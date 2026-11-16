package rpm

import (
	"bytes"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
)

// signature.go populates the signature (0x3e) index: size and digest tags that
// are always present, plus OpenPGP signatures when a signer is configured. The
// payload is read from the on-disk spool (never held in memory).
//
// Two signatures are produced for broad rpm v4 compatibility:
//   - over the header bytes only  -> RSA (268) or DSA (267)
//   - over header + payload bytes -> PGP (1002) or GPG (1005)
func (p *rpmPackage) writeSignatures(s *index, header []byte, payload *os.File, compressedSize int64, archiveSize uint64) error {
	putScalarSize(s, sigSize, sigLongSize, uint64(int64(len(header))+compressedSize))
	putScalarSize(s, sigPayloadSize, sigLongArchiveSize, archiveSize)

	// Header-only digests.
	sha256Sum := sha256.Sum256(header)
	s.add(sigSHA256, EntryString(hex.EncodeToString(sha256Sum[:])))
	sha1Sum := sha1.Sum(header)
	s.add(sigSHA1, EntryString(hex.EncodeToString(sha1Sum[:])))

	// MD5 (and, when signing, the header+payload signature) over a single
	// streaming pass of header followed by the spooled payload.
	if _, err := payload.Seek(0, io.SeekStart); err != nil {
		return err
	}
	md := md5.New()
	body := io.MultiReader(bytes.NewReader(header), payload)

	var headerSig, bodySig []byte
	var dsa bool
	switch {
	case p.signer != nil:
		hs, err := p.signer.signHeader(header)
		if err != nil {
			return err
		}
		bs, err := p.signer.signHeaderPayload(io.TeeReader(body, md))
		if err != nil {
			return err
		}
		headerSig, bodySig, dsa = hs, bs, p.signer.isDSA()
	case p.pgpSignFunc != nil:
		// The escape hatch takes []byte, so the body is buffered in memory here.
		buf, err := io.ReadAll(io.TeeReader(body, md))
		if err != nil {
			return err
		}
		if headerSig, err = p.pgpSignFunc(header); err != nil {
			return err
		}
		if bodySig, err = p.pgpSignFunc(buf); err != nil {
			return err
		}
	default:
		if _, err := io.Copy(md, body); err != nil {
			return err
		}
	}
	s.add(sigMD5, EntryBytes(md.Sum(nil)))

	// Optional padding so the package can be signed in place later.
	if p.reservedSigSpace > 0 {
		s.add(sigReservedSpace, EntryBytes(make([]byte, p.reservedSigSpace)))
	}

	if headerSig != nil {
		if dsa {
			s.add(sigDSA, EntryBytes(headerSig))
			s.add(sigGPG, EntryBytes(bodySig))
		} else {
			s.add(sigRSA, EntryBytes(headerSig))
			s.add(sigPGP, EntryBytes(bodySig))
		}
	}
	return nil
}
