package rpm

import (
	"bytes"
	"crypto"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
)

// NewSigner returns a builder for an OpenPGP package signer. Attach the built
// Signer with PackageBuilder.WithSigner. For full control over the produced
// signature bytes, use PackageBuilder.WithPGPSignFunc instead.
func NewSigner() SignerBuilder {
	return &pgpSigner{hash: crypto.SHA256}
}

// SignerBuilder configures an OpenPGP signer.
type SignerBuilder interface {
	// WithArmoredKey provides an ASCII-armored private key.
	WithArmoredKey([]byte) SignerBuilder
	// WithKeyFile reads the private key (armored or binary) from a path.
	WithKeyFile(string) SignerBuilder
	// WithPassphrase decrypts a passphrase-protected key.
	WithPassphrase(string) SignerBuilder
	// WithHash sets the signature digest (default SHA-256).
	WithHash(crypto.Hash) SignerBuilder
	// WithSigningTime fixes the signature creation time for reproducible output.
	WithSigningTime(time.Time) SignerBuilder
	Build() (Signer, error)
}

// Signer produces the detached OpenPGP signatures rpm stores. Its methods are
// unexported (the package applies it during serialization); the interface is
// exported so callers can hold a built signer.
type Signer interface {
	signHeader(header []byte) ([]byte, error)
	signHeaderPayload(headerPlusPayload io.Reader) ([]byte, error)
	isDSA() bool
}

type pgpSigner struct {
	armoredKey  []byte
	keyFile     string
	passphrase  string
	hash        crypto.Hash
	signingTime time.Time

	entity *openpgp.Entity
	dsa    bool
}

func (s *pgpSigner) WithArmoredKey(b []byte) SignerBuilder     { s.armoredKey = b; return s }
func (s *pgpSigner) WithKeyFile(p string) SignerBuilder        { s.keyFile = p; return s }
func (s *pgpSigner) WithPassphrase(p string) SignerBuilder     { s.passphrase = p; return s }
func (s *pgpSigner) WithHash(h crypto.Hash) SignerBuilder      { s.hash = h; return s }
func (s *pgpSigner) WithSigningTime(t time.Time) SignerBuilder { s.signingTime = t; return s }

func (s *pgpSigner) Build() (Signer, error) {
	raw := s.armoredKey
	if len(raw) == 0 && s.keyFile != "" {
		b, err := os.ReadFile(s.keyFile)
		if err != nil {
			return nil, fmt.Errorf("rpm: reading key file: %w", err)
		}
		raw = b
	}
	if len(raw) == 0 {
		return nil, ErrNoSigningKey
	}
	el, err := readKeyRing(raw)
	if err != nil {
		return nil, fmt.Errorf("rpm: parsing private key: %w", err)
	}
	if len(el) == 0 {
		return nil, ErrNoSigningKey
	}
	ent := el[0]

	if s.passphrase != "" {
		pw := []byte(s.passphrase)
		if ent.PrivateKey != nil && ent.PrivateKey.Encrypted {
			if err := ent.PrivateKey.Decrypt(pw); err != nil {
				return nil, fmt.Errorf("rpm: decrypting private key: %w", err)
			}
		}
		for _, sk := range ent.Subkeys {
			if sk.PrivateKey == nil || !sk.PrivateKey.Encrypted {
				continue
			}
			// Surface a wrong passphrase for a signing-capable subkey at Build
			// time rather than deep inside DetachSign later.
			err := sk.PrivateKey.Decrypt(pw)
			canSign := sk.Sig != nil && sk.Sig.FlagsValid && sk.Sig.FlagSign && sk.PublicKey.PubKeyAlgo.CanSign()
			if err != nil && canSign {
				return nil, fmt.Errorf("rpm: decrypting signing subkey: %w", err)
			}
		}
	}

	s.entity = ent
	if s.hash == 0 {
		s.hash = crypto.SHA256
	}
	// Determine the tag family (RSA vs DSA) from the key DetachSign will actually
	// use, which may be a signing subkey rather than the primary key.
	if k, ok := ent.SigningKey(s.config().Now()); ok && k.PublicKey != nil {
		s.dsa = k.PublicKey.PubKeyAlgo == packet.PubKeyAlgoDSA
	} else if ent.PrimaryKey != nil {
		s.dsa = ent.PrimaryKey.PubKeyAlgo == packet.PubKeyAlgoDSA
	}
	return s, nil
}

func readKeyRing(raw []byte) (openpgp.EntityList, error) {
	if el, err := openpgp.ReadArmoredKeyRing(bytes.NewReader(raw)); err == nil {
		return el, nil
	}
	return openpgp.ReadKeyRing(bytes.NewReader(raw))
}

func (s *pgpSigner) config() *packet.Config {
	deterministic := false
	cfg := &packet.Config{
		DefaultHash: s.hash,
		// Disable the random salt notation subpacket so that, with a fixed
		// signing time, signatures are byte-reproducible.
		NonDeterministicSignaturesViaNotation: &deterministic,
	}
	if !s.signingTime.IsZero() {
		t := s.signingTime
		cfg.Time = func() time.Time { return t }
	}
	return cfg
}

func (s *pgpSigner) signReader(r io.Reader) ([]byte, error) {
	buf := &bytes.Buffer{}
	if err := openpgp.DetachSign(buf, s.entity, r, s.config()); err != nil {
		return nil, fmt.Errorf("rpm: signing: %w", err)
	}
	return buf.Bytes(), nil
}

func (s *pgpSigner) signHeader(header []byte) ([]byte, error) {
	return s.signReader(bytes.NewReader(header))
}
func (s *pgpSigner) signHeaderPayload(r io.Reader) ([]byte, error) { return s.signReader(r) }
func (s *pgpSigner) isDSA() bool                                   { return s.dsa }
