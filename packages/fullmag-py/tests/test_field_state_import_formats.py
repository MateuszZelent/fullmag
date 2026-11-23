"""Tests for Task 3A: OVF 1.0/2.0 & NPZ field-state imports and trilinear antipodal fallback."""

from __future__ import annotations

import math
import struct
from pathlib import Path

import numpy as np
import pytest

from fullmag.init.state_io import (
    FieldState,
    load_field_state,
    load_magnetization,
    parse_ovf_bytes,
    resample_imported_field,
    save_ovf,
)


def _make_ovf1_binary4_be(
    nx: int,
    ny: int,
    nz: int,
    dx: float,
    dy: float,
    dz: float,
    vectors: list[tuple[float, float, float]],
    *,
    value_multiplier: float = 1.0,
) -> bytes:
    header = "\n".join(
        [
            "# OOMMF: rectangular mesh v1.0",
            "# Segment count: 1",
            "# Begin: Segment",
            "# Begin: Header",
            "# Title: test_ovf1",
            "# meshtype: rectangular",
            "# meshunit: m",
            "# xmin: 0",
            "# ymin: 0",
            "# zmin: 0",
            f"# xmax: {nx * dx}",
            f"# ymax: {ny * dy}",
            f"# zmax: {nz * dz}",
            f"# xstepsize: {dx}",
            f"# ystepsize: {dy}",
            f"# zstepsize: {dz}",
            f"# xnodes: {nx}",
            f"# ynodes: {ny}",
            f"# znodes: {nz}",
            f"# valuemultiplier: {value_multiplier}",
            "# End: Header",
            "# Begin: Data Binary 4",
        ]
    ).encode("ascii") + b"\n"
    payload = bytearray(struct.pack(">f", 1234567.0))
    for vx, vy, vz in vectors:
        payload.extend(struct.pack(">3f", vx, vy, vz))
    trailer = b"\n# End: Data Binary 4\n# End: Segment\n"
    return header + bytes(payload) + trailer


def test_ovf2_binary4_and_npz_roundtrip(tmp_path: Path) -> None:
    nx, ny, nz = 3, 2, 1
    dx, dy, dz = 5e-9, 5e-9, 5e-9
    # Canonical x-fastest loop order: idx = x + nx * (y + ny * z)
    vectors = [
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
        (-1.0, 0.0, 0.0),
        (0.0, -1.0, 0.0),
        (0.0, 0.0, -1.0),
    ]

    # 1. OVF 2.0 Binary 4 roundtrip
    ovf_bin4 = tmp_path / "state_bin4.ovf"
    save_ovf(
        ovf_bin4,
        vectors,
        grid_shape=(nx, ny, nz),
        grid_spacing=(dx, dy, dz),
        grid_origin=(0.0, 0.0, 0.0),
        encoding="binary4",
    )
    loaded_bin4 = load_field_state(ovf_bin4)
    assert loaded_bin4.source_format == "ovf"
    assert loaded_bin4.grid_shape == (nx, ny, nz)
    assert loaded_bin4.grid_spacing == pytest.approx((dx, dy, dz))
    np.testing.assert_allclose(loaded_bin4.values, vectors, atol=1e-6)

    # Also test load_magnetization directly on OVF
    loaded_mag = load_magnetization(ovf_bin4)
    assert loaded_mag.source_format == "ovf"
    np.testing.assert_allclose(loaded_mag.values, vectors, atol=1e-6)

    # 2. OVF 2.0 Binary 8 & Text roundtrip
    ovf_bin8 = tmp_path / "state_bin8.ovf"
    save_ovf(
        ovf_bin8,
        vectors,
        grid_shape=(nx, ny, nz),
        grid_spacing=(dx, dy, dz),
        encoding="binary8",
    )
    loaded_bin8 = load_field_state(ovf_bin8)
    np.testing.assert_allclose(loaded_bin8.values, vectors, atol=1e-15)

    ovf_text = tmp_path / "state_text.ovf"
    save_ovf(
        ovf_text,
        vectors,
        grid_shape=(nx, ny, nz),
        grid_spacing=(dx, dy, dz),
        encoding="text",
    )
    loaded_text = load_field_state(ovf_text)
    np.testing.assert_allclose(loaded_text.values, vectors, atol=1e-12)

    # 3. OVF 1.0 big-endian Binary 4 with valuemultiplier
    ovf1_bytes = _make_ovf1_binary4_be(
        nx,
        ny,
        nz,
        dx,
        dy,
        dz,
        [(0.5 * x, 0.5 * y, 0.5 * z) for (x, y, z) in vectors],
        value_multiplier=2.0,
    )
    parsed_ovf1 = parse_ovf_bytes(ovf1_bytes)
    assert parsed_ovf1.grid_shape == (nx, ny, nz)
    np.testing.assert_allclose(parsed_ovf1.values, vectors, atol=1e-6)

    # 4. NPZ 4D structured [Nz, Ny, Nx, 3] roundtrip (allow_pickle=False)
    npz_path = tmp_path / "state.npz"
    arr_4d = np.asarray(vectors, dtype=np.float64).reshape((nz, ny, nx, 3))
    np.savez(
        npz_path,
        m=arr_4d,
        origin=np.array([0.0, 0.0, 0.0]),
        spacing=np.array([dx, dy, dz]),
    )
    loaded_npz = load_field_state(npz_path)
    assert loaded_npz.source_format == "npz"
    assert loaded_npz.grid_shape == (nx, ny, nz)
    assert loaded_npz.grid_spacing == pytest.approx((dx, dy, dz))
    np.testing.assert_allclose(loaded_npz.values, vectors, atol=1e-15)


def test_trilinear_antipodal_wall_midpoint_falls_back_to_unit_nearest() -> None:
    """Review Focus #4: 2x1x1 grid with [0,0,1] and [0,0,-1] sampled at exact midpoint
    must NEVER yield NaN or zero — it deterministically falls back to unit Nearest."""
    source = FieldState(
        values=[(0.0, 0.0, 1.0), (0.0, 0.0, -1.0)],
        quantity_id="m",
        target_kind="object",
        target_id="bar",
        units="1",
        source_path=None,
        source_format="ovf",
        dataset=None,
        sample_index=None,
        grid_shape=(2, 1, 1),
        grid_origin=(0.0, 0.0, 0.0),
        grid_spacing=(10e-9, 10e-9, 10e-9),
    )

    # Cell 0 center = (5nm, 5nm, 5nm), Cell 1 center = (15nm, 5nm, 5nm).
    # Exact midpoint = (10nm, 5nm, 5nm) -> trilinear sum is 0.5*[0,0,1] + 0.5*[0,0,-1] = [0,0,0].
    target_points = np.array(
        [
            [5e-9, 5e-9, 5e-9],
            [10e-9, 5e-9, 5e-9],
            [15e-9, 5e-9, 5e-9],
        ],
        dtype=np.float64,
    )
    resampled = resample_imported_field(source, target_points, interpolation="trilinear")
    assert resampled.shape == (3, 3)
    assert np.all(np.isfinite(resampled))

    np.testing.assert_allclose(resampled[0], [0.0, 0.0, 1.0], atol=1e-12)
    np.testing.assert_allclose(resampled[2], [0.0, 0.0, -1.0], atol=1e-12)

    midpoint_vec = resampled[1]
    midpoint_norm = float(np.linalg.norm(midpoint_vec))
    assert math.isfinite(midpoint_norm)
    assert abs(midpoint_norm - 1.0) < 1e-12

    # Must match deterministic Nearest fallback identically
    nearest = resample_imported_field(source, target_points, interpolation="nearest")
    np.testing.assert_allclose(midpoint_vec, nearest[1], atol=1e-12)


def test_exact_interpolation_rejects_same_vector_count_3d_shape_mismatch() -> None:
    """P0 regression: a 4x2x1 source grid (8 vectors) must never silently copy
    into a 2x2x2 target grid (8 vectors) in exact mode."""
    vectors = [(1.0, 0.0, 0.0) if i < 4 else (0.0, 1.0, 0.0) for i in range(8)]
    source = FieldState(
        values=vectors,
        quantity_id="m",
        target_kind="object",
        target_id="bar",
        units="1",
        source_path=None,
        source_format="ovf",
        dataset=None,
        sample_index=None,
        grid_shape=(4, 2, 1),
        grid_origin=(0.0, 0.0, 0.0),
        grid_spacing=(5e-9, 5e-9, 5e-9),
    )
    dummy_pts = np.zeros((8, 3), dtype=np.float64)

    with pytest.raises(ValueError, match="grid mismatch"):
        resample_imported_field(
            source,
            dummy_pts,
            interpolation="exact",
            target_grid_shape=(2, 2, 2),
        )

    exact_ok = resample_imported_field(
        source,
        dummy_pts,
        interpolation="exact",
        target_grid_shape=(4, 2, 1),
    )
    np.testing.assert_allclose(exact_ok, vectors, atol=1e-15)


def test_nearest_and_trilinear_sample_cropped_and_shifted_target_coordinates() -> None:
    """P0 regression: shifted/cropped targets must sample at their actual physical
    cell coordinates mapped into source origin/spacing, not stretched source bounds."""
    # Source: 4x1x1 grid spanning x in [0, 40nm] with dx = 10nm (centers at 5, 15, 25, 35 nm)
    source = FieldState(
        values=[
            (1.0, 0.0, 0.0),
            (0.0, 1.0, 0.0),
            (0.0, 0.0, 1.0),
            (-1.0, 0.0, 0.0),
        ],
        quantity_id="m",
        target_kind="object",
        target_id="bar",
        units="1",
        source_path=None,
        source_format="ovf",
        dataset=None,
        sample_index=None,
        grid_shape=(4, 1, 1),
        grid_origin=(0.0, 0.0, 0.0),
        grid_spacing=(10e-9, 10e-9, 10e-9),
    )

    # Cropped + shifted 2x1x1 target grid: origin = (20nm, 0, 0), dx = 10nm -> centers at 25nm, 35nm
    shifted_target_pts = np.array(
        [
            [25e-9, 5e-9, 5e-9],
            [35e-9, 5e-9, 5e-9],
        ],
        dtype=np.float64,
    )
    nearest_out = resample_imported_field(source, shifted_target_pts, interpolation="nearest")
    trilinear_out = resample_imported_field(source, shifted_target_pts, interpolation="trilinear")

    expected_right_half = np.array([[0.0, 0.0, 1.0], [-1.0, 0.0, 0.0]], dtype=np.float64)
    np.testing.assert_allclose(nearest_out, expected_right_half, atol=1e-12)
    np.testing.assert_allclose(trilinear_out, expected_right_half, atol=1e-12)


def test_source_bbox_overlap_validation_and_explicit_origin_override(tmp_path: Path) -> None:
    """W5 fix: disjoint source/target bboxes fail loudly, partial Mumax3 [0, L] vs centered
    [-L/2, L/2] warns clearly, and explicit source_origin aligns cleanly without warning."""
    ovf_path = tmp_path / "mumax_uncentered.ovf"
    vectors = [
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
        (-1.0, 0.0, 0.0),
    ]
    # Mumax3-style [0, 40nm] x [0, 10nm] x [0, 10nm] grid
    save_ovf(
        ovf_path,
        vectors,
        grid_shape=(4, 1, 1),
        grid_spacing=(10e-9, 10e-9, 10e-9),
        grid_origin=(0.0, 0.0, 0.0),
        encoding="binary4",
    )
    loaded = load_field_state(ovf_path)
    assert loaded.origin_explicit is True

    # 1. Completely disjoint target domain -> hard ValueError
    disjoint_pts = np.array([[100e-9, 5e-9, 5e-9], [110e-9, 5e-9, 5e-9]], dtype=np.float64)
    with pytest.raises(ValueError, match="does not overlap"):
        resample_imported_field(loaded, disjoint_pts, interpolation="trilinear")

    # 2. Centered [-20nm, +20nm] target partially outside [0, 40nm] -> clear UserWarning
    centered_pts = np.array(
        [
            [-15e-9, 0.0, 0.0],
            [-5e-9, 0.0, 0.0],
            [5e-9, 0.0, 0.0],
            [15e-9, 0.0, 0.0],
        ],
        dtype=np.float64,
    )
    with pytest.warns(UserWarning, match="outside source grid bounds"):
        resample_imported_field(loaded, centered_pts, interpolation="trilinear")

    # 3. Explicit source_origin override maps [-20nm, +20nm] cleanly with zero warnings
    loaded_centered = load_field_state(
        ovf_path, source_origin=(-20e-9, -5e-9, -5e-9)
    )
    import warnings as _warnings

    with _warnings.catch_warnings(record=True) as caught:
        _warnings.simplefilter("always")
        aligned = resample_imported_field(
            loaded_centered, centered_pts, interpolation="trilinear"
        )
    assert len(caught) == 0
    np.testing.assert_allclose(aligned, np.asarray(vectors, dtype=np.float64), atol=1e-6)


def test_nearest_nonzero_cell_expands_beyond_3x3x3_and_never_returns_zero() -> None:
    """W5 fix: active target cells >2 cells away from nonzero source islands or on all-zero
    grids must NEVER receive |m| = 0."""
    # 6x1x1 grid where ONLY cell 5 (x=55nm) is nonzero; cell 0 (x=5nm) is 5 cells away!
    sparse_vectors = [
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
    ]
    sparse_state = FieldState(
        values=sparse_vectors,
        quantity_id="m",
        target_kind="object",
        target_id="island",
        units="1",
        source_path=None,
        source_format="ovf",
        dataset=None,
        sample_index=None,
        grid_shape=(6, 1, 1),
        grid_origin=(0.0, 0.0, 0.0),
        grid_spacing=(10e-9, 10e-9, 10e-9),
    )
    far_pt = np.array([[5e-9, 5e-9, 5e-9]], dtype=np.float64)
    for mode in ("nearest", "trilinear"):
        out = resample_imported_field(sparse_state, far_pt, interpolation=mode)
        np.testing.assert_allclose(out[0], [0.0, 1.0, 0.0], atol=1e-12)
        assert abs(float(np.linalg.norm(out[0])) - 1.0) < 1e-12

    # Pathological all-zero source grid still yields deterministic unit fallback (0, 0, 1)
    all_zero_state = FieldState(
        values=[(0.0, 0.0, 0.0), (0.0, 0.0, 0.0)],
        quantity_id="m",
        target_kind="object",
        target_id="empty",
        units="1",
        source_path=None,
        source_format="ovf",
        dataset=None,
        sample_index=None,
        grid_shape=(2, 1, 1),
        grid_origin=(0.0, 0.0, 0.0),
        grid_spacing=(10e-9, 10e-9, 10e-9),
    )
    for mode in ("nearest", "trilinear"):
        out_zero = resample_imported_field(all_zero_state, far_pt, interpolation=mode)
        np.testing.assert_allclose(out_zero[0], [0.0, 0.0, 1.0], atol=1e-12)


def test_valuedim_normalize_and_npz_4d_axis_order_validation(tmp_path: Path) -> None:
    """W5 fix: scalar valuedim=1 is inspected cleanly but rejected for magnetization,
    normalize=True/False works consistently, and NPZ [Nx,Ny,Nz,3] transpose ambiguity is caught."""
    # 1. Scalar valuedim=1 OVF loads via load_field_state, rejected for magnetization
    scalar_ovf = tmp_path / "scalar.ovf"
    save_ovf(
        scalar_ovf,
        [(2.5,), (-1.5,)],
        grid_shape=(2, 1, 1),
        grid_spacing=(5e-9, 5e-9, 5e-9),
        encoding="text",
    )
    scalar_state = load_field_state(scalar_ovf)
    assert scalar_state.component_count == 1
    assert scalar_state.quantity_id == "scalar"
    with pytest.raises(ValueError, match="valuedim=3"):
        load_magnetization(scalar_ovf)
    with pytest.raises(ValueError, match="valuedim=3"):
        resample_imported_field(scalar_state, [[2.5e-9, 2.5e-9, 2.5e-9]])

    # 2. normalize=True vs normalize=False across exact and trilinear (e.g. OOMMF A/m vectors)
    unnorm = FieldState(
        values=[(8.0e5, 0.0, 0.0), (0.0, 8.0e5, 0.0)],
        quantity_id="m",
        target_kind="object",
        target_id="bar",
        units="A/m",
        source_path=None,
        source_format="ovf",
        dataset=None,
        sample_index=None,
        grid_shape=(2, 1, 1),
        grid_origin=(0.0, 0.0, 0.0),
        grid_spacing=(10e-9, 10e-9, 10e-9),
    )
    pts = np.array([[5e-9, 5e-9, 5e-9], [15e-9, 5e-9, 5e-9]], dtype=np.float64)
    np.testing.assert_allclose(
        resample_imported_field(unnorm, pts, interpolation="exact", normalize=True),
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        atol=1e-12,
    )
    np.testing.assert_allclose(
        resample_imported_field(unnorm, pts, interpolation="trilinear", normalize=False),
        [[8.0e5, 0.0, 0.0], [0.0, 8.0e5, 0.0]],
        atol=1e-6,
    )

    # 3. NPZ 4D [Nx, Ny, Nz, 3] with grid_shape=[Nx, Ny, Nz] (Nx != Nz) rejects silent transpose
    nx, ny, nz = 3, 2, 1
    arr_xyz = np.zeros((nx, ny, nz, 3), dtype=np.float64)
    for ix in range(nx):
        for iy in range(ny):
            arr_xyz[ix, iy, 0] = (float(ix + 1), float(iy + 1), 0.0)

    ambiguous_npz = tmp_path / "ambiguous_xyz.npz"
    np.savez(
        ambiguous_npz,
        m=arr_xyz,
        grid_shape=np.array([nx, ny, nz]),
        origin=np.array([0.0, 0.0, 0.0]),
        spacing=np.array([5e-9, 5e-9, 5e-9]),
    )
    with pytest.raises(ValueError, match="axis_order='xyz'"):
        load_field_state(ambiguous_npz)

    # Explicit axis_order='xyz' transposes cleanly to canonical x-fastest ordering
    explicit_xyz_npz = tmp_path / "explicit_xyz.npz"
    np.savez(
        explicit_xyz_npz,
        m=arr_xyz,
        grid_shape=np.array([nx, ny, nz]),
        axis_order="xyz",
        origin=np.array([0.0, 0.0, 0.0]),
        spacing=np.array([5e-9, 5e-9, 5e-9]),
    )
    loaded_xyz = load_field_state(explicit_xyz_npz)
    assert loaded_xyz.grid_shape == (nx, ny, nz)
    # x=2, y=1, z=0 -> flat index 2 + 3*(1 + 2*0) = 5 -> (3.0, 2.0, 0.0)
    assert loaded_xyz.values[5] == pytest.approx((3.0, 2.0, 0.0))
