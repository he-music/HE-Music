package main

import "os"

// metadataPrepareCommitDirectory runs after the work and backup file Sync calls,
// before the caller's final identity/lease checks. A nil error permits commit;
// it does not promise that the directory entry is durable on every platform.
func metadataPrepareCommitDirectory(root *os.Root) error {
	_, err := metadataCommitDirectoryDurability(root)
	return err
}
