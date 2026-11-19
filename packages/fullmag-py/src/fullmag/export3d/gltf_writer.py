"""Pure-Python / NumPy Khronos glTF 2.0 (``.glb`` and ``.gltf``) serializer."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import re
import struct
from typing import Any, Mapping, Sequence

import numpy as np
from numpy.typing import ArrayLike, NDArray

from .colormaps import evaluate_field_colors, srgb_to_linear

GLB_MAGIC = 0x46546C67  # 'glTF' little-endian
GLB_VERSION = 2
GLB_CHUNK_JSON = 0x4E4F534A  # 'JSON'
GLB_CHUNK_BIN = 0x004E4942  # 'BIN\0'

COMPONENT_FLOAT = 5126
COMPONENT_UNSIGNED_SHORT = 5123
COMPONENT_UNSIGNED_INT = 5125

TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY_BUFFER = 34963

PRIMITIVE_LINES = 1
PRIMITIVE_TRIANGLES = 4

COORDINATE_SCALE_FACTORS: dict[str, float] = {
    "nm": 1e9,
    "um": 1e6,
    "mm": 1e3,
    "si_m": 1.0,
}

SUPPORTED_COORDINATE_SCALES = ("auto_scene", "nm", "um", "mm", "si_m")


@dataclass(slots=True)
class GltfPrimitiveSpec:
    """Single glTF primitive specification in physical meters."""

    positions_m: NDArray[np.float64]
    normals: NDArray[np.float64] | None = None
    colors_linear: NDArray[np.float64] | None = None
    indices: NDArray[np.uint32] | None = None
    mode: int = PRIMITIVE_TRIANGLES
    material_mode: str = "unlit"
    base_color_factor: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)
    double_sided: bool = True
    is_local_geometry: bool = False
    morph_deltas_m: Sequence[NDArray[np.float64]] = ()


@dataclass(slots=True)
class GltfMeshSpec:
    """glTF mesh containing one or more primitives."""

    name: str
    primitives: list[GltfPrimitiveSpec]
    weights: list[float] | None = None
    extras: dict[str, Any] | None = None


@dataclass(slots=True)
class GltfNodeSpec:
    """glTF scene node with optional mesh, TRS transform, and children."""

    name: str
    mesh_index: int | None = None
    translation_m: tuple[float, float, float] | None = None
    rotation_xyzw: tuple[float, float, float, float] | None = None
    scale: tuple[float, float, float] | None = None
    scale_in_meters: bool = False
    children: list[int] = field(default_factory=list)
    extras: dict[str, Any] | None = None


@dataclass(slots=True)
class GltfAnimationChannelSpec:
    """glTF animation channel targeting one node path."""

    node_name: str
    path: str  # 'translation' | 'rotation' | 'scale' | 'weights'
    times_s: NDArray[np.float64]
    values: NDArray[np.float64]
    interpolation: str = "LINEAR"  # 'LINEAR' | 'STEP'
    values_in_meters: bool = False


def sanitize_gltf_node_name(raw_name: str, used_names: set[str]) -> str:
    """Sanitize a node name strictly to ``[A-Za-z0-9_-]+`` and guarantee uniqueness."""
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", str(raw_name)).strip("_")
    base = cleaned if cleaned else "node"
    candidate = base
    suffix = 1
    while candidate in used_names:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used_names.add(candidate)
    return candidate


def resolve_coordinate_transform(
    world_positions_m: Sequence[ArrayLike],
    coordinate_scale: str = "auto_scene",
) -> tuple[float, tuple[float, float, float], str]:
    """Resolve ``(scale_factor, origin_offset_m, normalized_scale_name)``."""
    mode = (coordinate_scale or "auto_scene").strip().lower()
    if mode not in SUPPORTED_COORDINATE_SCALES:
        raise ValueError(
            f"unsupported coordinate_scale '{coordinate_scale}'; "
            f"expected one of {SUPPORTED_COORDINATE_SCALES}"
        )

    if mode != "auto_scene":
        return COORDINATE_SCALE_FACTORS[mode], (0.0, 0.0, 0.0), mode

    mins: list[NDArray[np.float64]] = []
    maxs: list[NDArray[np.float64]] = []
    for arr_like in world_positions_m:
        arr = np.asarray(arr_like, dtype=np.float64)
        if arr.size == 0:
            continue
        pts = arr.reshape(-1, 3)
        finite = np.all(np.isfinite(pts), axis=1)
        if np.any(finite):
            pts = pts[finite]
            mins.append(np.min(pts, axis=0))
            maxs.append(np.max(pts, axis=0))

    if not mins:
        return 1.0, (0.0, 0.0, 0.0), "auto_scene"

    bmin = np.min(np.vstack(mins), axis=0)
    bmax = np.max(np.vstack(maxs), axis=0)
    center = 0.5 * (bmin + bmax)
    extent = float(np.max(bmax - bmin))
    scale = (2.0 / extent) if extent > 1e-30 else 1.0
    return (
        float(scale),
        (float(center[0]), float(center[1]), float(center[2])),
        "auto_scene",
    )


class _BinaryBufferBuilder:
    """4-byte aligned binary buffer builder with content-based accessor deduplication."""

    def __init__(self) -> None:
        self._chunks: list[bytes] = []
        self._byte_length = 0
        self.buffer_views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []
        self._accessor_cache: dict[tuple[Any, ...], int] = {}
        self._id_cache: dict[tuple[str, int, str, tuple[int, ...]], int] = {}
        self._pinned_arrays: list[np.ndarray] = []

    @property
    def byte_length(self) -> int:
        return self._byte_length

    def to_bytes(self) -> bytes:
        return b"".join(self._chunks)

    def _append_bytes(self, raw: bytes, target: int | None) -> int:
        padding = (-self._byte_length) % 4
        if padding:
            self._chunks.append(b"\x00" * padding)
            self._byte_length += padding

        offset = self._byte_length
        self._chunks.append(raw)
        self._byte_length += len(raw)

        bv: dict[str, Any] = {
            "buffer": 0,
            "byteOffset": offset,
            "byteLength": len(raw),
        }
        if target is not None:
            bv["target"] = target
        bv_index = len(self.buffer_views)
        self.buffer_views.append(bv)
        return bv_index

    def add_accessor(
        self,
        array: np.ndarray,
        *,
        role: str,
        gltf_type: str,
        component_type: int,
        target: int | None,
        include_minmax: bool = False,
        dedup_source: object | None = None,
    ) -> int:
        arr = np.ascontiguousarray(array)
        if arr.dtype == np.float64:
            raise AssertionError("glTF buffer accessors must be converted to float32 or int before upload")

        if dedup_source is not None and isinstance(dedup_source, np.ndarray):
            id_key = (role, id(dedup_source), gltf_type, arr.shape)
            cached = self._id_cache.get(id_key)
            if cached is not None:
                return cached
            self._pinned_arrays.append(dedup_source)

        raw = arr.tobytes(order="C")
        digest = hashlib.blake2b(raw, digest_size=16).digest()
        cache_key = (role, gltf_type, component_type, arr.shape[0], target, include_minmax, digest)
        cached = self._accessor_cache.get(cache_key)
        if cached is not None:
            if dedup_source is not None and isinstance(dedup_source, np.ndarray):
                self._id_cache[(role, id(dedup_source), gltf_type, arr.shape)] = cached
            return cached

        bv_index = self._append_bytes(raw, target=target)
        accessor: dict[str, Any] = {
            "bufferView": bv_index,
            "byteOffset": 0,
            "componentType": component_type,
            "count": int(arr.shape[0]),
            "type": gltf_type,
        }
        if include_minmax and arr.shape[0] > 0:
            if arr.ndim == 1:
                accessor["min"] = [float(np.min(arr))]
                accessor["max"] = [float(np.max(arr))]
            else:
                accessor["min"] = [float(v) for v in np.min(arr, axis=0)]
                accessor["max"] = [float(v) for v in np.max(arr, axis=0)]

        acc_index = len(self.accessors)
        self.accessors.append(accessor)
        self._accessor_cache[cache_key] = acc_index
        if dedup_source is not None and isinstance(dedup_source, np.ndarray):
            self._id_cache[(role, id(dedup_source), gltf_type, arr.shape)] = acc_index
        return acc_index


def build_gltf_document(
    *,
    meshes: Sequence[GltfMeshSpec],
    nodes: Sequence[GltfNodeSpec],
    root_node_indices: Sequence[int] | None = None,
    animation_channels: Sequence[GltfAnimationChannelSpec] = (),
    animation_name: str = "FullmagAnimation",
    coordinate_scale: str = "auto_scene",
    world_positions_for_scale_m: Sequence[ArrayLike] = (),
    fullmag_extras: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], bytes]:
    """Assemble a Khronos glTF 2.0 JSON dictionary and single binary buffer."""
    scale_inputs: list[ArrayLike] = list(world_positions_for_scale_m)
    if not scale_inputs:
        for mesh in meshes:
            for prim in mesh.primitives:
                if not prim.is_local_geometry and prim.positions_m.size > 0:
                    scale_inputs.append(prim.positions_m)
        for node in nodes:
            if node.translation_m is not None:
                scale_inputs.append(np.asarray([node.translation_m], dtype=np.float64))

    coord_scale, origin_offset_m, resolved_scale_mode = resolve_coordinate_transform(
        scale_inputs,
        coordinate_scale=coordinate_scale,
    )
    origin_arr = np.asarray(origin_offset_m, dtype=np.float64)
    si_meters_per_unit = 1.0 / coord_scale

    builder = _BinaryBufferBuilder()
    materials: list[dict[str, Any]] = []
    material_cache: dict[tuple[Any, ...], int] = {}
    extensions_used: set[str] = set()

    def _get_or_create_material(
        mode: str,
        base_color: tuple[float, float, float, float],
        double_sided: bool,
    ) -> int:
        mode_norm = mode.strip().lower()
        if mode_norm not in {"unlit", "pbr"}:
            raise ValueError(f"material_mode must be 'unlit' or 'pbr', got '{mode}'")
        r, g, b, a = (
            round(float(np.clip(base_color[0], 0.0, 1.0)), 6),
            round(float(np.clip(base_color[1], 0.0, 1.0)), 6),
            round(float(np.clip(base_color[2], 0.0, 1.0)), 6),
            round(float(np.clip(base_color[3], 0.0, 1.0)), 6),
        )
        key = (mode_norm, (r, g, b, a), bool(double_sided))
        cached = material_cache.get(key)
        if cached is not None:
            return cached

        mat: dict[str, Any] = {
            "name": f"mat_{mode_norm}_{len(materials)}",
            "pbrMetallicRoughness": {
                "baseColorFactor": [r, g, b, a],
                "metallicFactor": 0.0 if mode_norm == "unlit" else 0.08,
                "roughnessFactor": 1.0 if mode_norm == "unlit" else 0.45,
            },
            "doubleSided": bool(double_sided),
        }
        if a < 0.999999:
            mat["alphaMode"] = "BLEND"
        if mode_norm == "unlit":
            mat["extensions"] = {"KHR_materials_unlit": {}}
            extensions_used.add("KHR_materials_unlit")

        idx = len(materials)
        materials.append(mat)
        material_cache[key] = idx
        return idx

    gltf_meshes: list[dict[str, Any]] = []
    for mesh in meshes:
        gltf_primitives: list[dict[str, Any]] = []
        for prim in mesh.primitives:
            pos_src = np.asarray(prim.positions_m, dtype=np.float64)
            if pos_src.ndim != 2 or pos_src.shape[1] != 3:
                raise ValueError(f"primitive positions must have shape (V, 3), got {pos_src.shape}")

            scaled_pos = (
                pos_src * coord_scale
                if prim.is_local_geometry
                else (pos_src - origin_arr) * coord_scale
            ).astype(np.float32)

            pos_acc = builder.add_accessor(
                scaled_pos,
                role="POSITION" if not prim.is_local_geometry else "LOCAL_POSITION",
                gltf_type="VEC3",
                component_type=COMPONENT_FLOAT,
                target=TARGET_ARRAY_BUFFER,
                include_minmax=True,
                dedup_source=prim.positions_m,
            )
            attributes: dict[str, int] = {"POSITION": pos_acc}

            if prim.normals is not None:
                norm_src = np.asarray(prim.normals, dtype=np.float32)
                if norm_src.shape != scaled_pos.shape:
                    raise ValueError(
                        f"primitive normals shape {norm_src.shape} != positions shape {scaled_pos.shape}"
                    )
                attributes["NORMAL"] = builder.add_accessor(
                    norm_src,
                    role="NORMAL",
                    gltf_type="VEC3",
                    component_type=COMPONENT_FLOAT,
                    target=TARGET_ARRAY_BUFFER,
                    dedup_source=prim.normals,
                )

            if prim.colors_linear is not None:
                col_src = np.clip(
                    np.asarray(prim.colors_linear, dtype=np.float32),
                    0.0,
                    1.0,
                )
                if col_src.shape != scaled_pos.shape:
                    raise ValueError(
                        f"primitive colors shape {col_src.shape} != positions shape {scaled_pos.shape}"
                    )
                attributes["COLOR_0"] = builder.add_accessor(
                    col_src,
                    role="COLOR_0",
                    gltf_type="VEC3",
                    component_type=COMPONENT_FLOAT,
                    target=TARGET_ARRAY_BUFFER,
                    dedup_source=prim.colors_linear,
                )

            prim_dict: dict[str, Any] = {
                "attributes": attributes,
                "mode": int(prim.mode),
                "material": _get_or_create_material(
                    prim.material_mode,
                    prim.base_color_factor,
                    prim.double_sided,
                ),
            }

            if prim.indices is not None:
                flat_idx = np.asarray(prim.indices).ravel()
                if flat_idx.size > 0:
                    max_idx = int(np.max(flat_idx))
                    if max_idx < 65535:
                        idx_arr = flat_idx.astype(np.uint16)
                        comp_type = COMPONENT_UNSIGNED_SHORT
                    else:
                        idx_arr = flat_idx.astype(np.uint32)
                        comp_type = COMPONENT_UNSIGNED_INT
                    prim_dict["indices"] = builder.add_accessor(
                        idx_arr,
                        role="INDICES",
                        gltf_type="SCALAR",
                        component_type=comp_type,
                        target=TARGET_ELEMENT_ARRAY_BUFFER,
                        dedup_source=prim.indices,
                    )

            if prim.morph_deltas_m:
                targets: list[dict[str, int]] = []
                for delta_src in prim.morph_deltas_m:
                    delta_arr = (
                        np.asarray(delta_src, dtype=np.float64) * coord_scale
                    ).astype(np.float32)
                    if delta_arr.shape != scaled_pos.shape:
                        raise ValueError(
                            f"morph delta shape {delta_arr.shape} != positions shape {scaled_pos.shape}"
                        )
                    delta_acc = builder.add_accessor(
                        delta_arr,
                        role="MORPH_POSITION",
                        gltf_type="VEC3",
                        component_type=COMPONENT_FLOAT,
                        target=TARGET_ARRAY_BUFFER,
                        include_minmax=True,
                        dedup_source=delta_src,
                    )
                    targets.append({"POSITION": delta_acc})
                prim_dict["targets"] = targets

            gltf_primitives.append(prim_dict)

        mesh_dict: dict[str, Any] = {
            "name": mesh.name,
            "primitives": gltf_primitives,
        }
        if mesh.weights is not None:
            mesh_dict["weights"] = [float(w) for w in mesh.weights]
        elif gltf_primitives and "targets" in gltf_primitives[0]:
            mesh_dict["weights"] = [0.0] * len(gltf_primitives[0]["targets"])
        if mesh.extras:
            mesh_dict["extras"] = dict(mesh.extras)
        gltf_meshes.append(mesh_dict)

    used_names: set[str] = set()
    node_name_to_index: dict[str, int] = {}
    gltf_nodes: list[dict[str, Any]] = []

    for index, node in enumerate(nodes):
        safe_name = sanitize_gltf_node_name(node.name, used_names)
        if node.name in node_name_to_index:
            raise ValueError(f"duplicate GltfNodeSpec name '{node.name}'")
        node_name_to_index[node.name] = index
        node_dict: dict[str, Any] = {"name": safe_name}
        if node.mesh_index is not None:
            node_dict["mesh"] = int(node.mesh_index)
        if node.translation_m is not None:
            t_vec = (
                (np.asarray(node.translation_m, dtype=np.float64) - origin_arr) * coord_scale
            )
            node_dict["translation"] = [float(t_vec[0]), float(t_vec[1]), float(t_vec[2])]
        if node.rotation_xyzw is not None:
            q = np.asarray(node.rotation_xyzw, dtype=np.float64)
            q_norm = float(np.linalg.norm(q))
            if q_norm > 0.0:
                q = q / q_norm
            node_dict["rotation"] = [float(q[0]), float(q[1]), float(q[2]), float(q[3])]
        if node.scale is not None:
            s_arr = np.asarray(node.scale, dtype=np.float64)
            if node.scale_in_meters:
                s_arr = s_arr * coord_scale
            node_dict["scale"] = [float(s_arr[0]), float(s_arr[1]), float(s_arr[2])]
        if node.children:
            node_dict["children"] = [int(c) for c in node.children]
        if node.extras:
            node_dict["extras"] = dict(node.extras)
        gltf_nodes.append(node_dict)

    animations: list[dict[str, Any]] = []
    if animation_channels:
        samplers: list[dict[str, Any]] = []
        channels: list[dict[str, Any]] = []
        sampler_cache: dict[tuple[int, int, str], int] = {}

        for ch in animation_channels:
            if ch.node_name not in node_name_to_index:
                raise ValueError(f"animation channel targets unknown node '{ch.node_name}'")
            node_idx = node_name_to_index[ch.node_name]

            times_arr = np.asarray(ch.times_s, dtype=np.float32).ravel()
            if times_arr.size == 0:
                continue
            input_acc = builder.add_accessor(
                times_arr,
                role="ANIM_INPUT",
                gltf_type="SCALAR",
                component_type=COMPONENT_FLOAT,
                target=None,
                include_minmax=True,
                dedup_source=ch.times_s,
            )

            path = ch.path
            if path == "translation":
                vals_f64 = np.asarray(ch.values, dtype=np.float64)
                if ch.values_in_meters:
                    vals_f64 = (vals_f64 - origin_arr) * coord_scale
                out_arr = vals_f64.astype(np.float32)
                gltf_type = "VEC3"
            elif path == "rotation":
                out_arr = np.asarray(ch.values, dtype=np.float32)
                gltf_type = "VEC4"
            elif path == "scale":
                vals_f64 = np.asarray(ch.values, dtype=np.float64)
                if ch.values_in_meters:
                    vals_f64 = vals_f64 * coord_scale
                out_arr = vals_f64.astype(np.float32)
                gltf_type = "VEC3"
            elif path == "weights":
                out_arr = np.asarray(ch.values, dtype=np.float32).ravel()
                gltf_type = "SCALAR"
            else:
                raise ValueError(f"unsupported animation channel path '{path}'")

            output_acc = builder.add_accessor(
                out_arr,
                role=f"ANIM_OUTPUT_{path}",
                gltf_type=gltf_type,
                component_type=COMPONENT_FLOAT,
                target=None,
                dedup_source=ch.values,
            )

            interp = ch.interpolation.upper()
            if interp not in {"LINEAR", "STEP"}:
                raise ValueError(f"unsupported animation interpolation '{ch.interpolation}'")

            sampler_key = (input_acc, output_acc, interp)
            sampler_idx = sampler_cache.get(sampler_key)
            if sampler_idx is None:
                sampler_idx = len(samplers)
                samplers.append(
                    {
                        "input": input_acc,
                        "output": output_acc,
                        "interpolation": interp,
                    }
                )
                sampler_cache[sampler_key] = sampler_idx

            channels.append(
                {
                    "sampler": sampler_idx,
                    "target": {
                        "node": node_idx,
                        "path": path,
                    },
                }
            )

        if channels:
            animations.append(
                {
                    "name": animation_name,
                    "samplers": samplers,
                    "channels": channels,
                }
            )

    bin_bytes = builder.to_bytes()
    if root_node_indices is None:
        child_set = {child for n in gltf_nodes for child in n.get("children", ())}
        roots = [i for i in range(len(gltf_nodes)) if i not in child_set]
    else:
        roots = [int(i) for i in root_node_indices]

    fullmag_meta: dict[str, Any] = {
        "schema": "fullmag.export3d.gltf.v1",
        "coordinate_scale": resolved_scale_mode,
        "scale_factor": float(coord_scale),
        "si_meters_per_unit": float(si_meters_per_unit),
        "origin_offset_m": [float(origin_offset_m[0]), float(origin_offset_m[1]), float(origin_offset_m[2])],
    }
    if fullmag_extras:
        for k, v in fullmag_extras.items():
            fullmag_meta[str(k)] = v

    doc: dict[str, Any] = {
        "asset": {
            "version": "2.0",
            "generator": "fullmag.export3d",
            "extras": {"fullmag": fullmag_meta},
        },
        "scene": 0,
        "scenes": [{"name": "FullmagScene", "nodes": roots}],
        "nodes": gltf_nodes,
        "meshes": gltf_meshes,
        "materials": materials,
        "accessors": builder.accessors,
        "bufferViews": builder.buffer_views,
    }
    if bin_bytes:
        doc["buffers"] = [{"byteLength": len(bin_bytes)}]
    if animations:
        doc["animations"] = animations
    if extensions_used:
        doc["extensionsUsed"] = sorted(extensions_used)

    return doc, bin_bytes


def serialize_glb_bytes(doc: Mapping[str, Any], bin_bytes: bytes = b"") -> bytes:
    """Serialize a glTF 2.0 JSON document + binary buffer into GLB 2.0 bytes."""
    json_doc = json.loads(json.dumps(doc))
    if bin_bytes and "buffers" in json_doc and json_doc["buffers"]:
        json_doc["buffers"][0].pop("uri", None)
        json_doc["buffers"][0]["byteLength"] = len(bin_bytes)

    json_raw = json.dumps(json_doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_pad = (-len(json_raw)) % 4
    json_chunk = json_raw + (b" " * json_pad)

    bin_chunk = b""
    if bin_bytes:
        bin_pad = (-len(bin_bytes)) % 4
        bin_chunk = bin_bytes + (b"\x00" * bin_pad)

    total_length = 12 + 8 + len(json_chunk) + ((8 + len(bin_chunk)) if bin_chunk else 0)
    parts = [
        struct.pack("<III", GLB_MAGIC, GLB_VERSION, total_length),
        struct.pack("<II", len(json_chunk), GLB_CHUNK_JSON),
        json_chunk,
    ]
    if bin_chunk:
        parts.append(struct.pack("<II", len(bin_chunk), GLB_CHUNK_BIN))
        parts.append(bin_chunk)
    return b"".join(parts)


def serialize_gltf_json(doc: Mapping[str, Any], bin_bytes: bytes = b"") -> str:
    """Serialize a glTF 2.0 JSON document with an embedded base64 buffer URI."""
    json_doc = json.loads(json.dumps(doc))
    if bin_bytes:
        encoded = base64.b64encode(bin_bytes).decode("ascii")
        json_doc["buffers"] = [
            {
                "byteLength": len(bin_bytes),
                "uri": f"data:application/octet-stream;base64,{encoded}",
            }
        ]
    else:
        json_doc.pop("buffers", None)
    return json.dumps(json_doc, indent=2, ensure_ascii=False)


def write_glb(output_path: str | Path, doc: Mapping[str, Any], bin_bytes: bytes = b"") -> Path:
    """Write GLB 2.0 bytes to ``output_path``."""
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(serialize_glb_bytes(doc, bin_bytes))
    return target


def write_gltf(output_path: str | Path, doc: Mapping[str, Any], bin_bytes: bytes = b"") -> Path:
    """Write self-contained glTF 2.0 JSON with embedded buffer URI to ``output_path``."""
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(serialize_gltf_json(doc, bin_bytes), encoding="utf-8")
    return target


def _build_direct_mesh_doc(
    *,
    positions_m: ArrayLike,
    indices: ArrayLike | None = None,
    normals: ArrayLike | None = None,
    colors_linear: ArrayLike | None = None,
    vectors: ArrayLike | None = None,
    scalars: ArrayLike | None = None,
    color_mode: str | None = None,
    color_palette: str = "viridis",
    scalar_range: tuple[float, float] | None = None,
    material_mode: str = "unlit",
    opacity: float = 1.0,
    coordinate_scale: str = "auto_scene",
    edge_indices: ArrayLike | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], bytes]:
    pos = np.asarray(positions_m, dtype=np.float64)
    if pos.ndim != 2 or pos.shape[1] != 3:
        raise ValueError(f"positions_m must have shape (V, 3), got {pos.shape}")

    idx_arr = np.asarray(indices, dtype=np.uint32) if indices is not None else None
    if normals is not None:
        norm_arr = np.asarray(normals, dtype=np.float64)
    elif idx_arr is not None:
        norm_arr = _compute_vertex_normals(pos, idx_arr.reshape(-1, 3))
    else:
        norm_arr = None

    resolved_colors: NDArray[np.float64] | None = None
    resolved_range = (0.0, 1.0)
    if colors_linear is not None:
        resolved_colors = np.asarray(colors_linear, dtype=np.float64)
    elif vectors is not None:
        resolved_colors, resolved_range = evaluate_field_colors(
            vectors,
            color_mode=color_mode or "orientation",
            color_palette=color_palette,
            scalar_range=scalar_range,
            color_space="linear",
        )
    elif scalars is not None:
        resolved_colors, resolved_range = evaluate_field_colors(
            scalars,
            color_mode=color_mode or "scalar",
            color_palette=color_palette,
            scalar_range=scalar_range,
            color_space="linear",
        )

    alpha = float(np.clip(opacity, 0.0, 1.0))
    mesh_specs: list[GltfMeshSpec] = [
        GltfMeshSpec(
            name="surface_mesh",
            primitives=[
                GltfPrimitiveSpec(
                    positions_m=pos,
                    normals=norm_arr,
                    colors_linear=resolved_colors,
                    indices=idx_arr,
                    mode=PRIMITIVE_TRIANGLES,
                    material_mode=material_mode,
                    base_color_factor=(1.0, 1.0, 1.0, alpha),
                )
            ],
        )
    ]
    node_specs: list[GltfNodeSpec] = [GltfNodeSpec(name="surface", mesh_index=0)]

    if edge_indices is not None:
        edges = np.asarray(edge_indices, dtype=np.uint32)
        if edges.size > 0:
            wire_rgb = srgb_to_linear((0.08, 0.08, 0.08))
            mesh_specs.append(
                GltfMeshSpec(
                    name="wireframe_mesh",
                    primitives=[
                        GltfPrimitiveSpec(
                            positions_m=pos,
                            indices=edges,
                            mode=PRIMITIVE_LINES,
                            material_mode="unlit",
                            base_color_factor=(
                                float(wire_rgb[0]),
                                float(wire_rgb[1]),
                                float(wire_rgb[2]),
                                min(alpha, 0.85),
                            ),
                            double_sided=False,
                        )
                    ],
                )
            )
            node_specs.append(GltfNodeSpec(name="wireframe", mesh_index=1))

    extras: dict[str, Any] = {"scalar_range": [resolved_range[0], resolved_range[1]]}
    if metadata:
        extras.update(metadata)

    return build_gltf_document(
        meshes=mesh_specs,
        nodes=node_specs,
        coordinate_scale=coordinate_scale,
        fullmag_extras=extras,
    )


def _compute_vertex_normals(
    positions: NDArray[np.float64],
    triangles: NDArray[np.uint32],
) -> NDArray[np.float64]:
    normals = np.zeros_like(positions, dtype=np.float64)
    if triangles.size == 0:
        normals[:, 2] = 1.0
        return normals
    v0 = positions[triangles[:, 0]]
    v1 = positions[triangles[:, 1]]
    v2 = positions[triangles[:, 2]]
    face_normals = np.cross(v1 - v0, v2 - v0)
    np.add.at(normals, triangles[:, 0], face_normals)
    np.add.at(normals, triangles[:, 1], face_normals)
    np.add.at(normals, triangles[:, 2], face_normals)
    lens = np.linalg.norm(normals, axis=1)
    valid = lens > 1e-30
    normals[valid] /= lens[valid, np.newaxis]
    normals[~valid] = (0.0, 0.0, 1.0)
    return normals


def export_glb(
    output_path: str | Path,
    *,
    positions_m: ArrayLike,
    indices: ArrayLike | None = None,
    normals: ArrayLike | None = None,
    colors_linear: ArrayLike | None = None,
    vectors: ArrayLike | None = None,
    scalars: ArrayLike | None = None,
    color_mode: str | None = None,
    color_palette: str = "viridis",
    scalar_range: tuple[float, float] | None = None,
    material_mode: str = "unlit",
    opacity: float = 1.0,
    coordinate_scale: str = "auto_scene",
    edge_indices: ArrayLike | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> Path:
    """Export an arbitrary 3D triangle mesh and optional field colors to binary ``.glb``."""
    doc, bin_bytes = _build_direct_mesh_doc(
        positions_m=positions_m,
        indices=indices,
        normals=normals,
        colors_linear=colors_linear,
        vectors=vectors,
        scalars=scalars,
        color_mode=color_mode,
        color_palette=color_palette,
        scalar_range=scalar_range,
        material_mode=material_mode,
        opacity=opacity,
        coordinate_scale=coordinate_scale,
        edge_indices=edge_indices,
        metadata=metadata,
    )
    return write_glb(output_path, doc, bin_bytes)


def export_gltf(
    output_path: str | Path,
    *,
    positions_m: ArrayLike,
    indices: ArrayLike | None = None,
    normals: ArrayLike | None = None,
    colors_linear: ArrayLike | None = None,
    vectors: ArrayLike | None = None,
    scalars: ArrayLike | None = None,
    color_mode: str | None = None,
    color_palette: str = "viridis",
    scalar_range: tuple[float, float] | None = None,
    material_mode: str = "unlit",
    opacity: float = 1.0,
    coordinate_scale: str = "auto_scene",
    edge_indices: ArrayLike | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> Path:
    """Export an arbitrary 3D triangle mesh and optional field colors to embedded ``.gltf``."""
    doc, bin_bytes = _build_direct_mesh_doc(
        positions_m=positions_m,
        indices=indices,
        normals=normals,
        colors_linear=colors_linear,
        vectors=vectors,
        scalars=scalars,
        color_mode=color_mode,
        color_palette=color_palette,
        scalar_range=scalar_range,
        material_mode=material_mode,
        opacity=opacity,
        coordinate_scale=coordinate_scale,
        edge_indices=edge_indices,
        metadata=metadata,
    )
    return write_gltf(output_path, doc, bin_bytes)
