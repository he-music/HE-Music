package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func resetTestWrite(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func resetTestMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected absent %s: %v", path, err)
	}
}

func TestPreferencesResetOldWritersThenFreshStores(t *testing.T) {
	directory, music := t.TempDir(), t.TempDir()
	song := filepath.Join(music, "song.mp3")
	resetTestWrite(t, song, "music remains")
	resetTestWrite(t, filepath.Join(directory, "download-history.json"), "history remains")
	appearance := &WindowAppearanceService{}
	if _, err := appearance.initialize(filepath.Join(directory, "window-appearance.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := appearance.save(true); err != nil {
		t.Fatal(err)
	}
	proxyPath := filepath.Join(directory, "network-proxy.json")
	proxy := NetworkProxyConfig{Protocol: "HTTP", Server: "localhost", Port: 8888}
	if err := saveNetworkProxyConfig(proxyPath, proxy); err != nil {
		t.Fatal(err)
	}
	dirs := &libraryDirectoryStore{path: filepath.Join(directory, "local-library-directories.json")}
	if err := dirs.update(music, true); err != nil {
		t.Fatal(err)
	}
	savedLibraryIndex.Lock()
	oldPath, oldEntries, oldErr := savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err
	savedLibraryIndex.Unlock()
	t.Cleanup(func() {
		savedLibraryIndex.Lock()
		defer savedLibraryIndex.Unlock()
		savedLibraryIndex.path, savedLibraryIndex.entries, savedLibraryIndex.err = oldPath, oldEntries, oldErr
	})
	if err := prepareLibraryIndex(directory); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(song)
	if err != nil {
		t.Fatal(err)
	}
	rememberLibraryMetadata(music, "song.mp3", info, metadata.Info{Title: "old"})
	if err := flushLibraryIndex(); err != nil {
		t.Fatal(err)
	}
	resetTestWrite(t, filepath.Join(directory, "window-state.json"), `{"main":{"width":999}}`)
	if err := schedulePreferencesReset(directory, PreferencesResetSettings); err != nil {
		t.Fatal(err)
	}
	// Intent is not deletion; canceling or failing before it never destroys stores.
	if loaded, _, err := appearance.store.Load(); err != nil || !loaded.UseBorderless {
		t.Fatal(loaded, err)
	}
	// Old cached stores and SDK shutdown save AFTER the request. They are allowed
	// to finish; next startup's marker is the write fence across process lifetime.
	if _, err := appearance.save(true); err != nil {
		t.Fatal(err)
	}
	if err := saveNetworkProxyConfig(proxyPath, proxy); err != nil {
		t.Fatal(err)
	}
	if err := dirs.update(music, false); err != nil {
		t.Fatal(err)
	}
	if err := dirs.update(music, true); err != nil {
		t.Fatal(err)
	}
	if err := flushLibraryIndex(); err != nil {
		t.Fatal(err)
	}
	resetTestWrite(t, filepath.Join(directory, "window-state.json"), `{"main":{"width":777}}`)
	if err := completePreferencesReset(directory); err != nil {
		t.Fatal(err)
	}
	for _, name := range preferencesResetFiles {
		resetTestMissing(t, filepath.Join(directory, name))
	}
	tx, err := readPreferencesReset(directory)
	if err != nil || tx.Phase != "renderer" {
		t.Fatal(tx, err)
	}
	if err := acknowledgePreferencesReset(directory, tx.TransactionID); err != nil {
		t.Fatal(err)
	}
	resetTestMissing(t, filepath.Join(directory, preferencesResetMarker))
	freshAppearance := &WindowAppearanceService{}
	if value, err := freshAppearance.initialize(appearance.store.path); err != nil || value.UseBorderless || freshAppearance.failed {
		t.Fatal(value, err)
	}
	if value, err := readNetworkProxyConfig(proxyPath); err != nil || value.Protocol != "off" || value.Server != "" {
		t.Fatal(value, err)
	}
	freshDirs := &libraryDirectoryStore{path: dirs.path}
	if paths, err := freshDirs.snapshot(); err != nil || len(paths) != 0 {
		t.Fatal(paths, err)
	}
	if err := prepareLibraryIndex(directory); err != nil {
		t.Fatal(err)
	}
	if _, found := cachedLibraryMetadata(music, "song.mp3", info); found {
		t.Fatal("fresh index retained old metadata")
	}
	if value, err := os.ReadFile(song); err != nil || string(value) != "music remains" {
		t.Fatal(string(value), err)
	}
	if value, err := os.ReadFile(filepath.Join(directory, "download-history.json")); err != nil || string(value) != "history remains" {
		t.Fatal(string(value), err)
	}
	// Without another explicit reset, a later launch must preserve new settings.
	if _, err := freshAppearance.save(true); err != nil {
		t.Fatal(err)
	}
	if err := completePreferencesReset(directory); err != nil {
		t.Fatal(err)
	}
	if value, _, err := freshAppearance.store.Load(); err != nil || !value.UseBorderless {
		t.Fatal(value, err)
	}
}

func TestPreferencesResetPartialCleanupRetainsIntentAndRetries(t *testing.T) {
	directory := t.TempDir()
	for _, name := range preferencesResetFiles {
		resetTestWrite(t, filepath.Join(directory, name), "old")
	}
	if err := schedulePreferencesReset(directory, PreferencesResetSettings); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(directory, "local-library-directories.json")
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	if err := completePreferencesReset(directory); err == nil {
		t.Fatal("partial cleanup reported success")
	}
	if _, err := os.Stat(filepath.Join(directory, preferencesResetMarker)); err != nil {
		t.Fatal("lost reset intent", err)
	}
	resetTestMissing(t, filepath.Join(directory, "window-appearance.json"))
	if value, err := os.ReadFile(filepath.Join(directory, "window-state.json")); err != nil || string(value) != "old" {
		t.Fatal("cleaned after failure", err)
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if err := completePreferencesReset(directory); err != nil {
		t.Fatal(err)
	}
	tx, err := readPreferencesReset(directory)
	if err != nil || tx.Phase != "renderer" {
		t.Fatal(tx, err)
	}
	if err := acknowledgePreferencesReset(directory, tx.TransactionID); err != nil {
		t.Fatal(err)
	}
	resetTestMissing(t, filepath.Join(directory, preferencesResetMarker))
	for _, name := range preferencesResetFiles {
		resetTestMissing(t, filepath.Join(directory, name))
	}
}

func TestPreferencesResetMarkerFailureKeepsPreferencesAndOwner(t *testing.T) {
	directory := t.TempDir()
	pref := filepath.Join(directory, "window-appearance.json")
	resetTestWrite(t, pref, "original")
	marker := filepath.Join(directory, preferencesResetMarker)
	if err := os.Mkdir(marker, 0700); err != nil {
		t.Fatal(err)
	}
	revoked := false
	receipt, err := resetPreferencesForOwner(context.Background(), directory, PreferencesResetSettings, func(_ context.Context, fn func() error) error { return fn() }, func() { revoked = true })
	if err == nil || receipt.Pending || revoked {
		t.Fatal(receipt, err, revoked)
	}
	if value, err := os.ReadFile(pref); err != nil || string(value) != "original" {
		t.Fatal(string(value), err)
	}
	if err := completePreferencesReset(directory); err == nil {
		t.Fatal("directory marker accepted")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	receipt, err = resetPreferencesForOwner(context.Background(), directory, PreferencesResetSettings, func(_ context.Context, fn func() error) error { return fn() }, func() { revoked = true })
	if err != nil || !receipt.Pending || !receipt.RestartRequired || !revoked {
		t.Fatal(receipt, err, revoked)
	}
}

func TestPreferencesResetRejectsCanceledReplacedAndForeignOwners(t *testing.T) {
	directory := t.TempDir()
	owner, cancel := context.WithCancel(context.Background())
	defer cancel()
	state := lifecycleState{owner: owner}
	gate := func(ctx context.Context, fn func() error) error {
		if !state.owns(ctx) {
			return errors.New("owner unavailable")
		}
		return fn()
	}
	foreign, cancelForeign := context.WithCancel(context.Background())
	defer cancelForeign()
	for _, ctx := range []context.Context{foreign, context.Background()} {
		if receipt, err := resetPreferencesForOwner(ctx, directory, PreferencesResetSettings, gate, func() { t.Fatal("unauthorized revoke") }); err == nil || receipt.Pending {
			t.Fatal(receipt, err)
		}
	}
	state.owner = foreign
	if _, err := resetPreferencesForOwner(owner, directory, PreferencesResetSettings, gate, func() { t.Fatal("replaced revoke") }); err == nil {
		t.Fatal("replaced owner accepted")
	}
	cancelForeign()
	if _, err := resetPreferencesForOwner(foreign, directory, PreferencesResetSettings, gate, func() { t.Fatal("canceled revoke") }); err == nil {
		t.Fatal("canceled owner accepted")
	}
	resetTestMissing(t, filepath.Join(directory, preferencesResetMarker))
	// The fresh owner can retry and successful scheduling really revokes file IO.
	actor, ctx, epoch := newFileTestActor(t)
	state.owner = ctx
	receipt, err := resetPreferencesForOwner(ctx, directory, PreferencesResetSettings, gate, actor.state.revoke)
	if err != nil || !receipt.Pending {
		t.Fatal(receipt, err)
	}
	if actor.state.owns(ctx, epoch) {
		t.Fatal("old file owner retained authority")
	}
}

func TestPreferencesResetStartupAndAcknowledgementFailureCanRetry(t *testing.T) {
	oldDirectory, oldTransaction, oldAck := preferencesResetStartupDirectory, preferencesResetStartupTransaction, preferencesResetAcknowledgedTransaction
	t.Cleanup(func() {
		preferencesResetStartupDirectory, preferencesResetStartupTransaction, preferencesResetAcknowledgedTransaction = oldDirectory, oldTransaction, oldAck
	})
	directory := t.TempDir()
	if err := schedulePreferencesReset(directory, PreferencesResetAll); err != nil {
		t.Fatal(err)
	}
	tx, err := readPreferencesReset(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := acknowledgePreferencesReset(directory, tx.TransactionID); err == nil {
		t.Fatal("early acknowledgement accepted")
	}
	if err := preparePreferencesResetStartup(directory); err != nil {
		t.Fatal(err)
	}
	if preferencesResetStartupTransaction != tx.TransactionID {
		t.Fatal("lost startup transaction")
	}
	blocker := filepath.Join(directory, preferencesResetMarker+".reset-discard")
	if err := os.Mkdir(blocker, 0700); err != nil {
		t.Fatal(err)
	}
	if err := acknowledgePreferencesReset(directory, tx.TransactionID); err == nil {
		t.Fatal("final marker move failure accepted")
	}
	pending, err := readPreferencesReset(directory)
	if err != nil || pending.TransactionID != tx.TransactionID {
		t.Fatal("lost failed intent", pending, err)
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if err := acknowledgePreferencesReset(directory, "stale"); err == nil {
		t.Fatal("stale acknowledgement accepted")
	}
	if err := acknowledgePreferencesReset(directory, tx.TransactionID); err != nil {
		t.Fatal(err)
	}
	resetTestMissing(t, filepath.Join(directory, preferencesResetMarker))
}

func TestPreferencesResetReceiptLostCrashAndPartialRendererRecovery(t *testing.T) {
	for _, mode := range []PreferencesResetMode{PreferencesResetSettings, PreferencesResetAll} {
		t.Run(string(mode), func(t *testing.T) {
			directory := t.TempDir()
			// Commit succeeds but receipt never reaches renderer / owner is replaced.
			if err := schedulePreferencesReset(directory, mode); err != nil {
				t.Fatal(err)
			}
			original, err := readPreferencesReset(directory)
			if err != nil {
				t.Fatal(err)
			}
			if err := schedulePreferencesReset(directory, mode); err != nil {
				t.Fatal(err)
			}
			retry, _ := readPreferencesReset(directory)
			otherMode := PreferencesResetAll
			if mode == PreferencesResetAll {
				otherMode = PreferencesResetSettings
			}
			if err := schedulePreferencesReset(directory, otherMode); err == nil {
				t.Fatal("different mode replaced pending intent")
			}
			if err := schedulePreferencesReset(directory, PreferencesResetMode("arbitrary")); err == nil {
				t.Fatal("invalid mode accepted")
			}
			if retry != original {
				t.Fatal("lost receipt retry replaced transaction", retry, original)
			}
			for attempt := 0; attempt < 3; attempt++ {
				resetTestWrite(t, filepath.Join(directory, "window-state.json"), "late SDK save")
				if err := completePreferencesReset(directory); err != nil {
					t.Fatal(err)
				}
				pending, err := readPreferencesReset(directory)
				if err != nil || pending.TransactionID != original.TransactionID || pending.Mode != mode || pending.Phase != "renderer" {
					t.Fatal(pending, err)
				}
				resetTestMissing(t, filepath.Join(directory, "window-state.json"))
				// Renderer crash, owner loss, or partial clear: no acknowledgement. The
				// next startup must retain exactly the same mode/ID and repeat cleanup.
			}
			if err := acknowledgePreferencesReset(directory, original.TransactionID); err != nil {
				t.Fatal(err)
			}
			resetTestMissing(t, filepath.Join(directory, preferencesResetMarker))
		})
	}
}

func TestPreferencesResetRecoveryAcrossProcessCrash(t *testing.T) {
	if phase := os.Getenv("HE_MUSIC_RESET_TEST_PHASE"); phase != "" {
		directory := os.Getenv("HE_MUSIC_RESET_TEST_DIRECTORY")
		switch phase {
		case "commit-crash":
			if err := schedulePreferencesReset(directory, PreferencesResetAll); err != nil {
				t.Fatal(err)
			}
			resetTestWrite(t, filepath.Join(directory, "window-state.json"), "SDK save after reset commit")
			os.Exit(23) // No renderer receipt, no cleanup defer, no acknowledgement.
		case "startup":
			if err := preparePreferencesResetStartup(directory); err != nil {
				t.Fatal(err)
			}
			pending, err := readPreferencesReset(directory)
			if err != nil || pending.Mode != PreferencesResetAll || pending.Phase != "renderer" {
				t.Fatal(pending, err)
			}
		default:
			t.Fatal("unknown child phase")
		}
		return
	}
	directory := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	run := func(phase string, exitCode int) {
		t.Helper()
		command := exec.Command(executable, "-test.run=^TestPreferencesResetRecoveryAcrossProcessCrash$")
		command.Env = append(os.Environ(), "HE_MUSIC_RESET_TEST_PHASE="+phase, "HE_MUSIC_RESET_TEST_DIRECTORY="+directory)
		output, err := command.CombinedOutput()
		if exitCode == 0 && err != nil {
			t.Fatalf("child startup: %s %v", output, err)
		}
		if exitCode != 0 {
			var failure *exec.ExitError
			if !errors.As(err, &failure) || failure.ExitCode() != exitCode {
				t.Fatalf("child crash: %s %v", output, err)
			}
		}
	}
	run("commit-crash", 23)
	committed, err := readPreferencesReset(directory)
	if err != nil || committed.Phase != "restart" {
		t.Fatal(committed, err)
	}
	run("startup", 0)
	resetTestMissing(t, filepath.Join(directory, "window-state.json"))
	// A second crash/partial renderer attempt still cannot erase renderer intent.
	run("startup", 0)
	recovered, err := readPreferencesReset(directory)
	if err != nil || recovered.TransactionID != committed.TransactionID || recovered.Mode != PreferencesResetAll || recovered.Phase != "renderer" {
		t.Fatal(recovered, err)
	}
	if err := acknowledgePreferencesReset(directory, committed.TransactionID); err != nil {
		t.Fatal(err)
	}
	resetTestMissing(t, filepath.Join(directory, preferencesResetMarker))
}
