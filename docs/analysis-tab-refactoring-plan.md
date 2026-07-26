# Analysis — produkcyjny plan hardeningu i refaktoryzacji UX

> **Status planu:** gotowy do realizacji etapami po review.
> **Status implementacji opisanej w tym dokumencie:** nie rozpoczęta; obecny resource-first Analysis Workbench pozostaje baseline'em.
> **Baseline źródłowy:** `85dc1765` (`master`, 2026-07-26).
> **Zakres:** `apps/control-room`; moduł `analysis-plots`, współdzielone wykresy, Inspector Quick Chart i integracja z dolnym panelem.
> **Poza zakresem:** nowa fizyka, zmiany Python/`ProblemIR`, przebudowa renderera 3D, nowy frontend FDM/FEM, modyfikacje `apps/legacy_web`.

## 1. Werdykt po audycie pierwotnego planu

Pierwotny dokument trafnie wykrywał słaby chart chrome, mało czytelne statusy, ograniczoną legendę, niewygodny slider zakresu i niespójność z Inspector primitives. Nie był jednak gotowy do bezpiecznego wdrożenia produkcyjnego.

Najważniejsze korekty:

1. Wykorzystanie większej liczby funkcji ECharts nie jest miarą jakości. `magicType`, `dataView`, broken axis, gradientowe area fills i natywny toolbox nie mogą być włączane hurtowo, bo część z nich zmienia interpretację danych, dubluje komendy Fullmag albo pogarsza dostępność.
2. `refreshInterval` i odświeżanie co 500 ms są niedozwolone. HTTP v2 jest źródłem prawdy, a realtime jedynie unieważnia zasoby. Stan spoczynkowy musi mieć zero pollingu, refetchu i redraw.
3. ECharts `sampling: "lttb"` nie może działać na danych już zredukowanych przez serwerowe `minmax_lttb`. Podwójna decymacja może usunąć ekstrema i zniszczyć mapowanie punktu do kanonicznego wiersza.
4. Raw hex i fonty wpisane w opcje renderera naruszają token-first design system. Renderer ma konsumować wartości rozstrzygnięte z `--fm-*`, z pełnym wsparciem Mocha/Latte i zmiany motywu.
5. Quick Chart nie może rejestrować `panel-bottom` w manifeście `analysis-plots`. `transport-footer` jest jedynym właścicielem dolnego slotu i montuje Quick Chart jako zawartość własnej zakładki. Ta zasada zapobiega regresji, w której znika cała stopka.
6. „Pause live” nie może oznaczać ignorowania wybranych eventów z WebSocket przy równoczesnym pozostawieniu innych ścieżek aktualizacji. Ma zamrozić przyjętą rewizję widoku, pokazać stan `paused/stale`, a po wznowieniu wykonać jeden fetch najnowszego zasobu.
7. W planie brakowało kompletnego podziału ownership, persistence, abort/session switch, bezpieczeństwa tooltipów i eksportu, dostępności klawiaturowej, testów prawdziwego lifecycle renderera, budżetów pamięci oraz rollbacku per etap.
8. Twierdzenia „ECharts 6 jest najnowszy” i „wykorzystujemy około 15%” nie są lokalnym dowodem technicznym i zostały usunięte. Repo deklaruje `echarts: ^6.0.0`; decyzja zależy od zmierzonego zachowania Fullmag, nie od procentu API biblioteki.

## 2. Źródła prawdy i oznaczenia dowodów

Obowiązujące dokumenty:

- `AGENTS.md`;
- `docs/specs/frontend-v2/01-module-kernel-architecture.md`;
- `docs/specs/frontend-v2/02-module-catalog.md`;
- `docs/specs/frontend-v2/03-api-integration-layer.md`;
- `docs/specs/frontend-v2/04-state-management.md`;
- `docs/specs/frontend-v2/05-viewport-architecture.md`;
- `docs/specs/frontend-v2/13-inspector-and-property-editing.md`;
- `docs/specs/frontend-v2/15-viewport-2d-module.md`;
- `docs/specs/frontend-v2/16-charts-analysis-module.md`;
- `docs/specs/frontend-v2/17-performance-memory-profiler.md`;
- `docs/specs/frontend-v2/18-testing-quality-gates.md`;
- `docs/adr/0016-center-viewport-tabbed-surfaces.md`;
- `docs/specs/resource-first-control-room-api-v2.md`.

Oznaczenia używane w planie:

- **[V] verified** — potwierdzone w aktualnym kodzie baseline'u;
- **[C] contract** — wymagane przez kanoniczne specyfikacje;
- **[P] proposal** — decyzja do wdrożenia i zweryfikowania;
- **[H] hypothesis** — hipoteza wymagająca pomiaru; nie wolno raportować jej jako osiągniętej poprawy.

## 3. Zweryfikowany baseline i rzeczywiste luki

| Obszar | Stan baseline'u | Wniosek |
|---|---|---|
| Renderer | [V] `src/shared/analysis-charts/EChartsCanvasSurface.tsx` tworzy jedną instancję Canvas per mount, używa `ResizeObserver`, jednorazowego RAF i właścicielskiego `dispose()` | Zachować lifecycle; rozbudować model/opcje, nie pisać drugiego ownera |
| Renderer boundary | [V] `chartRenderer.ts` ukrywa `setOption`, export, eventy i disposal za neutralnym ownerem | Rozszerzać neutralny model; typy ECharts nie mogą wyciec do modułów ani persistence |
| Dane tabeli | [V] `ChartTableWindow` przechowuje bounded `Float64Array`; limit wynosi 5000, domyślny `targetPoints` 1600, serwerowa decymacja `minmax_lttb` | Nie materializować pełnej historii ani nie dodawać drugiej decymacji w ECharts |
| Workspace state | [V] store zawiera aktywną surface, małe deskryptory kolumn, osie, zakres i selection; nie zawiera pełnego payloadu tabeli | Rozszerzać tylko o kompaktowe preferencje widoku; payload pozostaje w hook/cache/controller |
| Preferences persistence | [V] Analysis nie ma obecnie własnego versioned storage adaptera; testy mówią o persisted selection, ale store jest tylko in-memory | Nowy format zaczyna od schema v1 i musi mieć SSR-safe hydration, walidację, limity oraz reset |
| Realtime | [V] controller dopisuje `telemetry:scalar-sample` bezpośrednio do okna wykresu | P0: usunąć event jako źródło danych wykresu; wykres aktualizuje się po rewizji i HTTP resource fetch |
| Full Analysis | [V] `analysis-plots` deklaruje wyłącznie `viewport-main` | Zachować active-only mounting i unmount 3D przy wejściu w pełne Analysis |
| Quick Chart | [V] `transport-footer` deklaruje `panel-bottom`, pobiera manifest z registry i montuje go z `slotId="panel-bottom"` tylko w aktywnej zakładce Quick Chart | Zachować stopkę i jej wszystkie zakładki; testować ownership i integrację, nie tylko sam dock |
| Workbench composition | [V] `AnalysisPlotsView.tsx` jest już cienkim routerem surface; `useAnalysisPlotsController.ts` przekracza review trigger i skupia wiele rodzin resources | Dzielić controller według data family/lifecycle tylko tam, gdzie ogranicza subskrypcje i przebudowy |
| UI | [V] tabs są ręcznym `role=tab` na `Button`; status ma sześć równorzędnych pillów; legenda ma pięć kolorów i brak jawnego visibility/solo | Przejść na shared primitives i czytelną hierarchię |
| Styling | [V] dostępne są Mocha/Latte tokeny, font tokens i pięć chart colors | Dodać pełną, testowaną paletę semantyczną w centralnym theme; komponenty nie zawierają raw hex |
| Testy | [V] istnieją unit tests, `smoke:analysis-plots`, `audit:chart-performance`, idle i viewport-memory audits | Rozszerzyć o real renderer lifecycle, pełny footer, live pause/resume, a11y i mierzalne artefakty perf |

## 4. Nienaruszalne kontrakty produkcyjne

### 4.1. Przepływ danych

```text
runtime/artifact
  -> OpenAPI v2 generated transport
  -> ControlRoomApi facade
  -> revision-aware resource hook/cache
  -> bounded binary decode
  -> ChartDataPlan
  -> ChartRenderModel
  -> ECharts adapter
```

- [C] Komponenty nie używają `fetch()`, nie składają `/v2/...` i nie czytają generated transport bezpośrednio.
- [C] HTTP resource jest źródłem prawdy. WebSocket/realtime może unieważnić resource key, ale nie dostarcza kanonicznej historii do wykresu.
- [C] Status sesji pozostaje cienki; duże historie są osobnym zasobem data/analysis.
- [C] Zakres, kolumny, decymacja i `targetPoints` muszą należeć do kanonicznego query/cache key.
- [C] Każdy request obsługuje `AbortSignal`; odpowiedź starej sesji, rewizji lub query nie może zostać przyjęta.
- [C] `unsupported`, `empty`, `degraded`, `stale`, `error` i `aborted` są rozróżnione. Brak danych nie jest zerem.

### 4.2. Sloty i lifecycle 3D

```text
viewport-main tab host
  ├─ viewport-3d      (mounted tylko gdy aktywny)
  └─ analysis-plots   (mounted tylko gdy aktywny)

panel-bottom
  └─ transport-footer (jedyny manifest owner)
       ├─ Quick Chart -> MountedModule(analysis-plots, panel-bottom)
       ├─ Logs
       ├─ Telemetry
       ├─ Diagnostics
       ├─ Engine
       └─ Mesh Jobs
```

- [C] Pełne Analysis odmontowuje 3D; nie stosować CSS hiding, `forceMount` ani ukrytego Canvas.
- [C] Quick Chart współistnieje z 3D i nie może zmienić kamery, topologii, pola, jakości, drawing buffer ani dirty-frame count.
- [C] Zamknięcie/przełączenie Quick Chart zwalnia jego ECharts instance, observer, listeners, RAF i eksportowe object URLs.
- [C] `analysis-plots/manifest.ts` pozostaje z `slots: ["viewport-main"]`; próba dodania `panel-bottom` ma failować w teście.
- [C] Wyłączenie `analysis-plots` usuwa zakładkę Quick Chart, ale nie może usunąć `transport-footer` ani pozostałych zakładek.

### 4.3. Ownership stanu

| Stan | Owner | Persistence |
|---|---|---|
| scalar/energy/frequency payload i rewizja | resource hook/cache | nie w local storage/store |
| decoded `Float64Array` | resource cache/controller lease | do invalidation/release |
| osie, jednostki display, visible/solo series, range mode, point budget | chart view preferences | wersjonowany kompaktowy JSON |
| aktywna center surface i bottom tab | kernel layout | istniejący layout owner |
| cursor hover | ECharts/local ref | nigdy |
| wybrany punkt/seria | kernel selection, tylko mała tożsamość semantyczna | session-scoped |
| renderer/observer/listeners | `ChartRendererOwner` | nigdy |
| canonical artifacts | runtime/persistence resources | polityka runtime, nie browser preference |

Store ani persisted JSON nie mogą zawierać `Float64Array`, `number[][]`, punktów serii, pełnych odpowiedzi HTTP, ECharts options ani danych 3D.

## 5. Decyzja rendererowa

### 5.1. ECharts pozostaje defaultem

[P] Zachować ECharts Canvas v6 za `ChartRendererOwner`. Obecny renderer spełnia zakres interakcji, eksport PNG, zoom, eventy i wspólny lifecycle. Refaktoryzacja biblioteki bez pomiaru dodałaby drugi zestaw błędów lifecycle i a11y.

Spike uPlot lub własnego Canvas jest dozwolony wyłącznie, gdy ECharts nie przejdzie hard gate na największym realistycznym fixture. Migracja wymaga:

- pełnej zgodności osi, units, cursor, selection, zoom, legendy, eksportu, statusów i keyboard flow;
- co najmniej 30% poprawy p95 albo 25% mniejszego retained heap na dwóch największych fixture'ach;
- braku regresji Quick Chart + 3D, a11y i bundle budget;
- osobnego ADR, jeżeli w produkcie miałyby współistnieć dwa renderery.

### 5.2. Polityka funkcji ECharts

| Funkcja | Decyzja |
|---|---|
| Canvas | zachować |
| `animation` danych | domyślnie `false`; nowe próbki nie mogą przesuwać tysięcy punktów animacją |
| `dataZoom` inside + slider | zachować, slider zwiększyć do używalnego rozmiaru i zapewnić reset klawiaturą |
| `axisPointer`/crosshair | dodać z formatowaniem units i stabilnym row identity |
| tooltip | dodać formatter bez `any` i bez niesanitowanego HTML; preferować `richText`/plain text |
| legenda ECharts | wyłączyć, jeśli aktywna jest wspólna legenda Fullmag; nigdy nie renderować dwóch legend |
| ECharts `sampling` | nie używać na serwerowo zdecymowanych danych |
| `areaStyle`/gradient | nie włączać globalnie; opt-in tylko dla semantycznych bands/areas i po visual review |
| broken axis | wyłączone domyślnie; wymaga jawnego oznaczenia i testu uczciwości naukowej |
| `magicType` | odrzucone; użytkownik nie może przypadkowo zmieniać semantyki line/scatter/bar |
| `dataView` | zastąpić bounded Points Table Fullmag z units/provenance |
| natywny toolbox | nie jako primary UI; export/restore/fit są komendami/shared controls Fullmag |
| ECharts `aria` | włączyć, ale nie traktować jako pełnego a11y; zapewnić DOM summary i keyboard alternative |

### 5.3. Theme i tokeny

- [P] Wprowadzić `FullmagChartTokens`, rozwiązując wartości z `getComputedStyle()` dla `--fm-*` przy mount i zmianie motywu.
- [P] Recompute tokenów wywołuje jawna zmiana theme mode/revision z shella; nie dodawać timera ani okresowego odczytu stylów.
- [P] Opcje renderera konsumują rozstrzygnięte tokeny, nie raw hex i nie literalne nazwy fontów.
- [P] Zmiana Mocha/Latte aktualizuje option bez wycieku instancji i zachowuje zakres/selection.
- [C] Raw Catppuccin hex może wystąpić tylko w centralnym `src/design/styles/theme.css`.
- [C] Każda nowa klasa CSS ma prefix `fm-`; `app/globals.css` pozostaje import-only.

## 6. Docelowy UX naukowego workbencha

### 6.1. Hierarchia powierzchni

```text
┌ Analysis / nazwa datasetu ─ source · run · stage · revision · trust ┐
│ Overview | Energy | Dynamics | Convergence | Frequency              │
├ range mode · range value · point budget · Follow/Paused · Fit       ┤
│                                                                      │
│                         scientific chart                             │
│                                                                      │
├ series visibility/solo · latest value · unit · source               ┤
└ cursor/range summary · export CSV/TSV/PNG · provenance              ┘
```

- Header pokazuje dataset/resource, run/stage, data revision, stale/degraded/trust i backend provenance dostępne w zasobie.
- Surface tabs używają shared `Tabs/TabsList/TabsTrigger`; ikony są opcjonalne i `aria-hidden`, tekst pozostaje widoczny.
- Primary toolbar zawiera często używane sterowanie: zakres, Follow/Paused, Fit/Reset i export. `targetPoints` jest ustawieniem zaawansowanym, nie głównym „suwakiem jakości”.
- Status nie jest rzędem sześciu równorzędnych pillów. Priorytet: stan danych i rewizja, następnie liczba widocznych punktów, na końcu cursor/zoom w kontekście wykresu.
- Inspector pokazuje dokładne źródło, units, selection i ustawienia zaawansowane; nie jest jedynym miejscem podstawowej kontroli serii/zakresu.

### 6.2. Legenda i serie

- Single click/Space przełącza widoczność; jawna akcja `Solo` jest dostępna z klawiatury. Double click może być skrótem, ale nie jedyną drogą.
- Ukrycie serii nie wywołuje fetchu ani nie usuwa jej z legendy.
- Kolory pochodzą z co najmniej 12 tokenów chart palette, ale stan nie może być zakodowany wyłącznie kolorem; dodać line style/symbol/label tam, gdzie serie są trudne do rozróżnienia.
- Latest value używa tabular numerals, jednostki i pełnej wartości w accessible tooltip; nie może znikać bez alternatywy przez ellipsis.
- Domyślnie jeden chart zawiera jedną physical dimension/unit family. Expert dual-axis jest jawny, opisuje lewą/prawą oś i nie łączy heurystycznie energii, magnetyzacji, torque, residual ani field.

### 6.3. Zakres i live follow

Dozwolone tryby:

```typescript
type ChartRangeMode = "follow" | "tailRows" | "tailTime" | "fixed" | "fullDecimated";
type ChartLiveMode = "following" | "paused";
```

- `follow`: bounded tail aktualizowany po relewantnej rewizji.
- `tailRows`: ostatnie N kanonicznych wierszy, N walidowane i ograniczone.
- `tailTime`: przedział od `latestT - duration` do latest; wartość przechowywana w SI, prezentowana w wybranej jednostce.
- `fixed`: jawne `from/to`, bez automatycznego przesuwania.
- `fullDecimated`: cały dostępny zakres reprezentowany przez bounded server decimation; nigdy pełna surowa historia w przeglądarce.
- `paused`: zachowuje widoczną rewizję i pokazuje `Paused at revision ...`; może rejestrować mały invalidation pointer, ale nie pobiera nowych payloadów. Resume wykonuje dokładnie jeden fetch latest.

Nie dodawać `refreshInterval`. Aktualizacja pochodzi z relewantnej rewizji resource, a nie z zegara.

### 6.4. Tooltip, cursor i selection

- Tooltip pokazuje X z symbolem/jednostką, każdą widoczną serię z jednostką, canonical row id oraz znacznik stale/degraded, jeśli dotyczy.
- Precyzja wynika z quantity metadata/display policy; jedna globalna funkcja `toPrecision(5)` nie jest wystarczającym kontraktem.
- Nie używać niesanitowanych `seriesName`, label, resource name ani query w HTML tooltipu.
- Hover pozostaje lokalny. Click publikuje małe `ChartSelection`; field/snapshot trafia do 3D wyłącznie przez jawną, anulowalną komendę.

### 6.5. Quick Chart i footer

- Zakładki `Quick Chart`, `Logs`, `Telemetry`, `Diagnostics`, `Engine`, `Mesh Jobs` pozostają w jednym `transport-footer`.
- Quick Chart montuje renderer tylko, gdy jego footer tab jest aktywny.
- Pin zapisuje deskryptor/tożsamość resource i view preferences, nie payload.
- Empty selection pokazuje lekki stan pusty bez requestu i bez instancji ECharts.
- Opening, pinning, zoom, unit/legend actions i closing mają generować zero 3D field/topology requests i zero 3D dirty frames.

## 7. Persistence i trzy znaczenia „zapisu wykresu”

### 7.1. Canonical simulation data

Runtime/table/artifact jest kanonicznym wynikiem. UI nie tworzy prywatnej kopii danych naukowych w local storage. Retention, session/run/stage identity i provenance należą do runtime/persistence resources.

### 7.2. Preferencje widoku

[P] Dodać wersjonowany, kompaktowy model:

```typescript
type ChartRangePreference =
  | { mode: "follow" }
  | { mode: "tailRows"; rows: number }
  | { mode: "tailTime"; durationS: number }
  | { mode: "fixed"; fromSI: number; toSI: number }
  | { mode: "fullDecimated" };

interface AnalysisChartPreferencesV1 {
  schemaVersion: 1;
  activeSurface: AnalysisWorkbenchSurface;
  descriptorPreferences: Record<string, {
    displayUnits: Record<string, string>;
    hiddenSeriesIds: string[];
    liveMode: ChartLiveMode;
    range: ChartRangePreference;
    soloSeriesId: string | null;
    targetPoints: 160 | 400 | 800 | 1600 | 3200 | 5000;
    xAxisId: string;
    yAxisIds: string[];
  }>;
}
```

Wymagania:

- validate, clamp i repair podczas odczytu; nie ufać JSON z local storage;
- versioned key i jawna migracja albo bezpieczny reset;
- scope co najmniej workspace + descriptor; dane session-specific (selection/range row ids) są re-key/reset przy zmianie sesji;
- pierwszy client render musi być zgodny z SSR; użyć server snapshot/hydration gate, nie czytać local storage w renderze;
- limit liczby zapisanych deskryptorów i rozmiaru JSON; LRU może usuwać wyłącznie preferencje nieaktywne, nigdy zamontowane renderery ani cache resources;
- reset preferences nie usuwa canonical data ani eksportów.

### 7.3. Eksport

- CSV/TSV zawiera canonical numeric values, units, stabilne row ids i jawny stan decymacji.
- PNG odpowiada widocznym osiom, zakresowi, legendzie i motywowi.
- Każdy eksport ma versioned JSON provenance sidecar: session/run/stage, resource key/revision/query, canonical/display units, decimation, trust, backend/device/precision i timestamp.
- Stale/degraded export wymaga ostrzeżenia i flagi w sidecar.
- Nazwa pliku i tekstowe komórki są sanitizowane; formuły CSV nie mogą powstać z nieufnych labeli.
- Object URL jest revoke po pobraniu/anulowaniu/unmount; duży export jest bounded lub wykonywany przez worker.
- SVG/PDF są poza pierwszym cutem; dodać dopiero po testach font/token fidelity i bezpieczeństwa.

## 8. Dostępność, responsywność i motion

- Shared shadcn/ui-style primitives dla tabs, select, dropdown, tooltip, switch/segmented control i dialogów.
- Pełny keyboard flow: focus chart, wybór surface, series visibility/solo, reset range, export, przejście do bounded Points Table.
- Canvas ma accessible name/description, ale także DOM summary i alternatywną tabelę wartości; samo `aria.enabled` ECharts nie wystarcza.
- Focus ring, status i selection nie mogą zależeć wyłącznie od koloru.
- Test Mocha, Latte, forced colors/high contrast, 200% zoom i narrow desktop panel.
- Data animation pozostaje wyłączona. Krótkie CSS transitions chrome respektują `prefers-reduced-motion`; live pulse jest wyłączany w reduced motion i nie wywołuje redraw Canvas.
- Minimum hit target i text contrast muszą przejść automatyczny audit oraz manual keyboard review.

## 9. Budżety wydajności i pamięci

### 9.1. Hard invariants

- zero idle polling/refetch/RAF/redraw po settling;
- zero chart update na niepowiązaną rewizję lub zmianę stanu innego modułu;
- jeden fetch na relewantną rewizję/range miss; zero fetch dla legendy, display units, local zoom, cursor i point select;
- maksymalnie jeden ECharts instance na zamontowaną surface;
- instance/listener/observer/RAF/worker/object URL wraca do baseline'u po unmount;
- inactive center surface nie ma Canvas, hooków i renderer resources;
- Quick Chart nie powoduje 3D dirty frames, uploadów, context loss ani zmiany drawing buffer;
- po powrocie do 3D `gl.isContextLost() === false`, width/height drawing buffer są niezerowe;
- abort/session switch nie publikuje starego payloadu;
- duże typed arrays nie trafiają do React/Zustand/persistence.

### 9.2. Provisional targets do kalibracji

| Metryka | Target |
|---|---|
| lokalna kontrolka, warm p95 | <= 50 ms |
| range model + render, medium p95 | <= 100 ms bez network |
| relewantna aktualizacja, warm p95 | <= 250 ms bez network |
| request count: local controls/idle/irrelevant revision | 0 |
| request count: relevant revision/range miss | 1 per resource consumer/cache identity |
| heap po GC po 100 przełączeniach | <= max(8 MiB, 10% stabilized baseline) wzrostu |
| settled idle chart `setOption`/redraw | 0 |

Każdy wynik zapisuje build mode, commit, Chromium/version, sprzęt, fixture checksum, cold/warm, p50/p95, request count/bytes, cache hit/miss, model builds, `setOption`, redraw, listener/observer/worker count, heap i WebGL state. Brak metryki oznacza `NOT MEASURED`, nie zero.

Fixture matrix:

- raw source: 10k, 100k i 1M rows;
- renderer window: bounded zgodnie z query, 1/4/12 series;
- monotonic time, gaps/NaN, duplicate X, extrema i live tail;
- small/medium/largest realistic production artifact;
- Quick Chart + aktywne 3D, pełne Analysis, session switch podczas requestu;
- co najmniej 100 przełączeń 3D/Analysis i 100 open/close/pin/unpin Quick Chart.

## 10. Etapowy plan implementacji TDD

Każdy etap ma osobny diff, RED/GREEN, browser proof, gate pamięci i rollback. Nie usuwać compatibility komponentu przed parity testem wszystkich consumers.

### Etap 0 — Uzgodnienie dokumentacji i baseline proof

**Pliki:**

- `docs/specs/frontend-v2/02-module-catalog.md`;
- `docs/specs/frontend-v2/16-charts-analysis-module.md`;
- `docs/plans/active/2026-07-25-analysis-workbench-refactor.md`;
- `apps/control-room/src/modules/analysis-plots/analysisDock.test.tsx`;
- `apps/control-room/src/modules/footer/manifest.test.ts`.

**RED:** test/spec scan wykrywa instrukcję, że `analysis-plots` ma zadeklarować `panel-bottom`.

**GREEN:** wszystkie dokumenty mówią: footer jest jedynym ownerem slotu, Analysis jest montowane przez footer jako slot-aware content. Test potwierdza pełny zestaw zakładek stopki i brak `panel-bottom` w manifeście Analysis.

**Acceptance:** zero rozbieżności docs/code; brak zmian runtime.

**Rollback:** nie dotyczy kodu; błędnej architektury slotów nie przywracać.

### Etap 1 — Instrumentacja przed zmianą zachowania

**Pliki:**

- `apps/control-room/scripts/audit-chart-performance.mjs`;
- `apps/control-room/scripts/smoke-analysis-plots.mjs`;
- `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs`;
- `apps/control-room/src/modules/analysis-plots/components/chartDiagnostics.ts`;
- `apps/control-room/src/modules/analysis-plots/analysisPlotsPerformanceAuditScript.test.ts`;
- `apps/control-room/src/modules/analysis-plots/analysisPlotsSmokeScript.test.ts`;
- `apps/control-room/src/modules/analysis-plots/components/chartDiagnostics.test.ts`.

**RED:** proof JSON nie zawiera bytes/cache/heap/listener/observer/worker/WebGL/cancellation i nie rozróżnia Quick Chart od full Analysis.

**GREEN:** versioned `ChartPerformanceProof` mierzy komplet §9, z disabled-by-default diagnostics i zerowym narzutem poza profilem.

**Acceptance:** baseline artifacts dla trzech fixture'ów; brak twierdzenia o przyspieszeniu przed pomiarem after.

**Rollback:** wyłączyć opt-in instrumentation, zachowując dotychczasowe smoke/audits.

### Etap 2 — HTTP truth i spójne live pause/resume

**Pliki:**

- `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`;
- `apps/control-room/src/modules/analysis-plots/tableRowsAdapter.ts`;
- `apps/control-room/src/modules/analysis-plots/analysisPlotsModel.ts`;
- `apps/control-room/src/kernel/workspace/analysisPlotsWorkspace.ts`;
- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`;
- `apps/control-room/src/modules/analysis-plots/analysisPlotModel.test.ts`;
- `apps/control-room/src/kernel/workspace/analysisPlotsWorkspace.test.ts`.

**RED:** realtime scalar sample dopisuje punkt do chart window bez odczytu HTTP; paused view przyjmuje nowe dane; resume może fetchować wielokrotnie.

**GREEN:** chart window przyjmuje dane wyłącznie z revisioned table resource; `telemetry:scalar-sample` może pozostać diagnostyką stopki, ale nie source of truth Analysis. Pause zamraża widoczną rewizję, resume robi jeden latest fetch, abort/session switch jest fail-closed.

**Acceptance:** relevant invalidation = 1 fetch; irrelevant/paused = 0; resume = 1; żadna stara odpowiedź nie jest adoptowana.

**Rollback:** wyłączyć kontrolkę pause; nie przywracać scalar event jako kanonicznej historii.

### Etap 3 — Preferencje zakresu i bounded query

**Pliki:**

- `apps/control-room/src/shared/domain/analysis/chartDataPlan.ts`;
- `apps/control-room/src/modules/analysis-plots/chartTableModel.ts`;
- `apps/control-room/src/modules/analysis-plots/analysisPlotsModel.ts`;
- `apps/control-room/src/kernel/workspace/analysisPlotsWorkspace.ts`;
- nowy `apps/control-room/src/kernel/workspace/analysisChartPreferences.ts`;
- nowy `apps/control-room/src/kernel/workspace/useAnalysisChartPreferencesHydration.ts`;
- nowy `apps/control-room/src/kernel/workspace/analysisChartPreferences.test.ts`;
- nowy `apps/control-room/src/kernel/workspace/useAnalysisChartPreferencesHydration.test.tsx`;
- `apps/control-room/src/shared/domain/analysis/chartDataPlan.test.ts`;
- `apps/control-room/src/modules/analysis-plots/chartTableModel.test.ts`.

**RED:** invalid N/time/range/target points; unbounded `full`; malformed storage; pierwsza hydratacja różna od SSR.

**GREEN:** wszystkie range modes mapują się na bounded canonical query; target points 160..5000; full oznacza `fullDecimated`; cache key zawiera pełną query identity; persisted model nie zawiera payloadu.

**Acceptance:** range hit = 0 fetch, miss = 1; no double decimation; row identity zachowane.

**Rollback:** reset preferences do follow + 1600; canonical data bez zmian.

### Etap 4 — Token-aware renderer, formatting i bezpieczeństwo

**Pliki:**

- `apps/control-room/src/shared/analysis-charts/chartRenderer.ts`;
- `apps/control-room/src/shared/analysis-charts/EChartsCanvasSurface.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/fullmagChartTokens.ts`;
- nowy `apps/control-room/src/shared/analysis-charts/scientificChartFormatting.ts`;
- `apps/control-room/src/design/styles/theme.css`;
- `apps/control-room/src/shared/analysis-charts/chartRenderer.test.ts`;
- nowy `apps/control-room/src/shared/analysis-charts/EChartsCanvasSurface.test.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/fullmagChartTokens.test.ts`;
- nowy `apps/control-room/src/shared/analysis-charts/scientificChartFormatting.test.ts`.

**RED:** raw hex/font literal w rendererze, niesanitowany label, duplikowana legenda, theme switch traci range lub wycieka instance, ECharts sampling pojawia się w option.

**GREEN:** axes, crosshair, tooltip, grid, 12-token palette, emphasis i dataZoom są generowane z neutralnego modelu; no raw HTML/`any`; theme update jest owner-clean; renderer używa dokładnie jednej legendy i jednej decymacji.

**Acceptance:** real mount/update/resize/event/export/theme/dispose test; 0 callback po unmount; Mocha/Latte screenshot.

**Rollback:** neutralny owner pozostaje, option builder wraca do prostego tokenowego wariantu.

### Etap 5 — ChartSection, tabs i status hierarchy

**Pliki:**

- nowy `apps/control-room/src/shared/analysis-charts/ChartSection.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/ChartSection.test.tsx`;
- `apps/control-room/src/modules/analysis-plots/components/AnalysisSurfaceTabs.tsx`;
- `apps/control-room/src/modules/analysis-plots/components/AnalysisTableSurface.tsx`;
- `apps/control-room/src/modules/analysis-plots/components/AnalysisEnergySurface.tsx`;
- `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.tsx`;
- `apps/control-room/src/design/styles/analysis-plots.css`;
- `apps/control-room/src/modules/analysis-plots/analysisWorkbench.test.tsx`;
- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`.

**RED:** ręczny tabs widget, sześć równorzędnych pillów, brak provenance/status hierarchy, clipping w narrow layout.

**GREEN:** shared Tabs i ChartSection renderują header, scientific status, chart, actions i footer bez importu prywatnych modułów; stale/trust/revision są widoczne, responsive i keyboard accessible.

**Acceptance:** Mocha/Latte, 200% zoom, narrow desktop, reduced motion oraz before/after screenshots.

**Rollback:** ChartSection może opakować stary chart bez zmiany data path.

### Etap 6 — Legenda, axes i kontrolki zakresu

**Pliki:**

- zastąpić `apps/control-room/src/modules/analysis-plots/components/AnalysisSeriesLegend.tsx` nowym `apps/control-room/src/shared/analysis-charts/ChartLegend.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/ChartControlBar.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/ChartLegend.test.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/ChartControlBar.test.tsx`;
- `apps/control-room/src/kernel/workspace/analysisPlotsWorkspace.ts`;
- `apps/control-room/src/kernel/workspace/analysisChartPreferences.ts`;
- `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`;
- `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.tsx`;
- `apps/control-room/src/shared/domain/analysis/TableColumnList.test.tsx`;
- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`.

**RED:** hide/solo powoduje fetch; serie różnych dimensions trafiają na oś; jedyna akcja solo wymaga double click; latest value jest niedostępne po ellipsis.

**GREEN:** hide/solo/display unit/local zoom to czysto lokalne model updates; jawny expert dual-axis; keyboard parity; Inspector i workbench używają tego samego kompaktowego preference ownera.

**Acceptance:** 1/4/8/12 series, same/mixed dimensions, gaps/NaN, local action request count = 0.

**Rollback:** reset visibility/solo/axes; dane i resource query bez zmian.

### Etap 7 — Quick Chart i pełna integralność footera

**Pliki:**

- `apps/control-room/src/modules/footer/FooterModule.tsx`;
- `apps/control-room/src/modules/footer/manifest.ts`;
- `apps/control-room/src/modules/analysis-plots/AnalysisQuickChartDock.tsx`;
- `apps/control-room/src/shared/analysis-charts/QuickChartResourceView.tsx`;
- `apps/control-room/src/shared/analysis-charts/QuickChartView.tsx`;
- `apps/control-room/src/modules/analysis-plots/manifest.ts`;
- `apps/control-room/src/modules/analysis-plots/analysisDock.test.tsx`;
- `apps/control-room/src/modules/footer/manifest.test.ts`;
- `apps/control-room/src/shared/analysis-charts/quickChart.test.tsx`;
- `apps/control-room/scripts/smoke-analysis-plots.mjs`;
- `apps/control-room/scripts/audit-chart-performance.mjs`.

**RED:** rejestracja `panel-bottom` przez Analysis, zniknięcie dowolnej zakładki stopki, renderer aktywny na nieaktywnej zakładce, duplicate rows fetch, dirty 3D frame.

**GREEN:** footer pozostaje jedynym slot ownerem, Quick Chart jest lazy/active-tab-only, używa wspólnego cache/model/renderer i zwalnia wszystko po zamknięciu.

**Acceptance:** wszystkie footer tabs przełączalne; 100 open/close/pin/unpin; 3D canvas zdrowy i nieprzerysowany.

**Rollback:** ukryć tylko tab Quick Chart, pozostawiając pełny footer i full Analysis.

### Etap 8 — Specialized surfaces

**Pliki:**

- `apps/control-room/src/modules/analysis-plots/DynamicStructureFactorView.tsx`;
- `apps/control-room/src/modules/analysis-plots/SpinWaveGammaView.tsx`;
- `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.tsx`;
- `apps/control-room/src/shared/analysis-charts/frequencyRenderModels.ts`;
- `apps/control-room/src/shared/analysis-charts/frequencyRenderModels.test.ts`;
- `apps/control-room/src/modules/analysis-plots/dynamicStructureFactorModel.test.ts`;
- `apps/control-room/src/modules/analysis-plots/spinWaveGammaModel.test.ts`;
- `apps/control-room/src/design/styles/analysis-plots.css`.

**RED:** plain selects, brak status/trust/provenance, mieszane units, osobny lifecycle ECharts lub niebounded heatmap DOM.

**GREEN:** shared Select/ChartSection, legal unit grouping, bounded renderer/model, source spectrum wyraźnie odróżnione od magnetization response.

**Acceptance:** numeric equivalence fixtures, empty/unsupported/degraded/error, keyboard i lifecycle parity.

**Rollback:** compatibility composition na wspólnym rendererze; nie wracać do osobnego `echarts.init`.

### Etap 9 — Export i Points Table

**Pliki:**

- `apps/control-room/src/shared/analysis-charts/ChartExportControls.tsx`;
- `apps/control-room/src/shared/analysis-charts/chartExport.ts`;
- `apps/control-room/src/modules/analysis-plots/manifest.ts`;
- nowy `apps/control-room/src/shared/analysis-charts/PointsTableDialog.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/PointsTableDialog.test.tsx`;
- nowy `apps/control-room/src/shared/analysis-charts/chartExport.download.test.ts`;
- `apps/control-room/src/shared/analysis-charts/chartExport.test.ts`;
- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`.

**RED:** missing sidecar, stale/degraded bez ostrzeżenia, CSV injection, object URL leak, eksport danych spoza widocznego/żądanego query.

**GREEN:** CSV/TSV/PNG + versioned provenance, sanitizacja i cleanup; Points Table jest accessible replacement dla ECharts `dataView`.

**Acceptance:** odczytać rzeczywisty pobrany plik, porównać próbkę numeric round-trip, units/revision/query i PNG dimensions.

**Rollback:** wyłączyć wadliwy format; canonical data export pozostaje dostępny.

### Etap 10 — Rozbicie controllera według resource families

**Pliki:**

- `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`;
- nowy `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisTableData.ts`;
- nowy `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisEnergyData.ts`;
- nowy `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisFrequencyData.ts`;
- nowy `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisTableData.test.tsx`;
- nowy `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisEnergyData.test.tsx`;
- nowy `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisFrequencyData.test.tsx`;
- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`.

**RED:** nieaktywna surface nadal subskrybuje/fetchuje/build render model; irrelevant state przebudowuje wszystkie families.

**GREEN:** cienki orchestration controller, oddzielne hooks z jawnym `enabled`, abort i revision selector; bez nowego cross-module API i bez kopiowania server state.

**Acceptance:** tylko aktywne families mają consumers; zero behavior/numeric drift; file split redukuje realną odpowiedzialność i lifecycle risk.

**Rollback:** hooki można złożyć z powrotem bez zmiany publicznych props/contracts; nie utrzymywać dwóch równoległych paths.

### Etap 11 — Final qualification i retirement

**Pliki:**

- `apps/control-room/scripts/smoke-analysis-plots.mjs`;
- `apps/control-room/scripts/audit-chart-performance.mjs`;
- `apps/control-room/scripts/audit-idle-performance.mjs`;
- `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs`;
- `docs/specs/frontend-v2/02-module-catalog.md` i `16-charts-analysis-module.md` dopiero po uzyskaniu dowodów;
- `apps/control-room/src/modules/analysis-plots/components/AnalysisStatusPill.tsx`, stary legend component i ich CSS wyłącznie po potwierdzonej parity.

**RED:** pełna macierz uruchomiona przed oznaczeniem etapu jako complete; missing metric jest failure.

**GREEN:** dwa powtarzalne green runs na production buildzie i opisanych fixture'ach.

**Acceptance:** §12; screenshoty, JSON performance proof i downloaded export samples zapisane jako artefakty.

**Rollback:** wyłączyć nowe presentation/preferences adaptery, zachować resource-first data path, footer ownership i canonical exports.

**Retirement po parity:** usunąć `AnalysisStatusPill`, stary local legend, nieużywane option builders i migration readers. Nie pozostawiać dead CSS, eventów, imports ani dwóch ownerów renderer lifecycle.

## 11. Macierz testów

| Warstwa | Obowiązkowe przypadki |
|---|---|
| Model | unit/dimension compatibility, range validation, precision, NaN/gaps, extrema, stable row identity |
| Store/preferences | setters/selectors, malformed JSON, version migration/reset, size/LRU, session re-key, SSR snapshot |
| Resource | relevant/irrelevant invalidation, cache identity, abort, stale-while-revalidate, pause/resume |
| Renderer | real init/update/resize/events/export/theme/dispose, no callback after unmount, one legend, no double sampling |
| Component | tabs, legend hide/solo, toolbar, statuses, empty/error/degraded, Points Table |
| Footer integration | one `panel-bottom` owner, all tabs present, Quick Chart active-only, module disable fallback |
| 3D coexistence | zero field/topology requests, dirty frames/uploads/context loss during Quick Chart controls |
| A11y | keyboard-only flow, accessible names/descriptions, non-color cues, reduced motion, automated axe + manual review |
| Visual | before/after, Mocha/Latte, 1/4/8/12 series, narrow/200% zoom, long labels/units |
| Perf/memory | small/medium/largest, cold/warm, idle, 100 switches, 100 dock cycles, heap/resource plateau |
| Export | CSV/TSV numeric round-trip, PNG dimensions/theme, sidecar provenance, sanitization, URL cleanup |

## 12. Definition of Done

Refaktoryzacja jest produkcyjnie zakończona dopiero, gdy:

- resource-first HTTP truth jest zachowane, a Analysis nie buduje historii z realtime scalar payload;
- `analysis-plots` nie deklaruje `panel-bottom`, pełny footer pozostaje widoczny i funkcjonalny;
- pełne Analysis oraz 3D są active-only, Quick Chart nie narusza lifecycle ani pamięci 3D;
- renderer ma jednego ownera, zero idle work i pełny cleanup;
- dane są bounded, range-aware i decymowane dokładnie raz z zachowaniem ekstremów/row identity;
- units, physical dimensions, trust, provenance i wszystkie resource states są widoczne i poprawne;
- Mocha/Latte, keyboard, reduced motion, narrow layout i 200% zoom przechodzą;
- eksport zawiera poprawne dane i versioned provenance, bez wycieku object URLs;
- dwa kompletne performance/memory runs przechodzą hard invariants i skalibrowane targets;
- nie ma direct fetch, raw `/v2` w module, prywatnych cross-module imports, dużych payloadów w stores ani nowych feature flags bez ownera i daty usunięcia;
- stare komponenty/compatibility paths zostały usunięte dopiero po parity;
- specyfikacje zostały zaktualizowane na podstawie faktycznie uruchomionych dowodów, nie samego diffu.

## 13. Komendy kwalifikacyjne

Focused testy należy uruchamiać po każdym etapie. Finalny gate:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room test
pnpm --dir apps/control-room smoke:analysis-plots
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

Dla UI/lifecycle dodatkowo wymagany jest production/audit build uruchomiony w prawdziwym Chromium z działającym runtime, screenshotami i zapisanym `ChartPerformanceProof`. Sam TypeScript/unit suite nie jest dowodem poprawnego Canvas, stopki ani WebGL.

## 14. Jawne stop conditions

Zatrzymać etap i wrócić do projektu, jeśli:

- potrzeba nowego endpointu nie ma resource coverage matrix i drugiego niezależnego consumera;
- rozwiązanie wymaga polling, direct fetch, payloadu w store albo utrzymania ukrytego 3D;
- ECharts feature zmienia naukową semantykę bez jawnej specyfikacji;
- theme switch wymaga niekontrolowanego tworzenia dodatkowych instancji;
- Quick Chart wymaga przejęcia `panel-bottom` od footera;
- test przechodzi tylko po obniżeniu jakości 3D, limitu serii lub ukryciu błędu;
- największy fixture przekracza budżet, a profil nie wskazuje, czy problemem jest network, decode, model czy renderer;
- implementacja wymaga trwałego feature flag bez ownera, removal condition i daty.

[H] Komendy i targety z tego dokumentu są planem przyszłej implementacji. W tym zadaniu dokumentacyjnym nie są dowodem wdrożenia ani walidacji UI.
