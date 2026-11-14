"""Array masks for field excitation: the loop style of mumax3 ``VectorMask``.

A ``VectorMask`` is a float32 lattice of 3-vectors in tesla. Fill it with
ordinary Python, usually a loop inside a function::

    def antenna_mask_loop(field, B01, wavelength, fwhm_y, xs):
        nx, ny, nz = field.size
        for i in range(nx):
            x = field.index2coord(i, 0, 0)[0]
            ...
            for j in range(ny):
                for k in range(9):
                    field.set_vector(i, j, k, (bx, 0.0, bz))
        return field

    antenna.add(antenna_mask_loop(study.new_vector_mask(), B01=0.2 * mT, ...), drive)

The array travels inside the ProblemIR (``MaskSourceIR::Sampled``: little-endian
float32 in (z, y, x, component) order, zlib, base64, with the sha256 of the raw
bytes), cropped to the cells that hold a non-zero value. The planner takes, at
each cell centre, the value of the lattice cell that contains it, and zero
outside the lattice (mumax3 resamples a VectorMask the same way).
"""

from __future__ import annotations

import base64
import hashlib
import math
import zlib
from typing import Mapping, Sequence

import numpy as np

SAMPLED_MASK_ENCODING = "f32le-zlib-base64"


def _vector3(value: Sequence[float], name: str, *, positive: bool = False) -> tuple[float, float, float]:
    try:
        x, y, z = (float(component) for component in value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be three numbers") from None
    for component in (x, y, z):
        if not math.isfinite(component) or (positive and component <= 0.0):
            raise ValueError(f"{name} must be finite{' and positive' if positive else ''}")
    return (x, y, z)


class VectorMask:
    """A float32 lattice of 3-vectors in tesla (mumax3 ``newVectorMask``).

    ``size`` is ``(nx, ny, nz)`` cells of size ``cell`` (metres); ``origin`` is the
    lower corner of the lattice in the world frame. ``index2coord(i, j, k)`` is the
    world position of a cell centre. ``array`` is a numpy view of shape
    ``(nz, ny, nx, 3)`` for vectorized code.
    """

    __slots__ = ("_array", "_cell", "_origin")

    def __init__(
        self,
        size: Sequence[int],
        cell: Sequence[float],
        origin: Sequence[float] = (0.0, 0.0, 0.0),
    ) -> None:
        try:
            nx, ny, nz = (int(value) for value in size)
        except (TypeError, ValueError):
            raise ValueError("size must be three integers (nx, ny, nz)") from None
        if min(nx, ny, nz) <= 0:
            raise ValueError("size must be positive in every direction")
        self._cell = _vector3(cell, "cell", positive=True)
        self._origin = _vector3(origin, "origin")
        self._array = np.zeros((nz, ny, nx, 3), dtype=np.float32)

    @property
    def size(self) -> tuple[int, int, int]:
        nz, ny, nx, _ = self._array.shape
        return (nx, ny, nz)

    @property
    def cell(self) -> tuple[float, float, float]:
        return self._cell

    @property
    def origin(self) -> tuple[float, float, float]:
        return self._origin

    @property
    def array(self) -> np.ndarray:
        """Writable view of shape ``(nz, ny, nx, 3)``, tesla."""
        return self._array

    def _check_index(self, i: int, j: int, k: int) -> None:
        nx, ny, nz = self.size
        if not (0 <= i < nx and 0 <= j < ny and 0 <= k < nz):
            raise IndexError(f"cell ({i}, {j}, {k}) is outside the {nx}x{ny}x{nz} mask")

    def index2coord(self, i: int, j: int, k: int) -> tuple[float, float, float]:
        """World position of the centre of cell ``(i, j, k)``."""
        return tuple(  # type: ignore[return-value]
            self._origin[axis] + (index + 0.5) * self._cell[axis]
            for axis, index in enumerate((i, j, k))
        )

    def set_vector(self, i: int, j: int, k: int, value: Sequence[float]) -> None:
        self._check_index(i, j, k)
        self._array[k, j, i] = _vector3(value, f"value at cell ({i}, {j}, {k})")

    def get_vector(self, i: int, j: int, k: int) -> tuple[float, float, float]:
        self._check_index(i, j, k)
        x, y, z = (float(component) for component in self._array[k, j, i])
        return (x, y, z)

    def to_ir(self) -> dict[str, object]:
        """``MaskSourceIR::Sampled``, cropped to the cells holding a non-zero value."""
        values = np.ascontiguousarray(self._array, dtype="<f4")
        if not np.all(np.isfinite(values)):
            raise ValueError("a vector mask must hold finite values")
        nonzero = np.any(values != 0.0, axis=-1)
        if nonzero.any():
            bounds = [np.nonzero(np.any(nonzero, axis=axes))[0] for axes in ((1, 2), (0, 2), (0, 1))]
            (z0, z1), (y0, y1), (x0, x1) = ((int(b[0]), int(b[-1]) + 1) for b in bounds)
        else:
            z0, z1, y0, y1, x0, x1 = 0, 1, 0, 1, 0, 1
        cropped = np.ascontiguousarray(values[z0:z1, y0:y1, x0:x1])
        raw = cropped.tobytes(order="C")
        origin = [
            self._origin[axis] + start * self._cell[axis]
            for axis, start in enumerate((x0, y0, z0))
        ]
        return {
            "kind": "sampled",
            "encoding": SAMPLED_MASK_ENCODING,
            "data": base64.b64encode(zlib.compress(raw, 6)).decode("ascii"),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "size": [x1 - x0, y1 - y0, z1 - z0],
            "cell_m": list(self._cell),
            "origin_m": origin,
        }

    @classmethod
    def from_data(
        cls,
        *,
        encoding: str,
        data: str,
        sha256: str,
        size: Sequence[int],
        cell: Sequence[float],
        origin: Sequence[float],
    ) -> "VectorMask":
        """Rebuild a mask from its IR payload (used by exported scripts)."""
        if encoding != SAMPLED_MASK_ENCODING:
            raise ValueError(f"unknown vector mask encoding {encoding!r}")
        raw = zlib.decompress(base64.b64decode(data))
        digest = hashlib.sha256(raw).hexdigest()
        if digest != sha256.lower():
            raise ValueError(f"vector mask sha256 {digest} differs from {sha256}")
        mask = cls(size, cell, origin)
        nx, ny, nz = mask.size
        values = np.frombuffer(raw, dtype="<f4")
        if values.size != nx * ny * nz * 3:
            raise ValueError("vector mask data does not match its size")
        mask._array[...] = values.reshape(nz, ny, nx, 3)
        return mask

    @classmethod
    def from_ir(cls, payload: Mapping[str, object]) -> "VectorMask":
        return cls.from_data(
            encoding=str(payload["encoding"]),
            data=str(payload["data"]),
            sha256=str(payload["sha256"]),
            size=payload["size"],  # type: ignore[arg-type]
            cell=payload["cell_m"],  # type: ignore[arg-type]
            origin=payload["origin_m"],  # type: ignore[arg-type]
        )

    def __repr__(self) -> str:
        return f"VectorMask(size={self.size}, cell={self._cell}, origin={self._origin})"


__all__ = ["SAMPLED_MASK_ENCODING", "VectorMask"]
