"""最终 ELF 检查覆盖宿主和纯二进制运行目录，不依赖生产者脚本。"""

import hashlib
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import audit_linux


class LinuxAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.directory = self.root / "linux-amd64"
        (self.directory / "mpv").mkdir(parents=True)
        data = bytearray(64)
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 18, 62)
        self.host = self.directory / "he-music"
        self.library = self.directory / "mpv/libmpv.so.2"
        self.host.write_bytes(data)
        self.library.write_bytes(data)
        self.license = self.directory / "licenses/mpv/LICENSE"
        self.license.parent.mkdir(parents=True)
        self.license.write_bytes(b"license")
        def record(value):
            return {"sha256": hashlib.sha256(value).hexdigest(), "size": len(value)}
        self.lock = {"schemaVersion": 2, "targets": {"linux/amd64": {
            "runtimeFiles": {"libmpv.so.2": record(data)},
            "licenseFiles": {"licenses/LICENSE": record(b"license")},
        }}}
        self.config = {"slug": "he-music", "linux": {"depends": ["libc6 (>= 2.35)", "libpulse0"]}}
        loader = patch.object(audit_linux.download, "load_lock", return_value=self.lock)
        self.loader = loader.start()
        self.addCleanup(loader.stop)

    def test_checks_both_host_and_binary_only_library(self):
        with patch("audit_linux.subprocess.check_output", return_value="GLIBC_2.34 GLIBC_2.17 GLIBCXX_3.4.29") as command:
            report = audit_linux.audit(self.root, ["linux/amd64"], self.config)
        self.assertFalse((self.directory / "mpv/manifest.json").exists())
        self.loader.assert_called_once_with()
        self.assertEqual(command.call_count, 2)
        self.assertEqual(len(report["elfSymbolVersions"]), 2)
        self.assertFalse(report["desktopCompatibilityVerified"])

    def test_host_newer_than_declared_minimum_is_a_failure(self):
        def result(args, text):
            return "GLIBC_2.39" if args[-1] == self.host else "GLIBC_2.35"
        with patch("audit_linux.subprocess.check_output", side_effect=result):
            with self.assertRaisesRegex(ValueError, "GLIBC_2.39"):
                audit_linux.audit(self.root, ["linux/amd64"], self.config)

    def test_missing_host_is_not_reported_as_verified_package(self):
        self.host.unlink()
        with patch("audit_linux.subprocess.check_output", return_value="GLIBC_2.35"):
            with self.assertRaisesRegex(ValueError, "宿主"):
                audit_linux.audit(self.root, ["linux/amd64"], self.config)

    def test_wrong_host_architecture_is_rejected(self):
        data = bytearray(self.host.read_bytes())
        struct.pack_into("<H", data, 18, 183)
        self.host.write_bytes(data)
        with patch("audit_linux.subprocess.check_output", return_value="GLIBC_2.35"):
            with self.assertRaisesRegex(ValueError, "架构"):
                audit_linux.audit(self.root, ["linux/amd64"], self.config)

    def test_tampered_runtime_or_license_is_rejected_before_readelf(self):
        for file in (self.library, self.license):
            with self.subTest(file=file):
                original = file.read_bytes()
                file.write_bytes(b"tampered")
                with patch("audit_linux.subprocess.check_output") as command:
                    with self.assertRaisesRegex(ValueError, "SHA256"):
                        audit_linux.audit(self.root, ["linux/amd64"], self.config)
                    command.assert_not_called()
                file.write_bytes(original)

    def test_extra_build_material_in_runtime_directory_is_rejected(self):
        (self.directory / "mpv/manifest.json").write_text("{}")
        with patch("audit_linux.subprocess.check_output") as command:
            with self.assertRaises(ValueError):
                audit_linux.audit(self.root, ["linux/amd64"], self.config)
            command.assert_not_called()

    def test_rejects_non_linux_or_escaping_target(self):
        for targets in (["darwin/universal"], ["../outside"], []):
            with self.assertRaisesRegex(ValueError, "只接受 Linux"):
                audit_linux.audit(self.root, targets, self.config)
