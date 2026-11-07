"""Temporary, explicitly synthetic checks for the offline collector."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

import collect_results as collector


def _tiny_layer(key: str, grid: tuple[int, int, int], origin_nm: tuple[float, float, float]) -> collector.LayerData:
    nx, ny, nz = grid
    mask = np.ones((nz, ny, nx), dtype=np.bool_)
    if key == "film":
        mask[:, 0, 0] = False
    initial = np.zeros((nz, ny, nx, 3), dtype=np.float64)
    final = np.zeros_like(initial)
    initial[mask] = (1.0, 0.0, 0.0)
    final[mask] = (0.0, 1.0, 0.0)
    return collector.LayerData(
        key=key,
        object_id="bimeron-film" if key == "film" else "upper-cylinder",
        magnet_name=key,
        native_grid=grid,
        native_origin_m=np.asarray(origin_nm, dtype=np.float64) * 1e-9,
        cell_size_m=np.full(3, 1e-9, dtype=np.float64),
        active_mask=mask,
        initial_m=initial,
        final_m=final,
        source_metadata={"fixture_only": True},
    )


def _tiny_case() -> collector.CaseData:
    layers = {
        "film": _tiny_layer("film", (4, 4, 2), (-2.0, -2.0, -1.0)),
        "cylinder": _tiny_layer("cylinder", (3, 3, 2), (-1.5, -1.5, 10.0)),
    }
    return collector.CaseData(
        case_id="synthetic-fixture-only",
        run_id="synthetic-fixture-only",
        source_sha256="0" * 64,
        status="completed",
        steps=3000,
        max_steps=3000,
        converged=False,
        max_torque_T=1e-5,
        wall_time_s=1.0,
        energies_J={"total": 0.0},
        execution={"requested": {"backend": "fdm", "device": "gpu"}, "resolved": {"backend": "fdm", "device": "gpu"}},
        material={"id": "synthetic-fixture-only"},
        film_initial="synthetic-fixture-only",
        dot_mx=1,
        layers=layers,
        scalar_columns=("step", "mx", "my", "mz", "E_total", "max_torque_T"),
        scalar_values=np.asarray([[0, 1, 0, 0, 0, 1], [3000, 1, 0, 0, 0, 1e-5]], dtype=np.float64),
        completion={"status": "completed", "converged": False},
        provenance={"fixture_only": True},
        input_hashes={"fixture_only": "synthetic"},
        input_kind="synthetic_test_fixture_only",
    )


class SurfaceAndSamplingTests(unittest.TestCase):
    def test_top_surface_respects_inactive_cells_with_zero_vectors(self) -> None:
        layer = _tiny_layer("film", (3, 3, 2), (-1.5, -1.5, -1.0))
        colors, visible = collector._layer_top_surface(layer, "initial")
        self.assertFalse(visible[0, 0])
        self.assertTrue(np.all(colors[0, 0] == 0.0))
        self.assertTrue(np.isfinite(colors[visible]).all())

    def test_exposed_surface_uses_mask_boundaries(self) -> None:
        layer = _tiny_layer("film", (2, 2, 2), (0.0, 0.0, 0.0))
        layer.active_mask[:] = False
        layer.active_mask[0, 0, 0] = True
        faces = collector._active_surface_faces(layer)
        self.assertEqual(len(faces), 6)
        all_vertices = np.asarray([vertex for face in faces for vertex in face])
        np.testing.assert_allclose(all_vertices.min(axis=0), (0.0, 0.0, 0.0))
        np.testing.assert_allclose(all_vertices.max(axis=0), (1.0, 1.0, 1.0))

    def test_arrow_sample_is_repeatable_and_bounded(self) -> None:
        mask = np.ones((30, 30, 30), dtype=np.bool_)
        first = collector._sample_active_points(mask)
        second = collector._sample_active_points(mask)
        self.assertEqual(first.shape, (collector.MAX_3D_ARROWS_PER_LAYER, 3))
        np.testing.assert_array_equal(first, second)
        np.testing.assert_array_equal(first[0], (0, 0, 0))
        np.testing.assert_array_equal(first[-1], (29, 29, 29))


class RenderAndZarrTests(unittest.TestCase):
    def test_four_data_renders_are_deterministic(self) -> None:
        case = _tiny_case()
        with tempfile.TemporaryDirectory(prefix="bimeron-matrix-render-test-") as temp:
            root = Path(temp)
            hashes = []
            for name in ("first", "second"):
                parent = root / name
                parent.mkdir()
                hashes.append(collector.render_case_pngs(case, parent / "plots"))
            self.assertEqual(hashes[0], hashes[1])
            self.assertEqual(set(hashes[0]), {"initial_2d", "initial_3d", "final_2d", "final_3d"})

    def test_zarr_v2_chunk_roundtrip_and_case_arrays(self) -> None:
        case = _tiny_case()
        with tempfile.TemporaryDirectory(prefix="bimeron-matrix-zarr-test-") as temp:
            root = Path(temp)
            raw = np.arange(35, dtype=np.float64).reshape(5, 7)
            array_path = root / "chunked"
            collector.write_zarr_array(array_path, raw, chunks=(2, 3))
            np.testing.assert_array_equal(collector.read_zarr_array(array_path), raw)
            metadata = json.loads((array_path / ".zarray").read_text(encoding="utf-8"))
            self.assertEqual(metadata["zarr_format"], 2)
            self.assertIsNone(metadata["compressor"])
            self.assertEqual((array_path / "2.2").stat().st_size, 2 * 3 * 8)

            case_path = root / "result.zarr"
            collector.write_case_zarr(case, case_path)
            for state, values_name in (("initial", "initial_m"), ("final", "final_m")):
                for layer_key in ("film", "cylinder"):
                    np.testing.assert_array_equal(
                        collector.read_zarr_array(case_path / state / layer_key / "m"),
                        getattr(case.layers[layer_key], values_name),
                    )
            np.testing.assert_array_equal(
                collector.read_zarr_array(case_path / "masks" / "film"),
                case.layers["film"].active_mask.astype(np.uint8),
            )
            np.testing.assert_array_equal(
                collector.read_zarr_array(case_path / "grid" / "cylinder" / "native_grid"),
                np.asarray(case.layers["cylinder"].native_grid, dtype=np.int64),
            )
            zattrs = json.loads((case_path / ".zattrs").read_text(encoding="utf-8"))
            self.assertEqual(zattrs["plot_provenance"]["kind"], "data_render")

    def test_zarr_writer_rejects_nonfinite_data(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bimeron-matrix-zarr-invalid-") as temp:
            target = Path(temp) / "invalid"
            with self.assertRaisesRegex(collector.DataError, "NaN or infinity"):
                collector.write_zarr_array(target, np.asarray([1.0, np.nan]))
            self.assertFalse(target.exists())


class InputValidationTests(unittest.TestCase):
    def test_native_layer_shape_must_match_declared_grid(self) -> None:
        manifest, _ = collector.load_matrix_manifest()
        entry = {
            "object_id": "bimeron-film",
            "native_grid": [240, 240, 4],
            "native_origin": [-300e-9, -300e-9, -5e-9],
            "native_cell_size": [2.5e-9, 2.5e-9, 2.5e-9],
            "native_active_mask": [True] * (240 * 240 * 4),
            "active_cell_count": 240 * 240 * 4,
        }
        with self.assertRaisesRegex(collector.DataError, "initial M shape"):
            collector._make_layer_data(
                "film",
                entry,
                None,
                np.ones((1, 3), dtype=np.float64),
                np.ones((1, 3), dtype=np.float64),
                manifest,
            )

    def test_missing_final_npz_field_is_pending_without_initial_substitution(self) -> None:
        manifest, specs = collector.load_matrix_manifest()
        case_id = next(iter(specs))
        spec = specs[case_id]
        metadata = {
            "schema_version": collector.ARRAYS_SCHEMA,
            "case_id": case_id,
            "status": "completed",
            "completion": {"status": "completed", "converged": False},
            "requested_execution": {"backend": "fdm", "device": "gpu", "precision": "double", "mode": "bb"},
            "execution_provenance": {
                "execution_resolution": {
                    "resolved_execution": {"backend": "fdm", "device": "gpu"},
                    "fallback_occurred": False,
                },
                "execution": {"execution_engine": "synthetic fixture only"},
            },
            "provenance": {"run_id": "synthetic-fixture-only", "source_sha256": spec["script_sha256"]},
            "layers": {
                "film": {"object_id": "bimeron-film"},
                "cylinder": {"object_id": "upper-cylinder"},
            },
        }
        film_grid = np.asarray([240, 240, 4], dtype=np.int64)
        film_initial = np.zeros((4, 240, 240, 3), dtype=np.float64)
        film_initial[..., 0] = 1.0
        arrays = {
            "metadata_json": np.asarray(json.dumps(metadata)),
            "scalar_columns_json": np.asarray(json.dumps(["step", "mx", "my", "mz", "E_total", "max_torque_T"])),
            "scalars": np.asarray([[0, 1, 0, 0, 0, 1], [3000, 1, 0, 0, 0, 1e-5]], dtype=np.float64),
            "film_native_grid": film_grid,
            "film_native_origin_m": np.asarray([-300e-9, -300e-9, -5e-9]),
            "film_cell_size_m": np.asarray([2.5e-9] * 3),
            "film_mask": np.ones((4, 240, 240), dtype=np.uint8),
            "film_initial_m": film_initial,
            # Deliberately no film_final_m: this must remain pending.
        }
        with tempfile.TemporaryDirectory(prefix="bimeron-matrix-npz-pending-") as temp:
            npz_path = Path(temp) / "synthetic-pending.npz"
            np.savez(npz_path, **arrays)
            with self.assertRaisesRegex(collector.DataError, "pending: NPZ is missing required array 'film_final_m'"):
                collector._load_explicit_npz(npz_path, manifest, specs, case_id, None)

    def test_npz_array_rejects_nan_and_infinity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bimeron-matrix-npz-invalid-") as temp:
            npz_path = Path(temp) / "synthetic-invalid.npz"
            np.savez(npz_path, value=np.asarray([1.0, np.inf]))
            with np.load(npz_path, allow_pickle=False) as archive:
                with self.assertRaisesRegex(collector.DataError, "NaN or infinity"):
                    collector._npz_array(archive, "value")


if __name__ == "__main__":
    unittest.main()
