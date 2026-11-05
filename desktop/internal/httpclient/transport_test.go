package httpclient

import (
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestDefaultUserAgentOnWire(t *testing.T) {
	for _, useHTTP2 := range []bool{false, true} {
		t.Run(map[bool]string{false: "HTTP1", true: "HTTP2"}[useHTTP2], func(t *testing.T) {
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/redirect" {
					http.Redirect(w, r, "/final", http.StatusFound)
					return
				}
				if (r.ProtoMajor == 2) != useHTTP2 {
					t.Error("unexpected HTTP version")
				}
				_, _ = io.WriteString(w, r.UserAgent())
			}))
			server.EnableHTTP2 = useHTTP2
			server.StartTLS()
			defer server.Close()
			client := server.Client()
			client.Transport = &Transport{Base: client.Transport}
			defer client.CloseIdleConnections()
			for _, agent := range []string{"", " ", "LunaPC/3.3.0(359450208)"} {
				for _, nilHeader := range []bool{false, true} {
					req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/redirect", nil)
					if err != nil {
						t.Fatal(err)
					}
					if nilHeader {
						req.Header = nil
					} else {
						req.Header.Set("User-Agent", agent)
					}
					before := req.Header.Clone()
					response, err := client.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					data, err := io.ReadAll(response.Body)
					response.Body.Close()
					if err != nil {
						t.Fatal(err)
					}
					want := agent
					if nilHeader || strings.TrimSpace(want) == "" {
						want = DefaultUserAgent
					}
					if string(data) != want {
						t.Fatalf("User-Agent=%q want=%q", data, want)
					}
					if !reflect.DeepEqual(req.Header, before) {
						t.Fatal("transport mutated caller's headers")
					}
				}
			}
		})
	}
}

type idleTransport struct{ closed bool }

func (*idleTransport) RoundTrip(*http.Request) (*http.Response, error) { return nil, nil }
func (t *idleTransport) CloseIdleConnections()                         { t.closed = true }

func TestCloseIdleConnectionsReachesBase(t *testing.T) {
	base := new(idleTransport)
	client := &http.Client{Transport: &Transport{Base: base}}
	client.CloseIdleConnections()
	if !base.closed {
		t.Fatal("base connection pool was not closed")
	}
}
