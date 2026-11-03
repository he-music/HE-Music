#!/bin/sh
# 在启动进程前选择 WebKitGTK 绘制路径；不修改系统环境或安装依赖。
set -u
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
mode=${1:-normal}
case "$mode" in
  software-gl)
    export LIBGL_ALWAYS_SOFTWARE=1
    export WEBKIT_SKIA_ENABLE_CPU_RENDERING=1
    export WEBKIT_DISABLE_DMABUF_RENDERER=0
    export WEBKIT_DISABLE_COMPOSITING_MODE=0
    ;;
  normal)
    unset LIBGL_ALWAYS_SOFTWARE WEBKIT_SKIA_ENABLE_CPU_RENDERING WEBKIT_DISABLE_DMABUF_RENDERER WEBKIT_DISABLE_COMPOSITING_MODE
    ;;
  *) printf '用法: %s [normal|software-gl] [播放器可执行文件]\n' "$0" >&2; exit 2 ;;
esac
export HE_MUSIC_GRAPHICS_MODE_OVERRIDE="$mode"
binary=${2:-"$script_dir/he-music"}
if [ ! -x "$binary" ]; then
  printf '播放器不存在或不可执行，请提供程序路径: %s\n' "$binary" >&2
  exit 2
fi
log_file="$script_dir/ubuntu22-$mode-diagnostic.log"
{
  printf 'HE-Music Linux diagnostic v5 (persistent graphics settings)\n'
  printf 'Mode: %s\n' "$mode"
  date -u
  printf 'Session: %s\n' "${XDG_SESSION_TYPE:-unknown}"
  uname -m
  # 只记录已知渲染开关，不展开整个环境。
  printf 'WEBKIT_SKIA_ENABLE_CPU_RENDERING=%s\n' "${WEBKIT_SKIA_ENABLE_CPU_RENDERING:-unset}"
  printf 'WEBKIT_DISABLE_DMABUF_RENDERER=%s\n' "${WEBKIT_DISABLE_DMABUF_RENDERER:-unset}"
  printf 'WEBKIT_DISABLE_COMPOSITING_MODE=%s\n' "${WEBKIT_DISABLE_COMPOSITING_MODE:-unset}"
  printf 'LIBGL_ALWAYS_SOFTWARE=%s\n' "${LIBGL_ALWAYS_SOFTWARE:-unset}"
  if command -v dpkg >/dev/null 2>&1 && command -v dpkg-query >/dev/null 2>&1; then
    package_arch=$(dpkg --print-architecture)
    for package in libgtk-3-0 libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav gstreamer1.0-pulseaudio; do
      dpkg-query -W -f='${binary:Package} ${Architecture} ${Version} ${db:Status-Status}\n' "$package:$package_arch" 2>/dev/null || printf '%s: 未查询到当前架构的软件包\n' "$package"
    done
  fi
  if command -v gst-inspect-1.0 >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    for element in fakevideosink webvttenc pulsesink avdec_mp3; do
      if timeout 3 gst-inspect-1.0 "$element" >/dev/null 2>&1; then
        printf 'GStreamer %s: available\n' "$element"
      else
        printf 'GStreamer %s: unavailable or check timed out\n' "$element"
      fi
    done
  else
    printf '未检查 GStreamer 元素：需要 gst-inspect-1.0 和 timeout\n'
  fi
  printf '请先从托盘退出旧版；本次模式只影响这个播放器进程及其子进程。\n'
  if "$binary"; then
    printf 'application_exit=0\n'
  else
    application_status=$?
    printf 'application_exit=%s\n' "$application_status"
  fi
} 2>&1 | tee "$log_file"
