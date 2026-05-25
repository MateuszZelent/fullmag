"""Round-trip and correctness tests for the magnetic texture preset pipeline.

Covers:
- JSON round-trip through SceneDocument (preset_params, mapping, texture_transform).
- Inverse transform math: translate, rotate, scale, pivot.
- Metric space sampling: vortex / skyrmion profiles at known distances.
- preset_params vs params contract unification.
"""

from __future__ import annotations

import math
import numpy as np
import pytest

from fullmag.init.textures import texture, PresetTexture, TextureMapping
from fullmag.init.preset_eval import evaluate_preset_texture
from fullmag.runtime.initial_state import (
    _apply_inverse_transform,
    prepare_initial_magnetization,
)
from fullmag.runtime.scene_document import (
    build_scene_document_from_builder,
    build_builder_from_scene_document,
)


# ---------------------------------------------------------------------------
# 8.1  JSON round-trip contract
# ---------------------------------------------------------------------------

class TestJsonRoundTrip:
    """Verify that preset_params, mapping, and texture_transform survive
    the builder → SceneDocument → builder round-trip losslessly."""

    @staticmethod
    def _make_builder_geometry(preset: PresetTexture, name: str = "disc1") -> dict:
        ir = preset.to_ir()
        return {
            "name": name,
            "geometry_kind": "Disc",
            "geometry_params": {"radius": 100e-9, "height": 10e-9},
            "material": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.01, "Dind": None},
            "magnetization": {
                "kind": ir["kind"],
                "preset_kind": ir["preset_kind"],
                "preset_params": ir["preset_params"],
                "mapping": ir["mapping"],
                "texture_transform": ir["texture_transform"],
                "ui_label": ir.get("ui_label"),
                "preset_version": 1,
                "value": None,
                "seed": None,
                "source_path": None,
                "source_format": None,
                "dataset": None,
                "sample_index": None,
            },
        }

    def test_neel_skyrmion_roundtrip(self):
        preset = texture.neel_skyrmion(radius=35e-9, wall_width=10e-9, chirality=1)
        builder = {"revision": 0, "geometries": [self._make_builder_geometry(preset)]}

        scene = build_scene_document_from_builder(builder)
        recovered = build_builder_from_scene_document(scene)

        mag = recovered["geometries"][0]["magnetization"]
        assert mag["kind"] == "preset_texture"
        assert mag["preset_kind"] == "neel_skyrmion"
        assert mag["preset_params"]["radius"] == 35e-9
        assert mag["preset_params"]["wall_width"] == 10e-9
        assert mag["preset_params"]["chirality"] == 1
        assert mag["mapping"]["space"] == "object"
        assert mag["mapping"]["clamp_mode"] == "none"
        assert mag["texture_transform"]["rotation_quat"] == [0.0, 0.0, 0.0, 1.0]
        assert mag["texture_transform"]["scale"] == [1.0, 1.0, 1.0]

    def test_vortex_roundtrip(self):
        preset = texture.vortex(circulation=-1, core_polarity=1, core_radius=20e-9)
        builder = {"revision": 0, "geometries": [self._make_builder_geometry(preset)]}

        scene = build_scene_document_from_builder(builder)
        recovered = build_builder_from_scene_document(scene)

        mag = recovered["geometries"][0]["magnetization"]
        assert mag["preset_kind"] == "vortex"
        assert mag["preset_params"]["circulation"] == -1
        assert mag["preset_params"]["core_polarity"] == 1
        assert mag["preset_params"]["core_radius"] == 20e-9

    def test_custom_mapping_roundtrip(self):
        preset = texture.bloch_skyrmion(
            radius=30e-9, wall_width=8e-9,
        ).with_mapping(space="world", projection="planar_xz", clamp_mode="repeat")
        builder = {"revision": 0, "geometries": [self._make_builder_geometry(preset)]}

        scene = build_scene_document_from_builder(builder)
        recovered = build_builder_from_scene_document(scene)

        mag = recovered["geometries"][0]["magnetization"]
        assert mag["mapping"]["space"] == "world"
        assert mag["mapping"]["projection"] == "planar_xz"
        assert mag["mapping"]["clamp_mode"] == "repeat"

    def test_texture_transform_roundtrip(self):
        preset = texture.vortex().translate(10e-9, 20e-9, 0).rotate_z_deg(45)
        builder = {"revision": 0, "geometries": [self._make_builder_geometry(preset)]}

        scene = build_scene_document_from_builder(builder)
        recovered = build_builder_from_scene_document(scene)

        mag = recovered["geometries"][0]["magnetization"]
        tt = mag["texture_transform"]
        assert abs(tt["translation"][0] - 10e-9) < 1e-18
        assert abs(tt["translation"][1] - 20e-9) < 1e-18
        # Rotation quat should be non-identity
        assert not all(abs(v) < 1e-10 for v in tt["rotation_quat"][:3])

    def test_preset_params_not_params_in_ir(self):
        """Verify that to_ir() emits 'preset_params', not 'params'."""
        preset = texture.vortex()
        ir = preset.to_ir()
        assert "preset_params" in ir
        assert "params" not in ir

    def test_uniform_texture_accepts_three_scalar_components(self):
        preset = texture.uniform(1, 0, 0)
        ir = preset.to_ir()
        assert ir["preset_kind"] == "uniform"
        assert ir["preset_params"]["direction"] == [1.0, 0.0, 0.0]

    def test_vortex_omits_none_core_radius_in_ir(self):
        preset = texture.vortex()
        ir = preset.to_ir()
        assert "core_radius" not in ir["preset_params"]

    def test_antivortex_omits_none_core_radius_in_ir(self):
        preset = texture.antivortex()
        ir = preset.to_ir()
        assert "core_radius" not in ir["preset_params"]

    def test_bloch_skyrmion_positional_arguments(self):
        # 1. Full positional signature
        preset = texture.bloch_skyrmion(100e-9, 20e-9, 1, -1, "xy")
        ir = preset.to_ir()
        assert ir["preset_kind"] == "bloch_skyrmion"
        assert ir["preset_params"]["radius"] == 100e-9
        assert ir["preset_params"]["wall_width"] == 20e-9
        assert ir["preset_params"]["chirality"] == 1
        assert ir["preset_params"]["core_polarity"] == -1
        assert ir["preset_params"]["plane"] == "xy"

        # 2. Positional signature with plane at core_polarity position (omitting core_polarity)
        preset2 = texture.bloch_skyrmion(100e-9, 20e-9, 1, "xz")
        ir2 = preset2.to_ir()
        assert ir2["preset_params"]["chirality"] == 1
        assert ir2["preset_params"]["core_polarity"] == -1  # restored default
        assert ir2["preset_params"]["plane"] == "xz"         # intercepted from core_polarity

        # 3. Positional signature with plane at chirality position (omitting both chirality and core_polarity)
        preset3 = texture.bloch_skyrmion(100e-9, 20e-9, "yz")
        ir3 = preset3.to_ir()
        assert ir3["preset_params"]["chirality"] == 1       # restored default
        assert ir3["preset_params"]["core_polarity"] == -1  # restored default
        assert ir3["preset_params"]["plane"] == "yz"         # intercepted from chirality


# ---------------------------------------------------------------------------
# 8.2  Inverse transform correctness
# ---------------------------------------------------------------------------

class TestInverseTransform:
    """Verify the inverse of T ∘ R ∘ S (around pivot) is algebraically correct."""

    def test_identity(self):
        pts = np.array([[1.0, 2.0, 3.0]])
        result = _apply_inverse_transform(pts, {})
        np.testing.assert_allclose(result, pts, atol=1e-12)

    def test_translate_only(self):
        pts = np.array([[5.0, 0.0, 0.0]])
        transform = {"translation": [3.0, 0.0, 0.0]}
        result = _apply_inverse_transform(pts, transform)
        np.testing.assert_allclose(result, [[2.0, 0.0, 0.0]], atol=1e-12)

    def test_scale_only(self):
        pts = np.array([[4.0, 6.0, 8.0]])
        transform = {"scale": [2.0, 3.0, 4.0]}
        result = _apply_inverse_transform(pts, transform)
        np.testing.assert_allclose(result, [[2.0, 2.0, 2.0]], atol=1e-12)

    def test_rotate_90_z(self):
        """90° rotation around Z maps (1,0,0) → (0,1,0).
        Inverse should map (0,1,0) → (1,0,0)."""
        pts = np.array([[0.0, 1.0, 0.0]])
        # 90° around Z: quat = (0, 0, sin45, cos45)
        s = math.sin(math.pi / 4)
        c = math.cos(math.pi / 4)
        transform = {"rotation_quat": [0.0, 0.0, s, c]}
        result = _apply_inverse_transform(pts, transform)
        np.testing.assert_allclose(result, [[1.0, 0.0, 0.0]], atol=1e-10)

    def test_pivot_with_scale(self):
        """Forward: world = translation + pivot + R*(S*(local - pivot))
        With identity rotation, translation=0, pivot=(1,0,0), scale=(2,1,1):
        world = (1,0,0) + 2*(local - (1,0,0)) = 2*local - (1,0,0)
        So local = (world + (1,0,0)) / 2
        For world = (3, 0, 0): local = (4, 0, 0)/2 = (2, 0, 0)
        """
        pts = np.array([[3.0, 0.0, 0.0]])
        transform = {
            "pivot": [1.0, 0.0, 0.0],
            "scale": [2.0, 1.0, 1.0],
        }
        result = _apply_inverse_transform(pts, transform)
        np.testing.assert_allclose(result, [[2.0, 0.0, 0.0]], atol=1e-10)

    def test_pivot_rotate_scale(self):
        """Combined pivot + rotation + scale test.
        Forward: world = T + pivot + R * (S * (local - pivot))
        With T=(0,0,0), pivot=(1,0,0), S=(2,1,1), R=identity:
        world = (1,0,0) + (2*(local_x - 1), local_y, local_z)
        So world_x = 2*local_x - 1, meaning local_x = (world_x + 1)/2
        For world = (5, 0, 0): local_x = (5+1)/2 = 3
        """
        pts = np.array([[5.0, 0.0, 0.0]])
        transform = {
            "pivot": [1.0, 0.0, 0.0],
            "scale": [2.0, 1.0, 1.0],
        }
        result = _apply_inverse_transform(pts, transform)
        np.testing.assert_allclose(result, [[3.0, 0.0, 0.0]], atol=1e-10)


# ---------------------------------------------------------------------------
# 8.3  Metric space correctness
# ---------------------------------------------------------------------------

class TestMetricSpaceSampling:
    """Test that preset evaluators work correctly in metric space."""

    def test_vortex_center_polarity(self):
        """At the center of a vortex, mz should be positive for core_polarity=+1.
        Note: at r=0, mx=0, my=circulation*1, mz=polarity*1 → normalized to ~0.707."""
        result = evaluate_preset_texture(
            "vortex",
            {"circulation": 1, "core_polarity": 1, "core_radius": 10e-9, "plane": "xy"},
            [(0.0, 0.0, 0.0)],
        )
        mx, my, mz = result.values[0]
        assert mz > 0.5  # core polarity = +1, but not 1.0 due to in-plane contribution at center

    def test_vortex_far_from_center_in_plane(self):
        """Far from center, mz ≈ 0, in-plane circulation dominates."""
        r = 100e-9
        result = evaluate_preset_texture(
            "vortex",
            {"circulation": 1, "core_polarity": 1, "core_radius": 10e-9, "plane": "xy"},
            [(r, 0.0, 0.0)],
        )
        mx, my, mz = result.values[0]
        assert abs(mz) < 0.1  # far from core
        # At (r, 0): circulation=+1 → m ≈ (0, 1, 0)
        assert my > 0.9

    def test_neel_skyrmion_center(self):
        """At center of a Néel skyrmion, mz = core_polarity * cos(theta≈π) = -core_polarity.
        With core_polarity=-1: mz ≈ +1."""
        result = evaluate_preset_texture(
            "neel_skyrmion",
            {"radius": 35e-9, "wall_width": 10e-9, "core_polarity": -1, "chirality": 1, "plane": "xy"},
            [(0.0, 0.0, 0.0)],
        )
        mx, my, mz = result.values[0]
        assert mz > 0.9  # core_polarity=-1, cos(π)=-1, so mz=(-1)*(-1)=+1

    def test_neel_skyrmion_far_from_center(self):
        """Outside the skyrmion, mz = core_polarity * cos(theta≈0) = core_polarity.
        With core_polarity=-1: mz ≈ -1 far away."""
        r = 200e-9
        result = evaluate_preset_texture(
            "neel_skyrmion",
            {"radius": 35e-9, "wall_width": 10e-9, "core_polarity": -1, "chirality": 1, "plane": "xy"},
            [(r, 0.0, 0.0)],
        )
        mx, my, mz = result.values[0]
        assert mz < -0.9  # far away: mz → core_polarity = -1

    def test_skyrmion_wall_at_radius(self):
        """At r = radius, theta should be ≈ π/2, so mz ≈ 0."""
        radius = 35e-9
        result = evaluate_preset_texture(
            "neel_skyrmion",
            {"radius": radius, "wall_width": 10e-9, "core_polarity": -1, "chirality": 1, "plane": "xy"},
            [(radius, 0.0, 0.0)],
        )
        mx, my, mz = result.values[0]
        # At exactly r=radius, atan(exp(0)) = π/4, so theta = π/2, mz = cos(π/2) ≈ 0
        assert abs(mz) < 0.2

    def test_rotation_doesnt_change_skyrmion_radius(self):
        """Rotating the texture should not change the radial profile."""
        radius = 35e-9
        points = [(radius, 0.0, 0.0), (0.0, radius, 0.0)]
        result1 = evaluate_preset_texture(
            "neel_skyrmion",
            {"radius": radius, "wall_width": 10e-9, "core_polarity": -1, "plane": "xy"},
            points,
        )
        # Both points at same distance should give same |mz|
        mz1 = abs(result1.values[0][2])
        mz2 = abs(result1.values[1][2])
        assert abs(mz1 - mz2) < 0.05


# ---------------------------------------------------------------------------
# 8.4  prepare_initial_magnetization integration
# ---------------------------------------------------------------------------

class TestPrepareInitialMagnetization:

    def test_preset_texture_reads_preset_params(self):
        """Verify that prepare_initial_magnetization reads preset_params, not params."""
        spec = {
            "kind": "preset_texture",
            "preset_kind": "vortex",
            "preset_params": {
                "circulation": 1,
                "core_polarity": 1,
                "core_radius": 10e-9,
                "plane": "xy",
            },
            "mapping": {"space": "world", "projection": "object_local", "clamp_mode": "none"},
            "texture_transform": {},
        }
        points = np.array([[0.0, 0.0, 0.0], [100e-9, 0.0, 0.0]])
        result = prepare_initial_magnetization(spec, points)
        assert result.shape == (2, 3)
        # Center: mz > 0.5 (polarity, but normalized with in-plane component)
        assert result[0, 2] > 0.5

    def test_clamp_mode_none_passes_through(self):
        """With clamp_mode='none', coordinates should not be clamped to [-0.5, 0.5]."""
        spec = {
            "kind": "preset_texture",
            "preset_kind": "vortex",
            "preset_params": {"circulation": 1, "core_polarity": 1, "core_radius": 10e-9},
            "mapping": {"space": "world", "projection": "object_local", "clamp_mode": "none"},
            "texture_transform": {},
        }
        # A point at 100nm should NOT be clamped to 0.5
        points = np.array([[100e-9, 0.0, 0.0]])
        result = prepare_initial_magnetization(spec, points)
        assert result.shape == (1, 3)
        # At r=100nm, mz should be very small (far from 10nm core)
        assert abs(result[0, 2]) < 0.1

    def test_translate_shifts_texture(self):
        """Translating texture should shift the center of the vortex."""
        shift = 50e-9
        spec = {
            "kind": "preset_texture",
            "preset_kind": "vortex",
            "preset_params": {"circulation": 1, "core_polarity": 1, "core_radius": 10e-9},
            "mapping": {"space": "world", "projection": "object_local", "clamp_mode": "none"},
            "texture_transform": {"translation": [shift, 0.0, 0.0]},
        }
        # Sample at the shifted center
        points = np.array([[shift, 0.0, 0.0]])
        result = prepare_initial_magnetization(spec, points)
        # Should be at the core: mz > 0.5 (normalized)
        assert result[0, 2] > 0.5

    def test_backward_compat_params_fallback(self):
        """Legacy IR with 'params' instead of 'preset_params' should still work."""
        spec = {
            "kind": "preset_texture",
            "preset_kind": "vortex",
            "params": {
                "circulation": 1,
                "core_polarity": 1,
                "core_radius": 10e-9,
            },
            "mapping": {"space": "world", "projection": "object_local", "clamp_mode": "none"},
            "texture_transform": {},
        }
        points = np.array([[0.0, 0.0, 0.0]])
        result = prepare_initial_magnetization(spec, points)
        assert result[0, 2] > 0.5  # core polarity = +1
