import { expect, it, vi } from "vitest";
import { createPVProgramCache, type PVSong } from "./runtime";
import { createPVTheme } from "./model";

// 布局重排复用原分镜；真正换歌、歌词晚到与时长变化仍重新编译。
it("reuses the program through viewport and theme changes while retaining song updates", () => {
  const compile = vi.fn(() => ({}));
  const programFor = createPVProgramCache(compile);
  const song: PVSong = {
    seed: "song",
    lines: [],
    duration: 100,
    theme: createPVTheme("240, 160, 110", "sans-serif", 700, false),
    title: "歌曲",
    artist: "歌手",
    album: "专辑",
  };
  const program = programFor(song);
  expect(
    programFor({ ...song, theme: { ...song.theme, lyricSafeArea: { top: 0.25, bottom: 0.13 } } }),
  ).toBe(program);
  expect(programFor({ ...song, title: "新标题" })).toBe(program);
  expect(compile).toHaveBeenCalledOnce();
  expect(programFor({ ...song, lines: [...song.lines] })).not.toBe(program);
  programFor({ ...song, seed: "another-song" });
  programFor({ ...song, duration: 120 });
  expect(compile).toHaveBeenCalledTimes(4);
});
