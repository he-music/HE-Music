#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查 WebKitGTK 合成前置条件；仅在独立子进程中选择软件 EGL，不修改系统配置。"""

from __future__ import print_function

import sys

if sys.version_info < (3, 7):
    sys.stderr.write("This diagnostic requires Python 3.7 or newer. Run: python3 linux-egl.py\n")
    sys.exit(2)

import argparse
import ctypes
import json
import os
from pathlib import Path
import subprocess


class GError(ctypes.Structure):
    _fields_ = [("domain", ctypes.c_uint), ("code", ctypes.c_int), ("message", ctypes.c_char_p)]


def function(library, name, result, arguments):
    value = getattr(library, name)
    value.restype = result
    value.argtypes = arguments
    return value


def probe():
    keys = [
        "DISPLAY", "WAYLAND_DISPLAY", "GDK_BACKEND", "GDK_GL", "GDK_DEBUG",
        "LIBGL_ALWAYS_SOFTWARE", "LIBGL_ALWAYS_INDIRECT", "EGL_PLATFORM",
        "WEBKIT_SKIA_ENABLE_CPU_RENDERING", "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE", "WEBKIT_FORCE_COMPOSITING_MODE",
        "WEBKIT_FORCE_DMABUF_RENDERER",
        "WEBKIT_DMABUF_RENDERER_FORCE_SHM", "__EGL_VENDOR_LIBRARY_FILENAMES",
        "__GLX_VENDOR_LIBRARY_NAME",
    ]
    report = {"environment": {key: os.environ.get(key) for key in keys}}
    try:
        egl = ctypes.CDLL("libEGL.so.1")
        query = function(egl, "eglQueryString", ctypes.c_char_p, [ctypes.c_void_p, ctypes.c_int])
        extensions = (query(None, 0x3055) or b"").decode(errors="replace")
        report["eglClientExtensions"] = extensions
        report["webkitTransportSupported"] = any(
            name in extensions.split()
            for name in ["EGL_KHR_platform_gbm", "EGL_MESA_platform_surfaceless"]
        )
    except (OSError, AttributeError) as error:
        report["eglError"] = str(error)

    try:
        gtk = ctypes.CDLL("libgtk-3.so.0")
        initialize = function(gtk, "gtk_init_check", ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p])
        report["gtkDisplayAvailable"] = bool(initialize(None, None))
        if report["gtkDisplayAvailable"]:
            new_window = function(gtk, "gtk_window_new", ctypes.c_void_p, [ctypes.c_int])
            realize = function(gtk, "gtk_widget_realize", None, [ctypes.c_void_p])
            get_window = function(gtk, "gtk_widget_get_window", ctypes.c_void_p, [ctypes.c_void_p])
            create_context = function(gtk, "gdk_window_create_gl_context", ctypes.c_void_p,
                                      [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(GError))])
            destroy = function(gtk, "gtk_widget_destroy", None, [ctypes.c_void_p])
            unref = function(gtk, "g_object_unref", None, [ctypes.c_void_p])
            free_error = function(gtk, "g_error_free", None, [ctypes.POINTER(GError)])
            window = new_window(1)
            try:
                realize(window)
                error = ctypes.POINTER(GError)()
                context = create_context(get_window(window), ctypes.byref(error))
                report["gtkGLContextAvailable"] = bool(context)
                if context:
                    unref(context)
                if error:
                    report["gtkGLContextError"] = error.contents.message.decode(errors="replace")
                    free_error(error)
            finally:
                destroy(window)

            for name in ["libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.0.so.37"]:
                try:
                    webkit = ctypes.CDLL(name)
                    report["webkitLibrary"] = name
                    break
                except OSError:
                    continue
            else:
                raise OSError("未找到 WebKitGTK 4.1 或 4.0")
            report["webkitVersion"] = ".".join(str(function(
                webkit, "webkit_get_" + part + "_version", ctypes.c_uint, []
            )()) for part in ["major", "minor", "micro"])
            settings = function(webkit, "webkit_settings_new", ctypes.c_void_p, [])()
            get_policy = function(webkit, "webkit_settings_get_hardware_acceleration_policy",
                                  ctypes.c_int, [ctypes.c_void_p])
            set_policy = function(webkit, "webkit_settings_set_hardware_acceleration_policy",
                                  None, [ctypes.c_void_p, ctypes.c_int])
            try:
                report["policyBefore"] = get_policy(settings)
                set_policy(settings, 1)
                report["policyAfterAlways"] = get_policy(settings)
            finally:
                unref(settings)
    except (OSError, AttributeError) as error:
        report["gtkOrWebkitError"] = str(error)

    try:
        libraries = set()
        for line in Path("/proc/self/maps").read_text().splitlines():
            fields = line.split(maxsplit=5)
            if len(fields) != 6 or not fields[5].startswith("/"):
                continue
            name = Path(fields[5]).name
            if name.startswith(("libEGL", "libGLX", "libGLdispatch", "libwebkit2gtk", "libgtk-3")):
                libraries.add(fields[5])
        report["loadedGraphicsLibraries"] = sorted(libraries)
    except OSError as error:
        report["libraryMapError"] = str(error)
    print(json.dumps(report, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path, default=Path("linux-egl-report.json"))
    args = parser.parse_args()
    if args.probe:
        probe()
        return
    if not sys.platform.startswith("linux"):
        parser.error("请在出现拖影的 Linux 图形会话中运行")
    environment = dict(os.environ)
    environment.update({
        "LIBGL_ALWAYS_SOFTWARE": "1",
        "WEBKIT_SKIA_ENABLE_CPU_RENDERING": "1",
        "WEBKIT_DISABLE_DMABUF_RENDERER": "0",
        "WEBKIT_DISABLE_COMPOSITING_MODE": "0",
    })
    environment.pop("WEBKIT_FORCE_DMABUF_RENDERER", None)
    environment.pop("WEBKIT_DMABUF_RENDERER_FORCE_SHM", None)
    variants = {
        "software_gl": environment,
        "software_shm": dict(environment, WEBKIT_FORCE_DMABUF_RENDERER="1",
                             WEBKIT_DMABUF_RENDERER_FORCE_SHM="1"),
    }
    mesa = Path("/usr/share/glvnd/egl_vendor.d/50_mesa.json")
    if mesa.is_file():
        variants["software_mesa"] = dict(
            environment,
            __EGL_VENDOR_LIBRARY_FILENAMES=str(mesa),
            __GLX_VENDOR_LIBRARY_NAME="mesa",
        )
    report = {"mesaVendorFileExists": mesa.is_file(), "variants": {}}
    for name, child_environment in variants.items():
        try:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--probe"],
                env=child_environment, capture_output=True, text=True, timeout=30, check=False,
            )
            try:
                observation = json.loads(result.stdout)
            except ValueError:
                observation = {"output": result.stdout}
            observation.update({"exitCode": result.returncode, "stderr": result.stderr})
        except subprocess.TimeoutExpired:
            observation = {"timedOut": True}
        report["variants"][name] = observation
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    print("报告已保存：" + str(args.output.resolve()))


if __name__ == "__main__":
    main()
