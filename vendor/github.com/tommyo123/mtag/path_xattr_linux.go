//go:build linux

package mtag

import (
	"bytes"
	"errors"
	"syscall"
)

func copyPathXattrs(src, dst string) {
	if src == "" || dst == "" {
		return
	}
	names, err := listPathXattrs(src)
	if err != nil {
		return
	}
	for _, name := range names {
		value, err := getPathXattr(src, name)
		if err != nil {
			continue
		}
		_ = syscall.Setxattr(dst, name, value, 0)
	}
}

func listPathXattrs(path string) ([]string, error) {
	size, err := syscall.Listxattr(path, nil)
	if err != nil {
		if errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.ENODATA) {
			return nil, nil
		}
		return nil, err
	}
	if size <= 0 {
		return nil, nil
	}
	buf := make([]byte, size)
	size, err = syscall.Listxattr(path, buf)
	if err != nil {
		if errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.ENODATA) {
			return nil, nil
		}
		return nil, err
	}
	buf = buf[:size]
	parts := bytes.Split(buf, []byte{0})
	names := make([]string, 0, len(parts))
	for _, part := range parts {
		if len(part) == 0 {
			continue
		}
		names = append(names, string(part))
	}
	return names, nil
}

func getPathXattr(path, name string) ([]byte, error) {
	size, err := syscall.Getxattr(path, name, nil)
	if err != nil {
		if errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.ENODATA) {
			return nil, err
		}
		return nil, err
	}
	if size <= 0 {
		return nil, nil
	}
	buf := make([]byte, size)
	size, err = syscall.Getxattr(path, name, buf)
	if err != nil {
		return nil, err
	}
	return buf[:size], nil
}
