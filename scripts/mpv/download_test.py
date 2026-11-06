#!/usr/bin/env python3
"""下载器安全与离线行为测试：合成归档、临时目录及 HTTP mock。"""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import stat
import struct
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

spec = importlib.util.spec_from_file_location("mpv_download", Path(__file__).with_name("download.py"))
download = importlib.util.module_from_spec(spec)
spec.loader.exec_module(download)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def elf(arch="amd64"):
    value = bytearray(64)
    value[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", value, 18, 62 if arch == "amd64" else 183)
    return bytes(value)


def pe(arch="amd64"):
    value = bytearray(128)
    value[:2] = b"MZ"
    struct.pack_into("<I", value, 60, 64)
    value[64:68] = b"PE\0\0"
    struct.pack_into("<H", value, 68, 0x8664 if arch == "amd64" else 0xAA64)
    struct.pack_into("<H", value, 88, 0x20B)
    return bytes(value)


def universal():
    value = bytearray(112)
    value[:8] = struct.pack(">II", 0xCAFEBABE, 2)
    for index, cpu in enumerate((0x1000007, 0x100000C)):
        offset = 48 + index * 32
        struct.pack_into(">IIIII", value, 8 + 20 * index, cpu, 0, offset, 32, 0)
        value[offset:offset + 8] = struct.pack("<II", 0xFEEDFACF, cpu)
    return bytes(value)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.cache = self.root / "cache"
        self.resources = self.root / "resources"
        self.lock = dict(schemaVersion=1, repository="he-music/mpv-bundles", bundleVersion="v0.42.0-1",
                         mpvVersion="0.42.0", ffmpegVersion="8.0.1", clientAPI="2.6", recipeSHA256="a" * 64,
                         targets={})
        self.packages = {}
        for target in download.TARGETS:
            system, arch = target.split("/")
            library = {"linux": "libmpv.so.2", "windows": "libmpv-2.dll", "darwin": "libmpv.2.dylib"}[system]
            binary = universal() if system == "darwin" else pe(arch) if system == "windows" else elf(arch)
            files = {library: binary, "licenses/LICENSE": b"license"}
            if system == "windows":
                files["runtime.dll"] = pe(arch)
            manifest = {key: self.lock[key] for key in ("schemaVersion", "mpvVersion", "ffmpegVersion", "clientAPI", "recipeSHA256")}
            manifest.update(target=target, dependencies={}, details={}, files={name: {"sha256": sha(data), "size": len(data)} for name, data in files.items()})
            files["manifest.json"] = json.dumps(manifest).encode()
            package = self.tar(files)
            asset = "libmpv-" + target.replace("/", "-") + ".tar.gz"
            self.lock["targets"][target] = dict(asset=asset, sha256=sha(package), size=len(package), root="mpv", library=library,
                manifestSHA256=sha(files["manifest.json"]),
                url=f"https://github.com/he-music/mpv-bundles/releases/download/v0.42.0-1/{asset}", correspondingSourceStatus="published")
            self.packages[target] = package

    def tar(self, files):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name if name.startswith("/") else "mpv/" + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return output.getvalue()

    def seed(self, target="linux/amd64", data=None):
        entry = self.lock["targets"][target]
        path = self.cache / self.lock["bundleVersion"] / entry["asset"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.packages[target] if data is None else data)
        return path

    def run_process(self, target="linux/amd64", **kwargs):
        return download.process(self.lock, target, self.cache, self.resources, **kwargs)

    def http(self, data, url="https://release-assets.githubusercontent.com/asset"):
        response = io.BytesIO(data)
        response.url = url
        opener = mock.Mock()
        opener.open.return_value = response
        return mock.patch.object(download.urllib.request, "build_opener", return_value=opener)

    def snapshot(self):
        return {path.relative_to(self.root).as_posix():
                (path.stat().st_ino, path.stat().st_mtime_ns,
                 path.read_bytes() if path.is_file() else None)
                for path in self.root.rglob("*")}

    @contextlib.contextmanager
    def no_preparation(self):
        with contextlib.ExitStack() as stack:
            for owner, name in ((download.urllib.request, "build_opener"), (download, "download"),
                                (download, "extract"), (shutil, "copytree"), (Path, "rename"),
                                (Path, "mkdir"), (tempfile, "TemporaryDirectory")):
                stack.enter_context(mock.patch.object(owner, name, side_effect=AssertionError(name)))
            yield

    def test_lock_and_url_pinning(self):
        path = self.root / "lock.json"
        path.write_text(json.dumps(self.lock))
        self.assertEqual(download.load_lock(path), self.lock)
        for url in ("http://github.com/asset", "https://evil.invalid/asset", self.lock["targets"]["linux/amd64"]["url"] + "?x=1"):
            bad = copy.deepcopy(self.lock)
            bad["targets"]["linux/amd64"]["url"] = url
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                download.load_lock(path)
        for version in ("latest", "../v1", "v1?x=1"):
            bad = copy.deepcopy(self.lock)
            bad["bundleVersion"] = version
            path.write_text(json.dumps(bad))
            with self.assertRaises(ValueError):
                download.load_lock(path)

    def test_lock_requires_manifest_sha256_for_every_target(self):
        path = self.root / "lock.json"
        for target in download.TARGETS:
            for value in (None, "", "a" * 63, "g" * 64, 123):
                with self.subTest(target=target, value=value):
                    bad = copy.deepcopy(self.lock)
                    if value is None:
                        del bad["targets"][target]["manifestSHA256"]
                    else:
                        bad["targets"][target]["manifestSHA256"] = value
                    path.write_text(json.dumps(bad))
                    with self.assertRaisesRegex(ValueError, "manifestSHA256"):
                        download.load_lock(path)

    def test_check_without_cache_is_read_only_and_offline(self):
        self.seed()
        self.run_process(offline=True)
        shutil.rmtree(self.cache)
        before = self.snapshot()
        with self.no_preparation():
            self.run_process(check=True)
            self.run_process(check=True, offline=True)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.cache.exists())

    def test_prepare_reuses_staging_without_any_preparation(self):
        self.seed()
        self.run_process(offline=True)
        for cached in (True, False):
            if not cached:
                shutil.rmtree(self.cache)
            before = self.snapshot()
            with self.no_preparation():
                self.run_process()
                self.run_process(offline=True)
            self.assertEqual(self.snapshot(), before)
        self.assertFalse(self.cache.exists())

    def test_check_and_reuse_still_reject_existing_bad_cache(self):
        cached = self.seed()
        self.run_process(offline=True)
        cached.write_bytes(b"bad")
        before = self.snapshot()
        with self.no_preparation():
            for kwargs in ({"check": True}, {}, {"offline": True}):
                with self.assertRaisesRegex(ValueError, "SHA256"):
                    self.run_process(**kwargs)
        self.assertEqual(self.snapshot(), before)

    def test_staging_manifest_raw_bytes_are_pinned_without_cache(self):
        self.seed()
        self.run_process(offline=True)
        shutil.rmtree(self.cache)
        manifest = self.resources / "linux-amd64/mpv/manifest.json"
        manifest.write_bytes(manifest.read_bytes() + b"\n")
        before = self.snapshot()
        with self.no_preparation():
            for kwargs in ({"check": True}, {}, {"offline": True}):
                with self.assertRaisesRegex(ValueError, "manifestSHA256"):
                    self.run_process(**kwargs)
        self.assertEqual(self.snapshot(), before)

    def test_download_hash_failure_preserves_existing_cache_and_staging(self):
        cached = self.seed()
        self.run_process(offline=True)
        original = cached.read_bytes()
        library = self.resources / "linux-amd64/mpv/libmpv.so.2"
        before = library.read_bytes()
        broken = bytearray(original)
        broken[-1] ^= 1
        with self.http(bytes(broken)), self.assertRaisesRegex(ValueError, "SHA256"):
            self.run_process(force=True)
        self.assertEqual(cached.read_bytes(), original)
        self.assertEqual(library.read_bytes(), before)

    def test_http_size_and_https(self):
        entry = self.lock["targets"]["linux/amd64"]
        for data, url in ((b"x" * (entry["size"] + 1), "https://example.com"), (b"", "http://example.com")):
            with self.http(data, url), self.assertRaises(ValueError):
                download.download(entry, self.root / "candidate")
            (self.root / "candidate").unlink(missing_ok=True)
        request = download.urllib.request.Request(entry["url"])
        with self.assertRaises(ValueError):
            download.HTTPSRedirect().redirect_request(request, None, 302, "Found", {}, "http://evil.invalid")

    def test_offline_reuse_check_and_staging_tamper(self):
        self.seed()
        with mock.patch.object(download.urllib.request, "build_opener", side_effect=AssertionError("network")):
            self.run_process(offline=True)
            snapshot = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
            self.run_process(check=True)
            self.assertEqual(snapshot, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
            library = self.resources / "linux-amd64/mpv/libmpv.so.2"
            library.write_bytes(b"tampered")
            for kwargs in ({"check": True}, {"offline": True}):
                with self.assertRaises(ValueError):
                    self.run_process(**kwargs)
            manifest_path = library.parent / "manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["files"]["libmpv.so.2"] = {"size": 8, "sha256": sha(b"tampered")}
            manifest_path.write_text(json.dumps(manifest))
            shutil.rmtree(self.cache)
            with self.no_preparation():
                for kwargs in ({"check": True}, {}, {"offline": True}):
                    with self.assertRaisesRegex(ValueError, "manifestSHA256"):
                        self.run_process(**kwargs)

    def test_offline_missing_and_corrupt_cache_do_not_network(self):
        with mock.patch.object(download.urllib.request, "build_opener", side_effect=AssertionError("network")):
            with self.assertRaises(ValueError):
                self.run_process(offline=True)
            cached = self.seed(data=b"bad")
            with self.assertRaises(ValueError):
                self.run_process()
            with self.assertRaises(ValueError):
                self.run_process(force=True, offline=True)
            self.assertEqual(cached.read_bytes(), b"bad")

    def test_fetch_only_and_force_repair(self):
        cached = self.seed(data=b"bad")
        with self.http(self.packages["linux/amd64"]):
            self.run_process(force=True, fetch_only=True)
        self.assertEqual(cached.read_bytes(), self.packages["linux/amd64"])
        self.assertFalse(self.resources.exists())

    def test_fetch_only_does_not_reuse_staging_instead_of_archive(self):
        self.seed()
        self.run_process(offline=True)
        shutil.rmtree(self.cache)
        staging = self.resources / "linux-amd64/mpv"
        before = {path: (path.stat().st_ino, path.stat().st_mtime_ns) for path in staging.rglob("*")}
        with self.assertRaisesRegex(ValueError, "离线缓存缺失"):
            self.run_process(offline=True, fetch_only=True)
        with self.http(self.packages["linux/amd64"]) as opener:
            self.run_process(fetch_only=True)
        opener.return_value.open.assert_called_once()
        self.assertEqual(before, {path: (path.stat().st_ino, path.stat().st_mtime_ns) for path in staging.rglob("*")})

    def test_force_offline_reinstalls_and_requires_cache(self):
        cached = self.seed()
        self.run_process(offline=True)
        library = self.resources / "linux-amd64/mpv/libmpv.so.2"
        library.write_bytes(b"tampered")
        with mock.patch.object(download, "extract", wraps=download.extract) as extract:
            self.run_process(force=True, offline=True)
        extract.assert_called_once()
        self.assertEqual(library.read_bytes(), elf())
        cached.unlink()
        with self.assertRaisesRegex(ValueError, "离线缓存缺失"):
            self.run_process(force=True, offline=True)

    def test_unsafe_archive_paths_and_duplicate_case(self):
        for names in (("../outside",), ("/absolute",), ("x\\y",), ("C:x",), ("A", "a"), ("a/./b", "a/b")):
            with self.subTest(names=names):
                archive = self.root / "bad.tar.gz"
                archive.write_bytes(self.tar({name: b"x" for name in names}))
                with tempfile.TemporaryDirectory(dir=self.root) as temporary:
                    with self.assertRaises(ValueError):
                        download.extract(archive, Path(temporary) / "extract")
        self.assertFalse((self.root / "outside").exists())

    def test_links_devices_zip_and_limits(self):
        archive = self.root / "special.tar"
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with tarfile.open(archive, "w") as stream:
                member = tarfile.TarInfo("mpv/link")
                member.type, member.linkname = kind, "outside"
                stream.addfile(member)
            with tempfile.TemporaryDirectory(dir=self.root) as temporary:
                with self.assertRaises(ValueError):
                    download.extract(archive, Path(temporary) / "extract")
        archive = self.root / "special.zip"
        with zipfile.ZipFile(archive, "w") as stream:
            member = zipfile.ZipInfo("mpv/link")
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
            stream.writestr(member, "outside")
        with self.assertRaises(ValueError):
            download.extract(archive, self.root / "zip-out")
        cached = self.seed()
        for limit in ("MAX_MEMBERS", "MAX_EXPANDED"):
            with mock.patch.object(download, limit, 1), tempfile.TemporaryDirectory(dir=self.root) as temporary:
                with self.assertRaises(ValueError):
                    download.extract(cached, Path(temporary) / "extract")

    def test_manifest_content_and_metadata(self):
        archive = self.seed()
        prepared = download.extract(archive, self.root / "extracted")
        manifest_path = prepared / "manifest.json"
        original_bytes = manifest_path.read_bytes()
        original = json.loads(original_bytes)
        entry = self.lock["targets"]["linux/amd64"]
        for field in ("target", "mpvVersion", "clientAPI", "ffmpegVersion", "recipeSHA256"):
            manifest = copy.deepcopy(original)
            manifest[field] = "wrong"
            manifest_path.write_text(json.dumps(manifest))
            entry["manifestSHA256"] = download.digest(manifest_path)
            with self.assertRaisesRegex(ValueError, "版本/目标/API/配方"):
                download.verify_tree(prepared, self.lock, "linux/amd64")
        manifest_path.write_bytes(original_bytes)
        entry["manifestSHA256"] = sha(original_bytes)
        (prepared / "libmpv.so.2").write_bytes(b"x" * 64)
        with self.assertRaisesRegex(ValueError, "SHA256"):
            download.verify_tree(prepared, self.lock, "linux/amd64")

    def test_bad_manifest_archive_never_commits(self):
        cached = self.seed()
        prepared = download.extract(cached, self.root / "bad-content")
        (prepared / "licenses/LICENSE").write_bytes(b"tampered")
        package = self.tar({path.relative_to(prepared).as_posix(): path.read_bytes() for path in prepared.rglob("*") if path.is_file()})
        entry = self.lock["targets"]["linux/amd64"]
        entry.update(sha256=sha(package), size=len(package))
        before = cached.read_bytes()
        with self.http(package), self.assertRaisesRegex(ValueError, "SHA256"):
            self.run_process(force=True, fetch_only=True)
        self.assertEqual(cached.read_bytes(), before)
        self.assertFalse(self.resources.exists())

    def test_downloaded_manifest_sha256_mismatch_never_commits(self):
        self.lock["targets"]["linux/amd64"]["manifestSHA256"] = "0" * 64
        with self.http(self.packages["linux/amd64"]), self.assertRaisesRegex(ValueError, "manifestSHA256"):
            self.run_process(fetch_only=True)
        self.assertFalse(list(self.cache.rglob("*.tar.gz")))
        self.assertFalse(self.resources.exists())

    def test_atomic_rollback_restores_cache_and_resources(self):
        cached = self.seed()
        self.run_process(offline=True)
        library = self.resources / "linux-amd64/mpv/libmpv.so.2"
        old_cache, old_library = cached.read_bytes(), library.read_bytes()
        rename = Path.rename
        def fail_install(path, destination):
            if ".mpv-install-" in str(path) and path.name == "mpv":
                raise OSError("injected install failure")
            return rename(path, destination)
        with self.http(self.packages["linux/amd64"]), mock.patch.object(Path, "rename", fail_install):
            with self.assertRaisesRegex(OSError, "injected"):
                self.run_process(force=True)
        self.assertEqual(cached.read_bytes(), old_cache)
        self.assertEqual(library.read_bytes(), old_library)
        self.assertEqual(list(self.root.rglob("*.previous")), [])

    def test_universal_mapping_and_cleanup(self):
        self.seed("darwin/universal")
        with mock.patch.object(download.urllib.request, "build_opener", side_effect=AssertionError("network")):
            for arch in ("amd64", "arm64"):
                self.run_process("darwin/" + arch, offline=True)
                self.assertTrue((self.resources / f"darwin-{arch}/mpv/libmpv.2.dylib").is_file())
            self.run_process("darwin/universal", offline=True)
        for arch in ("amd64", "arm64"):
            self.assertFalse((self.resources / f"darwin-{arch}/mpv").exists())
        self.assertTrue((self.resources / "darwin-universal/mpv").is_dir())
        self.assertEqual(len(list(self.cache.rglob("*.tar.gz"))), 1)

    def prepare_universal_with_old_staging(self):
        self.seed("darwin/universal")
        for target in ("darwin/universal", "darwin/amd64", "darwin/arm64"):
            self.run_process(target, offline=True)
        shutil.rmtree(self.cache)

    def test_universal_reuse_cleans_old_staging_without_reinstall(self):
        self.prepare_universal_with_old_staging()
        library = self.resources / "darwin-universal/mpv/libmpv.2.dylib"
        before = library.stat()
        with mock.patch.object(download, "download", side_effect=AssertionError("download")), mock.patch.object(download, "extract", side_effect=AssertionError("extract")), mock.patch.object(shutil, "copytree", side_effect=AssertionError("copy")):
            self.run_process("darwin/universal", offline=True)
        self.assertEqual((library.stat().st_ino, library.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        for arch in ("amd64", "arm64"):
            self.assertFalse((self.resources / f"darwin-{arch}/mpv").exists())

    def test_universal_reuse_cleanup_ownership_and_rollback(self):
        self.prepare_universal_with_old_staging()
        old = self.resources / "darwin-arm64/mpv/manifest.json"
        original = old.read_bytes()
        old.write_text(json.dumps({"schemaVersion": 1, "target": "other"}))
        before = self.snapshot()
        with self.no_preparation(), self.assertRaisesRegex(ValueError, "非本工具"):
            self.run_process("darwin/universal", offline=True)
        self.assertEqual(self.snapshot(), before)
        old.write_bytes(original)
        before = self.snapshot()
        rename = Path.rename
        def fail_second_cleanup(path, destination):
            if path == old.parent:
                raise OSError("injected cleanup failure")
            return rename(path, destination)
        with mock.patch.object(Path, "rename", fail_second_cleanup):
            with self.assertRaisesRegex(OSError, "cleanup failure"):
                self.run_process("darwin/universal", offline=True)
        # 父目录 mtime 会因 rename 回滚改变；内容、旧 staging inode 和文件 mtime 保留。
        after = self.snapshot()
        self.assertEqual(set(after), set(before))
        for path, record in before.items():
            self.assertEqual(after[path][0], record[0])
            if record[2] is not None:
                self.assertEqual(after[path], record)
        self.assertEqual(list(self.root.rglob("*.previous")), [])

    def test_check_universal_never_cleans_old_staging(self):
        self.prepare_universal_with_old_staging()
        before = self.snapshot()
        with self.no_preparation():
            self.run_process("darwin/universal", check=True)
        self.assertEqual(self.snapshot(), before)

    def test_native_architectures_and_runtime_dll(self):
        for target in download.TARGETS:
            self.seed(target)
            self.run_process(target, offline=True, fetch_only=True)
        native = self.root / "binary"
        native.write_bytes(universal())
        self.assertEqual(download.binary_arches(native, "darwin"), {"amd64", "arm64"})
        broken = bytearray(universal())
        struct.pack_into(">I", broken, 16, 999999)
        native.write_bytes(broken)
        with self.assertRaises(ValueError):
            download.binary_arches(native, "darwin")
        prepared = download.extract(self.seed("windows/amd64"), self.root / "windows-out")
        (prepared / "runtime.dll").write_bytes(pe("arm64"))
        manifest_path = prepared / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["files"]["runtime.dll"]["sha256"] = sha(pe("arm64"))
        manifest_path.write_text(json.dumps(manifest))
        self.lock["targets"]["windows/amd64"]["manifestSHA256"] = download.digest(manifest_path)
        with self.assertRaisesRegex(ValueError, "架构"):
            download.verify_tree(prepared, self.lock, "windows/amd64")

    def test_cli_preserves_mpv_offline_environment(self):
        with mock.patch.dict(download.os.environ, {"MPV_OFFLINE": "1"}), mock.patch.object(
            download, "load_lock", return_value=self.lock
        ), mock.patch.object(download, "process") as process:
            download.main(["--target", "linux/amd64", "--cache", str(self.cache)])
        self.assertEqual(process.call_args.args[4:], (True, False, False, False))

    def test_cli_comma_targets_and_flags(self):
        with mock.patch.object(download, "load_lock", return_value=self.lock), mock.patch.object(download, "process") as process:
            download.main(["--target", "darwin/arm64,linux/amd64", "--cache", str(self.cache), "--offline", "--fetch-only", "--force"])
        self.assertEqual(process.call_count, 2)
        self.assertEqual(process.call_args_list[0].args[1], "darwin/arm64")
        self.assertEqual(process.call_args_list[1].args[1], "linux/amd64")
        self.assertEqual(process.call_args.args[4:], (True, False, True, True))

    def test_symlink_cache_rejected(self):
        cached = self.seed()
        other = self.root / "other"
        cached.rename(other)
        cached.symlink_to(other)
        with self.assertRaises(ValueError):
            self.run_process(offline=True)
        self.assertEqual(other.read_bytes(), self.packages["linux/amd64"])


if __name__ == "__main__":
    unittest.main()
