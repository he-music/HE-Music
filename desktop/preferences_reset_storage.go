package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const preferencesResetMarker = "preferences-reset.pending"

// Only application-owned preference files are eligible. Downloads and selected
// music files are outside this list; renderer history keeps its existing policy.
var preferencesResetFiles = [...]string{
	"window-appearance.json", "network-proxy.json", "local-library-directories.json",
	"local-library-index.json", "window-state.json",
}

func preferencesResetDirectory(directory string) error {
	if directory == "" || !filepath.IsAbs(directory) {
		return errors.New("preferences reset directory unavailable")
	}
	return nil
}

type PreferencesResetMode string
type PreferencesResetPhase string

const (
	PreferencesResetSettings PreferencesResetMode  = "settings"
	PreferencesResetAll      PreferencesResetMode  = "all"
	PreferencesResetRestart  PreferencesResetPhase = "restart"
	PreferencesResetRenderer PreferencesResetPhase = "renderer"
)

type PreferencesResetTransaction struct {
	Version       int                   `json:"version"`
	TransactionID string                `json:"transactionId"`
	Mode          PreferencesResetMode  `json:"mode"`
	Phase         PreferencesResetPhase `json:"phase"`
}

func readPreferencesReset(directory string) (PreferencesResetTransaction, error) {
	tx := PreferencesResetTransaction{}
	if err := preferencesResetDirectory(directory); err != nil {
		return tx, err
	}
	path := filepath.Join(directory, preferencesResetMarker)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return tx, nil
	}
	if err != nil {
		return tx, err
	}
	if !info.Mode().IsRegular() || info.Size() > 1024 {
		return tx, errors.New("invalid preferences reset marker")
	}
	file, err := os.Open(path)
	if err != nil {
		return tx, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1025))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&tx); err != nil {
		return tx, err
	}
	if decoder.Decode(new(any)) != io.EOF || tx.Version != 2 || len(tx.TransactionID) != 32 ||
		(tx.Mode != PreferencesResetSettings && tx.Mode != PreferencesResetAll) ||
		(tx.Phase != PreferencesResetRestart && tx.Phase != PreferencesResetRenderer) {
		return tx, errors.New("invalid preferences reset transaction")
	}
	if _, err := hex.DecodeString(tx.TransactionID); err != nil {
		return tx, err
	}
	return tx, nil
}

func writePreferencesReset(directory string, tx PreferencesResetTransaction) error {
	if err := preferencesResetDirectory(directory); err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(tx)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".preferences-reset-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	if err = writeSettingsOutput(file, data); err != nil {
		return err
	}
	return commitPreferencesResetRename(file.Name(), filepath.Join(directory, preferencesResetMarker))
}

// Commit both native and renderer intent BEFORE returning any receipt. Retrying
// a lost receipt never replaces the transaction or downgrades its requested mode.
func schedulePreferencesReset(directory string, mode PreferencesResetMode) error {
	if mode != PreferencesResetSettings && mode != PreferencesResetAll {
		return errors.New("invalid preferences reset mode")
	}
	previous, err := readPreferencesReset(directory)
	if err != nil {
		return err
	}
	if previous.TransactionID != "" {
		if previous.Mode != mode {
			return errors.New("another preferences reset is pending")
		}
		return nil
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	return writePreferencesReset(directory, PreferencesResetTransaction{Version: 2, TransactionID: hex.EncodeToString(nonce), Mode: mode, Phase: PreferencesResetRestart})
}

// Under the single-instance lock, before ANY store/window is loaded. Retain
// renderer intent even if native cleanup has completed in an earlier process.
func completePreferencesReset(directory string) error {
	tx, err := readPreferencesReset(directory)
	if err != nil {
		return err
	}
	if tx.TransactionID == "" {
		return nil
	}
	for _, name := range preferencesResetFiles {
		if err := removePreferencesResetFile(filepath.Join(directory, name)); err != nil {
			return err
		}
	}
	if err := resetApplicationStorage(directory, tx.Mode); err != nil {
		return err
	}
	tx.Phase = PreferencesResetRenderer
	return writePreferencesReset(directory, tx)
}

// Only an early renderer that finished all requested clearing may acknowledge.
// Caller additionally verifies this ID was prepared by THIS native startup.
func acknowledgePreferencesReset(directory, transactionID string) error {
	tx, err := readPreferencesReset(directory)
	if err != nil {
		return err
	}
	if tx.TransactionID != transactionID || tx.Phase != PreferencesResetRenderer {
		return errors.New("preferences reset acknowledgement is stale")
	}
	if err := removePreferencesResetFile(filepath.Join(directory, preferencesResetMarker)); err != nil {
		return errors.Join(err, writePreferencesReset(directory, tx))
	}
	return nil
}

// Rename out of the active filename durably before unlinking. The discard name
// is fixed and never followed; leftover discards cannot be loaded as settings.
func removePreferencesResetFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("preferences reset expected a file")
	}
	discard := path + ".reset-discard"
	if err := commitPreferencesResetRename(path, discard); err != nil {
		return err
	}
	return os.Remove(discard)
}
