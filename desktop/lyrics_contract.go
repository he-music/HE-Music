package main

// All lyric and clock times are milliseconds, including offsetMs. Line bounds
// are independent of the first/last word bounds in the upstream LyricLine type.
type LyricsWord struct {
	StartTime float64 `json:"startTime"`
	EndTime   float64 `json:"endTime"`
	Word      string  `json:"word"`
	RomanWord *string `json:"romanWord,omitempty"`
}

type LyricsLine struct {
	Words           []LyricsWord `json:"words"`
	TranslatedLyric string       `json:"translatedLyric"`
	RomanLyric      string       `json:"romanLyric"`
	IsBG            bool         `json:"isBG"`
	IsDuet          bool         `json:"isDuet"`
	StartTime       float64      `json:"startTime"`
	EndTime         float64      `json:"endTime"`
}

type LyricsSession struct {
	Epoch uint64 `json:"epoch"`
}

type LyricsBounds struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Visible means the native window has been shown; Pending means ready/Attach
// is still outstanding. A failed asynchronous open reports Failure and false.
// Locked windows ignore mouse events; a native tray action always permits unlocking.
type LyricsWindowState struct {
	Epoch       uint64        `json:"epoch"`
	Revision    uint64        `json:"revision"`
	Visible     bool          `json:"visible"`
	Pending     bool          `json:"pending"`
	Locked      bool          `json:"locked"`
	HoverUnlock bool          `json:"hoverUnlock"`
	Bounds      LyricsBounds  `json:"bounds"`
	WorkArea    *LyricsBounds `json:"workArea,omitempty"`
	Failure     string        `json:"failure"`
}

type LyricsSnapshot struct {
	Epoch      uint64         `json:"epoch"`
	Seq        uint64         `json:"seq"`
	TrackKey   string         `json:"trackKey"`
	PlayName   string         `json:"playName"`
	ArtistName string         `json:"artistName"`
	Playing    bool           `json:"playing"`
	PositionMs float64        `json:"positionMs"`
	OffsetMs   float64        `json:"offsetMs"`
	Rate       float64        `json:"rate"`
	Loading    bool           `json:"loading"`
	LrcData    []LyricsLine   `json:"lrcData"`
	YrcData    []LyricsLine   `json:"yrcData"`
	Style      *LyricsStyle   `json:"style,omitempty"`
	Options    *LyricsOptions `json:"options,omitempty"`
}

type LyricsClock struct {
	Epoch      uint64  `json:"epoch"`
	Seq        uint64  `json:"seq"`
	TrackKey   string  `json:"trackKey"`
	Playing    bool    `json:"playing"`
	PositionMs float64 `json:"positionMs"`
	OffsetMs   float64 `json:"offsetMs"`
	Rate       float64 `json:"rate"`
}

type LyricsAttachment struct {
	Window   LyricsWindowState `json:"window"`
	Snapshot *LyricsSnapshot   `json:"snapshot"`
}

type LyricsAction string

const (
	LyricsPrevious     LyricsAction = "previous"
	LyricsToggle       LyricsAction = "toggle"
	LyricsNext         LyricsAction = "next"
	LyricsShowMain     LyricsAction = "show-main"
	LyricsOpenSettings LyricsAction = "open-settings"
)

type LyricsCommand struct {
	Epoch    uint64       `json:"epoch"`
	TrackKey string       `json:"trackKey"`
	Action   LyricsAction `json:"action"`
}
