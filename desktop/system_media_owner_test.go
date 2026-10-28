package main

import "testing"

func TestNativeSystemMediaEnabled(t *testing.T) {
	for _, goos := range []string{"darwin", "windows", "linux"} {
		for _, requested := range []bool{false, true} {
			want := requested && goos != "darwin"
			if got := nativeSystemMediaEnabled(goos, requested); got != want {
				t.Fatalf("nativeSystemMediaEnabled(%q, %t) = %t, want %t", goos, requested, got, want)
			}
		}
	}
}
