"""Frozen-input regressions with owned fixtures and a mocked compiler only."""
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "settings_startup_freeze_runner",
    Path(__file__).with_name("run-settings-startup-observation.py"),
)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def owned_directory():
    base = os.environ.get("HE_MUSIC_STARTUP_UNIT_OUTPUT")
    if base:
        Path(base).mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="freeze-fixture-", dir=base or "/tmp"))


class SettingsStartupFreezeTests(unittest.TestCase):
    def test_frozen_manifest_contains_root_go_and_actual_tray_embeds(self):
        root = owned_directory()
        fixtures = {
            "go.mod": b"module github.com/he-music/HE-Music\n",
            "go.sum": b"owned-sum",
            "package.json": b"{}",
            "pnpm-lock.yaml": b"owned-lock",
            "assets.go": b'package desktopassets\nimport _ "embed"\n//go:embed public/icons/tray/trayTemplate.png\nvar TrayTemplate []byte\n',
            "additional_root.go": b"package desktopassets\n",
            "public/icons/tray/trayTemplate.png": b"synthetic-tray-template",
            "public/icons/tray/tray.png": b"synthetic-tray-color",
            "desktop/nativeprobe_settings_startup.go": b"owned-harness-fixture",
        }
        for name, content in fixtures.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        with patch.object(RUNNER, "ROOT", root), patch.object(RUNNER, "CACHE_MYGO", root / "absent-cache"):
            manifest = RUNNER.frozen_inputs()
        for name in ("assets.go", "additional_root.go", "public/icons/tray/trayTemplate.png", "public/icons/tray/tray.png"):
            with self.subTest(input=name):
                self.assertIn(str(root / name), manifest)
                self.assertEqual(manifest[str(root / name)], hashlib.sha256(fixtures[name]).hexdigest())

    def test_compile_freeze_rejects_added_deleted_modified_paths(self):
        for change in ("added", "deleted", "modified", "unchanged"):
            with self.subTest(change=change):
                output = owned_directory() / "preparation"
                before = {"owned/existing.go": "before-hash"}
                after = dict(before)
                if change == "added":
                    after["owned/new.go"] = "new-hash"
                elif change == "deleted":
                    after.pop("owned/existing.go")
                elif change == "modified":
                    after["owned/existing.go"] = "after-hash"

                def digest(path):
                    if path == RUNNER.PRIVATE_WINDOW:
                        return RUNNER.EXPECTED_PRIVATE_WINDOW
                    return RUNNER.EXPECTED_CACHE_WINDOW

                def sdk_copy(_source, target):
                    (target / "internal/darwin").mkdir(parents=True)
                    (target / "go.mod").write_text("owned-sdk-module-fixture")
                    (target / "internal/darwin/window.go").write_text("owned-sdk-window-fixture")

                def process(command, **_kwargs):
                    if command == ["node", "--version"]:
                        return subprocess.CompletedProcess(command, 0, "v24.22.1\n", "")
                    if command == ["pnpm", "--version"]:
                        return subprocess.CompletedProcess(command, 0, "10.28.1\n", "")
                    if command == [str(RUNNER.GO), "version"]:
                        return subprocess.CompletedProcess(command, 0, "go version go1.27.3 darwin/arm64\n", "")
                    self.assertEqual(command[:4], [str(RUNNER.GO), "test", "-c", "./desktop"])
                    Path(command[command.index("-o") + 1]).write_bytes(b"owned-mocked-test-binary-never-executed")
                    return subprocess.CompletedProcess(command, 0)

                with patch.object(RUNNER, "frozen_inputs", side_effect=[before, after]), patch.object(
                    RUNNER, "sha256", side_effect=digest
                ), patch.object(RUNNER.shutil, "copytree", side_effect=sdk_copy), patch.object(
                    RUNNER.subprocess, "run", side_effect=process
                ) as run:
                    code = RUNNER.run_preparation(output)
                record = json.loads((output / "preparation.json").read_text())
                self.assertEqual(run.call_count, 4)
                self.assertTrue(record["compileAttempted"])
                self.assertEqual(record["compileExitCode"], 0)
                self.assertFalse(record["nativeExecuted"])
                if change == "unchanged":
                    self.assertEqual(code, 0)
                    self.assertTrue(record["frozenInputsUnchanged"])
                    self.assertEqual(record["changedInputCount"], 0)
                else:
                    self.assertNotEqual(code, 0)
                    self.assertFalse(record["frozenInputsUnchanged"])
                    self.assertEqual(record["failureCategory"], "frozen-input-changed")
                    self.assertEqual(record["changedInputCount"], 1)


if __name__ == "__main__":
    unittest.main()
