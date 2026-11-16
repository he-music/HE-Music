package rpm

import (
	"fmt"
	"strings"
)

// TriggerKind selects when a trigger fires relative to the triggering package's
// install or removal.
type TriggerKind int

const (
	// TriggerIn fires when a matching package is installed.
	TriggerIn TriggerKind = iota
	// TriggerUn fires when a matching package is removed.
	TriggerUn
	// TriggerPostun fires after a matching package is removed.
	TriggerPostun
	// TriggerPrein fires before a matching package is installed.
	TriggerPrein
)

// senseBit returns the RPMSENSE trigger bit for this kind.
func (k TriggerKind) senseBit() Sense {
	switch k {
	case TriggerUn:
		return senseTriggerUn
	case TriggerPostun:
		return senseTriggerPostUn
	case TriggerPrein:
		return senseTriggerPreIn
	default:
		return senseTriggerIn
	}
}

type triggerCond struct {
	name    string
	version string
	sense   Sense
}

type triggerData struct {
	kind        TriggerKind
	conds       []triggerCond
	script      string
	interpreter string // defaults to /bin/sh
}

func (t *triggerData) emitted() bool {
	return len(t.conds) > 0
}

func (t *triggerData) validate() error {
	if len(t.conds) == 0 {
		return fmt.Errorf("at least one condition is required")
	}
	for i, condition := range t.conds {
		name := strings.TrimSpace(condition.name)
		if name == "" {
			return fmt.Errorf("condition %d: name is required", i)
		}
		// RPM only permits rich dependencies in selected ordinary dependency
		// sets. Its trigger parser rejects every name beginning with "(".
		if strings.HasPrefix(name, "(") {
			return fmt.Errorf("condition %d: rich dependencies are not supported in triggers: %q", i, condition.name)
		}
	}
	return nil
}

// TriggerBuilder configures a trigger: one or more conditions plus a script.
type TriggerBuilder interface {
	// On adds a triggering condition (repeatable). At least one condition with a
	// nonempty name is required. Rich dependencies are not supported in triggers;
	// validation errors surface at package Build.
	On(name, version string, sense Sense) TriggerBuilder
	// WithScript sets the trigger script body. Empty and whitespace-only bodies
	// are valid and preserved in the serialized trigger metadata.
	WithScript(string) TriggerBuilder
	// WithInterpreter overrides the interpreter (default "/bin/sh").
	WithInterpreter(string) TriggerBuilder
	// Done returns to the parent package builder.
	Done() PackageBuilder
}

type triggerHandle struct {
	pkg  *rpmPackage
	data *triggerData
}

func (h *triggerHandle) On(name, version string, sense Sense) TriggerBuilder {
	h.data.conds = append(h.data.conds, triggerCond{name: name, version: version, sense: sense})
	return h
}

func (h *triggerHandle) WithScript(s string) TriggerBuilder {
	h.data.script = s
	return h
}

func (h *triggerHandle) WithInterpreter(s string) TriggerBuilder {
	h.data.interpreter = s
	return h
}

func (h *triggerHandle) Done() PackageBuilder { return h.pkg }

// Trigger starts configuring a new trigger of the given kind.
func (p *rpmPackage) Trigger(kind TriggerKind) TriggerBuilder {
	d := &triggerData{kind: kind, interpreter: "/bin/sh"}
	p.triggers = append(p.triggers, d)
	return &triggerHandle{p, d}
}
