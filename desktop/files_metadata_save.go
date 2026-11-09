package main

import (
	"context"
	"os"
	"path"

	"github.com/egoist/mygo"

	"github.com/he-music/HE-Music/desktop/metadata"
)

func (f *NativeFiles) openMetadataSaveSource(ctx context.Context, lease *directoryLease, c *metadataCoordinator, req MetadataSaveRequest) (*os.File, os.FileInfo, func(), string) {
	source, err := f.state.resolveLocalFile(lease, req.Ref)
	if err != nil {
		return nil, nil, nil, metadataCode(err)
	}
	original, err := source.Stat()
	source.Close()
	if err != nil {
		return nil, nil, nil, metadataCode(err)
	}
	unlock, err := c.lock(ctx, original)
	if err != nil {
		return nil, nil, nil, metadataCode(err)
	}
	accepted := false
	defer func() {
		if !accepted {
			unlock()
		}
	}()
	source, err = f.state.resolveLocalFile(lease, req.Ref)
	if err != nil {
		return nil, nil, nil, metadataCode(err)
	}
	defer func() {
		if !accepted {
			source.Close()
		}
	}()
	baseline, err := metadataHash(ctx, source)
	if err != nil {
		return nil, nil, nil, metadataCode(err)
	}
	if baseline != req.SHA256 {
		return nil, nil, nil, "conflict"
	}
	// Resolve again after waiting for the identity lock.
	check, err := f.state.resolveLocalFile(lease, req.Ref)
	if err != nil {
		return nil, nil, nil, metadataCode(err)
	}
	check.Close()
	if err := metadataCheckAttributes(source); err != nil {
		return nil, nil, nil, "attributes_unsupported"
	}
	accepted = true
	return source, original, unlock, ""
}

func prepareMetadataEdit(ctx context.Context, source, work *os.File, size int64, baseline string, patch metadata.Patch) (metadata.Info, string) {
	if err := metadataCopy(ctx, work, source, size); err != nil {
		return metadata.Info{}, metadataCode(err)
	}
	hash, err := metadataHash(ctx, work)
	if err != nil {
		return metadata.Info{}, metadataCode(err)
	}
	if hash != baseline {
		return metadata.Info{}, "conflict"
	}
	if err := metadata.EditWorkingCopy(ctx, work, size, patch); err != nil {
		return metadata.Info{}, metadataCode(err)
	}
	edited, err := work.Stat()
	if err != nil {
		return metadata.Info{}, metadataCode(err)
	}
	if edited.Size() <= 0 {
		return metadata.Info{}, "limit"
	}
	if err := metadata.CompareMetadataPayload(ctx, source, size, work, edited.Size()); err != nil {
		return metadata.Info{}, metadataCode(err)
	}
	parsed, err := metadata.Parse(work, edited.Size())
	if err != nil {
		return metadata.Info{}, metadataCode(err)
	}
	if !metadataPatchMatches(parsed, patch) {
		return metadata.Info{}, "readback_mismatch"
	}
	return metadataDetachInfo(parsed), ""
}

func prepareMetadataBackup(ctx context.Context, source, backup, work *os.File, size int64, baseline string, parent *os.Root) string {
	if err := metadataCopy(ctx, backup, source, size); err != nil {
		return metadataCode(err)
	}
	hash, err := metadataHash(ctx, backup)
	if err != nil {
		return metadataCode(err)
	}
	if hash != baseline {
		return "conflict"
	}
	if err := metadataCopyAttributes(source, backup); err != nil {
		return "attributes_unsupported"
	}
	if err := backup.Sync(); err != nil {
		return metadataCode(err)
	}
	if err := metadataCopyAttributes(source, work); err != nil {
		return "attributes_unsupported"
	}
	if err := work.Sync(); err != nil {
		return metadataCode(err)
	}
	if err := metadataPrepareCommitDirectory(parent); err != nil {
		return metadataCode(err)
	}
	return ""
}

func (f *NativeFiles) prepareLocalFileMutation(ctx context.Context, original os.FileInfo) (func(), string) {
	if beforeLocalFileMutation != nil {
		release, err := beforeLocalFileMutation(ctx, f, original)
		if err != nil {
			return release, metadataCode(err)
		}
		if release == nil {
			return nil, "readers_unavailable"
		}
		return release, ""
	}
	return func() {}, ""
}

func (f *NativeFiles) checkMetadataSaveRoute(ctx context.Context, lease *directoryLease, ref LocalFileRef, original, pinned os.FileInfo, baseline string) string {
	current, err := f.state.resolveLocalFile(lease, ref)
	if err != nil {
		return metadataCode(err)
	}
	info, err := current.Stat()
	if err != nil {
		current.Close()
		return metadataCode(err)
	}
	hash, err := metadataHash(ctx, current)
	current.Close()
	route, routeErr := lease.handle.root.Stat(path.Dir(ref.RelativePath))
	if err != nil {
		return metadataCode(err)
	}
	if hash != baseline || !sameLocalFileInfo(original, info) || routeErr != nil || !os.SameFile(route, pinned) {
		return "conflict"
	}
	return ""
}

// The returned flag keeps the backup until durability and publication succeed.
func (f *NativeFiles) publishMetadataResult(lease *directoryLease, work *os.File, parent *os.Root, backupName string, original os.FileInfo, parsed metadata.Info, relative string) (MetadataResult, bool) {
	recovery := path.Join(path.Dir(relative), backupName)
	result := MetadataResult{Code: "ok", Committed: true, RecoveryName: recovery}
	durable, err := metadataDirectoryDurability(parent)
	if err != nil {
		result.Code = "durability_uncertain"
		return result, true
	}
	if !durable {
		result.Code = "durability_uncertain"
	}
	ref, file, err := f.state.registerLocalFile(lease, relative)
	if err != nil {
		return MetadataResult{Code: metadataCode(err), Committed: true, RecoveryName: recovery}, true
	}
	file.Close()
	if err := f.invalidateMetadataAliases(lease, original); err != nil {
		return MetadataResult{Code: metadataCode(err), Committed: true, RecoveryName: recovery}, true
	}
	hash, err := metadataHash(context.Background(), work)
	if err != nil {
		return MetadataResult{Code: "io_error", Committed: true, RecoveryName: recovery}, true
	}
	result.Ref, result.Info, result.SHA256 = ref, &parsed, hash
	if !durable {
		return result, true
	}
	if err := parent.Remove(backupName); err != nil {
		result.Code = "saved_cleanup_required"
		return result, true
	}
	result.RecoveryName = ""
	return result, false
}

func (f *NativeFiles) invalidateMetadataAliases(lease *directoryLease, original os.FileInfo) error {
	// Old aliases must be rescanned; the replacement inode is kept.
	return f.state.main(lease.owner, func(parent *mygo.Window) error {
		if err := f.state.checkLeaseOnMain(lease, parent); err != nil {
			return err
		}
		for id, entry := range f.state.fileEntries {
			if os.SameFile(entry.info, original) {
				delete(f.state.fileEntries, id)
				delete(entry.handle.filePaths, entry.ref.RelativePath)
			}
		}
		return nil
	})
}
