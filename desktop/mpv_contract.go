package main

// 原生协议使用封闭字符串类型，生成绑定会保留这些状态、事件和错误分类。
type MpvState string

const (
	MpvStateIdle      MpvState = "idle"
	MpvStateLoading   MpvState = "loading"
	MpvStatePaused    MpvState = "paused"
	MpvStatePlaying   MpvState = "playing"
	MpvStateBuffering MpvState = "buffering"
	MpvStateEnded     MpvState = "ended"
	MpvStateError     MpvState = "error"
)

type MpvEventType string

const (
	MpvEventLoadStart      MpvEventType = "loadstart"
	MpvEventLoadedMetadata MpvEventType = "loadedmetadata"
	MpvEventDurationChange MpvEventType = "durationchange"
	MpvEventLoadedData     MpvEventType = "loadeddata"
	MpvEventCanPlay        MpvEventType = "canplay"
	MpvEventPlay           MpvEventType = "play"
	MpvEventPlaying        MpvEventType = "playing"
	MpvEventPause          MpvEventType = "pause"
	MpvEventWaiting        MpvEventType = "waiting"
	MpvEventStateChange    MpvEventType = "statechange"
	MpvEventSeeking        MpvEventType = "seeking"
	MpvEventSeeked         MpvEventType = "seeked"
	MpvEventEnded          MpvEventType = "ended"
	MpvEventEmptied        MpvEventType = "emptied"
	MpvEventError          MpvEventType = "error"
	MpvEventVolumeChange   MpvEventType = "volumechange"
	MpvEventRateChange     MpvEventType = "ratechange"
	MpvEventTimeUpdate     MpvEventType = "timeupdate"
	MpvEventDevicesChange  MpvEventType = "deviceschange"
)

type MpvFailureKind string

const (
	MpvFailureLibrary MpvFailureKind = "library"
	MpvFailureABI     MpvFailureKind = "abi"
	MpvFailureSymbol  MpvFailureKind = "symbol"
	MpvFailureSource  MpvFailureKind = "source"
	MpvFailureNetwork MpvFailureKind = "network"
	MpvFailureDecode  MpvFailureKind = "decode"
	MpvFailureDevice  MpvFailureKind = "device"
	MpvFailureEngine  MpvFailureKind = "engine"
)
