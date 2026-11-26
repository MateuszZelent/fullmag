---
title: Qualification Status
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: "Frozen-spins qualification contract and evidence gates"
---

(public-docs-validation-qualification-status)=
# Qualification Status

Qualification in FullMag is per workload, per execution lane, and strictly evidence-backed. One
validated feature or one targeted A/B verification campaign never promotes an unrelated workload,
precision mode, or backend lane.

## Qualification governance

FullMag enforces a fail-closed qualification policy across all four execution lanes (`FDM CPU`,
`FDM GPU`, `FEM CPU`, `FEM GPU`):

- **Source presence, compilation, skipped tests, and superseded historical snapshots never promote
  a lane.** In particular, the superseded July 2026 relaxation snapshot is retired and is not valid
  evidence for current production promotion.
- **Universal matrix gates vs per-feature A/B verification:** The universal four-lane relaxation
  production matrix gate (`FM-RELAX-017`, covering 16 legal cells across
  `FDM/FEM × CPU/GPU × FP64/FP32 × algorithm` plus 4 explicit `not_applicable` TPI cells) remains
  `BLOCKED` pending clean-tree, source-bound, independent-oracle receipts across all 16 cells.
  Targeted November 2026 A/B parity and performance verifications (PRs `#539`, `#558`, `#561`,
  `#562`, `#564`, `#567`, `#577`, `#578`) qualify only their explicitly tested workloads and device
  contracts as summarized below.
- **No silent fallback:** Unsupported heterogeneous CUDA payloads, unsupported adaptive/tableau
  combinations, over-budget forced `cuDSS` requests, and unavailable explicit GPU requests fail
  closed at capability or preflight checks rather than substituting CPU execution, Heun, another
  minimizer, or a looser physical model.

Status labels used in the matrix below:

| Label | Meaning |
|---|---|
| `validated` / `qualified` | Executed runtime/device gate plus recorded source-bound receipt passed acceptance tolerances for the named workload |
| `production_executable` | Executable on the intended production lane (separate from broader scientific `validated` status) |
| `partial_production_executable` | Executable and verified only for the explicitly bounded production workload tuple |
| `reference_executable` | Executable on the reference lane used for correctness oracles and comparison |
| `development_executable` | Executable in development/explicitly scoped modes; pending universal clean-tree matrix receipts |
| `implemented` / `source_visible` | Source, planner, or contract tests exist; managed end-to-end runtime qualification remains open |
| `semantic_only` / `unsupported` | Canonical schema only or explicitly rejected fail-closed |

## Four-lane qualification matrix

Synchronized against the repository capability register and November 2026 executed device
verifications (RTX 4080 SUPER SM 8.9 and RTX 5050, `FP64` unless stated). See
{ref}`numerical-methods-performance` and {doc}`cpu-gpu-parity` for full measured numbers.

### Relaxation and time integration

| Capability / workload | FDM CPU | FDM GPU | FEM CPU | FEM GPU | Qualification boundary & Nov 2026 evidence |
|---|---|---|---|---|---|
| `llg_overdamped` relaxation | `reference_executable` | `development_executable` | `development_executable` | `development_executable` | Universal 16-cell `FM-RELAX-017` gate `BLOCKED` pending clean-tree receipts; see {doc}`../numerical-methods/relaxation/index` |
| `projected_gradient_bb` relaxation | `reference_executable` | `development_executable` | `development_executable` | `development_executable` | **Nov 2026 A/B PASS:** PR #561 single-layer `native_cuda_pgbb` strict receipt (`0` hot-loop transfers, `5.84×–9.65×`); PR #578 GPU `bb_exchange_mass` default (`6.18×–10.52×` fewer steps, `2.82×–6.11×`, parity $\le 9\times 10^{-12}$); PR #577 `pure_prism_p2` film relaxation (`-0.43%` vs FDM). Universal `FM-RELAX-017` matrix still open |
| `nonlinear_cg` relaxation | `reference_executable` | `development_executable` | `development_executable` | `development_executable` | Same `FM-RELAX-017` clean-tree release gate; FEM demag requires `rtol <= 1e-12` |
| `tangent_plane_implicit` relaxation | `unsupported` | `unsupported` | `development_executable` (`extended` only) | `unsupported` | Fail-closed in `strict` mode and on GPU/FDM |
| Single-grid LLG precision policies (`full_double` & `single_storage_fp64_reduction`) | `implemented` | `physics_validated` (exact workloads) | `implemented` | `implemented` | Source-bound CUDA single-grid receipt (Heun/RK4/RK23/DP45/ABM3 + Newell thin-film/periodic oracles) + **PR #561** D2Z/Z2D & R2C/C2R cuFFT A/B (`34` cases, FP64 rel. $\Delta E \le 2.63\times 10^{-14}$). FP32 PBC, boundary-correction, thermal, heterogeneous, and multilayer fail closed |
| Fixed-step `abm3` (`time_integrator.abm3.fixed.v1`) | `reference_executable` | `unsupported` | `source_visible` | `unsupported` | Single-grid CPU FP64 with exact checkpoint/resume; adaptive ABM3 and GPU fail closed |
| FEM GPU core demag (`Poisson` / `FEM-BEM` / `PBC`) & explicit RK FSAL/predictor | `unsupported` | `unsupported` | `production_executable` (reference oracles) | `production_executable` (Nov 2026 A/B PASS) | **PR #550 / #564:** `gpu_strategy` (`"auto"`, `"cg_amg"`, `"cudss"`), `19.1×–218.4×` open Poisson, `26.8×–35.5×` PBC 1D/2D, `34.6×` GPU FEM/BEM (`4.88e-14` vs CPU), fail-closed VRAM cap. **PR #578 Track 2:** short-range GPU kernels `1.80×` E2E RK4 (`< 2e-15` parity) |
| FEM `pure_prism_p2` & unified CSR GPU DMI | `unsupported` | `unsupported` | `implemented` (CPU MFEM ref) | `implemented` (Nov 2026 A/B PASS) | **PR #577:** `pure_prism_p2` `L=2` Aharoni `-0.60%`, CPU/GPU RK4 $\le 10^{-10}$ & PGBB $\le 10^{-9}$; CSR DMI across 15 configs ($h_{\mathrm{rel}} \le 1.12\times 10^{-15}$, `780×–4,812×` vs CPU) |
| FDM periodic demag (`fdm_periodic_demag_boundary_semantics`) | `reference_executable` | `production_executable` | `unsupported` | `unsupported` | Truncated-images realization on CPU/CUDA; periodic local exchange/DMI with `demag="open"` fails closed |
| FDM multilayer fixed-step explicit RK | `reference_executable` | `implemented` | `unsupported` | `unsupported` | Bounded D-07 CUDA FP64 Heun slice has source/contract coverage; managed source-bound CUDA parity receipt pending |

### Spin torques, transport, and Oersted fields

| Capability / workload | FDM CPU | FDM GPU | FEM CPU | FEM GPU | Qualification boundary & Nov 2026 evidence |
|---|---|---|---|---|---|
| `zhang_li.mumax3.v1` (bounded SP5 `converged_demag`) | `reference_executable` (`validated` SP5 fixed-step) | `production_executable` (`validated` SP5 fixed-step) | `unsupported` | `unsupported` | Qualified only for FP64 fixed-step SP5 vs MuMax3 `DemagAccuracy = 24` ($\le 4.4\times 10^{-5}$, CPU–CUDA $\le 7.5\times 10^{-16}$; see {doc}`mumag-standard-problems`). Adaptive, FP32, and `zhang_li.fullmag.v1` remain open |
| `SlonczewskiSTT` (`slonczewski.fullmag.v2` thin-layer homogenized) | `reference_executable` | `production_executable` | `reference_executable` | `reference_executable` | Managed 1-step & 8-step CPU/GPU contracts + **PR #562** bit-identical CUDA fused RK45 STT (`0` separate RHS launches); `interface_flux` remains `semantic_only` |
| `PrescribedSpinOrbitTorque` (`fullmag.v1`) | `reference_executable` | `production_executable` | `reference_executable` | `reference_executable` | **PR #562** bit-identical CUDA fused RK45 SOT (`0` separate RHS launches); never substitutes for direct/inverse SHE |
| M1 Ohmic charge transport (`fdm_gpu_bounded_m1.v1` & FEM Wave 2) | `semantic_only` | `partial_production_executable` | `reference_executable` (Wave 2 MUMPS/HYPRE) | `implemented` (`cuda_cudss_spd` A/B PASS) | **PR #561:** FDM GPU AMG-PCG (`<= 4.32e-14`, `1.46×–7.48×`) & `cuDSS` (`<= 4.12e-13`, `1.36×–8.53×`). **PR #567:** FEM 8-terminal charge `5.82×–8.02×` (`<= 2.04e-12`). General multi-component/convergence remains open |
| M1 steady spin drift-diffusion & direct SHE | `reference_executable` | `implemented` (PR #562 A/B PASS) | `reference_executable` | `implemented` (`cuda_cudss_lu` A/B PASS) | **PR #562:** bit-identical FDM CUDA M1 (`46×` small / `1.8×` medium). **PR #567:** FEM stiff M1/M2 `cuda_cudss_lu` (`4.25×–5.50×`, `<= 4.99e-15` vs MUMPS). General production qualification remains open |
| M2 reciprocal iSHE & AMR/PHE/AHE | `reference_executable` (bounded manufactured) | `semantic_only` | `reference_executable` (`fem_bounded_m2.v1`) | `implemented` (`cuda_cudss_lu` A/B PASS) | Onsager sweeps, heterogeneous/interface nonlinear coupling, and cross-backend parity remain open |
| M3 transient spin drift-diffusion (`coupled_imex_ark2.v1`) | `reference_executable` (`validated` M3 ref) | `semantic_only` | `semantic_only` | `semantic_only` | `just verify-fdm-transient-spin-m3-reference` on single-grid FP64 CPU |
| Oersted fields (legacy cylinder/midpoint & canonical OE-F1 / OE-F2 / OE-T0) | `reference_executable` (legacy) | `production_executable` (legacy) | `production_executable` (legacy) / `semantic_only` (canonical OE-F1/F2) | `production_executable` (legacy) / `semantic_only` (canonical OE-F1/F2) | **PR #567** native Wave 2 A/B PASS: OE-F2 sparse MUMPS/HYPRE (`68×–105×`, up to `68 921` DOFs), OE-F1 CPU `13.53×` 0-ULP & `GpuHybridFarField` `18.93×` (`5.59e-17`), OE-T0 2-rank MPI bit-exact. Normal-runtime canonical stage admission remains open |

### Spectral, frequency-domain, and specialized capabilities

| Capability / workload | FDM CPU | FDM GPU | FEM CPU | FEM GPU | Qualification boundary & Nov 2026 evidence |
|---|---|---|---|---|---|
| FEM driven frequency response (`StudyIR::FrequencyResponse`) | `semantic_only` | `semantic_only` | `partial_production_executable` | `partial_production_executable` | **PR #578 Track 3:** GPU `cuDSS` A/B PASS (`151.3×–454×` vs CPU GMRES open-airbox, `2.89×–4.22×` vs GPU GMRES `periodic_airbox_k0`, `rel_l2 <= 5.32e-10`, `0` perturbed pivots, up to `42 907` DOFs). Nonzero-$k$ `demag-k` & Floquet DMI assembly remain open |
| FEM modal eigensolve (`StudyIR::Eigenmodes`) | `semantic_only` | `semantic_only` | `source_visible` | `source_visible` (bounded PR #539 open-airbox GPU `cuDSS`) | **PR #539:** open-airbox Robin $k=0$ GPU `cuDSS` adapter with guarded Hermitian inertia window certificate. **PR #558:** shared `CudssModalShift` memory budget + native single-$k$ GPU Floquet adapter (`augmented_floquet_cudss_cuda`, native contract only; public GPU Floquet workflow remains fail-closed) |
| FEM element-DG0 $M_s$ time evolution | `unsupported` | `unsupported` | `partial_production_executable` | `unsupported` | Validated for CPU FP64 consistent-mass exchange + optional Poisson demag/Zeeman; GPU and direct relaxation fail closed |
| FEM live preview energy density | `unsupported` | `unsupported` | `partial_production_executable` | `partial_production_executable` | Bounded observation semantics only (CPU DG0 + GPU uniform-$M_s$ anisotropy/DMI) |
| Mixed-P1 swept prism / pyramid–tet topology | `unsupported` | `unsupported` | `implemented` | `implemented` | **PR #577:** `layers=2` Chebyshev untangler (`same_side 6 → 0`); managed public-runtime promotion remains separate |
| `RegionalFieldDrive` / `absorbing_boundary` damping layer | `reference_executable` | `unsupported` | `source_visible` / `implemented` | `unsupported` / `implemented` | Heterogeneous cellwise FDM CUDA fields fail closed without CPU fallback |
| `antenna_source_k_spectrum` | `semantic_only` | `semantic_only` | `reference_executable` | `semantic_only` | Full-wave FIT surface gap-port remains research-only CPU script ({doc}`analytical-cases`) |
| `frozen_spins.v1` | `RUNTIME_CONFIRMED` / `UNQUALIFIED` | `RUNTIME_CONFIRMED` / `UNQUALIFIED` | `RUNTIME_CONFIRMED` / `UNQUALIFIED` | `RUNTIME_CONFIRMED` / `UNQUALIFIED` | Tracked by dedicated lane-agnostic `frozen_spins.v1` gate below; clean-tree release receipt pending |

## Frozen-spins qualification

`frozen_spins` constraints are implemented via the typed `FrozenSpins` contract in API and planner
inputs and governed by the `frozen_spins.v1` qualification scope (`scope_revision: 1`,
`product_version: frozen_spins.v1`). Across FDM CPU (single-grid and multilayer), FDM CUDA
(FP64/FP32 single-grid), FEM CPU, FEM GPU, API v2, and Control Room WebGL preview/solver parity,
implementation status is `RUNTIME_CONFIRMED` with passing isolated receipts, while release
`qualification_status` remains `UNQUALIFIED` until a unified clean-tree release receipt closes the
full matrix (CUDA multilayer v2 remains explicitly fail-closed).

Feature coverage is verified through dedicated commands (`just verify-frozen-spins-qualification`
and lane companions) rather than by inference from relaxation or dynamics tables, covering:

- selector and membership behavior (`static` vs `snapshot_at_activation`);
- reference mode semantics (`capture_current_at_activation`, `initial_state`, `explicit_field_asset`);
- empty and inactive selection policy (`error`, `warn_and_intersect`);
- stage activation epochs, checkpoint resume portability without recapture, and visualization
  support.

### Frozen-spins authoring and contract details

`FrozenSpins` is a typed stage-aware constraint contract validated before planning; unsupported
combinations fail closed:

- [`class FrozenSpins`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/constraints.py#L137)
  validates `id`, `selector`, `name`, `enabled`, `reference`, `membership`, `activation`,
  `stage_ids`, `empty_selection`, and `inactive_selection`.
- [`ObjectRegion.freeze_spins`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L593)
  builds `FrozenSpins` via `in_region_selection(...)`.
- [`Ferromagnet.freeze_spins`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L877)
  builds `FrozenSpins` via `in_object_selection(...)`.

```python
import fullmag as fm
from fullmag.model.constraints import FrozenSpins
from fullmag.model.selection import in_region_selection

nm = 1.0e-9
study = fm.study("frozen_constructor_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_run(stage_id="run", until=1.0e-12)

# Direct constructor (public source class contract)
frozen = FrozenSpins(
    id="film_frozen",
    selector=in_region_selection("film", "all"),
    reference="capture_current_at_activation",
    membership=None,
    empty_selection="error",
    inactive_selection="warn_and_intersect",
)
```

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("frozen_region_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
film = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
film_region = film.add_region("core", fm.Box(20 * nm, 20 * nm, 4 * nm))
frozen_region = film_region.freeze_spins(
    id="film_frozen_region",
    reference="capture_current_at_activation",
    membership="snapshot_at_activation",
    stage_ids=("run",),
)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

| Function | Arguments and meanings |
|---|---|
| `FrozenSpins.__init__(*, id, selector, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | `frozen_spins` contract; selection and stage activation are normalized through `_reference_ir(...)` and `_activation_ir(...)`. |
| `ObjectRegion.freeze_spins(*, id=None, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Region-scoped freeze helper; `id` defaults to `<region_id>_frozen`, selector is `in_region_selection`. |
| `Ferromagnet.freeze_spins(*, id, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Object-scoped freeze helper; requires explicit `object_id`, selector is `in_object_selection`. |
| `TimeEvolution.constraints` | Sequence of `FrozenSpins` objects transported from study stages into the lowered problem contract. |

### Code references

- [`packages/fullmag-py/src/fullmag/model/constraints.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/constraints.py#L137) (`class FrozenSpins`, [`__init__`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/constraints.py#L148))
- [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L593) (`ObjectRegion.freeze_spins`)
- [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L877) (`Ferromagnet.freeze_spins`)
- [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) (`class Problem` aggregate and constraint lowering)
- [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L761) (`class TimeEvolution` transport and constraints handling)

## Per-interaction support matrices

Physics and numerical terminal pages own their detailed four-lane FDM/FEM CPU/GPU support and
qualification matrices:

- {doc}`../physics/interactions/index` — canonical interaction pages;
- {doc}`../numerical-methods/index` — method and solver-lane realizations;
- {ref}`numerical-methods-performance` — hardware A/B performance and optimization references.

## Not yet qualified

- Universal 16-cell four-lane relaxation production matrix (`FM-RELAX-017` clean-tree release receipts).
- Time-domain NIST µMAG SP4 reversal (`not_evaluated` / `unvalidated`) and FEM SP5 convergence sweep.
- COMSOL nonzero-$k$ spin-wave dispersion runtime execution and multi-$k$ GPU Floquet workflow qualification.
- Full-matrix `box500` managed FEM GPU strict-residency rerun and automated cross-backend FDM $\leftrightarrow$ FEM differential suite.
- Unified clean-tree release receipt for `frozen_spins.v1`.
- Promotion of research-only full-wave FIT surface gap-port excitation into canonical `ProblemIR`.

These items remain explicitly open until their dedicated managed gates pass with source- and
device-bound artifacts.

## Bibliography

- Abert, C. “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
