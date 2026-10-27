package main

import (
	"os"
	"path/filepath"
)

type DirectorySelectionStatus string

const (
	DirectorySelected    DirectorySelectionStatus = "selected"
	DirectoryCancelled   DirectorySelectionStatus = "cancelled"
	DirectoryOverlapping DirectorySelectionStatus = "overlap"
)

type DirectoryRelation string

const (
	DirectoryUnrelated DirectoryRelation = ""
	DirectoryDuplicate DirectoryRelation = "duplicate"
	DirectoryChild     DirectoryRelation = "child"
	DirectoryParent    DirectoryRelation = "parent"
)

type SettingsImportStatus string

const (
	SettingsImportSelected  SettingsImportStatus = "selected"
	SettingsImportCancelled SettingsImportStatus = "cancelled"
)

type SettingsExportStatus string

const (
	SettingsExportSaved     SettingsExportStatus = "saved"
	SettingsExportCancelled SettingsExportStatus = "cancelled"
)

// Capture ancestor identities off the main actor. Comparing identities supports
// case-insensitive volumes without assuming that every macOS volume folds case.
// This is a selection-time snapshot; Root, not this relationship, confines IO.
func directoryAncestorIdentities(canonical string) ([]os.FileInfo, error) {
	var ancestors []os.FileInfo
	for path := filepath.Dir(canonical); ; path = filepath.Dir(path) {
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() || !os.SameFile(info, info) {
			return nil, errDirectory
		}
		ancestors = append(ancestors, info)
		if filepath.Dir(path) == path {
			break
		}
	}
	return ancestors, nil
}

func directoryIdentityRelation(existing, candidate *directoryHandle) DirectoryRelation {
	if os.SameFile(existing.info, candidate.info) {
		return DirectoryDuplicate
	}
	for _, info := range candidate.ancestors {
		if os.SameFile(existing.info, info) {
			return DirectoryChild
		}
	}
	for _, info := range existing.ancestors {
		if os.SameFile(candidate.info, info) {
			return DirectoryParent
		}
	}
	return DirectoryUnrelated
}
