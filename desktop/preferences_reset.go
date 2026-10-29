package main

import (
	"context"
	"errors"
	"os"
)

// PreferencesResetReceipt means reset intent is durable. Actual deletion occurs
// before stores/SDK geometry load in the next process, after shutdown writers.
type PreferencesResetReceipt struct {
	Pending         bool                 `json:"pending"`
	RestartRequired bool                 `json:"restartRequired"`
	TransactionID   string               `json:"transactionId"`
	Mode            PreferencesResetMode `json:"mode"`
}

var preferencesResetStartupDirectory string
var preferencesResetStartupTransaction string
var preferencesResetAcknowledgedTransaction string

func preparePreferencesResetStartup(directory string) error {
	if os.Getenv("MYGO_GENERATE") != "" {
		return nil
	}
	preferencesResetStartupDirectory = ""
	preferencesResetStartupTransaction = ""
	preferencesResetAcknowledgedTransaction = ""
	if err := completePreferencesReset(directory); err != nil {
		return err
	}
	tx, err := readPreferencesReset(directory)
	if err != nil {
		return err
	}
	preferencesResetStartupTransaction = tx.TransactionID
	preferencesResetStartupDirectory = directory
	return nil
}

// ResetPreferences accepts no renderer path. The same top-level owner/context
// gate as all other native settings is checked before committing the marker.
func (*DesktopPlatform) ResetPreferences(ctx context.Context, mode PreferencesResetMode) (PreferencesResetReceipt, error) {
	return resetPreferencesForOwner(ctx, preferencesResetStartupDirectory, mode, func(ctx context.Context, fn func() error) error {
		return desktopLifecycle.call(ctx, true, fn)
	}, desktopFiles.revoke)
}

func resetPreferencesForOwner(ctx context.Context, directory string, mode PreferencesResetMode, ownerCall func(context.Context, func() error) error, revokeFiles func()) (PreferencesResetReceipt, error) {
	receipt := PreferencesResetReceipt{}
	err := ownerCall(ctx, func() error {
		if directory == "" || os.Getenv("MYGO_GENERATE") != "" {
			return errors.New("preferences reset unavailable")
		}
		if err := schedulePreferencesReset(directory, mode); err != nil {
			return err
		}
		// This invalidates unclaimed file operations. Already-claimed operations may
		// finish; the persistent marker deliberately survives those and SDK quit saves.
		tx, err := readPreferencesReset(directory)
		if err != nil {
			return err
		}
		revokeFiles()
		receipt = PreferencesResetReceipt{Pending: true, RestartRequired: true, TransactionID: tx.TransactionID, Mode: tx.Mode}
		return nil
	})
	return receipt, err
}

// Before Pinia/platform/App imports, only the attached main top-level page may
// read pending startup intent. Readiness is intentionally not required yet.
func (*DesktopPlatform) PendingPreferencesReset(ctx context.Context) (PreferencesResetTransaction, error) {
	var tx PreferencesResetTransaction
	err := desktopLifecycle.call(ctx, false, func() error {
		var err error
		tx, err = readPreferencesReset(preferencesResetStartupDirectory)
		return err
	})
	return tx, err
}

func (*DesktopPlatform) AcknowledgePreferencesReset(ctx context.Context, transactionID string) error {
	return desktopLifecycle.call(ctx, false, func() error {
		if transactionID == "" {
			return errors.New("preferences reset transaction required")
		}
		if transactionID == preferencesResetAcknowledgedTransaction {
			return nil
		}
		if transactionID != preferencesResetStartupTransaction {
			return errors.New("preferences reset requires native restart")
		}
		if err := acknowledgePreferencesReset(preferencesResetStartupDirectory, transactionID); err != nil {
			return err
		}
		preferencesResetAcknowledgedTransaction = transactionID
		preferencesResetStartupTransaction = ""
		return nil
	})
}
