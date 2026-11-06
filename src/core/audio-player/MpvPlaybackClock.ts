import type { MpvSnapshot } from "@/platform/mpvPlayback";

/** 原生快照使用到达时的 JS 单调时钟，Go 与 JS 时钟原点互不比较。 */
export class MpvPlaybackClock {
  private position = 0;
  private duration = 0;
  private rate = 1;
  private running = false;
  private anchor = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  update(snapshot: Pick<MpvSnapshot, "position" | "duration" | "rate" | "state">): void {
    this.position = Math.max(0, snapshot.position);
    this.duration = snapshot.duration;
    this.rate = snapshot.rate;
    this.running = snapshot.state === "playing";
    this.anchor = this.now();
  }

  get currentTime(): number {
    const value =
      this.position + (this.running ? ((this.now() - this.anchor) / 1000) * this.rate : 0);
    return this.duration > 0 ? Math.min(value, this.duration) : value;
  }
}
