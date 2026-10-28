package main

// WebKit publishes HTMLAudio on macOS; Go retains only its independent power lease.
func nativeSystemMediaEnabled(goos string, requested bool) bool {
	return goos != "darwin" && requested
}
