package windows

import (
	"strings"

	"github.com/egoist/mygo/internal/platform"
)

const (
	assocstrExecutable      = 2
	assocstrFriendlyAppName = 4
	assocstrAppID           = 21 // ASSOCSTR_APPID from shlwapi.h
)

// applicationByExecutable returns the installed-app entry whose executable
// target is executable. The resolver is kept separate from the comparison so
// the matching rule can be tested without Windows shell objects.
func applicationByExecutable(apps []platform.Application, executable string, resolve func(platform.Application) string) (platform.Application, bool) {
	for _, app := range apps {
		if strings.EqualFold(resolve(app), executable) {
			return app, true
		}
	}
	return platform.Application{}, false
}

func isOpenWithExecutable(path string) bool {
	if i := strings.LastIndexAny(path, `\/`); i >= 0 {
		path = path[i+1:]
	}
	return strings.EqualFold(path, "OpenWith.exe")
}
