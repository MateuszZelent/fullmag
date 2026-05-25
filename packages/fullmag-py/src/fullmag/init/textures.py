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
    params: Mapping[str, object] = field(default_factory=dict)
    mapping: TextureMapping = field(default_factory=TextureMapping)
    transform: TextureTransform3D = field(default_factory=TextureTransform3D)
    ui_label: str | None = None
    preview_proxy: str | None = None

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
        return PresetTexture(
            preset_kind="uniform",
            params={"direction": direction},
            preview_proxy="none",
        )

    @staticmethod
    def random(seed: int) -> PresetTexture:
        return PresetTexture(
            preset_kind="random",
            params={"seed": int(seed)},
            preview_proxy="none",
        )

    @staticmethod
    def random_seeded(seed: int) -> PresetTexture:
        return texture.random(seed)

    @staticmethod
    def vortex(
        circulation: int = 1,
        core_polarity: int = 1,
        core_radius: float | None = None,
        plane: str = "xy",
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
        return PresetTexture(
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
        return PresetTexture(
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
    ) -> PresetTexture:
        if isinstance(core_polarity, str):
            plane = core_polarity
            core_polarity = -1
        if isinstance(chirality, str):
            plane = chirality
            chirality = 1
        return PresetTexture(
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
    ) -> PresetTexture:
        if isinstance(core_polarity, str):
            plane = core_polarity
            core_polarity = -1
        if isinstance(chirality, str):
            plane = chirality
            chirality = 1
        return PresetTexture(
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
    def domain_wall(
        width: float,
        kind: Literal["bloch", "neel"] = "neel",
        center_offset: float = 0.0,
        normal_axis: Literal["x", "y", "z"] = "x",
        left: Sequence[float] = (1.0, 0.0, 0.0),
        right: Sequence[float] = (-1.0, 0.0, 0.0),
    ) -> PresetTexture:
        return PresetTexture(
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

    @staticmethod
    def two_domain(
        left: Sequence[float],
        right: Sequence[float],
        wall: Sequence[float],
        normal_axis: Literal["x", "y", "z"] = "x",
    ) -> PresetTexture:
        return PresetTexture(
            preset_kind="two_domain",
            params={
                "left": list(_vec3(left, "left")),
                "right": list(_vec3(right, "right")),
                "wall": list(_vec3(wall, "wall")),
                "normal_axis": normal_axis,
            },
            preview_proxy="box",
        )

    @staticmethod
    def helical(
        wavevector: Sequence[float],
        e1: Sequence[float] = (1.0, 0.0, 0.0),
        e2: Sequence[float] = (0.0, 1.0, 0.0),
        phase_rad: float = 0.0,
    ) -> PresetTexture:
        return PresetTexture(
            preset_kind="helical",
            params={
                "wavevector": list(_vec3(wavevector, "wavevector")),
                "e1": list(_vec3(e1, "e1")),
                "e2": list(_vec3(e2, "e2")),
                "phase_rad": float(phase_rad),
            },
            preview_proxy="box",
        )

    @staticmethod
    def conical(
        wavevector: Sequence[float],
        cone_axis: Sequence[float] = (0.0, 0.0, 1.0),
        cone_angle_rad: float = math.pi / 4.0,
        phase_rad: float = 0.0,
    ) -> PresetTexture:
        return PresetTexture(
            preset_kind="conical",
            params={
                "wavevector": list(_vec3(wavevector, "wavevector")),
                "cone_axis": list(_vec3(cone_axis, "cone_axis")),
                "cone_angle_rad": float(cone_angle_rad),
                "phase_rad": float(phase_rad),
            },
            preview_proxy="box",
        )
