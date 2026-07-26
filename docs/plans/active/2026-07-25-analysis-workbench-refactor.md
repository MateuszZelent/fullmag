# Analysis workbench refactor — aktywny plan wdrożenia

**Status:** Active  
**Data:** 2026-07-25  
**Baseline SHA:** `2054cdde572f73f10b3a28239b2d6064dfb3fdb7`  
**Spec:** `docs/specs/frontend-v2/16-charts-analysis-module.md`

> **Dla agentów wdrażających:** wykonywać etapami TDD, z osobnym review gate po każdym etapie. Nie zmieniać physics/Python/ProblemIR dla preferencji wykresów.

## Goal, architektura i global constraints

[C] Celem jest jeden resource-first Analysis workbench i Inspector Quick Chart z bounded data plan, neutralnym shared renderer/model contract, jawnym lifecycle, persistence i export provenance. HTTP v2 pozostaje source of truth; WebSocket jest invalidation-only; ECharts Canvas v6 pozostaje default do czasu reprodukowalnego fail hard gate.

[C] Moduły nie importują prywatnych elementów innych modułów. Server payload nie trafia do workspace/Inspector store. Pełne Analysis i 3D są active-only w `viewport-main`; Quick Chart w `panel-bottom` współistnieje z aktywnym 3D bez wpływu na WebGL. Wszystkie klasy CSS `fm-*`, kolory z `--fm-*`, interaktywne chrome ze shared primitives.

## Faza A — Evidence Ledger

### Baseline i worktree

- [M] `git rev-parse HEAD`, repo, 2026-07-25: `2054cdde572f73f10b3a28239b2d6064dfb3fdb7`, exit 0.
- [M] `git status --short`, exit 0: pre-existing changes w `crates/fullmag-runner/src/fem/relax/stop.rs`, planie FEM GPU, dwóch solver submodules i teście SP4; pozostawione bez zmian.
- [M] `git submodule status`, exit 128: `fatal: no submodule mapping found in .gitmodules for path 'Codex-Usage'`.
- [M] `.gitmodules:L1-L24 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`, `git ls-files -s ...` i `git -C ... rev-parse HEAD`, exit 0: MuMax3 index/HEAD `f656494b29516bead825b444b1f0b38c6e6c7dbf`; Tetmag index `5fe0f7c5daa3db9afd2fabec6e565d5720efd6c5`, local HEAD `4fae4825ed536056e1cd499b9966c41731cd1777`; TetraX external reference unavailable.

### Przeczytane źródła

[M] Przeczytano `AGENTS.md`, `docs/specs/README.md`, `docs/plans/README.md`, frontend specs 01, 02, 03, 04, 05, 13, 14, 15, 16, 17, 18, resource-first v2 spec oraz wskazane źródła `analysis-plots`, Inspector, kernel workspace/API/resources/codecs, testy i audyty. Primary external sources: Apache ECharts handbook/API, uPlot repository, MDN OffscreenCanvas/Web Workers. Dostęp 2026-07-25.

### Mapa komponentów i przepływ

| Warstwa | Baseline owner |
|---|---|
| manifest/root | `analysis-plots/manifest.ts`, `AnalysisPlotsModule.tsx` |
| controller | `useAnalysisPlotsController.ts` łączy selection, status revisions i wiele resource hooks |
| workspace | `analysisPlotsWorkspace.ts` przechowuje axes/range/selection oraz błędnie `visibleTable` |
| table data | generated transport → `ControlRoomApi` → `useTableRowsBinaryResource` → FMTB codec |
| adapters | table rows, energy, frequency-domain → local `ChartSeries` |
| render | `EChartsSurface` + chart option/model; osobny ECharts lifecycle w Inspector frequency charts |
| diagnostics | bounded instance/setOption/resize counters, smoke i chart performance audit |

[C] Aktualny przepływ, kopie, ownership, request scenarios, test scope, rozbieżności i rozwiązania do zachowania są opisane z baseline citations w spec 16 §2. To jest zamknięcie Evidence Ledger; dalsze decyzje odwołują się do tych constraints.

### Potwierdzone sprzeczności i informacje niezweryfikowane

- [C] Potwierdzone z exact baseline citations w spec 16 §2: `charts` vs `analysis-plots`, planned vs implemented, SVG vs ECharts Canvas, store payload ownership oraz duplikowany ECharts lifecycle.
- [H] NOT MEASURED: p50/p95, request bytes, cache hits/misses, peak/retained heap, listener/observer/worker counts i Quick Chart+WebGL. Sygnał: obecne audyty nie emitują pełnego zestawu. Eksperyment: etapy 1 i 13 na trzech fixtures. Metryki: komplet `ChartPerformanceProof`. Wyniki: green plateau zamyka hipotezę; missing/failing metric wyznacza remediation.
- [H] Brak realnego screenshot proof dla tej dokumentacyjnej sesji. Sygnał: nie uruchomiono UI/runtime. Eksperyment: before/after w tej samej fixture/browser/build. Metryki: pixel artifact + a11y snapshot + canvas bounds. Wyniki: czytelna zgodność akceptuje surface; blank/clipped/ambiguous odrzuca.
- [H] Nie potwierdzono potrzeby nowego API resource. Sygnał: wszystkie obecne surfaces dają się wstępnie zmapować na tables/solver/analysis/artifacts. Eksperyment: resource coverage matrix przed każdą zmianą OpenAPI. Metryka: brakujące semantic fields/range/revision per surface. Wyniki: zero luk zabrania endpointu; realna luka uruchamia wymagania spec 16 §8.

## Faza B — Etapy migracji

Każdy etap poniżej ma własny RED/GREEN, browser proof, performance/memory gate, acceptance, rollback i compatibility removal. Commity są sugestią wykonawczą; nie są częścią tego zadania docs-only.

### Etap 1: Evidence i instrumentation gaps

**Objective:** rozszerzyć runtime audit o pełną macierz bez zmiany UX.  
**Exact files:** `apps/control-room/scripts/audit-chart-performance.mjs`, `audit-viewport-3d-memory-churn.mjs`, nowy focused test/audit helper pod `src/kernel/performance/`, package scripts/testy rejestracji.  
**Interfaces:** emitować versioned JSON `ChartPerformanceProof` z scenario/build/browser/data identity i wszystkimi metrykami spec §10.  
**Migration:** brak danych/state migration.

- **RED:** test fixture wykazuje brak payload bytes/cache/model/observer/listener/heap/WebGL/cancel fields.
- **GREEN:** instrumentacja mierzy, nie symuluje, wszystkie fields i rozdziela cold/warm.
- **Browser/visual:** baseline screenshots Analysis i 3D+Inspector; brak twierdzenia o poprawie.
- **Perf/memory:** narzut disabled diagnostics = zero; enabled bounded.
- **Acceptance:** JSON artifact dla small/medium/largest i session abort.
- **Rollback:** usunąć opt-in instrumentation, zachować istniejące audyty.
- **Compatibility removal:** source-token-only tests zastąpić runtime assertions tam, gdzie możliwe.

### Etap 2: Semantic descriptors i unit compatibility

**Files:** nowe `src/shared/domain/analysis/chartContracts.ts`, `chartUnits.ts`; migracja `chartTableModel.ts`, frequency models; focused tests.  
**Interfaces:** dokładne typy `ChartDescriptor`, `ChartSeriesDescriptor`, `ChartCursor`, `ChartSelection`, `ChartRange` ze spec §7.1.

- **RED:** mixed m/J/torque/residual zostaje odrzucone; kompatybilne SI/display units akceptowane.
- **GREEN:** dimension-aware grouping, expert dual-axis explicit.
- **Browser:** osie/units/tooltip/legend screenshot i keyboard semantics.
- **Perf/memory:** descriptor build O(series), bez payload copy.
- **Acceptance:** wszystkie surfaces mają legal quantity matrix.
- **Rollback:** adapter z legacy `ChartSeries`; no persisted format change.
- **Removal:** string-only unit compatibility usunięte po migracji consumers.

### Etap 3: Usunięcie server payload z workspace store

**Files:** `analysisPlotsWorkspace.ts`, `useAnalysisPlotsWorkspace.ts`, controller, `ChartInspectorPanel.tsx`, tests.  
**Interfaces:** store zachowuje `tableId`, axes, range, selection row identity, display prefs; columns czytane z resource hook/shared selector.

- **RED:** test zabrania `TableRowsResource`, arrays i payload fields w snapshot/persistence.
- **GREEN:** Inspector i Analysis współdzielą stable ids/preferences, nie payload.
- **Browser:** Inspector axis controls działają bez dodatkowego rows fetch.
- **Perf/memory:** payload lease count nie rośnie przy Inspector open.
- **Acceptance:** session switch re-key/reset; zero stale cross-session payload.
- **Rollback:** compatibility selector czyta resource cache, nigdy store copy.
- **Removal:** `visibleTable` i `setTableState` usunięte po wszystkich consumers.

### Etap 4: Bounded decode/cache i `ChartDataPlan`

**Files:** table codec/cache/resource hook, nowe shared data-plan builders/worker protocol, adapters/tests.  
**Interfaces:** `ChartDataPlan` ze spec; decoded columnar lease z AbortSignal i byte budget.

- **RED:** oversized, aborted, revision mismatch, malformed, endpoint/extrema decimation tests.
- **GREEN:** one bounded decode, transferable worker input gdy próg przekroczony.
- **Browser:** range miss fetchuje raz, range hit zero.
- **Perf:** p50/p95/bytes/cache/model metrics; largest realistic bez long-task loop.
- **Memory:** lease release po consumer/unmount/session switch.
- **Acceptance:** brak pełnego `Float64Array -> number[][] -> points` dla production path.
- **Rollback:** small-data synchronous bounded adapter.
- **Removal:** legacy row reducer po equivalence tests.

### Etap 5: Neutral shared renderer/model boundary

**Files:** nowe `src/shared/analysis-charts/` contracts/model/ECharts adapter/surface; migracja `EChartsSurface`, `FrequencyDomainCharts`, tests.  
**Interfaces:** `ChartRenderModel`, renderer `mount/update/resize/export/dispose`; renderer-specific option prywatny.

- **RED:** real lifecycle test init/update/event/observer/dispose i zero post-unmount callback.
- **GREEN:** jeden ECharts Canvas v6 owner implementation dla Analysis/Inspector/dock.
- **Browser:** matching chart screenshots i a11y tree.
- **Perf:** one setOption per relevant render model; zero idle.
- **Memory:** instances/listeners/observers return baseline.
- **Acceptance:** Inspector nie implementuje `echarts.init`.
- **Rollback:** legacy surfaces behind bounded compatibility adapter.
- **Removal:** local frequency ECharts frame po parity.

### Etap 6: Rozdzielenie Analysis workbench surfaces

**Files:** thin `AnalysisPlotsView.tsx`, surface registry i `Overview/Energy/Dynamics/Convergence` components/models/tests.  
**Interfaces:** każda surface konsumuje descriptor + render model status, nie resource hook bezpośrednio.

- **RED:** surface quantity/default/state matrix tests.
- **GREEN:** compact workbench tabs, provenance/status strip.
- **Browser:** before/after, narrow layout, keyboard tabs.
- **Perf:** inactive surface nie buduje modelu/renderera.
- **Memory:** tylko aktywna surface lease/instance.
- **Acceptance:** spec §4 matrix complete.
- **Rollback:** Overview routes legacy combined chart.
- **Removal:** monolithic branches usunięte dopiero po parity; split tylko dla real ownership/re-render boundary.

### Etap 7: Inspector Quick Chart

**Files:** Inspector registry/panel adapter, shared Quick Chart view, descriptor selection adapter, tests.  
**Interfaces:** selected resource → `ChartDescriptor`; hover local; click `ChartSelection`.

- **RED:** open/close przy 3D nie może fetchować field/topology ani dirty 3D.
- **GREEN:** compact ready/stale/unsupported/empty/degraded/error UI.
- **Browser:** pinned/unpinned, keyboard cursor, WebGL visible/responsive.
- **Perf:** controls p95 target, zero idle/refetch.
- **Memory:** renderer/observer/listener returns baseline.
- **Acceptance:** same resource cache lease co full Analysis.
- **Rollback:** disable Quick Chart contribution.
- **Removal:** bespoke Inspector chart lifecycle po parity.

### Etap 8: Dock/aux ownership

**Files:** `manifest.ts`, kernel slot/layout typings/host, slot adapters, tests/spec catalog if semantics change.  
**Interfaces:** `analysis-plots` contributes `viewport-main` + `panel-bottom`; slot-specific config only.

- **RED:** duplicate payload fetch and duplicate cache entry test.
- **GREEN:** panel-bottom dock keeps 3D mounted; viewport-aux remains unused/deferred.
- **Browser:** open/close/pin/unpin and focus/resize.
- **Perf/memory:** no 3D dirty frame/context/resource growth.
- **Acceptance:** one cache identity across consumers.
- **Rollback:** unregister panel-bottom slot.
- **Removal:** no compatibility alias if `charts` manifest existed.

### Etap 9: Selection i chart-to-viewport command

**Files:** shared selection types, kernel event/command registry, chart/viewport adapters, tests.  
**Interfaces:** `ChartSelection`, cancellable `ChartViewportHandoff`; command completion resource.

- **RED:** point click cannot load field implicitly; abort/session switch covered.
- **GREEN:** explicit Load in 3D command with requested/resolved provenance.
- **Browser:** click vs command visually distinct, cancellation visible.
- **Perf:** selection zero fetch; command only required resources.
- **Memory:** aborted field buffer not adopted.
- **Acceptance:** camera/topology unchanged until completed explicit handoff.
- **Rollback:** remove command, retain semantic selection.
- **Removal:** direct chart→viewport callbacks/imports forbidden.

### Etap 10: Export i provenance

**Files:** shared export model, command contribution, facade only if existing persistence export is insufficient, tests/UI.  
**Interfaces:** CSV/TSV/PNG + provenance sidecar schema ze spec §11.

- **RED:** numeric round-trip, unit/provenance, stale/degraded and abort tests.
- **GREEN:** explicit export, safe filenames/object URL cleanup.
- **Browser:** downloaded file inspection + image visual proof.
- **Perf:** bounded export and worker for large rows.
- **Memory:** object URL and export buffer released.
- **Acceptance:** source identity/revision/query/decimation embedded.
- **Rollback:** disable image format, canonical data export remains.
- **Removal:** ad-hoc component downloads.

### Etap 11: Frequency-domain consolidation

**Files:** `FrequencyDomainCharts.tsx`, Analysis frequency surfaces, shared models/renderer, Inspector sections/tests.  
**Interfaces:** common descriptors for response/eigenmodes/dispersion; Inspector remains detail, Analysis workbench overview/exploration.

- **RED:** unit/trust/provenance/state parity and no private module import.
- **GREEN:** shared contract + renderer, distinct surface composition.
- **Browser:** response/eigen/dispersion interactions and explicit field command.
- **Perf/memory:** no duplicate dataset/renderer when hidden.
- **Acceptance:** old and new fixture numeric equivalence.
- **Rollback:** compatibility adapter per dataset kind.
- **Removal:** local option builders/lifecycle after parity.

### Etap 12: Compatibility cleanup

**Files:** legacy adapters/events/types/tests/docs directly referencing `charts` alias or old row ownership.  
**Interfaces:** canonical `analysis-plots:*` vocabulary, migration map for persisted keys.

- **RED:** repo scans fail on unallowlisted alias/direct fetch/private import.
- **GREEN:** only documented migration readers remain.
- **Browser:** old persisted layout repairs deterministically.
- **Perf/memory:** no dual subscribers or duplicate resources.
- **Acceptance:** allowlist empty or each entry has owner/removal date.
- **Rollback:** versioned one-release migration reader.
- **Removal:** reader removed after compatibility window and telemetry/proof.

### Etap 13: Final stress i cutover

**Files:** all audits/tests touched above, acceptance docs only after evidence.  
**Interfaces:** final `ChartPerformanceProof` artifact.

- **RED:** run full matrix before enabling cutover; any missing metric is failure, not zero.
- **GREEN:** typecheck/lint/test/smoke/chart/idle/viewport-memory gates all exit 0.
- **Browser:** before/after, scientific labels, keyboard/a11y, 100 switches.
- **Perf:** cold/warm p50/p95, requests/bytes/cache/model/setOption/dirty frames.
- **Memory:** Canvas/ECharts/worker/listener/observer/heap/WebGL bounded; no context loss; non-zero drawing buffer.
- **Acceptance:** wszystkie hard invariants i calibrated targets pass on recorded build/browser/fixtures.
- **Rollback:** disable dock/Quick Chart/new workbench registration and restore compatibility adapter; nie cofać canonical data.
- **Removal:** cutover dopiero po dwóch powtarzalnych green runs; potem usunąć adapters w osobnym review.

## Końcowe komendy wdrożeniowe

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room smoke:analysis-plots
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

[H] NOT RUN w zadaniu dokumentacyjnym: powyższe weryfikują przyszłą implementację, a kod aplikacji nie został zmieniony. Sygnał: brak implementacyjnego diffu i brak uruchomionego UI. Eksperyment: uruchomić komendy po etapach na działającym production build/runtime/Playwright i opisanych fixtures. Metryka: exit code i artifacts każdego gate. Wyniki: exit 0 z kompletnym dowodem akceptuje; każdy non-zero lub brak artifact blokuje etap.
