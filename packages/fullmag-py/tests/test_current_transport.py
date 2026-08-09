from __future__ import annotations

import textwrap
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

import fullmag as fm
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)
from fullmag.runtime.script_builder import (
    _render_current_modules,
    export_builder_draft,
    rewrite_loaded_problem_script,
)


def _base_problem(**kwargs) -> fm.Problem:
    geometry = fm.Box(size=(100e-9, 100e-9, 5e-9), name="layer")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    magnet = fm.Ferromagnet(name="layer", geometry=geometry, material=material)
    defaults = dict(
        name="current_transport_test",
        magnets=[magnet],
        energy=[fm.Exchange(), fm.Demag()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(),
            outputs=[fm.SaveScalar("E_total", every=10e-12)],
        ),
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(2e-9, 2e-9, 5e-9))),
    )
    defaults.update(kwargs)
    return fm.Problem(**defaults)  # type: ignore[arg-type]


class CurrentTransportTests(unittest.TestCase):
    def _closed_current_view(self) -> fm.ConservativeCurrentView:
        identity = fm.ConservativeCurrentIdentity(
            source_module_id="drive",
            source_state_revision="state-1",
            source_field_digest="field-1",
            conductivity_digest="sigma-1",
            mesh_revision="mesh-1",
            topology_revision="topology-1",
            geometry_digest="geometry-1",
            envelope_revision="envelope-1",
            envelope_digest="envelope-digest-1",
            evaluated_envelope_multiplier=1.0,
            evaluation_time_s=0.0,
            stage_identity=1,
        )
        return fm.ConservativeCurrentView(
            stable_vertex_ids=[10, 20, 30, 40],
            boundary_faces=[
                fm.ConservativeCurrentBoundaryFace((10, 20, 30), "source_cut", "cut"),
                fm.ConservativeCurrentBoundaryFace((10, 20, 40), "source_cut", "cut"),
                fm.ConservativeCurrentBoundaryFace((10, 30, 40), "insulating_outer"),
                fm.ConservativeCurrentBoundaryFace((20, 30, 40), "insulating_outer"),
            ],
            identity=identity,
            pins=fm.ConservativeCurrentPins(
                required_source_state_revision="state-1",
                required_source_field_digest="field-1",
                required_mesh_revision="mesh-1",
                required_topology_revision="topology-1",
            ),
            closure=fm.ConservativeCurrentClosedGeometry(
                "fem_charge_rt0.v1",
                "closure-1",
                "closure-digest-1",
                [
                    fm.ConservativeCurrentSourceCut(
                        "cut",
                        (1.0, 0.0, 0.0),
                        0.1,
                        [
                            fm.ConservativeCurrentSourceCutFacePair(
                                (10, 20, 30), (10, 20, 40)
                            )
                        ],
                    )
                ],
            ),
            algebraic_relative_tolerance=1.0e-10,
            physical_relative_gate=1.0e-8,
            physical_absolute_gate_a=1.0e-12,
        )

    def test_closed_conservative_current_view_round_trips_public_surfaces(self) -> None:
        view = self._closed_current_view()
        conductor = fm.RegionRef("layer")
        transport = fm.CurrentTransport(
            name="drive",
            model="ohmic_poisson",
            domain=[conductor],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    conductor, fm.ChargeTransportMaterial(sigma_Spm=5.8e7)
                )
            ],
            boundaries=[
                fm.ChargeInsulating(
                    "outer",
                    [fm.SurfaceRef("layer", "outer", (1.0, 0.0, 0.0))],
                )
            ],
            gauge=fm.ChargePotentialGauge("zero_mean"),
            solver=fm.ChargeSolverPolicy(),
            conservative_current_view=view,
        )
        rendered = _render_current_modules(
            _base_problem(current_modules=[transport]), overrides={}, surface="flat"
        )
        rebuilt = eval(rendered[1], {"fm": fm})
        self.assertEqual(rebuilt.to_ir(), transport.to_ir())
        entry = transport.to_ir()
        scene = build_scene_document_from_builder(
            {"revision": 1, "geometries": [], "current_modules": [entry]}
        )
        self.assertEqual(build_builder_from_scene_document(scene)["current_modules"], [entry])

    def test_conservative_current_view_is_restricted_to_one_way_ohmic_transport(self) -> None:
        view = self._closed_current_view()
        with self.assertRaisesRegex(ValueError, "one_way"):
            self._bidirectional_transport_with_view(view)
        with self.assertRaisesRegex(ValueError, "ohmic_poisson"):
            fm.CurrentTransport(
                name="drive",
                current_density=(1.0, 0.0, 0.0),
                conservative_current_view=view,
            )

    def test_source_cut_requires_distinct_minus_and_plus_faces(self) -> None:
        with self.assertRaisesRegex(ValueError, "distinct"):
            fm.ConservativeCurrentSourceCutFacePair((10, 20, 30), (30, 20, 10))

    def _bidirectional_transport_with_view(
        self, view: fm.ConservativeCurrentView
    ) -> fm.CurrentTransport:
        conductor = fm.RegionRef("layer")
        return fm.CurrentTransport(
            name="m2-charge",
            model="ohmic_poisson",
            coupling="bidirectional",
            domain=[conductor],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    conductor,
                    fm.ChargeTransportMaterial(
                        sigma_Spm=5.8e7,
                        sigma_parallel_Spm=5.9e7,
                        sigma_perpendicular_Spm=5.7e7,
                        sigma_AHE_Spm=1.2e5,
                    ),
                )
            ],
            boundaries=[],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(
                engine="block_gmres",
                operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
            ),
            conservative_current_view=view,
        )

    def _bidirectional_transport(self) -> fm.CurrentTransport:
        conductor = fm.RegionRef("layer")
        x_min = fm.SurfaceRef("layer", "x_min", (-1.0, 0.0, 0.0))
        x_max = fm.SurfaceRef("layer", "x_max", (1.0, 0.0, 0.0))
        material = fm.ChargeTransportMaterial(
            sigma_Spm=5.8e7,
            sigma_parallel_Spm=5.9e7,
            sigma_perpendicular_Spm=5.7e7,
            sigma_AHE_Spm=1.2e5,
        )
        return fm.CurrentTransport(
            name="m2-charge",
            model="ohmic_poisson",
            coupling="bidirectional",
            domain=[conductor],
            materials=[fm.ChargeTransportMaterialAssignment(conductor, material)],
            boundaries=[
                fm.VoltageElectrode("ground", [x_min], potential_V=0.0),
                fm.VoltageElectrode("drive", [x_max], potential_V=0.1),
            ],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(
                engine="block_gmres",
                relative_tolerance=1.0e-11,
                absolute_tolerance=1.0e-14,
                max_iterations=200,
                operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
            ),
        )

    def test_ohmic_poisson_serializes_complete_charge_contract(self) -> None:
        conductor = fm.RegionRef("layer")
        x_min = fm.SurfaceRef("layer", "x_min", (-1.0, 0.0, 0.0))
        x_max = fm.SurfaceRef("layer", "x_max", (1.0, 0.0, 0.0))
        transport = fm.CurrentTransport(
            name="charge",
            model="ohmic_poisson",
            domain=[conductor],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    conductor,
                    fm.ChargeTransportMaterial(sigma_Spm=5.8e7),
                )
            ],
            boundaries=[
                fm.VoltageElectrode("ground", [x_min], potential_V=0.0),
                fm.VoltageElectrode("drive", [x_max], potential_V=0.1),
            ],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(relative_tolerance=1.0e-10),
        )

        ir = transport.to_ir()
        self.assertEqual(ir["domain"], [{"object_id": "layer"}])
        self.assertEqual(ir["materials"][0]["material"]["sigma_Spm"], 5.8e7)  # type: ignore[index]
        self.assertEqual(ir["boundaries"][0]["kind"], "voltage_electrode")  # type: ignore[index]
        self.assertEqual(ir["gauge"], "dirichlet_reference")
        self.assertEqual(ir["solver"]["engine"], "cg")  # type: ignore[index]

    def test_current_transport_time_envelope_round_trips_through_ir_scene_and_script(self) -> None:
        conductor = fm.RegionRef("layer")
        x_min = fm.SurfaceRef("layer", "x_min", (-1.0, 0.0, 0.0))
        x_max = fm.SurfaceRef("layer", "x_max", (1.0, 0.0, 0.0))
        transport = fm.CurrentTransport(
            name="charge-envelope",
            model="ohmic_poisson",
            domain=[conductor],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    conductor,
                    fm.ChargeTransportMaterial(sigma_Spm=5.8e7),
                )
            ],
            boundaries=[
                fm.VoltageElectrode("ground", [x_min], potential_V=0.0),
                fm.VoltageElectrode("drive", [x_max], potential_V=0.1),
            ],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(),
            time_envelope=fm.SinusoidalEnvelope(
                amplitude=0.25,
                frequency_hz=2.0e9,
                phase_rad=0.3,
                offset=0.75,
            ),
        )
        expected = {
            "kind": "sinusoidal",
            "amplitude": 0.25,
            "frequency_hz": 2.0e9,
            "phase_rad": 0.3,
            "offset": 0.75,
        }
        self.assertEqual(transport.to_ir()["time_envelope"], expected)
        scene = build_scene_document_from_builder(
            {"revision": 3, "geometries": [], "current_modules": [transport.to_ir()]}
        )
        self.assertEqual(
            build_builder_from_scene_document(scene)["current_modules"],
            [transport.to_ir()],
        )
        rendered = _render_current_modules(
            _base_problem(current_modules=[transport]), overrides={}, surface="flat"
        )
        rebuilt = eval(rendered[1], {"fm": fm})
        self.assertEqual(rebuilt.to_ir(), transport.to_ir())

    def test_ohmic_poisson_rejects_ambiguous_legacy_definition(self) -> None:
        with self.assertRaisesRegex(ValueError, "complete charge contract"):
            fm.CurrentTransport(
                name="charge",
                model="ohmic_poisson",
                solve_region="layer",
                conductivity_s_per_m=5.8e7,
            )

    def test_bidirectional_contract_round_trips_through_script_and_scene(self) -> None:
        transport = self._bidirectional_transport()
        problem = _base_problem(current_modules=[transport])
        rendered = _render_current_modules(problem, overrides={}, surface="flat")
        self.assertIn("sigma_parallel_Spm", rendered[1])
        self.assertIn("fdm_coupled_charge_spin_fv_block_gmres.v1", rendered[1])

        fm.reset()
        rebuilt = eval(rendered[1], {"fm": fm})
        self.assertIsInstance(rebuilt, fm.CurrentTransport)
        self.assertEqual(rebuilt.to_ir(), transport.to_ir())

        entry = transport.to_ir()
        scene = build_scene_document_from_builder(
            {"revision": 2, "geometries": [], "current_modules": [entry]}
        )
        self.assertEqual(scene["current_transports"], [entry])
        self.assertEqual(
            build_builder_from_scene_document(scene)["current_modules"], [entry]
        )

    def test_prescribed_density_serializes_to_ir(self) -> None:
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        ir = transport.to_ir()
        self.assertEqual(ir["kind"], "current_transport")
        self.assertEqual(ir["model"], "prescribed_density")
        self.assertEqual(ir["current_density"], [0.0, 0.0, 5e10])

    def test_source_bound_slonczewski_preserves_current_source(self) -> None:
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        problem = _base_problem(
            current_modules=[transport],
            spin_torque=fm.SlonczewskiSTT(
                spin_polarization=(0.0, 0.0, 1.0),
                current_source="drive",
                degree=0.6,
            ),
        )
        ir = problem.to_ir()
        self.assertEqual(ir["current_modules"][0]["kind"], "current_transport")  # type: ignore[index]
        self.assertEqual(ir["spin_torque_modules"][0]["current_source"], "drive")  # type: ignore[index]
        self.assertNotIn("current_density", ir)

    def test_oersted_field_from_current_solution_serializes_to_ir(self) -> None:
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
            solve_region="pillar",
        )
        problem = _base_problem(
            current_modules=[transport],
            energy=[fm.Exchange(), fm.Demag(), fm.OerstedField(source="drive")],
        )
        ir = problem.to_ir()
        self.assertEqual(ir["energy_terms"][2]["kind"], "oersted_field")  # type: ignore[index]
        self.assertEqual(ir["energy_terms"][2]["model"], "from_current_solution")  # type: ignore[index]
        self.assertEqual(ir["energy_terms"][2]["source"], "drive")  # type: ignore[index]

    def test_oersted_field_requires_current_transport_source(self) -> None:
        with self.assertRaises(ValueError):
            _base_problem(
                current_modules=[
                    fm.AntennaFieldSource(
                        name="antenna",
                        antenna=fm.CPWAntenna(
                            signal_width=10e-9,
                            gap=5e-9,
                            ground_width=10e-9,
                            thickness=10e-9,
                            height_above_magnet=20e-9,
                            preview_length=100e-9,
                        ),
                        drive=fm.RfDrive(current_a=0.01, frequency_hz=10e9),
                    )
                ],
                energy=[fm.Exchange(), fm.Demag(), fm.OerstedField(source="antenna")],
            )

    def test_excitation_analysis_must_reference_antenna(self) -> None:
        with self.assertRaises(ValueError):
            _base_problem(
                current_modules=[
                    fm.CurrentTransport(
                        name="drive",
                        current_density=(0.0, 0.0, 5e10),
                    )
                ],
                excitation_analysis=fm.SpinWaveExcitationAnalysis(source="drive"),
            )

    def test_prescribed_zeeman_mask_antenna_serializes_to_ir(self) -> None:
        source = fm.AntennaFieldSource(
            name="center_drive",
            model="prescribed_zeeman_mask",
            object="center_microstrip",
            B=1e-3,
            direction=(0.0, 0.0, 1.0),
            waveform=fm.SincPulse(cutoff_hz=20e9, t0=50e-12),
        )
        ir = source.to_ir()
        self.assertEqual(ir["kind"], "antenna_field_source")
        self.assertEqual(ir["model"], "prescribed_zeeman_mask")
        self.assertEqual(ir["object"], "center_microstrip")
        self.assertEqual(ir["field"]["amplitude_B_T"], 1e-3)  # type: ignore[index]
        self.assertEqual(ir["field"]["direction"], [0.0, 0.0, 1.0])  # type: ignore[index]
        self.assertEqual(ir["spatial_profile"], {"kind": "uniform"})
        self.assertEqual(ir["waveform"]["kind"], "sinc_pulse")  # type: ignore[index]

    def test_prescribed_zeeman_mask_script_rewrite(self) -> None:
        source = fm.AntennaFieldSource(
            name="center_drive",
            model="prescribed_zeeman_mask",
            object="center_microstrip",
            B=1e-3,
            direction=(0.0, 0.0, 1.0),
            waveform=fm.SincPulse(cutoff_hz=20e9, t0=50e-12),
        )
        problem = _base_problem(
            current_modules=[source],
            auxiliary_geometries=[
                fm.Box(size=(50e-9, 100e-9, 5e-9), name="center_microstrip")
            ],
        )
        from fullmag.runtime.script_builder import _render_field_drives

        rendered = "\n".join(
            _render_field_drives(problem, surface="flat")
        )
        self.assertNotIn('model="prescribed_zeeman_mask"', rendered)
        self.assertIn('object_id="center_microstrip"', rendered)
        self.assertIn("amplitude_B_T=0.001", rendered)
        self.assertIn("SincPulse", rendered)

    def test_flat_antenna_object_prescribed_zeeman_mask_round_trip(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            fm.name("antenna_mask_flat")
            fm.cell(5e-9, 5e-9, 5e-9)

            layer = fm.geometry(fm.Box(100e-9, 100e-9, 5e-9), name="layer")
            layer.Ms = 800e3
            layer.Aex = 13e-12
            layer.alpha = 0.01
            layer.m = fm.texture.uniform(1, 0, 0)

            fm.antenna_object(fm.Box(50e-9, 100e-9, 5e-9), name="center_microstrip")
            fm.antenna_field_source(
                name="center_drive",
                model="prescribed_zeeman_mask",
                object="center_microstrip",
                B=1e-3,
                direction=(0, 1, 0),
                waveform=fm.SincPulse(cutoff_hz=20e9, t0=50e-12),
            )
            fm.save("H_drive", every=1e-12)
            fm.run(2e-12)
            """
        )
        with TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "antenna_mask_flat.py"
            script_path.write_text(script, encoding="utf-8")
            loaded = load_problem_from_script(script_path)
            ir = loaded.problem.to_ir(script_source=script, source_root=script_path.parent)
            geometry_names = [entry["name"] for entry in ir["geometry"]["entries"]]  # type: ignore[index]
            self.assertIn("center_microstrip", geometry_names)
            self.assertEqual(ir["current_modules"], [])
            self.assertEqual(
                ir["field_drives"][0]["spatial_profile"]["object_id"],  # type: ignore[index]
                "center_microstrip",
            )

            rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
            self.assertIn("fm.antenna_object", rendered)
            self.assertIn('object_id="center_microstrip"', rendered)

    def test_flat_antenna_object_exports_scene_document_object(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            fm.name("antenna_scene_flat")
            fm.cell(5e-9, 5e-9, 5e-9)

            layer = fm.geometry(fm.Box(100e-9, 100e-9, 5e-9), name="layer")
            layer.Ms = 800e3
            layer.Aex = 13e-12
            layer.alpha = 0.01

            fm.antenna_object(fm.Box(50e-9, 100e-9, 5e-9), name="center_microstrip")
            fm.antenna_field_source(
                name="center_drive",
                model="prescribed_zeeman_mask",
                object="center_microstrip",
                B=1e-3,
                direction=(0, 1, 0),
                waveform=fm.SincPulse(cutoff_hz=20e9, t0=50e-12),
            )
            fm.run(2e-12)
            """
        )
        with TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "antenna_scene_flat.py"
            script_path.write_text(script, encoding="utf-8")
            loaded = load_problem_from_script(script_path)
            scene = build_scene_document_from_builder(export_builder_draft(loaded))

        antenna = next(
            obj for obj in scene["objects"] if obj["id"] == "center_microstrip"
        )
        self.assertEqual(antenna["role"], "antenna")
        self.assertEqual(antenna["material_ref"], "")
        self.assertIsNone(antenna["magnetization_ref"])
        self.assertEqual(antenna["visualization_hint"]["role"], "antenna")
        self.assertEqual(
            scene["field_drives"]["drives"][0]["spatial_profile"]["object_id"],
            "center_microstrip",
        )

    def test_flat_script_round_trip_renders_current_transport(self) -> None:
        script = textwrap.dedent(
            """
            import fullmag as fm

            fm.name("transport_flat")
            fm.cell(2e-9, 2e-9, 5e-9)

            layer = fm.geometry(fm.Box(100e-9, 100e-9, 5e-9), name="layer")
            layer.Ms = 800e3
            layer.Aex = 13e-12
            layer.alpha = 0.01
            layer.m = fm.texture.uniform(1, 0, 0)

            fm.current_transport(name="drive", current_density=(0.0, 0.0, 5e10))
            fm.tableautosave(10e-12, ["E_total"])
            fm.run(20e-12)
            """
        )
        with TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "transport_flat.py"
            script_path.write_text(script, encoding="utf-8")
            loaded = load_problem_from_script(script_path)
            rewritten = rewrite_loaded_problem_script(loaded)["rendered_source"]

        self.assertIn('fm.current_transport(name="drive"', rewritten)
        self.assertIn("current_density=(0, 0, 50000000000)", rewritten)

    def test_flat_script_round_trip_renders_spin_torques(self) -> None:
        """Spin torques are emitted into the canonical script rewrite."""
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        problem = _base_problem(
            current_modules=[transport],
            spin_torques=[
                fm.SlonczewskiSTT(
                    spin_polarization=(0.0, 0.0, 1.0),
                    current_source="drive",
                    degree=0.6,
                ),
            ],
        )
        from fullmag.runtime.script_builder import _render_spin_torques

        lines = _render_spin_torques(problem, surface="flat")
        rendered = "\n".join(lines)
        self.assertIn("SlonczewskiSTT", rendered)
        self.assertIn('current_source="drive"', rendered)
        self.assertIn("degree=0.6", rendered)

    def test_export_builder_draft_includes_spin_torques(self) -> None:
        """Builder draft export includes spin_torque entries."""
        transport = fm.CurrentTransport(
            name="drive",
            current_density=(0.0, 0.0, 5e10),
        )
        problem = _base_problem(
            current_modules=[transport],
            spin_torques=[
                fm.SlonczewskiSTT(
                    spin_polarization=(0.0, 0.0, 1.0),
                    current_source="drive",
                ),
                fm.ZhangLiSTT(
                    current_density=(1e10, 0.0, 0.0),
                    beta=0.05,
                ),
            ],
        )
        from fullmag.runtime.script_builder import _export_spin_torque_entry

        entries = [_export_spin_torque_entry(m) for m in problem.spin_torques]
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["kind"], "slonczewski")
        self.assertEqual(entries[0]["current_source"], "drive")
        self.assertEqual(entries[1]["kind"], "zhang_li")
        self.assertAlmostEqual(entries[1]["beta"], 0.05)


if __name__ == "__main__":
    unittest.main()
