# 02 — Model domenowy wyników, tożsamości i stan aplikacji

## 1. Cel

Wspólny UI jest możliwy tylko wtedy, gdy wszystkie powierzchnie używają tej
samej semantyki danych. Ten rozdział definiuje model domenowy dla:

- datasetów;
- osi i współrzędnych;
- sample/slice;
- elementów wynikowych;
- branchy;
- pól;
- relacji;
- projections;
- result cursor;
- globalnej selekcji;
- lifecycle, kompletności i kwalifikacji.

Model jest backend-neutralny, ale nie physics-neutral w znaczeniu utraty
semantyki. Każdy typ zachowuje dokładne rozróżnienie między eigenmodem, punktem
odpowiedzi, pikiem FFT, punktem DSF i fitem.

## 2. Zasady tożsamości

### 2.1. Stable ID kontra indeks

Stable IDs są źródłem tożsamości:

```text
dataset_id
axis_id
axis_value_token
sample_id
item_id
branch_id
field_id
relation_id
projection_id
mesh_id
```

Indeksy służą wyłącznie prezentacji lub bounded lookupowi compatibility:

```text
sample_index
raw_mode_index
frequency_index
row_index
page_offset
```

Nie wolno:

- identyfikować sample przez indeks;
- identyfikować branch przez `raw_mode_index`;
- identyfikować punkt przez wartość `f64`;
- identyfikować pole przez aktualny quantity selection bez source item;
- zachowywać selection po re-orderingu tylko dlatego, że indeks jest równy.

### 2.2. Revision uczestniczy w tożsamości snapshotu

Ten sam `dataset_id` może mieć kolejną rewizję, ale field/item z jednej rewizji
nie jest automatycznie zgodny z inną.

```text
logical identity: dataset_id
snapshot identity: dataset_id + dataset_revision
item snapshot: dataset_revision + sample_id + item_id
field snapshot: dataset_revision + sample_id + item_id + field_id + field_revision
```

### 2.3. Wartość numeryczna nie jest kluczem

Dla osi pola:

```json
{
  "axis_value_token": "bias-hx-0007",
  "value_si": 59683.10365946075,
  "display": {"value": 75.0, "unit": "mT"}
}
```

UI wysyła token `bias-hx-0007`. Wartość SI służy do wykresu, sortowania i
prezentacji. Zapobiega to problemom reprezentacji float, równych wartości w
różnych kontekstach oraz zmianom konwersji jednostek.

## 3. Model datasetu

### 3.1. Rust — manifest publiczny

Proponowany kontrakt API:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResultDatasetManifestResource {
    pub schema_version: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub run_id: String,
    pub stage_id: String,
    pub product_kind: AnalysisResultProductKind,
    pub title: String,
    pub description: Option<String>,
    pub status: AnalysisResultStatusFacets,
    pub source_artifacts: Vec<AnalysisResultSourceArtifactRef>,
    pub axes: Vec<AnalysisResultAxisResource>,
    pub item_kinds: Vec<AnalysisResultItemKind>,
    pub projections: Vec<AnalysisResultProjectionDescriptor>,
    pub capabilities: AnalysisResultDatasetCapabilities,
    pub default_cursor: AnalysisResultDefaultCursor,
    pub topology_policy: AnalysisResultTopologyPolicy,
    pub units_policy: AnalysisResultUnitsPolicy,
    pub provenance: AnalysisResultProvenanceSummary,
}
```

### 3.2. Product kinds

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisResultProductKind {
    ModalEigen,
    ModalDispersion,
    DrivenResponse,
    DrivenResponseMap,
    TimeDomainSeries,
    TimeDomainSpectrum,
    SpectralFeatures,
    DynamicStructureFactor,
    Hysteresis,
    ResonanceFit,
    ModalDrivenComparison,
    Convergence,
}
```

`product_kind` determinuje legalne item kinds, projections i relacje, ale UI nie
wykonuje switcha po backendzie `FEM/FDM`. Backend/device są provenance.

### 3.3. Capabilities datasetu

```rust
pub struct AnalysisResultDatasetCapabilities {
    pub sample_paging: bool,
    pub item_paging: bool,
    pub server_filtering: bool,
    pub server_sorting: bool,
    pub branch_tracking: bool,
    pub fields: bool,
    pub result_meshes: bool,
    pub comparison: bool,
    pub export: bool,
    pub live_partial_results: bool,
}
```

Capability `fields=true` oznacza, że co najmniej część itemów może mieć field
refs. Nie oznacza, że każdy item ma pole. Field availability pozostaje per item.

## 4. Osie

### 4.1. Typ osi

```rust
pub struct AnalysisResultAxisResource {
    pub axis_id: String,
    pub role: AnalysisResultAxisRole,
    pub value_kind: AnalysisResultAxisValueKind,
    pub semantic_id: String,
    pub label: String,
    pub symbol: Option<String>,
    pub unit_si: Option<String>,
    pub preferred_display_units: Vec<String>,
    pub ordering: AnalysisResultAxisOrdering,
    pub cardinality: u64,
    pub values_resource_key: Option<String>,
    pub inline_values: Option<Vec<AnalysisResultAxisValueResource>>,
    pub projections: Vec<AnalysisResultAxisProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisResultAxisRole {
    OuterSweep,
    Spectral,
    Wavevector,
    Component,
    Spatial,
    Replicate,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisResultAxisValueKind {
    Scalar,
    Vector3,
    Category,
    EntityRef,
    Integer,
    Timestamp,
}
```

### 4.2. Semantic IDs

Przykłady:

```text
field:bias:H
field:bias:H:x
material:film:A_ex
material:film:M_s
material:film:alpha
geometry:antidot:diameter
geometry:film:thickness
transport:current-density:J
wavevector:k
wavevector:path-s
spectral:eigenfrequency
spectral:drive-frequency
spectral:fft-frequency
component:magnetization
replicate:seed
```

Semantic ID jest stabilnym odwołaniem do znaczenia parametru, nie adresem pola
formularza React.

### 4.3. Wartości osi

```rust
pub struct AnalysisResultAxisValueResource {
    pub token: String,
    pub scalar_si: Option<f64>,
    pub vector3_si: Option<[f64; 3]>,
    pub category: Option<String>,
    pub entity_ref: Option<AnalysisResultEntityRef>,
    pub label: Option<String>,
    pub status: AnalysisResultArtifactCompleteness,
}
```

Dokładnie jedno pole wartości jest ustawione zgodnie z `value_kind`.

### 4.4. Projekcje osi wektorowej

Bias field może być wektorem, a UI potrzebuje czytelnej osi skalarnej.

```rust
pub struct AnalysisResultAxisProjection {
    pub projection_id: String,
    pub label: String,
    pub symbol: Option<String>,
    pub unit_si: String,
    pub operation: AnalysisResultAxisProjectionOperation,
}

pub enum AnalysisResultAxisProjectionOperation {
    Component { index: u8 },
    Magnitude,
    DotWith { direction: [f64; 3], frame_id: String },
}
```

UI nie zakłada, że pierwsza niezerowa składowa jest osią sweepu. Writer/API
publikuje legalne projections.

## 5. Coordinates, sample i slice

### 5.1. Coordinate tuple

```rust
pub struct AnalysisResultCoordinateResource {
    pub axis_id: String,
    pub value_token: String,
}

pub struct AnalysisResultSampleSummaryResource {
    pub sample_id: String,
    pub sample_revision: String,
    pub sample_index: Option<u64>,
    pub coordinates: Vec<AnalysisResultCoordinateResource>,
    pub status: AnalysisResultStatusFacets,
    pub item_count: u64,
    pub field_count: u64,
    pub mesh_ref: Option<AnalysisResultMeshRef>,
    pub provenance_ref: Option<String>,
}
```

`sample_id` jest stabilne w obrębie logicznego datasetu. `sample_revision`
zmienia się, gdy zmienia się jakakolwiek naukowa zawartość próbki.

### 5.2. Slice

Slice nie jest osobnym artefaktem. Jest małym wyborem współrzędnych:

```typescript
export interface AnalysisResultSliceRef {
  coordinates: readonly {
    axisId: string;
    valueToken: string;
  }[];
  sampleId?: string;
}
```

Dla regularnego sweepu tuple coordinates mapuje do jednego sample. Dla
produktów, gdzie sample obejmuje wiele wartości osi, `sampleId` pozostaje
kanonicznym kluczem, a coordinates służą do nawigacji i walidacji.

### 5.3. Kanoniczny coordinate key

```typescript
export function canonicalCoordinateKey(
  coordinates: readonly AnalysisResultCoordinateRef[],
): string {
  return [...coordinates]
    .sort((left, right) => left.axisId.localeCompare(right.axisId))
    .map(({ axisId, valueToken }) =>
      `${encodeURIComponent(axisId)}=${encodeURIComponent(valueToken)}`,
    )
    .join("&");
}
```

Key używa tokenów. Nie zawiera display values ani unit preferences.

## 6. Elementy wynikowe

### 6.1. Wspólna koperta itemu

```rust
pub struct AnalysisResultItemSummaryResource {
    pub item_id: String,
    pub item_revision: String,
    pub item_kind: AnalysisResultItemKind,
    pub sample_id: String,
    pub label: String,
    pub status: AnalysisResultStatusFacets,
    pub coordinates: Vec<AnalysisResultCoordinateResource>,
    pub metrics: Vec<AnalysisResultMetricSummary>,
    pub branch_ref: Option<AnalysisResultBranchRef>,
    pub fields: Vec<AnalysisResultFieldRef>,
    pub relations: Vec<AnalysisResultRelationRef>,
    pub detail_resource_key: String,
}
```

### 6.2. Item kinds

```rust
pub enum AnalysisResultItemKind {
    EigenMode,
    Branch,
    BranchPoint,
    ResponsePoint,
    SpectralFeature,
    DsfPoint,
    ResonanceFit,
    TimeTrace,
    HysteresisPoint,
    ComparisonPair,
}
```

### 6.3. Metryki

```rust
pub struct AnalysisResultMetricSummary {
    pub metric_id: String,
    pub value: Option<f64>,
    pub unit: Option<String>,
    pub status: AnalysisResultMetricStatus,
}
```

Typowe metryki:

```text
frequency_hz
angular_frequency_rad_per_s
imaginary_frequency_hz
damping_rate_hz
linewidth_hz
q_factor
residual_relative_l2
tangent_leakage_max
tracking_overlap
tracking_confidence
response_amplitude
absorbed_power
susceptibility_abs
spectral_power
fit_residual_l2
uncertainty_hz
```

Brak wartości nie jest zerem. `status` wyjaśnia `missing`, `unsupported`,
`not_applicable` lub `invalid`.

## 7. Typowane detale itemów

Wspólna koperta nie zastępuje typed detail payloadów.

### 7.1. Eigenmode

```rust
pub struct EigenModeResultDetailResource {
    pub common: AnalysisResultItemSummaryResource,
    pub mode_id: String,
    pub raw_mode_index: Option<u64>,
    pub display_mode_index: Option<u64>,
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: Option<f64>,
    pub frequency_imag_hz: Option<f64>,
    pub residual_relative_l2: Option<f64>,
    pub tangent_leakage_max: Option<f64>,
    pub dominant_polarization: Option<String>,
    pub component_participation: Option<ModalParticipationResource>,
    pub source_spectrum_revision: String,
}
```

### 7.2. Driven response point

```rust
pub struct DrivenResponsePointDetailResource {
    pub common: AnalysisResultItemSummaryResource,
    pub point_id: String,
    pub frequency_hz: f64,
    pub observables: Vec<AnalysisResultObservableValue>,
    pub solver_residual: Option<f64>,
    pub convergence_status: String,
    pub source_response_revision: String,
}
```

### 7.3. Spectral feature

```rust
pub struct SpectralFeatureDetailResource {
    pub common: AnalysisResultItemSummaryResource,
    pub feature_id: String,
    pub feature_kind: String,
    pub frequency_hz: f64,
    pub bin_index: Option<u64>,
    pub power: Option<f64>,
    pub amplitude: Option<f64>,
    pub linewidth_hz: Option<f64>,
    pub uncertainty_hz: Option<f64>,
    pub source_spectrum_id: String,
    pub source_spectrum_revision: String,
    pub detection_method: String,
    pub detection_parameters: serde_json::Value,
}
```

Nie zawiera pola `mode_id`, chyba że jako typed relation opisany niżej.

### 7.4. DSF point

```rust
pub struct DsfPointDetailResource {
    pub common: AnalysisResultItemSummaryResource,
    pub point_id: String,
    pub wavevector_rad_per_m: [f64; 3],
    pub frequency_hz: f64,
    pub power: f64,
    pub complex_value: Option<[f64; 2]>,
    pub source_observable: String,
}
```

## 8. Branch model

### 8.1. Branch identity

```rust
pub struct AnalysisResultBranchRef {
    pub branch_id: String,
    pub branch_revision: String,
}

pub struct AnalysisResultBranchResource {
    pub branch_id: String,
    pub branch_revision: String,
    pub dataset_id: String,
    pub path_axis_id: String,
    pub fixed_coordinates: Vec<AnalysisResultCoordinateResource>,
    pub tracking_method: String,
    pub score_definition: String,
    pub points: Option<Vec<AnalysisResultBranchPointSummary>>,
    pub points_resource_key: Option<String>,
    pub gaps: Vec<AnalysisResultBranchGap>,
    pub qualification: AnalysisResultQualificationState,
}
```

### 8.2. Branch nie jest raw mode index

Przy przejściu między sample:

```text
preserve policy = branch_id
```

nie:

```text
preserve policy = raw_mode_index
```

Gdy branch nie istnieje w sample, cursor zachowuje branch focus, ale item jest
`null`, a UI pokazuje gap.

### 8.3. Tracking na wielowymiarowym sweepie

Branch musi określać:

- jedną uporządkowaną path axis;
- fixed coordinates pozostałych osi;
- metodę i score;
- gaps;
- source revisions.

Globalny branch na siatce 2D/3D wymaga osobnego grafu trackingu. UI nie tworzy
go przez sortowanie punktów.

## 9. Field references

```rust
pub struct AnalysisResultFieldRef {
    pub field_id: String,
    pub field_revision: String,
    pub field_kind: AnalysisResultFieldKind,
    pub quantity_id: String,
    pub representation: AnalysisResultFieldRepresentation,
    pub component_basis: String,
    pub component_count: u8,
    pub metadata_resource_key: String,
    pub binary_resource_key: String,
    pub mesh_ref: AnalysisResultMeshRef,
    pub available_views: Vec<String>,
    pub default_view: String,
    pub status: AnalysisResultArtifactCompleteness,
}

pub enum AnalysisResultFieldKind {
    EigenMode,
    DrivenResponse,
    TimeDomainResponse,
    StaticState,
    Difference,
}

pub enum AnalysisResultFieldRepresentation {
    ComplexVectorXyz,
    RealVectorXyz,
    ComplexScalar,
    RealScalar,
}
```

### Inwariant field ref

Field ref jest legalny tylko, gdy:

```text
field.dataset_revision == cursor.dataset_revision
field.sample_id == cursor.sample_id
field.item_id == cursor.item_id, jeśli pole jest item-scoped
field.mesh_ref odpowiada binary header
representation i component basis są obsługiwane
```

Item `spectrum-only` ma pustą listę fields i pozostaje pełnoprawnym elementem
widma.

## 10. Result mesh

```rust
pub struct AnalysisResultMeshRef {
    pub mesh_id: String,
    pub mesh_revision: String,
    pub domain_generation_id: Option<String>,
    pub topology_fingerprint: String,
    pub point_count: u64,
    pub indexing: String,
    pub metadata_resource_key: String,
    pub topology_resource_key: Option<String>,
}

pub enum AnalysisResultTopologyPolicy {
    SharedAcrossDataset { mesh: AnalysisResultMeshRef },
    PerSample,
    NoSpatialPayload,
}
```

Dla `PerSample` każdy sample z fieldami musi mieć mesh ref. Current-session mesh
nie jest domyślnym substytutem.

## 11. Relacje

### 11.1. Typed relation

```rust
pub struct AnalysisResultRelationRef {
    pub relation_id: String,
    pub relation_revision: String,
    pub relation_kind: AnalysisResultRelationKind,
    pub target_dataset_id: String,
    pub target_sample_id: Option<String>,
    pub target_item_id: Option<String>,
    pub detail_resource_key: String,
}

pub enum AnalysisResultRelationKind {
    Source,
    DerivedFrom,
    SameBranch,
    MatchedEigenMode,
    ModalDrivenPair,
    ConvergenceCounterpart,
    SamePhysicalConfiguration,
    ResultMesh,
}
```

### 11.2. Matched eigenmode

```rust
pub struct MatchedEigenModeRelationResource {
    pub relation: AnalysisResultRelationRef,
    pub method: String,
    pub frequency_distance_hz: f64,
    pub normalized_frequency_distance: Option<f64>,
    pub spatial_overlap: Option<f64>,
    pub confidence: f64,
    pub source_revisions: Vec<String>,
    pub qualification: AnalysisResultQualificationState,
}
```

Sama bliskość częstotliwości nie daje wysokiego confidence, jeśli nie ma
wymaganego kryterium fizycznego.

## 12. Projections

```rust
pub struct AnalysisResultProjectionDescriptor {
    pub projection_id: String,
    pub kind: AnalysisResultProjectionKind,
    pub label: String,
    pub supported_axis_roles: Vec<AnalysisResultAxisRole>,
    pub default_axis_mapping: AnalysisResultAxisMapping,
    pub data_resource_key_template: String,
    pub selection_mapping: AnalysisResultProjectionSelectionMapping,
}
```

Projection jest opisem prezentacji, np.:

```text
modal-spectrum-at-slice
modal-dispersion
branch-lines
response-spectrum-at-slice
field-frequency-map
temporal-trace
temporal-spectrum
spectral-features
dsf-heatmap
dsf-frequency-cut
dsf-wavevector-cut
hysteresis-loop
comparison-difference
```

Każdy punkt projection musi mapować do stable sample/item albo jawnie być
aggregate bez item selection.

## 13. Status facets

```rust
pub struct AnalysisResultStatusFacets {
    pub execution: AnalysisResultExecutionState,
    pub completeness: AnalysisResultArtifactCompleteness,
    pub qualification: AnalysisResultQualificationState,
    pub reason_code: Option<String>,
    pub detail: Option<String>,
}
```

### 13.1. Execution

```text
planned
queued
running
completed
failed
cancelled
not_applicable
```

### 13.2. Completeness

```text
complete
partial
interrupted
corrupt
missing
unsupported
```

### 13.3. Qualification

```text
source_visible
unvalidated
algebra_validated
physics_validated
production_qualified
```

`resource lifecycle` jest frontendowym stanem hooka i nie wchodzi do immutable
manifestu.

## 14. Result cursor

### 14.1. Typ

```typescript
export interface AnalysisResultCursorSnapshot {
  runId: string;
  stageId: string;
  datasetId: string;
  datasetRevision: string;
  slice: AnalysisResultSliceRef;
  item?: AnalysisResultItemRef;
  branch?: AnalysisResultBranchRef;
  projectionId?: string;
  revision: number;
}

export interface AnalysisResultItemRef {
  itemId: string;
  itemRevision: string;
  itemKind: AnalysisResultItemKind;
  sampleId: string;
}
```

`revision` cursora jest lokalnym monotonicznym numerem transakcji, nie revision
naukowego datasetu.

### 14.2. Controller

```typescript
export class AnalysisResultCursorController {
  private snapshot: AnalysisResultCursorSnapshot | null = null;
  private listeners = new Set<() => void>();

  getSnapshot = () => this.snapshot;

  setDataset(input: SetDatasetCursorInput): void;
  setSlice(input: SetResultSliceInput): void;
  setItem(input: SetResultItemInput): void;
  setBranch(input: SetResultBranchInput): void;
  setProjection(projectionId: string | null): void;
  clear(reason: AnalysisResultCursorClearReason): void;
  subscribe(listener: () => void): () => void;
}
```

Controller waliduje czysto strukturalne inwarianty. Walidacja istnienia IDs
odbywa się przez resource adapters przed wykonaniem transakcji.

### 14.3. Cursor transition

```typescript
export function transitionResultCursor(
  previous: AnalysisResultCursorSnapshot | null,
  intent: AnalysisResultCursorIntent,
): AnalysisResultCursorSnapshot {
  switch (intent.kind) {
    case "select-dataset":
      return cursorForDataset(intent.manifest, intent.preferredCoordinates);
    case "select-slice":
      return cursorForSlice(previous, intent.sample, intent.coordinates);
    case "select-item":
      return cursorForItem(previous, intent.item);
    case "preserve-branch-at-slice":
      return cursorForTrackedBranchPoint(previous, intent.branchPoint);
  }
}
```

Zmiana jest jedną transakcją. Nie ma sekwencji:

```text
setDataset -> render -> setSample -> render -> setItem
```

która pozostawiałaby chwilowo nielegalne kombinacje.

## 15. Kanoniczna selection

### 15.1. Typ

```typescript
export interface AnalysisResultSelectionRef {
  type: "analysis-result";
  focus:
    | "dataset"
    | "slice"
    | "item"
    | "branch"
    | "field"
    | "relation"
    | "source";
  runId: string;
  stageId: string;
  datasetId: string;
  datasetRevision: string;
  sampleId?: string;
  itemId?: string;
  itemRevision?: string;
  itemKind?: AnalysisResultItemKind;
  branchId?: string;
  branchRevision?: string;
  fieldId?: string;
  fieldRevision?: string;
  relationId?: string;
  relationRevision?: string;
  projectionId?: string;
  coordinateKey?: string;
  nodeId: string;
}
```

### 15.2. Equality

```typescript
export function analysisResultSelectionRefEquals(
  left: AnalysisResultSelectionRef | null,
  right: AnalysisResultSelectionRef | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.focus === right.focus &&
    left.runId === right.runId &&
    left.stageId === right.stageId &&
    left.datasetId === right.datasetId &&
    left.datasetRevision === right.datasetRevision &&
    left.sampleId === right.sampleId &&
    left.itemId === right.itemId &&
    left.itemRevision === right.itemRevision &&
    left.branchId === right.branchId &&
    left.branchRevision === right.branchRevision &&
    left.fieldId === right.fieldId &&
    left.fieldRevision === right.fieldRevision &&
    left.relationId === right.relationId &&
    left.relationRevision === right.relationRevision &&
    left.projectionId === right.projectionId;
}
```

`nodeId` i display labels nie definiują naukowej równości.

## 16. Atomowe powiązanie cursor + selection

Nie należy pozwolić modułom wykonywać osobno:

```typescript
kernel.resultCursor.setItem(...);
kernel.selection.set(...);
```

Docelowy kernel command/controller:

```typescript
export interface SelectAnalysisResultInput {
  cursor: AnalysisResultCursorSnapshot;
  focus: AnalysisResultSelectionRef["focus"];
  label: string;
  ref: AnalysisResultSelectionRef;
}

export function selectAnalysisResult(
  kernel: KernelApi,
  input: SelectAnalysisResultInput,
  source: ModuleId,
): void {
  kernel.resultCursor.transaction(() => {
    kernel.resultCursor.replace(input.cursor);
    kernel.selection.set({
      kind: `analysis.result.${input.focus}`,
      label: input.label,
      nodeId: input.ref.nodeId,
      objectId: null,
      ref: input.ref,
    }, source);
  });
}
```

Implementacja może użyć jednego `AnalysisResultNavigationController`, jeśli
łatwiej zagwarantować kolejność powiadomień. Wymagany efekt:

1. overlay jest unieważniony na podstawie nowego cursoru;
2. selection i Inspector widzą ten sam snapshot;
3. słuchacze nie obserwują pośredniej niezgodnej kombinacji.

## 17. Stan modułów

### 17.1. Result Navigator store

Dozwolone:

```typescript
interface ResultsNavigatorUiState {
  expandedDatasetNodeIds: ReadonlySet<string>;
  filterText: string;
  itemFilter: ResultItemFilter;
  itemSort: ResultItemSort;
  samplePageCursor: string | null;
  itemPageCursor: string | null;
  preservePolicy: "none" | "branch";
  panelMode: "datasets" | "slice" | "items";
}
```

Zabronione:

```text
manifest payload
sample pages
item pages
fields
topology
FFT arrays
spectrum points
```

### 17.2. Analysis workspace

Po migracji `selectedDatasetRef` nie jest drugim źródłem dataset selection.
Store zawiera wyłącznie:

- active surface/subview;
- projection preference per dataset;
- axis role mapping;
- visible series;
- display units;
- range/zoom;
- comparison secondary dataset ref;
- focused chart ID.

Primary dataset i slice pochodzą z result cursor.

### 17.3. Inspector

Inspector przechowuje:

- open sections;
- active local tab;
- local draft controls, jeżeli istnieją;
- scroll/focus restoration.

Nie przechowuje kopii item detail lub field metadata.

## 18. Compatibility z `frequency-domain` selection

### 18.1. Jeden bounded reader

```typescript
export function analysisResultRefFromLegacyFrequencyDomainRef(
  legacy: LegacyFrequencyDomainSelectionRef,
  index: AnalysisResultCompatibilityIndex,
): AnalysisResultSelectionRef | null;
```

Reader:

- istnieje w jednym pliku `shared/domain/analysis/results/compatibility.ts`;
- działa tylko dla opublikowanej mapping revision;
- nie zgaduje datasetu po samym `modeIndex`;
- wymaga run/stage/artifact revision;
- raportuje reason code przy braku mapowania;
- nigdy nie zapisuje legacy ref.

### 18.2. Removal gate

Legacy reader można usunąć dopiero, gdy:

- jedna wydana wersja zapisuje wyłącznie `analysis-result` refs;
- browser migration tests pokrywają persisted/deep-link inputs;
- Explorer, Results, Analysis, Inspector i overlay nie emitują starego typu;
- telemetry/diagnostics nie wykazuje użycia readera w wspieranym zakresie.

## 19. Przykłady modeli

### 19.1. Bias-field modal sweep

```json
{
  "dataset_id": "result:run-17:eigen-field-sweep",
  "product_kind": "modal_eigen",
  "axes": [
    {
      "axis_id": "bias-field",
      "role": "outer_sweep",
      "value_kind": "vector3",
      "semantic_id": "field:bias:H",
      "unit_si": "A/m"
    },
    {
      "axis_id": "eigenfrequency",
      "role": "spectral",
      "value_kind": "scalar",
      "semantic_id": "spectral:eigenfrequency",
      "unit_si": "Hz"
    }
  ],
  "item_kinds": ["eigen_mode"]
}
```

### 19.2. K-path modal dispersion

```json
{
  "product_kind": "modal_dispersion",
  "axes": [
    {"axis_id": "k-path-s", "role": "wavevector", "unit_si": "rad/m"},
    {"axis_id": "frequency", "role": "spectral", "unit_si": "Hz"}
  ],
  "item_kinds": ["branch_point", "eigen_mode"]
}
```

### 19.3. Driven field-frequency map

```json
{
  "product_kind": "driven_response_map",
  "axes": [
    {"axis_id": "bias-field", "role": "outer_sweep", "unit_si": "A/m"},
    {"axis_id": "drive-frequency", "role": "spectral", "unit_si": "Hz"}
  ],
  "item_kinds": ["response_point"]
}
```

### 19.4. Time-domain FFT

```json
{
  "product_kind": "time_domain_spectrum",
  "axes": [
    {"axis_id": "probe", "role": "spatial", "value_kind": "entity_ref"},
    {"axis_id": "component", "role": "component", "value_kind": "category"},
    {"axis_id": "fft-frequency", "role": "spectral", "unit_si": "Hz"}
  ],
  "item_kinds": ["spectral_feature"]
}
```

## 20. Walidacja kontraktu

Każdy manifest i page resource musi przejść walidację:

- non-empty IDs i bounded lengths;
- canonical digest format;
- unikalne axis IDs;
- unikalne value tokens per axis;
- coordinate odwołuje się do istniejącej osi i tokenu;
- sample coordinates nie zawierają duplikatu axis ID;
- item sample istnieje;
- item kind jest legalny dla datasetu;
- field ref ma legalny mesh ref i representation;
- relation source/target revisions istnieją;
- status `complete` nie zawiera wymaganych missing refs;
- projection axis mapping używa legalnych ról;
- default cursor wskazuje istniejący sample/slice.

Błąd walidacji nie jest automatycznie `500`. API zwraca typed contract problem z
reason code i nie publikuje datasetu jako ready.

## 21. Kryteria akceptacji modelu domenowego

- jeden model obsługuje K0, non-K0, driven i LLG/FFT bez utraty item kind;
- wszystkie IDs są stabilne i niezależne od kolejności;
- coordinate token, nie float, uczestniczy w query identity;
- branch tracking nie używa raw mode index;
- field ref jest związany z dataset/sample/item/mesh revisions;
- geometry sweep ma per-sample mesh identity;
- cursor i selection są atomowo synchronizowane;
- wybór obiektu modelu nie kasuje result cursor;
- Analysis nie posiada drugiego primary dataset selection;
- legacy mapping jest bounded, testowany i usuwalny;
- wszystkie status facets pozostają rozdzielone.
