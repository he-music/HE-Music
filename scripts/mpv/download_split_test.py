#!/usr/bin/env python3
"""精简运行资源的安装、许可分离和事务回滚回归。"""
import copy
import io
import json
from pathlib import Path
import shutil
import tarfile
import unittest
from unittest import mock

import download_test as legacy


download = legacy.download


class SplitDownloadTests(unittest.TestCase):
    tar = legacy.DownloadTests.tar
    seed = legacy.DownloadTests.seed
    run_process = legacy.DownloadTests.run_process
    http = legacy.DownloadTests.http
    snapshot = legacy.DownloadTests.snapshot
    no_preparation = legacy.DownloadTests.no_preparation

    def setUp(self):
        legacy.DownloadTests.setUp(self)
        self.lock["schemaVersion"] = 2
        self.lock["bundleVersion"] = "v0.42.0-2"
        asset = "libmpv-materials-v0.42.0-2.tar.gz"
        self.lock["materials"] = dict(asset=asset, root="materials", size=100,
            sha256="b" * 64, manifestSHA256="c" * 64,
            url=f"https://github.com/he-music/mpv-bundles/releases/download/v0.42.0-2/{asset}")
        for target, data in list(self.packages.items()):
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                files = {m.name.removeprefix("mpv/"): archive.extractfile(m).read()
                         for m in archive if m.isfile()}
            files["licenses/SOURCE-MATERIALS.json"] = json.dumps(self.lock["materials"]).encode()
            manifest = json.loads(files.pop("manifest.json"))
            manifest["files"] = {name: dict(sha256=legacy.sha(value), size=len(value))
                                 for name, value in files.items()}
            manifest["details"]["packageKind"] = "runtime"
            files["manifest.json"] = json.dumps(manifest).encode()
            package = self.tar(files)
            entry = self.lock["targets"][target]
            entry.update(size=len(package), sha256=legacy.sha(package),
                         manifestSHA256=legacy.sha(files["manifest.json"]))
            entry["url"] = f"https://github.com/he-music/mpv-bundles/releases/download/v0.42.0-2/{entry['asset']}"
            entry["runtimeFiles"] = {name: record for name, record in manifest["files"].items()
                                     if not name.startswith("licenses/")}
            entry["licenseFiles"] = {name: record for name, record in manifest["files"].items()
                                     if name.startswith("licenses/")}
            self.packages[target] = package

    def installed(self, requested="linux/amd64"):
        return self.resources / requested.replace("/", "-") / "mpv"

    def assert_installed(self, requested):
        target = "darwin/universal" if requested.startswith("darwin/") else requested
        entry = self.lock["targets"][target]
        staging = self.installed(requested)
        self.assertEqual({p.name for p in staging.iterdir()}, set(entry["runtimeFiles"]))
        self.assertTrue(all(p.is_file() for p in staging.iterdir()))
        self.assertFalse((staging / "manifest.json").exists())
        licenses = download.license_directory(staging)
        self.assertEqual({p.relative_to(licenses).as_posix() for p in licenses.rglob("*") if p.is_file()},
                         {name.removeprefix("licenses/") for name in entry["licenseFiles"]})
        download.verify_staging(staging, self.lock, target)

    def test_all_targets_install_only_libraries_and_separate_licenses(self):
        for target in sorted(download.TARGETS):
            self.seed(target)
            self.run_process(target, offline=True)
            self.assert_installed(target)
        path = self.root / "lock.json"
        path.write_text(json.dumps(self.lock))
        self.assertEqual(download.load_lock(path), self.lock)

    def test_download_never_fetches_materials(self):
        with self.http(self.packages["linux/amd64"]) as build:
            self.run_process()
        request = build.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, self.lock["targets"]["linux/amd64"]["url"])
        self.assertNotEqual(request.full_url, self.lock["materials"]["url"])
        self.assert_installed("linux/amd64")

    def test_check_and_reuse_without_archive_cache_are_read_only(self):
        self.seed()
        self.run_process(offline=True)
        shutil.rmtree(self.cache)
        before = self.snapshot()
        with self.no_preparation(), mock.patch.object(download, "copy_split_staging", side_effect=AssertionError("copy")):
            self.run_process(check=True, offline=True)
            self.run_process(offline=True)
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.cache.exists())

    def test_runtime_and_license_tampering_fail_without_cache(self):
        self.seed()
        self.run_process(offline=True)
        shutil.rmtree(self.cache)
        for path in (self.installed() / "libmpv.so.2",
                     download.license_directory(self.installed()) / "LICENSE"):
            with self.subTest(path=path):
                original = path.read_bytes()
                path.write_bytes(b"tampered")
                before = self.snapshot()
                with self.no_preparation(), self.assertRaisesRegex(ValueError, "SHA256"):
                    self.run_process(check=True, offline=True)
                self.assertEqual(before, self.snapshot())
                path.write_bytes(original)

    def test_extra_manifest_or_source_directory_is_rejected(self):
        self.seed()
        self.run_process(offline=True)
        extra = self.installed() / "manifest.json"
        extra.write_text("{}")
        with self.assertRaises(ValueError):
            self.run_process(check=True)
        extra.unlink()
        extra = self.installed() / "sources"
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, "多余目录"):
            self.run_process(check=True)

    def test_archive_inventory_must_match_trusted_payload_records(self):
        self.seed()
        self.lock["targets"]["linux/amd64"]["runtimeFiles"]["libmpv.so.2"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "锁定运行"):
            self.run_process(offline=True)
        self.assertFalse(self.installed().exists())

    def test_schema2_rejects_non_binary_runtime_and_license_escape(self):
        path = self.root / "lock.json"
        mutations = [
            lambda e: e["runtimeFiles"].update({"manifest.json": dict(sha256="a" * 64, size=2)}),
            lambda e: e["runtimeFiles"].update({"sub/libmpv.so.2": dict(sha256="a" * 64, size=64)}),
            lambda e: e["licenseFiles"].update({"licenses/../outside": dict(sha256="a" * 64, size=2)}),
            lambda e: e["licenseFiles"].update({"outside/LICENSE": dict(sha256="a" * 64, size=2)}),
        ]
        for mutate in mutations:
            bad = copy.deepcopy(self.lock)
            mutate(bad["targets"]["linux/amd64"])
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                download.load_lock(path)

    def test_materials_must_be_same_version_and_pinned(self):
        path = self.root / "lock.json"
        for key, value in (("url", "https://github.com/he-music/mpv-bundles/releases/download/latest/source.tar.gz"),
                           ("sha256", ""), ("manifestSHA256", "x"), ("asset", 12)):
            bad = copy.deepcopy(self.lock)
            bad["materials"][key] = value
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                download.load_lock(path)

    def test_failed_library_rename_rolls_back_licenses(self):
        self.seed()
        self.run_process(offline=True)
        before = self.snapshot()
        original = Path.rename
        staging = self.installed()
        def rename(path, destination):
            if Path(destination) == staging and path.name == "mpv":
                raise OSError("injected library install failure")
            return original(path, destination)
        with mock.patch.object(Path, "rename", rename), self.assertRaisesRegex(OSError, "injected"):
            self.run_process(force=True, offline=True)
        after = self.snapshot()
        self.assertEqual(set(before), set(after))
        for name, value in before.items():
            self.assertEqual(value[0], after[name][0], name)
            if value[2] is not None:
                self.assertEqual(value, after[name], name)
        self.assert_installed("linux/amd64")

    def test_force_migrates_old_full_resource_directory(self):
        self.seed()
        staging = self.installed()
        staging.mkdir(parents=True)
        (staging / "manifest.json").write_text("{}")
        (staging / "sources").mkdir()
        (staging / "sources/old.tar.gz").write_bytes(b"historical source")
        unrelated = staging.parent / "keep.txt"
        unrelated.write_text("keep")
        self.run_process(force=True, offline=True)
        self.assert_installed("linux/amd64")
        self.assertEqual(unrelated.read_text(), "keep")

    def test_universal_removes_verified_native_payloads_and_preserves_other_resources(self):
        self.seed("darwin/universal")
        for requested in ("darwin/amd64", "darwin/arm64"):
            self.run_process(requested, offline=True)
            self.assert_installed(requested)
            (self.installed(requested).parent / "keep.txt").write_text("keep")
        self.run_process("darwin/universal", offline=True)
        self.assert_installed("darwin/universal")
        for requested in ("darwin/amd64", "darwin/arm64"):
            self.assertFalse(self.installed(requested).exists())
            self.assertFalse(download.license_directory(self.installed(requested)).exists())
            self.assertEqual((self.installed(requested).parent / "keep.txt").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
