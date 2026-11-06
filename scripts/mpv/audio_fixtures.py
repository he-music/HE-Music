#!/usr/bin/env python3
"""为 HE-Music 网关集成测试生成临时 WAV、DSF 和原始 DFF 样本。"""
import math
import struct
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
