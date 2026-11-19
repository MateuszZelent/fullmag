"""Explicit RT0 surface inspection authoring, without executing a field solve."""
from dataclasses import replace
import copy

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import fullmag as fm
from test_antenna_coincident_cut import loop_geometry, closure
from fullmag.model.problem import BackendTarget, DeviceTarget


def authored_problem(*, geometry=None, assignments=None, ports=True):
    geometry = geometry or loop_geometry()
    if assignments is None:
        assignments = [fm.ChargeTransportMaterialAssignment(fm.RegionRef("object", part),
            fm.ChargeTransportMaterial(sigma)) for part, sigma in (
                (geometry.signal_part_id, geometry.conductivity_s_per_m),
                (geometry.return_part_id, geometry.conductivity_s_per_m),
                (geometry.inlet_connection_part_id, geometry.inlet_connection_conductivity_s_per_m),
                (geometry.outlet_connection_part_id, geometry.outlet_connection_conductivity_s_per_m))]
    transport = fm.CurrentTransport(name="charge", model="ohmic_poisson", domain=[fm.RegionRef("object")],
        materials=assignments, boundaries=[], gauge=fm.ChargePotentialGauge("zero_mean"),
        solver=fm.ChargeSolverPolicy(relative_tolerance=1e-12,
            operator_version="fem_charge_conforming_h1_p1.transparent.v1"), structured_current_closure=closure())
    port = fm.AntennaPortMode(id="port", source_object_id="object", current_transport_id="charge",
        schema_version="antenna_port_mode.v3", normalization=fm.AntennaSourceCutRt0("cut"),
        branches=[fm.AntennaPortBranch(geometry.signal_part_id,"signal-in","signal-out",1.),
                  fm.AntennaPortBranch(geometry.return_part_id,"return-in","return-out",-1.)])
    stage = fm.AntennaFieldSolveStage(id="solve", source_object_id="object", current_transport_id="charge",
        port_mode_ids=["port"], field_sampling_domain=fm.FieldTarget.object("object"),
        target_refs=[fm.FieldTarget.object("object")], outputs=[fm.AntennaNamedOutput("inspection","H_ant_basis")])
    return fm.Problem(name="coincident_public", magnets=[], energy=[], study=fm.FieldOnly(),
        auxiliary_geometries=[geometry], auxiliary_geometry_roles={geometry.geometry_name:"antenna"},
        auxiliary_geometry_object_ids={geometry.geometry_name:"object"}, current_modules=[transport],
        antenna_port_modes=[port] if ports else [], antenna_field_solve_stages=[stage] if ports else [],
        discretization=fm.DiscretizationHints(fem=fm.FEM(maximum_element_size=0.15e-6,order=1)),
        runtime=fm.RuntimeSelection(backend_target=BackendTarget.FEM, device_target=DeviceTarget.CPU),
        runtime_metadata={"script_api_surface":"study"})


def policy_payload():
    # Construction fixture only: these small budgets do not authorize a solve.
    return {
        "policy_version": "caller_supplied_rt0_surface.inspection.v1",
        "limits": {"total": [4_000_000] + [1] * 13, "per_target": [1] * 14,
            "maximum_raw_integer_bits": 64, "maximum_reduced_fraction_bits": 64,
            "maximum_lifetime_peak_rss_bytes": 1, "guard_interval_events": 1,
            "maximum_total_seconds": 0.5, "maximum_target_seconds": 0.25},
        "tolerances": {"absolute_field_apm": 1e-9, "relative_field": 1e-5,
            "cancellation_floor_apm": 1e-6, "scalar_relative_80": 1e-45,
            "scalar_relative_120": 1e-55, "angle_relative_80": 1e-45,
            "angle_relative_120": 1e-55, "binary_scalar_epsilon_factor": 64.,
            "binary_roundoff_epsilon_factor": 64., "binary_cancellation_limit": 1e8,
            "highprecision_cancellation_limit": 1e40},
    }


def surface_stage():
    return replace(authored_problem().antenna_field_solve_stages[0],
        oersted_realization="analytic_rt0_surface",
        surface_field_policy=fm.AntennaSurfaceFieldPolicy(**policy_payload()))


class SurfacePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="surface-policy-")
        self.addCleanup(self.temporary.cleanup)
        self.tmp_path = Path(self.temporary.name)

    def test_surface_policy_is_explicit_frozen_and_exact_in_ir(self):
        payload = policy_payload()
        policy = fm.AntennaSurfaceFieldPolicy(**payload)
        assert policy.to_ir() == payload
        payload["limits"]["total"][0] = 7
        payload["tolerances"]["relative_field"] = 0.5
        assert policy.to_ir() == policy_payload()
        with self.assertRaises(TypeError):
            policy.limits["guard_interval_events"] = 2
        with self.assertRaises(TypeError):
            policy.tolerances["relative_field"] = 0.1
        ir = surface_stage().to_ir()
        assert ir["oersted_realization"] == "analytic_rt0_surface"
        assert ir["surface_field_policy"] == policy.to_ir()
        assert "surface_field_policy" not in authored_problem().antenna_field_solve_stages[0].to_ir()


    def test_surface_policy_rejects_invalid_values(self):
        for section, key, value in [
            ("limits", "total", [True] * 14), ("limits", "total", [1] * 13),
            ("limits", "total", [4_000_001] + [1] * 13),
            ("limits", "guard_interval_events", True), ("limits", "maximum_raw_integer_bits", 2**64),
            ("limits", "maximum_raw_integer_bits", 1.0), ("limits", "maximum_total_seconds", float("inf")),
            ("limits", "maximum_target_seconds", False), ("limits", "maximum_lifetime_peak_rss_bytes", 0),
            ("tolerances", "absolute_field_apm", 1.01e-9), ("tolerances", "relative_field", 1.01e-5),
            ("tolerances", "scalar_relative_80", 1e-44), ("tolerances", "angle_relative_120", 1e-54),
            ("tolerances", "binary_roundoff_epsilon_factor", 63.),
            ("tolerances", "binary_cancellation_limit", 1.01e8),
            ("tolerances", "highprecision_cancellation_limit", 1.01e40),
            ("tolerances", "cancellation_floor_apm", 1.01e-6),
            ("tolerances", "binary_scalar_epsilon_factor", True),
        ]:
            with self.subTest(section=section, key=key, value=value):
                payload = policy_payload()
                payload[section][key] = value
                with self.assertRaises(ValueError):
                    fm.AntennaSurfaceFieldPolicy(**payload)


    def test_surface_policy_rejects_missing_or_extra_fields(self):
        for section in ("limits", "tolerances"):
            for change in ("missing", "extra"):
                with self.subTest(section=section, change=change):
                    payload = policy_payload()
                    if change == "missing":
                        payload[section].pop(next(iter(payload[section])))
                    else:
                        payload[section]["unknown"] = 1
                    with self.assertRaises(ValueError):
                        fm.AntennaSurfaceFieldPolicy(**payload)


    def test_surface_method_requires_exact_typed_policy_pair(self):
        direct = authored_problem().antenna_field_solve_stages[0]
        with self.assertRaises(ValueError):
            replace(direct, oersted_realization="analytic_rt0_surface")
        with self.assertRaises(ValueError):
            replace(direct, surface_field_policy=fm.AntennaSurfaceFieldPolicy(**policy_payload()))
        with self.assertRaises(TypeError):
            replace(direct, oersted_realization="analytic_rt0_surface", surface_field_policy=policy_payload())
        payload = policy_payload()
        payload["policy_version"] = "volume_inspection_v1"
        with self.assertRaises(ValueError):
            fm.AntennaSurfaceFieldPolicy(**payload)


    def test_surface_policy_survives_script_and_scene_round_trip(self):
        tmp_path = self.tmp_path
        from fullmag.runtime.loader import LoadedProblem, load_problem_from_script
        from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script
        from fullmag.runtime.scene_document import build_scene_document_from_builder
        stage = surface_stage()
        problem = replace(authored_problem(), antenna_field_solve_stages=[stage])
        loaded = LoadedProblem(problem=problem, source_path=tmp_path / "source.py", script_source="", entrypoint_kind="flat_workspace")
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        saved = copy.deepcopy(scene)
        for index, script in enumerate([render_loaded_problem_as_script(loaded), render_scene_document_as_script(scene)]):
            assert "fm.AntennaSurfaceFieldPolicy(" in script
            path = tmp_path / f"surface-roundtrip-{index}.py"
            path.write_text(script, encoding="utf-8")
            replay = load_problem_from_script(path, lightweight_assets=True)
            authored = replay.workspace_problem or replay.problem
            assert authored.antenna_field_solve_stages[0].to_ir() == stage.to_ir()
        assert scene == saved


    def test_field_method_and_policy_do_not_change_prepared_charge_source(self):
        tmp_path = self.tmp_path
        environment = patch.dict(os.environ, {"FULLMAG_FEM_MESH_CACHE_DIR": str(tmp_path / "mesh-cache")})
        environment.start()
        self.addCleanup(environment.stop)
        problem = authored_problem()
        baseline = problem.to_ir(include_geometry_assets=True)
        changed = replace(problem, antenna_field_solve_stages=[surface_stage()]).to_ir(include_geometry_assets=True)
        assert baseline["current_modules"] == changed["current_modules"]
        assert baseline["geometry_assets"] == changed["geometry_assets"]
        assert changed["antenna_field_solve_stages"][0]["surface_field_policy"] == policy_payload()


if __name__ == "__main__":
    unittest.main()
