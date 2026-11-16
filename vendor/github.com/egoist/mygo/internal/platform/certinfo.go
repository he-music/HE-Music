package platform

import (
	"strconv"
	"time"
	"unicode/utf16"
)

// CertificateIssuer reads the issuer's name and the validity of a
// DER-encoded certificate, for a backend whose platform does not name
// them: the issuer's common name (its organization when it has none),
// and the unix seconds it is valid from and to. ok is false when der is
// not a certificate.
//
// It walks the few fields it needs instead of using crypto/x509, which
// would grow every app, whether it handles client certificates or not.
func CertificateIssuer(der []byte) (issuer string, from, to int64, ok bool) {
	cert, ok := derField(der, 0x30)
	if !ok {
		return "", 0, 0, false
	}
	tbs, ok := derField(cert, 0x30)
	if !ok {
		return "", 0, 0, false
	}
	if len(tbs) > 0 && tbs[0] == 0xa0 { // [0] version, absent in v1
		if _, tbs, ok = derNext(tbs); !ok {
			return "", 0, 0, false
		}
	}
	// The serial number, the signature's algorithm, the issuer and the
	// validity, in that order.
	var fields [4][]byte
	for i, tag := range []byte{0x02, 0x30, 0x30, 0x30} {
		var t byte
		if t, fields[i], tbs, ok = derRead(tbs); !ok || t != tag {
			return "", 0, 0, false
		}
	}
	name, validity := fields[2], fields[3]
	if from, ok = derTime(&validity); !ok {
		return "", 0, 0, false
	}
	if to, ok = derTime(&validity); !ok {
		return "", 0, 0, false
	}
	return nameIssuer(name), from, to, true
}

// nameIssuer returns the common name of an X.501 name's content, or its
// organization when it has none.
func nameIssuer(name []byte) string {
	var cn, org string
	for len(name) > 0 {
		t, set, rest, ok := derRead(name)
		if !ok || t != 0x31 {
			break
		}
		name = rest
		for len(set) > 0 {
			t, atv, rest, ok := derRead(set)
			if !ok || t != 0x30 {
				break
			}
			set = rest
			t, oid, value, ok := derRead(atv)
			if !ok || t != 0x06 || len(oid) != 3 || oid[0] != 0x55 || oid[1] != 0x04 {
				continue
			}
			s, ok := derString(value)
			if !ok {
				continue
			}
			switch oid[2] {
			case 0x03: // 2.5.4.3, commonName
				if cn == "" {
					cn = s
				}
			case 0x0a: // 2.5.4.10, organizationName
				if org == "" {
					org = s
				}
			}
		}
	}
	if cn != "" {
		return cn
	}
	return org
}

// derString reads a directory string, the value of a name's attribute.
func derString(b []byte) (string, bool) {
	t, content, _, ok := derRead(b)
	if !ok {
		return "", false
	}
	switch t {
	case 0x0c, 0x13, 0x14, 0x16: // UTF8String, PrintableString, T61String, IA5String
		return string(content), true
	case 0x1e: // BMPString, UTF-16BE
		if len(content)%2 != 0 {
			return "", false
		}
		u := make([]uint16, len(content)/2)
		for i := range u {
			u[i] = uint16(content[2*i])<<8 | uint16(content[2*i+1])
		}
		return string(utf16.Decode(u)), true
	}
	return "", false
}

// derTime reads the UTCTime or GeneralizedTime at the start of *b, in
// unix seconds, and moves *b past it.
func derTime(b *[]byte) (int64, bool) {
	t, content, rest, ok := derRead(*b)
	if !ok {
		return 0, false
	}
	*b = rest
	s := string(content)
	switch t {
	case 0x17: // UTCTime, YYMMDDHHMMSSZ: years from 50 are the 1900s
		if len(s) < 2 {
			return 0, false
		}
		yy, err := strconv.Atoi(s[:2])
		if err != nil {
			return 0, false
		}
		if yy >= 50 {
			s = "19" + s
		} else {
			s = "20" + s
		}
	case 0x18: // GeneralizedTime, YYYYMMDDHHMMSSZ
	default:
		return 0, false
	}
	v, err := time.Parse("20060102150405Z0700", s)
	if err != nil {
		return 0, false
	}
	return v.Unix(), true
}

// derField returns the content of the element at the start of b, which
// must have the tag.
func derField(b []byte, tag byte) ([]byte, bool) {
	t, content, _, ok := derRead(b)
	return content, ok && t == tag
}

// derNext skips the element at the start of b.
func derNext(b []byte) (byte, []byte, bool) {
	t, _, rest, ok := derRead(b)
	return t, rest, ok
}

// derRead splits the DER element at the start of b into its tag, its
// content and what follows it.
func derRead(b []byte) (tag byte, content, rest []byte, ok bool) {
	if len(b) < 2 || b[0]&0x1f == 0x1f { // no high tag numbers in a certificate's fields
		return 0, nil, nil, false
	}
	tag, n, b := b[0], int(b[1]), b[2:]
	if n&0x80 != 0 {
		size := n & 0x7f
		if size == 0 || size > 4 || len(b) < size {
			return 0, nil, nil, false
		}
		n = 0
		for _, c := range b[:size] {
			n = n<<8 | int(c)
		}
		b = b[size:]
	}
	if n < 0 || n > len(b) {
		return 0, nil, nil, false
	}
	return tag, b[:n], b[n:], true
}
