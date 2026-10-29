package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// 与 src/platform/desktopLyricOptions.test.ts 使用相同 golden，在完整默认值上替换字段。
var lyricsOptionsValidNames = []string{
	"system-ui", "Arial", "Noto Sans SC", "思源黑体", "字体_Font-2.0", "Ａ１２", "Ⅳ²",
	strings.Repeat("A", 256), strings.Repeat("中", 85) + "A", strings.Repeat("𠮷", 64),
}
var lyricsOptionsInvalidNames = []string{
	"", " Arial", "Arial ", " ", "Arial, sans-serif", "url(x)", "var(--font)",
	"Arial; color:red", "Font(x)", "Font/x", "Font\\x", `"Arial"`, "'Arial'",
	"Font\n", "Font\r", "Font\t", "Font\u0000", "Font\u007f", "Font\u00a0",
	"Font\u2003", "e\u0301", "😀", string([]byte{0xed, 0xa0, 0x80}),
	strings.Repeat("A", 257), strings.Repeat("中", 86), strings.Repeat("𠮷", 64) + "A",
}

func TestLyricsOptionsFontNameGoldens(t *testing.T) {
	for _, field := range []string{"family", "postScriptName"} {
		for _, group := range []struct {
			names []string
			valid bool
		}{{lyricsOptionsValidNames, true}, {lyricsOptionsInvalidNames, false}} {
			for _, name := range group.names {
				options := defaultLyricsOptions()
				if field == "family" {
					options.Font.Family = name
				} else {
					options.Font.PostScriptName = name
				}
				if got := validLyricsOptions(&options); got != group.valid {
					t.Errorf("%s = %q: valid = %v, want %v", field, name, got, group.valid)
				}
			}
		}
	}
}

func TestLyricsOptionsNumericGoldens(t *testing.T) {
	for _, tc := range []struct {
		field   string
		valid   []int
		invalid []int
	}{
		{"size", []int{20, 24, 96}, []int{-1, 0, 19, 97}},
		{"weight", []int{100, 200, 700, 900}, []int{-100, 0, 99, 101, 950, 1000}},
	} {
		for _, group := range []struct {
			values []int
			valid  bool
		}{{tc.valid, true}, {tc.invalid, false}} {
			for _, value := range group.values {
				options := defaultLyricsOptions()
				if tc.field == "size" {
					options.Font.Size = value
				} else {
					options.Font.Weight = value
				}
				if got := validLyricsOptions(&options); got != group.valid {
					t.Errorf("%s = %d: valid = %v, want %v", tc.field, value, got, group.valid)
				}
			}
		}
	}
	// int 在标准 JSON 解码阶段拒绝小数；不引入自定义解析器。
	for _, field := range []string{"size", "weight"} {
		for _, value := range []string{"20.5", "100.5"} {
			var options LyricsOptions
			if err := json.Unmarshal([]byte(`{"font":{"`+field+`":`+value+`}}`), &options); err == nil {
				t.Errorf("%s accepts fractional JSON %s", field, value)
			}
		}
	}
}

func TestLyricsOptionsEnumGoldens(t *testing.T) {
	for _, tc := range []struct {
		field          string
		valid, invalid []string
	}{
		{"style", []string{"normal", "italic", "oblique"}, []string{"", "Normal", "bold", "italic "}},
		{"position", []string{"left", "center", "right", "both"}, []string{"", "Both", "justify", "left "}},
	} {
		for _, group := range []struct {
			values []string
			valid  bool
		}{{tc.valid, true}, {tc.invalid, false}} {
			for _, value := range group.values {
				options := defaultLyricsOptions()
				if tc.field == "style" {
					options.Font.Style = value
				} else {
					options.Position = value
				}
				if got := validLyricsOptions(&options); got != group.valid {
					t.Errorf("%s = %q: valid = %v, want %v", tc.field, value, got, group.valid)
				}
			}
		}
	}
}

func TestLyricsOptionsDefaultsCloneAndJSON(t *testing.T) {
	want := LyricsOptions{
		Font:         LyricsFontOptions{Family: "system-ui", Size: 24, Weight: 700, PostScriptName: "system-ui", Style: "normal"},
		IsDoubleLine: true, Position: "both", LimitBounds: false, ShowYrc: true, ShowTran: true, Animation: true, AlwaysShowPlayInfo: false,
	}
	defaults := defaultLyricsOptions()
	if defaults != want || !validLyricsOptions(&defaults) || !validLyricsOptions(nil) {
		t.Fatalf("unexpected defaults or nil policy: %+v", defaults)
	}
	for _, partial := range []LyricsOptions{{}, {Font: defaults.Font}, {Position: "both"}} {
		if validLyricsOptions(&partial) {
			t.Errorf("partial struct accepted: %+v", partial)
		}
	}
	first, second := cloneLyricsOptions(nil), cloneLyricsOptions(nil)
	if first == second || *first != want || *second != want {
		t.Fatal("nil clones must be independent defaults")
	}
	first.Font.Family = "Arial"
	if *second != want || defaultLyricsOptions() != want {
		t.Fatal("defaults share state")
	}
	original := defaults
	original.IsDoubleLine, original.LimitBounds = false, true
	original.ShowYrc, original.ShowTran = false, false
	original.Animation, original.AlwaysShowPlayInfo = false, true
	clone := cloneLyricsOptions(&original)
	if clone == &original || *clone != original || !validLyricsOptions(clone) {
		t.Fatal("clone changed values")
	}
	original.Font.Family = "思源黑体"
	if clone.Font.Family != "system-ui" {
		t.Fatal("original changed clone font")
	}
	clone.Font.Size = 96
	if original.Font.Size != 24 {
		t.Fatal("clone changed original font")
	}
	data, err := json.Marshal(defaults)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"font":{"family":"system-ui","size":24,"weight":700,"postScriptName":"system-ui","style":"normal"},"isDoubleLine":true,"position":"both","limitBounds":false,"showYrc":true,"showTran":true,"animation":true,"alwaysShowPlayInfo":false}`
	if string(data) != wantJSON {
		t.Fatalf("JSON = %s, want %s", data, wantJSON)
	}
	var decoded LyricsOptions
	if err := json.Unmarshal(data, &decoded); err != nil || decoded != defaults || !validLyricsOptions(&decoded) {
		t.Fatalf("JSON roundtrip = %+v, error %v", decoded, err)
	}
}
