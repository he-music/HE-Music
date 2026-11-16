//go:build js

package media

import "syscall/js"

// On browsers, a picture's surface is the video element that plays it,
// which WebGL uploads from GPU to GPU: Surface.Native holds the number
// AddElement gave it, which ElementOf takes back.

var (
	elements    = map[uintptr]js.Value{}
	lastElement uintptr
)

// AddElement numbers a video element, for a surface's Native.
func AddElement(v js.Value) uintptr {
	lastElement++
	elements[lastElement] = v
	return lastElement
}

// ElementOf returns the video element of a number AddElement gave, or
// undefined once RemoveElement removed it.
func ElementOf(n uintptr) js.Value {
	if v, ok := elements[n]; ok {
		return v
	}
	return js.Undefined()
}

// RemoveElement forgets the video element of a number.
func RemoveElement(n uintptr) { delete(elements, n) }
