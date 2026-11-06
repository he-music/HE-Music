"""最终 ELF 检查必须对宿主和随包库同时生效。"""

import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import audit_linux


class LinuxAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "linux-amd64"
        (self.directory / "mpv").mkdir(parents=True)
        data = bytearray(64)
        data[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", data, 18, 62)
        for file in (self.directory / "he-music", self.directory / "mpv/libmpv.so.2"):
            file.write_bytes(data)
        self.config = {"slug": "he-music", "linux": {"depends": ["libc6 (>= 2.35)", "libpulse0"]}}

    def test_checks_both_host_and_library_and_keeps_compatibility_unverified(self):
        with patch("prepare.verify"), patch("prepare.run", return_value="GLIBC_2.34 GLIBC_2.17 GLIBCXX_3.4.29") as command:
            report = audit_linux.audit(self.root, ["linux/amd64"], self.config)
        self.assertEqual(command.call_count, 2)
        self.assertEqual(len(report["elfSymbolVersions"]), 2)
        self.assertFalse(report["desktopCompatibilityVerified"])

    def test_host_newer_than_declared_minimum_is_a_failure(self):
        def result(args, capture):
            return "GLIBC_2.39" if args[-1].name == "he-music" else "GLIBC_2.35"
        with patch("prepare.verify"), patch("prepare.run", side_effect=result):
            with self.assertRaisesRegex(ValueError, "GLIBC_2.39"):
                audit_linux.audit(self.root, ["linux/amd64"], self.config)

    def test_missing_host_is_not_reported_as_verified_package(self):
        (self.directory / "he-music").unlink()
        with patch("prepare.verify"), patch("prepare.run", return_value="GLIBC_2.35"):
            with self.assertRaisesRegex(ValueError, "宿主"):
                audit_linux.audit(self.root, ["linux/amd64"], self.config)

    def test_wrong_architecture_is_rejected(self):
        with patch("prepare.verify"), patch("prepare.binary_arches", return_value={"arm64"}):
            with self.assertRaisesRegex(ValueError, "架构"):
                audit_linux.audit(self.root, ["linux/amd64"], self.config)
