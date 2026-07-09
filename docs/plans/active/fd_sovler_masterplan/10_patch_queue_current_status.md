---
title: Frequency-driven solver - patch queue current status
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Patch queue current status after full read

This file replaces the older mixed patch queue language.

## Patch A - docs-only alignment

Status:

```text
Superseded by this v5 full-read documentation package.
```

## Patch B - lane diagnostics and progress throttling

Reported status:

```text
Implemented at native contract level.
Diagnostics publish Krylov host location and GPU operator/preconditioner provenance.
Progress interval default throttling is pinned in planner tests.
```

## Patch C - planner descriptors

Reported status:

```text
Implemented as header/descriptor skeleton and conservative planner gates.
Defaults are conservative: no Schur certificate and no device Krylov by default.
The planner now rejects relaxed-texture frequency-domain selection when an
accepted LinearizationState is required but unavailable, using the exact
rejection reason equilibrium_artifact_missing.
Verified by just verify-fem-frequency-domain-native-contract on 2026-07-07.
```

Related P0 relaxed-texture evidence:

```text
The LinearizationState builder reports exact v5 reject reasons for:
- equilibrium_artifact_not_accepted_for_linearization
- equilibrium_mesh_hash_mismatch
- equilibrium_material_hash_mismatch
- equilibrium_physics_hash_mismatch
- equilibrium_static_demag_required_but_missing
- equilibrium_torque_residual_too_large
The native contract gate also checks expected mesh/material/physics snapshot
matching against the requested frequency-domain problem.
Verified by just verify-fem-frequency-domain-native-contract on 2026-07-07.
```

Related P0 mesh/periodic evidence:

```text
The mesh symmetry certificate now reports accepted matched magnetic/airbox
pair maps, rejects duplicate periodic node pairs, records schema marker
periodic_mesh_certificate.v5, records stable order-independent fnv1a64
magnetic/airbox pair-map fingerprints, and stores nonidentity tangent-frame
transfer blocks as explicit row-major G_pair = T_dst^T R T_src 2x2 matrices.
It also records canonical sha256 magnetic/airbox pair-map hashes in the mesh
symmetry certificate.
It also rejects inconsistent paired equilibrium directions with
periodic_m0_seam_mismatch, optional same-step H_demag0 seam mismatches with
periodic_static_demag_seam_mismatch, and required-but-unspecified Poisson gauge
policy with periodic_poisson_gauge_policy_missing.
The full pair-map, G_pair, seam/gauge, fingerprint, and sha256 hash
certificate slice was
verified by just verify-fem-frequency-domain-native-contract after a managed
runtime rebuild on 2026-07-07.

Runtime artifact propagation has started. The Rust FEM frequency-response
runner now writes a `periodic_mesh_certificate.v5` preflight candidate section
into `response/diagnostics/input_preflight.v1.json`, including canonical
`sha256:` magnetic and airbox pair-map hashes for the actual solver-lane
periodic pairs.

The Python runtime artifact verifier now also checks certificate propagation
consistency for periodic-airbox solved bundles. It requires
`response/diagnostics/solver.v1.json` and
`frequency_domain/manifest.v1.json` to carry matching
`input_preflight.periodic_mesh_certificate` schema, role, canonicalization,
pair counts, tangent-frame-transfer status, and magnetic/airbox
`sha256:` pair-map hashes. A focused RED/GREEN test corrupts
`manifest.diagnostics.input_preflight.periodic_mesh_certificate.magnetic_pair_map_sha256`
and verifies the bundle is rejected.

Follow-up after managed runtime rebuild: frequency-point demag contribution
artifacts now receive the same `input_preflight.periodic_mesh_certificate`
snapshot. The verifier checks
`response/frequency_points/frequency_XXXX.json.demag_contribution.input_preflight`
against solver diagnostics and rejects mismatched magnetic or airbox pair-map
hashes. The refreshed
`just run-fem-periodic-antidot-frequency-driven-managed-headless` target passed
with:

```text
response status: ready
response complete: true
total_iteration_count: 2006
relative_residual_l2_norm: 0.0009994399206910052
residual_consistency_status: ok
completed_frequency_points: 1
written_frequency_point_artifacts: 1
frequency_0000 demag_contribution certificate hashes: match solver diagnostics
```

The Rust input-preflight candidate now also derives deterministic
tangent-frame transfer-block provenance for compact magnetic periodic pairs.
When unit `m0` tangent frames can be built, the candidate certificate includes
`tangent_frame_transfer_block_count` and
`tangent_frame_transfer_blocks_row_major_2x2_sha256`. This remains a pending
candidate certificate, not accepted native G_pair consumption.

The verifier also now rejects internally invalid certificate snapshots even
when all copies agree. Solved periodic-airbox bundles must report positive
magnetic and airbox pair counts, canonical `periodic_mesh_certificate.v5`
schema/canonicalization/hash tokens, boolean
`tangent_frame_transfer_required`, and a known
`tangent_frame_transfer_artifact_status`. Focused tests cover a zero magnetic
pair count and an unknown transfer status.

The verifier also exposes a stricter promotion flag:
`--require-accepted-periodic-mesh-certificate`. When enabled, periodic-airbox
solved or bounded solve-error bundles must report
`tangent_frame_transfer_artifact_status=accepted_native_certificate_consumed`.
They must also report `tangent_frame_transfer_block_count == magnetic_pair_count`
and a canonical `tangent_frame_transfer_blocks_row_major_2x2_sha256` token, so
the accepted status is tied to transfer-block evidence rather than only a status
string. The default verifier still accepts
`pending_native_certificate_consumption` for the current compatibility path; the
stricter flag is reserved for the native runtime path that actually consumes
the accepted periodic/G_pair certificate.

This is still not accepted-certificate coverage for the full solver. Runtime
solver lanes still need to consume G_pair consistently and propagate the
accepted certificate hashes into every relevant periodic/Floquet artifact before
large periodic-airbox production workloads can be called covered.

Native modal-eigen follow-up from 2026-07-08: the PA-E2 Poisson-airbox
modal-eigen descriptor and public modal-eigen C ABI tail now carry the
`periodic_mesh_certificate.v5` schema plus magnetic and airbox pair counts.
The SLEPc PA-E2 contract rejects missing certificate metadata with
`poisson_airbox_eigen_requires_periodic_mesh_certificate` and emits the
certificate summary in solver diagnostics. Verified gates:
`just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`,
`just verify-fem-frequency-domain-native-contract`, focused
`fullmag-fem-sys` ABI layout test, and focused `fullmag-runner`
native-Poisson-airbox tests. This remains metadata/certificate consumption
plumbing, not full real-mesh Poisson-airbox assembly.

Additional PA-E2 guard from 2026-07-08: the SLEPc full-coupled descriptor now
rejects `periodic_airbox_k0` when the demag coupling blocks are decoupled.
`A_qphi` and `A_phiq` must each carry at least one nonzero CSR entry; otherwise
native validation returns `poisson_airbox_eigen_requires_full_coupled_blocks`.
The managed PA-E2 gate covers this with an explicit zero-coupling negative
test. This closes a false-positive claim path where a no-demag descriptor could
otherwise pass with periodic-airbox metadata.

Runner PA-E4b seam from 2026-07-08: `native_cpu_modal_window_enabled` now
admits K0-3 `demag_kind=periodic_airbox_k0` validation requests only when the
runner can construct a structured Poisson-airbox payload. A first
macrocell/Kittel payload builder constructs CSR `A_qq`, `A_qphi`, `A_phiq`,
`A_phiphi`, and `B_qq` blocks, requires nonzero demag coupling blocks, and
attaches `poisson_airbox_block_problem` to `NativeModalEigenRequest`. Ordinary
gamma and Bloch/Floquet native modal-window tests remain accepted. The builder
now derives magnetic and airbox periodic pair counts from mesh element markers
and periodic node pairs and rejects K0-3 requests with missing real pair maps
instead of substituting synthetic `1/1` counts. It also requires positive
`air_box_config.factor` and positive mesh extent before routing to the native
Poisson-airbox adapter. Payload dimensions now scale with the real pair-map
counts (`q=2*magnetic_pairs`, `phi=2*airbox_pairs`) instead of staying fixed at
the toy `2/2` size, and `A_phiphi` uses airbox periodic-pair length weights
instead of unit topology-only weights. `B_qq` now uses lumped magnetic element
volumes instead of unit diagonal masses. `A_qphi/A_phiq` now use a
mesh-derived coupling scale from magnetic pair lumped mass divided by the
associated airbox periodic-pair length, so demag coupling changes when the
underlying mesh geometry changes instead of staying at constant
`demag_delta`/unit source entries. `phi_mean_weights` now also come from
airbox periodic-pair geometry instead of a uniform vector: each pair length is
normalized and split across the pair's two phi DOFs for the mean-zero augmented
gauge. Native PA-E1/PA-E2 validators now require those gauge weights to be
finite, strictly positive, and normalized to sum to one before solving, with
`poisson_airbox_eigen_requires_mean_zero_gauge` diagnostics for invalid input.
The PA-E3 Schur fixture now carries the same `periodic_mesh_certificate.v5`
pair-count metadata consumed by PA-E2. PA-E3 Schur certification now also
rejects invalid `phi_mean_weights` before constructing Schur certificate keys,
using the Schur-specific `poisson_airbox_schur_requires_mean_zero_gauge`
reason. This is a wired block validation payload, not the final shared-domain
MFEM Poisson-airbox assembler.
```

Follow-up PA-E4b provenance hardening from 2026-07-09: path-level K0-3
`periodic_airbox_k0` modal diagnostics now emit
`solver_model=k0_poisson_airbox_cpu_full_coupled_slepc`,
`solver_family=k0_poisson_airbox_full_coupled`, and
`resolved_solver_family=k0_poisson_airbox_full_coupled` instead of preserving the
multi-k reference shell label `reference_full_2x2_tangent`. The single-run and
convergence artifact verifiers now reject periodic-airbox Kittel bundles that
pair the Poisson-airbox `solver_adapter` with a reference `solver_model`.
Verified by
`just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-cpu`,
`just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu`,
`just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu-gated`,
and the Python verifier suite (`396 passed`). GPU PA-G remains explicitly gated,
not implemented as a production Poisson-airbox modal runtime.

Nonzero-k modal production guard from 2026-07-09: the selected-spectrum
production CPU Floquet k-path slice now requires a labelled
`bloch_floquet_tangent_operator`, accepted periodic-pair contract metadata, a
positive Floquet periodic-pair count, `stage_id=eigenmodes`, requested
`calculation_mode=dispersion_modal`, requested `backend=fem`, requested
`device=cpu`, requested `precision=double`, requested
`solver_family=modal_eigen`, requested
`solve_equation="A q = lambda B q; lambda = i omega"`, resolved `backend=fem`,
resolved `device=cpu`, resolved `precision=double`, resolved `native_cpu`
provenance, SLEPc shift-invert solver provenance, resolved
`reference_or_production=production`, `modal_eigen` solve-kind provenance, and
no gated operator terms such as `dynamic_demag`, `demag`, DMI, periodic
Poisson, Floquet airbox, or magnetoelastic terms. The same no-demag Floquet
modal artifact path now also propagates a minimal
`periodic_mesh_certificate.v5` into solver diagnostics and manifest
diagnostics, with `certificate_status=accepted`, positive
`magnetic_pair_count`, and canonical `sha256:` `magnetic_pair_map_sha256`;
the verifier rejects missing solver certificates and manifest-vs-solver hash
drift. This is artifact-level pair-map identity propagation only, not accepted
native `G_pair` runtime consumption. The Rust dispatch
diagnostics, artifact verifier, and native modal contract now reject bundles or
payloads that try to preserve `production_cpu` shift-invert provenance while
smuggling those gated terms into `operator_terms_included`, presenting a
reference CPU bundle as native CPU production, replacing the resolved
production SLEPc algorithm with a reference solver label, or presenting a
driven-response bundle as modal eigensolve. The Rust manifest emitter also
downgrades stale `ProductionCpuShiftInvert` path results back to reference
manifest provenance when the current plan is rejected by the native CPU modal
window gate, including nonzero-k Floquet requests that still ask for demag
without a real dynamic demag-k operator. Demag-enabled nonzero-k Floquet modal
fallbacks now name that missing dynamic-demag-k operator explicitly with
`production_cpu_modal_dynamic_demag_k_operator_missing`,
`selected_spectrum_nonzero_k_floquet_modal_dynamic_demag`,
`bloch_floquet_tangent_operator_with_dynamic_demag_k`,
`required_demag_payload_kind=dynamic_demag_k_operator`, and
`dynamic_demag_operator_source=missing_numeric_fem_demag_k`; no-demag missing
Floquet-pair fallbacks retain the generic Bloch/Floquet pair contract. Normal
reference fallback manifests publish the same rejection contract as stale
production-downgrade manifests, so the manifest-level contract no longer
depends on the intermediate solver label.
The verifier also requires
reference/MVP nonzero-k Floquet frequency-window solver diagnostics and
manifests to publish the same `production_cpu_rejection_reason`,
`production_cpu_rejection_scope`, and `required_operator_contract` fields plus
`required_operator_payload_kind=bloch_floquet_tangent_operator`, the
reason-specific demag payload fields when applicable, and
`modal_periodic_pair_contract_available=false`, so downstream consumers can
distinguish the documented reference fallback from a production
selected-spectrum modal solve. It also rejects reference/MVP Floquet windows
that pair `window_completeness.status=not_certified` with a non-`none`
certification method or a no-additional-modes claim. The verifier also rejects
production modal k-path
manifests that carry driven-response artifact paths, response resource keys,
response field resources, frequency-point response paths, or
`driven_response_artifact_available=true`, and it requires
`modal_artifact_available=true`; modal eigensolve bundles must keep the
`modal_eigen` and `driven_response` product surfaces separate while explicitly
advertising the modal artifact surface. Verified locally by focused
`fullmag-runner` k-path tests and the Python eigen artifact verifier suite; the
managed native contract gate still needs a Docker-backed rerun after approval.
The sandboxed gate detected the stale managed runtime but failed while Docker
buildx tried to write its activity state under read-only `~/.config/docker`.

## Patch D - COMSOL physics gates

Reported status:

```text
Implemented slices:
- drive_kind
- require_nonzero_rhs
- dynamic-field phasor projection through -gamma*m0_cross_delta_h
- null imaginary buffers treated as zero
- zero-drive warnings for physical drive
- zero tangent RHS rejection when require_nonzero_rhs=true
- complex lift/project Cartesian/tangent
- local Cartesian 3x3 operator projection T^T A T
```

## Patch D2 - Kittel k=0 PBC eigensolve self-verification

Status:

```text
Implemented for the no-demag K0-1 managed runtime gate.
Thin-film demag K0-3 remains deferred.
```

Implemented evidence:

```text
- Python DSL can author K0KittelFieldSweepValidation.
- Typed IR and FemEigenPlanIR carry k0_kittel_validation.
- FEM eigen planner validates runtime_metadata.k0_kittel_validation.
- Modal eigen manifest can serialize validation.k0_kittel_validation.
- scripts/verify_fem_frequency_domain_eigen_artifacts.py has
  --require-k0-kittel-field-sweep and rejects wrong frequency scale.
- examples/fem_eigen_k0_kittel_zeeman_no_demag.py authors the no-demag K0-1
  validation fixture with five declared bias-field samples.
- The PathSolveResult artifact writer and the production multi-k dispatch
  artifact path both carry validation.k0_kittel_validation and emit
  validation/kittel_k0_pbc/summary.v1.json plus points.v1.csv when the branch
  data covers the declared K0 samples.
- just verify-fem-frequency-domain-eigen-k0-kittel-runtime exists and requires
  the summary/CSV artifacts plus --require-k0-kittel-field-sweep.
- The production multi-k dispatch adapter applies
  K0KittelFieldSample.bias_field as the per-sample point_plan.external_field
  for declared K0 Kittel samples. Verified locally by
  cargo test -p fullmag-runner k0_kittel --lib and
  cargo test -p fullmag-runner eigen --lib on 2026-07-07.
- The K0 Kittel branch selector now uses an unweighted uniform-subspace score
  from carried mode-shape vectors before frequency-error tie breaking. It
  prefers a uniform positive branch over a nonuniform frequency-only match.
  Verified by
  k0_kittel_selector_prefers_uniform_branch_over_frequency_only_match.
- The selector also supports per-node mass weights when
  SingleKModeResult.node_mass_weights is populated, and uses them before the
  unweighted fallback. Verified by
  k0_kittel_selector_uses_mass_weighted_uniformity_when_weights_are_available.
- The production native full_2x2 K0 path now derives per-node mass weights from
  the diagonal tangent mass matrix, serializes them in the single-k spectrum,
  and carries them into multi-k SingleKModeResult.node_mass_weights. Verified
  locally by cargo test -p fullmag-runner node_mass_weights --lib on
  2026-07-07.
- The full_2x2 native operator diagnostics now report the generalized
  field-spectrum range for the Rust dense payload. This exposed the old K0
  fixture bug where the 5 GHz upper window excluded the 0.2 T and 0.4 T
  samples; the fixture now uses a 13 GHz upper window for the 0.02-0.4 T sweep.
- The managed K0 Kittel runtime gate passed on 2026-07-08:
  just verify-fem-frequency-domain-eigen-k0-kittel-runtime executed the fixture,
  produced spectrum/branch/dispersion/manifest artifacts plus
  validation/kittel_k0_pbc/summary.v1.json and points.v1.csv, and passed
  scripts/verify_fem_frequency_domain_eigen_artifacts.py
  --require-k0-kittel-field-sweep.
```

Remaining D2 work:

```text
- deferred K0-3 thin-film demag gate after periodic-airbox conventions stabilize.
```

Latest managed-runtime evidence, 2026-07-07:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-runtime rebuilt the managed
runtime and executed examples/fem_eigen_k0_kittel_zeeman_no_demag.py. The run
produced five k=0 samples, but every dispersion row had the same frequency:
560052842.5830296 Hz. The artifact verifier correctly rejected the bundle with:
"k0 Kittel field sweep branch frequency must increase with bias field".

Root cause: the current modal k-path runtime samples k, not per-sample static
bias fields. The Python fixture declares K0KittelFieldSample bias fields for
validation, but FemEigenPlanIR/native modal execution still solve every sample
with the same plan.external_field. Do not weaken the validator; implement a
real per-sample bias-field override before promoting D2e.

Follow-up implementation after this failing run:
the multi-k dispatch adapter now overrides point_plan.external_field from
K0KittelFieldSample.bias_field for matching sample_index values. This has local
unit and runner-contract coverage. The managed runtime rerun is recorded below.
```

Latest managed-runtime evidence, 2026-07-08:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-runtime passed. The target
used the managed FEM runtime, ran examples/fem_eigen_k0_kittel_zeeman_no_demag.py,
and verified the generated artifacts with --require-k0-kittel-field-sweep. The
completed run reported eigen_lowest_frequency_hz=560052842.583033 for the
20 mT sample. Before the final green run, diagnostics showed that the previous
5 GHz fixture window excluded the higher-field samples; frequency_max is now
13 GHz.

The final validation bundle reports:
- status=passed
- model=macrospin_larmor
- boundary_condition=periodic_k0
- sweep_point_count=5
- max_relative_frequency_error=1.936968179482632e-14
- median_relative_frequency_error=1.5325462518983463e-15
- max_eigen_residual_relative=1.5940707124199782e-16
```

Canonical details are in `15_self_weryfication_Kittel.md`.

## Patch PA-E1 - dense Poisson-airbox k=0 modal eigen oracle

Status:

```text
Implemented at native contract level for the synthetic dense algebraic oracle.
This is not the real MFEM sparse/SLEPc Poisson-airbox modal eigensolver, not
Schur MatShell, and not GPU modal parity.
```

Implemented evidence:

```text
- Added internal-only native header:
  backends/fem/include/frequency_domain/dense_poisson_airbox_eigen_oracle.hpp
- Added implementation:
  backends/fem/cpu/frequency_domain/dense_poisson_airbox_eigen_oracle.cpp
- Added native contract test:
  backends/fem/tests/frequency_domain/poisson_airbox_eigen_oracle_test.cpp
- Added just gate:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
```

The oracle validates PA-E1 scope and requires:

```text
q_dof_count = 2
gauge_policy = mean_zero_augmented
phasor_convention = exp_plus_i_omega_t
eigenvalue_convention = lambda_imag_positive_frequency
alpha = 0
k = 0
synthetic_no_mesh = true
```

The native contract covers:

```text
- missing mean-zero gauge weights rejection
- pin_first_dof rejection for the production PA-E1 path
- singular Poisson block solved through mean-zero augmentation
- matrix-free Schur apply vs explicit Schur agreement
- full descriptor residual reconstruction from the reduced eigenpair
- positive-frequency branch selection with frequency_hz = imag(lambda)/(2*pi)
- synthetic demag-factor Kittel-like frequency with the correct sign
- sign-flip negative case that fails the expected demag frequency
- rejection of production demag_kind=periodic_airbox_k0 claims in PA-E1
- poisson_airbox_eigen_oracle.v1 diagnostics JSON
```

Verification, 2026-07-08:

```text
command:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle

result:
  passed

observed native target:
  cmake --build native/build --target fem_poisson_airbox_eigen_oracle_contract
  [100%] Built target fem_poisson_airbox_eigen_oracle_contract
  native/build/backends/fem/fem_poisson_airbox_eigen_oracle_contract exited 0
```

## Patch PA-E2 - CPU sparse/full-coupled SLEPc Poisson-airbox k=0 modal eigen

Status:

```text
Implemented at native contract level for the tiny sparse/full-coupled SLEPc
oracle. This is not Schur MatShell, not K0-3 FEM thin-film demag validation,
not public Python/API/IR exposure, and not GPU modal parity.
```

Implemented evidence:

```text
- Added internal-only native descriptor and result:
  backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp
- Added implementation:
  backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp
- Added native contract test:
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
- Added just gate:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
```

The PA-E2 path validates:

```text
demag_kind = periodic_airbox_k0
gauge_policy = mean_zero_augmented
phasor_convention = exp_plus_i_omega_t
eigenvalue_convention = lambda_imag_positive_frequency
solver_adapter = k0_poisson_airbox_cpu_full_coupled_slepc
k = 0
alpha = 0
real FEM block matrices
```

The native contract covers:

```text
- monolithic SeqAIJ assembly of the augmented full-coupled descriptor pencil
- mean-zero gauge rows and gauge residual
- SLEPc Krylov-Schur shift-invert solve of the tiny sparse problem
- PCLU with pivoting factorization for zero-diagonal gyrotropic/gauge blocks
- positive-frequency branch selection
- full descriptor residual reconstruction from the returned eigenvector
- PA-E2 sparse frequency agreement with the PA-E1 dense oracle
- rejection of PA-E1 synthetic demag_kind values on the PA-E2 path
- poisson_airbox_modal_eigen_slepc.v1 diagnostics JSON with solver_adapter
```

Verification, 2026-07-08:

```text
command:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc

result:
  passed

observed native target:
  cmake --build native/build --target fem_poisson_airbox_modal_eigen_slepc_contract
  [100%] Built target fem_poisson_airbox_modal_eigen_slepc_contract
  native/build/backends/fem/fem_poisson_airbox_modal_eigen_slepc_contract exited 0

regression gate:
  just verify-fem-frequency-domain-native-contract
  passed
```

## Patch PA-E3 - CPU Schur MatShell Poisson-airbox k=0 modal eigen

Status:

```text
Implemented at native contract level for the tiny Schur MatShell
certification path. This is not K0-3 FEM thin-film demag validation, not real
FEM-airbox mesh extraction, not public Python/API/IR exposure, and not GPU
modal parity/runtime.
```

Implemented evidence:

```text
- Added internal-only native certificate/result API:
  backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp
- Added implementation:
  backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp
- Added native contract test:
  backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp
- Added source and test target:
  backends/fem/CMakeLists.txt
- Added just gate:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
```

The native contract covers:

```text
- PETSc MatShell creation for the Schur-reduced magnetic operator
- matrix-free apply S(q) = A_qq q + A_qphi phi(q)
- reuse of mean_zero_augmented Poisson setup from the PA-E2 block problem
- sampled MatShell apply agreement with explicit Schur
- frequency agreement against the PA-E2 full-coupled sparse SLEPc reference
- full descriptor residual reconstruction from the Schur eigenvector
- Schur certificate key emission with mesh/material/m0/h_eff0/static_demag/
  boundary/k/gauge/operator signatures
- planner rejection of implicit Schur auto-selection
- planner selection of schur_reduced only for explicit certified requests
```

Verification, 2026-07-08:

```text
command:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell

result:
  passed

observed native target:
  cmake --build native/build --target fem_poisson_airbox_schur_matshell_contract
  [100%] Built target fem_poisson_airbox_schur_matshell_contract
  native/build/backends/fem/fem_poisson_airbox_schur_matshell_contract exited 0

regression gate:
  just verify-fem-frequency-domain-native-contract
  passed
```

## Patch PA-E4a - K0-3 synthetic demag-factor Kittel gate

Status:

```text
Implemented for the synthetic demag-factor slice only. This is the first
K0-3 artifact/validation gate and does not claim real periodic Poisson-airbox
demag, real airbox pair-map consumption, mean-zero phi solve telemetry, or
mesh-convergence readiness.
```

Implemented evidence:

```text
- K0KittelFieldSweepValidation now carries optional case_id and demag_kind.
- FemEigenK0KittelValidationIR carries optional case_id/demag_kind and planner
  validation accepts only none, synthetic_demag_factor, or periodic_airbox_k0.
- Added runner solver model:
  reference_k0_kittel_synthetic_demag_factor
- Added narrow CPU k-path synthetic gate for:
  case_id=K0-3
  demag_kind=synthetic_demag_factor
  model=thin_film_in_plane
  include_demag=true
  Floquet k=0
- validation/kittel_k0_pbc/summary.v1.json and points.v1.csv now include
  case_id/demag_kind metadata.
- Added verifier flag:
  scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-demag
- Added example:
  examples/fem_eigen_k0_kittel_thinfilm_demag.py
- Added managed gate entry point:
  just verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu
```

Verification, 2026-07-08:

```text
python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  12 passed

PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k 'k0_kittel'
  4 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan fem_eigen_carries_k0_kittel_validation_from_runtime_metadata
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k_path_manifest_and_auxiliary_artifacts_carry_k0_kittel_validation
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel_synthetic_demag_factor_single_k_matches_thin_film_formula
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan fem_eigen_allows_k0_kittel_synthetic_demag_factor_floquet_path
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-plan fem_eigen_floquet_dynamic_demag_is_rejected
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel_synthetic_demag_factor_path_bypasses_floquet_dynamic_demag_gate
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner runner_rejects_floquet_dynamic_demag_gate
  1 passed
```

Managed gate status:

```text
just verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu
  passed through the managed FEM runtime route
  script: examples/fem_eigen_k0_kittel_thinfilm_demag.py
  verifier: scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-demag
```

Remaining PA-E4 work after PA-E4a:

```text
K0-3b small real FEM film with shared-domain airbox
periodic_mesh_certificate.v5 consumption by the modal eigensolve path
airbox pair-map consumption
mean_zero_augmented phi gauge evidence in real K0-3 artifacts
Poisson residual / phi DOF / M_eff or N_eff reporting from numeric demag
K0-3c convergence table and threshold tightening
authoritative managed gate pass after Docker/buildx access is available
```

Current PA-E4b status note from 2026-07-09:

```text
The K0-3b periodic-airbox CPU modal/eigen route has moved past the old
"future slot only" state for the small managed fixture. The managed
`verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-cpu` gate produced
real artifacts under
.fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts with:
  solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc
  demag_kind=periodic_airbox_k0
  execution_lane=production_cpu
  production_solver_available=true
  production_periodic_airbox_claim=true
  poisson_constraint_relative_residual=0
  relative_reference_frequency_error=0
  validation/kittel_k0_pbc/convergence.v1.csv present

The Python verifier accepts those artifacts with
--require-k0-kittel-periodic-airbox-demag. This is still a narrow K0
periodic-airbox/Kittel CPU modal slice; it does not close GPU PA-G, nonzero-k
Floquet dynamic demag, broad modal sweeps, or production-v1 frequency-driven
coverage.
```

Follow-up verifier hardening, 2026-07-08:

```text
scripts/verify_fem_frequency_domain_eigen_artifacts.py --require-k0-kittel-demag
remains the shared K0-3 demag gate. It accepts PA-E4a synthetic-demag artifacts
and accepts demag_kind=periodic_airbox_k0 only when summary.v1.json proves:
  gauge_policy=mean_zero_augmented
  phi_dof_count > 0
  augmented_phi_dof_count > phi_dof_count
  poisson_constraint_relative_residual <= 1e-8
  magnetic_pair_count > 0
  airbox_pair_count > 0
  production_periodic_airbox_claim=true

scripts/verify_fem_frequency_domain_eigen_artifacts.py
  --require-k0-kittel-periodic-airbox-demag
is the stricter narrow PA-E4b CPU periodic-airbox gate. It implies the K0-3 demag gate and also
requires demag_kind=periodic_airbox_k0, so PA-E4a synthetic-demag artifacts
cannot satisfy it.

It also requires validation/kittel_k0_pbc/convergence.v1.csv with mesh
resolution, airbox size, phi dof count, Poisson residual, Kittel frequency
error, and effective magnetisation columns. Focused tests:

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  11 passed
```

This verifier coverage is now exercised by the narrow managed K0-3b
periodic-airbox CPU run above; broader shared-domain production and GPU coverage
remain separate gates.

Public/runtime guard follow-up, 2026-07-08:

```text
Public K0KittelFieldSweepValidation.demag_kind no longer advertises
periodic_airbox_k0. It accepts only none and synthetic_demag_factor.

The planner rejects raw k0_kittel_validation metadata with
demag_kind=periodic_airbox_k0 until the real PA-E4b FEM-airbox eigensolve path
is implemented.

The runner K0 Kittel artifact writer also rejects manually constructed
periodic_airbox_k0 PathSolveResult values without real PA-E4b metrics, so the
generic/synthetic path cannot emit production periodic-airbox claims.
```

Runtime artifact slot follow-up, 2026-07-08:

```text
PathSolveResult now carries optional K0KittelPeriodicAirboxDemagMetrics for
future real PA-E4b FEM-airbox outputs.

The K0 Kittel artifact writer accepts demag_kind=periodic_airbox_k0 only when
that metrics object is present and proves positive mesh/airbox scales, positive
phi and augmented phi dofs, mean-zero augmented gauge-compatible Poisson
residual <= 1e-8, positive magnetic/airbox pair counts, positive M_eff, and
non-negative Kittel frequency error.

Accepted periodic-airbox artifacts emit summary.v1.json, points.v1.csv, and
convergence.v1.csv under validation/kittel_k0_pbc.
```

Focused diagnostic verification:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel_artifacts_reject_periodic_airbox_without_real_metrics
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel_artifacts_accept_periodic_airbox_with_real_metrics
  1 passed

CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner eigen_artifacts_write_k0_kittel_summary_and_points
  1 passed

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  10 passed
```

This runtime/artifact seam is now populated by the narrow managed K0-3b
periodic-airbox CPU run. PA-E4b should still be treated as narrow rather than
general production coverage until larger shared-domain fixtures, mesh
certificate promotion, and GPU parity gates are closed.

Modal-eigen ABI payload follow-up, 2026-07-08:

```text
FullmagFemModalEigenRequest now has an explicit Poisson-airbox full-coupled
block payload:
  A_qq, A_qphi, A_phiq, A_phiphi, B_qq as CSR blocks
  q/phi dof counts
  mean-zero phi weights
  target/reference frequency

The Rust NativeModalEigenRequest wrapper carries the same payload as
NativeModalEigenPoissonAirboxBlockProblem and defaults all existing modal paths
to None.

The C++ API bridge maps the ABI tail into ModalEigenRequest, and
solve_modal_eigen_contract dispatches poisson_airbox_block_enabled requests to
solve_poisson_airbox_modal_eigen_cpu_slepc.

The native PA-E2 result JSON now carries q/phi/augmented-phi DOF counts plus
Poisson residual and reference-frequency error. The runner has a focused
`native_poisson_airbox_k0_metrics_from_result_json(...)` bridge that maps this
output into `K0KittelPeriodicAirboxDemagMetrics` only for
`solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc` and
`demag_kind=periodic_airbox_k0`; generic modal JSON is rejected.
```

Managed verification:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner native_poisson_airbox
  2 passed

just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
  passed after managed runtime rebuild

just verify-fem-frequency-domain-native-contract
  passed
```

The native modal contract now tests the public C ABI path, not only the direct
PA-E2 C++ solver call, and it checks the new result JSON DOF/residual fields.
Real small-film matrix assembly and K0-3 artifact metric production remain
open.

Runner path follow-up, 2026-07-08:

```text
crates/fullmag-runner/src/dispatch.rs now wires native PA-E2 metrics into the
multi-k K0 Kittel path:
  eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(...)
  eigen_path_periodic_airbox_k0_metrics_input_from_plan(...)

The path accepts only solver diagnostics from
solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc with
demag_kind=periodic_airbox_k0. It derives mesh_resolution_m from hmax,
airbox_size_m from air_box_config and mesh extent, pair counts from periodic
node pairs split by magnetic/airbox element markers, and M_eff from the K0-3
validation metadata. Per-sample metrics are merged only when DOF, pair-count,
mesh, airbox, and M_eff metadata remain consistent; worst Poisson residual and
worst Kittel error are retained.
```

Focused verification:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel
  11 passed

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  11 passed
```

This closes the runner-side artifact-population gap for the narrow K0
periodic-airbox/Kittel CPU modal slice. Remaining production gaps are broader
shared-domain validation, accepted-certificate promotion, GPU parity/runtime,
and nonzero-k Floquet dynamic-demag coverage.

## Patch E - dense full-coupled oracle

Reported status:

```text
Implemented tiny/oracle module:
- DenseFullCoupledMagnetostaticProblem
- DenseSchurExplicitBuilder
- FullReducedResidualReconstructionTest
- explicit Schur and full residual reconstruction checks
```

Follow-up native evidence from 2026-07-08: Patch E now also covers an explicit
tiny dense phi gauge/nullspace contract. `DenseFullCoupledMagnetostaticProblem`
has `DensePhiGaugePolicy::pin_first_dof`, and
`dense_full_coupled_oracle_handles_pinned_phi_gauge` verifies explicit Schur
construction, matrix-free Schur apply, phi reconstruction with the pinned
potential DOF, and full-vs-reduced residual reconstruction for a singular
compatible `A_phiphi`. RED was a compile failure because the policy did not
exist; GREEN passed through `just verify-fem-frequency-domain-native-contract`
after managed runtime rebuild.

This improves the certification oracle required by v5. It does not change the
large periodic-airbox runtime Schur/preconditioner path, which remains blocked
by true-residual inconsistency and harmful Schur quality until the certified
full-coupled/Schur runtime path consumes equivalent gauge, residual, and
preconditioner contracts.

## Patch F - CPU sparse/direct baseline

Reported status:

```text
Implemented MVP:
- engines/sparse_direct
- real-split CSR assembly [K, omega M; -omega M, K]
- PETSc sequential AIJ
- KSPPREONLY + PCLU
- explicit unavailable fallback for non-PETSc builds
- native contract compares to dense tiny and true residual
```

## Patch G - full-coupled field-split prototype

Reported status:

```text
Implemented dense/oracle-scale prototype:
- FullCoupledBlockOperator
- FieldSplitPreconditioner
- PoissonBlockSolverAdapter
- cached A_phiphi inverse
- block-triangular field-split preconditioner
- phi residual telemetry
- unpreconditioned reference telemetry
```

## Patch H - Schur certification gate

Reported status:

```text
Implemented contract/planner gate:
- SchurCertificationState
- finite full-vs-reduced reconstruction requirement
- residual-contraction requirement
- certificate-to-capability projection
- uncertified periodic-airbox fallback
- mesh/material/physics signature invalidation
```

## Patch I - modal response backend

Reported status:

```text
Implemented validation/helper slices:
- modal response diagonal validation helper
- ModalBasisPolicy
- cache key builder
- completeness certificate gate
- sparse/direct sample validation
- production CPU Gamma/k0 modal adapter runtime proof with SLEPc shift-invert
  selected-spectrum provenance and mode-field artifacts
```

Latest implementation evidence, 2026-07-07:

```text
- RED: the production Gamma/k0 modal verifier rejected the real runtime bundle
  because it applied the no-demag nonzero-k Floquet rule to
  --require-production-gamma-k-path and also required strictly increasing
  path_s for a degenerate all-Gamma k-path.
- GREEN: just verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime
  passed after the verifier was narrowed: nonzero-k production modal k-path
  still requires no-demag, while Gamma/k0 production bridge accepts ordinary
  k0 demag and degenerate path_s when all sampled k-vectors are zero.
```

Explicitly still missing:

```text
modal-reduced driven sweep engine integration
nonzero-k dynamic demag-k modal operator
periodic-airbox modal production proof
modal GPU runtime solver
broader sparse/matrix-free Floquet validation
```

## Periodic-antidot frequency-driven runtime evidence

Latest managed evidence, 2026-07-08:

```text
just run-fem-periodic-antidot-frequency-driven-managed-headless materialized
examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py,
generated the shared magnetic/airbox mesh, completed the relaxation stage by
torque tolerance, and entered the production_gpu frequency-response stage.

The frequency-response input preflight passed:
- status=ok
- equilibrium vectors matched the full mesh
- expected magnetic nodes were preserved in the dynamic slice
- periodic_airbox_delta_phi_dofs_cover_full_mesh=true
- periodic_airbox_delta_phi_pairs_present=true
- periodic_magnetic_pairs_retained=true
- periodic translation residuals were within tolerance

The solve did not pass the production verifier. With max_iterations=8192 and
restart_iterations=512, native GMRES stopped at max iterations with
relative_residual_l2_norm=8.430517903883425. The solver wrote partial
artifacts and diagnostics, but no completed response field artifacts.

Schur/preconditioner diagnostics showed that the current graph/Schur
preconditioner was not a valid contraction for this workload:
- right_preconditioner_auto_disabled=true
- right_preconditioner_auto_disable_reason=pilot_selected_unpreconditioned_after_probe
- right_preconditioner_probe_relative_residual_l2_norm=6.584202879742948
- schur_preconditioner_initial_relative_residual_l2_norm=7.4190907245080915
- schur_preconditioner_sweep_relative_residual_l2_norm stayed around 7.4-7.5
- residual_consistency_status=degraded

A follow-up experiment with max_iterations=8192 and restart_iterations=8192
avoided the 512-step restart but became impractically slow for the current
host-Krylov implementation; PETSc's GMRES documentation calls out this same
restart tradeoff: larger restart can help difficult systems, but increases
orthogonalization cost and memory use.

Conclusion: the periodic-antidot frequency-driven example now proves DSL,
mesh, relaxation handoff, periodic-airbox preflight, and diagnostic artifact
generation. It is not yet a green production solve. The next implementation
step is not another example tweak; it is the documented full-coupled /
certified-Schur solver work for dynamic demag periodic-airbox workloads.
```

Additional managed GPU periodic-airbox smoke evidence, 2026-07-08:

```text
target: just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
runtime bundle: rebuilt successfully by just ensure-managed-fem-runtime
input_preflight.status: ok
input_preflight.periodic_mesh_certificate.schema_version: periodic_mesh_certificate.v5
input_preflight.periodic_mesh_certificate.magnetic_pair_count: 8
input_preflight.periodic_mesh_certificate.airbox_pair_count: 22
input_preflight.periodic_mesh_certificate.magnetic_pair_map_sha256: sha256:0ee031a0ae3a1d89fefea95dff8858f099a2d5e60448c266df856f3bbdd04c3d
input_preflight.periodic_mesh_certificate.airbox_pair_map_sha256: sha256:5bae67ef2bc1a2c24281b76a0e9a42559a77ea1ac305c52bfe6ce3e5432dbbee
status: validation_error
total_iteration_count: 8192
max_iterations_for_frequency: 8192
relative_residual_l2_norm: 9.2642276718065e24
residual_growth_factor: 9.2642276718065e24
residual_consistency_status: degraded
delta_phi_phase_validation_status: failed
delta_phi_flux_validation_status: ok
native error: periodic-airbox k=0 solved delta_phi response violates periodic seam constraints
```

This confirms that preflight certificate-hash propagation is live in managed
runtime artifacts, but the current GPU periodic-airbox dynamic-demag solve is
not a valid production gate.

Follow-up implementation evidence, 2026-07-08:

```text
target: just verify-fem-frequency-domain-native-contract
status: passed
change: k0/Floquet postsolve delta_phi seam validation errors now preserve
        delta_phi_phase_max_residual, delta_phi_seam_max_after_offset, and
        best constant seam offset diagnostics in both artifacts and direct
        result diagnostics.
contract: production_cpu_periodic_airbox_dynamic_demag_reports_k0_delta_phi_seam_mismatch_residual
```

This is an observability fix, not a Schur convergence fix. The large
periodic-antidot GPU runtime remains blocked until the dynamic-demag
periodic-airbox solver contracts rather than diverges.

Second follow-up implementation evidence, 2026-07-08:

```text
target: just verify-fem-frequency-domain-native-contract
status: passed
change: GMRES now flags generic recomputed-vs-tracked residual degradation,
        not only right-preconditioner-specific degradation.
contract: production_cpu_matrix_free_solver_requires_recomputed_residual_for_convergence
```

Managed periodic-airbox smoke after this change:

```text
target: just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
status: solve_error
native error: production frequency-response GMRES residual consistency degraded
total_iteration_count: 132
max_iterations_for_frequency: 8192
relative_residual_l2_norm: 4.341950078029695
last_tracked_relative_residual_l2_norm: 0.0008480034623546483
last_recomputed_relative_residual_l2_norm: 4.341950078029695
minimum_tracked_relative_residual_l2_norm: 0.0008480034623546483
minimum_tracked_relative_residual_iteration: 132
residual_consistency_status: degraded
krylov_preconditioner_kind: none
right_preconditioner_auto_disabled: true
right_preconditioner_auto_disable_reason: probe_relative_residual_above_threshold
right_preconditioner_probe_relative_residual_l2_norm: 422769.88891747926
right_preconditioner_fallback_probe_relative_residual_l2_norm: 13.40885193418363
schur_preconditioner_sweep_relative_residual_l2_norm:
  [13.408851934183692, 169.52680596072662, 2281.1021626273337, 30975.195238984375]
```

This moves the failure boundary earlier and makes the production GPU runtime
refuse false Arnoldi convergence before postsolve `delta_phi` seam validation.
It still does not make the periodic-airbox dynamic-demag solve converge; the
next fix remains the documented certified/full-coupled Schur path.

Verifier follow-up, 2026-07-08:

```text
The artifact verifier now accepts the documented bounded-run stagnation
failure mode without requiring a failed solve to hit the full
max_iterations_for_frequency budget. A solve_error bundle may stop early only
when it reports stop_reason=stagnated, stagnation_detected=true, matching
stagnation_iteration, stagnation_relative_residual_ratio > 0.9, and
relative_residual_l2_norm > 1e-2.

Focused pytest coverage accepts a periodic-airbox solve_error bundle stopped at
256/8192 iterations for stagnation and keeps the existing solve_error
telemetry rejection tests green.
```

Third follow-up implementation evidence, 2026-07-08:

```text
target: just verify-fem-frequency-domain-native-contract
status: passed
change: Schur/preconditioner quality diagnostics now publish
        schur_preconditioner_quality_status according to v5 thresholds:
        good, bounded, weak, not_default, harmful, invalid, not_available.
contract: production_cpu_periodic_airbox_dynamic_demag_provider solver diagnostics
          require schur_preconditioner_quality_status.
```

Managed periodic-airbox GPU smoke after this telemetry increment:

```text
target: just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
status: solve_error
native error: production frequency-response GMRES residual consistency degraded
total_iteration_count: 130
relative_residual_l2_norm: 1.1116736446120163
last_tracked_relative_residual_l2_norm: 0.0009325591415167876
last_recomputed_relative_residual_l2_norm: 1.1116736446120163
residual_consistency_status: degraded
residual_consistency_recomputed_to_tracked_ratio: 1192.0677146587216
krylov_preconditioner_kind: none
right_preconditioner_auto_disabled: true
right_preconditioner_auto_disable_reason: probe_relative_residual_above_threshold
schur_preconditioner_quality_available: true
schur_preconditioner_quality_status: harmful
schur_preconditioner_sweep_relative_residual_l2_norm:
  [13.43191494483227, 170.31635815858712, 2310.2844332372265, 31544.245991230284]
```

This closes another observability/certification slice: harmful Schur quality is
now machine-readable in artifacts instead of only inferable from numeric
arrays. The solver remains intentionally red for this workload until a
certified full-coupled/Schur path contracts the true residual.

Fourth follow-up implementation evidence, 2026-07-08:

```text
target: just verify-fem-frequency-domain-native-contract
status: passed
change: production GMRES implements the v5 stagnation guard:
        relres_256 / relres_0 > 0.9 and relres_256 > 1e-2
        stops as solve_error with a stagnated error message.
contract: production_cpu_matrix_free_solver_stops_stagnated_run_at_256_iterations
```

The contract uses a bounded two-DOF skew operator that cannot reduce the
restart-1 GMRES residual. It verifies `total_iteration_count=256`,
`stagnation_detected=true`, `stagnation_iteration=256`, and a residual ratio
above the documented threshold. This implements the stop-policy slice only; it
does not change Schur mathematics or make periodic-airbox dynamic demag solve.

Fifth follow-up implementation evidence, 2026-07-08:

```text
target: fem_frequency_domain_contract
status: passed
change: production GMRES failure diagnostics and solver.v1 artifacts now expose
        stop_reason plus stagnation_detected, stagnation_iteration, and
        stagnation_relative_residual_ratio.
contract: production_cpu_lane_writes_failure_artifacts_for_nonconverged_gmres
```

This closes the artifact visibility part of the stop-policy slice. A bounded
nonconverged run reports `stop_reason=max_iterations` and
`stagnation_detected=false`; the native stagnation contract remains the source
of truth for the `stop_reason=stagnated` branch.

Sixth follow-up implementation evidence, 2026-07-08:

```text
target: just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
status: failed as expected at the current production boundary
native_status: solve_error
total_iteration_count: 134
max_iterations_for_frequency: 8192
relative_residual_l2_norm: 7.6763392511713855
last_tracked_relative_residual_l2_norm: 0.000547212062306515
residual_consistency_recomputed_to_tracked_ratio: 14028.088523515707
residual_consistency_status: degraded
schur_preconditioner_quality_status: harmful
delta_phi_seam_validation_status: ok
delta_phi_flux_validation_status: ok
stop_reason: residual_consistency_degraded
stagnation_detected: false
```

The current failure is therefore not a periodic seam failure in the latest
runtime evidence. The Schur/GMRES path is internally inconsistent: tracked
GMRES residual looks small, but recomputed true residual is large. The
periodic-airbox phi-consistency solve-error artifact path now has a native
contract requiring machine-readable GMRES stop telemetry, so the same failure
class can be surfaced as `stop_reason=residual_consistency_degraded` in the
runtime artifacts after the managed runtime is rebuilt.

Seventh follow-up native evidence from 2026-07-08: the
`matrix_free_mfem_demag_phi_consistency_schur_provider` runtime path now
publishes the concrete k=0 scalar-potential gauge instead of the generic
`matrix_free_provider_responsibility` placeholder. The no-exchange
phi-consistency happy-path contract requires `phi_gauge_policy="mean_zero"` and
`phi_gauge_constraint_applied=true` in the manifest, solver diagnostics, and
frequency-point demag contribution. RED failed on the missing manifest field;
GREEN passed `just verify-fem-frequency-domain-native-contract` after managed
runtime rebuild.

This is still a provenance/certification improvement, not a Schur convergence
fix. The current large periodic-airbox runtime failure remains
`stop_reason=residual_consistency_degraded` with harmful Schur-preconditioner
quality until the matrix-free Schur action and right-preconditioner contraction
are made consistent with the recomputed true residual.

Eighth follow-up implementation evidence from 2026-07-08: the frequency-response
solver policy is now public enough to select the native right-preconditioner
family explicitly. Python DSL/script export/ProblemIR/Rust IR/runner env
plumbing carry `solver_preconditioner` / `solver_policy.preconditioner` with
values `auto`, `graph_demag_coarse`, `demag_coarse`, `block_jacobi`, and
`none`. The runner maps it to
`FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT`, which is the native
runtime selector already consumed by the production frequency-response path.

`examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py`
now requests `solver_method="gpu_operator_host_krylov"` and
`solver_preconditioner="auto"`. This is an operational safety default for the
current antidot k=0 driven smoke path: runtime may probe Schur/graph and
block-Jacobi variants, but it must not force a known harmful preconditioner by
default. The Schur path remains blocked by harmful residual-consistency
diagnostics until its contraction is fixed against the recomputed true residual.

Ninth follow-up implementation evidence from 2026-07-08: the Rust runner now
copies the requested `solver_method` and `solver_preconditioner` into
`response/progress.v1.json` for running/interrupted native frequency-response
solves, including the embedded `progress_json` payload. This matters for the
large periodic-antidot stress case because a user interrupt before completion
can leave no `response/diagnostics/solver.v1.json`; the progress artifact still
shows the requested `solver_method` and `solver_preconditioner`.
Verified by
`frequency_response::tests::native_frequency_response_progress_artifact_records_solver_iteration`
and `cargo +nightly test -p fullmag-runner --features fem-gpu --no-run`.

Tenth follow-up native evidence from 2026-07-08: periodic-airbox
phi-consistency `solve_error` direct diagnostics now publish the same coupled
residual partition signal as the artifact diagnostics:
`coupled_residual_partition_status="magnetic_schur_phi_consistency_provider"`
plus `coupled_block_norms` with delta_m and delta_phi residual/RHS/response
shares. The RED contract failed on the missing direct diagnostics field; GREEN
passed through `just verify-fem-frequency-domain-native-contract` after adding
the existing split-norm JSON helper to the failure direct diagnostics path. This
improves root-cause observability for the current
`residual_consistency_degraded` periodic-airbox blocker; it does not change
Schur or GMRES mathematics.

Eleventh follow-up runtime evidence from 2026-07-08: the managed periodic-airbox
GPU smoke was rerun after the split-residual diagnostics patch. With the default
`auto` preconditioner policy, runtime auto-disabled the harmful right
preconditioner and failed at `stop_reason=residual_consistency_degraded` with
`last_tracked_relative_residual_l2_norm=8.524008946930797e-4`,
`last_recomputed_relative_residual_l2_norm=6.09485709510772`,
`residual_consistency_recomputed_to_tracked_ratio=7150.2237187377295`, and
`coupled_block_norms.relative_residual_delta_m_l2_norm=6.094857095107722` while
`relative_residual_delta_phi_l2_norm=0`. Forcing `block_jacobi` was worse on
the same smoke: `last_recomputed_relative_residual_l2_norm=8.810998387778028`
and `residual_consistency_recomputed_to_tracked_ratio=12249.534331532765`.
Therefore the periodic-antidot driven example and its managed target now use
`solver_preconditioner="auto"` / preconditioner env default `auto`, not
`block_jacobi`. Verified by the three focused runtime-target tests and the full
`python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -q` suite.

Twelfth follow-up implementation/runtime evidence from 2026-07-08: host GMRES
now treats an unpreconditioned true/tracked residual gap as residual
replacement instead of an immediate `solve_error`. The right-preconditioned path
still reports `solve_error` on residual-consistency degradation so `auto` can
disable/retry harmful right preconditioners. The new native contract
`production_cpu_matrix_free_solver_restarts_after_unpreconditioned_residual_gap`
failed before the policy change and passed after the fix; the full managed gate
`just verify-fem-frequency-domain-native-contract` passed.

After this fix, the managed periodic-airbox GPU smoke no longer stops at
`GMRES=128` with `stop_reason=residual_consistency_degraded`. It advances to
`total_iteration_count=260` and fails with `stop_reason=stagnated`,
`stagnation_iteration=260`,
`last_tracked_relative_residual_l2_norm=4.496965652556972e-4`,
`last_recomputed_relative_residual_l2_norm=13.195808726437836`, and
`residual_consistency_recomputed_to_tracked_ratio=29343.805903731347`.
The split residual remains purely magnetic:
`coupled_block_norms.relative_residual_delta_m_l2_norm=13.195808726437836` and
`relative_residual_delta_phi_l2_norm=0`. This moves the blocker from premature
residual-consistency abort to true magnetic reduced-Schur stagnation; it still
does not make the periodic-antidot frequency-driven workload production-green.

Thirteenth follow-up implementation/runtime evidence from 2026-07-08: the
periodic-airbox GPU runtime targets now pass through
`FULLMAG_FEM_GPU_DEMAG_MODE` and default the user-facing periodic-antidot and
small periodic-airbox GPU frequency-response targets to
`hybrid_cpu_poisson`. This keeps the frequency-response lane on GPU operator +
host Krylov while routing the dynamic demag Poisson provider through the
working host policy. The artifact writer no longer hardcodes
`device_hypre_poisson` for every production GPU run; it reports the actual
runtime demag policy, and the verifier accepts either device or hybrid
provenance according to the same env contract.

Current managed smoke evidence:

```text
target: just verify-fem-frequency-domain-periodic-airbox-gpu-runtime
status: passed
solver_status: ready
total_iteration_count: 2
relative_residual_l2_norm: 2.3535067523302147e-16
static_periodic_reduced_magnetic_solve: true
uses_gpu_poisson: false
demag_operator_mode: hybrid_cpu_poisson
hypre_execution_policy: host
demag_provider_residency: cpu
```

The failing device-hypre path remains reproducible by overriding
`FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson`; the observed failure is still
a magnetic reduced-operator/device-Hypre dynamic-demag consistency problem, not
a scalar `delta_phi` residual problem. The working periodic-antidot target is
therefore a compatibility/hybrid execution path, not proof that
device-resident Poisson demag is production-ready.

Fourteenth follow-up runtime evidence from 2026-07-08: the full
`just run-fem-periodic-antidot-frequency-driven-managed-headless` target now
passes in the same hybrid compatibility lane. The target runs relaxation and
frequency response as separate managed phases, converts the shared-domain
relaxed state to a magnetic-only initial state, and verifies the final artifact
bundle with `FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE=hybrid_cpu_poisson`.

Current full periodic-antidot artifact evidence:

```text
target: just run-fem-periodic-antidot-frequency-driven-managed-headless
stage 1 relaxation: completed by torque tolerance in 49 steps
response status: ready
response complete: true
completed_frequency_points: 1
written_frequency_point_artifacts: 1
requested_execution_lane: production_gpu
resolved_execution_lane: production_gpu
total_iteration_count: 2006
relative_residual_l2_norm: 0.0009994399206910052
residual_consistency_status: ok
delta_phi_seam_validation_status: ok
delta_phi_flux_validation_status: ok
h_demag_seam_validation_status: ok
uses_gpu_poisson: false
demag_operator_mode: hybrid_cpu_poisson
hypre_execution_policy: host
demag_provider_residency: cpu
krylov_preconditioner_variant: none
right_preconditioner_auto_disabled: true
right_preconditioner_auto_disable_reason: pilot_selected_unpreconditioned_after_probe
schur_preconditioner_quality_status: harmful
```

The managed artifact verifier passes for this mode when run with the same
environment contract as the target:

```text
FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE=hybrid_cpu_poisson
FULLMAG_FEM_FREQUENCY_RESPONSE_DELTA_PHI_FLUX_MAX_TOLERANCE_T=2e-2
python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py \
  --require-production-gpu \
  --require-periodic-airbox-gpu-demag-solved \
  .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts
```

This is the first green managed full periodic-antidot frequency-driven run for
the current example. Its scope is intentionally narrow: GPU operator/host
Krylov plus host Poisson demag provider. It does not validate strict
`device_hypre_poisson`, device-resident Krylov, full-coupled sparse
field-split, or native accepted `G_pair` certificate consumption.

Fifteenth follow-up PA-G1 runtime evidence from 2026-07-09: the strict
`device_hypre_poisson` small periodic-airbox CPU/GPU parity target now writes
and verifies a machine-readable GPU Poisson parity artifact.

Current managed PA-G1 artifact evidence:

```text
target: FULLMAG_FMR_RESPONSE_RTOL=1e-8 just verify-fem-frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime
status: passed
artifact: .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_poisson_parity.v1.json
schema_version: gpu_poisson_parity.v1
lane: gpu_poisson_airbox_k0
execution_policy: device
memory_location: device
fallback_used: false
max_relative_phi_error: 5.353355861550261e-10
max_relative_field_error: 5.112761456182738e-10
h2d_count: 0
d2h_count: 0
```

This closes the PA-G1 device Poisson parity artifact/runtime slice for the
small frequency-response fixture. It does not close GPU Schur parity,
GPU shift-invert, true GPU modal Poisson-airbox eigensolve, or production
large-workload GPU coverage.

Sixteenth follow-up PA-G2 runtime evidence from 2026-07-09: the same strict
`device_hypre_poisson` small periodic-airbox CPU/GPU parity target now writes
and verifies a machine-readable GPU Schur-apply parity artifact from the
frequency-response operator probe diagnostics.

Current managed PA-G2 artifact evidence:

```text
target: FULLMAG_FMR_RESPONSE_RTOL=1e-8 just verify-fem-frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime
status: passed
artifact: .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_schur_apply_parity.v1.json
schema_version: gpu_schur_apply_parity.v1
lane: gpu_poisson_airbox_k0
execution_policy: device
memory_location: device
fallback_used: false
vector_set: deterministic_frequency_response_probe
max_relative_schur_apply_error: 5.840773106872843e-11
complex_operator_relative_l2_error: 5.840773106872843e-11
real_stiffness_relative_l2_error: 4.37096199539583e-11
imag_stiffness_relative_l2_error: 4.9811840538123526e-11
real_mass_relative_l2_error: 0
imag_mass_relative_l2_error: 0
demag_tangent_relative_l2_error: 4.8057496817348875e-11
```

This closes the small PA-G2 Schur-apply parity artifact/runtime slice for the
frequency-response operator probe. It does not close GPU shift-invert action
parity, true GPU modal Poisson-airbox eigensolve, or production large-workload
GPU coverage.

Seventeenth follow-up PA-G3a runtime evidence from 2026-07-09: the same strict
`device_hypre_poisson` small periodic-airbox CPU/GPU parity target now writes
and verifies a machine-readable shifted linear-solve action parity artifact
from the frequency-response solve. This is a proxy slice before true modal
shift-invert action parity.

Current managed PA-G3a artifact evidence:

```text
target: FULLMAG_FMR_RESPONSE_RTOL=1e-8 just verify-fem-frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime
status: passed
artifact: .fullmag/reports/frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu_shifted_solve_action_parity.v1.json
schema_version: gpu_shifted_solve_action_parity.v1
lane: gpu_poisson_airbox_k0
execution_policy: device
memory_location: device
fallback_used: false
operator_family: frequency_response_shifted_linear_solve
rhs_family: dynamic_field_phasor
full_modal_shift_invert_claim: false
max_relative_action_error: 1.4213110688388042e-09
magnetization_response_relative_l2_error: 5.013823814612709e-10
component_amplitude_relative_l2_error: 1.837908524546982e-10
component_phase_max_abs_error_rad: 1.4213110688388042e-09
```

This closes only the PA-G3a shifted linear-solve action parity slice for the
frequency-response operator. It does not close true modal shift-invert
`(A - sigma B)^-1 Bv`, GPU Krylov-Schur, true GPU modal Poisson-airbox
eigensolve, or production large-workload GPU coverage.

Eighteenth follow-up PA-G3b CPU reference evidence from 2026-07-09: the native
CPU Poisson-airbox descriptor path now has a direct modal shift-invert action
reference for the actual eigensolver operation.

Current managed PA-G3b evidence:

```text
target: just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
status: passed
files:
  backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp
  backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
operation: (A - sigma B)^-1 Bv
schema_version: poisson_airbox_modal_shift_invert_action.v1
operator_family: full_modal_shift_invert
solver_adapter: k0_poisson_airbox_cpu_full_coupled_shift_invert_reference
full_modal_shift_invert_claim: true
contract residual threshold: shifted_system_relative_residual <= 1e-10
```

This closes the CPU reference half of true PA-G3. It still does not close
CPU/GPU modal shift-invert parity, GPU Krylov-Schur, true GPU modal
Poisson-airbox eigensolve, or production large-workload GPU coverage.

Nineteenth follow-up PA-G3c artifact-contract evidence from 2026-07-09: true
GPU modal shift-invert action parity now has a dedicated verifier that rejects
the earlier PA-G3a frequency-response proxy.

Current PA-G3c contract evidence:

```text
files:
  scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
  scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
schema_version: gpu_modal_shift_invert_action_parity.v1
operator_family: full_modal_shift_invert
algebraic_action: (A - sigma B)^-1 Bv
rhs_family: modal_mass_times_vector
cpu_reference_schema_version: poisson_airbox_modal_shift_invert_action.v1
gpu_action_schema_version: gpu_modal_shift_invert_action.v1
full_modal_shift_invert_claim: true
per_iteration_h2d_count: 0
per_iteration_d2h_count: 0
thresholds:
  max_relative_action_error <= 1e-6
  q_response_relative_l2_error <= 1e-6
  shifted_system_relative_residual_cpu <= 1e-6
  shifted_system_relative_residual_gpu <= 1e-6
verified:
  python3 -m pytest scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
    4 passed
  python3 -m py_compile scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
    passed
```

This closes only the PA-G3 true-artifact contract. It does not close the GPU
modal action producer, CPU/GPU modal shift-invert parity, GPU Krylov-Schur, true
GPU modal Poisson-airbox eigensolve, or production large-workload GPU coverage.

Twentieth follow-up PA-G3d CPU modal-contract producer evidence from
2026-07-09: the native modal contract now has a narrow
Poisson-airbox shift-invert action-producer mode for the existing full-coupled
CSR descriptor. This producer calls the PA-G3b CPU reference action and writes
the `poisson_airbox_modal_shift_invert_action.v1` artifact through the modal
contract when partial artifacts are enabled.

Current PA-G3d evidence:

```text
target: just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
status: passed after RED/GREEN
RED failure before implementation:
  FAIL: PA-G3b modal contract result must point at the shift-invert action artifact
files:
  backends/fem/include/frequency_domain/modal_eigen_request.hpp
  backends/fem/src/frequency_domain/modal_eigen_solver.cpp
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
request flag:
  poisson_airbox_shift_invert_action_enabled = 1
artifact:
  <output_directory>/eigen/diagnostics/poisson_airbox_modal_shift_invert_action.v1.json
schema_version: poisson_airbox_modal_shift_invert_action.v1
operator_family: full_modal_shift_invert
algebraic_action: (A - sigma B)^-1 Bv
solver_adapter: k0_poisson_airbox_cpu_full_coupled_shift_invert_reference
full_modal_shift_invert_claim: true
additional checks:
  python3 -m pytest scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py scripts/test_verify_fem_gpu_shifted_solve_action_parity_artifact.py scripts/test_frequency_domain_runtime_targets.py -q
    69 passed
  python3 -m py_compile scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py
    passed
  git diff --check
    passed
```

This closes the CPU modal-contract producer slice required before true GPU
modal action parity. It does not close `gpu_modal_shift_invert_action.v1`,
CPU/GPU modal shift-invert parity, GPU Krylov-Schur, true GPU modal
Poisson-airbox eigensolve, or production large-workload GPU coverage.

Twenty-first follow-up PA-G3e C ABI/Rust native seam evidence from 2026-07-09:
the CPU modal action producer is now reachable through the public native FEM C
ABI and Rust wrapper layer.

Current PA-G3e evidence:

```text
files:
  native/include/fullmag_fem.h
  crates/fullmag-fem-sys/src/lib.rs
  backends/fem/src/api.cpp
  crates/fullmag-runner/src/native_fem/frequency_domain.rs
  crates/fullmag-runner/src/fem_eigen.rs
  backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp
C ABI tail fields:
  poisson_airbox_shift_invert_action_enabled
  poisson_airbox_shift_sigma_real
  poisson_airbox_shift_sigma_imag
  poisson_airbox_shift_action_vector_real
  poisson_airbox_shift_action_vector_imag
  poisson_airbox_shift_action_vector_count
Rust safe wrapper:
  NativeModalEigenPoissonAirboxBlockProblem::shift_invert_action
  NativeModalEigenPoissonAirboxShiftInvertAction
verified:
  CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-fem-sys modal_eigen_request_abi_exposes_poisson_airbox_tail_layout
    1 passed
  CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel --lib
    23 passed
  focused managed-container fem_modal_eigen_contract
    passed
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
    passed
```

The broader `just verify-fem-frequency-domain-native-contract` was attempted
after the C ABI/Rust seam change. It rebuilt the managed FEM runtime and built
the modal contract target, but failed in the earlier
`fem_frequency_domain_contract` executable with:

```text
FAIL: production CPU MFEM demag callback is invoked for the linearity self-check and stiffness applications
```

That failure is in the driven-response MFEM demag callback count test, not in
the modal Poisson-airbox action seam. PA-G3e still does not close
`gpu_modal_shift_invert_action.v1`, CPU/GPU modal shift-invert parity, GPU
Krylov-Schur, true GPU modal Poisson-airbox eigensolve, or production
large-workload GPU coverage.

Twenty-second follow-up native-contract gate repair evidence from 2026-07-09:
the broader frequency-domain native contract gate is green again. The temporary
failure above was a stale driven-response test expectation after the MFEM demag
tangent linearity probe had been extended from four provider applications to
six provider applications (`a`, `b`, `a+b`, `scale*a`, `repeat(a)`,
`zero-after-nonzero`). The production CPU diagnostics path now emits the full
`demag_tangent_linearity_diagnostics_json(...)` payload, including repeat and
zero-after-nonzero diagnostics, and the callback-count test expects
`6 + 2 * (iteration_count + 1)`.

Verified:

```text
focused managed-container fem_frequency_domain_contract
  passed
just verify-fem-frequency-domain-native-contract
  passed
```

Twenty-third follow-up PA-G3f GPU modal shift-invert action producer/parity
from 2026-07-09: the native GPU frequency-domain code now has a hidden
developer action producer for the true modal operation `(A - sigma B)^-1 Bv`
on the tiny full-coupled Poisson-airbox contract descriptor. This is not the
earlier frequency-response shifted-solve proxy.

Current PA-G3f evidence:

```text
files:
  backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
  justfile
  scripts/test_frequency_domain_runtime_targets.py

target:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action

artifacts:
  .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/
    eigen/diagnostics/poisson_airbox_modal_shift_invert_action.v1.json
    eigen/diagnostics/gpu_modal_shift_invert_action.v1.json
    gpu_modal_shift_invert_action_parity.v1.json

schema_version: gpu_modal_shift_invert_action_parity.v1
operator_family: full_modal_shift_invert
algebraic_action: (A - sigma B)^-1 Bv
rhs_family: modal_mass_times_vector
gpu_action_schema_version: gpu_modal_shift_invert_action.v1
full_modal_shift_invert_claim: true
frequency_response_proxy: false
per_iteration_h2d_count: 0
per_iteration_d2h_count: 0
max_relative_action_error: 7.727016304571709e-17
q_response_relative_l2_error: 7.727016304571709e-17
shifted_system_relative_residual_cpu: 6.674284868174013e-27
shifted_system_relative_residual_gpu: 4.5324665183683945e-17

verification:
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  python3 -m pytest scripts/test_frequency_domain_runtime_targets.py scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  git diff --check
```

This closes the true GPU action-parity slice for PA-G3 on the contract
descriptor. It does not close GPU Krylov-Schur, production large-workload GPU
modal eigensolve, or public GPU K0/Kittel periodic-airbox demag execution.

Twenty-fourth follow-up PA-G3g modal-eigen ABI/contract seam from 2026-07-09:
the hidden PA-G3f GPU modal shift-invert action is now reachable through the
modal-eigen C ABI/request tail, not only by a direct native test call.

Current PA-G3g evidence:

```text
files:
  backends/fem/include/frequency_domain/modal_eigen_request.hpp
  native/include/fullmag_fem.h
  crates/fullmag-fem-sys/src/lib.rs
  crates/fullmag-runner/src/native_fem/frequency_domain.rs
  backends/fem/src/api.cpp
  backends/fem/src/frequency_domain/modal_eigen_solver.cpp
  backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp

request tail:
  poisson_airbox_shift_invert_action_enabled
  poisson_airbox_shift_invert_action_device
  poisson_airbox_shift_sigma_real
  poisson_airbox_shift_sigma_imag
  poisson_airbox_shift_action_vector_real
  poisson_airbox_shift_action_vector_imag
  poisson_airbox_shift_action_vector_count

device selector:
  0 = CPU reference action
  1 = hidden GPU action

modal C ABI artifact:
  eigen/diagnostics/gpu_modal_shift_invert_action.v1.json

required semantics:
  solver_adapter: gpu_device_dense_modal_shift_invert_action_contract
  operator_family: full_modal_shift_invert
  algebraic_action: (A - sigma B)^-1 Bv
  rhs_family: modal_mass_times_vector
  frequency_response_proxy: false
  gpu_device_resident_modal_eigensolver: false

verification:
  just verify-fem-frequency-domain-native-contract
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  python3 -m pytest scripts/test_frequency_domain_runtime_targets.py scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-fem-sys modal_eigen_request_abi_exposes_poisson_airbox_tail_layout
  git diff --check
```

This closes the PA-G3g contract seam. It still does not close the real
device-resident GPU modal eigensolver loop.

Twenty-fifth follow-up GPU-G4 hidden compatibility provenance from 2026-07-09:
the PA-G3f/PA-G3g GPU modal shift-invert action now explicitly labels itself as
the hidden compatibility lane, not as public production GPU modal eigensolve.

Current GPU-G4 evidence:

```text
files:
  backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu
  backends/fem/src/frequency_domain/modal_eigen_solver.cpp
  backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp

artifact:
  .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/
    eigen/diagnostics/gpu_modal_shift_invert_action.v1.json

required provenance:
  execution_lane: gpu_operator_host_modal_eigen_compatibility
  solver_adapter: gpu_device_dense_modal_shift_invert_action_contract
  operator_family: full_modal_shift_invert
  algebraic_action: (A - sigma B)^-1 Bv
  rhs_family: modal_mass_times_vector
  frequency_response_proxy: false
  gpu_device_resident_modal_eigensolver: false

RED:
  FAIL: modal C ABI GPU action result must identify the hidden GPU-G4 compatibility lane

verification:
  focused container fem_modal_eigen_contract
  just verify-fem-frequency-domain-native-contract
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
  python3 -m pytest scripts/test_frequency_domain_runtime_targets.py scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  git diff --check
```

This starts/closes the narrow GPU-G4 provenance slice. It is still not GPU-G5:
there is no public production device-resident modal eigensolver loop yet.

Twenty-sixth follow-up GPU-G5a tiny dense device modal eigensolver contract from
2026-07-09: the first true device-resident modal eigensolver slice now exists
for the tiny full-coupled Poisson-airbox descriptor. It uses a CUDA dense
inverse-iteration shift-invert loop and emits a modal eigen artifact. It is not
yet the production sparse/Krylov-Schur GPU modal eigensolver for large meshes.

Current GPU-G5a evidence:

```text
files:
  backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
  justfile
  scripts/test_frequency_domain_runtime_targets.py
  scripts/verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py
  scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py

artifact:
  .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/
    eigen/diagnostics/gpu_modal_poisson_airbox_eigensolver.v1.json

required provenance:
  schema_version: gpu_modal_poisson_airbox_eigensolver.v1
  execution_lane: gpu_device_modal_eigen_dense_contract
  solver_adapter: gpu_dense_poisson_airbox_modal_eigen_contract
  solver_library: cuda_dense_inverse_iteration
  demag_kind: periodic_airbox_k0
  gauge_policy: mean_zero_augmented
  frequency_response_proxy: false
  gpu_device_resident_modal_eigensolver: true
  cpu_fallback: disabled
  fallback_used: false
  per_iteration_h2d_count: 0
  per_iteration_d2h_count: 0

measured artifact metrics:
  eigen_frequency_hz: 2011901211.0259216
  relative_reference_frequency_error: 1.1850411829116929e-16
  full_descriptor_relative_residual: 3.735334638019538e-15

RED:
  undefined reference to fullmag_fem_frequency_domain_solve_modal_poisson_airbox_gpu_dense_eigensolver

verification:
  focused container fem_poisson_airbox_modal_eigen_slepc_contract
  just verify-fem-frequency-domain-native-contract
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
    including scripts/verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py
  python3 -m pytest scripts/test_verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py scripts/test_frequency_domain_runtime_targets.py -q
  python3 -m pytest scripts/test_frequency_domain_runtime_targets.py scripts/test_verify_fem_gpu_modal_shift_invert_action_parity_artifact.py -q
  git diff --check
```

This closes only GPU-G5a. Remaining production GPU modal work is still a
sparse/matrix-free device eigensolver path for real meshes plus public planner
exposure after validation.

Twenty-seventh follow-up GPU-G5b CSR device modal descriptor apply foundation
from 2026-07-09: the modal Poisson-airbox GPU path now has a device CSR apply
for the full-coupled descriptor operator `A*x` on the augmented vector
`[q, phi, eta]`. This is a sparse/matrix-free operator foundation, not yet a
sparse shift-invert solve or Krylov-Schur eigensolver.

Current GPU-G5b evidence:

```text
files:
  backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu
  backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp
  justfile
  scripts/test_frequency_domain_runtime_targets.py
  scripts/verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py
  scripts/test_verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py

artifact:
  .fullmag/reports/frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action/
    eigen/diagnostics/gpu_modal_poisson_airbox_descriptor_apply.v1.json

required provenance:
  schema_version: gpu_modal_poisson_airbox_descriptor_apply.v1
  execution_lane: gpu_device_modal_descriptor_apply_contract
  solver_family: modal_eigen
  operator_family: full_coupled_poisson_airbox_modal_pencil
  algebraic_action: A*x
  matrix_format: csr_device_apply
  frequency_response_proxy: false
  gpu_device_resident_operator_apply: true
  cpu_fallback: disabled
  fallback_used: false
  per_iteration_h2d_count: 0
  per_iteration_d2h_count: 0

measured artifact metrics:
  input_l2_norm: 1.5970676253684437
  output_l2_norm: 14250292096.377323

RED:
  undefined reference to fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_descriptor

verification:
  focused container fem_poisson_airbox_modal_eigen_slepc_contract
  just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
    including scripts/verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py
  python3 -m pytest scripts/test_verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py scripts/test_frequency_domain_runtime_targets.py -q
```

This closes only GPU-G5b as an operator-apply foundation. Remaining production
GPU modal work still requires a device sparse shifted solve and eigen iteration
over this descriptor path.

## Patch J - GPU device FGMRES

Reported status:

```text
Implemented only as gate/API/probe:
- planner entry gate
- DeviceComplexVectorView
- GpuFrequencyOperatorContext
- ApplyAomegaGpu
- ApplyRightPreconditionerGpu
- transfer diagnostics
- FGMRES prerequisites config validation
- callback probe
- fused Aomega diagnostics contract requiring device input/output/scratch,
  stiffness-or-Jacobian and gyrotropic-frequency terms, required damping/demag
  term inclusion when declared, no host-side split term application, and no
  per-apply H2D/D2H transfer
- FGMRESDeviceEngineConfig rejects missing fused Aomega diagnostics and records
  fused_aomega_contract_passed in the readiness state
```

Explicitly still missing:

```text
runtime device FGMRES loop
device basis allocation
GPU orthogonalization
production runtime fused apply_Aomega_gpu implementation
proof of no D2H per iteration on real workloads
```

Latest implementation evidence, 2026-07-07:

```text
- RED: just verify-fem-frequency-domain-native-contract failed on missing
  GpuFusedAomegaDiagnostics, gpu_fused_aomega_contract_passes,
  FGMRESDeviceEngineConfig::fused_aomega_diagnostics, and
  FGMRESDeviceEngineState::fused_aomega_contract_passed.
- GREEN: just verify-fem-frequency-domain-native-contract passed after adding
  the fused Aomega diagnostics contract and wiring it into the FGMRES device
  engine config validation. This is still a contract gate, not a production
  runtime device FGMRES loop.
```

## Patch K - production optimization

Status:

```text
future; blocked by proof of contraction and residency.
```

## Priority correction after full read

Do not describe CPU sparse/direct, field-split, Schur certification, modal helper, or GPU API as entirely future. They have contract/prototype slices according to the patch queue. Do describe them accurately as incomplete for production large periodic-airbox workloads.
