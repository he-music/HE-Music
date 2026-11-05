//go:build linux

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

func metadataCheckAttributes(file *os.File) error {
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return err
	}
	if stat.Mode&(unix.S_ISUID|unix.S_ISGID) != 0 {
		return errors.New("unsupported privileged file mode")
	}
	// FS_IOC_GETFLAGS uses sizeof(long); the extent-layout flag needs no copying.
	flags, err := unix.IoctlGetInt(int(file.Fd()), unix.FS_IOC_GETFLAGS)
	if err != nil && err != unix.ENOTTY && err != unix.EOPNOTSUPP {
		return err
	}
	if flags & ^0x80000 != 0 {
		return errors.New("unsupported inode flags")
	}
	_, err = metadataLinuxAttributes(file)
	return err
}

// Operate on pinned descriptors, including ACL xattrs, never on a resolved pathname.
func metadataLinuxAttributes(file *os.File) (map[string][]byte, error) {
	buffer := make([]byte, 65536) // Linux limits both xattr lists and values to 64 KiB.
	n, err := unix.Flistxattr(int(file.Fd()), buffer)
	if err == unix.EOPNOTSUPP {
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
		if !strings.HasPrefix(name, "user.") && name != "system.posix_acl_access" && name != "security.selinux" {
			return nil, errors.New("unsupported extended attribute: " + name)
		}
		value := make([]byte, 65536)
		size, err := unix.Fgetxattr(int(file.Fd()), name, value)
		if err != nil {
			return nil, err
		}
		attributes[name] = value[:size]
	}
	return attributes, nil
}

func metadataPrepareSELinuxLabel(destination *os.File, source, inherited map[string][]byte) error {
	sourceLabel, sourceLabeled := source["security.selinux"]
	destinationLabel, destinationLabeled := inherited["security.selinux"]
	if sourceLabeled && destinationLabeled && bytes.Equal(sourceLabel, destinationLabel) {
		return nil
	}
	if !sourceLabeled {
		if destinationLabeled {
			return errors.New("SELinux label mismatch: source has no security.selinux label")
		}
		return nil
	}
	if err := unix.Fsetxattr(int(destination.Fd()), "security.selinux", sourceLabel, 0); err != nil {
		return fmt.Errorf("cannot set security.selinux label: %w", err)
	}
	actual, err := metadataLinuxAttributes(destination)
	if err != nil {
		return fmt.Errorf("cannot read security.selinux label after setting: %w", err)
	}
	if !bytes.Equal(actual["security.selinux"], sourceLabel) {
		return errors.New("security.selinux label differs after setting")
	}
	return nil
}

func metadataCopyAttributes(source, destination *os.File) error {
	if err := metadataCheckAttributes(source); err != nil {
		return err
	}
	var stat, target unix.Stat_t
	if err := unix.Fstat(int(source.Fd()), &stat); err != nil {
		return err
	}
	if err := unix.Fstat(int(destination.Fd()), &target); err != nil {
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
	if err := metadataPrepareSELinuxLabel(destination, attributes, inherited); err != nil {
		return err
	}
	if stat.Uid != target.Uid || stat.Gid != target.Gid {
		if err := unix.Fchown(int(destination.Fd()), int(stat.Uid), int(stat.Gid)); err != nil {
			return err
		}
	}
	if err := unix.Fchmod(int(destination.Fd()), stat.Mode&0o7777); err != nil {
		return err
	}
	for name := range inherited {
		if name == "security.selinux" {
			continue
		}
		if _, present := attributes[name]; !present {
			if err := unix.Fremovexattr(int(destination.Fd()), name); err != nil {
				return err
			}
		}
	}
	for name, value := range attributes {
		if name == "security.selinux" {
			continue
		}
		if err := unix.Fsetxattr(int(destination.Fd()), name, value, 0); err != nil {
			return err
		}
	}
	// Keep the NULL-path utimensat form: x/sys UtimesNanoAt accepts only a
	// pathname. Futimes loses nanoseconds; AT_EMPTY_PATH needs Linux 5.8.
	times := [2]unix.Timespec{stat.Atim, stat.Mtim}
	_, _, errno := unix.Syscall6(unix.SYS_UTIMENSAT, destination.Fd(), 0, uintptr(unsafe.Pointer(&times)), 0, 0, 0)
	if errno != 0 {
		return errno
	}
	var copied unix.Stat_t
	if err := unix.Fstat(int(destination.Fd()), &copied); err != nil {
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
