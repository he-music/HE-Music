package rpm

// scriptletKind identifies one of the install/upgrade lifecycle scripts.
type scriptletKind int

const (
	scriptletPretrans scriptletKind = iota
	scriptletPrein
	scriptletPostin
	scriptletPreun
	scriptletPostun
	scriptletPosttrans
	scriptletVerify
)

type scriptletData struct {
	script      string
	interpreter string // defaults to /bin/sh
}

// ScriptletBuilder configures one lifecycle scriptlet.
type ScriptletBuilder interface {
	// WithScript sets the scriptlet body.
	WithScript(string) ScriptletBuilder
	// WithInterpreter overrides the interpreter (default "/bin/sh").
	WithInterpreter(string) ScriptletBuilder
	// Done returns to the parent package builder.
	Done() PackageBuilder
}

type scriptletHandle struct {
	pkg  *rpmPackage
	data *scriptletData
}

func (h *scriptletHandle) WithScript(s string) ScriptletBuilder {
	h.data.script = s
	return h
}

func (h *scriptletHandle) WithInterpreter(s string) ScriptletBuilder {
	h.data.interpreter = s
	return h
}

func (h *scriptletHandle) Done() PackageBuilder { return h.pkg }

func (p *rpmPackage) scriptletFor(k scriptletKind) *scriptletData {
	if d, ok := p.scriptlets[k]; ok {
		return d
	}
	d := &scriptletData{interpreter: "/bin/sh"}
	p.scriptlets[k] = d
	return d
}

func (p *rpmPackage) Pretrans() ScriptletBuilder {
	return &scriptletHandle{p, p.scriptletFor(scriptletPretrans)}
}
func (p *rpmPackage) Prein() ScriptletBuilder {
	return &scriptletHandle{p, p.scriptletFor(scriptletPrein)}
}
func (p *rpmPackage) Postin() ScriptletBuilder {
	return &scriptletHandle{p, p.scriptletFor(scriptletPostin)}
}
func (p *rpmPackage) Preun() ScriptletBuilder {
	return &scriptletHandle{p, p.scriptletFor(scriptletPreun)}
}
func (p *rpmPackage) Postun() ScriptletBuilder {
	return &scriptletHandle{p, p.scriptletFor(scriptletPostun)}
}
func (p *rpmPackage) Posttrans() ScriptletBuilder {
	return &scriptletHandle{p, p.scriptletFor(scriptletPosttrans)}
}
func (p *rpmPackage) VerifyScript() ScriptletBuilder {
	return &scriptletHandle{p, p.scriptletFor(scriptletVerify)}
}
