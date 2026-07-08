---
title: Frequency-driven solver - validation, certification and benchmarks
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Validation, certification and benchmarks

## 1. Physics gates

```text
G1 phase convention and chirality under exp(+i omega t)
G2 dynamic-field drive projection: b = -gamma T^T(m0 x delta_h)
G3 Cartesian/tangent roundtrip and m0·delta_m constraint
G4 zero-drive policy
G5 relaxed equilibrium consistency
G6 periodic/Floquet tangent-transfer
G7 DMI status gate
```

## 2. Algebra gates

```text
A1 real split equals complex form
A2 full-coupled vs Schur explicit apply
A3 full residual reconstruction from Schur solution
A4 sparse/direct vs dense tiny
A5 modal response vs dense/sparse sample points
```

## 3. Schur thresholds

```text
tiny dense:     <= 1e-10
CPU matrix-free <= 1e-8
GPU/HYPRE       <= 1e-6 initially
```

Runtime quality:

```text
eta = ||r - A P^-1 r|| / ||r||
```

```text
eta <= 0.30: good
0.30-0.70: bounded run only unless pilot confirms
0.70-0.90: weak, not default
>0.90: do not choose by default
>1.05: harmful, auto-disable unless forced debug
```

## 4. Stagnation policy

Do not run long 8192 solves when 64/256 show no contraction:

```text
if relres_256 / relres_0 > 0.9 and relres_256 > 1e-2:
    status = solve_error
    stop_reason = stagnated
```

## 5. Benchmark matrix

| Case | Purpose | Required backends |
|---|---|---|
| macrospin | phase/drive/damping | dense Cartesian/tangent |
| macrospin/Kittel k0 field sweep | eigen k=0 field scaling and thin-film FMR | modal eigen artifact verifier |
| standing spin waves | exchange/eigen | modal + sparse sample |
| skyrmion small | nonuniform m0 | relaxed texture + tangent gates |
| thin-film demag small | full vs Schur | full-coupled + Schur + sparse |
| periodic antidot small | PBC/Floquet/demag | mesh certificate + full-coupled |
| periodic antidot large | production | full-coupled/Schur/GPU when certified |
| wide sweep | speed | modal-reduced + sparse/direct samples |

## 6. Current status after full read

Patch queue reports many native contract gates already green for Patch D-J slices. The G5 relaxed-equilibrium gate now has native coverage for the missing accepted `LinearizationState` planner case and for builder-level v5 reject reasons/signature mismatches, verified by `just verify-fem-frequency-domain-native-contract` on 2026-07-07.

The modal/eigen k0 validation path now has a dedicated artifact-level Kittel
gate: `scripts/verify_fem_frequency_domain_eigen_artifacts.py
--require-k0-kittel-field-sweep`. It requires a zero-k branch over at least
three bias-field samples and checks either the macrospin Larmor law or the
in-plane thin-film Kittel formula declared in
`metadata.execution_plan.backend_plan.k0_kittel_validation`. This is the first
promotion gate before using larger periodic antidot or periodic-airbox modal
cases as evidence.

PA-E1 dense Poisson-airbox modal-eigen oracle evidence from 2026-07-08:
`just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle`
passed through the managed FEM runtime route. The gate builds and runs
`fem_poisson_airbox_eigen_oracle_contract`, which verifies the synthetic dense
full-coupled algebra for `k=0`: mean-zero augmented Poisson gauge,
matrix-free Schur apply vs explicit Schur, full descriptor residual
reconstruction, positive-frequency branch selection using
`frequency_hz = imag(lambda)/(2*pi)`, synthetic demag-factor Kittel-like
frequency, sign-flip negative detection, explicit rejection of production
`demag_kind=periodic_airbox_k0` claims in PA-E1, and
`poisson_airbox_eigen_oracle.v1` diagnostics JSON. This closes the PA-E1
algebraic oracle gate only; real MFEM sparse/SLEPc Poisson-airbox eigensolve,
Schur MatShell, K0-3 thin-film demag validation, and GPU modal parity remain
separate later gates.

PA-E2 CPU sparse/full-coupled SLEPc modal-eigen evidence from 2026-07-08:
`just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`
passed through the managed FEM runtime route. The gate builds and runs
`fem_poisson_airbox_modal_eigen_slepc_contract`, which verifies the internal
`PoissonAirboxEigenBlockProblem` path: monolithic SeqAIJ assembly of the full
augmented descriptor pencil, mean-zero augmented Poisson gauge, SLEPc
Krylov-Schur shift-invert with PCLU/pivoting factorization, positive-frequency
branch selection, full descriptor residual reconstruction from the returned
eigenvector, gauge residual, rejection of PA-E1 synthetic demag kinds, and
frequency agreement against the PA-E1 dense oracle. The broader
`just verify-fem-frequency-domain-native-contract` also passed after PA-E2.
This closes the PA-E2 tiny sparse/full-coupled SLEPc gate only; Schur
MatShell, K0-3 thin-film demag validation, real FEM-airbox mesh extraction,
and GPU modal parity remain separate later gates.

PA-E2/PA-E4b runner-output seam evidence from 2026-07-08:
the C++ modal-eigen result JSON now includes the Poisson-airbox DOF counters
and residual fields needed by K0-3 artifacts:
`q_dof_count`, `phi_dof_count`, `augmented_phi_dof_count`,
`poisson_constraint_relative_residual`, and
`relative_reference_frequency_error`. The runner has a focused parser that maps
only `solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc` plus
`demag_kind=periodic_airbox_k0` into
`K0KittelPeriodicAirboxDemagMetrics`, rejecting generic modal JSON. Verified
by `CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner
native_poisson_airbox`, `just
verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`, and `just
verify-fem-frequency-domain-native-contract`. This is still a data-contract
bridge, not K0-3 real thin-film validation; real FEM-airbox mesh extraction and
small-film matrix assembly remain open.

PA-E3 CPU Schur MatShell evidence from 2026-07-08:
`just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell`
passed through the managed FEM runtime route after rebuilding the managed
runtime bundle. The gate builds and runs
`fem_poisson_airbox_schur_matshell_contract`, which verifies the internal
`certify_poisson_airbox_schur_matshell_cpu` path: PETSc MatShell creation,
matrix-free Schur apply
`S(q) = A_qq q + A_qphi phi(q)`, reuse of the same mean-zero augmented Poisson
setup, Schur-specific rejection of invalid `phi_mean_weights` before Schur
certificate key construction with
`poisson_airbox_schur_requires_mean_zero_gauge`, sampled MatShell-vs-explicit Schur agreement, full sparse PA-E2
reference frequency agreement, full descriptor residual reconstruction, Schur
certificate key emission with mesh/material/m0/h_eff0/static_demag/boundary/k/
gauge/operator signatures, and planner policy requiring an explicit
`schur_reduced` request in addition to an accepted certificate. The broader
`just verify-fem-frequency-domain-native-contract` also passed after PA-E3.
This closes the PA-E3 tiny Schur MatShell certification gate only; K0-3
thin-film demag validation, real FEM-airbox mesh extraction, public Python/API/
IR exposure, and GPU modal parity/runtime remain separate later gates.

G6 now has certificate-level native coverage for bijective periodic pair maps, duplicate-pair rejection, schema marker `periodic_mesh_certificate.v5`, stable order-independent `fnv1a64:` magnetic/airbox pair-map fingerprints, canonical `sha256:` magnetic/airbox pair-map hashes, explicit nonidentity tangent-frame transfer storage as row-major `G_pair` 2x2 blocks, rejection of inconsistent paired equilibrium directions with `periodic_m0_seam_mismatch`, optional same-step `H_demag0` seam rejection with `periodic_static_demag_seam_mismatch`, and required Poisson gauge policy rejection with `periodic_poisson_gauge_policy_missing`. The full certificate-level pair-map, `G_pair`, seam/gauge, fingerprint, and `sha256:` hash slice passed `just verify-fem-frequency-domain-native-contract` after a managed runtime rebuild on 2026-07-07.

Runtime artifact integration has begun: `response/diagnostics/input_preflight.v1.json`
now includes a `periodic_mesh_certificate.v5` preflight candidate section with
canonical `sha256:` magnetic and airbox pair-map hashes for the actual
frequency-response lane input. The remaining gap is production integration and
larger-case validation, especially complete relaxed texture handoff, native
runtime consumption of periodic/Floquet `G_pair`, propagation of the accepted
seam/gauge/fingerprint/hash certificate beyond preflight into every solver-lane
artifact, full-coupled FEM field-split, certified Schur on real periodic-airbox
workloads, and true runtime device FGMRES.

Follow-up evidence from 2026-07-08: the runtime artifact verifier now requires
periodic-airbox solved bundles to carry a consistent
`input_preflight.periodic_mesh_certificate` snapshot in both
`response/diagnostics/solver.v1.json` and
`frequency_domain/manifest.v1.json`. It validates the v5 schema marker,
canonical pair-map hash token format, and exact magnetic/airbox pair-map hash
agreement between the two artifact surfaces. This closes a verifier-level
propagation check for the certificate hashes; it still does not mean the native
solver consumes accepted `G_pair` transfer blocks.

Second follow-up evidence from 2026-07-08: frequency-point artifacts now carry
the same `input_preflight.periodic_mesh_certificate` snapshot inside
`response/frequency_points/frequency_XXXX.json` under
`demag_contribution.input_preflight`. The verifier rejects a frequency-point
bundle when its magnetic or airbox pair-map hash differs from
`response/diagnostics/solver.v1.json`. The refreshed managed
`just run-fem-periodic-antidot-frequency-driven-managed-headless` target passed
with `GMRES=2006/8192`, `relative_residual_l2_norm=9.994399206910052e-4`, and
matching certificate hashes in solver diagnostics, manifest diagnostics, and
`frequency_0000.json`. This extends hash propagation into per-frequency
demag-result artifacts; accepted native `G_pair` consumption remains open.

Third follow-up evidence from 2026-07-08: the verifier now rejects
periodic-airbox certificate snapshots that are internally nonsensical even when
all artifact copies agree. The solved-bundle checks require positive magnetic
and airbox pair counts, canonical `periodic_mesh_certificate.v5` schema,
canonical pair-map hash token format, boolean
`tangent_frame_transfer_required`, and a known
`tangent_frame_transfer_artifact_status` value. Focused tests cover both
`magnetic_pair_count=0` and an unknown transfer status.

Fourth follow-up evidence from 2026-07-08: the runtime artifact verifier now
honors the v5 bounded-run stagnation policy. `--allow-solve-error` no longer
requires a failed GMRES bundle to reach `max_iterations_for_frequency` when the
solver reports `stop_reason=stagnated`, `stagnation_detected=true`, matching
`stagnation_iteration`, `stagnation_relative_residual_ratio > 0.9`, and
`relative_residual_l2_norm > 1e-2`. Focused tests cover an early
`total_iteration_count=256` / `max_iterations_for_frequency=8192` periodic
airbox solve-error bundle and the existing bounded solve-error rejection cases.

Fifth follow-up evidence from 2026-07-08: the verifier now has an explicit
future promotion gate,
`--require-accepted-periodic-mesh-certificate`. This flag requires solved or
bounded solve-error periodic-airbox bundles to report
`input_preflight.periodic_mesh_certificate.tangent_frame_transfer_artifact_status`
as `accepted_native_certificate_consumed` and also requires
`tangent_frame_transfer_block_count == magnetic_pair_count` plus a canonical
`tangent_frame_transfer_blocks_row_major_2x2_sha256` token. The default
solved-bundle verifier still accepts the current
`pending_native_certificate_consumption` compatibility state, so this does not
claim that the present solver consumes `G_pair`; it creates a concrete artifact
gate for the implementation that will.

Sixth follow-up evidence from 2026-07-08: the Rust frequency-response input
preflight candidate now derives deterministic tangent-frame transfer-block
evidence from the compact magnetic periodic pairs and relaxed `m0` slice. The
candidate certificate publishes `tangent_frame_transfer_block_count` and
`tangent_frame_transfer_blocks_row_major_2x2_sha256` when the C++-compatible
tangent frames can be built from unit `m0`. The certificate status remains
`pending_native_certificate_consumption`, so this is transfer-block provenance,
not accepted solver-lane consumption.

Seventh follow-up evidence from 2026-07-08: K0-3 thin-film demag Kittel
validation now has a first synthetic-demag managed runtime gate. The verifier
flag `--require-k0-kittel-demag` requires `case_id=K0-3`, model
`thin_film_in_plane`, supported demag-kind metadata, and matching K0-3 metadata
in `validation/kittel_k0_pbc/summary.v1.json` and `points.v1.csv`. The
implemented runtime slice is explicitly `demag_kind=synthetic_demag_factor`
with `production_periodic_airbox_claim=false`; it validates branch/artifact
plumbing against `sqrt(H0(H0+M_eff))` but does not claim real periodic-airbox
Poisson demag. `just verify-fem-frequency-domain-eigen-k0-kittel-demag-cpu`
now passes through the managed FEM runtime route. The slice also hardens
planner and runner gates so gamma-only K0-3 `synthetic_demag_factor` Floquet
field sweeps can execute while ordinary Floquet dynamic demag remains rejected.
The verifier accepts `binary_compatibility_exports` mode-field metadata for
this synthetic K0-3 artifact class as well as zarr-backed mode fields.

Eighth follow-up evidence from 2026-07-08: the PA-E2 Poisson-airbox modal
eigensolver now consumes minimal periodic-mesh certificate metadata at the
native descriptor and C ABI boundary. The accepted schema token is
`periodic_mesh_certificate.v5`; magnetic and airbox pair counts must be
positive; missing metadata is rejected with
`poisson_airbox_eigen_requires_periodic_mesh_certificate`; and diagnostics
record the consumed schema and pair counts. Verified gates:
`just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`,
`just verify-fem-frequency-domain-native-contract`, the focused Rust ABI layout
test, and the focused Rust runner native-Poisson-airbox tests. This gate proves
certificate plumbing, not final real-mesh full-coupled Poisson assembly.

Ninth follow-up evidence from 2026-07-08: PA-E2 now has a negative native gate
against decoupled demag blocks. A valid-shape CSR descriptor with zero
`A_qphi` and zero `A_phiq` entries is rejected with
`poisson_airbox_eigen_requires_full_coupled_blocks`; the passing fixture still
requires nonzero q-phi and phi-q coupling and full residual reconstruction.
This prevents reporting a no-demag eigenproblem as `periodic_airbox_k0`.

Tenth follow-up evidence from 2026-07-08: the Rust runner now guards the
modal-window dispatch boundary by requiring a structured PA-E4b payload for
K0-3 validation requests that ask for `demag_kind=periodic_airbox_k0`. A first
macrocell/Kittel payload builder now constructs nonzero `A_qphi` and `A_phiq`
CSR blocks, attaches `poisson_airbox_block_problem` to
`NativeModalEigenRequest`, and keeps ordinary gamma/Floquet native modal-window
eligibility unchanged. The builder requires positive magnetic and airbox
periodic pair counts derived from mesh element markers and periodic node pairs,
so a K0-3 request without real pair maps is rejected instead of being promoted
with synthetic counts. It also requires positive airbox geometry metadata:
`air_box_config.factor` and mesh extent must both be positive. Payload
dimensions now scale with real pair-map counts (`q=2*magnetic_pairs`,
`phi=2*airbox_pairs`) instead of remaining fixed at the toy `2/2` size. This
payload also weights `A_phiphi` by airbox periodic-pair geometry, so the
Poisson block is no longer identical for equal-count but different-length
airbox maps. `B_qq` also uses lumped magnetic element volumes, so the magnetic
mass block is no longer a unit diagonal for unequal magnetic cell volumes.
Eleventh follow-up evidence from 2026-07-08: the same PA-E4b runner payload
now weights `A_qphi/A_phiq` by a mesh-derived coupling scale using magnetic
pair lumped mass divided by the associated airbox periodic-pair length, rather
than constant `demag_delta` and unit Poisson-source entries. A focused Rust test
first failed on unchanged coupling values for different airbox lengths and now
passes. This narrows the validation payload toward geometry-sensitive coupling;
it is still not the final shared-domain MFEM Poisson-airbox weak-form
assembler.
Twelfth follow-up evidence from 2026-07-08: PA-E4b runner gauge weights now
come from airbox geometry instead of a uniform `1/phi_dof_count` vector. Each
airbox periodic-pair length contributes a normalized weight split across that
pair's two phi DOFs. A focused Rust test first failed on equal weights for
unequal airbox-pair lengths and now passes, proving the mean-zero augmented
gauge row receives geometry-sensitive weights from the runner payload.
Thirteenth follow-up evidence from 2026-07-08: native PA-E1/PA-E2 gauge
validation now requires `phi_mean_weights` to be finite, strictly positive, and
normalized to sum to one before the Poisson-airbox solve is attempted. The
dense oracle gate first failed on negative weights, then passed after explicit
validation was added. The CPU SLEPc gate also passes with zero/negative
gauge-weight rejection cases, and the Schur MatShell fixture now carries the
same periodic mesh certificate metadata required by the PA-E2 sparse reference.
This is a wired block validation payload, not the final shared-domain MFEM
Poisson-airbox assembler.

Eighth follow-up evidence from 2026-07-08: the same K0-3 verifier now rejects
real periodic-airbox claims unless they include real-airbox evidence, and it
now has a stricter `--require-k0-kittel-periodic-airbox-demag` gate for the
future PA-E4b production path. `--require-k0-kittel-demag` remains the shared
K0-3 demag gate and may validate the PA-E4a synthetic-demag slice. The stricter
periodic-airbox flag requires `demag_kind=periodic_airbox_k0`; synthetic K0-3
artifacts fail that gate. When `demag_kind=periodic_airbox_k0`,
`summary.v1.json` must report
`gauge_policy=mean_zero_augmented`, positive `phi_dof_count`, an augmented
phi size larger than the physical phi dofs, a Poisson constraint residual not
exceeding `1e-8`, positive magnetic and airbox pair counts, and
`production_periodic_airbox_claim=true`. It must also include
`validation/kittel_k0_pbc/convergence.v1.csv` with mesh resolution, airbox
size, phi dof count, Poisson residual, Kittel frequency error, and effective
magnetisation. Focused verifier tests for K0 Kittel now pass 10 selected
cases, and the periodic-airbox focused pair now passes 2 selected cases:
acceptance with convergence and synthetic-artifact rejection. This is still
verifier hardening; the real K0-3b FEM film/shared-airbox run remains to be
produced.

Ninth follow-up evidence from 2026-07-08: the runner artifact path now has a
positive internal contract for future real PA-E4b metrics. `PathSolveResult`
carries optional `K0KittelPeriodicAirboxDemagMetrics`, and
`demag_kind=periodic_airbox_k0` Kittel artifacts are accepted only when those
metrics prove positive mesh/airbox scales, positive physical and augmented phi
dofs, Poisson residual `<= 1e-8`, positive magnetic and airbox pair counts,
positive effective magnetisation matching the Kittel metadata, and
non-negative relative Kittel frequency error. When accepted, the writer emits
`summary.v1.json`, `points.v1.csv`, and `convergence.v1.csv` under
`validation/kittel_k0_pbc`. Focused runner tests cover both rejection without
metrics and acceptance with real-metrics-shaped input. This is still not the
real FEM film/shared-airbox solve; it is the artifact seam the solver must now
populate.

Tenth follow-up evidence from 2026-07-08: the PA-E2 full-coupled
Poisson-airbox eigensolve is no longer reachable only through a direct C++
helper test. `FullmagFemModalEigenRequest` now exposes a Poisson-airbox block
payload with CSR `A_qq`, `A_qphi`, `A_phiq`, `A_phiphi`, `B_qq`, q/phi dof
counts, mean-zero gauge weights, and target/reference frequency. The C++ API
bridge maps this payload into `ModalEigenRequest`, and
`solve_modal_eigen_contract` dispatches it to
`solve_poisson_airbox_modal_eigen_cpu_slepc`. The managed
`just verify-fem-frequency-domain-native-contract` gate passed with a
`fem_modal_eigen_contract` test proving the public C ABI path reaches the
full-coupled SLEPc adapter and reports `periodic_airbox_k0` plus
`mean_zero_augmented`. This validates the ABI seam; real small-film matrix
assembly and K0-3 artifact metrics are still pending.

Eleventh follow-up evidence from 2026-07-08: the runner multi-k K0 Kittel path
now consumes native PA-E2 diagnostics when a real `periodic_airbox_k0` single-k
solve emits them. It maps only
`solver_adapter=k0_poisson_airbox_cpu_full_coupled_slepc` diagnostics into
`K0KittelPeriodicAirboxDemagMetrics`, derives mesh/airbox/pair-count/M_eff
metadata from the FEM eigen plan, rejects missing or inconsistent metadata, and
aggregates the worst Poisson residual / Kittel error across the sweep. Focused
checks passed:

```text
CARGO_TARGET_DIR=/tmp/fullmag-target cargo test -p fullmag-runner k0_kittel
  11 passed

python3 -m pytest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py -k 'k0_kittel'
  11 passed
```

This proves the artifact path is connected; it does not yet prove real
small-film shared-domain matrix assembly.
