package mtag

import (
	"encoding/binary"
	"strconv"
	"strings"

	"github.com/tommyo123/mtag/id3v1"
	"github.com/tommyo123/mtag/mp4"
)

const mp4FreeformMeanITunes = "com.apple.iTunes"

// mp4ItemNameFor maps an ID3v2 canonical frame ID to the four-byte
// iTunes ilst tag carrying the same field, or "" when there is no
// equivalent.
//
// iTunes uses a literal 0xA9 byte (the Latin-1 copyright sign) as
// the high byte of many tag names. That is *not* the same as the
// "©" code-point's UTF-8 encoding (which is 0xC2 0xA9), so we
// hard-code the byte with \xa9 to keep the on-disk identifier
// exactly four bytes long.
func mp4ItemNameFor(frameID string) string {
	switch frameID {
	case "TIT2":
		return "\xa9nam"
	case "TPE1":
		return "\xa9ART"
	case "TALB":
		return "\xa9alb"
	case "TPE2":
		return "aART"
	case "TCOM":
		return "\xa9wrt"
	case "TYER", "TDRC":
		return "\xa9day"
	case "TCON":
		return "\xa9gen"
	case "TBPM":
		return "tmpo"
	case "TENC":
		return "\xa9enc"
	case "TCOP":
		return "cprt"
	case "USLT":
		return "\xa9lyr"
	case "COMM":
		return "\xa9cmt"
	}
	return ""
}

// mp4ItemString returns the first UTF-8 / UTF-16 string value of
// any item with the given name. Integer-typed items are stringified
// so callers that ask for "\xa9day" of an integer value still get a
// reasonable result.
func (f *File) mp4ItemString(name string) string {
	if f.mp4 == nil {
		return ""
	}
	for _, it := range mp4.ItemsByName(f.mp4.items, name) {
		switch it.Type {
		case mp4.DataUTF8, mp4.DataUTF16:
			return string(it.Data)
		case mp4.DataInteger:
			if v, ok := mp4DecodeInteger(it.Data); ok {
				return strconv.FormatInt(v, 10)
			}
		}
	}
	return ""
}

func (f *File) mp4MDTAString(name string) string {
	if f.mp4 == nil {
		return ""
	}
	for _, it := range f.mp4.mdta {
		if !strings.EqualFold(it.Key, name) {
			continue
		}
		switch it.Type {
		case mp4.DataUTF8, mp4.DataUTF16:
			return string(it.Data)
		case mp4.DataInteger:
			if v, ok := mp4DecodeInteger(it.Data); ok {
				return strconv.FormatInt(v, 10)
			}
		}
	}
	return ""
}

func mp4MDTAKeysForFrame(frameID string) []string {
	switch frameID {
	case "TIT2":
		return []string{"com.apple.quicktime.title"}
	case "TPE1":
		return []string{"com.apple.quicktime.artist", "com.apple.quicktime.author"}
	case "TALB":
		return []string{"com.apple.quicktime.album"}
	case "TCOM":
		return []string{"com.apple.quicktime.composer"}
	case "TCON":
		return []string{"com.apple.quicktime.genre"}
	case "COMM":
		return []string{"com.apple.quicktime.comment"}
	case "USLT":
		return []string{"com.apple.quicktime.lyrics"}
	case "TCOP":
		return []string{"com.apple.quicktime.copyright"}
	case "TPUB":
		return []string{"com.apple.quicktime.publisher"}
	case "TYER", "TDRC":
		return []string{"com.apple.quicktime.creationdate"}
	}
	return nil
}

func mp4LegacyItemNamesFor(frameID string) []string {
	switch frameID {
	case "TPUB":
		return []string{"\xa9pub"}
	case "TENC":
		return []string{"\xa9too"}
	}
	return nil
}

func (f *File) mp4SetFrameText(frameID, value string) {
	wrote := false
	if name := mp4ItemNameFor(frameID); name != "" {
		f.mp4SetText(name, value)
		wrote = true
	}
	mdtaKeys := mp4MDTAKeysForFrame(frameID)
	hasMDTA := f.mp4HasMDTAKeys(mdtaKeys)
	if !wrote && !hasMDTA && value != "" {
		return
	}
	for _, legacy := range mp4LegacyItemNamesFor(frameID) {
		f.mp4RemoveName(legacy)
	}
	f.mp4SyncMDTA(mdtaKeys, value)
}

func (f *File) mp4SyncMDTA(keys []string, value string) {
	if f.mp4 == nil || len(keys) == 0 {
		return
	}
	indexSet := map[int]struct{}{}
	for _, item := range f.mp4.mdta {
		for _, key := range keys {
			if strings.EqualFold(item.Key, key) {
				indexSet[item.Index] = struct{}{}
			}
		}
	}
	if len(indexSet) == 0 {
		return
	}
	kept := f.mp4.items[:0]
	for _, it := range f.mp4.items {
		index := int(binary.BigEndian.Uint32(it.Name[:]))
		if _, ok := indexSet[index]; ok {
			continue
		}
		kept = append(kept, it)
	}
	f.mp4.items = kept
	if value == "" {
		keptMDTA := f.mp4.mdta[:0]
		for _, item := range f.mp4.mdta {
			if _, ok := indexSet[item.Index]; ok {
				continue
			}
			keptMDTA = append(keptMDTA, item)
		}
		f.mp4.mdta = keptMDTA
		return
	}
	seen := map[int]struct{}{}
	for _, item := range f.mp4.mdta {
		if _, ok := indexSet[item.Index]; !ok {
			continue
		}
		if _, dup := seen[item.Index]; dup {
			continue
		}
		seen[item.Index] = struct{}{}
		var name [4]byte
		binary.BigEndian.PutUint32(name[:], uint32(item.Index))
		f.mp4.items = append(f.mp4.items, mp4.Item{
			Name: name,
			Type: mp4.DataUTF8,
			Data: []byte(value),
		})
	}
	for i := range f.mp4.mdta {
		if _, ok := indexSet[f.mp4.mdta[i].Index]; ok {
			f.mp4.mdta[i].Type = mp4.DataUTF8
			f.mp4.mdta[i].Data = []byte(value)
		}
	}
}

func (f *File) mp4HasMDTAKeys(keys []string) bool {
	if f.mp4 == nil || len(keys) == 0 {
		return false
	}
	for _, item := range f.mp4.mdta {
		for _, key := range keys {
			if strings.EqualFold(item.Key, key) {
				return true
			}
		}
	}
	return false
}

func mp4FreeformKey(mean, name string) string {
	return "----:" + mean + ":" + name
}

func parseMP4FreeformKey(key string) (mean, name string, ok bool) {
	if !strings.HasPrefix(key, "----:") {
		return "", "", false
	}
	rest := strings.TrimPrefix(key, "----:")
	i := strings.IndexByte(rest, ':')
	if i < 0 {
		return "", "", false
	}
	return rest[:i], rest[i+1:], true
}

func (f *File) mp4FreeformValues(mean, name string) []string {
	if f.mp4 == nil {
		return nil
	}
	var out []string
	for _, it := range f.mp4.items {
		if string(it.Name[:]) != "----" {
			continue
		}
		if !strings.EqualFold(it.Mean, mean) || !strings.EqualFold(it.FreeformName, name) {
			continue
		}
		switch it.Type {
		case mp4.DataUTF8, mp4.DataUTF16:
			out = append(out, string(it.Data))
		case mp4.DataInteger:
			if v, ok := mp4DecodeInteger(it.Data); ok {
				out = append(out, strconv.FormatInt(v, 10))
			}
		}
	}
	return out
}

func (f *File) mp4SetFreeform(mean, name string, values ...string) {
	f.mp4RemoveFreeform(mean, name)
	if len(values) == 0 {
		return
	}
	var fourcc [4]byte
	copy(fourcc[:], "----")
	for _, value := range values {
		f.mp4.items = append(f.mp4.items, mp4.Item{
			Name:         fourcc,
			Type:         mp4.DataUTF8,
			Data:         []byte(value),
			Mean:         mean,
			FreeformName: name,
		})
	}
}

func (f *File) mp4RemoveFreeform(mean, name string) {
	if f.mp4 == nil {
		return
	}
	kept := f.mp4.items[:0]
	for _, it := range f.mp4.items {
		if string(it.Name[:]) == "----" &&
			strings.EqualFold(it.Mean, mean) &&
			strings.EqualFold(it.FreeformName, name) {
			continue
		}
		kept = append(kept, it)
	}
	f.mp4.items = kept
}

// mp4DecodeInteger decodes the variable-width big-endian integer
// payload that iTunes uses for numeric ilst values (BPM, gnre, …).
// Up to 8 bytes are accepted; longer payloads are truncated to the
// low-order bytes.
func mp4DecodeInteger(b []byte) (int64, bool) {
	if len(b) == 0 || len(b) > 8 {
		return 0, false
	}
	var u uint64
	for _, c := range b {
		u = u<<8 | uint64(c)
	}
	// Sign-extend if the high bit of the first byte is set.
	bits := uint(len(b)) * 8
	if u&(1<<(bits-1)) != 0 {
		u |= ^uint64(0) << bits
	}
	return int64(u), true
}

// mp4Track returns the (track, total) pair from the binary "trkn"
// item (8 bytes: 2 reserved + 2 BE track + 2 BE total + 2 reserved).
// "disk" has the same layout.
func (f *File) mp4TwoPart(name string) (int, int) {
	if f.mp4 == nil {
		return 0, 0
	}
	for _, it := range mp4.ItemsByName(f.mp4.items, name) {
		if len(it.Data) >= 6 {
			a := int(binary.BigEndian.Uint16(it.Data[2:4]))
			b := int(binary.BigEndian.Uint16(it.Data[4:6]))
			return a, b
		}
	}
	return 0, 0
}

// mp4String reads a polymorphic field from MP4 metadata for the
// given canonical ID3 frame ID, with sensible fallbacks for the
// quirks of iTunes' encoding (numeric DATE, integer BPM, etc.).
func (f *File) mp4String(frameID string) string {
	if name := mp4ItemNameFor(frameID); name != "" {
		if s := f.mp4ItemString(name); s != "" {
			return s
		}
	}
	switch frameID {
	case "TIT2":
		return f.mp4MDTAString("com.apple.quicktime.title")
	case "TPE1":
		if s := f.mp4MDTAString("com.apple.quicktime.artist"); s != "" {
			return s
		}
		return f.mp4MDTAString("com.apple.quicktime.author")
	case "TALB":
		return f.mp4MDTAString("com.apple.quicktime.album")
	case "TCOM":
		return f.mp4MDTAString("com.apple.quicktime.composer")
	case "TCON":
		return f.mp4MDTAString("com.apple.quicktime.genre")
	case "COMM":
		return f.mp4MDTAString("com.apple.quicktime.comment")
	case "USLT":
		return f.mp4MDTAString("com.apple.quicktime.lyrics")
	case "TCOP":
		return f.mp4MDTAString("com.apple.quicktime.copyright")
	case "TPUB":
		if s := f.mp4ItemString("\xa9pub"); s != "" {
			return s
		}
		return f.mp4MDTAString("com.apple.quicktime.publisher")
	case "TENC":
		if s := f.mp4ItemString("\xa9too"); s != "" {
			return s
		}
		return f.mp4MDTAString("com.apple.quicktime.software")
	}
	return ""
}

// mp4Year extracts a year from the ©day item, which iTunes typically
// stores as an ISO 8601 timestamp like "2013-04-29T07:00:00Z".
func (f *File) mp4Year() int {
	s := f.mp4ItemString("\xa9day")
	if s == "" {
		s = f.mp4MDTAString("com.apple.quicktime.creationdate")
	}
	if s == "" {
		return 0
	}
	if n, err := strconv.Atoi(yearPrefix(s)); err == nil {
		return n
	}
	return 0
}

// mp4Genre returns the genre, preferring the human-readable "\xa9gen"
// item over the numeric "gnre" id (which references the v1 genre
// table, off by one — gnre value N corresponds to v1 genre N-1).
func (f *File) mp4Genre() string {
	if s := f.mp4ItemString("\xa9gen"); s != "" {
		return s
	}
	if s := f.mp4MDTAString("com.apple.quicktime.genre"); s != "" {
		return s
	}
	if f.mp4 != nil {
		for _, it := range mp4.ItemsByName(f.mp4.items, "gnre") {
			if v, ok := mp4DecodeInteger(it.Data); ok && v > 0 && v <= 256 {
				return id3v1.GenreName(byte(v - 1))
			}
		}
	}
	return ""
}

// mp4IsCompilation returns true when the cpil item is set.
func (f *File) mp4IsCompilation() bool {
	if f.mp4 == nil {
		return false
	}
	for _, it := range mp4.ItemsByName(f.mp4.items, "cpil") {
		if v, ok := mp4DecodeInteger(it.Data); ok && v != 0 {
			return true
		}
	}
	return false
}

// mp4SetText writes a UTF-8 text item, replacing any existing item
// with the same four-byte name. An empty value deletes the item.
func (f *File) mp4SetText(name, value string) {
	f.mp4RemoveName(name)
	if value == "" {
		return
	}
	var n [4]byte
	copy(n[:], name)
	f.mp4.items = append(f.mp4.items, mp4.Item{
		Name: n,
		Type: mp4.DataUTF8,
		Data: []byte(value),
	})
}

// mp4SetTwoPart writes a binary (track / disc) item. Pass total=0
// to leave the total field empty. When both track and total are zero
// the entry is deleted.
func (f *File) mp4SetTwoPart(name string, track, total int) {
	f.mp4RemoveName(name)
	if track <= 0 && total <= 0 {
		return
	}
	// MP4 trkn/disk atoms use uint16 fields; clamp to avoid silent truncation.
	track = clampUint16(track)
	total = clampUint16(total)
	data := make([]byte, 8)
	data[2] = byte(track >> 8)
	data[3] = byte(track)
	data[4] = byte(total >> 8)
	data[5] = byte(total)
	var n [4]byte
	copy(n[:], name)
	f.mp4.items = append(f.mp4.items, mp4.Item{
		Name: n,
		Type: mp4.DataBinary,
		Data: data,
	})
}

func clampUint16(v int) int {
	if v < 0 {
		return 0
	}
	if v > 65535 {
		return 65535
	}
	return v
}

func (f *File) mp4SetCompilation(on bool) {
	f.mp4RemoveName("cpil")
	if !on {
		return
	}
	var n [4]byte
	copy(n[:], "cpil")
	f.mp4.items = append(f.mp4.items, mp4.Item{
		Name: n,
		Type: mp4.DataInteger,
		Data: []byte{1},
	})
}

// mp4RemoveName deletes every item whose FourCC name matches.
func (f *File) mp4RemoveName(name string) {
	if f.mp4 == nil {
		return
	}
	kept := f.mp4.items[:0]
	for _, it := range f.mp4.items {
		if string(it.Name[:]) == name {
			continue
		}
		kept = append(kept, it)
	}
	f.mp4.items = kept
}

// mp4Pictures returns the cover-art items as polymorphic Pictures.
func (f *File) mp4Pictures() []Picture {
	if f.mp4 == nil {
		return nil
	}
	var out []Picture
	for _, it := range mp4.ItemsByName(f.mp4.items, "covr") {
		mime := "application/octet-stream"
		switch it.Type {
		case mp4.DataJPEG:
			mime = "image/jpeg"
		case mp4.DataPNG:
			mime = "image/png"
		}
		out = append(out, Picture{
			MIME: mime,
			Type: PictureCoverFront,
			Data: append([]byte(nil), it.Data...),
		})
	}
	return out
}
