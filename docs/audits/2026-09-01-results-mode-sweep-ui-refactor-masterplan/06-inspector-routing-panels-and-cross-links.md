# 06 — Inspector: routing, panele, akcje i referencje

## 1. Cel

Inspector ma prezentować szczegóły aktualnego fokusu bez duplikowania
właścicielstwa danych. Obecny katalog tras zawiera dużą liczbę stringowych
`selectionKinds` oraz wiele częściowo nakładających się paneli frequency-domain
i physics-first. Refaktor wprowadza jeden typed route dla `analysis-result`, a
specjalistyczne panele są wybierane przez pola `focus` i `itemKind`.

## 2. Zasady

1. Globalna `SelectionController` pozostaje właścicielem fokusu.
2. Selection typu `analysis-result` niesie pełną małą identity, nie payload.
3. Inspector pobiera dane wyłącznie przez resource hooks.
4. Każdy panel ma osobny status transportu, kompletności i kwalifikacji.
5. Akcje wykonują commands; panel nie importuje Results/Analysis/viewport store.
6. Breadcrumb i cross-links są budowane ze zweryfikowanych refs.
7. Background invalidation zachowuje last-valid panel, fokus i scroll.
8. Zmiana result cursor nie może pozostawić panelu z detalem starego itemu.
9. Pole `spectrum-only` jest normalnym stanem itemu i nie pokazuje fałszywego
   przycisku renderowania.
10. Brak danych nie jest zastępowany zerem, etykietą guessed ani fallbackiem do
    aktualnego runu.

## 3. Docelowy katalog

```text
modules/inspector/panels/analysis-results/
  AnalysisResultInspectorRouter.tsx
  AnalysisResultInspectorHeader.tsx
  ResultBreadcrumb.tsx
  ResultIdentityGroup.tsx
  ResultStatusGroup.tsx
  ResultCoordinatesGroup.tsx
  ResultProvenanceGroup.tsx
  ResultCrossLinksGroup.tsx
  ResultDatasetInspectorPanel.tsx
  ResultSliceInspectorPanel.tsx
  ResultItemInspectorRouter.tsx
  EigenModeResultInspectorPanel.tsx
  DrivenPointResultInspectorPanel.tsx
  SpectralFeatureResultInspectorPanel.tsx
  DsfPointResultInspectorPanel.tsx
  BranchResultInspectorPanel.tsx
  ResonanceFitResultInspectorPanel.tsx
  HysteresisPointResultInspectorPanel.tsx
  ResultFieldInspectorPanel.tsx
  ResultRelationInspectorPanel.tsx
  ResultSourceInspectorPanel.tsx
  resultInspectorModels.ts
  resultInspectorCommands.ts
```

Wspólne primitive pozostają w obecnym katalogu Inspectora.

## 4. Routing

## 4.1. Jeden selection kind na granicy katalogu

```typescript
const ANALYSIS_RESULT_ROUTE: InspectorRoute = {
  id: "analysis-result" as InspectorRouteId,
  title: "Analysis Result",
  selectionKinds: [
    "analysis.result.dataset",
    "analysis.result.slice",
    "analysis.result.item",
    "analysis.result.branch",
    "analysis.result.field",
    "analysis.result.relation",
    "analysis.result.source",
  ],
  component: AnalysisResultInspectorRouter,
  contribution: {
    id: "analysis-result",
    order: 200,
    component: AnalysisResultInspectorRouter,
  },
};
```

Nie należy dopisywać kolejnych kilkudziesięciu globalnych stringów dla każdego
produktu. Rozróżnienie odbywa się wewnątrz typed ref.

## 4.2. Typed router

```tsx
export function AnalysisResultInspectorRouter({ selection }: InspectorPanelProps) {
  const ref = analysisResultSelectionRef(selection.ref);
  if (!ref) return <InvalidResultSelectionPanel selection={selection} />;

  switch (ref.focus) {
    case "dataset":
      return <ResultDatasetInspectorPanel resultRef={ref} />;
    case "slice":
      return <ResultSliceInspectorPanel resultRef={ref} />;
    case "branch":
      return <BranchResultInspectorPanel resultRef={ref} />;
    case "field":
      return <ResultFieldInspectorPanel resultRef={ref} />;
    case "relation":
      return <ResultRelationInspectorPanel resultRef={ref} />;
    case "source":
      return <ResultSourceInspectorPanel resultRef={ref} />;
    case "item":
      return <ResultItemInspectorRouter resultRef={ref} />;
  }
}
```

### Item router

```tsx
export function ResultItemInspectorRouter({ resultRef }: Props) {
  switch (resultRef.itemKind) {
    case "eigen_mode":
      return <EigenModeResultInspectorPanel resultRef={resultRef} />;
    case "response_point":
      return <DrivenPointResultInspectorPanel resultRef={resultRef} />;
    case "spectral_feature":
      return <SpectralFeatureResultInspectorPanel resultRef={resultRef} />;
    case "dsf_point":
      return <DsfPointResultInspectorPanel resultRef={resultRef} />;
    case "resonance_fit":
      return <ResonanceFitResultInspectorPanel resultRef={resultRef} />;
    case "hysteresis_point":
      return <HysteresisPointResultInspectorPanel resultRef={resultRef} />;
    default:
      return <UnsupportedResultItemPanel resultRef={resultRef} />;
  }
}
```

Router nie używa `kind.startsWith(...)` ani nazw field ID do inferencji.

## 5. Wspólny nagłówek

```text
[icon] Eigen mode
Run antidot-field-sweep / K0 eigen / Modal field sweep / μ0Hx=75mT / B1
complete · unvalidated · FEM CPU · float64
```

### Elementy

- semantyczny typ fokusu;
- breadcrumb;
- completeness badge;
- qualification badge;
- source lane/device/precision summary;
- stale/foreign notice;
- menu actions.

Breadcrumb segmenty są przyciskami command registry:

```text
Run          -> Results context
Stage        -> Results stage group / Job stage
Dataset      -> Result dataset focus
Coordinate   -> Result slice focus
Item         -> current item
```

## 6. Wspólne grupy

## 6.1. Identity

```text
Run ID
Stage ID
Dataset ID
Dataset revision
Sample ID / revision
Item ID / revision
Branch ID / revision
Field ID / revision
Projection ID / revision
```

IDs mogą być skrócone wizualnie, ale copy action kopiuje pełną wartość.

## 6.2. Coordinates

Dla każdej osi:

```text
label i symbol
canonical SI value/unit
aktualna display value/unit
axis value token
role
entity reference, jeśli dotyczy
```

Przykład:

```text
Bias field H        [59683.1037, 0, 0] A/m
Displayed μ0Hx      75.0 mT
Wavevector          Γ · [0,0,0] rad/m
Geometry            antidot diameter 160 nm
```

Finite-open pokazuje `Finite system · k n/a`, nie zerowy wektor.

## 6.3. Status

```text
Resource lifecycle
Execution
Artifact completeness
Qualification
Validation scope
Reason code / detail
Last valid revision
Current requested revision
```

## 6.4. Provenance

```text
requested backend/device/precision
resolved backend/device/precision
engine/solver/operator
mesh/result mesh identity
source artifact refs i revisions
equilibrium identity
linearization/operator signature
phase/Floquet convention
normalization
publication/adapter schema version
```

## 6.5. Cross-links

Lista wyłącznie legalnych relacji:

```text
Open source stage
Open owning dataset
Reveal source artifact
Reveal result mesh
Open in Analysis
Open branch
Open related modal/driven item
Open qualification evidence
Open diagnostics
Copy deep link
```

## 7. ResultDatasetInspectorPanel

### Zawartość

#### Overview

```text
Title / description
Product kind
Run / stage
Dataset revision
Requested/completed sample count
Item count
Field count
Source artifacts
Default projection
```

#### Axes

Tabela:

```text
Axis | role | semantic ID | kind | cardinality | SI unit | display options
```

#### Capabilities

```text
sample paging
item paging
server filters/sort
branch tracking
fields
result meshes
comparison
export
partial live publication
```

#### Status

Oddzielne status facets.

#### Actions

```text
Open in Analysis
Select default slice
Compare as primary
Export dataset
Reveal source artifacts
Open contract diagnostics
```

### Hook

```typescript
const manifest = useAnalysisResultDatasetManifestResource(
  datasetIdentityFromRef(resultRef),
);
```

Panel nie ładuje item pages.

## 8. ResultSliceInspectorPanel

### Zawartość

```text
Sample ID / revision
Sample presentation index
All coordinate values
Item count / field count
Sample completeness
Equilibrium/source signatures
Result mesh ref
Branch availability
```

### Actions

```text
Previous / next coordinate
Open spectrum at this slice
Open map with selected axis
Reveal result mesh
Compare same slice
Export slice
```

Previous/next wykonuje `results.select-slice`, nie lokalną zmianę formularza.

### Topology notice

Dla per-sample geometry:

```text
This sample uses mesh mesh:antidot-d160, topology sha256:...
Current authoring mesh is not used for result visualization.
```

## 9. EigenModeResultInspectorPanel

## 9.1. Summary

```text
Mode ID
Display/raw mode index
Branch ID lub untracked
Frequency
Angular frequency
Imaginary frequency
Decay rate
Linewidth
Q factor
Residual relative L2
Tangent leakage
Dominant polarization
Mode field availability
```

## 9.2. Physics context

```text
finite-open / Gamma / fixed-k / k-path / k-grid
exact k vector
k path coordinate i segment labels
bias/material/geometry/current coordinates
equilibrium identity
operator/normalization/phasor convention
```

## 9.3. Participation

Jeżeli opublikowane:

```text
global x/y/z participation
per-object participation
integration method
quantity i unit
qualification
```

Brak participation ma typed reason, nie pusty wykres.

## 9.4. Field

```text
field ID/revision
representation
component basis/count
available views
default phase
mesh/topology identity
point count
status
```

### Akcje

```text
Plot in 3D
Open in Field Map
Real
Imaginary
Magnitude
Phase
Phase-rotated real
Animate
Follow branch
Open branch
Open spectrum
Compare with driven response
Reveal mode artifact
```

Buttons reuse shared `FrequencyDomainModeDisplayControls` podczas migracji, ale
ich input pochodzi z generic field ref.

## 10. DrivenPointResultInspectorPanel

### Summary

```text
Point ID
Drive frequency
Frequency index jako presentation metadata
Primary observable i unit
Pozostałe observables
Solver residual/convergence
Response field availability
```

### Excitation

```text
drive identity/type
amplitude/polarization
source field basis
phase convention
outer sweep coordinates
```

### Akcje

```text
Plot response field in 3D
Open response field in Field Map
Open response spectrum
Open field-frequency map
Open peak/fit relations
Compare to modal dataset
Reveal source response artifact
```

Panel nie nazywa punktu modem.

## 11. SpectralFeatureResultInspectorPanel

### Summary

```text
Feature ID
Feature kind
Frequency
Bin index
Power / amplitude
Linewidth
Uncertainty
Rank
Detection method i parameters
Source spectrum ID/revision
Response field availability
```

### Sampling and transform

```text
source temporal series
physical-time clock
sample count
dt/cadence
duration
uniformity/resampling proof
window
detrend
normalization
one-/two-sided
frequency resolution
Nyquist
component/probe/region
```

### Relations

`Matched eigen mode` jest osobną grupą:

```text
status: none / candidate / qualified
method
frequency distance
spatial overlap
confidence
source revisions
qualification
```

### Akcje

```text
Open temporal spectrum
Open source time trace
Plot spatial response, jeśli field istnieje
Open matched eigenmode, jeśli relation istnieje
Compare features
Reveal sampling diagnostics
```

Brak matched relation nie jest ostrzeżeniem; jest zwykłym `not published`.

## 12. DsfPointResultInspectorPanel

### Summary

```text
Point ID
k vector i path/grid coordinate
Frequency
Power
Complex value / phase, jeśli opublikowane
Response/source spectrum
Component
```

### Sampling

```text
propagation axis/frame
spatial grid i dx
physical-time grid i dt
spatial/temporal windows
normalization
probe signature
invalid probe mask
excluded absorber ranges
phase convention
```

### Akcje

```text
Open S(k,f)
Open frequency cut at k
Open k cut at f
Plot response field, jeśli opublikowane
Reveal probe/result mesh
```

## 13. BranchResultInspectorPanel

### Summary

```text
Branch ID/revision
Dataset
Path axis
Fixed coordinates
Point count
Gap count
Frequency range
Field coverage
```

### Tracking

```text
tracking method
score definition
overlap/confidence summary
fallback reason
gaps
source branches artifact/revision
qualification
```

### Akcje

```text
Follow branch
Open branch plot
Go to previous/next point
Open selected point
Export branch
Reveal tracking diagnostics
```

`Follow branch` ustawia preserve policy w result cursor/navigation, nie zmienia
raw mode index.

## 14. ResonanceFitResultInspectorPanel

```text
Fit ID/model
source peak/revision
fit range
baseline/weights
peak frequency
linewidth
Q factor
coefficients
covariance status
conditioning
residual
uncertainty
qualification
```

Brak covariance nie jest pokazywany jako statystyczna uncertainty. Status
pozostaje partial zgodnie z contractem.

## 15. ResultFieldInspectorPanel

### Identity

```text
owner dataset/sample/item
field ID/revision
quantity
field kind
representation
component basis/count
encoding/layout
mesh ref
point count
content digest
```

### Render state

```text
active / inactive / loading / stale / foreign / incompatible / error
view
component
phase
animation
color source/range
vectors budget/scale
geometry scope
```

### Actions

```text
Activate
Clear
Rebind, tylko gdy nowy target jest zgodny
Open 3D
Open Field Map
Reveal owner item
Reveal result mesh
Open visualization diagnostics
```

### Fail-closed reasons

```text
field_owner_mismatch
field_revision_mismatch
field_mesh_mismatch
field_point_count_mismatch
field_component_basis_unsupported
field_encoding_unsupported
result_mesh_unavailable
cursor_item_changed
foreign_run
```

## 16. ResultRelationInspectorPanel

Panel jest tagged według relation kind.

### Common

```text
relation ID/revision
source dataset/sample/item
relation kind
target dataset/sample/item
method
source revisions
status/qualification
```

### Actions

```text
Open source
Open target
Open comparison
Reveal relation artifact
```

Relation nie zmienia automatycznie target selection. Użytkownik wybiera akcję.

## 17. ResultSourceInspectorPanel

Pokazuje immutable source artifact ref:

```text
artifact kind/path
revision/content digest
schema version
publisher/runtime
owner run/stage
status
cross refs
```

Akcja `Reveal in Resources` przełącza kartę Resources przez kernel command.

## 18. Commands i cross-links

## 18.1. Komendy Inspectora

```text
analysis-result.open-dataset
analysis-result.open-slice
analysis-result.open-item
analysis-result.open-branch
analysis-result.open-related
analysis-result.open-in-analysis
analysis-result.open-projection
analysis-result.plot-field-3d
analysis-result.open-field-map
analysis-result.clear-field
analysis-result.reveal-source
analysis-result.reveal-result-mesh
analysis-result.open-diagnostics
analysis-result.copy-id
analysis-result.copy-deep-link
analysis-result.export
```

## 18.2. Command input

```typescript
export interface AnalysisResultCommandInput {
  ref: AnalysisResultSelectionRef;
  projectionId?: string;
  fieldView?: AnalysisResultFieldView;
  displayTarget?: "viewport-3d" | "field-map";
}
```

Input jest walidowany względem aktualnej selection i resource revision.

## 18.3. Cross-module boundary

Inspector wykonuje:

```typescript
kernel.commands.execute(
  "analysis-result.open-in-analysis",
  createCommandContext("inspector", kernel, { sourceDetail: "result item" }),
  { ref: resultRef, projectionId },
);
```

Nie importuje:

```text
analysisWorkspaceStore
resultsNavigatorStore
viewport store
field-map store
```

## 19. Resource loading

### Dataset panel

- manifest only.

### Slice panel

- manifest + sample detail.

### Item panel

- manifest summary + item detail;
- field metadata tylko, gdy sekcja Field jest otwarta lub potrzebna do command
  enablement; command enablement może korzystać z field ref summary bez heavy
  metadata.

### Field panel

- field metadata;
- binary payload należy do aktywnego renderer/overlay, nie Inspectora.

### Relation panel

- relation detail po explicit focus.

## 20. Last-valid, focus i invalidation

### Invalidation tej samej identity

- panel zachowuje layout, open groups i scroll;
- pokazuje `refreshing`;
- po sukcesie podmienia snapshot;
- po błędzie zachowuje last-valid jako stale;
- nie remountuje całego Inspectora przez dynamic key oparty o revision.

### Zmiana identity

- anulowane są poprzednie requests;
- focus trafia do nagłówka nowego panelu tylko, jeśli zmiana została wywołana
  klawiaturą/nawigacją wymagającą announce;
- open group preferences mogą być per panel kind, nie per item ID;
- drafty z innego typu nie są przenoszone.

### Usunięty item

Panel pokazuje:

```text
Selected item is not available in dataset revision sha256:new.
Previous item revision: sha256:old.
```

Akcje:

```text
Return to dataset
Locate same stable item in historical snapshot
Open contract diagnostics
```

Nie wybiera najbliższej częstotliwości automatycznie.

## 21. Inspector a result cursor

- Inspector selection może chwilowo być `scene-object`, `resource`, `job` lub
  `diagnostic`, gdy result cursor nadal istnieje;
- powrót do Results/Analysis może ustawić result focus bez ponownego wyboru
  datasetu;
- field overlay może pozostać aktywny przy model focus, o ile cursor nadal jest
  zgodny;
- zmiana cursor dataset/sample/item unieważnia overlay niezależnie od aktualnego
  non-result focus;
- breadcrumb result panel nie jest budowany z `selection.label`.

## 22. Migracja istniejących paneli

### Zachować i uogólnić

- kontrolki phase/view/animation;
- helpers formatujące frequency i units;
- mode summary logic po przeniesieniu do shared result adapters;
- field metadata validation;
- branch diagnostics;
- FMR fits;
- visualization debug.

### Połączyć lub usunąć po parity

- `EigenModeInspectorPanel` i physics-first modal mode panel;
- dwa zestawy overview/spectrum/modes panels;
- specjalny `FrequencyDomainFieldSweepPanel` po przeniesieniu do dataset/slice;
- stringowe result kinds w globalnym route catalog;
- manual `record(...)` parsing wymaganych pól;
- `kind.startsWith("results.eigen")` source inference.

### Compatibility mapping

Stary `frequency-domain` ref jest mapowany do `analysis-result` przed routerem.
Jeśli mapping jest niepełny, Inspector pokazuje bounded compatibility diagnostic,
a nie częściowo działający legacy panel z błędnym field command.

## 23. Testy

### Routing

- każdy `focus` wybiera właściwy panel;
- każdy `itemKind` wybiera właściwy item panel;
- nieznany kind daje unsupported, nie crash;
- invalid ref fail-closed;
- globalny katalog ma jeden analysis-result route.

### Panele

- wszystkie identity fields;
- coordinates i units;
- status facets;
- source revisions;
- field spectrum-only;
- topology mismatch;
- branch gap;
- FFT feature bez mode ID;
- optional matched relation;
- fit bez covariance pozostaje partial.

### Commands

- disabled reasons;
- no cross-module imports;
- Open in Analysis zachowuje cursor;
- Reveal source otwiera Resources;
- Plot field nie działa bez legalnego field ref;
- stale item nie wykonuje command na nowej revision.

### Lifecycle/a11y

- retained stale panel;
- abort on selection change/unmount;
- scroll/open groups preserved on refresh;
- keyboard actions;
- breadcrumb focus;
- 200% zoom;
- status nie tylko kolorem.

## 24. Definition of Done

- jeden typed analysis-result route zastępuje mnożenie globalnych string kinds;
- każdy fokus ma jednoznaczny panel;
- każdy item kind zachowuje własną semantykę;
- Inspector nie posiada server state ani field buffer;
- breadcrumb i cross-links używają typed refs;
- field actions są fail-closed;
- FFT feature nie jest eigenmode;
- finite-open nie jest Gamma;
- branch panel nie używa raw index do trackingu;
- stale/partial/interrupted/corrupt/qualification są jawne;
- invalidation nie niszczy fokusu i scrollu;
- cross-module actions przechodzą przez command registry;
- stare panele mają bounded migration/removal gate.
