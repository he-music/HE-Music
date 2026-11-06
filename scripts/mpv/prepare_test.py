"""固定下载、归档边界、架构与离线资源完整性回归；不启动应用。"""

import hashlib
import io
import json
import os
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import prepare


def pe(machine=0x8664, imports=()):
    data = bytearray(1024)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 64)
    data[64:68] = b"PE\0\0"
    struct.pack_into("<HH", data, 68, machine, 1)
    struct.pack_into("<H", data, 84, 240)
    struct.pack_into("<H", data, 88, 0x20B)
    struct.pack_into("<IIII", data, 336, 512, 0x1000, 512, 512)
    if imports:
        struct.pack_into("<II", data, 208, 0x1000, (len(imports) + 1) * 20)
        for index, name in enumerate(imports):
            offset = 800 + index * 64
            struct.pack_into("<I", data, 512 + index * 20 + 12, 0x1000 + offset - 512)
            data[offset:offset + len(name) + 1] = name.encode() + b"\0"
    return data


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mpv test 空格 ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.entry = {"url": "https://example.test/source.tar.xz", "sha256": hashlib.sha256(b"fixed bytes").hexdigest()}

    def test_fixed_cache_is_reusable_offline_and_never_silently_redownloads_tampering(self):
        self.cache.mkdir()
        file = self.cache / "source.tar.xz"
        file.write_bytes(b"fixed bytes")
        with patch("urllib.request.urlopen", side_effect=AssertionError("不得联网")):
            self.assertEqual(prepare.fetch(self.entry, self.cache, True), file)
            file.write_bytes(b"damaged")
            with self.assertRaisesRegex(ValueError, "摘要不符"):
                prepare.fetch(self.entry, self.cache)
            file.unlink()
            with self.assertRaisesRegex(ValueError, "离线缓存缺失"):
                prepare.fetch(self.entry, self.cache, True)

    def test_download_verifies_before_publish_and_cleans_partial_on_failure(self):
        class Response(io.BytesIO):
            url = "https://cdn.example.test/source.tar.xz"
        with patch("urllib.request.urlopen", return_value=Response(b"wrong bytes")):
            with self.assertRaisesRegex(ValueError, "下载摘要不符"):
                prepare.fetch(self.entry, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])
        with patch("urllib.request.urlopen", return_value=Response(b"fixed bytes")):
            result = prepare.fetch(self.entry, self.cache)
        self.assertEqual(result.read_bytes(), b"fixed bytes")
        self.assertEqual(len(list(self.cache.iterdir())), 1)

    def test_download_error_does_not_hide_cause_or_leave_success_receipt(self):
        with patch("urllib.request.urlopen", side_effect=OSError("isolated connection failure")):
            with self.assertRaisesRegex(OSError, "isolated connection failure"):
                prepare.fetch(self.entry, self.cache)
        self.assertEqual(list(self.cache.iterdir()), [])
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            prepare.fetch({**self.entry, "url": "http://example.test/source"}, self.cache)
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            prepare.fetch({**self.entry, "sha256": "0" * 63}, self.cache)

    def test_cache_symlink_and_broken_symlink_are_rejected(self):
        self.cache.mkdir()
        target = self.root / "outside"
        target.write_bytes(b"fixed bytes")
        link = self.cache / "source.tar.xz"
        link.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "缓存摘要不符"):
            prepare.fetch(self.entry, self.cache)
        target.unlink()
        with self.assertRaisesRegex(ValueError, "缓存摘要不符"):
            prepare.fetch(self.entry, self.cache)

    def test_archives_reject_traversal_links_special_files_and_wrong_root_before_extract(self):
        for index, (name, kind) in enumerate([
            ("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
            ("C:/drive", tarfile.REGTYPE), ("root\\escape", tarfile.REGTYPE),
            ("root/link", tarfile.SYMTYPE), ("root/hard", tarfile.LNKTYPE),
            ("root/device", tarfile.CHRTYPE), ("other/file", tarfile.REGTYPE),
        ]):
            with self.subTest(name=name):
                archive = self.root / f"bad-{index}.tar"
                with tarfile.open(archive, "w") as container:
                    good = tarfile.TarInfo("root/first")
                    good.size = 1
                    container.addfile(good, io.BytesIO(b"x"))
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    item.linkname = "../../escape"
                    container.addfile(item)
                output = self.root / f"output-{index}"
                with self.assertRaises(ValueError):
                    prepare.extract(archive, output, "root")
                self.assertEqual(list(output.iterdir()), [])

    def test_zip_links_case_collisions_and_paths_are_rejected(self):
        for index, names in enumerate([("../escape",), ("/absolute",), ("file", "FILE"), ("root\\bad",)]):
            archive = self.root / f"bad-{index}.zip"
            with zipfile.ZipFile(archive, "w") as container:
                for name in names:
                    container.writestr(name, b"x")
            with self.assertRaises(ValueError):
                prepare.extract(archive, self.root / f"out-{index}")
        archive = self.root / "link.zip"
        with zipfile.ZipFile(archive, "w") as container:
            item = zipfile.ZipInfo("link")
            item.external_attr = 0o120777 << 16
            container.writestr(item, "../escape")
        with self.assertRaisesRegex(ValueError, "软链接"):
            prepare.extract(archive, self.root / "link-output")

    def test_valid_archive_handles_unicode_spaces_and_executable_modes(self):
        archive = self.root / "good.tar"
        with tarfile.open(archive, "w") as container:
            item = tarfile.TarInfo("root/中文 文件")
            item.mode = 0o755
            item.size = 2
            container.addfile(item, io.BytesIO(b"ok"))
        result = prepare.extract(archive, self.root / "output", "root")
        self.assertEqual((result / "中文 文件").read_bytes(), b"ok")
        self.assertTrue((result / "中文 文件").stat().st_mode & 0o111)

    def test_pe_architecture_and_import_closure(self):
        file = self.root / "libmpv-2.dll"
        file.write_bytes(pe(imports=("kernel32.dll", "libmissing.dll")))
        self.assertEqual(prepare.binary_arches(file), {"amd64"})
        self.assertEqual(prepare.pe_imports(file), ["kernel32.dll", "libmissing.dll"])
        with self.assertRaisesRegex(ValueError, "libmissing.dll"):
            prepare.validate_dependencies(self.root, "windows")
        (self.root / "libmissing.dll").write_bytes(pe())
        self.assertIn("libmpv-2.dll", prepare.validate_dependencies(self.root, "windows"))
        file.write_bytes(pe(machine=0xAA64))
        self.assertEqual(prepare.binary_arches(file), {"arm64"})
        file.write_bytes(b"MZ")
        with self.assertRaisesRegex(ValueError, "损坏"):
            prepare.binary_arches(file)

    def test_windows_requires_native_architecture_and_matching_msys_crt_before_fetch(self):
        with patch.object(prepare.sys, "platform", "darwin"), patch.object(prepare, "fetch") as fetch:
            with self.assertRaisesRegex(ValueError, "对应架构原生"):
                prepare.source_build("windows/amd64", self.root, self.cache, {}, True, 1)
            fetch.assert_not_called()
        for arch, machine, wrong in (("amd64", "AMD64", "CLANGARM64"), ("arm64", "ARM64", "CLANG64")):
            with self.subTest(arch=arch), patch.object(prepare.sys, "platform", "win32"), \
                    patch.object(prepare.platform, "machine", return_value=machine), \
                    patch.dict(os.environ, {"MSYSTEM": wrong}), patch.object(prepare, "fetch") as fetch:
                with self.assertRaisesRegex(ValueError, "不能混合 CRT/架构"):
                    prepare.source_build("windows/" + arch, self.root, self.cache, {}, True, 1)
                fetch.assert_not_called()

    def test_windows_configure_uses_msys_bash_but_native_compilers_remain_direct(self):
        with patch.object(prepare.sys, "platform", "win32"), \
                patch.object(prepare.subprocess, "check_output", return_value="/c/构建 空格/configure\n") as cygpath:
            self.assertEqual(prepare.command_args(["C:\\构建 空格\\configure", "--prefix=C:\\目标"]),
                             ["bash", "/c/构建 空格/configure", "--prefix=C:/目标"])
            cygpath.assert_called_once_with(["cygpath", "-u", "C:/构建 空格/configure"], text=True)
            self.assertEqual(prepare.command_args(["clang", "-c", "C:\\源\\sample.c"]),
                             ["clang", "-c", "C:/源/sample.c"])

    def test_windows_ucrt_is_system_but_unbundled_compiler_runtimes_are_rejected(self):
        file = self.root / "libmpv-2.dll"
        file.write_bytes(pe(imports=("kernel32.dll", "ucrtbase.dll", "api-ms-win-crt-runtime-l1-1-0.dll")))
        prepare.validate_dependencies(self.root, "windows")
        for runtime in ("libc++.dll", "libunwind.dll", "libwinpthread-1.dll"):
            with self.subTest(runtime=runtime):
                file.write_bytes(pe(imports=(runtime,)))
                with self.assertRaisesRegex(ValueError, "未随包或未声明"):
                    prepare.validate_dependencies(self.root, "windows")

    def fixture(self):
        directory = self.cache / "prepared/windows-amd64/mpv"
        directory.mkdir(parents=True)
        (directory / "libmpv-2.dll").write_bytes(pe())
        (directory / "license.txt").write_text("test license")
        prepare.write_manifest(directory, "windows/amd64", {"fixture": True})
        return directory

    def test_prepared_cache_checks_recipe_inventory_hash_size_and_architecture(self):
        directory = self.fixture()
        with patch.object(prepare, "fetch", side_effect=AssertionError("不得下载或编译")):
            self.assertEqual(prepare.prepare("windows/amd64", self.cache, True), directory)
        manifest = json.loads((directory / "manifest.json").read_text())
        for mutation in ("missing", "changed", "extra", "recipe", "wrong-arch"):
            with self.subTest(mutation=mutation):
                (directory / "license.txt").write_text("test license")
                if mutation == "missing":
                    (directory / "license.txt").unlink()
                elif mutation == "changed":
                    (directory / "license.txt").write_text("tampered")
                elif mutation == "extra":
                    (directory / "extra").write_text("unexpected")
                elif mutation == "recipe":
                    prepare.atomic_json(directory / "manifest.json", {**manifest, "recipeSHA256": "0" * 64})
                elif mutation == "wrong-arch":
                    (directory / "libmpv-2.dll").write_bytes(pe(machine=0xAA64))
                    prepare.atomic_json(directory / "manifest.json", {**manifest, "files": prepare.inventory(directory)})
                with self.assertRaises(ValueError):
                    prepare.verify(directory, "windows/amd64")
                (directory / "extra").unlink(missing_ok=True)
                (directory / "libmpv-2.dll").write_bytes(pe())
                prepare.atomic_json(directory / "manifest.json", manifest)

    def test_nested_manifest_files_are_not_exempt_from_integrity_inventory(self):
        directory = self.fixture()
        nested = directory / "nested"
        nested.mkdir()
        file = nested / "manifest.json"
        file.write_text("original nested material")
        prepare.write_manifest(directory, "windows/amd64", {})
        file.write_text("tampered nested material")
        with self.assertRaisesRegex(ValueError, "清单不符"):
            prepare.verify(directory, "windows/amd64")

    def test_every_dependency_architecture_is_checked(self):
        directory = self.fixture()
        (directory / "other.dll").write_bytes(pe(machine=0xAA64))
        with self.assertRaisesRegex(ValueError, "依赖库架构"):
            prepare.write_manifest(directory, "windows/amd64", {})

    def test_failed_replacement_restores_previous_success_and_does_not_make_receipt(self):
        destination = self.root / "destination"
        destination.mkdir()
        (destination / "success").write_text("previous")
        source = self.root / "source"
        source.mkdir()
        with patch("shutil.move", side_effect=OSError("isolated move failure")):
            with self.assertRaisesRegex(OSError, "isolated move failure"):
                prepare.replace_tree(source, destination)
        self.assertEqual((destination / "success").read_text(), "previous")
        self.assertFalse(destination.with_name("destination.previous").exists())

    def test_staging_refuses_external_directory_symlinks(self):
        directory = self.fixture()
        resources = self.root / "resources"
        resources.symlink_to(self.cache, target_is_directory=True)
        with patch.object(prepare, "ROOT", self.root):
            with self.assertRaisesRegex(ValueError, "祖先目录"):
                prepare.stage_resources(directory, "windows/amd64")

    def test_universal_staging_removes_empty_architecture_parents_but_preserves_unrelated_files(self):
        prepared = self.fixture()
        resources = self.root / "resources"
        old = resources / "darwin-arm64/mpv"
        old.mkdir(parents=True)
        prepare.atomic_json(old / "manifest.json", {"schemaVersion": 1, "target": "darwin/arm64"})
        other = resources / "darwin-amd64"
        other.mkdir()
        (other / "unrelated.txt").write_text("preserve")
        with patch.object(prepare, "ROOT", self.root), patch.object(prepare, "verify"):
            prepare.stage_resources(prepared, "darwin/universal")
        self.assertFalse((resources / "darwin-arm64").exists())
        self.assertEqual((other / "unrelated.txt").read_text(), "preserve")
        self.assertTrue((resources / "darwin-universal/mpv/libmpv-2.dll").is_file())

    def test_universal_staging_refuses_symlink_cleanup(self):
        prepared = self.fixture()
        resources = self.root / "resources"
        resources.mkdir()
        outside = self.root / "outside"
        (outside / "mpv").mkdir(parents=True)
        prepare.atomic_json(outside / "mpv/manifest.json", {"schemaVersion": 1, "target": "darwin/arm64"})
        (resources / "darwin-arm64").symlink_to(outside, target_is_directory=True)
        with patch.object(prepare, "ROOT", self.root), patch.object(prepare, "verify"):
            with self.assertRaisesRegex(ValueError, "软链接资源目录"):
                prepare.stage_resources(prepared, "darwin/universal")
        self.assertTrue((outside / "mpv/manifest.json").is_file())

    def test_coreaudio_fix_has_exact_context_and_is_recorded(self):
        file = self.root / "meson.build"
        original = "if features['coreaudio']\n    dependencies += coreaudio\n"
        file.write_text(original)
        receipt = prepare.apply_coreaudio_fix(self.root)
        self.assertIn("osdep/utils-mac.c", file.read_text())
        self.assertEqual(receipt["resultSHA256"], prepare.digest(file))
        with self.assertRaisesRegex(ValueError, "上下文"):
            prepare.apply_coreaudio_fix(self.root)
        file.write_text("different source")
        with self.assertRaisesRegex(ValueError, "上下文"):
            prepare.apply_coreaudio_fix(self.root)

    def test_command_failure_retains_exit_code_and_full_captured_output(self):
        import sys
        with self.assertRaisesRegex(RuntimeError, "(?s)17.*specific diagnostic"):
            prepare.run([sys.executable, "-c", "print('specific diagnostic'); raise SystemExit(17)"], capture=True)


if __name__ == "__main__":
    unittest.main()
