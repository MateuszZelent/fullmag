"""Interpreted execution-only antenna lead binding; no native field or LLG solve."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from verify_antenna_lead_authoring import LeadAuthoringChecks
from verify_antenna_external_lead_preparation import LeadPreparationChecks


class LeadMaterializationChecks(unittest.TestCase):
    storage_root: Path

    def capture(self, *, antenna_expression="fm.Box(1e-6,1e-6,1e-6)", transport=None):
        from fullmag.runtime.loader import load_problem_from_script
        from fullmag.runtime.script_builder import _render_current_transport_payload

        authoring = LeadAuthoringChecks()
        source = (
            "import fullmag as fm\n"
            "study = fm.study('lead-execution')\n"
            "study.engine('fem')\nstudy.device('cpu', precision='double')\n"
            "study.objects.mesh.defaults(maximum_element_size=0.5e-6, order=1)\nstudy.disable_demag()\n"
            "film = study.geometry(fm.Box(1e-6,1e-6,1e-6), name='film', object_id='film-id')\n"
            "film.Ms=800e3\nfilm.Aex=13e-12\nfilm.alpha=0.01\n"
            f"study.antenna_object({antenna_expression}, name='Readable antenna', object_id='device')\n"
            + _render_current_transport_payload((transport or authoring.transport()).to_ir(), surface="flat") + "\n"
        )
        path = self.storage_root / "lead-execution.py"
        path.write_text(source, encoding="utf-8")
        return load_problem_from_script(path, lightweight_assets=True)

    def materialize(self, problem, ir, **changes):
        from fullmag.runtime.antenna_lead_materialization import materialize_antenna_lead_preparations
        values = dict(geometries=problem._collect_geometries(), discretization=problem.discretization,
                      mesh_workflow=None)
        values.update(changes)
        materialize_antenna_lead_preparations(problem, ir, **values)

    def test_full_export_and_disk_cache_preserve_identity_and_authored_state(self):
        from fullmag.runtime.script_builder import export_builder_draft

        loaded = self.capture()
        problem = loaded.problem
        authored = problem.to_ir(include_geometry_assets=False)
        before = json.dumps(export_builder_draft(loaded), sort_keys=True)
        mesh = LeadPreparationChecks.box_mesh(taper=0.8)
        with patch("fullmag.meshing.realize_fem_mesh_asset", return_value=mesh) as generate:
            first = problem.to_ir(include_geometry_assets=True)
            count = generate.call_count
        self.assertGreater(count, 0)
        with patch("fullmag.meshing.realize_fem_mesh_asset", side_effect=AssertionError("must use exact NPZ cache")):
            second = problem.to_ir(include_geometry_assets=True)
        current = first["current_modules"][0]
        self.assertNotIn("external_lead_preparation", current)
        self.assertEqual(current["conservative_current_source"]["device_stable_vertex_ids"], list(mesh.vertex_identity["vertex_ids"]))
        self.assertEqual(first["physics_graph"]["modules"][0]["family_payload"], current)
        self.assertEqual(current, second["current_modules"][0])
        receipt = first["problem_meta"]["runtime_metadata"]["antenna_lead_preparations"][0]
        self.assertEqual(receipt["authored_intent"], authored["current_modules"][0]["external_lead_preparation"])
        self.assertFalse(receipt["preparation"]["capabilities"]["per_ampere_basis"])
        self.assertEqual(before, json.dumps(export_builder_draft(loaded), sort_keys=True))
        second["current_modules"][0]["conservative_current_source"]["device_stable_vertex_ids"][0] = 7
        self.assertNotEqual(current, second["current_modules"][0])
        self.assertEqual(problem.to_ir(include_geometry_assets=False), authored)

    def test_shared_asset_is_not_the_device_mesh_and_cached_containers_are_untouched(self):
        loaded = self.capture()
        problem = loaded.problem
        ir = problem.to_ir(include_geometry_assets=False)
        shared = {"fdm_grid_assets": [], "fem_mesh_assets": [],
                  "fem_domain_mesh_asset": {"mesh": {"nodes": [[42., 0., 0.]]}}}
        ir["geometry_assets"] = shared
        before = copy.deepcopy(shared)
        mesh = LeadPreparationChecks.box_mesh()

        def independent(**kwargs):
            self.assertNotIn("study_universe", kwargs)
            self.assertNotIn("domain_mesh_source", kwargs["mesh_workflow"])
            geometry = kwargs["geometries"][0]
            kwargs["_realized_object_mesh_sink"][geometry.geometry_name] = mesh
            return {"fem_mesh_assets": [{"geometry_name": geometry.geometry_name, "mesh_source": None,
                                        "mesh": mesh.to_ir(geometry.geometry_name)}], "fdm_grid_assets": []}

        with patch("fullmag.model.problem.build_geometry_assets_for_request", side_effect=independent):
            self.materialize(problem, ir, mesh_workflow={"domain_mesh_source": "not-the-conductor.json"})
        self.assertEqual(shared, before)
        self.assertIs(ir["geometry_assets"]["fem_domain_mesh_asset"], shared["fem_domain_mesh_asset"])
        self.assertEqual(ir["current_modules"][0]["conservative_current_source"]["device_stable_vertex_ids"], list(mesh.vertex_identity["vertex_ids"]))

    def test_unsupported_lane_and_forced_override_refuse_before_meshing(self):
        problem = self.capture().problem
        for key, value in (("backend", "fdm"), ("precision", "single"), ("mode", "extended"), ("device", "gpu"), ("override", "gpu")):
            ir = problem.to_ir(include_geometry_assets=False)
            if key == "backend":
                ir["backend_policy"]["requested_backend"] = value
            elif key == "precision":
                ir["backend_policy"]["execution_precision"] = value
            elif key == "mode":
                ir["validation_profile"]["execution_mode"] = value
            elif key == "device":
                ir["problem_meta"]["runtime_metadata"]["runtime_selection"]["device"] = value
            with self.subTest(key=key), patch("fullmag.model.problem.build_geometry_assets_for_request", side_effect=AssertionError("invalid lane must not mesh")):
                with self.assertRaisesRegex(ValueError, "no device fallback"):
                    self.materialize(problem, ir, runtime_device_override=value if key == "override" else None)

    def test_absent_vertex_identity_is_not_replaced_with_ordinals(self):
        from dataclasses import replace
        problem = self.capture().problem
        ir = problem.to_ir(include_geometry_assets=False)
        mesh = replace(LeadPreparationChecks.box_mesh(), vertex_identity=None)

        def independent(**kwargs):
            geometry = kwargs["geometries"][0]
            kwargs["_realized_object_mesh_sink"][geometry.geometry_name] = mesh
            return {"fem_mesh_assets": [{"geometry_name": geometry.geometry_name, "mesh": mesh.to_ir(geometry.geometry_name)}]}

        before = copy.deepcopy(ir)
        with patch("fullmag.model.problem.build_geometry_assets_for_request", side_effect=independent):
            with self.assertRaisesRegex(ValueError, "identity"):
                self.materialize(problem, ir)
        self.assertEqual(ir, before)

    def test_real_gmsh_microstrip_and_taper_full_execution_export(self):
        import fullmag as fm
        from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker

        for taper in (1., 0.7):
            with self.subTest(taper=taper), patch.dict(os.environ, {
                "FULLMAG_FEM_MESH_CACHE_DIR": str(self.storage_root / f"real-gmsh-{taper}")
            }):
                extensions = []
                for part in ("signal", "return"):
                    for selector, direction in (("local_u_min", (-1., 0., 0.)), ("local_u_max", (1., 0., 0.))):
                        terminal = f"{part}:{selector}"
                        extensions.append(fm.TerminalLeadExtension(terminal, f"observe:{terminal}", "device",
                            [antenna_terminal_marker("device", part, selector)], 1e-6, direction, 4e7))
                currents = {extension.id: (-0.001 if extension.id.endswith("local_u_min") else 0.001)
                            * (1. if extension.id.startswith("signal:") else -1.) for extension in extensions}
                intent = fm.ExternalLeadPreparation("real-r1", extensions,
                    [fm.CurrentSourceDrive("real-drive", "real-port", currents)])
                transport = LeadAuthoringChecks().transport(external_lead_preparation=intent)
                layout = (
                    "fm.MicrostripAntennaLayout(name='not-the-owner', length_m=4e-6, thickness_m=0.5e-6, "
                    "conductivity_s_per_m=4e7, return_width_m=2e-6, return_offset_m=0.5e-6, "
                    f"stations=[fm.MicrostripWidthStation(0.,1e-6), fm.MicrostripWidthStation(1.,{taper}e-6)])"
                )
                problem = self.capture(antenna_expression=layout, transport=transport).problem
                first = problem.to_ir(include_geometry_assets=True)
                current = first["current_modules"][0]["conservative_current_source"]
                receipt = first["problem_meta"]["runtime_metadata"]["antenna_lead_preparations"][0]
                device = next(asset["mesh"] for asset in first["geometry_assets"]["fem_mesh_assets"]
                              if asset["geometry_name"] == receipt["geometry_id"])
                self.assertEqual(len(current["device_stable_vertex_ids"]), len(device["nodes"]))
                self.assertEqual(len(current["device_stable_vertex_ids"]), receipt["preparation"]["device_node_count"])
                self.assertNotIn("device_mesh", receipt["preparation"])
                self.assertNotIn("device_stable_vertex_ids", receipt["preparation"])
                self.assertEqual(len(current["outer_terminals"]), 4)
                self.assertEqual(current["drives"][0]["outer_terminal_currents_a"], currents)
                self.assertEqual(receipt["preparation"]["field_scope"], "external_electrode_truncation")
                with patch("fullmag.meshing.realize_fem_mesh_asset", side_effect=AssertionError("must use NPZ")):
                    second = problem.to_ir(include_geometry_assets=True)
                self.assertEqual(current, second["current_modules"][0]["conservative_current_source"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--storage-root", type=Path, required=True)
    args = parser.parse_args()
    if not args.storage_root.is_absolute() or not args.storage_root.is_dir():
        parser.error("--storage-root must be an existing absolute configured storage directory")
    sys.path.insert(0, str(args.repo_root / "packages/fullmag-py/src"))
    with tempfile.TemporaryDirectory(prefix="antenna-materialization-", dir=args.storage_root) as directory:
        LeadMaterializationChecks.storage_root = Path(directory)
        tempfile.tempdir = directory
        with patch.dict(os.environ, {"FULLMAG_FEM_MESH_CACHE_DIR": str(Path(directory) / "mesh-cache")}):
            result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LeadMaterializationChecks))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
