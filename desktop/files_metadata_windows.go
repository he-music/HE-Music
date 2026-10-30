//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ReOpenFile is not exposed by x/sys/windows. Keep this handle-based call;
// reopening a pathname would lose the pinned file identity.
var metadataReopen = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReOpenFile")

// Audit SACLs require SeSecurityPrivilege and are outside the ordinary-user contract.
// FILE_BASIC_INFO includes creation/access/write/change times and DOS attributes.
type metadataWindowsBasic struct {
	Creation, Access, Write, Change int64
	Attributes                      uint32
	Padding                         uint32
}

type metadataWindowsSecurity struct {
	owner, group *windows.SID
	dacl, label  *windows.ACL
	// GetSecurityInfo returns a Go-owned descriptor; never pass it to LocalFree.
	descriptor *windows.SECURITY_DESCRIPTOR
	control    windows.SECURITY_DESCRIPTOR_CONTROL
}

func metadataWindowsReadSecurity(file *os.File) (metadataWindowsSecurity, error) {
	var security metadataWindowsSecurity
	descriptor, err := windows.GetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION)
	if err != nil {
		return security, err
	}
	security.descriptor = descriptor
	if security.owner, _, err = descriptor.Owner(); err != nil {
		return metadataWindowsSecurity{}, err
	}
	if security.group, _, err = descriptor.Group(); err != nil {
		return metadataWindowsSecurity{}, err
	}
	if security.dacl, _, err = descriptor.DACL(); err != nil && !errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return metadataWindowsSecurity{}, err
	}
	if security.label, _, err = descriptor.SACL(); err != nil && !errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
		return metadataWindowsSecurity{}, err
	}
	if security.control, _, err = descriptor.Control(); err != nil {
		return metadataWindowsSecurity{}, err
	}
	return security, nil
}

func metadataWindowsBasicInfo(file *os.File) (metadataWindowsBasic, error) {
	var basic metadataWindowsBasic
	err := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic)))
	return basic, err
}

func metadataCheckAttributes(file *os.File) error {
	basic, err := metadataWindowsBasicInfo(file)
	if err != nil {
		return err
	}
	// Reject storage/security features that a fresh ordinary file cannot reproduce.
	if basic.Attributes & ^uint32(windows.FILE_ATTRIBUTE_READONLY|windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM|windows.FILE_ATTRIBUTE_ARCHIVE|windows.FILE_ATTRIBUTE_NORMAL) != 0 {
		return errors.New("unsupported Windows file attributes")
	}
	// Native FileEaInformation reports EA bytes without requiring backup privileges.
	var statusBlock windows.IO_STATUS_BLOCK
	var eaSize uint32
	if err := windows.NtQueryInformationFile(windows.Handle(file.Fd()), &statusBlock,
		(*byte)(unsafe.Pointer(&eaSize)), uint32(unsafe.Sizeof(eaSize)), windows.FileEaInformation); err != nil {
		return fmt.Errorf("query extended attributes: %w", err)
	}
	if eaSize != 0 {
		return errors.New("Windows extended attributes are unsupported")
	}
	// FILE_STREAM_INFO is queried on the pinned handle. Extra named streams must
	// never disappear when the staged default stream replaces the original.
	buffer := make([]byte, 65536)
	if err := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileStreamInfo, &buffer[0], uint32(len(buffer))); err != nil {
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
		if windows.UTF16ToString(name) != "::$DATA" {
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
	_, err = metadataWindowsReadSecurity(file)
	return err
}

func metadataWindowsSameSID(a, b *windows.SID) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equals(b)
}

func metadataWindowsACL(pointer *windows.ACL) []byte {
	if pointer == nil {
		return nil
	}
	size := *(*uint16)(unsafe.Add(unsafe.Pointer(pointer), 2))
	return unsafe.Slice((*byte)(unsafe.Pointer(pointer)), int(size))
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
	target, err := metadataWindowsReadSecurity(destination)
	if err != nil {
		return err
	}
	information := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION)
	access := uint32(windows.WRITE_DAC)
	if !metadataWindowsSameSID(security.owner, target.owner) {
		information |= windows.OWNER_SECURITY_INFORMATION
		access |= windows.WRITE_OWNER
	}
	if !metadataWindowsSameSID(security.group, target.group) {
		information |= windows.GROUP_SECURITY_INFORMATION
		access |= windows.WRITE_OWNER
	}
	if !bytes.Equal(metadataWindowsACL(security.label), metadataWindowsACL(target.label)) {
		information |= windows.LABEL_SECURITY_INFORMATION
		access |= windows.WRITE_OWNER
	}
	// Keep explicit DACL protection; ordinary same-owner files need no privilege.
	if security.control&windows.SE_DACL_PROTECTED != 0 {
		information |= windows.PROTECTED_DACL_SECURITY_INFORMATION
	} else {
		information |= windows.UNPROTECTED_DACL_SECURITY_INFORMATION
	}
	handle, _, err := metadataReopen.Call(destination.Fd(), uintptr(access), windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, 0)
	if handle == ^uintptr(0) {
		return err
	}
	defer windows.CloseHandle(windows.Handle(handle))
	if err := windows.SetSecurityInfo(windows.Handle(handle), windows.SE_FILE_OBJECT, information,
		security.owner, security.group, security.dacl, security.label); err != nil {
		return err
	}
	if err := windows.SetFileInformationByHandle(windows.Handle(destination.Fd()), windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return err
	}
	copied, err := metadataWindowsReadSecurity(destination)
	if err != nil {
		return err
	}
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
