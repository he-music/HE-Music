//go:build linux

package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"reflect"
	"syscall"
	"testing"
	"unsafe"
)

func TestMetadataLinuxAttributes(t *testing.T) {
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	destination, err := os.CreateTemp(t.TempDir(), "destination")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	if err := source.Chmod(0640); err != nil {
		t.Fatal(err)
	}
	if err := metadataCheckAttributes(source); err != nil {
		t.Fatal(err)
	}
	for _, value := range [][]byte{[]byte("tag attribute"), {}} {
		if _, err := metadataLinuxXattr(source, syscall.SYS_FSETXATTR, "user.music", value); err != nil {
			if err == syscall.EOPNOTSUPP {
				t.Skip("filesystem does not support xattrs")
			}
			t.Fatal(err)
		}
		if _, err := metadataLinuxXattr(destination, syscall.SYS_FSETXATTR, "user.stale", []byte("remove")); err != nil {
			t.Fatal(err)
		}
		if err := metadataCopyAttributes(source, destination); err != nil {
			t.Fatal(err)
		}
		var before, after syscall.Stat_t
		if err := syscall.Fstat(int(source.Fd()), &before); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Fstat(int(destination.Fd()), &after); err != nil {
			t.Fatal(err)
		}
		if before.Mode != after.Mode || before.Uid != after.Uid || before.Gid != after.Gid || before.Atim != after.Atim || before.Mtim != after.Mtim {
			t.Fatalf("attributes differ: source=%+v destination=%+v", before, after)
		}
		expected, err := metadataLinuxAttributes(source)
		if err != nil {
			t.Fatal(err)
		}
		attrs, err := metadataLinuxAttributes(destination)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(attrs, expected) {
			t.Fatalf("attributes differ: got=%v want=%v", attrs, expected)
		}
		if actual, ok := attrs["user.music"]; !ok || !bytes.Equal(actual, value) {
			t.Fatalf("user.music was not preserved: %v", attrs)
		}
	}
}

func TestMetadataLinuxACL(t *testing.T) {
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	destination, err := os.CreateTemp(t.TempDir(), "destination")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	// Linux POSIX ACL xattr version 2: owner, named user, group, mask, other.
	acl := make([]byte, 4+5*8)
	binary.LittleEndian.PutUint32(acl, 2)
	for i, entry := range [][3]uint32{{1, 6, 0xffffffff}, {2, 4, uint32(os.Getuid() + 1)}, {4, 4, 0xffffffff}, {16, 4, 0xffffffff}, {32, 0, 0xffffffff}} {
		offset := 4 + i*8
		binary.LittleEndian.PutUint16(acl[offset:], uint16(entry[0]))
		binary.LittleEndian.PutUint16(acl[offset+2:], uint16(entry[1]))
		binary.LittleEndian.PutUint32(acl[offset+4:], entry[2])
	}
	if _, err := metadataLinuxXattr(source, syscall.SYS_FSETXATTR, "system.posix_acl_access", acl); err != nil {
		if err == syscall.EOPNOTSUPP {
			t.Skip("filesystem does not support POSIX ACLs")
		}
		t.Fatal(err)
	}
	if err := metadataCopyAttributes(source, destination); err != nil {
		t.Fatal(err)
	}
	attributes, err := metadataLinuxAttributes(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(attributes["system.posix_acl_access"], acl) {
		t.Fatal("ACL was not preserved")
	}
	// A destination ACL inherited from its parent must not survive an ACL-free source.
	if _, err := metadataLinuxXattr(source, syscall.SYS_FREMOVEXATTR, "system.posix_acl_access", nil); err != nil {
		t.Fatal(err)
	}
	if err := metadataCopyAttributes(source, destination); err != nil {
		t.Fatal(err)
	}
	attributes, err = metadataLinuxAttributes(destination)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := attributes["system.posix_acl_access"]; exists {
		t.Fatal("stale destination ACL survived")
	}
}

func TestMetadataLinuxRejectsPrivilegedMode(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := file.Chmod(0600 | os.ModeSetuid); err != nil {
		t.Fatal(err)
	}
	if err := metadataCheckAttributes(file); err == nil {
		t.Fatal("setuid file was accepted")
	}
}

func TestMetadataLinuxRejectsInodeFlags(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var flags uintptr
	get := uintptr(0x80006601) | unsafe.Sizeof(flags)<<16
	set := uintptr(0x40006602) | unsafe.Sizeof(flags)<<16
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), get, uintptr(unsafe.Pointer(&flags)))
	if errno == syscall.ENOTTY || errno == syscall.EOPNOTSUPP {
		t.Skip("filesystem does not support inode flags")
	}
	if errno != 0 {
		t.Fatal(errno)
	}
	original := flags
	flags |= 0x40 // FS_NODUMP_FL is owner-settable and cannot silently disappear.
	_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), set, uintptr(unsafe.Pointer(&flags)))
	if errno == syscall.EPERM || errno == syscall.EOPNOTSUPP {
		t.Skip("filesystem cannot set inode flags")
	}
	if errno != 0 {
		t.Fatal(errno)
	}
	defer func() {
		_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), set, uintptr(unsafe.Pointer(&original)))
		if errno != 0 {
			t.Error(errno)
		}
	}()
	if err := metadataCheckAttributes(file); err == nil {
		t.Fatal("inode flags were accepted")
	}
}

func TestMetadataLinuxSELinuxSameLabelIsReusable(t *testing.T) {
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	destination, err := os.CreateTemp(t.TempDir(), "destination")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	sourceAttrs, err := metadataLinuxAttributes(source)
	if err != nil {
		t.Fatal(err)
	}
	destinationAttrs, err := metadataLinuxAttributes(destination)
	if err != nil {
		t.Fatal(err)
	}
	sourceLabel, sourceLabeled := sourceAttrs["security.selinux"]
	destinationLabel, destinationLabeled := destinationAttrs["security.selinux"]
	if !sourceLabeled || !destinationLabeled {
		t.Skipf("SELinux same-label integration case unavailable: sourceLabeled=%t destinationLabeled=%t", sourceLabeled, destinationLabeled)
	}
	if !bytes.Equal(sourceLabel, destinationLabel) {
		t.Skipf("SELinux same-label integration case unavailable: source=%q destination=%q", sourceLabel, destinationLabel)
	}
	if err := metadataPrepareSELinuxLabel(destination, sourceAttrs, destinationAttrs); err != nil {
		t.Fatal(err)
	}
}

func TestMetadataLinuxSELinuxDifferentLabelRequiresVerifiedWrite(t *testing.T) {
	destination, err := os.CreateTemp(t.TempDir(), "destination")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	before, err := metadataLinuxAttributes(destination)
	if err != nil {
		t.Fatal(err)
	}
	label, ok := before["security.selinux"]
	if !ok || len(label) == 0 {
		t.Skipf("SELinux different-label integration case unavailable: attributes=%v", before)
	}
	different := append(append([]byte(nil), label...), []byte("-different")...)
	err = metadataPrepareSELinuxLabel(destination, map[string][]byte{"security.selinux": different}, before)
	after, readErr := metadataLinuxAttributes(destination)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if err != nil {
		if !reflect.DeepEqual(after, before) {
			t.Fatalf("failed label update changed destination: before=%v after=%v", before, after)
		}
		return
	}
	if !bytes.Equal(after["security.selinux"], different) {
		t.Fatalf("label update succeeded without matching readback: got=%v want=%v", after["security.selinux"], different)
	}
}
