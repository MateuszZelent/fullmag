# Subagent-driven development progress

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
