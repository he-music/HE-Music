package rpm

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/hex"
	"hash"
)

// DigestAlgo selects the hash used for file and payload digests. SHA256 is the
// modern default; SHA1/MD5 exist for compatibility with old rpm, and SHA384/512
// for environments that require them.
type DigestAlgo int

const (
	// DigestSHA256 is the default file/payload digest algorithm.
	DigestSHA256 DigestAlgo = iota
	// DigestSHA1 selects SHA-1 (legacy; avoid for new packages).
	DigestSHA1
	// DigestSHA512 selects SHA-512.
	DigestSHA512
	// DigestMD5 selects MD5 (legacy; the original rpm file digest).
	DigestMD5
	// DigestSHA384 selects SHA-384.
	DigestSHA384
)

// String returns the human-readable algorithm name.
func (d DigestAlgo) String() string {
	switch d {
	case DigestSHA1:
		return "sha1"
	case DigestSHA512:
		return "sha512"
	case DigestMD5:
		return "md5"
	case DigestSHA384:
		return "sha384"
	default:
		return "sha256"
	}
}

// rpmAlgo returns the PGPHASHALGO identifier rpm stores in FILEDIGESTALGO /
// PAYLOADDIGESTALGO.
func (d DigestAlgo) rpmAlgo() int {
	switch d {
	case DigestSHA1:
		return hashAlgoSHA1
	case DigestSHA512:
		return hashAlgoSHA512
	case DigestMD5:
		return hashAlgoMD5
	case DigestSHA384:
		return hashAlgoSHA384
	default:
		return hashAlgoSHA256
	}
}

func (d DigestAlgo) newHash() hash.Hash {
	switch d {
	case DigestSHA1:
		return sha1.New()
	case DigestSHA512:
		return sha512.New()
	case DigestMD5:
		return md5.New()
	case DigestSHA384:
		return sha512.New384()
	default:
		return sha256.New()
	}
}

// hexSum returns the lowercase hex digest of b under this algorithm.
func (d DigestAlgo) hexSum(b []byte) string {
	h := d.newHash()
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}
