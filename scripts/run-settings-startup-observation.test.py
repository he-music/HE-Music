"""Pure runner policy regressions: no compiler, native process or window is launched."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "settings_startup_runner", Path(__file__).with_name("run-settings-startup-observation.py")
)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def output_path():
    parent = Path(tempfile.mkdtemp(prefix="hemusic-startup-runner-unit-", dir="/tmp"))
    return parent / "evidence"


def fixed_hash(path):
    if path == RUNNER.PRIVATE_WINDOW:
        return RUNNER.EXPECTED_PRIVATE_WINDOW
    return RUNNER.EXPECTED_CACHE_WINDOW


class SettingsStartupRunnerTests(unittest.TestCase):
    def test_root_is_application_and_environment_keeps_spaces_and_home(self):
        self.assertEqual(RUNNER.ROOT, Path(__file__).resolve().parents[1])
        inherited = {
            "PATH": "/owned/path with spaces:/usr/bin:/bin",
            "HOME": "/synthetic/home with spaces",
            "GOFLAGS": "unsafe-inherited",
            "HE_MUSIC_FILE_PROBE_PRIVATE_STORE_VERIFIED": "1",
        }
        env = RUNNER.build_environment(inherited)
        self.assertEqual(env["PATH"].split(os.pathsep)[1], "/owned/path with spaces")
        self.assertEqual(env["HOME"], inherited["HOME"])
        self.assertEqual(env["GOTOOLCHAIN"], "local")
        self.assertEqual(env["GOWORK"], "off")
        self.assertEqual(env["GOMODCACHE"], "/Users/wangjian/go/pkg/mod")
        self.assertNotIn("GOFLAGS", env)
        self.assertNotIn("HE_MUSIC_FILE_PROBE_PRIVATE_STORE_VERIFIED", env)
        self.assertEqual(inherited["GOFLAGS"], "unsafe-inherited")

    def test_invalid_root_preserves_initial_and_final_failure_before_subprocess(self):
        output = output_path()
        with patch.object(RUNNER, "ROOT", output.parent), patch.object(RUNNER.subprocess, "run") as run:
            self.assertEqual(RUNNER.run_preparation(output), 1)
        run.assert_not_called()
        record = json.loads((output / "preparation.json").read_text())
        self.assertEqual(record["failureCategory"], "root-layout")
        self.assertFalse(record["compileAttempted"])
        self.assertFalse(record["nativeExecuted"])

    def test_wrong_version_fails_before_sdk_copy_or_compile(self):
        output = output_path()
        wrong = subprocess.CompletedProcess(["node", "--version"], 0, "v25.0.0\n", "PRIVATE")
        with patch.object(RUNNER, "frozen_inputs", return_value={"fixed-input": "hash"}), patch.object(
            RUNNER, "sha256", side_effect=fixed_hash
        ), patch.object(RUNNER.subprocess, "run", return_value=wrong) as run, patch.object(
            RUNNER.shutil, "copytree"
        ) as copy:
            self.assertEqual(RUNNER.run_preparation(output), 1)
        copy.assert_not_called()
        self.assertEqual(run.call_args.args[0], ["node", "--version"])
        self.assertIsInstance(run.call_args.kwargs["env"], dict)
        record = json.loads((output / "preparation.json").read_text())
        self.assertEqual(record["failureCategory"], "toolchain-version")
        self.assertFalse(record["compileAttempted"])
        self.assertNotIn("PRIVATE", json.dumps(record))
        self.assertTrue((output / "versions.json").is_file())

    def test_timeout_and_unknown_failure_are_retained_without_error_content(self):
        for exception, category in (
            (subprocess.TimeoutExpired(["node"], 15, output="PRIVATE"), "subprocess-timeout"),
            (RuntimeError("PRIVATE https://private.invalid/token"), "unknown"),
        ):
            with self.subTest(category=category):
                output = output_path()
                with patch.object(RUNNER, "frozen_inputs", return_value={"fixed-input": "hash"}), patch.object(
                    RUNNER, "sha256", side_effect=fixed_hash
                ), patch.object(RUNNER.subprocess, "run", side_effect=exception):
                    self.assertEqual(RUNNER.run_preparation(output), 1)
                text = (output / "preparation.json").read_text()
                record = json.loads(text)
                self.assertEqual(record["failureCategory"], category)
                self.assertFalse(record["compileAttempted"])
                self.assertNotIn("PRIVATE", text)
                self.assertTrue((output / "artifacts.json").is_file())


if __name__ == "__main__":
    unittest.main()
