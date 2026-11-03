package mtag

// FeatureSupport reports whether a feature can be read and written.
type FeatureSupport struct {
	Read  bool
	Write bool
}

// Capabilities describes what the current file/container can do
// through mtag's public API and native accessors.
type Capabilities struct {
	Container         ContainerKind
	CanSave           bool
	Images            FeatureSupport
	Lyrics            FeatureSupport
	Chapters          FeatureSupport
	CustomFields      FeatureSupport
	ReplayGain        FeatureSupport
	MusicBrainzIDs    FeatureSupport
	NativeAttachments FeatureSupport
	Podcast           FeatureSupport
	Rating            FeatureSupport
	PlayCount         FeatureSupport
}

// Capabilities reports the feature families the current file can read
// and persist.
func (f *File) Capabilities() Capabilities {
	kind := ContainerUnknown
	if f.container != nil {
		kind = f.container.Kind()
	}
	id3rw := supportsWritableID3v2(kind)
	ape := isAPEContainer(kind)

	return Capabilities{
		Container: kind,
		CanSave:   f.canSave(),
		Images: FeatureSupport{
			Read:  id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMP4 || kind == ContainerASF || kind == ContainerMatroska || ape,
			Write: id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMP4 || kind == ContainerASF || kind == ContainerMatroska || ape,
		},
		Lyrics: FeatureSupport{
			Read:  id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMP4 || kind == ContainerMatroska || ape,
			Write: id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMP4 || kind == ContainerMatroska || ape,
		},
		Chapters: FeatureSupport{
			Read:  id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMP4 || kind == ContainerMatroska || kind == ContainerWAV,
			Write: id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMP4 || kind == ContainerMatroska || kind == ContainerWAV,
		},
		CustomFields: FeatureSupport{
			Read:  id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMatroska || kind == ContainerASF || kind == ContainerRealMedia || kind == ContainerMP4 || ape,
			Write: id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMatroska || kind == ContainerASF || kind == ContainerMP4 || ape,
		},
		ReplayGain: FeatureSupport{
			Read:  id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMatroska || kind == ContainerASF || kind == ContainerMP4 || ape,
			Write: id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMatroska || kind == ContainerASF || kind == ContainerMP4 || ape,
		},
		MusicBrainzIDs: FeatureSupport{
			Read:  id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMatroska || kind == ContainerMP4 || ape,
			Write: id3rw || kind == ContainerFLAC || kind == ContainerOGG || kind == ContainerMatroska || kind == ContainerMP4 || ape,
		},
		NativeAttachments: FeatureSupport{
			Read:  kind == ContainerMatroska,
			Write: false, // not yet implemented
		},
		Podcast: FeatureSupport{
			Read:  id3rw,
			Write: id3rw,
		},
		Rating: FeatureSupport{
			Read:  id3rw,
			Write: id3rw,
		},
		PlayCount: FeatureSupport{
			Read:  id3rw,
			Write: id3rw,
		},
	}
}

func (f *File) canSave() bool {
	if f.forceReadOnly {
		return false
	}
	if f.rw != nil {
		return true
	}
	return f.fd != nil && f.path != ""
}

func supportsWritableID3v2(kind ContainerKind) bool {
	switch kind {
	case ContainerMP3,
		ContainerWAV,
		ContainerAIFF,
		ContainerAAC,
		ContainerAC3,
		ContainerDTS,
		ContainerAMR,
		ContainerDSF,
		ContainerDFF,
		ContainerTTA,
		ContainerOMA:
		return true
	}
	return false
}
