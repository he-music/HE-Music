//go:build darwin

package darwin

import (
	"strconv"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/egoist/mygo/internal/platform"
)

// HTTP authentication and server certificates of pages: the navigation
// delegate's webView:didReceiveAuthenticationChallenge:completionHandler:,
// whose completion handler takes an NSURLSessionAuthChallengeDisposition
// and a credential.

const (
	authUseCredential = 0
	authDefault       = 1
	authReject        = 3 // NSURLSessionAuthChallengeRejectProtectionSpace
)

// authScheme names the NSURLAuthenticationMethods of HTTP, "" the
// others, which get WebKit's default handling. Client certificates are
// asked about apart, in clientCertificate.
func authScheme(method string) string {
	switch method {
	case "NSURLAuthenticationMethodDefault", "NSURLAuthenticationMethodHTTPBasic":
		return "basic"
	case "NSURLAuthenticationMethodHTTPDigest":
		return "digest"
	case "NSURLAuthenticationMethodNTLM":
		return "ntlm"
	case "NSURLAuthenticationMethodNegotiate":
		return "negotiate"
	}
	return ""
}

// trustAPI is what checking server certificates and listing client
// certificate identities takes of the Security framework, loaded with
// the first use.
var trustAPI = sync.OnceValue(func() *trustFuncs {
	lib, err := purego.Dlopen("/System/Library/Frameworks/Security.framework/Security", purego.RTLD_GLOBAL|purego.RTLD_NOW)
	if err != nil {
		return nil
	}
	main, err := purego.Dlsym(purego.RTLD_DEFAULT, "_dispatch_main_q")
	if err != nil {
		return nil
	}
	return &trustFuncs{
		evaluate:  mustDlsym(lib, "SecTrustEvaluateAsyncWithError"),
		chain:     mustDlsym(lib, "SecTrustCopyCertificateChain"),
		data:      mustDlsym(lib, "SecCertificateCopyData"),
		mainQueue: main, // dispatch_get_main_queue()

		item:             mustDlsym(lib, "SecItemCopyMatching"),
		identityCert:     mustDlsym(lib, "SecIdentityCopyCertificate"),
		commonName:       mustDlsym(lib, "SecCertificateCopyCommonName"),
		secClass:         cfConstant(lib, "kSecClass"),
		secClassIdent:    cfConstant(lib, "kSecClassIdentity"),
		secReturnRef:     cfConstant(lib, "kSecReturnRef"),
		secMatchLimit:    cfConstant(lib, "kSecMatchLimit"),
		secMatchLimitAll: cfConstant(lib, "kSecMatchLimitAll"),
		boolTrue:         cfConstant(libCF, "kCFBooleanTrue"),
	}
})

type trustFuncs struct {
	evaluate, chain, data, mainQueue uintptr

	item, identityCert, commonName uintptr
	// The query constants, their values read from the Security framework,
	// and kCFBooleanTrue. CFStringRef and CFBooleanRef are toll-free
	// bridged to NSString and NSNumber, so an NSDictionary takes them.
	secClass, secClassIdent, secReturnRef, secMatchLimit, secMatchLimitAll, boolTrue uintptr
}

// cfConstant reads a constant a framework exports, kSecClass say: its
// symbol is a CFStringRef, and the constant is that string.
func cfConstant(lib uintptr, name string) uintptr {
	addr := mustDlsym(lib, name)
	return *(*uintptr)(*(*unsafe.Pointer)(unsafe.Pointer(&addr)))
}

// authChallenge answers a challenge of the page or of what it loads.
func (w *window) authChallenge(challenge id, handler uintptr) {
	space := send(challenge, "protectionSpace")
	method := goString(send(space, "authenticationMethod"))
	switch method {
	case "NSURLAuthenticationMethodServerTrust":
		w.serverTrust(challenge, space, handler)
		return
	case "NSURLAuthenticationMethodClientCertificate":
		w.clientCertificate(space, handler)
		return
	}
	scheme := authScheme(method)
	if scheme == "" {
		callBlock(handler, authDefault, 0)
		return
	}
	resp := w.h.AuthRequested(platform.AuthRequest{
		Host:    goString(send(space, "host")),
		Port:    sendInt(space, "port"),
		Realm:   goString(send(space, "realm")),
		Scheme:  scheme,
		IsProxy: sendBool(space, "isProxy"),
	})
	switch {
	case resp.Default:
		callBlock(handler, authDefault, 0)
	case resp.Username == "" && resp.Password == "":
		// Without credentials: the server's refusal.
		callBlock(handler, authReject, 0)
	default:
		withPool(func() {
			const forSession = 1 // NSURLCredentialPersistenceForSession
			cred := send(class("NSURLCredential"), "credentialWithUser:password:persistence:",
				uintptr(nsString(resp.Username)), uintptr(nsString(resp.Password)), forSession)
			callBlock(handler, authUseCredential, uintptr(cred))
		})
	}
}

// clientCertificate asks the app which identity to give a server that
// asks for one: every identity the keychain holds, with its certificate
// DER-encoded, as Electron offers them; the server's acceptable issuers
// (protectionSpace.distinguishedNames) are the app's to filter by. What
// the app does not take is refused, for the platform has no choice of
// its own to leave it to.
func (w *window) clientCertificate(space id, handler uintptr) {
	api := trustAPI()
	if api == nil || !w.h.HandlesClientCertificates() {
		// Without a handler the challenge is the web view's, and the
		// keychain is not asked about: it would ask the user.
		callBlock(handler, authDefault, 0)
		return
	}
	certs, identities := keychainIdentities(api)
	// The array owns the identities, which an answer uses: it lives as
	// long as they do. The keychain may hold none.
	if identities != 0 {
		defer cfRelease(uintptr(identities))
	}
	resp := w.h.ClientCertificateRequested(platform.ClientCertificateRequest{
		Host:         goString(send(space, "host")),
		Port:         sendInt(space, "port"),
		IsProxy:      sendBool(space, "isProxy"),
		Certificates: certs,
	})
	switch {
	case resp.Default:
		callBlock(handler, authDefault, 0)
	case resp.Certificate != nil && resp.Certificate.Native != 0:
		withPool(func() {
			const forSession = 1 // NSURLCredentialPersistenceForSession
			cred := send(class("NSURLCredential"), "credentialWithIdentity:certificates:persistence:",
				resp.Certificate.Native, uintptr(identityCertificates(api, resp.Certificate.Native)), forSession)
			callBlock(handler, authUseCredential, uintptr(cred))
		})
	default:
		callBlock(handler, authReject, 0)
	}
}

// identityCertificates returns the array of certificates an identity's
// credential carries: the identity's own certificate, which the
// handshake needs.
func identityCertificates(api *trustFuncs, identity uintptr) id {
	chain := send(class("NSMutableArray"), "array")
	cert := identityCertificate(api, identity)
	if cert == 0 {
		return chain
	}
	defer cfRelease(cert)
	send(chain, "addObject:", cert)
	return chain
}

// identityCertificate returns the certificate of an identity, which the
// caller releases, or 0. SecIdentityCopyCertificate returns an OSStatus
// and writes the certificate to its second argument.
func identityCertificate(api *trustFuncs, identity uintptr) uintptr {
	var cert uintptr
	if status, _, _ := purego.SyscallN(api.identityCert, identity, uintptr(unsafe.Pointer(&cert))); int32(status) != 0 {
		return 0
	}
	return cert
}

// keychainIdentities lists the identities of the keychain, their
// certificates DER-encoded with their common names. The array
// SecItemCopyMatching returns owns the identities; it is returned too,
// for the caller to keep alive as long as an answer uses them.
func keychainIdentities(api *trustFuncs) ([]platform.ClientCertificate, id) {
	var certs []platform.ClientCertificate
	var array id
	withPool(func() {
		query := send(class("NSMutableDictionary"), "dictionary")
		send(query, "setObject:forKey:", api.secClassIdent, api.secClass)
		send(query, "setObject:forKey:", api.boolTrue, api.secReturnRef)
		send(query, "setObject:forKey:", api.secMatchLimitAll, api.secMatchLimit)
		var result uintptr
		if status, _, _ := purego.SyscallN(api.item, uintptr(query), uintptr(unsafe.Pointer(&result))); int32(status) != 0 || result == 0 {
			return // errSecItemNotFound, among the others: no identities
		}
		array = id(result)
		for i, n := 0, sendInt(array, "count"); i < n; i++ {
			identity := send(array, "objectAtIndex:", uintptr(i))
			cert := identityCertificate(api, uintptr(identity))
			if cert == 0 {
				continue
			}
			c := platform.ClientCertificate{Native: uintptr(identity)}
			if data, _, _ := purego.SyscallN(api.data, cert); data != 0 {
				c.DER = goBytes(id(data))
				cfRelease(data)
			}
			// Security has no public call for the issuer or the validity
			// on macOS: they are read from the certificate itself.
			if issuer, from, to, ok := platform.CertificateIssuer(c.DER); ok {
				c.Issuer, c.ValidFrom, c.ValidTo = issuer, from, to
			}
			var name uintptr
			if status, _, _ := purego.SyscallN(api.commonName, cert, uintptr(unsafe.Pointer(&name))); int32(status) == 0 && name != 0 {
				c.Subject = goString(id(name))
				cfRelease(name)
			}
			cfRelease(cert)
			if c.DER != nil {
				certs = append(certs, c)
			}
		}
	})
	return certs, array
}

// serverTrust checks the server's certificate while the app handles
// certificate errors, and asks it about one that does not verify: WebKit
// checks it again otherwise (default handling), and fails the load.
func (w *window) serverTrust(challenge, space id, handler uintptr) {
	api := trustAPI()
	trust := send(space, "serverTrust")
	if api == nil || trust == 0 || !w.h.HandlesCertificateErrors() {
		callBlock(handler, authDefault, 0)
		return
	}
	host, port := goString(send(space, "host")), sendInt(space, "port")
	handler = blockCopy(handler)
	retain(challenge) // and its trust, until the check ends
	// SecTrustEvaluateAsyncWithError calls back on the queue it was
	// called from, the main one.
	block := newBlock(func(_ objc.Block, _ id, ok bool, nserr id) {
		defer release(challenge)
		defer blockRelease(handler)
		if ok || w.closed {
			callBlock(handler, authDefault, 0)
			return
		}
		origin := host
		if strings.Contains(host, ":") {
			origin = "[" + host + "]" // IPv6
		}
		if port != 443 && port != 0 {
			origin += ":" + strconv.Itoa(port)
		}
		e := platform.CertificateError{
			URL:         "https://" + origin,
			Host:        host,
			Error:       goString(send(nserr, "localizedDescription")), // a CFError is an NSError
			Certificate: leafCertificate(api, trust),
		}
		if !w.h.CertificateError(e) {
			callBlock(handler, authDefault, 0)
			return
		}
		withPool(func() {
			callBlock(handler, authUseCredential, uintptr(send(class("NSURLCredential"), "credentialForTrust:", uintptr(trust))))
		})
	})
	status, _, _ := purego.SyscallN(api.evaluate, uintptr(trust), api.mainQueue, uintptr(block))
	block.Release()
	if int32(status) != 0 { // errSecSuccess: the block never runs otherwise
		release(challenge)
		callBlock(handler, authDefault, 0)
		blockRelease(handler)
	}
}

// leafCertificate returns the DER encoding of the server's own
// certificate in trust.
func leafCertificate(api *trustFuncs, trust id) []byte {
	chain, _, _ := purego.SyscallN(api.chain, uintptr(trust))
	if chain == 0 {
		return nil
	}
	defer release(id(chain))
	if sendInt(id(chain), "count") == 0 {
		return nil
	}
	data, _, _ := purego.SyscallN(api.data, uintptr(send(id(chain), "objectAtIndex:", 0)))
	defer release(id(data))
	return goBytes(id(data))
}
