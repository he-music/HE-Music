//go:build windows && (amd64 || arm64)

package windows

import (
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"github.com/egoist/mygo/internal/platform"
)

var (
	procSHGetKnownFolderItem = shell32.NewProc("SHGetKnownFolderItem")
	procCoUninitialize       = ole32.NewProc("CoUninitialize")

	folderIDAppsFolder = guid("1e87508d-89c2-42f0-8a7e-645a0f50ca58")
	bhidEnumItems      = guid("94f60519-2850-4924-aa5a-d15e84868039")
	iidIEnumShellItems = guid("70629033-e363-4a28-a567-0db78006e6d7")
	iidIShellItem2     = guid("7e9fb0d3-919f-4307-ab2e-9b1860310c93")
	iidIPersistFile    = guid("0000010b-0000-0000-c000-000000000046")
)

const si2GetString = 17 // IShellItem2::GetString

var pkeyLinkTargetParsingPath = propertyKey{
	Format: guid("b9b4b3fc-2b51-4a42-b5d8-324146afcf25"),
	ID:     2,
}

const appsFolder = `shell:AppsFolder\`

// Applications lists the apps of the Start menu's All apps list, the
// shell's Applications folder (FOLDERID_AppsFolder): desktop apps by their
// shortcuts and packaged apps alike, as PowerToys' Command Palette lists
// them. An app's ID is its AppUserModelID, or for a desktop app without
// one, its path under a known folder; its Path is the shell item,
// shell:AppsFolder\<ID>, which FileIcon draws and OpenApplication starts.
// It runs on a thread of its own, in its own COM apartment.
func (b *Backend) Applications() ([]platform.Application, error) {
	var apps []platform.Application
	err := withCOM(func() error {
		var err error
		apps, _, err = enumerateApplications("")
		return err
	})
	return apps, err
}

func withCOM(fn func() error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if r, _, _ := procCoInitializeEx.Call(0, coinitApartmentThreaded); !failed(r) {
		defer procCoUninitialize.Call()
	}
	return fn()
}

func enumerateApplications(executable string) ([]platform.Application, platform.Application, error) {
	var folder uintptr
	if r, _, _ := procSHGetKnownFolderItem.Call(uintptr(unsafe.Pointer(&folderIDAppsFolder)), 0, 0, uintptr(unsafe.Pointer(&iidIShellItem)), uintptr(unsafe.Pointer(&folder))); failed(r) {
		return nil, platform.Application{}, hresultError("SHGetKnownFolderItem(AppsFolder)", r)
	}
	defer release(folder)
	var items uintptr
	if r := comCall(folder, 3, 0, uintptr(unsafe.Pointer(&bhidEnumItems)), uintptr(unsafe.Pointer(&iidIEnumShellItems)), uintptr(unsafe.Pointer(&items))); failed(r) { // BindToHandler
		return nil, platform.Application{}, hresultError("enumerating the Applications folder", r)
	}
	defer release(items)
	const (
		sigdnNormalDisplay         = 0
		sigdnParentRelativeParsing = 0x80018001
		sigdnFileSysPath           = 0x80058000
	)
	var apps []platform.Application
	var targets map[string]string
	if executable != "" {
		targets = make(map[string]string)
	}
	for {
		var item uintptr
		var fetched uint32
		if r := comCall(items, 3, 1, uintptr(unsafe.Pointer(&item)), uintptr(unsafe.Pointer(&fetched))); r != 0 || fetched == 0 { // Next: S_FALSE at the end
			break
		}
		var name, id uintptr
		comCall(item, 5, sigdnNormalDisplay, uintptr(unsafe.Pointer(&name)))       // GetDisplayName
		comCall(item, 5, sigdnParentRelativeParsing, uintptr(unsafe.Pointer(&id))) // its ID in the folder
		a := platform.Application{Name: takeWstr(name), ID: takeWstr(id)}
		if a.Name == "" || a.ID == "" {
			release(item)
			continue
		}
		a.Path = appsFolder + a.ID
		apps = append(apps, a)
		if executable != "" {
			targets[a.ID] = itemExecutable(item, sigdnFileSysPath)
		}
		release(item)
	}
	var match platform.Application
	if executable != "" {
		match, _ = applicationByExecutable(apps, executable, func(app platform.Application) string {
			return targets[app.ID]
		})
	}
	return apps, match, nil
}

func findInstalledApplication(executable string) (platform.Application, bool, error) {
	var match platform.Application
	err := withCOM(func() error {
		_, found, err := enumerateApplications(executable)
		match = found
		return err
	})
	return match, match.ID != "", err
}

func itemExecutable(item uintptr, sigdnFileSysPath uint32) string {
	if target := itemTargetParsingPath(item); target != "" {
		return target
	}
	var path uintptr
	if failed(comCall(item, 5, uintptr(sigdnFileSysPath), uintptr(unsafe.Pointer(&path)))) {
		return ""
	}
	pathName := takeWstr(path)
	if !strings.EqualFold(filepath.Ext(pathName), ".lnk") {
		return pathName
	}
	return shortcutTarget(pathName)
}

func itemTargetParsingPath(item uintptr) string {
	item2 := queryInterface(item, &iidIShellItem2)
	if item2 == 0 {
		return ""
	}
	defer release(item2)
	var path uintptr
	if failed(comCall(item2, si2GetString, uintptr(unsafe.Pointer(&pkeyLinkTargetParsingPath)), uintptr(unsafe.Pointer(&path)))) {
		return ""
	}
	return takeWstr(path)
}

func shortcutTarget(path string) string {
	link, err := coCreate(clsidShellLink, iidIShellLinkW)
	if err != nil {
		return ""
	}
	defer release(link)
	persist := queryInterface(link, &iidIPersistFile)
	if persist == 0 {
		return ""
	}
	defer release(persist)
	if failed(comCall(persist, 5, uintptr(unsafe.Pointer(u16(path))), 0)) { // IPersistFile::Load
		return ""
	}
	var target [syscall.MAX_PATH]uint16
	if failed(comCall(link, 3, uintptr(unsafe.Pointer(&target[0])), uintptr(len(target)), 0, 0)) { // IShellLinkW::GetPath
		return ""
	}
	return syscall.UTF16ToString(target[:])
}

// OpenApplication starts an app of the Applications folder by its shell
// item, with its default verb, or any program by its path.
func (shell) OpenApplication(path string) error { return shellExecute("", path, "") }
