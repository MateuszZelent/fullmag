from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import math
from numbers import Real
from typing import Literal, TypeAlias

from fullmag._validation import (
    as_vector3,
    infer_geometry_format,
    require_non_empty,
    require_positive,
)


# ---------------------------------------------------------------------------
# Array3D budget constants (shared 1:1 with Rust & TypeScript contracts)
# ---------------------------------------------------------------------------
MAX_ARRAY_AXIS_COUNT = 10_000
MAX_EXPANDED_SCENE_OBJECTS = 256
MAX_ARRAY_INSTANCES_FEM_OCC = 2_500
MAX_ARRAY_INSTANCES_FDM = 100_000
MAX_ARRAY_FDM_CANDIDATES_PER_QUERY = 256


def _normalize_array_direction(value: str) -> Literal["positive", "negative", "symmetric"]:
    token = str(value).strip().lower()
    mapping: dict[str, Literal["positive", "negative", "symmetric"]] = {
        "+": "positive",
        "positive": "positive",
        "-": "negative",
        "negative": "negative",
        "+-": "symmetric",
        "-+": "symmetric",
        "±": "symmetric",
        "symmetric": "symmetric",
    }
    if token not in mapping:
        raise ValueError(
            f"Array3D direction must be 'positive' (+), 'negative' (-), or 'symmetric' (+-/±), got {value!r}"
        )
    return mapping[token]


def _normalize_array_spacing_mode(value: str) -> Literal["lattice_step", "bounding_box_gap"]:
    token = str(value).strip().lower()
    if token not in {"lattice_step", "bounding_box_gap"}:
        raise ValueError(
            f"Array3D spacing_mode must be 'lattice_step' or 'bounding_box_gap', got {value!r}"
        )
    return token  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Mixin for CSG operator overloads
# ---------------------------------------------------------------------------
class _GeometryOps:
    """Mixin providing CSG operators (``|``, ``+``, ``-``, ``&``, ``^``) and fluent methods."""

    def __sub__(self, other: "Geometry") -> "Difference":
        return Difference(base=self, tool=other)  # type: ignore[arg-type]

    def __add__(self, other: "Geometry") -> "Union":
        return Union(a=self, b=other)  # type: ignore[arg-type]

    def __or__(self, other: "Geometry") -> "Union":
        return Union(a=self, b=other)  # type: ignore[arg-type]

    def __and__(self, other: "Geometry") -> "Intersection":
        return Intersection(a=self, b=other)  # type: ignore[arg-type]

    def __xor__(self, other: "Geometry") -> "Xor":
        return Xor(left=self, right=other)  # type: ignore[arg-type]

    def union(self, other: "Geometry", *, name: str | None = None) -> "Union":
        if name is None:
            return Union(a=self, b=other)  # type: ignore[arg-type]
        return Union(a=self, b=other, name=name)  # type: ignore[arg-type]

    def subtract(self, other: "Geometry", *, name: str | None = None) -> "Difference":
        if name is None:
            return Difference(base=self, tool=other)  # type: ignore[arg-type]
        return Difference(base=self, tool=other, name=name)  # type: ignore[arg-type]

    def intersect(self, other: "Geometry", *, name: str | None = None) -> "Intersection":
        if name is None:
            return Intersection(a=self, b=other)  # type: ignore[arg-type]
        return Intersection(a=self, b=other, name=name)  # type: ignore[arg-type]

    def xor(self, other: "Geometry", *, name: str | None = None) -> "Xor":
        if name is None:
            return Xor(left=self, right=other)  # type: ignore[arg-type]
        return Xor(left=self, right=other, name=name)  # type: ignore[arg-type]

    def translate(self, offset: tuple[float, float, float]) -> "Translate":
        return Translate(geometry=self, offset=offset)  # type: ignore[arg-type]

    def rotate(
        self,
        *,
        euler_deg: tuple[float, float, float] | None = None,
        axis: tuple[float, float, float] | None = None,
        angle_deg: float | None = None,
        quat: tuple[float, float, float, float] | None = None,
        pivot: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str | None = None,
    ) -> "Transform":
        specified = sum(
            1
            for provided in (
                euler_deg is not None,
                axis is not None or angle_deg is not None,
                quat is not None,
            )
            if provided
        )
        if specified != 1:
            raise ValueError(
                "rotate() requires exactly one of euler_deg, (axis and angle_deg), or quat"
            )
        if euler_deg is not None:
            rotation_quat = quaternion_from_euler_xyz_deg(euler_deg)
        elif quat is not None:
            rotation_quat = normalize_quaternion(quat, "quat")
        else:
            if axis is None or angle_deg is None:
                raise ValueError("rotate() requires both axis and angle_deg together")
            rotation_quat = quaternion_from_axis_angle_deg(axis, angle_deg)
        return Transform(
            child=self,  # type: ignore[arg-type]
            rotation_quat=rotation_quat,
            pivot=pivot,
            name=name,
        )

    def scale(
        self,
        sx: float | tuple[float, float, float],
        sy: float | None = None,
        sz: float | None = None,
        *,
        pivot: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str | None = None,
    ) -> "Transform":
        if isinstance(sx, (tuple, list)):
            if sy is not None or sz is not None:
                raise ValueError("scale() accepts either a 3-tuple or scalar components")
            factors = as_vector3(sx, "scale")  # type: ignore[arg-type]
        elif sy is None and sz is None:
            s = _require_finite(float(sx), "scale")
            factors = (s, s, s)
        elif sy is not None and sz is not None:
            factors = (
                _require_finite(float(sx), "sx"),
                _require_finite(float(sy), "sy"),
                _require_finite(float(sz), "sz"),
            )
        else:
            raise ValueError("scale() requires either 1 uniform factor or 3 (sx, sy, sz) factors")
        return Transform(
            child=self,  # type: ignore[arg-type]
            scale=factors,
            pivot=pivot,
            name=name,
        )

    def transform(
        self,
        *,
        translation: tuple[float, float, float] = (0.0, 0.0, 0.0),
        rotation_quat: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0),
        scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
        pivot: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str | None = None,
    ) -> "Transform":
        return Transform(
            child=self,  # type: ignore[arg-type]
            translation=translation,
            rotation_quat=rotation_quat,
            scale=scale,
            pivot=pivot,
            name=name,
        )

    def slice_plane(
        self,
        origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
        normal: tuple[float, float, float] = (0.0, 0.0, 1.0),
        keep: Literal["positive", "negative"] = "positive",
        *,
        name: str | None = None,
    ) -> "SlicePlane":
        return SlicePlane(
            child=self,  # type: ignore[arg-type]
            plane_origin=origin,
            plane_normal=normal,
            keep_side=keep,
            name=name,
        )

    def array_3d(
        self,
        nx: int = 1,
        ny: int = 1,
        nz: int = 1,
        dx: float = 0.0,
        dy: float = 0.0,
        dz: float = 0.0,
        *,
        direction: str | Sequence[str] = ("positive", "positive", "positive"),
        spacing_mode: str | Sequence[str] = "lattice_step",
        gap: float | Sequence[float] = (0.0, 0.0, 0.0),
        relative_factor: float | Sequence[float] = (1.0, 1.0, 1.0),
        extra_step: Sequence[Sequence[float]] = (
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0),
        ),
        step_rot_deg: Sequence[Sequence[float]] = (
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0),
            (0.0, 0.0, 0.0),
        ),
        step_scale: Sequence[Sequence[float]] = (
            (1.0, 1.0, 1.0),
            (1.0, 1.0, 1.0),
            (1.0, 1.0, 1.0),
        ),
        merge: bool = False,
        name: str | None = None,
    ) -> "Array3D":
        def _expand3_str(val: str | Sequence[str], field: str) -> tuple[str, str, str]:
            if isinstance(val, str):
                return (val, val, val)
            if len(val) != 3:
                raise ValueError(f"array_3d {field} must be a string or 3-element sequence")
            return (str(val[0]), str(val[1]), str(val[2]))

        def _expand3_float(val: float | Sequence[float], field: str) -> tuple[float, float, float]:
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                f = float(val)
                return (f, f, f)
            return as_vector3(val, field)  # type: ignore[arg-type]

        dirs = _expand3_str(direction, "direction")
        modes = _expand3_str(spacing_mode, "spacing_mode")
        gaps = _expand3_float(gap, "gap")
        rel_factors = _expand3_float(relative_factor, "relative_factor")
        if len(extra_step) != 3 or len(step_rot_deg) != 3 or len(step_scale) != 3:
            raise ValueError("array_3d extra_step, step_rot_deg, and step_scale must have 3 entries (x, y, z)")

        counts = (nx, ny, nz)
        pitches = (float(dx), float(dy), float(dz))
        axis_names: tuple[Literal["x", "y", "z"], ...] = ("x", "y", "z")
        specs = tuple(
            ArrayAxisSpec(
                axis=axis_names[i],
                enabled=counts[i] > 1,
                count=counts[i],
                direction=_normalize_array_direction(dirs[i]),
                spacing_mode=_normalize_array_spacing_mode(modes[i]),
                pitch_m=pitches[i],
                relative_factor=rel_factors[i],
                gap_m=gaps[i],
                step_translation_extra_m=as_vector3(extra_step[i], f"extra_step[{i}]"),  # type: ignore[arg-type]
                step_rotation_euler_deg=as_vector3(step_rot_deg[i], f"step_rot_deg[{i}]"),  # type: ignore[arg-type]
                step_scale_factor=as_vector3(step_scale[i], f"step_scale[{i}]"),  # type: ignore[arg-type]
            )
            for i in range(3)
        )
        return Array3D(
            child=self,  # type: ignore[arg-type]
            axes=specs,  # type: ignore[arg-type]
            merge_overlapping=bool(merge),
            name=name,
        )


def _normalize_unit_vector3(value: tuple[float, float, float], field: str) -> tuple[float, float, float]:
    vector = as_vector3(value, field)
    norm = math.sqrt(sum(component * component for component in vector))
    if not math.isfinite(norm) or norm <= 0.0:
        raise ValueError(f"{field} must be a non-zero finite vector")
    return tuple(component / norm for component in vector)


def normalize_quaternion(
    value: Sequence[float],
    field: str = "rotation_quat",
) -> tuple[float, float, float, float]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or len(value) != 4:
        raise ValueError(f"{field} must be a 4-component (x, y, z, w) quaternion")
    components = tuple(_require_finite(float(c), f"{field}[{i}]") for i, c in enumerate(value))
    norm = math.sqrt(sum(c * c for c in components))
    if not math.isfinite(norm) or norm <= 0.0:
        raise ValueError(f"{field} must be a non-zero finite quaternion")
    return (
        components[0] / norm,
        components[1] / norm,
        components[2] / norm,
        components[3] / norm,
    )


def quaternion_from_euler_xyz_deg(
    euler_deg: Sequence[float],
) -> tuple[float, float, float, float]:
    """Convert extrinsic XYZ Euler angles in degrees to unit quaternion ``(x, y, z, w)``."""
    rx_deg, ry_deg, rz_deg = as_vector3(euler_deg, "euler_deg")  # type: ignore[arg-type]
    rx, ry, rz = math.radians(rx_deg), math.radians(ry_deg), math.radians(rz_deg)
    cx, sx = math.cos(0.5 * rx), math.sin(0.5 * rx)
    cy, sy = math.cos(0.5 * ry), math.sin(0.5 * ry)
    cz, sz = math.cos(0.5 * rz), math.sin(0.5 * rz)
    return normalize_quaternion(
        (
            sx * cy * cz - cx * sy * sz,
            cx * sy * cz + sx * cy * sz,
            cx * cy * sz - sx * sy * cz,
            cx * cy * cz + sx * sy * sz,
        ),
        "euler_deg",
    )


def quaternion_from_axis_angle_deg(
    axis: Sequence[float],
    angle_deg: float,
) -> tuple[float, float, float, float]:
    """Convert an axis and angle in degrees to unit quaternion ``(x, y, z, w)``."""
    ux, uy, uz = _normalize_unit_vector3(axis, "axis")  # type: ignore[arg-type]
    half = 0.5 * math.radians(_require_finite(float(angle_deg), "angle_deg"))
    s = math.sin(half)
    c = math.cos(half)
    return normalize_quaternion((ux * s, uy * s, uz * s, c), "axis_angle")


def rotation_matrix_from_quaternion(
    quat: Sequence[float],
) -> tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]:
    """Convert unit quaternion ``(x, y, z, w)`` to a 3x3 rotation matrix."""
    x, y, z, w = normalize_quaternion(quat, "rotation_quat")
    return (
        (1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)),
        (2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)),
        (2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)),
    )


def _format_translation_component(value: float) -> str:
    normalized = float(value)
    if normalized == 0.0:
        return "0"
    return repr(normalized)


def _derived_translate_name(base_name: str, offset: tuple[float, float, float]) -> str:
    components = "_".join(_format_translation_component(component) for component in offset)
    return f"{base_name}__translate_{components}"


def _derived_transform_name(
    base_name: str,
    translation: tuple[float, float, float],
    rotation_quat: tuple[float, float, float, float],
    scale: tuple[float, float, float],
    pivot: tuple[float, float, float],
) -> str:
    parts = [base_name, "transform"]
    if any(c != 0.0 for c in translation):
        parts.append("t_" + "_".join(_format_translation_component(c) for c in translation))
    if rotation_quat != (0.0, 0.0, 0.0, 1.0):
        parts.append("q_" + "_".join(_format_translation_component(c) for c in rotation_quat))
    if scale != (1.0, 1.0, 1.0):
        parts.append("s_" + "_".join(_format_translation_component(c) for c in scale))
    if any(c != 0.0 for c in pivot):
        parts.append("p_" + "_".join(_format_translation_component(c) for c in pivot))
    return "__".join(parts)


def _derived_slice_plane_name(
    base_name: str,
    plane_origin: tuple[float, float, float],
    plane_normal: tuple[float, float, float],
    keep_side: str,
) -> str:
    orig = "_".join(_format_translation_component(c) for c in plane_origin)
    norm = "_".join(_format_translation_component(c) for c in plane_normal)
    return f"{base_name}__slice_{keep_side}_o_{orig}_n_{norm}"


def _require_finite(value: float, field: str) -> float:
    normalized = float(value)
    if not math.isfinite(normalized):
        raise ValueError(f"{field} must be finite")
    return normalized


def _require_non_negative(value: float, field: str) -> float:
    normalized = _require_finite(value, field)
    if normalized < 0.0:
        raise ValueError(f"{field} must be non-negative, got {normalized}")
    return normalized


# ---------------------------------------------------------------------------
# Imported geometry (NPZ mask, STL, STEP, etc.)
# ---------------------------------------------------------------------------
ImportedGeometryScale: TypeAlias = float | tuple[float, float, float]
ImportedGeometryUnits: TypeAlias = str
ImportedGeometryVolume: TypeAlias = Literal["full", "surface"]

_IMPORTED_GEOMETRY_UNIT_SCALES: dict[str, float] = {
    "m": 1.0,
    "cm": 1e-2,
    "mm": 1e-3,
    "um": 1e-6,
    "µm": 1e-6,
    "μm": 1e-6,
    "nm": 1e-9,
    "pm": 1e-12,
}
_IMPORTED_GEOMETRY_VOLUMES: tuple[ImportedGeometryVolume, ...] = ("full", "surface")


def _normalize_import_units(units: ImportedGeometryUnits | None) -> tuple[ImportedGeometryUnits | None, float]:
    if units is None:
        return None, 1.0
    normalized = require_non_empty(units, "units").strip().lower()
    try:
        return normalized, _IMPORTED_GEOMETRY_UNIT_SCALES[normalized]
    except KeyError as exc:
        supported = ", ".join(sorted(_IMPORTED_GEOMETRY_UNIT_SCALES))
        raise ValueError(f"units must be one of: {supported}") from exc


def _apply_unit_scale(
    scale: ImportedGeometryScale,
    unit_scale: float,
) -> ImportedGeometryScale:
    if isinstance(scale, (int, float)):
        return float(scale) * unit_scale
    return tuple(float(component) * unit_scale for component in scale)


def _normalize_import_volume(volume: ImportedGeometryVolume | None) -> ImportedGeometryVolume:
    if volume is None:
        return "full"
    normalized = require_non_empty(volume, "volume").strip().lower()
    if normalized not in _IMPORTED_GEOMETRY_VOLUMES:
        supported = ", ".join(_IMPORTED_GEOMETRY_VOLUMES)
        raise ValueError(f"volume must be one of: {supported}")
    return normalized  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class ImportedGeometry(_GeometryOps):
    source: str
    scale: ImportedGeometryScale = 1.0
    units: ImportedGeometryUnits | None = None
    name: str | None = None
    volume: ImportedGeometryVolume = "full"

    def __post_init__(self) -> None:
        source = require_non_empty(self.source, "source")
        object.__setattr__(self, "source", source)
        normalized_units, unit_scale = _normalize_import_units(self.units)
        object.__setattr__(self, "units", normalized_units)
        object.__setattr__(self, "volume", _normalize_import_volume(self.volume))
        effective_scale = _apply_unit_scale(self.scale, unit_scale)
        if isinstance(self.scale, (int, float)):
            object.__setattr__(self, "scale", require_positive(float(effective_scale), "scale"))
        else:
            normalized_scale = as_vector3(effective_scale, "scale")
            for index, component in enumerate(normalized_scale):
                require_positive(component, f"scale[{index}]")
            object.__setattr__(self, "scale", normalized_scale)
        if self.name is not None:
            object.__setattr__(self, "name", require_non_empty(self.name, "name"))

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return self.source.rsplit("/", 1)[-1].rsplit(".", 1)[0]

    def to_ir(self) -> dict[str, object]:
        scale_ir: float | list[float]
        if isinstance(self.scale, (int, float)):
            scale_ir = float(self.scale)
        else:
            scale_ir = list(self.scale)
        return {
            "name": self.geometry_name,
            "kind": "imported_geometry",
            "source": self.source,
            "format": infer_geometry_format(self.source),
            "scale": scale_ir,
            **({"volume": self.volume} if self.volume != "full" else {}),
        }


# ---------------------------------------------------------------------------
# 3-D conductor-backed antenna geometry
# ---------------------------------------------------------------------------
def _antenna_real(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{field} must be a finite real number")
    normalized = float(value)
    if not math.isfinite(normalized):
        raise ValueError(f"{field} must be finite")
    return normalized


def _antenna_positive(value: object, field: str) -> float:
    normalized = _antenna_real(value, field)
    if normalized <= 0.0:
        raise ValueError(f"{field} must be positive")
    return normalized


def _antenna_non_negative(value: object, field: str) -> float:
    normalized = _antenna_real(value, field)
    if normalized < 0.0:
        raise ValueError(f"{field} must be non-negative")
    return normalized


def _antenna_alias(primary: object, alias: object, field: str) -> object:
    if primary is not None and alias is not None and primary != alias:
        raise ValueError(f"{field} and its compatibility alias disagree")
    return primary if primary is not None else alias


def _normalize_antenna_stations(
    stations: Sequence[object],
    expected_type: type,
    field: str,
) -> tuple[object, ...]:
    if isinstance(stations, (str, bytes)):
        raise TypeError(f"{field} must be a sequence of typed stations")
    resolved = tuple(stations)
    if len(resolved) < 2 or any(not isinstance(station, expected_type) for station in resolved):
        raise ValueError(f"{field} requires at least two {expected_type.__name__} values")
    positions = tuple(float(getattr(station, "s")) for station in resolved)
    if positions[0] != 0.0 or positions[-1] != 1.0:
        raise ValueError(f"{field} must start at s=0 and end at s=1")
    if any(not current > previous for previous, current in zip(positions, positions[1:])):
        raise ValueError(f"{field} positions must be strictly increasing")
    return resolved


def _normalize_matrix3(value: object, field: str) -> tuple[tuple[float, float, float], ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or len(value) != 3:
        raise TypeError(f"{field} must be a 3x3 sequence")
    rows = []
    for row_index, row in enumerate(value):
        if isinstance(row, (str, bytes)) or not isinstance(row, Sequence) or len(row) != 3:
            raise TypeError(f"{field}[{row_index}] must contain three values")
        rows.append(tuple(_antenna_real(component, f"{field}[{row_index}][{column}]") for column, component in enumerate(row)))
    matrix = tuple(rows)
    gram = tuple(
        sum(matrix[row][column] * matrix[row][other] for row in range(3))
        for column in range(3)
        for other in range(3)
    )
    for index, value in enumerate(gram):
        expected = 1.0 if index in (0, 4, 8) else 0.0
        if abs(value - expected) > 1e-9:
            raise ValueError(f"{field} must be an orthonormal rotation matrix")
    determinant = (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )
    if abs(determinant - 1.0) > 1e-9:
        raise ValueError(f"{field} must have determinant +1")
    return matrix


@dataclass(frozen=True, slots=True, init=False)
class RigidTransform:
    """Finite right-handed rigid transform for the complete antenna layout."""

    rotation_matrix: tuple[tuple[float, float, float], ...]
    translation_m: tuple[float, float, float]

    def __init__(
        self,
        rotation_matrix: Sequence[Sequence[float]] | None = None,
        translation_m: Sequence[float] | None = None,
        *,
        rotation: Sequence[Sequence[float]] | None = None,
        translation: Sequence[float] | None = None,
    ) -> None:
        resolved_rotation = _antenna_alias(rotation_matrix, rotation, "rotation_matrix")
        resolved_translation = _antenna_alias(translation_m, translation, "translation_m")
        if resolved_rotation is None:
            resolved_rotation = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
        if resolved_translation is None:
            resolved_translation = (0.0, 0.0, 0.0)
        object.__setattr__(self, "rotation_matrix", _normalize_matrix3(resolved_rotation, "rotation_matrix"))
        translation = as_vector3(resolved_translation, "translation_m")
        object.__setattr__(
            self,
            "translation_m",
            tuple(_antenna_real(component, f"translation_m[{index}]") for index, component in enumerate(translation)),
        )

    @classmethod
    def identity(cls) -> "RigidTransform":
        return cls()

    @property
    def rotation(self) -> tuple[tuple[float, float, float], ...]:
        return self.rotation_matrix

    @property
    def translation(self) -> tuple[float, float, float]:
        return self.translation_m

    def apply(self, point_m: Sequence[float]) -> tuple[float, float, float]:
        point = as_vector3(point_m, "point_m")
        return tuple(
            sum(self.rotation_matrix[row][column] * point[column] for column in range(3))
            + self.translation_m[row]
            for row in range(3)
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "rotation_matrix": [list(row) for row in self.rotation_matrix],
            "translation_m": list(self.translation_m),
        }

    @classmethod
    def from_ir(cls, value: Mapping[str, object]) -> "RigidTransform":
        return cls(rotation_matrix=value["rotation_matrix"], translation_m=value["translation_m"])


AntennaRigidTransform = RigidTransform


@dataclass(frozen=True, slots=True, init=False)
class MicrostripWidthStation:
    """One normalized longitudinal station of a microstrip signal conductor."""

    s: float
    signal_width_m: float

    def __init__(
        self,
        s: float,
        signal_width_m: float | None = None,
        *,
        signal_width: float | None = None,
    ) -> None:
        width = _antenna_alias(signal_width_m, signal_width, "signal_width_m")
        if width is None:
            raise TypeError("signal_width_m is required")
        object.__setattr__(self, "s", _antenna_real(s, "s"))
        object.__setattr__(self, "signal_width_m", _antenna_positive(width, "signal_width_m"))
        if not 0.0 <= self.s <= 1.0:
            raise ValueError("s must lie in [0, 1]")

    @property
    def signal_width(self) -> float:
        return self.signal_width_m

    def to_ir(self) -> dict[str, float]:
        return {"s": self.s, "signal_width_m": self.signal_width_m}


@dataclass(frozen=True, slots=True, init=False)
class CPWWidthStation:
    """One normalized station of an asymmetric CPW signal/ground profile."""

    s: float
    signal_width_m: float
    left_gap_m: float
    right_gap_m: float
    left_ground_width_m: float
    right_ground_width_m: float

    def __init__(
        self,
        s: float,
        signal_width_m: float | None = None,
        left_gap_m: float | None = None,
        right_gap_m: float | None = None,
        left_ground_width_m: float | None = None,
        right_ground_width_m: float | None = None,
        *,
        signal_width: float | None = None,
        gap: float | None = None,
        gap_m: float | None = None,
        ground_width: float | None = None,
        ground_width_m: float | None = None,
    ) -> None:
        width = _antenna_alias(signal_width_m, signal_width, "signal_width_m")
        symmetric_gap = _antenna_alias(gap_m, gap, "gap_m")
        symmetric_ground = _antenna_alias(ground_width_m, ground_width, "ground_width_m")
        left_gap = _antenna_alias(left_gap_m, symmetric_gap, "left_gap_m")
        right_gap = _antenna_alias(right_gap_m, symmetric_gap, "right_gap_m")
        left_ground = _antenna_alias(left_ground_width_m, symmetric_ground, "left_ground_width_m")
        right_ground = _antenna_alias(right_ground_width_m, symmetric_ground, "right_ground_width_m")
        if any(value is None for value in (width, left_gap, right_gap, left_ground, right_ground)):
            raise TypeError("CPWWidthStation requires signal width, both gaps, and both ground widths")
        object.__setattr__(self, "s", _antenna_real(s, "s"))
        object.__setattr__(self, "signal_width_m", _antenna_positive(width, "signal_width_m"))
        object.__setattr__(self, "left_gap_m", _antenna_positive(left_gap, "left_gap_m"))
        object.__setattr__(self, "right_gap_m", _antenna_positive(right_gap, "right_gap_m"))
        object.__setattr__(self, "left_ground_width_m", _antenna_positive(left_ground, "left_ground_width_m"))
        object.__setattr__(self, "right_ground_width_m", _antenna_positive(right_ground, "right_ground_width_m"))
        if not 0.0 <= self.s <= 1.0:
            raise ValueError("s must lie in [0, 1]")

    @classmethod
    def symmetric(
        cls,
        *,
        s: float,
        signal_width: float | None = None,
        signal_width_m: float | None = None,
        gap: float | None = None,
        gap_m: float | None = None,
        ground_width: float | None = None,
        ground_width_m: float | None = None,
    ) -> "CPWWidthStation":
        return cls(
            s,
            signal_width_m=signal_width_m,
            signal_width=signal_width,
            gap=gap,
            gap_m=gap_m,
            ground_width=ground_width,
            ground_width_m=ground_width_m,
        )

    @property
    def signal_width(self) -> float:
        return self.signal_width_m

    def to_ir(self) -> dict[str, float]:
        return {
            "s": self.s,
            "signal_width_m": self.signal_width_m,
            "left_gap_m": self.left_gap_m,
            "right_gap_m": self.right_gap_m,
            "left_ground_width_m": self.left_ground_width_m,
            "right_ground_width_m": self.right_ground_width_m,
        }


def _section_vertices(
    transform: RigidTransform,
    u_m: float,
    center_v_m: float,
    width_m: float,
    center_w_m: float,
    thickness_m: float,
) -> tuple[tuple[float, float, float], ...]:
    half_width = width_m / 2.0
    half_thickness = thickness_m / 2.0
    local = (
        (u_m, center_v_m - half_width, center_w_m - half_thickness),
        (u_m, center_v_m + half_width, center_w_m - half_thickness),
        (u_m, center_v_m + half_width, center_w_m + half_thickness),
        (u_m, center_v_m - half_width, center_w_m + half_thickness),
    )
    return tuple(transform.apply(point) for point in local)


class _AntennaLayoutGeometry(_GeometryOps):
    """Shared geometry behaviour for straight, piecewise-linear conductor lofts."""

    geometry_name: str
    length_m: float
    thickness_m: float
    transform: RigidTransform

    def _sections(self) -> tuple[dict[str, object], ...]:
        raise NotImplementedError

    def solid_segments(self) -> tuple[dict[str, object], ...]:
        sections = self._sections()
        return tuple(
            {
                "from": sections[index],
                "to": sections[index + 1],
            }
            for index in range(len(sections) - 1)
        )

    def world_bounds(self) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        vertices = [vertex for section in self._sections() for vertex in section["vertices"]]
        return (
            tuple(min(vertex[index] for vertex in vertices) for index in range(3)),
            tuple(max(vertex[index] for vertex in vertices) for index in range(3)),
        )


def _antenna_conductor_ids(
    conductors: Sequence[Mapping[str, object]], kinds: tuple[str, ...],
) -> tuple[str, ...]:
    if any("kind" in part for part in conductors):
        by_kind = {part.get("kind"): str(part["id"]) for part in conductors}
        if len(conductors) != len(kinds) or set(by_kind) != set(kinds):
            raise ValueError("Antenna conductors must declare each expected kind exactly once")
        return tuple(by_kind[kind] for kind in kinds)
    ids = tuple(str(part["id"]) for part in conductors)
    return ids if len(ids) == len(kinds) else kinds


@dataclass(frozen=True, slots=True, init=False)
class MicrostripAntennaLayout(_AntennaLayoutGeometry):
    """3-D microstrip signal plus explicit parallel return conductor.

    ``return_offset_m`` is the insulating clearance between the signal bottom
    and return top faces. Curved centerlines and frequency-domain effects are
    intentionally outside this Tier-1 geometry contract.
    """

    name: str
    length_m: float
    thickness_m: float
    conductivity_s_per_m: float
    stations: tuple[MicrostripWidthStation, ...]
    transform: RigidTransform
    return_width_m: float
    return_offset_m: float
    signal_part_id: str
    return_part_id: str
    closed_loop: bool
    inlet_connection_length_m: float | None
    inlet_connection_width_m: float | None
    inlet_connection_offset_v_m: float | None
    inlet_connection_part_id: str | None
    inlet_connection_conductivity_s_per_m: float | None
    outlet_connection_length_m: float | None
    outlet_connection_width_m: float | None
    outlet_connection_offset_v_m: float | None
    outlet_connection_part_id: str | None
    outlet_connection_conductivity_s_per_m: float | None

    def __init__(
        self,
        name: str,
        length_m: float | None = None,
        thickness_m: float | None = None,
        conductivity_s_per_m: float | None = None,
        stations: Sequence[MicrostripWidthStation] = (),
        transform: RigidTransform | None = None,
        return_width_m: float | None = None,
        return_offset_m: float | None = None,
        signal_part_id: str = "signal",
        return_part_id: str = "return",
        *,
        closed_loop: bool = False,
        inlet_connection_length_m: float | None = None,
        inlet_connection_width_m: float | None = None,
        inlet_connection_offset_v_m: float | None = None,
        inlet_connection_part_id: str | None = None,
        inlet_connection_conductivity_s_per_m: float | None = None,
        outlet_connection_length_m: float | None = None,
        outlet_connection_width_m: float | None = None,
        outlet_connection_offset_v_m: float | None = None,
        outlet_connection_part_id: str | None = None,
        outlet_connection_conductivity_s_per_m: float | None = None,
        length: float | None = None,
        thickness: float | None = None,
        conductivity: float | None = None,
        return_width: float | None = None,
    ) -> None:
        resolved_length = _antenna_alias(length_m, length, "length_m")
        resolved_thickness = _antenna_alias(thickness_m, thickness, "thickness_m")
        resolved_conductivity = _antenna_alias(conductivity_s_per_m, conductivity, "conductivity_s_per_m")
        resolved_return_width = _antenna_alias(return_width_m, return_width, "return_width_m")
        if any(value is None for value in (resolved_length, resolved_thickness, resolved_conductivity, resolved_return_width)):
            raise TypeError("MicrostripAntennaLayout requires length, thickness, conductivity, and return_width_m")
        normalized_name = require_non_empty(name, "name")
        normalized_length = _antenna_positive(resolved_length, "length_m")
        normalized_thickness = _antenna_positive(resolved_thickness, "thickness_m")
        normalized_conductivity = _antenna_positive(resolved_conductivity, "conductivity_s_per_m")
        normalized_return_width = _antenna_positive(resolved_return_width, "return_width_m")
        normalized_offset = _antenna_non_negative(
            normalized_thickness if return_offset_m is None else return_offset_m,
            "return_offset_m",
        )
        normalized_stations = _normalize_antenna_stations(stations, MicrostripWidthStation, "stations")
        signal_id = require_non_empty(signal_part_id, "signal_part_id")
        return_id = require_non_empty(return_part_id, "return_part_id")
        if signal_id == return_id:
            raise ValueError("signal_part_id and return_part_id must differ")
        object.__setattr__(self, "name", normalized_name)
        object.__setattr__(self, "length_m", normalized_length)
        object.__setattr__(self, "thickness_m", normalized_thickness)
        object.__setattr__(self, "conductivity_s_per_m", normalized_conductivity)
        object.__setattr__(self, "stations", normalized_stations)
        object.__setattr__(self, "transform", RigidTransform.identity() if transform is None else transform)
        if not isinstance(self.transform, RigidTransform):
            raise TypeError("transform must be a RigidTransform")
        object.__setattr__(self, "return_width_m", normalized_return_width)
        object.__setattr__(self, "return_offset_m", normalized_offset)
        object.__setattr__(self, "signal_part_id", signal_id)
        object.__setattr__(self, "return_part_id", return_id)
        if not isinstance(closed_loop, bool):
            raise TypeError("closed_loop must be boolean")
        object.__setattr__(self, "closed_loop", closed_loop)
        loop_values = {
            "inlet_connection_length_m": inlet_connection_length_m,
            "inlet_connection_width_m": inlet_connection_width_m,
            "inlet_connection_offset_v_m": inlet_connection_offset_v_m,
            "inlet_connection_part_id": inlet_connection_part_id,
            "inlet_connection_conductivity_s_per_m": inlet_connection_conductivity_s_per_m,
            "outlet_connection_length_m": outlet_connection_length_m,
            "outlet_connection_width_m": outlet_connection_width_m,
            "outlet_connection_offset_v_m": outlet_connection_offset_v_m,
            "outlet_connection_part_id": outlet_connection_part_id,
            "outlet_connection_conductivity_s_per_m": outlet_connection_conductivity_s_per_m,
        }
        if not closed_loop and any(value is not None for value in loop_values.values()):
            raise ValueError("connection parameters require closed_loop=True")
        if closed_loop and normalized_offset <= 0.0:
            raise ValueError("closed_loop requires positive return_offset_m")
        for field, value in loop_values.items():
            if closed_loop:
                if value is None:
                    raise ValueError(f"closed_loop requires explicit {field}")
                value = (require_non_empty(value, field) if field.endswith("part_id")
                         else _antenna_real(value, field) if field.endswith("offset_v_m")
                         else _antenna_positive(value, field))
            object.__setattr__(self, field, value)
        if closed_loop:
            ids = (signal_id, return_id, inlet_connection_part_id, outlet_connection_part_id)
            if len(set(ids)) != 4:
                raise ValueError("closed_loop part IDs must be distinct")
            for side, station in (("inlet", normalized_stations[0]), ("outlet", normalized_stations[-1])):
                width = getattr(self, f"{side}_connection_width_m")
                offset = getattr(self, f"{side}_connection_offset_v_m")
                for target_width in (station.signal_width_m, normalized_return_width):
                    if min(offset + width / 2, target_width / 2) <= max(offset - width / 2, -target_width / 2):
                        raise ValueError(f"{side} connection must contact signal and return with positive area")


    @property
    def geometry_name(self) -> str:
        return self.name

    @property
    def conductor_part_ids(self) -> tuple[str, str]:
        return self.signal_part_id, self.return_part_id

    @property
    def minimum_signal_width_m(self) -> float:
        return min(station.signal_width_m for station in self.stations)

    @property
    def end_face_areas_m2(self) -> dict[str, float]:
        return {
            self.signal_part_id: self.stations[0].signal_width_m * self.thickness_m,
            self.return_part_id: self.return_width_m * self.thickness_m,
        }

    def _sections(self) -> tuple[dict[str, object], ...]:
        sections = []
        for station in self.stations:
            u_m = station.s * self.length_m
            sections.append(
                {
                    "s": station.s,
                    "u_m": u_m,
                    "conductors": {
                        self.signal_part_id: _section_vertices(self.transform, u_m, 0.0, station.signal_width_m, 0.0, self.thickness_m),
                        self.return_part_id: _section_vertices(self.transform, u_m, 0.0, self.return_width_m, -(self.thickness_m + self.return_offset_m), self.thickness_m),
                    },
                    "vertices": tuple(
                        vertex
                        for width, center_w in (
                            (station.signal_width_m, 0.0),
                            (self.return_width_m, -(self.thickness_m + self.return_offset_m)),
                        )
                        for vertex in _section_vertices(self.transform, u_m, 0.0, width, center_w, self.thickness_m)
                    ),
                }
            )
        return tuple(sections)

    def connection_sections(self) -> dict[str, tuple[dict[str, object], ...]]:
        """Full volumetric bridge sections, preserving authored rigid transform."""
        if not self.closed_loop:
            return {}
        result = {}
        for side in ("inlet", "outlet"):
            length = getattr(self, f"{side}_connection_length_m")
            width = getattr(self, f"{side}_connection_width_m")
            offset = getattr(self, f"{side}_connection_offset_v_m")
            part = getattr(self, f"{side}_connection_part_id")
            bounds = (-length, 0.0) if side == "inlet" else (self.length_m, self.length_m + length)
            height = 2 * self.thickness_m + self.return_offset_m
            center = -(self.thickness_m + self.return_offset_m) / 2
            result[part] = tuple({"u_m": u, "conductors": {part: _section_vertices(
                self.transform, u, offset, width, center, height)}, "vertices": _section_vertices(
                self.transform, u, offset, width, center, height)} for u in bounds)
        return result

    def solid_segments(self) -> tuple[dict[str, object], ...]:
        return _AntennaLayoutGeometry.solid_segments(self) + tuple({"from": sections[0], "to": sections[1]}
                                               for sections in self.connection_sections().values())

    def world_bounds(self) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        vertices = [v for section in self._sections() for v in section["vertices"]]
        vertices.extend(v for sections in self.connection_sections().values()
                        for section in sections for v in section["vertices"])
        return (tuple(min(v[i] for v in vertices) for i in range(3)),
                tuple(max(v[i] for v in vertices) for i in range(3)))

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "microstrip",
            **({"loop": {"enabled": True,
                "inlet_connection_length_m": self.inlet_connection_length_m,
                "inlet_connection_width_m": self.inlet_connection_width_m,
                "inlet_connection_offset_v_m": self.inlet_connection_offset_v_m,
                "inlet_connection_part_id": self.inlet_connection_part_id,
                "inlet_connection_conductivity_s_per_m": self.inlet_connection_conductivity_s_per_m,
                "outlet_connection_length_m": self.outlet_connection_length_m,
                "outlet_connection_width_m": self.outlet_connection_width_m,
                "outlet_connection_offset_v_m": self.outlet_connection_offset_v_m,
                "outlet_connection_part_id": self.outlet_connection_part_id,
                "outlet_connection_conductivity_s_per_m": self.outlet_connection_conductivity_s_per_m,
            }} if self.closed_loop else {}),
            "length_m": self.length_m,
            "thickness_m": self.thickness_m,
            "conductivity_s_per_m": self.conductivity_s_per_m,
            "transform": self.transform.to_ir(),
            "stations": [station.to_ir() for station in self.stations],
            "return_width_m": self.return_width_m,
            "return_offset_m": self.return_offset_m,
            "conductors": [
                {"id": self.signal_part_id, "kind": "signal"},
                {"id": self.return_part_id, "kind": "return"},
            ],
            "terminal_faces": {
                part_id: {"inlet": "local_u_min", "outlet": "local_u_max"}
                for part_id in self.conductor_part_ids
            },
        }

    @classmethod
    def from_ir(cls, value: Mapping[str, object]) -> "MicrostripAntennaLayout":
        if value.get("kind") != "microstrip":
            raise ValueError("microstrip layout kind is required")
        loop = value.get("loop", {})
        if not isinstance(loop, Mapping) or set(loop) - {"enabled", 'inlet_connection_length_m', 'inlet_connection_width_m', 'inlet_connection_offset_v_m', 'inlet_connection_part_id', 'inlet_connection_conductivity_s_per_m', 'outlet_connection_length_m', 'outlet_connection_width_m', 'outlet_connection_offset_v_m', 'outlet_connection_part_id', 'outlet_connection_conductivity_s_per_m'}:
            raise ValueError("microstrip loop contains unsupported authored fields")
        stations = tuple(MicrostripWidthStation(**station) for station in value["stations"])
        signal_id, return_id = _antenna_conductor_ids(
            value.get("conductors", ()), ("signal", "return"),
        )
        return cls(
            name=value["name"],
            length_m=value.get("length_m", value.get("length")),
            thickness_m=value.get("thickness_m", value.get("thickness")),
            conductivity_s_per_m=value.get("conductivity_s_per_m", value.get("conductivity")),
            stations=stations,
            transform=RigidTransform.from_ir(value.get("transform", RigidTransform.identity().to_ir())),
            return_width_m=value["return_width_m"],
            return_offset_m=value.get("return_offset_m"),
            signal_part_id=signal_id,
            return_part_id=return_id,
            closed_loop=loop.get("enabled", False),
            inlet_connection_length_m=loop.get("inlet_connection_length_m"),
            inlet_connection_width_m=loop.get("inlet_connection_width_m"),
            inlet_connection_offset_v_m=loop.get("inlet_connection_offset_v_m"),
            inlet_connection_part_id=loop.get("inlet_connection_part_id"),
            inlet_connection_conductivity_s_per_m=loop.get("inlet_connection_conductivity_s_per_m"),
            outlet_connection_length_m=loop.get("outlet_connection_length_m"),
            outlet_connection_width_m=loop.get("outlet_connection_width_m"),
            outlet_connection_offset_v_m=loop.get("outlet_connection_offset_v_m"),
            outlet_connection_part_id=loop.get("outlet_connection_part_id"),
            outlet_connection_conductivity_s_per_m=loop.get("outlet_connection_conductivity_s_per_m"),
        )


@dataclass(frozen=True, slots=True, init=False)
class CPWAntennaLayout(_AntennaLayoutGeometry):
    """3-D signal plus both ground conductors with an ordered width loft."""

    name: str
    length_m: float
    thickness_m: float
    conductivity_s_per_m: float
    stations: tuple[CPWWidthStation, ...]
    transform: RigidTransform
    signal_part_id: str
    left_ground_part_id: str
    right_ground_part_id: str
    closed_loop: bool
    inlet_connection_length_m: float | None
    inlet_crossbar_length_m: float | None
    inlet_connection_part_id: str | None
    inlet_connection_conductivity_s_per_m: float | None
    outlet_connection_length_m: float | None
    outlet_crossbar_length_m: float | None
    outlet_connection_part_id: str | None
    outlet_connection_conductivity_s_per_m: float | None

    def __init__(
        self,
        name: str,
        length_m: float | None = None,
        thickness_m: float | None = None,
        conductivity_s_per_m: float | None = None,
        stations: Sequence[CPWWidthStation] = (),
        transform: RigidTransform | None = None,
        signal_part_id: str = "signal",
        left_ground_part_id: str = "ground_left",
        right_ground_part_id: str = "ground_right",
        *,
        length: float | None = None,
        thickness: float | None = None,
        conductivity: float | None = None,
        closed_loop: bool = False,
        inlet_connection_length_m: float | None = None,
        inlet_crossbar_length_m: float | None = None,
        inlet_connection_part_id: str | None = None,
        inlet_connection_conductivity_s_per_m: float | None = None,
        outlet_connection_length_m: float | None = None,
        outlet_crossbar_length_m: float | None = None,
        outlet_connection_part_id: str | None = None,
        outlet_connection_conductivity_s_per_m: float | None = None,
    ) -> None:
        resolved_length = _antenna_alias(length_m, length, "length_m")
        resolved_thickness = _antenna_alias(thickness_m, thickness, "thickness_m")
        resolved_conductivity = _antenna_alias(conductivity_s_per_m, conductivity, "conductivity_s_per_m")
        if any(value is None for value in (resolved_length, resolved_thickness, resolved_conductivity)):
            raise TypeError("CPWAntennaLayout requires length, thickness, and conductivity")
        normalized_stations = _normalize_antenna_stations(stations, CPWWidthStation, "stations")
        normalized_ids = tuple(require_non_empty(value, field) for value, field in (
            (signal_part_id, "signal_part_id"),
            (left_ground_part_id, "left_ground_part_id"),
            (right_ground_part_id, "right_ground_part_id"),
        ))
        if len(set(normalized_ids)) != 3:
            raise ValueError("CPW conductor part ids must be unique")
        object.__setattr__(self, "name", require_non_empty(name, "name"))
        object.__setattr__(self, "length_m", _antenna_positive(resolved_length, "length_m"))
        object.__setattr__(self, "thickness_m", _antenna_positive(resolved_thickness, "thickness_m"))
        object.__setattr__(self, "conductivity_s_per_m", _antenna_positive(resolved_conductivity, "conductivity_s_per_m"))
        object.__setattr__(self, "stations", normalized_stations)
        object.__setattr__(self, "transform", RigidTransform.identity() if transform is None else transform)
        if not isinstance(self.transform, RigidTransform):
            raise TypeError("transform must be a RigidTransform")
        object.__setattr__(self, "signal_part_id", normalized_ids[0])
        object.__setattr__(self, "left_ground_part_id", normalized_ids[1])
        object.__setattr__(self, "right_ground_part_id", normalized_ids[2])
        if not isinstance(closed_loop, bool):
            raise TypeError("closed_loop must be bool")
        loop_values = {
            "inlet_connection_length_m": inlet_connection_length_m,
            "inlet_crossbar_length_m": inlet_crossbar_length_m,
            "inlet_connection_part_id": inlet_connection_part_id,
            "inlet_connection_conductivity_s_per_m": inlet_connection_conductivity_s_per_m,
            "outlet_connection_length_m": outlet_connection_length_m,
            "outlet_crossbar_length_m": outlet_crossbar_length_m,
            "outlet_connection_part_id": outlet_connection_part_id,
            "outlet_connection_conductivity_s_per_m": outlet_connection_conductivity_s_per_m,
        }
        if not closed_loop and any(value is not None for value in loop_values.values()):
            raise ValueError("connection parameters require closed_loop=True")
        object.__setattr__(self, "closed_loop", closed_loop)
        for field, value in loop_values.items():
            if closed_loop:
                if value is None:
                    raise ValueError(f"closed_loop requires explicit {field}")
                value = (require_non_empty(value, field) if field.endswith("part_id")
                         else _antenna_positive(value, field))
            object.__setattr__(self, field, value)
        if closed_loop:
            if len(set((*normalized_ids, self.inlet_connection_part_id, self.outlet_connection_part_id))) != 5:
                raise ValueError("closed_loop part IDs must be distinct")
            for side in ("inlet", "outlet"):
                if getattr(self, f"{side}_crossbar_length_m") >= getattr(self, f"{side}_connection_length_m"):
                    raise ValueError(f"{side} crossbar must leave a positive-length feed neck")

    @property
    def geometry_name(self) -> str:
        return self.name

    @property
    def conductor_part_ids(self) -> tuple[str, str, str]:
        return self.signal_part_id, self.left_ground_part_id, self.right_ground_part_id

    @property
    def minimum_signal_width_m(self) -> float:
        return min(station.signal_width_m for station in self.stations)

    @property
    def minimum_gap_m(self) -> float:
        return min(
            min(station.left_gap_m, station.right_gap_m)
            for station in self.stations
        )

    @property
    def end_face_areas_m2(self) -> dict[str, float]:
        station = self.stations[0]
        return {
            self.signal_part_id: station.signal_width_m * self.thickness_m,
            self.left_ground_part_id: station.left_ground_width_m * self.thickness_m,
            self.right_ground_part_id: station.right_ground_width_m * self.thickness_m,
        }

    def _sections(self) -> tuple[dict[str, object], ...]:
        sections = []
        for station in self.stations:
            u_m = station.s * self.length_m
            left_center = -(station.signal_width_m / 2.0 + station.left_gap_m + station.left_ground_width_m / 2.0)
            right_center = station.signal_width_m / 2.0 + station.right_gap_m + station.right_ground_width_m / 2.0
            conductor_specs = (
                (self.signal_part_id, 0.0, station.signal_width_m),
                (self.left_ground_part_id, left_center, station.left_ground_width_m),
                (self.right_ground_part_id, right_center, station.right_ground_width_m),
            )
            conductors = {
                part_id: _section_vertices(self.transform, u_m, center_v, width, 0.0, self.thickness_m)
                for part_id, center_v, width in conductor_specs
            }
            sections.append({
                "s": station.s,
                "u_m": u_m,
                "conductors": conductors,
                "vertices": tuple(vertex for points in conductors.values() for vertex in points),
            })
        return tuple(sections)

    def connection_solids(self) -> dict[str, tuple[dict[str, object], ...]]:
        """Three necks and one crossbar per connection, in world coordinates."""
        if not self.closed_loop:
            return {}
        result = {}
        for side, station in (("inlet", self.stations[0]), ("outlet", self.stations[-1])):
            length = getattr(self, f"{side}_connection_length_m")
            bar = getattr(self, f"{side}_crossbar_length_m")
            if side == "inlet":
                neck_interval, bar_interval = (-length + bar, 0.0), (-length, -length + bar)
            else:
                neck_interval = (self.length_m, self.length_m + length - bar)
                bar_interval = (self.length_m + length - bar, self.length_m + length)
            left = -(station.signal_width_m / 2 + station.left_gap_m + station.left_ground_width_m / 2)
            right = station.signal_width_m / 2 + station.right_gap_m + station.right_ground_width_m / 2
            vmin, vmax = left - station.left_ground_width_m / 2, right + station.right_ground_width_m / 2
            specs = (
                (neck_interval, 0.0, station.signal_width_m),
                (neck_interval, left, station.left_ground_width_m),
                (neck_interval, right, station.right_ground_width_m),
                (bar_interval, (vmin + vmax) / 2, vmax - vmin),
            )
            part = getattr(self, f"{side}_connection_part_id")
            result[part] = tuple(
                {key: {"u_m": u, "vertices": vertices, "conductors": {part: vertices}}
                 for key, u in zip(("from", "to"), interval)
                 for vertices in (_section_vertices(self.transform, u, center, width, 0.0, self.thickness_m),)}
                for interval, center, width in specs
            )
        return result

    def solid_segments(self) -> tuple[dict[str, object], ...]:
        return _AntennaLayoutGeometry.solid_segments(self) + tuple(
            solid for solids in self.connection_solids().values() for solid in solids)

    def world_bounds(self) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        vertices = [v for section in self._sections() for v in section["vertices"]]
        vertices.extend(v for solids in self.connection_solids().values() for solid in solids
                        for section in solid.values() for v in section["vertices"])
        return (tuple(min(v[i] for v in vertices) for i in range(3)),
                tuple(max(v[i] for v in vertices) for i in range(3)))

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "cpw",
            **({"loop": {"enabled": True,
                "inlet_connection_length_m": self.inlet_connection_length_m,
                "inlet_crossbar_length_m": self.inlet_crossbar_length_m,
                "inlet_connection_part_id": self.inlet_connection_part_id,
                "inlet_connection_conductivity_s_per_m": self.inlet_connection_conductivity_s_per_m,
                "outlet_connection_length_m": self.outlet_connection_length_m,
                "outlet_crossbar_length_m": self.outlet_crossbar_length_m,
                "outlet_connection_part_id": self.outlet_connection_part_id,
                "outlet_connection_conductivity_s_per_m": self.outlet_connection_conductivity_s_per_m,
            }} if self.closed_loop else {}),
            "length_m": self.length_m,
            "thickness_m": self.thickness_m,
            "conductivity_s_per_m": self.conductivity_s_per_m,
            "transform": self.transform.to_ir(),
            "stations": [station.to_ir() for station in self.stations],
            "conductors": [
                {"id": self.signal_part_id, "kind": "signal"},
                {"id": self.left_ground_part_id, "kind": "ground_left"},
                {"id": self.right_ground_part_id, "kind": "ground_right"},
            ],
            "terminal_faces": {
                part_id: {"inlet": "local_u_min", "outlet": "local_u_max"}
                for part_id in self.conductor_part_ids
            },
        }

    @classmethod
    def from_ir(cls, value: Mapping[str, object]) -> "CPWAntennaLayout":
        if value.get("kind") != "cpw":
            raise ValueError("CPW layout kind is required")
        loop = value.get("loop", {})
        if not isinstance(loop, Mapping) or set(loop) - {'outlet_connection_length_m', 'inlet_crossbar_length_m', 'outlet_connection_conductivity_s_per_m', 'inlet_connection_conductivity_s_per_m', 'inlet_connection_length_m', 'inlet_connection_part_id', 'enabled', 'outlet_crossbar_length_m', 'outlet_connection_part_id'}:
            raise ValueError("CPW loop contains unsupported authored fields")
        stations = tuple(CPWWidthStation(**station) for station in value["stations"])
        signal_id, left_id, right_id = _antenna_conductor_ids(
            value.get("conductors", ()), ("signal", "ground_left", "ground_right"),
        )
        return cls(
            name=value["name"],
            length_m=value.get("length_m", value.get("length")),
            thickness_m=value.get("thickness_m", value.get("thickness")),
            conductivity_s_per_m=value.get("conductivity_s_per_m", value.get("conductivity")),
            stations=stations,
            transform=RigidTransform.from_ir(value.get("transform", RigidTransform.identity().to_ir())),
            signal_part_id=signal_id,
            left_ground_part_id=left_id,
            right_ground_part_id=right_id,
            closed_loop=loop.get("enabled", False),
            inlet_connection_length_m=loop.get("inlet_connection_length_m"),
            inlet_crossbar_length_m=loop.get("inlet_crossbar_length_m"),
            inlet_connection_part_id=loop.get("inlet_connection_part_id"),
            inlet_connection_conductivity_s_per_m=loop.get("inlet_connection_conductivity_s_per_m"),
            outlet_connection_length_m=loop.get("outlet_connection_length_m"),
            outlet_crossbar_length_m=loop.get("outlet_crossbar_length_m"),
            outlet_connection_part_id=loop.get("outlet_connection_part_id"),
            outlet_connection_conductivity_s_per_m=loop.get("outlet_connection_conductivity_s_per_m"),
        )


def _path_strip_sections(
    transform: RigidTransform,
    centerline: Sequence[tuple[float, float, float]],
    widths: Sequence[float],
    thickness_m: float,
    part_id: str,
) -> tuple[dict[str, object], ...]:
    """Generate rectangular conductor cross-sections along a 3D centerline using parallel transport."""
    n = len(centerline)
    if n < 2:
        raise ValueError("conductor centerline requires at least two points")

    def _sub(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
        return (a[0] - b[0], a[1] - b[1], a[2] - b[2])

    def _add(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
        return (a[0] + b[0], a[1] + b[1], a[2] + b[2])

    def _scale(v: tuple[float, float, float], s: float) -> tuple[float, float, float]:
        return (v[0] * s, v[1] * s, v[2] * s)

    def _dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

    def _cross(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
        return (
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        )

    def _unit(v: tuple[float, float, float]) -> tuple[float, float, float]:
        length = math.sqrt(_dot(v, v))
        if length <= 1e-18:
            return (1.0, 0.0, 0.0)
        return (v[0] / length, v[1] / length, v[2] / length)

    seg_tangents = [_unit(_sub(centerline[i + 1], centerline[i])) for i in range(n - 1)]
    tangents: list[tuple[float, float, float]] = []
    for i in range(n):
        if i == 0:
            tangents.append(seg_tangents[0])
        elif i == n - 1:
            tangents.append(seg_tangents[-1])
        else:
            avg = _add(seg_tangents[i - 1], seg_tangents[i])
            if math.sqrt(_dot(avg, avg)) <= 1e-12:
                tangents.append(seg_tangents[i])
            else:
                tangents.append(_unit(avg))

    # Initialize orthonormal thickness axis B (prefer +Z when tangent is planar in XY)
    t0 = tangents[0]
    ref_b = (0.0, 0.0, 1.0) if abs(t0[2]) < 0.9 else (0.0, 1.0, 0.0)
    n0 = _unit(_cross(ref_b, t0))
    b0 = _unit(_cross(t0, n0))

    frames: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]] = [
        (t0, n0, b0)
    ]
    for i in range(1, n):
        prev_t, prev_n, prev_b = frames[-1]
        cur_t = tangents[i]
        # Parallel transport previous normal & binormal to new tangent
        proj_n = _sub(prev_n, _scale(cur_t, _dot(prev_n, cur_t)))
        if math.sqrt(_dot(proj_n, proj_n)) > 1e-12:
            cur_n = _unit(proj_n)
            cur_b = _unit(_cross(cur_t, cur_n))
        else:
            proj_b = _sub(prev_b, _scale(cur_t, _dot(prev_b, cur_t)))
            cur_b = _unit(proj_b) if math.sqrt(_dot(proj_b, proj_b)) > 1e-12 else (0.0, 0.0, 1.0)
            cur_n = _unit(_cross(cur_b, cur_t))
        frames.append((cur_t, cur_n, cur_b))

    half_t = 0.5 * thickness_m
    total_len = 0.0
    cum_lengths = [0.0]
    for i in range(n - 1):
        d = _sub(centerline[i + 1], centerline[i])
        total_len += math.sqrt(_dot(d, d))
        cum_lengths.append(total_len)

    sections = []
    for i, point in enumerate(centerline):
        _, cur_n, cur_b = frames[i]
        half_w = 0.5 * widths[i]
        # Scale miter slightly at sharp 90-deg turns so width stays uniform
        miter_scale = 1.0
        if 0 < i < n - 1:
            cos_half = max(0.35, min(1.0, _dot(seg_tangents[i], tangents[i])))
            miter_scale = min(1.0 / cos_half, 1.6)
        nw = _scale(cur_n, half_w * miter_scale)
        tb = _scale(cur_b, half_t)
        local_quad = (
            _sub(_sub(point, nw), tb),
            _sub(_add(point, nw), tb),
            _add(_add(point, nw), tb),
            _add(_sub(point, nw), tb),
        )
        world_quad = tuple(transform.apply(v) for v in local_quad)
        s_val = cum_lengths[i] / total_len if total_len > 0.0 else float(i) / max(n - 1, 1)
        sections.append(
            {
                "s": s_val,
                "u_m": cum_lengths[i],
                "conductors": {part_id: world_quad},
                "vertices": world_quad,
            }
        )
    return tuple(sections)


@dataclass(frozen=True, slots=True, init=False)
class MeanderAntennaLayout(_AntennaLayoutGeometry):
    """3-D serpentine meander grating antenna for narrow-k spin-wave excitation."""

    name: str
    length_m: float
    signal_width_m: float
    thickness_m: float
    conductivity_s_per_m: float
    finger_count: int
    pitch_m: float
    bend_radius_m: float
    transform: RigidTransform
    signal_part_id: str

    def __init__(
        self,
        name: str,
        length_m: float | None = None,
        signal_width_m: float | None = None,
        thickness_m: float | None = None,
        conductivity_s_per_m: float | None = None,
        finger_count: int = 4,
        pitch_m: float | None = None,
        bend_radius_m: float = 0.0,
        transform: RigidTransform | None = None,
        signal_part_id: str = "signal",
        *,
        length: float | None = None,
        width: float | None = None,
        thickness: float | None = None,
        conductivity: float | None = None,
        pitch: float | None = None,
        bend_radius: float | None = None,
    ) -> None:
        resolved_length = _antenna_alias(length_m, length, "length_m")
        resolved_width = _antenna_alias(signal_width_m, width, "signal_width_m")
        resolved_thickness = _antenna_alias(thickness_m, thickness, "thickness_m")
        resolved_conductivity = _antenna_alias(conductivity_s_per_m, conductivity, "conductivity_s_per_m")
        resolved_pitch = _antenna_alias(pitch_m, pitch, "pitch_m")
        resolved_bend = bend_radius if bend_radius is not None else bend_radius_m
        if any(
            value is None
            for value in (resolved_length, resolved_width, resolved_thickness, resolved_conductivity, resolved_pitch)
        ):
            raise TypeError(
                "MeanderAntennaLayout requires length_m, signal_width_m, thickness_m, conductivity_s_per_m, and pitch_m"
            )
        if isinstance(finger_count, bool) or not isinstance(finger_count, int) or not (2 <= finger_count <= 64):
            raise ValueError("finger_count must be an integer in [2, 64]")
        val_length = _antenna_positive(resolved_length, "length_m")
        val_width = _antenna_positive(resolved_width, "signal_width_m")
        val_thickness = _antenna_positive(resolved_thickness, "thickness_m")
        val_conductivity = _antenna_positive(resolved_conductivity, "conductivity_s_per_m")
        val_pitch = _antenna_positive(resolved_pitch, "pitch_m")
        val_bend = float(resolved_bend)
        if not math.isfinite(val_bend) or val_bend < 0.0:
            raise ValueError("bend_radius_m must be finite and non-negative")
        if val_pitch <= val_width:
            raise ValueError("pitch_m must be strictly greater than signal_width_m")
        if 2.0 * val_bend + val_width > val_pitch + 1.0e-15:
            raise ValueError(
                "bend_radius_m causes meander self-intersection: require 2 * bend_radius_m + signal_width_m <= pitch_m"
            )
        resolved_transform = RigidTransform.identity() if transform is None else transform
        if not isinstance(resolved_transform, RigidTransform):
            raise TypeError("transform must be a RigidTransform")
        object.__setattr__(self, "name", require_non_empty(name, "name"))
        object.__setattr__(self, "length_m", val_length)
        object.__setattr__(self, "signal_width_m", val_width)
        object.__setattr__(self, "thickness_m", val_thickness)
        object.__setattr__(self, "conductivity_s_per_m", val_conductivity)
        object.__setattr__(self, "finger_count", finger_count)
        object.__setattr__(self, "pitch_m", val_pitch)
        object.__setattr__(self, "bend_radius_m", val_bend)
        object.__setattr__(self, "transform", resolved_transform)
        object.__setattr__(self, "signal_part_id", require_non_empty(signal_part_id, "signal_part_id"))

    @property
    def geometry_name(self) -> str:
        return self.name

    @property
    def conductor_part_ids(self) -> tuple[str, ...]:
        return (self.signal_part_id,)

    @property
    def dominant_wavenumber_rad_per_m(self) -> float:
        return math.pi / self.pitch_m

    def _sections(self) -> tuple[dict[str, object], ...]:
        half_l = 0.5 * self.length_m
        v_offset = 0.5 * (self.finger_count - 1) * self.pitch_m
        pts: list[tuple[float, float, float]] = []
        r_arc = self.bend_radius_m
        arc_steps = 6
        for k in range(self.finger_count):
            vk = k * self.pitch_m - v_offset
            u_start, u_end = (-half_l, half_l) if k % 2 == 0 else (half_l, -half_l)
            if k == 0:
                pts.append((u_start, vk, 0.0))
            pts.append((u_end, vk, 0.0))
            if k < self.finger_count - 1:
                v_next = (k + 1) * self.pitch_m - v_offset
                v_mid = 0.5 * (vk + v_next)
                if r_arc > 0.0:
                    sign_u = 1.0 if k % 2 == 0 else -1.0
                    # Smooth semicircular U-turn centered at (u_end, v_mid)
                    r_turn = 0.5 * self.pitch_m
                    for step in range(1, arc_steps):
                        theta = -0.5 * math.pi + math.pi * (step / arc_steps)
                        pts.append(
                            (
                                u_end + sign_u * r_arc * math.cos(theta),
                                v_mid + r_turn * math.sin(theta),
                                0.0,
                            )
                        )
                pts.append((u_end, v_next, 0.0))
        return _path_strip_sections(
            self.transform,
            pts,
            [self.signal_width_m] * len(pts),
            self.thickness_m,
            self.signal_part_id,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "meander",
            "length_m": self.length_m,
            "signal_width_m": self.signal_width_m,
            "thickness_m": self.thickness_m,
            "conductivity_s_per_m": self.conductivity_s_per_m,
            "finger_count": self.finger_count,
            "pitch_m": self.pitch_m,
            "bend_radius_m": self.bend_radius_m,
            "transform": self.transform.to_ir(),
            "conductors": [{"id": self.signal_part_id, "kind": "signal"}],
            "terminal_faces": {
                self.signal_part_id: {"inlet": "local_u_min", "outlet": "local_u_max"}
            },
        }

    @classmethod
    def from_ir(cls, value: Mapping[str, object]) -> "MeanderAntennaLayout":
        if value.get("kind") not in {"meander", "MeanderAntennaLayout", None}:
            raise ValueError("meander layout kind is required")
        (signal_id,) = _antenna_conductor_ids(value.get("conductors", ()), ("signal",))
        return cls(
            name=str(value["name"]),
            length_m=value.get("length_m", value.get("length")),  # type: ignore[arg-type]
            signal_width_m=value.get("signal_width_m", value.get("width")),  # type: ignore[arg-type]
            thickness_m=value.get("thickness_m", value.get("thickness")),  # type: ignore[arg-type]
            conductivity_s_per_m=value.get("conductivity_s_per_m", value.get("conductivity")),  # type: ignore[arg-type]
            finger_count=int(value.get("finger_count", 4)),  # type: ignore[arg-type]
            pitch_m=value.get("pitch_m", value.get("pitch")),  # type: ignore[arg-type]
            bend_radius_m=float(value.get("bend_radius_m", 0.0)),  # type: ignore[arg-type]
            transform=RigidTransform.from_ir(value.get("transform", RigidTransform.identity().to_ir())),  # type: ignore[arg-type]
            signal_part_id=signal_id,
        )


@dataclass(frozen=True, slots=True, init=False)
class InductiveLoopLayout(_AntennaLayoutGeometry):
    """3-D circular, rounded-rectangular, or omega-shaped micro-coil antenna."""

    name: str
    loop_shape: Literal["circular", "rectangular", "omega"]
    inner_radius_m: float
    signal_width_m: float
    thickness_m: float
    conductivity_s_per_m: float
    turns: int
    bend_radius_m: float
    feed_gap_m: float
    pitch_m: float
    transform: RigidTransform
    signal_part_id: str

    def __init__(
        self,
        name: str,
        loop_shape: Literal["circular", "rectangular", "omega"] = "circular",
        inner_radius_m: float | None = None,
        signal_width_m: float | None = None,
        thickness_m: float | None = None,
        conductivity_s_per_m: float | None = None,
        turns: int = 1,
        bend_radius_m: float = 0.0,
        feed_gap_m: float | None = None,
        pitch_m: float | None = None,
        transform: RigidTransform | None = None,
        signal_part_id: str = "signal",
        *,
        inner_radius: float | None = None,
        width: float | None = None,
        thickness: float | None = None,
        conductivity: float | None = None,
    ) -> None:
        if loop_shape not in ("circular", "rectangular", "omega"):
            raise ValueError("loop_shape must be 'circular', 'rectangular', or 'omega'")
        resolved_radius = _antenna_alias(inner_radius_m, inner_radius, "inner_radius_m")
        resolved_width = _antenna_alias(signal_width_m, width, "signal_width_m")
        resolved_thickness = _antenna_alias(thickness_m, thickness, "thickness_m")
        resolved_conductivity = _antenna_alias(conductivity_s_per_m, conductivity, "conductivity_s_per_m")
        if any(
            value is None
            for value in (resolved_radius, resolved_width, resolved_thickness, resolved_conductivity)
        ):
            raise TypeError(
                "InductiveLoopLayout requires inner_radius_m, signal_width_m, thickness_m, and conductivity_s_per_m"
            )
        if isinstance(turns, bool) or not isinstance(turns, int) or not (1 <= turns <= 16):
            raise ValueError("turns must be an integer in [1, 16]")
        val_radius = _antenna_positive(resolved_radius, "inner_radius_m")
        val_width = _antenna_positive(resolved_width, "signal_width_m")
        val_thickness = _antenna_positive(resolved_thickness, "thickness_m")
        val_conductivity = _antenna_positive(resolved_conductivity, "conductivity_s_per_m")
        val_bend = float(bend_radius_m)
        if not math.isfinite(val_bend) or val_bend < 0.0:
            raise ValueError("bend_radius_m must be finite and non-negative")
        if loop_shape == "rectangular" and val_bend > val_radius + 1.0e-15:
            raise ValueError("bend_radius_m must not exceed inner_radius_m for rectangular loops")
        val_gap = (
            min(0.5 * val_radius, val_width)
            if feed_gap_m is None
            else _antenna_positive(feed_gap_m, "feed_gap_m")
        )
        if val_gap >= 2.0 * val_radius:
            raise ValueError("feed_gap_m must be strictly smaller than 2 * inner_radius_m")
        val_pitch = (
            2.0 * val_width
            if pitch_m is None
            else _antenna_positive(pitch_m, "pitch_m")
        )
        if turns > 1 and val_pitch <= val_width:
            raise ValueError("pitch_m must exceed signal_width_m for multi-turn loops")
        resolved_transform = RigidTransform.identity() if transform is None else transform
        if not isinstance(resolved_transform, RigidTransform):
            raise TypeError("transform must be a RigidTransform")
        object.__setattr__(self, "name", require_non_empty(name, "name"))
        object.__setattr__(self, "loop_shape", loop_shape)
        object.__setattr__(self, "inner_radius_m", val_radius)
        object.__setattr__(self, "signal_width_m", val_width)
        object.__setattr__(self, "thickness_m", val_thickness)
        object.__setattr__(self, "conductivity_s_per_m", val_conductivity)
        object.__setattr__(self, "turns", turns)
        object.__setattr__(self, "bend_radius_m", val_bend)
        object.__setattr__(self, "feed_gap_m", val_gap)
        object.__setattr__(self, "pitch_m", val_pitch)
        object.__setattr__(self, "transform", resolved_transform)
        object.__setattr__(self, "signal_part_id", require_non_empty(signal_part_id, "signal_part_id"))

    @property
    def geometry_name(self) -> str:
        return self.name

    @property
    def length_m(self) -> float:
        return 2.0 * math.pi * (self.inner_radius_m + 0.5 * self.signal_width_m) * self.turns

    @property
    def conductor_part_ids(self) -> tuple[str, ...]:
        return (self.signal_part_id,)

    def _sections(self) -> tuple[dict[str, object], ...]:
        r0 = self.inner_radius_m + 0.5 * self.signal_width_m
        pts: list[tuple[float, float, float]] = []
        if self.loop_shape in ("circular", "omega"):
            half_gap_angle = math.asin(min(0.45, (0.5 * self.feed_gap_m + 0.5 * self.signal_width_m) / max(r0, 1e-18)))
            start_angle = math.pi - half_gap_angle
            sweep = 2.0 * math.pi * self.turns - 2.0 * half_gap_angle
            steps = max(24, 32 * self.turns)
            if self.loop_shape == "omega":
                stem_x = -(r0 + self.inner_radius_m)
                y_entry = r0 * math.sin(start_angle)
                pts.append((stem_x, y_entry, 0.0))
            for i in range(steps + 1):
                frac = i / steps
                angle = start_angle - frac * sweep
                radius = r0 + (self.turns - 1) * self.pitch_m * frac
                pts.append((radius * math.cos(angle), radius * math.sin(angle), 0.0))
            if self.loop_shape == "omega":
                r_end = r0 + (self.turns - 1) * self.pitch_m
                stem_x = -(r_end + self.inner_radius_m)
                y_exit = pts[-1][1]
                pts.append((stem_x, y_exit, 0.0))
        else:
            # Rounded rectangular loop opening on the -u side
            half_gap = 0.5 * self.feed_gap_m + 0.5 * self.signal_width_m
            for turn in range(self.turns):
                half = r0 + turn * self.pitch_m
                f = min(self.bend_radius_m, 0.45 * half)
                corners = [
                    (-half, half_gap, 0.0),
                    (-half, half - f, 0.0),
                    (-half + f, half, 0.0),
                    (half - f, half, 0.0),
                    (half, half - f, 0.0),
                    (half, -half + f, 0.0),
                    (half - f, -half, 0.0),
                    (-half + f, -half, 0.0),
                    (-half, -half + f, 0.0),
                    (-half, -half_gap, 0.0),
                ]
                for pt in corners:
                    if not pts or math.dist(pts[-1], pt) > 1e-15:
                        pts.append(pt)
        return _path_strip_sections(
            self.transform,
            pts,
            [self.signal_width_m] * len(pts),
            self.thickness_m,
            self.signal_part_id,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "inductive_loop",
            "loop_shape": self.loop_shape,
            "inner_radius_m": self.inner_radius_m,
            "signal_width_m": self.signal_width_m,
            "thickness_m": self.thickness_m,
            "conductivity_s_per_m": self.conductivity_s_per_m,
            "turns": self.turns,
            "bend_radius_m": self.bend_radius_m,
            "feed_gap_m": self.feed_gap_m,
            "pitch_m": self.pitch_m,
            "transform": self.transform.to_ir(),
            "conductors": [{"id": self.signal_part_id, "kind": "signal"}],
            "terminal_faces": {
                self.signal_part_id: {"inlet": "local_u_min", "outlet": "local_u_max"}
            },
        }

    @classmethod
    def from_ir(cls, value: Mapping[str, object]) -> "InductiveLoopLayout":
        if value.get("kind") not in {"inductive_loop", "InductiveLoopLayout", None}:
            raise ValueError("inductive_loop layout kind is required")
        (signal_id,) = _antenna_conductor_ids(value.get("conductors", ()), ("signal",))
        return cls(
            name=str(value["name"]),
            loop_shape=str(value.get("loop_shape", "circular")),  # type: ignore[arg-type]
            inner_radius_m=value.get("inner_radius_m", value.get("inner_radius")),  # type: ignore[arg-type]
            signal_width_m=value.get("signal_width_m", value.get("width")),  # type: ignore[arg-type]
            thickness_m=value.get("thickness_m", value.get("thickness")),  # type: ignore[arg-type]
            conductivity_s_per_m=value.get("conductivity_s_per_m", value.get("conductivity")),  # type: ignore[arg-type]
            turns=int(value.get("turns", 1)),  # type: ignore[arg-type]
            bend_radius_m=float(value.get("bend_radius_m", 0.0)),  # type: ignore[arg-type]
            feed_gap_m=value.get("feed_gap_m"),  # type: ignore[arg-type]
            pitch_m=value.get("pitch_m"),  # type: ignore[arg-type]
            transform=RigidTransform.from_ir(value.get("transform", RigidTransform.identity().to_ir())),  # type: ignore[arg-type]
            signal_part_id=signal_id,
        )


@dataclass(frozen=True, slots=True)
class Path3DWaypoint:
    """Single 3D centerline waypoint for ``PiecewisePath3DLayout``."""

    x_m: float
    y_m: float
    z_m: float
    width_m: float | None = None
    bend_radius_m: float = 0.0

    def __post_init__(self) -> None:
        for attr in ("x_m", "y_m", "z_m"):
            val = float(getattr(self, attr))
            if not math.isfinite(val):
                raise ValueError(f"waypoint {attr} must be finite")
            object.__setattr__(self, attr, val)
        if self.width_m is not None:
            object.__setattr__(self, "width_m", _antenna_positive(self.width_m, "width_m"))
        bend = float(self.bend_radius_m)
        if not math.isfinite(bend) or bend < 0.0:
            raise ValueError("waypoint bend_radius_m must be finite and non-negative")
        object.__setattr__(self, "bend_radius_m", bend)

    def to_ir(self) -> dict[str, float | None]:
        result: dict[str, float | None] = {
            "x_m": self.x_m,
            "y_m": self.y_m,
            "z_m": self.z_m,
            "bend_radius_m": self.bend_radius_m,
        }
        if self.width_m is not None:
            result["width_m"] = self.width_m
        return result


@dataclass(frozen=True, slots=True, init=False)
class PiecewisePath3DLayout(_AntennaLayoutGeometry):
    """Arbitrary 3-D piecewise conductor path / air-bridge with optional corner fillets."""

    name: str
    waypoints: tuple[Path3DWaypoint, ...]
    signal_width_m: float
    thickness_m: float
    conductivity_s_per_m: float
    transform: RigidTransform
    signal_part_id: str

    def __init__(
        self,
        name: str,
        waypoints: Sequence[Path3DWaypoint | Mapping[str, object] | Sequence[float]],
        signal_width_m: float | None = None,
        thickness_m: float | None = None,
        conductivity_s_per_m: float | None = None,
        transform: RigidTransform | None = None,
        signal_part_id: str = "signal",
        *,
        width: float | None = None,
        thickness: float | None = None,
        conductivity: float | None = None,
    ) -> None:
        resolved_width = _antenna_alias(signal_width_m, width, "signal_width_m")
        resolved_thickness = _antenna_alias(thickness_m, thickness, "thickness_m")
        resolved_conductivity = _antenna_alias(conductivity_s_per_m, conductivity, "conductivity_s_per_m")
        if any(value is None for value in (resolved_width, resolved_thickness, resolved_conductivity)):
            raise TypeError(
                "PiecewisePath3DLayout requires signal_width_m, thickness_m, and conductivity_s_per_m"
            )
        if isinstance(waypoints, (str, bytes)) or not isinstance(waypoints, Sequence) or len(waypoints) < 2:
            raise ValueError("PiecewisePath3DLayout requires at least two distinct 3D waypoints")
        normalized_waypoints: list[Path3DWaypoint] = []
        for entry in waypoints:
            if isinstance(entry, Path3DWaypoint):
                wp = entry
            elif isinstance(entry, Mapping):
                wp = Path3DWaypoint(
                    x_m=float(entry.get("x_m", entry.get("x"))),  # type: ignore[arg-type]
                    y_m=float(entry.get("y_m", entry.get("y"))),  # type: ignore[arg-type]
                    z_m=float(entry.get("z_m", entry.get("z"))),  # type: ignore[arg-type]
                    width_m=entry.get("width_m"),  # type: ignore[arg-type]
                    bend_radius_m=float(entry.get("bend_radius_m", 0.0)),  # type: ignore[arg-type]
                )
            elif isinstance(entry, Sequence) and not isinstance(entry, (str, bytes)) and len(entry) == 3:
                wp = Path3DWaypoint(float(entry[0]), float(entry[1]), float(entry[2]))
            else:
                raise TypeError("each waypoint must be a Path3DWaypoint, mapping, or 3-tuple")
            if normalized_waypoints:
                prev = normalized_waypoints[-1]
                if math.dist((prev.x_m, prev.y_m, prev.z_m), (wp.x_m, wp.y_m, wp.z_m)) <= 1.0e-12:
                    raise ValueError("consecutive 3D waypoints must be distinct")
            normalized_waypoints.append(wp)
        resolved_transform = RigidTransform.identity() if transform is None else transform
        if not isinstance(resolved_transform, RigidTransform):
            raise TypeError("transform must be a RigidTransform")
        object.__setattr__(self, "name", require_non_empty(name, "name"))
        object.__setattr__(self, "waypoints", tuple(normalized_waypoints))
        object.__setattr__(self, "signal_width_m", _antenna_positive(resolved_width, "signal_width_m"))
        object.__setattr__(self, "thickness_m", _antenna_positive(resolved_thickness, "thickness_m"))
        object.__setattr__(self, "conductivity_s_per_m", _antenna_positive(resolved_conductivity, "conductivity_s_per_m"))
        object.__setattr__(self, "transform", resolved_transform)
        object.__setattr__(self, "signal_part_id", require_non_empty(signal_part_id, "signal_part_id"))

    @property
    def geometry_name(self) -> str:
        return self.name

    @property
    def length_m(self) -> float:
        return sum(
            math.dist(
                (a.x_m, a.y_m, a.z_m),
                (b.x_m, b.y_m, b.z_m),
            )
            for a, b in zip(self.waypoints, self.waypoints[1:])
        )

    @property
    def conductor_part_ids(self) -> tuple[str, ...]:
        return (self.signal_part_id,)

    def _sections(self) -> tuple[dict[str, object], ...]:
        raw_pts = [(wp.x_m, wp.y_m, wp.z_m) for wp in self.waypoints]
        raw_widths = [wp.width_m if wp.width_m is not None else self.signal_width_m for wp in self.waypoints]
        pts: list[tuple[float, float, float]] = [raw_pts[0]]
        widths: list[float] = [raw_widths[0]]
        for idx in range(1, len(raw_pts) - 1):
            wp = self.waypoints[idx]
            prev_pt = raw_pts[idx - 1]
            cur_pt = raw_pts[idx]
            next_pt = raw_pts[idx + 1]
            if wp.bend_radius_m > 0.0:
                len_in = math.dist(prev_pt, cur_pt)
                len_out = math.dist(cur_pt, next_pt)
                trim = min(wp.bend_radius_m, 0.4 * len_in, 0.4 * len_out)
                if trim > 1e-15:
                    p_in = tuple(
                        cur_pt[c] + (prev_pt[c] - cur_pt[c]) * (trim / len_in)
                        for c in range(3)
                    )
                    p_out = tuple(
                        cur_pt[c] + (next_pt[c] - cur_pt[c]) * (trim / len_out)
                        for c in range(3)
                    )
                    # Quadratic Bezier corner fillet across 5 samples
                    for step in range(5):
                        t = step / 4.0
                        omt = 1.0 - t
                        bez = tuple(
                            omt * omt * p_in[c] + 2.0 * omt * t * cur_pt[c] + t * t * p_out[c]
                            for c in range(3)
                        )
                        if math.dist(pts[-1], bez) > 1e-15:
                            pts.append(bez)
                            widths.append(raw_widths[idx])
                    continue
            pts.append(cur_pt)
            widths.append(raw_widths[idx])
        if math.dist(pts[-1], raw_pts[-1]) > 1e-15:
            pts.append(raw_pts[-1])
            widths.append(raw_widths[-1])
        return _path_strip_sections(
            self.transform,
            pts,
            widths,
            self.thickness_m,
            self.signal_part_id,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "piecewise_3d_path",
            "waypoints": [wp.to_ir() for wp in self.waypoints],
            "signal_width_m": self.signal_width_m,
            "thickness_m": self.thickness_m,
            "conductivity_s_per_m": self.conductivity_s_per_m,
            "transform": self.transform.to_ir(),
            "conductors": [{"id": self.signal_part_id, "kind": "signal"}],
            "terminal_faces": {
                self.signal_part_id: {"inlet": "local_u_min", "outlet": "local_u_max"}
            },
        }

    @classmethod
    def from_ir(cls, value: Mapping[str, object]) -> "PiecewisePath3DLayout":
        if value.get("kind") not in {"piecewise_3d_path", "PiecewisePath3DLayout", None}:
            raise ValueError("piecewise_3d_path layout kind is required")
        (signal_id,) = _antenna_conductor_ids(value.get("conductors", ()), ("signal",))
        return cls(
            name=str(value["name"]),
            waypoints=value["waypoints"],  # type: ignore[arg-type]
            signal_width_m=value.get("signal_width_m", value.get("width")),  # type: ignore[arg-type]
            thickness_m=value.get("thickness_m", value.get("thickness")),  # type: ignore[arg-type]
            conductivity_s_per_m=value.get("conductivity_s_per_m", value.get("conductivity")),  # type: ignore[arg-type]
            transform=RigidTransform.from_ir(value.get("transform", RigidTransform.identity().to_ir())),  # type: ignore[arg-type]
            signal_part_id=signal_id,
        )


ANTENNA_LAYOUT_TYPES = (
    MicrostripAntennaLayout,
    CPWAntennaLayout,
    MeanderAntennaLayout,
    InductiveLoopLayout,
    PiecewisePath3DLayout,
)

AntennaLayout: TypeAlias = (
    MicrostripAntennaLayout
    | CPWAntennaLayout
    | MeanderAntennaLayout
    | InductiveLoopLayout
    | PiecewisePath3DLayout
)


# ---------------------------------------------------------------------------
# Primitive shapes
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Box(_GeometryOps):
    """Axis-aligned box centered at origin."""

    size: tuple[float, float, float]
    name: str = "box"

    def __init__(
        self,
        size_or_x: tuple[float, float, float] | float | None = None,
        y: float | None = None,
        z: float | None = None,
        *,
        size: tuple[float, float, float] | None = None,
        name: str = "box",
    ) -> None:
        # Support both Box(size=(dx,dy,dz)) and Box(dx, dy, dz)
        if size is not None:
            resolved = size
        elif isinstance(size_or_x, (list, tuple)):
            resolved = size_or_x
        elif size_or_x is not None and y is not None and z is not None:
            resolved = (size_or_x, y, z)
        elif size_or_x is not None:
            raise TypeError("Box() requires 3 dimensions: Box(dx, dy, dz) or Box(size=(dx, dy, dz))")
        else:
            raise TypeError("Box() requires size argument")
        normalized_size = as_vector3(resolved, "size")
        for index, component in enumerate(normalized_size):
            require_positive(component, f"size[{index}]")
        object.__setattr__(self, "size", normalized_size)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "box",
            "size": list(self.size),
        }


@dataclass(frozen=True, slots=True)
class Cylinder(_GeometryOps):
    """Circular cylinder centered at origin."""

    radius: float
    height: float
    axis: tuple[float, float, float]
    name: str = "cylinder"

    def __init__(
        self,
        radius: float,
        height: float,
        name: str = "cylinder",
        *,
        axis: tuple[float, float, float] = (0.0, 0.0, 1.0),
    ) -> None:
        object.__setattr__(self, "radius", require_positive(radius, "radius"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "axis", _normalize_unit_vector3(axis, "axis"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "cylinder",
            "radius": self.radius,
            "height": self.height,
            "axis": list(self.axis),
        }


@dataclass(frozen=True, slots=True)
class SinWaveguide(_GeometryOps):
    length: float
    width: float
    height: float
    period: float
    amplitude: float
    phase: float = 0.0
    z0: float = 0.0
    name: str = "sin_waveguide"

    def __init__(
        self,
        length: float,
        width: float,
        height: float,
        period: float,
        amplitude: float,
        *,
        phase: float = 0.0,
        z0: float = 0.0,
        name: str = "sin_waveguide",
    ) -> None:
        object.__setattr__(self, "length", require_positive(length, "length"))
        object.__setattr__(self, "width", require_positive(width, "width"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "period", require_positive(period, "period"))
        object.__setattr__(self, "amplitude", _require_finite(amplitude, "amplitude"))
        object.__setattr__(self, "phase", _require_finite(phase, "phase"))
        object.__setattr__(self, "z0", _require_finite(z0, "z0"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "sin_waveguide",
            "length": self.length,
            "width": self.width,
            "height": self.height,
            "period": self.period,
            "amplitude": self.amplitude,
            "phase": self.phase,
            "z0": self.z0,
        }


@dataclass(frozen=True, slots=True)
class ArchWaveguide(_GeometryOps):
    length: float
    width: float
    height: float
    arch_height: float
    z0: float = 0.0
    name: str = "arch_waveguide"

    def __init__(
        self,
        length: float,
        width: float,
        height: float,
        arch_height: float,
        *,
        z0: float = 0.0,
        name: str = "arch_waveguide",
    ) -> None:
        object.__setattr__(self, "length", require_positive(length, "length"))
        object.__setattr__(self, "width", require_positive(width, "width"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "arch_height", _require_finite(arch_height, "arch_height"))
        object.__setattr__(self, "z0", _require_finite(z0, "z0"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "arch_waveguide",
            "length": self.length,
            "width": self.width,
            "height": self.height,
            "arch_height": self.arch_height,
            "z0": self.z0,
        }


@dataclass(frozen=True, slots=True)
class Ellipsoid(_GeometryOps):
    """Ellipsoid centered at origin with semi-axes (rx, ry, rz).

    For a sphere, use ``Sphere(r)`` or ``Ellipsoid(r, r, r)``.
    """

    rx: float
    ry: float
    rz: float
    name: str = "ellipsoid"

    def __init__(
        self, rx: float, ry: float, rz: float, name: str = "ellipsoid"
    ) -> None:
        object.__setattr__(self, "rx", require_positive(rx, "rx"))
        object.__setattr__(self, "ry", require_positive(ry, "ry"))
        object.__setattr__(self, "rz", require_positive(rz, "rz"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "ellipsoid",
            "radii": [self.rx, self.ry, self.rz],
        }


def Sphere(radius: float, name: str = "sphere") -> Ellipsoid:
    """Convenience constructor for a sphere (uniform ellipsoid)."""
    return Ellipsoid(rx=radius, ry=radius, rz=radius, name=name)


@dataclass(frozen=True, slots=True)
class Ellipse(_GeometryOps):
    """Elliptical disk centered at origin, axis along z.

    For a circular disk, use ``Ellipse(r, r, h)`` or just ``Cylinder(r, h)``.
    """

    rx: float
    ry: float
    height: float
    name: str = "ellipse"

    def __init__(
        self, rx: float, ry: float, height: float, name: str = "ellipse"
    ) -> None:
        object.__setattr__(self, "rx", require_positive(rx, "rx"))
        object.__setattr__(self, "ry", require_positive(ry, "ry"))
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "ellipse",
            "radii": [float(self.rx), float(self.ry)],
            "height": float(self.height),
        }


@dataclass(frozen=True, slots=True)
class Cone(_GeometryOps):
    """Right circular cone or frustum centered at origin along ``axis``."""

    radius_bottom: float
    radius_top: float
    height: float
    axis: tuple[float, float, float] = (0.0, 0.0, 1.0)
    name: str = "cone"

    def __init__(
        self,
        radius_bottom: float,
        radius_top: float,
        height: float,
        axis: tuple[float, float, float] = (0.0, 0.0, 1.0),
        name: str = "cone",
    ) -> None:
        rb = _require_non_negative(radius_bottom, "radius_bottom")
        rt = _require_non_negative(radius_top, "radius_top")
        if rb <= 0.0 and rt <= 0.0:
            raise ValueError("Cone requires at least one positive radius (radius_bottom or radius_top)")
        object.__setattr__(self, "radius_bottom", rb)
        object.__setattr__(self, "radius_top", rt)
        object.__setattr__(self, "height", require_positive(height, "height"))
        object.__setattr__(self, "axis", _normalize_unit_vector3(axis, "axis"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "cone",
            "radius_bottom": self.radius_bottom,
            "radius_top": self.radius_top,
            "height": self.height,
            "axis": list(self.axis),
        }


@dataclass(frozen=True, slots=True)
class Torus(_GeometryOps):
    """Torus centered at origin with symmetry axis ``axis``."""

    major_radius: float
    minor_radius: float
    axis: tuple[float, float, float] = (0.0, 0.0, 1.0)
    name: str = "torus"

    def __init__(
        self,
        major_radius: float,
        minor_radius: float,
        axis: tuple[float, float, float] = (0.0, 0.0, 1.0),
        name: str = "torus",
    ) -> None:
        r_maj = require_positive(major_radius, "major_radius")
        r_min = require_positive(minor_radius, "minor_radius")
        if r_min >= r_maj:
            raise ValueError(
                f"Torus requires minor_radius < major_radius (got minor_radius={r_min}, major_radius={r_maj})"
            )
        object.__setattr__(self, "major_radius", r_maj)
        object.__setattr__(self, "minor_radius", r_min)
        object.__setattr__(self, "axis", _normalize_unit_vector3(axis, "axis"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "torus",
            "major_radius": self.major_radius,
            "minor_radius": self.minor_radius,
            "axis": list(self.axis),
        }


@dataclass(frozen=True, slots=True)
class PolygonPrism(_GeometryOps):
    """2D simple polygon extruded symmetrically along Z in ``[-thickness/2, +thickness/2]``."""

    vertices_xy: tuple[tuple[float, float], ...]
    thickness: float
    name: str = "polygon_prism"

    def __init__(
        self,
        vertices_xy: Sequence[Sequence[float]],
        thickness: float,
        name: str = "polygon_prism",
    ) -> None:
        if isinstance(vertices_xy, (str, bytes)) or not isinstance(vertices_xy, Sequence) or len(vertices_xy) < 3:
            raise ValueError("PolygonPrism requires at least 3 2D vertices")
        pts: list[tuple[float, float]] = []
        for idx, raw_pt in enumerate(vertices_xy):
            if isinstance(raw_pt, (str, bytes)) or not isinstance(raw_pt, Sequence) or len(raw_pt) != 2:
                raise ValueError(f"PolygonPrism vertices_xy[{idx}] must be a 2-tuple (x, y)")
            pts.append(
                (
                    _require_finite(float(raw_pt[0]), f"vertices_xy[{idx}][0]"),
                    _require_finite(float(raw_pt[1]), f"vertices_xy[{idx}][1]"),
                )
            )
        area2 = 0.0
        n = len(pts)
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            area2 += x0 * y1 - x1 * y0
        if abs(area2) <= 0.0:
            raise ValueError("PolygonPrism vertices_xy must have non-zero area")
        object.__setattr__(self, "vertices_xy", tuple(pts))
        object.__setattr__(self, "thickness", require_positive(thickness, "thickness"))
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "polygon_prism",
            "vertices_xy": [[x, y] for x, y in self.vertices_xy],
            "thickness": self.thickness,
        }


# ---------------------------------------------------------------------------
# CSG boolean operations
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Difference(_GeometryOps):
    """CSG Boolean difference: base geometry minus tool geometry.

    Example: Box with a cylindrical hole::

        body = fm.Box(size=(1e-6, 1e-6, 10e-9)) - fm.Cylinder(radius=50e-9, height=10e-9)
    """

    base: "Geometry"
    tool: "Geometry"
    name: str = "difference"

    def __init__(
        self,
        base: "Geometry",
        tool: "Geometry",
        name: str = "difference",
    ) -> None:
        object.__setattr__(self, "base", base)
        object.__setattr__(self, "tool", tool)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "difference",
            "base": self.base.to_ir(),
            "tool": self.tool.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class Union(_GeometryOps):
    """CSG Boolean union: combine two geometries.

    Example::

        body = fm.Box(size=(1e-6, 1e-6, 10e-9)) + fm.Cylinder(radius=50e-9, height=10e-9)
    """

    a: "Geometry"
    b: "Geometry"
    name: str = "union"

    def __init__(
        self,
        a: "Geometry",
        b: "Geometry",
        name: str = "union",
    ) -> None:
        object.__setattr__(self, "a", a)
        object.__setattr__(self, "b", b)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "union",
            "a": self.a.to_ir(),
            "b": self.b.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class Intersection(_GeometryOps):
    """CSG Boolean intersection: keep only overlapping region.

    Example::

        body = fm.Box(size=(1e-6, 1e-6, 10e-9)) & fm.Cylinder(radius=50e-9, height=10e-9)
    """

    a: "Geometry"
    b: "Geometry"
    name: str = "intersection"

    def __init__(
        self,
        a: "Geometry",
        b: "Geometry",
        name: str = "intersection",
    ) -> None:
        object.__setattr__(self, "a", a)
        object.__setattr__(self, "b", b)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "intersection",
            "a": self.a.to_ir(),
            "b": self.b.to_ir(),
        }


# ---------------------------------------------------------------------------
# Spatial transformations
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Translate(_GeometryOps):
    """Translate (offset) a geometry by a 3D vector.

    Example: Hole off-center::

        hole = fm.Cylinder(radius=50e-9, height=10e-9).translate((100e-9, 0, 0))
    """

    geometry: "Geometry"
    offset: tuple[float, float, float]
    name: str | None = None

    def __init__(
        self,
        geometry: "Geometry",
        offset: tuple[float, float, float],
        name: str | None = None,
    ) -> None:
        object.__setattr__(self, "geometry", geometry)
        normalized_offset = as_vector3(offset, "offset")
        object.__setattr__(self, "offset", normalized_offset)
        if name is not None:
            object.__setattr__(self, "name", require_non_empty(name, "name"))
        else:
            object.__setattr__(self, "name", None)

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return _derived_translate_name(self.geometry.geometry_name, self.offset)

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.geometry_name,
            "kind": "translate",
            "base": self.geometry.to_ir(),
            "by": list(self.offset),
        }


@dataclass(frozen=True, slots=True)
class Xor(_GeometryOps):
    """CSG symmetric difference (XOR): points in ``left`` or ``right`` but not both."""

    left: "Geometry"
    right: "Geometry"
    name: str = "xor"

    def __init__(
        self,
        left: "Geometry",
        right: "Geometry",
        name: str = "xor",
    ) -> None:
        object.__setattr__(self, "left", left)
        object.__setattr__(self, "right", right)
        object.__setattr__(self, "name", require_non_empty(name, "name"))

    @property
    def geometry_name(self) -> str:
        return self.name

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "xor",
            "left": self.left.to_ir(),
            "right": self.right.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class Transform(_GeometryOps):
    """Affine TRS transform ``M = T(translation + pivot) R(rotation_quat) S(scale) T(-pivot)``."""

    child: "Geometry"
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation_quat: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    pivot: tuple[float, float, float] = (0.0, 0.0, 0.0)
    name: str | None = None

    def __init__(
        self,
        child: "Geometry",
        translation: tuple[float, float, float] = (0.0, 0.0, 0.0),
        rotation_quat: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0),
        scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
        pivot: tuple[float, float, float] = (0.0, 0.0, 0.0),
        name: str | None = None,
    ) -> None:
        norm_t = as_vector3(translation, "translation")
        norm_q = normalize_quaternion(rotation_quat, "rotation_quat")
        norm_s = as_vector3(scale, "scale")
        for idx, comp in enumerate(norm_s):
            if comp <= 0.0:
                raise ValueError(f"Transform scale[{idx}] must be positive, got {comp}")
        norm_p = as_vector3(pivot, "pivot")
        object.__setattr__(self, "child", child)
        object.__setattr__(self, "translation", norm_t)
        object.__setattr__(self, "rotation_quat", norm_q)
        object.__setattr__(self, "scale", norm_s)
        object.__setattr__(self, "pivot", norm_p)
        if name is not None:
            object.__setattr__(self, "name", require_non_empty(name, "name"))
        else:
            object.__setattr__(self, "name", None)

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return _derived_transform_name(
            self.child.geometry_name,
            self.translation,
            self.rotation_quat,
            self.scale,
            self.pivot,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.geometry_name,
            "kind": "transform",
            "child": self.child.to_ir(),
            "translation": list(self.translation),
            "rotation_quat": list(self.rotation_quat),
            "scale": list(self.scale),
            "pivot": list(self.pivot),
        }


@dataclass(frozen=True, slots=True)
class SlicePlane(_GeometryOps):
    """Clip a solid geometry against an oriented half-space plane."""

    child: "Geometry"
    plane_origin: tuple[float, float, float] = (0.0, 0.0, 0.0)
    plane_normal: tuple[float, float, float] = (0.0, 0.0, 1.0)
    keep_side: Literal["positive", "negative"] = "positive"
    name: str | None = None

    def __init__(
        self,
        child: "Geometry",
        plane_origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
        plane_normal: tuple[float, float, float] = (0.0, 0.0, 1.0),
        keep_side: Literal["positive", "negative"] = "positive",
        name: str | None = None,
    ) -> None:
        norm_origin = as_vector3(plane_origin, "plane_origin")
        norm_normal = _normalize_unit_vector3(plane_normal, "plane_normal")
        side = str(keep_side).strip().lower()
        if side not in {"positive", "negative"}:
            raise ValueError(f"keep_side must be 'positive' or 'negative', got {keep_side!r}")
        object.__setattr__(self, "child", child)
        object.__setattr__(self, "plane_origin", norm_origin)
        object.__setattr__(self, "plane_normal", norm_normal)
        object.__setattr__(self, "keep_side", side)
        if name is not None:
            object.__setattr__(self, "name", require_non_empty(name, "name"))
        else:
            object.__setattr__(self, "name", None)

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return _derived_slice_plane_name(
            self.child.geometry_name,
            self.plane_origin,
            self.plane_normal,
            self.keep_side,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.geometry_name,
            "kind": "slice_plane",
            "child": self.child.to_ir(),
            "plane_origin": list(self.plane_origin),
            "plane_normal": list(self.plane_normal),
            "keep_side": self.keep_side,
        }


@dataclass(frozen=True, slots=True)
class ArrayAxisSpec:
    """Single-axis lattice specification for ``Array3D``."""

    axis: Literal["x", "y", "z"]
    enabled: bool = False
    count: int = 1
    direction: Literal["positive", "negative", "symmetric"] = "positive"
    spacing_mode: Literal["lattice_step", "bounding_box_gap"] = "lattice_step"
    pitch_m: float = 0.0
    relative_factor: float = 1.0
    gap_m: float = 0.0
    step_translation_extra_m: tuple[float, float, float] = (0.0, 0.0, 0.0)
    step_rotation_euler_deg: tuple[float, float, float] = (0.0, 0.0, 0.0)
    step_scale_factor: tuple[float, float, float] = (1.0, 1.0, 1.0)

    def __init__(
        self,
        axis: Literal["x", "y", "z"],
        enabled: bool = False,
        count: int = 1,
        direction: str = "positive",
        spacing_mode: str = "lattice_step",
        pitch_m: float = 0.0,
        relative_factor: float = 1.0,
        gap_m: float = 0.0,
        step_translation_extra_m: Sequence[float] = (0.0, 0.0, 0.0),
        step_rotation_euler_deg: Sequence[float] = (0.0, 0.0, 0.0),
        step_scale_factor: Sequence[float] = (1.0, 1.0, 1.0),
    ) -> None:
        axis_norm = str(axis).strip().lower()
        if axis_norm not in {"x", "y", "z"}:
            raise ValueError(f"ArrayAxisSpec axis must be 'x', 'y', or 'z', got {axis!r}")
        if isinstance(count, bool) or not isinstance(count, int) or count < 1 or count > MAX_ARRAY_AXIS_COUNT:
            raise ValueError(
                f"ArrayAxisSpec count must be an integer in 1..={MAX_ARRAY_AXIS_COUNT}, got {count!r}"
            )
        norm_dir = _normalize_array_direction(direction)
        norm_mode = _normalize_array_spacing_mode(spacing_mode)
        norm_pitch = _require_finite(pitch_m, "pitch_m")
        norm_rel = _require_finite(relative_factor, "relative_factor")
        norm_gap = _require_finite(gap_m, "gap_m")
        norm_extra = as_vector3(step_translation_extra_m, "step_translation_extra_m")  # type: ignore[arg-type]
        norm_rot = as_vector3(step_rotation_euler_deg, "step_rotation_euler_deg")  # type: ignore[arg-type]
        norm_scale = as_vector3(step_scale_factor, "step_scale_factor")  # type: ignore[arg-type]
        for idx, comp in enumerate(norm_scale):
            if comp <= 0.0:
                raise ValueError(f"ArrayAxisSpec step_scale_factor[{idx}] must be positive, got {comp}")
        object.__setattr__(self, "axis", axis_norm)
        object.__setattr__(self, "enabled", bool(enabled))
        object.__setattr__(self, "count", int(count))
        object.__setattr__(self, "direction", norm_dir)
        object.__setattr__(self, "spacing_mode", norm_mode)
        object.__setattr__(self, "pitch_m", norm_pitch)
        object.__setattr__(self, "relative_factor", norm_rel)
        object.__setattr__(self, "gap_m", norm_gap)
        object.__setattr__(self, "step_translation_extra_m", norm_extra)
        object.__setattr__(self, "step_rotation_euler_deg", norm_rot)
        object.__setattr__(self, "step_scale_factor", norm_scale)

    @property
    def axis_index(self) -> int:
        return {"x": 0, "y": 1, "z": 2}[self.axis]

    def effective_count(self) -> int:
        return self.count if self.enabled else 1

    def canonical_indices(self) -> tuple[float, ...]:
        """Return canonical lattice index coordinates ``k_a`` preserving stable ID ordering."""
        n = self.effective_count()
        if n <= 1:
            return (0.0,)
        if self.direction == "positive":
            return tuple(float(i) for i in range(n))
        if self.direction == "negative":
            return tuple(-float(i) for i in range(n))
        # symmetric: even N=2 -> (-0.5, +0.5), odd N=3 -> (-1.0, 0.0, +1.0)
        offset = 0.5 * (n - 1)
        return tuple(float(i) - offset for i in range(n))

    def index_min_offset(self) -> float:
        """Lowest lattice coordinate ``k_start`` such that ``k in {k_start + 0, ..., k_start + N - 1}``."""
        n = self.effective_count()
        if n <= 1 or self.direction == "positive":
            return 0.0
        if self.direction == "negative":
            return -float(n - 1)
        return -0.5 * float(n - 1)

    def step_vector(self, child_extent: tuple[float, float, float]) -> tuple[float, float, float]:
        idx = self.axis_index
        if self.spacing_mode == "lattice_step":
            delta = self.pitch_m
        else:
            delta = self.relative_factor * child_extent[idx] + self.gap_m
        vx, vy, vz = self.step_translation_extra_m
        if idx == 0:
            vx += delta
        elif idx == 1:
            vy += delta
        else:
            vz += delta
        return (vx, vy, vz)

    def to_ir(self) -> dict[str, object]:
        return {
            "axis": self.axis,
            "enabled": self.enabled,
            "count": self.count,
            "direction": self.direction,
            "spacing_mode": self.spacing_mode,
            "pitch_m": self.pitch_m,
            "relative_factor": self.relative_factor,
            "gap_m": self.gap_m,
            "step_translation_extra_m": list(self.step_translation_extra_m),
            "step_rotation_euler_deg": list(self.step_rotation_euler_deg),
            "step_scale_factor": list(self.step_scale_factor),
        }

    @classmethod
    def from_ir(
        cls,
        value: Mapping[str, object],
        *,
        default_axis: Literal["x", "y", "z"] = "x",
    ) -> "ArrayAxisSpec":
        return cls(
            axis=str(value.get("axis", default_axis)),  # type: ignore[arg-type]
            enabled=bool(value.get("enabled", int(value.get("count", 1)) > 1)),
            count=int(value.get("count", 1)),
            direction=str(value.get("direction", "positive")),
            spacing_mode=str(value.get("spacing_mode", "lattice_step")),
            pitch_m=float(value.get("pitch_m", 0.0)),
            relative_factor=float(value.get("relative_factor", 1.0)),
            gap_m=float(value.get("gap_m", 0.0)),
            step_translation_extra_m=value.get("step_translation_extra_m", (0.0, 0.0, 0.0)),  # type: ignore[arg-type]
            step_rotation_euler_deg=value.get("step_rotation_euler_deg", (0.0, 0.0, 0.0)),  # type: ignore[arg-type]
            step_scale_factor=value.get("step_scale_factor", (1.0, 1.0, 1.0)),  # type: ignore[arg-type]
        )


def _derived_array3d_name(
    base_name: str,
    axes: tuple[ArrayAxisSpec, ArrayAxisSpec, ArrayAxisSpec],
    merge_overlapping: bool,
) -> str:
    dims = "x".join(str(ax.effective_count()) for ax in axes)
    parts = [f"{base_name}__array3d_{dims}"]
    for ax in axes:
        if ax.effective_count() > 1:
            parts.append(
                f"{ax.axis}_{ax.direction}_{ax.spacing_mode}_"
                f"{_format_translation_component(ax.pitch_m)}_"
                f"{_format_translation_component(ax.gap_m)}"
            )
    if merge_overlapping:
        parts.append("merged")
    return "__".join(parts)


@dataclass(frozen=True, slots=True)
class Array3D(_GeometryOps):
    """3D parametric Bravais / stepped lattice array modifier."""

    child: "Geometry"
    axes: tuple[ArrayAxisSpec, ArrayAxisSpec, ArrayAxisSpec]
    merge_overlapping: bool = False
    name: str | None = None

    def __init__(
        self,
        child: "Geometry",
        axes: Sequence[ArrayAxisSpec | Mapping[str, object]],
        merge_overlapping: bool = False,
        name: str | None = None,
    ) -> None:
        if isinstance(axes, (str, bytes)) or not isinstance(axes, Sequence) or len(axes) != 3:
            raise ValueError("Array3D requires exactly 3 ArrayAxisSpec entries for x, y, z")
        default_names: tuple[Literal["x", "y", "z"], ...] = ("x", "y", "z")
        parsed: dict[str, ArrayAxisSpec] = {}
        for idx, raw_ax in enumerate(axes):
            if isinstance(raw_ax, ArrayAxisSpec):
                spec = raw_ax
            elif isinstance(raw_ax, Mapping):
                spec = ArrayAxisSpec.from_ir(raw_ax, default_axis=default_names[idx])
            else:
                raise TypeError(f"Array3D axes[{idx}] must be an ArrayAxisSpec or mapping")
            if spec.axis in parsed:
                raise ValueError(f"Array3D duplicate axis specification for {spec.axis!r}")
            parsed[spec.axis] = spec
        if set(parsed.keys()) != {"x", "y", "z"}:
            raise ValueError("Array3D axes must cover 'x', 'y', and 'z'")
        ordered = (parsed["x"], parsed["y"], parsed["z"])
        total = ordered[0].effective_count() * ordered[1].effective_count() * ordered[2].effective_count()
        if total > MAX_ARRAY_INSTANCES_FDM:
            raise ValueError(
                f"Array3D total instance count {total} exceeds maximum allowed {MAX_ARRAY_INSTANCES_FDM}"
            )
        object.__setattr__(self, "child", child)
        object.__setattr__(self, "axes", ordered)
        object.__setattr__(self, "merge_overlapping", bool(merge_overlapping))
        if name is not None:
            object.__setattr__(self, "name", require_non_empty(name, "name"))
        else:
            object.__setattr__(self, "name", None)

    @property
    def total_instances(self) -> int:
        return (
            self.axes[0].effective_count()
            * self.axes[1].effective_count()
            * self.axes[2].effective_count()
        )

    @property
    def has_step_rotation_or_scale(self) -> bool:
        for ax in self.axes:
            if ax.effective_count() <= 1:
                continue
            if any(abs(r) > 1e-15 for r in ax.step_rotation_euler_deg):
                return True
            if any(abs(s - 1.0) > 1e-15 for s in ax.step_scale_factor):
                return True
        return False

    def instance_transforms(
        self,
        child_extent: tuple[float, float, float],
    ) -> list[tuple[tuple[float, float, float], tuple[float, float, float, float], tuple[float, float, float]]]:
        """Enumerate ``(translation, rotation_quat, scale)`` for every instance in canonical order."""
        v0 = self.axes[0].step_vector(child_extent)
        v1 = self.axes[1].step_vector(child_extent)
        v2 = self.axes[2].step_vector(child_extent)
        r0 = self.axes[0].step_rotation_euler_deg
        r1 = self.axes[1].step_rotation_euler_deg
        r2 = self.axes[2].step_rotation_euler_deg
        s0 = self.axes[0].step_scale_factor
        s1 = self.axes[1].step_scale_factor
        s2 = self.axes[2].step_scale_factor
        has_rot_scale = self.has_step_rotation_or_scale
        identity_q = (0.0, 0.0, 0.0, 1.0)
        identity_s = (1.0, 1.0, 1.0)
        result: list[
            tuple[tuple[float, float, float], tuple[float, float, float, float], tuple[float, float, float]]
        ] = []
        for kx in self.axes[0].canonical_indices():
            for ky in self.axes[1].canonical_indices():
                for kz in self.axes[2].canonical_indices():
                    tx = kx * v0[0] + ky * v1[0] + kz * v2[0]
                    ty = kx * v0[1] + ky * v1[1] + kz * v2[1]
                    tz = kx * v0[2] + ky * v1[2] + kz * v2[2]
                    if has_rot_scale:
                        euler = (
                            kx * r0[0] + ky * r1[0] + kz * r2[0],
                            kx * r0[1] + ky * r1[1] + kz * r2[1],
                            kx * r0[2] + ky * r1[2] + kz * r2[2],
                        )
                        q = (
                            quaternion_from_euler_xyz_deg(euler)
                            if any(abs(c) > 1e-15 for c in euler)
                            else identity_q
                        )
                        sc = (
                            (s0[0] ** kx) * (s1[0] ** ky) * (s2[0] ** kz),
                            (s0[1] ** kx) * (s1[1] ** ky) * (s2[1] ** kz),
                            (s0[2] ** kx) * (s1[2] ** ky) * (s2[2] ** kz),
                        )
                    else:
                        q = identity_q
                        sc = identity_s
                    result.append(((tx, ty, tz), q, sc))
        return result

    @property
    def geometry_name(self) -> str:
        if self.name is not None:
            return self.name
        return _derived_array3d_name(
            self.child.geometry_name,
            self.axes,
            self.merge_overlapping,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.geometry_name,
            "kind": "array_3d",
            "child": self.child.to_ir(),
            "axes": [ax.to_ir() for ax in self.axes],
            "merge_overlapping": self.merge_overlapping,
        }


# ---------------------------------------------------------------------------
# Type alias
# ---------------------------------------------------------------------------
Geometry: TypeAlias = (
    ImportedGeometry
    | Box
    | Cylinder
    | SinWaveguide
    | ArchWaveguide
    | Ellipsoid
    | Ellipse
    | Cone
    | Torus
    | PolygonPrism
    | Difference
    | Union
    | Intersection
    | Xor
    | Translate
    | Transform
    | SlicePlane
    | Array3D
    | MicrostripAntennaLayout
    | CPWAntennaLayout
    | MeanderAntennaLayout
    | InductiveLoopLayout
    | PiecewisePath3DLayout
)


# ---------------------------------------------------------------------------
# Selection geometry predicates
# ---------------------------------------------------------------------------
def _selection_real(value: object, field: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        qualifier = "positive " if positive else ""
        raise TypeError(f"{field} must be a {qualifier}finite real number")
    normalized = float(value)
    if not math.isfinite(normalized):
        qualifier = " and positive" if positive else ""
        raise ValueError(f"{field} must be finite{qualifier}")
    if positive and normalized <= 0.0:
        raise ValueError(f"{field} must be positive")
    return normalized


def _selection_vector(
    value: object,
    length: int,
    field: str,
) -> tuple[float, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise TypeError(f"{field} must be a sequence of {length} finite real numbers")
    if len(value) != length:
        raise ValueError(f"{field} must contain exactly {length} values")
    return tuple(
        _selection_real(component, f"{field}[{index}]")
        for index, component in enumerate(value)
    )


def _normalize_finite_vector(value: object, length: int, field: str) -> tuple[float, ...]:
    normalized = _selection_vector(value, length, field)
    largest = max(abs(component) for component in normalized)
    if largest == 0.0:
        raise ValueError(f"{field} must be a non-zero finite vector")
    scaled_norm = math.sqrt(sum((component / largest) ** 2 for component in normalized))
    return tuple(component / largest / scaled_norm for component in normalized)


def _selection_vector3(
    value: object,
    field: str,
) -> tuple[float, float, float]:
    vector = _selection_vector(value, 3, field)
    return (vector[0], vector[1], vector[2])


def _selection_vector4(
    value: object,
    field: str,
) -> tuple[float, float, float, float]:
    normalized = _normalize_finite_vector(value, 4, field)
    return (normalized[0], normalized[1], normalized[2], normalized[3])


def _selection_object_id(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("object_id must be a non-empty string")
    return require_non_empty(value, "object_id")


class AuthoredSelectionGeometry:
    """Closed authored selection-geometry AST before canonical lowering."""

    __slots__ = ()

    @classmethod
    def from_authored_ir(cls, value: object) -> "AuthoredSelectionGeometry":
        return _selection_geometry_from_authored_ir(value)


class SelectionGeometry(AuthoredSelectionGeometry):
    """Closed canonical ``geometry_predicate.v1`` AST."""

    __slots__ = ()

    @classmethod
    def from_ir(cls, value: object) -> "SelectionGeometry":
        return _selection_geometry_from_ir(value)

    def to_ir(self) -> dict[str, object]:
        raise NotImplementedError

    def to_authored_ir(self) -> dict[str, object]:
        return self.to_ir()


@dataclass(frozen=True, slots=True)
class ThroughObjectExtrusion:
    """Unresolved finite extrusion through an explicitly identified object."""

    object_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "object_id", _selection_object_id(self.object_id))

    def to_authored_ir(self) -> dict[str, str]:
        return {"kind": "through_object", "object_id": self.object_id}


@dataclass(frozen=True, slots=True)
class SelectionCylinder(SelectionGeometry):
    """Canonical finite cylinder selection predicate."""

    radius_m: float
    center_m: tuple[float, float, float]
    axis: tuple[float, float, float]
    height_m: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "radius_m", _selection_real(self.radius_m, "radius", positive=True))
        object.__setattr__(self, "center_m", _selection_vector3(self.center_m, "center"))
        normalized_axis = _normalize_finite_vector(self.axis, 3, "normal")
        object.__setattr__(self, "axis", normalized_axis)
        object.__setattr__(self, "height_m", _selection_real(self.height_m, "thickness", positive=True))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "cylinder",
            "center_m": list(self.center_m),
            "axis": list(self.axis),
            "radius_m": self.radius_m,
            "height_m": self.height_m,
        }


@dataclass(frozen=True, slots=True)
class SelectionThroughObjectDisk(AuthoredSelectionGeometry):
    """Authored disk whose finite object-bounded lowering is still unresolved."""

    radius_m: float
    center_m: tuple[float, float, float]
    normal: tuple[float, float, float]
    extrusion: ThroughObjectExtrusion

    def __post_init__(self) -> None:
        object.__setattr__(self, "radius_m", _selection_real(self.radius_m, "radius", positive=True))
        object.__setattr__(self, "center_m", _selection_vector3(self.center_m, "center"))
        normalized_normal = _normalize_finite_vector(self.normal, 3, "normal")
        object.__setattr__(self, "normal", normalized_normal)
        if type(self.extrusion) is not ThroughObjectExtrusion:
            raise TypeError("extrusion must be a ThroughObjectExtrusion node")

    def to_authored_ir(self) -> dict[str, object]:
        return {
            "kind": "disk",
            "center_m": list(self.center_m),
            "normal": list(self.normal),
            "radius_m": self.radius_m,
            "extrusion": self.extrusion.to_authored_ir(),
        }


def _require_canonical_geometry(value: object) -> SelectionGeometry:
    if type(value) not in (SelectionCylinder, SelectionAffine):
        raise TypeError("geometry must be an exact canonical SelectionGeometry node")
    return value


def _require_authored_geometry(value: object) -> AuthoredSelectionGeometry:
    if type(value) not in (
        SelectionCylinder,
        SelectionAffine,
        SelectionThroughObjectDisk,
        AuthoredSelectionAffine,
    ):
        raise TypeError("geometry must be an exact AuthoredSelectionGeometry node")
    return value


@dataclass(frozen=True, slots=True)
class SelectionAffine(SelectionGeometry):
    """Serializable affine transform for a selection-geometry predicate."""

    geometry: SelectionGeometry
    translation_m: tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation_xyzw: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    pivot_m: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def __post_init__(self) -> None:
        object.__setattr__(self, "geometry", _require_canonical_geometry(self.geometry))
        object.__setattr__(self, "translation_m", _selection_vector3(self.translation_m, "translation"))
        object.__setattr__(self, "rotation_xyzw", _selection_vector4(self.rotation_xyzw, "quaternion"))
        normalized_scale = _selection_vector3(self.scale, "scale")
        if any(component == 0.0 for component in normalized_scale):
            raise ValueError("scale must be invertible")
        object.__setattr__(self, "scale", normalized_scale)
        object.__setattr__(self, "pivot_m", _selection_vector3(self.pivot_m, "pivot"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "affine",
            "geometry": self.geometry.to_ir(),
            "translation_m": list(self.translation_m),
            "rotation_xyzw": list(self.rotation_xyzw),
            "scale": list(self.scale),
            "pivot_m": list(self.pivot_m),
        }


@dataclass(frozen=True, slots=True)
class AuthoredSelectionAffine(AuthoredSelectionGeometry):
    """Affine authored AST containing at least one unresolved authored node."""

    geometry: AuthoredSelectionGeometry
    translation_m: tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation_xyzw: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 1.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    pivot_m: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def __post_init__(self) -> None:
        geometry = _require_authored_geometry(self.geometry)
        if type(geometry) in (SelectionCylinder, SelectionAffine):
            raise TypeError("authored affine geometry must contain an unresolved authored node")
        object.__setattr__(self, "geometry", geometry)
        object.__setattr__(self, "translation_m", _selection_vector3(self.translation_m, "translation"))
        object.__setattr__(self, "rotation_xyzw", _selection_vector4(self.rotation_xyzw, "quaternion"))
        normalized_scale = _selection_vector3(self.scale, "scale")
        if any(component == 0.0 for component in normalized_scale):
            raise ValueError("scale must be invertible")
        object.__setattr__(self, "scale", normalized_scale)
        object.__setattr__(self, "pivot_m", _selection_vector3(self.pivot_m, "pivot"))

    def to_authored_ir(self) -> dict[str, object]:
        return {
            "kind": "affine",
            "geometry": self.geometry.to_authored_ir(),
            "translation_m": list(self.translation_m),
            "rotation_xyzw": list(self.rotation_xyzw),
            "scale": list(self.scale),
            "pivot_m": list(self.pivot_m),
        }


def _selection_ir_mapping(value: object, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field} must be a mapping")
    if any(not isinstance(key, str) for key in value):
        raise ValueError(f"{field} keys must be strings")
    return value


def _selection_ir_fields(
    value: Mapping[str, object],
    expected: set[str],
    field: str,
) -> None:
    actual = set(value)
    unknown = actual - expected
    missing = expected - actual
    if unknown:
        raise ValueError(f"{field} has unknown fields: {', '.join(sorted(unknown))}")
    if missing:
        raise ValueError(f"{field} is missing fields: {', '.join(sorted(missing))}")


def _selection_geometry_from_ir(value: object) -> SelectionGeometry:
    node = _selection_ir_mapping(value, "canonical geometry predicate")
    kind = node.get("kind")
    if kind == "cylinder":
        _selection_ir_fields(
            node,
            {"kind", "center_m", "axis", "radius_m", "height_m"},
            "canonical cylinder",
        )
        return SelectionCylinder(
            radius_m=node["radius_m"],
            center_m=node["center_m"],
            axis=node["axis"],
            height_m=node["height_m"],
        )
    if kind == "affine":
        _selection_ir_fields(
            node,
            {"kind", "geometry", "translation_m", "rotation_xyzw", "scale", "pivot_m"},
            "canonical affine",
        )
        return SelectionAffine(
            geometry=_selection_geometry_from_ir(node["geometry"]),
            translation_m=node["translation_m"],
            rotation_xyzw=node["rotation_xyzw"],
            scale=node["scale"],
            pivot_m=node["pivot_m"],
        )
    raise ValueError(f"canonical geometry predicate has unsupported kind {kind!r}")


def _selection_geometry_from_authored_ir(value: object) -> AuthoredSelectionGeometry:
    node = _selection_ir_mapping(value, "authored selection geometry")
    kind = node.get("kind")
    if kind == "cylinder":
        return _selection_geometry_from_ir(node)
    if kind == "disk":
        _selection_ir_fields(
            node,
            {"kind", "center_m", "normal", "radius_m", "extrusion"},
            "authored through-object disk",
        )
        extrusion = _selection_ir_mapping(node["extrusion"], "extrusion")
        _selection_ir_fields(extrusion, {"kind", "object_id"}, "extrusion")
        if extrusion["kind"] != "through_object":
            raise ValueError("extrusion kind must be 'through_object'")
        return SelectionThroughObjectDisk(
            radius_m=node["radius_m"],
            center_m=node["center_m"],
            normal=node["normal"],
            extrusion=ThroughObjectExtrusion(object_id=extrusion["object_id"]),
        )
    if kind == "affine":
        _selection_ir_fields(
            node,
            {"kind", "geometry", "translation_m", "rotation_xyzw", "scale", "pivot_m"},
            "authored affine",
        )
        geometry = _selection_geometry_from_authored_ir(node["geometry"])
        affine_fields = {
            "geometry": geometry,
            "translation_m": node["translation_m"],
            "rotation_xyzw": node["rotation_xyzw"],
            "scale": node["scale"],
            "pivot_m": node["pivot_m"],
        }
        if type(geometry) in (SelectionCylinder, SelectionAffine):
            return SelectionAffine(**affine_fields)
        return AuthoredSelectionAffine(**affine_fields)
    raise ValueError(f"authored selection geometry has unsupported kind {kind!r}")
