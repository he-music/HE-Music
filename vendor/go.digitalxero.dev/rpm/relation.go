package rpm

import (
	"fmt"
	"regexp"
	"strings"
)

// Sense is the RPMSENSE_* comparison bitfield attached to a dependency.
type Sense uint32

const (
	// SenseAny imposes no version constraint.
	SenseAny Sense = senseAny
	// SenseLess means "< version".
	SenseLess Sense = senseLess
	// SenseGreater means "> version".
	SenseGreater Sense = senseGreater
	// SenseEqual means "= version".
	SenseEqual Sense = senseEqual
	// SenseLessEqual means "<= version".
	SenseLessEqual = SenseLess | SenseEqual
	// SenseGreaterEqual means ">= version".
	SenseGreaterEqual = SenseGreater | SenseEqual
	// SenseRPMLIB marks an rpmlib() feature dependency.
	SenseRPMLIB Sense = senseRPMLIB
)

// Dependency phase/qualifier bits. OR one of these into a require's sense to mark
// the install phase it is needed for — the equivalent of rpm's Requires(pre):,
// Requires(post):, etc.
const (
	// SensePreReq is the legacy PreReq qualifier.
	SensePreReq Sense = sensePreReq
	// SenseInterp marks an interpreter dependency.
	SenseInterp Sense = senseInterp
	// SensePreTrans is Requires(pretrans).
	SensePreTrans Sense = sensePreTrans
	// SensePostTrans is Requires(posttrans).
	SensePostTrans Sense = sensePostTrans
	// SenseScriptPre is Requires(pre).
	SenseScriptPre Sense = senseScriptPre
	// SenseScriptPost is Requires(post).
	SenseScriptPost Sense = senseScriptPost
	// SenseScriptPreUn is Requires(preun).
	SenseScriptPreUn Sense = senseScriptPreUn
	// SenseScriptPostUn is Requires(postun).
	SenseScriptPostUn Sense = senseScriptPostUn
	// SenseScriptVerify is Requires(verify).
	SenseScriptVerify Sense = senseScriptVerify
	// SenseMissingOK marks a weak/optional dependency.
	SenseMissingOK Sense = senseMissingOK
	// SenseConfig marks a config() dependency.
	SenseConfig Sense = senseConfig
)

// Relation is a single dependency: a name, an optional version, and a comparison
// sense. Rich/boolean dependencies are represented as a Name beginning with "("
// and SenseAny.
type Relation interface {
	Name() string
	Version() string
	Sense() Sense
	String() string
	Equal(Relation) bool
}

type relation struct {
	name    string
	version string
	sense   Sense
}

func (r *relation) Name() string    { return r.name }
func (r *relation) Version() string { return r.version }
func (r *relation) Sense() Sense    { return r.sense }

func (r *relation) String() string {
	op := senseString(r.sense)
	if op == "" || r.version == "" {
		return r.name
	}
	return fmt.Sprintf("%s %s %s", r.name, op, r.version)
}

func (r *relation) Equal(o Relation) bool {
	return r.name == o.Name() && r.version == o.Version() && r.sense == o.Sense()
}

func senseString(s Sense) string {
	switch s & (SenseLess | SenseGreater | SenseEqual) {
	case SenseLess:
		return "<"
	case SenseGreater:
		return ">"
	case SenseEqual:
		return "="
	case SenseLessEqual:
		return "<="
	case SenseGreaterEqual:
		return ">="
	default:
		return ""
	}
}

// NewRelation constructs a relation explicitly.
func NewRelation(name, version string, sense Sense) Relation {
	return &relation{name: name, version: version, sense: sense}
}

// A relation is a name, optionally followed by a comparison operator and a
// single version token. Trailing junk that is neither makes the spec invalid.
var relationPattern = regexp.MustCompile(`^([^=<>\s]+)\s*(?:([=<>]+)\s*(\S+))?\s*$`)

// ParseRelation parses a dependency spec such as "bash >= 4.0", "python3", or a
// rich/boolean dependency "(foo if bar)".
func ParseRelation(spec string) (Relation, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, fmt.Errorf("rpm: empty relation")
	}
	// Rich/boolean dependencies are passed through verbatim and evaluated by rpm
	// at install time.
	if strings.HasPrefix(spec, "(") && strings.HasSuffix(spec, ")") {
		return &relation{name: spec, sense: SenseAny}, nil
	}
	m := relationPattern.FindStringSubmatch(spec)
	if m == nil {
		return nil, fmt.Errorf("rpm: malformed relation %q", spec)
	}
	sense, err := parseSense(m[2])
	if err != nil {
		return nil, err
	}
	return &relation{name: m[1], version: m[3], sense: sense}, nil
}

func parseSense(op string) (Sense, error) {
	switch op {
	case "":
		return SenseAny, nil
	case "<":
		return SenseLess, nil
	case ">":
		return SenseGreater, nil
	case "=", "==":
		return SenseEqual, nil
	case "<=", "=<":
		return SenseLessEqual, nil
	case ">=", "=>":
		return SenseGreaterEqual, nil
	default:
		return SenseAny, fmt.Errorf("rpm: unknown version operator %q", op)
	}
}

// relationSet is an ordered, de-duplicated collection of relations.
type relationSet struct {
	rels []*relation
}

func (s *relationSet) addIfMissing(r *relation) {
	for _, existing := range s.rels {
		if existing.Equal(r) {
			return
		}
	}
	s.rels = append(s.rels, r)
}

// RelationSetBuilder accumulates relations for one dependency category.
type RelationSetBuilder interface {
	// Add appends a relation (deduplicated).
	Add(Relation) RelationSetBuilder
	// AddParsed parses a spec string and appends it; a parse error surfaces at Build.
	AddParsed(spec string) RelationSetBuilder
	// With appends a relation built from its parts.
	With(name, version string, sense Sense) RelationSetBuilder
	// Done returns to the parent package builder.
	Done() PackageBuilder
}

type relationSetHandle struct {
	pkg *rpmPackage
	set *relationSet
}

func (h *relationSetHandle) Add(r Relation) RelationSetBuilder {
	h.set.addIfMissing(&relation{name: r.Name(), version: r.Version(), sense: r.Sense()})
	return h
}

func (h *relationSetHandle) AddParsed(spec string) RelationSetBuilder {
	r, err := ParseRelation(spec)
	if err != nil {
		h.pkg.fail(err)
		return h
	}
	return h.Add(r)
}

func (h *relationSetHandle) With(name, version string, sense Sense) RelationSetBuilder {
	h.set.addIfMissing(&relation{name: name, version: version, sense: sense})
	return h
}

func (h *relationSetHandle) Done() PackageBuilder { return h.pkg }

func (p *rpmPackage) Provides() RelationSetBuilder          { return &relationSetHandle{p, p.provides} }
func (p *rpmPackage) Requires() RelationSetBuilder          { return &relationSetHandle{p, p.requires} }
func (p *rpmPackage) Conflicts() RelationSetBuilder         { return &relationSetHandle{p, p.conflicts} }
func (p *rpmPackage) Obsoletes() RelationSetBuilder         { return &relationSetHandle{p, p.obsoletes} }
func (p *rpmPackage) Recommends() RelationSetBuilder        { return &relationSetHandle{p, p.recommends} }
func (p *rpmPackage) Suggests() RelationSetBuilder          { return &relationSetHandle{p, p.suggests} }
func (p *rpmPackage) Supplements() RelationSetBuilder       { return &relationSetHandle{p, p.supplements} }
func (p *rpmPackage) Enhances() RelationSetBuilder          { return &relationSetHandle{p, p.enhances} }
func (p *rpmPackage) OrderWithRequires() RelationSetBuilder { return &relationSetHandle{p, p.order} }
