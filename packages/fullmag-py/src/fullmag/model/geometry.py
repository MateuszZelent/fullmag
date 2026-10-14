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
# Mixin for CSG operator overloads
# ---------------------------------------------------------------------------
class _GeometryOps:
    """Mixin providing ``-``, ``+``, ``&`` operators for CSG boolean ops."""

    def __sub__(self, other: "Geometry") -> "Difference":
        return Difference(base=self, tool=other)  # type: ignore[arg-type]

    def __add__(self, other: "Geometry") -> "Union":
        return Union(a=self, b=other)  # type: ignore[arg-type]

    def __and__(self, other: "Geometry") -> "Intersection":
        return Intersection(a=self, b=other)  # type: ignore[arg-type]

    def translate(self, offset: tuple[float, float, float]) -> "Translate":
        return Translate(geometry=self, offset=offset)  # type: ignore[arg-type]


def _normalize_unit_vector3(value: tuple[float, float, float], field: str) -> tuple[float, float, float]:
    vector = as_vector3(value, field)
    norm = math.sqrt(sum(component * component for component in vector))
    if not math.isfinite(norm) or norm <= 0.0:
        raise ValueError(f"{field} must be a non-zero finite vector")
    return tuple(component / norm for component in vector)


def _format_translation_component(value: float) -> str:
    return f"{value:.6g}"


def _derived_translate_name(base_name: str, offset: tuple[float, float, float]) -> str:
    components = "_".join(_format_translation_component(component) for component in offset)
    return f"{base_name}__translate_{components}"


def _require_finite(value: float, field: str) -> float:
    normalized = float(value)
    if not math.isfinite(normalized):
        raise ValueError(f"{field} must be finite")
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

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "microstrip",
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

    def to_ir(self) -> dict[str, object]:
        return {
            "name": self.name,
            "kind": "cpw",
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
        )


AntennaLayout: TypeAlias = MicrostripAntennaLayout | CPWAntennaLayout


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
            "rx": self.rx,
            "ry": self.ry,
            "height": self.height,
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
    | Difference
    | Union
    | Intersection
    | Translate
    | MicrostripAntennaLayout
    | CPWAntennaLayout
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
