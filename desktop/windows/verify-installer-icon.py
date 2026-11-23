"""Verify the primary icon Windows displays for a finished NSIS setup executable."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import struct


def icon_frames(ico):
    data = ico.read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", data)
    if (reserved, kind) != (0, 1) or count == 0:
        raise ValueError(f"Invalid ICO header: {ico}")
    frames = []
    for i in range(count):
        width, height, _, _, _, _, size, offset = struct.unpack_from("<BBBBHHII", data, 6 + 16 * i)
        content = data[offset:offset + size]
        if len(content) != size:
            raise ValueError("Truncated source icon frame")
        frames.append((width or 256, height or 256, hashlib.sha256(content).hexdigest()))
    return sorted(frames)


def setup_frames(exe):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = wintypes.HANDLE
    ptr = ctypes.c_void_p
    enum_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, handle, ptr, ptr, ctypes.c_ssize_t)
    for name, args, result in (
        ("LoadLibraryExW", [wintypes.LPCWSTR, handle, wintypes.DWORD], handle),
        ("EnumResourceNamesW", [handle, ptr, enum_callback, ctypes.c_ssize_t], wintypes.BOOL),
        ("FindResourceW", [handle, ptr, ptr], handle),
        ("SizeofResource", [handle, handle], wintypes.DWORD),
        ("LoadResource", [handle, handle], handle),
        ("LockResource", [handle], ptr),
        ("FreeLibrary", [handle], wintypes.BOOL),
    ):
        function = getattr(kernel, name)
        function.argtypes = args
        function.restype = result

    # Inspect the PE as data only. Setup, uninstaller and packaged application never execute.
    module = kernel.LoadLibraryExW(str(exe.resolve()), None, 2)
    if not module:
        raise ctypes.WinError(ctypes.get_last_error())

    def resource(kind, name):
        label = ctypes.c_wchar_p(name) if isinstance(name, str) else None
        resource_id = ctypes.cast(label, ptr) if label is not None else name
        info = kernel.FindResourceW(module, resource_id, kind)
        if not info:
            raise ctypes.WinError(ctypes.get_last_error())
        size = kernel.SizeofResource(module, info)
        data = kernel.LockResource(kernel.LoadResource(module, info))
        if not size or not data:
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.string_at(data, size)

    groups = []

    @enum_callback
    def remember_group(_module, _kind, name, _param):
        groups.append(name if name <= 65535 else ctypes.wstring_at(name))
        return True

    try:
        if not kernel.EnumResourceNamesW(module, 14, remember_group, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        group = groups[0]  # Shell icon index zero, not a later matching icon group.
        directory = resource(14, group)
        _, kind, count = struct.unpack_from("<HHH", directory)
        if kind != 1 or not count:
            raise ValueError("Invalid primary RT_GROUP_ICON")
        frames = []
        for i in range(count):
            w, h, _, _, _, _, size, icon_id = struct.unpack_from("<BBBBHHIH", directory, 6 + 14 * i)
            pixels = resource(3, icon_id)
            if len(pixels) != size:
                raise ValueError("Truncated setup icon frame")
            frames.append((w or 256, h or 256, hashlib.sha256(pixels).hexdigest()))
        return group, sorted(frames)
    finally:
        kernel.FreeLibrary(module)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ico", type=Path)
    parser.add_argument("exe", type=Path)
    args = parser.parse_args()
    expected = icon_frames(args.ico)
    group_id, actual = setup_frames(args.exe)
    match = actual == expected
    print(json.dumps({"file": args.exe.name, "iconGroup": group_id, "frames": actual, "match": match}))
    if not match:
        raise SystemExit("Setup's primary icon group does not match every brand ICO frame.")
