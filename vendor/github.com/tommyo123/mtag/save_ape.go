package mtag

import "fmt"

func supportsRawAPETail(kind ContainerKind) bool {
	switch kind {
	case ContainerMP3, ContainerAAC, ContainerAC3, ContainerDTS, ContainerAMR, ContainerTTA:
		return true
	}
	return false
}

// saveRawAPETail rewrites a trailing APEv2 region that lives before an
// optional ID3v1 footer on raw audio files.
func (f *File) saveRawAPETail() error {
	if !supportsRawAPETail(f.Container()) {
		return fmt.Errorf("mtag: saveRawAPETail called on %v", f.Container())
	}
	if f.ape == nil && f.apeLen == 0 {
		return nil
	}

	fd, err := f.writable()
	if err != nil {
		return err
	}

	regionStart := f.apeAt
	if f.apeLen == 0 {
		regionStart = f.size
		if f.formatsOnDisk().Has(FormatID3v1) && regionStart >= 128 {
			regionStart -= 128
		}
	}
	tailStart := regionStart + f.apeLen
	tailLen := f.size - tailStart
	if tailLen < 0 {
		tailLen = 0
	}

	var tail []byte
	if tailLen > 0 {
		tail = make([]byte, tailLen)
		if _, err := f.src.ReadAt(tail, tailStart); err != nil {
			return err
		}
	}

	var encoded []byte
	if f.ape != nil {
		encoded, err = f.ape.Encode()
		if err != nil {
			return err
		}
	}

	if len(encoded) > 0 {
		if _, err := fd.WriteAt(encoded, regionStart); err != nil {
			return err
		}
	}
	if len(tail) > 0 {
		if _, err := fd.WriteAt(tail, regionStart+int64(len(encoded))); err != nil {
			return err
		}
	}

	newSize := regionStart + int64(len(encoded)) + int64(len(tail))
	if newSize < f.size {
		if err := fd.Truncate(newSize); err != nil {
			return err
		}
	}
	f.size = newSize
	if len(encoded) == 0 {
		f.apeAt = 0
		f.apeLen = 0
		return nil
	}
	f.apeAt = regionStart
	f.apeLen = int64(len(encoded))
	return nil
}

// saveMAC rewrites the trailing APE region of an APE-native file:
// Monkey's Audio (.ape / "MAC "), WavPack (.wv) or Musepack (.mpc).
// When the new tag is smaller than the original, the file is
// truncated; when it is larger, the tail is rewritten in place
// starting at the original APE offset. All three formats keep the
// audio payload strictly before the APE region, so a simple EOF
// patch suffices — no full container rewrite is required.
func (f *File) saveMAC() error {
	switch f.container.Kind() {
	case ContainerMAC, ContainerWavPack, ContainerMPC, ContainerTAK:
	default:
		return fmt.Errorf("mtag: saveMAC called on %v", f.container.Kind())
	}

	// Nothing to write: strip an existing APE region, leave the
	// audio alone.
	if f.ape == nil {
		if f.apeLen == 0 {
			return nil
		}
		fd, err := f.writable()
		if err != nil {
			return err
		}
		if err := fd.Truncate(f.apeAt); err != nil {
			return err
		}
		f.size = f.apeAt
		f.apeLen = 0
		f.apeAt = 0
		return nil
	}

	encoded, err := f.ape.Encode()
	if err != nil {
		return err
	}

	// Figure out where the APE region starts. If no APE was
	// originally present, the new tag goes at end-of-audio (i.e.
	// current file size).
	regionStart := f.apeAt
	if f.apeLen == 0 {
		regionStart = f.size
	}

	fd, err := f.writable()
	if err != nil {
		return err
	}
	if _, err := fd.WriteAt(encoded, regionStart); err != nil {
		return err
	}
	newSize := regionStart + int64(len(encoded))
	if newSize < f.size {
		if err := fd.Truncate(newSize); err != nil {
			return err
		}
	}
	// Refresh bookkeeping.
	f.size = newSize
	f.apeAt = regionStart
	f.apeLen = int64(len(encoded))
	return nil
}
