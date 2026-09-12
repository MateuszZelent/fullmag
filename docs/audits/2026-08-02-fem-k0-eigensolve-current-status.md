---
title: FEM K0 dynamic-demag eigensolve current implementation status
date: 2026-08-05
status: implementation and qualification boundary
scope: cpu_gpu_modal_eigen_periodic_airbox_k0
---

# Current status

This report records the state of the K0 dynamic-demag eigensolve after the
worktree audit and the current implementation pass. It separates source
implementation, focused contract evidence, managed-runtime proof, and
production qualification. A source change or a passing synthetic fixture does
not promote a capability cell.

## Recovery snapshot (2026-08-05)

The current recovery worktree is `codex/eigensolve-k0-demag` at
`138d95325cee241fae1b6ffa44d3d7c883242cbf` with a dirty source snapshot
`8d6c8a993d9e6361f85430882d570233c6712c40489ab145d8888ba42742fbb5`. The
source and focused contract tests are current, but the managed runtime pointer
is stale relative to that dirty snapshot. A previous managed runtime with
PETSc 3.24.6/SLEPc 3.24.3 is usable for syntax diagnostics only; it is not
fresh execution evidence for the current source.

Fresh managed CPU/GPU qualification is currently blocked by the existing
`.fullmag/runtimes/.fem-gpu-host.export.lock`, held by a stale export process
outside this worktree. No new runtime export, device solve, convergence
matrix, CPU/GPU parity bundle, performance/residency proof, browser proof, or
release DOD record is claimed in this snapshot. The lock must be resolved and
the managed runtime rebuilt before those gates are rerun.

The performance verifier now requires hash-bound native diagnostics and
managed-runtime telemetry for every GPU performance row; summary-only or
hand-authored timing/residency fields are rejected. This closes the evidence
contract, but does not substitute for the missing fresh managed run.

The runner now canonicalizes native frequency-window diagnostics before they
reach artifacts-v2: GPU `executed_subwindows` and CPU/native `subwindows` are
published as sampled `subwindows[]`, failed/interrupted samples are mapped to
the contract status vocabulary, and requested/resolved search ranges plus the
fail-closed `not_certified` completeness state are always present. This fixes
the Spectrum metadata boundary; it does not certify the underlying window
count or promote the runtime.

The latest local verification pass adds full `fullmag-runner` library coverage
(`770/770` tests), 74 focused Python artifact/performance/runtime-target tests,
the masterplan full-pack drift check, and 142 focused Control Room tests plus
TypeScript typechecking. These are source and contract evidence only; they do
not replace a fresh managed CPU/GPU solve or browser-native field proof.

## Discretization boundary: FEM only

The implementation described in this report is **FEM-only**. The K0
periodic-airbox dynamic-demag eigensolve is available on the FEM CPU/GPU
lanes described below; it is not routed from the FDM planner or runner.
FDM currently provides time-domain demagnetization and FFT/spectrum analysis
of simulated time series, but it has no native modal eigenproblem solver and
therefore cannot produce the FEM `spectrum.v2`/mode-field eigensolve bundle.
The canonical physics note records that boundary in
`docs/physics/0600-fem-eigenmodes.md`; an FDM K0 eigensolver requires a
separate implementation and qualification scope rather than inheriting the
FEM claim.

## Master synchronisation (2026-08-03)

The recovery branch was synchronised with `master` twice because `master`
advanced during the first validation pass. The first merge was
`9908945c9002749cc9be087f44bff440f89e089a`; the current merge is
`b1fc084441808ec42b588c193d7c81df3e49a5e0`, with local `master` parent
`762aeffbfd7dce60791fc93533bee4ba1d117265` (the configured `origin/master`
ref remains older at `96b84512d4ae435f5198f73f9d56feaa96670d9e`). The latest
merge brings in the current CPU MFEM demag lifecycle/recovery/RHS changes, GPU
CUDA demag operator changes, OCC mesh validation, the SLEPc header alignment,
and the managed-image `PKG_CONFIG_PATH` contract.

The merge conflict in the GPU image definition was resolved in favour of the
qualified CUDA PETSc/SLEPc 3.24.6/3.24.3 stack already required by the K0 GPU
contract; the `master` demag and mesh changes remain intact. The post-merge
runtime artifacts below are historical after the current recovery snapshot
changed again. They refer to the then-fresh `b1fc0844418` snapshot and must
not be read as fresh evidence for `138d95325cee`.

## Worktree audit

The repository currently has 30 registered worktrees. The only worktree with
uncommitted K0 *content* changes in the native CPU/GPU, runner, and Control
Room owners is
`/home/kkingstoun/git/fullmag/fullmag/.worktrees/eigensolve-k0-demag-recovery`.
The recovery branch is `codex/eigensolve-k0-demag`, at merge commit
`b1fc084441808ec42b588c193d7c81df3e49a5e0`. The implementation and the
documentation described below remain intentionally uncommitted on top of the
merge; unrelated dirty work is preserved.

One other worktree needs an explicit distinction:
`/zfn2/mateuszz/git/fullmag/worktrees/fem-solver-optimization-remediation-current`
(`codex/fem-solver-optimization-remediation-current`, `ef0ee059`). It is
156 commits ahead and 15 commits behind the current local `master`, but its
5,187-file dirty state is overwhelmingly file-mode churn (5,155 mode-only
changes). The K0 CPU files there are mode-only changes; it has no
`backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu` and no competing
content version of the recovery GPU lane. Its committed history preserves the
older CPU SLEPc/dense-validation and GPU dense modal-validation work already
described by the readiness audit. The main checkout and that worktree were not
modified.

The ancestry check agrees with the file audit: recovery commit `5e3efe56`
(`feat(fem): add shared-domain K0 modal CPU GPU slice`) is reachable only from
`codex/eigensolve-k0-demag`. Older K0 contract commits such as `aba31046` and
`47b1c6aa` are already ancestors of the current `master`, so they are shared
baseline history rather than a second unpublished implementation.

The active normative references remain:

- `docs/plans/active/fd_sovler_masterplan/17_eigen_k0_gpu_readiness_audit.md`
- `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`
- `docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md`
- `docs/plans/active/fd_sovler_masterplan/24_production_definition_of_done.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`

## Implemented in this branch

### CPU

`poisson_airbox_schur_matshell.cpp` now contains the real-scalar Schur lane
for the shared-domain descriptor. It validates
`assembly_kind=mfem_weak_form_shared_domain`, certificate schema v6, the
real-split `real_frequency_rotated` representation, and the BC/gauge tuple;
builds persistent Poisson factorization state; applies the reduced Schur
operator through a MatShell; and reconstructs `phi` and the original block
residuals. It emits the adapter
`k0_poisson_airbox_cpu_schur_slepc` and rejects CPU fallback or static-demag
substitution.

`poisson_airbox_modal_eigen.cpp` dispatches the shared-domain descriptor to
that lane while retaining the synthetic algebraic oracle as a separate
validation-only contract. The runner recognizes the adapter and preserves the
native residual tolerance and solver provenance in artifacts-v2 diagnostics.

The managed FEM runtime previously produced a 15-field K0-3 sweep on the real
shared-domain mesh. The CPU run passed the artifact verifier after the PETSc
shifted-Schur factorization was given an SI-scaled zero-pivot threshold of
`1e-30`; its accepted frequency was
`1956981356.1280994 Hz` and its reconstructed original-block residual is
`4.940374972503828e-14`. The independent CPU mesh/airbox convergence study
remains the bounded CPU K0-3 qualification evidence (`M_eff=791111.1106133367
A/m`, 1.1111% relative error). These are bounded physics results, not a
blanket claim for nonuniform textures, damping, nonzero k, or arbitrary mesh
sizes.

### GPU

`modal_krylov.cu` owns persistent device CSR blocks, vectors, shifted action,
orthogonalization kernels, basis storage, and device residual certification.
The Arnoldi/Ritz path keeps full vectors and the hot operator loop on device;
only scalar/control state and the bounded projected Hessenberg are transferred
to the host. The projected Ritz extraction is deliberately disclosed as
`host_ritz_extraction=true` with
`ritz_state_location=host_small_projected`. Strict requests still have
`cpu_fallback=disabled`, but this adapter is explicitly
`validation_only=true` with `scalable_selected_spectrum=false`; it cannot
promote the production `gpu_modal_device_krylov` capability. Production GPU
modal execution uses the separate PETSc/SLEPc CUDA adapter below.

The PETSc/SLEPc adapter applies the same boundary to synthetic algebraic
fixtures: it emits `execution_lane=validation_gpu` and
`production_implication=false` whenever the request is validation-only, and
the runner rejects both `validation_only=true` and
`production_implication=false` at the final GPU promotion predicate.

The managed GPU runtime previously completed the same 15-field real shared-domain
K0-3 sweep on an NVIDIA GeForce RTX 4080 SUPER (compute capability 8.9,
CUDA 12.4, PETSc 3.24.6/SLEPc 3.24.3). The GPU artifact gate passed with
`solver_adapter=k0_poisson_airbox_gpu_petsc_slepc`, the Schur descriptor and
real-split shift-invert contract, `full_residual_certified=true`, no CPU
fallback, and zero per-iteration H2D/D2H full-vector transfers. Its accepted
frequency is `1956981356.1283116 Hz` and its reconstructed residual is
`3.3650808035851064e-11`. CPU/GPU frequency difference is
`0.00021266937255859375 Hz` (`1.0867215055095796e-13` relative). Those
pre-merge artifacts prove only the historical bounded executed-device physics
slice; they do not qualify the merged demag implementation or larger
matrix-free sizes, GPU mesh/airbox convergence, or the complete Chapter-24
release scope.

### Runner, artifacts, and Control Room

The runner propagates native `residual_tolerance`, selected-spectrum
provenance, GPU bounded-validation versus scalable-lane limitations, and
device-resident Krylov capability labels into artifacts-v2. Existing
`spectrum.v2`, `branches.v2`, dispersion, diagnostics, mode metadata, Zarr /
binary field resources, and manifest links remain the canonical data-plane
surface.

The recovery UI now has canonical K0 authoring controls for CPU/GPU intent,
`target=frequency_window`, `frequency_min`, `frequency_max`, periodic spin-wave
BC, `periodic_airbox_k0`, zero k, demag, equilibrium source, and damping. The
K0 smoke fixture supplies a valid preparation resource and accepted fixed-step
equilibrium, then verifies both device intents and canonical Python/IR
round-trip. Spectrum and mode-field inspectors already consume the v2 resource
families and hand off Real/Imag/Abs/Phase fields to the unified viewport. The
current 15-sample artifact contains `spectrum.v2`, `branches.v2`,
`dispersion.csv`, 15 mode metadata records, compatibility binary fields and
Zarr complex-vector fields. The inspector reports the number of ready
mode-field payloads instead of a hard-coded pending state.

The current implementation pass also changed the runner manifest writer to
carry native requested/resolved execution, solver method/preconditioner,
residency, fallback, assembly, boundary-gauge, spectral, and certificate/hash
provenance instead of synthesising a CPU/double classification. The focused
runner artifact suite passes 18 tests, including a strict GPU provenance
regression and a tamper-resistant provenance fixture.

Chapter-24 identity validation is now fail-closed in
`scripts/verify_fem_frequency_domain_production_dod.py`: it validates the
closed `frequency_domain_validation_scope.v1`, content-addressed
`scope_catalog.v1`, direct/coverage bindings, directional subset predicates,
and deterministic CSV/Zarr/binary sidecar hashes. Eleven focused tests cover
accepted direct and coverage scopes, catalog hash rejection, K0/Floquet
contradiction, directional interval rejection, missing sidecar rejection,
and accepted CSV/JSON evidence binding. No current runtime bundle emits a
complete Chapter-24 scope/catalog binding yet, so this validator intentionally
does not promote the existing bounded artifacts.

An independent exact-scope parity verifier now lives in
`scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py`. It compares
all shared K0 samples and modes, reconstructed residuals, strict requested and
resolved lanes, GPU residency/transfer telemetry, and an exact
lane-independent `operator_input_signature_sha256`. Independent CPU/GPU v6
equilibrium states are compared component-wise against an explicit `1e-9`
tolerance; lane-specific phase/equilibrium/linearization hashes remain
required provenance but are not falsely required to be bit-identical. The
focused parity suite passes 8 tests. Existing bounded artifacts predate this
signature and the master demag merge, so they intentionally fail closed until
fresh managed artifacts are rebuilt.

## Historical first post-merge managed evidence (superseded 2026-08-03)

The managed runtime was rebuilt from merge `9908945c9002749cc9be087f44bff440f89e089a`
with source snapshot `0e7fd34d117d59cab6e2668f31c7d177bf04e369001752bd7b584f70eef5536e`
and validated as an exact bundle (`5733` entries, compute capability `8.9`,
CUDA `12.4`, PETSc `3.24.6`, SLEPc `3.24.3`). The worktree is intentionally
dirty because this recovery branch contains the uncommitted implementation and
documentation changes; this is runtime identity evidence, not a release claim.

Fresh managed CPU and GPU runs completed the real shared-domain 15-sample K0-3
fixture. CPU accepted `k=0` frequency is
`1956981356.1281905 Hz` with full residual `3.368251709443301e-14`; GPU
accepted `k=0` frequency is `1956981356.1283116 Hz` with full residual
`4.810607373897376e-10`. Both lanes reported strict intent, no fallback, and
accepted `equilibrium_artifact.v6`/`LinearizationState.v6` sidecars for every
sample. The GPU run reported `fem_native_gpu`, `device_hypre_poisson`, and
device-resident modal execution with zero per-iteration full-vector transfers.

The fresh parity artifact is
`.fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox/cpu_gpu_parity.v1.json`:
all 15 samples passed, max frequency delta is `0.21249866485595703 Hz`
(`4.7722741140200655e-11` relative), max accepted-state vector delta is
`1.385925159166067e-20`, and max residual delta is
`4.810607373897376e-10`. The comparison used the exact lane-independent
`operator_input_signature_sha256` and a physical accepted-state tolerance of
`1e-9`; lane-specific provenance hashes remained bound rather than being
incorrectly compared bit-for-bit.

The fresh managed CPU convergence matrix passed with three distinct mesh sizes
and three distinct airbox sizes. Its aggregate artifact is
`.fullmag/reports/frequency-domain-eigen-k0-kittel-periodic-airbox-convergence/aggregate`;
the reported finest-two frequency deltas are `4.7822636609566816e-14` for the
mesh sequence and `0.003399624388728585` for the airbox sequence. The native
frequency-domain contract passed after explicitly configuring the shared
container CMake cache with `FULLMAG_FEM_WITH_SLEPC=ON`; the focused demag/Poisson
contract passed with exit code `0` after its intentional SLEPc-off configuration.

These runs closed the first post-merge execution/parity/convergence evidence
for the bounded K0-3 fixture, but they are superseded by the second master
merge below. They do not close production qualification: no GPU
mesh/airbox convergence matrix, three-size GPU performance proof with Compute
Sanitizer evidence, immutable Chapter-24 scope/catalog plus DOD-01..DOD-14
record, or live native browser smoke has been produced.

## Historical second master sync: fresh managed qualification (2026-08-03)

After `master` advanced to `762aeffbfd7dce60791fc93533bee4ba1d117265`, the
branch was merged as `b1fc084441808ec42b588c193d7c81df3e49a5e0`. The first
rebuild exposed a poisoned CMake cache: it retained PETSc 3.24.6 include paths
after a temporary distro-PETSc image, which produced a false `petscksp.h`
failure. The cache was not reused as evidence; the qualified pinned CUDA image
was restored and the managed export was rebuilt successfully.

The current managed runtime is an exact `5733`-entry bundle for commit
`b1fc084441808ec42b588c193d7c81df3e49a5e0`, source snapshot
`66e5759a3d1c37145777d35ddcbf59017df593fb2daf81cd6c670e9f6e53c142`, dirty
patch `ee30c69675312016cf8004e17803ef8d66e293913a45d35ba13eff3c3bdc9727`,
compute capability `8.9`, CUDA `12.4`, PETSc `3.24.6`, and SLEPc `3.24.3`.

Fresh managed CPU and GPU K0 runs both completed the real shared-domain
15-sample fixture. CPU accepted `k=0` frequency is
`1956981356.1281905 Hz`; GPU accepted `1956981356.1283116 Hz`. The GPU run
reported `fem_native_gpu`, `device_hypre_poisson`, strict no-fallback intent,
and device-resident execution. The CPU/GPU parity artifact passed all 15
samples with maximum frequency delta `0.21249866485595703 Hz`
(`4.7722741140200655e-11` relative), accepted-state vector delta
`1.385925159166067e-20`, and full residual delta
`4.810607373897376e-10`.

The fresh CPU convergence matrix also passed: three mesh and three airbox
levels, finest-two frequency deltas `4.7822636609566816e-14` (mesh) and
`0.003399624388728585` (airbox). These results confirm that the pulled demag
changes do not break the bounded CPU/GPU K0 execution slice. They still do not
promote the branch to production qualification: GPU mesh/airbox convergence,
three-size GPU performance and sanitizer proof, immutable Chapter-24
scope/catalog bindings, and live native browser proof remain open.

## Historical latest master sync and dynamic-demag recheck (2026-08-04)

The branch was pulled from the newest local `master` after the previous
qualification pass. The clean merge is
`c0010ed6c7740919134c590cb60ee34c9cbb4a88`; it contains current local
`master` commit `93b481bdd` (including the preceding `3181be696` demag-gate
identity refresh and `0560bd6de` FEM reference Slonczewski-v2 RHS).
`master...HEAD` is `0 51`. The configured `origin/master` is still
`b3c839b9c0d6a7cab99b8ad5c7b88007f7456a01`.
Tracked eigensolve changes and the unrelated untracked `native-debug/` artifact
were preserved; the merge had no conflicts.

The managed runtime was rebuilt and validated as an exact 5733-entry bundle
for `c0010ed6`, dirty source snapshot
`f89baa82b6190762501fefd41af0d2fbea2080f1d8b4f450ff36edf088c856ee`, CUDA
compute capability 8.9, and HYPRE 3.1.0. On that runtime:

- the CPU and GPU K0/Kittel periodic-airbox tests both pass with 15 distinct
  field samples and valid spectrum/branch/dispersion/mode-field artifacts;
- the lowest-frequency sample is `1956981356.1281905 Hz` on CPU and
  `1956981356.1283116 Hz` on GPU; the Kittel sweep maximum relative error is
  `0.01672403056750604` (CPU) and `0.016724030567445185` (GPU);
- the Poisson constraint residuals are `7.77394369135076e-16` (CPU) and
  `1.6645108404203045e-10` (GPU), while the certified modal residual maxima are
  `1.3784973306503879e-12` and `4.811420215307732e-10` respectively;
- the focused demag/Poisson contract passes in its intentional SLEPc-off
  configuration (wrapper exit code 0; the contained `PCG: No convergence!`
  line is the expected negative contract case);
- the coarse CPU/GPU equilibrium-demag parity gate passes all four pairs, with
  maximum demag residual `7.829564049780969e-13` and maximum component
  difference `1.1102230246251565e-16`.

The strict LLG time-domain qualification now passes all lanes after aligning
the comparator with the documented physical contract. CPU and GPU still use
different valid PG-BB directions (`exchange_plus_mass_tangent_gradient` and
`device_tangent_gradient`), so their independently relaxed endpoints are not
compared. The qualification artifact now persists the exact `handoff_m`; the
parity gate compares the subsequent common-time LLG increment instead. Fresh
managed results pass with demag residuals `6.609398211229491e-12` (CPU) and
`6.895738635308989e-12` (GPU), and common-time increment difference
`1.1086919238290349e-09` at `1e-15 s` (budget `5e-8`). This changes the
qualification comparator only; no demag tolerance or solver policy was
relaxed. The final `93b481bdd`/`3181be696` pull changes only BORIS tooling,
its `justfile` invocation, and demag-gate documentation; it does not change
the FEM native dynamic or eigensolve sources.

### Post-pull K0 rerun with path-provenance repair (2026-08-04)

The managed bundle was rebuilt once more after correcting the multi-k path
writer. The exact runtime is the 5733-entry bundle for `c0010ed6`, source
snapshot `5e777829355a523611c503c7ba30a5b9ece87618eade1d7b4856a929d805415e`,
dirty patch `e664a61d9f944d57359d5dbe6a0fe1e7b74113c5bcef0526bfe5a0c6c55532aa`,
CUDA compute capability 8.9, and HYPRE 3.1.0. The repair does not alter the
native modal calculation; it makes the path-level spectrum, branches, legacy
summary, and manifest agree with the executed lane.

Fresh managed CPU and GPU runs again passed the real shared-domain 15-sample
periodic-airbox fixture. The CPU artifacts now identify
`native_fem_modal_eigen/slepc_multi_shift_invert_production_cpu_dense`; the GPU
artifacts identify `native_fem_modal_eigen/gpu_modal_device_krylov`, while each
sample retains the native adapter (`k0_poisson_airbox_cpu_schur_slepc` or
`k0_poisson_airbox_gpu_petsc_slepc`). The GPU artifact gate passed with
`persistent_solver_context=true`, `scalable_selected_spectrum=true`,
`gpu_device_resident_modal_eigensolver=true`, zero per-iteration full-vector
transfers, `full_residual_certified=true`, `fallback_used=false`, and
`cpu_fallback=disabled`. The exact CPU/GPU parity verifier passed all 15
samples: maximum frequency difference `0.21249866485595703 Hz`
(`4.7722741140200655e-11` relative), accepted-state L2 difference
`1.385925159166067e-20`, and maximum full/block residual difference
`4.810607373897376e-10`.

This closes the provenance inconsistency in the path writer, not the broader
qualification boundary. The managed run remains a bounded 100-node/291-tet
fixture; GPU mesh/airbox convergence, larger selected-spectrum performance,
sanitizer evidence, immutable Chapter-24 scope/catalog bindings, and native
browser proof remain open.

### Fresh canonical planner and device-residual recheck (2026-08-04)

After the planner token was made canonical (`gpu_modal_device_krylov`, with a
legacy decode alias for `k0_poisson_airbox_gpu_petsc_slepc`) and the GPU modal
residual path was moved to persistent PETSc/CUDA workspaces, the managed
runtime was rebuilt from merge `138d95325cee241fae1b6ffa44d3d7c883242cbf`.
The strict CPU and GPU K0-3 Kittel targets were then executed again through the
container-backed `just` recipes.

Both fresh artifacts contain the real 15-point H0 sweep, with strictly
increasing accepted frequency. The CPU verifier passed with maximum Kittel
relative error `0.01672403056750604`, maximum modal residual
`1.3784973306503879e-12`, and Poisson residual
`7.77394369135076e-16`. The GPU verifier passed with maximum Kittel relative
error `0.016724030567445185`, maximum modal residual
`4.811420196734392e-10`, and Poisson residual
`1.66451064351267e-10`. The paired CPU/GPU sweep differs by at most
`0.21249866485595703 Hz` (`4.7722741140200655e-11` relative).

The GPU diagnostics report `execution_lane=production_gpu`,
`solver_algorithm=gpu_modal_device_krylov`, `gpu_device_resident_modal_eigensolver=true`,
`device_residual_certification=true`, `per_iteration_full_vector_transfers=0`,
`fallback_used=false`, and `cpu_fallback=disabled`. This is fresh evidence for
the bounded K0-3 physics slice; it does not close the separate GPU
mesh/airbox-convergence, larger-spectrum/performance, sanitizer, DOD
scope/catalog, or browser-native-proof gates listed below.

The separate CUDA `modal_krylov.cu` contract was corrected on this sync: its
host-projected Hessenberg/Ritz extraction is now emitted as
`validation_gpu_operator_host_krylov`, `validation_only=true`, and
`scalable_selected_spectrum=false`. The runner has a regression guard that
rejects `host_ritz_extraction=true` before assigning the production
`gpu_modal_device_krylov` model. The corrected CUDA source compiled in the
qualified image, the CPU/SLEPc native contract returned `0`, the targeted
runner regression passed, and the focused Python/docs suite passed (`254`
tests). This correction removes a false promotion path; it does not provide
the missing device-backed GPU qualification evidence.

### Fresh direct production-scope CPU execution (2026-08-04)

The new production-scope example
`examples/fem_eigen_k0_poisson_airbox_production.py` was executed through the
managed container route after the runner provenance repair. This is a fresh
shared-domain P1 FEM solve, not the Kittel validation fixture: 100 nodes, 291
tetrahedra, one $k=0$ mode, and accepted frequency
`6329462315.583798 Hz`. The native CPU adapter was
`k0_poisson_airbox_cpu_schur_slepc`; the reconstructed full residual was
`3.503778719772536e-14`; and the artifact verifier passed with strict CPU,
periodic-airbox, no-fallback, and no-Kittel-metadata checks.

The managed target then stopped at the deliberate production gate. The
validation-bundle writer emits a fail-closed `frequency_domain_production_dod.v1`
record with DOD-01 through DOD-14 open until independent evidence is supplied;
the run is therefore executable evidence, not `production_qualified` status.
The current environment has no NVIDIA driver, so a fresh direct GPU production
fixture was not executed in this pass; the earlier managed GPU Kittel run
remains bounded device evidence only.

The CPU production target now uses a dedicated `fem-modal-cpu` Compose service
which mounts the same pinned PETSc/SLEPc runtime image without requesting
`gpus: all`. This keeps a missing host NVIDIA driver from blocking a strict
CPU run while preserving the separate fail-closed GPU service. The target was
rerun through that service on 2026-08-04: the native shared-domain artifact
verifier passed, and only the deliberate Chapter-24/DOD promotion gate stopped
the recipe. Control Room typecheck is also green after forwarding the
`react-resizable-panels` layout-change metadata; the focused K0 inspector,
viewport, resource-policy and layout tests pass (`135/135`).

The browser smoke fixture now exposes modal CPU as
`partial_production_executable` and modal GPU as `source_visible`; it no longer
claims `production_qualified` while the immutable DOD record and fresh
executed-device evidence are open. A static runtime-target test protects this
fail-closed UI boundary.

The native shared-domain contract now also executes independent affine-P1
tetrahedron oracles for the assembled `A_phiq` source block and `B_qq`, with
deliberate sign-flip negative controls. This verifies the volume/4 source
integral, the P1 mass identities `V/10` and `V/20`, and both production signs
without reusing the production MFEM integrator; it is assembly evidence, not a
substitute for the complete Chapter-24 promotion record.

FDM remains outside this modal contract: it has time-domain demagnetization and
FFT/time-series spectrum analysis, but no native modal eigensolver or FEM
`spectrum.v2`/mode-field bundle. Any FDM K0 modal solver requires its own
implementation, artifacts, and qualification scope.

## Historical evidence collected (b1fc snapshot)

| Evidence | Result | Boundary |
|---|---|---|
| Native C++ CPU syntax checks with SLEPc disabled | pass | compile/syntax only |
| Diagnostic container build and `fem_poisson_airbox_modal_eigen_slepc_contract` | `CONTRACT_EXIT:0` | synthetic/native contract; not managed production proof |
| Managed 15-field CPU K0-3 sweep | fresh second-sync pass | real shared-domain x/y-periodic Kittel fixture; k=0 `1956981356.1281905 Hz`, full residual `3.368251709443301e-14` |
| Independent CPU convergence: 3 mesh levels + 3 airbox levels | fresh second-sync pass | bounded K0-3 CPU evidence; `M_eff` error 1.1111%, mesh finest-two Δf `4.7822636609566816e-14`, airbox finest-two Δf `0.003399624388728585` |
| GPU 2x2 Robin/gauge fixture | pass when CUDA is available | bounded device contract |
| GPU 67-DOF Arnoldi/Ritz fixture | pass when CUDA is available (`CONTRACT_EXIT:0`) | device BiCGStab plus device 2x2 block-Jacobi; bounded host-projected Ritz extraction; `scalable_selected_spectrum=false`; validation contract only |
| `cargo check -p fullmag-runner --lib` | pass | Rust compile only; verified with the configured persistent cargo cache |
| runner native Poisson-airbox tests | 5 pass | artifact/contract mapping |
| runner eigen artifact tests | 17 pass | artifacts-v2 mapping |
| Control Room focused tests | 385 pass, then 35 regression tests pass | component/resource contract |
| Control Room full suite | 465 files pass, 1 skipped; 4310 tests pass, 1 skipped | no remaining UI test failures in this worktree |
| Control Room typecheck | pass | Next route types and the K0 UI surface compile |
| Recovery K0 browser smoke | pass, 7 model transactions | fixture-backed authoring/export/viewport path |
| Managed runtime build and CPU K0 verification | fresh second-sync pass | commit `b1fc084441808ec42b588c193d7c81df3e49a5e0`, source snapshot `66e5759a3d1c37145777d35ddcbf59017df593fb2daf81cd6c670e9f6e53c142`; exact 5733-entry bundle validation passed |
| Managed runtime GPU K0 verification on RTX 4080 SUPER | fresh second-sync pass | real shared-domain 15-field sweep; `fem_native_gpu`, device Hypre Poisson, strict no-fallback |
| Managed production-scope CPU launch without host GPU | fresh 2026-08-04 pass | dedicated `fem-modal-cpu` service, native artifact verifier pass; DOD promotion remains fail-closed |
| CPU/GPU accepted-frequency parity | fresh second-sync pass | max absolute difference `0.21249866485595703 Hz`, relative `4.7722741140200655e-11`; canonical operator signature equal |
| CPU/GPU accepted-state parity | fresh second-sync pass | max component/vector deltas `1.3264969153228109e-20` / `1.385925159166067e-20`, tolerance `1e-9`; v6 sidecars bound to diagnostic hashes |
| CPU/GPU full residual certification | fresh second-sync pass | max residual `4.810607373897376e-10`; per-sample full residual and block residual gates passed |
| Spectrum, branches, dispersion and mode-field artifact set | pass | 15 samples; binary compatibility payloads and Zarr complex vectors |
| Runner native execution/provenance manifest propagation | pass | 18 focused artifact tests; GPU requested/resolved/residency/fallback and certificate/hash fields are preserved |
| Chapter-24 scope/catalog/sidecar validator | pass | 11 focused tests; current bundles remain blocked until a complete runtime binding is emitted |
| Independent CPU/GPU K0 parity verifier | 8 focused tests and fresh second-sync 15-sample run pass | exact lane-independent operator signature, accepted v6 sidecars, physical state tolerance, strict lanes, and GPU residency all verified |
| Native frequency-domain contract with SLEPc enabled | fresh pass | container-backed CMake configuration `FULLMAG_FEM_WITH_SLEPC=ON`; all chained contract executables completed |
| Shared-domain independent quadrature/sign oracle | fresh pass, exit code 0 | analytic affine-P1 tetrahedron `A_phiq` oracle plus independent `B_qq` mass oracle (`V/10`, `V/20`) and sign-flip negative controls; no production-integrator reuse |
| Control Room typecheck and focused K0 UI tests | typecheck pass; 135 focused tests pass | Spectrum/mode inspector, viewport handoff, resource policy and layout callback contracts |
| Control Room stale-evidence health gate | full suite pass after fail-closed stale handling | stale render snapshots now display `unknown` instead of a false `ready` diagnosis |
| Focused demag/Poisson native contract | fresh pass, exit code 0 | intentional SLEPc-off CMake configuration; CPU Poisson recovery and CUDA demag contract chain completed |
| Latest master pull and managed runtime | pass | merge `c0010ed6` containing `master=93b481bd`; exact 5733-entry runtime, source snapshot `f89baa82b6190762501fefd41af0d2fbea2080f1d8b4f450ff36edf088c856ee` |
| Post-pull CPU/GPU K0 recheck | pass | 15-sample shared-domain periodic-airbox sweep; CPU/GPU lowest frequency `1956981356.1281905` / `1956981356.1283116 Hz`; no GPU fallback |
| Post-pull dynamic demag recheck | pass | four coarse CPU/GPU equilibrium pairs pass; strict LLG CPU/GPU FP64 lanes and common-time increment parity pass (`1.1086919238290349e-09`) |
| Post-pull path-provenance repair and K0 rerun | pass | exact 5733-entry runtime; CPU path labels `slepc_multi_shift_invert_production_cpu_dense`, GPU path labels `gpu_modal_device_krylov`; native adapters, residual certification, residency, no-fallback, and 15-sample parity all pass |

The browser smoke is fixture-backed. It proves the interaction and round-trip
contract, not a physical native solve or an executed GPU device result.

## Historical DOD-01 through DOD-14 boundary (b1fc snapshot)

Fresh evidence now covers the bounded managed CPU and GPU K0-3 physics slice,
CPU/GPU parity, CPU mesh/airbox convergence, partial DOD-02 (Python/UI
round-trip), partial DOD-07 (native contracts), and partial DOD-09 (v2
resources plus browser handoff). The remaining DOD items stay open for the
full product claim because the GPU path has only been executed at the bounded
materialized-size fixture, GPU mesh/airbox convergence and the three-size
performance/residency envelope are incomplete, the immutable coverage catalog
and negative-gate evidence are incomplete, and the release bundle is not
closed.

In particular, the following claims are not yet legal:

- production-qualified CPU shared-domain Poisson-airbox K0 beyond the bounded K0-3 fixture;
- production-qualified GPU shared-domain Poisson-airbox K0 beyond the executed bounded fixture;
- broad/scalable GPU selected-spectrum qualification and >1024-DOF matrix-free proof;
- GPU mesh/airbox convergence and performance qualification;
- promotion of `modal_gpu_k0_periodic_airbox_scalable` in the readiness matrix.

## Required next promotion steps

1. Produce the missing GPU mesh/airbox convergence matrix and a >1024-DOF
   matrix-free selected-spectrum case; keep bounded materialized and broad
   scalable claims separate.
2. Produce a real three-size GPU performance/residency proof with context
   reuse/invalidation, zero hot-loop transfers/allocations, bounded memory and
   Compute Sanitizer error count zero. The performance verifier intentionally
   rejects hand-written or inferred timing evidence.
3. Complete the Chapter-24 coverage catalog and CSV/JSON sidecars, negative
   gates, and DOD-01..DOD-14 validators before promoting any readiness cell to
   `production_qualified`. The production `just` recipes intentionally fail
   closed until the scope catalog and `frequency_domain_production_dod.v1`
   record exist.
4. Keep the strict LLG cross-lane contract on the documented common-time
   increment comparison. Any future relaxation-policy change must preserve
   independent lane certificates and must not reintroduce direct endpoint
   equality as a proxy for demag parity.

## Source and symbol map

| Contract | Source owner |
|---|---|
| CPU Schur reduction | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` (`solve_poisson_airbox_schur_matshell`) |
| CPU dispatch | `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` (`solve_poisson_airbox_modal_eigen`) |
| GPU production modal lane | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` (PETSc/SLEPc CUDA real-split adapter) |
| GPU validation-only modal lane | `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu` (`cuda_modal_problem_supported`) |
| Native GPU diagnostics | `modal_petsc_slepc.cpp` production diagnostics plus `write_gpu_diagnostics` in `modal_krylov.cu` validation diagnostics |
| Runner provenance/artifacts | `crates/fullmag-runner/src/fem_eigen.rs` (`merge_poisson_airbox_modal_result_diagnostics`, `native_modal_artifacts`) |
| Canonical CPU/GPU input signature | `crates/fullmag-runner/src/fem_eigen.rs` (`shared_domain_identity`) |
| CPU/GPU parity and state tolerance | `scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py` (`compare_bundles`) |
| UI authoring | `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx` |
| UI K0 smoke | `apps/control-room/scripts/smoke-study-authoring-ui.mjs` (`authorK0ModalDemagForDevice`) |
