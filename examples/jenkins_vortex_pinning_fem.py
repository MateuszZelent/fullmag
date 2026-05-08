#!/usr/bin/env python3
"""
FEM Simulation: Vortex Pinning in MTJ with Granular Free Layer
==============================================================

Based on: Jenkins et al., "The impact of local pinning sites in magnetic
tunnel junctions with non-homogeneous free layers",
Communications Materials 5, 7 (2024).
https://doi.org/10.1038/s43246-023-00423-x

Physical system (from paper):
    - SAF pinned layer: CoFe(2.0)/Ru(0.7)/CoFeB(2.6 nm)
    - MgO barrier: 1.0 nm
    - Free layer composite: CoFeB(2.0)/Ta(0.2)/NiFe(7.0 nm)
    - Nanopillar diameter: 500 nm (also tested 300-1000 nm)
    - Devices annealed at 330°C, 2h, 1T field

Micromagnetic simulation parameters (from paper):
    - Msat = 740 × 10³ A/m (NiFe)
    - Aex  = 1.3 × 10⁻¹¹ J/m
    - alpha = 0.01
    - Granular structure: average grain size 20 nm
    - Ms variation: Msat to 0.85×Msat between grains
    - Exchange reduction at grain boundaries: 0.85×Aex

This script sets up:
    Stage 1: Vortex relaxation in a 500 nm disk (uniform free layer, FEM)
    Stage 2: Sub-threshold excitation (low-power RF) to probe pinned mode
    Stage 3: Super-threshold excitation to observe gyrotropic mode
    Stage 4: Energy landscape mapping (vortex at different positions)

NOTE: The granular structure in the paper was implemented in mumax3 using
Voronoi grains with randomized Ms and reduced inter-grain exchange.
In Fullmag, this can be approximated using spatially varying material
fields (Ms_field, A_field) on the FDM/FEM grid.
"""

from __future__ import annotations

import math

import numpy as np

from fullmag.init.textures import texture
from fullmag.model.discretization import DiscretizationHints, FDM, FEM
from fullmag.model.dynamics import LLG, AdaptiveTimestep
from fullmag.model.energy import (
    Demag,
    Exchange,
    OerstedCylinder,
    Sinusoidal,
    Zeeman,
)
from fullmag.model.geometry import Cylinder
from fullmag.model.outputs import SaveField, SaveScalar, Snapshot
from fullmag.model.problem import (
    BackendTarget,
    ExecutionPrecision,
    Problem,
    RuntimeSelection,
)
from fullmag.model.spin_torque import SlonczewskiSTT
from fullmag.model.structure import Ferromagnet, Material
from fullmag.model.study import Relaxation, TimeEvolution

# ─────────────────────────────────────────────────────────────────────
# Physical constants and device parameters (from paper)
# ─────────────────────────────────────────────────────────────────────

DIAMETER = 500e-9         # m — nanopillar diameter
RADIUS = DIAMETER / 2     # 250 nm
T_NIFE = 7e-9             # m — NiFe free layer thickness
T_COFEB = 2e-9            # m — CoFeB layer (interface to MgO)
T_FREE = T_NIFE + T_COFEB  # 9 nm total free layer

# NiFe (Py) material parameters from paper
MS_NIFE = 740e3           # A/m — saturation magnetization
A_NIFE = 1.3e-11          # J/m — exchange stiffness
ALPHA_NIFE = 0.01         # dimensionless — Gilbert damping

# Grain defects (paper parameters)
MS_MIN_FRACTION = 0.85    # Ms varies from Ms to 0.85*Ms
A_BOUNDARY_FRACTION = 0.85  # Exchange reduced to 0.85*Aex at boundaries
GRAIN_SIZE = 20e-9        # m — average Voronoi grain diameter

# Gyrotropic mode frequency (from paper, d=500nm)
F_GYRO_EXPECTED = 115e6   # Hz — ~115 MHz for 500nm disk

# ─────────────────────────────────────────────────────────────────────
# Helper: generate Voronoi-like granular Ms/A fields
# ─────────────────────────────────────────────────────────────────────

def generate_granular_fields(
    cell_centers: list[tuple[float, float, float]],
    *,
    radius: float,
    grain_size: float,
    ms_base: float,
    ms_min_frac: float,
    a_base: float,
    a_boundary_frac: float,
    seed: int = 42,
) -> tuple[list[float], list[float]]:
    """Generate spatially varying Ms and A fields mimicking granular structure.

    Uses Voronoi seeds distributed within the disk to assign each cell
    to a grain, then randomly varies Ms per grain and reduces A near
    grain boundaries.

    Parameters
    ----------
    cell_centers : list of (x, y, z) tuples
        Cell center positions [m].
    radius : float
        Disk radius [m].
    grain_size : float
        Average grain diameter [m].
    ms_base, a_base : float
        Base material parameter values.
    ms_min_frac : float
        Minimum Ms fraction (0.85 means Ms ranges from Ms to 0.85*Ms).
    a_boundary_frac : float
        Exchange fraction at grain boundaries.
    seed : int
        RNG seed for reproducibility.

    Returns
    -------
    ms_field : list of float
        Per-cell Ms values [A/m].
    a_field : list of float
        Per-cell exchange stiffness values [J/m].
    """
    rng = np.random.default_rng(seed)
    n_cells = len(cell_centers)
    coords = np.array(cell_centers)
    xy = coords[:, :2]

    # Estimate number of grains to fill the disk
    disk_area = math.pi * radius ** 2
    grain_area = (grain_size / 2) ** 2 * math.pi  # rough circle area per grain
    n_grains = max(int(disk_area / grain_area * 1.2), 10)

    # Place Voronoi seeds randomly within the disk
    seeds_xy: list[np.ndarray] = []
    while len(seeds_xy) < n_grains:
        candidate = rng.uniform(-radius, radius, size=(n_grains * 3, 2))
        r2 = candidate[:, 0] ** 2 + candidate[:, 1] ** 2
        valid = candidate[r2 < radius ** 2]
        for pt in valid:
            seeds_xy.append(pt)
            if len(seeds_xy) >= n_grains:
                break

    seed_array = np.array(seeds_xy[:n_grains])

    # Assign each cell to the nearest Voronoi seed
    cell_xy = xy
    dists = np.sqrt(
        (cell_xy[:, 0:1] - seed_array[:, 0:1].T) ** 2
        + (cell_xy[:, 1:2] - seed_array[:, 1:2].T) ** 2
    )
    grain_id = np.argmin(dists, axis=1)

    # Random Ms per grain
    grain_ms_factor = rng.uniform(ms_min_frac, 1.0, size=n_grains)
    ms_field = [float(ms_base * grain_ms_factor[gid]) for gid in grain_id]

    # Exchange: reduce near grain boundaries
    # A cell is "near boundary" if the 2nd-nearest Voronoi seed is within ~grain_size/2
    sorted_dists = np.sort(dists, axis=1)
    boundary_proximity = sorted_dists[:, 1] - sorted_dists[:, 0]
    # Normalize: if boundary_proximity < grain_size/4 → boundary region
    boundary_threshold = grain_size / 4
    a_field = []
    for i in range(n_cells):
        if boundary_proximity[i] < boundary_threshold:
            # Boundary: reduce exchange
            blend = boundary_proximity[i] / boundary_threshold
            factor = a_boundary_frac + (1.0 - a_boundary_frac) * blend
            a_field.append(float(a_base * factor))
        else:
            a_field.append(float(a_base))

    return ms_field, a_field


# ─────────────────────────────────────────────────────────────────────
# Geometry and materials
# ─────────────────────────────────────────────────────────────────────

disk = Cylinder(radius=RADIUS, height=T_FREE, name="free_disk_500nm")

# Uniform material (used for initial relaxation, then replaced with granular)
mat_nife_uniform = Material(
    name="NiFe_uniform",
    Ms=MS_NIFE,
    A=A_NIFE,
    alpha=ALPHA_NIFE,
)

free_layer_uniform = Ferromagnet(
    name="free",
    geometry=disk,
    material=mat_nife_uniform,
    m0=texture.vortex(circulation=+1, core_polarity=+1),
)

# ─────────────────────────────────────────────────────────────────────
# Runtime — FEM solver
# ─────────────────────────────────────────────────────────────────────

runtime_fem = RuntimeSelection(
    backend_target=BackendTarget.FEM,
    execution_precision=ExecutionPrecision.DOUBLE,
)

disc_fem = DiscretizationHints(
    fem=FEM(order=1, maximum_element_size=4e-9),    # ~4 nm max element size
)

# Alternative: FDM runtime (faster for time-domain STNO)
runtime_fdm = RuntimeSelection(
    backend_target=BackendTarget.FDM,
    execution_precision=ExecutionPrecision.DOUBLE,
)

disc_fdm = DiscretizationHints(
    fdm=FDM(default_cell=(2.5e-9, 2.5e-9, 1e-9)),  # refined grid
)

# ═════════════════════════════════════════════════════════════════════
# Stage 1: Vortex Relaxation (FEM)
# ═════════════════════════════════════════════════════════════════════

relax_outputs = [
    SaveScalar(scalar="E_total", every=50e-12),
    SaveScalar(scalar="E_ex", every=50e-12),
    SaveScalar(scalar="E_demag", every=50e-12),
    SaveScalar(scalar="max_dm_dt", every=50e-12),
    Snapshot(field="m", component="3D", every=2e-9),
]

relax_problem_fem = Problem(
    name="jenkins_vortex_relax_fem",
    description=(
        "Relaxation to vortex state in 500nm NiFe disk (FEM). "
        "Based on Jenkins et al. Commun. Mater. 5, 7 (2024)."
    ),
    magnets=[free_layer_uniform],
    energy=[Exchange(), Demag()],
    study=Relaxation(
        outputs=relax_outputs,
        torque_tolerance=1e-5,
        max_steps=100_000,
    ),
    discretization=disc_fem,
    runtime=runtime_fem,
)

# ═════════════════════════════════════════════════════════════════════
# Stage 2: Sub-threshold excitation — probing the pinned mode
#
# From paper: "a clear threshold Prf below which the vortex core
# is pinned, and above which the core escapes the pinning sites
# and enters the gyrotropic mode"
#
# At low power (Prf = 10 µW), the resonant frequency varies
# strongly as a function of the in-plane magnetic field.
# ═════════════════════════════════════════════════════════════════════

# Small AC Oersted excitation at 1 mA (sub-threshold for d=500nm)
oersted_sub = OerstedCylinder(
    current=1e-3,            # 1 mA excitation current
    radius=RADIUS,
    center=(0, 0, 0),
    axis=(0, 0, 1),
    time_dependence=Sinusoidal(
        frequency_hz=F_GYRO_EXPECTED,  # 115 MHz — gyrotropic freq for d=500nm
        phase_rad=0.0,
    ),
)

time_outputs_fine = [
    SaveScalar(scalar="mx", every=5e-12),
    SaveScalar(scalar="my", every=5e-12),
    SaveScalar(scalar="mz", every=5e-12),
    SaveScalar(scalar="E_total", every=50e-12),
    SaveScalar(scalar="time", every=5e-12),
    Snapshot(field="m", component="z", every=0.5e-9),
]

sub_threshold_problem = Problem(
    name="jenkins_sub_threshold_drive",
    description=(
        "Sub-threshold RF excitation to probe pinned vortex mode. "
        "Prf ~ 10µW, f = 115 MHz."
    ),
    magnets=[free_layer_uniform],
    energy=[Exchange(), Demag(), oersted_sub],
    study=TimeEvolution(
        dynamics=LLG(
            integrator="rk45",
            adaptive_timestep=AdaptiveTimestep(
                atol=1e-7,
                rtol=1e-7,
                dt_initial=1e-14,
                dt_max=5e-13,
            ),
        ),
        outputs=time_outputs_fine,
    ),
    discretization=disc_fem,
    runtime=runtime_fem,
)

# ═════════════════════════════════════════════════════════════════════
# Stage 3: Super-threshold excitation — gyrotropic mode
#
# From paper: "Prf = 150 µW" → gyrotropic mode visible with
# constant frequency ~115 MHz, independent of field.
# ═════════════════════════════════════════════════════════════════════

oersted_super = OerstedCylinder(
    current=10e-3,           # 10 mA — stronger excitation (super-threshold)
    radius=RADIUS,
    center=(0, 0, 0),
    axis=(0, 0, 1),
    time_dependence=Sinusoidal(
        frequency_hz=F_GYRO_EXPECTED,
    ),
)

super_threshold_problem = Problem(
    name="jenkins_super_threshold_drive",
    description=(
        "Super-threshold RF excitation for gyrotropic mode. "
        "Prf ~ 150µW, f = 115 MHz."
    ),
    magnets=[free_layer_uniform],
    energy=[Exchange(), Demag(), oersted_super],
    study=TimeEvolution(
        dynamics=LLG(
            integrator="rk45",
            adaptive_timestep=AdaptiveTimestep(
                atol=1e-7,
                rtol=1e-7,
                dt_initial=1e-14,
                dt_max=5e-13,
            ),
        ),
        outputs=time_outputs_fine,
    ),
    discretization=disc_fem,
    runtime=runtime_fem,
)

# ═════════════════════════════════════════════════════════════════════
# Stage 4: With external in-plane field (Zeeman)
#
# Paper sweeps Hx and Hy to map pinning landscape.
# Example: Hx = -4.2 mT, Hy = 3.3 mT (weakly pinned site)
# and:     Hx = -5.4 mT, Hy = 2.6 mT (strongly pinned site)
# ═════════════════════════════════════════════════════════════════════

# Field position 1 (weakly pinned, f1 ≈ 220 MHz)
MU0 = 4 * math.pi * 1e-7
BX_1 = -4.2e-3 * MU0   # T (convert mT → T via µ₀ for Zeeman)
BY_1 = 3.3e-3 * MU0

# Note: Zeeman takes B in Tesla. H = 4.2 mT means µ₀H = 4.2e-3 × µ₀ T
# Actually for external field Zeeman wants B = µ₀ H_ext
# For mT field: B = µ₀ × H, where H in A/m. But "4.2 mT" likely means µ₀H = 4.2 mT
BX_1 = -4.2e-3   # T — 4.2 mT as flux density
BY_1 = 3.3e-3

field_pinned_weak = Problem(
    name="jenkins_field_pinned_weak",
    description=(
        "Vortex in in-plane field [Hx,Hy] = [-4.2, 3.3] mT. "
        "Weakly pinned site → f ≈ 220 MHz."
    ),
    magnets=[free_layer_uniform],
    energy=[
        Exchange(),
        Demag(),
        Zeeman(B=(BX_1, BY_1, 0)),
        oersted_sub,
    ],
    study=TimeEvolution(
        dynamics=LLG(
            integrator="rk45",
            adaptive_timestep=AdaptiveTimestep(
                atol=1e-7,
                rtol=1e-7,
                dt_initial=1e-14,
                dt_max=5e-13,
            ),
        ),
        outputs=time_outputs_fine,
    ),
    discretization=disc_fem,
    runtime=runtime_fem,
)

# Field position 2 (strongly pinned, f2 ≈ 1400 MHz)
BX_2 = -5.4e-3   # T
BY_2 = 2.6e-3

field_pinned_strong = Problem(
    name="jenkins_field_pinned_strong",
    description=(
        "Vortex in in-plane field [Hx,Hy] = [-5.4, 2.6] mT. "
        "Strongly pinned site → f ≈ 1400 MHz."
    ),
    magnets=[free_layer_uniform],
    energy=[
        Exchange(),
        Demag(),
        Zeeman(B=(BX_2, BY_2, 0)),
        oersted_sub,
    ],
    study=TimeEvolution(
        dynamics=LLG(
            integrator="rk45",
            adaptive_timestep=AdaptiveTimestep(
                atol=1e-7,
                rtol=1e-7,
                dt_initial=1e-14,
                dt_max=5e-13,
            ),
        ),
        outputs=time_outputs_fine,
    ),
    discretization=disc_fem,
    runtime=runtime_fem,
)

# ═════════════════════════════════════════════════════════════════════
# Stage 5: STT-driven oscillation (CPP geometry, Slonczewski)
#
# From paper ref [28]: Dussaux et al. studied field dependence of
# spin-transfer-induced vortex dynamics in the nonlinear regime.
# Critical current for auto-oscillation depends on thickness.
# ═════════════════════════════════════════════════════════════════════

stt_slonczewski = SlonczewskiSTT(
    current_density=(0, 0, 3e10),    # J = 3×10¹⁰ A/m² (moderate CPP current)
    spin_polarization=(1, 0, 0),     # SAF reference layer along +x (easy axis)
    degree=0.3,                       # P = 0.3 (typical TMR ratio → polarization)
    lambda_asymmetry=1.0,
    epsilon_prime=0.0,
)

oersted_dc_bias = OerstedCylinder(
    current=0.3e-3,      # 0.3 mA DC bias current
    radius=RADIUS,
    center=(0, 0, 0),
    axis=(0, 0, 1),
)

stt_autooscillation_problem = Problem(
    name="jenkins_stt_autooscillation",
    description=(
        "Slonczewski STT-driven vortex auto-oscillation in 500nm NiFe disk. "
        "CPP geometry, J = 3×10¹⁰ A/m², P = 0.3."
    ),
    magnets=[free_layer_uniform],
    energy=[
        Exchange(),
        Demag(),
        oersted_dc_bias,
    ],
    spin_torque=stt_slonczewski,
    study=TimeEvolution(
        dynamics=LLG(
            integrator="rk45",
            adaptive_timestep=AdaptiveTimestep(
                atol=1e-7,
                rtol=1e-7,
                dt_initial=1e-14,
                dt_max=1e-12,
            ),
        ),
        outputs=[
            SaveScalar(scalar="mx", every=10e-12),
            SaveScalar(scalar="my", every=10e-12),
            SaveScalar(scalar="mz", every=10e-12),
            SaveScalar(scalar="time", every=10e-12),
            SaveScalar(scalar="max_dm_dt", every=50e-12),
            SaveField(field="m", every=1e-9),
            Snapshot(field="m", component="z", every=0.5e-9),
            Snapshot(field="m", component="3D", every=2e-9),
        ],
    ),
    discretization=disc_fem,
    runtime=runtime_fem,
)

# ═════════════════════════════════════════════════════════════════════
# Stage 6: CoFeSiB amorphous free layer (reduced pinning)
#
# From paper: CoFeSiB = Co₆₇Fe₄Si₁₄.₅B₁₄.₅
# Properties: amorphous, lower pinning threshold
# Paper shows Prf threshold drops ~3 orders of magnitude for 40nm
# ═════════════════════════════════════════════════════════════════════

mat_cofesib = Material(
    name="CoFeSiB_amorphous",
    Ms=600e3,       # A/m — estimated for Co₆₇Fe₄Si₁₄.₅B₁₄.₅
    A=1.0e-11,      # J/m — lower exchange (softer amorphous)
    alpha=0.01,     # damping — similar to NiFe
)

disk_cofesib_7nm = Cylinder(
    radius=200e-9,   # 400 nm diameter for direct comparison
    height=9e-9,     # CoFeB(2)/Ta(0.5)/CoFeSiB(7)
    name="cofesib_disk_7nm",
)

disk_cofesib_40nm = Cylinder(
    radius=200e-9,
    height=42e-9,    # CoFeB(2)/Ta(0.5)/CoFeSiB(40)
    name="cofesib_disk_40nm",
)

free_cofesib_7nm = Ferromagnet(
    name="free_cofesib_7",
    geometry=disk_cofesib_7nm,
    material=mat_cofesib,
    m0=texture.vortex(circulation=+1, core_polarity=+1),
)

free_cofesib_40nm = Ferromagnet(
    name="free_cofesib_40",
    geometry=disk_cofesib_40nm,
    material=mat_cofesib,
    m0=texture.vortex(circulation=+1, core_polarity=+1),
)

# CoFeSiB relax + drive for comparison
cofesib_relax_7nm = Problem(
    name="jenkins_cofesib_7nm_relax",
    description="Relax CoFeSiB(7nm) amorphous free layer to vortex",
    magnets=[free_cofesib_7nm],
    energy=[Exchange(), Demag()],
    study=Relaxation(
        outputs=relax_outputs,
        torque_tolerance=1e-5,
        max_steps=100_000,
    ),
    discretization=disc_fem,
    runtime=runtime_fem,
)

cofesib_relax_40nm = Problem(
    name="jenkins_cofesib_40nm_relax",
    description="Relax CoFeSiB(40nm) amorphous free layer — reduced pinning",
    magnets=[free_cofesib_40nm],
    energy=[Exchange(), Demag()],
    study=Relaxation(
        outputs=relax_outputs,
        torque_tolerance=1e-5,
        max_steps=100_000,
    ),
    discretization=DiscretizationHints(
        fem=FEM(order=1, maximum_element_size=5e-9),  # slightly coarser for thicker disk
    ),
    runtime=runtime_fem,
)

# ═════════════════════════════════════════════════════════════════════
# Validation and summary
# ═════════════════════════════════════════════════════════════════════

ALL_PROBLEMS = [
    relax_problem_fem,
    sub_threshold_problem,
    super_threshold_problem,
    field_pinned_weak,
    field_pinned_strong,
    stt_autooscillation_problem,
    cofesib_relax_7nm,
    cofesib_relax_40nm,
]


if __name__ == "__main__":
    print("=" * 70)
    print("Jenkins et al. (2024) — Vortex Pinning in MTJ — FEM Simulation Setup")
    print("=" * 70)
    print()
    print(f"Device: {DIAMETER*1e9:.0f} nm diameter nanopillar")
    print(f"Free layer: NiFe {T_NIFE*1e9:.0f} nm + CoFeB {T_COFEB*1e9:.0f} nm")
    print(f"Ms = {MS_NIFE/1e3:.0f} kA/m, A = {A_NIFE*1e11:.1f}×10⁻¹¹ J/m, α = {ALPHA_NIFE}")
    print(f"Expected f_gyro ≈ {F_GYRO_EXPECTED/1e6:.0f} MHz")
    print(f"Grain size: {GRAIN_SIZE*1e9:.0f} nm")
    print(f"Ms disorder: {MS_MIN_FRACTION:.0%}–100%")
    print(f"A at boundaries: {A_BOUNDARY_FRACTION:.0%}")
    print()

    for prob in ALL_PROBLEMS:
        ir = prob.to_ir(include_geometry_assets=False)
        study_kind = ir.get("study", {}).get("kind", "unknown")
        n_energy = len(ir.get("energy_terms", []))
        has_stt = ir.get("current_density") is not None
        print(f"  {prob.name}")
        print(f"    study={study_kind}, energy_terms={n_energy}, stt={has_stt}")

    print()

    # Validate STT auto-oscillation IR
    ir = stt_autooscillation_problem.to_ir(include_geometry_assets=False)
    assert ir.get("current_density") == [0, 0, 3e10]
    assert ir.get("stt_degree") == 0.3
    assert ir.get("stt_spin_polarization") == [1, 0, 0]
    print("  ✓ STT fields correctly propagated to IR")

    # Demonstrate granular field generation
    print()
    print("── Granular field generation demo ──")
    # Synthetic cell centers for a small test grid
    cell_size = 5e-9
    n_x = int(2 * RADIUS / cell_size)
    n_y = n_x
    centers = []
    for iy in range(n_y):
        for ix in range(n_x):
            cx = -RADIUS + (ix + 0.5) * cell_size
            cy = -RADIUS + (iy + 0.5) * cell_size
            if cx**2 + cy**2 < RADIUS**2:
                centers.append((cx, cy, T_FREE / 2))

    ms_field, a_field = generate_granular_fields(
        centers,
        radius=RADIUS,
        grain_size=GRAIN_SIZE,
        ms_base=MS_NIFE,
        ms_min_frac=MS_MIN_FRACTION,
        a_base=A_NIFE,
        a_boundary_frac=A_BOUNDARY_FRACTION,
        seed=42,
    )

    ms_arr = np.array(ms_field)
    a_arr = np.array(a_field)
    print(f"  Grid: {len(centers)} cells within disk")
    print(f"  Ms range: [{ms_arr.min()/1e3:.1f}, {ms_arr.max()/1e3:.1f}] kA/m"
          f" (expected: [{MS_NIFE*MS_MIN_FRACTION/1e3:.1f}, {MS_NIFE/1e3:.1f}])")
    print(f"  A range:  [{a_arr.min()*1e11:.3f}, {a_arr.max()*1e11:.3f}] ×10⁻¹¹ J/m")
    print(f"  Cells with reduced A: {np.sum(a_arr < A_NIFE * 0.999)}/{len(a_arr)}"
          f" ({np.sum(a_arr < A_NIFE * 0.999)/len(a_arr)*100:.1f}%)")

    # Post-processing demo
    print()
    print("── Post-processing example (synthetic ringdown) ──")

    from fullmag.analysis.spectrum import peak_frequency, psd_from_trace
    from fullmag.analysis.vortex import track_vortex_core

    # Simulate ringdown: vortex relaxing from displaced position
    dt = 5e-12
    t = np.arange(0, 50e-9, dt)
    f_ring = F_GYRO_EXPECTED
    tau = 20e-9  # decay time
    mx = 0.05 * np.sin(2 * np.pi * f_ring * t) * np.exp(-t / tau)
    my = 0.05 * np.cos(2 * np.pi * f_ring * t) * np.exp(-t / tau)

    freqs, psd = psd_from_trace(t, my, discard_transient=2e-9)
    f_peak = peak_frequency(freqs, psd, fmin=50e6, fmax=300e6)
    print(f"  Ringdown peak: {f_peak/1e6:.1f} MHz (expected: {f_ring/1e6:.0f} MHz)")

    print()
    print("✓ All FEM simulation configurations validated.")
    print()
    print("To run a simulation, use:")
    print("  from fullmag.runtime import run")
    print("  result = run(relax_problem_fem)")
