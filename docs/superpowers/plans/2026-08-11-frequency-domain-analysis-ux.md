# Frequency-Domain Analysis UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uporządkować i ujednolicić UX FMR modal spectrum, frequency-driven response, eigenmodes, dispersion i mode visualization bez mieszania znaczeń fizycznych ani lifecycle viewportu.

**Architecture:** Resource hooks i `frequencyDomainChartModels` pozostają źródłem danych. Nowy neutralny `AnalysisSurfaceDescriptor` opisuje osie, jednostki, selection kind, Inspector route i 3D handoff; dedykowane surface/Inspector owners renderują właściwą semantykę przez wspólne chart/table/legend/status primitives.

**Tech Stack:** TypeScript, React 19, ECharts Canvas, Vitest, resource-first v2 hooks, shared `analysis-charts`, Three.js/R3F handoff commands.

## Global Constraints

- HTTP resources są authoritative; realtime invalidation nie przenosi historii wykresu.
- Analiza wymaga explicit dataset/artifact/manifest identity i nie przejmuje live-tail state.
- Każda seria ma fizyczną quantity/unit; dimensionless quantities zachowują scale 1.
- Nie mieszaj niekompatybilnych jednostek na jednej osi bez selector/split/dual-axis label.
- `selectedSeriesIds` jest jedynym visibility ownerem dla każdej surface.
- Background refresh zachowuje poprzedni wykres; tylko initial loading może zastąpić pusty canvas skeletonem.
- ECharts ma jednego ownera per mounted chart, `ResizeObserver`, dispose przy unmount i brak polling/idle redraw.
- 3D handoff jest explicit, cancellable i nie mutuje camera/topology/field state bez command.
- Wszystkie klasy CSS mają `fm-` prefix i korzystają z `--fm-*`; Next.js pozostaje na wersji 16.
- Nie kopiować do Inspectorów drugiego payloadu ani prywatnych komponentów `analysis-plots`.
- Zachować niezwiązane `external_solvers/3` i path-specific commits.

---

## Mapa plików

| Plik | Odpowiedzialność |
|---|---|
| `apps/control-room/src/shared/domain/analysis/analysisSurfaceDescriptor.ts` | neutralny descriptor family/surface |
| `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` | canonical chart/table models i selection refs |
| `apps/control-room/src/modules/analysis-plots/analysisWorkbenchModel.ts` | surface summary, labels, cursor semantics |
| `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx` | surface tabs, dataset identity, surface owner |
| `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.tsx` | frequency chart renderer boundary |
| `apps/control-room/src/modules/analysis-plots/frequencyDomainSeriesAdapter.ts` | resource → bounded chart series |
| `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx` | existing result owners to split by family |
| `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrModalSpectrumInspectorPanel.tsx` | modal spectrum owner |
| `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrResponseSweepInspectorPanel.tsx` | driven response owner |
| `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenDispersionInspectorPanel.tsx` | branch/dispersion owner |
| `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainDiagnosticsInspectors.tsx` | diagnostic/provenance owners |
| `apps/control-room/src/design/styles/analysis-plots.css` | analysis surface layout/responsive states |
| `apps/control-room/src/design/styles/inspector-frequency-domain.css` | frequency Inspector layout |

### Task 1: Dodaj descriptor powierzchni i failing semantic tests

**Files:**
- Create: `apps/control-room/src/shared/domain/analysis/analysisSurfaceDescriptor.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisWorkbenchModel.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Create: `apps/control-room/src/shared/domain/analysis/analysisSurfaceDescriptor.test.ts`
- Test: `apps/control-room/src/modules/analysis-plots/analysisWorkbenchModel.test.ts`

**Interfaces:**
- Consumes: existing `AnalysisSurface`, `ChartSeries`, frequency table IDs and selection refs.
- Produces: pure `AnalysisSurfaceDescriptor` with axis/unit/route/handoff metadata.

- [ ] **Step 1: Napisz failing descriptor tests**

```ts
expect(descriptorForFrequencyTable("frequency-domain:eigen-spectrum")).toMatchObject({
  selectionKind: "analysis.chart",
  xAxis: { label: "mode index", unit: "1" },
  yAxes: [{ label: "frequency", unit: "Hz" }],
  handoff: "mode-overlay",
});
expect(descriptorForFrequencyTable("frequency-domain:eigen-dispersion")).toMatchObject({
  yAxis: { label: "frequency", unit: "Hz" },
  handoff: "branch-overlay",
});
expect(descriptorForFrequencyTable("frequency-domain:response-sweep")).toMatchObject({
  xAxis: { label: "frequency", unit: "Hz" },
  handoff: "response-overlay",
});
```

- [ ] **Step 2: Uruchom RED**

```bash
pnpm --dir apps/control-room test -- --run src/shared/domain/analysis/analysisSurfaceDescriptor.test.ts src/modules/analysis-plots/analysisWorkbenchModel.test.ts
```

- [ ] **Step 3: Zaimplementuj pure descriptor**

```ts
export interface AxisDescriptor {
  label: string;
  unit: string;
}

export interface AnalysisSurfaceDescriptor {
  surface: AnalysisSurface;
  title: string;
  xAxis: AxisDescriptor;
  yAxes: readonly AxisDescriptor[];
  selectionKind: string;
  inspectorRouteId: string;
  handoff: "mode-overlay" | "response-overlay" | "branch-overlay" | "none";
}

export function descriptorForFrequencyTable(tableId: string): AnalysisSurfaceDescriptor {
  if (tableId === "frequency-domain:eigen-dispersion") return eigenDispersionDescriptor;
  if (tableId === "frequency-domain:response-sweep") return responseSweepDescriptor;
  return eigenSpectrumDescriptor;
}
```

Zdefiniuj trzy kompletne stałe descriptorów (`eigenSpectrumDescriptor`, `eigenDispersionDescriptor`, `responseSweepDescriptor`) w tym samym pure module. `descriptorForSurface("spectrum")` nadal opisuje istniejący spin-wave gamma surface; FMR modal spectrum wybieraj wyłącznie przez `descriptorForFrequencyTable("frequency-domain:eigen-spectrum")`. Użyj istniejących quantity/unit helpers, nie dopisuj drugiego formattera częstotliwości.

- [ ] **Step 4: Podłącz descriptor do view summary**

`AnalysisFrequencySurface` i `analysisWorkbenchModel` korzystają z descriptoru do tytułu, osi, workflow handoff i status label; descriptor nie wykonuje requestów.

- [ ] **Step 5: Uruchom GREEN i commit**

```bash
pnpm --dir apps/control-room test -- --run src/shared/domain/analysis/analysisSurfaceDescriptor.test.ts src/modules/analysis-plots/analysisWorkbenchModel.test.ts src/modules/analysis-plots/components/AnalysisFrequencySurface.test.tsx
git add apps/control-room/src/shared/domain/analysis/analysisSurfaceDescriptor.ts apps/control-room/src/shared/domain/analysis/analysisSurfaceDescriptor.test.ts apps/control-room/src/modules/analysis-plots
git commit -m "feat: add frequency analysis surface descriptors"
```

### Task 2: Ujednolić chart/table/status boundary

**Files:**
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx`
- Modify: `apps/control-room/src/shared/analysis-charts/ChartSection.tsx`
- Modify: `apps/control-room/src/shared/analysis-charts/ChartLegend.tsx`
- Modify: `apps/control-room/src/shared/analysis-charts/chartScalePolicy.ts`
- Test: `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.test.tsx`
- Test: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.test.tsx`
- Test: `apps/control-room/src/shared/analysis-charts/chartScalePolicy.test.ts`

**Interfaces:**
- Consumes: `AnalysisSurfaceDescriptor`, bounded `ChartSeries`, resource status/revision.
- Produces: readable title/axis/unit/status/legend/cursor contract shared by each frequency surface.

- [ ] **Step 1: Dodaj failing status/trust tests**

Wymagaj rozdzielenia `initial-loading`, `refreshing`, `stale`, `ready`, `unsupported`, `error` od scientific trust. Przy `refreshing` poprzednie series i canvas pozostają w DOM.

- [ ] **Step 2: Dodaj descriptor-driven chart props**

```tsx
<ChartSection
  title={descriptor.title}
  subtitle={descriptorSubtitle(descriptor, workbench)}
  status={resolveChartStatus(resourceStatus, provenance)}
  legend={legend}
>
  <EChartsSurface
    descriptor={descriptor}
    series={visibleSeries}
    dataStatus={resourceStatus}
    onPointSelect={onPointSelect}
  />
</ChartSection>
```

- [ ] **Step 3: Napraw display transform**

Dimensionless `unit === "1"` lub pusty unit renderuj bez SI prefix; Hz, s, A/m i T korzystają z istniejącego `createChartDisplayTransform`. Axis, tooltip, legend, cursor i table używają tego samego transform.

- [ ] **Step 4: Dodaj selected-series empty state**

Pusta lista `selectedSeriesIds` renderuje `Select at least one signal`, nie tworzy ECharts series i nie wykonuje requestu.

- [ ] **Step 5: Uruchom GREEN i commit**

```bash
pnpm --dir apps/control-room test -- --run src/modules/analysis-plots/components/AnalysisFrequencySurface.test.tsx src/modules/analysis-plots/components/EChartsSurface.test.tsx src/shared/analysis-charts/chartScalePolicy.test.ts
git add apps/control-room/src/modules/analysis-plots/components apps/control-room/src/shared/analysis-charts
git commit -m "refactor: unify frequency chart status and units"
```

### Task 3: Rozdziel i popraw FMR modal spectrum

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrModalSpectrumInspectorPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrModalSpectrumModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Modify: `apps/control-room/src/design/styles/inspector-frequency-domain.css`
- Test: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrModalSpectrumInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/analysis-plots/frequencyDomainSeriesAdapter.test.ts`

**Interfaces:**
- Consumes: `buildEigenSpectrumChartModel`, manifest, eigen mode metadata/field resources, `AnalysisSurfaceDescriptor`.
- Produces: FMR modal spectrum owner with mode/branch/provenance/3D handoff semantics.

- [ ] **Step 1: Dodaj failing owner/model tests**

Model wymaga częstotliwości Hz, mode index, linewidth tylko jeśli opublikowany, field availability, calculation mode `fmr_modal` i provenance. Panel nie może pokazywać response controls jako modal controls.

- [ ] **Step 2: Wyodrębnij pure model**

```ts
export interface FmrModalSpectrumViewModel {
  modes: readonly FmrModalModeRow[];
  selectedModeKey: string | null;
  canPlotSelectedMode: boolean;
  trust: "qualified" | "partial" | "unknown";
  provenance: readonly InspectorMetadataItem[];
}
```

Model nie ma hooks, ECharts instances ani command side effects.

- [ ] **Step 3: Wytnij panel z monolitu**

Przenieś `FmrModalSpectrumInspectorPanel` i jego local helpers do nowego pliku. `FrequencyDomainResultInspectors.tsx` zachowuje compatibility export do czasu migracji wszystkich imports.

- [ ] **Step 4: Dodaj mode actions**

`real`, `imag`, `abs`, `phase_rotated_real`, `phase` i `animate` są dostępne wyłącznie dla selected mode; brak field resource daje typed unsupported state, nie aktywny przycisk.

- [ ] **Step 5: Uruchom focused testy i commit**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/frequency-domain/FmrModalSpectrumInspectorPanel.test.tsx src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx src/modules/analysis-plots/frequencyDomainSeriesAdapter.test.ts
git add apps/control-room/src/modules/inspector/panels/frequency-domain apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx apps/control-room/src/design/styles/inspector-frequency-domain.css
git commit -m "feat: refine FMR modal spectrum workflow"
```

### Task 4: Rozdziel frequency-driven response i peak Inspector

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrResponseSweepInspectorPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrResponseSweepModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrPeakInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Modify: `apps/control-room/src/design/styles/inspector-frequency-domain.css`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrResponseSweepInspectorPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrPeakInspector.test.tsx`
- Test: `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.test.tsx`

**Interfaces:**
- Consumes: response sweep/progress/cancel/field metadata resources and existing peak models.
- Produces: response owner with frequency axis, response quantity, magnitude/phase, progress/cancellation, peak selection and response-field handoff.

- [ ] **Step 1: Dodaj failing response state tests**

Testuj osobno `no manifest`, `loading`, `running`, `cancel requested`, `ready`, `stale`, `unsupported field` i `error`. Running response nie może zostać przedstawiony jako completed.

- [ ] **Step 2: Dodaj pure response view model**

```ts
export interface FmrResponseSweepViewModel {
  frequencyAxis: AxisDescriptor;
  responseAxes: readonly AxisDescriptor[];
  peaks: readonly FmrPeakRow[];
  progress: FrequencyResponseProgressView | null;
  canPlotSelectedFrequency: boolean;
  selectedFrequencyHz: number | null;
}
```

- [ ] **Step 3: Renderuj response-specific composition**

Wykres, peak table i selected-point summary używają wspólnego renderer boundary, ale własnych labels, `data-inspector-owner="frequency-domain.fmr-response"` i route-specific actions.

- [ ] **Step 4: Zweryfikuj response overlay**

Handoff publikuje `frequency-response` selection ref z field resource key, frequency index i revision. Brak zgodnego resource blokuje command z opisem.

- [ ] **Step 5: Uruchom GREEN i commit**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/frequency-domain/FmrResponseSweepInspectorPanel.test.tsx src/modules/inspector/panels/frequency-domain/FmrPeakInspector.test.tsx src/modules/analysis-plots/components/AnalysisFrequencySurface.test.tsx
git add apps/control-room/src/modules/inspector/panels/frequency-domain apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx apps/control-room/src/design/styles/inspector-frequency-domain.css
git commit -m "feat: refine FMR driven response workflow"
```

### Task 5: Rozdziel dispersion, eigen branch i eigen mode visualization

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenDispersionInspectorPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenBranchInspectorPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenModeInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`
- Modify: `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisWorkbenchModel.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenDispersionInspectorPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenBranchInspectorPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenModeInspectorPanel.test.tsx`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`

**Interfaces:**
- Consumes: eigen branches, k-path, dispersion, spectrum, mode field metadata and existing semantic selection refs.
- Produces: branch/point/mode owners with correct `k`, `path_s`, `frequency`, linewidth, provenance and 3D mode handoff.

- [ ] **Step 1: Dodaj failing axis/selection tests**

Wymagaj, aby dispersion nie traktowała `path_s` jako Hz, branch point zachowywał label i numeric coordinate, a eigen mode zachowywał mode index, branch ID i field identity.

- [ ] **Step 2: Dodaj pure row models**

```ts
export interface EigenDispersionPointViewModel {
  branchId: string;
  pointId: string;
  kLabel: string | null;
  pathCoordinate: number;
  pathUnit: string;
  frequencyHz: number;
  linewidthHz: number | null;
  fieldAvailable: boolean;
}
```

- [ ] **Step 3: Dodaj dedicated Inspector sections**

Branch owner pokazuje k-path and branch provenance; point owner pokazuje numeric point/linewidth/warnings; mode owner pokazuje field view/phase/animation/3D handoff. Nie renderuj wszystkiego w jednym `EigenModeInspectorPanel` dla wszystkich kinds.

- [ ] **Step 4: Przepnij Explorer/Analysis selection**

`frequencyDomainExplorerNodes.ts` publikuje node IDs i resource refs bez zmiany stable IDs. `analysisWorkbenchModel.ts` zwraca descriptor-derived handoff strings i cursor summary bez `chartTitle.toLowerCase()` heuristics dla znanych table IDs.

- [ ] **Step 5: Uruchom GREEN i commit**

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/panels/frequency-domain/EigenDispersionInspectorPanel.test.tsx src/modules/inspector/panels/frequency-domain/EigenBranchInspectorPanel.test.tsx src/modules/inspector/panels/frequency-domain/EigenModeInspectorPanel.test.tsx src/modules/explorer/builders/buildModelTree.test.ts src/modules/analysis-plots/analysisWorkbenchModel.test.ts
git add apps/control-room/src/modules/inspector/panels/frequency-domain apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts apps/control-room/src/modules/analysis-plots/analysisWorkbenchModel.ts apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx
git commit -m "feat: refine eigenmode and dispersion workflows"
```

### Task 6: Responsywność, lifecycle i browser qualification analiz

**Files:**
- Modify: `apps/control-room/src/design/styles/analysis-plots.css`
- Modify: `apps/control-room/src/design/styles/inspector-frequency-domain.css`
- Modify: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx`
- Modify: `apps/control-room/scripts/smoke-analysis-plots.mjs`
- Modify: `apps/control-room/scripts/smoke-viewport-3d-explorer-inspector-targets.mjs`
- Test: `apps/control-room/src/modules/analysis-plots/analysisPlotsSmokeScript.test.ts`
- Test: `apps/control-room/src/modules/analysis-plots/analysisPlotsPerformanceAuditScript.test.ts`
- Test: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.test.tsx`

**Interfaces:**
- Consumes: descriptor-driven surfaces and dedicated Inspector owners.
- Produces: browser evidence for charts, tables, responsive controls, stale refresh, WebGL handoff and cleanup.

- [ ] **Step 1: Dodaj responsive chart fixtures**

Sprawdź szerokości 360, 640, 900 i 1280 px; tytuł, dataset selector, legend, axis labels, units, table/point summary i primary action nie mogą zostać obcięte. Przy 360 px controls przechodzą do stacked layout.

- [ ] **Step 2: Dodaj reduced-motion i keyboard tests**

Series toggles, point selection, mode actions, branch rows i response controls muszą mieć focus ring, accessible name, Enter/Space behavior i nie polegać na kolorze.

- [ ] **Step 3: Dodaj retained-data refresh test**

Symuluj nową revision przy istniejącym `ChartSeries`. Oczekuj `data-status="refreshing"`, niezmienionego canvas identity i braku blokującego `Loading table samples`.

- [ ] **Step 4: Dodaj ECharts cleanup test**

Po unmount sprawdź dispose instance, ResizeObserver, event listeners, pending animation frame i export object URLs. Quick Chart i Analysis nie mogą tworzyć requestów 3D.

- [ ] **Step 5: Uruchom browser/runtime gates**

```bash
pnpm --dir apps/control-room smoke:analysis-plots
pnpm --dir apps/control-room smoke:viewport-3d-explorer-inspector-targets
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Po przejściu z FMR/eigen/dispersion do viewportu smoke wymaga widocznego canvasu, dodatniego drawing buffer i `gl.isContextLost() === false`.

- [ ] **Step 6: Zacommituj qualification**

```bash
git add apps/control-room/src/design/styles/analysis-plots.css apps/control-room/src/design/styles/inspector-frequency-domain.css apps/control-room/src/modules/analysis-plots apps/control-room/src/modules/inspector/panels/frequency-domain apps/control-room/scripts/smoke-analysis-plots.mjs apps/control-room/scripts/smoke-viewport-3d-explorer-inspector-targets.mjs
git commit -m "test: qualify frequency analysis UX and lifecycle"
```

## Końcowa bramka planu

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
```

Nie raportuj końca, jeśli wykresy są tylko wizualnie podobne: każda rodzina musi mieć poprawne osie/jednostki, własny Inspector owner, explicit resource identity/provenance i browser proof handoffu do 3D.
