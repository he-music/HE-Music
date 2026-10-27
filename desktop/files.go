package main

import (
	"context"
	"os"

	"github.com/egoist/mygo"
)

var desktopFiles = &NativeFiles{}

// NativeFiles exposes picker-scoped operations only. It does not expose paths as
// capabilities, enumerate media, persist grants, or read/write arbitrary targets.
type NativeFiles struct{ state nativeFilesState }

func init() {
	desktopFiles.state = nativeFilesState{
		main: func(ctx context.Context, fn func(*mygo.Window) error) error {
			if os.Getenv("MYGO_GENERATE") != "" {
				return errFilesOwner
			}
			return desktopLifecycle.call(ctx, true, func() error { return fn(desktopLifecycle.main) })
		},
		dispatch: mygo.RunOnMain,
		picker:   mygo.Dialog,
		defaultPath: func(kind DefaultDirectoryKind) (string, error) {
			switch kind {
			case DefaultDirectoryMusic:
				return mygo.App.Path(mygo.PathMusic)
			case DefaultDirectoryDownloads:
				return mygo.App.Path(mygo.PathDownloads)
			default:
				return "", errDirectory
			}
		},
	}
	mygo.Bind(desktopFiles)
}

// Begin is called after DesktopLifecycle.Ready. The epoch is transient and must
// never be restored from renderer storage or imported settings.
func (f *NativeFiles) Begin(ctx context.Context) (FileSession, error) {
	return f.state.session(ctx)
}

func (f *NativeFiles) DefaultDirectory(ctx context.Context, epoch uint64, kind DefaultDirectoryKind) (DefaultDirectoryResult, error) {
	return f.state.defaultDirectory(ctx, epoch, kind)
}

func (f *NativeFiles) ChooseDirectory(ctx context.Context, epoch uint64) (DirectorySelection, error) {
	return f.state.chooseDirectory(ctx, epoch)
}

func (f *NativeFiles) RevokeDirectory(ctx context.Context, epoch uint64, token string) error {
	return f.state.revokeDirectory(ctx, epoch, token)
}

func (f *NativeFiles) ImportSettings(ctx context.Context, epoch uint64) (SettingsImportResult, error) {
	return f.state.importSettings(ctx, epoch)
}

func (f *NativeFiles) ExportSettings(ctx context.Context, epoch uint64, settings RendererSettings) (SettingsExportResult, error) {
	return f.state.exportSettings(ctx, epoch, settings)
}

func (f *NativeFiles) Teardown(ctx context.Context, epoch uint64) error {
	return f.state.teardown(ctx, epoch)
}

// Called by the lifecycle on navigation, Ready replacement, teardown and quit.
func (f *NativeFiles) revoke() { f.state.revoke() }
