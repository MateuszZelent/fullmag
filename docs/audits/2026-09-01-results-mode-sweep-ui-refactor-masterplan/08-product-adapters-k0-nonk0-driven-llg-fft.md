# 08 — Adaptery produktów: K0, non-K0, driven response, LLG i FFT

## 1. Cel

Wspólny model datasetu nie może spłaszczyć fizyki. Ten rozdział definiuje
mapowanie każdego produktu solvera na:

- `product_kind`;
- osie;
- sample;
- item kinds;
- projections;
- fields;
- branches;
- relations;
- status i qualification;
- ograniczenia.

Adapter jest jawny i wersjonowany. Nie rozpoznaje produktu po nazwie katalogu w
komponencie React.

## 2. Macierz produktów

| Produkt źródłowy | Product kind | Główne osie | Item kind | Field kind | Główne projections |
|---|---|---|---|---|---|
| finite-open modal eigen | `modal_eigen` | eigenfrequency; opcjonalne outer sweep | `eigen_mode` | `modal-eigen` | spectrum at slice |
| periodic Gamma modal eigen | `modal_eigen` | eigenfrequency; `k=Gamma` context | `eigen_mode` | `modal-eigen` | spectrum, field sweep |
| fixed nonzero-k modal | `modal_eigen` | fixed `k`, eigenfrequency | `eigen_mode` | `modal-eigen` | spectrum at fixed k |
| k-path modal | `modal_dispersion` | path-s/k vector, frequency | `eigen_mode`, `branch_point`, `branch` | `modal-eigen` | dispersion, branches, cuts |
| k-grid modal | `modal_dispersion` | kx/ky/kz, frequency | `eigen_mode`, optional branch graph | `modal-eigen` | slices/maps |
| driven frequency response | `driven_response` | drive frequency; outer sweep | `response_point` | `driven-response` | response spectrum |
| driven k/f map | `driven_response_map` | k, drive frequency; outer sweep | `response_point` | `driven-response` | A(k,f), cuts |
| LLG time trace | `time_domain_series` | time; probe/component/outer | `time_trace` | optional static/time snapshot | traces |
| temporal FFT | `time_domain_spectrum` | FFT frequency; probe/component/outer | optional bin item | `time-domain-response` | spectrum |
| detected FFT peaks | `spectral_features` | outer/probe/component | `spectral_feature` | `time-domain-response` | feature table/markers |
| dynamic structure factor | `dynamic_structure_factor` | k, frequency; component/outer | `dsf_point` | optional `time-domain-response` | heatmap/cuts |
| hysteresis | `hysteresis` | applied field, branch/orientation | `hysteresis_point` | optional static state | loop/metrics |
| resonance fit | `resonance_fit` | outer sample / fit ID | `resonance_fit` | none | fit overlay/table |
| modal-driven comparison | `modal_driven_comparison` | shared configuration/frequency | `comparison_pair` | optional difference | comparison |

## 3. Wspólne reguły adapterów

### 3.1. Input

Adapter konsumuje wyłącznie validated source artifacts i owner context:

```rust
pub struct ProductAdapterInput {
    pub run_id: String,
    pub stage_id: String,
    pub source_artifacts: Vec<ValidatedArtifactHandle>,
    pub mesh_catalog: ValidatedResultMeshCatalog,
    pub qualification: QualificationSnapshot,
}
```

### 3.2. Output

Adapter produkuje:

```text
manifest
axis value pages lub inline values
sample index
item index/details
projection descriptors/data
field refs
relation refs
status diagnostics
```

### 3.3. Zakazy

Adapter nie może:

- fabrykować wartości pola z konfiguracji oracle;
- traktować missing jako zero;
- tworzyć branch po raw mode index;
- tworzyć field ref bez istniejącego payloadu;
- podpisywać source artifact innym digestem;
- nadawać `production_qualified` bez scope evidence;
- interpretować finite-open jako Gamma;
- traktować FFT peak jako mode;
- używać current model/mesh jako result identity bez exact match.

## 4. Finite-open modal eigen

## 4.1. Semantyka

Układ skończony nie ma Bloch/Floquet wavevector. Dataset context:

```json
{
  "boundary_context": "finite_open",
  "k_context": {"kind": "finite_open"}
}
```

Nie publikuje osi `k` i nie pokazuje `k=0`.

## 4.2. Osie

Minimalnie:

```text
eigenfrequency    spectral, Hz
```

Jeśli solve jest częścią outer sweepu:

```text
bias/material/current/geometry    outer_sweep
```

## 4.3. Sample i items

Pojedynczy solve ma stable technical sample ID:

```text
sample:finite-open:default
```

Items:

```text
item_kind=eigen_mode
item_id=source stable mode_id
metrics=frequency/residual/damping/...
fields=verified mode field refs
```

## 4.4. Projections

- `modal-spectrum-at-slice`;
- opcjonalnie `modal-participation`;
- `modal-table`.

Linie między kolejnymi mode indexes są zabronione.

## 5. Periodic Gamma / K0 modal eigen

## 5.1. Semantyka

Gamma oznacza periodic/Floquet context i dokładnie zerowy vector w tolerancji
kontraktu:

```json
{
  "boundary_context": "floquet_periodic",
  "k_context": {
    "kind": "gamma",
    "vector_rad_per_m": [0.0, 0.0, 0.0]
  }
}
```

Finite-open i Gamma mogą dawać podobne liczby, ale nie są tym samym produktem.

## 5.2. Field sweep K0

Source:

```text
eigen/field_sweep.v1.json
eigen/spectrum.v2.json
eigen/branches.v2.json
mode metadata/payloads
```

### Osie

```text
bias-field        outer_sweep, vector3 A/m
frequency         spectral, scalar Hz
branch            category, opcjonalna projection role
```

### Axis values

Każdy field sample publikuje token:

```text
bias-field-sample-0000
...
bias-field-sample-0014
```

Token może być równy sample ID w pierwszym adapterze, ale kontrakt nie wymaga
tej równości.

### Sample

```rust
sample_id = field_sweep_sample.sample_id
coordinates = [bias-axis-token]
mesh_ref = sample.topology lub shared topology
status = source sample status
```

### Items

Każdy source mode:

```text
item_id = mode_id
item_kind = eigen_mode
branch_ref = branch_id, jeśli istnieje
frequency = frequency_hz
residual = residual_relative_l2
field ref = tylko verified payload
```

### Projections

1. `modal-spectrum-at-field`;
2. `modal-field-sweep-scatter`;
3. `modal-field-sweep-branches`, tylko przy tracking;
4. `modal-field-sweep-table`;
5. `kittel-comparison`, jako oddzielny derived dataset lub relation projection.

### UI

```text
μ0 Hx = 75 mT -> sample -> modes -> selected mode -> field
```

Wartość display pochodzi z typed conversion, nie ręcznego mnożnika w
komponencie.

## 6. Fixed nonzero-k modal eigen

## 6.1. Osie/context

`k` może być:

- częścią sample coordinates;
- stałym contextem całego datasetu, gdy solve dotyczy jednego `k`.

```json
{
  "k_context": {
    "kind": "fixed_k",
    "vector_rad_per_m": [1.2e7, 0.0, 0.0]
  }
}
```

### Field metadata

Wymaga:

```text
wavevectorKf
cell origin
Floquet spatial convention
phasor convention
reference cell topology
```

### Projections

- spectrum at fixed k;
- modal participation;
- field visualization w reference cell z poprawną konwencją.

## 7. K-path modal dispersion

## 7.1. Source

```text
eigen/dispersion.csv + path metadata
eigen/branches.v2.json
spectrum/mode artifacts
```

Docelowo adapter nie parsuje CSV w UI. Serwer waliduje i wystawia typed
projection/pages.

## 7.2. Osie

```text
k-path-s         wavevector, scalar rad/m lub dimensionless path coordinate
k-vector         wavevector, vector3 rad/m
frequency        spectral, Hz
```

`k-path-s` i `k-vector` są skorelowane; sample zawiera oba tokeny/values.

## 7.3. Sample

```text
sample_id = stable k-sample ID
coordinates = path-s token + k-vector token
item_count = modes at k
```

## 7.4. Items

- `eigen_mode` dla modes at k;
- `branch_point` może być projection view tego samego mode z branch relation;
- `branch` jest osobnym item/resource na poziomie datasetu.

## 7.5. Branch tracking

Adapter wymaga:

```text
branch_id
sample_id lub stable sample mapping
mode_id/raw lookup bridge
tracking method
score/overlap/confidence
gaps
source revision
```

Gdy source branches nie ma stable mode IDs, adapter może opublikować partial
branch z reason `legacy_index_bridge`, ale nie może nadać production-qualified.

## 7.6. Projections

- modal dispersion scatter;
- qualified branch lines;
- branch confidence;
- fixed-k spectrum cut;
- fixed-frequency k cut, jeśli data shape na to pozwala.

## 8. K-grid modal

## 8.1. Osie

```text
kx, ky, kz lub vector k       wavevector
frequency                     spectral
outer sweep axes              fixed/slice
```

Grid może być regularny lub listą punktów. Regularność jest metadata, nie
założeniem UI.

## 8.2. Branch semantics

Na k-grid nie zakładamy jednej liniowej branch. Możliwe warianty:

1. brak branch tracking — scatter/modes per k;
2. branches po jawnie wybranych paths;
3. graph tracking z typed edges/confidence;
4. bands/surfaces jako osobny qualified projection.

UI nie sortuje punktów leksykograficznie i nie łączy ich linią.

## 9. Driven frequency response

## 9.1. Source

```text
response/magnetic_response_sweep.v2.json
response point details
response field metadata/payloads
FMR peaks/fits
result manifest / drive metadata
```

## 9.2. Osie

```text
drive-frequency          spectral, Hz
outer sweep axes         bias/material/current/geometry
observable/component     component/category
```

## 9.3. Sample i item

Outer coordinates definiują sample. Frequency point jest item:

```text
sample_id = fixed outer configuration
item_id = stable response point ID
item_kind = response_point
frequency = drive frequency
metrics = response observables, residual
field = optional complex response field
```

Dla prostego sweepu bez outer axes może istnieć jeden sample.

## 9.4. Projections

- response spectrum at slice;
- multi-observable response spectrum;
- outer-axis × frequency heatmap;
- peaks/fits overlay;
- modal-driven comparison przez relation.

## 9.5. FMR naming

Driven result jest `FMR Response Spectrum` tylko, gdy drive i observable
spełniają typed FMR evidence. Inaczej `Harmonic Response Spectrum`.

Eigenfrequency bez RF coupling nie staje się FMR intensity.

## 10. Driven k/f response map

## 10.1. Osie

```text
wavevector k             wavevector
frequency                spectral
outer parameters         outer_sweep
observable               component/category
```

## 10.2. Items

Każda wybieralna komórka/punkt mapuje do stable response point identity albo
regular grid token tuple. Dense map nie musi materializować milionów item
records; selection mapping opisuje deterministyczny locator.

## 10.3. Rozróżnienie source i response

```text
H(k,f) / source spectrum
S_m(k,f) / magnetization response
absorbed power / scalar observable
```

Są osobnymi quantities/series. UI nie podpisuje source heatmap jako response.

## 11. Time-domain series

## 11.1. Zależność od canonical contract

Pełna implementacja zależy od planu time-domain spectral contracts/storage.
Obecny globalny `SpinWaveGammaResource` jest compatibility source, nie docelowym
pełnym datasetem.

## 11.2. Osie

```text
time                   temporal/spatial-like presentation axis, s
probe/region/object    spatial/entity
component              component
outer sweep            outer_sweep
replicate              replicate
```

Dla result-domain katalog osi może rozszerzyć role o `temporal` albo użyć
projection-specific temporal role. Rekomendacja: dodać jawne
`AnalysisResultAxisRole::Temporal`, zamiast przeciążać `spectral` lub `spatial`.
Zmiana wymaga aktualizacji modelu z rozdziału 02 przed schema freeze.

## 11.3. Item

`time_trace` reprezentuje named series/probe/component, nie każdą próbkę czasu.
Punkty czasu pozostają projection data.

## 11.4. Status

Manifest zachowuje:

```text
physical-time clock
sampling cadence
accepted-step kontra output grid
uniformity proof
interpolation/resampling
completeness
source stage
```

## 12. Temporal FFT spectrum

## 12.1. Osie

```text
fft-frequency      spectral, Hz
probe/region       spatial/entity
component          component
outer sweep        outer_sweep
```

## 12.2. Spectrum bins i items

Nie trzeba tworzyć itemu dla każdego binu. Projection zawiera bins. Itemami są:

- explicit spectral features;
- user-created bookmark, jeśli produkt wspiera derived annotations;
- response field-bearing bins, jeśli writer nadaje stable field/bin ID.

## 12.3. Transform provenance

```text
window
detrend
normalization
one-/two-sided
sample count
dt/duration
frequency resolution
Nyquist
uniformity/resampling error
reference equilibrium
source observable/drive
```

## 13. Spectral features / FFT peaks

## 13.1. Item semantics

```text
item_kind=spectral_feature
feature_kind=peak/notch/linewidth candidate/other
```

Stable ID pochodzi z writer/detection artifact. Rank i bin index są
presentation metadata.

## 13.2. Field relation

Feature może mieć:

- direct time-domain response field ref;
- source spectrum relation;
- optional matched eigenmode relation;
- optional fit relation.

Brak direct field ref blokuje spatial visualization, ale nie wybór feature.

## 13.3. Matched eigenmode

Relacja wymaga jawnego produktu matching. Minimalnie:

```text
source feature ID/revision
target eigenmode ID/revision
frequency distance
matching method
confidence
source dataset revisions
qualification
```

Spatial overlap jest wymagane dla claimu modalnego, jeśli kontrakt matching tak
stanowi. Sama najbliższa częstotliwość może być tylko `candidate`.

## 14. Dynamic structure factor

## 14.1. Obecny compatibility source

Obecny artifact zawiera:

- `k_rad_per_m`;
- `frequency_hz`;
- response/source power;
- complex spectra;
- windows;
- probe signature;
- invalid mask;
- excluded absorber ranges.

Jest FEM/P1/tet4/x-axis specific i bounded w API. Adapter oznacza zakres
`legacy_partial` i zachowuje ograniczenia.

## 14.2. Docelowy model

Osie:

```text
k-vector lub path k      wavevector
frequency                spectral
component                component
probe family/plane       spatial/entity
outer sweep              outer_sweep
```

Projections:

- response S(k,f);
- source H(k,f);
- fixed-k frequency cut;
- fixed-frequency k cut;
- optional phase map;
- feature extraction.

## 14.3. Item identity

Dla regularnej grid projection point identity może być:

```text
sample outer coordinates
k value token
frequency value token
quantity/component token
```

`dsf_point` item może być materializowany on-demand przez locator, nie jako pełna
lista.

## 15. Hysteresis

## 15.1. Osie

```text
applied/measurement field       ordered axis, A/m
branch                          category
orientation                     outer/category
minor loop/reversal family      outer/category
```

## 15.2. Items

```text
hysteresis_point
branch
metric/fit jako derived item/dataset
```

## 15.3. Projections

- loop;
- branch lines;
- coercivity/remanence/bias metrics;
- angular family;
- minor-loop family;
- convergence/settle traces jako linked datasets.

Istniejący Hysteresis UI może być migrowany po pionowym frequency-domain
zakresie, bez blokowania pierwszych PR.

## 16. Resonance fits

Fit pozostaje derived dataset/item:

```text
source peak/revision
model
fit range
parameters
covariance/conditioning
residual
uncertainty
status
```

Jeśli covariance nie istnieje, status jest partial. Adapter nie wylicza jej
frontendowo.

## 17. Modal-driven comparison

## 17.1. Wymagane alignment

```text
same physical configuration lub typed coordinate mapping
compatible frequency units
explicit modal/response source revisions
matching policy
optional coupling/overlap
```

## 17.2. Comparison pair

```rust
pub struct ModalDrivenComparisonPair {
    pub pair_id: String,
    pub modal_item_ref: AnalysisResultItemRef,
    pub driven_item_ref: AnalysisResultItemRef,
    pub frequency_delta_hz: f64,
    pub matching_score: Option<f64>,
    pub relation_ref: AnalysisResultRelationRef,
}
```

Nie zakłada jeden-do-jednego przy degeneracji. Jedna grupa może mieć wiele
kandydatów.

## 18. Generic outer sweeps

## 18.1. Pole

```text
semantic ID: field:bias:H
value kind: vector3
unit SI: A/m
projections: component/magnitude/dot
```

## 18.2. Material

Przykłady:

```text
material:film:A_ex          J/m
material:film:M_s           A/m
material:film:alpha         1
material:film:K_u           J/m^3
material:film:D             J/m^2 lub właściwa kontraktowa jednostka modelu
```

Axis metadata zawiera owner entity ref i immutable material snapshot ref.

## 18.3. Current / current density

```text
transport:source:I          A
transport:region:J          A/m^2
```

UI nie zamienia prądu i gęstości prądu. Semantic ID, dimension i unit są jawne.

## 18.4. Geometry

```text
geometry:film:thickness
geometry:antidot:diameter
geometry:waveguide:width
```

Każdy sample publikuje geometry snapshot ref i result mesh ref.

## 18.5. Temperature i stochastic replicate

Jeśli model wspiera:

```text
thermal:temperature       K, outer_sweep
replicate:seed            integer/category, replicate
```

Statystyki po replicates są osobnym projection/derived datasetem z metodą i
uncertainty.

## 19. Multi-axis sweeps

## 19.1. Przykład

```text
A_ex × μ0 Hx × J
```

Dataset:

```json
{
  "axes": [
    {"id": "aex", "role": "outer_sweep"},
    {"id": "bias", "role": "outer_sweep"},
    {"id": "current-density", "role": "outer_sweep"},
    {"id": "frequency", "role": "spectral"}
  ]
}
```

Results fixed slice:

```text
A_ex = 13 pJ/m
μ0 Hx = 75 mT
J = 4e11 A/m^2
```

Analysis może ustawić:

```text
X = bias
series = current density
fixed = A_ex
Y/point = frequency
```

## 19.2. Sparse sweeps

Nie zakładamy pełnego iloczynu kartezjańskiego. Sample index publikuje istniejące
tuple. Brak kombinacji jest missing sample, nie zero response.

## 19.3. Adaptive sweeps

Axis values i sample mogą przyrastać nieregularnie. Cursor pagination i stable
IDs są obowiązkowe. UI może pokazać adaptive provenance/refinement reason.

## 19.4. Branch tracking

Branch jest legalny tylko dla jawnej path:

```text
path axis = bias
fixed A_ex/current
```

Zmiana fixed coordinate wybiera inny branch family/revision.

## 20. Geometry topology i porównania

### Spectrum comparison

Może porównywać różne topologie, jeśli quantities i configuration semantics są
kompatybilne.

### Field comparison

Wymaga:

- tej samej topologii; albo
- opublikowanego transfer/interpolation operatora;
- target mesh identity;
- transfer error/qualification;
- jawnej representation.

Frontend nie interpoluje arbitralnie FEM/FDM pól dla naukowego difference.

## 21. Kwalifikacja per adapter

Adapter manifest publikuje:

```text
adapter_id/version
source schema versions
supported backend/device/precision scope
implementation state
validation state
qualified scope ID
open contract gaps
```

Przykład:

```text
BiasFieldModalSweepAdapter
source-visible / unvalidated
FEM CPU float64 exact K0 with Poisson airbox
```

Nie kwalifikuje automatycznie GPU, fixed-k ani geometry sweeps.

## 22. Mapowanie do UI

| Adapter | Results | Analysis | Inspector | Spatial |
|---|---|---|---|---|
| finite-open modal | sample/modes | eigen spectrum | eigen mode | mode field |
| K0 field sweep | field slice + modes | spectrum/map/branches | sample/mode/branch | mode field |
| fixed-k | k context + modes | spectrum | k/mode | Floquet field |
| k-path | k sample + modes/branch | dispersion/cuts | branch point | mode field |
| driven | outer slice + response points | response spectrum/map | driven point | response field |
| time trace | probe/component | traces | series/sampling | optional snapshot |
| FFT features | feature list | spectrum/markers | feature/match | response field if present |
| DSF | k/f selection | heatmap/cuts | DSF point | optional response field |
| hysteresis | branch/points | loop/metrics | point/branch | optional state |

## 23. Testy adapterów

Dla każdego adaptera:

- positive canonical artifact;
- missing required source;
- wrong source revision;
- duplicate IDs;
- invalid units;
- partial/interrupted/corrupt;
- field ref missing/invalid;
- topology mismatch;
- stable reordering;
- selection locator;
- projection point mapping;
- qualification scope.

Specyficzne:

- finite-open nie publikuje k axis;
- Gamma odrzuca nonzero vector;
- fixed-k wymaga vector;
- k-path branch gaps;
- k-grid bez trackingu nie tworzy lines;
- driven nie jest modal;
- FFT peak nie ma mode ID bez relation;
- DSF response/source quantities są rozdzielone;
- geometry sweep wymaga result mesh dla field;
- sparse multi-axis nie wypełnia braków zerami.

## 24. Definition of Done

- istnieje jawny adapter dla każdego wspieranego produktu;
- product/item kinds pozostają fizycznie poprawne;
- K0, finite-open i non-K0 nie są mieszane;
- field sweep mapuje fizyczne wartości do właściwych sample/modes;
- branch tracking jest oparty na opublikowanym branch ID;
- driven response ma własne response points/fields;
- LLG time series zachowuje sampling provenance;
- FFT features są oddzielne od eigenmodes;
- DSF ma typed k/f selection i source/response split;
- generic sweeps zachowują semantic IDs, units i entity refs;
- geometry sample zachowuje geometry/result mesh identity;
- multi-axis i sparse/adaptive sweeps nie wymagają nowych specjalnych drzew UI;
- qualification jest adapter- i scope-specific;
- każdy adapter ma pozytywne i negatywne testy contract/projection/selection.
