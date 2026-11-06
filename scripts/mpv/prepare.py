#!/usr/bin/env python3
"""准备随包 libmpv；仅构建已校验的固定源码，不执行资产内的安装程序。"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
LOCK = Path(__file__).with_name("sources.lock.json")
TARGETS = {f"{system}/{arch}" for system in ("darwin", "linux", "windows") for arch in ("amd64", "arm64")}
SYSTEM_DLLS = set("avicap32 bcryptprimitives d2d1 dwrite shcore usp10 wsock32 advapi32 avrt bcrypt cabinet cfgmgr32 combase comdlg32 crypt32 d3d11 d3d12 dcomp dinput8 dnsapi dwmapi dxgi dxva2 gdi32 imm32 iphlpapi kernel32 ksuser mf mfplat mfreadwrite mfuuid mmdevapi mpr msvcrt ncrypt netapi32 normaliz ntdll ole32 oleaut32 opengl32 powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi user32 userenv ucrtbase uxtheme version vfw32 winhttp wininet winmm winspool wintrust ws2_32 wtsapi32".split())


def digest(file):
    value = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def host_system():
    return "windows" if sys.platform == "win32" else sys.platform


def command_args(args):
    values = [value.as_posix() if isinstance(value, Path) else str(value) for value in args]
    if host_system() == "windows":
        values = [value.replace("\\", "/") for value in values]
    # 原生 MinGW Python/meson 不执行 shebang；仅 configure 通过已选择的 MSYS2 bash。
    if host_system() == "windows" and Path(values[0]).name == "configure":
        shell_path = subprocess.check_output(["cygpath", "-u", values[0]], text=True).strip()
        return ["bash", shell_path, *values[1:]]
    return values


def run(args, cwd=None, env=None, capture=False):
    print("+ " + " ".join(map(str, args)), flush=True)
    result = subprocess.run(command_args(args), cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None, check=False)
    if result.returncode:
        raise RuntimeError(f"命令失败 ({result.returncode}): {args}\n{result.stdout or ''}")
    return result.stdout or ""


def atomic_json(file, value):
    file = Path(file)
    temporary = file.with_suffix(file.suffix + ".partial")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(file)


def fetch(entry, cache, offline=False):
    url = urllib.parse.urlparse(entry["url"])
    if url.scheme != "https" or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
        raise ValueError("输入必须固定 HTTPS URL 和 SHA256")
    name = entry.get("filename", Path(url.path).name)
    if Path(name).name != name or name in ("", ".", ".."):
        raise ValueError("缓存文件名无效")
    cache.mkdir(parents=True, exist_ok=True)
    file = cache / name
    if file.exists() or file.is_symlink():
        if file.is_symlink() or not file.is_file() or digest(file) != entry["sha256"]:
            raise ValueError(f"缓存摘要不符（拒绝自动覆盖）: {file}")
        return file
    if offline:
        raise ValueError(f"离线缓存缺失: {file}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=name + "-", suffix=".partial", dir=cache)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        request = urllib.request.Request(entry["url"], headers={"User-Agent": "HE-Music-mpv-resources/1"})
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
            if urllib.parse.urlparse(response.url).scheme != "https":
                raise ValueError("拒绝非 HTTPS 下载重定向")
            shutil.copyfileobj(response, output)
        if digest(temporary) != entry["sha256"]:
            raise ValueError(f"下载摘要不符: {entry['url']}")
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)
    return file


def archive_path(name):
    parts = PurePosixPath(name)
    if not name or "\\" in name or ":" in name or parts.is_absolute() or ".." in parts.parts:
        raise ValueError(f"不安全解包路径: {name}")
    return parts


def extract(archive, destination, expected_root=None):
    """上游固定源包均无链接；拒绝链接而不依赖解包工具的跟随行为。"""
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ValueError("只允许解包到空隔离目录")
    seen = set()
    total = 0
    if zipfile.is_zipfile(archive):
        container = zipfile.ZipFile(archive)
        members = [(item.filename, item.is_dir(), item.file_size, item) for item in container.infolist()]
        unsafe = lambda item: (item.external_attr >> 16) & 0o170000 not in (0, 0o100000, 0o040000)
        opener = container.open
    else:
        container = tarfile.open(archive)
        members = [(item.name, item.isdir(), item.size, item) for item in container.getmembers()]
        unsafe = lambda item: not (item.isfile() or item.isdir())
        opener = container.extractfile
    with container:
        # 先完整检查，避免恶意归档留下半解包文件。
        for name, directory, size, item in members:
            relative = archive_path(name)
            if expected_root and (not relative.parts or relative.parts[0] != expected_root):
                raise ValueError(f"归档根目录不符: {name}")
            folded = str(relative).casefold()
            if folded in seen or unsafe(item):
                raise ValueError(f"归档包含重复路径、软链接或特殊文件: {name}")
            seen.add(folded)
            total += size
            if total > 2 * 1024**3:
                raise ValueError("归档解包大小超限")
        for name, directory, size, item in members:
            target = destination.joinpath(*archive_path(name).parts)
            if directory:
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with opener(item) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                mode = (item.external_attr >> 16) if isinstance(item, zipfile.ZipInfo) else item.mode
                target.chmod(0o755 if mode & 0o111 else 0o644)
                if isinstance(item, tarfile.TarInfo):
                    os.utime(target, (item.mtime, item.mtime))
    return destination / expected_root if expected_root else destination


def binary_arches(file):
    data = Path(file).read_bytes()
    machines = {0x8664: "amd64", 0xAA64: "arm64", 62: "amd64", 183: "arm64", 0x1000007: "amd64", 0x100000C: "arm64"}
    try:
        if data[:2] == b"MZ":
            offset = struct.unpack_from("<I", data, 0x3C)[0]
            if data[offset:offset + 4] != b"PE\0\0":
                raise ValueError("PE 签名无效")
            machine = struct.unpack_from("<H", data, offset + 4)[0]
        elif data[:4] == b"\x7fELF" and data[4:6] == b"\x02\x01":
            machine = struct.unpack_from("<H", data, 18)[0]
        elif data[:4] == b"\xcf\xfa\xed\xfe":
            machine = struct.unpack_from("<I", data, 4)[0]
        elif data[:4] == b"\xca\xfe\xba\xbe":
            count = struct.unpack_from(">I", data, 4)[0]
            if count != 2:
                raise ValueError("universal 必须包含两种架构")
            return {machines[struct.unpack_from(">I", data, 8 + index * 20)[0]] for index in range(count)}
        else:
            raise ValueError("非受支持的 64 位原生库")
        return {machines[machine]}
    except (IndexError, KeyError, struct.error) as error:
        raise ValueError("原生库头损坏或架构不受支持") from error


def pe_imports(file):
    data = Path(file).read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    count, optional_size = struct.unpack_from("<H12xH", data, pe + 6)
    optional = pe + 24
    if struct.unpack_from("<H", data, optional)[0] != 0x20B:
        raise ValueError("只接受 PE32+ DLL")
    sections = []
    for index in range(count):
        offset = optional + optional_size + index * 40
        size, address, raw_size, raw_offset = struct.unpack_from("<IIII", data, offset + 8)
        sections.append((address, max(size, raw_size), raw_offset))

    def rva(address):
        for start, size, offset in sections:
            if start <= address < start + size:
                return offset + address - start
        raise ValueError("PE import RVA 越界")

    imports = []
    # 同时检查普通和 delay-load 导入。
    for directory, stride, name_offset in ((1, 20, 12), (13, 32, 4)):
        address, size = struct.unpack_from("<II", data, optional + 112 + directory * 8)
        if not address:
            continue
        offset = rva(address)
        for position in range(offset, offset + size, stride):
            row = data[position:position + stride]
            if len(row) != stride:
                raise ValueError("PE import 表截断")
            if not any(row):
                break
            name = rva(struct.unpack_from("<I", row, name_offset)[0])
            end = data.find(b"\0", name, name + 256)
            if end < 0:
                raise ValueError("PE import 名称损坏")
            imports.append(data[name:end].decode("ascii").lower())
    return sorted(set(imports))


def validate_dependencies(directory, system):
    result = {}
    libraries = sorted(file for file in directory.iterdir() if file.suffix in (".dll", ".dylib") or ".so" in file.name)
    names = {file.name.lower() for file in libraries}
    for file in libraries:
        if system == "windows":
            deps = pe_imports(file)
            unknown = [dep for dep in deps if dep not in names and dep.removesuffix(".dll") not in SYSTEM_DLLS
                       and not dep.startswith(("api-ms-win-", "ext-ms-win-"))]
        elif system == "darwin":
            text = run(["otool", "-L", file], capture=True)
            deps = re.findall(r"^\s+(\S+) \(", text, re.M)
            unknown = [dep for dep in deps if not dep.startswith(("/usr/lib/", "/System/Library/"))
                       and not (dep.startswith("@loader_path/") and Path(dep).name.lower() in names)]
        else:
            text = run(["readelf", "-d", file], capture=True)
            deps = re.findall(r"\(NEEDED\).*?\[(.*?)\]", text)
            allowed = {"libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1", "libstdc++.so.6", "libgcc_s.so.1", "libpulse.so.0", "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1"}
            unknown = [dep for dep in deps if dep.lower() not in names and dep not in allowed]
            paths = re.findall(r"\((?:RUNPATH|RPATH)\).*?\[(.*?)\]", text)
            if any(part not in ("", "$ORIGIN") for value in paths for part in value.split(":")):
                raise ValueError(f"{file.name} 存在非随包 RPATH: {paths}")
        if unknown:
            raise ValueError(f"{file.name} 存在未随包或未声明的依赖: {unknown}")
        result[file.name] = deps
    if not libraries:
        raise ValueError("没有原生库")
    return result


def recipe_digest():
    value = hashlib.sha256(LOCK.read_bytes())
    value.update(Path(__file__).read_bytes())
    value.update(Path(__file__).with_name("smoke.py").read_bytes())
    return value.hexdigest()


def inventory(directory):
    files = {}
    for file in sorted(directory.rglob("*")):
        if file.is_symlink() or not (file.is_file() or file.is_dir()):
            raise ValueError(f"资源不得含链接或特殊文件: {file}")
        if file.is_file() and file != directory / "manifest.json":
            files[file.relative_to(directory).as_posix()] = {"sha256": digest(file), "size": file.stat().st_size}
    return files


def verify(directory, target, inspect=True):
    if directory.is_symlink():
        raise ValueError("资源目录不得是软链接")
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("recipeSHA256") != recipe_digest() or manifest.get("target") != target:
        raise ValueError(f"资源版本或构建配方已改变: {target}")
    if manifest.get("files") != inventory(directory):
        raise ValueError(f"资源文件摘要/清单不符: {target}")
    system, arch = target.split("/")
    name = {"darwin": "libmpv.2.dylib", "linux": "libmpv.so.2", "windows": "libmpv-2.dll"}[system]
    required = {"amd64", "arm64"} if arch == "universal" else {arch}
    if binary_arches(directory / name) != required:
        raise ValueError(f"资源架构不符: {target}")
    for file in directory.iterdir():
        if file.suffix in (".dll", ".dylib") or ".so" in file.name:
            if binary_arches(file) != required:
                raise ValueError(f"依赖库架构不符: {file.name}")
    if inspect and validate_dependencies(directory, system) != manifest["dependencies"]:
        raise ValueError("动态依赖与准备记录不符")
    return manifest


def write_manifest(directory, target, details):
    system, arch = target.split("/")
    dependencies = validate_dependencies(directory, system)
    atomic_json(directory / "manifest.json", {
        "schemaVersion": 1, "mpvVersion": "0.42.0", "clientAPI": "2.6", "target": target,
        "recipeSHA256": recipe_digest(), "dependencies": dependencies,
        "details": details, "files": inventory(directory),
    })
    return verify(directory, target)


def apply_coreaudio_fix(source):
    # 上游把 CoreAudio 使用的辅助函数放在 Cocoa 分支；音频构建只补入这个 C 文件。
    file = source / "meson.build"
    before = "if features['coreaudio']\n    dependencies += coreaudio\n"
    after = before + "    sources += files('osdep/utils-mac.c')\n"
    text = file.read_text()
    if text.count(before) != 1 or after in text:
        raise ValueError("固定 mpv CoreAudio 补丁上下文不符")
    file.write_text(text.replace(before, after), encoding="utf-8")
    return {"file": "meson.build", "before": before, "after": after, "resultSHA256": digest(file)}


def source_build(target, stage, cache, lock, offline, jobs):
    system, arch = target.split("/")
    host_arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "amd64"
    if system != host_system() or (system in ("linux", "windows") and arch != host_arch):
        raise ValueError("Linux/Windows 源构建需在对应架构原生运行；macOS 允许 SDK 交叉编译")
    if system == "windows":
        expected = "CLANGARM64" if arch == "arm64" else "CLANG64"
        if os.environ.get("MSYSTEM") != expected:
            raise ValueError(f"Windows {arch} 源构建必须使用 MSYS2 {expected}，不能混合 CRT/架构")
    if system == "linux" and tuple(map(int, platform.libc_ver()[1].split("."))) > tuple(map(int, lock["linuxGlibcBaseline"].split("."))):
        raise ValueError("本机 glibc 高于 2.35；请在 sources.lock.json 固定的 Ubuntu 22.04 容器中准备资源")
    tools = ["meson", "ninja", "make"]
    tools += ["clang", "clang++", "llvm-ar", "llvm-strip", "bash", "cygpath"] if system == "windows" else ["cc", "c++"]
    for tool in tools:
        if not shutil.which(tool):
            raise ValueError(f"缺少构建工具 {tool}；见 scripts/mpv/README.md")
    archives = {name: fetch(entry, cache, offline) for name, entry in lock["sources"].items()}
    work = stage / "work"
    sources = {name: extract(file, work / name, lock["sources"][name]["root"]) for name, file in archives.items()}
    prefix = (stage / "prefix").resolve()
    prefix.mkdir()
    env = dict(os.environ)
    # pkg-config 只允许本次前缀；Linux 另外明确允许发行版 libpulse 开发包。
    env.update(PKG_CONFIG_PATH="", PKG_CONFIG_LIBDIR=(prefix / "lib/pkgconfig").as_posix(),
               CFLAGS="-O2 -fPIC", CXXFLAGS="-O2 -fPIC", LDFLAGS="", SOURCE_DATE_EPOCH="1793836800")
    if system == "darwin":
        apple_arch = "arm64" if arch == "arm64" else "x86_64"
        env.update(CC=f"clang -arch {apple_arch}", CXX=f"clang++ -arch {apple_arch}",
                   MACOSX_DEPLOYMENT_TARGET="11.0")
        env["CFLAGS"] += f" -arch {apple_arch} -mmacosx-version-min=11.0"
        env["CXXFLAGS"] += f" -arch {apple_arch} -mmacosx-version-min=11.0"
        env["LDFLAGS"] = f"-arch {apple_arch} -mmacosx-version-min=11.0"
    elif system == "linux":
        triplet = "aarch64-linux-gnu" if arch == "arm64" else "x86_64-linux-gnu"
        env["PKG_CONFIG_LIBDIR"] += f":/usr/lib/{triplet}/pkgconfig:/usr/share/pkgconfig"
    else:
        env.update(CC="clang", CXX="clang++", AR="llvm-ar", RANLIB="llvm-ranlib",
                   CFLAGS="-O2", CXXFLAGS="-O2", LDFLAGS="-static -static-libgcc -static-libstdc++")
        # make 使用 MSYS2 shell；不继承 Git Bash/Visual Studio 的工具配置。
        env["SHELL"] = run(["cygpath", "-u", shutil.which("bash")], capture=True).strip()
    commands = []

    def execute(args, cwd=None, custom_env=None):
        effective = command_args(args)
        commands.append(effective)
        return run(effective, cwd, custom_env or env)

    # pkgconf 是构建机工具，不能随目标架构交叉编译。
    tool_env = {**env, "CC": "clang" if system == "windows" else "cc", "CXX": "clang++" if system == "windows" else "c++", "CFLAGS": "-O2", "CXXFLAGS": "-O2", "LDFLAGS": ""}
    execute([sources["pkgconf"] / "configure", f"--prefix={prefix}", "--disable-shared"], sources["pkgconf"], tool_env)
    execute(["make", f"-j{jobs}"], sources["pkgconf"], tool_env)
    execute(["make", "install"], sources["pkgconf"], tool_env)
    cross_options = []
    if system == "windows":
        pkgconf = prefix / "bin/pkgconf.exe"
        env["PKG_CONFIG"] = pkgconf.as_posix()
        native = stage / "windows-native.ini"
        native.write_text(
            "[binaries]\nc = 'clang'\ncpp = 'clang++'\nar = 'llvm-ar'\nstrip = 'llvm-strip'\n"
            + "pkg-config = ['" + pkgconf.as_posix() + "', '--static']\n", encoding="utf-8")
        cross_options = ["--native-file", native]
    else:
        env["PKG_CONFIG"] = str(prefix / "bin/pkgconf")
        wrapper = prefix / "bin/mpv-pkg-config"
        wrapper.write_text('#!/bin/sh\nexec "' + str(prefix / "bin/pkgconf") + '" --static "$@"\n')
        wrapper.chmod(0o755)
        env["PKG_CONFIG"] = str(wrapper)
    ffmpeg_cross = []
    if system == "windows":
        ffmpeg_cross = ["--target-os=mingw32", "--arch=" + ("aarch64" if arch == "arm64" else "x86_64"),
                        "--cc=clang", "--cxx=clang++", "--ar=llvm-ar", "--ranlib=llvm-ranlib", "--nm=llvm-nm",
                        "--pkg-config=" + env["PKG_CONFIG"], "--pkg-config-flags=--static"]
    if system == "darwin" and arch != host_arch:
        cross = stage / "cross.ini"
        cross.write_text(
            "[binaries]\nc = ['clang', '-arch', '" + apple_arch + "']\n"
            "cpp = ['clang++', '-arch', '" + apple_arch + "']\n"
            "objc = ['clang', '-arch', '" + apple_arch + "']\n"
            "objcpp = ['clang++', '-arch', '" + apple_arch + "']\n"
            "ar = 'ar'\nstrip = 'strip'\npkg-config = '" + str(wrapper) + "'\n"
            "[host_machine]\nsystem = 'darwin'\ncpu_family = '" + apple_arch + "'\n"
            "cpu = '" + apple_arch + "'\nendian = 'little'\n"
            "[properties]\nneeds_exe_wrapper = true\n", encoding="utf-8")
        cross_options = ["--cross-file", cross]
        ffmpeg_cross = ["--enable-cross-compile", "--target-os=darwin", "--arch=" + apple_arch]
    def meson(name, options):
        build = work / (name + "-build")
        execute(["meson", "setup", build, sources[name], f"--prefix={prefix}", "--libdir=lib",
                 "--buildtype=release", "--default-library=static", "--wrap-mode=nodownload",
                 "-Db_staticpic=true", "-Db_lundef=true", "-Dauto_features=disabled", *cross_options, *options])
        execute(["meson", "compile", "-C", build, f"-j{jobs}"])
        execute(["meson", "install", "-C", build])

    # 原生初始化会显式关闭 Lua 内建脚本；需保留对应选项，不能在编译时移除。
    lua = sources["lua"]
    execute(["make", "-C", lua / "src", "liblua.a", "CC=" + env.get("CC", "cc"),
             "MYCFLAGS=" + env["CFLAGS"] + (" -DLUA_USE_WINDOWS" if system == "windows" else ""),
             "AR=" + ("llvm-ar rcu" if system == "windows" else "ar rcu"),
             "RANLIB=" + env.get("RANLIB", "ranlib")], lua)
    shutil.copy2(lua / "src/liblua.a", prefix / "lib/liblua.a")
    shutil.copytree(lua / "src", prefix / "include/lua5.2", ignore=shutil.ignore_patterns("*.c", "*.o", "*.a", "Makefile"))
    (prefix / "lib/pkgconfig/lua52.pc").write_text(
        f"prefix={prefix.as_posix()}\nlibdir=${{prefix}}/lib\nincludedir=${{prefix}}/include/lua5.2\n"
        "Name: Lua\nDescription: 固定 Lua 5.2\nVersion: 5.2.4\n"
        "Libs: -L${libdir} -llua" + ("" if system == "windows" else " -lm") + "\nCflags: -I${includedir}\n", encoding="utf-8")
    meson("freetype", ["-Dharfbuzz=disabled", "-Dzlib=disabled"])
    meson("fribidi", ["-Ddocs=false", "-Dbin=false", "-Dtests=false"])
    meson("harfbuzz", ["-Dfreetype=enabled", "-Dtests=disabled", "-Dutilities=disabled"])
    meson("libass", ["-Drequire-system-font-provider=false"])
    shutil.copytree(sources["fast_float"] / "include/fast_float", sources["libplacebo"] / "3rdparty/fast_float/include/fast_float", dirs_exist_ok=True)
    shutil.copytree(sources["vulkan-headers"] / "include", prefix / "include", dirs_exist_ok=True)
    env["CFLAGS"] += f' -I"{(prefix / "include").as_posix()}"'
    env["CXXFLAGS"] += f' -I"{(prefix / "include").as_posix()}"'
    meson("libplacebo", ["-Ddemos=false", "-Dtests=false", "-Dbench=false", "-Dfuzz=false"])
    ffmpeg = sources["ffmpeg"]
    # 保留所有内建音频 decoder（包括 APE/DSD），禁用外部自动探测、视频/硬件与 GPL。
    execute([ffmpeg / "configure", f"--prefix={prefix}", "--libdir=" + str(prefix / "lib"),
             "--enable-static", "--disable-shared", "--enable-pic", "--disable-autodetect",
             "--disable-gpl", "--disable-nonfree", "--disable-programs", "--disable-doc",
             "--disable-debug", "--enable-network", "--disable-avdevice",
             "--disable-encoders", "--disable-muxers", "--disable-hwaccels", "--disable-videotoolbox",
             "--disable-audiotoolbox", "--disable-x86asm", "--disable-v4l2-m2m",
             "--disable-vaapi", "--disable-vdpau", "--disable-vulkan",
             "--disable-decoders", "--enable-decoder=" + ",".join(AUDIO_DECODERS),
             "--disable-demuxers", "--enable-demuxer=ape,dsf,iff,flac,wav,aiff,mp3,aac,ogg,mov,matroska,asf,wv,tta,tak,mpc,mpc8,amr,ac3,eac3,dts",
             "--disable-protocols", "--enable-protocol=file,http,tcp,pipe,crypto",
             "--disable-filters", "--enable-filter=aresample,aformat,anull,atempo,volume,pan,abuffer,abuffersink",
             "--extra-cflags=" + env["CFLAGS"], "--extra-ldflags=" + env["LDFLAGS"], *ffmpeg_cross], ffmpeg)
    execute(["make", f"-j{jobs}"], ffmpeg)
    execute(["make", "install"], ffmpeg)
    # 静态 pkg-config 将闭包完整地链接进唯一的 libmpv。
    if system != "windows":
        env["LDFLAGS"] += " -lc++" if system == "darwin" else " -lstdc++"
    adjustments = [apply_coreaudio_fix(sources["mpv"])] if system == "darwin" else []
    meson("mpv", ["--default-library=shared", "-Dgpl=false", "-Dcplayer=false", "-Dlibmpv=true",
                  "-Dbuild-date=false", "-Dlua=lua52", "-Dgl=disabled", "-Dmanpage-build=disabled",
                  *(["-Dcoreaudio=enabled"] if system == "darwin" else ["-Dwasapi=enabled"] if system == "windows" else ["-Dpulse=enabled"])])
    output = stage / "mpv"
    output.mkdir()
    filename = "libmpv.2.dylib" if system == "darwin" else "libmpv-2.dll" if system == "windows" else "libmpv.so.2"
    library = (prefix / ("bin" if system == "windows" else "lib") / filename).resolve()
    shutil.copy2(library, output / filename)
    if system == "darwin":
        execute(["install_name_tool", "-id", "@loader_path/libmpv.2.dylib", output / filename])
        execute(["codesign", "--force", "--sign", "-", output / filename])
        execute(["codesign", "--verify", "--strict", output / filename])
    else:
        execute(["llvm-strip" if system == "windows" else "strip", "--strip-unneeded", output / filename])
    materials(output, sources, archives, lock)
    config = output / "build-config"
    config.mkdir()
    for name in ("freetype", "fribidi", "harfbuzz", "libass", "libplacebo", "mpv"):
        folder = config / name
        folder.mkdir()
        shutil.copy2(work / (name + "-build") / "meson-info/intro-buildoptions.json", folder / "options.json")
        shutil.copy2(work / (name + "-build") / "meson-logs/meson-log.txt", folder / "meson-log.txt")
    if system == "windows":
        # 记录实际 runner/CRT/工具链，不能将安装包版本冒充对应源码闭包。
        toolchain = {
            "msystem": os.environ["MSYSTEM"],
            "runnerImage": os.environ.get("ImageVersion", "unknown"),
            "compiler": run(["clang", "--version"], capture=True),
            "packages": run(["pacman", "-Q"], capture=True),
            "packageMetadata": run(["pacman", "-Qi"], capture=True),
            "runtimeSourceStatus": "pending：需按实际静态链接的 MinGW/LLVM 运行库核对对应源码和许可证；不能公开发布",
        }
        shutil.copy2(native, config / "windows-native.ini")
        msys_prefix = Path(os.environ["MINGW_PREFIX"])
        # MINGW_PREFIX 是 /clang64 等 MSYS 路径；转为原生 Python 可访问的路径。
        msys_prefix = Path(run(["cygpath", "-m", str(msys_prefix)], capture=True).strip())
        runtime_licenses = msys_prefix / "share/licenses"
        if not runtime_licenses.is_dir():
            raise ValueError("MSYS2 工具链许可证缺失")
        shutil.copytree(runtime_licenses, output / "licenses/windows-toolchain")
    else:
        toolchain = {"compiler": run([env.get("CC", "cc").split()[0], "--version"], capture=True)}
    atomic_json(config / "toolchain.json", toolchain)
    shutil.copy2(ffmpeg / "config.h", config / "ffmpeg-config.h")
    shutil.copy2(ffmpeg / "ffbuild/config.mak", config / "ffmpeg-config.mak")
    shutil.copy2(work / "mpv-build/meson-info/intro-buildoptions.json", config / "mpv-options.json")
    atomic_json(config / "commands.json", commands)
    atomic_json(config / "mpv-source-adjustments.json", adjustments)
    system_packages = run(["dpkg-query", "-W", "-f=${Package}=${Version}\\n", "libc6", "libpulse0", "libstdc++6"], capture=True) if system == "linux" else toolchain["packages"] if system == "windows" else "Apple SDK / macOS 系统框架"
    if system == "linux":
        baseline = lock["linuxGlibcBaseline"]
        required = re.findall(r"GLIBC_(\d+\.\d+)", run(["readelf", "--version-info", output / filename], capture=True))
        if required and max(tuple(map(int, item.split("."))) for item in required) > tuple(map(int, baseline.split("."))):
            raise ValueError(f"libmpv 的 ELF 符号版本超过 glibc {baseline} 基线")
    return output, {"kind": "source", "host": platform.platform(), "commands": "build-config/commands.json",
                    "ffmpeg": "8.0.1", "audioOnly": True, "toolchain": "build-config/toolchain.json",
                    "correspondingSourceStatus": "pending-toolchain-runtime-review" if system == "windows" else "project-fixed-sources", "systemPackages": system_packages,
                    "linuxBuildImage": lock["linuxBuildImage"] if system == "linux" else None}


AUDIO_DECODERS = ["aac", "aac_fixed", "aac_latm", "ac3", "alac", "als", "amrnb", "amrwb", "ape",
                  "atrac1", "atrac3", "atrac3al", "atrac3p", "atrac3pal", "cook", "dca", "dolby_e", "dsd_lsbf",
                  "dsd_lsbf_planar", "dsd_msbf", "dsd_msbf_planar", "eac3", "flac", "g723_1", "g729", "gsm",
                  "gsm_ms", "iac", "imc", "mace3", "mace6", "mlp", "mp1", "mp1float", "mp2", "mp2float",
                  "mp3", "mp3float", "mp3adu", "mp3adufloat", "mp3on4", "mp3on4float", "mpc7", "mpc8",
                  "nellymoser", "opus", "pcm*", "adpcm*", "qcelp", "qdm2", "qdmc", "ralf", "real_144",
                  "real_288", "s302m", "shorten", "sipr", "speex", "tak", "truehd", "truespeech", "tta",
                  "twinvq", "vorbis", "wavpack", "wmalossless", "wmapro", "wmav1", "wmav2", "wmavoice"]


def materials(output, sources, archives, lock):
    licenses = output / "licenses"
    licenses.mkdir()
    for name, source in sources.items():
        folder = licenses / name
        folder.mkdir()
        for relative in lock["sources"][name]["licenses"]:
            shutil.copy2(source / relative, folder / Path(relative).name)
    source_dir = output / "sources"
    source_dir.mkdir()
    for name, archive in archives.items():
        shutil.copy2(archive, source_dir / archive.name)
    shutil.copy2(LOCK, output / "sources.lock.json")
    shutil.copy2(Path(__file__), output / "prepare.py")
    shutil.copy2(Path(__file__).with_name("smoke.py"), output / "smoke.py")
    (licenses / "说明.txt").write_text(
        "本目录包含实际构建的库许可证；sources 保存对应源码归档，sources.lock.json 固定来源及摘要。\n"
        "mpv/FFmpeg/libplacebo/FriBidi 使用 LGPL；FreeType 使用 FTL；libass 与 HarfBuzz 使用各自宽松许可证。\n"
        "libmpv 为独立动态库，可替换；复现构建使用 prepare.py 及同版本仓库构建脚本。\n"
        "Windows 使用本项目固定源码音频配方；工具链及运行库来源验收状态见 manifest.json 和 build-config。\n",
        encoding="utf-8")




def prepare(target, cache, offline=False, jobs=4, force=False):
    if target not in TARGETS:
        raise ValueError(f"不支持的目标: {target}")
    destination = cache / "prepared" / target.replace("/", "-") / "mpv"
    if destination.exists() and not force:
        verify(destination, target, inspect=target.startswith("windows/") or target.split("/")[0] == sys.platform)
        print(f"已验证并复用: {destination}")
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    lock = json.loads(LOCK.read_text())
    started_recipe = recipe_digest()
    with tempfile.TemporaryDirectory(prefix="mpv-build-", dir=cache) as temporary:
        stage = Path(temporary)
        output, details = source_build(target, stage, cache, lock, offline, jobs)
        if recipe_digest() != started_recipe:
            raise ValueError("构建期间配方发生变化，拒绝记录为新配方产物；请重试")
        host_arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "amd64"
        host_system = "windows" if sys.platform == "win32" else sys.platform
        if target == f"{host_system}/{host_arch}":
            run([sys.executable, Path(__file__).with_name("smoke.py"), "--resources", output,
                 "--output", output / "validation.json"])
            details["runtimeSmoke"] = "validation.json；ao=null，不代表可闻发声"
        else:
            details["runtimeSmoke"] = "未在对应架构运行；仅完成文件架构与依赖静态检查"
        write_manifest(output, target, details)
        # 只在完整验证成功后替换；失败保留上次成功产物。
        replace_tree(output, destination)
    return destination


def universal(cache, offline, jobs, force):
    if sys.platform != "darwin":
        raise ValueError("macOS universal 需在 macOS 准备")
    halves = [prepare("darwin/" + arch, cache, offline, jobs, force) for arch in ("arm64", "amd64")]
    destination = cache / "prepared/darwin-universal/mpv"
    if destination.exists() and not force:
        verify(destination, "darwin/universal")
        return destination
    with tempfile.TemporaryDirectory(prefix="mpv-universal-", dir=cache) as temporary:
        output = Path(temporary) / "mpv"
        shutil.copytree(halves[0], output)
        (output / "manifest.json").unlink()
        run(["lipo", "-create", *[half / "libmpv.2.dylib" for half in halves], "-output", output / "libmpv.2.dylib"])
        run(["codesign", "--force", "--sign", "-", output / "libmpv.2.dylib"])
        run(["codesign", "--verify", "--strict", output / "libmpv.2.dylib"])
        shutil.copytree(halves[1] / "build-config", output / "build-config-amd64")
        write_manifest(output, "darwin/universal", {"kind": "universal", "halves": [digest(half / "manifest.json") for half in halves]})
        destination.parent.mkdir(parents=True, exist_ok=True)
        replace_tree(output, destination)
    return destination


def replace_tree(source, destination):
    backup = destination.with_name(destination.name + ".previous")
    if destination.is_symlink() or backup.exists() or backup.is_symlink():
        raise ValueError(f"目标含软链接或未完成的替换: {destination}")
    if destination.exists():
        destination.rename(backup)
    try:
        shutil.move(source, destination)
    except BaseException:
        if backup.exists():
            backup.rename(destination)
        raise
    shutil.rmtree(backup, ignore_errors=True)


def stage_resources(prepared, target):
    destination = ROOT / "resources" / target.replace("/", "-") / "mpv"
    verify(prepared, target, inspect=target.startswith("windows/") or target.split("/")[0] == sys.platform)
    if destination.parent.is_symlink() or destination.parent.parent.is_symlink():
        raise ValueError("资源祖先目录不得是软链接")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name("mpv.next")
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(prepared, temporary)
    replace_tree(temporary, destination)
    if target == "darwin/universal":
        # mygo 会合并两种架构的同名文本；清除本工具旧的独立架构资源，避免清单冲突。
        for arch in ("arm64", "amd64"):
            previous = ROOT / "resources" / ("darwin-" + arch) / "mpv"
            if previous.is_symlink() or previous.parent.is_symlink():
                raise ValueError(f"拒绝清理软链接资源目录: {previous}")
            if previous.exists():
                data = json.loads((previous / "manifest.json").read_text())
                if data.get("target") != "darwin/" + arch or data.get("schemaVersion") != 1:
                    raise ValueError(f"拒绝清理非本工具资源: {previous}")
                shutil.rmtree(previous)
            if previous.parent.is_dir() and not any(previous.parent.iterdir()):
                previous.parent.rmdir()
    print(f"随包资源: {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default=f"{sys.platform if sys.platform != 'win32' else 'windows'}/{'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'amd64'}")
    parser.add_argument("--cache", type=Path, default=ROOT / "build/mpv-cache")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--check", action="store_true", help="仅验证已准备并已接入 mygo 的资源")
    parser.add_argument("--fetch-only", action="store_true", help="下载并验证全部固定输入，不编译")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 2, 8))
    args = parser.parse_args()
    targets = args.target.split(",")
    if not targets or any(target not in TARGETS | {"darwin/universal"} for target in targets):
        raise ValueError("目标必须是受支持的 GOOS/GOARCH")
    args.cache = args.cache.resolve()
    args.cache.mkdir(parents=True, exist_ok=True)
    if args.fetch_only:
        lock = json.loads(LOCK.read_text())
        for entry in lock["sources"].values():
            fetch(entry, args.cache, args.offline)
        print("全部固定库源码输入摘要已验证")
        return
    for target in targets:
        staged = ROOT / "resources" / target.replace("/", "-") / "mpv"
        if staged.exists() and not args.force and not args.check:
            verify(staged, target, inspect=target.startswith("windows/") or target.split("/")[0] == sys.platform)
            print(f"已校验并复用随包资源: {target}")
            continue
        if args.check:
            verify(ROOT / "resources" / target.replace("/", "-") / "mpv", target,
                   inspect=target.startswith("windows/") or target.split("/")[0] == sys.platform)
            print(f"随包资源校验通过: {target}")
        else:
            prepared = universal(args.cache, args.offline, args.jobs, args.force) if target == "darwin/universal" else prepare(target, args.cache, args.offline, args.jobs, args.force)
            stage_resources(prepared, target)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, tarfile.TarError, zipfile.BadZipFile, KeyError, struct.error) as error:
        print(f"libmpv 资源准备失败: {error}", file=sys.stderr)
        sys.exit(1)
