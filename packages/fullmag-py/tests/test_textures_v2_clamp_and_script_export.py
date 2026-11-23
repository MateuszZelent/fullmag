"""Tests for Task 2: v2 texture clamp_mode, rotate_vectors, region space, Wave-2 presets, and fluent script export."""

from __future__ import annotations

import math

import numpy as np
import pytest

import fullmag as fm
from fullmag.init.preset_eval_v2 import evaluate_preset_texture_v2
from fullmag.init.textures import PresetTexture, TextureMapping, TextureTransform3D, texture
from fullmag.runtime.initial_state import prepare_initial_magnetization
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import _render_preset_texture_expr


def test_clamp_modes_repeat_mirror_and_background_evaluate_accurately() -> None:
    period = (50e-9, 50e-9, 5e-9)
    base_preset = texture.bloch_skyrmion(radius=15e-9, wall_width=4e-9)

    # Periodic tiling ("repeat"): m(x + Px, y, z) == m(x, y, z)
    repeat_spec = base_preset.with_mapping(
        clamp_mode="repeat",
        tile_period=period,
    ).to_ir()
    pts_repeat = np.array(
        [
            [10e-9, -5e-9, 0.0],
            [10e-9 + 50e-9, -5e-9, 0.0],
            [10e-9 - 100e-9, -5e-9 + 50e-9, 0.0],
        ],
        dtype=np.float64,
    )
    vals_repeat = prepare_initial_magnetization(repeat_spec, pts_repeat)
    np.testing.assert_allclose(vals_repeat[1], vals_repeat[0], atol=1e-12)
    np.testing.assert_allclose(vals_repeat[2], vals_repeat[0], atol=1e-12)

    # Symmetric mirror tiling ("mirror"): coord=40nm with period=50nm folds to +10nm
    mirror_spec = base_preset.with_mapping(
        clamp_mode="mirror",
        tile_period=period,
    ).to_ir()
    pts_mirror = np.array(
        [
            [10e-9, 0.0, 0.0],
            [40e-9, 0.0, 0.0],
            [-40e-9, 0.0, 0.0],
            [-10e-9, 0.0, 0.0],
        ],
        dtype=np.float64,
    )
    vals_mirror = prepare_initial_magnetization(mirror_spec, pts_mirror)
    np.testing.assert_allclose(vals_mirror[1], vals_mirror[0], atol=1e-12)
    np.testing.assert_allclose(vals_mirror[2], vals_mirror[3], atol=1e-12)

    # Hard clamp ("clamp"): coord=80nm clamps to +25nm
    clamp_spec = base_preset.with_mapping(
        clamp_mode="clamp",
        tile_period=period,
    ).to_ir()
    pts_clamp = np.array(
        [
            [25e-9, 0.0, 0.0],
            [80e-9, 0.0, 0.0],
        ],
        dtype=np.float64,
    )
    vals_clamp = prepare_initial_magnetization(clamp_spec, pts_clamp)
    np.testing.assert_allclose(vals_clamp[1], vals_clamp[0], atol=1e-12)

    # Background ("background"): outside box returns normalized background_vector
    bg_spec = base_preset.with_mapping(
        clamp_mode="background",
        tile_period=period,
        background_vector=(0.0, 3.0, 4.0),
    ).to_ir()
    pts_bg = np.array(
        [
            [0.0, 0.0, 0.0],      # inside box -> skyrmion core (core_polarity=-1 => mz ≈ -1)
            [40e-9, 0.0, 0.0],    # outside box (|x| > 25nm) -> normalized (0, 0.6, 0.8)
        ],
        dtype=np.float64,
    )
    vals_bg = prepare_initial_magnetization(bg_spec, pts_bg)
    assert vals_bg[0, 2] < -0.99
    np.testing.assert_allclose(vals_bg[1], [0.0, 0.6, 0.8], atol=1e-12)


def test_space_only_rotation_keeps_domain_vectors_along_crystal_axis() -> None:
    # 1. Domain wall rotated 45 deg around Z with rotate_vectors=False:
    #    Wall plane is tilted 45 deg in XY, yet wall-center spin remains +Y (unrotated)
    #    and far-left domain remains +Z.
    wall_z_space_only = (
        texture.domain_wall(
            width=10e-9,
            kind="bloch",
            normal_axis="x",
            left=(0.0, 0.0, 1.0),
            right=(0.0, 0.0, -1.0),
        )
        .rotate_z_deg(45.0)
        .with_rotate_vectors(False)
    )
    wall_z_coupled = (
        texture.domain_wall(
            width=10e-9,
            kind="bloch",
            normal_axis="x",
            left=(0.0, 0.0, 1.0),
            right=(0.0, 0.0, -1.0),
        )
        .rotate_z_deg(45.0)
        .with_rotate_vectors(True)
    )
    # After R_z(+45 deg), x' = (x + y) / sqrt(2):
    # - point (-200nm, -200nm, 0) has x' = -282.8nm << 0 (far left domain, sech < 1e-12)
    # - point (-20nm, +20nm, 0) lies directly on the tilted wall center (x' = 0)
    # - point (+200nm, +200nm, 0) has x' = +282.8nm >> 0 (far right domain)
    pts_z = np.array(
        [
            [-200e-9, -200e-9, 0.0],
            [-20e-9, 20e-9, 0.0],
            [200e-9, 200e-9, 0.0],
        ],
        dtype=np.float64,
    )
    vals_space_only = prepare_initial_magnetization(wall_z_space_only.to_ir(), pts_z)
    vals_coupled = prepare_initial_magnetization(wall_z_coupled.to_ir(), pts_z)

    # For normal_axis="x" and left=(0,0,1), Bloch wall_center_direction = x cross z = (0, -1, 0).
    np.testing.assert_allclose(vals_space_only[0], [0.0, 0.0, 1.0], atol=1e-11)
    np.testing.assert_allclose(vals_space_only[1], [0.0, -1.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(vals_space_only[2], [0.0, 0.0, -1.0], atol=1e-11)

    # With rotate_vectors=True, the wall-center spin (-Y) rotates by +45 deg around Z to (+sqrt(2)/2, -sqrt(2)/2, 0)
    inv_sqrt2 = math.sqrt(0.5)
    np.testing.assert_allclose(vals_coupled[1], [inv_sqrt2, -inv_sqrt2, 0.0], atol=1e-12)

    # 2. Rotation around Y by 45 deg: far-left domain (+Z) stays +Z when rotate_vectors=False,
    #    but tilts to (+sqrt(2)/2, 0, +sqrt(2)/2) when rotate_vectors=True.
    wall_y_space_only = (
        texture.domain_wall(
            width=10e-9,
            kind="neel",
            normal_axis="x",
            left=(0.0, 0.0, 1.0),
            right=(0.0, 0.0, -1.0),
        )
        .rotate_y_deg(45.0)
        .with_rotate_vectors(False)
    )
    wall_y_coupled = (
        texture.domain_wall(
            width=10e-9,
            kind="neel",
            normal_axis="x",
            left=(0.0, 0.0, 1.0),
            right=(0.0, 0.0, -1.0),
        )
        .rotate_y_deg(45.0)
        .with_rotate_vectors(True)
    )
    pts_y = np.array([[-150e-9, 0.0, 150e-9]], dtype=np.float64)
    val_y_space = prepare_initial_magnetization(wall_y_space_only.to_ir(), pts_y)[0]
    val_y_coupled = prepare_initial_magnetization(wall_y_coupled.to_ir(), pts_y)[0]
    np.testing.assert_allclose(val_y_space, [0.0, 0.0, 1.0], atol=1e-6)
    np.testing.assert_allclose(val_y_coupled, [inv_sqrt2, 0.0, inv_sqrt2], atol=1e-6)


def test_script_builder_renders_fluent_fm_texture_calls_for_all_v2_presets() -> None:
    presets = [
        texture.antiskyrmion(radius=25e-9, wall_width=5e-9, chirality=1, core_polarity=-1),
        texture.skyrmionium(inner_radius=15e-9, outer_radius=35e-9, wall_width=4e-9, kind="neel"),
        texture.vortex_wall(wall_half_width=30e-9, left_mx=1.0, right_mx=-1.0, core_radius=5e-9),
        texture.hopfion(radius=20e-9, hopf_charge=1, background_sign=1, axial_scale=1.2, phase_rad=0.25),
        texture.hopfion_compact_support(major_radius=25e-9, minor_radius=10e-9),
        texture.skyrmion_lattice(lattice_constant=60e-9, radius=15e-9, wall_width=4e-9, lattice="hexagonal", kind="bloch"),
        texture.spiral(wavelength=80e-9, spiral_kind="cycloidal", propagation_axis=(1.0, 0.0, 0.0)),
        texture.bloch_point(bp_kind="circulating", polarity=1, twist_rad=math.pi / 2.0, core_radius=1e-9),
        texture.artificial_spin_ice(pitch=50e-9, lattice="square", vertex_state="type_i_ground"),
    ]

    for preset in presets:
        translated = preset.translate(10e-9, 0.0, 0.0).rotate_z_deg(30.0)
        ir = translated.to_ir()
        rendered = _render_preset_texture_expr(
            str(ir["preset_kind"]),
            dict(ir["preset_params"]),
            mapping=dict(ir["mapping"]),
            transform=dict(ir["texture_transform"]),
            preset_version=int(ir["preset_version"]),
            ui_label=None,
            preview_proxy=ir.get("preview_proxy"),
        )
        assert rendered.startswith(f"fm.texture.{ir['preset_kind']}("), rendered
        assert "fm.PresetTexture(" not in rendered, rendered
        assert ".translate(" in rendered, rendered
        assert ".rotate_z_deg(" in rendered, rendered

        reconstructed = eval(rendered, {"fm": fm})
        assert isinstance(reconstructed, PresetTexture)
        rec_ir = reconstructed.to_ir()
        assert rec_ir["preset_kind"] == ir["preset_kind"]
        assert set(rec_ir["preset_params"].keys()) == set(ir["preset_params"].keys())
        for key, orig_val in ir["preset_params"].items():
            rec_val = rec_ir["preset_params"][key]
            if isinstance(orig_val, float):
                assert rec_val == pytest.approx(orig_val, rel=1e-10, abs=1e-15)
            elif isinstance(orig_val, list):
                np.testing.assert_allclose(rec_val, orig_val, rtol=1e-10, atol=1e-15)
            else:
                assert rec_val == orig_val
        np.testing.assert_allclose(
            rec_ir["texture_transform"]["translation"],
            ir["texture_transform"]["translation"],
            atol=1e-15,
        )
        # Quaternions represent the same rotation up to sign +/-q
        q_orig = np.array(ir["texture_transform"]["rotation_quat"], dtype=np.float64)
        q_rec = np.array(rec_ir["texture_transform"]["rotation_quat"], dtype=np.float64)
        assert abs(float(np.dot(q_orig, q_rec))) > 1.0 - 1e-12

    # When rotate_vectors=False, fallback to lossless fm.PresetTexture(...) preserving rotate_vectors=False
    space_only = texture.bloch_skyrmion(radius=20e-9, wall_width=5e-9).rotate_z_deg(45.0).with_rotate_vectors(False)
    ir_so = space_only.to_ir()
    rendered_so = _render_preset_texture_expr(
        str(ir_so["preset_kind"]),
        dict(ir_so["preset_params"]),
        mapping=dict(ir_so["mapping"]),
        transform=dict(ir_so["texture_transform"]),
        preset_version=2,
        ui_label=None,
        preview_proxy=ir_so.get("preview_proxy"),
    )
    assert "fm.PresetTexture(" in rendered_so
    assert "rotate_vectors=False" in rendered_so
    reconstructed_so = eval(rendered_so, {"fm": fm})
    assert reconstructed_so.transform.rotate_vectors is False


def test_wave2_presets_evaluate_unit_vectors_and_validate() -> None:
    pts = [
        (0.0, 0.0, 0.0),
        (15e-9, 0.0, 0.0),
        (0.0, 20e-9, 5e-9),
        (-30e-9, 12e-9, -4e-9),
        (60e-9, 0.0, 0.0),
    ]

    # 1. Skyrmion lattice (hexagonal & square)
    sk_hex = texture.skyrmion_lattice(lattice_constant=60e-9, radius=15e-9, wall_width=4e-9, lattice="hexagonal")
    vals_hex = evaluate_preset_texture_v2("skyrmion_lattice", sk_hex.params, pts).values
    assert len(vals_hex) == len(pts)
    for vec in vals_hex:
        assert abs(math.sqrt(sum(c * c for c in vec)) - 1.0) < 1e-12
    # Lattice periodicity along a1 = (60nm, 0, 0)
    np.testing.assert_allclose(vals_hex[0], vals_hex[4], atol=1e-12)
    assert vals_hex[0][2] < -0.99  # core_polarity=-1 at origin

    with pytest.raises(ValueError, match="lattice_constant"):
        texture.skyrmion_lattice(lattice_constant=20e-9, radius=15e-9, wall_width=4e-9)

    # 2. Generalized spin spiral (cycloidal & proper_screw)
    sp_cyc = texture.spiral(wavelength=40e-9, spiral_kind="cycloidal", propagation_axis=(1.0, 0.0, 0.0))
    vals_cyc = evaluate_preset_texture_v2(
        "spiral",
        sp_cyc.params,
        [(0.0, 0.0, 0.0), (10e-9, 0.0, 0.0), (40e-9, 0.0, 0.0)],
    ).values
    np.testing.assert_allclose(vals_cyc[0], vals_cyc[2], atol=1e-12)
    assert abs(sum(a * b for a, b in zip(vals_cyc[0], vals_cyc[1]))) < 1e-12  # quarter-wave orthogonal

    sp_screw = texture.spiral(wavelength=40e-9, spiral_kind="proper_screw", propagation_axis=(0.0, 0.0, 1.0))
    vals_screw = evaluate_preset_texture_v2("spiral", sp_screw.params, pts).values
    for vec in vals_screw:
        assert abs(vec[2]) < 1e-12  # spins rotate purely in XY perpendicular to Z

    # 3. 3D Bloch point (radial, circulating, hyperbolic)
    bp_circ = texture.bloch_point(bp_kind="circulating", polarity=1, twist_rad=math.pi / 2.0)
    vals_bp = evaluate_preset_texture_v2(
        "bloch_point",
        bp_circ.params,
        [(0.0, 0.0, 0.0), (0.0, 0.0, 10e-9), (0.0, 0.0, -10e-9), (10e-9, 0.0, 0.0)],
    ).values
    np.testing.assert_allclose(vals_bp[0], [0.0, 0.0, 1.0], atol=1e-12)
    np.testing.assert_allclose(vals_bp[1], [0.0, 0.0, 1.0], atol=1e-12)
    np.testing.assert_allclose(vals_bp[2], [0.0, 0.0, -1.0], atol=1e-12)
    np.testing.assert_allclose(vals_bp[3], [0.0, 1.0, 0.0], atol=1e-12)

    with pytest.raises(ValueError, match="object_local"):
        evaluate_preset_texture_v2("bloch_point", bp_circ.params, pts, projection="planar_xy")

    # 4. Artificial spin ice (square & kagome)
    asi_sq = texture.artificial_spin_ice(pitch=50e-9, lattice="square", vertex_state="type_i_ground")
    vals_asi = evaluate_preset_texture_v2(
        "artificial_spin_ice",
        asi_sq.params,
        [(25e-9, 0.0, 0.0), (-25e-9, 0.0, 0.0), (0.0, 25e-9, 0.0), (0.0, -25e-9, 0.0)],
    ).values
    # 2-in / 2-out at vertex (0,0): right +x, left -x, top -y, bottom +y
    np.testing.assert_allclose(vals_asi[0], [1.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(vals_asi[1], [-1.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(vals_asi[2], [0.0, -1.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(vals_asi[3], [0.0, 1.0, 0.0], atol=1e-12)

    asi_kag = texture.artificial_spin_ice(pitch=50e-9, lattice="kagome", vertex_state="type_i_ground")
    vals_kag = evaluate_preset_texture_v2("artificial_spin_ice", asi_kag.params, pts).values
    for vec in vals_kag:
        assert abs(math.sqrt(sum(c * c for c in vec)) - 1.0) < 1e-12


def test_region_space_and_scene_document_roundtrip_preserve_new_fields() -> None:
    preset = (
        texture.vortex(circulation=1, core_polarity=1, core_radius=5e-9)
        .rotate_z_deg(30.0)
        .with_rotate_vectors(False)
        .with_mapping(
            space="region",
            clamp_mode="background",
            tile_period=(40e-9, 40e-9, 10e-9),
            background_vector=(0.0, 0.0, 1.0),
        )
    )
    ir = preset.to_ir()
    builder = {
        "revision": 0,
        "geometries": [
            {
                "name": "disc1",
                "geometry_kind": "Disc",
                "geometry_params": {"radius": 100e-9, "height": 10e-9},
                "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.01},
                "magnetization": {
                    "kind": ir["kind"],
                    "preset_kind": ir["preset_kind"],
                    "preset_params": ir["preset_params"],
                    "preset_version": 2,
                    "mapping": ir["mapping"],
                    "texture_transform": ir["texture_transform"],
                    "ui_label": None,
                },
            }
        ],
    }
    scene = build_scene_document_from_builder(builder)
    recovered = build_builder_from_scene_document(scene)
    mag = recovered["geometries"][0]["magnetization"]
    assert mag["mapping"]["space"] == "region"
    assert mag["mapping"]["clamp_mode"] == "background"
    assert mag["mapping"]["tile_period"] == [40e-9, 40e-9, 10e-9]
    assert mag["mapping"]["background_vector"] == [0.0, 0.0, 1.0]
    assert mag["texture_transform"]["rotate_vectors"] is False

    # Verify space="region" centers vortex at region centroid even when points are shifted in object space
    region_spec = (
        texture.vortex(circulation=1, core_polarity=1, core_radius=5e-9)
        .with_mapping(space="region")
        .to_ir()
    )
    # Symmetric box centered around (100nm, 0, 0)
    region_pts = np.array(
        [
            [80e-9, 0.0, 0.0],
            [100e-9, 0.0, 0.0],
            [120e-9, 0.0, 0.0],
        ],
        dtype=np.float64,
    )
    vals_region = prepare_initial_magnetization(region_spec, region_pts)
    # Center point (100nm, 0, 0) maps to region-local (0, 0, 0) -> vortex core (+Z)
    np.testing.assert_allclose(vals_region[1], [0.0, 0.0, 1.0], atol=1e-12)


def test_finite_axis_thickness_confines_translated_and_tilted_skyrmion_slab() -> None:
    # 1 nm Bloch skyrmion translated to z = +2 nm (core_polarity=-1 -> natural background +Z)
    skyrmion_1nm = (
        texture.bloch_skyrmion(radius=15e-9, wall_width=4e-9, core_polarity=-1, chirality=1)
        .translate(0.0, 0.0, 2.0e-9)
        .with_mapping(axis_extent_mode="thickness", axis_thickness_m=1.0e-9)
    )
    ir = skyrmion_1nm.to_ir()
    assert ir["mapping"]["axis_extent_mode"] == "thickness"
    assert ir["mapping"]["axis_thickness_m"] == pytest.approx(1.0e-9)

    pts = np.array(
        [
            [0.0, 0.0, 2.0e-9],     # slab center -> skyrmion core (-Z)
            [0.0, 0.0, 1.5e-9],     # lower slab boundary (|z - 2nm| == 0.5nm) -> skyrmion core (-Z)
            [0.0, 0.0, 2.5e-9],     # upper slab boundary (|z - 2nm| == 0.5nm) -> skyrmion core (-Z)
            [15e-9, 0.0, 2.0e-9],   # skyrmion wall at r = radius inside slab -> in-plane (+Y)
            [0.0, 0.0, 1.49e-9],    # just below slab -> natural background (+Z)
            [0.0, 0.0, 2.51e-9],    # just above slab -> natural background (+Z)
            [15e-9, 0.0, 0.0],      # z = 0 outside translated slab -> natural background (+Z)
        ],
        dtype=np.float64,
    )
    vals = prepare_initial_magnetization(ir, pts)
    assert vals[0, 2] < -0.99
    assert vals[1, 2] < -0.99
    assert vals[2, 2] < -0.99
    assert vals[3, 1] > 0.99 and abs(vals[3, 2]) < 1e-12
    np.testing.assert_allclose(vals[4], [0.0, 0.0, 1.0], atol=1e-12)
    np.testing.assert_allclose(vals[5], [0.0, 0.0, 1.0], atol=1e-12)
    np.testing.assert_allclose(vals[6], [0.0, 0.0, 1.0], atol=1e-12)

    # Core polarity +1 flips natural skyrmion background to -Z
    skyrmion_pos_core = (
        texture.neel_skyrmion(radius=15e-9, wall_width=4e-9, core_polarity=1)
        .translate(0.0, 0.0, 2.0e-9)
        .with_thickness(1.0e-9)
    )
    vals_pos = prepare_initial_magnetization(
        skyrmion_pos_core.to_ir(),
        np.array([[0.0, 0.0, 2.0e-9], [0.0, 0.0, 3.0e-9]], dtype=np.float64),
    )
    assert vals_pos[0, 2] > 0.99
    np.testing.assert_allclose(vals_pos[1], [0.0, 0.0, -1.0], atol=1e-12)

    # Custom background_vector + 90 deg X rotation tilts slab normal along -Y and rotates spins when rotate_vectors=True
    tilted = (
        texture.bloch_skyrmion(radius=15e-9, wall_width=4e-9, core_polarity=-1)
        .rotate_x_deg(90.0)
        .with_mapping(
            axis_extent_mode="thickness",
            axis_thickness_m=1.0e-9,
            background_vector=(0.0, 3.0, 4.0),
        )
    )
    # R_x(+90 deg) maps local (0, 0, z') -> world (0, -z', 0), and rotates bg (0, 0.6, 0.8) -> (0, -0.8, 0.6)
    vals_tilted = prepare_initial_magnetization(
        tilted.to_ir(),
        np.array([[0.0, 0.0, 0.0], [0.0, 2.0e-9, 0.0]], dtype=np.float64),
    )
    np.testing.assert_allclose(vals_tilted[0], [0.0, 1.0, 0.0], atol=1e-6)  # core (0,0,-1) rotated +90 deg around X -> (0,+1,0)
    np.testing.assert_allclose(vals_tilted[1], [0.0, -0.8, 0.6], atol=1e-12)

    # Fluent script export & scene_document round-trip preserve axis_extent_mode & axis_thickness_m
    rendered = _render_preset_texture_expr(
        str(ir["preset_kind"]),
        dict(ir["preset_params"]),
        mapping=dict(ir["mapping"]),
        transform=dict(ir["texture_transform"]),
        preset_version=2,
    )
    assert ".with_mapping(" in rendered
    assert 'axis_extent_mode="thickness"' in rendered
    assert "axis_thickness_m=" in rendered
    reconstructed = eval(rendered, {"fm": fm})
    assert reconstructed.to_ir()["mapping"] == ir["mapping"]

    # Validation rejects non-positive or missing axis_thickness_m when axis_extent_mode == "thickness"
    with pytest.raises(ValueError, match="axis_thickness_m"):
        TextureMapping(axis_extent_mode="thickness")
    with pytest.raises(ValueError, match="axis_thickness_m"):
        evaluate_preset_texture_v2(
            "bloch_skyrmion",
            {"radius": 15e-9, "wall_width": 4e-9},
            [(0.0, 0.0, 0.0)],
            axis_extent_mode="thickness",
            axis_thickness_m=0.0,
        )


def test_default_tile_period_uses_pre_transform_source_bounds_and_metric_background() -> None:
    # 1. Default tile_period when omitted uses source-space domain bbox BEFORE texture_transform,
    #    so scaling by 0.5 tiles the 50nm domain twice across [-25nm, +25nm].
    spec_scaled_repeat = (
        texture.bloch_skyrmion(radius=10e-9, wall_width=3e-9, core_polarity=-1)
        .scale(0.5, 0.5, 1.0)
        .with_mapping(clamp_mode="repeat")
        .to_ir()
    )
    pts = np.array(
        [
            [-25e-9, -25e-9, -5e-9],
            [0.0, 0.0, 0.0],
            [25e-9, 0.0, 0.0],
            [25e-9, 25e-9, 5e-9],
        ],
        dtype=np.float64,
    )
    # Source bbox extent is [50nm, 50nm, 10nm]. After scale 0.5, x=+25nm -> x_tex=+50nm,
    # which wraps modulo 50nm back to x_tex=0 -> skyrmion core (-Z)!
    vals_default = prepare_initial_magnetization(spec_scaled_repeat, pts)
    spec_explicit_repeat = (
        texture.bloch_skyrmion(radius=10e-9, wall_width=3e-9, core_polarity=-1)
        .scale(0.5, 0.5, 1.0)
        .with_mapping(clamp_mode="repeat", tile_period=(50e-9, 50e-9, 10e-9))
        .to_ir()
    )
    vals_explicit = prepare_initial_magnetization(spec_explicit_repeat, pts)
    np.testing.assert_allclose(vals_default, vals_explicit, atol=1e-12)
    assert vals_default[1, 2] < -0.99
    assert vals_default[2, 2] < -0.99

    # 2. Default background vector (when background_vector is omitted) passes through
    #    the oriented metric frame: plane="xz" has e_n = (0, -1, 0), plane="yz" has e_n = (1, 0, 0).
    for plane, expected_bg in (("xy", [0.0, 0.0, 1.0]), ("xz", [0.0, -1.0, 0.0]), ("yz", [1.0, 0.0, 0.0])):
        bg_spec = (
            texture.vortex(circulation=1, core_polarity=1, core_radius=4e-9, plane=plane)
            .with_mapping(clamp_mode="background", tile_period=(20e-9, 20e-9, 20e-9))
            .to_ir()
        )
        vals = prepare_initial_magnetization(
            bg_spec,
            np.array([[0.0, 0.0, 0.0], [30e-9, 30e-9, 30e-9]], dtype=np.float64),
        )
        np.testing.assert_allclose(vals[1], expected_bg, atol=1e-12)

    # 3. space="region" with explicit analytic target_bounds derives both region_center and default tile_period
    region_spec = (
        texture.vortex(circulation=1, core_polarity=1, core_radius=4e-9, plane="xy")
        .with_mapping(space="region", clamp_mode="clamp")
        .to_ir()
    )
    region_bounds = ((80e-9, -10e-9, -5e-9), (120e-9, 10e-9, 5e-9))
    vals_region_bounds = prepare_initial_magnetization(
        region_spec,
        np.array([[100e-9, 0.0, 0.0], [160e-9, 0.0, 0.0]], dtype=np.float64),
        target_bounds=region_bounds,
    )
    # Center (100nm, 0, 0) -> region (0, 0, 0) -> core (+Z)
    np.testing.assert_allclose(vals_region_bounds[0], [0.0, 0.0, 1.0], atol=1e-12)
    # Clamped at x_region = +20nm (half of 40nm extent)
    vals_clamped_ref = prepare_initial_magnetization(
        texture.vortex(circulation=1, core_polarity=1, core_radius=4e-9, plane="xy").to_ir(),
        np.array([[20e-9, 0.0, 0.0]], dtype=np.float64),
    )
    np.testing.assert_allclose(vals_region_bounds[1], vals_clamped_ref[0], atol=1e-12)
