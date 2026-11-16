//go:build linux && (amd64 || arm64)

package linux

import (
	"fmt"
	"net/url"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo/internal/platform"
)

var (
	appsOnce sync.Once

	gAppInfoGetAll                func() ptr
	gAppInfoShouldShow            func(info ptr) bool
	gAppInfoGetDisplayName        func(info ptr) ptr
	gAppInfoLaunch                func(info, files, ctx ptr, gerr *ptr) bool
	gDesktopAppInfoGetFilename    func(info ptr) ptr
	gFileInfoGetContentType       func(info ptr) ptr
	gdkDisplayGetAppLaunchContext func(d ptr) ptr
)

func loadApps() {
	appsOnce.Do(func() {
		loadIcons() // g_desktop_app_info_new_from_filename
		mustBind(libGIO, &gAppInfoGetAll, "g_app_info_get_all")
		mustBind(libGIO, &gAppInfoShouldShow, "g_app_info_should_show")
		mustBind(libGIO, &gAppInfoGetDisplayName, "g_app_info_get_display_name")
		mustBind(libGIO, &gAppInfoLaunch, "g_app_info_launch")
		mustBind(libGIO, &gDesktopAppInfoGetFilename, "g_desktop_app_info_get_filename")
		mustBind(libGIO, &gFileInfoGetContentType, "g_file_info_get_content_type")
		mustBind(libGDK, &gdkDisplayGetAppLaunchContext, "gdk_display_get_app_launch_context")
	})
}

// Applications lists the applications of the desktop entries that menus
// show (g_app_info_should_show: not NoDisplay or Hidden, and meant for this
// desktop), with their names in the user's language, their desktop file
// IDs and the paths of their entries. GIO is thread-safe.
func (b *Backend) Applications() ([]platform.Application, error) {
	loadApps()
	var apps []platform.Application
	list := gAppInfoGetAll()
	for l := list; l != 0; l = field[ptr](l, 8) { // GList: data, next, prev
		info := field[ptr](l, 0)
		if gAppInfoShouldShow(info) {
			if path := goStr(gDesktopAppInfoGetFilename(info)); path != "" {
				apps = append(apps, platform.Application{
					Name: goStr(gAppInfoGetDisplayName(info)),
					ID:   goStr(gAppInfoGetID(info)),
					Path: path,
				})
			}
		}
		gObjectUnref(info)
	}
	gListFree(list)
	return apps, nil
}

// OpenApplication launches the application of a desktop entry, with the
// display's launch context, which gives it startup notification or the
// activation token that lets it take the focus.
func (shell) OpenApplication(path string) error {
	loadApps()
	info := gDesktopAppInfoNewFromFile(cs(path))
	if info == 0 {
		return fmt.Errorf("mygo: %q is not a desktop entry of an application", path)
	}
	defer gObjectUnref(info)
	ctx := gdkDisplayGetAppLaunchContext(gdkDisplayGetDefault())
	defer gObjectUnref(ctx)
	var gerr ptr
	if !gAppInfoLaunch(info, 0, ctx, &gerr) {
		return gErr(gerr)
	}
	return nil
}

// DefaultApp returns the application that opens url: the default handler
// for its scheme (g_app_info_get_default_for_uri_scheme), or for a file://
// URL or a path, the default handler for the file's content type
// (g_app_info_get_default_for_type): the type GIO finds the file to be,
// which knows a folder and a file without an extension, or where there is
// no such file, the type its name tells (g_content_type_guess).
func (shell) DefaultApp(rawURL string) (platform.Application, error) {
	loadApps()
	var scheme, path string
	if u, e := url.Parse(rawURL); e == nil && u.Scheme != "" {
		if u.Scheme == "file" {
			path = u.Path
		} else {
			scheme = u.Scheme
		}
	} else {
		path = rawURL
	}
	var info ptr
	if scheme != "" {
		info = gAppInfoGetDefaultForURIScheme(cs(scheme))
	} else if path != "" {
		ct := contentType(path)
		if ct == "" {
			return platform.Application{}, fmt.Errorf("mygo: no application found for %q", rawURL)
		}
		info = gAppInfoGetDefaultForType(cs(ct), false)
	} else {
		return platform.Application{}, fmt.Errorf("mygo: invalid URL %q", rawURL)
	}
	if info == 0 {
		return platform.Application{}, fmt.Errorf("mygo: no application found for %q", rawURL)
	}
	defer gObjectUnref(info)
	entry := goStr(gDesktopAppInfoGetFilename(info))
	id := goStr(gAppInfoGetID(info))
	if entry == "" {
		entry = id
	}
	return platform.Application{
		Name: goStr(gAppInfoGetDisplayName(info)),
		ID:   id,
		Path: entry,
	}, nil
}

// contentType returns the content type of the file at path, as GIO finds
// it (standard::content-type, from its name and its first bytes, and
// inode/directory for a folder), or what its name tells where there is no
// such file.
func contentType(path string) string {
	f := gFileNewForPath(cs(path))
	info := gFileQueryInfo(f, cs("standard::content-type"), 0, 0, nil)
	gObjectUnref(f)
	if info != 0 {
		defer gObjectUnref(info)
		return goStr(gFileInfoGetContentType(info))
	}
	ct := gContentTypeGuess(cs(filepath.Base(path)), 0, 0, nil)
	defer gFree(ct)
	return goStr(ct)
}
