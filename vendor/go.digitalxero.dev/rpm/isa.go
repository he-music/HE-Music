package rpm

import (
	"path"
	"strings"
)

// isaRule maps an RPM architecture glob to its ISA name and bit width. A blank
// name means the ISA name is the architecture itself.
type isaRule struct {
	pattern string
	name    string
	bits    string
}

// isaRules mirrors the architecture case statement in rpm's installplatform
// script, which defines %__isa_name and %__isa_bits (and so %_isa) for every
// canonical architecture. Order matters: the first matching pattern wins.
// https://github.com/rpm-software-management/rpm/blob/master/installplatform
//
//nolint:gochecknoglobals // read-only lookup table
var isaRules = []isaRule{
	{"sparc64*", "sparc", "64"},
	{"sparc*", "sparc", "32"},
	{"s390", "s390", "32"},
	{"s390x", "s390", "64"},
	{"ppc64", "ppc", "64"},
	{"ppc64p7", "ppc", "64"},
	{"ppc64le", "ppc", "64"},
	{"ppc*", "ppc", "32"},
	{"i?86", "x86", "32"},
	{"pentium?", "x86", "32"},
	{"athlon", "x86", "32"},
	{"geode", "x86", "32"},
	{"x86_64*", "x86", "64"},
	{"amd64", "x86", "64"},
	{"ia32e", "x86", "64"},
	{"ia64", "ia", "64"},
	{"sh*", "sh", "32"},
	{"armv7h*", "armv7hl", "32"},
	{"arm*", "", "32"},
	{"alpha*", "alpha", "64"},
	{"aarch64", "aarch", "64"},
	{"mips", "mips", "32"},
	{"mipsel", "mips", "32"},
	{"mips64", "mips", "64"},
	{"mips64el", "mips", "64"},
	{"mipsr6", "mipsr6", "32"},
	{"mipsr6el", "mipsr6", "32"},
	{"mips64r6", "mipsr6", "64"},
	{"mips64r6el", "mipsr6", "64"},
	{"m68k", "m68k", "32"},
	{"riscv64", "riscv", "64"},
	{"loongarch64", "loongarch", "64"},
	{"e2k*", "e2k", "64"},
}

// ISA returns the instruction set architecture rpm associates with arch, in the
// "<name>-<bits>" form of the %{_isa} macro without its parentheses (x86_64 is
// "x86-64", aarch64 is "aarch-64"). It reports false for noarch, source and any
// architecture rpm defines no ISA for.
func ISA(arch string) (string, bool) {
	if arch == "" || strings.ContainsAny(arch, "*?[]\\/") {
		return "", false
	}
	for _, r := range isaRules {
		if ok, _ := path.Match(r.pattern, arch); !ok {
			continue
		}
		name := r.name
		if name == "" {
			name = arch
		}
		return name + "-" + r.bits, true
	}
	return "", false
}
