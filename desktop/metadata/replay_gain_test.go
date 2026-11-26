package metadata

import (
	"bytes"
	"reflect"
	"testing"
)

func TestReplayGainRoundTripPreservesAudio(t *testing.T) {
	for _, format := range []string{"mp3", "flac", "m4a", "ogg"} {
		t.Run(format, func(t *testing.T) {
			path := fixture(t, format, "3")
			packets := packetHash(t, path)
			want := &ReplayGain{GainDB: 0, Peak: new(1.035)}
			edit(t, path, Patch{ReplayGain: want})
			edit(t, path, Patch{Title: new("新标题")})
			for _, scan := range []bool{false, true} {
				if got := readInfo(t, path, scan).ReplayGain; !reflect.DeepEqual(got, want) {
					t.Fatalf("scan=%t: 增益标签 = %+v，预期 %+v", scan, got, want)
				}
			}
			if !bytes.Equal(packets, packetHash(t, path)) {
				t.Fatal("写标签更改了音频包")
			}
		})
	}
}
