"""Explicit GNU libm norm binding; not a producer-provenance certificate."""
import ctypes
import hashlib
import math
from pathlib import Path
import platform
import re
import sys

MAX_LIBRARY_BYTES = 16 * 1024**2


class _DlInfo(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("base", ctypes.c_void_p),
                ("symbol", ctypes.c_char_p), ("address", ctypes.c_void_p)]


def _library_digest(path):
    if not path.is_file() or path.stat().st_size > MAX_LIBRARY_BYTES:
        raise ValueError("invalid matched libm library size/type")
    with path.open("rb") as stream:
        data = stream.read(MAX_LIBRARY_BYTES + 1)
    if not data or len(data) > MAX_LIBRARY_BYTES:
        raise ValueError("invalid matched libm library size/type")
    return hashlib.sha256(data).hexdigest()


class MatchedLibmHypot:
    def __init__(self, library, expected_sha256):
        path = Path(library)
        if (not path.is_absolute() or not isinstance(expected_sha256, str)
                or re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None):
            raise ValueError("matched libm requires an absolute library and explicit lowercase digest")
        if sys.platform != "linux" or platform.machine() != "x86_64":
            raise ValueError("unsupported matched libm runtime; GNU/Linux x86-64 required")
        path = path.resolve(strict=True)
        if _library_digest(path) != expected_sha256:
            raise ValueError("matched libm library hash mismatch")
        try:
            self._library = ctypes.CDLL(str(path), mode=ctypes.RTLD_LOCAL)
            loader = ctypes.CDLL(None)
            dlvsym, dladdr = loader.dlvsym, loader.dladdr
            self._fegetround = self._library.fegetround
        except (OSError, AttributeError) as error:
            raise ValueError("unsupported matched libm loader/symbol capability") from error
        dlvsym.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
        dlvsym.restype = ctypes.c_void_p
        dladdr.argtypes = [ctypes.c_void_p, ctypes.POINTER(_DlInfo)]
        dladdr.restype = ctypes.c_int
        address = dlvsym(self._library._handle, b"hypot", b"GLIBC_2.35")
        info = _DlInfo()
        if not address or not dladdr(address, ctypes.byref(info)) or not info.name:
            raise ValueError("matched libm hypot@GLIBC_2.35 symbol unavailable")
        resolved = Path(info.name.decode("utf-8"))
        if (not resolved.is_absolute() or resolved.resolve(strict=True) != path
                or _library_digest(path) != expected_sha256):
            raise ValueError("matched libm resolved symbol/library identity mismatch")
        self._hypot = ctypes.CFUNCTYPE(ctypes.c_double, ctypes.c_double, ctypes.c_double)(address)
        self._fegetround.argtypes = []
        self._fegetround.restype = ctypes.c_int
        self._check_rounding()
        self._path = str(path)
        self._sha256 = expected_sha256

    def _check_rounding(self):
        if self._fegetround() != 0:
            raise ValueError("matched libm rounding mode must be nearest-even")

    def norm(self, raw):
        self._check_rounding()
        if len(raw) != 3 or any(type(value) not in (int, float) or not math.isfinite(value) for value in raw):
            raise ValueError("matched libm norm requires three finite components")
        value = self._hypot(self._hypot(raw[0], raw[1]), raw[2])
        if not math.isfinite(value):
            raise ValueError("evidence norm is non-finite")
        return value

    @property
    def description(self):
        self._check_rounding()
        return {"kind": "matched_gnu_libm_hypot", "library_path": self._path,
                "library_sha256": self._sha256, "hypot_symbol_version": "GLIBC_2.35",
                "rounding_mode": "nearest_even", "library_symbol_binding_checked": True,
                "producer_math_qualified": False}
