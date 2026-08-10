# Subagent-driven development progress

## Plan: FEM single-layer prism/pyramid shared domain

- Worktree: `/home/kkingstoun/git/fullmag/fullmag/.worktrees/fem-mixed-prism-pyramid-runtime`
- Branch: `codex/fem-mixed-prism-pyramid-runtime`
- Integrated base: `6f695afa2ddb5c0780cb1e1daa632baff0c8de86`
- Source plan: `/home/kkingstoun/git/fullmag/fullmag/docs/plans/active/2026-07-27-fem-single-layer-prism-pyramid-shared-domain.md`

| Slice | Status | RED evidence | GREEN evidence | Reviews | Commit |
|---:|---|---|---|---|---|
| 1 | complete | missing fixture; import-order and boundary-set guards reproduced | focused Gmsh 1 passed; co-collection 1 passed/251 deselected | spec compliant; quality approved | `0b12322b..cf2d0b3c` |
| 2 | complete | missing canonical typed CSR/strict mixed topology; review reproduced lossy Jacobian/ordinal/interface/fingerprint/API guards | Python 43; IR 52+148; plan 247; runner 10+artifact; CLI 13; API 691; Control Room 3808; strict resource/contract guards | three review rounds; final approved with no findings | `76199c84..7a790d46` |
| 3 | complete | old fixed tet/tri ABI; review reproduced unchecked facet geometry, unbound manifest ABI, incomplete layout assertions, overflow and non-isolated build artifacts | parser/manifest 46; runner ABI 1; native sys 31; material and full managed export/validator/demag exit 0; active variant `66284f27` | three review rounds; final approved with no findings | `9ef6afe8` |
| 4 | complete | native prism path initially split to tet; remediation reproduced silent hex-to-prism relabel, non-durable/false provenance, permissive numeric ingress, invalid dimensions, wrong realized plane count, and hidden requested/resolved degradation | mixed+fallback 104; swept regression 3; compileall and diff-check exit 0 | three review rounds; final approved with no findings | `923a39ad` |
| 5 | complete | shared-domain route absent; remediation reproduced overlapping air tets, circular CAD volume evidence, mutable certificate claims, incomplete interface coverage, ignored authored controls, environment-dependent threads, scaling gaps, and strict-wire coercions | mixed 146; API 263; final-wave 14; compileall and diff-check exit 0; production verifier mixed/API components pass | four review rounds; final task-scoped approval with no findings; overall production gate still blocked by recorded baseline/external evidence | `4d5c3627` |
| 6 | complete with concerns | stale layered state, lossy authoring round-trip, ineffective interface ramp, overlapping transition tets, and pyramid p05 below 0.1 reproduced | mixed+fallback 178; DSL/round-trip 30 + 47 subtests; authoring 57; full meshing 254 + 19 subtests with one baseline failure | two review waves; final task-scoped approval; production gate still blocked by missing evidence/runtime and proven baseline periodic-facet bug | `4f47893a` |
| 7 | complete | stale/self-certified mixed certificate, saturating cross-language node quantization, planner repacking, partial API mesh parts, and CLI artifact certificate drop reproduced | IR 64+149; planner 248; API focused 1; managed mixed-wire CLI 5; no-feature API check; targeted fmt/diff checks | certificate, planner, and CLI/API reviews independently approved with no findings | `14a7f009` |
| 8 | complete (fail-closed interim) | certified mixed plans could bypass through per-object assets, backend auto, materialized planned-runtime entrypoints, stale/self-consistent certificate evidence, false capability provenance, or empty topology | IR 70+149; planner 254; runtime topology guard 7; capability gate runner 10 + Python 6; API check; diff-check all pass | independent capability and runtime reviews approved after closing auto/runtime/status/legacy-tet findings | `a0a6b2e2` |
| 9 | complete | FMMT v1 fixed-arity payload, lossy mixed aliases, unchecked Range identity/length, concurrent full serialization, stale capability projection, and missing typed rejection/fallback publication reproduced | FMMT/API focused 23+; mixed API 7; OpenAPI typed truth; ControlRoom API codec 102; cache/range/304 guards; IR fallback presence 1 | independent data-plane and capability reviews approved after strong-ETag, bounded-cache, current-rejection precedence, stale-capability, and fallback-tristate remediation | pending |
| 10 | complete | tet-only viewport faces/edges/quality, unsafe facet-ID fallback, Tri3/Quad4 collision, disabled-control JSON bypass, and misleading airbox labels reproduced | viewport/scoped focused 140; full Control Room 420 files / 3963 tests; typecheck; lint zero warnings; diff-check pass | independent UI/viewport reviews approved after positional facet identity and mixed CSR quality remediation | pending |
| 11 | pending | pending | pending | pending | pending |
| 12 | pending | pending | pending | pending | pending |

Task 0.1 documentation remediation: complete (commit dea075a0, review clean).

Task 4.1 native MFEM mesh builder: complete. RED reached the managed target and
failed on the missing builder header. GREEN evidence is
`just verify-fem-mixed-p1-native-contract` with explicit separate CPU and CUDA
rollback processes, plus `just verify-fem-time-domain-native-contract` with
Rust ABI 31/31. Four implementation/review-fix commits:
`5ef3ff06`, `afa01f0f`, `bba70b74`, `3a847139`. Three independent review waves
closed lifecycle, orientation, rollback-matrix, and false-positive source-test
findings; final verdict `Ready: Yes` with no Critical or Important issues.
The public mixed solver remains fail-closed before material/MFEM/GPU startup.

Task 4.2 generic mixed-P1 measures and nodal materials: complete. Production
MFEM magnetic mass row sums are the canonical integration weights and feed the
compatibility node-volume copy and Ms-weighted averages. Uniform and legal
nodal-P1 Ms/A material realizations work on prism/pyramid/tet meshes; DG0 stays
fail-closed. Review remediation added a non-affine prism oracle that
distinguishes MFEM row sums from volume/arity and validates nodal Ms/A through
the real validator plus `GridFunctionCoefficient` evaluation. Managed
`just verify-fem-mixed-p1-native-contract` passed including CPU/CUDA rollback
processes. Independent final review: approved with 0 Critical/Important.
Commits: `83b69feb`, `44ce8ef2`. The public mixed solver remains fail-closed
until Task 4.3 exchange and Poisson operators are complete.

Task 4.3 mixed CPU exchange/Poisson/relaxation implementation is source- and
contract-complete but remains product status `implemented`. The first public
unlock commit `bdb60758` did not qualify `production_executable`: independent
review found missing enclosing build-report fallback/degradation checks,
destructive managed-device overlay provenance, and no exact managed public SP4
runtime report. Review remediation now requires explicit empty certificate and
report fallback trails, `degraded=false`, separate authored and managed-launcher
device requests, and one effective device source shared by runner topology and
engine resolution. CPU promotion remains blocked until a fresh managed public
SP4 run stores immutable topology fingerprint, CPU engine/device identity,
empty fallback trail, solver telemetry, and artifacts. GPU and auto remain
rejecting.

The review-required public-runtime precursor is now named
`just verify-fem-mixed-prism-airbox-runtime`. It generates a one-step temporary
copy of the exact SP4 projected-gradient scenario and validates immutable
managed CPU artifact identity without changing the authored source. Source and
validator contract tests do not promote status. Fast Python coverage exports
the base and relaxation-stage overlay without real assets; the standalone
real-asset helper export is an explicit
`FULLMAG_RUN_SLOW_REAL_ASSET_TESTS=1` diagnostic. The non-skipping managed
recipe is the authoritative exact-source runtime gate. Task 4.3 remains
`implemented` until that managed command itself passes with reviewed evidence.

## Plan: FEM K0 eigensolve Poisson-airbox CPU/GPU i Control Room

- Worktree: `/home/kkingstoun/git/fullmag/fullmag/.worktrees/eigensolve-k0-demag-recovery`
- Branch: `codex/eigensolve-k0-demag`
- Source plan: `docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`

N1b canonical map binding: complete source-level, independent review approved;
managed MFEM/runtime proof remains open.

N1c runner linearization descriptor: complete source-level, independent
re-review approved after fixing full-global `3N` importer semantics, runner FFI
envelope tests and validation-only `A_qq` oracle. `certificate_binding_v6`
remains `NULL`, aggregate gate remains closed, and N1d owns the full typed v6
preimage/relation producer. No commit was created because this is a shared dirty
recovery worktree.

N1d runner-owned certificate v6 producer: complete source-level, final
independent re-review `SPEC APPROVED / QUALITY APPROVED`. The canonical IR
producer separates magnetic-prefix and global-scalar evidence; the runner
regenerates and compares the complete accepted certificate, constructs all four
owned views, byte-aligns the native preimage and
`shared_domain_map_binding.v1`, validates the trusted ordered multi-part
registry for one physical magnetic object plus airbox, and keeps all nested ABI
v18 pointers alive. The real-plan-like fixture covers `body +
hole_transition_refinement + air` with magnetic markers 1/2, shared nodes,
x/y edge/corner closure and open z. Fresh focused evidence: IR 6/6,
`modal_v6_` 8/8, `shared_domain` 13/13, `native_fem` 22/22, routing 1/1,
no-default and fem-native no-link checks PASS, scoped diff-check PASS. Managed
MFEM/CUDA runtime proof remains open and belongs to N1e/integration.

N1e periodic-antidot eigen script slice: complete source-level, final
independent re-review `SPEC APPROVED / QUALITY APPROVED`. Added the separate
`examples/fem_periodic_antidot_relax_eigenmodes.py` without changing the
frequency-driven FMR example. Canonical Python export proves CPU
`relax -> eigenmodes` and GPU `relax -> change_device -> eigenmodes` with
devices `[cpu,gpu,gpu]`, strict/double, `full_2x2`, K0,
`periodic_airbox_k0`, bounded window and spectrum/dispersion/mode outputs.
Fresh evidence: Python 7/7 plus 5 subtests, canonical pipeline and public
CPU/GPU run-config PASS, three focused Rust typed producer/CPU routing/strict
GPU rejection tests each real 1/1, py_compile and diff-check PASS. The
accidentally zeroed `script_builder.py` was restored exactly from branch HEAD
with explicit user approval and has no diff. Managed MFEM solve remains open:
export lock inode 77593 is still owned by Antigravity ptyHost TID 816338 while
the recipe's flock waiter has been blocked for more than one day.

## Global constraints

- Native mixed topology is `prism6` in the magnet, `pyramid5` only in air transition, and `tet4` in far air; facets are `tri3 | quad4`.
- `layers=1` means exactly two magnetic node planes.
- Strict mode never silently splits or falls back to tetrahedra.
- Unsupported physics and topology combinations fail before backend startup.
- FEM builds and runtime proof use repository container-backed `just` recipes first.
- Preserve the dirty master checkout and the user-owned SP4 scenario edit.
- Slice 8 does not complete plan Task 3.2 positive mixed-P1 CPU/GPU execution: native exchange/demag operators remain absent, so the canonical product status is `unsupported` and every mixed plan rejects before backend startup.

Task 8.1 matrix-smoke evidence mode: complete (commits af33bed2..26f04b60, review clean; 94 executor/planner/runtime-verifier tests passed).
Managed runtime SONAME evidence fix: complete (commits 26f04b60..087a7411, review clean; 64 canonical bundle tests and 95 SP4 matrix/runtime-verifier tests passed).
Control Room Thin Film authoring slice: complete (commits 087a7411..bc6290a4, review clean; 93 targeted tests, typecheck, and zero-warning targeted ESLint passed).

Task 3 (GPU K0 B_qq compile blocker): complete (commit f6f018c4c, independent
spec/quality review approved with no findings; source contract and diff-check
pass). Fresh managed GREEN remains the next integration gate.

Task 4 (CLI Eigenmodes bias_field_sweep merge blocker): complete (commit
7766c1231, independent spec/quality review approved with no findings; focused
regression, cargo check, rustfmt, and diff-check pass). Fresh managed GREEN
remains the next integration gate.
