# Eigen k0 Kittel GPU Readiness Audit

**Date:** 2026-07-08  
**Scope:** current implementation and validation state for `modal_eigen` k0 Kittel, plus what is missing for the same validation on GPU.  
**Canonical package checked:** `docs/plans/active/fd_sovler_masterplan/`

## Path correction

The pasted objective named `docs/plans/active/fd_sovler_masterplan/after_corrections/`,
but that directory does not exist in this checkout. The v5 canonical package is
directly under `docs/plans/active/fd_sovler_masterplan/`, as shown by
`documentation_manifest.json` and `00_README_CANONICAL_FULL_READ.md`.

## Commands run

```bash
git status --short
ls -la docs/plans/active/fd_sovler_masterplan
ls -la docs/plans/active/fd_sovler_masterplan/after_corrections
rg -n "verify-fem-frequency-domain-eigen|k0-kittel|Kittel|gamma-k-path|native-contract|frequency-domain-eigen|gpu|GPU|Floquet|nonzero" justfile
just --list | rg 'frequency-domain.*eigen|frequency-domain.*gpu|fem-gpu-headless|ensure-managed-fem-runtime|rebuild-fem-runtime'
just verify-fem-frequency-domain-eigen-k0-kittel-runtime
python3 -m json.tool .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/validation/kittel_k0_pbc/summary.v1.json
sed -n '1,12p' .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/validation/kittel_k0_pbc/points.v1.csv
python3 -m json.tool .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/frequency_domain/manifest.v1.json
python3 -m json.tool .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts/eigen/diagnostics/solver.v1.json
```

The first sandboxed `just verify-fem-frequency-domain-eigen-k0-kittel-runtime`
attempt failed before solver execution because Docker/buildx could not write
`/home/kkingstoun/.config/docker/buildx/activity` in the read-only sandbox.
The same command was rerun outside the sandbox and passed.

## Current status matrix

| Scope | Implemented | Runnable | Validated | Evidence |
|---|---:|---:|---:|---|
| CPU k0 Kittel K0-1 no-demag | yes | yes | yes | `just verify-fem-frequency-domain-eigen-k0-kittel-runtime` passed and emitted `validation/kittel_k0_pbc/summary.v1.json` plus `points.v1.csv`. |
| CPU k0 Kittel demag K0-3 | partial/spec only | no focused gate found | no | `15_self_weryfication_Kittel.md` keeps demag K0-3 deferred until periodic-airbox/dynamic-demag convention is stable. |
| CPU non-k0/Floquet modal | partial | yes for selected no-demag slices | partially validated | `verify-fem-frequency-domain-eigen-dispersion-*` and `verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime` exist; dynamic demag-k remains gated. |
| GPU k0 Kittel same test | no real path | no focused gate found | no | current Kittel recipe forces `FULLMAG_FEM_EXECUTION=cpu`; modal GPU capability is `unsupported`; runner GPU modal path returns unavailable. |
| GPU non-k0/Floquet modal | no production path | no focused gate found | no | capability matrix says production modal GPU remains unsupported and driven-response GPU Floquet smoke is not modal proof. |
| Driven-response GPU/Floquet | partial separate product | yes for narrow driven-response gates | partial | this is not evidence for modal eigen/Kittel. |

## Fresh CPU Kittel runtime evidence

`just verify-fem-frequency-domain-eigen-k0-kittel-runtime` passed on 2026-07-08.
The recipe uses the managed container-backed FEM runtime, runs
`examples/fem_eigen_k0_kittel_zeeman_no_demag.py`, asserts the expected modal
artifacts, then invokes:

```bash
python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py \
  --require-k0-kittel-field-sweep \
  .fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts
```

Generated Kittel summary:

```text
status: passed
model: macrospin_larmor
boundary_condition: periodic_k0
sweep_point_count: 5
max_relative_frequency_error: 1.936968179482632e-14
median_relative_frequency_error: 1.5325462518983463e-15
max_eigen_residual_relative: 1.5940707124199782e-16
solver_algorithm: slepc_multi_shift_invert_production_cpu_dense
execution_lane: production
```

Generated manifest evidence:

```text
requested_execution.device: cpu
resolved_execution.device: cpu
resolved_execution.native_backend: native_cpu
resolved_execution.solver_algorithm: slepc_multi_shift_invert_production_cpu_dense
capabilities.dispersion.production_gpu.status: unsupported
capabilities.dispersion.production_gpu.reason: native modal GPU dispersion is unavailable until a real modal GPU eigensolver and matching Floquet operator exist
```

Generated solver diagnostics:

```text
study_product: modal_eigen
execution_lane: production_cpu
solver_adapter: slepc_modal_eigen
solver_family: slepc_multi_shift_invert_production_cpu_dense
spectral_transform: shift_invert
sample_count: 5
requested_window_hz: [100000000.0, 13000000000.0]
complete: true
status: ready
window_completeness.status: not_certified
```

The CPU proof is therefore strong for the K0-1 no-demag macrospin Larmor field
sweep. It is not proof for demag K0-3, damping/complex eigenvalues, or broad
production completeness.

## Code and documentation evidence

- `justfile:339-368` defines the focused Kittel gate and explicitly sets
  `FULLMAG_FEM_EXECUTION=cpu`, `FULLMAG_RELAX_DEVICE=cpu`, then checks
  `spectrum.v2.json`, `branches.v2.json`, `dispersion.csv`, manifest, Kittel
  summary, Kittel points, and the artifact verifier.
- `examples/fem_eigen_k0_kittel_zeeman_no_demag.py:24-78` authors the CPU
  K0-1 fixture: device CPU/double, no demag, five bias-field samples, k path
  with zero vectors, and Floquet BC over `x_faces`.
- `crates/fullmag-plan/src/fem.rs:88-170` parses and validates
  `runtime_metadata.k0_kittel_validation`.
- `crates/fullmag-runner/src/eigen/artifacts.rs:2124-2200` builds
  `validation/kittel_k0_pbc/points.v1.csv` and `summary.v1.json`.
- `crates/fullmag-runner/src/eigen/artifacts.rs:2216-2364` writes the modal
  manifest and then writes the Kittel auxiliary artifacts.
- `scripts/verify_fem_frequency_domain_eigen_artifacts.py:2314-2443` verifies
  Kittel metadata, zero k vectors, increasing branch frequency, tolerance, and
  summary artifacts.
- `docs/specs/capability-matrix-v0.md:111` states modal k-path dispersion is
  reference CPU plus partial production CPU, while production GPU remains
  unsupported.
- `docs/specs/capability-matrix-v0.md:112-113` covers driven response GPU
  slices only; it explicitly does not promote modal eigensolve.
- `docs/plans/active/fd_sovler_masterplan/06_solver_tree_planner_and_lanes.md:17-35`
  distinguishes `gpu_operator_host_krylov` from `gpu_device_krylov` and warns
  that `PRODUCTION_GPU` maps to `gpu_operator_host_krylov` unless true device
  residency is proven.
- `docs/plans/active/fd_sovler_masterplan/08_backend_algorithms_and_status.md:117-134`
  says the runtime device FGMRES loop is not implemented.
- `crates/fullmag-runner/src/fem/eigen_path.rs:31-34` dispatches `NativeGpu`
  modal eigen requests to `execute_gpu_fem_eigen`.
- `crates/fullmag-runner/src/fem_eigen.rs:272-281` documents the older GPU
  dense eigensolver idea as transitional and non-fallback.
- `crates/fullmag-runner/src/fem_eigen.rs:282-326` currently calls the native
  modal eigen request and then returns
  `native FEM modal_eigen production path is unavailable`.
- `crates/fullmag-plan/src/fem.rs:2648-2665` carries Kittel validation into
  the FEM eigen plan and rejects Floquet dynamic demag in the modal eigen path.
- `crates/fullmag-plan/src/fem.rs:3064-3097` gates nonzero-k Floquet dynamic
  demag for frequency response until a validated demag-k operator exists.

## What is missing for GPU Kittel

1. **Public/API selection:** the Kittel fixture and managed recipe request CPU.
   A GPU Kittel test needs a deliberate GPU variant that preserves requested
   vs resolved execution in artifacts.
2. **Planner capability:** `BackendPlanIR::FemEigen` can name a GPU backend, but
   the current modal capability matrix still marks modal GPU unsupported.
3. **Native modal GPU backend lane:** `execute_gpu_fem_eigen` does not produce a
   solved modal result today; it reports native modal eigensolve unavailable.
4. **Operator realization:** the K0-1 no-demag case needs a real GPU modal
   operator/eigensolver path for the same `Full2x2` gyrotropic contract, not a
   driven-response operator smoke.
5. **Krylov/device loop:** true GPU production must be `gpu_device_krylov`
   or an equivalent device-resident modal eigensolver. Current docs say the
   device FGMRES loop is not implemented.
6. **Artifact/provenance:** GPU Kittel artifacts must show
   `requested_execution.device=gpu`, `resolved_execution.device=gpu`,
   GPU solver family, device residency diagnostics, and no CPU fallback.
7. **Verifier/gate:** add a separate `just verify-fem-frequency-domain-eigen-k0-kittel-gpu-runtime`
   gate that requires the same Kittel summary/points plus GPU execution
   provenance. It must not reuse the driven-response GPU Floquet smoke as proof.

## Minimal next patch

Do not implement a large GPU eigensolver in one step. The next useful patch is
a GPU-readiness verifier/gate that intentionally fails until the real path
exists:

1. Add a GPU Kittel example or recipe variant that requests `study.device("gpu",
   precision="double")`.
2. Add verifier checks for GPU modal Kittel provenance:
   `requested_execution.device=gpu`, `resolved_execution.device=gpu`,
   `study_product=modal_eigen`, `solver_family` from an accepted GPU modal lane,
   and no CPU fallback.
3. Add `just verify-fem-frequency-domain-eigen-k0-kittel-gpu-runtime` with its
   own output directory, for example
   `.fullmag/reports/frequency-domain-eigen-k0-kittel-gpu-runtime`.

## Implementation update 2026-07-08

Implemented the readiness gate without claiming GPU modal eigensolve support:

1. Added `examples/fem_eigen_k0_kittel_zeeman_no_demag_gpu.py`, which requests
   `study.device("gpu", precision="double")` for the no-demag K0 Kittel sweep.
2. Added `--require-gpu-modal-k0-kittel-provenance` to
   `scripts/verify_fem_frequency_domain_eigen_artifacts.py`.
3. Added positive and negative verifier tests proving the gate accepts explicit
   GPU modal provenance and rejects CPU Kittel provenance as a GPU result.
4. Added `just verify-fem-frequency-domain-eigen-k0-kittel-gpu-runtime` as the
   managed/container-backed runtime gate.

Until that gate passes with real GPU modal artifacts, the honest status is:
CPU K0-1 Kittel is implemented, runnable, and freshly validated; GPU K0 Kittel
is not implemented as a real modal solve and is not validated.

## Implementation update 2026-07-08: GPU K0 slice closed

The managed GPU K0 Kittel gate now passes with real GPU modal artifacts:

```bash
/usr/bin/time -p just verify-fem-frequency-domain-eigen-k0-kittel-gpu-runtime
```

Fresh no-rebuild result:

```text
real: 3.35 s
solver_algorithm: gpu_dense_k0_macrospin_modal_eigen
resolved_execution.device: gpu
resolved_execution.native_backend: native_gpu
resolved_execution.reference_or_production: production
resolved_execution.device_residency: gpu_device_resident
validation/kittel_k0_pbc/summary.v1.json.status: passed
max_relative_frequency_error: 4.193216828110753e-14
max_eigen_residual_relative: 2.43862882710822e-16
```

The first passing GPU gate after the runtime fix took `real: 509.90 s` because
it rebuilt the managed FEM runtime bundle; that is not the steady gate time.

The matching CPU gate was rerun after the same runtime rebuild:

```bash
/usr/bin/time -p just verify-fem-frequency-domain-eigen-k0-kittel-runtime
```

Fresh CPU comparison point:

```text
real: 3.80 s
solver_algorithm: slepc_multi_shift_invert_production_cpu_dense
max_relative_frequency_error: 1.936968179482632e-14
max_eigen_residual_relative: 1.5940707124199782e-16
```

The CPU/GPU frequency comparison is numerically identical to roundoff for this
macrospin no-demag K0 case:

```text
max_abs_cpu_gpu_frequency_delta_hz: 3.814697265625e-05
max_relative_cpu_gpu_frequency_delta: 2.256248648628077e-14
```

This closes only the K0 no-demag macrospin/Kittel GPU modal slice. It does not
implement nonzero-k Floquet GPU modal dispersion, dynamic demag-k, Kittel-demag,
or a broad sparse/matrix-free GPU modal eigensolver. Those remain gated in the
capability matrix.
