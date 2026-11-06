#!/usr/bin/env python3
"""从本地固定锁下载、校验并安装 libmpv 分发包（仅使用 Python 标准库）。"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
LOCK = Path(__file__).with_name("bundles.lock.json")
TARGETS = {"darwin/universal", "windows/amd64", "windows/arm64", "linux/amd64", "linux/arm64"}
REQUEST_TARGETS = TARGETS | {"darwin/amd64", "darwin/arm64"}
MAX_MEMBERS = 20000
MAX_EXPANDED = 2 * 1024**3
CHUNK = 1024 * 1024


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK), b""):
            value.update(block)
    return value.hexdigest()


def safe_path(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name or "\0" in name:
        raise ValueError(f"不安全路径: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"不安全路径: {name!r}")
    return path


def no_symlinks(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"拒绝链接路径: {part}")


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"JSON 重复键: {key}")
            result[key] = value
        return result
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique)


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def validate_split_files(entry, target):
    runtime = entry.get("runtimeFiles")
    licenses = entry.get("licenseFiles")
    if not isinstance(runtime, dict) or not runtime or not isinstance(licenses, dict) or not licenses:
        raise ValueError("运行文件和许可证清单缺失")
    seen = set()
    system = target.split("/")[0]
    for collection, is_runtime in ((runtime, True), (licenses, False)):
        for name, record in collection.items():
            path = safe_path(name)
            if path.as_posix() != name or name.casefold() in seen:
                raise ValueError("运行文件或许可证路径无效/冲突")
            seen.add(name.casefold())
            if is_runtime:
                native = (name.endswith(".dylib") if system == "darwin" else
                          name.lower().endswith(".dll") if system == "windows" else
                          re.fullmatch(r"lib[^/]+\.so(?:\.[0-9]+)*", name))
                if len(path.parts) != 1 or not native:
                    raise ValueError("运行目录只能包含原生动态库")
            elif len(path.parts) < 2 or path.parts[0] != "licenses":
                raise ValueError("许可证必须位于 licenses/ 下")
            if not isinstance(record, dict) or not valid_hash(record.get("sha256")) or type(record.get("size")) is not int or record["size"] <= 0:
                raise ValueError("运行文件或许可证 size/SHA256 无效")
    if entry["library"] not in runtime:
        raise ValueError("主库未列入运行文件")


def load_lock(path=LOCK):
    lock = read_json(path)
    if lock.get("schemaVersion") not in (1, 2) or lock.get("repository") != "he-music/mpv-bundles":
        raise ValueError("分发锁 schemaVersion/repository 无效")
    version = lock.get("bundleVersion", "")
    if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", version) or version.lower() == "latest":
        raise ValueError("必须锁定固定 bundleVersion")
    if not valid_hash(lock.get("recipeSHA256")):
        raise ValueError("recipeSHA256 无效")
    for key in ("mpvVersion", "ffmpegVersion", "clientAPI"):
        if not isinstance(lock.get(key), str) or not lock[key]:
            raise ValueError(f"锁字段无效: {key}")
    if not isinstance(lock.get("targets"), dict) or set(lock["targets"]) != TARGETS:
        raise ValueError("锁必须包含五个分发目标")
    for target, entry in lock["targets"].items():
        if not isinstance(entry, dict):
            raise ValueError("目标记录无效")
        asset = entry.get("asset", "")
        if not isinstance(asset, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", asset):
            raise ValueError("asset 必须是普通文件名")
        expected = f"https://github.com/he-music/mpv-bundles/releases/download/{version}/{asset}"
        if entry.get("url") != expected:
            raise ValueError("只允许固定版本的官方 GitHub release URL")
        if not valid_hash(entry.get("sha256")) or type(entry.get("size")) is not int or entry["size"] <= 0:
            raise ValueError("归档 size/SHA256 无效")
        if not valid_hash(entry.get("manifestSHA256")):
            raise ValueError("manifestSHA256 无效")
        if entry.get("root") != "mpv" or "correspondingSourceStatus" not in entry:
            raise ValueError("分发根目录或源码状态缺失")
        if safe_path(entry.get("library")).as_posix() != entry["library"]:
            raise ValueError("主库路径必须规范化")
        if lock["schemaVersion"] == 2:
            validate_split_files(entry, target)
    if lock["schemaVersion"] == 2:
        materials = lock.get("materials", {})
        asset = materials.get("asset", "") if isinstance(materials, dict) else ""
        if not isinstance(asset, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", asset) or materials.get("url") != f"https://github.com/he-music/mpv-bundles/releases/download/{version}/{asset}":
            raise ValueError("材料包必须使用同版本官方 Release URL")
        if materials.get("root") != "materials" or not valid_hash(materials.get("sha256")) or not valid_hash(materials.get("manifestSHA256")) or type(materials.get("size")) is not int or materials["size"] <= 0:
            raise ValueError("材料包 size/SHA256/清单无效")
    return lock


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme.lower() != "https":
            raise ValueError("拒绝非 HTTPS 重定向")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def verify_archive(path, entry):
    no_symlinks(path)
    if not path.is_file() or path.stat().st_size != entry["size"] or digest(path) != entry["sha256"]:
        raise ValueError(f"归档 size/SHA256 不符: {path}；可用 --force 从正确来源重建")


def download(entry, destination):
    request = urllib.request.Request(entry["url"], headers={"User-Agent": "HE-Music-mpv-bundles/1"})
    opener = urllib.request.build_opener(HTTPSRedirect())
    with opener.open(request, timeout=120) as response, destination.open("xb") as output:
        if urllib.parse.urlsplit(response.url).scheme.lower() != "https":
            raise ValueError("拒绝非 HTTPS 下载")
        size = 0
        for block in iter(lambda: response.read(CHUNK), b""):
            size += len(block)
            if size > entry["size"]:
                raise ValueError("下载超过锁定大小")
            output.write(block)
    verify_archive(destination, entry)


def extract(archive, destination):
    """只在摘要通过后调用；先检查全部成员，再写入空隔离目录。"""
    destination.mkdir()
    if zipfile.is_zipfile(archive):
        container = zipfile.ZipFile(archive)
        members = [(m.filename, m.is_dir(), m.file_size, m) for m in container.infolist()]
        def regular(member):
            kind = stat.S_IFMT(member.external_attr >> 16)
            expected = stat.S_IFDIR if member.is_dir() else stat.S_IFREG
            return kind in (0, expected) and not (member.flag_bits & 1)
        opener = container.open
    else:
        container = tarfile.open(archive, "r:*")
        members = []
        try:
            for member in container:
                members.append((member.name, member.isdir(), member.size, member))
                if len(members) > MAX_MEMBERS:
                    raise ValueError("归档成员数超限")
        except BaseException:
            container.close()
            raise
        regular = lambda member: member.isfile() or member.isdir()
        opener = container.extractfile
    with container:
        if len(members) > MAX_MEMBERS:
            raise ValueError("归档成员数超限")
        seen, total = set(), 0
        for name, directory, size, member in members:
            relative = safe_path(name)
            folded = relative.as_posix().casefold()
            if relative.parts[0] != "mpv" or (len(relative.parts) == 1 and not directory):
                raise ValueError(f"归档必须在 mpv/ 根下: {name}")
            if folded in seen or not regular(member) or size < 0:
                raise ValueError(f"重复路径、链接或特殊成员: {name}")
            seen.add(folded)
            total += size
            if total > MAX_EXPANDED:
                raise ValueError("归档展开大小超限")
        for name, directory, size, member in members:
            output = destination.joinpath(*safe_path(name).parts)
            if directory:
                output.mkdir(parents=True, exist_ok=True)
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            with opener(member) as source, output.open("xb") as stream:
                remaining = size
                while remaining:
                    block = source.read(min(CHUNK, remaining))
                    if not block:
                        raise ValueError("归档成员截断")
                    stream.write(block)
                    remaining -= len(block)
                if source.read(1):
                    raise ValueError("归档成员大小不符")
            mode = member.external_attr >> 16 if isinstance(member, zipfile.ZipInfo) else member.mode
            output.chmod(0o755 if mode & 0o111 else 0o644)
    return destination / "mpv"


def binary_arches(path, system):
    with Path(path).open("rb") as stream:
        data = stream.read(4096)
        size = os.fstat(stream.fileno()).st_size
        try:
            if system == "windows" and data[:2] == b"MZ":
                offset = struct.unpack_from("<I", data, 60)[0]
                if offset < 64 or offset > size - 26:
                    raise ValueError("PE 头越界")
                stream.seek(offset)
                header = stream.read(26)
                if header[:4] != b"PE\0\0" or struct.unpack_from("<H", header, 24)[0] != 0x20B:
                    raise ValueError("需要 PE32+ 原生库")
                return {{0x8664: "amd64", 0xAA64: "arm64"}[struct.unpack_from("<H", header, 4)[0]]}
            if system == "linux" and data[:6] == b"\x7fELF\x02\x01" and len(data) >= 64:
                return {{62: "amd64", 183: "arm64"}[struct.unpack_from("<H", data, 18)[0]]}
            if system == "darwin" and data[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
                wide = data[3] == 0xBF
                stride = 32 if wide else 20
                if struct.unpack_from(">I", data, 4)[0] != 2:
                    raise ValueError("Mach-O universal 必须恰有两个架构")
                arches, ranges = set(), []
                for index in range(2):
                    base = 8 + index * stride
                    cpu = struct.unpack_from(">I", data, base)[0]
                    arch = {0x1000007: "amd64", 0x100000C: "arm64"}[cpu]
                    offset, length = struct.unpack_from(">QQ" if wide else ">II", data, base + 8)
                    if offset < 8 + 2 * stride or length < 32 or offset + length > size:
                        raise ValueError("Mach-O slice 越界")
                    if any(offset < end and start < offset + length for start, end in ranges):
                        raise ValueError("Mach-O slice 重叠")
                    stream.seek(offset)
                    header = stream.read(8)
                    if header[:4] != b"\xcf\xfa\xed\xfe" or struct.unpack_from("<I", header, 4)[0] != cpu:
                        raise ValueError("Mach-O slice 头不匹配")
                    ranges.append((offset, offset + length))
                    arches.add(arch)
                if arches != {"amd64", "arm64"}:
                    raise ValueError("Mach-O universal 架构不完整")
                return arches
        except (KeyError, struct.error, IndexError) as error:
            raise ValueError("原生库头损坏或架构不受支持") from error
    raise ValueError(f"原生库格式不符: {path}")


def verify_tree(directory, lock, target):
    no_symlinks(directory)
    manifest_path = directory / "manifest.json"
    no_symlinks(manifest_path)
    if digest(manifest_path) != lock["targets"][target]["manifestSHA256"]:
        raise ValueError("manifestSHA256 与锁不符；可用 --force 从正确来源重建")
    manifest = read_json(manifest_path)
    expected = {key: lock[key] for key in ("mpvVersion", "clientAPI", "ffmpegVersion", "recipeSHA256")}
    expected.update(schemaVersion=1, target=target)
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ValueError("包内 manifest 版本/目标/API/配方与锁不符")
    files = manifest.get("files")
    if not isinstance(files, dict):
        raise ValueError("manifest.files 无效")
    if lock["schemaVersion"] == 2:
        entry = lock["targets"][target]
        if files != {**entry["runtimeFiles"], **entry["licenseFiles"]}:
            raise ValueError("包内文件与锁定运行/许可证清单不符")
    actual, folded = set(), set()
    for path in directory.rglob("*"):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError(f"资源包含链接或特殊文件: {path}")
        relative = path.relative_to(directory).as_posix()
        safe_path(relative)
        if relative.casefold() in folded:
            raise ValueError("资源包含大小写冲突")
        folded.add(relative.casefold())
        if path.is_file() and relative != "manifest.json":
            actual.add(relative)
    if set(files) != actual:
        raise ValueError("manifest 文件清单与实际文件不完全匹配")
    for name, record in files.items():
        if safe_path(name).as_posix() != name or not isinstance(record, dict):
            raise ValueError("文件记录无效")
        path = directory / name
        if type(record.get("size")) is not int or not valid_hash(record.get("sha256")) or path.stat().st_size != record["size"] or digest(path) != record["sha256"]:
            raise ValueError(f"包内文件 size/SHA256 不符: {name}")
    system, arch = target.split("/")
    library = lock["targets"][target]["library"]
    if library not in files:
        raise ValueError("主库未列入 manifest")
    required = {"amd64", "arm64"} if arch == "universal" else {arch}
    libraries = {library}
    if system == "windows":
        libraries.update(name for name in files if name.lower().endswith(".dll"))
    for name in libraries:
        if binary_arches(directory / name, system) != required:
            raise ValueError(f"原生库架构不符: {name}")
    return manifest


def verify_file_set(directory, expected, flat=False):
    no_symlinks(directory)
    if not directory.is_dir():
        raise ValueError(f"运行库或许可证目录缺失: {directory}")
    allowed_dirs = {parent.as_posix() for name in expected for parent in PurePosixPath(name).parents if parent != PurePosixPath(".")}
    actual = set()
    for path in directory.rglob("*"):
        relative = path.relative_to(directory).as_posix()
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError(f"资源包含链接或特殊文件: {path}")
        if path.is_dir():
            if flat or relative not in allowed_dirs:
                raise ValueError(f"运行资源包含多余目录: {path}")
        else:
            actual.add(relative)
    if actual != set(expected):
        raise ValueError("运行文件或许可证与锁不符；可用 --force 从正确来源重建")
    for name, record in expected.items():
        path = directory / name
        if path.stat().st_size != record["size"] or digest(path) != record["sha256"]:
            raise ValueError(f"运行文件或许可证 size/SHA256 不符: {name}")


def license_directory(staging):
    return staging.parent / "licenses" / "mpv"


def verify_staging(staging, lock, target):
    if lock["schemaVersion"] == 1:
        return verify_tree(staging, lock, target)
    entry = lock["targets"][target]
    verify_file_set(staging, entry["runtimeFiles"], flat=True)
    licenses = {name.removeprefix("licenses/"): record for name, record in entry["licenseFiles"].items()}
    verify_file_set(license_directory(staging), licenses)
    system, arch = target.split("/")
    required = {"amd64", "arm64"} if arch == "universal" else {arch}
    for name in entry["runtimeFiles"]:
        if binary_arches(staging / name, system) != required:
            raise ValueError(f"原生库架构不符: {name}")


def copy_split_staging(prepared, staging, entry):
    staging.mkdir()
    for name in entry["runtimeFiles"]:
        shutil.copy2(prepared / name, staging / name)
    licenses = license_directory(staging)
    for name in entry["licenseFiles"]:
        destination = licenses / name.removeprefix("licenses/")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(prepared / name, destination)


def replace_transaction(changes):
    """同文件系统 rename，全部操作成功后才删除备份；失败恢复原资源。"""
    completed = []
    try:
        for source, destination in changes:
            no_symlinks(destination)
            backup = destination.with_name(destination.name + ".previous")
            if backup.exists() or backup.is_symlink():
                raise ValueError(f"存在未处理的备份: {backup}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            existed = destination.exists()
            if existed:
                destination.rename(backup)
            completed.append((destination, backup, existed))
            if source is not None:
                source.rename(destination)
    except BaseException:
        for destination, backup, existed in reversed(completed):
            if destination.is_dir():
                shutil.rmtree(destination)
            elif destination.exists():
                destination.unlink()
            if existed:
                backup.rename(destination)
        raise
    for _, backup, existed in completed:
        if existed:
            if backup.is_dir():
                shutil.rmtree(backup)
            else:
                backup.unlink()


def old_darwin_staging(resources, requested, lock):
    changes = []
    if requested == "darwin/universal":
        for arch in ("amd64", "arm64"):
            previous = Path(resources) / f"darwin-{arch}" / "mpv"
            no_symlinks(previous)
            if previous.exists():
                if (previous / "manifest.json").exists():
                    no_symlinks(previous / "manifest.json")
                    old = read_json(previous / "manifest.json")
                    if old.get("schemaVersion") != 1 or old.get("target") not in (f"darwin/{arch}", "darwin/universal"):
                        raise ValueError(f"拒绝清理非本工具资源: {previous}")
                elif lock["schemaVersion"] == 2:
                    verify_staging(previous, lock, "darwin/universal")
                else:
                    raise ValueError(f"拒绝清理非本工具资源: {previous}")
                changes.append((None, previous))
                if lock["schemaVersion"] == 2 and license_directory(previous).exists():
                    no_symlinks(license_directory(previous))
                    verify_file_set(license_directory(previous), {name.removeprefix("licenses/"): record for name, record in lock["targets"]["darwin/universal"]["licenseFiles"].items()})
                    changes.append((None, license_directory(previous)))
    return changes


def process(lock, requested, cache, resources, offline=False, check=False, fetch_only=False, force=False):
    if requested not in REQUEST_TARGETS:
        raise ValueError("目标必须是受支持的 GOOS/GOARCH")
    target = "darwin/universal" if requested.startswith("darwin/") else requested
    entry = lock["targets"][target]
    cache = Path(cache) / lock["bundleVersion"]
    archive = cache / entry["asset"]
    staging = Path(resources) / requested.replace("/", "-") / "mpv"
    no_symlinks(cache)
    no_symlinks(staging)
    present = archive.exists() or archive.is_symlink()
    if present and (check or offline or not force):
        verify_archive(archive, entry)
    if check:
        verify_staging(staging, lock, target)
        if present:
            with tempfile.TemporaryDirectory(prefix="mpv-check-") as temporary:
                prepared = extract(archive, Path(temporary).resolve() / "unpacked")
                verify_tree(prepared, lock, target)
        return
    if not fetch_only and not force and staging.exists():
        verify_staging(staging, lock, target)
        replace_transaction(old_darwin_staging(resources, requested, lock))
        return
    if not present and offline:
        raise ValueError(f"离线缓存缺失: {archive}")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".download-", dir=cache) as temporary:
        temporary = Path(temporary)
        candidate = archive
        replace_archive = not present or (force and not offline)
        if replace_archive:
            candidate = temporary / entry["asset"]
            download(entry, candidate)
        prepared = extract(candidate, temporary / "unpacked")
        verify_tree(prepared, lock, target)
        changes = []
        if replace_archive:
            changes.append((candidate, archive))
        if fetch_only:
            replace_transaction(changes)
            return
        # staging 的临时目录位于资源同一文件系统，允许 --cache 指向其他磁盘。
        staging.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".mpv-install-", dir=staging.parent) as stage_tmp:
            source = Path(stage_tmp) / "mpv"
            if lock["schemaVersion"] == 2:
                copy_split_staging(prepared, source, entry)
                verify_staging(source, lock, target)
                changes.append((license_directory(source), license_directory(staging)))
            else:
                shutil.copytree(prepared, source)
                verify_tree(source, lock, target)
            changes.append((source, staging))
            changes.extend(old_darwin_staging(resources, requested, lock))
            replace_transaction(changes)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    system = "windows" if sys.platform == "win32" else sys.platform
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "amd64"
    parser.add_argument("--target", default=f"{system}/{arch}")
    parser.add_argument("--cache", type=Path, default=ROOT / "build/mpv-bundles")
    parser.add_argument("--offline", action="store_true", default=os.environ.get("MPV_OFFLINE") == "1")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--fetch-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    targets = list(dict.fromkeys(args.target.split(",")))
    if any(target not in REQUEST_TARGETS for target in targets):
        parser.error("目标必须是受支持的 GOOS/GOARCH")
    if args.check and (args.force or args.fetch_only):
        parser.error("--check 不能与 --force 或 --fetch-only 同用")
    lock = load_lock()
    for target in targets:
        process(lock, target, args.cache, ROOT / "resources", args.offline, args.check, args.fetch_only, args.force)
        print(f"libmpv 校验通过: {target}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, zipfile.BadZipFile) as error:
        sys.exit(f"libmpv 准备失败: {error}")
