"""Immutable reference-corpus loading with fail-closed integrity checks."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

import numpy as np


_SHA256 = re.compile(r"[0-9a-f]{64}")
_FORMATS = {"oommf-odt", "ovf-2-binary8", "albuquerque-text", "albuquerque-vector-text"}


class ReferenceDataError(ValueError):
    pass


@dataclass(frozen=True)
class Trajectory:
    time_s: np.ndarray
    m: np.ndarray
    source: str


@dataclass(frozen=True)
class VectorField:
    values: np.ndarray
    coordinates_m: tuple[np.ndarray, np.ndarray, np.ndarray]
    source: str
    values_are_reduced_magnetization: bool = True

    @property
    def shape(self):
        return self.values.shape


@dataclass(frozen=True)
class ReferenceFile:
    id: str
    path: str
    url: str
    author: str
    format: str
    units: str
    mesh: str
    sha256: str
    axis_transform: str


@dataclass(frozen=True)
class ReferenceManifest:
    schema: str
    downloaded: str
    files: tuple[ReferenceFile, ...]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_reference_manifest(path: Path, verify: bool = True) -> ReferenceManifest:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schema") != "fullmag.mumag.sp4.references.v1":
        raise ValueError("unsupported SP4 reference manifest schema")
    entries = tuple(ReferenceFile(**item) for item in raw.get("files", ()))
    if not entries:
        raise ValueError("reference manifest is empty")
    ids = [entry.id for entry in entries]
    paths = [entry.path for entry in entries]
    if len(ids) != len(set(ids)) or len(paths) != len(set(paths)):
        raise ValueError("duplicate reference id or path")

    root = path.parent.resolve()
    for entry in entries:
        relative = PurePosixPath(entry.path)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"reference path escapes root: {entry.path}")
        if not _SHA256.fullmatch(entry.sha256):
            raise ValueError(f"malformed SHA-256 for {entry.id}")
        if entry.format not in _FORMATS:
            raise ValueError(f"unknown reference format: {entry.format}")
        target = (root / Path(*relative.parts)).resolve()
        if not target.is_relative_to(root):
            raise ValueError(f"reference path escapes root: {entry.path}")
        if verify:
            if not target.is_file():
                raise FileNotFoundError(target)
            actual = sha256_file(target)
            if actual != entry.sha256:
                raise ValueError(f"checksum mismatch for {entry.id}: {actual}")
    return ReferenceManifest(
        schema=raw["schema"], downloaded=raw["downloaded"], files=entries
    )


def _validated_trajectory(time_s, m, source: str) -> Trajectory:
    time_s = np.asarray(time_s, dtype=float)
    m = np.asarray(m, dtype=float)
    if time_s.ndim != 1 or m.shape != (len(time_s), 3) or len(time_s) < 2:
        raise ReferenceDataError("invalid trajectory shape")
    if not np.all(np.isfinite(time_s)) or not np.all(np.isfinite(m)):
        raise ReferenceDataError("non-finite trajectory")
    if np.any(np.diff(time_s) <= 0):
        raise ReferenceDataError("trajectory time must increase strictly")
    return Trajectory(time_s, m, source)


def parse_oommf_odt(path: Path) -> Trajectory:
    columns = units = None
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# Columns:"):
            columns = re.findall(r"\{([^}]+)\}|([^\s]+)", line.split(":", 1)[1])
            columns = [a or b for a, b in columns]
        elif line.startswith("# Units:"):
            units = re.findall(r"\{([^}]*)\}|([^\s]+)", line.split(":", 1)[1])
            units = [a or b for a, b in units]
        elif line and not line.startswith("#"):
            rows.append([float(value) for value in line.split()])
    if columns is None or units is None or not rows:
        raise ReferenceDataError("malformed ODT header or data")
    names = ["Oxs_TimeDriver::Simulation time", "Oxs_TimeDriver::mx", "Oxs_TimeDriver::my", "Oxs_TimeDriver::mz"]
    try:
        indexes = [columns.index(name) for name in names]
    except ValueError as exc:
        raise ReferenceDataError("ODT lacks required columns") from exc
    if units[indexes[0]] != "s" or any(units[index] not in {"", "{}"} for index in indexes[1:]):
        raise ReferenceDataError("unexpected ODT units")
    data = np.asarray(rows)
    return _validated_trajectory(data[:, indexes[0]], data[:, indexes[1:]], str(path))


def parse_albuquerque_trace(path: Path) -> Trajectory:
    try:
        data = np.loadtxt(path)
    except (OSError, ValueError) as exc:
        raise ReferenceDataError("malformed Albuquerque trace") from exc
    if data.ndim != 2 or data.shape[1] != 4:
        raise ReferenceDataError("Albuquerque trace must have four columns")
    return _validated_trajectory(data[:, 0] * 1e-9, data[:, 1:4], str(path))


def parse_albuquerque_vector_map(path: Path) -> VectorField:
    try:
        data = np.loadtxt(path)
    except (OSError, ValueError) as exc:
        raise ReferenceDataError("malformed Albuquerque vector map") from exc
    if data.ndim != 2 or data.shape[1] != 6 or not np.all(np.isfinite(data)):
        raise ReferenceDataError("Albuquerque vector map must contain finite xyz+m columns")
    return VectorField(data[:, 3:6], tuple(data[:, i] * 1e-9 for i in range(3)), str(path))


def parse_ovf2_rectangular(path: Path, ms_a_per_m: float = 8e5) -> VectorField:
    raw = path.read_bytes()
    marker = b"# Begin: Data Binary 8\n"
    offset = raw.find(marker)
    if offset < 0:
        raise ReferenceDataError("OVF is not Binary 8")
    header = raw[:offset].decode("ascii", "strict")
    values = {}
    for line in header.splitlines():
        if line.startswith("#") and ":" in line:
            key, value = line[1:].split(":", 1)
            values[key.strip().lower()] = value.strip()
    try:
        nx, ny, nz = (int(values[f"{axis}nodes"]) for axis in "xyz")
        steps = tuple(float(values[f"{axis}stepsize"]) for axis in "xyz")
        bases = tuple(float(values[f"{axis}base"]) for axis in "xyz")
    except (KeyError, ValueError) as exc:
        raise ReferenceDataError("malformed OVF rectangular header") from exc
    if values.get("meshunit") != "m" or values.get("valueunits") != "A/m A/m A/m":
        raise ReferenceDataError("unexpected OVF units")
    payload = raw[offset + len(marker):]
    count = 1 + nx * ny * nz * 3
    if len(payload) < count * 8:
        raise ReferenceDataError("truncated OVF binary payload")
    endian = None
    for candidate in ("<", ">"):
        check = np.frombuffer(payload[:8], dtype=candidate + "f8")[0]
        if np.isclose(check, 123456789012345.0, rtol=0, atol=0.5):
            endian = candidate
            break
    if endian is None:
        raise ReferenceDataError("invalid OVF byte-order check value")
    vectors = np.frombuffer(payload[8:count * 8], dtype=endian + "f8").astype(float)
    vectors = vectors.reshape((nz, ny, nx, 3)).transpose(2, 1, 0, 3) / ms_a_per_m
    if not np.all(np.isfinite(vectors)):
        raise ReferenceDataError("non-finite OVF field")
    coordinates = tuple(base + np.arange(n) * step for base, n, step in zip(bases, (nx, ny, nz), steps))
    return VectorField(vectors, coordinates, str(path))
