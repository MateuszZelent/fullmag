from __future__ import annotations

"""Starter implementation for analytic magnetic texture presets.

This file is intentionally standalone and conservative:
- keeps preset definitions analytic
- keeps texture transform separate from geometry transform
- serializes to a backend-friendly IR payload
"""

from dataclasses import dataclass, field, replace
import math
from typing import Any, Literal, Mapping, Sequence


Vec3 = tuple[float, float, float]
Quat = tuple[float, float, float, float]


def _drop_none_params(params: Mapping[str, object | None]) -> dict[str, object]:
    return {key: value for key, value in params.items() if value is not None}


def _vec3(value: Sequence[float], name: str) -> Vec3:
    if len(value) != 3:
        raise ValueError(f"{name} must have 3 components")
    return (float(value[0]), float(value[1]), float(value[2]))

def _require_finite_positive(value: object, name: str) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be finite and positive") from exc
    if not math.isfinite(value) or value <= 0.0:
        raise ValueError(f"{name} must be finite and positive")
    return value


def _require_sign(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value not in (-1, 1):
        raise ValueError(f"{name} must be -1 or 1")
    return value


def _require_v2_preset(preset_version: int, name: str) -> None:
    if preset_version != 2:
        raise ValueError(f"{name} requires preset_version=2")


def _require_plane(value: str) -> str:
    if value not in ("xy", "xz", "yz"):
        raise ValueError("plane must be one of 'xy', 'xz', or 'yz'")
    return value


def _require_nonzero_vector(value: Vec3, name: str) -> Vec3:
    if not all(math.isfinite(component) for component in value):
        raise ValueError(f"{name} must have finite components")
    if math.sqrt(sum(component * component for component in value)) <= 1e-30:
        raise ValueError(f"{name} must be nonzero")

    return value

def _normalized_vec3(value: Vec3, name: str) -> Vec3:
    value = _require_nonzero_vector(value, name)
    norm = math.sqrt(sum(component * component for component in value))
    return tuple(component / norm for component in value)  # type: ignore[return-value]

def _dot_vec3(lhs: Vec3, rhs: Vec3) -> float:
    return sum(left * right for left, right in zip(lhs, rhs))

def _cross_vec3(lhs: Vec3, rhs: Vec3) -> Vec3:
    return (lhs[1] * rhs[2] - lhs[2] * rhs[1], lhs[2] * rhs[0] - lhs[0] * rhs[2], lhs[0] * rhs[1] - lhs[1] * rhs[0])
def _validate_vortex_arguments(
    circulation: int,
    core_polarity: int,
    core_radius: float | None,
    plane: str,
) -> None:
    _require_sign(circulation, "circulation")
    _require_sign(core_polarity, "core_polarity")
    if core_radius is not None:
        _require_finite_positive(core_radius, "core_radius")
    _require_plane(plane)

def _quat(value: Sequence[float], name: str) -> Quat:
    if len(value) != 4:
        raise ValueError(f"{name} must have 4 components")
    return (float(value[0]), float(value[1]), float(value[2]), float(value[3]))


def _normalize_quat(q: Quat) -> Quat:
    norm = math.sqrt(sum(component * component for component in q))
    if norm <= 1e-30:
        return (0.0, 0.0, 0.0, 1.0)
    return tuple(component / norm for component in q)  # type: ignore[return-value]


def _quat_mul(lhs: Quat, rhs: Quat) -> Quat:
    lx, ly, lz, lw = lhs
    rx, ry, rz, rw = rhs
    return _normalize_quat(
        (
            lw * rx + lx * rw + ly * rz - lz * ry,
            lw * ry - lx * rz + ly * rw + lz * rx,
            lw * rz + lx * ry - ly * rx + lz * rw,
            lw * rw - lx * rx - ly * ry - lz * rz,
        )
    )


def _quat_from_axis_angle(axis: Vec3, angle_rad: float) -> Quat:
    ax, ay, az = axis
    norm = math.sqrt(ax * ax + ay * ay + az * az)
    if norm <= 1e-30:
        return (0.0, 0.0, 0.0, 1.0)
    ax /= norm
    ay /= norm
    az /= norm
    half = 0.5 * angle_rad
    s = math.sin(half)
    return _normalize_quat((ax * s, ay * s, az * s, math.cos(half)))


@dataclass(frozen=True, slots=True)
class TextureTransform3D:
    translation: Vec3 = (0.0, 0.0, 0.0)
    rotation_quat: Quat = (0.0, 0.0, 0.0, 1.0)
    scale: Vec3 = (1.0, 1.0, 1.0)
    pivot: Vec3 = (0.0, 0.0, 0.0)

    def translate(self, dx: float, dy: float, dz: float) -> "TextureTransform3D":
        tx, ty, tz = self.translation
        return replace(self, translation=(tx + dx, ty + dy, tz + dz))

    def rotate_axis(self, axis: Vec3, angle_rad: float) -> "TextureTransform3D":
        delta = _quat_from_axis_angle(axis, angle_rad)
        return replace(self, rotation_quat=_quat_mul(delta, self.rotation_quat))

    def rotate_x(self, angle_rad: float) -> "TextureTransform3D":
        return self.rotate_axis((1.0, 0.0, 0.0), angle_rad)

    def rotate_y(self, angle_rad: float) -> "TextureTransform3D":
        return self.rotate_axis((0.0, 1.0, 0.0), angle_rad)

    def rotate_z(self, angle_rad: float) -> "TextureTransform3D":
        return self.rotate_axis((0.0, 0.0, 1.0), angle_rad)

    def rotate_x_deg(self, angle_deg: float) -> "TextureTransform3D":
        return self.rotate_x(math.radians(angle_deg))

    def rotate_y_deg(self, angle_deg: float) -> "TextureTransform3D":
        return self.rotate_y(math.radians(angle_deg))

    def rotate_z_deg(self, angle_deg: float) -> "TextureTransform3D":
        return self.rotate_z(math.radians(angle_deg))

    def scale_by(self, sx: float, sy: float, sz: float) -> "TextureTransform3D":
        cx, cy, cz = self.scale
        return replace(self, scale=(cx * sx, cy * sy, cz * sz))

    def set_pivot(self, pivot: Sequence[float]) -> "TextureTransform3D":
        return replace(self, pivot=_vec3(pivot, "pivot"))

    def to_ir(self) -> dict[str, object]:
        return {
            "translation": list(self.translation),
            "rotation_quat": list(self.rotation_quat),
            "scale": list(self.scale),
            "pivot": list(self.pivot),
        }


@dataclass(frozen=True, slots=True)
class TextureMapping:
    space: Literal["object", "world"] = "object"
    projection: str = "object_local"
    clamp_mode: Literal["clamp", "repeat", "mirror", "none"] = "none"

    def to_ir(self) -> dict[str, object]:
        return {
            "space": self.space,
            "projection": self.projection,
            "clamp_mode": self.clamp_mode,
        }


@dataclass(frozen=True, slots=True)
class PresetTexture:
    preset_kind: str
    preset_version: int = 2
    params: Mapping[str, object] = field(default_factory=dict)
    mapping: TextureMapping = field(default_factory=TextureMapping)
    transform: TextureTransform3D = field(default_factory=TextureTransform3D)
    ui_label: str | None = None
    preview_proxy: str | None = None

    def __post_init__(self) -> None:
        if isinstance(self.preset_version, bool) or not isinstance(self.preset_version, int) or self.preset_version not in (1, 2):
            raise ValueError("preset_version must be 1 or 2")


    def copy(self) -> "PresetTexture":
        return replace(self)

    def translate(self, dx: float, dy: float, dz: float) -> "PresetTexture":
        return replace(self, transform=self.transform.translate(dx, dy, dz))

    def rotate_x(self, angle_rad: float) -> "PresetTexture":
        return replace(self, transform=self.transform.rotate_x(angle_rad))

    def rotate_y(self, angle_rad: float) -> "PresetTexture":
        return replace(self, transform=self.transform.rotate_y(angle_rad))

    def rotate_z(self, angle_rad: float) -> "PresetTexture":
        return replace(self, transform=self.transform.rotate_z(angle_rad))

    def rotate_x_deg(self, angle_deg: float) -> "PresetTexture":
        return replace(self, transform=self.transform.rotate_x_deg(angle_deg))

    def rotate_y_deg(self, angle_deg: float) -> "PresetTexture":
        return replace(self, transform=self.transform.rotate_y_deg(angle_deg))

    def rotate_z_deg(self, angle_deg: float) -> "PresetTexture":
        return replace(self, transform=self.transform.rotate_z_deg(angle_deg))

    def scale(self, sx: float, sy: float, sz: float) -> "PresetTexture":
        return replace(self, transform=self.transform.scale_by(sx, sy, sz))

    def with_mapping(
        self,
        *,
        space: Literal["object", "world"] | None = None,
        projection: str | None = None,
        clamp_mode: Literal["clamp", "repeat", "mirror"] | None = None,
    ) -> "PresetTexture":
        return replace(
            self,
            mapping=TextureMapping(
                space=space if space is not None else self.mapping.space,
                projection=projection if projection is not None else self.mapping.projection,
                clamp_mode=clamp_mode if clamp_mode is not None else self.mapping.clamp_mode,
            ),
        )

    def with_pivot(self, pivot: Sequence[float]) -> "PresetTexture":
        return replace(self, transform=self.transform.set_pivot(pivot))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "preset_texture",
            "preset_kind": self.preset_kind,
            "preset_version": self.preset_version,
            "preset_params": dict(self.params),
            "mapping": self.mapping.to_ir(),
            "texture_transform": self.transform.to_ir(),
            "ui_label": self.ui_label,
            "preview_proxy": self.preview_proxy,
        }


class texture:
    """Factory namespace for analytic magnetic texture presets."""

    @staticmethod
    def uniform(
        direction_or_x: Sequence[float] | float = (1.0, 0.0, 0.0),
        y: float | None = None,
        z: float | None = None,
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if isinstance(direction_or_x, (list, tuple)):
            direction = list(_vec3(direction_or_x, "direction"))
        elif y is not None and z is not None:
            direction = [float(direction_or_x), float(y), float(z)]
        else:
            raise TypeError(
                "texture.uniform() requires 3 components: "
                "texture.uniform(x, y, z) or texture.uniform((x, y, z))"
            )
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="uniform",
                params={"direction": direction},
                preview_proxy="none",
            )
        direction = list(_require_nonzero_vector(tuple(direction), "direction"))
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="uniform",
            params={"direction": direction},
            preview_proxy="none",
        )

    @staticmethod
    def random(seed: int, *, preset_version: int = 2) -> PresetTexture:
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="random",
                params={"seed": int(seed)},
                preview_proxy="none",
            )
        if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
            raise ValueError("seed must be a non-negative integer")
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="random",
            params={"seed": seed},
            preview_proxy="none",
        )

    @staticmethod
    def random_seeded(seed: int, *, preset_version: int = 2) -> PresetTexture:
        return texture.random(seed, preset_version=preset_version)

    @staticmethod
    def vortex(
        circulation: int = 1,
        core_polarity: int = 1,
        core_radius: float | None = None,
        plane: str = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if isinstance(core_radius, str):
            plane = core_radius
            core_radius = None
        if isinstance(core_polarity, str):
            plane = core_polarity
            core_polarity = 1
        if isinstance(circulation, str):
            plane = circulation
            circulation = 1
        if preset_version == 2:
            _validate_vortex_arguments(circulation, core_polarity, core_radius, plane)
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="vortex",
            params=_drop_none_params(
                {
                    "circulation": int(circulation),
                    "core_polarity": int(core_polarity),
                    "core_radius": core_radius,
                    "plane": plane,
                }
            ),
            preview_proxy="disc",
        )

    @staticmethod
    def antivortex(
        circulation: int = 1,
        core_polarity: int = 1,
        core_radius: float | None = None,
        plane: str = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if isinstance(core_radius, str):
            plane = core_radius
            core_radius = None
        if isinstance(core_polarity, str):
            plane = core_polarity
            core_polarity = 1
        if isinstance(circulation, str):
            plane = circulation
            circulation = 1
        if preset_version == 2:
            _validate_vortex_arguments(circulation, core_polarity, core_radius, plane)
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="antivortex",
            params=_drop_none_params(
                {
                    "circulation": int(circulation),
                    "core_polarity": int(core_polarity),
                    "core_radius": core_radius,
                    "plane": plane,
                }
            ),
            preview_proxy="disc",
        )

    @staticmethod
    def bloch_skyrmion(
        radius: float,
        wall_width: float,
        chirality: int = 1,
        core_polarity: int = -1,
        plane: str = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if isinstance(core_polarity, str):
            plane = core_polarity
            core_polarity = -1
        if isinstance(chirality, str):
            plane = chirality
            chirality = 1
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="bloch_skyrmion",
                params={
                    "radius": float(radius),
                    "wall_width": float(wall_width),
                    "chirality": int(chirality),
                    "core_polarity": int(core_polarity),
                    "plane": plane,
                },
                preview_proxy="disc",
            )
        radius = _require_finite_positive(radius, "radius")
        wall_width = _require_finite_positive(wall_width, "wall_width")
        chirality = _require_sign(chirality, "chirality")
        core_polarity = _require_sign(core_polarity, "core_polarity")
        plane = _require_plane(plane)
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="bloch_skyrmion",
            params={
                "radius": float(radius),
                "wall_width": float(wall_width),
                "chirality": int(chirality),
                "core_polarity": int(core_polarity),
                "plane": plane,
            },
            preview_proxy="disc",
        )

    @staticmethod
    def neel_skyrmion(
        radius: float,
        wall_width: float,
        chirality: int = 1,
        core_polarity: int = -1,
        plane: str = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if isinstance(core_polarity, str):
            plane = core_polarity
            core_polarity = -1
        if isinstance(chirality, str):
            plane = chirality
            chirality = 1
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="neel_skyrmion",
                params={
                    "radius": float(radius),
                    "wall_width": float(wall_width),
                    "chirality": int(chirality),
                    "core_polarity": int(core_polarity),
                    "plane": plane,
                },
                preview_proxy="disc",
            )
        radius = _require_finite_positive(radius, "radius")
        wall_width = _require_finite_positive(wall_width, "wall_width")
        chirality = _require_sign(chirality, "chirality")
        core_polarity = _require_sign(core_polarity, "core_polarity")
        plane = _require_plane(plane)
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="neel_skyrmion",
            params={
                "radius": float(radius),
                "wall_width": float(wall_width),
                "chirality": int(chirality),
                "core_polarity": int(core_polarity),
                "plane": plane,
            },
            preview_proxy="disc",
        )

    @staticmethod
    def antiskyrmion(
        radius: float,
        wall_width: float,
        chirality: int = 1,
        core_polarity: int = -1,
        plane: Literal["xy", "xz", "yz"] = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        _require_v2_preset(preset_version, "antiskyrmion")
        radius = _require_finite_positive(radius, "radius")
        wall_width = _require_finite_positive(wall_width, "wall_width")
        chirality = _require_sign(chirality, "chirality")
        core_polarity = _require_sign(core_polarity, "core_polarity")
        plane = _require_plane(plane)
        return PresetTexture(
            preset_version=2,
            preset_kind="antiskyrmion",
            params={
                "radius": radius,
                "wall_width": wall_width,
                "chirality": chirality,
                "core_polarity": core_polarity,
                "plane": plane,
            },
            preview_proxy="disc",
        )

    @staticmethod
    def skyrmionium(
        inner_radius: float,
        outer_radius: float,
        wall_width: float,
        kind: Literal["bloch", "neel"] = "neel",
        chirality: int = 1,
        background_sign: int = 1,
        plane: Literal["xy", "xz", "yz"] = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        _require_v2_preset(preset_version, "skyrmionium")
        inner_radius = _require_finite_positive(inner_radius, "inner_radius")
        outer_radius = _require_finite_positive(outer_radius, "outer_radius")
        if outer_radius <= inner_radius:
            raise ValueError("outer_radius must be greater than inner_radius")
        wall_width = _require_finite_positive(wall_width, "wall_width")
        if kind not in ("bloch", "neel"):
            raise ValueError("kind must be 'bloch' or 'neel'")
        chirality = _require_sign(chirality, "chirality")
        background_sign = _require_sign(background_sign, "background_sign")
        plane = _require_plane(plane)
        return PresetTexture(
            preset_version=2,
            preset_kind="skyrmionium",
            params={
                "inner_radius": inner_radius,
                "outer_radius": outer_radius,
                "wall_width": wall_width,
                "kind": kind,
                "chirality": chirality,
                "background_sign": background_sign,
                "plane": plane,
            },
            preview_proxy="disc",
        )

    @staticmethod
    def hopfion(
        radius: float,
        hopf_charge: int = 1,
        background_sign: int = 1,
        axial_scale: float = 1.0,
        phase_rad: float = 0.0,
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        _require_v2_preset(preset_version, "hopfion")
        radius = _require_finite_positive(radius, "radius")
        hopf_charge = _require_sign(hopf_charge, "hopf_charge")
        background_sign = _require_sign(background_sign, "background_sign")
        axial_scale = _require_finite_positive(axial_scale, "axial_scale")
        phase_rad = float(phase_rad)
        if not math.isfinite(phase_rad):
            raise ValueError("phase_rad must be finite")
        return PresetTexture(
            preset_version=2,
            preset_kind="hopfion",
            params={
                "radius": radius,
                "hopf_charge": hopf_charge,
                "background_sign": background_sign,
                "axial_scale": axial_scale,
                "phase_rad": phase_rad,
            },
            preview_proxy="sphere",
        )


    @staticmethod
    def vortex_wall(
        wall_half_width: float,
        left_mx: float = 1.0,
        right_mx: float = -1.0,
        circulation: int = 1,
        core_polarity: int = 1,
        core_radius: float = 1.0e-9,
        plane: Literal["xy", "xz", "yz"] = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        # Mumax3-compatible vortex wall with explicit physical core and wall scales.

        _require_v2_preset(preset_version, "vortex_wall")
        wall_half_width = _require_finite_positive(wall_half_width, "wall_half_width")
        left_mx = float(left_mx)
        right_mx = float(right_mx)
        if not math.isfinite(left_mx) or left_mx == 0.0:
            raise ValueError("left_mx must be finite and nonzero")
        if not math.isfinite(right_mx) or right_mx == 0.0:
            raise ValueError("right_mx must be finite and nonzero")
        circulation = _require_sign(circulation, "circulation")
        core_polarity = _require_sign(core_polarity, "core_polarity")
        core_radius = _require_finite_positive(core_radius, "core_radius")
        plane = _require_plane(plane)
        return PresetTexture(
            preset_version=2,
            preset_kind="vortex_wall",
            params={
                "wall_half_width": wall_half_width,
                "left_mx": left_mx,
                "right_mx": right_mx,
                "circulation": circulation,
                "core_polarity": core_polarity,
                "core_radius": core_radius,
                "plane": plane,
            },
            preview_proxy="box",
        )

    @staticmethod
    def hopfion_compact_support(
        major_radius: float,
        minor_radius: float,
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        # Mumax3 HopfionCompactSupport profile with exact uniform exterior.

        _require_v2_preset(preset_version, "hopfion_compact_support")
        major_radius = _require_finite_positive(major_radius, "major_radius")
        minor_radius = _require_finite_positive(minor_radius, "minor_radius")
        return PresetTexture(
            preset_version=2,
            preset_kind="hopfion_compact_support",
            params={
                "major_radius": major_radius,
                "minor_radius": minor_radius,
            },
            preview_proxy="torus",
        )

    @staticmethod
    def bimeron(
        radius: float,
        wall_width: float,
        vorticity: int = 1,
        helicity_rad: float = 0.0,
        background_sign: int = 1,
        plane: Literal["xy", "xz", "yz"] = "xy",
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        radius = float(radius)
        wall_width = float(wall_width)
        helicity_rad = float(helicity_rad)
        if not math.isfinite(radius) or radius <= 0.0:
            raise ValueError("radius must be finite and positive")
        if not math.isfinite(wall_width) or wall_width <= 0.0:
            raise ValueError("wall_width must be finite and positive")
        if isinstance(vorticity, bool) or not isinstance(vorticity, int) or vorticity not in (-1, 1):
            raise ValueError("vorticity must be -1 or 1")
        if not math.isfinite(helicity_rad):
            raise ValueError("helicity_rad must be finite")
        if isinstance(background_sign, bool) or not isinstance(background_sign, int) or background_sign not in (-1, 1):
            raise ValueError("background_sign must be -1 or 1")
        if plane not in ("xy", "xz", "yz"):
            raise ValueError("plane must be one of 'xy', 'xz', or 'yz'")
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="bimeron",
            params={
                "plane": plane,
                "radius": radius,
                "wall_width": wall_width,
                "vorticity": int(vorticity),
                "helicity_rad": helicity_rad,
                "background_sign": int(background_sign),
            },
            preview_proxy="disc",
        )

    @staticmethod
    def domain_wall(
        width: float,
        kind: Literal["bloch", "neel"] = "neel",
        center_offset: float = 0.0,
        normal_axis: Literal["x", "y", "z"] = "x",
        left: Sequence[float] = (1.0, 0.0, 0.0),
        right: Sequence[float] = (-1.0, 0.0, 0.0),
        wall_center_direction: Sequence[float] | None = None,
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="domain_wall",
                params={
                    "kind": kind,
                    "width": float(width),
                    "center_offset": float(center_offset),
                    "normal_axis": normal_axis,
                    "left": list(_vec3(left, "left")),
                    "right": list(_vec3(right, "right")),
                },
                preview_proxy="box",
            )
        width = _require_finite_positive(width, "width")
        center_offset = float(center_offset)
        if not math.isfinite(center_offset):
            raise ValueError("center_offset must be finite")
        if kind not in ("bloch", "neel"):
            raise ValueError("kind must be 'bloch' or 'neel'")
        if normal_axis not in ("x", "y", "z"):
            raise ValueError("normal_axis must be 'x', 'y', or 'z'")
        left_vec = _normalized_vec3(_vec3(left, "left"), "left")
        right_vec = _normalized_vec3(_vec3(right, "right"), "right")
        if _dot_vec3(left_vec, right_vec) > -1.0 + 1e-10:
            raise ValueError("right must be antiparallel to left")
        if wall_center_direction is None:
            axis_vec = {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}[normal_axis]
            projected = tuple(
                axis_vec[index] - left_vec[index] * _dot_vec3(axis_vec, left_vec)
                for index in range(3)
            )
            wall_direction = projected if kind == "neel" else _cross_vec3(axis_vec, left_vec)
            if math.sqrt(sum(component * component for component in wall_direction)) <= 1e-14:
                helper = (
                    (1.0, 0.0, 0.0)
                    if abs(axis_vec[0]) < 0.9
                    else (0.0, 1.0, 0.0)
                    if abs(axis_vec[1]) < 0.9
                    else (0.0, 0.0, 1.0)
                )
                tangent_one = _cross_vec3(axis_vec, helper)
                tangent_two = _cross_vec3(tangent_one, axis_vec)
                wall_direction = tangent_one if kind == "bloch" else tangent_two
            if math.sqrt(sum(component * component for component in wall_direction)) <= 1e-14:
                raise ValueError("wall_center_direction could not be derived")
        else:
            wall_direction = _vec3(wall_center_direction, "wall_center_direction")
        wall_direction = _normalized_vec3(wall_direction, "wall_center_direction")
        if abs(_dot_vec3(wall_direction, left_vec)) > 1e-10:
            raise ValueError("wall_center_direction must be orthogonal to left")
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="domain_wall",
            params={
                "kind": kind,
                "width": float(width),
                "center_offset": float(center_offset),
                "normal_axis": normal_axis,
                "left": list(left_vec),
                "right": list(right_vec),
                "wall_center_direction": list(wall_direction),
            },
            preview_proxy="box",
        )

    @staticmethod
    def two_domain(
        left: Sequence[float],
        right: Sequence[float],
        wall: Sequence[float],
        normal_axis: Literal["x", "y", "z"] = "x",
        wall_width: float | None = None,
        sharp: bool | None = None,
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="two_domain",
                params={
                    "left": list(_vec3(left, "left")),
                    "right": list(_vec3(right, "right")),
                    "wall": list(_vec3(wall, "wall")),
                    "normal_axis": normal_axis,
                },
                preview_proxy="box",
            )
        if normal_axis not in ("x", "y", "z"):
            raise ValueError("normal_axis must be 'x', 'y', or 'z'")
        left_vec = _normalized_vec3(_vec3(left, "left"), "left")
        right_vec = _normalized_vec3(_vec3(right, "right"), "right")
        wall_vec = _normalized_vec3(_vec3(wall, "wall"), "wall")
        if sharp is None:
            sharp = wall_width is None
        if not isinstance(sharp, bool):
            raise ValueError("sharp must be boolean")
        if sharp:
            if wall_width is not None:
                raise ValueError("wall_width is only valid for a smooth two_domain")
            wall_width_value = None
        else:
            wall_width_value = _require_finite_positive(wall_width, "wall_width")
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="two_domain",
            params=_drop_none_params(
                {
                    "left": list(left_vec),
                    "right": list(right_vec),
                    "wall": list(wall_vec),
                    "normal_axis": normal_axis,
                    "wall_width": wall_width_value,
                    "sharp": sharp,
                }
            ),
            preview_proxy="box",
        )

    @staticmethod
    def helical(
        wavevector: Sequence[float],
        e1: Sequence[float] = (1.0, 0.0, 0.0),
        e2: Sequence[float] = (0.0, 1.0, 0.0),
        phase_rad: float = 0.0,
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="helical",
                params={
                    "wavevector": list(_vec3(wavevector, "wavevector")),
                    "e1": list(_vec3(e1, "e1")),
                    "e2": list(_vec3(e2, "e2")),
                    "phase_rad": float(phase_rad),
                },
                preview_proxy="box",
            )
        wavevector_vec = _require_nonzero_vector(_vec3(wavevector, "wavevector"), "wavevector")
        e1_vec = _normalized_vec3(_vec3(e1, "e1"), "e1")
        e2_vec = _normalized_vec3(_vec3(e2, "e2"), "e2")
        if abs(_dot_vec3(e1_vec, e2_vec)) > 1e-12:
            raise ValueError("e1 and e2 must be orthogonal")
        phase_value = float(phase_rad)
        if not math.isfinite(phase_value):
            raise ValueError("phase_rad must be finite")
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="helical",
            params={
                "wavevector": list(wavevector_vec),
                "e1": list(e1_vec),
                "e2": list(e2_vec),
                "phase_rad": phase_value,
            },
            preview_proxy="box",
        )

    @staticmethod
    def conical(
        wavevector: Sequence[float],
        cone_axis: Sequence[float] = (0.0, 0.0, 1.0),
        cone_angle_rad: float = math.pi / 4.0,
        phase_rad: float = 0.0,
        *,
        preset_version: int = 2,
    ) -> PresetTexture:
        if preset_version == 1:
            return PresetTexture(
                preset_version=1,
                preset_kind="conical",
                params={
                    "wavevector": list(_vec3(wavevector, "wavevector")),
                    "cone_axis": list(_vec3(cone_axis, "cone_axis")),
                    "cone_angle_rad": float(cone_angle_rad),
                    "phase_rad": float(phase_rad),
                },
                preview_proxy="box",
            )
        wavevector_vec = _require_nonzero_vector(_vec3(wavevector, "wavevector"), "wavevector")
        axis_vec = _normalized_vec3(_vec3(cone_axis, "cone_axis"), "cone_axis")
        angle_value = float(cone_angle_rad)
        if not math.isfinite(angle_value) or not 0.0 <= angle_value <= math.pi:
            raise ValueError("cone_angle_rad must be finite and lie in [0, pi]")
        phase_value = float(phase_rad)
        if not math.isfinite(phase_value):
            raise ValueError("phase_rad must be finite")
        return PresetTexture(
            preset_version=preset_version,
            preset_kind="conical",
            params={
                "wavevector": list(wavevector_vec),
                "cone_axis": list(axis_vec),
                "cone_angle_rad": angle_value,
                "phase_rad": phase_value,
            },
            preview_proxy="box",
        )
