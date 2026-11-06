#!/usr/bin/env python3
"""仅用临时合成音频与 ao=null 验证随包库，不访问 App、曲库、账号或真实音频设备。"""

import argparse
import ctypes
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import time
import wave


def samples(directory):
    wav = directory / "合成 sample.wav"
    with wave.open(str(wav), "wb") as stream:
        stream.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        stream.writeframes(b"".join(struct.pack("<hh", *([int(math.sin(i * math.tau * 440 / 48000) * 1000)] * 2)) for i in range(48000 * 6)))
    rate = 2822400
    count = rate * 6
    block = 4096
    payload = b"\x69" * (((count // 8 + block - 1) // block) * block * 2)
    fmt = b"fmt " + struct.pack("<QIIIIIIQII", 52, 1, 0, 2, 2, rate, 1, count, block, 0)
    dsf = directory / "合成.dsf"
    dsf.write_bytes(b"DSD " + struct.pack("<QQQ", 28, 28 + len(fmt) + 12 + len(payload), 0) + fmt + b"data" + struct.pack("<Q", 12 + len(payload)) + payload)

    def chunk(tag, value):
        return tag + struct.pack(">Q", len(value)) + value + (b"\0" if len(value) % 2 else b"")

    label = b"not compressed"
    properties = b"SND " + chunk(b"FS  ", struct.pack(">I", rate)) + chunk(b"CHNL", struct.pack(">H", 2) + b"SLFTSRGT") + chunk(b"CMPR", b"DSD " + bytes([len(label)]) + label)
    body = b"DSD " + chunk(b"FVER", struct.pack(">I", 0x01050000)) + chunk(b"PROP", properties) + chunk(b"DSD ", b"\x69" * (count // 8 * 2))
    dff = directory / "合成.dff"
    dff.write_bytes(chunk(b"FRM8", body))
    return [wav, dsf, dff]


def exercise(resources):
    names = {"darwin": "libmpv.2.dylib", "linux": "libmpv.so.2", "win32": "libmpv-2.dll"}
    library = (resources / names[sys.platform]).resolve(strict=True)
    if os.name == "nt":
        api = ctypes.CDLL(str(library), winmode=0x900)
    else:
        api = ctypes.CDLL(str(library))
    api.mpv_client_api_version.restype = ctypes.c_ulong
    version = api.mpv_client_api_version()
    if version >> 16 != 2 or (version & 0xFFFF) < 6:
        raise ValueError(f"不兼容的 client API: {version}")
    api.mpv_create.restype = ctypes.c_void_p
    api.mpv_initialize.argtypes = [ctypes.c_void_p]
    api.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
    api.mpv_set_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
    api.mpv_get_property.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
    api.mpv_get_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    api.mpv_get_property_string.restype = ctypes.c_void_p
    api.mpv_free.argtypes = [ctypes.c_void_p]
    api.mpv_command.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
    api.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]
    handle = api.mpv_create()
    if not handle:
        raise RuntimeError("mpv_create 失败")

    def check(code):
        if code < 0:
            raise RuntimeError(f"libmpv 调用失败: {code}")

    def option(key, value):
        result = api.mpv_set_option_string(handle, key.encode(), value.encode())
        if result < 0:
            raise RuntimeError(f"libmpv 选项 {key}={value} 失败: {result}")

    def prop(key, value):
        check(api.mpv_set_property_string(handle, key.encode(), value.encode()))

    def number(key):
        value = ctypes.c_double()
        check(api.mpv_get_property(handle, key.encode(), 5, ctypes.byref(value)))
        return value.value

    def text(key):
        value = api.mpv_get_property_string(handle, key.encode())
        if not value:
            raise RuntimeError(f"缺少属性: {key}")
        try:
            return ctypes.string_at(value).decode("utf-8")
        finally:
            api.mpv_free(value)

    def command(*args):
        values = (ctypes.c_char_p * (len(args) + 1))(*[arg.encode() for arg in args], None)
        check(api.mpv_command(handle, values))

    def until(predicate, label):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                if predicate():
                    return
            except RuntimeError:
                pass
            time.sleep(0.01)
        raise RuntimeError(f"等待 {label} 超时")

    evidence = {"library": str(library), "clientAPI": f"{version >> 16}.{version & 0xffff}", "ao": "null", "audible": False, "samples": []}
    try:
        # null 后端默认模拟 200ms 缓冲，会使暂停 seek 快照暂时偏移；限制为 50ms 以验证精度。
        for key, value in {"config": "no", "load-scripts": "no", "video": "no", "audio-display": "no", "terminal": "no", "ao": "null", "ao-null-buffer": "0.05", "idle": "yes", "keep-open": "yes", "pause": "yes"}.items():
            option(key, value)
        check(api.mpv_initialize(handle))
        evidence["mpvVersion"] = text("mpv-version")
        evidence["ffmpegVersion"] = text("ffmpeg-version")
        evidence["mpvConfiguration"] = text("mpv-configuration")
        with tempfile.TemporaryDirectory(prefix="he-music-mpv-smoke-") as temporary:
            for sample in samples(Path(temporary)):
                prop("pause", "yes")
                command("loadfile", str(sample))
                until(lambda: text("path") == str(sample), "音源切换")
                until(lambda: number("duration") >= 5.5, "载入 " + sample.suffix)
                until(lambda: bool(text("audio-codec-name")), "音频解码器就绪")
                duration = number("duration")
                codec = text("audio-codec-name")
                prop("pause", "no")
                until(lambda: number("time-pos") > 0.3, "播放时钟")
                prop("pause", "yes")
                time.sleep(0.1)
                paused = number("time-pos")
                time.sleep(0.2)
                if abs(number("time-pos") - paused) > 0.08:
                    raise RuntimeError("暂停后播放时钟继续前进")
                command("seek", "3", "absolute+exact")
                until(lambda: abs(number("time-pos") - 3) < 0.15, "seek")
                sought = number("time-pos")
                prop("pause", "no")
                until(lambda: number("time-pos") > sought + 0.25, "seek 后恢复")
                command("stop")
                evidence["samples"].append({"format": sample.suffix, "codec": codec, "duration": duration, "pausedPosition": paused, "seekPosition": sought, "clockAdvanced": True, "pauseStable": True})
    finally:
        api.mpv_terminate_destroy(handle)
        evidence["destroyed"] = True
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = exercise(args.resources)
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
