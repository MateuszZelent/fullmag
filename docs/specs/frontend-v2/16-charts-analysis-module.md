# Frontend v2 — Analysis workbench i wykresy naukowe

**Status:** Kanoniczny kontrakt docelowy
**Data:** 2026-07-25
**Moduł:** `analysis-plots`
**Baseline audytu:** `2054cdde572f73f10b3a28239b2d6064dfb3fdb7`

## 1. Cel i granice

[C] `analysis-plots` jest modułem inspekcji i postprocessingu danych naukowych w jednym workspace. Nie oblicza ukrytej fizyki, nie jest drugim modelem sesji i nie tworzy osobnego UX dla FDM/FEM. Źródła: `AGENTS.md`, `docs/specs/resource-first-control-room-api-v2.md` oraz `docs/specs/frontend-v2/01-module-kernel-architecture.md`.

[C] Kanoniczna nazwa modułu, eventów i komend to `analysis-plots`; istniejące eventy `charts:*` są compatibility vocabulary do usunięcia w etapie migracji, a nie nazwą modułu. Preferencje wykresu nigdy nie zmieniają canonical Python ani `ProblemIR`.

[V] Baseline ma działający manifest `analysis-plots` w `viewport-main`, deklarujący eventy `charts:*` i komendę `analysis-plots.open`: `apps/control-room/src/modules/analysis-plots/manifest.ts:L3-L33 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

## 2. Audyt baseline

### 2.1 Przepływ danych

[V] Aktualna ścieżka tabeli jest zgodna z resource-first do poziomu hooka: runtime/artifact → OpenAPI generated transport → `ControlRoomApi.data.tables.rowsBinary()` → `useTableRowsBinaryResource()` → FMTB codec (`Float64Array`) → `tableRowsResourceFromBinary()` (`number[][]`) → workspace store → `buildScalarChartSeries()` (per-series point objects) → `buildChartOption()` → ECharts Canvas. Źródła: `apps/control-room/src/kernel/api/ControlRoomApi.ts:L1122-L1131`, `apps/control-room/src/kernel/resources/studyRuntimeResources.ts:L1981-L2038`, `apps/control-room/src/kernel/api/codecs/tableRowsCodec.ts:L11-L64`, `apps/control-room/src/modules/analysis-plots/tableRowsAdapter.ts:L56-L102`, `apps/control-room/src/modules/analysis-plots/chartTableModel.ts:L267-L329`, `apps/control-room/src/modules/analysis-plots/components/chartSurfaceModel.ts:L37-L62 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] Zapytanie tabeli rozdziela semantic axis/view state od query range, lecz zoom po 200 ms zmienia zakres requestu; wybór osi/legendy nie powinien zmieniać query identity, jeśli potrzebne kolumny są już w buforze. Baseline controller wywołuje `useTableRowsBinaryResource` z memoizowanym query, a `EChartsSurface` debouncuje `dataZoom`: `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts:L68-L101`, `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx:L133-L159`, `apps/control-room/src/modules/analysis-plots/components/chartSurfaceModel.ts:L64-L79 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] `analysisPlotsWorkspaceStore` narusza docelowy ownership: `AnalysisTableState.visibleTable` przechowuje pełny `TableRowsResource`, a Inspector czyta jego kolumny. `apps/control-room/src/kernel/workspace/analysisPlotsWorkspace.ts:L1-L33`, `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.tsx:L32-L64 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] Baseline tworzy co najmniej trzy materializacje po decode: `Float64Array`, row-major `number[][]`, następnie tablice `ChartPoint` i tablice ECharts option. Dodatkowa ścieżka `buildChartSeriesModel` kopiuje wiersze przez `[...row]`. `apps/control-room/src/modules/analysis-plots/tableRowsAdapter.ts:L56-L102`, `apps/control-room/src/modules/analysis-plots/chartTableModel.ts:L213-L263`, `apps/control-room/src/modules/analysis-plots/chartTableModel.ts:L267-L329 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[H] Rzeczywisty peak heap i czas tych kopii są niezmierzone. Sygnał: wielokrotna materializacja O(rows × columns). Eksperyment: fixture small/medium/largest realistic, Chrome CDP allocation sampling przed/po decode/model/setOption. Metryki: peak/retained heap, allocations, p50/p95 decode/model/update. Wyniki: jeśli hard gate przechodzi, zachować prostszą ścieżkę; jeśli nie, przejść na bounded columnar buffer i worker plan.

### 2.2 Ownership i lifecycle

| Zasób | Owner baseline | Release trigger | Ocena |
|---|---|---|---|
| FMTB `ArrayBuffer`/`Float64Array` | resource hook/cache | invalidation/consumer release | [V] codec jest bounded i waliduje format; `tableRowsCodec.ts:L11-L64 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| `TableRowsResource.rows` | workspace store | reset/session lifecycle | [V] błędny server-payload owner; `analysisPlotsWorkspace.ts:L4-L30 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| `ChartSeries.points` | React memo/model | zmiana resource/axes | [V] derived allocation; `AnalysisPlotsView.tsx:L81-L102 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| ECharts primary | `EChartsSurface` | component unmount | [V] observer, RAF schedulers, timer, events i instance są czyszczone; `EChartsSurface.tsx:L89-L184 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| ECharts frequency Inspector | `FrequencyDomainEChartsFrame` | panel unmount | [V] osobny lifecycle i option builder; `FrequencyDomainCharts.tsx:L469-L543 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| chart hover | ECharts/local ref | pointer exit/unmount | [C] pozostaje renderer-local; nie trafia do store/event bus; źródło: wymagania tego kontraktu |
| semantic selection | kernel selection | selection replacement/session switch | [V] istniejący point click publikuje mały obiekt bez historii; `EChartsSurface.tsx:L115-L122`, `useAnalysisPlotsController.ts:L238-L262 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |

[V] Primary ECharts używa Canvas, dynamicznego importu, jednego `ResizeObserver`, one-shot RAF schedulerów, `setTimeout` wyłącznie do debounced range commit i pełnego cleanup; nie używa `setInterval`. `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx:L89-L197 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] Inspector frequency-domain ma drugą implementację `echarts.init`, eventów, observera, RAF i dispose, więc Analysis i Inspector współdzielą modele tylko częściowo, nie neutralny renderer/lifecycle. `apps/control-room/src/modules/inspector/panels/FrequencyDomainCharts.tsx:L427-L543 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

### 2.3 Request scenarios baseline

| Scenariusz | Baseline / kontrakt |
|---|---|
| mount | [V] columns + bounded binary rows oraz zależne resources; controller `useAnalysisPlotsController.ts:L86-L137 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| idle | [V] skrypt sprawdza brak nowych `rows.bin` i brak `setOption`; nie mierzy heap/WebGL/listenerów; `apps/control-room/scripts/audit-chart-performance.mjs:L179-L210 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| zoom/pan | [V] `dataZoom` → 200 ms commit → range query; lokalna animacja interakcji nie wymaga refetch do chwili commit; `EChartsSurface.tsx:L133-L159`, `chartSurfaceModel.ts:L64-L79 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| point selection | [V] lokalny ECharts click → mały cursor/selection, bez field fetch; `EChartsSurface.tsx:L115-L122`, `L140-L149 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| series/legend toggle | [V] smoke wymaga 0 `rows.bin`; model może się przebudować lokalnie; `apps/control-room/scripts/smoke-analysis-plots.mjs:L293-L325 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| axis change | [V] smoke wymaga 0 `rows.bin` dla dostępnych kolumn; query identity nie może zależeć od display unit; `apps/control-room/scripts/smoke-analysis-plots.mjs:L328-L416 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7` |
| run/stage/relevant revision | [C] dokładnie jeden refetch właściwego resource key; stale-while-revalidate jest jawne |
| irrelevant revision | [C] zero fetch/model rebuild/setOption |
| Inspector open/close/tab | [H] Sygnał: dwa lifecycle rendererów i brak wspólnego stress gate. Eksperyment: 100 open/close/tab switches z instrumentacją cache i resources. Metryki: fetch/cache hit, instances/listeners/observers/heap. Wyniki: plateau potwierdza reuse/cleanup; wzrost lub duplicate fetch potwierdza lukę. |

### 2.4 Testy i audyty baseline

[V] Codec testuje row-major decode, resync flag i malformed payload; nie testuje transfer ownership ani peak memory. `apps/control-room/src/kernel/api/codecs/tableRowsCodec.test.ts:L29-L68 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] `EChartsSurface.test.tsx` jest głównie source/SSR assertion: potwierdza overlay oraz obecność scheduler/cleanup tokenów; nie montuje realnej instancji, observera ani listenerów. `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.test.tsx:L25-L87 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] `smoke-analysis-plots.mjs` sprawdza canvas/drawing buffer, niepusty obraz, legendę, axis/series/point/range events i request budget. `audit-chart-performance.mjs` sprawdza idle request/setOption oraz instance counter przez domyślnie 100 przełączeń. Nie mierzą p50/p95, payload bytes, cache hit/miss, heap, listeners, observers, workers ani WebGL context podczas Quick Chart. `apps/control-room/scripts/smoke-analysis-plots.mjs:L65-L122`, `apps/control-room/scripts/smoke-analysis-plots.mjs:L545-L661`, `apps/control-room/scripts/audit-chart-performance.mjs:L179-L281 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] `audit-idle-performance.mjs` jest statycznym audytem wystąpień RAF/allowlist, nie browser runtime profilerem. `apps/control-room/scripts/audit-idle-performance.mjs:L40-L124 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[V] `audit-viewport-3d-memory-churn.mjs` mierzy heap, WebGL buffers, resource listeners, workers, idle frames i drawing-buffer fidelity dla 3D, ale nie jest obecnie połączony ze scenariuszem Quick Chart. `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs:L228-L344`, `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs:L443-L565 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

### 2.5 Rozbieżności dokumentacja–kod i zachowywane rozwiązania

- [V] Poprzednia spec 16 nazywała moduł `charts/`; kod i katalog używają `analysis-plots`. Zachować kodową nazwę. `docs/specs/frontend-v2/16-charts-analysis-module.md:L8-L33` (baseline content przez `git show`) i `apps/control-room/src/modules/analysis-plots/manifest.ts:L3-L8 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.
- [V] Poprzednia spec 15 twierdziła, że baseline renderer to SVG i ECharts jest przyszły; kod i `package.json` mają ECharts Canvas `^6.0.0`. `apps/control-room/package.json:L74-L81`, `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx:L100-L106 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.
- [V] Katalog oznaczał `analysis-plots` jako planned mimo implementacji manifestu, widoku, testów i smoke. Zachować lifecycle active-only, ale skorygować status dokumentacyjny. `docs/specs/frontend-v2/02-module-catalog.md:L20-L20` (baseline content przez `git show`) i `apps/control-room/src/modules/analysis-plots/manifest.ts:L3-L33 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.
- [V] Zachować: generated transport/facade/hooks, HTTP truth + WS invalidation, binary FMTB validation, bounded server decimation, unit limit w axis selection, event/command boundary, Canvas ECharts cleanup, Catppuccin tokens i brak polling. `docs/specs/frontend-v2/03-api-integration-layer.md:L13-L50`, `apps/control-room/src/kernel/api/codecs/tableRowsCodec.ts:L11-L64`, `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx:L89-L197 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.
- [V] TetraX nie ma osobnego lokalnego submodułu. Nie jest aliasem Tetmag; status: `external reference unavailable`. `.gitmodules:L1-L24 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

## 3. Zewnętrzne wzorce i decyzja rendererowa

[V] MuMax3 jest submodułem `external_solvers/3` (index i HEAD `f656494b29516bead825b444b1f0b38c6e6c7dbf`); canonical `table.txt`, osobne field outputs i proste postprocessing tools wspierają zasadę: tabela jest artefaktem, a wykres widokiem. `.gitmodules:L1-L3`, `external_solvers/3/engine/table.go:L1-L260`, `external_solvers/3/cmd/mumax3-plot/main.go:L1-L111 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[M] `git ls-files -s external_solvers/tetmag` i `git -C external_solvers/tetmag rev-parse HEAD`, exit 0: index `5fe0f7c5daa3db9afd2fabec6e565d5720efd6c5`, lokalny HEAD `4fae4825ed536056e1cd499b9966c41731cd1777`. W lokalnym źródle log rozdziela czas, energie, torque, M i H z jednostkami, a snapshoty VTK są osobnymi outputs: `external_solvers/tetmag/main/TheSimulation.cpp:L88-L91`, `L225-L283`, `L325-L351 @ 4fae4825ed536056e1cd499b9966c41731cd1777`. Zasada do zachowania: canonical outputs/provenance są niezależne od UI postprocessingu.

| Wariant | Mocne strony | Ryzyka / koszt | Decyzja |
|---|---|---|---|
| ECharts Canvas v6 | baseline, zoom/cursor/legend/export/a11y surface, Canvas zalecany przez projekt ECharts dla wielu elementów | bundle, option allocations, main-thread lifecycle | [P] default; uporządkować shared boundary, nie migrować |
| uPlot | mały Canvas time-series renderer, prosty columnar input | węższy chart vocabulary, plugin work dla a11y/export/complex analysis, drugi renderer lifecycle | [P] tylko spike po niespełnieniu hard gate |
| własny Canvas/worker | pełna kontrola nad buffers i worker | największy koszt utrzymania, a11y, hit testing, export | [P] odrzucić jako default; dopuszczalny wyłącznie dla udowodnionej specjalnej surface |

[C] Primary sources, dostęp 2026-07-25: [Apache ECharts Canvas/SVG handbook](https://echarts.apache.org/handbook/en/best-practices/canvas-vs-svg/), [Dataset](https://echarts.apache.org/handbook/en/concepts/dataset/), [Data Transform](https://echarts.apache.org/handbook/en/concepts/data-transform/), [SSR](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/), [uPlot repository](https://github.com/leeoniya/uPlot), [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) i [Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API). Twierdzenia marketingowe o milionach punktów nie są pomiarem Fullmag.

[P] Renderer comparison proposal: uzasadnienie — baseline już spełnia szeroki scientific interaction contract; alternatywy — uPlot lub własny Canvas; ryzyko — ECharts może nie spełnić largest-data hard gate; koszt — shared-boundary refactor bez dependency migration, spike tylko po fail; acceptance — pełna macierz §10; rollback — zachować dotychczasowy ECharts adapter. Szczegółowe progi ewentualnej migracji podaje następny akapit.

[P] Spike rendererowy uruchamiamy tylko po fail hard gate. Dataset: 10k/100k/1M punktów × 1/4/12 series, monotonic time, gaps/NaN, extrema i live tail. Scenariusze: cold/warm mount, pan/zoom/cursor, unit switch, append/revision, PNG/SVG/CSV export, unmount i Quick Chart przy 3D. Metryki: p50/p95, long tasks, peak/retained heap, bundle delta, instances/listeners/observers/workers, 3D dirty frames/context. Akceptacja migracji: kandydat przechodzi wszystkie hard invariants i daje ≥30% p95 lub ≥25% retained-heap improvement w dwóch largest-realistic fixtures bez regresji a11y/export; rollback: pozostaje ECharts.

## 4. Docelowe powierzchnie Analysis workbench

| Surface | Scientific purpose | Quantity families / osie | Default / provenance | Interactions i stany |
|---|---|---|---|---|
| Overview | stan run/stage i najważniejsze sygnały | kompatybilne scalar summaries, bez mieszania units | m, energy, convergence w oddzielnych panes; run/stage/revision | select, open detail; wszystkie lifecycle/trust states |
| Energy | bilans energii | energy `[J]` lub jawnie density `[J/m3]`; x=time/step | total + dostępne terms; method/backend/precision | legend, range, export; bez m/torque na osi |
| Magnetization / Dynamics | dynamika m/M | dimensionless m albo `A/m`; x=time | mx,my,mz lub projections | cursor/selection, component/unit display |
| Convergence | jakość solvera | torque, residual, energy delta w osobnych unit groups | canonical stop observables | threshold overlays, log scale |
| Frequency Response | response vs frequency | amplitude/phase per compatible observable; Hz display scales | resource provenance i drive | peak select, explicit load-field command |
| Eigenmodes | spectrum/mode quality | frequency, damping, residual; rozdzielone semantics | solver/method/mesh/field provenance | mode select, explicit overlay command |
| Dispersion / Sweep | branches over k/parameter | compatible branch quantity + axis coordinate | sweep definition/revision | branch selection, range |
| Results / Artifacts Navigator | odkrywanie canonical outputs | metadata, not raw plot state | run/stage/artifact identity | open, pin, export |
| Inspector Quick Chart | szybki kontekst selection | jedna unit-compatible group | selection resource/revision | hover local, click semantic selection |
| Points Table (optional) | dokładne wartości | wirtualizowane bounded rows | ten sam data plan | keyboard navigation/copy/export |

[C] Każda surface musi pokazywać osie z jednostkami, legendę, tooltip bez raw tuple, provenance, status resource i oddzielny scientific trust/quality. `unsupported`, `empty`, `degraded` i `error` nie mogą wyglądać jak gotowe zero.

### 4.1 Tekstowy wireframe

```text
┌ unified ribbon: Analysis commands / quantity / unit / export ┐
├ Results/Artifacts ┬ viewport-main: Analysis workbench ┬ Inspector ┤
│ run/stage tree    │ tabs: Overview Energy Dynamics ... │ source   │
│ artifacts         │ toolbar + scientific chart/table   │ units    │
│ provenance badges │ status + provenance strip          │ quality  │
├───────────────────┴ panel-bottom Quick Chart dock ──────┴──────────┤
│ pinned descriptor | compact chart | cursor | explicit Load in 3D  │
└ status-bar: session/run/stage/revisions/backend/precision ─────────┘
```

### 4.2 Współistnienie z 3D

[P] Quick Chart jest slot-aware wariantem `analysis-plots` w `panel-bottom`; etap pierwszy nie aktywuje `viewport-aux`. Uzasadnienie: jeden manifest/descriptor/cache/renderer contract bez nowego modułu i bez importu Inspector → Analysis. Alternatywa osobnego dock module zwiększa lifecycle i cache consumers; `viewport-aux` rezerwujemy dla przyszłego jawnego split view. Ryzyko: root stanie się wielotrybowy; koszt: cienkie slot adapters, manifest/layout tests i stress audit; acceptance: slot adaptery są cienkie i współdzielą neutralne `src/shared` contracts; rollback: disable `panel-bottom` contribution bez zmiany full Analysis.

[C] Przy Quick Chart `viewport-3d` pozostaje zamontowany, widoczny i responsywny. Hover/cursor/zoom/pan/legend/unit conversion: zero field/topology fetch, camera change, topology rebuild, unchanged-buffer upload i 3D dirty frame. Point click publikuje małą `ChartSelection`. Pole/snapshot ładuje tylko jawna anulowalna `ChartViewportHandoff` command.

[C] Pełne Analysis w `viewport-main` jest jedyną ciężką zamontowaną powierzchnią. Wejście odmontowuje `viewport-3d` i zwalnia module-owned WebGL; powrót korzysta z revision-aware cache, persisted camera/display profile i stable selection. Hidden Canvas, CSS hiding i `forceMount` są zabronione.

## 5. Macierz stanów

| Resource lifecycle | Znaczenie |
|---|---|
| `idle` | descriptor istnieje, request jeszcze niepotrzebny/nieuruchomiony |
| `loading` | brak ready payload dla identity/query |
| `ready` | payload odpowiada requested revision/query |
| `stale` | poprzedni payload widoczny z jawnym stale badge, refresh pending/allowed |
| `unsupported` | capability/quantity/resource nie istnieje; powód typed |
| `empty` | poprawna odpowiedź ma zero chartable samples |
| `degraded` | dane renderowalne, lecz np. decimated/incomplete/estimated |
| `error` | fetch/decode/model/renderer/export failure, warstwa wskazana |
| `aborted` | request/worker anulowany przez query/session/unmount; nie pokazuj jako error |

[C] Niezależny `ScientificTrust` ma `qualified | under_resolved | estimated | incomplete | unknown`. Resource `ready` nie oznacza `qualified`; `stale` nie nadpisuje trust payloadu.

## 6. Trzy znaczenia zapisu

| Klasa | Owner / format | Identity i lifetime | Invalidation/usuwanie/export |
|---|---|---|---|
| canonical simulation data/artifacts | runtime/resources; JSON metadata + binary/data artifact | session/run/stage/resource/revision; durable wg artifact policy | runtime revision, retention policy; export zachowuje provenance |
| chart preferences | user/workspace persistence; versioned compact JSON descriptor refs | user + workspace + surface + descriptor id; bez payload | migration/version reset/session re-key; delete preference only |
| chart/data export | explicit export command; PNG/SVG/PDF-view + CSV/TSV/data artifact ref | immutable export timestamp + source identities/revisions/query | nie jest cache; failed/stale/degraded jawne; provenance embedded/sidecar |

[C] Preferencje zawierają tylko surface, descriptor ids, axes/units, visible series, range mode, dock/pin i presentation. Zakazane: histories, typed arrays, `number[][]`, topology, renderer options, canonical simulation state.

## 7. Docelowa architektura danych

```text
resource identity + revision + query
  -> typed ControlRoomApi facade / revision-aware hook
  -> bounded binary decode + ResourceCache
  -> immutable ChartDataPlan
  -> optional abortable worker/decimation
  -> immutable ChartRenderModel
  -> renderer adapter (ECharts Canvas v6 default)
```

| Etap | Input → output | Owner/cache key | Abort/release/invalidation | Allocation/instrumentation |
|---|---|---|---|---|
| facade/hook | typed identity/query → response bytes/envelope | kernel resource layer; session+resource+revision+canonical query | AbortSignal; session/unmount/query; relevant only | request count/bytes/p50/p95/cache result |
| decode/cache | FMTB/analysis codec → bounded columnar decoded buffer | ResourceCache; codec+ETag+revision+query | consumer lease/eviction; no React/store copy | decode time/bytes/leases |
| data plan | descriptor+buffer metadata → `ChartDataPlan` | shared pure builder; semantic key | replaced on relevant semantic change | build count/time, planned points |
| worker | plan+transferable lease → reduced columns/extrema map | bounded worker pool; plan key | AbortSignal/session/unmount/new plan | queue/compute/cancel/transfer bytes |
| render model | reduced columns+display prefs → `ChartRenderModel` | consumer memo/cache; descriptor+data revision+display profile | consumer release | model builds/allocations |
| renderer | render model → pixels/events/export | mounted surface | unmount/renderer failure; local hover only | init/dispose/setOption/redraw/observer/listener |

### 7.1 Neutralne kontrakty

```typescript
type ChartDescriptor = {
  id: string; surface: ChartSurfaceKind; title: string;
  series: readonly ChartSeriesDescriptor[]; x: ChartAxisDescriptor;
  provenancePolicy: ChartProvenancePolicy;
};
type ChartSeriesDescriptor = {
  id: string; quantityId: string; dimension: PhysicalDimension;
  canonicalUnit: string; source: ChartResourceRef; role: "line"|"points"|"band";
};
type ChartDataPlan = {
  key: string; resource: ChartResourceIdentity; revision: RevisionToken;
  query: ChartResourceQuery; columns: readonly string[];
  budget: { targetPoints: number; maxDecodedBytes: number; decimation: DecimationKind };
};
type ChartRenderModel = {
  descriptorId: string; axes: readonly ChartAxisModel[];
  series: readonly ChartRenderSeries[]; status: ChartCompositeStatus;
  provenance: ChartProvenance; dataRevision: RevisionToken;
};
type ChartCursor = { descriptorId: string; seriesId: string; rowId: string; x: number; y: number };
type ChartSelection = { source: ChartResourceIdentity; rowIds: readonly string[]; semanticTarget?: SemanticTargetRef };
type ChartRange = { axisId: string; from: number; to: number; unit: string };
type ChartViewportHandoff = { selection: ChartSelection; fieldRef: FieldResourceRef; commandId: string };
```

[C] `ChartDescriptor` nie zawiera payload; `ChartDataPlan` nie zawiera renderer option; decoded buffer nie jest React/Zustand state; `ChartRenderModel` nie zawiera ECharts-specific types. Renderer option powstaje wewnątrz adaptera i nie jest persisted.

[P] Unit compatibility opiera się na physical dimension + canonical SI unit, nie string equality. Uzasadnienie: string unit nie dowodzi zgodności wymiarowej; alternatywa: osobny chart dla każdej series; ryzyko: błędny katalog dimension; koszt: shared registry i testy. Domyślnie jedna Y-axis dimension/unit family. Dwie osie są jawnie włączanym expert mode z opisanymi sides i provenance; m, energy, torque, field i residual nie są łączone heurystycznie. Acceptance: matrix tests dla wszystkich families; rollback: pojedyncza seria/oś z widocznym unsupported reason.

## 8. Zasoby API

[V] Baseline ma wystarczające families dla pierwszej migracji: `data/tables/{table_id}/rows(.bin)`, solver energy, frequency/eigenmode/dispersion resources i artifacts. Nie ma dowodu uzasadniającego screen-shaped endpoint. `docs/specs/resource-first-control-room-api-v2.md:L51-L64`, `apps/control-room/src/kernel/api/ControlRoomApi.ts:L778-L815`, `L1122-L1131 @ 2054cdde572f73f10b3a28239b2d6064dfb3fdb7`.

[P] Nie dodawać endpointu w etapach 1–10. Uzasadnienie: ledger nie wykazał luki; alternatywa: rozszerzyć istniejący canonical resource; ryzyko: później ujawniona semantyczna luka; koszt: coverage matrix przed OpenAPI work. Jeśli luka powstanie, propozycja trafia do rodziny `data` albo `analysis`, z identity run/stage/dataset, revision/ETag, typed OpenAPI, binary codec, range/pagination/decimation i shared hook. Acceptance: dwóch niezależnych consumers używa tej samej semantyki; rollback: adapter do istniejącego artifact/table resource.

## 9. Interakcje, refetch i query identity

| Akcja | Fetch? | Model/render | 3D wpływ |
|---|---|---|---|
| hover/cursor | nie | renderer-local overlay | zero |
| legend toggle | nie | local render model | zero |
| display unit | nie | transform labels/values from cached canonical units | zero |
| X/Y axis from cached columns | nie | rebuild model | zero |
| zoom/pan within decoded window | nie | renderer-local | zero |
| range commit outside window | tak, bounded query | stale → ready | zero field/topology |
| point click | nie | publish `ChartSelection` | selection highlight only if adapter supports it |
| Load in 3D | explicit command | cancellable field/snapshot resource | may switch/dirty 3D after command completion |
| relevant revision | dokładnie jeden consumer fetch | data plan/model/setOption once | only if same relevant 3D resource |
| irrelevant revision | nie | zero | zero |
| session switch | abort old; fetch new identity | clear/re-key prefs and selection | normal viewport session teardown |

## 10. Budżety i procedura dowodowa

[C] HARD INVARIANT: zero idle polling/refetch/RAF/redraw; zero context loss; non-zero drawing buffer po powrocie; active-only heavy `viewport-main`; cleanup instances/workers/listeners/observers; bounded resource/heap growth; abort nie publikuje starego stanu.

[P] PROVISIONAL TARGET, do kalibracji po baseline: warm local control p95 ≤50 ms; warm range model+render p95 ≤100 ms dla medium; relevant update p95 ≤250 ms bez network latency; cold mount p95 raportowany oddzielnie; heap po GC po 100 switches ≤ max(8 MiB, 10% stabilized baseline); request count 0 dla controls/idle/irrelevant revision i 1 dla relevant revision/range miss. Uzasadnienie: wykrywa interakcyjne i leak regressions przed dostępnością real baseline; alternatywa: wyłącznie relative before/after; ryzyko: wariancja CI; koszt: repeat runs i fixture capture; acceptance: browser/device/build zapisane z wynikiem; rollback: target pozostaje provisional, hard invariants obowiązują.

[H] Wszystkie p50/p95, payload bytes, cache hit/miss, heap i Quick Chart + WebGL są NOT MEASURED. Sygnał: obecne skrypty nie emitują kompletnej macierzy. Eksperyment: rozszerzony Playwright/CDP audit na produkcyjnym buildzie, zapisujący Chromium version i fixture checksums dla small/medium/largest data. Metryki: pełny zestaw §10 w JSON artifact z exit code i commit. Wyniki: green plateau zamyka hipotezę; missing/failing metric blokuje cutover i wskazuje właściciela remediation.

Obowiązkowa macierz scenariuszy: Quick Chart przy 3D; open/close/pin/unpin; series/unit/zoom/pan/point/range; active simulation relevant/irrelevant revision; Analysis→3D; ≥100 przełączeń; three dataset sizes; settled idle; session switch z pending abort. Każdy rekord zawiera p50/p95, requests/bytes/cache, model/setOption/redraw/3D dirty frames, Canvas/ECharts/worker/listener/observer counts, heap/WebGL growth, `gl.isContextLost()`, drawing buffer i cancellation result.

## 11. Eksport i provenance

[C] Export jest explicit command, nie automatycznym side effect. Data export używa canonical values i stabilnych row ids; image export odzwierciedla widoczne axes/units/legend/range, ale sidecar zawiera canonical units, descriptor, source resource/run/stage/revision/query, decimation, scientific trust, backend/device/precision i timestamp. Stale/degraded export wymaga widocznego ostrzeżenia i flagi provenance.

[P] Pierwszy format: CSV/TSV dla bounded rows + PNG dla renderu + JSON provenance sidecar. Uzasadnienie: rozdziela numeric data od presentation; alternatywy: SVG/PDF lub server export; ryzyko: locale/precision i niespójny obraz; koszt: schema, command, file inspection tests. SVG/PDF dopiero po testach font/token fidelity. Acceptance: round-trip numeric sample i deterministic metadata test; rollback: wyłączyć wadliwy format bez utraty canonical data export.

## 12. Końcowa macierz akceptacji implementacji

- unit/dimension compatibility i zakaz default mixed quantities;
- decimation zachowuje endpoints i wymagane extrema;
- cache key zawiera session/resource/revision/canonical query;
- relevant/irrelevant invalidation i abort/session switch;
- brak direct production fetch/raw `/v2` URL poza facade/generated transport;
- dokładnie jeden owner renderer instance i pełny observer/listener/worker cleanup;
- Quick Chart nie zmienia camera/topology/field fetch/buffer upload/3D dirty frames;
- jedna ciężka surface w `viewport-main`, brak hidden Canvas/forceMount;
- brak WebGL context loss i non-zero drawing buffer po powrocie;
- ≥100-switch stress, bounded heap/resources i zero settled-idle work;
- screenshot before/after, osie/jednostki/legendy/tooltip/provenance/status;
- keyboard flow: focus chart, series navigation, cursor, range reset, explicit command; a11y name/description i non-color state cues;
- future gates: `pnpm --dir apps/control-room typecheck`, `lint`, `test`, `smoke:analysis-plots`, `audit:chart-performance`, `audit:idle-performance`, `audit:viewport-3d-memory-churn`.

[C] Powyższe future gates nie są dowodem tego zadania dokumentacyjnego i muszą być uruchomione po implementacji z zapisanym outputem.
