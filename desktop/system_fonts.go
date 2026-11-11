package main

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/egoist/mygo"
)

const (
	maxSystemFontCount = 4096
	maxSystemFontName  = 512
	maxSystemFontScan  = maxSystemFontCount * 4
)

// SystemFont describes one installed font face rather than only a family.
type SystemFont struct {
	Family         string `json:"family"`
	FullName       string `json:"fullName"`
	PostScriptName string `json:"postScriptName"`
	Weight         int    `json:"weight"`
	Style          string `json:"style"`
}

// SystemFonts exposes bounded font faces to the renderer. Enumeration runs on
// the lifecycle main owner so a lyrics child cannot read the system list.
type SystemFonts struct{}

func init() {
	mygo.Bind(&SystemFonts{})
}

func (s *SystemFonts) List(ctx context.Context) ([]SystemFont, error) {
	var fonts []SystemFont
	err := desktopLifecycle.call(ctx, true, func() error {
		var err error
		fonts, err = enumerateSystemFonts()
		return err
	})
	if err != nil {
		return nil, err
	}
	return normalizeSystemFonts(fonts), nil
}

type systemFontCollector struct {
	families []string
	fonts    []SystemFont
	scanned  int
	stopped  bool
}

func newSystemFontCollector() *systemFontCollector {
	return &systemFontCollector{
		families: make([]string, 0, maxSystemFontCount),
		fonts:    make([]SystemFont, 0, maxSystemFontCount),
	}
}

// collect returns whether the native enumeration may continue. It remains a
// family-only adapter for platform callbacks and existing collector tests.
func (c *systemFontCollector) collect(name string) bool {
	return c.collectFont(SystemFont{Family: name})
}

// collectFont enforces both the native scan budget and result limit while a
// platform callback is still running.
func (c *systemFontCollector) collectFont(font SystemFont) bool {
	if c.stopped {
		return false
	}
	c.scanned++
	if font.Family != "" && len(c.fonts) < maxSystemFontCount {
		c.families = append(c.families, font.Family)
		c.fonts = append(c.fonts, font)
	}
	if len(c.fonts) >= maxSystemFontCount || c.scanned >= maxSystemFontScan {
		c.stopped = true
	}
	return !c.stopped
}

type systemFontCollectorRouter struct {
	mu     sync.Mutex
	nextID atomic.Uint64
	active map[uintptr]*systemFontCollector
}

func newSystemFontCollectorRouter() *systemFontCollectorRouter {
	return &systemFontCollectorRouter{active: make(map[uintptr]*systemFontCollector)}
}

func (r *systemFontCollectorRouter) register(collector *systemFontCollector) uintptr {
	id := uintptr(r.nextID.Add(1))
	r.mu.Lock()
	r.active[id] = collector
	r.mu.Unlock()
	return id
}

func (r *systemFontCollectorRouter) unregister(id uintptr) {
	r.mu.Lock()
	delete(r.active, id)
	r.mu.Unlock()
}

func (r *systemFontCollectorRouter) collect(id uintptr, name string) bool {
	r.mu.Lock()
	collector := r.active[id]
	if collector == nil {
		r.mu.Unlock()
		return false
	}
	keepGoing := collector.collect(name)
	r.mu.Unlock()
	return keepGoing
}

func normalizeSystemFonts(fonts []SystemFont) []SystemFont {
	capacity := min(len(fonts), maxSystemFontCount)
	seen := make(map[string]struct{}, capacity)
	result := make([]SystemFont, 0, capacity)
	for _, font := range fonts {
		font.Family = strings.TrimSpace(font.Family)
		font.FullName = strings.TrimSpace(font.FullName)
		font.PostScriptName = strings.TrimSpace(font.PostScriptName)
		if font.Family == "" || len(font.Family) > maxSystemFontName || strings.HasPrefix(font.Family, ".") || strings.ContainsRune(font.Family, '\x00') {
			continue
		}
		if font.FullName == "" {
			font.FullName = font.Family
		}
		if font.PostScriptName == "" {
			font.PostScriptName = font.FullName
		}
		if len(font.FullName) > maxSystemFontName || len(font.PostScriptName) > maxSystemFontName ||
			strings.ContainsRune(font.FullName, '\x00') || strings.ContainsRune(font.PostScriptName, '\x00') {
			continue
		}
		if font.Weight < 100 || font.Weight > 900 || font.Weight%100 != 0 {
			font.Weight = 400
		}
		if font.Style != "normal" && font.Style != "italic" && font.Style != "oblique" {
			font.Style = "normal"
		}
		if _, ok := seen[font.PostScriptName]; ok {
			continue
		}
		seen[font.PostScriptName] = struct{}{}
		result = append(result, font)
		if len(result) == maxSystemFontCount {
			break
		}
	}
	slices.SortFunc(result, func(left, right SystemFont) int {
		return cmp.Or(
			strings.Compare(left.FullName, right.FullName),
			strings.Compare(left.PostScriptName, right.PostScriptName),
		)
	})
	return result
}

func normalizeSystemFontFamilies(fonts []string) []string {
	faces := make([]SystemFont, 0, len(fonts))
	for _, family := range fonts {
		faces = append(faces, SystemFont{Family: family})
	}
	result := normalizeSystemFonts(faces)
	families := make([]string, 0, len(result))
	seen := make(map[string]struct{}, len(result))
	for _, font := range result {
		if _, ok := seen[font.Family]; ok {
			continue
		}
		seen[font.Family] = struct{}{}
		families = append(families, font.Family)
	}
	slices.Sort(families)
	return families
}
