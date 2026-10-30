//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
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
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	handle, _, err := metadataReopen.Call(source.Fd(), windows.WRITE_DAC, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, 0)
	if handle == ^uintptr(0) {
		t.Fatal(err)
	}
	err = windows.SetSecurityInfo(windows.Handle(handle), windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
	windows.CloseHandle(windows.Handle(handle))
	if err != nil {
		t.Fatal(err)
	}
	basic, err := metadataWindowsBasicInfo(source)
	if err != nil {
		t.Fatal(err)
	}
	basic.Attributes = 0x2 | 0x20 // hidden, archive
	basic.Creation, basic.Access, basic.Write, basic.Change = 132000000000000000, 132000000010000000, 132000000020000000, 132000000030000000
	if err := windows.SetFileInformationByHandle(windows.Handle(source.Fd()), windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
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
	var statusBlock windows.IO_STATUS_BLOCK
	if err := windows.NtSetEaFile(windows.Handle(file.Fd()), &statusBlock, &ea[0], uint32(len(ea))); err != nil {
		t.Fatalf("set temp EA: %v", err)
	}
	if err := metadataCheckAttributes(file); err == nil || !strings.Contains(err.Error(), "extended attributes are unsupported") {
		t.Fatalf("EA rejection was not specific: %v", err)
	}
}
