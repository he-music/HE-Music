package metadata

import (
	"math"
	"strconv"
	"strings"

	"github.com/tommyo123/mtag"
)

const (
	trackGainTag = "REPLAYGAIN_TRACK_GAIN"
	trackPeakTag = "REPLAYGAIN_TRACK_PEAK"
)

type ReplayGain struct {
	GainDB float64  `json:"track_gain_db"`
	Peak   *float64 `json:"track_peak,omitempty"`
}

func (r *ReplayGain) Valid() bool {
	return r != nil && math.Abs(r.GainDB) <= 60 && (r.Peak == nil || validReplayGainPeak(*r.Peak))
}

func validReplayGainPeak(peak float64) bool {
	return peak > 0 && peak <= 10
}

func readReplayGain(f *mtag.File) *ReplayGain {
	gain := readReplayGainNumber(f, trackGainTag, true, func(value float64) bool { return math.Abs(value) <= 60 })
	if gain == nil {
		return nil
	}
	return &ReplayGain{GainDB: *gain, Peak: readReplayGainNumber(f, trackPeakTag, false, validReplayGainPeak)}
}

func readReplayGainNumber(f *mtag.File, key string, gain bool, valid func(float64) bool) *float64 {
	for _, name := range []string{key, strings.ToLower(key)} {
		for _, text := range f.CustomValues(name) {
			text = strings.TrimSpace(strings.ToLower(text))
			if gain {
				text = strings.TrimSpace(strings.TrimSuffix(text, "db"))
			}
			if value, err := strconv.ParseFloat(text, 64); err == nil && valid(value) {
				return new(value)
			}
		}
	}
	return nil
}

func CanWriteReplayGain(container string) bool {
	switch container {
	case "mp3", "flac", "ogg", "mp4", "ape":
		return true
	default:
		return false
	}
}

func setReplayGain(f *mtag.File, gain *ReplayGain) {
	gainKey, peakKey := trackGainTag, trackPeakTag
	if f.Container() == mtag.ContainerMP4 {
		gainKey, peakKey = strings.ToLower(gainKey), strings.ToLower(peakKey)
	}
	f.SetCustomValues(gainKey, strconv.FormatFloat(gain.GainDB, 'f', -1, 64)+" dB")
	if gain.Peak != nil {
		f.SetCustomValues(peakKey, strconv.FormatFloat(*gain.Peak, 'f', -1, 64))
	}
}
