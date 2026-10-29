//go:build !darwin

package main

import "github.com/egoist/mygo"

func installWindowButtonsHover(_ *mygo.Window, _ bool) (func(), error) {
	return func() {}, nil
}
