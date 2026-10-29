package main

import (
	"context"
	"errors"
	"sort"
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

var errSystemFontsUnsupported = errors.New("system font enumeration is unsupported on this platform")

// SystemFonts exposes bounded family names to the renderer. Enumeration runs on
// the lifecycle main owner so a lyrics child cannot read the system list.
type SystemFonts struct{}

func init() {
	mygo.Bind(&SystemFonts{})
}

func (s *SystemFonts) List(ctx context.Context) ([]string, error) {
	var fonts []string
	err := desktopLifecycle.call(ctx, true, func() error {
		var err error
		fonts, err = enumerateSystemFontFamilies()
		return err
	})
	if err != nil {
		return nil, err
	}
	return normalizeSystemFontFamilies(fonts), nil
}

type systemFontCollector struct {
	families []string
	scanned  int
	stopped  bool
}

func newSystemFontCollector() *systemFontCollector {
	return &systemFontCollector{families: make([]string, 0, maxSystemFontCount)}
}

// collect returns whether the native enumeration may continue. Both the scan
// budget and result limit are enforced while the native callback is running.
func (c *systemFontCollector) collect(name string) bool {
	if c.stopped {
		return false
	}
	c.scanned++
	if name != "" && len(c.families) < maxSystemFontCount {
		c.families = append(c.families, name)
	}
	if len(c.families) >= maxSystemFontCount || c.scanned >= maxSystemFontScan {
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

func normalizeSystemFontFamilies(fonts []string) []string {
	capacity := boundedMin(len(fonts), maxSystemFontCount)
	seen := make(map[string]struct{}, capacity)
	result := make([]string, 0, capacity)
	for _, raw := range fonts {
		name := strings.TrimSpace(raw)
		if name == "" || len(name) > maxSystemFontName || strings.HasPrefix(name, ".") || strings.ContainsRune(name, '\x00') {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
		if len(result) == maxSystemFontCount {
			break
		}
	}
	sort.Strings(result)
	return result
}

func boundedMin(a, b int) int {
	if a < b {
		return a
	}
	return b
}
