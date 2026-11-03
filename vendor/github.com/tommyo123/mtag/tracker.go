package mtag

import (
	"encoding/binary"
	"fmt"
	"io"
	"strings"

	"github.com/tommyo123/mtag/id3v2"
)

type trackerField struct {
	Name  string
	Value string
}

type trackerTextSlot struct {
	Offset int64
	Size   int
}

type trackerMessageRegion struct {
	Offset    int64
	Size      int
	Separator byte
}

type trackerView struct {
	format      ContainerKind
	Fields      []trackerField
	titleSlot   trackerTextSlot
	trackerSlot trackerTextSlot
	commentSlot []trackerTextSlot
	message     trackerMessageRegion
}

func (v *trackerView) add(name, value string) {
	if v == nil || name == "" || value == "" {
		return
	}
	v.Fields = append(v.Fields, trackerField{Name: name, Value: value})
}

func (v *trackerView) Get(name string) string {
	if v == nil {
		return ""
	}
	for i := len(v.Fields) - 1; i >= 0; i-- {
		if strings.EqualFold(v.Fields[i].Name, name) {
			return v.Fields[i].Value
		}
	}
	return ""
}

func (v *trackerView) GetAll(name string) []string {
	if v == nil {
		return nil
	}
	var out []string
	for _, f := range v.Fields {
		if strings.EqualFold(f.Name, name) {
			out = append(out, f.Value)
		}
	}
	return out
}

func (v *trackerView) Set(name, value string) {
	if v == nil || name == "" {
		return
	}
	kept := v.Fields[:0]
	for _, f := range v.Fields {
		if !strings.EqualFold(f.Name, name) {
			kept = append(kept, f)
		}
	}
	v.Fields = kept
	if value != "" {
		v.Fields = append(v.Fields, trackerField{Name: name, Value: value})
	}
}

func normaliseTrackerComment(lines []string) string {
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}

func isTrackerContainer(kind ContainerKind) bool {
	switch kind {
	case ContainerMOD, ContainerS3M, ContainerXM, ContainerIT:
		return true
	}
	return false
}

func (f *File) detectTracker() error {
	view, err := readTrackerMetadata(f.src, f.size, f.container.Kind())
	if err != nil {
		return err
	}
	f.tracker = view
	return nil
}

func readTrackerMetadata(r io.ReaderAt, size int64, kind ContainerKind) (*trackerView, error) {
	switch kind {
	case ContainerMOD:
		return readMODMetadata(r, size)
	case ContainerS3M:
		return readS3MMetadata(r, size)
	case ContainerXM:
		return readXMMetadata(r, size)
	case ContainerIT:
		return readITMetadata(r, size)
	}
	return nil, fmt.Errorf("tracker: unsupported container %v", kind)
}

func readMODMetadata(r io.ReaderAt, size int64) (*trackerView, error) {
	if size < 1084 {
		return nil, fmt.Errorf("mod: short file")
	}
	var sig [4]byte
	if _, err := r.ReadAt(sig[:], 1080); err != nil {
		return nil, err
	}
	trackerName, instruments, ok := decodeMODSignature(string(sig[:]))
	if !ok {
		return nil, fmt.Errorf("mod: unsupported signature %q", string(sig[:]))
	}
	view := &trackerView{
		format:    ContainerMOD,
		titleSlot: trackerTextSlot{Offset: 0, Size: 20},
	}
	title, _ := readTrackerString(r, 0, 20)
	view.add("TITLE", title)
	if trackerName != "" {
		view.add("TRACKERNAME", trackerName)
		view.add("ENCODER", trackerName)
	}
	var lines []string
	for i := 0; i < instruments; i++ {
		off := int64(20 + i*30)
		s, err := readTrackerString(r, off, 22)
		if err != nil {
			break
		}
		lines = append(lines, s)
		view.commentSlot = append(view.commentSlot, trackerTextSlot{Offset: off, Size: 22})
	}
	view.add("COMMENT", normaliseTrackerComment(lines))
	return view, nil
}

func decodeMODSignature(sig string) (trackerName string, instruments int, ok bool) {
	switch {
	case sig == "M.K." || sig == "M!K!" || sig == "M&K!" || sig == "N.T.":
		return "ProTracker", 31, true
	case strings.HasPrefix(sig, "FLT") || strings.HasPrefix(sig, "TDZ"):
		return "StarTrekker", 31, true
	case strings.HasSuffix(sig, "CHN"):
		return "StarTrekker", 31, true
	case sig == "CD81" || sig == "OKTA":
		return "Atari Oktalyzer", 31, true
	case strings.HasSuffix(sig, "CH") || strings.HasSuffix(sig, "CN"):
		return "TakeTracker", 31, true
	}
	return "", 0, false
}

func readS3MMetadata(r io.ReaderAt, size int64) (*trackerView, error) {
	if size < 96 {
		return nil, fmt.Errorf("s3m: short file")
	}
	var head [48]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	if head[28] != 0x1A || head[29] != 0x10 || string(head[44:48]) != "SCRM" {
		return nil, fmt.Errorf("s3m: bad header")
	}
	length := int(binary.LittleEndian.Uint16(head[32:34]))
	sampleCount := int(binary.LittleEndian.Uint16(head[34:36]))
	trackerVersion := binary.LittleEndian.Uint16(head[40:42])
	view := &trackerView{
		format:    ContainerS3M,
		titleSlot: trackerTextSlot{Offset: 0, Size: 28},
	}
	view.add("TITLE", trimTrackerString(head[:28]))
	trackerName := trackerNameFromS3MVersion(trackerVersion)
	view.add("TRACKERNAME", trackerName)
	view.add("ENCODER", trackerName)
	var lines []string
	for i := 0; i < sampleCount; i++ {
		ptrOff := int64(96 + length + i*2)
		var paraBuf [2]byte
		if _, err := r.ReadAt(paraBuf[:], ptrOff); err != nil {
			break
		}
		headerOff := int64(binary.LittleEndian.Uint16(paraBuf[:])) << 4
		if headerOff <= 0 || headerOff+76 > size {
			continue
		}
		name, err := readTrackerString(r, headerOff+48, 28)
		if err != nil {
			continue
		}
		lines = append(lines, name)
		view.commentSlot = append(view.commentSlot, trackerTextSlot{Offset: headerOff + 48, Size: 28})
	}
	view.add("COMMENT", normaliseTrackerComment(lines))
	return view, nil
}

func trackerNameFromS3MVersion(version uint16) string {
	if version == 0 {
		return "Scream Tracker III"
	}
	major := int((version >> 8) & 0x0F)
	minor := int(version & 0xFF)
	if major > 0 {
		return fmt.Sprintf("Scream Tracker %d.%02X", major, minor)
	}
	return "Scream Tracker III"
}

func readXMMetadata(r io.ReaderAt, size int64) (*trackerView, error) {
	if size < 80 {
		return nil, fmt.Errorf("xm: short file")
	}
	var head [80]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	if string(head[:17]) != "Extended Module: " {
		return nil, fmt.Errorf("xm: bad magic")
	}
	headerSize := int64(binary.LittleEndian.Uint32(head[60:64]))
	patternCount := int(binary.LittleEndian.Uint16(head[70:72]))
	instrumentCount := int(binary.LittleEndian.Uint16(head[72:74]))
	view := &trackerView{
		format:      ContainerXM,
		titleSlot:   trackerTextSlot{Offset: 17, Size: 20},
		trackerSlot: trackerTextSlot{Offset: 38, Size: 20},
	}
	view.add("TITLE", trimTrackerString(head[17:37]))
	trackerName := trimTrackerString(head[38:58])
	view.add("TRACKERNAME", trackerName)
	view.add("ENCODER", trackerName)
	pos := int64(60) + headerSize
	for i := 0; i < patternCount && pos+9 <= size; i++ {
		var patHdr [9]byte
		if _, err := r.ReadAt(patHdr[:], pos); err != nil {
			return view, nil
		}
		patternHeaderLen := int64(binary.LittleEndian.Uint32(patHdr[:4]))
		if patternHeaderLen < 4 || pos+patternHeaderLen > size {
			return view, nil
		}
		dataSize := int64(binary.LittleEndian.Uint16(patHdr[7:9]))
		pos += patternHeaderLen + dataSize
		if pos > size {
			return view, nil
		}
	}
	var instrumentNames []string
	var sampleNames []string
	for i := 0; i < instrumentCount && pos+4 <= size; i++ {
		var instHdr [33]byte
		n := len(instHdr)
		if pos+int64(n) > size {
			n = int(size - pos)
		}
		if _, err := r.ReadAt(instHdr[:n], pos); err != nil {
			return view, nil
		}
		instrumentHeaderSize := int64(binary.LittleEndian.Uint32(instHdr[:4]))
		if instrumentHeaderSize < 4 || pos+instrumentHeaderSize > size {
			return view, nil
		}
		nameLen := int(min(instrumentHeaderSize-4, 22))
		name, _ := readTrackerString(r, pos+4, nameLen)
		instrumentNames = append(instrumentNames, name)
		view.commentSlot = append(view.commentSlot, trackerTextSlot{Offset: pos + 4, Size: nameLen})
		sampleCount := 0
		if instrumentHeaderSize >= 29 {
			var buf [2]byte
			if _, err := r.ReadAt(buf[:], pos+27); err == nil {
				sampleCount = int(binary.LittleEndian.Uint16(buf[:]))
			}
		}
		sampleHeaderSize := int64(0)
		if sampleCount > 0 && instrumentHeaderSize >= 33 {
			var buf [4]byte
			if _, err := r.ReadAt(buf[:], pos+29); err == nil {
				sampleHeaderSize = int64(binary.LittleEndian.Uint32(buf[:]))
			}
		}
		pos += instrumentHeaderSize
		var sampleDataBytes int64
		for j := 0; j < sampleCount && sampleHeaderSize > 0 && pos+sampleHeaderSize <= size; j++ {
			var sampleLenBuf [4]byte
			if _, err := r.ReadAt(sampleLenBuf[:], pos); err != nil {
				break
			}
			sampleDataBytes += int64(binary.LittleEndian.Uint32(sampleLenBuf[:]))
			if sampleHeaderSize > 18 {
				nameLen := int(min(sampleHeaderSize-18, 22))
				name, _ := readTrackerString(r, pos+18, nameLen)
				sampleNames = append(sampleNames, name)
				view.commentSlot = append(view.commentSlot, trackerTextSlot{Offset: pos + 18, Size: nameLen})
			}
			pos += sampleHeaderSize
		}
		pos += sampleDataBytes
		if pos > size {
			return view, nil
		}
	}
	comment := append(instrumentNames, sampleNames...)
	view.add("COMMENT", strings.Join(comment, "\n"))
	return view, nil
}

func readITMetadata(r io.ReaderAt, size int64) (*trackerView, error) {
	if size < 64 {
		return nil, fmt.Errorf("it: short file")
	}
	var head [64]byte
	if _, err := r.ReadAt(head[:], 0); err != nil {
		return nil, err
	}
	if string(head[:4]) != "IMPM" {
		return nil, fmt.Errorf("it: bad magic")
	}
	length := int(binary.LittleEndian.Uint16(head[32:34]))
	instrumentCount := int(binary.LittleEndian.Uint16(head[34:36]))
	sampleCount := int(binary.LittleEndian.Uint16(head[36:38]))
	special := binary.LittleEndian.Uint16(head[46:48])
	view := &trackerView{
		format:    ContainerIT,
		titleSlot: trackerTextSlot{Offset: 4, Size: 26},
	}
	view.add("TITLE", trimTrackerString(head[4:30]))
	trackerName := "Impulse Tracker"
	view.add("TRACKERNAME", trackerName)
	view.add("ENCODER", trackerName)
	if special&0x1 != 0 && size >= 60 {
		msgLen := int(binary.LittleEndian.Uint16(head[54:56]))
		msgOff := int64(binary.LittleEndian.Uint32(head[56:60]))
		if msgLen > 0 && msgOff > 0 && msgOff+int64(msgLen) <= size {
			view.message = trackerMessageRegion{Offset: msgOff, Size: msgLen, Separator: '\r'}
			msg, err := readTrackerRawString(r, msgOff, msgLen)
			if err == nil {
				msg = strings.ReplaceAll(msg, "\r", "\n")
				if msg != "" {
					view.add("MESSAGE", msg)
				}
			}
		}
	}
	base := int64(192 + length)
	var lines []string
	for i := 0; i < instrumentCount; i++ {
		ptrOff := base + int64(i*4)
		var buf [4]byte
		if _, err := r.ReadAt(buf[:], ptrOff); err != nil {
			break
		}
		instOff := int64(binary.LittleEndian.Uint32(buf[:]))
		if instOff <= 0 || instOff+58 > size {
			continue
		}
		name, err := readTrackerString(r, instOff+32, 26)
		if err != nil {
			continue
		}
		lines = append(lines, name)
		view.commentSlot = append(view.commentSlot, trackerTextSlot{Offset: instOff + 32, Size: 26})
	}
	sampleBase := base + int64(instrumentCount*4)
	for i := 0; i < sampleCount; i++ {
		ptrOff := sampleBase + int64(i*4)
		var buf [4]byte
		if _, err := r.ReadAt(buf[:], ptrOff); err != nil {
			break
		}
		sampOff := int64(binary.LittleEndian.Uint32(buf[:]))
		if sampOff <= 0 || sampOff+46 > size {
			continue
		}
		name, err := readTrackerString(r, sampOff+20, 26)
		if err != nil {
			continue
		}
		lines = append(lines, name)
		view.commentSlot = append(view.commentSlot, trackerTextSlot{Offset: sampOff + 20, Size: 26})
	}
	comment := normaliseTrackerComment(lines)
	if msg := view.Get("MESSAGE"); msg != "" {
		if comment != "" {
			comment += "\n" + msg
		} else {
			comment = msg
		}
	}
	view.add("COMMENT", comment)
	return view, nil
}

func readTrackerString(r io.ReaderAt, off int64, size int) (string, error) {
	raw, err := readTrackerBytes(r, off, size)
	if err != nil {
		return "", err
	}
	return trimTrackerString(raw), nil
}

func readTrackerRawString(r io.ReaderAt, off int64, size int) (string, error) {
	raw, err := readTrackerBytes(r, off, size)
	if err != nil {
		return "", err
	}
	if i := indexByte(raw, 0); i >= 0 {
		raw = raw[:i]
	}
	return strings.TrimRight(string(raw), "\x00 "), nil
}

func readTrackerBytes(r io.ReaderAt, off int64, size int) ([]byte, error) {
	buf := make([]byte, size)
	if _, err := r.ReadAt(buf, off); err != nil {
		return nil, err
	}
	return buf, nil
}

func trimTrackerString(raw []byte) string {
	if i := indexByte(raw, 0); i >= 0 {
		raw = raw[:i]
	}
	for i, b := range raw {
		if b == 0xFF {
			raw[i] = ' '
		}
	}
	return strings.TrimRight(string(raw), "\x00 ")
}

func trackerFieldFor(frameID string) []string {
	switch frameID {
	case id3v2.FrameTitle:
		return []string{"TITLE"}
	case id3v2.FrameComment:
		return []string{"COMMENT"}
	case id3v2.FrameEncodedBy:
		return []string{"TRACKERNAME", "ENCODER"}
	}
	return nil
}

func trackerFieldWritable(v *trackerView, frameID string) bool {
	if v == nil {
		return false
	}
	switch frameID {
	case id3v2.FrameTitle:
		return v.titleSlot.Size > 0
	case id3v2.FrameComment:
		return len(v.commentSlot) > 0 || v.message.Size > 0
	case id3v2.FrameEncodedBy:
		return v.trackerSlot.Size > 0
	}
	return false
}

func (f *File) saveTracker() error {
	if f.tracker == nil {
		return ErrContainerWriteUnsupported
	}
	w, err := f.writable()
	if err != nil {
		return err
	}
	if err := f.writeTrackerSlot(w, f.tracker.titleSlot, f.tracker.Get("TITLE"), "title"); err != nil {
		return err
	}
	if f.tracker.trackerSlot.Size > 0 {
		name := f.tracker.Get("TRACKERNAME")
		if name == "" {
			name = f.tracker.Get("ENCODER")
		}
		if err := f.writeTrackerSlot(w, f.tracker.trackerSlot, name, "tracker"); err != nil {
			return err
		}
	}
	lines := splitTrackerComment(f.tracker.Get("COMMENT"))
	if len(lines) > 0 && len(f.tracker.commentSlot) == 0 && f.tracker.message.Size == 0 {
		f.recordErr(fmt.Errorf("mtag: tracker comment dropped: file has no writable comment slots"))
		return nil
	}
	for i, slot := range f.tracker.commentSlot {
		line := ""
		if i < len(lines) {
			line = lines[i]
		}
		if err := f.writeTrackerSlot(w, slot, line, "comment"); err != nil {
			return err
		}
	}
	if len(lines) > len(f.tracker.commentSlot) {
		tail := lines[len(f.tracker.commentSlot):]
		if f.tracker.message.Size > 0 {
			if err := f.writeTrackerMessage(w, tail); err != nil {
				return err
			}
		} else {
			f.recordErr(fmt.Errorf("mtag: tracker comment truncated to %d line slots", len(f.tracker.commentSlot)))
		}
	} else if f.tracker.message.Size > 0 {
		if err := f.writeTrackerMessage(w, nil); err != nil {
			return err
		}
	}
	return nil
}

func splitTrackerComment(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

func (f *File) writeTrackerSlot(w WritableSource, slot trackerTextSlot, value, field string) error {
	if slot.Size <= 0 {
		return nil
	}
	buf := make([]byte, slot.Size)
	out, truncated, substituted := truncateLatinWithReport(value, slot.Size)
	copy(buf, []byte(out))
	switch {
	case truncated && substituted:
		f.recordErr(fmt.Errorf("mtag: tracker %s write truncated and replaced non-Latin-1 runes", field))
	case truncated:
		f.recordErr(fmt.Errorf("mtag: tracker %s write truncated to %d bytes", field, slot.Size))
	case substituted:
		f.recordErr(fmt.Errorf("mtag: tracker %s write replaced non-Latin-1 runes", field))
	}
	_, err := w.WriteAt(buf, slot.Offset)
	return err
}

func (f *File) writeTrackerMessage(w WritableSource, lines []string) error {
	region := f.tracker.message
	if region.Size <= 0 {
		return nil
	}
	buf := make([]byte, region.Size)
	if len(lines) > 0 {
		sep := string([]byte{region.Separator})
		msg, truncated, substituted := truncateLatinWithReport(strings.Join(lines, sep), max(region.Size-1, 0))
		copy(buf, []byte(msg))
		if len(msg) < len(buf) {
			buf[len(msg)] = 0
		}
		switch {
		case truncated && substituted:
			f.recordErr(fmt.Errorf("mtag: tracker message write truncated and replaced non-Latin-1 runes"))
		case truncated:
			f.recordErr(fmt.Errorf("mtag: tracker message write truncated to %d bytes", region.Size))
		case substituted:
			f.recordErr(fmt.Errorf("mtag: tracker message write replaced non-Latin-1 runes"))
		}
	}
	_, err := w.WriteAt(buf, region.Offset)
	return err
}

type trackerTagView struct{ v *trackerView }

func (v *trackerTagView) Kind() TagKind { return TagTracker }

func (v *trackerTagView) Keys() []string {
	if v.v == nil {
		return nil
	}
	out := make([]string, 0, len(v.v.Fields))
	seen := make(map[string]bool, len(v.v.Fields))
	for _, f := range v.v.Fields {
		if !seen[f.Name] {
			seen[f.Name] = true
			out = append(out, f.Name)
		}
	}
	return out
}

func (v *trackerTagView) Get(name string) string { return v.v.Get(name) }
