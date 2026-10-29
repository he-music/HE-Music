//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var metadataKernel32 = syscall.NewLazyDLL("kernel32.dll")
var metadataAdvapi32 = syscall.NewLazyDLL("advapi32.dll")
var metadataGetInfo = metadataKernel32.NewProc("GetFileInformationByHandleEx")
var metadataSetInfo = metadataKernel32.NewProc("SetFileInformationByHandle")
var metadataReopen = metadataKernel32.NewProc("ReOpenFile")
var metadataGetSecurity = metadataAdvapi32.NewProc("GetSecurityInfo")
var metadataSetSecurity = metadataAdvapi32.NewProc("SetSecurityInfo")
var metadataEqualSID = metadataAdvapi32.NewProc("EqualSid")
var metadataQueryNative = syscall.NewLazyDLL("ntdll.dll").NewProc("NtQueryInformationFile")
var metadataSecurityControl = metadataAdvapi32.NewProc("GetSecurityDescriptorControl")

// Audit SACLs require SeSecurityPrivilege and are outside the ordinary-user contract.
// FILE_BASIC_INFO includes creation/access/write/change times and DOS attributes.
type metadataWindowsBasic struct {
	Creation, Access, Write, Change int64
	Attributes                      uint32
	Padding                         uint32
}

type metadataWindowsSecurity struct {
	owner, group, dacl, label, descriptor unsafe.Pointer
	control                               uint16
}

func metadataWindowsReadSecurity(file *os.File) (metadataWindowsSecurity, error) {
	var security metadataWindowsSecurity
	code, _, _ := metadataGetSecurity.Call(file.Fd(), 1, 7|0x10,
		uintptr(unsafe.Pointer(&security.owner)), uintptr(unsafe.Pointer(&security.group)),
		uintptr(unsafe.Pointer(&security.dacl)), uintptr(unsafe.Pointer(&security.label)), uintptr(unsafe.Pointer(&security.descriptor)))
	if code != 0 {
		return security, syscall.Errno(code)
	}
	var revision uint32
	ok, _, err := metadataSecurityControl.Call(uintptr(security.descriptor), uintptr(unsafe.Pointer(&security.control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 {
		syscall.LocalFree(syscall.Handle(uintptr(security.descriptor)))
		return metadataWindowsSecurity{}, err
	}
	return security, nil
}

func metadataWindowsBasicInfo(file *os.File) (metadataWindowsBasic, error) {
	var basic metadataWindowsBasic
	ok, _, err := metadataGetInfo.Call(file.Fd(), 0, uintptr(unsafe.Pointer(&basic)), unsafe.Sizeof(basic))
	if ok == 0 {
		return basic, err
	}
	return basic, nil
}

func metadataCheckAttributes(file *os.File) error {
	basic, err := metadataWindowsBasicInfo(file)
	if err != nil {
		return err
	}
	// Reject storage/security features that a fresh ordinary file cannot reproduce.
	if basic.Attributes & ^uint32(0x1|0x2|0x4|0x20|0x80) != 0 {
		return errors.New("unsupported Windows file attributes")
	}
	// Native FileEaInformation reports EA bytes without requiring backup privileges.
	var statusBlock [2]uintptr
	var eaSize uint32
	status, _, _ := metadataQueryNative.Call(file.Fd(), uintptr(unsafe.Pointer(&statusBlock)), uintptr(unsafe.Pointer(&eaSize)), 4, 7)
	if status != 0 {
		return fmt.Errorf("query extended attributes: NTSTATUS %#x", status)
	}
	if eaSize != 0 {
		return errors.New("Windows extended attributes are unsupported")
	}
	// FILE_STREAM_INFO is queried on the pinned handle. Extra named streams must
	// never disappear when the staged default stream replaces the original.
	buffer := make([]byte, 65536)
	ok, _, err := metadataGetInfo.Call(file.Fd(), 7, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if ok == 0 {
		return err
	}
	for offset := uint32(0); ; {
		if offset > uint32(len(buffer))-24 {
			return errors.New("invalid stream information")
		}
		header := buffer[offset:]
		next := *(*uint32)(unsafe.Pointer(&header[0]))
		length := *(*uint32)(unsafe.Pointer(&header[4]))
		if length != 14 || length > uint32(len(header))-24 {
			return errors.New("alternate data streams are unsupported")
		}
		name := unsafe.Slice((*uint16)(unsafe.Pointer(&header[24])), int(length/2))
		if syscall.UTF16ToString(name) != "::$DATA" {
			return errors.New("alternate data streams are unsupported")
		}
		if next == 0 {
			break
		}
		if next < 24 || next > uint32(len(header))-24 {
			return errors.New("invalid stream information")
		}
		offset += next
	}
	security, err := metadataWindowsReadSecurity(file)
	if err == nil {
		syscall.LocalFree(syscall.Handle(uintptr(security.descriptor)))
	}
	return err
}

func metadataWindowsSameSID(a, b unsafe.Pointer) bool {
	if a == nil || b == nil {
		return a == b
	}
	equal, _, _ := metadataEqualSID.Call(uintptr(a), uintptr(b))
	return equal != 0
}

func metadataWindowsACL(pointer unsafe.Pointer) []byte {
	if pointer == nil {
		return nil
	}
	size := *(*uint16)(unsafe.Add(pointer, 2))
	return unsafe.Slice((*byte)(pointer), int(size))
}

func metadataCopyAttributes(source, destination *os.File) error {
	if err := metadataCheckAttributes(source); err != nil {
		return err
	}
	basic, err := metadataWindowsBasicInfo(source)
	if err != nil {
		return err
	}
	security, err := metadataWindowsReadSecurity(source)
	if err != nil {
		return err
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(security.descriptor)))
	target, err := metadataWindowsReadSecurity(destination)
	if err != nil {
		return err
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(target.descriptor)))
	information, access := uintptr(4), uintptr(0x40000) // DACL_SECURITY_INFORMATION, WRITE_DAC
	if !metadataWindowsSameSID(security.owner, target.owner) {
		information |= 1
		access |= 0x80000
	}
	if !metadataWindowsSameSID(security.group, target.group) {
		information |= 2
		access |= 0x80000
	}
	if !bytes.Equal(metadataWindowsACL(security.label), metadataWindowsACL(target.label)) {
		information |= 0x10
		access |= 0x80000
	}
	// Keep explicit DACL protection; ordinary same-owner files need no privilege.
	if security.control&0x1000 != 0 {
		information |= 0x80000000
	} else {
		information |= 0x20000000
	}
	handle, _, err := metadataReopen.Call(destination.Fd(), access, 1|2|4, 0)
	if handle == ^uintptr(0) {
		return err
	}
	defer syscall.CloseHandle(syscall.Handle(handle))
	code, _, _ := metadataSetSecurity.Call(handle, 1, information, uintptr(security.owner), uintptr(security.group), uintptr(security.dacl), uintptr(security.label))
	if code != 0 {
		return syscall.Errno(code)
	}
	ok, _, err := metadataSetInfo.Call(destination.Fd(), 0, uintptr(unsafe.Pointer(&basic)), unsafe.Sizeof(basic))
	if ok == 0 {
		return err
	}
	copied, err := metadataWindowsReadSecurity(destination)
	if err != nil {
		return err
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(copied.descriptor)))
	if !metadataWindowsSameSID(security.owner, copied.owner) || !metadataWindowsSameSID(security.group, copied.group) ||
		security.control&0x1004 != copied.control&0x1004 || !bytes.Equal(metadataWindowsACL(security.dacl), metadataWindowsACL(copied.dacl)) ||
		!bytes.Equal(metadataWindowsACL(security.label), metadataWindowsACL(copied.label)) {
		return errors.New("security attributes differ after copy")
	}
	actual, err := metadataWindowsBasicInfo(destination)
	if err != nil {
		return err
	}
	if actual != basic {
		return errors.New("file attributes differ after copy")
	}
	return nil
}
