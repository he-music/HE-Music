package main

import "testing"

func TestMiniPlayerWaitsForInitialDOM(t *testing.T) {
	window := miniPlayerWindow{ready: true, attached: true}
	if window.canShow() {
		t.Fatal("原生就绪和 Attach 回执不足以显示窗口")
	}
	window.rendered = true
	if !window.canShow() {
		t.Fatal("子页更新 DOM 后应显示窗口")
	}
	window.ready = false
	if window.canShow() {
		t.Fatal("子页先确认时仍需等待原生窗口就绪")
	}
}

func TestMiniPlayerCommandsMatchTheDisplayedTrack(t *testing.T) {
	view := MiniPlayerView{Generation: 3, Revision: 7, Playback: MiniPlayerSnapshot{
		TrackKey: "song-a", CanNext: true, CanFavorite: true,
	}}
	for _, tc := range []struct {
		name     string
		request  MiniPlayerRequest
		accepted bool
	}{
		{"旧窗口", MiniPlayerRequest{2, 7, miniPlayerToggle}, false},
		{"旧歌曲快照", MiniPlayerRequest{3, 6, miniPlayerToggle}, false},
		{"播放", MiniPlayerRequest{3, 7, miniPlayerToggle}, true},
		{"播放下一曲", MiniPlayerRequest{3, 7, miniPlayerNext}, true},
		{"电台没有上一曲", MiniPlayerRequest{3, 7, miniPlayerPrevious}, false},
		{"收藏", MiniPlayerRequest{3, 7, miniPlayerFavorite}, true},
		{"窗口操作不转给播放器", MiniPlayerRequest{3, 7, miniPlayerPin}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			command, ok := view.playbackCommand(tc.request)
			if ok != tc.accepted {
				t.Fatalf("accepted = %v, want %v", ok, tc.accepted)
			}
			if ok && (command.TrackKey != "song-a" || command.Generation != 3 ||
				command.Action != tc.request.Action || command.Favorite != (tc.request.Action == miniPlayerFavorite)) {
				t.Fatalf("unexpected command: %+v", command)
			}
		})
	}
	view.Playback.Favorite = true
	request := MiniPlayerRequest{3, 7, miniPlayerFavorite}
	if command, ok := view.playbackCommand(request); !ok || command.Favorite {
		t.Fatalf("取消收藏命令无效: %+v, %v", command, ok)
	}
	view.Playback.CanFavorite = false
	if _, ok := view.playbackCommand(request); ok {
		t.Fatal("不可收藏的歌曲不应派发收藏命令")
	}
	view.Playback = MiniPlayerSnapshot{}
	if _, ok := view.playbackCommand(MiniPlayerRequest{3, 7, miniPlayerToggle}); ok {
		t.Fatal("无歌曲时不应派发播放命令")
	}
}
