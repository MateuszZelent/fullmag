"""High-level 3D model exporters for Fullmag grids, FEM meshes, modes, and result bundles."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import math
from pathlib import Path
import struct
from typing import Any, Mapping, Sequence

import numpy as np
from numpy.typing import ArrayLike, NDArray

from .arrow_mesh import build_animated_arrow_tracks, build_merged_arrow_mesh, create_unit_arrow_mesh
from .colormaps import (
    evaluate_complex_vector_field,
    evaluate_field_colors,
    extract_scalar_from_vectors,
    normalize_color_mode,
    normalize_palette_name,
    normalize_scalar_values,
    srgb_to_linear,
)
from .gltf_writer import (
    PRIMITIVE_LINES,
    PRIMITIVE_TRIANGLES,
    GltfAnimationChannelSpec,
    GltfMeshSpec,
    GltfNodeSpec,
    GltfPrimitiveSpec,
    build_gltf_document,
    resolve_coordinate_transform,
    write_glb,
    write_gltf,
)
from .voxel_shell import (
    VoxelShell,
    extract_voxel_shell,
    merge_voxel_shells,
    normalize_active_mask,
    sample_grid_arrow_sites,
    validate_grid_descriptor,
    voxel_cell_centers_m,
    voxel_hexahedra_vtu_data,
)
from .vtk_writer import export_vtu, write_pvd_bundle

_FEM_CELL_ARITIES: dict[str, int] = {
    "tet4": 4,
    "prism6": 6,
    "pyramid5": 5,
    "hex8": 8,
}

_FEM_CELL_FACES: dict[str, tuple[tuple[int, ...], ...]] = {
    "tet4": ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)),
    "prism6": ((0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)),
    "pyramid5": ((0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)),
    "hex8": (
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ),
}

_VTK_TO_CELL_NAME: dict[int, str] = {
    10: "tet4",
    12: "hex8",
    13: "prism6",
    14: "pyramid5",
}


@dataclass(frozen=True, slots=True)
class Export3DResult:
    """Summary of a completed 3D model export (also usable as ``os.PathLike``)."""

    output_path: Path
    format: str
    frame_count: int
    vertex_count: int
    cell_count: int
    arrow_count: int
    coordinate_scale: str
    si_meters_per_unit: float
    origin_offset_m: tuple[float, float, float]
    scalar_range: tuple[float, float]
    files_written: tuple[Path, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def __fspath__(self) -> str:
        return str(self.output_path)


def _infer_export_format(output_path: Path, fmt: str) -> str:
    norm = fmt.strip().lower()
    if norm and norm != "auto":
        if norm in {"zip", "pvd_zip"}:
            return "vtu_zip"
        if norm in {"glb", "gltf", "vtu", "pvd", "vtu_zip"}:
            return norm
        raise ValueError(
            f"unsupported export format '{fmt}'; expected 'auto', 'glb', 'gltf', 'vtu', 'pvd', or 'vtu_zip'"
        )
    lower = output_path.name.lower()
    if lower.endswith(".glb"):
        return "glb"
    if lower.endswith(".gltf"):
        return "gltf"
    if lower.endswith(".vtu.zip") or lower.endswith(".zip"):
        return "vtu_zip"
    if lower.endswith(".vtu"):
        return "vtu"
    if lower.endswith(".pvd") or output_path.suffix == "":
        return "pvd"
    raise ValueError(
        f"cannot infer 3D export format from '{output_path.name}'; specify format explicitly"
    )


def _resolve_coordinate_scale(fmt: str, coordinate_scale: str | None) -> str:
    if coordinate_scale is not None:
        return coordinate_scale
    return "si_m" if fmt in {"vtu", "pvd", "vtu_zip"} else "auto_scene"


def _unwrap_values(values: Any) -> Any:
    if hasattr(values, "values") and hasattr(values, "quantity_id"):
        return values.values
    if hasattr(values, "values") and hasattr(values, "source_format"):
        return values.values
    return values


def _normalize_grid_field_frames(
    values: Any,
    total_cells: int,
    grid_shape: tuple[int, int, int] | None = None,
) -> tuple[NDArray[np.float64], bool]:
    """Normalize FDM field values into shape ``(T, total_cells, C)`` where ``C`` is 1 or 3.

    Returns ``(frames, is_vector)``.
    """
    arr = np.asarray(_unwrap_values(values), dtype=np.float64)
    if arr.ndim == 1:
        if arr.size == total_cells:
            return arr.reshape(1, total_cells, 1), False
        if arr.size == total_cells * 3:
            return arr.reshape(1, total_cells, 3), True
    elif arr.ndim == 2:
        if arr.shape == (total_cells, 3):
            return arr[np.newaxis, :, :], True
        if arr.shape == (total_cells, 1):
            return arr[np.newaxis, :, :], False
        if arr.shape[1] == total_cells:
            return arr[:, :, np.newaxis], False
        if arr.shape[1] == total_cells * 3:
            return arr.reshape(arr.shape[0], total_cells, 3), True
    elif arr.ndim == 3:
        if arr.shape[1:] == (total_cells, 3):
            return arr, True
        if arr.shape[1:] == (total_cells, 1):
            return arr, False
        if grid_shape is not None and arr.shape == (grid_shape[2], grid_shape[1], grid_shape[0]):
            return arr.reshape(1, total_cells, 1), False
    elif arr.ndim == 4 and grid_shape is not None:
        nx, ny, nz = grid_shape
        if arr.shape == (nz, ny, nx, 3):
            return arr.reshape(1, total_cells, 3), True
        if arr.shape[1:] == (nz, ny, nx):
            return arr.reshape(arr.shape[0], total_cells, 1), False
    elif arr.ndim == 5 and grid_shape is not None:
        nx, ny, nz = grid_shape
        if arr.shape[1:] == (nz, ny, nx, 3):
            return arr.reshape(arr.shape[0], total_cells, 3), True

    raise ValueError(
        f"field values shape {arr.shape} is incompatible with grid cell count {total_cells}"
    )


def _normalize_mesh_field_frames(
    values: Any,
    node_count: int,
    cell_count: int,
    active_cell_count: int | None = None,
) -> tuple[NDArray[np.float64], bool, str]:
    """Normalize FEM field values into ``(T, count, C)`` and location ``'node' | 'cell' | 'active_cell'``."""
    arr = np.asarray(_unwrap_values(values), dtype=np.float64)
    candidates: list[tuple[int, str]] = [(node_count, "node")]
    if cell_count > 0 and cell_count != node_count:
        candidates.append((cell_count, "cell"))
    if active_cell_count is not None and active_cell_count > 0 and active_cell_count not in {node_count, cell_count}:
        candidates.append((active_cell_count, "active_cell"))

    for count, loc in candidates:
        if arr.ndim == 1:
            if arr.size == count:
                return arr.reshape(1, count, 1), False, loc
            if arr.size == count * 3:
                return arr.reshape(1, count, 3), True, loc
        elif arr.ndim == 2:
            if arr.shape == (count, 3):
                return arr[np.newaxis, :, :], True, loc
            if arr.shape == (count, 1):
                return arr[np.newaxis, :, :], False, loc
            if arr.shape[1] == count:
                return arr[:, :, np.newaxis], False, loc
            if arr.shape[1] == count * 3:
                return arr.reshape(arr.shape[0], count, 3), True, loc
        elif arr.ndim == 3:
            if arr.shape[1:] == (count, 3):
                return arr, True, loc
            if arr.shape[1:] == (count, 1):
                return arr, False, loc

    raise ValueError(
        f"FEM field shape {arr.shape} does not match node_count={node_count} or cell_count={cell_count}"
    )


def _resolve_times_s(times_s: Sequence[float] | None, frame_count: int) -> list[float]:
    if times_s is None:
        return [float(i) for i in range(frame_count)]
    resolved = [float(t) for t in times_s]
    if len(resolved) != frame_count:
        raise ValueError(
            f"times_s length {len(resolved)} does not match frame_count {frame_count}"
        )
    for i in range(1, len(resolved)):
        if not (math.isfinite(resolved[i]) and resolved[i] > resolved[i - 1]):
            raise ValueError("times_s must be finite and strictly increasing")
    if resolved and not math.isfinite(resolved[0]):
        raise ValueError("times_s entries must be finite")
    return resolved


def _resolve_gltf_timeline(
    times_s: Sequence[float],
    *,
    duration_s: float | None,
    fps: float | None,
) -> NDArray[np.float64]:
    k = len(times_s)
    if k <= 1:
        return np.asarray([0.0], dtype=np.float64)
    if duration_s is not None:
        target_dur = float(duration_s)
    elif fps is not None:
        target_dur = (k - 1) / max(float(fps), 1e-6)
    else:
        target_dur = max(2.0, (k - 1) / 12.0)

    t0 = times_s[0]
    span = times_s[-1] - t0
    if span > 0.0 and math.isfinite(span):
        return np.asarray([(t - t0) / span * target_dur for t in times_s], dtype=np.float64)
    return np.linspace(0.0, target_dur, k, dtype=np.float64)


def _compute_global_scalar_range(
    frames: NDArray[np.float64],
    is_vector: bool,
    color_mode: str,
    scalar_range: tuple[float, float] | None,
) -> tuple[float, float]:
    if scalar_range is not None:
        return (float(scalar_range[0]), float(scalar_range[1]))
    if color_mode in {"orientation", "monochrome"}:
        return (0.0, 1.0)
    vmin = math.inf
    vmax = -math.inf
    for frame in frames:
        arr = frame if is_vector else frame[:, 0]
        vals = extract_scalar_from_vectors(arr, color_mode=color_mode) if is_vector else arr
        finite = vals[np.isfinite(vals)]
        if finite.size > 0:
            vmin = min(vmin, float(np.min(finite)))
            vmax = max(vmax, float(np.max(finite)))
    if not (math.isfinite(vmin) and math.isfinite(vmax)):
        return (0.0, 1.0)
    return (vmin, vmax)


def _quantize_arrow_palette(
    colors_linear: NDArray[np.float64],
    *,
    steps: int = 8,
) -> tuple[list[tuple[float, float, float]], NDArray[np.int64]]:
    """Quantize M linear RGB colors into a bounded list of shared material colors."""
    clipped = np.clip(colors_linear, 0.0, 1.0)
    quantized = np.round(clipped * steps) / float(steps)
    unique_cols, inverse = np.unique(quantized, axis=0, return_inverse=True)
    palette = [(float(r), float(g), float(b)) for r, g, b in unique_cols]
    return palette, inverse


def _build_gltf_surface_and_arrows(
    *,
    surface_positions_m: NDArray[np.float64] | None,
    surface_normals: NDArray[np.float64] | None,
    surface_indices: NDArray[np.uint32] | None,
    surface_edge_indices: NDArray[np.uint32] | None,
    surface_frame_colors_linear: Sequence[NDArray[np.float64]] | None,
    morph_deltas_m: Sequence[NDArray[np.float64]] = (),
    morph_weights_track: NDArray[np.float64] | None = None,
    arrow_sites_m: NDArray[np.float64] | None = None,
    arrow_vector_frames: NDArray[np.float64] | None = None,
    arrow_colors_linear_ref: NDArray[np.float64] | None = None,
    arrow_length_m: float = 1e-8,
    arrow_scale_by_magnitude: bool = False,
    arrow_max_magnitude: float | None = None,
    arrow_anchor: str = "center",
    timeline_s: NDArray[np.float64],
    phase_cycle: bool,
    material_mode: str,
    opacity: float,
    coordinate_scale: str,
    fullmag_extras: Mapping[str, Any],
) -> tuple[dict[str, Any], bytes, tuple[float, float, float], float]:
    """Assemble static or animated glTF document + BIN buffer for surface and/or arrows."""
    meshes: list[GltfMeshSpec] = []
    nodes: list[GltfNodeSpec] = []
    channels: list[GltfAnimationChannelSpec] = []
    scale_inputs: list[ArrayLike] = []

    alpha = float(np.clip(opacity, 0.0, 1.0))

    if (
        surface_positions_m is not None
        and surface_indices is not None
        and surface_frame_colors_linear is not None
        and len(surface_frame_colors_linear) > 0
    ):
        scale_inputs.append(surface_positions_m)
        k_frames = len(surface_frame_colors_linear)
        has_morph = len(morph_deltas_m) > 0

        if k_frames == 1:
            mesh_idx = len(meshes)
            meshes.append(
                GltfMeshSpec(
                    name="surface_mesh",
                    primitives=[
                        GltfPrimitiveSpec(
                            positions_m=surface_positions_m,
                            normals=surface_normals,
                            colors_linear=surface_frame_colors_linear[0],
                            indices=surface_indices,
                            mode=PRIMITIVE_TRIANGLES,
                            material_mode=material_mode,
                            base_color_factor=(1.0, 1.0, 1.0, alpha),
                            morph_deltas_m=morph_deltas_m,
                        )
                    ],
                    weights=[1.0] + [0.0] * (len(morph_deltas_m) - 1) if has_morph else None,
                )
            )
            nodes.append(GltfNodeSpec(name="surface", mesh_index=mesh_idx))
        else:
            t_len = int(timeline_s.shape[0])
            for k, frame_cols in enumerate(surface_frame_colors_linear):
                mesh_idx = len(meshes)
                meshes.append(
                    GltfMeshSpec(
                        name=f"surface_frame_mesh_{k:04d}",
                        primitives=[
                            GltfPrimitiveSpec(
                                positions_m=surface_positions_m,
                                normals=surface_normals,
                                colors_linear=frame_cols,
                                indices=surface_indices,
                                mode=PRIMITIVE_TRIANGLES,
                                material_mode=material_mode,
                                base_color_factor=(1.0, 1.0, 1.0, alpha),
                                morph_deltas_m=morph_deltas_m,
                            )
                        ],
                    )
                )
                node_name = f"surface_frame_{k:04d}"
                init_scale = (1.0, 1.0, 1.0) if k == 0 else (0.0, 0.0, 0.0)
                nodes.append(GltfNodeSpec(name=node_name, mesh_index=mesh_idx, scale=init_scale))

                scale_vals = np.zeros((t_len, 3), dtype=np.float64)
                active_steps = np.zeros(t_len, dtype=bool)
                active_steps[k] = True
                if phase_cycle and t_len == k_frames + 1 and k == 0:
                    active_steps[-1] = True
                scale_vals[active_steps] = 1.0
                channels.append(
                    GltfAnimationChannelSpec(
                        node_name=node_name,
                        path="scale",
                        times_s=timeline_s,
                        values=scale_vals,
                        interpolation="STEP",
                    )
                )
                if has_morph and morph_weights_track is not None:
                    channels.append(
                        GltfAnimationChannelSpec(
                            node_name=node_name,
                            path="weights",
                            times_s=timeline_s,
                            values=morph_weights_track,
                            interpolation="LINEAR",
                        )
                    )

        if surface_edge_indices is not None and surface_edge_indices.size > 0:
            wire_rgb = srgb_to_linear((0.08, 0.08, 0.08))
            wire_mesh_idx = len(meshes)
            meshes.append(
                GltfMeshSpec(
                    name="surface_wireframe_mesh",
                    primitives=[
                        GltfPrimitiveSpec(
                            positions_m=surface_positions_m,
                            indices=surface_edge_indices,
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
            nodes.append(GltfNodeSpec(name="surface_wireframe", mesh_index=wire_mesh_idx))

    if arrow_sites_m is not None and arrow_vector_frames is not None and arrow_sites_m.shape[0] > 0:
        scale_inputs.append(arrow_sites_m)
        t_frames, m_sites, _ = arrow_vector_frames.shape
        if t_frames == 1:
            assert arrow_colors_linear_ref is not None
            a_pos, a_norm, a_cols, a_idx = build_merged_arrow_mesh(
                arrow_sites_m,
                arrow_vector_frames[0],
                arrow_colors_linear_ref,
                arrow_length_m=arrow_length_m,
                scale_by_magnitude=arrow_scale_by_magnitude,
                max_magnitude=arrow_max_magnitude,
                anchor=arrow_anchor,
            )
            if a_pos.shape[0] > 0:
                arrow_mesh_idx = len(meshes)
                meshes.append(
                    GltfMeshSpec(
                        name="vector_arrows_mesh",
                        primitives=[
                            GltfPrimitiveSpec(
                                positions_m=a_pos,
                                normals=a_norm,
                                colors_linear=a_cols,
                                indices=a_idx,
                                mode=PRIMITIVE_TRIANGLES,
                                material_mode=material_mode,
                                base_color_factor=(1.0, 1.0, 1.0, alpha),
                            )
                        ],
                    )
                )
                nodes.append(GltfNodeSpec(name="vector_arrows", mesh_index=arrow_mesh_idx))
        else:
            assert arrow_colors_linear_ref is not None
            unit = create_unit_arrow_mesh(anchor=arrow_anchor)
            palette_cols, bucket_ids = _quantize_arrow_palette(arrow_colors_linear_ref)
            bucket_mesh_indices: list[int] = []
            for b_idx, (r, g, b) in enumerate(palette_cols):
                m_idx = len(meshes)
                meshes.append(
                    GltfMeshSpec(
                        name=f"unit_arrow_palette_{b_idx:03d}",
                        primitives=[
                            GltfPrimitiveSpec(
                                positions_m=unit.positions,
                                normals=unit.normals,
                                indices=unit.indices,
                                mode=PRIMITIVE_TRIANGLES,
                                material_mode=material_mode,
                                base_color_factor=(r, g, b, alpha),
                                is_local_geometry=True,
                            )
                        ],
                    )
                )
                bucket_mesh_indices.append(m_idx)

            tracks = build_animated_arrow_tracks(
                arrow_sites_m,
                arrow_vector_frames,
                arrow_length_m=arrow_length_m,
                scale_by_magnitude=arrow_scale_by_magnitude,
                max_magnitude=arrow_max_magnitude,
            )
            trans_track = tracks["translations_m"]
            rot_track = tracks["rotations_xyzw"]
            scale_track = tracks["scales"]

            for site_i in range(m_sites):
                node_name = f"arrow_{site_i:04d}"
                t0 = trans_track[0, site_i]
                q0 = rot_track[0, site_i]
                s0 = scale_track[0, site_i]
                nodes.append(
                    GltfNodeSpec(
                        name=node_name,
                        mesh_index=bucket_mesh_indices[int(bucket_ids[site_i])],
                        translation_m=(float(t0[0]), float(t0[1]), float(t0[2])),
                        rotation_xyzw=(float(q0[0]), float(q0[1]), float(q0[2]), float(q0[3])),
                        scale=(float(s0[0]), float(s0[1]), float(s0[2])),
                        scale_in_meters=True,
                    )
                )
                channels.append(
                    GltfAnimationChannelSpec(
                        node_name=node_name,
                        path="translation",
                        times_s=timeline_s,
                        values=trans_track[:, site_i, :],
                        interpolation="LINEAR",
                        values_in_meters=True,
                    )
                )
                channels.append(
                    GltfAnimationChannelSpec(
                        node_name=node_name,
                        path="rotation",
                        times_s=timeline_s,
                        values=rot_track[:, site_i, :],
                        interpolation="LINEAR",
                    )
                )
                channels.append(
                    GltfAnimationChannelSpec(
                        node_name=node_name,
                        path="scale",
                        times_s=timeline_s,
                        values=scale_track[:, site_i, :],
                        interpolation="LINEAR",
                        values_in_meters=True,
                    )
                )

    coord_scale, origin_offset_m, _ = resolve_coordinate_transform(
        scale_inputs,
        coordinate_scale=coordinate_scale,
    )
    doc, bin_bytes = build_gltf_document(
        meshes=meshes,
        nodes=nodes,
        animation_channels=channels,
        coordinate_scale=coordinate_scale,
        world_positions_for_scale_m=scale_inputs,
        fullmag_extras=fullmag_extras,
    )
    return doc, bin_bytes, origin_offset_m, 1.0 / coord_scale


def _write_gltf_or_glb(
    output_path: Path,
    fmt: str,
    doc: Mapping[str, Any],
    bin_bytes: bytes,
) -> Path:
    if fmt == "glb":
        return write_glb(output_path, doc, bin_bytes)
    return write_gltf(output_path, doc, bin_bytes)


def _compute_normal_morph_deltas(
    base_vectors: NDArray[np.float64],
    quad_vectors: NDArray[np.float64],
    normals: NDArray[np.float64],
    *,
    displacement_scale_m: float,
    displacement_component: str = "auto",
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Compute harmonic ``(delta_cos, delta_sin)`` vertex position displacements along normals."""
    comp = displacement_component.strip().lower()
    if comp == "x":
        s0, s1 = base_vectors[:, 0], quad_vectors[:, 0]
    elif comp == "y":
        s0, s1 = base_vectors[:, 1], quad_vectors[:, 1]
    elif comp == "z":
        s0, s1 = base_vectors[:, 2], quad_vectors[:, 2]
    else:
        n0 = np.sum(base_vectors * normals, axis=1)
        n1 = np.sum(quad_vectors * normals, axis=1)
        max_n = max(float(np.max(np.abs(n0))), float(np.max(np.abs(n1))))
        max_v = max(
            float(np.max(np.linalg.norm(base_vectors, axis=1))),
            float(np.max(np.linalg.norm(quad_vectors, axis=1))),
            1e-30,
        )
        if comp == "normal" or max_n > 1e-9 * max_v:
            s0, s1 = n0, n1
        else:
            axis_energies = np.sum(base_vectors * base_vectors + quad_vectors * quad_vectors, axis=0)
            best_axis = int(np.argmax(axis_energies))
            s0, s1 = base_vectors[:, best_axis], quad_vectors[:, best_axis]

    amp_max = max(float(np.max(np.abs(s0))), float(np.max(np.abs(s1))), 1e-30)
    scale = float(displacement_scale_m) / amp_max
    delta_cos = normals * (s0[:, np.newaxis] * scale)
    delta_sin = normals * (s1[:, np.newaxis] * scale)
    return delta_cos, delta_sin


def _vtu_data_for_field(
    values: NDArray[np.float64],
    *,
    is_vector: bool,
    quantity_id: str,
    color_mode: str,
    color_palette: str,
    scalar_range: tuple[float, float],
    extra_arrays: Mapping[str, NDArray[np.float64]] | None = None,
) -> dict[str, np.ndarray]:
    data: dict[str, np.ndarray] = {}
    if is_vector:
        data[quantity_id] = values
        data[f"{quantity_id}_magnitude"] = np.linalg.norm(values, axis=1)
        srgb, _ = evaluate_field_colors(
            values,
            color_mode=color_mode,
            color_palette=color_palette,
            scalar_range=scalar_range,
            color_space="srgb",
        )
    else:
        scalar = values[:, 0]
        data[quantity_id] = scalar
        srgb, _ = evaluate_field_colors(
            scalar,
            color_mode=color_mode if color_mode == "monochrome" else "scalar",
            color_palette=color_palette,
            scalar_range=scalar_range,
            color_space="srgb",
        )
    data["magnetic_texture_rgb"] = np.clip(np.round(srgb * 255.0), 0.0, 255.0).astype(np.uint8)
    if extra_arrays:
        for k, v in extra_arrays.items():
            data[k] = v
    return data


def _build_grid_geometry(
    *,
    grid_shape: Sequence[int] | None,
    cell_size_m: Sequence[float] | None,
    origin_m: Sequence[float],
    active_mask: Any | None,
    layers: Sequence[Mapping[str, Any]] | None,
    axis_order: str,
    max_arrows: int,
) -> tuple[VoxelShell, NDArray[np.float64], NDArray[np.int64], NDArray[np.float64], NDArray[np.int64], NDArray[np.int64], int, tuple[float, float, float]]:
    """Build combined FDM ``VoxelShell``, VTU hexahedra, and arrow sample sites."""
    if layers is not None:
        if not layers:
            raise ValueError("layers must not be empty")
        shells: list[VoxelShell] = []
        hex_pts_list: list[NDArray[np.float64]] = []
        hex_conn_list: list[NDArray[np.int64]] = []
        hex_cells_list: list[NDArray[np.int64]] = []
        arrow_pts_list: list[NDArray[np.float64]] = []
        arrow_cells_list: list[NDArray[np.int64]] = []
        total_cells = 0
        pt_offset = 0
        max_cell_dim = 0.0
        for layer in layers:
            l_shape, l_cell, l_origin = validate_grid_descriptor(
                layer["grid_shape"],
                layer["cell_size_m"],
                layer.get("origin_m", (0.0, 0.0, 0.0)),
            )
            max_cell_dim = max(max_cell_dim, max(l_cell))
            l_count = l_shape[0] * l_shape[1] * l_shape[2]
            v_off = int(layer.get("value_offset", total_cells))
            l_mask = layer.get("active_mask")
            shells.append(
                extract_voxel_shell(
                    l_shape,
                    l_cell,
                    l_origin,
                    active_mask=l_mask,
                    axis_order=axis_order,
                    cell_offset=v_off,
                )
            )
            vh = voxel_hexahedra_vtu_data(
                l_shape,
                l_cell,
                l_origin,
                active_mask=l_mask,
                axis_order=axis_order,
                cell_offset=v_off,
            )
            hex_pts_list.append(vh.points_m)
            hex_conn_list.append(vh.connectivity + pt_offset)
            hex_cells_list.append(vh.cell_indices)
            pt_offset += vh.points_m.shape[0]
            total_cells = max(total_cells, v_off + l_count)

        per_layer_budget = max(1, int(math.ceil(max(max_arrows, 1) / len(layers))))
        for layer in layers:
            l_shape, l_cell, l_origin = validate_grid_descriptor(
                layer["grid_shape"],
                layer["cell_size_m"],
                layer.get("origin_m", (0.0, 0.0, 0.0)),
            )
            v_off = int(layer.get("value_offset", 0))
            pts, cids = sample_grid_arrow_sites(
                l_shape,
                l_cell,
                l_origin,
                active_mask=layer.get("active_mask"),
                max_arrows=per_layer_budget,
                axis_order=axis_order,
                cell_offset=v_off,
            )
            arrow_pts_list.append(pts)
            arrow_cells_list.append(cids)

        shell = merge_voxel_shells(shells)
        hex_pts = np.concatenate(hex_pts_list, axis=0)
        hex_conn = np.concatenate(hex_conn_list, axis=0)
        hex_cell_ids = np.concatenate(hex_cells_list, axis=0)
        arrow_pts = np.concatenate(arrow_pts_list, axis=0)[:max_arrows]
        arrow_cids = np.concatenate(arrow_cells_list, axis=0)[:max_arrows]
        return shell, hex_pts, hex_conn, arrow_pts, arrow_cids, hex_cell_ids, total_cells, (max_cell_dim, max_cell_dim, max_cell_dim)

    if grid_shape is None or cell_size_m is None:
        raise ValueError("grid_shape and cell_size_m are required unless layers is provided")
    shape, cell_size, origin = validate_grid_descriptor(grid_shape, cell_size_m, origin_m)
    total_cells = shape[0] * shape[1] * shape[2]
    shell = extract_voxel_shell(
        shape,
        cell_size,
        origin,
        active_mask=active_mask,
        axis_order=axis_order,
    )
    vh = voxel_hexahedra_vtu_data(
        shape,
        cell_size,
        origin,
        active_mask=active_mask,
        axis_order=axis_order,
    )
    arrow_pts, arrow_cids = sample_grid_arrow_sites(
        shape,
        cell_size,
        origin,
        active_mask=active_mask,
        max_arrows=max_arrows,
        axis_order=axis_order,
    )
    return shell, vh.points_m, vh.connectivity, arrow_pts, arrow_cids, vh.cell_indices, total_cells, cell_size


def export_grid_3d(
    output_path: str | Path,
    values: Any,
    *,
    grid_shape: Sequence[int] | None = None,
    cell_size_m: Sequence[float] | None = None,
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    active_mask: Any | None = None,
    layers: Sequence[Mapping[str, Any]] | None = None,
    axis_order: str = "zyx",
    times_s: Sequence[float] | None = None,
    format: str = "auto",
    quantity_id: str = "m",
    field_units: str | None = None,
    color_mode: str | None = None,
    color_palette: str = "viridis",
    scalar_range: tuple[float, float] | None = None,
    material_mode: str = "unlit",
    opacity: float = 1.0,
    coordinate_scale: str | None = None,
    include_surface: bool = True,
    include_wireframe: bool = False,
    include_arrows: bool = False,
    max_arrows: int = 256,
    arrow_length_m: float | None = None,
    arrow_scale_by_magnitude: bool = False,
    arrow_anchor: str = "center",
    arrow_color_mode: str | None = None,
    playback_duration_s: float | None = None,
    fps: float | None = None,
    vtk_encoding: str = "binary",
    metadata: Mapping[str, Any] | None = None,
) -> Export3DResult:
    """Export an FDM regular grid (or multilayer grid) field to GLB, glTF, VTU, or PVD."""
    target = Path(output_path)
    fmt = _infer_export_format(target, format)
    scale_mode = _resolve_coordinate_scale(fmt, coordinate_scale)

    if grid_shape is None and active_mask is not None and hasattr(active_mask, "shape") and hasattr(active_mask, "cell_size"):
        nz, ny, nx = active_mask.shape
        grid_shape = (nx, ny, nz)
        if cell_size_m is None:
            cell_size_m = active_mask.cell_size
        if origin_m == (0.0, 0.0, 0.0) and hasattr(active_mask, "origin"):
            origin_m = active_mask.origin

    (
        shell,
        hex_pts,
        hex_conn,
        arrow_pts,
        arrow_cids,
        hex_cids,
        total_cells,
        ref_cell_size,
    ) = _build_grid_geometry(
        grid_shape=grid_shape,
        cell_size_m=cell_size_m,
        origin_m=origin_m,
        active_mask=active_mask,
        layers=layers,
        axis_order=axis_order,
        max_arrows=max_arrows if include_arrows else 0,
    )

    grid_tuple = tuple(int(v) for v in grid_shape) if (layers is None and grid_shape is not None) else None
    frames, is_vector = _normalize_grid_field_frames(values, total_cells, grid_shape=grid_tuple)
    if include_arrows and not is_vector:
        raise ValueError("3D vector arrows require a 3-component vector field")

    t_count = frames.shape[0]
    resolved_times = _resolve_times_s(times_s, t_count)
    resolved_color_mode = normalize_color_mode(
        color_mode,
        fallback="orientation" if is_vector else "scalar",
    )
    if not is_vector and resolved_color_mode == "orientation":
        resolved_color_mode = "scalar"
    palette_id = normalize_palette_name(color_palette)
    resolved_range = _compute_global_scalar_range(frames, is_vector, resolved_color_mode, scalar_range)

    if fmt == "vtu":
        frame_vals = frames[0, hex_cids]
        cell_data = _vtu_data_for_field(
            frame_vals,
            is_vector=is_vector,
            quantity_id=quantity_id,
            color_mode=resolved_color_mode,
            color_palette=palette_id,
            scalar_range=resolved_range,
        )
        field_meta: dict[str, Any] = {"time_s": resolved_times[0], "quantity_id": quantity_id}
        if field_units:
            field_meta["field_units"] = field_units
        written_path = export_vtu(
            target,
            points_m=hex_pts,
            cells=hex_conn,
            cell_types="hex8",
            cell_data=cell_data,
            field_data=field_meta,
            coordinate_scale=scale_mode,
            encoding=vtk_encoding,
        )
        c_scale, origin_off, _ = resolve_coordinate_transform([hex_pts], scale_mode)
        return Export3DResult(
            output_path=written_path,
            format=fmt,
            frame_count=1,
            vertex_count=int(hex_pts.shape[0]),
            cell_count=int(hex_conn.shape[0]),
            arrow_count=0,
            coordinate_scale=scale_mode,
            si_meters_per_unit=1.0 / c_scale,
            origin_offset_m=origin_off,
            scalar_range=resolved_range,
            files_written=(written_path,),
        )

    if fmt in {"pvd", "vtu_zip"}:
        pvd_frames: list[dict[str, Any]] = []
        for idx in range(t_count):
            frame_vals = frames[idx, hex_cids]
            c_data = _vtu_data_for_field(
                frame_vals,
                is_vector=is_vector,
                quantity_id=quantity_id,
                color_mode=resolved_color_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
            )
            pvd_frames.append(
                {
                    "timestep": resolved_times[idx],
                    "points_m": hex_pts,
                    "cells": hex_conn,
                    "cell_types": "hex8",
                    "cell_data": c_data,
                    "field_data": {"time_s": resolved_times[idx], "quantity_id": quantity_id},
                }
            )
        written_path, files_written = write_pvd_bundle(
            target,
            pvd_frames,
            coordinate_scale=scale_mode,
            encoding=vtk_encoding,
            zip_archive=(fmt == "vtu_zip"),
        )
        c_scale, origin_off, _ = resolve_coordinate_transform([hex_pts], scale_mode)
        return Export3DResult(
            output_path=written_path,
            format=fmt,
            frame_count=t_count,
            vertex_count=int(hex_pts.shape[0]),
            cell_count=int(hex_conn.shape[0]),
            arrow_count=0,
            coordinate_scale=scale_mode,
            si_meters_per_unit=1.0 / c_scale,
            origin_offset_m=origin_off,
            scalar_range=resolved_range,
            files_written=files_written,
        )

    # glTF / GLB export
    surface_frame_cols: list[NDArray[np.float64]] | None = None
    if include_surface:
        surface_frame_cols = []
        for idx in range(t_count):
            v_vals = frames[idx, shell.cell_indices]
            if not is_vector:
                v_vals = v_vals[:, 0]
            cols, _ = evaluate_field_colors(
                v_vals,
                color_mode=resolved_color_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
                color_space="linear",
            )
            surface_frame_cols.append(cols)

    arrow_frames: NDArray[np.float64] | None = None
    arrow_ref_cols: NDArray[np.float64] | None = None
    arrow_max_mag: float | None = None
    eff_arrow_len = (
        float(arrow_length_m)
        if arrow_length_m is not None
        else 1.4 * max(ref_cell_size)
    )
    if include_arrows and arrow_pts.shape[0] > 0:
        arrow_frames = frames[:, arrow_cids, :]
        norms = np.linalg.norm(arrow_frames, axis=2)
        arrow_max_mag = float(np.max(norms)) if norms.size else 1.0
        peak_idx = np.argmax(norms, axis=0)
        ref_vecs = arrow_frames[peak_idx, np.arange(arrow_cids.shape[0]), :]
        a_mode = normalize_color_mode(arrow_color_mode, fallback=resolved_color_mode)
        arrow_ref_cols, _ = evaluate_field_colors(
            ref_vecs,
            color_mode=a_mode,
            color_palette=palette_id,
            scalar_range=resolved_range,
            color_space="linear",
        )

    timeline_s = _resolve_gltf_timeline(resolved_times, duration_s=playback_duration_s, fps=fps)
    extras: dict[str, Any] = {
        "domain_kind": "fdm_multilayer" if layers is not None else "fdm",
        "quantity_id": quantity_id,
        "field_units": field_units,
        "color_mode": resolved_color_mode,
        "color_palette": palette_id,
        "scalar_range": [resolved_range[0], resolved_range[1]],
        "animation_kind": "playback_frames" if t_count > 1 else "static",
        "frame_times_s": resolved_times,
    }
    if metadata:
        extras.update(metadata)

    doc, bin_bytes, origin_off, si_per_unit = _build_gltf_surface_and_arrows(
        surface_positions_m=shell.positions if include_surface else None,
        surface_normals=shell.normals if include_surface else None,
        surface_indices=shell.indices if include_surface else None,
        surface_edge_indices=shell.edge_indices if (include_surface and include_wireframe) else None,
        surface_frame_colors_linear=surface_frame_cols,
        arrow_sites_m=arrow_pts if include_arrows else None,
        arrow_vector_frames=arrow_frames,
        arrow_colors_linear_ref=arrow_ref_cols,
        arrow_length_m=eff_arrow_len,
        arrow_scale_by_magnitude=arrow_scale_by_magnitude,
        arrow_max_magnitude=arrow_max_mag,
        arrow_anchor=arrow_anchor,
        timeline_s=timeline_s,
        phase_cycle=False,
        material_mode=material_mode,
        opacity=opacity,
        coordinate_scale=scale_mode,
        fullmag_extras=extras,
    )
    written_path = _write_gltf_or_glb(target, fmt, doc, bin_bytes)
    return Export3DResult(
        output_path=written_path,
        format=fmt,
        frame_count=t_count,
        vertex_count=int(shell.positions.shape[0]) if include_surface else 0,
        cell_count=int(hex_conn.shape[0]),
        arrow_count=int(arrow_pts.shape[0]) if include_arrows else 0,
        coordinate_scale=scale_mode,
        si_meters_per_unit=si_per_unit,
        origin_offset_m=origin_off,
        scalar_range=resolved_range,
        files_written=(written_path,),
        metadata=extras,
    )


@dataclass(slots=True)
class _ParsedFemTopology:
    nodes_m: NDArray[np.float64]
    active_node_mask: NDArray[np.bool_]
    volume_cells: list[tuple[str, tuple[int, ...], int]]  # (type_name, node_tuple, orig_cell_idx)
    surface_triangles: NDArray[np.uint32]  # (T_surf, 3) referencing nodes_m
    surface_cell_owners: NDArray[np.int64]  # (T_surf,) original cell index or -1
    surface_edges: NDArray[np.uint32]


def _extract_fem_topology(
    *,
    mesh: Any = None,
    nodes: ArrayLike | None = None,
    triangles: ArrayLike | None = None,
    cells: Any = None,
    cell_types: ArrayLike | str | None = None,
    active_node_mask: ArrayLike | None = None,
    active_cell_mask: ArrayLike | None = None,
) -> _ParsedFemTopology:
    """Normalize ``MeshData``, ``MeshIR``/``SavedFemP1FieldGeometry`` dicts, or raw arrays."""
    raw_nodes: NDArray[np.float64]
    parsed_cells: list[tuple[str, tuple[int, ...]]] = []
    parsed_facets: list[tuple[str, tuple[int, ...]]] = []
    inferred_node_mask: NDArray[np.bool_] | None = None

    if mesh is not None:
        if isinstance(mesh, Mapping):
            # Support SavedFemP1FieldGeometry wrapper or bare MeshIR dict
            if "mesh" in mesh and isinstance(mesh["mesh"], Mapping):
                mesh_obj = mesh["mesh"]
                semantics = mesh.get("field_semantics")
                if isinstance(semantics, Mapping) and "active_node_mask" in semantics:
                    inferred_node_mask = np.asarray(semantics["active_node_mask"], dtype=bool)
            else:
                mesh_obj = mesh
            raw_nodes = np.asarray(mesh_obj["nodes"], dtype=np.float64)
            if "cells" in mesh_obj and isinstance(mesh_obj["cells"], Mapping):
                c_obj = mesh_obj["cells"]
                c_types = c_obj["types"]
                c_offs = c_obj["offsets"]
                c_nodes = c_obj["nodes"]
                for i, ctype in enumerate(c_types):
                    parsed_cells.append(
                        (str(ctype).lower(), tuple(int(v) for v in c_nodes[int(c_offs[i]) : int(c_offs[i + 1])]))
                    )
            elif "elements" in mesh_obj:
                for elem in mesh_obj["elements"]:
                    parsed_cells.append(("tet4", tuple(int(v) for v in elem)))
            if "facets" in mesh_obj and isinstance(mesh_obj["facets"], Mapping):
                f_obj = mesh_obj["facets"]
                f_types = f_obj["types"]
                f_offs = f_obj["offsets"]
                f_nodes = f_obj["nodes"]
                f_roles = f_obj.get("roles", ["exterior"] * len(f_types))
                for i, ftype in enumerate(f_types):
                    role = str(f_roles[i]).lower() if i < len(f_roles) else "exterior"
                    if role in {"exterior", "material_interface"}:
                        parsed_facets.append(
                            (str(ftype).lower(), tuple(int(v) for v in f_nodes[int(f_offs[i]) : int(f_offs[i + 1])]))
                        )
            elif "boundary_faces" in mesh_obj:
                for face in mesh_obj["boundary_faces"]:
                    parsed_facets.append(("tri3", tuple(int(v) for v in face)))
        elif hasattr(mesh, "nodes") and hasattr(mesh, "cell_types") and hasattr(mesh, "cell_offsets"):
            raw_nodes = np.asarray(mesh.nodes, dtype=np.float64)
            c_types = mesh.cell_types
            c_offs = mesh.cell_offsets
            c_nodes = mesh.cell_nodes
            for i in range(len(c_types)):
                parsed_cells.append(
                    (str(c_types[i]).lower(), tuple(int(v) for v in c_nodes[int(c_offs[i]) : int(c_offs[i + 1])]))
                )
            if hasattr(mesh, "facet_types") and hasattr(mesh, "facet_offsets"):
                f_types = mesh.facet_types
                f_offs = mesh.facet_offsets
                f_nodes = mesh.facet_nodes
                f_roles = getattr(mesh, "facet_roles", None)
                for i in range(len(f_types)):
                    role = str(f_roles[i]).lower() if f_roles is not None and i < len(f_roles) else "exterior"
                    if role in {"exterior", "material_interface"}:
                        parsed_facets.append(
                            (str(f_types[i]).lower(), tuple(int(v) for v in f_nodes[int(f_offs[i]) : int(f_offs[i + 1])]))
                        )
        else:
            raise TypeError("mesh must be a Fullmag MeshData, MeshIR/geometry dict, or None")
    else:
        if nodes is None:
            raise ValueError("either mesh or nodes must be provided")
        raw_nodes = np.asarray(nodes, dtype=np.float64)

    if raw_nodes.ndim != 2 or raw_nodes.shape[1] != 3:
        raise ValueError(f"nodes must have shape (N, 3), got {raw_nodes.shape}")
    n_nodes = raw_nodes.shape[0]

    if triangles is not None:
        tri_arr = np.asarray(triangles, dtype=np.int64)
        if tri_arr.ndim != 2 or tri_arr.shape[1] != 3:
            raise ValueError(f"triangles must have shape (T, 3), got {tri_arr.shape}")
        for row in tri_arr.tolist():
            parsed_facets.append(("tri3", (int(row[0]), int(row[1]), int(row[2]))))

    if cells is not None:
        if isinstance(cells, tuple) and len(cells) == 2:
            conn, offs = np.asarray(cells[0], dtype=np.int64), np.asarray(cells[1], dtype=np.int64)
            c_count = offs.size - 1 if (offs.size > 1 and offs[0] == 0) else offs.size
            if cell_types is None:
                raise ValueError("cell_types is required when cells are passed in CSR format")
            if isinstance(cell_types, str):
                t_list = [cell_types.lower()] * c_count
            else:
                t_list = [
                    _VTK_TO_CELL_NAME.get(int(t), str(t).lower()) if isinstance(t, (int, np.integer)) else str(t).lower()
                    for t in np.asarray(cell_types).tolist()
                ]
            start = 0
            for i in range(c_count):
                end = int(offs[i + 1] if (offs.size > 1 and offs[0] == 0) else offs[i])
                if offs.size > 1 and offs[0] == 0:
                    start = int(offs[i])
                parsed_cells.append((t_list[i], tuple(int(v) for v in conn[start:end])))
                start = end
        else:
            c_arr = np.asarray(cells, dtype=np.int64)
            if c_arr.ndim != 2:
                raise ValueError(f"cells must be 2D, got shape {c_arr.shape}")
            default_type = {4: "tet4", 5: "pyramid5", 6: "prism6", 8: "hex8", 3: "tri3"}.get(
                c_arr.shape[1]
            )
            if cell_types is None:
                if default_type is None:
                    raise ValueError(f"cannot infer cell_types for arity {c_arr.shape[1]}")
                t_name = default_type
            elif isinstance(cell_types, (int, np.integer)):
                t_name = _VTK_TO_CELL_NAME.get(int(cell_types), "tri3" if int(cell_types) == 5 else "")
            else:
                t_name = str(cell_types).lower()
            if t_name == "tri3":
                for row in c_arr.tolist():
                    parsed_facets.append(("tri3", tuple(int(v) for v in row)))
            else:
                for row in c_arr.tolist():
                    parsed_cells.append((t_name, tuple(int(v) for v in row)))

    if active_node_mask is not None:
        node_mask = np.asarray(active_node_mask, dtype=bool).ravel()
        if node_mask.size != n_nodes:
            raise ValueError(
                f"active_node_mask length {node_mask.size} does not match node count {n_nodes}"
            )
    elif inferred_node_mask is not None:
        node_mask = inferred_node_mask.astype(bool).ravel()
    else:
        node_mask = np.ones((n_nodes,), dtype=bool)

    active_vol_cells: list[tuple[str, tuple[int, ...], int]] = []
    if parsed_cells:
        if active_cell_mask is not None:
            cmask = np.asarray(active_cell_mask, dtype=bool).ravel()
            if cmask.size != len(parsed_cells):
                raise ValueError("active_cell_mask length does not match cell count")
            for idx, (ctype, cnodes) in enumerate(parsed_cells):
                if bool(cmask[idx]):
                    active_vol_cells.append((ctype, cnodes, idx))
        else:
            for idx, (ctype, cnodes) in enumerate(parsed_cells):
                if all(0 <= n < n_nodes and bool(node_mask[n]) for n in cnodes):
                    active_vol_cells.append((ctype, cnodes, idx))

    tri_list: list[tuple[int, int, int]] = []
    tri_owners: list[int] = []

    if active_vol_cells:
        face_counts: dict[tuple[int, ...], int] = {}
        face_first: dict[tuple[int, ...], tuple[tuple[int, ...], int, tuple[int, ...]]] = {}
        for ctype, cnodes, orig_idx in active_vol_cells:
            local_faces = _FEM_CELL_FACES.get(ctype)
            if local_faces is None:
                raise ValueError(f"unsupported FEM volume cell type '{ctype}'")
            for f_idx_tuple in local_faces:
                f_nodes = tuple(cnodes[k] for k in f_idx_tuple)
                key = tuple(sorted(f_nodes))
                face_counts[key] = face_counts.get(key, 0) + 1
                if key not in face_first:
                    face_first[key] = (f_nodes, orig_idx, cnodes)

        for key, count in face_counts.items():
            if count != 1:
                continue
            f_nodes, orig_idx, cnodes = face_first[key]
            cell_centroid = np.mean(raw_nodes[list(cnodes)], axis=0)
            face_center = np.mean(raw_nodes[list(f_nodes)], axis=0)
            p0, p1, p2 = raw_nodes[f_nodes[0]], raw_nodes[f_nodes[1]], raw_nodes[f_nodes[2]]
            face_normal = np.cross(p1 - p0, p2 - p0)
            if float(np.dot(face_normal, face_center - cell_centroid)) < 0.0:
                f_nodes = tuple(reversed(f_nodes))
            if len(f_nodes) == 3:
                tri_list.append((f_nodes[0], f_nodes[1], f_nodes[2]))
                tri_owners.append(orig_idx)
            elif len(f_nodes) == 4:
                tri_list.append((f_nodes[0], f_nodes[1], f_nodes[2]))
                tri_owners.append(orig_idx)
                tri_list.append((f_nodes[0], f_nodes[2], f_nodes[3]))
                tri_owners.append(orig_idx)
    elif parsed_facets:
        for ftype, fnodes in parsed_facets:
            if not all(0 <= n < n_nodes and bool(node_mask[n]) for n in fnodes):
                continue
            if ftype == "tri3" or len(fnodes) == 3:
                tri_list.append((fnodes[0], fnodes[1], fnodes[2]))
                tri_owners.append(-1)
            elif ftype == "quad4" or len(fnodes) == 4:
                tri_list.append((fnodes[0], fnodes[1], fnodes[2]))
                tri_owners.append(-1)
                tri_list.append((fnodes[0], fnodes[2], fnodes[3]))
                tri_owners.append(-1)
    else:
        raise ValueError("FEM topology has neither active volume cells nor surface triangles")

    if not tri_list:
        raise ValueError("FEM topology has zero active surface triangles")

    surf_tris = np.asarray(tri_list, dtype=np.uint32)
    owners_arr = np.asarray(tri_owners, dtype=np.int64)
    edges_raw = np.concatenate(
        (
            surf_tris[:, [0, 1]],
            surf_tris[:, [1, 2]],
            surf_tris[:, [2, 0]],
        ),
        axis=0,
    )
    surf_edges = np.unique(np.sort(edges_raw, axis=1), axis=0).astype(np.uint32)

    return _ParsedFemTopology(
        nodes_m=raw_nodes,
        active_node_mask=node_mask,
        volume_cells=active_vol_cells,
        surface_triangles=surf_tris,
        surface_cell_owners=owners_arr,
        surface_edges=surf_edges,
    )


def _compact_fem_surface(
    topo: _ParsedFemTopology,
) -> tuple[NDArray[np.float64], NDArray[np.uint32], NDArray[np.uint32], NDArray[np.int64]]:
    """Compact surface vertices so inactive airbox nodes do not pollute coordinates or AABB."""
    used_nodes, inverse = np.unique(topo.surface_triangles.ravel(), return_inverse=True)
    comp_pos = topo.nodes_m[used_nodes]
    comp_tris = inverse.reshape(-1, 3).astype(np.uint32)
    edge_lookup = np.empty((topo.nodes_m.shape[0],), dtype=np.uint32)
    edge_lookup[used_nodes] = np.arange(used_nodes.shape[0], dtype=np.uint32)
    comp_edges = edge_lookup[topo.surface_edges]
    return comp_pos, comp_tris, comp_edges, used_nodes.astype(np.int64)


def _compact_fem_volume(
    topo: _ParsedFemTopology,
) -> tuple[NDArray[np.float64], tuple[NDArray[np.int64], NDArray[np.int64]], NDArray[np.uint8], NDArray[np.int64], NDArray[np.int64]]:
    """Compact active FEM volume cells (or surface triangles if no volume cells) for VTU."""
    from .vtk_writer import VTK_CELL_TYPE_CODES

    if topo.volume_cells:
        all_node_ids: list[int] = []
        offsets: list[int] = [0]
        ctypes: list[int] = []
        orig_cell_ids: list[int] = []
        for ctype, cnodes, orig_idx in topo.volume_cells:
            all_node_ids.extend(cnodes)
            offsets.append(len(all_node_ids))
            ctypes.append(VTK_CELL_TYPE_CODES[ctype])
            orig_cell_ids.append(orig_idx)
        conn_raw = np.asarray(all_node_ids, dtype=np.int64)
        used_nodes, inverse = np.unique(conn_raw, return_inverse=True)
        return (
            topo.nodes_m[used_nodes],
            (inverse.astype(np.int64), np.asarray(offsets, dtype=np.int64)),
            np.asarray(ctypes, dtype=np.uint8),
            used_nodes.astype(np.int64),
            np.asarray(orig_cell_ids, dtype=np.int64),
        )

    comp_pos, comp_tris, _, used_nodes = _compact_fem_surface(topo)
    c_count = comp_tris.shape[0]
    offs = np.arange(0, c_count + 1, dtype=np.int64) * 3
    return (
        comp_pos,
        (comp_tris.ravel().astype(np.int64), offs),
        np.full((c_count,), 5, dtype=np.uint8),
        used_nodes,
        np.arange(c_count, dtype=np.int64),
    )


def _compute_surface_normals(
    positions: NDArray[np.float64],
    triangles: NDArray[np.uint32],
    *,
    flat: bool = False,
) -> NDArray[np.float64]:
    v0 = positions[triangles[:, 0]]
    v1 = positions[triangles[:, 1]]
    v2 = positions[triangles[:, 2]]
    face_norms = np.cross(v1 - v0, v2 - v0)
    lens = np.linalg.norm(face_norms, axis=1)
    valid = lens > 1e-30
    unit_face = np.zeros_like(face_norms)
    unit_face[valid] = face_norms[valid] / lens[valid, np.newaxis]
    unit_face[~valid] = (0.0, 0.0, 1.0)
    if flat:
        return np.repeat(unit_face, 3, axis=0)

    vert_norms = np.zeros_like(positions)
    np.add.at(vert_norms, triangles[:, 0], face_norms)
    np.add.at(vert_norms, triangles[:, 1], face_norms)
    np.add.at(vert_norms, triangles[:, 2], face_norms)
    vlens = np.linalg.norm(vert_norms, axis=1)
    vvalid = vlens > 1e-30
    vert_norms[vvalid] /= vlens[vvalid, np.newaxis]
    vert_norms[~vvalid] = (0.0, 0.0, 1.0)
    return vert_norms


def _sample_fem_arrow_sites(
    topo: _ParsedFemTopology,
    comp_pos: NDArray[np.float64],
    used_nodes: NDArray[np.int64],
    location: str,
    max_arrows: int,
) -> tuple[NDArray[np.float64], NDArray[np.int64]]:
    budget = max(0, int(max_arrows))
    if budget == 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0,), dtype=np.int64)
    if location == "node":
        count = comp_pos.shape[0]
        if count <= budget:
            return comp_pos, used_nodes
        idx = np.unique(np.floor(np.linspace(0, count - 1, budget)).astype(np.int64))
        return comp_pos[idx], used_nodes[idx]

    # Cell centroids
    if topo.volume_cells:
        centroids = np.asarray(
            [np.mean(topo.nodes_m[list(cnodes)], axis=0) for _, cnodes, _ in topo.volume_cells],
            dtype=np.float64,
        )
        orig_ids = np.asarray(
            [orig_idx for _, _, orig_idx in topo.volume_cells],
            dtype=np.int64,
        )
    else:
        centroids = np.mean(topo.nodes_m[topo.surface_triangles], axis=1)
        orig_ids = np.arange(topo.surface_triangles.shape[0], dtype=np.int64)
    count = centroids.shape[0]
    if count <= budget:
        return centroids, orig_ids
    idx = np.unique(np.floor(np.linspace(0, count - 1, budget)).astype(np.int64))
    return centroids[idx], orig_ids[idx]


def export_mesh_3d(
    output_path: str | Path,
    values: Any,
    *,
    mesh: Any = None,
    nodes: ArrayLike | None = None,
    triangles: ArrayLike | None = None,
    cells: Any = None,
    cell_types: ArrayLike | str | None = None,
    active_node_mask: ArrayLike | None = None,
    active_cell_mask: ArrayLike | None = None,
    times_s: Sequence[float] | None = None,
    format: str = "auto",
    quantity_id: str = "m",
    field_units: str | None = None,
    color_mode: str | None = None,
    color_palette: str = "viridis",
    scalar_range: tuple[float, float] | None = None,
    material_mode: str = "unlit",
    opacity: float = 1.0,
    coordinate_scale: str | None = None,
    include_surface: bool = True,
    include_wireframe: bool = False,
    include_arrows: bool = False,
    max_arrows: int = 256,
    arrow_length_m: float | None = None,
    arrow_scale_by_magnitude: bool = False,
    arrow_anchor: str = "center",
    arrow_color_mode: str | None = None,
    playback_duration_s: float | None = None,
    fps: float | None = None,
    vtk_encoding: str = "binary",
    metadata: Mapping[str, Any] | None = None,
) -> Export3DResult:
    """Export a FEM mesh field (nodal or cell-centered, static or time-series) to 3D."""
    target = Path(output_path)
    fmt = _infer_export_format(target, format)
    scale_mode = _resolve_coordinate_scale(fmt, coordinate_scale)

    topo = _extract_fem_topology(
        mesh=mesh,
        nodes=nodes,
        triangles=triangles,
        cells=cells,
        cell_types=cell_types,
        active_node_mask=active_node_mask,
        active_cell_mask=active_cell_mask,
    )
    total_cells = (
        max((orig for _, _, orig in topo.volume_cells), default=-1) + 1
        if topo.volume_cells
        else topo.surface_triangles.shape[0]
    )
    active_cell_count = len(topo.volume_cells) if topo.volume_cells else topo.surface_triangles.shape[0]
    frames, is_vector, loc = _normalize_mesh_field_frames(
        values,
        topo.nodes_m.shape[0],
        total_cells,
        active_cell_count=active_cell_count,
    )
    if include_arrows and not is_vector:
        raise ValueError("3D vector arrows require a 3-component vector field")

    t_count = frames.shape[0]
    resolved_times = _resolve_times_s(times_s, t_count)
    resolved_color_mode = normalize_color_mode(
        color_mode,
        fallback="orientation" if is_vector else "scalar",
    )
    if not is_vector and resolved_color_mode == "orientation":
        resolved_color_mode = "scalar"
    palette_id = normalize_palette_name(color_palette)

    comp_pos, comp_tris, comp_edges, used_surf_nodes = _compact_fem_surface(topo)
    vtu_pts, vtu_cells, vtu_ctypes, vtu_used_nodes, vtu_cell_ids = _compact_fem_volume(topo)

    # Compute scalar range only over active magnetic support
    if loc == "node":
        active_eval = frames[:, used_surf_nodes, :]
    elif loc == "active_cell":
        active_eval = frames
    else:
        active_eval = frames[:, vtu_cell_ids, :] if topo.volume_cells else frames
    resolved_range = _compute_global_scalar_range(
        active_eval,
        is_vector,
        resolved_color_mode,
        scalar_range,
    )

    if fmt in {"vtu", "pvd", "vtu_zip"}:
        active_cell_map = {orig: i for i, (_, _, orig) in enumerate(topo.volume_cells)}
        vtu_entries: list[dict[str, Any]] = []
        for idx in range(t_count):
            if loc == "node":
                vals = frames[idx, vtu_used_nodes, :]
                p_data = _vtu_data_for_field(
                    vals,
                    is_vector=is_vector,
                    quantity_id=quantity_id,
                    color_mode=resolved_color_mode,
                    color_palette=palette_id,
                    scalar_range=resolved_range,
                )
                c_data = None
            else:
                if loc == "active_cell":
                    vals = np.asarray(
                        [frames[idx, active_cell_map[cid], :] for cid in vtu_cell_ids],
                        dtype=np.float64,
                    )
                else:
                    vals = frames[idx, vtu_cell_ids, :]
                p_data = None
                c_data = _vtu_data_for_field(
                    vals,
                    is_vector=is_vector,
                    quantity_id=quantity_id,
                    color_mode=resolved_color_mode,
                    color_palette=palette_id,
                    scalar_range=resolved_range,
                )
            vtu_entries.append(
                {
                    "timestep": resolved_times[idx],
                    "points_m": vtu_pts,
                    "cells": vtu_cells,
                    "cell_types": vtu_ctypes,
                    "point_data": p_data,
                    "cell_data": c_data,
                    "field_data": {"time_s": resolved_times[idx], "quantity_id": quantity_id},
                }
            )

        if fmt == "vtu":
            written_path = export_vtu(
                target,
                points_m=vtu_pts,
                cells=vtu_cells,
                cell_types=vtu_ctypes,
                point_data=vtu_entries[0]["point_data"],
                cell_data=vtu_entries[0]["cell_data"],
                field_data=vtu_entries[0]["field_data"],
                coordinate_scale=scale_mode,
                encoding=vtk_encoding,
            )
            files_written = (written_path,)
            exported_frames = 1
        else:
            written_path, files_written = write_pvd_bundle(
                target,
                vtu_entries,
                coordinate_scale=scale_mode,
                encoding=vtk_encoding,
                zip_archive=(fmt == "vtu_zip"),
            )
            exported_frames = t_count

        c_scale, origin_off, _ = resolve_coordinate_transform([vtu_pts], scale_mode)
        return Export3DResult(
            output_path=written_path,
            format=fmt,
            frame_count=exported_frames,
            vertex_count=int(vtu_pts.shape[0]),
            cell_count=int(vtu_ctypes.shape[0]),
            arrow_count=0,
            coordinate_scale=scale_mode,
            si_meters_per_unit=1.0 / c_scale,
            origin_offset_m=origin_off,
            scalar_range=resolved_range,
            files_written=files_written,
        )

    # glTF / GLB surface geometry
    if loc == "node":
        surf_pos = comp_pos
        surf_tris = comp_tris
        surf_norms = _compute_surface_normals(surf_pos, surf_tris, flat=False)
        surf_edges = comp_edges
        surf_frame_cols: list[NDArray[np.float64]] = []
        for idx in range(t_count):
            vals = frames[idx, used_surf_nodes, :]
            if not is_vector:
                vals = vals[:, 0]
            cols, _ = evaluate_field_colors(
                vals,
                color_mode=resolved_color_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
                color_space="linear",
            )
            surf_frame_cols.append(cols)
    else:
        # Cell-valued field: expand triangles so each face keeps flat cell color
        surf_pos = comp_pos[comp_tris.ravel()]
        surf_tris = np.arange(surf_pos.shape[0], dtype=np.uint32).reshape(-1, 3)
        surf_norms = _compute_surface_normals(surf_pos, surf_tris, flat=True)
        surf_edges = np.concatenate(
            (surf_tris[:, [0, 1]], surf_tris[:, [1, 2]], surf_tris[:, [2, 0]]),
            axis=0,
        )
        active_cell_map = {orig: i for i, (_, _, orig) in enumerate(topo.volume_cells)}
        if loc == "active_cell":
            tri_cell_indices = np.asarray(
                [active_cell_map[int(cid)] for cid in topo.surface_cell_owners],
                dtype=np.int64,
            )
        else:
            tri_cell_indices = (
                topo.surface_cell_owners
                if topo.volume_cells
                else np.arange(comp_tris.shape[0], dtype=np.int64)
            )
        vert_cell_indices = np.repeat(tri_cell_indices, 3)
        surf_frame_cols = []
        for idx in range(t_count):
            vals = frames[idx, vert_cell_indices, :]
            if not is_vector:
                vals = vals[:, 0]
            cols, _ = evaluate_field_colors(
                vals,
                color_mode=resolved_color_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
                color_space="linear",
            )
            surf_frame_cols.append(cols)

    extent = float(np.max(np.max(comp_pos, axis=0) - np.min(comp_pos, axis=0))) if comp_pos.size else 1.0
    eff_arrow_len = float(arrow_length_m) if arrow_length_m is not None else max(extent * 0.06, 1e-12)

    arrow_pts = np.zeros((0, 3), dtype=np.float64)
    arrow_frames: NDArray[np.float64] | None = None
    arrow_ref_cols: NDArray[np.float64] | None = None
    arrow_max_mag: float | None = None
    if include_arrows:
        arrow_pts, arrow_ids = _sample_fem_arrow_sites(
            topo,
            comp_pos,
            used_surf_nodes,
            "node" if loc == "node" else "cell",
            max_arrows,
        )
        if arrow_pts.shape[0] > 0:
            if loc == "active_cell":
                active_cell_map = {orig: i for i, (_, _, orig) in enumerate(topo.volume_cells)}
                arrow_ids = np.asarray([active_cell_map[int(cid)] for cid in arrow_ids], dtype=np.int64)
            arrow_frames = frames[:, arrow_ids, :]
            norms = np.linalg.norm(arrow_frames, axis=2)
            arrow_max_mag = float(np.max(norms)) if norms.size else 1.0
            peak_idx = np.argmax(norms, axis=0)
            ref_vecs = arrow_frames[peak_idx, np.arange(arrow_ids.shape[0]), :]
            a_mode = normalize_color_mode(arrow_color_mode, fallback=resolved_color_mode)
            arrow_ref_cols, _ = evaluate_field_colors(
                ref_vecs,
                color_mode=a_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
                color_space="linear",
            )

    timeline_s = _resolve_gltf_timeline(resolved_times, duration_s=playback_duration_s, fps=fps)
    extras: dict[str, Any] = {
        "domain_kind": "fem",
        "quantity_id": quantity_id,
        "field_units": field_units,
        "field_location": loc,
        "color_mode": resolved_color_mode,
        "color_palette": palette_id,
        "scalar_range": [resolved_range[0], resolved_range[1]],
        "animation_kind": "playback_frames" if t_count > 1 else "static",
        "frame_times_s": resolved_times,
    }
    if metadata:
        extras.update(metadata)

    doc, bin_bytes, origin_off, si_per_unit = _build_gltf_surface_and_arrows(
        surface_positions_m=surf_pos if include_surface else None,
        surface_normals=surf_norms if include_surface else None,
        surface_indices=surf_tris if include_surface else None,
        surface_edge_indices=surf_edges if (include_surface and include_wireframe) else None,
        surface_frame_colors_linear=surf_frame_cols if include_surface else None,
        arrow_sites_m=arrow_pts if include_arrows else None,
        arrow_vector_frames=arrow_frames,
        arrow_colors_linear_ref=arrow_ref_cols,
        arrow_length_m=eff_arrow_len,
        arrow_scale_by_magnitude=arrow_scale_by_magnitude,
        arrow_max_magnitude=arrow_max_mag,
        arrow_anchor=arrow_anchor,
        timeline_s=timeline_s,
        phase_cycle=False,
        material_mode=material_mode,
        opacity=opacity,
        coordinate_scale=scale_mode,
        fullmag_extras=extras,
    )
    written_path = _write_gltf_or_glb(target, fmt, doc, bin_bytes)
    return Export3DResult(
        output_path=written_path,
        format=fmt,
        frame_count=t_count,
        vertex_count=int(surf_pos.shape[0]) if include_surface else 0,
        cell_count=int(vtu_ctypes.shape[0]),
        arrow_count=int(arrow_pts.shape[0]) if include_arrows else 0,
        coordinate_scale=scale_mode,
        si_meters_per_unit=si_per_unit,
        origin_offset_m=origin_off,
        scalar_range=resolved_range,
        files_written=(written_path,),
        metadata=extras,
    )


def export_mode_animation_3d(
    output_path: str | Path,
    *,
    real: Any = None,
    imag: Any = None,
    complex_values: Any = None,
    # FDM grid options
    grid_shape: Sequence[int] | None = None,
    cell_size_m: Sequence[float] | None = None,
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    active_mask: Any | None = None,
    layers: Sequence[Mapping[str, Any]] | None = None,
    axis_order: str = "zyx",
    # FEM mesh options
    mesh: Any = None,
    nodes: ArrayLike | None = None,
    triangles: ArrayLike | None = None,
    cells: Any = None,
    cell_types: ArrayLike | str | None = None,
    active_node_mask: ArrayLike | None = None,
    active_cell_mask: ArrayLike | None = None,
    # Harmonic / Floquet parameters
    phase_steps: int = 24,
    cycle_duration_s: float = 2.0,
    representation: str = "phase_rotated_real",
    amplitude_scale: float = 1.0,
    wavevector_kf: Sequence[float] | None = None,
    cell_origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    phasor_convention: str = "exp_i_omega_t",
    floquet_spatial_convention: str = "dst_equals_src_exp_minus_i_k_dot_delta_r",
    surface_displacement_scale: float = 0.0,
    displacement_component: str = "auto",
    frequency_hz: float | None = None,
    mode_id: str | None = None,
    # Presentation / export options
    format: str = "auto",
    quantity_id: str = "delta_m",
    color_mode: str = "orientation",
    color_palette: str = "viridis",
    scalar_range: tuple[float, float] | None = None,
    material_mode: str = "unlit",
    opacity: float = 1.0,
    coordinate_scale: str | None = None,
    include_surface: bool = True,
    include_wireframe: bool = False,
    include_arrows: bool = True,
    max_arrows: int = 128,
    arrow_length_m: float | None = None,
    arrow_scale_by_magnitude: bool = True,
    arrow_anchor: str = "center",
    arrow_color_mode: str | None = None,
    vtk_encoding: str = "binary",
    metadata: Mapping[str, Any] | None = None,
) -> Export3DResult:
    """Export a complex eigenmode or driven-response harmonic field over a ``2*pi`` phase cycle."""
    if complex_values is not None:
        c_arr = np.asarray(complex_values)
        if not np.iscomplexobj(c_arr):
            raise ValueError("complex_values must be a complex array")
        re_in: Any = np.real(c_arr)
        im_in: Any = np.imag(c_arr)
    elif real is not None and imag is not None:
        re_in = real
        im_in = imag
    else:
        raise ValueError("provide either complex_values or both real and imag arrays")

    target = Path(output_path)
    fmt = _infer_export_format(target, format)
    scale_mode = _resolve_coordinate_scale(fmt, coordinate_scale)
    steps = max(1, int(phase_steps))
    resolved_color_mode = normalize_color_mode(color_mode, fallback="orientation")
    palette_id = normalize_palette_name(
        "twilight" if (representation.strip().lower() == "phase" and color_palette == "viridis") else color_palette
    )

    is_fdm = (grid_shape is not None) or (layers is not None)
    is_fem = (mesh is not None) or (nodes is not None)
    if is_fdm == is_fem:
        raise ValueError("specify either FDM grid parameters (grid_shape/layers) or FEM mesh parameters (mesh/nodes)")

    if is_fdm:
        (
            shell,
            hex_pts,
            hex_conn,
            arrow_pts,
            arrow_cids,
            hex_cids,
            total_cells,
            ref_cell_size,
        ) = _build_grid_geometry(
            grid_shape=grid_shape,
            cell_size_m=cell_size_m,
            origin_m=origin_m,
            active_mask=active_mask,
            layers=layers,
            axis_order=axis_order,
            max_arrows=max_arrows if include_arrows else 0,
        )
        grid_tuple = tuple(int(v) for v in grid_shape) if (layers is None and grid_shape is not None) else None
        re_frames, re_vec = _normalize_grid_field_frames(re_in, total_cells, grid_shape=grid_tuple)
        im_frames, im_vec = _normalize_grid_field_frames(im_in, total_cells, grid_shape=grid_tuple)
        if re_vec != im_vec:
            raise ValueError("real and imag payloads must match in vector/scalar component count")
        is_vector = re_vec
        re_arr = re_frames[0] if is_vector else np.pad(re_frames[0], ((0, 0), (0, 2)))
        im_arr = im_frames[0] if is_vector else np.pad(im_frames[0], ((0, 0), (0, 2)))
        cell_centers_all, active_all_cids = (
            voxel_cell_centers_m(grid_shape, cell_size_m, origin_m, active_mask=active_mask, axis_order=axis_order)
            if layers is None and grid_shape is not None and cell_size_m is not None
            else (np.zeros((total_cells, 3), dtype=np.float64), np.arange(total_cells, dtype=np.int64))
        )
        site_positions_all = np.zeros((total_cells, 3), dtype=np.float64)
        site_positions_all[active_all_cids] = cell_centers_all

        surf_pos = shell.positions
        surf_norms = shell.normals
        surf_tris = shell.indices
        surf_edges = shell.edge_indices
        surf_re = re_arr[shell.cell_indices]
        surf_im = im_arr[shell.cell_indices]
        surf_eval_pos = surf_pos  # Use exact surface vertex positions (or cell center for constant cell Floquet)
        # Note: cell centers keep uniform color per voxel face even with Floquet k_F
        surf_eval_pos_cell = site_positions_all[shell.cell_indices]
        vtu_pts = hex_pts
        vtu_cells: Any = hex_conn
        vtu_ctypes: Any = "hex8"
        vtu_re = re_arr[hex_cids]
        vtu_im = im_arr[hex_cids]
        vtu_pos = site_positions_all[hex_cids]
        vtu_loc = "cell"
        arrow_re = re_arr[arrow_cids] if arrow_cids.size else np.zeros((0, 3))
        arrow_im = im_arr[arrow_cids] if arrow_cids.size else np.zeros((0, 3))
        domain_extent = float(np.max(np.max(surf_pos, axis=0) - np.min(surf_pos, axis=0)))
        eff_arrow_len = float(arrow_length_m) if arrow_length_m is not None else max(1.4 * max(ref_cell_size), domain_extent * 0.05)
    else:
        topo = _extract_fem_topology(
            mesh=mesh,
            nodes=nodes,
            triangles=triangles,
            cells=cells,
            cell_types=cell_types,
            active_node_mask=active_node_mask,
            active_cell_mask=active_cell_mask,
        )
        total_cells = (
            max((orig for _, _, orig in topo.volume_cells), default=-1) + 1
            if topo.volume_cells
            else topo.surface_triangles.shape[0]
        )
        active_cell_count = len(topo.volume_cells) if topo.volume_cells else topo.surface_triangles.shape[0]
        re_frames, re_vec, loc = _normalize_mesh_field_frames(
            re_in,
            topo.nodes_m.shape[0],
            total_cells,
            active_cell_count=active_cell_count,
        )
        im_frames, im_vec, loc_im = _normalize_mesh_field_frames(
            im_in,
            topo.nodes_m.shape[0],
            total_cells,
            active_cell_count=active_cell_count,
        )
        if re_vec != im_vec or loc != loc_im:
            raise ValueError("real and imag FEM fields must match in location and component count")
        is_vector = re_vec
        re_arr = re_frames[0] if is_vector else np.pad(re_frames[0], ((0, 0), (0, 2)))
        im_arr = im_frames[0] if is_vector else np.pad(im_frames[0], ((0, 0), (0, 2)))

        comp_pos, comp_tris, comp_edges, used_surf_nodes = _compact_fem_surface(topo)
        vtu_pts, vtu_cells, vtu_ctypes, vtu_used_nodes, vtu_cell_ids = _compact_fem_volume(topo)

        if loc == "node":
            surf_pos = comp_pos
            surf_tris = comp_tris
            surf_norms = _compute_surface_normals(surf_pos, surf_tris, flat=False)
            surf_edges = comp_edges
            surf_re = re_arr[used_surf_nodes]
            surf_im = im_arr[used_surf_nodes]
            surf_eval_pos_cell = surf_pos
            vtu_re = re_arr[vtu_used_nodes]
            vtu_im = im_arr[vtu_used_nodes]
            vtu_pos = vtu_pts
            vtu_loc = "node"
        else:
            surf_pos = comp_pos[comp_tris.ravel()]
            surf_tris = np.arange(surf_pos.shape[0], dtype=np.uint32).reshape(-1, 3)
            surf_norms = _compute_surface_normals(surf_pos, surf_tris, flat=True)
            surf_edges = np.concatenate(
                (surf_tris[:, [0, 1]], surf_tris[:, [1, 2]], surf_tris[:, [2, 0]]),
                axis=0,
            )
            active_cell_map = {orig: i for i, (_, _, orig) in enumerate(topo.volume_cells)}
            if loc == "active_cell":
                tri_cell_indices = np.asarray(
                    [active_cell_map[int(cid)] for cid in topo.surface_cell_owners],
                    dtype=np.int64,
                )
                vtu_re = np.asarray([re_arr[active_cell_map[int(cid)]] for cid in vtu_cell_ids])
                vtu_im = np.asarray([im_arr[active_cell_map[int(cid)]] for cid in vtu_cell_ids])
            else:
                tri_cell_indices = (
                    topo.surface_cell_owners
                    if topo.volume_cells
                    else np.arange(comp_tris.shape[0], dtype=np.int64)
                )
                vtu_re = re_arr[vtu_cell_ids]
                vtu_im = im_arr[vtu_cell_ids]
            vert_cids = np.repeat(tri_cell_indices, 3)
            surf_re = re_arr[vert_cids]
            surf_im = im_arr[vert_cids]
            surf_eval_pos_cell = surf_pos
            vtu_pos = np.asarray(
                [np.mean(topo.nodes_m[list(cnodes)], axis=0) for _, cnodes, _ in topo.volume_cells],
                dtype=np.float64,
            ) if topo.volume_cells else np.mean(comp_pos[comp_tris], axis=1)
            vtu_loc = "cell"

        arrow_pts, arrow_ids = _sample_fem_arrow_sites(
            topo,
            comp_pos,
            used_surf_nodes,
            "node" if loc == "node" else "cell",
            max_arrows if include_arrows else 0,
        )
        if loc == "active_cell" and arrow_ids.size > 0:
            active_cell_map = {orig: i for i, (_, _, orig) in enumerate(topo.volume_cells)}
            arrow_ids = np.asarray([active_cell_map[int(cid)] for cid in arrow_ids], dtype=np.int64)
        arrow_re = re_arr[arrow_ids] if arrow_ids.size else np.zeros((0, 3))
        arrow_im = im_arr[arrow_ids] if arrow_ids.size else np.zeros((0, 3))
        domain_extent = float(np.max(np.max(comp_pos, axis=0) - np.min(comp_pos, axis=0))) if comp_pos.size else 1.0
        eff_arrow_len = float(arrow_length_m) if arrow_length_m is not None else max(domain_extent * 0.06, 1e-12)

    if include_arrows and not is_vector:
        raise ValueError("3D vector arrows require a 3-component complex vector field")

    phases_rad = (
        np.linspace(0.0, 2.0 * math.pi, steps, endpoint=False, dtype=np.float64)
        if steps > 1
        else np.asarray([0.0], dtype=np.float64)
    )
    rep = representation.strip().lower()
    if rep == "amplitude":
        rep = "abs"

    # Evaluate surface colors across the full phase cycle for a globally stable scalar range.
    surf_eval_frames = np.stack(
        [
            evaluate_complex_vector_field(
                surf_re,
                surf_im,
                phase_rad=float(ph),
                representation=rep,
                amplitude_scale=amplitude_scale,
                wavevector_kf=wavevector_kf,
                positions_m=surf_eval_pos_cell,
                cell_origin_m=cell_origin_m,
                phasor_convention=phasor_convention,
                floquet_spatial_convention=floquet_spatial_convention,
            )
            for ph in phases_rad
        ],
        axis=0,
    )
    resolved_range = _compute_global_scalar_range(
        surf_eval_frames if is_vector else surf_eval_frames[:, :, :1],
        is_vector,
        resolved_color_mode,
        scalar_range,
    )
    if fmt in {"vtu", "pvd", "vtu_zip"}:
        if fmt == "vtu":
            vtu_vec = evaluate_complex_vector_field(
                vtu_re,
                vtu_im,
                phase_rad=0.0,
                representation=rep,
                amplitude_scale=amplitude_scale,
                wavevector_kf=wavevector_kf,
                positions_m=vtu_pos,
                cell_origin_m=cell_origin_m,
                phasor_convention=phasor_convention,
                floquet_spatial_convention=floquet_spatial_convention,
            )
            vtu_abs = np.sqrt(vtu_re * vtu_re + vtu_im * vtu_im) * float(amplitude_scale)
            extra = {
                f"{quantity_id}_real": vtu_re,
                f"{quantity_id}_imag": vtu_im,
                f"{quantity_id}_abs": vtu_abs if is_vector else vtu_abs[:, 0],
            }
            d_dict = _vtu_data_for_field(
                vtu_vec if is_vector else vtu_vec[:, :1],
                is_vector=is_vector,
                quantity_id=quantity_id,
                color_mode=resolved_color_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
                extra_arrays=extra,
            )
            f_data: dict[str, Any] = {"phase_rad": 0.0, "quantity_id": quantity_id}
            if frequency_hz is not None:
                f_data["frequency_hz"] = float(frequency_hz)
            written_path = export_vtu(
                target,
                points_m=vtu_pts,
                cells=vtu_cells,
                cell_types=vtu_ctypes,
                point_data=d_dict if vtu_loc == "node" else None,
                cell_data=d_dict if vtu_loc == "cell" else None,
                field_data=f_data,
                coordinate_scale=scale_mode,
                encoding=vtk_encoding,
            )
            c_scale, origin_off, _ = resolve_coordinate_transform([vtu_pts], scale_mode)
            return Export3DResult(
                output_path=written_path,
                format=fmt,
                frame_count=1,
                vertex_count=int(vtu_pts.shape[0]),
                cell_count=int(len(vtu_ctypes) if not isinstance(vtu_ctypes, str) else vtu_cells.shape[0]),
                arrow_count=0,
                coordinate_scale=scale_mode,
                si_meters_per_unit=1.0 / c_scale,
                origin_offset_m=origin_off,
                scalar_range=resolved_range,
                files_written=(written_path,),
            )

        pvd_frames: list[dict[str, Any]] = []
        for ph in phases_rad:
            vtu_vec = evaluate_complex_vector_field(
                vtu_re,
                vtu_im,
                phase_rad=float(ph),
                representation=rep,
                amplitude_scale=amplitude_scale,
                wavevector_kf=wavevector_kf,
                positions_m=vtu_pos,
                cell_origin_m=cell_origin_m,
                phasor_convention=phasor_convention,
                floquet_spatial_convention=floquet_spatial_convention,
            )
            d_dict = _vtu_data_for_field(
                vtu_vec if is_vector else vtu_vec[:, :1],
                is_vector=is_vector,
                quantity_id=quantity_id,
                color_mode=resolved_color_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
            )
            f_data = {"phase_rad": float(ph), "quantity_id": quantity_id}
            if frequency_hz is not None:
                f_data["frequency_hz"] = float(frequency_hz)
            pvd_frames.append(
                {
                    "timestep": float(ph),
                    "points_m": vtu_pts,
                    "cells": vtu_cells,
                    "cell_types": vtu_ctypes,
                    "point_data": d_dict if vtu_loc == "node" else None,
                    "cell_data": d_dict if vtu_loc == "cell" else None,
                    "field_data": f_data,
                }
            )
        written_path, files_written = write_pvd_bundle(
            target,
            pvd_frames,
            coordinate_scale=scale_mode,
            encoding=vtk_encoding,
            zip_archive=(fmt == "vtu_zip"),
        )
        c_scale, origin_off, _ = resolve_coordinate_transform([vtu_pts], scale_mode)
        return Export3DResult(
            output_path=written_path,
            format=fmt,
            frame_count=steps,
            vertex_count=int(vtu_pts.shape[0]),
            cell_count=int(len(vtu_ctypes) if not isinstance(vtu_ctypes, str) else vtu_cells.shape[0]),
            arrow_count=0,
            coordinate_scale=scale_mode,
            si_meters_per_unit=1.0 / c_scale,
            origin_offset_m=origin_off,
            scalar_range=resolved_range,
            files_written=files_written,
        )

    # glTF / GLB phase cycle export
    surf_frame_cols: list[NDArray[np.float64]] = []
    if include_surface:
        for frame in surf_eval_frames:
            cols, _ = evaluate_field_colors(
                frame if is_vector else frame[:, 0],
                color_mode=resolved_color_mode,
                color_palette=palette_id,
                scalar_range=resolved_range,
                color_space="linear",
            )
            surf_frame_cols.append(cols)

    timeline_phases = (
        np.linspace(0.0, 2.0 * math.pi, steps + 1, endpoint=True, dtype=np.float64)
        if steps > 1
        else np.asarray([0.0], dtype=np.float64)
    )
    timeline_s = (
        np.linspace(0.0, float(cycle_duration_s), steps + 1, endpoint=True, dtype=np.float64)
        if steps > 1
        else np.asarray([0.0], dtype=np.float64)
    )

    morph_deltas_m: tuple[NDArray[np.float64], ...] = ()
    morph_weights: NDArray[np.float64] | None = None
    if include_surface and float(surface_displacement_scale) > 0.0:
        disp_m = float(surface_displacement_scale) * 0.1 * max(domain_extent, 1e-30)
        vec_0 = evaluate_complex_vector_field(
            surf_re,
            surf_im,
            phase_rad=0.0,
            representation=rep,
            amplitude_scale=amplitude_scale,
            wavevector_kf=wavevector_kf,
            positions_m=surf_eval_pos_cell,
            cell_origin_m=cell_origin_m,
            phasor_convention=phasor_convention,
            floquet_spatial_convention=floquet_spatial_convention,
        )
        vec_90 = evaluate_complex_vector_field(
            surf_re,
            surf_im,
            phase_rad=0.5 * math.pi,
            representation=rep,
            amplitude_scale=amplitude_scale,
            wavevector_kf=wavevector_kf,
            positions_m=surf_eval_pos_cell,
            cell_origin_m=cell_origin_m,
            phasor_convention=phasor_convention,
            floquet_spatial_convention=floquet_spatial_convention,
        )
        d_cos, d_sin = _compute_normal_morph_deltas(
            vec_0,
            vec_90,
            surf_norms,
            displacement_scale_m=disp_m,
            displacement_component=displacement_component,
        )
        morph_deltas_m = (d_cos, d_sin)
        if steps > 1:
            morph_weights = np.column_stack((np.cos(timeline_phases), np.sin(timeline_phases))).ravel()

    arrow_frames: NDArray[np.float64] | None = None
    arrow_ref_cols: NDArray[np.float64] | None = None
    arrow_max_mag: float | None = None
    if include_arrows and arrow_pts.shape[0] > 0:
        arrow_frames = np.stack(
            [
                evaluate_complex_vector_field(
                    arrow_re,
                    arrow_im,
                    phase_rad=float(ph),
                    representation=rep,
                    amplitude_scale=amplitude_scale,
                    wavevector_kf=wavevector_kf,
                    positions_m=arrow_pts,
                    cell_origin_m=cell_origin_m,
                    phasor_convention=phasor_convention,
                    floquet_spatial_convention=floquet_spatial_convention,
                )
                for ph in timeline_phases
            ],
            axis=0,
        )
        norms = np.linalg.norm(arrow_frames, axis=2)
        arrow_max_mag = float(np.max(norms)) if norms.size else 1.0
        peak_idx = np.argmax(norms, axis=0)
        ref_vecs = arrow_frames[peak_idx, np.arange(arrow_pts.shape[0]), :]
        a_mode = normalize_color_mode(arrow_color_mode, fallback=resolved_color_mode)
        arrow_ref_cols, _ = evaluate_field_colors(
            ref_vecs,
            color_mode=a_mode,
            color_palette=palette_id,
            scalar_range=resolved_range,
            color_space="linear",
        )

    extras: dict[str, Any] = {
        "domain_kind": "fdm" if is_fdm else "fem",
        "quantity_id": quantity_id,
        "animation_kind": "phase_cycle" if steps > 1 else "static",
        "complex_representation": rep,
        "phasor_convention": phasor_convention,
        "floquet_spatial_convention": floquet_spatial_convention,
        "wavevector_kf": [float(v) for v in wavevector_kf] if wavevector_kf is not None else None,
        "phase_steps": steps,
        "frequency_hz": float(frequency_hz) if frequency_hz is not None else None,
        "mode_id": mode_id,
        "color_mode": resolved_color_mode,
        "color_palette": palette_id,
        "scalar_range": [resolved_range[0], resolved_range[1]],
        "surface_displacement_scale": float(surface_displacement_scale),
    }
    if metadata:
        extras.update(metadata)

    doc, bin_bytes, origin_off, si_per_unit = _build_gltf_surface_and_arrows(
        surface_positions_m=surf_pos if include_surface else None,
        surface_normals=surf_norms if include_surface else None,
        surface_indices=surf_tris if include_surface else None,
        surface_edge_indices=surf_edges if (include_surface and include_wireframe) else None,
        surface_frame_colors_linear=surf_frame_cols if include_surface else None,
        morph_deltas_m=morph_deltas_m,
        morph_weights_track=morph_weights,
        arrow_sites_m=arrow_pts if include_arrows else None,
        arrow_vector_frames=arrow_frames,
        arrow_colors_linear_ref=arrow_ref_cols,
        arrow_length_m=eff_arrow_len,
        arrow_scale_by_magnitude=arrow_scale_by_magnitude,
        arrow_max_magnitude=arrow_max_mag,
        arrow_anchor=arrow_anchor,
        timeline_s=timeline_s,
        phase_cycle=True,
        material_mode=material_mode,
        opacity=opacity,
        coordinate_scale=scale_mode,
        fullmag_extras=extras,
    )
    written_path = _write_gltf_or_glb(target, fmt, doc, bin_bytes)
    return Export3DResult(
        output_path=written_path,
        format=fmt,
        frame_count=steps,
        vertex_count=int(surf_pos.shape[0]) if include_surface else 0,
        cell_count=int(len(vtu_ctypes) if not isinstance(vtu_ctypes, str) else vtu_cells.shape[0]),
        arrow_count=int(arrow_pts.shape[0]) if include_arrows else 0,
        coordinate_scale=scale_mode,
        si_meters_per_unit=si_per_unit,
        origin_offset_m=origin_off,
        scalar_range=resolved_range,
        files_written=(written_path,),
        metadata=extras,
    )


def _read_zarr_array_dir(array_dir: Path) -> NDArray[np.float64]:
    """Read a Zarr v2/v3 array directory into a float64 NumPy array.

    Supports uncompressed Zarr v2 arrays directly via ``.zarray`` + raw chunk
    files with zero optional dependencies, and falls back to ``zarr.open`` for
    compressed Zarr v2 or Zarr v3 arrays.
    """
    zarray_file = array_dir / ".zarray"
    if zarray_file.is_file():
        meta = json.loads(zarray_file.read_text(encoding="utf-8"))
        compressor = meta.get("compressor")
        filters = meta.get("filters")
        if compressor is None and not filters and meta.get("order", "C") == "C":
            shape = tuple(int(s) for s in meta["shape"])
            chunks = tuple(int(c) for c in meta["chunks"])
            dtype = np.dtype(meta["dtype"])
            sep = str(meta.get("dimension_separator", "."))
            fill_raw = meta.get("fill_value", 0.0)
            fill_val = 0.0 if fill_raw is None else float(fill_raw)
            out = np.full(shape, fill_val, dtype=dtype)
            chunk_counts = tuple(math.ceil(s / c) for s, c in zip(shape, chunks))
            for grid_idx in np.ndindex(*chunk_counts):
                chunk_name = sep.join(str(i) for i in grid_idx)
                chunk_path = array_dir / chunk_name
                if not chunk_path.is_file():
                    continue
                slices = tuple(
                    slice(i * c, min((i + 1) * c, s))
                    for i, c, s in zip(grid_idx, chunks, shape)
                )
                raw_chunk = np.fromfile(chunk_path, dtype=dtype)
                sub_shape = tuple(sl.stop - sl.start for sl in slices)
                expected_full = int(np.prod(chunks))
                expected_sub = int(np.prod(sub_shape))
                if raw_chunk.size == expected_full:
                    chunk_arr = raw_chunk.reshape(chunks)
                    sub_slices = tuple(slice(0, sl.stop - sl.start) for sl in slices)
                    out[slices] = chunk_arr[sub_slices]
                elif raw_chunk.size == expected_sub:
                    out[slices] = raw_chunk.reshape(sub_shape)
                else:
                    raise ValueError(
                        f"unexpected Zarr chunk element count {raw_chunk.size} in '{chunk_path}'"
                    )
            return out.astype(np.float64, copy=False)

    try:
        import zarr
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            f"reading Zarr array '{array_dir}' requires the 'zarr' package"
        ) from exc

    arr = zarr.open(str(array_dir), mode="r")
    return np.asarray(arr, dtype=np.float64)


def _normalize_stage_frames(
    raw: NDArray[np.float64],
    spatial_count: int,
    field_layout: str | None,
) -> NDArray[np.float64]:
    """Normalize loaded playback array into shape ``(T, spatial_count, 3)``."""
    if raw.ndim == 2:
        t_count, flat = raw.shape
        if flat != spatial_count * 3:
            raise ValueError(
                f"expected stage width {spatial_count * 3}, got {flat}"
            )
        if field_layout == "soa_component_major":
            return np.transpose(raw.reshape(t_count, 3, spatial_count), (0, 2, 1))
        return raw.reshape(t_count, spatial_count, 3)

    if raw.ndim == 3:
        if raw.shape[1:] == (3, spatial_count):
            return np.transpose(raw, (0, 2, 1))
        if raw.shape[1:] == (spatial_count, 3):
            return raw

    raise ValueError(
        f"unexpected Zarr playback array shape {raw.shape} for spatial_count={spatial_count}"
    )


def _read_complex_vector_bin(path: Path) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    raw = np.fromfile(path, dtype="<f8")
    if raw.size == 0 or raw.size % 6 != 0:
        raise ValueError(f"invalid complex vector binary payload length in '{path}'")
    paired = raw.reshape(-1, 3, 2)
    return paired[:, :, 0].copy(), paired[:, :, 1].copy()


def export_result_bundle_3d(
    result_dir: str | Path,
    output_path: str | Path,
    *,
    stage_id: str | None = None,
    frame_index: int | None = None,
    stride: int = 1,
    sample_index: int = 0,
    mode_index: int = 0,
    mesh: Any = None,
    grid_shape: Sequence[int] | None = None,
    cell_size_m: Sequence[float] | None = None,
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    active_mask: Any | None = None,
    format: str = "auto",
    color_mode: str = "orientation",
    color_palette: str = "viridis",
    scalar_range: tuple[float, float] | None = None,
    material_mode: str = "unlit",
    opacity: float = 1.0,
    coordinate_scale: str | None = None,
    include_surface: bool = True,
    include_wireframe: bool = False,
    include_arrows: bool | None = None,
    max_arrows: int = 256,
    arrow_length_m: float | None = None,
    arrow_scale_by_magnitude: bool = False,
    surface_displacement_scale: float = 0.0,
    phase_steps: int = 24,
    playback_duration_s: float | None = None,
    vtk_encoding: str = "binary",
) -> Export3DResult:
    """Read a saved Fullmag result bundle (``playback.json``+Zarr or eigenmodes) and export 3D."""
    root = Path(result_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"result directory does not exist: '{root}'")

    playback_path = root / "playback.json"
    eigen_mode_json = root / "eigen" / "modes" / f"sample_{sample_index:04d}" / f"mode_{mode_index:04d}.json"
    if not eigen_mode_json.is_file():
        alt_mode_json = root / "eigen" / "modes" / f"sample_{sample_index:04d}_mode_{mode_index:04d}.json"
        if alt_mode_json.is_file():
            eigen_mode_json = alt_mode_json

    if playback_path.is_file():
        sidecar = json.loads(playback_path.read_text(encoding="utf-8"))
        if sidecar.get("schema") != "fullmag.saved_playback.v1":
            raise ValueError(f"unsupported playback schema '{sidecar.get('schema')}'")
        if not sidecar.get("complete", False):
            raise ValueError("playback.json does not declare complete=true")

        stages = list(sidecar.get("stages", ()))
        if stage_id is not None:
            stages = [s for s in stages if s.get("stage_id") == stage_id]
            if not stages:
                raise ValueError(f"stage_id '{stage_id}' not found in playback.json")
        if not stages:
            raise ValueError("playback.json contains no stages")

        fem_desc = sidecar.get("fem_mesh")
        if fem_desc is not None:
            geom_file = root / str(fem_desc["geometry_path"])
            if not geom_file.is_file():
                raise FileNotFoundError(f"FEM geometry file not found: '{geom_file}'")
            geom_json = json.loads(geom_file.read_text(encoding="utf-8"))
            spatial_count = len(geom_json["mesh"]["nodes"])
            all_frames: list[NDArray[np.float64]] = []
            all_times: list[float] = []
            for st in stages:
                arr = _read_zarr_array_dir(root / str(st["array_path"]))
                normed = _normalize_stage_frames(arr, spatial_count, st.get("field_layout"))
                st_times = [float(t) for t in st.get("times_s", range(normed.shape[0]))]
                cur_offset = (
                    all_times[-1] - st_times[0] + 1e-12
                    if (all_times and st_times and st_times[0] <= all_times[-1])
                    else 0.0
                )
                all_frames.append(normed)
                all_times.extend(t + cur_offset for t in st_times)
            frames = np.concatenate(all_frames, axis=0)
            times = all_times
        else:
            grid_xyz = sidecar.get("grid_cells_xyz")
            cell_xyz = sidecar.get("cell_size_m")
            orig_xyz = sidecar.get("origin_m")
            if not (grid_xyz and cell_xyz and orig_xyz):
                raise ValueError("FDM playback.json is missing grid_cells_xyz, cell_size_m, or origin_m")
            spatial_count = int(grid_xyz[0]) * int(grid_xyz[1]) * int(grid_xyz[2])
            all_frames = []
            all_times = []
            for st in stages:
                arr = _read_zarr_array_dir(root / str(st["array_path"]))
                normed = _normalize_stage_frames(arr, spatial_count, st.get("field_layout"))
                st_times = [float(t) for t in st.get("times_s", range(normed.shape[0]))]
                cur_offset = (
                    all_times[-1] - st_times[0] + 1e-12
                    if (all_times and st_times and st_times[0] <= all_times[-1])
                    else 0.0
                )
                all_frames.append(normed)
                all_times.extend(t + cur_offset for t in st_times)
            frames = np.concatenate(all_frames, axis=0)
            times = all_times

        if frame_index is not None:
            idx = int(frame_index)
            if idx < 0:
                idx += frames.shape[0]
            if idx < 0 or idx >= frames.shape[0]:
                raise IndexError(
                    f"frame_index {frame_index} out of range for {frames.shape[0]} frames"
                )
            frames = frames[idx : idx + 1]
            times = [times[idx]]
        elif stride > 1:
            step = int(stride)
            frames = frames[::step]
            times = times[::step]

        arrows_flag = False if include_arrows is None else bool(include_arrows)
        bundle_meta = {
            "source_bundle": str(root),
            "bundle_name": sidecar.get("name"),
            "stages": [s.get("stage_id") for s in stages],
        }
        if fem_desc is not None:
            return export_mesh_3d(
                output_path,
                frames,
                mesh=geom_json,
                times_s=times,
                format=format,
                quantity_id="m",
                color_mode=color_mode,
                color_palette=color_palette,
                scalar_range=scalar_range,
                material_mode=material_mode,
                opacity=opacity,
                coordinate_scale=coordinate_scale,
                include_surface=include_surface,
                include_wireframe=include_wireframe,
                include_arrows=arrows_flag,
                max_arrows=max_arrows,
                arrow_length_m=arrow_length_m,
                arrow_scale_by_magnitude=arrow_scale_by_magnitude,
                playback_duration_s=playback_duration_s,
                vtk_encoding=vtk_encoding,
                metadata=bundle_meta,
            )

        return export_grid_3d(
            output_path,
            frames,
            grid_shape=grid_xyz,
            cell_size_m=cell_xyz,
            origin_m=orig_xyz,
            active_mask=active_mask,
            times_s=times,
            format=format,
            quantity_id="m",
            color_mode=color_mode,
            color_palette=color_palette,
            scalar_range=scalar_range,
            material_mode=material_mode,
            opacity=opacity,
            coordinate_scale=coordinate_scale,
            include_surface=include_surface,
            include_wireframe=include_wireframe,
            include_arrows=arrows_flag,
            max_arrows=max_arrows,
            arrow_length_m=arrow_length_m,
            arrow_scale_by_magnitude=arrow_scale_by_magnitude,
            playback_duration_s=playback_duration_s,
            vtk_encoding=vtk_encoding,
            metadata=bundle_meta,
        )

    if eigen_mode_json.is_file():
        mode_meta = json.loads(eigen_mode_json.read_text(encoding="utf-8"))
        zarr_array_rel = mode_meta.get("zarr_array_path")
        bin_rel = mode_meta.get("compatibility_binary_payload_path")
        canonical_zarr_dir = (
            root
            / "eigen"
            / "mode_fields.zarr"
            / f"sample_{sample_index:04d}"
            / f"mode_{mode_index:04d}"
            / "vector_xyz_complex"
        )
        if zarr_array_rel and (root / zarr_array_rel).is_dir():
            paired = _read_zarr_array_dir(root / zarr_array_rel)
            re_arr, im_arr = paired[:, :, 0], paired[:, :, 1]
        elif canonical_zarr_dir.is_dir():
            paired = _read_zarr_array_dir(canonical_zarr_dir)
            re_arr, im_arr = paired[:, :, 0], paired[:, :, 1]
        elif bin_rel and (root / bin_rel).is_file():
            re_arr, im_arr = _read_complex_vector_bin(root / bin_rel)
        else:
            default_bin = root / "eigen" / "mode_fields" / f"sample_{sample_index:04d}" / f"mode_{mode_index:04d}" / "vector.bin"
            if not default_bin.is_file():
                raise FileNotFoundError(
                    f"no mode field payload found for sample={sample_index}, mode={mode_index}"
                )
            re_arr, im_arr = _read_complex_vector_bin(default_bin)

        resolved_mesh = mesh
        if resolved_mesh is None and (root / "geometry.json").is_file():
            resolved_mesh = json.loads((root / "geometry.json").read_text(encoding="utf-8"))
        resolved_grid = grid_shape
        resolved_cell = cell_size_m
        resolved_origin = origin_m
        if resolved_mesh is None and resolved_grid is None:
            meta_file = root / "artifacts" / "metadata.json"
            if meta_file.is_file():
                run_meta = json.loads(meta_file.read_text(encoding="utf-8"))
                layout = run_meta.get("artifact_layout", {})
                resolved_grid = layout.get("grid_cells")
                resolved_cell = layout.get("cell_size_m", resolved_cell)
                resolved_origin = layout.get("origin_m", resolved_origin)

        arrows_flag = True if include_arrows is None else bool(include_arrows)
        k_vec = mode_meta.get("k_vector")
        return export_mode_animation_3d(
            output_path,
            real=re_arr,
            imag=im_arr,
            grid_shape=resolved_grid,
            cell_size_m=resolved_cell,
            origin_m=resolved_origin,
            active_mask=active_mask,
            mesh=resolved_mesh,
            phase_steps=phase_steps,
            cycle_duration_s=playback_duration_s or 2.0,
            wavevector_kf=k_vec if (k_vec and any(float(v) != 0.0 for v in k_vec)) else None,
            phasor_convention=str(mode_meta.get("phasor_convention", "exp_i_omega_t")),
            surface_displacement_scale=surface_displacement_scale,
            frequency_hz=mode_meta.get("frequency_hz"),
            mode_id=mode_meta.get("mode_field_id"),
            format=format,
            color_mode=color_mode,
            color_palette=color_palette,
            scalar_range=scalar_range,
            material_mode=material_mode,
            opacity=opacity,
            coordinate_scale=coordinate_scale,
            include_surface=include_surface,
            include_wireframe=include_wireframe,
            include_arrows=arrows_flag,
            max_arrows=min(max_arrows, 128),
            arrow_length_m=arrow_length_m,
            arrow_scale_by_magnitude=True if not arrow_scale_by_magnitude else arrow_scale_by_magnitude,
            vtk_encoding=vtk_encoding,
            metadata={"source_bundle": str(root)},
        )

    raise FileNotFoundError(
        f"no supported 'playback.json' or eigenmode artifact bundle found in '{root}'"
    )
