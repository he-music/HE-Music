package main

import (
	"sync"
	"testing"
)

func TestNormalizeSystemFontFamilies(t *testing.T) {
	got := normalizeSystemFontFamilies([]string{" Inter ", "Inter", "", ".private", "Arial\x00bad", "Arial"})
	want := []string{"Arial", "Inter"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestNormalizeSystemFontFamiliesBounds(t *testing.T) {
	input := make([]string, maxSystemFontCount+1)
	for i := range input {
		input[i] = "Font " + string(rune('A'+i%26)) + string(rune(i))
	}
	got := normalizeSystemFontFamilies(input)
	if len(got) != maxSystemFontCount {
		t.Fatalf("got %d families, want %d", len(got), maxSystemFontCount)
	}
}

func TestSystemFontCollectorStopsAtResultLimit(t *testing.T) {
	collector := newSystemFontCollector()
	for i := 0; i < maxSystemFontCount; i++ {
		if !collector.collect("Font") && i != maxSystemFontCount-1 {
			t.Fatalf("collector stopped at %d", i)
		}
	}
	if collector.collect("after-limit") {
		t.Fatal("collector continued after result limit")
	}
	if len(collector.families) != maxSystemFontCount {
		t.Fatalf("got %d results, want %d", len(collector.families), maxSystemFontCount)
	}
}

func TestSystemFontCollectorStopsAtScanBudget(t *testing.T) {
	collector := newSystemFontCollector()
	for i := 0; i < maxSystemFontScan; i++ {
		if !collector.collect("") && i != maxSystemFontScan-1 {
			t.Fatalf("collector stopped at scan %d", i)
		}
	}
	if collector.scanned != maxSystemFontScan {
		t.Fatalf("scanned %d, want %d", collector.scanned, maxSystemFontScan)
	}
	if len(collector.families) != 0 {
		t.Fatalf("got %d results from empty callbacks", len(collector.families))
	}
}

func TestSystemFontCollectorRouterUsesOpaqueIDs(t *testing.T) {
	router := newSystemFontCollectorRouter()
	first := newSystemFontCollector()
	second := newSystemFontCollector()
	firstID := router.register(first)
	secondID := router.register(second)
	defer router.unregister(firstID)
	defer router.unregister(secondID)
	if !router.collect(firstID, "First") || !router.collect(secondID, "Second") {
		t.Fatal("active collector did not accept callback")
	}
	if got := first.families; len(got) != 1 || got[0] != "First" {
		t.Fatalf("first collector got %v", got)
	}
	if got := second.families; len(got) != 1 || got[0] != "Second" {
		t.Fatalf("second collector got %v", got)
	}
	router.unregister(firstID)
	if router.collect(firstID, "stale") {
		t.Fatal("stale opaque ID was routed")
	}
}

func TestSystemFontCollectorRouterConcurrentCollectors(t *testing.T) {
	router := newSystemFontCollectorRouter()
	const count = 8
	collectors := make([]*systemFontCollector, count)
	ids := make([]uintptr, count)
	for i := range collectors {
		collectors[i] = newSystemFontCollector()
		ids[i] = router.register(collectors[i])
	}
	var group sync.WaitGroup
	for i := range collectors {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			if !router.collect(ids[i], "Font") {
				t.Errorf("collector %d did not accept callback", i)
			}
		}(i)
	}
	group.Wait()
	for i, collector := range collectors {
		if len(collector.families) != 1 || collector.families[0] != "Font" {
			t.Fatalf("collector %d got %v", i, collector.families)
		}
		router.unregister(ids[i])
	}
}
