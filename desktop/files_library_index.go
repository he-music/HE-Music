package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/he-music/HE-Music/desktop/metadata"
)

type libraryIndexEntry struct {
	Directory string        `json:"directory"`
	Relative  string        `json:"relative"`
	Size      int64         `json:"size"`
	Modified  int64         `json:"modified"`
	Metadata  metadata.Info `json:"metadata"`
}
type libraryIndexDocument struct {
	Version int                 `json:"version"`
	Entries []libraryIndexEntry `json:"entries"`
}

type libraryIndexStore struct {
	sync.Mutex
	path    string
	entries map[string]libraryIndexEntry
	err     error
}

var savedLibraryIndex libraryIndexStore

func libraryIndexKey(directory, relative string) string { return directory + "\x00" + relative }

func prepareLibraryIndex(directory string) error {
	if os.Getenv("MYGO_GENERATE") != "" {
		return nil
	}
	store := &savedLibraryIndex
	store.Lock()
	defer store.Unlock()
	store.path = filepath.Join(directory, "local-library-index.json")
	store.entries = make(map[string]libraryIndexEntry)
	store.err = nil
	file, err := os.Open(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		store.err = err
		return err
	}
	defer file.Close()
	var doc libraryIndexDocument
	decoder := json.NewDecoder(file)
	if err = decoder.Decode(&doc); err != nil || doc.Version != 1 {
		store.err = errors.New("invalid local music index")
		return store.err
	}
	if decoder.Decode(new(any)) != io.EOF {
		store.err = errors.New("invalid trailing local music index data")
		return store.err
	}
	for _, entry := range doc.Entries {
		if !filepath.IsAbs(entry.Directory) || validateLocalRelativePath(entry.Relative) != nil || entry.Size < 0 {
			store.err = errors.New("invalid local music index entry")
			return store.err
		}
		entry.Metadata = boundedScanInfo(entry.Metadata)
		store.entries[libraryIndexKey(entry.Directory, entry.Relative)] = entry
	}
	return nil
}

func cachedLibraryMetadata(directory, relative string, info os.FileInfo) (metadata.Info, bool) {
	store := &savedLibraryIndex
	store.Lock()
	defer store.Unlock()
	entry, found := store.entries[libraryIndexKey(directory, relative)]
	return entry.Metadata, store.err == nil && found && entry.Size == info.Size() && entry.Modified == info.ModTime().UnixNano()
}

func rememberLibraryMetadata(directory, relative string, info os.FileInfo, value metadata.Info) {
	store := &savedLibraryIndex
	store.Lock()
	defer store.Unlock()
	if store.path == "" || store.err != nil || store.entries == nil {
		return
	}
	store.entries[libraryIndexKey(directory, relative)] = libraryIndexEntry{
		Directory: directory, Relative: relative, Size: info.Size(), Modified: info.ModTime().UnixNano(), Metadata: boundedScanInfo(value),
	}
}

func invalidateLibraryMetadata(directory, relative string) {
	savedLibraryIndex.Lock()
	defer savedLibraryIndex.Unlock()
	delete(savedLibraryIndex.entries, libraryIndexKey(directory, relative))
}

// Persist display metadata only. Every scan reopens the authorized file and
// registers a fresh native reference; saved paths and stamps are not capabilities.
func flushLibraryIndex() error {
	store := &savedLibraryIndex
	store.Lock()
	defer store.Unlock()
	if store.path == "" {
		return nil
	}
	if store.err != nil {
		return store.err
	}
	doc := libraryIndexDocument{Version: 1, Entries: make([]libraryIndexEntry, 0, len(store.entries))}
	for _, entry := range store.entries {
		doc.Entries = append(doc.Entries, entry)
	}
	data, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	save, err := prepareSettingsSave(store.path, data)
	if err != nil {
		return err
	}
	defer save.cleanup()
	return save.replace()
}
