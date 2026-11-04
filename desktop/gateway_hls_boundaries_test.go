package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayRejectsHLSFeaturesWithUnroutedSecondaryResources(t *testing.T) {
	for _, manifest := range []string{
		"#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://steer.invalid/steering.json\",PATHWAY-ID=\"main\"\n",
		"#EXTM3U\n#EXT-X-DATERANGE:ID=\"ad\",CLASS=\"com.apple.hls.interstitial\",X-ASSET-URI=\"https://ad.invalid/ad.m3u8\"\n",
		"#EXTM3U\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"https://ad.invalid/list.json\"\n",
		"#EXTM3U\n#EXT-X-DEFINE:NAME=\"v\",VALUE=\"video\"\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n{$v}/index.m3u8\n",
		"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.invalid/{$key}.bin\"\n",
	} {
		t.Run(strings.Split(manifest, "\n")[1], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
				_, _ = io.WriteString(w, manifest)
			}))
			defer upstream.Close()
			_, base := gatewayTestServer(t, GatewayAPIConfig{})
			response, body := gatewayRequest(t, "GET", base+"/__proxy/"+gatewayTarget(t, upstream.URL+"/master.m3u8"), "", nil)
			if response.StatusCode != http.StatusBadGateway || strings.Contains(body, "https://") {
				t.Fatalf("unsupported manifest was returned to the player: status %d, body %q", response.StatusCode, body)
			}
		})
	}
}
