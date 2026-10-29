//go:build linux

package main

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

func metadataCheckAttributes(file *os.File) error {
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(file.Fd()), &stat); err != nil {
		return err
	}
	if stat.Mode&(syscall.S_ISUID|syscall.S_ISGID) != 0 {
		return errors.New("unsupported privileged file mode")
	}
	// FS_IOC_GETFLAGS uses sizeof(long); the extent-layout flag needs no copying.
	var flags uintptr
	request := uintptr(0x80006601) | unsafe.Sizeof(flags)<<16
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), request, uintptr(unsafe.Pointer(&flags)))
	if errno != 0 && errno != syscall.ENOTTY && errno != syscall.EOPNOTSUPP {
		return errno
	}
	if flags & ^uintptr(0x80000) != 0 {
		return errors.New("unsupported inode flags")
	}
	_, err := metadataLinuxAttributes(file)
	return err
}

// Operate on pinned descriptors, including ACL xattrs, never on a resolved pathname.
func metadataLinuxXattr(file *os.File, operation uintptr, name string, value []byte) (int, error) {
	var namePointer *byte
	if name != "" {
		var err error
		namePointer, err = syscall.BytePtrFromString(name)
		if err != nil {
			return 0, err
		}
	}
	var valuePointer *byte
	if len(value) != 0 {
		valuePointer = &value[0]
	}
	var n uintptr
	var errno syscall.Errno
	if operation == syscall.SYS_FLISTXATTR {
		n, _, errno = syscall.Syscall(operation, file.Fd(), uintptr(unsafe.Pointer(valuePointer)), uintptr(len(value)))
	} else {
		n, _, errno = syscall.Syscall6(operation, file.Fd(), uintptr(unsafe.Pointer(namePointer)), uintptr(unsafe.Pointer(valuePointer)), uintptr(len(value)), 0, 0)
	}
	if errno != 0 {
		return 0, errno
	}
	return int(n), nil
}

func metadataLinuxAttributes(file *os.File) (map[string][]byte, error) {
	buffer := make([]byte, 65536) // Linux limits both xattr lists and values to 64 KiB.
	n, err := metadataLinuxXattr(file, syscall.SYS_FLISTXATTR, "", buffer)
	if err == syscall.EOPNOTSUPP {
		return map[string][]byte{}, nil
	}
	if err != nil {
		return nil, err
	}
	attributes := make(map[string][]byte)
	for _, raw := range bytes.Split(buffer[:n], []byte{0}) {
		if len(raw) == 0 {
			continue
		}
		name := string(raw)
		if !strings.HasPrefix(name, "user.") && name != "system.posix_acl_access" {
			return nil, errors.New("unsupported extended attribute: " + name)
		}
		value := make([]byte, 65536)
		size, err := metadataLinuxXattr(file, syscall.SYS_FGETXATTR, name, value)
		if err != nil {
			return nil, err
		}
		attributes[name] = value[:size]
	}
	return attributes, nil
}

func metadataCopyAttributes(source, destination *os.File) error {
	if err := metadataCheckAttributes(source); err != nil {
		return err
	}
	var stat, target syscall.Stat_t
	if err := syscall.Fstat(int(source.Fd()), &stat); err != nil {
		return err
	}
	if err := syscall.Fstat(int(destination.Fd()), &target); err != nil {
		return err
	}
	if stat.Uid != target.Uid || stat.Gid != target.Gid {
		if err := syscall.Fchown(int(destination.Fd()), int(stat.Uid), int(stat.Gid)); err != nil {
			return err
		}
	}
	if err := syscall.Fchmod(int(destination.Fd()), stat.Mode&07777); err != nil {
		return err
	}
	attributes, err := metadataLinuxAttributes(source)
	if err != nil {
		return err
	}
	inherited, err := metadataLinuxAttributes(destination)
	if err != nil {
		return err
	}
	for name := range inherited {
		if _, present := attributes[name]; !present {
			if _, err := metadataLinuxXattr(destination, syscall.SYS_FREMOVEXATTR, name, nil); err != nil {
				return err
			}
		}
	}
	for name, value := range attributes {
		if _, err := metadataLinuxXattr(destination, syscall.SYS_FSETXATTR, name, value); err != nil {
			return err
		}
	}
	times := [2]syscall.Timespec{stat.Atim, stat.Mtim}
	_, _, errno := syscall.Syscall6(syscall.SYS_UTIMENSAT, destination.Fd(), 0, uintptr(unsafe.Pointer(&times)), 0, 0, 0)
	if errno != 0 {
		return errno
	}
	var copied syscall.Stat_t
	if err := syscall.Fstat(int(destination.Fd()), &copied); err != nil {
		return err
	}
	if copied.Uid != stat.Uid || copied.Gid != stat.Gid || copied.Mode != stat.Mode {
		return errors.New("file attributes differ after copy")
	}
	actual, err := metadataLinuxAttributes(destination)
	if err != nil {
		return err
	}
	if len(actual) != len(attributes) {
		return errors.New("extended attributes differ after copy")
	}
	for name, value := range attributes {
		if copied, present := actual[name]; !present || !bytes.Equal(copied, value) {
			return errors.New("extended attributes differ after copy")
		}
	}
	return nil
}
