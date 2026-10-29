package main

import (
	"errors"
	"io"
	"os"
	"sync"
)

// The coordinator captures this seam into each job before starting IO. Tests may
// fail a particular operation without sharing mutable process-global hooks.
type downloadIO struct {
	Before              func(kind, operation string) error
	DirectoryDurability func(*os.Root) (bool, error)
}

func (d downloadIO) before(kind, op string) error {
	if d.Before != nil {
		return d.Before(kind, op)
	}
	return nil
}

type downloadOwnedPrivate struct {
	root       *os.Root
	parent     os.FileInfo
	file       *os.File
	identity   os.FileInfo
	name, kind string
	io         downloadIO
	residual   bool
	closeOnce  sync.Once
	closeErr   error
}

func downloadNewPrivate(root *os.Root, kind string, d downloadIO) (*downloadOwnedPrivate, error) {
	parent, err := root.Stat(".")
	if err != nil {
		return nil, err
	}
	nonce, err := newDirectoryToken()
	if err != nil {
		return nil, err
	}
	name := downloadPrivatePrefix + kind + "-" + nonce
	f, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	// Capture the real inode even when the injected Stat operation fails. This
	// permits identity-safe cleanup of a successfully created but rejected file.
	identity, err := f.Stat()
	p := &downloadOwnedPrivate{root: root, parent: parent, file: f, identity: identity, name: name, kind: kind, io: d}
	if err != nil {
		return p, err
	}
	if err = d.before(kind, "stat"); err != nil {
		return p, err
	}
	return p, nil
}
func (p *downloadOwnedPrivate) write(b []byte) error {
	if err := p.io.before(p.kind, "write"); err != nil {
		return err
	}
	n, err := p.file.Write(b)
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	return err
}
func (p *downloadOwnedPrivate) sync() error {
	if err := p.io.before(p.kind, "sync"); err != nil {
		return err
	}
	return p.file.Sync()
}
func (p *downloadOwnedPrivate) close() error {
	p.closeOnce.Do(func() { injected := p.io.before(p.kind, "close"); p.closeErr = errors.Join(injected, p.file.Close()) })
	return p.closeErr
}
func (p *downloadOwnedPrivate) cleanup() error {
	if p == nil {
		return nil
	}
	closeErr := p.close()
	p.residual = true
	parent, err := p.root.Stat(".")
	if err != nil {
		return errors.Join(closeErr, err)
	}
	if !os.SameFile(parent, p.parent) {
		return errors.Join(closeErr, errFilesChanged)
	}
	if err = p.io.before(p.kind, "lstat"); err != nil {
		return errors.Join(closeErr, err)
	}
	current, err := p.root.Lstat(p.name)
	if errors.Is(err, os.ErrNotExist) {
		p.residual = false
		return closeErr
	}
	if err != nil {
		return errors.Join(closeErr, err)
	}
	if p.identity == nil || !os.SameFile(current, p.identity) {
		return errors.Join(closeErr, errFilesChanged)
	}
	if err = p.io.before(p.kind, "remove"); err != nil {
		return errors.Join(closeErr, err)
	}
	err = p.root.Remove(p.name)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		p.residual = false
	}
	return errors.Join(closeErr, err)
}

func (p *downloadOwnedPrivate) publish(name string) error {
	parent, err := p.root.Stat(".")
	if err != nil {
		return err
	}
	if !os.SameFile(parent, p.parent) {
		return errFilesChanged
	}
	current, err := p.root.Lstat(p.name)
	if err != nil {
		return err
	}
	if p.identity == nil || !os.SameFile(current, p.identity) {
		return errFilesChanged
	}
	if err = p.root.Link(p.name, name); err != nil {
		return err
	}
	return nil
}
