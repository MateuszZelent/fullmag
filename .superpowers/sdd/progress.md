# Subagent-driven development progress

Simulation preparation failure diagnostics Task 1: complete (working-tree evidence; 31/31 focused tests, typecheck, independent re-review approved; no commit by policy).
Simulation preparation failure diagnostics Task 2: complete (working-tree evidence; mounted 12/12, typecheck, independent re-review approved; browser gate delegated to Task 3; no commit by policy).

## Plan: Solver audit remediation (2026-08-22)

- Worktree: `D:\\git\\fullmag`
- Branch: `master` (jawnie zatwierdzony przez użytkownika)
- Source index: `docs/superpowers/plans/2026-08-22-solver-audit-plan-index.md`

| Lane task | Status | Implementer | Review |
|---|---|---|---|
| FDM CPU Task 1 (`FDM-CPU-NUM-001`) | complete (`7eeed7d1e` + `1046b8691`) | `fdm_cpu_num001_impl` | approved after strict-shrink/test-seam fix wave; 2/2 integration + 7/7 controller tests |
| FDM GPU Task 1 (`FDM-GPU-ABI-001`) | complete (`8372823d4` + `5561fbb4c` + `9d7afa886`) | `fdm_gpu_abi001_impl` | approved after semantic-ingestion and nested-layout fix waves; 0 Critical/Important/Minor; managed CUDA gate remains environmentally blocked by missing Docker/WSL integration |
| FDM GPU Task 2 (strict residency proof) | complete (`e6e133344` + `ff6b15ac9` + `0039b71ce` + `fe2e6dc03` + `12dc1d736` + `78f06dfa5` + `b44e3272b`) | `fdm_gpu_abi001_impl` | approved after six fix waves; 0 Critical/Important/Minor; manifest/self-test 193/193 and host CTest 2/2 pass; native managed CUDA qualification remains fail-closed because Docker Desktop containerd storage is read-only |

## Plan: Frontend 3D visualization FEM/FDM remediation (2026-08-20)

- Worktree: `/home/kkingstoun/git/fullmag/fullmag`
- Branch: `master` (jawnie zatwierdzony przez użytkownika)
- Source plan: `docs/superpowers/plans/2026-08-20-frontend-3d-visualization-fem-fdm-remediation.md`
- Commit policy: no automatic commits or pushes; task reviews use task-scoped working-tree evidence.

| Task | Status | Implementer | Review |
|---:|---|---|---|
| 0 | complete (source/CI contracts) | `frontend3d_task0_impl` | approved after TOCTOU fix wave; real managed/browser baseline remains BLOCKED |
| 1 | complete (source contracts) | `frontend3d_task1_impl` | approved after two Critical fix waves; real delayed-session browser proof remains BLOCKED |
| 2 | partial (source/API contracts) | `frontend3d_task0_impl` | `ResolvedQuantityProviderRegistry` z `CompatibilityProfile`/`ResolvedPlan`; pięć planes i generyczne carriery; `compute_fields` dla braku/compat/empty registry fail-closed, a FDM multilayer `H_demag` jest target-only Airbox; OpenAPI 1.15 MB/current, frontend quantity/catalog/Ribbon 16/16 + viewport 51/51/typecheck/hygiene, API 13/13 + 28/28 + 1/1, runner lib check PASS; `quantities::tests::` 6/6 i `capabilities::tests::` 20/20 PASS po lane-aware FEM CPU/GPU `H_drive`/`eden_drive` korekcie; `QUANTITY_ITEMS` usunięto, lecz mapy shape/unit, pełny provider/materializer/active-term registry i runtime/browser pozostają otwarte |
| 3 | partial (F3D-S01/S02 source contracts) | `frontend3d_task1_impl` | canonical Airbox aliases and resolver mapping; exact FMRM/native-mask admission with zero-worker fail-closed scheduler; persisted display/session migration now canonical-only with bounded warning and ambiguous-legacy fail-closed; focused frontend 302/302, typecheck/lint/diff-check pass; per-entry revision/timestamp schema, stale/fingerprint provenance and runtime/browser remain open |
| 4 | complete (source contracts) | `frontend3d_task1_review2` | quantity-only fallback removed; exact carrier consumer required, including fail-closed `consumers:[]` regression; 230 graph tests and typecheck pass; browser/runtime remains blocked |
| 5 | blocked (source contracts verified) | `frontend3d_task5_impl` | final review approved; stored exact-frame bundle, resolver-driven provider selection, terminal-first admission, production heartbeat and connectivity path verified at source level; API/CLI/OpenAPI execution, managed FEM and four-lane black-box remain blocked by unrelated Frozen Spins/IR compile state and environment |
| 6 | complete with concerns (source contracts) | `frontend3d_task0_impl` | approved after route-fixture/requestId fix wave; transaction-scoped pending/ACK, target-scoped last-good and structured v2 lifecycle/debug export verified; final primary suite 368/368 (independent review 261/261), typecheck/diff-check pass; browser/WebGL reject-before/during/after remains blocked |
| 7 | complete (source contracts) | `frontend3d_task7_impl` | approved after four review waves; ACK/adoption identity, bounded fail-closed lifecycle and canonical durable quantity request/ACK proof verified; real browser/runtime capture remains Task 12 |
| 8 | blocked (source contracts verified) | `frontend3d_task8_impl` | review approved after two fix waves; teardown/root-owned invalidation, StrictMode lifecycle, bounded reasons and resource-zero audit verified; real Chromium/WebGL 100-switch remains blocked by SIGTRAP |
| 9 | complete (source contracts) | `frontend3d_task9_impl` | approved after three review waves; byte-first cache budgets, bounded counters, quantity/orbit gates and durable raw proof artifacts verified; real browser/WebGL qualification remains Task 12 |
| 10 | complete with concerns (source contracts) | `frontend3d_task1_impl` | canonical-only CLI launcher, legacy runtime hygiene gate and backup-suffix gate verified; Vitest 18/18, typecheck/rustfmt/diff-check pass; Cargo test blocked by unrelated Frozen Spins/IR compile errors, browser/runtime remains blocked |
| 11 | complete (source/CI contracts) | `frontend3d_task11_impl` | review approved after fix wave; five visible contexts, real GitHub identity-bound proof writer, strict schema and fail-closed missing-runner/intentional-failure gates verified; actual GitHub/browser/managed run remains blocked |
| 12 | blocked (runtime qualification) | `frontend3d_task7_impl` | final report `.superpowers/sdd/frontend3d-task-12-report.md`; source/CI evidence is partially approved, but real API/models, four lane matrix, browser/WebGL, managed FEM and GitHub proof remain unavailable; do not report production PASS |

## Plan: Frozen spins production implementation (2026-08-20)

- Worktree: `/home/kkingstoun/git/fullmag/fullmag`
- Branch: `master`
- Source plan: `docs/superpowers/plans/2026-08-20-frozen-spins-production-implementation.md`
- Commit policy: no automatic commits or pushes; task reviews use task-scoped working-tree diff packages.

| Task | Status | Implementer | Review |
|---:|---|---|---|
| 1 | complete | task1_docs + task1_fix | review approved; focused docs gates clean |
| 2 | complete | task2_geometry + task2_fix | review approved; planner 389/389, API 14/14, generated contract 9/9 |
| 3 | complete | task3_python_geometry + task3_fix | review approved; focused 40/40; broad 313 passed, 1 skipped, 1 unrelated baseline failure |
| 4 | complete | task4_selection_ir + task4_fix + task4_quality | review approved; Python 78/78, Rust 22/22, docs validator 23/23 |
| 5 | complete | task5_frozen_constraint + task5_fix | review approved; fullmag-ir 321/321, Python 77 + 4 subtests, planner check |
| 6 | complete | task6_selection_compiler + task6_fix | review approved; planner 19/19, IR 3/3, full plan+IR 805/805, docs/diff gates clean; execution lanes UNQUALIFIED |
| 7 | complete | task7_api_impl | review approved; API 26/26, planner 19/19, authoring 91/91, OpenAPI 2/2, frontend contract 10/10; broad 630 passed with 5 known unrelated baseline failures; runtime/scientific/browser lanes UNQUALIFIED |
| 8 | implemented, qualification partial | task8_fdm_cpu_impl + task8_fdm_cpu_review | canonical single-grid ProblemIR→FdmPlan ingress, final-RHS masking, candidate restore, free/all telemetry and all-frozen path; focused runner/planner/IR tests green; full scientific qualification remains open |
| 9 | implemented, qualification partial | task9_fdm_minimizer | PG-BB/NCG free-domain reductions, frozen trial restore and unequal multilayer offset restore; focused runner tests 5/5 green; multilayer execution remains fail-closed |
| 10 | partial / fail-closed | task10_fdm_cuda | append-only ABI, C++ ABI 1/1, Rust FFI 1/1, managed CUDA gate 1/1 and capability guard green; native CUDA kernels/integrators/minimizers are not implemented, capability remains disabled |
| 11 | partial / fail-closed | task11_fem_descriptor | FEM true-DOF planner mask/reference and append-only native descriptor materialized; managed FEM build green; native consumer rejects with typed `frozen_spins_fem_unqualified` |
| 12 | blocked | — | native FEM CPU/MFEM mask/restore/reduction consumer is not implemented; execution fails closed before backend startup |
| 13 | blocked | — | native FEM GPU device-resident consumer is not implemented; execution fails closed before backend startup |
| 14 | pending / unqualified | — | checkpoint persistence of dense mask/reference and activation epoch is not wired; no restart claim |
| 15 | partial / browser blocked | task15_control_room | FDM API/ribbon/Explorer/dedicated Inspector/FMSK overlay source contracts and 93 focused tests green; FEM command disabled; real browser/WebGL proof unavailable |
| 16 | blocked | — | qualification matrix updated only from executable evidence; CUDA/FEM scientific lanes and browser gate remain open |

## Plan: Compositional physics object authoring (2026-08-13)

- Worktree: `/home/kkingstoun/git/fullmag/fullmag/.worktrees/fdm-gpu-public-m1-spin`
- Branch: `codex/fdm-gpu-public-m1-spin`
- Plan commit: `f2594cc5ff6e70e8b9377c252c7574962c112c38`
- Protected unrelated file: `.superpowers/sdd/task-1-report.md`

| Task | Status | Implementer | Review |
|---:|---|---|---|
| 1 | fixes pending | `260238ce4` | migration targets/references review findings |
| 2 | pending | — | — |
| 3 | pending | — | — |
| 4 | pending | — | — |
| 5 | pending | — | — |
| 6 | pending | — | — |
| 7 | pending | — | — |
| 8 | pending | — | — |
| 9 | pending | — | — |
| 10 | pending | — | — |
| 11 | pending | — | — |
| 12 | pending | — | — |
| 13 | pending | — | — |

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

## FDM GPU public pure-Neumann charge (2026-08-11)

- Branch: `codex/fdm-gpu-public-neumann`
- Integrated base: `4bdfdd064fd937b92a3448008568807cf4a4f6c3`
- Source plan: `docs/superpowers/plans/2026-08-11-fdm-gpu-public-neumann.md`

| Task | Status | RED evidence | GREEN evidence | Reviews | Commit |
|---:|---|---|---|---|---|
| 1 | ledger closure re-review pending | I1: mały niezbilansowany $5\times10^{-13}\,\mathrm{A}$ był akceptowany przez ukrytą skalę $1\,\mathrm{A}$; I2: brakujący sidewall i zła `adjacent_cell` dochodziły do ABI; M1: test różnych osi nie izolował wspólnej osi; I1-R1: one-cell RHS rozbiegał się z ownerem; I2-R1: `area_m2` omijało preflight; I1-R2: `\sigma=5e-324\,\mathrm{S/m}` rozcinało ownerowy graf przy globalnie zbilansowanym RHS; I1-R3: dokumenty normatywne opisywały terminalową redukcję zamiast ownerowego RHS per komponent | RED: planner zwracał `Ok(())`; po wyłączeniu runner preflight MockAbi zwracał wynik, więc ABI było osiągalne. GREEN: planner 342/342; runner 818/818; source-map 22/22; FDM GPU docs 16/16; managed CUDA E2E: $V=[-0.025,+0.025]$ V, $J_x=-2e13$ A/m², residual algebraiczny $4.1150157270026995\times10^{-17}$, bilanse $0$ | Final documentation review: `REQUEST_CHANGES`, `0 Critical / 1 Important`; finding ledgeru fixed by `452b40e`; ledger closure re-review pending | `2e00562a37f61b26666cf51598e1e358bfb9d742..72ea50a23738205ad33eb7c41ae2454733030df6` |

## Plan: Control Room Inspector refactor

Task 1: complete (commits `5d8d18a8..fdfe1037`, review clean; focused RED
confirmed 2 intended failures and 52 passing tests; fixture coverage includes
model, resources, results, jobs, and diagnostics).
Task 2: complete (commit `ebd02bc3`, review clean; 54 focused route-coverage
tests and typecheck pass; exact route map, explicit unknown fallback, and
frequency-kind coverage are present).
Task 3: complete (commit `737eeafe`, review clean; 154 focused tree tests,
typecheck, focused lint, and API hygiene pass; builder domains are split while
public node IDs, kinds, order, and selection refs remain stable).
Resource loader stabilization: complete (commits `46e769390..e12b03224`,
fresh review clean; 2 focused timer/source-contract tests and typecheck pass;
the base variant produced the intended RED result).
Task 4: complete (commits `c836680b..22b8d7b2`; dedicated Airbox/object/mesh/mode
visualization Inspector owners, canonical mode breadcrumb identity, interactive
phase commands, distinct debug contracts, and stale CSS cleanup; focused
171/171, full Control Room 515/515 files and 4947/4947 tests, typecheck, lint,
and diff-check pass).
Task 5: ukończony (commit `4955c06f6`; wszystkie selectable node kinds mają
fail-closed route coverage oraz descriptor owner/icon/type contracts, w tym
dedykowane Airbox/object/mesh-part/mode metadata; focused 226/226, typecheck,
targeted ESLint i diff-check przechodzą).
Task 6: częściowo zweryfikowany (commit `d09a41132`; `smoke:inspector` przechodzi
z `consoleErrors: 0`, selection matrixą Airbox/Object/Mesh-part/Mode, keyboard
path i asercją zdrowego WebGL canvasu). Wymagany dodatkowy
`smoke:viewport-3d-explorer-inspector-targets` pozostaje zablokowany przez
istniejący próg pixel-delta: FDM `changedPixels=13 < 18`, FEM fallback
`changedPixels=0 < 18`; progu nie obniżano.
Plan design systemu Inspectorów: zweryfikowany na implementacji odziedziczonej
z wcześniejszych commitów; świeża family matrix `30/30` plików i `228/228`
testów, kontrakty design systemu `93/93`, API hygiene `exit 0`. Pełny wrapper
testowy nadal odtwarza niezależny baseline failure
`ChartLegend.rowsBinary...` (`3` wywołania zamiast `2`), a architecture hygiene
ma znany import `explorerSelection.ts` do `viewport-3d`.

## Frequency-domain UX

Deskryptory powierzchni analitycznych zakończone w `36912c45d`, wspólny stan
prezentacji zasobów zakończony w `09ab148d3`, a dedykowany FMR modal spectrum
Inspector zakończony w `75272786a`. Panel zachowuje wspólny szablon
Inspectorów, ma własny owner, proweniencję i fail-closed gotowość pola 3D;
routing korzysta bezpośrednio z nowego komponentu, a eksport z monolitu
pozostaje dla kompatybilności.

Task 4 driven-response/peak zakończony w `14cceb401`: response sweep ma
dedykowanego ownera, pure model osi/progress/cancel/field handoff, osobny
response-point browser oraz bezpośredni route import. Compatibility export
monolitu pozostaje zachowany, a single-peak Inspector ma jawnego ownera.

Ostatnia bramka tej części: `328/328` testów w pięciu plikach dla Task 4 oraz
wcześniejsze `356/356` testów w sześciu plikach dla Task 3; typecheck,
targeted ESLint, design contracts `93/93`, API hygiene i `git diff --check`.
Końcowy audyt pozostałych powierzchni częstotliwości oraz wymagany smoke
`smoke:viewport-3d-explorer-inspector-targets` pozostają otwarte; smoke nadal
zatrzymuje się na istniejącym progu pixel-delta FDM `13 < 18` i FEM fallback
`0 < 18`.

Task 5 eigen/dispersion został zaimplementowany lokalnie: dispersion, branch i
mode mają osobnych ownerów z tym samym `InspectorGroup`/`FieldRow`/chart/table
template, osobne pure row models, stabilne selection refs i jawny handoff 3D.
Explorer zachowuje istniejące ID, a dodatkowo publikuje artifact/resource
provenance. Workbench używa descriptorów i explicit calculation mode; znane
ścieżki nie rozpoznają FMR przez tytuł wykresu. Przeszły `461/461` testów
fokusowych, typecheck, zero-warning targeted ESLint i `git diff --check`.

Task 6 qualification checkpoint: responsywność Analysis jest sprawdzana przy
360/640/900/1280 px wraz z osiami i jednostkami, legendą, kursorem/tabelą,
eksportem oraz brakiem poziomego overflow. Klawiatura pokrywa toggles serii,
wybór punktu z tabeli, driven-response point, wiersz eigen branch i modalny
Plot 3D. Właściciel ECharts zachowuje ten sam canvas podczas retained refresh,
a cleanup obejmuje renderer, listenery, ResizeObserver, MutationObserver i
oczekujący RAF. `396/396` szerokich testów Analysis/chart/frequency Inspector,
typecheck, targeted ESLint, API hygiene, React Doctor `90/100` bez uwag,
`smoke:analysis-plots`, `smoke:inspector` oraz izolowany
`CONTROL_ROOM_TARGET_SMOKE_PHASE=analysis-handoff` przechodzą. Produkcyjny
build Next 16 przechodzi. Pełna macierz target smoke nadal zatrzymuje się na
niezmienionym progu FDM pixel delta `13 < 18`.

Audyt chart performance został naprawiony tak, aby zawsze wybierał Dynamics,
mierzył ustalony heap po trzech cyklach GC i nie przypisywał globalnego RAF
aktywnego viewportu 3D właścicielowi chartu. Produkcyjny przebieg 10 000 wierszy
i 100 remountów przeszedł wcześniejszy limit heap oraz zerowy wzrost canvasów,
listenerów, observerów, workerów, URL-i i aktywnych RAF. Pozostaje otwarta
bramka Quick Chart + 3D: `/v2/sessions/current/data/fields` jest odpytywane co
około 110 ms, dlatego session requests nie osiągają idle. Progu ani liczby
cykli nie obniżono.

## Plan: refaktoryzacja widoku 2D i monitorów planarnych (2026-08-12)

- Branch/worktree: `/home/kkingstoun/git/fullmag/fullmag`, `master` (jawnie wskazane przez użytkownika)
- Base: `ac56e75f410354285fc49dc0459b6c116d187719`
- Plan: `docs/plans/active/viewport-2d-refactor-2026-08-12/viewport-2d-refactor-audit-and-implementation-plan.md`
- Niezależne zmiany użytkownika do zachowania: `ribbon.css`, `FooterTelemetry.tsx`, `ribbonCommon.tsx`, `external_solvers/3`.

| Task | Status | Commit(s) | Review |
|---:|---|---|---|
| 0 | complete | `42eede461`, `5138078f7` | spec compliant; quality approved; managed science pass + browser RED baseline (`canvas` timeout) |
| 1 | complete | `c3ecccaa0`, `68780427f`, `4b7bedca4`, `c4a57f1b3` | spec compliant; quality approved; docs/source-map/capability gates pass; browser RED remains unqualified |
| 2 | complete | `9ce555065`, `66e7579a4` | spec compliant; quality approved; carrier identity/provenance and public field resources verified |
| 3 | complete | `935d8e681`, `216f603fa`, `d19cfc96b` | spec compliant; quality approved; exact targets, sampling and cache identity verified |
| 4 | complete | `5bf32e3aa`, `ab973377a`, `ca3107991`, `1b5a2e090`, `618d9b997`, `eec5544d6`, `e48fbe821` | spec compliant; quality approved; public sample identity and exact revision contract verified |
| 5 | complete | `b015c81d6`, `acdbe9556`, `c36fd1741`, `04eebbf0e`, `3a2b75df2` | spec/quality reviews clean; full monitor editor and round-trip implementation present; runtime qualification remains Task 10 |
| 6 | complete | `f4782d038` | state ownership implementation present; focused state/API/hydration reviews clean; runtime qualification remains Task 10 |
| 7 | complete (static) | `208a40d1f`, `594939f57`, `8e9b08c95`, `396fa7edd`, `6c1aba2f4`, `df1479b6e`, `b36fe10d7`, `dd8c4e697` | render model, presentation profile, points/bounds and FDM grid overlay reviewed; focused tests pass; browser/runtime qualification remains Task 10 |
| 8 | complete (static) | `cb530a726`, `ff5f7d178`, `1eff3234c` | dedicated Inspector/capability controls reviewed; focused tests/typecheck/lint pass; runtime qualification remains Task 10 |
| 9 | complete (static) | `8f6d6e467`, `b0157bd86`, `4ffd43741` | monitor creation/clip workflow and overlay lifecycle implementation present; browser/runtime qualification remains Task 10 |
| 10 | in progress | `c437e4197` plus current runtime attempt | harness and fail-closed aggregation reviewed; compact/full contract PASS (`just verify-viewport-2d-planar-compact-full-contract`, exit 0); fresh FDM CPU reached canonical planner but fixture is invalid for current multilayer contract (4 explicit planner causes), FEM CPU reached mesh/API but dirty snapshot and host-root `ENOSPC` blocked science/browser qualification; browser showed partial WebGL/layer evidence only; FEM GPU and clean-lane reruns remain required |
| 11 | pending | pending | pending |

FDM multilayer directed/symmetrized pair-energy: complete (commits
`5feda8498..fd2c8bac1`, task and final reviews clean; CPU FP64 only, no API v2/CUDA
capability promotion). Pair ledger, atomic snapshot publication, independent
runtime/source fingerprints, durable validated artifact, FFT/memory telemetry,
canonical directed wire order, Scene/Python identity evidence, equal/unequal
push-pull reciprocity, finite-difference and documentation gates passed in the
task scope. Full runner integration still has separately proven baseline
source-layout and FEM physics-validation failures.

## FDM multilayer convolution — bieżący stan realizacji (2026-08-14)

- D-07 ma zaimplementowaną wąską ścieżkę `cuda_native_multilayer_convolution`
  dla FP64, stałego Heuna, `three_d` i wspólnej siatki identity; pozostałe
  przypadki zachowują jawny native-stacked/CUDA-assisted fallback zamiast
  cichej zmiany semantyki.
- Snapshot końcowy materializuje kanoniczne `H_eff = H_ex + H_demag + H_ext +
  H_ani + H_dmi`, a telemetryka liczy tylko rzeczywiste wektorowe transfery
  stanu/pól (inicjalne H2D oraz sześć końcowych D2H na warstwę). Kontrakt
  źródłowy `fdm_source_layout_contract` i trzy testy jednostkowe D-07 przechodzą.
- `just verify-fdm-multilayer-demag-runtime cpu-fp64` pozostaje bramką CPU.
  Lane jest wykonywalny, ale nie ma kompletnego source-bound dowodu naukowego,
  dlatego nie został zakwalifikowany. Verifier rozdziela teraz wprost
  `artifact_verification_status=verified` od
  `qualification_status=not_qualified`, zwraca kod 3 i zapisuje brak oceny
  progów FP64, direct oracle, reciprocity oraz równowagi kontroli ze step-zero;
  receptura nie może już zakończyć się fałszywym `status=verified`. Bramka
  Airboxa używa jawnego `--artifact-only`, bez promocji naukowej artefaktu.
- Kontrakt CUDA build/source/ABI jest zielony. Runtime CUDA ma osobne bramki
  `just verify-fdm-multilayer-cuda-runtime cuda-fp64` i
  `just verify-fdm-multilayer-cuda-runtime cuda-fp32`; receptura
  `verify-fdm-multilayer-demag-runtime` celowo odrzuca lane'y CUDA. Oba lane'y
  CUDA pozostają niezakwalifikowane, ponieważ source snapshot, manifest
  runtime'u i wejścia verifiera nie zostały jeszcze zsynchronizowane w jednym
  niezmiennym przebiegu.
- Smoke WebGL ma frame-bound dowód kolejności Airbox wektorów: trzy różne,
  rosnące rewizje PATCH i klatki `wireframe_on` → `wireframe_off` →
  `vectors_on`; flagi wireframe/wektorów są zapisywane w tym samym snapshotcie
  debug co `frameCommitId`. Stary snapshot lub odpowiedź pola sprzed przełączenia
  nie może przejść bramki. Self-test ma także negatywne fixtures dla wektorów
  przy aktywnym wireframe, braku środkowej klatki, wektorów w klatce pośredniej
  i zamienionej kolejności; kwalifikacja zawsze musi najpierw wyłączyć wireframe.
- D-06 ma teraz wspólny `KernelCatalogSpec` oraz `KernelMemoryAccounting` w
  descriptorze, plannerze i CPU engine/runnerze. Planner i runtime porównują
  te same liczniki unique/pair, logical spectrum bytes i fixed-width binding
  bytes; CUDA ABI-v2/L² oraz native single-grid pozostają osobnymi modelami
  admission i nie są przez to automatycznie promowane.
- Potwierdzone lokalnie: CUDA source/unit, source-layout 8/8, kontrakt CUDA
  build/source/ABI, Control Room typecheck, 134 testy viewport/debug, składnia
  i self-test smoke. Nie są to dowody runtime ani kwalifikacja naukowa. Nadal
  otwarte: zsynchronizowany managed CUDA runtime, pełna macierz WebGL z aktywną
  sesją oraz kwalifikacja produkcyjna CPU FP64, CUDA FP64, CUDA FP32,
  heterogenicznych `h_z` i `push_pull`.
- Ostatnia próba `just verify-fdm-multilayer-cuda-runtime cuda-fp64` została
  zatrzymana przed uruchomieniem solvera: `ensure-managed-fem-runtime` wykrył
  rozbieżność snapshotu źródeł i próbował przebudować runtime, lecz eksport
  archiwum zakończył się `No space left on device` na pełnym
  `/mnt/fullmag-zfn2-native` (100%). Wcześniejszy preflight CUDA zgłosił także
  brak dostępu NVML (`GPU access blocked by the operating system`). Nie użyto
  starego binarium jako substytutu i nie nadano lane'owi statusu qualified.
- Bieżąca weryfikacja po domknięciu katalogu D-06/D-07: `fullmag-fdm-demag`
  31/31, `fullmag-engine` multilayer 19/19 (1 benchmark ignored), runner CPU
  multilayer 16/16, API multilayer 18/18, Python/runtime 58/58, frontend
  viewport/debug 321/321, typecheck, rustfmt, diff-check, dokumentacja i
  smoke self-test przechodzą. Naprawiono także dwa kontrakty API wykryte w tym
  przebiegu: region na niezależnych siatkach zwraca jawne `422`, a błąd
  spójności fingerprintu Airboxa zachowuje diagnostyczny token
  `carrier_fingerprint`. Nadal nie jest to świeży managed runtime ani dowód
  browser/WebGL z aktywną sesją.

## Plan: Scratch simulation authoring (2026-08-23)

- Worktree: `D:\git\fullmag\worktrees\scratch-authoring-ui`
- Branch: `codex/scratch-authoring-ui`
- Source plan: `docs/superpowers/plans/2026-08-23-scratch-simulation-authoring.md`
- Plan commits: `b5454c822`, `ae2e800cc`

| Task | Status | Implementer | Review |
|---:|---|---|---|
| 1 | complete (`ccf27947e..1e7805a08`) | `scratch_task1_impl` | spec clean; quality approved after three fix waves |
| 2 | complete (`b7588f8a6..cad851bf2`) | `scratch_task2_impl` | spec clean; quality approved after one fix wave; full typecheck retains 6 baseline errors outside task |
| 3 | complete (`1d16fdecf..2d7ffcd43`) | `scratch_task3_impl` + `scratch_task3_fix` | approved after two fix waves; typed session list, distinct loading/error/no-session, canonical invalidation and real AppMenu/EmptyWorkspace/Ctrl+N integration verified; 50/50 Task 3 regression, independent 25/25 |
| 4 | complete (`3eb5cf186`, `48f9915bc`, `2f16f09f2`, `28fda14de`, `e7d6fcda9`, `3b9fa3919`) | `scratch_task4_impl` | definitively approved after five review waves; canonical readiness/material/object set, production Run providers, bounded invalidation and final ACK revisions verified |
| 5 | complete (`1f2674a6d`, `f2762e998`, `05475556b`) | `scratch_task5_impl` | approved after two review waves; revision-safe primitive draft, real DOM conflict recovery and overlay isolation/lifecycle verified; browser/WebGL deferred only to mandatory Task 15 gate |
| 6 | complete (`30b65e027`, `4df823171`, `9f3c346f8`) | `scratch_task6_impl` | approved after two review waves; mounted KernelContext Move flow, complete pointer lifecycle and stale activation/session cleanup verified; browser/WebGL deferred only to Task 15 |
| 7 | complete (`0486448be`) | `scratch_task7_fix` | approved: real KernelContext/resource harness 12/12, targeted ESLint clean, TSC no Task7 errors |
| 8 | pending | — | — |
| 9 | pending | — | — |
| 10 | pending | — | — |
| 11 | pending | — | — |
| 12 | pending | — | — |
| 13 | pending | — | — |
| 14 | pending | — | — |
| 15 | pending | — | — |

## Plan: produkcyjny redesign mapy pola 2D (2026-08-18)

- Worktree/branch: `/home/kkingstoun/git/fullmag/fullmag`, `master`.
- Plans: `docs/superpowers/plans/2026-08-18-planar-field-map-production-redesign-00-master.md` oraz plany `01`–`03`.
- Task 0 baseline migration test: complete (commit `33bcbd65`, focused test 1/1 pass, independent review clean).
- Task 1 FDM midplane RED: complete (commit `b1464b481`, expected RED `z=0.0` vs `-0.5`, independent review approved).
- Task 2 cell-centered FDM default slice: complete (commits `a750062ca`, `d47029f97`; overflow RED then source tests 15/15 and endpoint 1/1 pass; independent re-review approved).
- Task 3 source parity: complete (commit `48ed0c3f6`; field meta/vector/planar revision, generation, stats and payload parity; focused 1/1 pass; independent re-review approved).

Task mixed-P1 local interactions 1: complete (working-tree scope, final review clean; 3 Rust exact tests and managed focused native contract passed).

## Plan: FEM meshing production remediation (2026-08-27)

- Worktree: `/home/kkingstoun/git/fullmag/fullmag-worktrees/fem-meshing-production-remediation-20260827`
- Branch: `codex/fem-meshing-production-remediation-20260827`
- Frozen base/master: `5ac37c7a8c4715cff7fdf197caede15f94665d9e`
- Source plan SHA-256: `fd1e3be2008fe18e1ab21cfaad4b976dbef06cf7d213339f283a4d4eb3b9a7fc`
- Commit policy: task-scoped commits on this branch for safe periodic rebase; no push or integration.

| Task | Status | Implementer | Review | Master sync |
|---:|---|---|---|---|
| 0 | complete; Gate 0 PASS | root | baseline evidence matrix in `fem-meshing-task-0-report.md` | equal to master |
| 1 | complete; Gate 1 PASS (`d6a4ad670..170e4f17a`) | `fem_mesh_task1_impl` + `fem_mesh_task1_fix` | approved after three fix waves; source maps 9/9, validator 28/28, execute smoke 9/9 | local master unchanged at `5ac37c7a8` |
| 2 | pending | — | — | pending |
| 3 | pending | — | — | pending |
| 4 | pending | — | — | pending |
| 5 | pending | — | — | pending |
| 6 | pending | — | — | pending |
| 7 | pending | — | — | pending |
| 8 | pending | — | — | pending |
| 9 | pending | — | — | pending |
| 10 | pending | — | — | pending |
| 11 | pending | — | — | pending |
| 12 | pending | — | — | pending |

## Plan: FEM mixed-mesh performance and certification (2026-08-27)

- Worktree/branch: `/home/kkingstoun/git/fullmag/fullmag`, `master` (jawnie zatwierdzony przez użytkownika).
- Source plan: `docs/superpowers/plans/2026-08-27-fem-mixed-mesh-performance-and-certification.md`.
- Commit policy: task-scoped working-tree evidence; no automatic commit, stage or push.

| Task | Status | Implementer | Review |
|---:|---|---|---|
| 0 | complete (working-tree evidence; benchmark import side-effect and tuple return fixed; 30/30 tests) | `mixed_task0_benchmark_import` + `mixed_task0_review_fix` | approved after isolation fix wave; corrected production baseline still requires runtime execution |
| 1 | source/spec complete; production `BLOCKED_MESHER_QUALITY` | `mixed_task1_root_cause` | source approved after two fix waves; exact SP4 `Relocate3D,niter=1` leaves a strict-degenerate tet4, so N=10 and production receipt are not passed |
| 2 | implemented (focused working-tree evidence; exact-SP4 performance gate deferred by small-first strategy) | `mixed_task2_implement` | approved after fail-closed mutation and benchmark-evidence fix waves; 54 benchmark/qualification tests plus focused certificate/trust/public-fixture gates pass |
| 3 | current-state audit pending | — | — |
| 4 | current-state audit pending | — | — |
| 5 | blocked by Task 1 production gate | — | — |
| 6 | blocked by Task 1 production gate | — | — |
| 7 | blocked by Task 1 production gate | — | — |
| 8 | blocked by Task 1 production gate | — | — |
| 9 | blocked by Task 1 production gate | — | — |
| 10 | blocked by Task 1 production gate | — | — |
| 11 | blocked by Task 1 production gate | — | — |

Small-first repair diagnostic: complete (working-tree evidence). The real-Gmsh
microfixture in `scripts/fem_mixed_tet_repair_microfixture.py` uses 161 nodes,
101 tet4, one prism6 and one pyramid5. The thresholded default repair changes
only the defective cavity (`101 -> 100` tet4, strict degenerates `1 -> 0`),
preserves 96 control tet topology keys and raw hybrid connectivity, and is
deterministic across 10 fresh runs. Independent re-review approved 7/7 tests,
ruff, lifecycle restoration and the real-Gmsh audit. This is not OCC/SP4 or
production-runtime qualification; medium and canonical scenarios remain
deferred until a versioned repair-policy design is approved.
## Plan: Public Sphinx documentation standardization (2026-08-31)

- Worktree: C:\git\fullmag\fullmag
- Branch: master (subagent implementation explicitly requested by user)
- Plan: .superpowers/sdd/public-docs-standardization/plan.md
- Commit policy: no automatic commit, stage, or push; task-scoped working-tree evidence.
- Baseline: strict Sphinx build PASS for 228 pages; 101 source maps = 78 PASS / 23 FAIL.

| Task | Status | Implementer | Review |
|---:|---|---|---|
| 1 | dispatch attempted | pending notification | pending |
| 2 | dispatch attempted | pending notification | pending |
| 3 | dispatch attempted | pending notification | pending |
| 4 | dispatch attempted | pending notification | pending |
| 5 | dispatch attempted | pending notification | pending |
| 6 | dispatch attempted | pending notification | pending |
| 7 | dispatch attempted | pending notification | pending |

## Plan: FEM meshing production closure (2026-08-31)

- Worktree: `C:\git\fullmag\fullmag`.
- Branch: `master`; the current dirty shared checkout is the user-authorized implementation input.
- Source plan: `docs/superpowers/plans/2026-08-31-fem-meshing-production-closure-masterplan.md`.
- Commit policy: no automatic commit, stage, stash, reset, push, or cleanup; task-scoped working-tree evidence and independent review.
- Worktree policy: work in place because the active dirty snapshot is authoritative; a clean linked worktree would omit required in-flight changes.
- Phase-0 observation (historical initial read): `HEAD e4f653cfaa4505b8659b1ad173b7aec2b67aaad5`, `master...origin/master [0/0]`, no merge/rebase/index lock, `0` staged, `116` unstaged, `8` untracked.
- Phase-0 source identity (prequalification only): `adfe4772bb06e20854d30ab64a6f18dd88e5b35e621a037132fd1a030d82cacd`; dirty-content identity `0680f9ea7b4dbfa1b96c4f48972c845d04c6e37e229e7fe9dd16efacc77d3d0f`.
- Release rule: dirty evidence may support engineering/prequalification only; final sealed qualification still requires stable clean source before/after.

### Phase-0 refresh (2026-08-31, current checkout)

- The earlier observation above is retained as historical context. An external
  user commit `a1de38b4d7dad275dccbdbfd937b757d6ca7ee99` subsequently updated
  public Sphinx documentation and is now synchronized with `origin/master`.
  The current refresh is on `master` at `HEAD a1de38b4d7dad275dccbdbfd937b757d6ca7ee99`,
  with `master...origin/master [0/0]`, no merge/rebase/cherry-pick/revert/bisect
  marker, no unmerged index entries and no `.git/index.lock`.
- Current `git status --porcelain=v1 --untracked-files=all` counts are `0`
  staged, `66` unstaged and `29` untracked paths. This is explicitly a dirty
  prequalification input, never a release-qualified source state.
- WP-00.1 source-only preflight is implemented and independently reviewed
  `Approved`. GREEN evidence: `python scripts/test_prepare_fem_meshing_qualification.py`
  (`35` tests, `OK`, `1` platform-only skip), Python `py_compile` and scoped
  `git diff --check` passed. The focused pytest helper suite remains
  `NOT VERIFIED` because host Python has no `pytest` module.
- Current external evidence root is
  `C:\git\fullmag\.fullmag-evidence\fem-meshing-production\2026-08-31-wp00-1-preflight-v11`.
  It contains the two generated preflight JSON artifacts plus the observational
  toolchain inventory and historical evidence index. Snapshot identity is
  recorded in `source-snapshot-before.v1.json`; scope status is
  `prepared` for S13/box/bbox/mixed_p1/FEM CPU+forced GPU/double.
- No managed build, runtime, commit, stage, stash, reset, clean, push, process
  termination or cache pruning was performed. WP-00.4 remains pending until a
  managed run exists and can receive a before/after drift seal.

| Work package | Status | Implementer | Review |
|---:|---|---|---|
| WP-00.1 source-freeze preflight | complete | implemented | Approved (v7) |
| WP-00.2 qualification-scope schema | complete (prepared only) | preflight artifact | covered by WP-00.1 review |
| WP-00.3 evidence namespace/toolchain inventory | complete (observation only) | Phase-0 artifact | not a runtime qualification |
| WP-00.4 post-run drift seal | pending | - | - |
| WP-01..WP-03 policy and round-trip | pending decisions | - | - |
| WP-04..WP-10 meshing, quality, certificate, cache | pending decisions/dependencies | - | - |
| WP-11..WP-13 Windows and managed CPU/GPU | pending dependencies | - | - |
| WP-14..WP-16 API, WebGL, performance | pending dependencies | - | - |
| WP-17 sealed receipt/capability | pending all prior gates | - | - |
| WP-18..WP-23 remaining contract/runtime closure | pending decisions/dependencies | - | - |

### Kontynuacja realizacji planu — 2026-08-31 (source closure pass)

Zakres wykonany w tej sesji pozostaje zmianą roboczą na wspólnym checkoutcie; nie wykonano
stage/commit/push/reset/stash/clean ani zatrzymywania procesów. Aktualny odczyt kontrolny:

```text
repo: C:\\git\\fullmag\\fullmag
branch: master...origin/master [0/0]
HEAD: d6a8cef166e18a87e183df95a8250649e2db1cac
status entries: 134 (0 staged, 98 unstaged, 36 untracked)
MERGE_HEAD: absent
index.lock: absent (during two equal status reads)
source snapshot: DIRTY / prequalification only
```

#### Domknięte źródłowo kontrakty meshera

- `FM-MESH-001/007/008`: pomiar sąsiedniego wzrostu rozmiaru po pełnych ścianach,
  family/region/mesh-role/zone summaries, percentyle, worst ordinals i structured
  threshold failures; krawędzie prism/pyramid/hex są fizycznymi krawędziami, nie pełnymi
  kombinacjami węzłów.
- `FM-MESH-003/018/029`: authored/resolved sweep direction (`auto|x|y|z`), fail-closed
  named face selectors, ambiguity/no-overlap component identity oraz jawne statusy fallbacku.
- `FM-MESH-004/019/026`: ścisłe finite scalar/int/bool/vector parsing, odrzucenie
  fractional/bool/non-finite coercion i nieaktywnego `growth_rate <= 1` także w typed
  `AirboxOptions`.
- `FM-MESH-028/034`: pełne physical-tag coverage, duplicate/missing/extra mapping oraz
  length/finite/order guards dla wszystkich kanałów Gmsh quality.
- `FM-MESH-032/033`: typed family dispatch (`tet4`, `prism6`, `pyramid5`, `hex8`) z
  jawnie ograniczonym legacy tet4 view oraz blokadą publikacji starej jakości po mutacji
  connectivity.
- `FM-MESH-035/036/038`: FMMQ v2 fixed-layout writer/verifier, canonical identity,
  family ranges, ordinal/checksum/digest checks, API preflight/manifest binding,
  verify-before-publish, fsync + atomic replace oraz raport requested/effective Gmsh
  `Algorithm3D` uwzględniający pola generowane i pre-existing airbox.
- `FM-MESH-037`: standalone preview route odrzuca przekazane `study_universe`; solver
  mesh z airboxem musi przejść przez shared-domain entry point.
- `FM-MESH-023/024/025`: niezaimplementowane non-default assembly policies i mesh
  operations są odrzucane przed Gmsh zamiast udawać realizację.

#### Dowody uruchomione po tej zmianie

```text
python scripts/test_fmmq_v2.py                                      9/9 PASS
python scripts/test_fem_quality_typed_dispatch.py                  26/26 PASS
python -m unittest discover -s packages/fullmag-py/tests             284 PASS, 31 skipped
python -m py_compile (zmienione moduły meshing)                     PASS
cargo check -p fullmag-api -p fullmag-ir                             PASS
cargo test -p fullmag-api fmmq_canonical_json...                     1/1 PASS
frontend meshQualityDataCodec targeted Vitest                     5/5 PASS
pnpm --dir apps/control-room typecheck                               PASS
git diff --check                                                     PASS
```

`cargo check` ma wyłącznie istniejące ostrzeżenie `resolve_with_registry` (`dead_code`).
Frontendowe `pnpm exec vitest` nie było używane, ponieważ lokalny Corepack odmawia
weryfikacji podpisu pnpm; test został uruchomiony bezpośrednio przez repozytoryjny Vitest.

#### Nadal otwarte i celowo niepromowane

- Python FMMQ producer nie korzysta jeszcze z jednego wspólnego Rust quality engine dla
  wszystkich family metrics; native certifier/preflight nie jest pełnym quality oracle.
- Brak macierzy cache invalidation/concurrency, Rayon/Gmsh determinism oraz cold/warm
  performance C1/C2/W1/R1/X1 na aktualnym snapshotcie.
- Brak stabilnego clean source before/after i samodzielnego sealed `production-receipt.v2`.
- Brak świeżego managed Windows FEM CPU/GPU runtime, forced-device/no-fallback, manifestów,
  API live resource i rzeczywistego browser/WebGL proof; S1–S13 pozostają `NOT VERIFIED`.
- Pozostają niezaimplementowane lub niezakwalifikowane: `swept_hex`, mixed-periodic pełnej
  semantyki, geometry-dependent prism poza dozwolonym Box, sphere exact realization,
  preview projection parity i capability/documentation promotion.

Status programu po tej sesji: `source implementation = substantially closed`,
`production qualification = NOT QUALIFIED`. Powyższe testy nie są dowodem managed runtime,
GPU ani przeglądarki.

#### Korekta końcowej bariery persystencji — 2026-08-31

Pierwsze uruchomienie testów persystencji wykazało błąd w nowo dodanym flushu:
`os.fsync` na Windows nie przyjmuje uchwytu otwartego wyłącznie do odczytu
(`OSError: [Errno 9] Bad file descriptor`). Poprawiono `_fsync_file`, aby otwierał
tymczasowy artefakt przez `r+b`, co odpowiada wymaganiu `FlushFileBuffers` i nie zmienia
atomowego modelu publikacji.

Po poprawce:

```text
test_mesh_persistence.py                         24 PASS, 1 NOT RUN (brak gmsh/trimesh)
test_mesh_artifact_trust.py                      23 PASS, 1 skipped
test_meshing_fallbacks.py                        27 PASS
```

Jedyny nieprzechodzący przypadek persystencji to celowo wykonywany realny shared-domain
mesh, który wymaga lokalnych pakietów `gmsh` i `trimesh`; test zatrzymuje się na braku
zależności, a nie na asercji kontraktu. Nie maskowano tego przez zmianę testu.

#### Kontynuacja cache/periodic contract — 2026-08-31

- Per-object FEM `.npz` cache jest publikowany przez unikalny katalog tymczasowy,
  `r+b`/`fsync`, `os.replace` i barierę katalogu. Przerwany writer nie nadpisuje
  poprzedniego artefaktu i nie wystawia częściowego archiwum.
- Klucz cache wiąże teraz także digest bajtów importowanej geometrii, source snapshot,
  wersję Gmsh/repair/certifier, schema/topology fingerprint i jawny source compatibility
  epoch. Shared-domain identity korzysta z tego samego kontraktu.
- Uszkodzone per-object i shared-domain entries są przenoszone do namespaced
  `quarantine/` z unikalną nazwą i skrótem przyczyny zamiast cichego overwrite.
  Rename jest warunkowany niezmienionym `stat`, aby ograniczyć race z atomowym writerem.
- Mixed/non-tet periodic request (`swept_prism`, `swept_hex` albo auto z warstwami) ma
  typed `mixed_periodic_topology_unsupported` i jest odrzucany przed Gmsh zarówno w
  `generate_mesh`, jak i w shared-domain plannerze. Tetrahedral periodic route pozostaje
  osobnym, wspieranym kontraktem.
- Native `fullmag-ir` ma osobny lekki `validate_mixed_mesh_semantics` używany przez
  `fullmag-py-core` preflight. Sprawdza legalny part/family/marker, jednoznaczne role,
  owner count i interface marker, a opcjonalne expected markers z certyfikatu wiążą
  cache reload z tym samym markerem bez uruchamiania pełnych redukcji jakości.

Dowody dla tej kontynuacji:

```text
ProblemApiTests cache subset                                      5/5 PASS
LayeredMeshDslValidationTests::mixed_periodic...                  1/1 PASS
python -m unittest discover -s packages/fullmag-py/tests -p test_meshing.py
                                                                  285 PASS, 31 skipped
python -m py_compile (problem/_gmsh_types/_gmsh_generators/asset_pipeline)
                                                                  PASS
cargo test -p fullmag-ir native_semantic_preflight_rejects_wrong_interface_marker
                                                                  1/1 PASS
```

#### Kontynuacja Windows isolation/Nsight contract — 2026-08-31

- Domyślne ścieżki cache/build/temp oraz nazwy projektu Compose i tagi lokalnych
  obrazów w launcherach Windows są namespacowane skrótem kanonicznej ścieżki
  repozytorium. Jawne `FULLMAG_WINDOWS_*_ROOT` pozostają świadomym override'em
  właściciela. Eliminuje to kolizję kilku worktree przy wspólnym `C:\fullmag-*`.
- Dockerfile `fem-gpu` nie wymaga już obecności ani konkretnej wersji Nsight przy
  budowie obrazu. `nsys`/`ncu` są opcjonalnymi narzędziami capture-time; ich
  dostępność i uprawnienia nadal są sprawdzane fail-closed przez harness
  `capture_fem_gpu_nsight.py` przed profilem.
- Uodporniono kontrakt testowy ścieżek fixture na separator Windows oraz usunięto
  przestarzałe założenie o stałym poleceniu `cargo +nightly build`.

Dowody źródłowe:

```text
Windows launcher contract (no-arg functions)                         PASS
Nsight source/fixture contract (no-arg functions)                    PASS
PowerShell parser: run_fullmag.ps1/run_fullmag_wsl.ps1/setup_fullmag.ps1 PASS
```

Nie wykonano w tej sesji rebuilda managed `fem-gpu` ani capture: aktywne kontenery
GPU/CPU i wspólny checkout należą do innych uruchomień, a pełny runtime proof
pozostaje `NOT VERIFIED` zgodnie z bramkami S1–S13.

#### Izolacja Compose i bezpieczny cleanup — 2026-08-31

- Usunięto z meshingowych recipe globalne `COMPOSE_PROJECT_NAME=fullmag`. Każdy
  managed Compose call wylicza teraz nazwę z kanonicznego repo root przez
  `scripts/resolve_fullmag_compose_project.sh`; dopuszczony jest jawny override
  `FULLMAG_COMPOSE_PROJECT_NAME` po walidacji znaków.
- `ensure-managed-fem-runtime` oraz exporter nie uruchamiają już destrukcyjnego
  prune domyślnie (`FULLMAG_RUNTIME_PRUNE=0`). Dodano osobną recipe
  `just prune-managed-fem-runtimes`, która zawsze wykonuje dry-run, a usuwanie
  wymaga jawnego `apply=1`. Ochrona active/in-use pozostaje po stronie prunera.

Dowody:

```text
managed Compose namespace source contract                                  PASS
runtime cleanup opt-in/dry-run contract                                     PASS
no-arg Windows + Nsight source contracts                                    PASS
```

Lock edge-case hardening:

- cache lock creation uses a restrictive mode and handles partial writes;
- malformed metadata is reclaimed only after the stale-age budget, so a reader
  cannot mistake the owner's O_EXCL-to-JSON publication window for a dead lock;
- a regression test confirms that a fresh partial lock times out without being
  quarantined or allowing a second writer.

```text
ProblemApiTests cache/lock subset (including fresh partial metadata)          9/9 PASS
```

#### Truthful sweep fallback and bbox-tie determinism — 2026-08-31

- Shared-domain `ArchWaveguide` builds that receive a `swept_prism` request are
  now reported as `fallback` with `actual_method=free_tetrahedral` and an
  explicit reason that `prism6` topology is not preserved.  The previous
  `applied/layered_surface_tetrahedral` status could be read as a strict swept
  realization even though the component-aware STL route asks Gmsh for tets.
- The aggregate shared-domain report also raises `degraded=true` for this
  explicit semantic fallback; a status entry can no longer say `fallback`
  while the top-level report remains apparently exact.
- The body-only swept-cylinder compatibility route still returns its historical
  tet4 view, but now carries a durable `MeshRealizationReport` binding the
  requested `prism6`/`hex8` intent to resolved `tet4`, resolved z-layer count,
  linear order, and explicit fallback markers.  This keeps old callers working
  without hiding the topology conversion in provenance.
- Surface bbox matching retains the full min-envelope and now sorts matching
  entities by complete bounding box and tag.  Distance-field target lists are
  deduplicated and sorted before being handed to Gmsh, removing dependence on
  unspecified entity iteration order for equal-distance/tie surfaces.
- Added a real two-thread cache-writer regression: a second publisher cannot
  enter while the first owner holds the lock, and fresh partial lock metadata is
  still never reclaimed.

Evidence:

```text
python -m unittest discover -s packages/fullmag-py/tests -p 'test_meshing.py'  288 PASS, 31 skipped
python -m unittest packages/fullmag-py/tests/test_api.py -k fem_cache_writer  2 PASS
python -m py_compile (swept/fields/report + updated tests)                     PASS
```

The bbox fixture proves deterministic target selection only; it does not yet
prove continuity of a real Gmsh field map or a no-regression runtime fingerprint.
Managed CPU/GPU/browser qualification and the full cold/warm determinism matrix
remain `NOT VERIFIED`.

#### Cross-platform mesh-source path normalization — 2026-08-31

The flat authoring API now stores `domain_mesh` and
`frozen_magnetic_submesh` paths with portable forward separators.  This keeps
Windows-generated IR and Script Builder round-trips byte-stable with POSIX
fixtures while preserving absolute/relative path meaning.  Empty raw sources
are rejected before `Path` can turn them into the misleading `.` path.

#### Rust/API qualification pass after source closure — 2026-08-31

- Usunięto wyłącznie zdublowany import `MixedLayerTopologyCertificateV1IR` w
  `crates/fullmag-ir/tests/mixed_certificate_parallel.rs`. Był to błąd kompilacji
  testu w bieżącym, współdzielonym checkoutcie; nie zmieniał semantyki certyfikatu.
- `cargo test -p fullmag-ir` przechodzi w całości: 98 testów unit, 223 testy IR,
  16 testów równoległego certyfikatu oraz wszystkie pozostałe binaria integracyjne
  i doctesty — 0 failures.
- `cargo test -p fullmag-plan` przechodzi w całości: 442 testy biblioteki oraz
  wszystkie testy integracyjne i doctesty — 0 failures.
- Meshingowa część API została zweryfikowana osobną bramką:
  `cargo test -p fullmag-api mesh` — 140/140 PASS oraz
  `cargo test -p fullmag-api fmmq` — 2/2 PASS.
- `scripts.test_benchmark_fem_mixed_mesh_pipeline` uruchomione z jawnie dodanym
  `scripts` do `PYTHONPATH`: 33/33 PASS.

Pełne `cargo test -p fullmag-api` nie jest jeszcze zielone, ale jego 10 porażek nie
pochodzi z meshingowej bramki: cztery testy field-state kończą się na pustym/
niepoprawnym `.fullmag/local/python/bin/python` (Windows error 193), a sześć
pozostałych dotyczy niezależnych, równoległych zmian Frozen Spins/session persistence.
Osobny hostowy Python nie ma `gmsh`, `trimesh`, `h5py` ani `zarr`, dlatego nie
zastępuję nim managed runtime i nie maskuję brakujących zależności.

Stan programu pozostaje bez zmiany: source contracts meshingu są szeroko zamknięte,
lecz managed FEM CPU/GPU, API live resource na aktualnym artefakcie, browser/WebGL,
macierz cold/warm/determinism i sealed production receipt nadal mają status
`NOT VERIFIED`; produkt nie jest globalnie `QUALIFIED`.

#### Finalny odczyt kontrolny tej sesji — 2026-08-31

Współdzielony checkout został w międzyczasie przesunięty przez zewnętrzny commit do
`532e99c04` (`docs: avoid geometry source anchor collision`). Nie wykonywałem na nim
commit/stage/reset/stash/clean. Odczyt końcowy: `master...origin/master`, 152 wpisy
dirty (0 staged), brak `.git/index.lock`; `git diff --check` nie zgłasza błędów
whitespace poza przewidywanymi ostrzeżeniami LF/CRLF. Każdy przyszły runtime receipt
musi przeliczyć source identity ponownie po ustabilizowaniu wszystkich tych zmian.

#### Windows-only orchestration naming correction — 2026-08-31

Normalna trasa FEM nie wymaga WSL. `just` uruchomiony z PowerShell używa Git Bash
wyłącznie jako interpretera receptury, a sama trasa wykonawcza przechodzi przez
Windows PowerShell do `docker.exe`/Docker Desktop Linux. Nie ma wywołania
`wsl.exe`, nie ma WSL-owego checkoutu i nie ma drugiego właściciela indeksu Git.

Dodano kanoniczny `scripts/windows/run_fullmag_fem.ps1` i skierowano do niego
`just windows-build`, `just fullmag` oraz komunikaty bind-mountów Compose. Dawny
`run_fullmag_wsl.ps1` pozostaje tylko implementacją kompatybilności dla starszych
wywołań; jego nazwa nie opisuje już wymaganego środowiska. Aktualna kwalifikacja
runtime nadal wymaga działającego Docker Desktop i nie została przez tę zmianę
automatycznie uznana za `QUALIFIED`.

Evidence:

```text
PowerShell parser for scripts/windows/run_fullmag_fem.ps1                   PASS
Windows launcher contract functions (30)                                   PASS
run_fullmag_fem.ps1 -BuildMode invalid forwards to legacy validation         PASS
```

#### Phase-0 source-only preflight repeatability — 2026-08-31

Na aktualnym checkoutcie wykonano dwie niezależne migawki z
`--ignore-non-runtime-dirty`; oba przebiegi zwróciły
`source_snapshot_sha256=83f73b1c89141fed451963b4fa40475292dadd800d8a3ed7709b6fb6b30ea2c8`.
Przygotowano również tymczasowy, pusty evidence root poza repozytorium dla scope
S13 (`Box + bbox + mixed_p1 + double`, lane `fem_cpu` i `fem_gpu_forced`).
Artefakt jest prequalification input, nie release receipt, ponieważ checkout nadal
ma zmiany dirty i nie ma aktualnego managed runtime manifestu.

#### FMMQ v2 full adjacency channel — 2026-08-31

`AdjacentSizeGrowthReport` zachowuje teraz pełny kanał `pair_ordinals`/`pair_ratios`
w zwartej postaci, podczas gdy `worst_pairs` nadal jest ograniczone do listy
diagnostycznej. `build_fmmq_v2_spec` publikuje wszystkie ocenione pary i sortuje je
kanonicznie po ordinalach, niezależnie od porządku ratio w raporcie. Dzięki temu
duże siatki nie tracą obowiązkowego `adjacent_size_growth.v1`, a JSON raportu nie
powiela całego sąsiedztwa.

Evidence:

```text
python scripts/test_fmmq_v2.py                  10/10 PASS
python scripts/test_fem_quality_typed_dispatch.py 38/38 PASS
```

## Windows-only CI boundary clarification — 2026-08-31

- User-facing Windows build/run does not require WSL or `wsl.exe`; FEM crosses
  only the Docker Desktop Linux-container boundary and FDM stays native.
- The existing `frontend-3d-managed-fem` workflow label
  `[self-hosted, linux, x64, fem-managed]` denotes a Linux self-hosted runner,
  not WSL. It remains separate because the managed receipt contract currently
  validates ext4/loop-device storage via `findmnt` and durable runtime mounts.
- A future Windows-hosted managed gate is allowed only after a tested
  Windows-path/Docker Desktop storage adapter; changing the runner label alone
  is explicitly not considered a qualification.
- Repository guidance now labels the `/zfn2` + loop/ext4 instructions as the
  dedicated Linux-runner policy; they no longer imply that a Windows checkout
  must be owned or mounted by WSL.

### Windows managed storage adapter decision — 2026-08-31

`ext4` is a provenance policy of the current Linux exporter, not a requirement
of meshing or FEM numerics. The planned Windows equivalent is an explicit
`windows-folder-v1` profile (for example `C:\fullmag-managed` or
`FULLMAG_WINDOWS_MANAGED_ROOT`) with local-volume/path identity, junction/UNC
escape rejection, per-worktree namespace, write/free-space probe, owner
metadata, and same-volume staging/promotion. Docker Linux scratch may remain in
the container/volume; the Windows folder can own the immutable bundle, receipt,
and evidence. The managed CI label must not move until this adapter and its
restart/concurrency tests are qualified.

## Post-mesh growth publication gate — 2026-08-31

`packages/fullmag-py/src/fullmag/meshing/remesh_cli.py` previously measured a
declared `growth_rate`, but still published the mesh when the measured face
neighbor ratio exceeded the allowed value or when no pair could be evaluated.
The payload path now calls `validate_adjacent_size_growth`, so both cases fail
closed with `MeshGrowthValidationError` before topology or FMMQ publication.

Evidence:

```text
PYTHONPATH=scripts;packages/fullmag-py/src
python -m unittest scripts.test_fem_quality_typed_dispatch -v   28/28 PASS
```

#### Managed runtime prune is dry-run by default — 2026-08-31

`ensure-managed-fem-runtime` pozostaje nie-destrukcyjne domyślnie
(`FULLMAG_RUNTIME_PRUNE=0`), a osobny przepis `prune-managed-fem-runtimes`
wykonuje najpierw inventory/dry-run i dopiero po `apply=1` ustawia
`FULLMAG_RUNTIME_DRY_RUN=0`. Dodatkowo sam
`scripts/prune_managed_fem_runtimes.sh` ma domyślnie `FULLMAG_RUNTIME_DRY_RUN=1`,
więc bezpośredni caller nie usunie generacji bez jawnej zgody.

Evidence:

```text
static prune default contract test                                      PASS
justfile ensure/prune dry-run contract tests                             PASS (source-level)
live destructive-prune test                                             NOT VERIFIED on this Windows host (bash/WSL unavailable)
```

#### Status inventory after source-only closure pass — 2026-08-31

Zaktualizowano indeks masterplanu zgodnie z obecnym kodem: `FM-MESH-003/004/007/008/017/026/027/029`
mają częściową naprawę; `FM-MESH-009/028/032/033/034/035/036/038` oraz `FM-QUAL-005` mają
implementację bez kwalifikacji; `FM-MESH-022/037` mają jawne fail-closed behavior, lecz nie
pełny capability contract; `FM-OPS-008/013` są częściowo zamknięte. Żaden z tych punktów nie
został oznaczony jako `CLOSED`, ponieważ obecny checkout nie ma świeżego managed CPU/GPU,
browser/WebGL ani sealed production receipt.

Potwierdzone testy źródłowe:

```text
scripts.test_fem_quality_typed_dispatch                         28/28 PASS
scripts/test_fmmq_v2.py                                         10/10 PASS
packages/fullmag-py/tests/test_meshing.py                       289 PASS, 31 skipped
prune default/just dry-run source contracts                    PASS
```

#### Root package-manager contract — 2026-08-31

Usunięto wyłącznie śledzony root `package-lock.json`, który kolidował z deklaracją
`pnpm@10.8.1` i powodował ostrzeżenie VS Code o wielu lockfile'ach. Lockfile
`external_solvers/amumax/frontend/package-lock.json` pozostaje nietknięty jako
własność nested projektu. Root `.gitignore` blokuje ponowne dodanie npm lockfile'a,
a `scripts/ci/contract_guard.sh` kończy się błędem, jeśli taki plik wróci albo
zniknie kanoniczny `pnpm-lock.yaml`.

`setup_fullmag.ps1 -InstallMissing` provisionuje teraz `COREPACK_HOME` i wymaga
dokładnie `pnpm@10.8.1` w tym samym path, którego używa launcher. Nadal nie ma
live proof clean first run/offline reuse/wrong-version na pełnym Windows host,
więc OPS-014 pozostaje `PARTIALLY_FIXED`, nie `CLOSED`.

Evidence:

```text
root package-manager contract (no root package-lock, pnpm lock present)       PASS
Windows launcher/setup lock contract (31 checks)                              PASS
PowerShell parser for setup_fullmag.ps1                                        PASS
git diff --check for lockfile guard                                           PASS
```

## Evidence manifest path and digest hardening — 2026-08-31

`scripts/verify_fem_meshing_production.py` now resolves native, managed and
browser artifact paths under the manifest directory and rejects `..` traversal,
absolute paths outside the evidence root, and symlink/junction escapes.  Stages
may additionally declare `<field>_sha256` (or `artifact_sha256`), which is
verified against the file before the stage is accepted.  Existing manifests
without digest fields remain readable for the legacy `evidence.v1` contract.

The growth publication gate was also moved ahead of topology and quality
artifact creation.  A rejected post-mesh ratio therefore leaves no partial
artifact behind.

Evidence:

```text
python -m py_compile scripts/verify_fem_meshing_production.py \
  scripts/test_verify_fem_meshing_production_manifest.py                 PASS
manifest focused tests (5)                                               PASS
PYTHONPATH=scripts;packages/fullmag-py/src
python -m unittest scripts.test_fem_quality_typed_dispatch -v   28/28 PASS
```

#### FMMQ v2 publication namespace hardening — 2026-08-31

FMMQ v2 carriers no longer share one fixed `mesh_name-quality-v2.fmmq` path.
The producer derives a deterministic SHA-256 filename token from the complete
canonical identity (topology, policy, revision, family table and sidecar
identity).  Atomic replace remains the publication primitive, while distinct
concurrent remesh identities now have independent destination paths and cannot
overwrite one another's evidence.  Re-publishing the same identity remains
idempotent.  The meshing suite covers two revisions under one mesh name and
confirms both files remain readable.

Evidence:

```text
scripts/test_fmmq_v2.py                                      10/10 PASS
packages/fullmag-py/tests/test_meshing.py                    293 PASS, 31 skipped
```

#### Structured meshing quality failures — 2026-08-31

Quality publication and extraction failures now expose the same
`mesh_quality_failure.v2` envelope instead of forcing API/CI callers to parse
exception text. Threshold, non-finite metric, adjacent-growth, physical-tag
coverage and topology-mutation failures expose a stable code/pointer/metric
shape plus bounded details; threshold failures retain policy/topology/evidence
identity when supplied by the caller.

Evidence:

```text
scripts.test_fem_quality_typed_dispatch                         28/28 PASS
packages/fullmag-py/tests/test_meshing.py                       293 PASS, 31 skipped
python -m py_compile (quality/extraction/asset pipeline)         PASS
```

#### Native material-interface owner guard — 2026-08-31

The MFEM mesh builder now applies the same-side material-interface invariant at
the native boundary-collection boundary: a declared material interface must
have exactly two volume owners and their canonical cell markers must differ.
This prevents a typed interface from connecting two cells in the same material
domain, while preserving the existing rule that interface facets are not
published as MFEM boundary elements.  The mixed-P1 native contract adds a
regression for equal owner markers.  Native compilation/runtime execution is
`NOT VERIFIED` on this Windows host because the MFEM managed build is not
available locally.

#### Mixed-periodic public-route boundary — 2026-08-31

The public Python generator and `MeshData.validate()` now share an explicit
fail-closed boundary for mixed/non-tetrahedral periodic requests. Swept mixed
options are rejected before Gmsh import, and a mixed `MeshData` carrying
periodic pairs, a periodic certificate, or `periodic_seam` roles is rejected
unless a future end-to-end certificate is present. The low-level native MFEM
builder still understands an already-validated seam facet as a boundary
attribute; that is not yet mixed-periodic node-pair support. Full native/Rust
CPU/GPU parity remains `NOT VERIFIED`.

Evidence:

```text
CARGO_TARGET_DIR=C:\\git\\fullmag\\build\\cargo-targets\\fem-meshing-ir
cargo test -p fullmag-ir --lib --no-fail-fast                         98/98 PASS
```

The same external target also passed the planner contract suite, including
mixed-topology device gating and mesh-asset policy lowering:

```text
cargo test -p fullmag-plan --lib --no-fail-fast                      442/442 PASS
```
## Plan: FEM K0 eigensolve Poisson-airbox CPU/GPU i Control Room — odzyskany ledger recovery

- Worktree źródłowy: `/home/kkingstoun/git/fullmag/fullmag/.worktrees/eigensolve-k0-demag-recovery`
- Branch źródłowy: `codex/eigensolve-k0-demag`
- Source plan: `docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`
- Poniższe wpisy zachowują stan udokumentowany na branchu recovery przed
  integracją; nie zastępują świeżej kwalifikacji scalonego `master`.

N1b canonical map binding: complete source-level, independent review approved;
managed MFEM/runtime proof remains open.

N1c runner linearization descriptor: complete source-level, independent
re-review approved after fixing full-global `3N` importer semantics, runner FFI
envelope tests and validation-only `A_qq` oracle. `certificate_binding_v6`
remains `NULL`, aggregate gate remains closed, and N1d owns the full typed v6
preimage/relation producer.

N1d runner-owned certificate v6 producer: complete source-level, final
independent re-review `SPEC APPROVED / QUALITY APPROVED`. The canonical IR
producer separates magnetic-prefix and global-scalar evidence; the runner
regenerates and compares the complete accepted certificate, constructs all four
owned views, byte-aligns the native preimage and
`shared_domain_map_binding.v1`, validates the trusted ordered multi-part
registry for one physical magnetic object plus airbox, and keeps all nested ABI
v18 pointers alive. The real-plan-like fixture covers `body +
hole_transition_refinement + air` with magnetic markers 1/2, shared nodes,
x/y edge/corner closure and open z. Fresh focused evidence recorded on recovery:
IR 6/6, `modal_v6_` 8/8, `shared_domain` 13/13, `native_fem` 22/22, routing 1/1,
no-default and fem-native no-link checks PASS. Managed MFEM/CUDA runtime proof
remained open and belonged to N1e/integration.

N1e periodic-antidot eigen script slice: complete source-level, final
independent re-review `SPEC APPROVED / QUALITY APPROVED`. Added the separate
`examples/fem_periodic_antidot_relax_eigenmodes.py` without changing the
frequency-driven FMR example. Canonical Python export proves CPU
`relax -> eigenmodes` and GPU `relax -> change_device -> eigenmodes` with
devices `[cpu,gpu,gpu]`, strict/double, `full_2x2`, K0,
`periodic_airbox_k0`, bounded window and spectrum/dispersion/mode outputs.
Recorded recovery evidence: Python 7/7 plus 5 subtests, canonical pipeline and
public CPU/GPU run-config PASS, three focused Rust typed producer/CPU
routing/strict GPU rejection tests each real 1/1, py_compile and diff-check
PASS. Managed MFEM solve remained open at that checkpoint.

Task 3 (GPU K0 B_qq compile blocker): complete (commit `f6f018c4c`, independent
spec/quality review approved with no findings; source contract and diff-check
pass). Fresh managed GREEN remained the next integration gate.

Task 4 (CLI Eigenmodes bias_field_sweep merge blocker): complete (commit
`7766c1231`, independent spec/quality review approved with no findings; focused
regression, cargo check, rustfmt, and diff-check pass). Fresh managed GREEN
remained the next integration gate.

Task 11 (N1a mixed-P1 native A_qq): complete (commits `50b3a3b5..78050779c`,
independent spec/quality review approved with no Critical/Important findings;
focused MFEM container contract exit 0). Authoritative managed runtime
qualification remained open at that checkpoint.

Task A2-RI (canonical realtime invalidation for frequency-domain resources):
complete source-level (four frontend files, no solver/API schema changes),
independent review `APPROVE` with no Critical/Important/Minor findings. The
canonical key catalog covers eigen branches/dispersion/diagnostics, response
sweep/progress/cancel/diagnostics/frequency-point/field-meta and existing
manifest/spectrum/field-sweep/FMR/mode-field resources. Indexed paths are strict
non-negative `u32`, artifact aliases converge to hook keys, and
`resource.updated`/`resource.batch_changed` tests cover sibling isolation and
compatibility diagnostics routing. Recorded recovery verification: Vitest
93/93 and Control Room typecheck pass; targeted ESLint and diff-check were green
in the independent review. Managed/native/browser qualification was not claimed.

Task N2-CW1 (CPU frequency-window completion certificate): complete source-level
and focused-contract level; independent remediation re-review `APPROVE` with no
findings. The CPU Schur frequency-window path runs base and refinement shift
schedules, compares frequencies, physical cluster ranks and invariant-subspace
overlap, requires positive coverage margins, and fails closed on disagreement,
truncation, cancellation or incomplete schedules. Focused container evidence
recorded on recovery passed the positive, rank-two degeneracy, split-cluster
disagreement, empty failure and cancellation cases; documentation validation
was green (21/21). Managed runtime, full legacy monolithic binary, GPU parity
and production qualification remained explicitly open.

# Plan: FEM GPU performance remediation implementation (2026-09-01)

- Worktree: `C:\git\fullmag\worktrees\fem-gpu-performance-remediation-implementation-20260901`
- Branch: `codex/fem-gpu-performance-remediation-implementation-20260901`
- Immutable base at worktree creation: `c3f49db708868f3649a3e894416d230269718920`
- Commit policy: no commit, push, reset, stash, or cleanup performed.

## Baseline ledger

- `git status --short`: worktree contains only the task-scoped source,
  contract, Rust ABI, and performance-documentation changes listed below; the
  unrelated dirty main checkout was not modified.
- `git diff --check`: no whitespace errors; Git emitted only the expected
  LF/CRLF conversion warnings.
- `just --list`: exit `0`.
- The performance package manifest contains all 31 finding IDs and records
  `verified_commit=c3f49db708868f3649a3e894416d230269718920`, with managed GPU
  runtime still `NOT VERIFIED`.
- The repository has a documented `rebuild-fem-runtime`/`ensure-managed-fem-runtime`
  container route. No host-side FEM build was used as qualification evidence.

## Current task status

| Task | Source state | Qualification state |
|---:|---|---|
| 1 | unified transactional GPU performance snapshot, C ABI/Rust layout, attempt telemetry | managed compile/receipt pending |
| 2 | single HYPRE device-policy owner and conditional residual-validation resolver | managed compile/runtime pending |
| 3 | typed FieldOnly mode, fused/split demag recovery selection, timing hooks | parity/timing/managed pending |
| 4 | deferred RK normalization and typed attempt packet | CUDA compile/rollback proof pending |
| 5 | cosine/min rotation reduction and error-policy resolver | method specializations/managed parity pending |
| 6 | endpoint token and fail-closed FSAL policy | DP54/periodic parity pending |
| 7 | explicit metric mode and resolved `has_external_field` composition | typed reductions/output-mask integration pending |
| 8 | row scale, fused XYZ exchange, deterministic CSR builder/planner types | qualified accuracy mode/planner wiring pending |
| 9 | reduced periodic CSR/mass/lift and projection guards | energy/Armijo/PBC parity and complexity receipt pending |
| 10 | deterministic exchange planner resolver (fail-closed) | benchmark/profile/capability wiring pending |
| 11 | diagonal preconditioner builder/resolver (fail-closed) | NCG/PG-BB integration and qualification pending |
| 12 | documentation/matrix corrections and explicit evidence boundaries | managed/scientific/production gates pending |

The source changes intentionally do not promote unqualified advanced profiles,
partial assembly, preconditioners, or periodic FSAL to a public validated
capability. The remaining evidence lanes must be run on a clean source identity
after the managed runtime can be rebuilt.

## Verification wave (2026-09-02)

- Canonical Windows FEM route passed: `just windows-build backend=fem
  device=gpu frontend=static` exited `0` using Docker Desktop, CUDA `12.6.85`,
  and the RTX 4080 SUPER (`sm_89`). This is compile/package evidence, not an
  immutable managed-runtime receipt.
- Seven focused CUDA/C++ contracts passed in the same GPU image: performance
  snapshot ABI, HYPRE validation policy, exchange operator, demag FieldOnly,
  adaptive error policy, RK attempt packet, and relaxation preconditioner.
- Rust ABI and provenance-contract checks passed: `fullmag-fem-sys` 1/1 and
  runner performance-snapshot filters 3/3.
- `git diff --check` reported no whitespace errors (only expected LF/CRLF
  conversion warnings); `just --list` exited `0`; manifest metrics match all
  11 documented files; the manifest contains all 31 finding IDs.
- Targeted `rustfmt --edition 2021 --check` for the three changed Rust files
  passed. A whole-workspace `cargo fmt --all -- --check` still reports a
  formatting delta in the untouched pre-existing `crates/fullmag-runner/src/lib.rs`;
  it was not changed in this worktree.
- The managed canonical Linux runtime remains `NOT VERIFIED`: the available
  storage/export route does not currently satisfy the repository's required
  loop-backed `canonical`/`native-2` profile. Therefore no managed receipt,
  scientific CPU/GPU parity, benchmark speedup, or production qualification is
  claimed.
- During verification one invalid exchange negative case was corrected and the
  preconditioner now rejects a negative exchange weight, preserving the
  fail-closed contract.

## Reduced exchange consumer completion (2026-09-02)

- EX-01 source gap closed: periodic reduced CSR is now consumed by dedicated
  CUDA kernels for final RK exchange energy and direct-minimizer exchange
  energy difference (the Armijo input), with the full CSR path retained as the
  non-periodic/fallback route.
- Canonical Windows FEM GPU build was rerun after this change and exited `0`.
- The seven focused CMake contracts were rebuilt and passed `7/7`, including
  the exchange-operator contract; this proves CUDA compilation and source
  contracts, not periodic physics parity or a managed runtime receipt.
- The EX-01 status and coverage matrix were synchronized in both the source
  documentation package and the combined document. Managed runtime,
  field/energy/direct-energy parity, complexity receipt and benchmark remain
  `NOT VERIFIED`.
- Final documentation checks after synchronization: manifest metrics match all
  11 files, the matrix has 31 unique IDs equal to the manifest, the combined
  document's 01–10 sections match their source documents (README link paths
  remain intentionally rebased for the combined location), and the manifest
  JSON parses successfully.
