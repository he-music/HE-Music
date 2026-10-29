//go:build !darwin

package main

import "github.com/egoist/mygo"

func newNativeProtocolBackend() protocolBackend { return mygo.App }
