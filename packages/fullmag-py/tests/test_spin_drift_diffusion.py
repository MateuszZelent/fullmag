from __future__ import annotations

import json
import unittest
from dataclasses import replace
from pathlib import Path

import fullmag as fm


class SpinDriftDiffusionAuthoringTests(unittest.TestCase):
    def setUp(self) -> None:
        self.nm = fm.RegionRef("stack", "normal_metal")
        self.fm = fm.RegionRef("stack", "ferromagnet")
        self.top = fm.SurfaceRef("stack", "top", (0.0, 0.0, 1.0))

    def complete_charge_transport(self) -> fm.CurrentTransport:
        return fm.CurrentTransport(
            name="charge",
            model="ohmic_poisson",
            coupling="one_way",
            domain=[self.fm],
            materials=[fm.ChargeTransportMaterialAssignment(
                self.fm,
                fm.ChargeTransportMaterial(4.0e6),
            )],
            boundaries=[fm.VoltageElectrode("ground", [self.top], potential_V=0.0)],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(),
        )

    def fem_reciprocal_problem(self) -> fm.Problem:
        """Build the smallest public FEM M2 authoring fixture."""

        geometry = fm.Box(size=(30e-9, 20e-9, 2e-9), name="layer")
        magnet = fm.Ferromagnet(
            name="layer",
            geometry=geometry,
            material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01),
        )
        charge_operator = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
        charge = fm.CurrentTransport(
            name="charge",
            model="ohmic_poisson",
            coupling="bidirectional",
            domain=[self.fm],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    self.fm,
                    fm.ChargeTransportMaterial(
                        4.0e6,
                        sigma_parallel_Spm=4.0e6,
                        sigma_perpendicular_Spm=4.0e6,
                        sigma_AHE_Spm=0.0,
                    ),
                )
            ],
            boundaries=[fm.VoltageElectrode("top", [self.top], potential_V=0.01)],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(
                engine="block_gmres",
                operator_version=charge_operator,
            ),
        )
        spin = fm.SpinDriftDiffusion(
            id="spin",
            current_source_id="charge",
            domain=[self.fm],
            materials=[
                fm.SpinTransportMaterialAssignment(
                    self.fm,
                    fm.SpinTransportMaterial(
                        sigma_s_Spm=3.0e6,
                        polarization_p=0.2,
                        theta_sh=0.1,
                        lambda_sf_m=4.0e-9,
                        lambda_j_m=1.0e-9,
                        lambda_phi_m=1.0e-9,
                    ),
                )
            ],
            solver=fm.SpinSolverPolicy(
                engine="block_gmres",
                operator_version=charge_operator,
            ),
            requested_execution=fm.TransportExecution(
                discretization="fem",
                device="cpu",
                precision="double",
                execution_mode="strict",
            ),
        )
        return fm.Problem(
            name="fem_m2_authoring",
            magnets=[magnet],
            energy=[fm.Exchange()],
            current_modules=[charge],
            spin_transports=[spin],
            spin_torques=[fm.DriftDiffusionSpinTorque("torque", "spin", self.fm)],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(),
                outputs=[fm.SaveScalar("E_total", every=1.0e-12)],
            ),
            discretization=fm.DiscretizationHints(
                fem=fm.FEM(order=1, maximum_element_size=20e-9),
            ),
        )

    def test_public_problem_accepts_bounded_fem_m2_operator_without_nonlinear_policy(self) -> None:
        problem = self.fem_reciprocal_problem()
        ir = problem.to_ir(
            requested_backend=fm.BackendTarget.FEM,
            execution_mode=fm.ExecutionMode.STRICT,
            execution_precision=fm.ExecutionPrecision.DOUBLE,
            include_geometry_assets=False,
        )
        self.assertEqual(
            ir["current_modules"][0]["solver"]["operator_version"],
            "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        )
        self.assertEqual(
            ir["spin_transport_modules"][0]["solver"]["operator_version"],
            "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        )
        self.assertNotIn(
            "reciprocal_nonlinear",
            ir["spin_transport_modules"][0]["solver"],
        )

    def test_public_fem_m2_rejects_fdm_nonlinear_policy(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not accept reciprocal_nonlinear"):
            fm.Problem(
                name="invalid_fem_m2_authoring",
                magnets=self.fem_reciprocal_problem().magnets,
                energy=[fm.Exchange()],
                current_modules=[
                    fm.CurrentTransport(
                        name="charge",
                        model="ohmic_poisson",
                        coupling="bidirectional",
                        domain=[self.fm],
                        materials=[
                            fm.ChargeTransportMaterialAssignment(
                                self.fm,
                                fm.ChargeTransportMaterial(
                                    4.0e6,
                                    sigma_parallel_Spm=4.0e6,
                                    sigma_perpendicular_Spm=4.0e6,
                                    sigma_AHE_Spm=0.0,
                                ),
                            )
                        ],
                        boundaries=[
                            fm.VoltageElectrode(
                                "top", [self.top], potential_V=0.01
                            )
                        ],
                        gauge=fm.ChargePotentialGauge("dirichlet_reference"),
                        solver=fm.ChargeSolverPolicy(
                            engine="block_gmres",
                            operator_version=(
                                "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
                            ),
                        ),
                    )
                ],
                spin_transports=[
                    replace(
                        self.fem_reciprocal_problem().spin_transports[0],
                        solver=fm.SpinSolverPolicy(
                            engine="block_gmres",
                            operator_version=(
                                "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"
                            ),
                            reciprocal_nonlinear=fm.ReciprocalNonlinearSolverPolicy(),
                        ),
                    )
                ],
                study=fm.TimeEvolution(
                    dynamics=fm.LLG(),
                    outputs=[fm.SaveScalar("E_total", every=1.0e-12)],
                ),
            )

    def test_m1_module_serializes_canonical_typed_contract(self) -> None:
        solve = fm.SpinDriftDiffusion(
            id="spin_solve",
            current_source_id="charge",
            domain=[self.nm, self.fm],
            materials=[
                fm.SpinTransportMaterialAssignment(
                    self.nm,
                    fm.SpinTransportMaterial(
                        sigma_s_Spm=5.0e6,
                        polarization_p=0.0,
                        theta_sh=0.12,
                        lambda_sf_m=1.5e-9,
                    ),
                ),
                fm.SpinTransportMaterialAssignment(
                    self.fm,
                    fm.SpinTransportMaterial(
                        sigma_s_Spm=3.0e6,
                        polarization_p=0.45,
                        theta_sh=0.0,
                        lambda_sf_m=4.0e-9,
                        lambda_j_m=1.0e-9,
                        lambda_phi_m=0.8e-9,
                    ),
                ),
            ],
            interfaces=[fm.TransparentSpinInterface("nm_fm", self.nm, self.fm, (0, 0, 1))],
            boundaries=[fm.SpinSink("top_sink", [self.top])],
            solver=fm.SpinSolverPolicy(relative_tolerance=1.0e-9),
            requested_execution=fm.TransportExecution(),
        )

        ir = solve.to_ir()
        self.assertEqual(ir["schema_version"], "spin_transport.v1")
        self.assertEqual(ir["mode"], "steady")
        self.assertNotIn("coupling", ir)
        self.assertEqual(ir["materials"][0]["material"]["theta_sh"], 0.12)
        self.assertEqual(ir["interfaces"][0]["kind"], "transparent")
        self.assertEqual(ir["solver"]["operator_version"], "fv_spin_upwind_v1")
        self.assertEqual(ir["requested_execution"]["precision"], "double")

    def test_mixing_interface_preserves_orientation_and_conductance_units(self) -> None:
        reservoir = fm.SpinMemoryLossReservoir(
            g_n_Spm2=0.2e15,
            g_f_Spm2=0.3e15,
            g_lattice_Spm2=0.4e15,
        )
        interface = fm.MixingConductanceSpinInterface(
            id="mix",
            normal_to_ferromagnet=(0, 0, 1),
            normal_side=self.nm,
            ferromagnet_side=self.fm,
            g_up_Spm2=1.0e15,
            g_down_Spm2=0.5e15,
            g_r_Spm2=2.0e15,
            g_i_Spm2=-0.1e15,
            spin_memory_loss=reservoir,
        )
        ir = interface.to_ir()
        self.assertEqual(ir["formula_version"], "magnetoelectronic.fullmag.v2")
        self.assertEqual(ir["normal_to_ferromagnet"], [0.0, 0.0, 1.0])
        self.assertEqual(ir["absorption"], "full_absorption")
        self.assertEqual(
            ir["spin_memory_loss"]["formula_version"],
            "sml_reservoir.fullmag.v2",
        )
        self.assertEqual(ir["spin_memory_loss"]["g_lattice_Spm2"], 0.4e15)

    def test_sml_reservoir_requires_positive_lattice_conductance(self) -> None:
        with self.assertRaisesRegex(ValueError, "g_lattice_Spm2"):
            fm.SpinMemoryLossReservoir(
                g_n_Spm2=1.0,
                g_f_Spm2=1.0,
                g_lattice_Spm2=0.0,
            )

    def test_transport_torque_only_references_named_spin_solve(self) -> None:
        torque = fm.DriftDiffusionSpinTorque(
            id="transport_torque",
            solve_id="spin_solve",
            target=self.fm,
        )
        self.assertEqual(
            torque.to_ir_module(),
            {
                "kind": "drift_diffusion_spin_torque",
                "schema_version": "drift_diffusion_spin_torque.v1",
                "id": "transport_torque",
                "solve_id": "spin_solve",
                "target": {"object_id": "stack", "region_id": "ferromagnet"},
                "formula_version": "transport_torque_angular_momentum.fullmag.v1",
            },
        )

    def test_transient_requires_physical_capacitance_and_invalid_coefficients_fail(self) -> None:
        material = fm.SpinTransportMaterial(
            sigma_s_Spm=1.0,
            polarization_p=0.0,
            theta_sh=0.0,
            lambda_sf_m=1.0,
            spin_capacitance_As_per_V_m3=2.0,
            capacitance_formula_version="dos_isotropic_nonmagnetic.fullmag.v1",
        )
        transient = fm.SpinDriftDiffusion(
            id="transient",
            current_source_id="charge",
            domain=[self.nm],
            materials=[fm.SpinTransportMaterialAssignment(self.nm, material)],
            mode="transient",
        )
        self.assertEqual(transient.to_ir()["mode"], "transient")
        self.assertEqual(
            transient.to_ir()["materials"][0]["material"]["spin_capacitance_As_per_V_m3"],
            2.0,
        )
        with self.assertRaisesRegex(ValueError, "capacitance_formula_version"):
            fm.SpinTransportMaterial(
                sigma_s_Spm=5.0e6,
                polarization_p=0.0,
                theta_sh=0.0,
                lambda_sf_m=5.0e-9,
                spin_capacitance_As_per_V_m3=2.0,
                capacitance_formula_version="dos_constant.fullmag.v1",
            )
        with self.assertRaisesRegex(ValueError, "spin_capacitance"):
            fm.SpinDriftDiffusion(
                id="bad",
                current_source_id="charge",
                domain=[self.nm],
                materials=[fm.SpinTransportMaterialAssignment(
                    self.nm,
                    fm.SpinTransportMaterial(1.0, 0.0, 0.0, 1.0),
                )],
                mode="transient",
            )
        with self.assertRaisesRegex(ValueError, "polarization_p"):
            fm.SpinTransportMaterial(
                sigma_s_Spm=1.0,
                polarization_p=1.1,
                theta_sh=0.0,
                lambda_sf_m=1.0,
            )

    def test_transient_dos_adapter_derives_spin_capacitance(self) -> None:
        material = fm.SpinTransportMaterial(
            sigma_s_Spm=1.0,
            polarization_p=0.0,
            theta_sh=0.0,
            lambda_sf_m=1.0,
            density_of_states_per_spin_Jinv_m3=2.0,
            capacitance_formula_version="dos_isotropic_nonmagnetic.fullmag.v1",
        )
        ir = material.to_ir()
        self.assertEqual(ir["density_of_states_per_spin_Jinv_m3"], 2.0)
        self.assertNotIn("spin_capacitance_As_per_V_m3", ir)
        transient = fm.SpinDriftDiffusion(
            id="transient-dos",
            current_source_id="charge",
            domain=[self.nm],
            materials=[fm.SpinTransportMaterialAssignment(self.nm, material)],
            mode="transient",
        )
        self.assertEqual(
            transient.to_ir()["materials"][0]["material"]["density_of_states_per_spin_Jinv_m3"],
            2.0,
        )
        with self.assertRaisesRegex(ValueError, "must equal e\\^2"):
            fm.SpinTransportMaterial(
                sigma_s_Spm=1.0,
                polarization_p=0.0,
                theta_sh=0.0,
                lambda_sf_m=1.0,
                spin_capacitance_As_per_V_m3=1.0,
                density_of_states_per_spin_Jinv_m3=2.0,
                capacitance_formula_version="dos_isotropic_nonmagnetic.fullmag.v1",
            )

    def test_coupled_imex_ark2_is_owned_by_llg_and_round_trips_exactly(self) -> None:
        dynamics = fm.LLG(
            integrator="coupled_imex_ark2",
            adaptive_timestep=fm.AdaptiveTimestep(atol=1.0e-12, rtol=1.0e-6),
        )

        self.assertEqual(dynamics.integrator, "coupled_imex_ark2")
        self.assertEqual(dynamics.to_ir()["integrator"], "coupled_imex_ark2")
        self.assertEqual(fm.LLG().integrator, "auto")

    def test_current_transport_is_single_coupling_owner(self) -> None:
        source = self.complete_charge_transport()
        self.assertEqual(source.to_ir()["coupling"], "one_way")
        with self.assertRaisesRegex(ValueError, "complete charge contract"):
            fm.CurrentTransport(
                name="charge",
                model="ohmic_poisson",
                coupling="bidirectional",
            )

    def test_bidirectional_m2_charge_and_spin_solver_parameters_round_trip(self) -> None:
        charge = fm.CurrentTransport(
            name="m2-charge",
            model="ohmic_poisson",
            coupling="bidirectional",
            domain=[self.nm, self.fm],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    self.nm,
                    fm.ChargeTransportMaterial(
                        5.0e6,
                        sigma_parallel_Spm=5.2e6,
                        sigma_perpendicular_Spm=4.8e6,
                        sigma_AHE_Spm=0.1e6,
                    ),
                ),
                fm.ChargeTransportMaterialAssignment(
                    self.fm,
                    fm.ChargeTransportMaterial(
                        3.0e6,
                        sigma_parallel_Spm=3.1e6,
                        sigma_perpendicular_Spm=2.9e6,
                        sigma_AHE_Spm=0.05e6,
                    ),
                ),
            ],
            boundaries=[fm.VoltageElectrode("ground", [self.top], potential_V=0.0)],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(
                engine="block_gmres",
                operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
            ),
        )
        nonlinear = fm.ReciprocalNonlinearSolverPolicy(
            gmres_restart=40,
            max_picard_iterations=4,
            relative_update_tolerance=1.0e-9,
            eta_transport=0.25,
        )
        spin = fm.SpinDriftDiffusion(
            id="m2-spin",
            current_source_id="m2-charge",
            domain=[self.nm, self.fm],
            materials=[
                fm.SpinTransportMaterialAssignment(
                    self.nm,
                    fm.SpinTransportMaterial(5.0e6, 0.0, 0.12, 1.5e-9),
                ),
                fm.SpinTransportMaterialAssignment(
                    self.fm,
                    fm.SpinTransportMaterial(
                        3.0e6,
                        0.45,
                        0.0,
                        4.0e-9,
                        lambda_j_m=1.0e-9,
                        lambda_phi_m=0.8e-9,
                    ),
                ),
            ],
            solver=fm.SpinSolverPolicy(
                operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
                reciprocal_nonlinear=nonlinear,
            ),
        )
        self.assertEqual(charge.to_ir()["coupling"], "bidirectional")
        self.assertEqual(
            charge.to_ir()["materials"][0]["material"]["sigma_parallel_Spm"],
            5.2e6,
        )
        self.assertEqual(
            spin.to_ir()["solver"]["reciprocal_nonlinear"]["eta_transport"],
            0.25,
        )

        geometry = fm.Box(size=(10e-9, 10e-9, 2e-9), name="stack")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="stack", geometry=geometry, material=material)
        problem = fm.Problem(
            name="m2-python",
            magnets=[magnet],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
            current_modules=[charge],
            spin_transports=[spin],
        )
        problem_ir = problem.to_ir(include_geometry_assets=False)
        self.assertEqual(
            problem_ir["spin_transport_modules"][0]["constitutive_version"],
            "transport_constitutive.reciprocal.fullmag.v1",
        )

    def test_reciprocal_nonlinear_policy_rejects_invalid_eta(self) -> None:
        with self.assertRaisesRegex(ValueError, "eta_transport"):
            fm.ReciprocalNonlinearSolverPolicy(
                gmres_restart=40,
                max_picard_iterations=4,
                relative_update_tolerance=1.0e-9,
                eta_transport=1.5,
            )

    def test_python_and_ir_preserve_separate_transport_and_magnetic_domains(self) -> None:
        geometry = fm.Box(size=(10e-9, 10e-9, 2e-9), name="fm_geometry")
        hm_geometry = fm.Box(size=(10e-9, 10e-9, 2e-9), name="hm")
        hm_transport_region = fm.ObjectRegion(
            owner_object="hm",
            name="transport",
            region_id="hm:transport",
            shape=fm.Box(size=(10e-9, 10e-9, 2e-9), name="hm_transport_shape"),
        )
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(
            name="fm",
            geometry=geometry,
            region=fm.Region(name="fm_magnetic", geometry=geometry),
            material=material,
            object_regions=(
                hm_transport_region,
                fm.ObjectRegion(
                    owner_object="fm",
                    name="transport",
                    region_id="fm:transport",
                    shape=fm.Box(size=(10e-9, 10e-9, 2e-9), name="fm_transport_shape"),
                ),
                fm.ObjectRegion(
                    owner_object="fm",
                    name="torque",
                    region_id="fm:torque",
                    shape=fm.Box(size=(5e-9, 5e-9, 2e-9), name="fm_torque_shape"),
                ),
            ),
        )
        hm_transport = fm.RegionRef("hm", "hm:transport")
        fm_transport = fm.RegionRef("fm", "fm:transport")
        fm_torque = fm.RegionRef("fm", "fm:torque")
        hm_left = fm.SurfaceRef("hm", "x-", (-1.0, 0.0, 0.0))
        charge = fm.CurrentTransport(
            name="charge",
            model="ohmic_poisson",
            coupling="one_way",
            domain=[hm_transport, fm_transport],
            materials=[
                fm.ChargeTransportMaterialAssignment(
                    hm_transport, fm.ChargeTransportMaterial(5.0e6)
                ),
                fm.ChargeTransportMaterialAssignment(
                    fm_transport, fm.ChargeTransportMaterial(4.0e6)
                ),
            ],
            boundaries=[fm.VoltageElectrode("ground", [hm_left], potential_V=0.0)],
            gauge=fm.ChargePotentialGauge("dirichlet_reference"),
            solver=fm.ChargeSolverPolicy(),
        )
        solve = fm.SpinDriftDiffusion(
            id="spin_solve",
            current_source_id="charge",
            domain=[hm_transport, fm_transport],
            materials=[
                fm.SpinTransportMaterialAssignment(
                    hm_transport, fm.SpinTransportMaterial(5e6, 0.0, 0.1, 5e-9)
                ),
                fm.SpinTransportMaterialAssignment(
                    fm_transport, fm.SpinTransportMaterial(4e6, 0.4, 0.0, 5e-9)
                ),
            ],
        )
        problem = fm.Problem(
            name="m1",
            magnets=[magnet],
            auxiliary_geometries=[hm_geometry],
            energy=[fm.Exchange()],
            study=fm.TimeEvolution(
                dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]
            ),
            current_modules=[charge],
            spin_transports=[solve],
            spin_torques=[fm.DriftDiffusionSpinTorque("tr", "spin_solve", fm_torque)],
        )
        ir = problem.to_ir(include_geometry_assets=False)
        canonical_ir = json.loads(json.dumps(ir, sort_keys=True, allow_nan=False))
        self.assertEqual(
            next(
                edge
                for edge in canonical_ir["physics_graph"]["edges"]
                if edge["target_id"] == "tr"
            )["kind"],
            "spin_transport_to_torque",
        )
        golden_path = (
            Path(__file__).resolve().parents[3]
            / "tests/standard_problems/transport/racetrack_m1_v1/python_problem_ir.v1.json"
        )
        with golden_path.open(encoding="utf-8") as golden_file:
            golden_ir = json.load(golden_file)
        self.assertEqual(canonical_ir, golden_ir)
        ir = canonical_ir
        self.assertEqual(ir["spin_transport_modules"], [solve.to_ir()])
        self.assertEqual(ir["spin_torque_modules"][0]["solve_id"], "spin_solve")
        self.assertEqual(ir["magnets"][0]["region"], "fm_magnetic")
        self.assertEqual(
            ir["regions"], [{"name": "fm_magnetic", "geometry": "fm_geometry"}]
        )
        self.assertEqual(
            [(region["owner_object"], region["region_id"]) for region in ir["object_regions"]],
            [("hm", "hm:transport"), ("fm", "fm:transport"), ("fm", "fm:torque")],
        )
        self.assertIn("hm", [geometry["name"] for geometry in ir["geometry"]["entries"]])
        self.assertEqual(
            ir["current_modules"][0]["domain"],
            [
                {"object_id": "hm", "region_id": "hm:transport"},
                {"object_id": "fm", "region_id": "fm:transport"},
            ],
        )
        self.assertEqual(
            ir["spin_transport_modules"][0]["domain"],
            [
                {"object_id": "hm", "region_id": "hm:transport"},
                {"object_id": "fm", "region_id": "fm:transport"},
            ],
        )
        self.assertEqual(
            ir["spin_torque_modules"][0]["target"],
            {"object_id": "fm", "region_id": "fm:torque"},
        )
        self.assertEqual(
            ir["current_modules"][0]["boundaries"][0]["surfaces"],
            [
                {
                    "object_id": "hm",
                    "surface_id": "x-",
                    "orientation": [-1.0, 0.0, 0.0],
                }
            ],
        )
        self.assertNotEqual(
            ir["current_modules"][0]["domain"][1],
            ir["spin_torque_modules"][0]["target"],
        )
        self.assertNotIn("transport_active_mask", ir["spin_transport_modules"][0])
        self.assertNotIn("magnetic_active_mask", ir["spin_transport_modules"][0])
        self.assertNotIn("torque_target_masks", ir["spin_torque_modules"][0])


if __name__ == "__main__":
    unittest.main()
