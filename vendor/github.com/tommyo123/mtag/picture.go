package mtag

// PictureType enumerates the attached-picture roles defined by ID3v2
// (APIC / PIC). Values are intentionally identical to the byte stored
// in the frame so the enum doubles as the wire representation.
type PictureType byte

const (
	PictureOther              PictureType = 0x00
	PictureFileIcon32x32      PictureType = 0x01
	PictureOtherFileIcon      PictureType = 0x02
	PictureCoverFront         PictureType = 0x03
	PictureCoverBack          PictureType = 0x04
	PictureLeafletPage        PictureType = 0x05
	PictureMedia              PictureType = 0x06
	PictureLeadArtist         PictureType = 0x07
	PictureArtist             PictureType = 0x08
	PictureConductor          PictureType = 0x09
	PictureBand               PictureType = 0x0A
	PictureComposer           PictureType = 0x0B
	PictureLyricist           PictureType = 0x0C
	PictureRecordingLocation  PictureType = 0x0D
	PictureDuringRecording    PictureType = 0x0E
	PictureDuringPerformance  PictureType = 0x0F
	PictureScreenCapture      PictureType = 0x10
	PictureBrightColouredFish PictureType = 0x11
	PictureIllustration       PictureType = 0x12
	PictureBandLogo           PictureType = 0x13
	PicturePublisherLogo      PictureType = 0x14
)

// Picture is an embedded image attached to a tag. It is the neutral
// representation used by the polymorphic API; individual tag formats
// translate to and from this struct.
type Picture struct {
	// MIME type such as "image/jpeg" or "image/png". For legacy
	// ID3v2.2 PIC frames mtag maps the three-character image format
	// to the corresponding MIME type transparently.
	MIME string
	// Type is the picture role (cover art, band logo, …).
	Type PictureType
	// Description is an optional human-readable caption. ID3
	// considers (Type, Description) the unique identifier of a
	// picture within a tag.
	Description string
	// Data is the raw image payload.
	Data []byte
}

// ImageSummary is the light-weight counterpart to [Picture]. It is
// intended for scans that only need type, MIME, and payload size.
type ImageSummary struct {
	MIME string
	Type PictureType
	Size int
}
