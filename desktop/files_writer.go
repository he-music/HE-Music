package main

// settingsOutput is the minimal file writer boundary. Production passes the
// exclusive same-directory temporary file; tests can exercise syscall failures.
type settingsOutput interface {
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

func writeSettingsOutput(file settingsOutput, data []byte) error {
	n, writeErr := file.Write(data)
	var syncErr error
	if writeErr == nil && n == len(data) {
		syncErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil || n != len(data) || syncErr != nil || closeErr != nil {
		return errFileIO
	}
	return nil
}
