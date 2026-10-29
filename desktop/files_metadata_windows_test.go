//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

func TestMetadataWindowsAttributes(t *testing.T) {
	source, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if _, err := source.Write([]byte("music")); err != nil {
		t.Fatal(err)
	}
	destination, err := os.CreateTemp(t.TempDir(), "destination")
	if err != nil {
		t.Fatal(err)
	}
	defer destination.Close()
	// Use an explicit protected DACL, distinguishable from directory inheritance.
	sddl, err := syscall.UTF16PtrFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	var descriptor uintptr
	convert := metadataAdvapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	ok, _, err := convert.Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		t.Fatal(err)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	var dacl uintptr
	var present, defaulted int32
	getDACL := metadataAdvapi32.NewProc("GetSecurityDescriptorDacl")
	ok, _, err = getDACL.Call(descriptor, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || present == 0 {
		t.Fatalf("read test DACL: %v", err)
	}
	handle, _, err := metadataReopen.Call(source.Fd(), 0x40000, 1|2|4, 0)
	if handle == ^uintptr(0) {
		t.Fatal(err)
	}
	code, _, _ := metadataSetSecurity.Call(handle, 1, 4|0x80000000, 0, 0, dacl, 0)
	syscall.CloseHandle(syscall.Handle(handle))
	if code != 0 {
		t.Fatal(syscall.Errno(code))
	}
	basic, err := metadataWindowsBasicInfo(source)
	if err != nil {
		t.Fatal(err)
	}
	basic.Attributes = 0x2 | 0x20 // hidden, archive
	basic.Creation, basic.Access, basic.Write, basic.Change = 132000000000000000, 132000000010000000, 132000000020000000, 132000000030000000
	ok, _, err = metadataSetInfo.Call(source.Fd(), 0, uintptr(unsafe.Pointer(&basic)), unsafe.Sizeof(basic))
	if ok == 0 {
		t.Fatal(err)
	}
	if err := metadataCheckAttributes(source); err != nil {
		t.Fatal(err)
	}
	if err := metadataCopyAttributes(source, destination); err != nil {
		t.Fatal(err)
	}
	actual, err := metadataWindowsBasicInfo(destination)
	if err != nil {
		t.Fatal(err)
	}
	if actual != basic {
		t.Fatalf("basic information changed: got %+v want %+v", actual, basic)
	}
	security, err := metadataWindowsReadSecurity(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(security.descriptor)))
	if security.control&0x1000 == 0 {
		t.Fatal("DACL protection was lost")
	}
}

func TestMetadataWindowsRejectsAlternateStreams(t *testing.T) {
	name := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(name, []byte("music"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name+":tags", []byte("preserve me"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(name)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := metadataCheckAttributes(file); err == nil {
		t.Fatal("alternate stream was accepted")
	}
	value, err := os.ReadFile(name + ":tags")
	if err != nil || string(value) != "preserve me" {
		t.Fatalf("alternate stream changed: %q %v", value, err)
	}
}

func TestMetadataWindowsRejectsExtendedAttributes(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Write([]byte("music")); err != nil {
		t.Fatal(err)
	}
	// FILE_FULL_EA_INFORMATION: next offset, flags, name length, value length,
	// NUL-terminated ASCII name, then value. All bytes belong to this temp file.
	ea := []byte{0, 0, 0, 0, 0, 4, 3, 0, 't', 'a', 'g', 's', 0, 'e', 'a', '!'}
	var statusBlock [2]uintptr
	setEA := syscall.NewLazyDLL("ntdll.dll").NewProc("NtSetEaFile")
	status, _, _ := setEA.Call(file.Fd(), uintptr(unsafe.Pointer(&statusBlock)), uintptr(unsafe.Pointer(&ea[0])), uintptr(len(ea)))
	if status != 0 {
		t.Fatalf("set temp EA: NTSTATUS %#x", status)
	}
	if err := metadataCheckAttributes(file); err == nil || !strings.Contains(err.Error(), "extended attributes are unsupported") {
		t.Fatalf("EA rejection was not specific: %v", err)
	}
}
