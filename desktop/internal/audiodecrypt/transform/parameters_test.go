package transform

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestParametersRejectInvalidInputs(t *testing.T) {
	for _, text := range []string{"", "!", strings.Repeat("a", MaxEncodedSize+1), `{"v":2,"kind":1,"key":"AQ=="}`, `{"v":1,"kind":99,"key":"AQ=="}`, `{"v":1,"kind":2,"key":"AQ==","period":0}`, `{"v":1,"kind":3,"key":"AA==","box":"AQ==","hash":1,"segment":2}`, `{"v":1,"kind":4,"key":"AQ=="}`, `{"v":1,"v":1,"kind":1,"key":"AQ=="}`, `{"v":1,"kind":1,"key":"AQ==","user_agent":"bad\r\nheader"}`} {
		if strings.HasPrefix(text, "{") {
			text = base64.RawURLEncoding.EncodeToString([]byte(text))
		}
		if _, err := Parse(text); err == nil {
			t.Fatal("accepted invalid parameters")
		}
	}
}

func FuzzParse(f *testing.F) {
	f.Add("")
	encoded, _ := Encode(Parameters{Version: Version, Kind: Subtract, Key: []byte{1, 2, 3}})
	f.Add(encoded)
	f.Fuzz(func(t *testing.T, encoded string) {
		p, err := Parse(encoded)
		if err == nil {
			if err := p.Validate(); err != nil {
				t.Fatal("parser returned invalid parameters")
			}
		}
	})
}
