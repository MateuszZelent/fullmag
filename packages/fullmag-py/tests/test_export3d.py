from __future__ import annotations

import base64
import json
import math
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import pytest

import fullmag as fm
from fullmag.export3d import (
    DIRECTION_HSL_NEUTRAL_RGB,
    SCALAR_PALETTES,
    build_animated_arrow_tracks,
    build_merged_arrow_mesh,
    create_unit_arrow_mesh,
    direction_hsl_linear,
    direction_hsl_srgb,
    evaluate_complex_vector_field,
    export_glb,
    export_gltf,
    export_grid_3d,
    export_mesh_3d,
    export_mode_animation_3d,
    export_pvd,
    export_result_bundle_3d,
    export_vtu,
    extract_voxel_shell,
    linear_to_srgb,
    scalar_color_linear,
    scalar_color_srgb,
    srgb_to_linear,
    vectors_to_quaternions_xyzw,
)
from fullmag.export3d.arrow_mesh import quaternions_to_rotation_matrices
from fullmag.export3d.gltf_writer import GLB_CHUNK_BIN, GLB_CHUNK_JSON, GLB_MAGIC, GLB_VERSION
from fullmag.meshing import MeshData


def _parse_glb(path: Path) -> tuple[dict[str, object], bytes]:
    raw = path.read_bytes()
    assert len(raw) >= 12
    magic, version, total_len = struct.unpack("<III", raw[:12])
    assert magic == GLB_MAGIC
    assert version == GLB_VERSION
    assert total_len == len(raw)

    offset = 12
    json_len, json_type = struct.unpack("<II", raw[offset : offset + 8])
    assert json_type == GLB_CHUNK_JSON
    assert json_len % 4 == 0
    offset += 8
    json_bytes = raw[offset : offset + json_len]
    offset += json_len
    doc = json.loads(json_bytes.decode("utf-8"))

    bin_bytes = b""
    if offset < len(raw):
        bin_len, bin_type = struct.unpack("<II", raw[offset : offset + 8])
        assert bin_type == GLB_CHUNK_BIN
        assert bin_len % 4 == 0
        offset += 8
        bin_bytes = raw[offset : offset + bin_len]
        offset += bin_len
    assert offset == len(raw)
    return doc, bin_bytes


def _read_glb_accessor(doc: dict[str, object], bin_bytes: bytes, accessor_idx: int) -> np.ndarray:
    acc = doc["accessors"][accessor_idx]  # type: ignore[index]
    bv = doc["bufferViews"][acc["bufferView"]]  # type: ignore[index]
    comp_map = {
        5126: np.dtype("<f4"),
        5123: np.dtype("<u2"),
        5125: np.dtype("<u4"),
    }
    type_width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    dtype = comp_map[acc["componentType"]]
    width = type_width[acc["type"]]
    start = int(bv.get("byteOffset", 0)) + int(acc.get("byteOffset", 0))
    count = int(acc["count"])
    arr = np.frombuffer(bin_bytes, dtype=dtype, count=count * width, offset=start)
    return arr.copy() if width == 1 else arr.reshape(count, width).copy()


def _decode_vtk_binary_data_array(elem: ET.Element, header_type: str = "UInt32") -> np.ndarray:
    vtk_type_map = {
        "Float64": np.dtype("<f8"),
        "Float32": np.dtype("<f4"),
        "UInt8": np.dtype("|u1"),
        "Int32": np.dtype("<i4"),
        "Int64": np.dtype("<i8"),
        "UInt32": np.dtype("<u4"),
        "UInt64": np.dtype("<u8"),
    }
    raw = base64.b64decode((elem.text or "").strip())
    hdr_len = 8 if header_type == "UInt64" else 4
    hdr_fmt = "<Q" if header_type == "UInt64" else "<I"
    (payload_bytes,) = struct.unpack(hdr_fmt, raw[:hdr_len])
    assert len(raw) - hdr_len == payload_bytes
    dtype = vtk_type_map[elem.attrib["type"]]
    arr = np.frombuffer(raw[hdr_len:], dtype=dtype)
    n_comp = int(elem.attrib.get("NumberOfComponents", "1"))
    return arr.copy() if n_comp == 1 else arr.reshape(-1, n_comp).copy()


def test_top_level_fullmag_exports_export3d() -> None:
    assert "export3d" in fm.__all__
    assert fm.export3d.export_grid_3d is export_grid_3d
    assert fm.export3d.export_mesh_3d is export_mesh_3d
    assert fm.export3d.export_mode_animation_3d is export_mode_animation_3d
    assert fm.export3d.export_result_bundle_3d is export_result_bundle_3d


def test_colormaps_hsl_palettes_and_srgb_parity() -> None:
    # +X -> pure red; +Y -> chartreuse/yellow-green [0.5, 1, 0]; +Z -> white; -Z -> black
    vecs = np.array(
        [
            [2.5, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 3.0],
            [0.0, 0.0, -3.0],
            [0.0, 0.0, 0.0],
            [1e-31, 0.0, 0.0],
            [float("nan"), 1.0, 0.0],
        ],
        dtype=np.float64,
    )
    srgb = direction_hsl_srgb(vecs)
    np.testing.assert_allclose(srgb[0], [1.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(srgb[1], [0.5, 1.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(srgb[2], [0.0, 1.0, 1.0], atol=1e-12)
    np.testing.assert_allclose(srgb[3], [1.0, 1.0, 1.0], atol=1e-12)
    np.testing.assert_allclose(srgb[4], [0.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(srgb[5], DIRECTION_HSL_NEUTRAL_RGB, atol=1e-12)
    np.testing.assert_allclose(srgb[6], DIRECTION_HSL_NEUTRAL_RGB, atol=1e-12)
    np.testing.assert_allclose(srgb[7], DIRECTION_HSL_NEUTRAL_RGB, atol=1e-12)

    linear = direction_hsl_linear(vecs)
    np.testing.assert_allclose(linear, srgb_to_linear(srgb), atol=1e-12)
    np.testing.assert_allclose(linear_to_srgb(linear), srgb, atol=1e-10)
    assert np.isclose(srgb_to_linear(0.04045), 0.04045 / 12.92, atol=1e-12)

    expected_palettes = {
        "viridis",
        "coolwarm",
        "inferno",
        "magma",
        "jet",
        "plasma",
        "cividis",
        "turbo",
        "grayscale",
        "rdbu",
        "twilight",
    }
    assert set(SCALAR_PALETTES) == expected_palettes
    for name, stops in SCALAR_PALETTES.items():
        c = scalar_color_srgb([-0.5, 0.0, 1.0, 2.0], palette=name)
        np.testing.assert_allclose(c[0], stops[0], atol=1e-12)
        np.testing.assert_allclose(c[1], stops[0], atol=1e-12)
        np.testing.assert_allclose(c[2], stops[-1], atol=1e-12)
        np.testing.assert_allclose(c[3], stops[-1], atol=1e-12)
        c_lin = scalar_color_linear([0.25, 0.75], palette=name)
        np.testing.assert_allclose(
            c_lin,
            srgb_to_linear(scalar_color_srgb([0.25, 0.75], palette=name)),
            atol=1e-12,
        )


def test_complex_phasor_and_floquet_evaluation() -> None:
    re = np.array([[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]], dtype=np.float64)
    im = np.array([[0.0, 1.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64)
    pos = np.array([[0.0, 0.0, 0.0], [10e-9, 0.0, 0.0]], dtype=np.float64)
    kf = (math.pi / (20e-9), 0.0, 0.0)  # k_x * 10nm = pi / 2

    # At phase = 0, spatialPhaseSign = -1 -> theta = [0, -pi/2]
    # Re*cos(theta) - Im*sin(theta) -> [1, 0, 0] at origin, [0, +1, 0] at 10nm
    v_minus = evaluate_complex_vector_field(
        re,
        im,
        phase_rad=0.0,
        wavevector_kf=kf,
        positions_m=pos,
        phasor_convention="exp_i_omega_t",
        floquet_spatial_convention="dst_equals_src_exp_minus_i_k_dot_delta_r",
    )
    np.testing.assert_allclose(v_minus[0], [1.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(v_minus[1], [0.0, 1.0, 0.0], atol=1e-12)

    # Opposite temporal convention exp_minus_i_omega_t flips phase sign at t = pi/2
    v_pos_t = evaluate_complex_vector_field(re, im, phase_rad=math.pi / 2, phasor_convention="exp_i_omega_t")
    v_neg_t = evaluate_complex_vector_field(re, im, phase_rad=math.pi / 2, phasor_convention="exp_minus_i_omega_t")
    np.testing.assert_allclose(v_pos_t[0], [0.0, -1.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(v_neg_t[0], [0.0, 1.0, 0.0], atol=1e-12)

    v_abs = evaluate_complex_vector_field(re, im, representation="abs")
    np.testing.assert_allclose(v_abs[0], [1.0, 1.0, 0.0], atol=1e-12)


def test_voxel_shell_face_culling_normals_and_cell_indices() -> None:
    # 2x2x2 cube -> 8 cells -> 24 exterior faces (interior shared faces culled)
    shell = extract_voxel_shell((2, 2, 2), (2e-9, 3e-9, 4e-9), origin_m=(1e-9, -1e-9, 0.0))
    assert shell.positions.shape == (24 * 4, 3)
    assert shell.indices.shape == (24 * 2, 3)
    assert shell.cell_indices.shape == (24 * 4,)
    assert shell.edge_indices.shape[0] > 0

    # Verify triangle winding matches stored outward normals
    p = shell.positions[shell.indices]
    cross = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    cross_unit = cross / np.linalg.norm(cross, axis=1, keepdims=True)
    tri_norms = shell.normals[shell.indices[:, 0]]
    np.testing.assert_allclose(cross_unit, tri_norms, atol=1e-12)

    # Non-convex 3x3x3 hollow shell (26 cells -> 6*9 outer + 6 inner = 60 exposed faces)
    mask = np.ones((3, 3, 3), dtype=bool)
    mask[1, 1, 1] = False
    hollow = extract_voxel_shell((3, 3, 3), (1e-9, 1e-9, 1e-9), active_mask=mask)
    assert hollow.positions.shape == (60 * 4, 3)
    assert 13 not in set(hollow.cell_indices.tolist())


def test_arrow_mesh_quaternions_and_hemisphere_continuity() -> None:
    unit = create_unit_arrow_mesh(anchor="center")
    assert unit.positions[:, 1].min() == pytest.approx(-0.5)
    assert unit.positions[:, 1].max() == pytest.approx(0.5)

    targets = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 2.0, -3.0],
        ],
        dtype=np.float64,
    )
    quats, norms = vectors_to_quaternions_xyzw(targets)
    rot_mats = quaternions_to_rotation_matrices(quats)
    rotated_y = np.einsum("mij,j->mi", rot_mats, np.array([0.0, 1.0, 0.0]))
    np.testing.assert_allclose(rotated_y, targets / norms[:, np.newaxis], atol=1e-12)

    # Full 360 deg precessing spin -> must maintain positive hemisphere dot product across steps
    angles = np.linspace(0.0, 2.0 * math.pi, 33, endpoint=True)
    frames = np.stack(
        [np.array([[math.cos(a), 0.2, math.sin(a)], [0.0, 0.0, 0.0]]) for a in angles],
        axis=0,
    )
    sites = np.array([[0.0, 0.0, 0.0], [1e-9, 0.0, 0.0]])
    tracks = build_animated_arrow_tracks(sites, frames, arrow_length_m=1e-9, scale_by_magnitude=True)
    rot_seq = tracks["rotations_xyzw"][:, 0, :]
    step_dots = np.sum(rot_seq[1:] * rot_seq[:-1], axis=1)
    assert np.all(step_dots >= -1e-12)
    # Zero vector site has zero scale
    np.testing.assert_allclose(tracks["scales"][:, 1, :], 0.0)

    # Static merged arrow mesh skips zero vector
    m_pos, m_norm, m_cols, m_idx = build_merged_arrow_mesh(
        sites,
        np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]]),
        np.array([[1.0, 0.0, 0.0], [0.5, 0.5, 0.5]]),
        arrow_length_m=1e-9,
    )
    assert m_pos.shape[0] == unit.positions.shape[0]
    assert m_norm.shape == m_pos.shape
    assert m_cols.shape == m_pos.shape
    assert m_idx.shape == unit.indices.shape


def test_glb_gltf_accessor_dedup_materials_and_scale(tmp_path: Path) -> None:
    positions = np.array(
        [[0.0, 0.0, 0.0], [10e-9, 0.0, 0.0], [10e-9, 5e-9, 0.0], [0.0, 5e-9, 0.0]],
        dtype=np.float64,
    )
    indices = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.uint32)
    vectors = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]])

    glb_path = tmp_path / "direct.glb"
    gltf_path = tmp_path / "direct.gltf"
    export_glb(
        glb_path,
        positions_m=positions,
        indices=indices,
        vectors=vectors,
        material_mode="pbr",
        opacity=0.6,
        coordinate_scale="auto_scene",
        edge_indices=np.array([[0, 1], [1, 2]], dtype=np.uint32),
        metadata={"custom_tag": "test"},
    )
    export_gltf(
        gltf_path,
        positions_m=positions,
        indices=indices,
        vectors=vectors,
        material_mode="unlit",
        coordinate_scale="nm",
    )

    doc_glb, bin_glb = _parse_glb(glb_path)
    assert doc_glb["asset"]["extras"]["fullmag"]["coordinate_scale"] == "auto_scene"  # type: ignore[index]
    assert doc_glb["asset"]["extras"]["fullmag"]["custom_tag"] == "test"  # type: ignore[index]
    pos_read = _read_glb_accessor(doc_glb, bin_glb, doc_glb["meshes"][0]["primitives"][0]["attributes"]["POSITION"])  # type: ignore[index]
    # Max extent 10nm scaled to 2.0, centered at [0, 0, 0]
    np.testing.assert_allclose(np.max(pos_read, axis=0) - np.min(pos_read, axis=0), [2.0, 1.0, 0.0], atol=1e-6)
    np.testing.assert_allclose(0.5 * (np.max(pos_read, axis=0) + np.min(pos_read, axis=0)), [0.0, 0.0, 0.0], atol=1e-6)
    assert doc_glb["materials"][0]["alphaMode"] == "BLEND"  # type: ignore[index]
    assert doc_glb["meshes"][1]["primitives"][0]["mode"] == 1  # LINES wireframe  # type: ignore[index]

    doc_gltf = json.loads(gltf_path.read_text(encoding="utf-8"))
    assert "KHR_materials_unlit" in doc_gltf["extensionsUsed"]
    assert doc_gltf["buffers"][0]["uri"].startswith("data:application/octet-stream;base64,")
    assert doc_gltf["asset"]["extras"]["fullmag"]["si_meters_per_unit"] == pytest.approx(1e-9)


def test_export_grid_3d_multilayer_and_playback_animation(tmp_path: Path) -> None:
    # Two layers of 2x2x1 = 4 cells each (8 cells total), 4 playback frames
    layers = [
        {"grid_shape": (2, 2, 1), "cell_size_m": (5e-9, 5e-9, 2e-9), "origin_m": (0.0, 0.0, 0.0), "value_offset": 0},
        {"grid_shape": (2, 2, 1), "cell_size_m": (5e-9, 5e-9, 2e-9), "origin_m": (0.0, 0.0, 4e-9), "value_offset": 4},
    ]
    t_frames = 4
    frames = np.zeros((t_frames, 8, 3), dtype=np.float64)
    for t in range(t_frames):
        ang = t * math.pi / 4.0
        frames[t, :, 0] = math.cos(ang)
        frames[t, :, 1] = math.sin(ang)
        frames[t, :, 2] = 0.25 * (t - 1.5)

    glb_out = tmp_path / "grid_anim.glb"
    res = export_grid_3d(
        glb_out,
        frames,
        layers=layers,
        times_s=[0.0, 1e-9, 2e-9, 3e-9],
        include_arrows=True,
        include_wireframe=True,
        max_arrows=8,
        color_mode="orientation",
    )
    assert res.frame_count == 4
    assert res.arrow_count == 8

    doc, _ = _parse_glb(glb_out)
    # 4 frame surface meshes must share identical POSITION, NORMAL, and indices accessors!
    surf_meshes = [m for m in doc["meshes"] if m["name"].startswith("surface_frame_mesh_")]  # type: ignore[index]
    assert len(surf_meshes) == 4
    pos_accs = {m["primitives"][0]["attributes"]["POSITION"] for m in surf_meshes}
    norm_accs = {m["primitives"][0]["attributes"]["NORMAL"] for m in surf_meshes}
    idx_accs = {m["primitives"][0]["indices"] for m in surf_meshes}
    col_accs = {m["primitives"][0]["attributes"]["COLOR_0"] for m in surf_meshes}
    assert len(pos_accs) == 1
    assert len(norm_accs) == 1
    assert len(idx_accs) == 1
    assert len(col_accs) == 4

    # All node names strictly sanitized
    for node in doc["nodes"]:  # type: ignore[index]
        assert re.fullmatch(r"[A-Za-z0-9_-]+", node["name"])

    # Animation samplers: STEP for surface frames, LINEAR for arrow TRS
    anim = doc["animations"][0]  # type: ignore[index]
    paths_by_interp = {(anim["samplers"][ch["sampler"]]["interpolation"], ch["target"]["path"]) for ch in anim["channels"]}
    assert ("STEP", "scale") in paths_by_interp
    assert ("LINEAR", "translation") in paths_by_interp
    assert ("LINEAR", "rotation") in paths_by_interp
    assert ("LINEAR", "scale") in paths_by_interp


def test_export_mode_animation_3d_morph_floquet_and_pvd(tmp_path: Path) -> None:
    # FEM 2-tet mesh with 1 inactive FarAir node (index 4)
    nodes = np.array(
        [
            [0.0, 0.0, 0.0],
            [10e-9, 0.0, 0.0],
            [0.0, 10e-9, 0.0],
            [0.0, 0.0, 10e-9],
            [0.0, 0.0, -10e-9],
        ],
        dtype=np.float64,
    )
    cells = np.array([[0, 1, 2, 3], [0, 2, 1, 4]], dtype=np.int32)
    active_mask = np.array([True, True, True, True, False], dtype=bool)
    re = np.array([[1.0, 0.0, 0.2], [0.5, 0.5, 0.4], [0.0, 1.0, 0.6], [0.2, 0.2, 1.0], [1e6, 1e6, 1e6]])
    im = np.array([[0.0, 1.0, 0.1], [-0.5, 0.5, 0.2], [-1.0, 0.0, 0.3], [-0.2, 0.2, 0.5], [1e6, 1e6, 1e6]])

    glb_path = tmp_path / "mode_fem.glb"
    res_glb = export_mode_animation_3d(
        glb_path,
        real=re,
        imag=im,
        nodes=nodes,
        cells=cells,
        cell_types="tet4",
        active_node_mask=active_mask,
        phase_steps=8,
        wavevector_kf=(1e8, 0.0, 0.0),
        phasor_convention="exp_minus_i_omega_t",
        surface_displacement_scale=0.25,
        include_arrows=True,
        max_arrows=4,
    )
    assert res_glb.vertex_count == 4  # inactive node 4 compacted out!
    assert res_glb.cell_count == 1
    doc, _ = _parse_glb(glb_path)
    surf_meshes = [m for m in doc["meshes"] if m["name"].startswith("surface_frame_mesh_")]  # type: ignore[index]
    assert len(surf_meshes) == 8
    # Morph targets deduplicated across all 8 surface frame meshes
    target_pairs = {(t[0]["POSITION"], t[1]["POSITION"]) for t in (m["primitives"][0]["targets"] for m in surf_meshes)}
    assert len(target_pairs) == 1
    assert any(ch["target"]["path"] == "weights" for ch in doc["animations"][0]["channels"])  # type: ignore[index]

    # Also test PVD + ZIP output for mode phase cycle
    zip_path = tmp_path / "mode_series.vtu.zip"
    res_zip = export_mode_animation_3d(
        zip_path,
        complex_values=re + 1j * im,
        nodes=nodes,
        cells=cells,
        cell_types="tet4",
        active_node_mask=active_mask,
        phase_steps=6,
    )
    assert res_zip.format == "vtu_zip"
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = set(zf.namelist())
        assert "series.pvd" in names
        pvd_root = ET.fromstring(zf.read("series.pvd"))
        datasets = pvd_root.findall("./Collection/DataSet")
        assert len(datasets) == 6
        for ds in datasets:
            rel_file = ds.attrib["file"]
            assert rel_file in names
            vtu_root = ET.fromstring(zf.read(rel_file))
            piece = vtu_root.find("./UnstructuredGrid/Piece")
            assert piece is not None
            assert piece.attrib["NumberOfPoints"] == "4"
            assert piece.attrib["NumberOfCells"] == "1"


def test_vtk_writer_vtu_and_pvd_directory_roundtrip(tmp_path: Path) -> None:
    pts = np.array([[0.0, 0.0, 0.0], [1e-8, 0.0, 0.0], [0.0, 1e-8, 0.0], [0.0, 0.0, 1e-8]])
    cells = np.array([[0, 1, 2, 3]], dtype=np.int32)
    vecs = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]])
    rgb_u8 = np.array([[255, 0, 0], [128, 255, 0], [255, 255, 255], [0, 0, 0]], dtype=np.uint8)

    vtu_bin = tmp_path / "tet_bin.vtu"
    vtu_asc = tmp_path / "tet_asc.vtu"
    export_vtu(
        vtu_bin,
        points_m=pts,
        cells=cells,
        cell_types="tet4",
        point_data={"m": vecs, "magnetic_texture_rgb": rgb_u8},
        encoding="binary",
    )
    export_vtu(
        vtu_asc,
        points_m=pts,
        cells=cells,
        cell_types=10,
        point_data={"m": vecs, "magnetic_texture_rgb": rgb_u8},
        encoding="ascii",
    )

    root_bin = ET.fromstring(vtu_bin.read_text(encoding="utf-8"))
    assert root_bin.attrib["type"] == "UnstructuredGrid"
    pts_elem = root_bin.find("./UnstructuredGrid/Piece/Points/DataArray")
    assert pts_elem is not None
    decoded_pts = _decode_vtk_binary_data_array(pts_elem, root_bin.attrib["header_type"])
    np.testing.assert_allclose(decoded_pts, pts, atol=1e-18)

    rgb_elem = root_bin.find("./UnstructuredGrid/Piece/PointData/DataArray[@Name='magnetic_texture_rgb']")
    assert rgb_elem is not None
    assert rgb_elem.attrib["type"] == "UInt8"
    assert rgb_elem.attrib["NumberOfComponents"] == "3"
    np.testing.assert_array_equal(_decode_vtk_binary_data_array(rgb_elem), rgb_u8)

    types_elem = root_bin.find("./UnstructuredGrid/Piece/Cells/DataArray[@Name='types']")
    assert types_elem is not None
    np.testing.assert_array_equal(_decode_vtk_binary_data_array(types_elem), [10])

    # Check ASCII VTU also parses cleanly
    root_asc = ET.fromstring(vtu_asc.read_text(encoding="utf-8"))
    assert root_asc.find("./UnstructuredGrid/Piece").attrib["NumberOfCells"] == "1"  # type: ignore[union-attr]

    # Check PVD sidecar directory export
    pvd_path = tmp_path / "run_series.pvd"
    export_pvd(
        pvd_path,
        [
            {"timestep": 0.0, "points_m": pts, "cells": cells, "cell_types": "tet4", "point_data": {"m": vecs}},
            {"timestep": 1e-9, "points_m": pts, "cells": cells, "cell_types": "tet4", "point_data": {"m": -vecs}},
        ],
    )
    assert pvd_path.is_file()
    pvd_root = ET.fromstring(pvd_path.read_text(encoding="utf-8"))
    ds = pvd_root.findall("./Collection/DataSet")
    assert len(ds) == 2
    for entry in ds:
        assert (pvd_path.parent / entry.attrib["file"]).is_file()


def test_export_result_bundle_3d_fdm_fem_and_eigenmode(tmp_path: Path) -> None:
    # 1. FDM playback.json + Zarr v2 bundle
    fdm_dir = tmp_path / "fdm_bundle"
    arr_dir = fdm_dir / "stages" / "relax" / "fields" / "m"
    arr_dir.mkdir(parents=True)
    # 2 frames, 2 cells (2x1x1) -> shape [2, 6]
    zarray = {
        "zarr_format": 2,
        "shape": [2, 6],
        "chunks": [1, 6],
        "dtype": "<f8",
        "compressor": None,
        "fill_value": 0.0,
        "order": "C",
        "filters": None,
        "dimension_separator": ".",
    }
    (arr_dir / ".zarray").write_text(json.dumps(zarray), encoding="utf-8")
    np.array([1.0, 0.0, 0.0, 0.0, 1.0, 0.0], dtype="<f8").tofile(arr_dir / "0.0")
    np.array([0.0, 0.0, 1.0, 0.0, 0.0, -1.0], dtype="<f8").tofile(arr_dir / "1.0")
    (fdm_dir / "playback.json").write_text(
        json.dumps(
            {
                "schema": "fullmag.saved_playback.v1",
                "complete": True,
                "name": "FDM synthetic playback",
                "grid_cells_xyz": [2, 1, 1],
                "cell_size_m": [2e-9, 2e-9, 2e-9],
                "origin_m": [0.0, 0.0, 0.0],
                "stages": [
                    {
                        "stage_id": "relax",
                        "array_path": "stages/relax/fields/m",
                        "times_s": [0.0, 1e-9],
                        "quantity_ids": ["m"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    fdm_glb = tmp_path / "fdm_bundle.glb"
    res_fdm = export_result_bundle_3d(fdm_dir, fdm_glb, include_arrows=True)
    assert res_fdm.frame_count == 2
    assert res_fdm.cell_count == 2
    doc_fdm, _ = _parse_glb(fdm_glb)
    assert len([m for m in doc_fdm["meshes"] if m["name"].startswith("surface_frame_mesh_")]) == 2  # type: ignore[index]

    # 2. FEM playback.json + geometry.json + soa_component_major rank-3 Zarr v2
    fem_dir = tmp_path / "fem_bundle"
    fem_arr_dir = fem_dir / "fixture.zarr" / "stages" / "stage_0000_propagate" / "fields" / "m"
    fem_arr_dir.mkdir(parents=True)
    geom_json = {
        "schema_version": "fullmag.fem_p1_field_geometry.v1",
        "coordinate_unit": "m",
        "representation_evidence": "not_verified",
        "mesh": {
            "mesh_name": "two-tet",
            "nodes": [
                [0.0, 0.0, 0.0],
                [5e-9, 0.0, 0.0],
                [0.0, 5e-9, 0.0],
                [0.0, 0.0, 5e-9],
                [0.0, 0.0, -5e-9],
            ],
            "cells": {
                "types": ["tet4", "tet4"],
                "offsets": [0, 4, 8],
                "nodes": [0, 1, 2, 3, 0, 2, 1, 4],
            },
            "element_markers": [1, 0],
            "facets": {
                "types": ["tri3"],
                "roles": ["exterior"],
                "offsets": [0, 3],
                "nodes": [0, 1, 2],
            },
            "boundary_markers": [1],
        },
        "field_semantics": {
            "format": "fullmag.fem_p1_magnetization_field_semantics.v1",
            "producer_id": "test",
            "producer_version": "1",
            "active_node_mask": [True, True, True, True, False],
            "descriptor": {},
        },
    }
    (fem_dir / "geometry.json").write_text(json.dumps(geom_json), encoding="utf-8")
    (fem_arr_dir / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [2, 3, 5],
                "chunks": [1, 3, 5],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": 0.0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            }
        ),
        encoding="utf-8",
    )
    # Component-major [3, 5] frames; inactive node 4 carries 1e6 sentinel values
    f0 = np.array(
        [
            [1.0, 1.0, 0.0, 0.0, 1e6],
            [0.0, 0.0, 1.0, 0.0, -2e6],
            [0.0, 0.0, 0.0, 1.0, 3e6],
        ],
        dtype="<f8",
    )
    f1 = -f0
    f0.tofile(fem_arr_dir / "0.0.0")
    f1.tofile(fem_arr_dir / "1.0.0")
    (fem_dir / "playback.json").write_text(
        json.dumps(
            {
                "schema": "fullmag.saved_playback.v1",
                "complete": True,
                "name": "FEM synthetic playback",
                "fem_mesh": {
                    "geometry_path": "geometry.json",
                    "geometry_sha256": "a" * 64,
                },
                "stages": [
                    {
                        "stage_id": "propagate",
                        "array_path": "fixture.zarr/stages/stage_0000_propagate/fields/m",
                        "times_s": [0.0, 2e-9],
                        "quantity_ids": ["m"],
                        "field_layout": "soa_component_major",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    fem_vtu = tmp_path / "fem_frame0.vtu"
    res_fem_vtu = export_result_bundle_3d(fem_dir, fem_vtu, frame_index=-1)
    assert res_fem_vtu.vertex_count == 4
    assert res_fem_vtu.cell_count == 1
    vtu_root = ET.fromstring(fem_vtu.read_text(encoding="utf-8"))
    m_elem = vtu_root.find("./UnstructuredGrid/Piece/PointData/DataArray[@Name='m']")
    assert m_elem is not None
    m_vals = _decode_vtk_binary_data_array(m_elem)
    assert np.max(np.abs(m_vals)) <= 1.0 + 1e-12

    # 3. Eigenmode artifact bundle (vector.bin + geometry.json)
    eig_dir = tmp_path / "eigen_bundle"
    (eig_dir / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (eig_dir / "eigen" / "mode_fields" / "sample_0000" / "mode_0000").mkdir(parents=True)
    (eig_dir / "geometry.json").write_text(json.dumps(geom_json), encoding="utf-8")
    (eig_dir / "eigen" / "modes" / "sample_0000" / "mode_0000.json").write_text(
        json.dumps(
            {
                "mode_field_id": "sample_0000_mode_0000",
                "frequency_hz": 5.4e9,
                "phasor_convention": "exp_i_omega_t",
                "k_vector": [2e7, 0.0, 0.0],
                "compatibility_binary_payload_path": "eigen/mode_fields/sample_0000/mode_0000/vector.bin",
            }
        ),
        encoding="utf-8",
    )
    paired = np.zeros((5, 3, 2), dtype="<f8")
    paired[:4, 0, 0] = 1.0
    paired[:4, 1, 1] = 1.0
    paired.tofile(eig_dir / "eigen" / "mode_fields" / "sample_0000" / "mode_0000" / "vector.bin")

    eig_glb = tmp_path / "eigen_mode.glb"
    res_eig = export_result_bundle_3d(eig_dir, eig_glb, phase_steps=8, surface_displacement_scale=0.1)
    assert res_eig.frame_count == 8
    assert res_eig.metadata["frequency_hz"] == pytest.approx(5.4e9)
    doc_eig, _ = _parse_glb(eig_glb)
    assert doc_eig["asset"]["extras"]["fullmag"]["animation_kind"] == "phase_cycle"  # type: ignore[index]


def test_export_mesh_3d_with_meshdata_and_cell_values(tmp_path: Path) -> None:
    # Construct canonical MeshData (single tetrahedron) with cell-centered scalar field
    mesh = MeshData(
        nodes=np.array([[0.0, 0.0, 0.0], [1e-8, 0.0, 0.0], [0.0, 1e-8, 0.0], [0.0, 0.0, 1e-8]]),
        cell_types=np.array(["tet4"]),
        cell_offsets=np.array([0, 4], dtype=np.int64),
        cell_nodes=np.array([0, 1, 2, 3], dtype=np.int32),
        element_markers=np.array([1], dtype=np.uint32),
        facet_types=np.array(["tri3", "tri3", "tri3", "tri3"]),
        facet_roles=np.array(["exterior", "exterior", "exterior", "exterior"]),
        facet_offsets=np.array([0, 3, 6, 9, 12], dtype=np.int64),
        facet_nodes=np.array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3], dtype=np.int32),
        boundary_markers=np.array([1, 1, 1, 1], dtype=np.uint32),
        cell_global_ordinals=np.array([0], dtype=np.int64),
        facet_global_ordinals=np.array([0, 1, 2, 3], dtype=np.int64),
    )
    glb_path = tmp_path / "meshdata_cell.glb"
    res = export_mesh_3d(
        glb_path,
        np.array([0.75]),
        mesh=mesh,
        color_palette="coolwarm",
        quantity_id="energy_density",
    )
    assert res.cell_count == 1
    assert res.vertex_count == 12  # 4 surface triangles * 3 expanded vertices for crisp cell color
    doc, _ = _parse_glb(glb_path)
    assert doc["asset"]["extras"]["fullmag"]["field_location"] == "cell"  # type: ignore[index]


def test_voxel_mask_data_hexahedra_vtu_and_large_uint32_glb(tmp_path: Path) -> None:
    from fullmag.meshing import VoxelMaskData

    mask_zyx = np.zeros((2, 2, 2), dtype=bool)
    mask_zyx[0, :, :] = True
    mask_zyx[1, 0, 0] = True  # 5 active cells
    vmask = VoxelMaskData(mask=mask_zyx, cell_size=(2e-9, 2e-9, 2e-9), origin=(0.0, 0.0, 0.0))

    scalars = np.arange(8, dtype=np.float64) * 0.25
    vtu_path = tmp_path / "voxel_hex.vtu"
    res_vtu = export_grid_3d(
        vtu_path,
        scalars,
        active_mask=vmask,
        quantity_id="phi_m",
        color_palette="plasma",
    )
    assert res_vtu.cell_count == 5
    root = ET.fromstring(vtu_path.read_text(encoding="utf-8"))
    types_elem = root.find("./UnstructuredGrid/Piece/Cells/DataArray[@Name='types']")
    assert types_elem is not None
    np.testing.assert_array_equal(_decode_vtk_binary_data_array(types_elem), [12] * 5)

    # Verify >= 65535 vertices automatically selects UNSIGNED_INT (5125) indices in GLB
    n_verts = 65540
    large_pos = np.zeros((n_verts, 3), dtype=np.float64)
    large_pos[:, 0] = np.linspace(0.0, 1.0, n_verts)
    large_idx = np.array([[0, 1, 65539]], dtype=np.uint32)
    large_glb = tmp_path / "large_u32.glb"
    export_glb(large_glb, positions_m=large_pos, indices=large_idx)
    doc_u32, _ = _parse_glb(large_glb)
    idx_acc = doc_u32["accessors"][doc_u32["meshes"][0]["primitives"][0]["indices"]]  # type: ignore[index]
    assert idx_acc["componentType"] == 5125


def test_surface_triangles_cell_arrows_prism6_and_static_morph(tmp_path: Path) -> None:
    # Surface-only triangles with cell-centered vectors + arrows
    nodes = np.array(
        [[0.0, 0.0, 0.0], [1e-8, 0.0, 0.0], [1e-8, 1e-8, 0.0], [0.0, 1e-8, 0.0]],
        dtype=np.float64,
    )
    tris = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32)
    cell_vecs = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], dtype=np.float64)
    surf_glb = tmp_path / "surf_cell_arrows.glb"
    res_surf = export_mesh_3d(
        surf_glb,
        cell_vecs,
        nodes=nodes,
        triangles=tris,
        include_arrows=True,
        max_arrows=8,
    )
    assert res_surf.arrow_count == 2

    # Prism6 mesh VTU (type=13) + static mode morph weights=[1.0, 0.0]
    p_nodes = np.array(
        [
            [0.0, 0.0, 0.0],
            [1e-8, 0.0, 0.0],
            [0.0, 1e-8, 0.0],
            [0.0, 0.0, 5e-9],
            [1e-8, 0.0, 5e-9],
            [0.0, 1e-8, 5e-9],
        ],
        dtype=np.float64,
    )
    p_cells = np.array([[0, 1, 2, 3, 4, 5]], dtype=np.int32)
    re = np.tile(np.array([[0.0, 0.0, 1.0]]), (6, 1))
    im = np.tile(np.array([[1.0, 0.0, 0.0]]), (6, 1))

    prism_vtu = tmp_path / "prism.vtu"
    export_mesh_3d(prism_vtu, re, nodes=p_nodes, cells=p_cells, cell_types="prism6")
    prism_root = ET.fromstring(prism_vtu.read_text(encoding="utf-8"))
    prism_types = prism_root.find("./UnstructuredGrid/Piece/Cells/DataArray[@Name='types']")
    assert prism_types is not None
    np.testing.assert_array_equal(_decode_vtk_binary_data_array(prism_types), [13])

    static_mode_glb = tmp_path / "static_morph.glb"
    export_mode_animation_3d(
        static_mode_glb,
        real=re,
        imag=im,
        nodes=p_nodes,
        cells=p_cells,
        cell_types="prism6",
        phase_steps=1,
        surface_displacement_scale=0.2,
    )
    doc_sm, _ = _parse_glb(static_mode_glb)
    assert doc_sm["meshes"][0]["weights"] == [1.0, 0.0]  # type: ignore[index]


def test_export_result_bundle_3d_compressed_zarr_and_eigen_zarr(tmp_path: Path) -> None:
    zarr = pytest.importorskip("zarr")

    # Test compressed Zarr array read via zarr package inside playback.json bundle
    comp_dir = tmp_path / "compressed_fdm"
    arr_path = comp_dir / "stages" / "run" / "fields" / "m"
    arr_path.parent.mkdir(parents=True)
    data = np.array(
        [
            [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            [0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    z = zarr.open(str(arr_path), mode="w", shape=data.shape, chunks=(1, 6), dtype="f8")
    z[:] = data
    (comp_dir / "playback.json").write_text(
        json.dumps(
            {
                "schema": "fullmag.saved_playback.v1",
                "complete": True,
                "name": "Compressed Zarr FDM",
                "grid_cells_xyz": [2, 1, 1],
                "cell_size_m": [2e-9, 2e-9, 2e-9],
                "origin_m": [0.0, 0.0, 0.0],
                "stages": [
                    {
                        "stage_id": "run",
                        "array_path": "stages/run/fields/m",
                        "times_s": [0.0, 1e-9],
                        "quantity_ids": ["m"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    out_glb = tmp_path / "compressed_fdm.glb"
    res = export_result_bundle_3d(comp_dir, out_glb)
    assert res.frame_count == 2

    # Test eigenmode Zarr array (vector_xyz_complex)
    eig_z_dir = tmp_path / "eigen_zarr_bundle"
    (eig_z_dir / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    vec_zarr_path = (
        eig_z_dir / "eigen" / "mode_fields.zarr" / "sample_0000" / "mode_0000" / "vector_xyz_complex"
    )
    vec_zarr_path.mkdir(parents=True)
    (eig_z_dir / "eigen" / "modes" / "sample_0000" / "mode_0000.json").write_text(
        json.dumps(
            {
                "mode_field_id": "sample_0000_mode_0000",
                "frequency_hz": 3.1e9,
                "phasor_convention": "exp_i_omega_t",
                "k_vector": [0.0, 0.0, 0.0],
            }
        ),
        encoding="utf-8",
    )
    (vec_zarr_path / ".zarray").write_text(
        json.dumps(
            {
                "zarr_format": 2,
                "shape": [2, 3, 2],
                "chunks": [2, 3, 2],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": 0.0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            }
        ),
        encoding="utf-8",
    )
    complex_payload = np.array(
        [
            [[1.0, 0.0], [0.0, 1.0], [0.0, 0.0]],
            [[0.0, 1.0], [1.0, 0.0], [0.0, 0.0]],
        ],
        dtype="<f8",
    )
    complex_payload.tofile(vec_zarr_path / "0.0.0")
    out_eig_pvd = tmp_path / "eigen_fdm.pvd"
    res_eig_pvd = export_result_bundle_3d(
        eig_z_dir,
        out_eig_pvd,
        grid_shape=(2, 1, 1),
        cell_size_m=(2e-9, 2e-9, 2e-9),
        phase_steps=4,
    )
    assert res_eig_pvd.frame_count == 4
    assert out_eig_pvd.is_file()

