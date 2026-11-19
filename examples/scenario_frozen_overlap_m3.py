# %% Explicit CPU double authoring; runtime evidence is still required.
import fullmag as fm

study = fm.study("e11_cd_frozen_overlap_lifecycle")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.cell(2e-9, 2e-9, 2e-9)
study.disable_demag()
study.exchange()
film = study.geometry(fm.Box(size=(16e-9, 8e-9, 2e-9)), name="Diagnostic film", object_id="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.1
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.b_ext(0.02, 0.0, 0.0)
study.solver(fix_dt=2e-14, integrator="heun")
study.save("m", every=2e-13)
study.save("E_total", every=2e-13)

# %% Overlapping actual spatial selectors; neither union nor complement is empty.
left = fm.FrozenSpins(
    id="pin_a", selector=fm.select.inside(fm.shapes.box(size=(6e-9, 8e-9, 2e-9), center=(-3e-9, 0.0, 0.0))),
    reference="capture_current_at_activation", membership="static",
)
right = fm.FrozenSpins(
    id="pin_b", selector=fm.select.inside(fm.shapes.box(size=(6e-9, 8e-9, 2e-9), center=(1e-9, 0.0, 0.0))),
    reference="capture_current_at_activation", membership="static",
)
study.stages.add_relax(stage_id="relax_a", max_steps=8, tolT=1e-6, dt=2e-14, constraints=[left])

# %% Register M3 only after the pure-frozen Relax snapshot was captured.
# Synthetic positive transport coefficients are diagnostic inputs, not a fitted material.
study.b_ext(0.0, 0.0, 0.05)
study.solver(fix_dt=2e-14, integrator="coupled_imex_ark2")
study.current_transport(name="charge", current_density=(1e9, 0.0, 0.0), solve_region="film", coupling="one_way")
region = fm.RegionRef("film")
study.spin_transport(fm.SpinDriftDiffusion(
    id="spin", current_source_id="charge", domain=[region],
    materials=[fm.SpinTransportMaterialAssignment(region, fm.SpinTransportMaterial(
        sigma_s_Spm=1e6, polarization_p=0.2, theta_sh=0.05,
        lambda_sf_m=5e-9, lambda_j_m=2e-9, lambda_phi_m=2e-9,
        spin_capacitance_As_per_V_m3=1e10,
        capacitance_formula_version="dos_isotropic_nonmagnetic.fullmag.v1",
    ))],
    requested_execution=fm.TransportExecution(discretization="fdm", device="cpu", precision="double", execution_mode="strict"),
    solver=fm.SpinSolverPolicy(relative_tolerance=1e-9, absolute_tolerance=1e-14, max_iterations=500),
    mode="transient",
))
study.spin_torque(fm.DriftDiffusionSpinTorque(id="spin-torque", solve_id="spin", target=region))

# %% Actual predecessor M must carry forward; no LoadState or authored reset.
study.stages.add_run(stage_id="active_a", until=1e-12, constraints=[left])
study.stages.add_run(stage_id="overlap_ab", until=1e-12, constraints=[left, right])
study.stages.add_run(stage_id="inactive", until=1e-12, constraints=[])
study.stages.add_run(stage_id="reactivate_ab", until=1e-12, constraints=[left, right])