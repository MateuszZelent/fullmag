"""Pure-Python owner-bound inputs; no native, mesher or scientific qualification."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import numpy as np
import fullmag as fm
from fullmag import _core, world
from fullmag.model.problem import BackendTarget, build_geometry_assets_for_request
from fullmag.meshing.persistence import save_mesh_artifact
from fullmag.runtime.script_builder import _render_object_id_mesh_workflow
from test_mesh_persistence import _tetra_mesh, _mixed_linear_mesh


class OwnerBoundMeshSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.addCleanup(fm.reset)
        # Exercise the real optional facade with native deliberately unavailable.
        self.native = patch.object(_core, "_native_core", None)
        self.native.start()
        self.addCleanup(self.native.stop)
        self.generated_cache = patch("fullmag.model.problem._fem_mesh_cache_dir", return_value=None)
        self.generated_cache.start()
        self.addCleanup(self.generated_cache.stop)
        self.mesh = _tetra_mesh()
        self.source = self.root / "source.npz"
        self.mesh.save(self.source)
        self.geometries = [fm.Box((1e-9, 1e-9, 1e-9), name="conductor"),
                           fm.Box((1e-9, 1e-9, 1e-9), name="sampling")]
        self.kwargs = dict(requested_backend=BackendTarget.FEM, geometries=self.geometries,
                          discretization=fm.DiscretizationHints(fem=fm.FEM(order=1, hmax=1e-9)),
                          geometry_object_ids={"conductor": "source-id", "sampling": "sampling-id"})
        self.workflow = {"per_geometry": [{"geometry": geometry.geometry_name, "source": str(self.source), "order": 1}
                                          for geometry in self.geometries]}

    def build(self, **overrides):
        options = dict(self.kwargs, mesh_workflow=self.workflow)
        options.update(overrides)
        return build_geometry_assets_for_request(**options)

    def test_public_setter_keeps_owner_and_atomic_validation(self) -> None:
        study = fm.study("owner-bound-input")
        study.engine("fem")
        study.objects.mesh.defaults(maximum_element_size=1e-9, order=1)
        study.antenna_object(self.geometries[0], name="conductor", object_id="source-id")
        handle = study.objects.mesh.by_id("source-id")
        self.assertIs(handle(source=str(self.source), order=1), handle)
        entry = world._collect_mesh_workflow_metadata()["per_geometry"][0]
        self.assertEqual((entry["geometry"], entry["source"]), ("conductor", str(self.source)))
        self.assertFalse(isinstance(handle._owner, world.MagnetHandle))
        for value in ("", "source.json", 3):
            with self.subTest(value=value), self.assertRaises(ValueError):
                handle(source=value)
        with self.assertRaisesRegex(ValueError, "P1"):
            handle(source=str(self.source), order=2)
        self.assertEqual(handle._owner._mesh_spec.order, 1)
        with self.assertRaises(ValueError):
            study.objects.mesh.by_id("conductor")
        rendered = _render_object_id_mesh_workflow("source-id", entry, source_root=self.root)
        self.assertIn('study.objects.mesh.by_id("source-id")', rendered[0])
        self.assertIn('source="source.npz"', rendered[0])

    def test_explicit_inputs_remain_beside_shared_global(self) -> None:
        global_path = self.root / "global.fullmag-mesh"
        save_mesh_artifact(global_path, mesh=self.mesh, mesh_name="study_domain", authoring_document={},
                           region_markers=[{"geometry_name": "conductor", "marker": 1}],
                           boundary_map={"outer": 10, "interface": 20})
        workflow = dict(self.workflow, domain_mesh_source=str(global_path),
                        domain_region_markers=[{"geometry_name": "conductor", "marker": 1}])
        sink = {}
        with patch("fullmag.meshing.realize_fem_mesh_asset", side_effect=AssertionError("must not remesh")), \
             patch.object(_core, "validate_mesh_ir", wraps=_core.validate_mesh_ir) as validation:
            result = self.build(mesh_workflow=workflow, _realized_object_mesh_sink=sink)
        self.assertEqual(set(sink), {"conductor", "sampling"})
        self.assertEqual(len(result["fem_mesh_assets"]), 2)
        np.testing.assert_array_equal(result["fem_domain_mesh_asset"]["mesh"]["nodes"], self.mesh.nodes)
        np.testing.assert_array_equal(sink["conductor"].cell_nodes, self.mesh.cell_nodes)
        np.testing.assert_array_equal(sink["sampling"].facet_global_ordinals, self.mesh.facet_global_ordinals)
        self.assertEqual(validation.call_count, 2)

    def test_owner_and_conflicting_sources_fail_closed(self) -> None:
        cases = [[{"geometry": "missing", "source": str(self.source)}],
                 [{"source": str(self.source)}],
                 [{"geometry": "conductor", "source": str(self.source)},
                  {"geometry": "conductor", "source": str(self.root / "other.npz")}]]
        with patch("fullmag.meshing.realize_fem_mesh_asset", side_effect=AssertionError("must not remesh")):
            for entries in cases:
                with self.subTest(entries=entries), self.assertRaises(ValueError):
                    self.build(mesh_workflow={"per_geometry": entries})

    def test_source_reread_never_uses_generated_cache_or_fallback(self) -> None:
        import fullmag.model.problem as problem
        cache = {}
        with patch("fullmag.meshing.realize_fem_mesh_asset", side_effect=AssertionError("must not remesh")):
            self.build(asset_cache=cache)
            self.assertEqual(cache, {})
            key = problem._geometry_asset_cache_key(**self.kwargs, mesh_workflow=self.workflow,
                study_universe=None, per_object_recipes=None, object_regions=None,
                body_material_fields=None, fdm_only=False)
            cache[key] = {"stale": True}
            self.source.write_bytes(b"corrupt source")
            with self.assertRaises((ValueError, OSError)):
                self.build(asset_cache=cache)
            self.source.unlink()
            with self.assertRaises(OSError):
                self.build(asset_cache=cache)

    def test_only_new_source_path_requires_positive_p1_tet4(self) -> None:
        self.mesh = replace(self.mesh, cell_nodes=np.asarray([1, 0, 2, 3]))
        self.mesh.save(self.source)
        with self.assertRaises(ValueError):
            self.build()
        _mixed_linear_mesh().save(self.source)
        with self.assertRaisesRegex(ValueError, "Tet4"):
            self.build()
        with self.assertRaisesRegex(ValueError, "P1"):
            self.build(discretization=fm.DiscretizationHints(fem=fm.FEM(order=2, hmax=1e-9)))

    def test_backend_intent_is_honored_or_rejected(self) -> None:
        with patch("fullmag.meshing.realize_fem_mesh_asset", side_effect=AssertionError("must not remesh")):
            result = self.build(requested_backend=BackendTarget.AUTO)
            self.assertEqual(len(result["fem_mesh_assets"]), 2)
            for backend, hints in [(BackendTarget.FDM, self.kwargs["discretization"]),
                                   (BackendTarget.AUTO, fm.DiscretizationHints(fdm=fm.FDM(cell=(1e-9,) * 3))),
                                   (BackendTarget.AUTO, None)]:
                with self.subTest(backend=backend, hints=hints), self.assertRaisesRegex(ValueError, "FEM configuration"):
                    self.build(requested_backend=backend, discretization=hints)

    def test_partial_object_id_map_keeps_all_geometry_owners(self) -> None:
        partial_ids = {"conductor": "source-id"}
        with patch("fullmag.meshing.realize_fem_mesh_asset", return_value=self.mesh) as generate:
            result = self.build(geometry_object_ids=partial_ids, mesh_workflow={})
        self.assertEqual(generate.call_count, 2)
        self.assertEqual(len(result["fem_mesh_assets"]), 2)
        sink = {}
        with patch("fullmag.meshing.realize_fem_mesh_asset", side_effect=AssertionError("must not remesh")):
            result = self.build(geometry_object_ids=partial_ids, _realized_object_mesh_sink=sink)
        self.assertEqual(set(sink), {"conductor", "sampling"})
        self.assertEqual(len(result["fem_mesh_assets"]), 2)

    def test_source_less_mixed_and_fdm_paths_are_unchanged(self) -> None:
        mixed = _mixed_linear_mesh()
        with patch("fullmag.meshing.realize_fem_mesh_asset", return_value=mixed) as generate:
            result = self.build(mesh_workflow={"per_geometry": []})
        self.assertEqual(generate.call_count, 2)
        self.assertEqual(result["fem_mesh_assets"][0]["mesh"]["cells"]["types"], mixed.cell_types.tolist())
        self.assertEqual(set(mixed.cell_types), {"tet4", "prism6", "pyramid5", "hex8"})
        self.assertIsNone(self.build(requested_backend=BackendTarget.FDM, mesh_workflow={}))
        self.assertIsNone(self.build(discretization=None, mesh_workflow={"per_geometry": None}))


if __name__ == "__main__":
    unittest.main()
