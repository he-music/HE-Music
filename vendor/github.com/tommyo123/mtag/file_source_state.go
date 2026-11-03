package mtag

import (
	"io"
	"os"
)

func (f *File) attachReadOnlySource(src io.ReaderAt, size int64) {
	f.fd = nil
	f.src = src
	f.rw = nil
	f.size = size
	f.openedRW = false
}

func (f *File) attachWritableSource(src WritableSource, size int64) {
	f.fd = nil
	f.src = src
	f.rw = src
	f.size = size
	f.openedRW = true
}

func (f *File) attachPathHandle(path string, fd *os.File, writable bool, size int64) {
	f.path = path
	f.fd = fd
	f.src = fd
	f.size = size
	f.rw = nil
	f.openedRW = writable
	if writable {
		f.rw = fd
	}
}

func (f *File) clearSourceHandles() {
	f.fd = nil
	f.src = nil
	f.rw = nil
	f.openedRW = false
}

func (f *File) clearDetectedState() {
	f.v1 = nil
	f.v2 = nil
	f.v2at = 0
	f.v2size = 0
	f.v2corrupt = false
	f.formats = 0

	f.flac = nil
	f.oggErr = nil
	f.mp4 = nil
	f.mkv = nil
	f.tracker = nil

	f.ape = nil
	f.apeAt = 0
	f.apeLen = 0

	f.riffInfo = nil
	f.bwf = nil
	f.asf = nil
	f.realMedia = nil
	f.caf = nil

	f.container = nil
	f.audio = AudioProperties{}
	f.audioCached = false
}
