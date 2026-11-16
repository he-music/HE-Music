package rpm

import "time"

type changelogEntry struct {
	when   time.Time
	author string
	text   string
}

// ChangelogBuilder accumulates changelog entries. rpm convention lists the newest
// entry first; serialize sorts entries newest-first automatically.
type ChangelogBuilder interface {
	// Add appends a changelog entry.
	Add(when time.Time, author, text string) ChangelogBuilder
	// Done returns to the parent package builder.
	Done() PackageBuilder
}

type changelogHandle struct {
	pkg *rpmPackage
}

func (h *changelogHandle) Add(when time.Time, author, text string) ChangelogBuilder {
	h.pkg.changelog = append(h.pkg.changelog, changelogEntry{when: when, author: author, text: text})
	return h
}

func (h *changelogHandle) Done() PackageBuilder { return h.pkg }

// Changelog returns the changelog builder.
func (p *rpmPackage) Changelog() ChangelogBuilder { return &changelogHandle{p} }
