package main

import "testing"

func TestDesktopPlatformRejectsNonHTTPExternalLinks(t *testing.T) {
	service := &DesktopPlatform{}
	for _, rawURL := range []string{"file:///tmp/test", "javascript:alert(1)", "https:", "https://", "data:text/html,test", "mygo://localhost/", "%"} {
		t.Run(rawURL, func(t *testing.T) {
			if err := service.OpenExternal(rawURL); err == nil {
				t.Fatal("unsupported external URL was accepted")
			}
		})
	}
}
