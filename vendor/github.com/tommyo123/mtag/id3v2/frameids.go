package id3v2

// Frame identifier constants. mtag canonicalises every frame to its
// ID3v2.3/2.4 identifier on read, translating v2.2's three-letter
// IDs up. The [FrameIDTo22] / [FrameIDFrom22] tables perform the
// round-trip needed when serialising to v2.2 or reading v2.2 frames.

const (
	FrameTitle         = "TIT2"
	FrameSubtitle      = "TIT3"
	FrameContentGroup  = "TIT1"
	FrameArtist        = "TPE1"
	FrameBand          = "TPE2"
	FrameConductor     = "TPE3"
	FrameRemixedBy     = "TPE4"
	FrameAlbum         = "TALB"
	FrameOriginalAlbum = "TOAL"
	FrameComposer      = "TCOM"
	FrameGenre         = "TCON"
	FrameTrack         = "TRCK"
	FramePart          = "TPOS"
	FrameYear          = "TYER" // ID3v2.3 only
	FrameRecordingTime = "TDRC" // ID3v2.4 (replaces TYER/TDAT/TIME)
	FrameReleaseTime   = "TDRL" // ID3v2.4
	FrameOriginalYear  = "TORY" // ID3v2.3
	FrameOriginalTime  = "TDOR" // ID3v2.4
	FrameLanguage      = "TLAN"
	FrameLength        = "TLEN"
	FrameEncodedBy     = "TENC"
	FrameCopyright     = "TCOP"
	FramePublisher     = "TPUB"
	FrameISRC          = "TSRC"
	FrameBPM           = "TBPM"
	FrameMediaType     = "TMED"
	FrameComment       = "COMM"
	FrameLyrics        = "USLT"
	FramePicture       = "APIC"
	FrameUserText      = "TXXX"
	FrameUserURL       = "WXXX"
	FramePrivate       = "PRIV"
	FrameUFID          = "UFID"
	FramePopularimeter = "POPM"
	FramePlayCount     = "PCNT"
	FrameChapter       = "CHAP" // ID3v2 Chapter Frame Addendum
	FrameTOC           = "CTOC" // ID3v2 Chapter Frame Addendum (table of contents)
	FrameGEOB          = "GEOB" // General encapsulated object
	FrameMCDI          = "MCDI" // Music CD identifier
	FrameATXT          = "ATXT" // Accessibility audio-text frame
	FrameSYLT          = "SYLT" // Synchronised lyrics / text
	FrameRVA2          = "RVA2" // Relative volume adjustment (v2.4)
	FrameETCO          = "ETCO" // Event timing codes
	FrameSYTC          = "SYTC" // Synchronised tempo codes
	FrameRVRB          = "RVRB" // Reverb
	FrameRBUF          = "RBUF" // Recommended buffer size
	FrameSEEK          = "SEEK" // Seek frame (v2.4)
	FrameASPI          = "ASPI" // Audio seek point index (v2.4)
	FrameSIGN          = "SIGN" // Signature (v2.4)
	FrameUSER          = "USER" // Terms-of-use
	FrameOWNE          = "OWNE" // Ownership
	FrameLINK          = "LINK" // Linked information
	FrameCOMR          = "COMR" // Commercial frame
	FrameRVAD          = "RVAD" // Relative volume adjustment (v2.3 predecessor of RVA2)
	FrameEQU2          = "EQU2" // Equalisation (v2.4)
	FrameEQUA          = "EQUA" // Equalisation (v2.3 predecessor of EQU2)
	FrameMLLT          = "MLLT" // MPEG location lookup table
	FrameAENC          = "AENC" // Audio encryption
	FrameENCR          = "ENCR" // Encryption method registration
	FrameGRID          = "GRID" // Group identification registration
	FramePOSS          = "POSS" // Position synchronisation
)

// frameIDUpgrade maps an ID3v2.2 three-letter identifier to its
// ID3v2.3/2.4 four-letter equivalent. Frames without a modern
// counterpart are left out; callers receive them as "raw" frames
// keyed by the original three-letter ID.
var frameIDUpgrade = map[string]string{
	"BUF": "RBUF",
	"CNT": "PCNT",
	"COM": "COMM",
	"CRA": "AENC",
	"ETC": "ETCO",
	"EQU": "EQUA",
	"GEO": "GEOB",
	"IPL": "IPLS",
	"LNK": "LINK",
	"MCI": "MCDI",
	"MLL": "MLLT",
	"PIC": "APIC",
	"POP": "POPM",
	"REV": "RVRB",
	"RVA": "RVAD",
	"SLT": "SYLT",
	"STC": "SYTC",
	"TAL": "TALB",
	"TBP": "TBPM",
	"TCM": "TCOM",
	"TCO": "TCON",
	"TCR": "TCOP",
	"TDA": "TDAT",
	"TDY": "TDLY",
	"TEN": "TENC",
	"TFT": "TFLT",
	"TIM": "TIME",
	"TKE": "TKEY",
	"TLA": "TLAN",
	"TLE": "TLEN",
	"TMT": "TMED",
	"TOA": "TOPE",
	"TOF": "TOFN",
	"TOL": "TOLY",
	"TOR": "TORY",
	"TOT": "TOAL",
	"TP1": "TPE1",
	"TP2": "TPE2",
	"TP3": "TPE3",
	"TP4": "TPE4",
	"TPA": "TPOS",
	"TPB": "TPUB",
	"TRC": "TSRC",
	"TRD": "TRDA",
	"TRK": "TRCK",
	"TSI": "TSIZ",
	"TSS": "TSSE",
	"TT1": "TIT1",
	"TT2": "TIT2",
	"TT3": "TIT3",
	"TXT": "TEXT",
	"TXX": "TXXX",
	"TYE": "TYER",
	"UFI": "UFID",
	"ULT": "USLT",
	"WAF": "WOAF",
	"WAR": "WOAR",
	"WAS": "WOAS",
	"WCM": "WCOM",
	"WCP": "WCOP",
	"WPB": "WPUB",
	"WXX": "WXXX",
}

// frameIDDowngrade is the reverse of frameIDUpgrade.
var frameIDDowngrade map[string]string

func init() {
	frameIDDowngrade = make(map[string]string, len(frameIDUpgrade))
	for k, v := range frameIDUpgrade {
		frameIDDowngrade[v] = k
	}
}

// UpgradeFrameID translates an ID3v2.2 three-letter frame ID to its
// v2.3/2.4 equivalent. Unknown three-letter IDs are returned
// unchanged so callers can distinguish proprietary frames.
func UpgradeFrameID(id string) string {
	if u, ok := frameIDUpgrade[id]; ok {
		return u
	}
	return id
}

// DowngradeFrameID is the inverse of UpgradeFrameID. It returns the
// v2.2 equivalent, or an empty string if the frame has no v2.2
// counterpart.
func DowngradeFrameID(id string) string {
	return frameIDDowngrade[id]
}

// IsTextFrame reports whether id names a simple text information
// frame (starts with 'T' and is not the user-defined TXXX).
func IsTextFrame(id string) bool {
	return len(id) >= 3 && id[0] == 'T' && id != FrameUserText && id != "TXX"
}

// IsURLFrame reports whether id names a URL link frame ('W' prefix,
// excluding WXXX/WXX).
func IsURLFrame(id string) bool {
	return len(id) >= 3 && id[0] == 'W' && id != FrameUserURL && id != "WXX"
}
