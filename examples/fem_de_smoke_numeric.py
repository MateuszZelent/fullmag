"""DE-SMOKE numerical FEM fixture from the 2026-09-16 validation plan.

Default: Gamma and ky=2e6 rad/m. FULLMAG_DE_SMOKE_SAMPLING=k0 or k2 requests
only the lowest target mode at the selected wavevector so a single-point solve does not ask
each shift for a full four-mode bundle. FULLMAG_DE_SMOKE_MODAL_TARGET=nearest
selects the mode nearest the finite positive
FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ at one single-k point; this is a
selected-only diagnostic and cannot certify a complete frequency window or a
dispersion curve. The separately named ui-seven pilot applies one nearest-frequency
target to seven signed DE path samples and remains selected-only, without spectrum
completeness or branch-continuity claims. FULLMAG_DE_SMOKE_SAMPLING=five selects
all five prescribed points; signed-eleven selects Gamma and five pairs of
positive/negative ky, one mode per point. signed-fifteen selects the prescribed
signed DE path from -25 to +25 rad/um, one mode per point. References are evaluated after the native solve;
this fixture does not select an analytic solver or claim qualification.
"""
from __future__ import annotations

import math
import os
import fullmag as fm

SAMPLING = os.environ.get("FULLMAG_DE_SMOKE_SAMPLING", "two")
_AIR_GROWTH_RATE_VALUES = {
    "1.3": 1.3,
    "1.15": 1.15,
    "1.075": 1.075,
    "1.0375": 1.0375,
}
_AIR_GROWTH_RATE_TEXT = os.environ.get("FULLMAG_DE_SMOKE_AIR_GROWTH_RATE", "1.3")
if _AIR_GROWTH_RATE_TEXT not in _AIR_GROWTH_RATE_VALUES:
    raise ValueError(
        "FULLMAG_DE_SMOKE_AIR_GROWTH_RATE must be one of "
        + ", ".join(repr(value) for value in _AIR_GROWTH_RATE_VALUES)
        + ", "
        f"got {_AIR_GROWTH_RATE_TEXT!r}"
    )
AIR_GROWTH_RATE = _AIR_GROWTH_RATE_VALUES[_AIR_GROWTH_RATE_TEXT]
_SINGLE_K_NAMES = {f"{prefix}k{k}" for prefix in ("", "bv-") for k in range(-25, 26)}
_PATH_NAMES = {
    "two", "five", "positive-six", "bv-positive-six", "positive-26",
    "bv-positive-26", "signed-eleven", "signed-fifteen", "ui-seven",
}
if SAMPLING not in _SINGLE_K_NAMES | _PATH_NAMES:
    raise ValueError(f"Unsupported FULLMAG_DE_SMOKE_SAMPLING: {SAMPLING}")
_single_k_name = SAMPLING.removeprefix("bv-")
IS_SINGLE = SAMPLING in _SINGLE_K_NAMES
KY = ((float(_single_k_name[1:]) * 1e6,) if IS_SINGLE else
      tuple(k * 1e6 for k in range(26)) if SAMPLING in ("positive-26", "bv-positive-26") else
      (2e6, 5e6, 10e6, 15e6, 20e6, 25e6) if SAMPLING in ("positive-six", "bv-positive-six") else
      (0.0, 2e6) if SAMPLING == "two" else
      (0.0, 1e6, 2e6, 3e6, 5e6) if SAMPLING == "five" else
      (-25e6, -20e6, -15e6, -10e6, -7e6, -5e6, -2e6, 0.0,
       2e6, 5e6, 7e6, 10e6, 15e6, 20e6, 25e6) if SAMPLING == "signed-fifteen" else
      (-25e6, -15e6, -5e6, 0.0, 5e6, 15e6, 25e6) if SAMPLING == "ui-seven" else
      (-3e6, -2e6, -1.5e6, -1e6, -0.5e6, 0.0,
       0.5e6, 1e6, 1.5e6, 2e6, 3e6))
REQUESTED_MODE_COUNT = 4 if SAMPLING in ("two", "five") else 1
IS_BV = SAMPLING.startswith("bv-")
IS_GAMMA_SINGLE = IS_SINGLE and KY[0] == 0.0
K_VECTORS = [(k, 0.0, 0.0) if IS_BV else (0.0, k, 0.0) for k in KY]
FREQUENCY_MIN_HZ = 12e9 if SAMPLING in ("k25", "k-25") else 8.5e9
FREQUENCY_MAX_HZ = 16e9 if (SAMPLING in (
    "k25", "k-25", "positive-six", "positive-26", "signed-fifteen"
) or (IS_SINGLE and not IS_BV and abs(KY[0]) >= 15e6)) else 12e9
_DEFAULT_MODAL_TARGET = "nearest" if SAMPLING == "ui-seven" else "frequency_window"
MODAL_TARGET = os.environ.get("FULLMAG_DE_SMOKE_MODAL_TARGET", _DEFAULT_MODAL_TARGET)
if SAMPLING == "ui-seven" and MODAL_TARGET != "nearest":
    raise ValueError("ui-seven requires a nearest selected-only modal target")
if MODAL_TARGET not in {"frequency_window", "nearest"}:
    raise ValueError(
        "FULLMAG_DE_SMOKE_MODAL_TARGET must be 'frequency_window' or 'nearest', "
        f"got {MODAL_TARGET!r}"
    )
def _configured_frequency_window_hz(default_min, default_max, modal_target):
    names = ("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ", "FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ")
    values = [os.environ.get(name) for name in names]
    if values == [None, None]:
        return default_min, default_max
    if any(value is None for value in values):
        raise ValueError("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ and FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ must be provided together")
    if modal_target != "frequency_window":
        raise ValueError("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ/MAX_GHZ require frequency_window")
    try:
        bounds = [float(value) * 1e9 for value in values]
    except ValueError as exc:
        raise ValueError("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ/MAX_GHZ must be numbers") from exc
    if not all(math.isfinite(value) and value > 0 for value in bounds) or bounds[0] >= bounds[1]:
        raise ValueError("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ/MAX_GHZ must be finite, positive and strictly ordered")
    return tuple(bounds)


FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ = _configured_frequency_window_hz(
    FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ, MODAL_TARGET)

if MODAL_TARGET == "nearest" and not IS_SINGLE and SAMPLING != "ui-seven":
    raise ValueError(
        "FULLMAG_DE_SMOKE_MODAL_TARGET=nearest requires one single-k point or the ui-seven pilot"
    )
if MODAL_TARGET == "nearest" and REQUESTED_MODE_COUNT != 1:
    raise ValueError("nearest DE-SMOKE selection requires one requested mode")
TARGET_FREQUENCY_HZ = None
if MODAL_TARGET == "nearest":
    _target_frequency_ghz_text = os.environ.get(
        "FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", "10.0"
    )
    try:
        _target_frequency_ghz = float(_target_frequency_ghz_text)
    except ValueError as exc:
        raise ValueError(
            "FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ must be a number, "
            f"got {_target_frequency_ghz_text!r}"
        ) from exc
    if not math.isfinite(_target_frequency_ghz) or _target_frequency_ghz <= 0.0:
        raise ValueError(
            "FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ must be finite and positive"
        )
    TARGET_FREQUENCY_HZ = _target_frequency_ghz * 1.0e9
    if not math.isfinite(TARGET_FREQUENCY_HZ):
        raise ValueError(
            "FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ overflows finite Hz range"
        )
RELAX_DT_S = 5e-15
RELAX_MAX_STEPS = 50000
RELAX_MAX_TIME_S = RELAX_DT_S * RELAX_MAX_STEPS
# The 500-iteration k2 trial produced frequency candidates but failed the
# independent magnetic residual gate (2.17e-7 > 1e-8). Use a bounded 2000
# iterations to test iterative convergence. The physical acceptance threshold
# remains 1e-8; the native EPS absolute prefilter is set more strictly because
# its globally normalized residual is not the per-mode original-block metric.
_RTOL_VALUES = {"1e-8": 1e-8, "1e-7": 1e-7, "1e-6": 1e-6}
_requested_rtol = os.environ.get("FULLMAG_DE_SMOKE_SOLVER_RTOL", "1e-8")
if _requested_rtol not in _RTOL_VALUES:
    raise ValueError("FULLMAG_DE_SMOKE_SOLVER_RTOL must be 1e-8, 1e-7 or 1e-6")
if SAMPLING == "ui-seven" and _requested_rtol != "1e-8":
    raise ValueError("ui-seven requires FULLMAG_DE_SMOKE_SOLVER_RTOL exactly 1e-8")
EIGEN_SOLVER_RTOL = _RTOL_VALUES[_requested_rtol]
EIGEN_SOLVER_MAX_OUTER_ITERATIONS = 2000
MS_A_PER_M = 800000.0
A_J_PER_M = 13e-12
GAMMA0_M_PER_A_S = 2.211e5
MU0_T_M_A = 4.0 * math.pi * 1e-7
B_EXT_T = 0.1
FILM_THICKNESS_M = 10e-9
CELL_PERIOD_M = 40e-9
AIR_PADDING_EACH_SIDE_M = 2e-6
DOMAIN_HEIGHT_M = FILM_THICKNESS_M + 2.0 * AIR_PADDING_EACH_SIDE_M
MESH_LEVEL = os.environ.get("FULLMAG_DE_SMOKE_MESH_LEVEL", "L0")
_MESH_SIZES_M = {"L0": 10e-9, "L1": 7.5e-9, "L2": 5e-9, "L3": 3.75e-9}
if MESH_LEVEL not in _MESH_SIZES_M:
    raise ValueError(f"Unsupported FULLMAG_DE_SMOKE_MESH_LEVEL: {MESH_LEVEL}")
MAGNETIC_ELEMENT_SIZE_M = _MESH_SIZES_M[MESH_LEVEL]
_THICKNESS_LAYERS_TEXT = os.environ.get("FULLMAG_DE_SMOKE_THICKNESS_LAYERS", "3")
if _THICKNESS_LAYERS_TEXT not in ("3", "6", "9"):
    raise ValueError("Unsupported FULLMAG_DE_SMOKE_THICKNESS_LAYERS")
THICKNESS_LAYERS = int(_THICKNESS_LAYERS_TEXT)

_PARALLEL_MODE = os.environ.get("FULLMAG_DE_SMOKE_PARALLEL_MODE", "serial")
try:
    PARALLEL_EXECUTION = fm.ParallelExecutionPolicy(
        mode=_PARALLEL_MODE,
        max_cpu_percent=90.0,
        max_memory_percent=80.0,
        memory_reserve_bytes=1_073_741_824,
        max_workers=None,
        threads_per_worker=1,
    )
except (TypeError, ValueError) as exc:
    raise ValueError(
        "FULLMAG_DE_SMOKE_PARALLEL_MODE must be 'serial' or 'adaptive'"
    ) from exc


study = fm.study("de-smoke-10nm-numeric")
study.engine("fem")
study.device("cpu", precision="double")
study.parallel_execution(PARALLEL_EXECUTION)
study.mode("strict")
study.interactive(False)
study.wait_for_solve(True)
study.universe(mode="manual", size=(CELL_PERIOD_M, CELL_PERIOD_M, DOMAIN_HEIGHT_M),
               center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=100e-9,
                    maximum_element_growth_rate=AIR_GROWTH_RATE, grading="geometric")
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.objects.mesh.defaults(periodic_pair_ids=["x_faces", "y_faces"])
body = study.geometry(fm.Box(size=(CELL_PERIOD_M, CELL_PERIOD_M, FILM_THICKNESS_M), name="film"), name="film")
body.Ms = MS_A_PER_M
body.Aex = A_J_PER_M
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=MAGNETIC_ELEMENT_SIZE_M, maximum_element_size=MAGNETIC_ELEMENT_SIZE_M,
    interface_maximum_element_size=MAGNETIC_ELEMENT_SIZE_M, interface_thickness=20e-9,
    transition_distance=20e-9, edge_thickness=10e-9, corner_extent=10e-9,
    layers=THICKNESS_LAYERS, topology="tetrahedral", order=1,
)
study.b_ext(B_EXT_T, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="dirichlet")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-7,
                       max_iterations=1000)
study.solver(gamma=GAMMA0_M_PER_A_S, fix_dt=RELAX_DT_S)
study.build_domain_mesh()
study.save("spectrum")
study.save("dispersion", include_branch_table=True)
study.save("diagnostics")
# Capture demag seam inputs at the terminal relaxed state without writing a
# dense transient field history. The runner publishes these requested fields
# at finalization even when relaxation converges before this limit.
study.save("H_demag", every=RELAX_MAX_TIME_S)
study.save("demag_phi", every=RELAX_MAX_TIME_S)
study.save("mode", field="mode", indices=tuple(range(REQUESTED_MODE_COUNT)),
           sample_indices=tuple(range(len(KY))))
study.runtime_metadata("de_smoke", {
    "schema": "fullmag.de-smoke.v1",
    "sampling": SAMPLING,
    "film_thickness_m": FILM_THICKNESS_M,
    "mesh_level": MESH_LEVEL,
    "magnetic_element_size_m": MAGNETIC_ELEMENT_SIZE_M,
    "air_growth_rate": AIR_GROWTH_RATE,
    "through_thickness_elements": THICKNESS_LAYERS,
    "cell_period_m": CELL_PERIOD_M,
    "air_padding_each_side_m": AIR_PADDING_EACH_SIDE_M,
    "saturation_magnetization_a_per_m": MS_A_PER_M,
    # Keep the published model convention bitwise aligned with fullmag-engine::MU0.
    "mu0_t_m_a": MU0_T_M_A,
    "exchange_stiffness_j_per_m": A_J_PER_M,
    "gamma0_m_per_a_s": GAMMA0_M_PER_A_S,
    "external_induction_t": B_EXT_T,
    "outer_boundary_kind": "poisson_dirichlet",
    "outer_boundary_potential_a": 0.0,
    "ky_rad_per_m": [k[1] for k in K_VECTORS],
    "kx_rad_per_m": [k[0] for k in K_VECTORS],
    "k_vectors_rad_per_m": [list(k) for k in K_VECTORS],
    "dispersion_geometry": "backward_volume" if IS_BV else "damon_eshbach",
    "requested_mode_count": REQUESTED_MODE_COUNT,
    "orientation": "M0=x,k=x,normal=z" if IS_BV else "M0=x,k=y,normal=z",
    "modal_target": MODAL_TARGET,
    "target_frequency_hz": TARGET_FREQUENCY_HZ,
    "frequency_window_hz": [FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ]
    if MODAL_TARGET == "frequency_window" else None,
    "selection_scope": "selected_only" if MODAL_TARGET == "nearest" else "frequency_window",
    "window_complete": False if MODAL_TARGET == "nearest" else None,
    "eigen_solver_rtol": EIGEN_SOLVER_RTOL,
    "eigen_solver_max_outer_iterations": EIGEN_SOLVER_MAX_OUTER_ITERATIONS,
    "analytic_comparison": "postsolve_only",
    "qualification": "NOT VERIFIED",
    **({"purpose": "ui_diagnostic", "branch_continuity": "NOT VERIFIED"}
       if SAMPLING == "ui-seven" else {}),
})
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped",
                       dt=RELAX_DT_S, relax_alpha=0.5,
                       max_steps=RELAX_MAX_STEPS, tolA=1.0).autosave(
    fm.StageAutosave(
        target="results", layout="separate", format="zarr",
        fields=(fm.FieldAutosave("m", every_steps=100),),
    )
)
study.stages.add_eigenmodes(
    count=REQUESTED_MODE_COUNT, target=MODAL_TARGET,
    target_frequency=TARGET_FREQUENCY_HZ if MODAL_TARGET == "nearest" else None,
    frequency_min=FREQUENCY_MIN_HZ if MODAL_TARGET == "frequency_window" else None,
    frequency_max=FREQUENCY_MAX_HZ if MODAL_TARGET == "frequency_window" else None,
    operator="full_2x2", include_demag=True,
    solver_rtol=EIGEN_SOLVER_RTOL,
    solver_max_outer_iterations=EIGEN_SOLVER_MAX_OUTER_ITERATIONS,
    equilibrium_source="relax", normalization="unit_l2", damping_policy="ignore",
    **({"k_vector": K_VECTORS[0]} if IS_SINGLE else
       {"k_sampling": fm.KPath(
           points=[fm.KPoint("Gamma" if k == 0 else f"{'BV' if IS_BV else 'DE'}-{k:g}", vector)
                   for k, vector in zip(KY, K_VECTORS)],
           samples_per_segment=[1] * (len(KY) - 1),
       )}),
    bc=(fm.PeriodicBC(["x_faces", "y_faces"]) if IS_GAMMA_SINGLE else
        fm.FloquetBC(["x_faces", "y_faces"],
                     phase_convention="exp_minus_i_k_dot_delta_r")),
    magnetostatic_bc="periodic_airbox_k0" if IS_GAMMA_SINGLE else "floquet_airbox",
)
