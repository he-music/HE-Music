#!/usr/bin/env python3
"""检查最终 Linux 包目录的 ELF 符号需求；不据此宣称完整桌面兼容性。"""

import argparse
import json
from pathlib import Path
import re

import prepare


def audit(root, targets, config):
    declared = " ".join(config["linux"]["depends"])
    match = re.search(r"libc6\s*\(>=\s*(\d+\.\d+)\)", declared)
    if not match:
        raise ValueError("linux.depends 必须明确声明 libc6 最低版本")
    baseline = tuple(map(int, match[1].split(".")))
    records = {}
    for target in targets:
        directory = root / target.replace("/", "-")
        prepare.verify(directory / "mpv", target)
        found_host = False
        for file in directory.rglob("*"):
            if not file.is_file():
                continue
            with file.open("rb") as stream:
                if stream.read(4) != b"\x7fELF":
                    continue
            if prepare.binary_arches(file) != {target.split("/")[1]}:
                raise ValueError(f"最终 ELF 架构不符: {file}")
            text = prepare.run(["readelf", "--version-info", file], capture=True)
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
    parser.add_argument("--root", type=Path, default=prepare.ROOT / "build/mygo")
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((prepare.ROOT / "mygo.json").read_text())
    report = audit(args.root, args.target.split(","), config)
    prepare.atomic_json(args.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
