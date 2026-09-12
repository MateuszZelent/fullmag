# 03 — Artefakty, API v2, zasoby i stronicowanie

## 1. Cel

Ten rozdział definiuje drogę danych od solver-native artifacts do Control Room.
Pierwszym wymaganiem jest naprawienie istniejącego typed field-sweep handoffu.
Drugim — wprowadzenie run-scoped result dataset API, które potrafi indeksować
różne produkty bez zmuszania frontendu do czytania plików lub `extra`.

Kanoniczna ścieżka:

```text
runner writer
  -> immutable artifact + digest
  -> server-side validation/adaptation
  -> OpenAPI v2 resource
  -> generated TypeScript transport/types
  -> ControlRoomApi facade
  -> revision-aware resource hook
  -> shared domain adapter
  -> module
```

## 2. Stan wejściowy i najpilniejsza luka

`crates/fullmag-runner/src/eigen/artifacts/field_sweep.rs` publikuje między innymi:

- `scan_axis`;
- `display_conversions`;
- `requested_sample_count` i `completed_sample_count`;
- `source`, `source_revision`, `revision`, `content_sha256`;
- requested/resolved execution;
- topology;
- per-sample bias field w A/m i `mu0 H` w T;
- equilibrium, linearization i operator signatures;
- branch IDs;
- per-sample mode records;
- frequency, residual i field references;
- cross-artifact refs;
- complete/partial/interrupted/corrupt.

Obecny typ API `FrequencyDomainFieldSweepArtifactPayload` jawnie opisuje tylko
część root fields, a per-sample payload głównie `sample_id`, `sample_index`,
`bias_field_a_per_m` i status. Pozostałe pola trafiają do `flatten extra`.
Frontend nie może traktować `extra` jako publicznego kontraktu.

Wniosek: **PR wdrażający UI nie może poprzedzić typed parity API**.

## 3. Faza A — pełny typed `eigen/field_sweep.v1`

## 3.1. Typy Rust API

W `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` albo w
wydzielonym module schema należy jawnie zdefiniować pełną kopertę:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepArtifactPayload {
    pub schema_version: String,
    pub artifact_id: String,
    pub source: FrequencyDomainArtifactSourcePayload,
    pub source_revision: String,
    pub run_id: String,
    pub stage_id: String,
    pub scope_id: String,
    pub runtime_id: String,
    pub revision: String,
    pub content_sha256: String,
    pub status: FrequencyDomainArtifactStatusPayload,
    pub complete: bool,
    pub interrupted: bool,
    pub stop_reason: Option<String>,
    pub requested_sample_count: u64,
    pub completed_sample_count: u64,
    pub scan_axis: FrequencyDomainFieldSweepAxisPayload,
    pub units: FrequencyDomainArtifactUnitsPayload,
    pub topology: FrequencyDomainArtifactTopologyPayload,
    pub requested_execution: FrequencyDomainArtifactExecutionPayload,
    pub resolved_execution: FrequencyDomainArtifactExecutionPayload,
    pub samples: Vec<FrequencyDomainFieldSweepSamplePayload>,
    pub cross_artifact_refs: Vec<FrequencyDomainArtifactReferencePayload>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}
```

`extra` pozostaje wyłącznie dla niekrytycznych pól forward-compatible. Żadne
pole wymagane do listy sample, modów, branch trackingu, pola ani provenance nie
może być dostępne tylko przez `extra`.

### Oś i konwersje

```rust
pub struct FrequencyDomainFieldSweepAxisPayload {
    pub kind: String,
    pub coordinate: String,
    pub unit: String,
    pub display_conversions: Vec<FrequencyDomainFieldSweepDisplayConversionPayload>,
}

pub struct FrequencyDomainFieldSweepDisplayConversionPayload {
    pub name: String,
    pub unit: String,
    pub scale: f64,
}
```

### Sample

```rust
pub struct FrequencyDomainFieldSweepSamplePayload {
    pub sample_id: String,
    pub sample_index: Option<u64>,
    pub scan_axis: FrequencyDomainFieldSweepAxisPayload,
    pub bias_field_a_per_m: [f64; 3],
    pub bias_field_mu0_t: [f64; 3],
    pub equilibrium_artifact_sha256: Option<String>,
    pub linearization_state_sha256: Option<String>,
    pub operator_input_signature_sha256: Option<String>,
    pub topology: FrequencyDomainArtifactTopologyPayload,
    pub branch_ids: Vec<u64>,
    pub modes: Vec<FrequencyDomainFieldSweepModePayload>,
    pub status: FrequencyDomainArtifactStatusPayload,
    pub stop_reason: Option<String>,
}
```

### Mode

```rust
pub struct FrequencyDomainFieldSweepModePayload {
    pub sample_id: String,
    pub mode_id: String,
    pub raw_mode_index: u64,
    pub branch_id: Option<u64>,
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub mode_artifact_path: Option<String>,
    pub mode_field_id: Option<String>,
    pub mode_field_resource_key: Option<String>,
    pub residual_relative_l2: Option<f64>,
    pub source_revision: String,
    pub status: FrequencyDomainArtifactStatusPayload,
}
```

`mode_artifact_path`, `mode_field_id` i `mode_field_resource_key` powinny być
`Option`. Writer/API nie może deklarować field ref dla mode, którego Cartesian
complex XYZ payload nie został zweryfikowany. Mode bez pola jest
`spectrum-only`, nie błędem całego datasetu.

## 3.2. Walidacja server-side

Przed zwróceniem `ready` API sprawdza:

1. `schema_version == eigen/field_sweep.v1`;
2. root digest ma canonical format i zgadza się z bajtami artefaktu;
3. source spectrum i branches refs istnieją oraz mają zgodne digests;
4. unikalność `sample_id`;
5. unikalność `mode_id` w sample;
6. `mode.sample_id == sample.sample_id`;
7. skończone axis values, frequency i residual;
8. `completed_sample_count <= requested_sample_count`;
9. `complete=true` wyłącznie dla pełnego zakresu;
10. mode field ref istnieje tylko przy legalnym mode bundle;
11. topology identity jest kompletne dla field-bearing sample;
12. branch ID należy do opublikowanego branches artifact;
13. source revision każdego mode jest zgodne ze spectrum;
14. status sample/mode nie jest sprzeczny z root status.

Błąd digest/join daje `corrupt` albo `409 result_artifact_revision_conflict`, a
nie częściowo sparsowany payload przedstawiony jako ready.

## 3.3. Test writer -> API -> generated TS

Fixture ma pochodzić z serializacji rzeczywistego typu writera:

```rust
#[test]
fn field_sweep_writer_fixture_round_trips_through_api_schema() {
    let artifact = build_test_field_sweep_artifact();
    let bytes = serde_json::to_vec(&artifact).unwrap();
    let payload: FrequencyDomainFieldSweepArtifactPayload =
        serde_json::from_slice(&bytes).unwrap();

    assert_eq!(payload.samples.len(), 15);
    assert_eq!(payload.samples[7].modes[0].sample_id,
               payload.samples[7].sample_id);
    assert!(payload.scan_axis.display_conversions
        .iter().any(|conversion| conversion.name == "mu0_H"));
}
```

Nie wolno utrzymywać oddzielnego ręcznego fixture API, który omija pola writera.

## 3.4. OpenAPI i frontend

Po zmianie Rust:

```bash
pnpm --dir apps/control-room run generate:api
```

Następnie:

- generated JSON zawiera wszystkie typed fields;
- generated TS nie używa `unknown` dla osi/sample/mode;
- `navigatorFieldSweepFromResource()` konsumuje generated union;
- brak parsera `objectRecord(payload.extra)` dla wymaganych pól;
- test source scan odrzuca ad-hoc parser w module.

## 4. Faza B — run-scoped Result Dataset API

## 4.1. Namespace

Rekomendowany namespace:

```text
/v2/sessions/current/analysis/results/runs/{run_id}
```

Nie należy tworzyć globalnego `/analysis/results/latest`. Current run jest
wyborem UI i statusu sesji, nie semantyką zasobu.

## 4.2. Endpointy

### Catalog

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets
```

Query:

```text
stage_id?
product_kind?
status?
cursor?
limit?
```

Response:

```rust
pub struct AnalysisResultDatasetCatalogResource {
    pub schema_version: String,
    pub run_id: String,
    pub revision: String,
    pub items: Vec<AnalysisResultDatasetSummaryResource>,
    pub next_cursor: Option<String>,
    pub total_count: Option<u64>,
}
```

### Manifest

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}
```

Zwraca pełny manifest control-plane bez sample/item arrays.

### Axis values

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/axes/{axis_id}/values
```

Query:

```text
cursor
limit
search
from_si
to_si
```

Dla małej cardinality values mogą być inline w manifeście. Dla dużej są
stronicowane.

### Samples

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/samples
```

Query:

```text
coordinate.<axis_id>=<value_token>
cursor
limit
sort
status
has_fields
```

### Items

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/items
```

Query:

```text
sample_id
coordinate.<axis_id>=<value_token>
item_kind
branch_id
frequency_min_hz
frequency_max_hz
residual_max
has_field
status
sort
cursor
limit
```

### Item detail

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/items/{item_id}
```

Response jest tagged unionem typed detail resources.

### Branches

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/branches
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/branches/{branch_id}
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/branches/{branch_id}/points
```

### Projections

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/projections/{projection_id}
```

Query definiuje axis mapping, fixed coordinates, visible range, resolution i
cursor. Projection response jest bounded i ma jawny selection mapping.

### Relations

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/relations
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/relations/{relation_id}
```

### Result mesh

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/meshes/{mesh_id}/meta
GET /v2/sessions/current/analysis/results/runs/{run_id}/meshes/{mesh_id}/topology
```

Heavy topology używa istniejącego lub kompatybilnego binarnego codec contract.

## 4.3. Dlaczego `run_id` jest w ścieżce

- historyczne wyniki są pierwszorzędne;
- selection nie zależy od zmiennego current run;
- cache key jest jednoznaczny;
- link można odtworzyć;
- obcy run daje 404/409 zamiast cichego podmienienia;
- result field może zostać zweryfikowany względem owner run.

## 5. Adaptery serwerowe

## 5.1. Trait

```rust
pub trait AnalysisResultDatasetAdapter: Send + Sync {
    fn supports(&self, source: &AnalysisArtifactSet) -> bool;

    fn manifest(
        &self,
        context: &AnalysisResultAdapterContext,
    ) -> Result<AnalysisResultDatasetManifestResource, AnalysisResultAdapterError>;

    fn samples(
        &self,
        context: &AnalysisResultAdapterContext,
        query: &AnalysisResultSampleQuery,
    ) -> Result<AnalysisResultSamplePageResource, AnalysisResultAdapterError>;

    fn items(
        &self,
        context: &AnalysisResultAdapterContext,
        query: &AnalysisResultItemQuery,
    ) -> Result<AnalysisResultItemPageResource, AnalysisResultAdapterError>;

    fn projection(
        &self,
        context: &AnalysisResultAdapterContext,
        query: &AnalysisResultProjectionQuery,
    ) -> Result<AnalysisResultProjectionResource, AnalysisResultAdapterError>;
}
```

### Adaptery początkowe

```text
SingleSampleModalEigenAdapter
BiasFieldModalSweepAdapter
ModalDispersionAdapter
DrivenResponseAdapter
TimeDomainSeriesAdapter
TimeDomainSpectrumAdapter
DynamicStructureFactorAdapter
HysteresisAdapter
```

Adapter nie zmienia danych naukowych. Waliduje i mapuje source-native schema na
wspólny indeks.

## 5.2. Adapter context

```rust
pub struct AnalysisResultAdapterContext {
    pub session_id: String,
    pub run_id: String,
    pub stage_id: String,
    pub artifact_root: PathBuf,
    pub artifact_catalog_revision: String,
    pub source_artifacts: Vec<ValidatedArtifactHandle>,
}
```

Każdy adapter otrzymuje wyłącznie zweryfikowane uchwyty. Nie skanuje
arbitralnych ścieżek ani nie używa nazw plików dostarczonych przez klienta.

## 5.3. Dataset ID i revision

Dataset ID jest deterministyczny względem logicznego produktu:

```text
result:<run-id>:<stage-id>:<product-role>
```

Revision jest digestem:

```text
adapter schema version
+ source artifact revisions
+ mapping/qualification metadata
+ projection descriptors
```

Zmiana samej konwersji display units, jeśli jest częścią manifestu, zmienia
revision. Preferencja jednostki użytkownika nie zmienia dataset revision.

## 6. Cursor pagination

## 6.1. Dlaczego cursor, nie `page=17`

Datasety mogą publikować partial results podczas działania. Offset pagination
może duplikować lub pomijać rekordy przy zmianie zbioru. Cursor wiąże:

- dataset revision;
- query/filter digest;
- sort order;
- ostatni stable key.

## 6.2. Opaque cursor

```rust
struct AnalysisResultPageCursorV1 {
    schema: u8,
    dataset_revision: String,
    query_digest: String,
    sort_key: String,
    last_stable_id: String,
}
```

Cursor jest podpisany lub MAC-owany po stronie serwera i zakodowany base64url.
Klient nie interpretuje zawartości.

## 6.3. Limity

Rekomendowane początkowe ograniczenia:

```text
default sample page: 100
max sample page: 500
default item page: 100
max item page: 500
max inline axis values: 256
max coordinate filters: 16
max sort keys: 3
max search length: 128
max projection points JSON: 10000
larger projections: binary/tiled/paged
```

Limity są capability/contract metadata i mają testy. UI nie implementuje
`slice(0, 500)` jako ukrytego substytutu.

## 6.4. Stale cursor

Gdy dataset revision zmieniła się:

```http
409 Conflict
Content-Type: application/problem+json
```

```json
{
  "code": "RESULT_PAGE_CURSOR_STALE",
  "expected_revision": "sha256:new",
  "cursor_revision": "sha256:old",
  "restart_resource_key": ".../items?..."
}
```

Resource hook zachowuje poprzednią stronę jako stale, rozpoczyna query od
początku lub od stable selection locator, a UI nie łączy stron z różnych
rewizji.

## 7. Query identity i filtry

## 7.1. Typed frontend query

```typescript
export interface AnalysisResultItemsQuery {
  runId: string;
  datasetId: string;
  datasetRevision: string;
  sampleId?: string;
  coordinates?: readonly AnalysisResultCoordinateRef[];
  itemKinds?: readonly AnalysisResultItemKind[];
  branchId?: string;
  frequencyRangeHz?: readonly [number, number];
  residualMax?: number;
  hasField?: boolean;
  completeness?: readonly AnalysisArtifactCompleteness[];
  sort: readonly AnalysisResultSortKey[];
  cursor?: string;
  limit: number;
}
```

### Canonical cache key

```typescript
export function analysisResultItemsResourceKey(
  query: AnalysisResultItemsQuery,
): string {
  return canonicalResourceKey("analysis-result-items", {
    ...query,
    coordinates: canonicalizeCoordinates(query.coordinates ?? []),
    itemKinds: [...(query.itemKinds ?? [])].sort(),
    completeness: [...(query.completeness ?? [])].sort(),
  });
}
```

Nie używamy inline `JSON.stringify` w komponencie.

## 7.2. Serwerowa walidacja filtrów

- axis ID musi istnieć;
- token musi należeć do osi;
- frequency range jest skończone i uporządkowane;
- residual nie może być ujemny;
- sort key musi należeć do dataset capability;
- branch filter wymaga branch tracking capability;
- field filter jest legalny tylko dla datasetu z field capability;
- nieznany filtr daje 422, nie jest ignorowany.

## 8. Projection resources

## 8.1. Wspólna koperta

```rust
pub struct AnalysisResultProjectionResource {
    pub schema_version: String,
    pub run_id: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub projection_id: String,
    pub projection_revision: String,
    pub axis_mapping: AnalysisResultAxisMapping,
    pub fixed_coordinates: Vec<AnalysisResultCoordinateResource>,
    pub series: Vec<AnalysisResultProjectionSeries>,
    pub selection_index: Vec<AnalysisResultProjectionSelectionEntry>,
    pub bounds: AnalysisResultProjectionBounds,
    pub status: AnalysisResultStatusFacets,
}
```

### Selection index

Każdy point/cell, który jest wybieralny, ma compact mapping:

```rust
pub struct AnalysisResultProjectionSelectionEntry {
    pub ordinal: u64,
    pub sample_id: Option<String>,
    pub item_id: Option<String>,
    pub branch_id: Option<String>,
}
```

Dla dużych heatmap selection index może być regularnym mapping descriptor
zamiast listy per-cell.

## 8.2. JSON kontra binary

JSON:

- małe spectrum;
- branch summaries;
- bounded points;
- metadata i selection index.

Binary/tiled:

- duże `(outer, frequency)` maps;
- DSF grids;
- wielowymiarowe response maps;
- duże profile/cuts;
- dense comparison tensors.

Format data-plane zawiera:

- dataset/projection revision;
- shape;
- dtype;
- axis IDs i units;
- indexing/order;
- missing mask;
- optional selection mapping descriptor;
- content digest.

## 9. Fields i heavy data-plane

## 9.1. Field metadata

Generic result API zwraca field refs, ale heavy field pozostaje w data plane.
Metadata endpoint może użyć wspólnej trasy:

```http
GET /v2/sessions/current/analysis/results/runs/{run_id}/datasets/{dataset_id}/fields/{field_id}/meta
```

albo delegować do istniejącego named field resource, jeśli koperta zawiera pełne
owner identity.

### Wymagane metadata

```text
run_id
stage_id
dataset_id
dataset_revision
sample_id
item_id
item_revision
field_id
field_revision
quantity
value_kind
representation
component_basis
component_count
components
available_views
default_view
payload encoding/layout
mesh_ref
point_count
content_digest
```

## 9.2. Binary response

Header musi zawierać co najmniej:

```text
field revision
domain generation / mesh ID
topology fingerprint/revision
point count
component count
dtype
indexing
quantity ID
representation
```

Frontend porównuje header z metadata oraz aktywnym result mesh. Serwer nie
podpisuje starego payloadu nowym mesh revision.

## 10. Result mesh API

### Shared topology

Dla field sweepu z tą samą geometrią manifest może publikować:

```text
topology_policy = shared_across_dataset
```

Jedna topologia jest cache'owana przez wszystkie sample.

### Per-sample topology

Dla geometry sweep:

```text
topology_policy = per_sample
```

Sample summary zawiera `mesh_ref`. Pole bez result mesh endpointu ma status
`spectrum-only` lub visualization unsupported.

### Mesh lease

Resource cache klucz:

```text
runId + meshId + meshRevision + topologyFingerprint
```

Nie:

```text
current mesh revision
```

## 11. Error contract

### 404

```text
RESULT_RUN_NOT_FOUND
RESULT_DATASET_NOT_FOUND
RESULT_SAMPLE_NOT_FOUND
RESULT_ITEM_NOT_FOUND
RESULT_FIELD_NOT_FOUND
RESULT_MESH_NOT_FOUND
```

### 409

```text
RESULT_DATASET_REVISION_CONFLICT
RESULT_PAGE_CURSOR_STALE
RESULT_SOURCE_REVISION_CONFLICT
RESULT_FIELD_OWNER_MISMATCH
RESULT_FIELD_MESH_MISMATCH
RESULT_RELATION_REVISION_CONFLICT
```

### 422

```text
RESULT_INVALID_AXIS_FILTER
RESULT_UNKNOWN_AXIS_VALUE_TOKEN
RESULT_UNSUPPORTED_SORT
RESULT_INVALID_RANGE
RESULT_PROJECTION_AXIS_MAPPING_INVALID
RESULT_BRANCH_FILTER_UNSUPPORTED
```

### 500 / corrupt source

Server-side artifact corruption zwraca problem z publicznym reason code i
bounded detail. Nie ujawnia arbitralnej ścieżki hosta.

## 12. ControlRoomApi facade

```typescript
export class ControlRoomApi {
  readonly analysis = {
    results: {
      datasets: (runId: string, query: ResultDatasetCatalogQuery, options?: RequestOptions) =>
        this.requestJson<AnalysisResultDatasetCatalogResource>(
          buildGeneratedPath(/* generated route */),
          options,
        ),
      manifest: (runId: string, datasetId: string, options?: RequestOptions) =>
        /* generated transport */,
      axisValues: (query: AnalysisResultAxisValuesQuery, options?: RequestOptions) =>
        /* generated transport */,
      samples: (query: AnalysisResultSamplesQuery, options?: RequestOptions) =>
        /* generated transport */,
      items: (query: AnalysisResultItemsQuery, options?: RequestOptions) =>
        /* generated transport */,
      item: (query: AnalysisResultItemQuery, options?: RequestOptions) =>
        /* generated transport */,
      projection: (query: AnalysisResultProjectionQuery, options?: RequestOptions) =>
        /* generated transport */,
      relation: (query: AnalysisResultRelationQuery, options?: RequestOptions) =>
        /* generated transport */,
    },
  };
}
```

Powyższy pseudokod nie zezwala na ręczne URL strings w module. Konkretna
implementacja korzysta z generated paths/client.

## 13. Resource hooks

Docelowy plik:

```text
apps/control-room/src/kernel/resources/analysisResultResources.ts
```

### Manifest hook

```typescript
export function useAnalysisResultDatasetManifestResource(
  identity: AnalysisResultDatasetIdentity | null,
  options: RuntimeResourceOptions = {},
) {
  const { api } = useKernel();
  const resourceKey = identity
    ? analysisResultDatasetManifestKey(identity)
    : analysisResultDisabledKey("manifest");

  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      identity
        ? api.analysis.results.manifest(identity.runId, identity.datasetId, { signal })
        : Promise.resolve(null),
    [api, identity],
  );

  return useResource({
    enabled: options.enabled !== false && identity !== null,
    load,
    resolveRevision: (data) => data?.dataset_revision ?? null,
    resourceKey,
  });
}
```

### Page hook

```typescript
export function useAnalysisResultItemsPageResource(
  query: AnalysisResultItemsQuery | null,
  options: RuntimeResourceOptions = {},
) {
  // query jest wcześniej canonicalized i immutable
  // stale page może pozostać widoczna, ale nie jest łączona z nową revision
}
```

### Zasady hooków

- enabled tylko przy wymaganej identity;
- abort przy zmianie query/unmount;
- exact resource key z revision selectors;
- no fetch-on-render loop;
- last-valid retention jawnie oznaczone stale;
- unrelated invalidation nie powoduje refetch;
- field hook nie aktywuje się podczas samej zmiany display units;
- pages należą do resource cache, nie Zustand.

## 14. Realtime invalidation

Zdarzenie pozostaje małe:

```json
{
  "resource_key": "analysis/results/runs/run-17/datasets/result-1/items",
  "revision": "sha256:...",
  "recommended_fetch": "..."
}
```

Realtime nie przenosi:

- manifestu;
- stron itemów;
- projection points;
- FFT arrays;
- field payloads;
- topologii.

### Partial publication

Dla działającego sweepu:

1. writer atomowo publikuje nową partial artifact revision;
2. adapter buduje nową dataset revision;
3. event invaliduje catalog/manifest/affected pages;
4. UI zachowuje ostatni snapshot jako stale;
5. nowy cursor jest uzgadniany po stable IDs;
6. nieistniejący item staje się unavailable, nie jest zastąpiony po indeksie.

## 15. Cache i wydajność

### Control-plane

Cache może przechowywać:

- catalog pages;
- manifesty;
- axis pages;
- sample pages;
- item pages;
- małe projections;
- item details;
- relation details.

### Heavy data

Leases:

- result mesh topology;
- field buffer;
- large projection tile;
- DSF tile;
- response map tile.

Domyślna strategia Results:

- aktywna strona;
- poprzednia i następna strona mogą być prefetched dopiero po idle i tylko dla
  control-plane;
- field nie jest prefetched;
- result mesh jest pobierany dopiero dla explicit spatial visualization;
- zmiana unit/filter UI nie pobiera payloadu, gdy cache wystarcza.

## 16. Security i bounds

- wszystkie IDs mają maksymalne długości;
- path IDs są percent-decoded dokładnie raz i walidowane;
- cursor jest opaque i podpisany;
- klient nie podaje filesystem path;
- artifact path resolution pozostaje wewnątrz zatwierdzonego run root;
- search/filter są bounded;
- JSON projection ma limit punktów;
- binary payload ma deklarowany max bytes i shape validation;
- decompression ma output limit;
- cancellation jest obsługiwana;
- nie ma wildcard artifact download przez result API.

## 17. Compatibility

### Existing frequency-domain endpoints

Pozostają aktywne do parity:

- spectrum;
- branches;
- dispersion;
- field sweep;
- mode detail/field metadata;
- response sweep/point/field metadata;
- FMR fits.

Generic adapter może początkowo konsumować te same validated artifacts.
Frontend migracyjny nie powinien pobierać równolegle starej i nowej rodziny dla
tego samego widoku poza testem parity.

### Legacy time-domain endpoints

`spin_wave_response.gamma.v1` i `dynamic_structure_factor.1d.v1` są mapowane
przez bounded adapter z qualification `legacy/partial`. Nowe runy po wdrożeniu
kanonicznych time-domain contracts publikują pełne datasets.

## 18. Kolejność zmian API

1. test fixture writer/API drift;
2. pełny typed field sweep schema;
3. regenerate OpenAPI;
4. frontend field-sweep adapter i pionowy UI;
5. ADR Result Dataset API;
6. catalog + manifest;
7. samples/items paging;
8. projections;
9. relations;
10. result mesh;
11. time-domain adapters;
12. compatibility telemetry i cleanup.

## 19. Kryteria akceptacji API

- pełny 15-punktowy artifact przechodzi writer -> API -> generated TS bez utraty
  pól;
- UI nie parsuje `extra`;
- mode field refs są opcjonalne i prawdziwe;
- dataset catalog jest run-scoped;
- manifest nie zawiera ciężkich arrays;
- sample/item pages mają opaque cursor i revision binding;
- filtry i sortowanie są typed oraz walidowane;
- stale cursor daje 409 z restart hint;
- projection point mapuje do stable sample/item;
- geometry sample publikuje result mesh ref albo spatial unsupported;
- field metadata niesie pełną owner identity;
- realtime tylko invaliduje;
- resource hooks reagują tylko na właściwe revisions;
- żadna ścieżka modułu nie składa URL ani nie wywołuje `fetch()`.
