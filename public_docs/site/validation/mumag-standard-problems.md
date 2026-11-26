---
title: µMAG Standard Problems
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-mumag-standard-problems)=
# µMAG Standard Problems

µMAG standard problems and external-solver community harnesses benchmark FullMag against published
reference trajectories and spectra. This page covers **NIST µMAG Standard Problem 4** (SP4, FEM and
FDM), **bounded µMAG Standard Problem 5** (SP5, FDM CPU/CUDA FP64 fixed-step `converged_demag` and
diagnostic FEM), and the **COMSOL-aligned nonzero-$k$ spin-wave dispersion harness**.

## µMAG Standard Problem 4 (SP4)

### Problem definition

SP4 is a $500 \times 125 \times 3\;\mathrm{nm}$ Permalloy film with saturation magnetization
$M_s = 800\,000\;\mathrm{A\,m^{-1}}$, exchange stiffness
$A_{\mathrm{ex}} = 1.3 \times 10^{-11}\;\mathrm{J\,m^{-1}}$, and damping $\alpha = 0.02$. An
S-shaped magnetization state is relaxed in zero external field, then one of two applied fields
drives a dynamic reversal:

- **Field 1 (Case A):** $\mathbf{B} = (-24.6, 4.3, 0)\;\mathrm{mT}$;
- **Field 2 (Case B):** $\mathbf{B} = (-35.5, -6.3, 0)\;\mathrm{mT}$.

The canonical observable is the volume-weighted average of the reduced magnetization; the first
zero-crossing of $\bar{m}_x$ and the trajectory envelope are compared against the NIST reference
corpus (NIST is authoritative; MuMax3/OOMMF endpoints are supplementary regression metrics only).

### FullMag FEM setup

- **Meshes:** Magnetic element sizes $3.0$, $2.0$, and $1.5\;\mathrm{nm}$; airboxes
  $700^3\;\mathrm{nm}$ and $1000 \times 500 \times 500\;\mathrm{nm}$ (plus $1200 \times 600 \times 550\;\mathrm{nm}$
  graded airbox in the relaxation scenario).
- **Thin-film prismatic route:** SP4 relaxation supports the strict mixed-prism thin-film route
  (`film.mesh.thin_film(..., layers=1, topology="prismatic", exact_layers=True, transition="pyramid_to_tetrahedra", order=1)`)
  as well as the `transition="pure_prism"` extruded wedge route (see {doc}`fem-fdm-comparison`).
  The topology-only mesh contract lives in
  [`tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py).
- **Execution lanes and GPU demag resolution:** Strict FEM CPU and strict FEM GPU in double
  precision (`FP64`). GPU demagnetization must resolve to `device_hypre_poisson` (with
  `resolved_linear_solver = "cudss_direct"` or `"hypre_krylov"`, controlled by
  `gpu_strategy` in `study.fem_demag_solver(...)`), never `hybrid_cpu_poisson`.
- **Observables:** Native $M_s \times V$ lumped-volume averages from `scalars.csv`; unweighted
  node averages are not accepted as the NIST observable.
- **Sampling:** Uninterrupted trajectories are sampled every $1\;\mathrm{ps}$; replay runs start
  from the same S-state and stop at the bracketing zero-crossing.

The public relaxation stage scenario is
[`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py),
and the managed qualification gate is:

```console
just verify-fem-standard-problem-4
```

### Canonical stage-first SP4 Python authoring pattern

```python
import fullmag as fm

study = fm.study("mumag_sp4_strict")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(1200e-9, 600e-9, 550e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=110e-9,
    maximum_element_growth_rate=1.9,
    grading="geometric",
)

film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
film.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    order=1,
)

study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=600,
    gpu_strategy="auto",
)

# Stage 1: zero-field S-state relaxation (PG-BB direct minimization)
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=100_000,
    tolT=5.8349e-9,
)

# Stage 2: NIST SP4 Field 1 (Case A) dynamic reversal
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.solver(integrator="rk4", fix_dt=2e-13, gamma=2.211e5)
study.stages.add_run(until=1.0e-9, stage_id="reversal_case_a")
```

### Functions and arguments relevant to SP4

| Function / class | Key arguments for SP4 |
|---|---|
| `GeometryMeshHandle.thin_film` | `hmax`, `hmin`, `maximum_element_size`, `minimum_element_size`, `order`, `layers`, `topology` (`"prismatic"` or `"tetrahedral"`), `exact_layers`, `transition` (`"pyramid_to_tetrahedra"`, `"pure_prism"`, or `"reject"`), `interface_maximum_element_size`, `edge_maximum_element_size`, `corner_maximum_element_size` |
| `PerObjectMeshRecipe` | `mesh_strategy="swept_prism"`, `topology="prismatic"`, `through_thickness_elements` (`1`, `2`, `3`), `exact_layer_count=True`, `transition_policy`, `element_family="prism"`, `order=1` |
| `study.fem_demag_solver` | `solver="CG"`, `preconditioner="AMG"`, `rtol=1e-12`, `max_iterations=600`, `gpu_strategy` (`"auto"`, `"cg_amg"`, or `"cudss"`) |
| `study.mode` | `"strict"` (gates certified topology, GPU residency, and fail-closed provenance) |

### FDM SP4 vs MuMax3 comparison evidence

On the canonical $128 \times 32 \times 1$ Cartesian grid ($3.90625 \times 3.90625 \times 3\;\mathrm{nm}$,
$4\,096$ cells), FullMag FDM S-state relaxation agrees closely with MuMax3 3.12:

- **August 2026 texture comparison** (`projected_gradient_bb` CPU vs MuMax3 `minimize()`):
  FullMag mean `(0.96696102, 0.12528809, -1.9e-27)` vs MuMax3 `(0.96696658, 0.12527857, 0)`;
  cellwise vector RMSE `2.342e-5`, maximum per-cell vector error `1.041e-4`, mean component
  differences $\sim 10^{-5}$.
- **November 2026 four-lane audit comparison:** FullMag FDM CPU (`6.29771e-19 J`, `29.07 s`) and
  FDM GPU `nativecuda` (`6.29771e-19 J`, `1.45 s`) match MuMax3 (`6.29602e-19 J`, `2.38 s`) to
  within **`0.03%`** on $E_{\mathrm{total}}$ and $\sim 10^{-6}$ on $\langle m_x \rangle, \langle m_y \rangle$
  (see the full four-lane table on {doc}`fem-fdm-comparison`).

### Current SP4 status

Relaxed S-state and reversal-run artifacts exist for FEM CPU and FEM GPU (coarse/baseline), and
FDM S-state relaxation matches MuMax3 to $0.03\%$ in total energy. However, the FEM time-domain
`qualification` record currently reports `not_evaluated` / `unvalidated` for adaptive RK reversal
runs: artifact creation alone is not validation, and the full NIST/convergence/CPU-GPU/no-fallback
gate (`just verify-fem-standard-problem-4`) has not yet been closed. SP4 acceptance requires, per
lane: NIST trajectory agreement, three-mesh and two-airbox convergence, CPU/GPU parity within
documented tolerances, and zero silent fallback.

## µMAG Standard Problem 5 (SP5) — bounded FDM qualification

SP5 (Najafi et al., 2009) models current-driven vortex dynamics under Zhang–Li spin-transfer torque
in a $100 \times 100 \times 10\;\mathrm{nm}$ Permalloy plate ($32 \times 32 \times 4$ cells of
$3.125 \times 3.125 \times 2.5\;\mathrm{nm}$, $M_s = 800\;\mathrm{kA\,m^{-1}}$,
$A_{\mathrm{ex}} = 13\;\mathrm{pJ\,m^{-1}}$, $\alpha = 0.1$,
$\gamma_0 = 2.211 \times 10^5\;\mathrm{m\,A^{-1}\,s^{-1}}$). After relaxing a vortex
(`circulation = 1`, `core_polarity = 1`), a uniform current density
$\mathbf{J}_c = (10^{12}, 0, 0)\;\mathrm{A\,m^{-2}}$ with $P = 1.0$, $\xi = \beta = 0.05$, and
$g = 2.0$ drives the magnetization for $1\;\mathrm{ns}$ using the source-compatible central stencil
(`formula_version="zhang_li.mumax3.v1"`, `operator_version="zl_mumax3_central_v1"` in
[`examples/mumax_standard_problem_5_fdm.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/examples/mumax_standard_problem_5_fdm.py)).

### Bounded `converged_demag` qualification results (FDM CPU & CUDA FP64)

FullMag evaluates the analytic Newell demagnetizing tensor, whereas MuMax3 evaluates numerical
quadrature controlled by `DemagAccuracy`. Full-field diagnostics on a common state confirm that the
demagnetizing-field relative RMS against MuMax3 decreases monotonically from $1.1728 \times 10^{-3}$
(`DemagAccuracy = 6`), through $4.9233 \times 10^{-4}$ (`12`), to $2.2833 \times 10^{-4}$ (`24`).
Using the explicit MuMax3 `DemagAccuracy = 24` full-field reference (`converged_demag`) validated by
[`scripts/validate_fdm_sp5_runtime.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/validate_fdm_sp5_runtime.py#L129):

| Fixed timestep $\Delta t$ [$\mathrm{s}$] | FullMag CPU vs MuMax3 (`DemagAccuracy = 24`) full-field RMS | Max component error (gate $\le 10^{-4}$) | CPU–CUDA max component diff | Schedule & provenance |
|---:|---:|---:|---:|---|
| $1.0 \times 10^{-13}$ | $9.7093 \times 10^{-6}$ | $4.3982 \times 10^{-5}$ (**PASS**) | $6.9389 \times 10^{-16}$ (vector RMS $1.14 \times 10^{-16}$) | Identical `10 000` dynamic steps (`12 458` total), `FP64`, `lossy_fallback_used = false` |
| $5.0 \times 10^{-14}$ | $9.7045 \times 10^{-6}$ | $4.3967 \times 10^{-5}$ (**PASS**) | $7.4940 \times 10^{-16}$ | Exact fixed-step schedule parity, `FP64`, zero fallback |

### Explicit SP5 scope boundaries (what remains open)

- **Literal MuMax3 default-accuracy golden (`DemagAccuracy = 6`):** Reported separately as a known
  failure (`max_component = 2.28e-4 > 1e-4`) isolated to MuMax3's default quadrature approximation
  relative to the analytic Newell tensor; FullMag never degrades its Newell kernel to match default
  quadrature.
- **Additional integrators and precisions:** Fixed-step FDM CPU `abm3`
  (`time_integrator.abm3.fixed.v1`) is `reference_executable` with source-level third-order and
  bitwise-checkpoint coverage, but has no managed SP5 qualification receipt. Adaptive RK45, `FP32`,
  general grids, and the canonical `zhang_li.fullmag.v1` family remain unvalidated.
- **FEM SP5 counterpart:** [`examples/mumax_standard_problem_5_fem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/examples/mumax_standard_problem_5_fem.py)
  uses the separate `zhang_li.fullmag.v1` / `zl_central_reference_v1` operator. Full $1\;\mathrm{ns}$
  CPU trajectories and $1\;\mathrm{ps}$ GPU smokes execute as diagnostics, and exact affine-$P_1$
  volume restriction
  ([`build_tet4_cartesian_restriction`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/analysis/fem_cartesian_restriction.py#L603))
  is implemented; however, three-level FEM $h$-refinement ($h_{\max} = 6\;\mathrm{nm}$ torque stop),
  controlled $\Delta t$ sweeps, and FEM qualification remain open.

## COMSOL-aligned nonzero-$k$ spin-wave dispersion harness

FullMag maintains an executable FEM modal-dispersion benchmark harness under
[`tests/standard_problems/mumag/comsol_nonzero_k_dispersion/`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py)
(`benchmark_id = "comsol-py-antidot-square-v1"`) targeting a square Permalloy magnonic crystal
antidot lattice:

- **Geometry and materials:** Lattice period $a = 200\;\mathrm{nm}$, film thickness
  $d = 10\;\mathrm{nm}$, circular antidot hole radius $r = 50\;\mathrm{nm}$ (case `a1`),
  $2.0\;\mu\mathrm{m}$ top/bottom Dirichlet airbox padding on each side, $M_s = 800\;\mathrm{kA\,m^{-1}}$,
  $A_{\mathrm{ex}} = 13\;\mathrm{pJ\,m^{-1}}$, $\gamma_0 = 2.211 \times 10^5\;\mathrm{m\,A^{-1}\,s^{-1}}$,
  static bias $\mu_0 \mathbf{H}_0 = (0.1, 0, 0)\;\mathrm{T}$, relaxation $\alpha = 0.5$, eigen
  $\alpha = 0$ (`damping_policy="ignore"`).
- **Controls and path:** Three controls selectable via `FULLMAG_COMSOL_DISPERSION_CASE`:
  - `c0` — uniform full film at $\Gamma$ (exchange + Zeeman only; analytic reference $2.800\;\mathrm{GHz}$);
  - `c1` — uniform full film with finite Dirichlet Floquet airbox ($\Gamma$ reference $9.299\;\mathrm{GHz}$,
    plus auxiliary $k = 10^7\;\mathrm{rad\,m^{-1}}$ Kalinikos–Slavin backward-volume and
    Damon–Eshbach slab controls);
  - `a1` — square antidot lattice along $\Gamma \to X \to M \to \Gamma$ ($61$ $k$-samples, $20$
    intervals per segment, targeting $8$ positive physical bands inside $[1\;\mathrm{MHz}, 30\;\mathrm{GHz}]$
    with external comparison target $\varepsilon_{\max} = 0.005$).
- **Gate status (`proposed_not_executed` / `NOT VERIFIED`):** Authoring, `ProblemIR` lowering,
  Bloch phase convention ($\exp(-i\mathbf{k}\cdot\Delta\mathbf{r})$), mesh-contract, and parameter
  consistency tests pass in
  [`test_contract.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/comsol_nonzero_k_dispersion/test_contract.py),
  while full managed runtime execution and external COMSOL 8-band frequency validation remain open.

## Code references

- [`tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py)
- [`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py)
- [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2335) (`GeometryMeshHandle.thin_film`, [`StudyBuilder.fem_demag_solver`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6860))
- [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L694) (`PerObjectMeshRecipe`, [`SweptMeshControls`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L413))
- [`packages/fullmag-py/tests/test_mixed_element_meshing.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/tests/test_mixed_element_meshing.py)
- [`examples/mumax_standard_problem_5_fdm.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/examples/mumax_standard_problem_5_fdm.py), [`examples/mumax_standard_problem_5_fem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/examples/mumax_standard_problem_5_fem.py), and [`scripts/validate_fdm_sp5_runtime.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/scripts/validate_fdm_sp5_runtime.py#L129)
- [`tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py) and [`config.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py)

## Bibliography

- NIST µMAG Standard Problem 4 specification and reference corpus.
- Najafi, M., Krüger, B., Bohlens, S., Franchin, M., Fangohr, H., et al. “Proposal for a standard problem for micromagnetic simulations including spin-transfer torque,” *Journal of Applied Physics* **105**, 113914 (2009), [doi:10.1063/1.3126702](https://doi.org/10.1063/1.3126702).
- Abert, C. “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
