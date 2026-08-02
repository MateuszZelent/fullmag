from __future__ import annotations

import unittest

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
        with self.assertRaisesRegex(ValueError, "M1"):
            fm.CurrentTransport(
                name="charge",
                model="ohmic_poisson",
                coupling="bidirectional",
            )

    def test_problem_lowers_spin_solve_and_torque_as_separate_top_level_records(self) -> None:
        geometry = fm.Box(size=(10e-9, 10e-9, 2e-9), name="stack")
        material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
        magnet = fm.Ferromagnet(name="stack", geometry=geometry, material=material)
        solve = fm.SpinDriftDiffusion(
            id="spin_solve", current_source_id="charge", domain=[self.fm],
            materials=[fm.SpinTransportMaterialAssignment(self.fm,
                fm.SpinTransportMaterial(5e6, 0.4, 0.1, 5e-9))],
        )
        problem = fm.Problem(
            name="m1", magnets=[magnet], energy=[fm.Exchange()],
            study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[fm.SaveScalar("E_total", every=1e-12)]),
            current_modules=[self.complete_charge_transport()],
            spin_transports=[solve],
            spin_torques=[fm.DriftDiffusionSpinTorque("tr", "spin_solve", self.fm)],
        )
        ir = problem.to_ir(include_geometry_assets=False)
        self.assertEqual(ir["spin_transport_modules"], [solve.to_ir()])
        self.assertEqual(ir["spin_torque_modules"][0]["solve_id"], "spin_solve")


if __name__ == "__main__":
    unittest.main()
