# FDM solver audit remediation ledger

- Source audit: `docs/audits/2026-07-19-fdm-solver-audit.md`
- Physical contract: `docs/physics/0970-fdm-remediation-physical-contract.md`
- Status vocabulary: `open` means no remediation has begun; `in progress`
  means a scoped change and its narrow evidence exist, but the stated gate is
  not complete; `closed` requires the stated acceptance evidence. No row may
  be marked closed only because source code exists.

Every finding below has one implementation owner stage and one gate. A gate
must fail before its fix where a regression test is practical, then pass after
the fix. Required CUDA evidence is a managed device run, not a no-device CTest
success.

| Finding | Stage | Required implementation outcome | Acceptance evidence | Status |
|---|---:|---|---|---|
| FDM-EXEC-001 | 2 | Typed forced GPU request fails when unavailable; auto retains fallback trail on every run path. | planner and batch/live/interactive/hysteresis unavailable-GPU tests | closed |
| FDM-XCH-001 | 5 | T0/T1 FP64 applies exchange stiffness exactly once and clears inactive output. | manufactured Laplacian plus stale-buffer CUDA test | in progress |
| FDM-SUBCELL-FP32-001 | 5–6 | FP32 sub-cell field/energy is implemented with parity or rejected before ABI launch. | strict planner rejection or FP32 field-energy parity gate | closed |
| FDM-DEMAG-ABI-001 | 6 | Auto-Newell either uploads validated spectra or returns unavailable. | native ABI missing-spectra failure test | closed |
| FDM-DMI-001 | 7 | CUDA bulk-DMI field has canonical variational sign. | chiral-helix CPU/CUDA sign and derivative gate | in progress |
| FDM-SOT-001 | 10 | CPU and CUDA SOT convert the field amplitude through `gamma_mu0` and the Gilbert projection before adding RHS torque. | CPU macrospin and CUDA source contracts; device amplitude/unit oracle still required | in progress |
| FDM-MASK-001 | 10 | Single-grid CUDA LLG RHS freezes inactive cells before every torque contribution. | FP64/FP32 source contract; device evolution test still required | in progress |
| FDM-CPU-001 | 9 | CPU batch uses thermal, spatial material, and resolved PBC plan data. | batch/snapshot materialization identity tests | closed |
| FDM-THERM-002 | 9 | CUDA uses the attempted `dt`, bare `gamma_mu0`, and a seed/accepted-step/cell counter; the ABI resolves entropy when its seed is zero. | native and CPU Brown contracts; replay and variance CPU/CUDA device gate still required | in progress |
| FDM-ML-001 | 11/14 | Native-stacked Zeeman energy has no self-energy half factor. | two-layer analytic Zeeman energy test | closed |
| FDM-ML-DRIVE-001 | 4/14 | Multilayer field drives are lossless or fail closed. | planner rejection test until plan owns drives | closed |
| FDM-ENERGY-001 | 11/13 | Regional drive participates in the canonical conservative energy used by minimizers. | regional-drive finite-difference gradient test | closed |
| PYIR-001 | 3 | Material-only anisotropy round-trips without unsupported energy tags. | Python JSON to Rust IR and script round-trip test | closed |
| UI-OVERRIDE-001 | 17 | One versioned override schema is emitted and consumed by Rust/Python/rendering. | cross-adapter schema equivalence test | open |
| UI-EXEC-001 | 17 | Execution selection survives SceneDocument to script to ProblemIR. | UI transaction round-trip equality test | open |
| UI-FIELD-001 | 17 | Regional field drives survive model sync and script export. | changed-drive export/parse equality test | open |
| FDM-THERM-003 | 3/9 | `ThermalNoise(temperature, seed)` lowers into one FDM temperature/seed policy, flat-script rewrites preserve it, and unmaterialized `H_therm` fails explicitly instead of emitting an empty field. | planner lowering/rejection tests, CPU materialization test, Python flat-script round-trip | closed |
| FDM-T0-002 | 5 | Unsupported boundary SDF is strict failure, never warning-only downgrade. | unsupported-shape planner rejection test | closed |
| FDM-T0-003 | 5/11 | Partial-cell weights are shared across fields and energies. | partial-cell derivative and weighting identity tests | open |
| FDM-PBC-001 | 3 | Python rejects FEM-only PBC modes for FDM at authoring time. | Python API invalid-PBC test | closed |
| FDM-DMI-002 | 7 | Free-surface bulk DMI is rejected until a natural boundary closure exists. | open-boundary planner rejection; fully periodic DMI remains legal | closed |
| FDM-DMI-003 | 7 | Unsupported interface normals and spatial DMI material fields are rejected before native launch. | non-+z-normal and `dind_field` planner-rejection tests | closed |
| FDM-ANI-001 | 8 | CPU and CUDA share public Kc3 semantics. | Kc3-specific cubic-minima parity test | in progress |
| FDM-OE-001 | 4/10 | CPU Oersted capability matches executable dispatch. | plan legality/reason-code test | closed |
| FDM-OE-002 | 10/12 | Oersted supports documented axes and stage time. | rotated-cylinder and RK order tests | open |
| FDM-STT-001 | 10 | CUDA Zhang-Li upwind stencils consume all planned periodic axes; the common RHS already freezes inactive cells. | FP64/FP32 source contract; periodic-seam and inactive-mask device tests still required | in progress |
| FDM-OBS-001 | 11 | Dynamic CUDA `StepStats` now maps cubic anisotropy and DMI exactly as the snapshot adapter; CPU observable H_eff also includes cylindrical Oersted, matching the stepping field. | dynamic mapping source contract and CPU cache regressions pass; CUDA device identity test remains required | in progress |
| FDM-OBS-002 | 11 | CPU FDM materializes `H_dmi` through the direct DMI accessor; CUDA FDM rejects that output until its native observable is materialized. | CPU quantity materialization test; CUDA planner fail-closed guard | closed |
| FDM-OBS-003 | 11 | CPU AoS/SoA scalars now include static cylindrical Oersted energy; native CUDA FP64/FP32 reductions include `oersted_field_scale * H_oe_static` under a managed source contract. | CPU scalar-total and derivative tests plus managed native CPU/CUDA source contract; device numerical parity remains required | in progress |
| FDM-INT-001 | 12 | Native magnetization uploads reset FSAL and ABM history through one helper. | ABI/source contract; restart and discontinuity device equivalence tests remain required | in progress |
| FDM-INT-002 | 9/12 | Planner rejects adaptive Brown dynamics until an accepted-step SDE replay contract is qualified. | planner rejection test; rejected-attempt replay device test remains deferred | in progress |
| FDM-INT-003 | 4/12 | Adaptive CUDA is planner-illegal until runtime identity exists. | CUDA-adaptive legality test | closed |
| FDM-ML-002 | 4/14 | Every multilayer profile advertises only its executable scope. | profile matrix planner/UI gate test | open |
| FDM-ML-003 | 14/15 | Assisted multilayer records host-authoritative residency plus measured vector H2D/D2H counts and bytes in execution provenance. | CUDA-feature transfer-counter and provenance-contract tests | closed |
| CAP-001 | 4/16 | Host, intrinsic, and session legality have distinct owners/shared reasons. | planner/API/UI same-reason test | open |
| CAP-002 | 4 | Capability entries match executable Oersted, SOT, thermal, and magnetoelastic scope. | capability-catalog contract test | closed |
| IR-001 | 2/3 | FDM plans retain typed literal requested/resolved integrator provenance and artifact finalization emits public lower-case values; `gpu_count>1` now fails at Python/ProblemIR boundary because no multi-GPU realization exists. Runtime-selection metadata key unification remains open. | CPU/CUDA provenance round-trip plus Python/ProblemIR multi-GPU rejection tests; browser metadata contract still required | in progress |
| IR-002 | 3 | `allow_single_grid_fallback` is removed or produces explicit provenance. | public API migration test | closed |
| IR-003 | 3/8 | Easy-plane anisotropy has one public material semantic. | anisotropy validation parity test | closed |
| UI-002 | 17 | PBC, thermal/seed, and torque are authored or absent from writable UI. | supported-control round-trip and deferred-control tests | open |
| UI-003 | 17 | RK4/ABM3 and lane-specific legality appear in the study UI. | inspector model and command-gating tests | open |
| UI-004 | 16/17 | Artifact resource revision precedes facade/hook/browser implementation. | revision, facade, and Results resource tests | open |
| UI-RELAX-001 | 17 | Global relaxation is rendered and exported under canonical schema. | solver.relax export/parse test | open |
| API-ART-001 | 16 | Artifact revision/ETag changes for replacement and provenance. | ETag/invalidation integration test | open |
| API-OAS-001 | 16 | CI compares generated OpenAPI with checked-in contract. | generation drift test including remove_field_drive | open |
| API-004 | 3/16 | Runtime selection values are typed and validated at scene PATCH boundary. | invalid-enum API and scene validation tests | open |
| TEST-001 | 17 | Authoring test runs actual Scene to script to parse to ProblemIR path. | non-mocked canonical round-trip test | open |
| TEST-002 | 17/18 | Browser smoke uses current selectors and a real runtime. | CPU browser smoke artifact | open |
| TEST-GPU-001 | 18 | No-device CTest becomes explicit skip; required GPU lane fails when skipped. | CMake skip metadata and executed-case count | open |
| VALID-001 | 18 | Each public CPU/CUDA capability row has a managed qualification gate. | versioned per-lane manifests and artifacts | open |
| VALID-002 | 18 | SP4 compares trajectories, crossing/map, convergence, and parity. | checksummed NIST-reference SP4 artifact | open |
| ARCH-001 | 1 | One compiled owner per runner/native function; orphan trees removed or isolated. | module/CMake active-graph test | in progress |
| ABI-001 | 15 | ABI separates success/warning/error from last error. | C ABI status contract test | open |
| ABI-002 | 2/15 | Invalid execution policy and GPU index fail validation. | ABI/public validation tests | open |
| ABI-003 | 15 | CUDA architecture/build availability is toolchain-defined and distinguished from solver availability. | managed build metadata gate | open |
| API-001 | 16 | Run-level status preserves stage reason. | run resource schema/API test | open |
| API-002 | 16 | API commands have no `as never` escape in handwritten facade. | TypeScript type-use test | open |
| API-003 | 16 | preview cache has an owner and removal criterion. | architecture guard and resource-owner test | open |
| API-005 | 16/17 | Export does not mutate/save the active script implicitly. | command side-effect contract test | open |
| DOC-001 | 18 | Physics checklists report implemented/executable/validated/production accurately. | documentation ledger consistency check | open |
| IR-004 | 3/16 | Dead MaxPseudotime stop reason is removed or emitted canonically. | IR/OpenAPI stop-reason contract test | open |

## Gate closure rule

Closing a row requires fresh command output or a stored managed artifact that
covers the stated evidence. It also requires a review of the linked change
against the physical contract. A passing narrow test cannot close a broader
CPU/CUDA/multilayer or UI round-trip row.
