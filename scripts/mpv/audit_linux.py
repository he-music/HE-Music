#!/usr/bin/env python3
"""检查最终 Linux 宿主和下载运行库的 ELF 符号需求，不执行待检程序。"""

import argparse
import json
from pathlib import Path
import re
import subprocess

import download


def audit(root, targets, config):
    declared = " ".join(config["linux"]["depends"])
    match = re.search(r"libc6\s*\(>=\s*(\d+\.\d+)\)", declared)
    if not match:
        raise ValueError("linux.depends 必须明确声明 libc6 最低版本")
    if not targets or any(target not in ("linux/amd64", "linux/arm64") for target in targets):
        raise ValueError("最终 ELF 审计只接受 Linux amd64/arm64")
    baseline = tuple(map(int, match[1].split(".")))
    lock = download.load_lock()
    records = {}
    for target in targets:
        directory = root / target.replace("/", "-")
        download.verify_staging(directory / "mpv", lock, target)
        found_host = False
        for file in directory.rglob("*"):
            if not file.is_file():
                continue
            with file.open("rb") as stream:
                if stream.read(4) != b"\x7fELF":
                    continue
            if download.binary_arches(file, "linux") != {target.split("/")[1]}:
                raise ValueError(f"最终 ELF 架构不符: {file}")
            text = subprocess.check_output(["readelf", "--version-info", file], text=True)
            versions = sorted(set(re.findall(r"(?:GLIBC|GLIBCXX|CXXABI)_[0-9.]+", text)))
            required = [tuple(map(int, value.split("_")[1].split("."))) for value in versions if value.startswith("GLIBC_")]
            if required and max(required) > baseline:
                raise ValueError(f"{file} 要求 GLIBC_{'.'.join(map(str, max(required)))}，高于包声明 {match[1]}；需按真实最高需求修正包依赖")
            records[file.relative_to(root).as_posix()] = versions
            if file.name == config["slug"]:
                found_host = True
        if not found_host:
            raise ValueError(f"缺少已构建的 Linux 宿主程序: {target}")
    return {"libmpvBuildBaseline": "Ubuntu 22.04 / glibc 2.35", "declaredGlibcMinimum": match[1],
            "runtimeRequirements": ["GTK 3", "WebKitGTK 4.1（mygo Debian 包声明）", "libpulse0", "libstdc++6"],
            "elfSymbolVersions": records, "desktopCompatibilityVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=download.ROOT / "build/mygo")
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((download.ROOT / "mygo.json").read_text())
    report = audit(args.root, args.target.split(","), config)
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output, encoding="utf-8")
    print(output, end="")


if __name__ == "__main__":
    main()
