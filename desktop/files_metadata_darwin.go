//go:build darwin

package main

import (
	"errors"
	"os"
	"sync"
	"syscall"

	"github.com/ebitengine/purego"
)

var metadataCopyfile struct {
	once sync.Once
	call func(int32, int32, uintptr, uint32) int32
	err  error
}

func metadataCheckAttributes(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	// Immutable/append/restricted and other flags cannot safely be staged and
	// removed through the generic Root transaction. Never silently drop them.
	if !ok || stat.Flags != 0 || info.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 {
		return errors.New("unsupported file flags or privileged mode")
	}
	return nil
}

func metadataCopyAttributes(source, destination *os.File) error {
	if err := metadataCheckAttributes(source); err != nil {
		return err
	}
	metadataCopyfile.once.Do(func() {
		library, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_LOCAL)
		if err != nil {
			metadataCopyfile.err = err
			return
		}
		symbol, err := purego.Dlsym(library, "fcopyfile")
		if err != nil {
			metadataCopyfile.err = err
			return
		}
		purego.RegisterFunc(&metadataCopyfile.call, symbol)
	})
	if metadataCopyfile.err != nil {
		return metadataCopyfile.err
	}
	// macOS SDK copyfile.h: ACL=1<<0, STAT=1<<1, XATTR=1<<2;
	// COPYFILE_METADATA=7, with no DATA bit. FDs are already pinned and private.
	// man copyfile: NULL state is allowed; EXCL/NOFOLLOW are path-only flags.
	if metadataCopyfile.call(int32(source.Fd()), int32(destination.Fd()), 0, 7) != 0 {
		return errors.New("fcopyfile metadata failed")
	}
	before, err := source.Stat()
	if err != nil {
		return err
	}
	after, err := destination.Stat()
	if err != nil {
		return err
	}
	a, okA := before.Sys().(*syscall.Stat_t)
	b, okB := after.Sys().(*syscall.Stat_t)
	if !okA || !okB || a.Uid != b.Uid || a.Gid != b.Gid || a.Flags != b.Flags || before.Mode() != after.Mode() {
		return errors.New("file attributes differ after copy")
	}
	return nil
}
