package mygo

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

// readShared reads the file at path through openShared, which shares its
// deletion: os.ReadFile does not, and while it held the file open, a save
// replacing it was refused ("Access is denied"), so that a goroutine
// reading an app file in a loop could make another's save run out of
// retries.
func readShared(path string) ([]byte, error) {
	f, err := openShared(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// renameOver renames from over to, its sibling, with POSIX semantics
// (os.Root.Rename), which replace a file that others hold open sharing its
// deletion, as readShared does. os.Rename's MoveFileEx is refused while
// any handle to the file is open, whatever it shares. The root comes from
// fileWatchOpenRoot, which shares the directory's deletion.
func renameOver(from, to string) error {
	dir := filepath.Dir(to)
	if filepath.Dir(from) != dir {
		return os.Rename(from, to)
	}
	root, err := fileWatchOpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	err = root.Rename(filepath.Base(from), filepath.Base(to))
	if le := (*os.LinkError)(nil); errors.As(err, &le) {
		err = &os.LinkError{Op: "rename", Old: from, New: to, Err: le.Err}
	}
	return err
}
