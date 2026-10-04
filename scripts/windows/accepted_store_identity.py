"""Read-only encoding of the native accepted-store path binding.

Keep aligned with accepted_store_binding_for_root in fullmag-session. Windows
uses the kernel's normalized DOS path, including its verbatim prefix, and the
empty join suffix retained by the native resolver.
"""
import ctypes
import hashlib
import os
from pathlib import Path

from windows import development_handoff as capsule


def store_binding(root):
    root = capsule._validate_runtime_root(root)
    if os.name == "nt":
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        create = kernel.CreateFileW
        create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                           wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        create.restype = wintypes.HANDLE
        final = kernel.GetFinalPathNameByHandleW
        final.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
        final.restype = wintypes.DWORD
        close = kernel.CloseHandle
        close.argtypes = [wintypes.HANDLE]
        close.restype = wintypes.BOOL
        # Existing directory, metadata access only; no creation or elevation.
        handle = create(str(root), 0x80, 7, None, 3, 0x02000000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise capsule.HandoffError("Cannot open accepted-store identity")
        try:
            required = final(handle, None, 0, 0)
            if not required or required > 32768:
                raise capsule.HandoffError("Cannot resolve accepted-store identity")
            buffer = ctypes.create_unicode_buffer(required + 1)
            length = final(handle, buffer, len(buffer), 0)
            if not length or length >= len(buffer):
                raise capsule.HandoffError("Accepted-store identity changed while resolving")
            path = buffer.value
            if not path.startswith("\\\\?\\"):
                raise capsule.HandoffError("Unsupported accepted-store Windows identity")
            encoded = (path.rstrip("\\") + "\\").encode("utf-16-le", errors="surrogatepass")
        finally:
            if not close(handle):
                raise capsule.HandoffError("Cannot close accepted-store identity handle")
    elif os.name == "posix":
        encoded = os.fsencode(str(Path(root).resolve()).rstrip("/") + "/")
    else:
        raise capsule.HandoffError("Unsupported accepted-store identity platform")
    return hashlib.sha256(b"fullmag.accepted-store-binding.v1\0" + encoded).hexdigest()
