#!/usr/bin/env python3
"""Freeze inputs and compile the private startup probe; never launch native/Vite."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GO = Path("/Users/wangjian/.govm/go/bin/go")
CACHE_MYGO = Path("/Users/wangjian/go/pkg/mod/github.com/egoist/mygo@v0.6.5-0.20261026063203-07ebe19ac0dc")
OVERLAY_DIR = Path("/tmp/hemusic-settings-wk-private-overlay.MG1VLs")
PRIVATE_WINDOW = OVERLAY_DIR / "window.go"
EXPECTED_CACHE_WINDOW = "6666046407c4b925b1044b6fa81ff0e2cc57f1f8dcec9802f7fada6221450c07"
EXPECTED_PRIVATE_WINDOW = "c2c8bff99a52deabcdd919692e5a4a912aca5f7f126358d21b8e13ffe37f9928"


class PreparationFailure(Exception):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def build_environment(inherited: dict[str, str]) -> dict[str, str]:
    env = inherited.copy()
    for key in ("HE_MUSIC_FILE_PROBE_PRIVATE_STORE_VERIFIED", "GOFLAGS"):
        env.pop(key, None)
    # A dictionary environment and argv arrays preserve spaces in PATH entries.
    env["PATH"] = os.pathsep.join([str(GO.parent), env.get("PATH", "/usr/bin:/bin")])
    env.update(GOMODCACHE="/Users/wangjian/go/pkg/mod", GOTOOLCHAIN="local", GOWORK="off", GOPROXY="off", GOSUMDB="off")
    return env


def frozen_inputs() -> dict[str, str]:
    # Freeze this listed application/probe/fixed-SDK set, not arbitrary OS files,
    # other module-cache entries, or resources outside the listed paths.
    paths = [ROOT / name for name in ("go.mod", "go.sum", "package.json", "pnpm-lock.yaml")]
    paths += [Path(__file__).resolve(), PRIVATE_WINDOW, OVERLAY_DIR / "overlay.json"]
    paths += [ROOT / "build/mygo/darwin-arm64/HE-Music.app/Contents/MacOS/HE-Music"]
    paths += list(ROOT.glob("*.go"))
    paths += [ROOT / "public/icons/tray" / name for name in ("trayTemplate.png", "tray.png")]
    for directory in (ROOT / "desktop", ROOT / "src/nativeprobe", ROOT / "src/platform", ROOT / "bindings", CACHE_MYGO):
        if directory.exists():
            paths += [path for path in directory.rglob("*") if path.is_file()]
    return {str(path): sha256(path) for path in sorted(set(paths)) if path.is_file()}


def run_preparation(output: Path) -> int:
    output.mkdir(parents=True, exist_ok=False)
    record: dict[str, object] = {
        "output": str(output), "nativeExecuted": False, "viteExecuted": False,
        "compileAttempted": False, "compileExitCode": None, "exitCode": 1,
        "stage": "created", "failureCategory": None,
        "dependencyIdentity": "temporary-local-SDK-replace-with-private-WK-overlay",
    }
    write_json(output / "preparation.json", record)
    before: dict[str, str] = {}
    exit_code = 1
    stage = "root-validation"
    try:
        if not (ROOT / "go.mod").is_file() or not (ROOT / "desktop/nativeprobe_settings_startup.go").is_file():
            raise PreparationFailure("root-layout")
        if not (ROOT / "go.mod").read_text().startswith("module github.com/he-music/HE-Music\n"):
            raise PreparationFailure("module-identity")
        stage = "input-manifest"
        before = frozen_inputs()
        write_json(output / "inputs-before.json", before)
        if sha256(CACHE_MYGO / "internal/darwin/window.go") != EXPECTED_CACHE_WINDOW:
            raise PreparationFailure("cache-window-hash")
        if sha256(PRIVATE_WINDOW) != EXPECTED_PRIVATE_WINDOW:
            raise PreparationFailure("private-window-hash")
        stage = "toolchain"
        env = build_environment(dict(os.environ))
        versions = {}
        for name, command, expected in (
            ("node", ["node", "--version"], "v24.22.1"),
            ("pnpm", ["pnpm", "--version"], "10.28.1"),
            ("go", [str(GO), "version"], "go version go1.27.3 darwin/arm64"),
        ):
            completed = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=15, check=False)
            matches = completed.returncode == 0 and completed.stdout.strip() == expected
            versions[name] = {"matched": matches, "exitCode": completed.returncode, "expected": expected}
            write_json(output / "versions.json", versions)
            if not matches:
                raise PreparationFailure("toolchain-version")
        stage = "temporary-sdk"
        sdk = output / "mygo"
        # No edits to the SDK copy: only the outside-cache overlay changes window.go.
        shutil.copytree(CACHE_MYGO, sdk)
        if sha256(sdk / "go.mod") != sha256(CACHE_MYGO / "go.mod"):
            raise PreparationFailure("sdk-module-hash")
        if sha256(sdk / "internal/darwin/window.go") != EXPECTED_CACHE_WINDOW:
            raise PreparationFailure("sdk-window-hash")
        compile_mod = output / "compile.mod"
        compile_sum = output / "compile.sum"
        compile_mod.write_text((ROOT / "go.mod").read_text() + f"\nreplace github.com/egoist/mygo => {sdk}\n")
        shutil.copyfile(ROOT / "go.sum", compile_sum)
        overlay = output / "overlay-local.json"
        write_json(overlay, {"Replace": {str(sdk / "internal/darwin/window.go"): str(PRIVATE_WINDOW)}})
        command = [str(GO), "test", "-c", "./desktop", "-tags", "nativeprobe,fileprobe",
                   "-mod=mod", f"-modfile={compile_mod}", "-overlay", str(overlay),
                   "-o", str(output / "settings-startup-probe")]
        record.update(sdk=str(sdk), sdkSource=str(CACHE_MYGO), command=command,
                      compileMod=str(compile_mod), compileSum=str(compile_sum), overlay=str(overlay))
        write_json(output / "build-inputs.json", {
            "sdkSource": str(CACHE_MYGO), "sdkFiles": {str(path.relative_to(sdk)): sha256(path) for path in sorted(sdk.rglob("*")) if path.is_file()},
            "files": {str(path): sha256(path) for path in (compile_mod, compile_sum, overlay, PRIVATE_WINDOW)},
        })
        stage = "compile"
        record.update(stage=stage, compileAttempted=True)
        write_json(output / "preparation.json", record)
        # Compile from the application graph, never SDK-root vendor/examples.
        with (output / "compile.stdout.log").open("wb") as stdout, (output / "compile.stderr.log").open("wb") as stderr:
            completed = subprocess.run(command, cwd=ROOT, env=env, stdout=stdout, stderr=stderr, timeout=180, check=False)
        record["compileExitCode"] = completed.returncode
        if completed.returncode != 0:
            raise PreparationFailure("compile-failed")
        binary = output / "settings-startup-probe"
        if not binary.is_file():
            raise PreparationFailure("binary-missing")
        record["binarySHA256"] = sha256(binary)
        exit_code = 0
    except PreparationFailure as error:
        # Only explicit local guard enumerations can be retained.
        record["failureCategory"] = error.args[0]
    except subprocess.TimeoutExpired:
        record["failureCategory"] = "subprocess-timeout"
    except (Exception, KeyboardInterrupt):
        # Unknown exception messages/paths/content are never persisted.
        record["failureCategory"] = "unknown"
    finally:
        try:
            after = frozen_inputs() if before else {}
            write_json(output / "inputs-after.json", after)
            changed = [path for path in sorted(before.keys() | after.keys()) if before.get(path) != after.get(path)]
            record["frozenInputsUnchanged"] = bool(before) and not changed
            record["changedInputCount"] = len(changed)
            if before and changed:
                exit_code = 1
                record["failureCategory"] = "frozen-input-changed"
            artifacts = {str(path.relative_to(output)): sha256(path) for path in sorted(output.rglob("*")) if path.is_file() and path.name != "preparation.json"}
            write_json(output / "artifacts.json", artifacts)
        except (Exception, KeyboardInterrupt):
            exit_code = 1
            record["failureCategory"] = "evidence-finalization-failed"
        record.update(stage=stage, exitCode=exit_code)
        write_json(output / "preparation.json", record)
    return exit_code


def main() -> int:
    # Create evidence before root/version/copy/compile operations can fail.
    parent = Path(tempfile.mkdtemp(prefix="hemusic-settings-startup-repair-", dir="/tmp"))
    output = parent / "preparation"
    code = run_preparation(output)
    print(json.dumps({"output": str(output), "exitCode": code, "nativeExecuted": False, "viteExecuted": False}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
