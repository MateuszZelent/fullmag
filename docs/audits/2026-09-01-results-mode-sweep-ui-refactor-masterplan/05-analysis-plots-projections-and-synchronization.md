# 05 — Analysis: projekcje, wykresy i synchronizacja wyboru

## 1. Cel

Analysis jest centrum prezentacji ilościowej. Nie jest jednak właścicielem
primary dataset selection. Odczytuje aktywny `AnalysisResultCursor` i wybiera
jedną z projections opublikowanych przez dataset.

Docelowy przepływ:

```text
Results wybiera dataset/slice/item
    -> Analysis odczytuje cursor
    -> ładuje manifest i projection dla tego samego snapshotu
    -> wykres mapuje każdy punkt na stable sample/item
    -> kliknięcie punktu aktualizuje ten sam cursor/selection
    -> Results i Inspector odzwierciedlają zmianę
```

## 2. Stan wejściowy

Obecny Analysis ma wartościowe elementy:

- podział na `Dynamics`, `Resonance & FMR`, `Dispersion`, `Hysteresis`,
  `Comparison`;
- typed resource hooks dla części frequency-domain;
- ECharts lifecycle i shared chart primitives;
- mapping klikniętego punktu do frequency-domain selection;
- osobne widoki Gamma FFT i DSF;
- preferences jednostek, range i widocznych serii.

Luka polega na tym, że:

- `analysisWorkspace.selectedDatasetRef` jest niezależnym źródłem wyboru;
- `useAnalysisFrequencyData` routuje po konkretnych artefaktach;
- field sweep nie jest projection źródłem;
- multi-axis slice nie istnieje;
- FFT i DSF nie używają wspólnej result selection;
- Results i Analysis mogą wskazywać różne dane.

## 3. Docelowa nawigacja Analysis

## 3.1. Powierzchnie i podwidoki

```typescript
export type AnalysisSurface =
  | "dynamics"
  | "resonance-fmr"
  | "dispersion"
  | "hysteresis"
  | "comparison";

export type AnalysisSubview =
  | "dynamics.time-traces"
  | "dynamics.temporal-spectrum"
  | "dynamics.spectral-features"
  | "dynamics.s-k-f"
  | "dynamics.spatial-response"
  | "resonance.eigenmodes"
  | "resonance.driven-response"
  | "resonance.field-sweep-map"
  | "resonance.modal-driven"
  | "dispersion.modal"
  | "dispersion.branches"
  | "dispersion.driven-map"
  | "dispersion.cuts"
  | "hysteresis.loop"
  | "hysteresis.branches"
  | "hysteresis.metrics"
  | "comparison.datasets"
  | "comparison.difference"
  | "comparison.convergence";
```

### Mapowanie obecnych nazw

```text
dynamics.temporal-fft       -> dynamics.temporal-spectrum
resonance.frequency-response -> resonance.driven-response
comparison.sources          -> comparison.datasets
```

Compatibility reader jest bounded do jednej wersji preferences. Nowy writer
zapisuje wyłącznie nowe IDs.

## 3.2. Dostępność podwidoków

Lista subviews nie jest stałą globalną renderowaną bez kontekstu. Jest
przecięciem:

```text
kanoniczny katalog UI
∩ projections opublikowane przez dataset
∩ capability runtime/frontend
```

Przykład:

- modal field sweep: Eigenmodes, Field-Sweep Map, ewentualnie Modal–Driven;
- single fixed-k modal: Eigenmodes;
- k-path: Modal f_n(k), Branches, Cuts;
- driven sweep: Driven Response, Field-Sweep Map;
- temporal spectrum: Temporal Spectrum, Spectral Features;
- DSF: S(k,f), Cuts;
- brak response fields: Spatial Response widoczny jako unsupported tylko wtedy,
  gdy użytkownik potrzebuje wyjaśnienia capability; nie jako aktywna pusta karta.

## 4. Projection registry

## 4.1. Cel

Zamiast `switch` po nazwie artefaktu Analysis używa registry projections.
Registry znajduje się w shared domain, a nie w module Results ani Inspector.

```text
apps/control-room/src/shared/domain/analysis/results/projections/
  registry.ts
  types.ts
  spectrumProjection.ts
  dispersionProjection.ts
  responseProjection.ts
  heatmapProjection.ts
  branchProjection.ts
  temporalProjection.ts
  comparisonProjection.ts
```

## 4.2. Typ adaptera

```typescript
export interface AnalysisProjectionAdapter<
  Resource,
  Model extends AnalysisProjectionModel,
> {
  projectionKind: AnalysisResultProjectionKind;
  supportedProducts: readonly AnalysisResultProductKind[];
  validateDescriptor(
    descriptor: AnalysisResultProjectionDescriptor,
    manifest: AnalysisResultDatasetManifest,
  ): ProjectionValidationResult;
  buildQuery(input: AnalysisProjectionQueryInput): AnalysisResultProjectionQuery;
  buildModel(
    resource: Resource,
    context: AnalysisProjectionBuildContext,
  ): Model;
  pointSelection(
    model: Model,
    point: AnalysisChartCursorPoint,
  ): AnalysisResultSelectionRef | null;
}
```

### Registry

```typescript
const ANALYSIS_PROJECTION_ADAPTERS = new Map<
  AnalysisResultProjectionKind,
  AnalysisProjectionAdapter<unknown, AnalysisProjectionModel>
>([
  ["line-spectrum", lineSpectrumAdapter],
  ["branch-lines", branchLinesAdapter],
  ["heatmap", heatmapAdapter],
  ["time-traces", timeTraceAdapter],
  ["feature-table", spectralFeatureAdapter],
  ["comparison", comparisonAdapter],
]);
```

Adapter nie wywołuje API. Buduje query/model jako pure functions.

## 4.3. Model projekcji

```typescript
export interface AnalysisProjectionModel {
  projectionId: string;
  projectionRevision: string;
  datasetId: string;
  datasetRevision: string;
  axisMapping: AnalysisAxisRoleMapping;
  fixedCoordinates: readonly AnalysisResultCoordinateRef[];
  status: AnalysisResultStatusFacets;
  diagnostics: readonly AnalysisProjectionDiagnostic[];
}

export interface AnalysisLineProjectionModel
  extends AnalysisProjectionModel {
  kind: "line";
  series: readonly AnalysisLineSeries[];
}

export interface AnalysisHeatmapProjectionModel
  extends AnalysisProjectionModel {
  kind: "heatmap";
  shape: readonly [number, number];
  xAxis: AnalysisNumericAxisModel;
  yAxis: AnalysisNumericAxisModel;
  tiles: readonly AnalysisHeatmapTileRef[];
  selectionMapping: AnalysisGridSelectionMapping;
}
```

## 5. Axis role mapping

## 5.1. Role UI

Użytkownik może przypisać osie datasetu do:

```typescript
export type AnalysisAxisDisplayRole =
  | "x"
  | "y"
  | "series"
  | "facet-row"
  | "facet-column"
  | "fixed"
  | "hidden";
```

Mapping musi być legalny dla projection descriptor.

### Przykład field sweep

```text
Dataset axes:
- bias field      outer_sweep
- frequency       spectral
- branch          category/series

Spectrum slice:
- bias field      fixed = 75 mT
- frequency       x
- mode/branch     points/series

Field-frequency map:
- bias field      x
- frequency       y
- response power  color
```

### Przykład 2D material/current sweep

```text
A_ex              x
current density   series
bias field        fixed
frequency         y lub item coordinate
```

## 5.2. Kontrolka

```tsx
export interface AnalysisAxisRoleControlsProps {
  manifest: AnalysisResultDatasetManifest;
  projection: AnalysisResultProjectionDescriptor;
  mapping: AnalysisAxisRoleMapping;
  onChange(mapping: AnalysisAxisRoleMapping): void;
}
```

Kontrolka pokazuje:

- semantic label i symbol;
- canonical SI unit;
- display unit preference;
- cardinality;
- role;
- fixed value, gdy rola `fixed`;
- reason, jeśli mapping jest niedozwolony.

## 5.3. Walidacja mappingu

```typescript
export function validateAxisRoleMapping(
  manifest: AnalysisResultDatasetManifest,
  descriptor: AnalysisResultProjectionDescriptor,
  mapping: AnalysisAxisRoleMapping,
): AxisMappingValidation {
  // dokładnie jedna oś X dla line projection
  // heatmap wymaga X i Y
  // oś spectral/wavevector zgodnie z descriptor capability
  // każda nieprzypisana outer axis musi być fixed
  // brak dwóch ról dla tej samej osi
  // display unit musi być wymiarowo zgodne
}
```

Nielegalny mapping nie uruchamia requestu.

## 6. Controller i hook danych

## 6.1. `useAnalysisPlotsController`

Docelowy controller:

```typescript
export function useAnalysisPlotsController(kernel: KernelApi) {
  const cursor = useAnalysisResultCursor(kernel.resultCursor);
  const viewPreferences = useAnalysisViewPreferencesHydration();
  const route = useAnalysisResultRoute(cursor, viewPreferences);
  const projection = useAnalysisResultProjection({
    cursor,
    route,
    preferences: viewPreferences,
  });

  return {
    cursor,
    route,
    projection,
    // wyłącznie display handlers i typed navigation commands
  };
}
```

Nie pobiera osobnego primary dataset list tylko dlatego, że surface jest
aktywna.

## 6.2. `useAnalysisResultProjection`

```typescript
export function useAnalysisResultProjection({
  cursor,
  route,
  preferences,
}: UseAnalysisResultProjectionInput): AnalysisResultProjectionState {
  const manifest = useAnalysisResultDatasetManifestResource(
    cursor ? resultDatasetIdentity(cursor) : null,
    { enabled: route.enabled },
  );

  const descriptor = resolveProjectionDescriptor(
    manifest.data,
    route.projectionId,
  );
  const mapping = resolveAxisRoleMapping(
    descriptor,
    cursor,
    preferences,
  );
  const query = buildProjectionQuery({ cursor, descriptor, mapping });
  const resource = useAnalysisResultProjectionResource(query, {
    enabled: descriptor !== null && mapping.status === "valid",
  });

  return buildAnalysisResultProjectionState({
    cursor,
    manifest,
    descriptor,
    mapping,
    resource,
  });
}
```

### Request gating

Projection request nie występuje, gdy:

- Analysis center surface jest nieaktywna;
- brak cursoru;
- dataset revision nie pasuje;
- subview nie jest wspierany;
- mapping osi jest nielegalny;
- fixed coordinate jest niekompletne;
- selected run jest foreign względem zasobu.

## 7. Routing powierzchni

## 7.1. Manifest-driven route

```typescript
export interface AnalysisResultRoute {
  surface: AnalysisSurface;
  subview: AnalysisSubview;
  projectionId: string;
  status: "available" | "unsupported" | "incompatible";
  reason: string | null;
}
```

`resolveAnalysisResultRoute` używa:

1. explicit user subview preference;
2. cursor projectionId;
3. default projection manifestu;
4. first compatible canonical subview.

Nie używa nazwy pliku ani heurystyki typu `schema_version.includes(...)` w
komponencie.

## 7.2. Domyślne mapowanie product -> surface

| Product | Surface | Subview |
|---|---|---|
| modal_eigen, finite/gamma/fixed-k | Resonance & FMR | Eigenmodes |
| modal eigen field sweep | Resonance & FMR | Eigenmodes lub Field-Sweep Map |
| modal_dispersion | Dispersion | Modal f_n(k) |
| branches | Dispersion | Branches |
| driven_response | Resonance & FMR | Driven Response |
| driven_response_map | Resonance & FMR lub Dispersion według k context | Field-Sweep Map / Driven A(k,f) |
| time_domain_series | Dynamics | Time Traces |
| time_domain_spectrum | Dynamics | Temporal Spectrum |
| spectral_features | Dynamics | Spectral Features |
| dynamic_structure_factor | Dynamics lub Dispersion | S(k,f) |
| hysteresis | Hysteresis | Loop |
| comparison | Comparison | Datasets |

## 8. Chart point identity

## 8.1. Punkt nie może zawierać tylko rowIndex

```typescript
export interface AnalysisResultChartPointIdentity {
  datasetId: string;
  datasetRevision: string;
  sampleId?: string;
  itemId?: string;
  itemRevision?: string;
  itemKind?: AnalysisResultItemKind;
  branchId?: string;
  coordinateKey?: string;
}

export interface AnalysisResultChartPoint {
  x: number;
  y: number;
  label: string;
  identity: AnalysisResultChartPointIdentity;
  metrics?: Readonly<Record<string, number | null>>;
}
```

`rowIndex` może pozostać rendererowym ordinalem, ale selection używa identity.

## 8.2. Kliknięcie punktu

```typescript
function onProjectionPointSelect(point: AnalysisResultChartPoint): void {
  const next = cursorForProjectionPoint(cursor, point.identity);
  kernel.resultNavigation.select({
    cursor: next,
    focus: point.identity.itemId ? "item" : "slice",
    label: point.label,
    source: "analysis-plots",
  });
}
```

### Branch line

Kliknięcie serii/legendy może ustawić branch focus. Kliknięcie konkretnego point
ustawia branch + sample + item.

### Heatmap

Kliknięcie cell używa selection mapping/tile identity. Nie rekonstruuje sample po
zaokrąglonym `x/y`.

## 9. Synchronizacja z Results

### Results -> Analysis

- dataset/slice/item zmienia cursor;
- Analysis hook tworzy query z tego cursoru;
- wybrany punkt jest podświetlony po stable item ID;
- jeśli item nie należy do projection, Analysis pokazuje projection bez punktu,
  a Inspector nadal opisuje item;
- `Open in Analysis` wybiera compatible subview i center module.

### Analysis -> Results

- click aktualizuje cursor/selection;
- Results po aktywacji rozwija dataset i lokalizuje item;
- slice controls odczytują coordinates;
- nie ma callback props między modułami;
- nie ma zapisu do `resultsNavigatorStore` przez Analysis.

### Inspector -> Analysis

- akcja `Open spectrum`, `Open branch`, `Open field-sweep map` wykonuje command,
  który ustawia projectionId/subview i center surface;
- item identity pozostaje bez zmian.

## 10. Widok Eigenmodes

### 10.1. Pojedynczy sample

```text
X: mode/display order albo frequency według wybranej presentation
Y: frequency [GHz]
Series/color: branch, field availability lub user-selected metric
```

Domyślna prezentacja naukowa powinna być wykresem punktowym frequency z tabelą
modów, nie linią sugerującą ciągłość po indeksie.

### 10.2. Field sweep

Dwa główne modes:

1. **Spectrum at selected field** — fixed bias sample, punkty modów.
2. **Field-sweep map/branches** — bias field na X, frequency na Y, branch lines
   tylko tam, gdzie tracking jest opublikowany.

Nie łączymy kolejnych `raw_mode_index` linią bez branch tracking.

### 10.3. Tooltip

```text
Mode: B1 / sample-0007-mode-0001
μ0 Hx: 75 mT
f: 6.908 GHz
residual: 4.7e-10
field: ready
qualification: unvalidated
```

## 11. Driven Response

### Line spectrum

- X: drive frequency;
- Y: wybrany observable;
- series: observable/component/outer category;
- fixed outer coordinates: Results slice.

### Field-sweep map

- X: outer axis (np. field);
- Y: frequency;
- color: response amplitude/power/susceptibility;
- missing/failed points mają maskę, nie wartość zero;
- kliknięcie mapuje do response point.

### Modal–Driven

Comparison model wymaga:

- primary modal dataset revision;
- driven dataset revision;
- explicit relation/matching policy;
- compatible physical configuration coordinates;
- units/dimension compatibility.

UI pokazuje osobno modal frequency i driven response intensity. Nie nadaje
intensywności eigenfrequency bez coupling observable.

## 12. Dynamics

## 12.1. Time Traces

- explicit temporal-series dataset;
- X: physical time;
- series: components/observables/probes;
- sample clock i cadence w provenance;
- adaptive accepted steps nie są przedstawiane jako uniform output bez
  resampling proof.

## 12.2. Temporal Spectrum

- X: FFT frequency;
- Y: PSD/amplitude/susceptibility;
- wybrany probe/component jako fixed lub series;
- one-sided/two-sided i normalization jawne;
- frequency resolution i Nyquist w status summary.

## 12.3. Spectral Features

Tabela/overlay markerów:

- stable feature ID;
- frequency;
- power/amplitude;
- linewidth i uncertainty;
- detection method;
- response field availability;
- matched relation state.

Feature marker jest wybieralny i mapuje do item.

## 12.4. S(k,f)

- heatmap jest tile/binary projection dla dużych danych;
- spectrum source i response są oddzielnymi quantities;
- skala linear/log jest local display preference;
- cuts są projections tego samego datasetu;
- invalid probe mask i absorber exclusions są widoczne;
- kliknięcie point używa stable mapping.

## 12.5. Spatial Response

Subview nie renderuje ciężkiego pola samodzielnie. Pokazuje:

- selected spectral item;
- field availability;
- controls `Open 3D`, `Open Field Map`;
- ewentualnie bounded thumbnail/probe summary;
- reason, jeśli field nie został zapisany.

## 13. Dispersion

### Modal f_n(k)

- branch lines tylko z tracking artifact;
- scatter fallback dla nieśledzonych modów;
- k path labels i breakpoints;
- exact vector w tooltip/Inspector;
- gaps jako przerwy;
- analytic/reference curves jako osobne qualified series.

### Branches

- tabela branchy;
- tracking score/confidence;
- gaps;
- component participation;
- akcja focus/reveal.

### Driven A(k,f)

- response map po k/f;
- source excitation spectrum nie jest podpisane jako magnetization response;
- fixed outer coordinates;
- click -> response point.

### Cuts

- fixed k, sweep f;
- fixed f, sweep k;
- line cut jest server projection lub bounded tile extraction;
- selection zachowuje cell identity.

## 14. Hysteresis i Comparison

### Hysteresis

Istniejący model może zostać zaadaptowany do result dataset:

- measurement field outer/spectral-like ordered axis;
- branch category;
- magnetization observables;
- point items;
- metrics projection.

Nie jest wymagane przepisywanie fizyki hysteresis w pierwszych PR.

### Comparison

Comparison używa primary result cursor oraz jawnie wybranego secondary datasetu.
Secondary ref jest display preference, ale query zawiera jego revision.

Kompatybilność:

```text
same quantity dimensions
compatible axis semantics
explicit coordinate alignment policy
compatible or transferable topology for spatial differences
```

## 15. Preferences i persistence

## 15.1. Nowy schema

```typescript
export interface AnalysisViewPreferencesV3 {
  schemaVersion: 3;
  activeSurface: AnalysisSurface;
  activeSubviews: Partial<Record<AnalysisSurface, AnalysisSubview>>;
  projectionPreferences: Record<string, AnalysisProjectionPreference>;
  comparisonSecondaryDatasetIds: Record<string, string | null>;
}

export interface AnalysisProjectionPreference {
  projectionId: string;
  axisMapping: AnalysisAxisRoleMapping;
  displayUnits: Record<string, string>;
  selectedSeriesIds: string[];
  range: AnalysisDisplayRange | null;
  scale?: "linear" | "log";
}
```

Klucz preferences używa logical dataset ID + projection ID. Nie zapisuje
scientific revision, points ani cursor pages. Gdy nowa revision usuwa oś/series,
preference jest walidowane i częściowo odrzucane.

## 15.2. Usunięcie primary selectedDatasetRef

`selectedDatasetRef` z v2 jest compatibility input. Migrator może wykorzystać je
do początkowego cursoru tylko wtedy, gdy API potrafi jednoznacznie zmapować ref na
dataset. Nowy writer v3 nie zapisuje primary datasetu w Analysis preferences.

## 16. Series identity

```typescript
export interface AnalysisResultSeriesIdentity {
  datasetId: string;
  projectionId: string;
  quantityId: string;
  component?: string;
  branchId?: string;
  coordinateKey?: string;
}
```

Series ID jest deterministyczny i nie zależy od localized label. Widoczność
serii przechowuje tylko ID.

## 17. Units

### Zasady

- canonical data pozostaje SI;
- display conversion jest dimension-checked;
- zmiana display unit nie wykonuje nowego requestu, jeśli dane są w cache;
- `Hz` i `rad/s` nie są zamieniane bez jawnego conversion;
- dimensionless normalized magnetization nie dostaje prefixu;
- tooltip pokazuje display i opcjonalnie canonical value;
- eksport może użyć SI lub wybranych units, ale zapisuje oba metadata.

### Formatter

```typescript
export interface AnalysisUnitFormatter {
  formatAxisValue(axis: AnalysisNumericAxisModel, valueSI: number): string;
  formatMetric(metric: AnalysisResultMetric, displayUnit?: string): string;
  convert(valueSI: number, fromSIUnit: string, displayUnit: string): number;
}
```

## 18. Export

### Eksport wykresu

Każdy export zawiera sidecar/headers:

```text
run_id
stage_id
dataset_id
dataset_revision
projection_id
projection_revision
fixed coordinates z axis value tokens i SI values
axis mapping
quantity IDs i units
source artifact refs
qualification state
export timestamp jako metadata, nie revision
```

### Format

- CSV/TSV dla line/table;
- PNG/SVG tam, gdzie renderer wspiera;
- NPZ/Zarr/HDF5/FMS dla danych wielowymiarowych przez backend export command;
- screenshot nie jest naukowym exportem danych.

Object URLs są zwalniane po pobraniu.

## 19. Loading, stale i errors

`AnalysisFrequencyPresentationState` powinien zostać uogólniony:

```typescript
export type AnalysisProjectionPresentationState =
  | { kind: "empty" }
  | { kind: "initial-loading" }
  | { kind: "ready"; revision: string }
  | { kind: "refreshing"; visibleRevision: string; requestedRevision: string }
  | { kind: "stale"; visibleRevision: string; error: Error }
  | { kind: "partial"; revision: string; reason: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "incompatible"; reason: string }
  | { kind: "corrupt"; reason: string }
  | { kind: "error"; error: Error };
```

Renderer nie otrzymuje data series przy corrupt/incompatible. Partial może
renderować legalne punkty i maskować braki.

## 20. Lifecycle i wydajność

### Active-only

- `analysis-plots` ładuje projection tylko jako active center module;
- inactive module jest odmontowany;
- result cursor nie znika;
- po powrocie cache może zapewnić warm load;
- ECharts instance jest tworzona raz per mount i niszczona na unmount.

### Model building

- duży artifact nie jest parsowany na każdym renderze;
- projection adapter buduje model po resource revision/query identity;
- heatmap korzysta z tiles/typed arrays;
- brak spread do `Math.min/max` dla dużych arrays;
- local unit/range/legend change nie przebudowuje source modelu;
- animation danych jest wyłączona dla dużych serii;
- resize przez observer, bez interval.

### Budżet requestów

Dla zmiany field sample w Results przy aktywnym Analysis spectrum:

```text
1 locate/sample request, jeśli mapping nie jest już znany
1 item/projection request lub cache hit
0 field requests
0 topology requests
```

Field/topology dopiero po explicit spatial action.

## 21. Migracja z obecnego frequency-domain flow

### Etap 1 — adapter pod istniejącym Analysis

- pełny typed field sweep;
- zbudować `AnalysisResultDatasetManifest` client-side wyłącznie w testowym
  compatibility adapterze lub server-side preferred;
- podłączyć spectrum-at-slice dla field sweep;
- zachować stare `useAnalysisFrequencyData` dla pozostałych produktów.

### Etap 2 — generic projection hook

- dodać `useAnalysisResultProjection`;
- migrować modal spectrum;
- migrować dispersion/branches;
- migrować driven response;
- parity tests z obecnymi chart models.

### Etap 3 — cursor ownership

- primary dataset/slice z result cursor;
- usunąć nowe zapisy `selectedDatasetRef`;
- bounded read preferences v2;
- chart clicks emitują `analysis-result` selection.

### Etap 4 — time-domain

- temporal series;
- temporal spectrum/features;
- DSF/cuts;
- response field links.

### Etap 5 — usunięcie artifact-specific routing

- `useAnalysisFrequencyData` zostaje compatibility wrapper albo jest usunięty;
- stare selection routes zostają usunięte po release gate;
- tests potwierdzają brak dual requests.

## 22. Testy

### Pure adapters

- descriptor/product compatibility;
- legal/illegal axis mappings;
- SI/display conversions;
- series identity;
- branch gaps;
- point -> stable selection;
- heatmap cell mapping;
- partial/missing masks;
- comparison compatibility.

### Hooks/controller

- brak cursoru = zero requests;
- inactive module = zero requests;
- route mismatch = zero subresource requests;
- cursor revision change abortuje stary request;
- unit/range/legend = zero network;
- stale retention;
- click updates cursor/selection once;
- Results-origin selection podświetla point.

### Component/a11y

- surface/subview availability;
- axis controls keyboard;
- tooltip/DOM summary z units;
- 200% zoom;
- reduced motion;
- no-data/partial/corrupt states;
- ECharts dispose.

## 23. Definition of Done

- Analysis nie posiada niezależnego primary dataset selection;
- każda subview jest projection opublikowanego datasetu;
- axis mapping jest typed i walidowane przed requestem;
- każdy selectable point/cell ma stable sample/item identity;
- click round-trip synchronizuje Results i Inspector;
- field sweep obsługuje spectrum at selected field i mapę/branches;
- fixed-k/k-path zachowują pełny k context;
- driven point nie jest eigenmode;
- FFT peak jest spectral feature;
- DSF cuts używają tego samego datasetu;
- units są jawne i local conversion nie pobiera danych;
- export zawiera dataset/projection revisions i coordinates;
- inactive Analysis nie utrzymuje ECharts ani requests;
- partial/stale/corrupt/incompatible mają odrębne stany;
- artifact-specific compatibility path ma właściciela i removal gate.
