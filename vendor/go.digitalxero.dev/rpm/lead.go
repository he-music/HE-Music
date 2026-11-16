package rpm

import "fmt"

// lead.go writes the 96-byte RPM lead. The lead is legacy: modern rpm ignores its
// contents and relies on the header, but it must still be present and well-formed
// (the magic, in particular, identifies the file as an RPM).
//
// Layout:
//
//	0-3    magic   ED AB EE DB
//	4      major   03
//	5      minor   00
//	6-7    type    0 = binary, 1 = source
//	8-9    archnum 0001
//	10-75  name    "name-fullversion", truncated to 65 bytes, NUL-padded to 66
//	76-77  osnum   0001
//	78-79  sigtype 0005 (header-style signatures)
//	80-95  reserved (16 zero bytes)

const leadLength = 96

func writeLead(name, fullVersion string, source bool) []byte {
	b := make([]byte, leadLength)
	copy(b[0:4], []byte{0xed, 0xab, 0xee, 0xdb})
	b[4] = 0x03 // major version 3
	b[5] = 0x00 // minor version 0
	if source {
		b[7] = 0x01 // type: source
	} // else type: binary (0x0000)
	b[8] = 0x00
	b[9] = 0x01 // archnum

	n := fmt.Appendf(nil, "%s-%s", name, fullVersion)
	if len(n) > 65 {
		n = n[:65]
	}
	copy(b[10:76], n) // remaining bytes stay zero (NUL padding/terminator)

	b[76] = 0x00
	b[77] = 0x01 // osnum
	b[78] = 0x00
	b[79] = 0x05 // signature type: header-style
	// b[80:96] already zero (reserved)
	return b
}
