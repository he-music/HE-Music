package gpu

import (
	"cmp"
	"image"
	"math"
	"slices"

	"github.com/egoist/mygo/internal/raster"
	"github.com/egoist/mygo/internal/scene"
)

// clipMaskSlot is a retained clip mask. Masks outlive the frames that
// don't use them, up to idleMaskBytes of them, so a transform that comes
// and goes finds its masks again instead of rasterizing them.
type clipMaskSlot struct {
	// shapes are the clips the mask is of, their stops in stops, and area
	// the frame pixels it covers: the clip's scissor rectangle, or more
	// for a clip that grows (maskArea).
	shapes []scene.ClipShape
	stops  []scene.Stop
	area   image.Rectangle
	image  *scene.Image
	// frame is the last frame that used the mask, and slot the clip's
	// place among that frame's masked clips.
	frame uint64
	slot  int
}

// idleMaskBytes is how much memory the masks no clip of the frame uses
// keep, the least recently used dropped first.
const idleMaskBytes = 32 << 20

func (b *Builder) prepare(in *Instance, m scene.Affine, c *clip) bool {
	b.preparedMask = 0
	if c.scissor.Empty() || in.Rect[2] <= 0 || in.Rect[3] <= 0 {
		return false
	}
	if _, ok := m.Inverse(); !ok {
		return false
	}
	in.Transform0, in.Transform1, in.Transform2 = [4]float32{1, 0, 0, 0}, [4]float32{0, 1, 0, 0}, [4]float32{}
	if m.Set {
		in.Transform0 = [4]float32{m.A, m.C, m.X, 1}
		in.Transform1 = [4]float32{m.B, m.D, m.Y, 0}
		in.Transform2 = [4]float32{m.G, m.H, 0, 0}
		if m.Behind {
			in.Transform2[2] = 1 // the divisor's constant term is -1
		}
	}
	in.Clip, in.ClipRadii = rect(c.rect), c.radii
	if !c.masked {
		return true
	}
	// Stationary clips can often reduce to one rounded rectangle, even
	// around scaled content or a fractional scrolling viewport. Evaluate
	// that geometry in the shader instead of rasterizing a window-sized mask.
	if !c.moved && !c.masks {
		if rounded, ok := b.analyticClip(); ok {
			in.Clip, in.ClipRadii = rect(rounded.rect), rounded.radii
			return true
		}
	}
	// A hard clip sharing the drawing's coordinates is cheap to evaluate in
	// the fragment shader. Keep the rounded ancestor's mask stationary even
	// when a text input or custom clipped drawing moves within it. Drawing
	// that a translation of the clip's moved shares them too, folded into
	// the frame's (scene.TranslationFolder): the clip's rectangle moves.
	// So does drawing that nothing transforms, or that a translation only
	// moves, in a clip in the frame's coordinates (as a clip only moved
	// is, scene.MovedClip), whose rectangle moves the other way: as a
	// pane reaching into the rounded corners of the frame around it
	// (markEnclosing), which then needs no mask of its own.
	shared, dx, dy := c.shape.Transform == m && m.Set, float32(0), float32(0)
	if tx, ty, moved := m.Translation(); !c.shape.Transform.Set && (!m.Set || moved) {
		dx, dy, shared = -tx, -ty, true
	}
	if c.shape.Radii == [4]float32{} && !c.shape.Masks() && shared && len(b.stack) > 1 {
		parent := &b.stack[len(b.stack)-2]
		if parent.masked {
			b.preparedMask = b.clipTexture(parent, b.clipShapes[:len(b.clipShapes)-1])
			if b.preparedMask == 0 {
				return false
			}
			in.Clip = rect(c.rect)
			in.Clip[0], in.Clip[1] = in.Clip[0]+dx, in.Clip[1]+dy
			in.ClipRadii = areaRect(parent.maskArea)
			in.Transform1[3] = 2
			return true
		}
	}
	b.preparedMask = b.clipTexture(c, b.clipShapes)
	if b.preparedMask == 0 {
		return false
	}
	in.Clip = areaRect(c.maskArea)
	in.ClipRadii = [4]float32{}
	in.Transform1[3] = 1
	return true
}

// analyticClip removes clips that cover every pixel of the scissor, then
// represents the remaining coverage with one rectangle and its corners.
// Overlapping antialiased edges still need their multiplied pixel mask.
func (b *Builder) analyticClip() (clip, bool) {
	var rounded, hard *clip
	sc := b.stack[len(b.stack)-1].scissor
	area := scene.Rect{X: float32(sc.Left), Y: float32(sc.Top), W: float32(sc.Right - sc.Left), H: float32(sc.Bottom - sc.Top)}
	for i := range b.stack {
		c := &b.stack[i]
		// Only Metal's shader evaluates continuous corners (SplitCorners):
		// the other renderers, which never draw them in an app, keep the
		// mask. On Metal, a pane against the side of a rounded frame, as a
		// sidebar, cuts the frame's curves in the shader rather than with a
		// mask of the whole frame (#1511).
		if continuous(c.radii) && !b.contClips {
			return clip{}, false
		}
		if c.radii == [4]float32{} && integerClip(c.rect) {
			continue // the batch scissor implements these edges exactly
		}
		if clipOpaqueWithin(c, area) {
			continue
		}
		if c.radii != [4]float32{} {
			if rounded != nil {
				return clip{}, false
			}
			rounded = c
		} else {
			if hard != nil {
				return clip{}, false
			}
			hard = c
		}
	}
	if rounded == nil {
		if hard != nil {
			return *hard, true
		}
		return clip{rect: area}, true
	}
	if hard != nil {
		return intersectAnalyticClip(*rounded, hard.rect)
	}
	return *rounded, true
}

func integerClip(r scene.Rect) bool {
	for _, v := range [4]float32{r.X, r.Y, r.X + r.W, r.Y + r.H} {
		if v != float32(math.Floor(float64(v))) {
			return false
		}
	}
	return true
}

// clipCornerBounds conservatively encloses each curve and its
// antialiasing: a continuous one (negative radius) reaches contExtent
// times its radius from its corner, where the shader stops evaluating it
// (contValue).
func clipCornerBounds(c *clip) [4]scene.Rect {
	r := c.rect
	var boxes [4]scene.Rect
	for i, radius := range c.radii {
		if radius == 0 {
			continue
		}
		reach := radius + 1
		if radius < 0 {
			reach = -radius*contExtent + 1
		}
		box := scene.Rect{X: r.X, Y: r.Y, W: reach, H: reach}
		if i == 1 || i == 2 {
			box.X = r.X + r.W - reach
		}
		if i == 2 || i == 3 {
			box.Y = r.Y + r.H - reach
		}
		boxes[i] = box
	}
	return boxes
}

// clipOpaqueWithin proves that a clip contributes coverage 1 to every
// integer pixel box in area; merely containing the pixel centers is unsafe.
func clipOpaqueWithin(c *clip, area scene.Rect) bool {
	r := c.rect
	if area.X < r.X || area.Y < r.Y || area.X+area.W > r.X+r.W || area.Y+area.H > r.Y+r.H {
		return false
	}
	for _, box := range clipCornerBounds(c) {
		if !box.Intersect(area).Empty() {
			return false
		}
	}
	return true
}

// intersectAnalyticClip trims away whole corners, as a fractional lyrics
// viewport trims its player card. Cutting a curve or multiplying partial
// coverages cannot be represented by a single rounded rectangle.
func intersectAnalyticClip(c clip, hard scene.Rect) (clip, bool) {
	r := c.rect.Intersect(hard)
	if r.W < 1 || r.H < 1 {
		return clip{}, false
	}
	before := [4]float32{c.rect.X, c.rect.Y, c.rect.X + c.rect.W, c.rect.Y + c.rect.H}
	after := [4]float32{r.X, r.Y, r.X + r.W, r.Y + r.H}
	edges := [4]float32{hard.X, hard.Y, hard.X + hard.W, hard.Y + hard.H}
	for i, edge := range edges {
		old := float64(before[i])
		if i < 2 {
			if edge <= before[i] && float64(edge) > math.Floor(old) || edge > before[i] && math.Floor(float64(edge)) < math.Ceil(old) {
				return clip{}, false
			}
		} else if edge >= before[i] && float64(edge) < math.Ceil(old) || edge < before[i] && math.Ceil(float64(edge)) > math.Floor(old) {
			return clip{}, false
		}
	}
	pixels := scene.Rect{X: float32(math.Floor(float64(r.X))), Y: float32(math.Floor(float64(r.Y)))}
	pixels.W, pixels.H = float32(math.Ceil(float64(r.X+r.W)))-pixels.X, float32(math.Ceil(float64(r.Y+r.H)))-pixels.Y
	for i, box := range clipCornerBounds(&c) {
		sides := [4][2]int{{0, 1}, {2, 1}, {2, 3}, {0, 3}}[i]
		if after[sides[0]] != before[sides[0]] || after[sides[1]] != before[sides[1]] {
			if !box.Intersect(pixels).Empty() {
				return clip{}, false
			}
			c.radii[i] = 0
		} else if box.W > r.W/2 || box.H > r.H/2 {
			// Moving a surviving curve across the new midpoint would change
			// which corner the shader evaluates there. A continuous curve
			// keeps its shape too, which depends on the sides and its
			// neighbors' radii only where they are shorter than
			// contExtent times the radii they join (the shader's
			// contCorner): a side the cut leaves is as long as before, with
			// the same neighbor, and one it shortens is still twice this
			// box long, its neighbor cut away beyond it.
			return clip{}, false
		}
	}
	c.rect = r
	return c, true
}

func (b *Builder) clipTexture(c *clip, shapes []scene.ClipShape) uintptr {
	if c.maskTexture != 0 {
		return c.maskTexture
	}
	area := image.Rect(int(c.scissor.Left), int(c.scissor.Top), int(c.scissor.Right), int(c.scissor.Bottom))
	// The mask of the same clip, in this frame or an earlier one; else
	// the one the clip in its place had last frame, which it most likely
	// is, changed; else a new one.
	found, reuse := -1, -1
	for i := range b.maskSlots {
		m := &b.maskSlots[i]
		// A mask of more of the frame than the clip's scissor rectangle
		// holds the same coverage there.
		if area.In(m.area) && slices.EqualFunc(m.shapes, shapes, func(a, b scene.ClipShape) bool { return a.Same(&b) }) {
			found = i
			break
		}
		if reuse < 0 && m.frame == b.frame-1 && m.slot == c.maskSlot {
			reuse = i
		}
	}
	if found < 0 {
		found = reuse
		if found < 0 {
			found = len(b.maskSlots)
			b.maskSlots = append(b.maskSlots, clipMaskSlot{})
		}
		m := &b.maskSlots[found]
		m.area = maskArea(area, m.image, b.stack[0].scissor)
		m.image = raster.ClipMask(m.image, shapes, m.area)
		m.keep(shapes)
	}
	m := &b.maskSlots[found]
	m.frame, m.slot = b.frame, c.maskSlot
	c.maskArea = m.area
	c.maskTexture = b.imageTexture(m.image)
	return c.maskTexture
}

// maskArea returns the frame pixels to rasterize a clip's mask into,
// for a clip whose scissor rectangle is area, given had, the mask the
// clip in its place had last frame. A new mask covers area. Otherwise
// the mask keeps had's size, placed where area fits in it, so that a
// clip that changes reuses its mask's memory and texture instead of
// allocating both again on every frame of its animation. A card growing
// out of a cover to fill the window allocated 190 MB in 40 frames
// (egoist/mygo-music#55). A side that outgrows it doubles, up to the
// frame's size, and a clip that shrinks to less than a quarter of it
// takes its own size.
func maskArea(area image.Rectangle, had *scene.Image, frame Scissor) image.Rectangle {
	if had == nil || had.W <= 0 || had.H <= 0 {
		return area
	}
	w, h := area.Dx(), area.Dy()
	if 4*w*h < had.W*had.H {
		return area
	}
	grow := func(n, was, most int) int {
		if n <= was {
			return was
		}
		return max(n, min(2*was, most))
	}
	w, h = grow(w, had.W, int(frame.Right-frame.Left)), grow(h, had.H, int(frame.Bottom-frame.Top))
	// Within the frame where it fits, rather than rasterizing what is off
	// it.
	place := func(lo, hi, n int, end int32) int {
		return max(min(lo, int(end)-n), hi-n)
	}
	x, y := place(area.Min.X, area.Max.X, w, frame.Right), place(area.Min.Y, area.Max.Y, h, frame.Bottom)
	return image.Rect(x, y, x+w, y+h)
}

// areaRect returns area, a mask's frame pixels, as the shaders take it:
// its origin and size, which map frame pixels to the mask's texels.
func areaRect(area image.Rectangle) [4]float32 {
	return [4]float32{float32(area.Min.X), float32(area.Min.Y), float32(area.Dx()), float32(area.Dy())}
}

// keep keeps shapes as the mask's, with copies of their stops, which
// the scene's are not from frame to frame.
func (m *clipMaskSlot) keep(shapes []scene.ClipShape) {
	m.shapes = append(m.shapes[:0], shapes...)
	m.stops = m.stops[:0]
	for _, c := range shapes {
		m.stops = append(m.stops, c.Stops...)
	}
	at := 0
	for i := range m.shapes {
		if st := m.shapes[i].Stops; st != nil {
			m.shapes[i].Stops = m.stops[at : at+len(st) : at+len(st)]
			at += len(st)
		}
	}
}

// dropIdleMasks drops the least recently used masks this frame didn't use
// beyond idle bytes of them.
func (b *Builder) dropIdleMasks(idle int) {
	slices.SortFunc(b.maskSlots, func(x, y clipMaskSlot) int { return cmp.Compare(y.frame, x.frame) })
	for i := range b.maskSlots {
		m := &b.maskSlots[i]
		if m.frame == b.frame {
			continue
		}
		// The memory a mask keeps, which may be more than its pixels
		// take up: Resize reuses it for smaller ones.
		if idle -= cap(m.image.Pix); idle < 0 {
			clear(b.maskSlots[i:])
			b.maskSlots = b.maskSlots[:i]
			return
		}
	}
}
