package main

import (
	"cmp"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

const cueMaxBytes = 64 * 1024

// CueTrack is a section of the authorized audio file, not a separate file.
type CueTrack struct {
	Number     int    `json:"number"`
	Title      string `json:"title,omitempty"`
	Performer  string `json:"performer,omitempty"`
	StartFrame int    `json:"startFrame"`
}

type CueSheet struct {
	Title     string     `json:"title,omitempty"`
	Performer string     `json:"performer,omitempty"`
	Tracks    []CueTrack `json:"tracks"`
}

func (j *fileScan) directoryCues(dir *os.Root, relative string, remaining int) map[string]*CueSheet {
	file, err := dir.Open(".")
	if err != nil {
		return nil
	}
	defer file.Close()
	var sheets map[string]*CueSheet
	for remaining > 0 && j.ctx.Err() == nil {
		entries, readErr := file.ReadDir(min(scanPageSize, remaining))
		remaining -= len(entries)
		for _, entry := range entries {
			name := entry.Name()
			if !entry.Type().IsRegular() || !strings.EqualFold(filepath.Ext(name), ".cue") {
				continue
			}
			path := name
			if relative != "" {
				path = relative + "/" + name
			}
			target, sheet := j.readCue(path)
			if sheet == nil {
				continue
			}
			if sheets == nil {
				sheets = make(map[string]*CueSheet)
			}
			if _, ambiguous := sheets[target]; ambiguous {
				// 多份 CUE 指向同一个文件时不猜测，保留整轨。
				sheet = nil
			}
			sheets[target] = sheet
		}
		if readErr != nil || len(entries) == 0 {
			break
		}
	}
	return sheets
}

func (j *fileScan) readCue(relative string) (string, *CueSheet) {
	file, before, err := openGrantedRegular(j.lease, relative)
	if err != nil {
		return "", nil
	}
	defer file.Close()
	if before.Size() > cueMaxBytes {
		return "", nil
	}
	data, err := io.ReadAll(io.LimitReader(file, cueMaxBytes+1))
	after, statErr := file.Stat()
	if err != nil || statErr != nil || !sameLocalFileInfo(before, after) || len(data) > cueMaxBytes {
		return "", nil
	}
	return parseCue(string(data))
}

// 首版只接收 UTF-8、单文件、AUDIO 轨；引用只用于匹配同目录扫描项，不直接打开路径。
func parseCue(input string) (string, *CueSheet) {
	if !utf8.ValidString(input) || strings.ContainsRune(input, 0) {
		return "", nil
	}
	sheet := &CueSheet{}
	var filename string
	var track *CueTrack
	for line := range strings.SplitSeq(strings.TrimPrefix(input, "\uFEFF"), "\n") {
		word, rest := cueWord(line)
		key := strings.ToUpper(word)
		switch key {
		case "FILE":
			name := cueFilename(rest)
			if filename != "" || name == "" {
				return "", nil
			}
			filename = name
		case "TRACK":
			n := cueAudioTrackNumber(rest)
			if filename == "" || n == 0 || !validCueTrackOrder(track, n) {
				return "", nil
			}
			sheet.Tracks = append(sheet.Tracks, CueTrack{Number: n, StartFrame: -1})
			track = &sheet.Tracks[len(sheet.Tracks)-1]
		case "INDEX":
			index, time := cueWord(rest)
			if index != "01" {
				continue
			}
			if !setCueIndex(sheet.Tracks, time) {
				return "", nil
			}
		case "TITLE", "PERFORMER":
			setCueText(sheet, track, key, rest)
		}
	}
	if track == nil || track.StartFrame < 0 {
		return "", nil
	}
	return filename, sheet
}

func cueFilename(value string) string {
	name, kind := cueWord(value)
	if strings.TrimSpace(kind) == "" || validateLocalRelativePath(name) != nil || strings.Contains(name, "/") {
		return ""
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".flac", ".wav", ".ape":
		return name
	default:
		return ""
	}
}

func cueAudioTrackNumber(value string) int {
	number, kind := cueWord(value)
	n, err := strconv.Atoi(number)
	if err != nil || n < 1 || n > 99 || !strings.EqualFold(strings.TrimSpace(kind), "AUDIO") {
		return 0
	}
	return n
}

func validCueTrackOrder(previous *CueTrack, number int) bool {
	return previous == nil || (previous.StartFrame >= 0 && number > previous.Number)
}

func setCueIndex(tracks []CueTrack, time string) bool {
	frame, ok := cueFrame(strings.TrimSpace(time))
	count := len(tracks)
	if !ok || count == 0 || tracks[count-1].StartFrame >= 0 || (count > 1 && frame <= tracks[count-2].StartFrame) {
		return false
	}
	tracks[count-1].StartFrame = frame
	return true
}

func setCueText(sheet *CueSheet, track *CueTrack, key, text string) {
	value := strings.TrimSpace(text)
	if strings.HasPrefix(value, `"`) {
		value, _ = cueWord(value)
	}
	if len(value) > 1024 {
		return
	}
	switch {
	case track == nil && key == "TITLE":
		sheet.Title = value
	case track == nil:
		sheet.Performer = value
	case key == "TITLE":
		track.Title = value
	default:
		track.Performer = value
	}
}

func cueWord(line string) (string, string) {
	line = strings.TrimSpace(line)
	if rest, quoted := strings.CutPrefix(line, `"`); quoted {
		word, tail, closed := strings.Cut(rest, `"`)
		if !closed {
			return "", ""
		}
		return word, tail
	}
	if index := strings.IndexAny(line, " \t"); index >= 0 {
		return line[:index], line[index+1:]
	}
	return line, ""
}

func cueFrame(value string) (int, bool) {
	minText, rest, okMin := strings.Cut(value, ":")
	secText, frameText, okSec := strings.Cut(rest, ":")
	minutes, minErr := strconv.Atoi(minText)
	seconds, secErr := strconv.Atoi(secText)
	frames, frameErr := strconv.Atoi(frameText)
	if !okMin || !okSec || cmp.Or(minErr, secErr, frameErr) != nil ||
		minutes < 0 || minutes > 9999 || seconds < 0 || seconds >= 60 || frames < 0 || frames >= 75 {
		return 0, false
	}
	return (minutes*60+seconds)*75 + frames, true
}

func cueWithinDuration(sheet *CueSheet, duration float64) *CueSheet {
	if sheet == nil || !(duration > 0) || math.IsInf(duration, 0) ||
		float64(sheet.Tracks[len(sheet.Tracks)-1].StartFrame)/75 >= duration {
		return nil
	}
	return sheet
}
