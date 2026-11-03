package main

import "errors"

// Native calls must run on the window's UI thread. Keep policy verification
// independent of platform bindings so missing views and failed setters fail open.
type nativeWebViewPolicyAccess struct {
	isWebView                    func(uintptr) bool
	children                     func(uintptr) []uintptr
	settings                     func(uintptr) uintptr
	requiresGesture              func(uintptr) bool
	setGesture                   func(uintptr, bool)
	acceleration                 func(uintptr) int32
	setAcceleration              func(uintptr, int32)
	prepareTransparentBackground func(uintptr) error
}

const webViewCompositingEnabled int32 = 1 // WEBKIT_HARDWARE_ACCELERATION_POLICY_ALWAYS

func nativeWebViewTarget(handle uintptr, access nativeWebViewPolicyAccess) (uintptr, uintptr, error) {
	if handle == 0 || access.isWebView == nil || access.children == nil || access.settings == nil {
		return 0, 0, errors.New("native web view is unavailable")
	}
	queue := []uintptr{handle}
	seen := make(map[uintptr]bool)
	for len(queue) != 0 && len(seen) < 64 {
		widget := queue[0]
		queue = queue[1:]
		if widget == 0 || seen[widget] {
			continue
		}
		seen[widget] = true
		if access.isWebView(widget) {
			if settings := access.settings(widget); settings != 0 {
				return widget, settings, nil
			}
			return 0, 0, errors.New("native web view settings are unavailable")
		}
		queue = append(queue, access.children(widget)...)
	}
	return 0, 0, errors.New("native web view was not found")
}

func nativeWebViewSettings(handle uintptr, access nativeWebViewPolicyAccess) (uintptr, error) {
	_, settings, err := nativeWebViewTarget(handle, access)
	return settings, err
}

func applyNativePlaybackPolicy(handle uintptr, access nativeWebViewPolicyAccess) error {
	settings, err := nativeWebViewSettings(handle, access)
	if err != nil {
		return err
	}
	if access.requiresGesture == nil || access.setGesture == nil {
		return errors.New("native playback policy is unavailable")
	}
	// Autoplay intent remains owned by Player; async URL resolution must not
	// introduce a second browser gesture gate inside the desktop application.
	access.setGesture(settings, false)
	if access.requiresGesture(settings) {
		return errors.New("native playback policy did not take effect")
	}
	return nil
}

func applyNativeLyricsRenderingPolicy(handle uintptr, access nativeWebViewPolicyAccess) error {
	view, settings, err := nativeWebViewTarget(handle, access)
	if err != nil {
		return err
	}
	if access.acceleration == nil || access.setAcceleration == nil {
		return errors.New("native lyrics rendering policy is unavailable")
	}
	// WebKitGTK 2.50's non-composited transparent backing store retains stale
	// pixels. Keep compositing even when Skia/Mesa use software rendering.
	access.setAcceleration(settings, webViewCompositingEnabled)
	var policyErr error
	if access.acceleration(settings) != webViewCompositingEnabled {
		policyErr = errors.New("native lyrics rendering policy did not take effect")
	}
	if access.prepareTransparentBackground == nil {
		return errors.Join(policyErr, errors.New("native transparent background clearing is unavailable"))
	}
	return errors.Join(policyErr, access.prepareTransparentBackground(view))
}

type nativeTransparentDrawAccess struct {
	save        func(uintptr)
	setOperator func(uintptr, int32)
	paint       func(uintptr)
	restore     func(uintptr)
}

func clearNativeTransparentBackground(context uintptr, access nativeTransparentDrawAccess) {
	if context == 0 {
		return
	}
	access.save(context)
	access.setOperator(context, 0) // CAIRO_OPERATOR_CLEAR, clipped to GTK's damage region
	access.paint(context)
	access.restore(context)
}
