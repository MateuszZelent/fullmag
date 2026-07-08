# Frequency-domain / modal eigensolve — self-verification `k=0` PBC by Kittel field sweep

**Status:** canonical v5 validation specification plus Patch D2 implementation plan.  
**Canonical path:** `docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md`  
**Scope:** very small periodic FEM micromagnetic systems, `k=0` modal/eigen solve, field sweep, comparison to Kittel formula.  
**Primary goal:** catch unit, sign, phase, demag, periodic-boundary and mode-selection regressions before large periodic-airbox workloads.

This document is intentionally split into two layers:

```text
1. implemented contract slice:
   public validation intent, typed IR, planner propagation, manifest metadata,
   and artifact-level verifier hook;

2. Patch D2 runtime self-verification:
   actual tiny k=0 field-sweep runner, uniform-mode selector, Kittel summary/CSV
   artifacts, and CI gate.
```

Do not treat the implemented contract slice as proof that the runtime Kittel
self-verification is complete. It proves that the validation intent can be
authored, planned, serialized and checked in existing modal artifacts.

---

## 0. Executive decision

The `k=0` PBC Kittel field sweep should become a mandatory self-verification gate for the modal/eigen pipeline and a diagnostic gate for frequency-driven backends.

It should not replace the dense Cartesian/tangent gates, sparse/direct oracle or Schur certification. It is a complementary physics-level test with a very high value-to-cost ratio:

```text
tiny periodic magnetic cell
uniform relaxed equilibrium m0
k = 0 periodic / Floquet-zero eigen solve
sweep over static bias field H0
extract the uniform positive-frequency mode
compare f_eigen(H0) against Kittel f_Kittel(H0)
```

This test should be run in staged variants:

```text
K0-0: macrospin / no demag / no exchange / no anisotropy
K0-1: PBC small FEM / no demag / Zeeman only
K0-2: PBC small FEM / Zeeman + known local anisotropy
K0-3: PBC thin-film / dynamic demag enabled / Kittel in-plane FMR
K0-4: optional damping/complex eigenvalue sanity
```

The recommended first production CI gate is `K0-1`. The recommended demag gate is `K0-3`, but it should be introduced only after the periodic airbox/demag convention is explicit and stable.

### 0.1. Current repo status

As of the 2026-07-08 v5 implementation pass, the Kittel `k=0` no-demag
validation is green for the managed K0-1 gate:

| Layer | Current status | Evidence |
|---|---|---|
| Python DSL | implemented | `K0KittelFieldSweepValidation`, `K0KittelFieldSample`, `study.k0_kittel_validation(...)` |
| Typed IR | implemented | `FemEigenK0KittelValidationIR`, `FemEigenPlanIR.k0_kittel_validation` |
| Planner | implemented | reads `runtime_metadata.k0_kittel_validation`, validates it, carries it into `FemEigenPlanIR` |
| Runner/orchestrator metadata | implemented | `PathSolveResult.k0_kittel_validation`; file writer and production multi-k dispatch manifest carry `validation.k0_kittel_validation` |
| Artifact verifier | implemented slice | `scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-field-sweep` |
| Actual tiny field-sweep runner | green for K0-1 no-demag | `examples/fem_eigen_k0_kittel_zeeman_no_demag.py` exists; production multi-k dispatch applies `K0KittelFieldSample.bias_field` as the per-sample `point_plan.external_field`; fixture window covers the 0.02-0.4 T sweep |
| Uniform-mode selector | green for K0-1 no-demag | K0 branch selection uses mode-shape uniform-subspace scoring; the native full_2x2 K0 path derives per-node weights from the tangent mass matrix and carries them into `SingleKModeResult.node_mass_weights`; managed runtime proof passed |
| `validation/kittel_k0_pbc/summary.v1.json` | green for K0-1 no-demag | emitted and verified by `just verify-fem-frequency-domain-eigen-k0-kittel-runtime` |
| `validation/kittel_k0_pbc/points.v1.csv` | green for K0-1 no-demag | emitted and verified by `just verify-fem-frequency-domain-eigen-k0-kittel-runtime` |
| Managed CI gate | green for K0-1 no-demag | `just verify-fem-frequency-domain-eigen-k0-kittel-runtime` passed on 2026-07-08 |
| Demag K0-3 gate | deferred | must wait for explicit periodic-airbox/dynamic-demag convention stability |

The current artifact verifier is therefore a contract-level and artifact-level
gate. It must not be reported as the full Kittel runtime self-verification
until Patch D2 emits the dedicated summary/CSV artifacts from a real per-sample
bias-field sweep and passes the managed `just` verification target.

---

## 1. Why this test is valuable

A Kittel field sweep probes several independent failure modes with one cheap run.

| Failure mode | What the Kittel sweep sees |
|---|---|
| wrong `γ` units | slope is wrong by constant factor |
| missing `2π` | slope wrong by `2π` |
| missing or duplicated `μ0` | slope/demag term wrong by `μ0` or `1/μ0` |
| wrong sign of gyrotropic block | negative frequency branch selected or chirality flips |
| wrong phasor convention mapping | phase/chirality diagnostic inconsistent |
| wrong Zeeman/equilibrium-field tangent term | Zeeman-only test does not produce `f ∝ H0` |
| PBC seam treated as free boundary | uniform mode not uniform; extra low modes appear |
| k=0 Floquet not equal periodic | `periodic` and `floquet(k=0)` results differ |
| demag k=0 convention wrong | in-plane thin-film Kittel `sqrt(H(H+M_eff))` fails |
| mode dedup/sorting wrong | extracted mode jumps between branches |
| Cartesian↔tangent bug | `m0·δm` leakage or tangent roundtrip errors |

This is the cheapest test that connects the solver's formal COMSOL-aligned contract to a recognizable physical result.

---

## 2. Relation to the canonical frequency-domain contract

The validation must follow the canonical contract:

```text
m(r,t) = m0(r) + Re(delta_m(r) exp(+i omega t))
delta_m ∈ C^3 per magnetic node
m0 · delta_m = 0
internal tangent representation: delta_m_i = T_i q_i, q_i ∈ C^2
```

For the Kittel test the equilibrium is intentionally simple:

```text
m0 = uniform unit vector
h_eff0 ∥ m0
m0 × h_eff0 = 0
```

The internal tangent representation is still used, but the public validation artifact should report the lifted Cartesian mode:

```text
dmX_real, dmX_imag
dmY_real, dmY_imag
dmZ_real, dmZ_imag
m0_dot_delta_m_real/im
```

For `k=0` PBC/Floquet, the expected physical constraint is:

```text
delta_m_dst = delta_m_src
```

and, equivalently for Floquet:

```text
delta_m_dst = delta_m_src * exp(-i k · delta_r), with k = 0
```

In tangent coordinates this is only scalar identity if paired tangent frames are identical. For the uniform Kittel validation they should be identical up to deterministic frame gauge, and the test must verify this explicitly.

---

## 3. Physics formulas

### 3.1. Units

Use one of two equivalent conventions, but never mix them.

#### A/m internal convention

```text
gamma0_rad_s_per_Am = rad / (s * A/m)
omega = gamma0 * sqrt(H1 * H2)
f = omega / (2π)
```

where `H1`, `H2`, `H0`, `Ms`, `Hk` are in `A/m`.

#### Tesla reporting convention

```text
gamma_bar_Hz_per_T = Hz / T
B = μ0 H
B_M = μ0 Ms
B_K = μ0 Hk
f = gamma_bar * sqrt(B1 * B2)
```

The two conventions are equivalent if:

```text
gamma0_rad_s_per_Am = 2π * gamma_bar_Hz_per_T * μ0
```

Recommended artifact fields:

```json
{
  "gamma0_rad_s_per_Am": 221000.0,
  "gamma_bar_Hz_per_T": 28110000000.0,
  "mu0_H0_T": 0.100,
  "H0_A_per_m": 79577.4715459
}
```

Do not compare `H_A_per_m` to a formula expecting `B_T`.

---

### 3.2. Generic two-stiffness Kittel formula

For a uniform equilibrium and two orthogonal tangent directions, the local linearized undamped dynamics reduce to:

```text
d u / dt = -gamma0 * H2 * v
d v / dt =  gamma0 * H1 * u
```

therefore:

```text
omega_K = gamma0 * sqrt(H1 * H2)
f_K = omega_K / (2π)
```

In Tesla convention:

```text
f_K = gamma_bar * sqrt(B1 * B2)
```

This is the most useful formulation for implementation because every special case just defines `H1` and `H2`.

---

### 3.3. K0-0 / K0-1: no demag, no anisotropy, Zeeman only

Configuration:

```text
m0 = +z
H0 = H0 * z
demag = disabled
exchange = disabled or enabled but uniform k=0 mode
anisotropy = disabled
alpha = 0
```

Expected:

```text
H1 = H0
H2 = H0
omega = gamma0 * H0
f = gamma0 * H0 / (2π)
```

or:

```text
f = gamma_bar * μ0 H0
```

This is the cleanest gate for:

```text
gamma units
2π
Zeeman sign
tangent frame orientation
positive-frequency selection
```

It should be exact to dense/sparse numerical precision.

---

### 3.4. K0-2: known uniaxial anisotropy

For an easy-axis field-like anisotropy aligned with `m0`:

```text
h_an = Hk (eK · m) eK
eK = m0 = +z
```

the transverse dynamics see an equilibrium field:

```text
H_eff0 = H0 + Hk
```

Expected:

```text
H1 = H0 + Hk
H2 = H0 + Hk
f = gamma0 * (H0 + Hk) / (2π)
```

This tests whether the static equilibrium effective field contribution is included in the tangent-projected linearization. It is also a good detector for the common error “Zeeman contribution to Hessian is zero, therefore static field was omitted from the projected LLG operator.”

If the implementation instead uses energy-density anisotropy `Ku [J/m^3]`, the field equivalent must be explicit:

```text
Hk = 2 Ku / (μ0 Ms)
```

Do not silently treat `Ku` and field-like `K` as the same quantity.

---

### 3.5. K0-3: in-plane thin-film Kittel formula with demag

This is the most relevant test for periodic-airbox/dynamic-demag, but it is also the easiest to misconfigure.

Configuration:

```text
film normal = +z
periodic axes = x, y
open / airbox axis = z
m0 = +x
H0 = H0 * x
demag = enabled
exchange = enabled or disabled; k=0 uniform exchange contribution is zero
anisotropy = disabled initially
alpha = 0 for eigenfrequency gate
```

For an ideal infinite thin film:

```text
N_x = 0
N_y = 0
N_z = 1
```

and the in-plane Kittel formula is:

```text
f = gamma_bar * sqrt(B_H * (B_H + B_Meff))
```

or, in A/m convention:

```text
f = gamma0 / (2π) * sqrt(H0 * (H0 + M_eff))
```

with:

```text
B_H = μ0 H0
B_Meff = μ0 M_eff
M_eff ≈ Ms            if no perpendicular anisotropy
```

If there is a perpendicular anisotropy field, define it explicitly and use:

```text
M_eff = Ms - Hk_perp
```

where `Hk_perp` is in `A/m`. If using an energy-density convention:

```text
Hk_perp = 2 Ku_perp / (μ0 Ms)
```

Acceptance for this gate should be looser than Zeeman-only because airbox size, gauge, finite thickness and mesh introduce controlled numerical error. The first goal is not machine precision; it is to prove the dynamic demag sign and scale.

---

### 3.6. K0-4: perpendicular thin-film sanity

Optional additional demag case:

```text
film normal = +z
m0 = +z
H0 = H0 * z
H0 > M_eff
```

Expected:

```text
f = gamma0 / (2π) * (H0 - M_eff)
```

or:

```text
f = gamma_bar * (B_H - B_Meff)
```

This linear branch is a good check for demag sign. It is less robust near saturation threshold, so choose `H0` comfortably above `M_eff`.

---

## 4. Minimal system design

### 4.1. Magnetic geometry

Use the smallest mesh that still exercises the FEM/PBC machinery.

Recommended first slice:

```text
geometry: rectangular film/cell
PBC: x and y for K0-3; x/y/z or no demag for K0-1 depending on implementation
elements: P1 tetrahedra
magnetic nodes: as small as PBC pair validation allows
material: uniform
```

Suggested tiny meshes:

```text
K0-1 no demag:
    1x1x1 or 2x2x1 cell equivalent, depending on periodic mapper requirements

K0-3 thin film demag:
    2x2x1 magnetic cells minimum
    at least one element through thickness
    symmetric airbox top/bottom
    matched x/y periodic airbox pairs
```

For strict periodic FEM v1:

```text
require symmetric matched mesh certificate
require source/destination node bijection
require material and boundary labels equal across periodic classes
require tangent-frame transfer blocks to be identity for uniform m0
```

### 4.2. Material

Use a simple material, for example:

```text
Ms = 800000 A/m         # or project default YIG-like value
gamma_bar = 28.0e9 Hz/T
gamma0 = 2π * gamma_bar * μ0
alpha = 0 for eigensolve gate
Aex = any positive value; exchange has zero k=0 contribution for uniform mode
Ku = 0 initially
DMI = disabled
STT = disabled
EASA = disabled
temperature = 0
```

Store both `gamma_bar` and `gamma0` in artifacts to prevent unit ambiguity.

### 4.3. Bias field sweep

Use fields that avoid numerical degeneracy and saturation edge cases.

For Zeeman-only:

```text
μ0 H0_T = [0.02, 0.05, 0.10, 0.20, 0.40]
```

For in-plane demag film:

```text
μ0 H0_T = [0.02, 0.04, 0.08, 0.12, 0.20, 0.30, 0.50]
```

If using YIG-like `Ms ≈ 0.194e6 A/m`, reduce the upper range if desired. If using `Ms = 0.8e6 A/m`, the range above is safe.

Avoid zero field in the first gate. At zero field the branch can become degenerate and mode selection becomes a separate test.

---

## 5. Solver configuration

### 5.1. Modal/eigen request

The gate should run as modal/eigen, not driven response.

Required settings:

```text
study_product = modal_eigen
spin_wave_bc = periodic
k_vector = [0, 0, 0]
phasor_convention = exp_plus_i_omega_t
requested_mode_count >= 2
positive_frequency_policy = select_positive_frequency
demag_kind = none for K0-1
demag_kind = periodic_airbox_k0 for K0-3
alpha = 0
```

If the solver uses a generalized pencil:

```text
K v = lambda G v
```

the accepted frequency must be derived from the positive imaginary/positive frequency branch according to the solver's documented convention. The artifact must record:

```json
{
  "eigenvalue_real": ...,
  "eigenvalue_imag": ...,
  "omega_rad_s": ...,
  "frequency_hz": ...,
  "positive_frequency_branch": true
}
```

### 5.2. Backend order for this validation

Recommended:

```text
1. dense_tangent_reference if tiny dense payload exists
2. cpu_sparse_direct / SLEPc shift-invert
3. production modal sparse CSR
4. gpu_device_krylov modal path only after device-residency gates
```

For this self-verification, `gpu_operator_host_krylov` is not required. The point is to validate eigensolve algebra and physics, not to benchmark runtime throughput.

---

## 6. Mode extraction

The sweep must not blindly take the first positive mode. It must identify the uniform Kittel mode.

### 6.1. Build the reference uniform mode

For `m0 = +z`, a circular positive-frequency tangent mode can be represented by:

```text
q_ref = e1 + i * s * e2
```

where `s` depends on the gyrotropic sign convention. Do not hard-code `s` as the only selector until the phase/chirality gate is finalized.

For robust initial mode selection, use the linearly polarized uniform subspace:

```text
U = span(uniform e1, uniform e2)
```

and compute overlap of the numerical mode with this subspace.

### 6.2. Uniformity score

For an eigenvector `q`, define:

```text
q_mean = average over periodic magnetic nodes
uniformity_score =
    sum_i |q_mean|^2 / sum_i |q_i|^2
```

Better, mass-weighted:

```text
uniformity_score =
    ||P_uniform q||_M^2 / ||q||_M^2
```

Acceptance:

```text
K0-1 no demag:        uniformity_score >= 0.999999
K0-3 demag thin film: uniformity_score >= 0.995 initially, tighten later
```

### 6.3. Constraint leakage

After lifting to Cartesian:

```text
delta_m_i = T_i q_i
```

verify:

```text
max_i |m0_i · delta_m_i| / max_i |delta_m_i| < tolerance
```

Acceptance:

```text
dense/sparse CPU: <= 1e-10 ... 1e-8
GPU/matrix-free:  <= 1e-6 initially
```

### 6.4. Branch continuity

Across the field sweep, track the same branch by overlap with the previous accepted mode:

```text
overlap_j(H_n, H_{n-1}) = |<q_j(H_n), q_selected(H_{n-1})>_M|
```

Do not sort by frequency only once demag, anisotropy, or multiple cells are enabled.

---

## 7. Expected-value calculation

### 7.1. Python reference function

```python
import math

MU0 = 4.0 * math.pi * 1e-7

def gamma0_from_gamma_bar(gamma_bar_hz_per_t: float) -> float:
    # gamma0 maps H[A/m] to omega[rad/s]
    return 2.0 * math.pi * gamma_bar_hz_per_t * MU0

def kittel_zeeman_only_hz(H0_A_per_m: float, gamma0_rad_s_per_Am: float) -> float:
    omega = gamma0_rad_s_per_Am * H0_A_per_m
    return omega / (2.0 * math.pi)

def kittel_two_stiffness_hz(
    H1_A_per_m: float,
    H2_A_per_m: float,
    gamma0_rad_s_per_Am: float,
) -> float:
    if H1_A_per_m < 0.0 or H2_A_per_m < 0.0:
        raise ValueError("Kittel stiffness fields must be non-negative for this gate")
    omega = gamma0_rad_s_per_Am * math.sqrt(H1_A_per_m * H2_A_per_m)
    return omega / (2.0 * math.pi)

def kittel_inplane_film_hz(
    H0_A_per_m: float,
    Ms_A_per_m: float,
    gamma0_rad_s_per_Am: float,
    Hk_inplane_A_per_m: float = 0.0,
    Meff_A_per_m: float | None = None,
) -> float:
    if Meff_A_per_m is None:
        Meff_A_per_m = Ms_A_per_m
    H1 = H0_A_per_m + Hk_inplane_A_per_m
    H2 = H0_A_per_m + Hk_inplane_A_per_m + Meff_A_per_m
    return kittel_two_stiffness_hz(H1, H2, gamma0_rad_s_per_Am)

def kittel_inplane_film_hz_from_tesla(
    B_H_T: float,
    B_Meff_T: float,
    gamma_bar_hz_per_t: float,
    B_K_T: float = 0.0,
) -> float:
    return gamma_bar_hz_per_t * math.sqrt((B_H_T + B_K_T) * (B_H_T + B_K_T + B_Meff_T))
```

### 7.2. Fit model for sweep-level validation

Per-point errors are necessary but not sufficient. Also fit the sweep.

For in-plane film:

```text
f(B) = gamma_bar * sqrt((B + B_offset) * (B + B_offset + B_Meff))
```

Staged fits:

```text
Fit A: gamma fixed, B_Meff fixed, B_offset = 0
Fit B: gamma fixed, B_Meff free, B_offset = 0
Fit C: gamma and B_Meff free
Fit D: gamma fixed, B_Meff fixed, B_offset free
```

Interpretation:

| Fit symptom | Likely bug |
|---|---|
| fitted `gamma` off by `2π` | angular/cyclic frequency mix |
| fitted `gamma` off by `μ0` | A/m vs Tesla mix |
| fitted `B_Meff ≈ 0` in demag film | dynamic demag missing |
| fitted `B_Meff < 0` unexpectedly | demag sign wrong |
| large `B_offset` | static field offset, anisotropy offset or wrong equilibrium |
| high scatter but good fit mean | mode selection or residual tolerance issue |

---

## 8. Acceptance thresholds

Use staged thresholds because K0-1 and K0-3 have different numerical difficulty.

### 8.1. K0-1 Zeeman-only

Required for CI:

```text
max_relative_frequency_error <= 1e-8 dense/reference
max_relative_frequency_error <= 1e-6 sparse/modal
uniformity_score_min >= 0.999999
max_tangent_leakage <= 1e-10 CPU
mode_residual_relative <= solver_eigen_tolerance * 10
monotonic f(H) strictly increasing
```

For early implementation, temporary threshold may be:

```text
max_relative_frequency_error <= 1e-5
```

but only with a tracked issue.

### 8.2. K0-2 anisotropy

Required after anisotropy operator is production:

```text
max_relative_frequency_error <= 1e-5 initially
fitted Hk error <= 0.5%
```

Tighten after unit conventions are frozen.

### 8.3. K0-3 thin-film demag

Initial acceptance:

```text
max_relative_frequency_error <= 2e-2
median_relative_frequency_error <= 5e-3
fitted Meff within 2% of expected Ms or documented demag convention
uniformity_score_min >= 0.995
k=0 periodic and floquet(k=0) agree within 1e-6 relative for no-demag,
and within 1e-4...1e-3 for demag depending on airbox tolerance
```

Production acceptance after airbox/demag stabilization:

```text
max_relative_frequency_error <= 5e-3
median_relative_frequency_error <= 1e-3
fitted Meff within 0.5%
```

### 8.4. Explicit non-goals

This gate does not certify:

```text
nonzero-k dispersion
exchange stiffness from k^2 slope
nonuniform skyrmion modes
Schur correctness
large-GPU performance
DMI boundary conditions
```

Those require separate gates.

---

## 9. Test matrix

| ID | Demag | Anisotropy | PBC | Formula | Purpose |
|---|---|---|---|---|---|
| `kittel_k0_macrospin_zeeman` | off | off | optional | `f = γ μ0H / 2π` or `γbar B` | unit/sign baseline |
| `kittel_k0_pbc_zeeman` | off | off | k=0 PBC | same | periodic constraint baseline |
| `kittel_k0_pbc_anisotropy_axis` | off | easy axis along `m0` | k=0 PBC | `f = γ(H+Hk)/2π` | static effective field term |
| `kittel_k0_pbc_thinfilm_demag_inplane` | on | off | x/y PBC | `f=γsqrt(H(H+Ms))/2π` | dynamic demag sign/scale |
| `kittel_k0_pbc_thinfilm_demag_perp` | on | off | x/y PBC | `f=γ(H-Ms)/2π` | demag sign sanity |
| `kittel_k0_floquet_zero_equivalence` | off initially | off | Floquet `k=0` | same as PBC | Floquet zero-phase gate |

---

## 10. Proposed artifact schema

### 10.1. Summary JSON

File:

```text
validation/kittel_k0_pbc/summary.v1.json
```

Schema:

```json
{
  "schema_version": "frequency_domain_kittel_k0_validation.v1",
  "status": "passed",
  "test_id": "kittel_k0_pbc_thinfilm_demag_inplane",
  "phasor_convention": "exp_plus_i_omega_t",
  "boundary_condition": "periodic_k0",
  "k_vector_rad_per_m": [0.0, 0.0, 0.0],
  "demag_kind": "periodic_airbox_k0",
  "gamma0_rad_s_per_Am": 221000.0,
  "gamma_bar_Hz_per_T": 28110000000.0,
  "Ms_A_per_m": 800000.0,
  "mu0_Ms_T": 1.005309649,
  "sweep_point_count": 7,
  "max_relative_frequency_error": 0.0021,
  "median_relative_frequency_error": 0.0008,
  "fit": {
    "model": "inplane_film_kittel",
    "gamma_fixed": true,
    "fitted_Meff_A_per_m": 798500.0,
    "relative_Meff_error": 0.001875,
    "B_offset_T": 0.0
  },
  "mode_selection": {
    "minimum_uniformity_score": 0.997,
    "minimum_branch_overlap": 0.995,
    "maximum_tangent_leakage": 1.0e-9
  },
  "periodic": {
    "symmetric_mesh_certificate": "passed",
    "k0_floquet_equals_periodic": true,
    "max_periodic_seam_mode_mismatch": 1.0e-10
  },
  "solver": {
    "backend": "modal_reduced_or_slepc",
    "execution_lane": "cpu_sparse_direct",
    "requested_mode_count": 4,
    "max_eigen_residual_relative": 1.0e-10
  }
}
```

### 10.2. Per-field CSV

File:

```text
validation/kittel_k0_pbc/points.v1.csv
```

Columns:

```text
field_index
H0_A_per_m
mu0_H0_T
expected_frequency_hz
eigen_frequency_hz
relative_frequency_error
selected_mode_index
eigenvalue_real
eigenvalue_imag
mode_residual_relative
uniformity_score
branch_overlap_previous
max_m0_dot_delta_m_abs
max_periodic_seam_mismatch
```

### 10.3. Failure JSON

On failure, emit:

```json
{
  "status": "failed",
  "failure_class": "unit_mismatch|demag_sign|mode_selection|pbc_constraint|solver_residual|unknown",
  "first_failed_field_index": 3,
  "observed": {
    "eigen_frequency_hz": 1.234e9,
    "expected_frequency_hz": 2.468e9,
    "relative_frequency_error": 0.5
  },
  "likely_causes": [
    "missing factor 2π",
    "H supplied in A/m but formula evaluated as Tesla"
  ]
}
```

---

## 11. Pseudocode for the validation runner

```python
def run_kittel_k0_pbc_validation(config):
    results = []

    for H0 in config.field_values_A_per_m:
        problem = build_uniform_pbc_problem(
            mesh=config.mesh,
            Ms=config.Ms_A_per_m,
            gamma0=config.gamma0_rad_s_per_Am,
            alpha=0.0,
            H0_vector_A_per_m=H0 * config.field_direction,
            m0=config.equilibrium_direction,
            demag_kind=config.demag_kind,
            anisotropy=config.anisotropy,
            pbc=config.pbc,
            k_vector=[0.0, 0.0, 0.0],
        )

        eigen = solve_modal_eigen(problem, requested_mode_count=config.requested_mode_count)

        selected = select_uniform_positive_mode(
            eigen.modes,
            m0=problem.m0,
            tangent_frames=problem.tangent_frames,
            mass=problem.mass_matrix,
            previous_mode=results[-1].mode if results else None,
        )

        expected = compute_expected_kittel_frequency(config, H0)

        results.append(compare_mode_to_expected(selected, expected, H0))

    summary = fit_and_summarize_kittel_sweep(results, config)
    write_kittel_artifacts(summary, results)
    assert_acceptance(summary, config.thresholds)
```

---

## 12. Mode selector pseudocode

```python
def select_uniform_positive_mode(modes, m0, tangent_frames, mass, previous_mode=None):
    candidates = []
    for mode in modes:
        if mode.frequency_hz <= 0:
            continue
        if mode.relative_residual > 10 * requested_eigen_tolerance:
            continue

        delta_m = lift_tangent_to_cartesian(mode.q, tangent_frames)
        leakage = max_abs_dot(m0, delta_m) / max_norm(delta_m)

        uniformity = mass_weighted_uniformity_score(mode.q, mass)
        if previous_mode is not None:
            overlap = mass_overlap(mode.q, previous_mode.q, mass)
        else:
            overlap = 1.0

        score = uniformity * overlap / max(mode.relative_residual, 1e-30)
        candidates.append((score, mode, uniformity, overlap, leakage))

    if not candidates:
        raise RuntimeError("No positive uniform Kittel mode candidate")

    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0]
```

---

## 13. Integration into the patch queue

Add a new patch after the basic COMSOL physics gates and before large demag/GPU work.

Recommended placement:

```text
Patch D2 — Kittel k=0 PBC eigensolve self-verification
```

Patch D2 is split so the existing implementation evidence can be tracked
without overstating production readiness:

| Slice | Status | Definition |
|---|---|---|
| D2a contract/verifier | implemented slice | DSL/IR/planner/manifest/verifier can carry and check `k0_kittel_validation` metadata |
| D2b runtime fixture | green for K0-1 no-demag | `examples/fem_eigen_k0_kittel_zeeman_no_demag.py` exists; production multi-k dispatch applies per-sample bias-field overrides; fixture window now covers the 0.02-0.4 T sweep |
| D2c uniform-mode selector | green for K0-1 no-demag | uniform-subspace selector implemented from carried mode-shape vectors; native full_2x2 K0 mass-weight extraction is implemented and covered by the managed K0-1 gate |
| D2d dedicated artifacts | green for K0-1 no-demag | `validation/kittel_k0_pbc/summary.v1.json` and `points.v1.csv` are emitted and verified by the managed K0-1 gate |
| D2e managed CI gate | green for K0-1 no-demag | `just verify-fem-frequency-domain-eigen-k0-kittel-runtime` passed on 2026-07-08 |
| D2f demag extended gate | deferred | K0-3 thin-film dynamic-demag gate after airbox conventions stabilize |

Dependencies:

```text
- phase convention gate
- tangent lift/project helpers
- modal eigen runner can produce positive-frequency modes
- PBC k=0 or periodic reduced mesh support
- artifact writer
```

Patch content:

```text
1. Keep this canonical document in:
   docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md
2. Add or update test spec fixtures:
   tests/frequency_domain/kittel_k0_pbc/*.json
3. Add expected formula helper:
   frequency_domain/validation/kittel_formula.hpp
4. Add mode selector:
   frequency_domain/validation/uniform_mode_selector.hpp
5. Add CI test:
   kittel_k0_pbc_zeeman_no_demag
6. Add non-CI extended test:
   kittel_k0_pbc_thinfilm_demag_inplane
```

Do not start with the demag case as the first CI gate. Start with Zeeman-only, then anisotropy, then demag.

---

## 14. Proposed C++ helper skeleton

```cpp
enum class KittelValidationGeometry : std::uint32_t {
    macrospin_no_demag = 1,
    pbc_zeeman_no_demag = 2,
    pbc_easy_axis_anisotropy = 3,
    pbc_thin_film_inplane_demag = 4,
    pbc_thin_film_perpendicular_demag = 5,
};

struct KittelFormulaInput {
    KittelValidationGeometry geometry;
    double gamma0_rad_s_per_Am;
    double ms_A_per_m;
    double h0_A_per_m;
    double hk_A_per_m;
    double meff_A_per_m;
};

struct KittelFormulaResult {
    double omega_rad_s;
    double frequency_hz;
    double h1_A_per_m;
    double h2_A_per_m;
    char formula_name[64];
};

FrequencyDomainStatus evaluate_kittel_formula(
    const KittelFormulaInput& input,
    KittelFormulaResult* out_result,
    char error_message[128]) noexcept;
```

Implementation rule:

```cpp
omega = gamma0 * sqrt(h1 * h2);
frequency = omega / (2*pi);
```

No hidden `μ0` inside `evaluate_kittel_formula` if the function receives `A/m`. A separate helper may accept Tesla.

---

## 15. Proposed JSON test fixture

```json
{
  "schema_version": "frequency_domain_validation_fixture.v1",
  "test_id": "kittel_k0_pbc_zeeman_no_demag",
  "study_product": "modal_eigen",
  "phasor_convention": "exp_plus_i_omega_t",
  "unknown_internal_representation": "tangent2_complex",
  "geometry": {
    "kind": "tiny_periodic_box",
    "periodic_axes": ["x", "y", "z"],
    "symmetric_mesh_required": true
  },
  "physics": {
    "Ms_A_per_m": 800000.0,
    "gamma_bar_Hz_per_T": 28110000000.0,
    "alpha": 0.0,
    "exchange_enabled": false,
    "demag_kind": "none",
    "anisotropy_enabled": false,
    "dmi_enabled": false,
    "stt_enabled": false
  },
  "equilibrium": {
    "m0": [0.0, 0.0, 1.0],
    "source": "analytic_uniform",
    "accepted_for_linearization": true
  },
  "sweep": {
    "field_direction": [0.0, 0.0, 1.0],
    "mu0_H0_T": [0.02, 0.05, 0.10, 0.20, 0.40]
  },
  "expected": {
    "formula": "zeeman_only",
    "frequency_units": "Hz"
  },
  "acceptance": {
    "max_relative_frequency_error": 1.0e-6,
    "minimum_uniformity_score": 0.999999,
    "maximum_tangent_leakage": 1.0e-10
  }
}
```

---

## 16. Diagnostics and troubleshooting

| Observation | Likely cause | Next check |
|---|---|---|
| all frequencies off by `2π` | using rad/s as Hz or inverse | inspect eigenvalue-to-frequency conversion |
| all frequencies off by `μ0` | A/m vs Tesla mismatch | print `H_A_per_m`, `μ0H_T`, `gamma0`, `gamma_bar` |
| frequency decreases with field | gyrotropic sign or branch selection wrong | inspect positive-frequency policy and chirality |
| Zeeman-only not linear | static field term missing in tangent LLG | check projected `δm × h_eff0` term |
| demag film result is linear `f ∝ H` | dynamic demag missing at k=0 | inspect demag operator contribution for uniform mode |
| fitted `M_eff` doubled | demag applied twice | compare full coupled vs Schur/demag path |
| mode uniformity poor | PBC seam or mesh pair issue | inspect periodic pair certificate |
| PBC and Floquet k=0 differ | Floquet phase adapter bug | compare boundary operator matrices |
| good fit but high residual | eigensolver tolerance too loose | check eigen residual and direct oracle |
| branch jumps | sorting by frequency only | use mass-overlap tracking |

---

## 17. CI policy

### Fast CI

Run on every native contract gate:

```text
kittel_k0_pbc_zeeman_no_demag
```

Requirements:

```text
runtime < 1 s preferred
no airbox
no HYPRE
no GPU
deterministic
```

### Extended CI

Run nightly or with `FULLMAG_EXTENDED_FD_VALIDATION=1`:

```text
kittel_k0_pbc_easy_axis_anisotropy
kittel_k0_pbc_thinfilm_demag_inplane
kittel_k0_floquet_zero_equivalence
```

### Release gate

Before release:

```text
all Kittel variants pass on dense/sparse reference
demag variant passes with documented airbox tolerances
artifacts archived with plots and summary JSON
```

---

## 18. Documentation insertion points

This document should be referenced from:

```text
00_README_CANONICAL_FULL_READ.md
09_validation_certification_benchmarks.md
10_patch_queue_current_status.md
12_adr_decisions.md
```

The historical path suggestion `docs/frequency_domain_solver_v5/...` should not
be used unless the repo is explicitly migrated to that layout. For the current
repo, the canonical v5 folder is:

```text
docs/plans/active/fd_sovler_masterplan/
```

Add to the benchmark matrix:

```text
k0 PBC Kittel field sweep:
    validates modal eigensolve sign, γ/μ0/2π units, k=0 periodic/Floquet equivalence,
    static effective-field term and optional dynamic demag sign/scale.
```

Add to patch queue:

```text
Patch D2 — Kittel k=0 PBC eigensolve self-verification
```

---

## 19. Minimal acceptance definition

### 19.1. Artifact-level contract acceptance

The current artifact-level contract slice is considered implemented when:

```text
1. Python DSL can author k0 Kittel validation metadata.
2. The metadata lowers into typed IR and `FemEigenPlanIR`.
3. The runner/orchestrator carries the metadata into modal eigen artifacts.
4. The modal artifact verifier has an explicit `--require-k0-kittel-field-sweep` gate.
5. The verifier rejects wrong frequency scale and accepts a correct declared branch.
```

This slice is useful, but it is not the same as a runtime self-verification.

### 19.2. Runtime self-verification acceptance

The full Kittel runtime self-verification is considered implemented when:

```text
1. A no-demag k=0 PBC Zeeman-only modal test exists.
2. It sweeps at least five H0 values.
3. It extracts the uniform positive-frequency mode by uniformity/overlap, not by raw index.
4. It compares against Kittel expected frequency.
5. It emits summary JSON + per-point CSV.
6. It fails with actionable failure_class when errors exceed threshold.
7. It verifies phasor_convention=exp_plus_i_omega_t.
8. It verifies lifted Cartesian mode satisfies m0·delta_m≈0.
9. It optionally compares periodic and Floquet(k=0).
10. A demag thin-film variant exists as extended validation.
```

The first mandatory CI gate is complete only after items 1-8 run through a
managed/container-backed `just` target. Item 9 is a follow-up equivalence gate.
Item 10 is an extended demag gate and must not block the first no-demag CI
slice.

---

## 20. Recommendation

Implement this as the next validation document and test fixture before investing more work into large `periodic_airbox_k0` eigensolve or driven-response performance. The no-demag Kittel gate is cheap, deterministic and will catch the most destructive unit/sign mistakes. The demag Kittel gate then becomes a focused validation for dynamic demag k=0 and periodic-airbox semantics.
