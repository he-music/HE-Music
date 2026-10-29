package main

import "errors"

// All callbacks and the success cache are confined to the main thread.
// withBundle validates the running bundle before exposing its registration call.
type nativeProtocolBackend struct {
	sdk              protocolBackend
	available        func() bool
	onMain           func(func())
	withBundle       func(string, func(func() error) error) error
	bundleRegistered bool
}

func nativeProtocolScheme(scheme string) bool { return scheme == "orpheus" || scheme == "kuwo" }

var errNativeProtocolUnavailable = errors.New("protocol association unavailable before Ready or during generation")

func (b *nativeProtocolBackend) RegisterURLScheme(scheme string) error {
	if !nativeProtocolScheme(scheme) {
		return errors.New("invalid protocol scheme")
	}
	if !b.available() {
		return errNativeProtocolUnavailable
	}
	err := errNativeProtocolUnavailable
	b.onMain(func() {
		if !b.available() {
			return
		}
		err = b.withBundle(scheme, func(register func() error) error {
			if !b.bundleRegistered {
				if err := register(); err != nil {
					return err
				}
				b.bundleRegistered = true
			}
			return b.sdk.RegisterURLScheme(scheme)
		})
	})
	return err
}

func (b *nativeProtocolBackend) IsURLSchemeRegistered(scheme string) bool {
	if !nativeProtocolScheme(scheme) || !b.available() {
		return false
	}
	registered := false
	b.onMain(func() {
		if b.available() {
			registered = b.sdk.IsURLSchemeRegistered(scheme)
		}
	})
	return registered
}

func (b *nativeProtocolBackend) UnregisterURLScheme(scheme string) error {
	if !nativeProtocolScheme(scheme) {
		return errors.New("invalid protocol scheme")
	}
	if !b.available() {
		return errNativeProtocolUnavailable
	}
	err := errNativeProtocolUnavailable
	b.onMain(func() {
		if b.available() {
			err = b.sdk.UnregisterURLScheme(scheme)
		}
	})
	return err
}

// The policy reads only this controlled reason; native detail stays local.
type protocolRegistrationError struct {
	reason string
	cause  error
}

func (e *protocolRegistrationError) Error() string                      { return e.reason + ": " + e.cause.Error() }
func (e *protocolRegistrationError) Unwrap() error                      { return e.cause }
func (e *protocolRegistrationError) ProtocolRegistrationReason() string { return e.reason }
