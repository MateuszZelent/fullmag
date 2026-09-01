# 10 — Testy, wydajność, browser proof i Definition of Done

## 1. Cel

Refaktor wyników nie jest ukończony po skompilowaniu TypeScriptu ani po
wyrenderowaniu statycznego mocka. Ten rozdział definiuje pełny system dowodów:

```text
artifact contract
-> API round-trip
-> domain/selection tests
-> component/integration tests
-> performance fixtures
-> browser/WebGL proof
-> physics/runtime qualification
-> release evidence
```

Każdy poziom dowodzi innej własności. Test frontend nie kwalifikuje solvera, a
zgodny solver output nie dowodzi działania UI.

## 2. Poziomy dowodu

| Poziom | Dowodzi | Nie dowodzi |
|---|---|---|
| source review | obecność i spójność implementacji | wykonania |
| unit test | lokalnego kontraktu funkcji/modelu | realnego transportu/renderera |
| API contract test | serializacji, schema i statusów | fizyki solvera |
| integration test | współpracy resource/cursor/selection | native browser/WebGL |
| synthetic browser test | rzeczywistego UI na kontrolowanym fixture | prawdziwego solve |
| real-artifact browser proof | UI na artefakcie solvera | pełnej fizycznej kwalifikacji lane |
| physics validation | zgodności z oracle/convergence/parity | jakości całego UX |
| production qualification | kompletnego, scope-bound release evidence | innych backendów/scope |

Statusy w raporcie:

```text
PASS
FAIL
NOT RUN
NOT MEASURED
NOT APPLICABLE z dozwolonym reason code
```

Brak wyniku nie jest implicit pass.

## 3. Test pyramid

```text
                ┌──────────────────────────────┐
                │ Real runtime + browser proof │
                ├──────────────────────────────┤
                │ Browser synthetic / WebGL    │
                ├──────────────────────────────┤
                │ Module integration           │
                ├──────────────────────────────┤
                │ Resource/cursor/selection     │
                ├──────────────────────────────┤
                │ API + artifact contract      │
                ├──────────────────────────────┤
                │ Pure domain/unit tests       │
                └──────────────────────────────┘
```

Najwięcej testów pozostaje na poziomie pure/domain. Najmniej, ale najbardziej
wartościowych, to real browser proofs.

## 4. Canonical fixtures

## 4.1. Fixture F1 — single finite-open modal

```text
1 sample
8 modes
6 field-ready
2 spectrum-only
no k axis
complete dataset
unvalidated qualification
```

Sprawdza:

- finite-open label;
- brak fałszywego `k=0`;
- mode selection;
- spectrum-only field command disabled;
- item reorder stability.

## 4.2. Fixture F2 — 15-point FEM K0 antidot field sweep

Fixture musi pochodzić z realnego writera albo jego typed test buildera i
zachować pełny schema.

```text
15 bias samples
physical H [A/m] + mu0 H [T]
co najmniej kilka modów per sample
branch tracking z co najmniej jednym gapem
co najmniej jeden spectrum-only mode
shared topology
complete/partial sample mix w negative variant
```

Warianty:

- F2a complete;
- F2b interrupted po 9/15;
- F2c source revision mismatch;
- F2d corrupt duplicate mode ID;
- F2e field topology mismatch;
- F2f branch gap/crossing;
- F2g sample reorder z identycznymi IDs.

## 4.3. Fixture F3 — fixed nonzero-k

```text
1 fixed k vector
Floquet convention
complex XYZ field
mode metadata
```

Negative:

- zero vector opisany jako fixed-k;
- brak wavevector;
- wrong Floquet convention;
- field bez cell origin, jeśli wymagane.

## 4.4. Fixture F4 — k-path dispersion

```text
64 k samples
12 branches
branch crossings
3 gaps
tracking confidence
mode fields tylko dla wybranych punktów
```

Sprawdza branch line/gaps, point identity i follow branch.

## 4.5. Fixture F5 — driven outer field × frequency

```text
15 field samples
201 frequency points per sample
absorbed power + susceptibility + amplitude
response fields dla 10 wybranych punktów
peaks i fits
```

Negative:

- observable unit missing;
- point ID duplicate;
- response field z innym sample;
- modal/driven relation revision mismatch.

## 4.6. Fixture F6 — LLG temporal spectrum

```text
uniform physical time grid
mx/my/mz lub selected transverse components
drive trace
FFT spectrum
spectral features
optional response field
sampling/transform provenance
```

Negative:

- nonuniform accepted steps bez resampling proof;
- incomplete time series;
- Nyquist violation;
- unknown window;
- feature bez stable ID;
- peak ręcznie oznaczony jako eigenmode.

## 4.7. Fixture F7 — DSF

```text
k × frequency grid
response and source quantities
invalid probe mask
absorber exclusions
spatial/temporal windows
selection mapping
tiled large variant
```

Negative:

- inconsistent shape;
- source/response arrays swapped;
- missing units;
- cell mapping poza grid;
- result field bez ref.

## 4.8. Fixture F8 — geometry sweep

```text
3 antidot diameters
3 geometry snapshot IDs
3 result mesh refs
fields per topology
```

Negative:

- sample B field z mesh A;
- ten sam point count, różny fingerprint;
- brak result mesh endpoint;
- comparison difference bez transfer operatora.

## 4.9. Fixture F9 — scale fixture 10k × 100

```text
10,000 samples
100 items per sample
1,000,000 logicznych itemów
stronicowane axis/sample/item resources
bez field payloads w podstawowym fixture
```

Fixture nie może być materializowany w całości po stronie przeglądarki. Server
stub/generator generuje strony deterministycznie z cursoru.

## 4.10. Fixture F10 — sparse multi-axis

```text
A_ex × bias × current density
niepełny iloczyn kartezjański
adaptive refinement
branch family po bias przy fixed A_ex/current
```

Sprawdza brak zer zastępczych i legalny axis mapping.

## 5. Testy artefaktów i API

## 5.1. Writer/API round-trip

Dla każdego source artifact:

```text
Rust writer type
-> JSON bytes
-> API typed deserialization
-> validation
-> OpenAPI schema
-> generated TypeScript
```

Testy:

- required fields preserved;
- canonical digest;
- cross-artifact refs;
- stable IDs;
- units;
- requested/resolved execution;
- topology;
- complete/partial/interrupted/corrupt;
- field refs optional i verified.

## 5.2. Result adapter tests

- supports/does-not-support source set;
- deterministic dataset ID/revision;
- axis semantics i values;
- sample mapping;
- item mapping;
- branch mapping;
- field/mesh refs;
- projection descriptor i selection index;
- relation mapping;
- qualification scope;
- bounded error detail.

## 5.3. Pagination

- first/next/previous cursor;
- stable ordering;
- query digest binding;
- dataset revision binding;
- stale cursor 409;
- max limit enforcement;
- unknown token/filter 422;
- sparse coordinates;
- partial publication between pages;
- item locator returns page cursor;
- cursor tampering rejected.

## 5.4. API route security

- invalid IDs/percent encoding;
- path traversal rejected;
- artifact path not client-controlled;
- oversized search/filter rejected;
- binary output bounds;
- decompression bounds;
- cancellation;
- no arbitrary file download.

## 6. Pure frontend domain tests

## 6.1. Identity

- coordinate key stable independent of input order;
- display units/labels do not change identity;
- float values are not keys;
- dataset/item/field revisions participate correctly;
- DOM node ID może pozostać stabilne across revision;
- legacy ref requires complete mapping.

## 6.2. Cursor transitions

- no cursor -> dataset default;
- dataset -> slice;
- slice -> item;
- item -> branch preserve next slice;
- branch gap -> item null;
- different sample item rejected;
- different revision rejected;
- selecting non-result focus leaves cursor;
- clear reasons;
- one notification per transaction.

## 6.3. Selection equality

- equality ignores labels/indexes;
- field focus includes field revision;
- relation focus includes relation revision;
- selection/cursor invariant;
- historical revision remains distinct.

## 6.4. Axis mapping

- line projection requires X;
- heatmap requires X/Y;
- outer axes not mapped must be fixed;
- dimension-compatible display unit;
- vector projection legal/illegal;
- sparse axis support;
- mapping preference migration;
- no request for invalid mapping.

## 6.5. Product semantics

- finite-open != Gamma;
- fixed-k requires nonzero vector;
- k-path branch gaps;
- k-grid without tracking has scatter only;
- driven item != mode;
- spectral feature != mode;
- DSF source != response;
- geometry field requires matching mesh.

## 7. Resource hook tests

Każdy hook sprawdza:

```text
enabled gating
canonical resource key
revision selector
abort
stale retention
error mapping
unrelated invalidation ignored
relevant invalidation exactly one refetch
no update after unmount
```

### Szczególne budgets

- inactive Results: zero catalog/page requests;
- inactive Analysis: zero projection requests;
- item hover/focus: zero field requests;
- display unit/range/legend: zero requests, jeśli data cached;
- sample switch: zero topology request przy shared topology;
- geometry sample switch: topology request tylko przy cache miss;
- field request tylko po explicit action.

## 8. Panel-left i Results component tests

## 8.1. Kernel host

- pięć contributions w prawidłowej kolejności;
- dokładnie jeden owner per tab;
- ribbon i left tab niezależne;
- persistence v2/v3 migration;
- active module mount;
- inactive owner unmount/cleanup;
- same-owner tab change bez duplicate subscriptions;
- unavailable contribution reason.

## 8.2. Dataset tree

- groups i datasets z catalogu;
- zero sample/item children;
- status badges;
- context menu/commands;
- expand/focus restoration;
- stale refresh;
- history/current run;
- search bounded.

## 8.3. Slice controls

- 15 fizycznych values i poprawne units;
- vector projection component/magnitude;
- previous/next;
- searchable large axis;
- keyboard;
- request race cancellation;
- token, nie float, w query;
- missing combination;
- branch preserve/gap.

## 8.4. Item list

- rows per item kind;
- selected/focused distinction;
- virtual range;
- page boundary prefetch;
- stale page replacement;
- no field preload;
- field ready/spectrum-only status;
- partial/corrupt rows;
- responsive stacked layout;
- locator/reveal exact item.

## 9. Analysis tests

## 9.1. Routing

- product/projection -> legal surface/subview;
- unsupported projection reason;
- user preference validated against manifest;
- no independent primary dataset;
- old preference migration bounded;
- surface mismatch zero requests.

## 9.2. Projection models

- spectrum points stable identity;
- branch gaps produce line breaks;
- no lines by raw mode index;
- heatmap missing mask;
- response/source quantities separated;
- DSF cuts map to same cells;
- spectral feature markers;
- comparison alignment.

## 9.3. Selection round-trip

```text
Results item -> chart highlight
chart point -> exact Results item
Inspector open projection -> same cursor
branch series -> branch focus
branch point -> sample/item focus
heatmap cell -> DSF/response item
```

## 9.4. ECharts lifecycle

- one instance per mounted surface/pane;
- `setOption` only for relevant model/display changes;
- ResizeObserver cleanup;
- no interval;
- dispose on unmount;
- object URL cleanup;
- reduced motion;
- no renderer for empty selection.

## 10. Inspector tests

- typed route dispatch;
- common identity/status/coordinates/provenance;
- dataset panel axes/capabilities;
- slice panel mesh/provenance;
- eigen metrics/field availability;
- response observables;
- FFT sampling/feature/match relation;
- DSF windows/mask;
- branch gaps/tracking;
- fit covariance partial;
- field mismatch reasons;
- cross-link commands;
- stale retained state;
- no data copied to store;
- 200% zoom and keyboard actions.

## 11. Field overlay tests

## 11.1. Intent and compatibility

- all required owner IDs/revisions;
- cursor dataset/sample/item match;
- foreign run;
- dataset revision change;
- same branch/different item still invalidates;
- non-result focus leaves compatible overlay;
- finite-open/Gamma/fixed-k/k-path rules.

## 11.2. Metadata/binary

- metadata owner mismatch;
- field revision mismatch;
- representation/basis/count/layout mismatch;
- binary point/value count mismatch;
- NaN/Inf;
- mesh fingerprint/revision mismatch;
- equal point count but different topology rejected;
- valid complex XYZ accepted;
- tangent field without reconstruction rejected.

## 11.3. Race and lifecycle

- sample change makes old overlay non-renderable synchronously;
- late metadata ignored;
- late binary decode ignored;
- abort on unmount;
- partial GPU resources disposed;
- rebind preserves appearance only;
- animation rAF starts/stops;
- idle frames zero;
- 3D/Field Map use same field identity but independent renderer leases.

## 12. Architecture hygiene tests

Automatyczne skany:

```bash
rg "fetch\(" apps/control-room/src
rg "/v2/" apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'
rg "apps/legacy_web|/v1/live/current|bootstrap|poll|preview" apps/control-room/src
rg "from ['\"]\.\./.*modules" apps/control-room/src/modules
rg "resultsExplorerNodes|frequency-domain.*selection" apps/control-room/src
```

Każdy legalny wynik grep ma udokumentowane uzasadnienie i ownera compatibility.

## 13. Performance budgets

Poniższe wartości są początkowymi bramkami produktu. Muszą zostać zmierzone na
udokumentowanym hardware/browser profile. Ich zmiana wymaga review i zapisania
baseline; nie wolno ich po prostu poluzować po failure.

## 13.1. Złożoność

- liczba zbudowanych tree nodes nie zależy od całkowitej liczby sample/items;
- DOM item rows jest ograniczone do visible range + overscan;
- dla fixture F9 liczba materializowanych item summaries w module nie przekracza
  trzech stron aktywnego query;
- field/topology payload count nie zależy od scrollowania listy;
- zmiana display settings nie przebudowuje source projection modelu.

## 13.2. Request budgets

### Otworzenie datasetu

```text
<= 1 manifest request
<= 1 inline/axis-values request na oś potrzebującą zewnętrznej strony
<= 1 sample locator/page request
<= 1 item page request
0 field requests
0 topology requests bez spatial action
```

### Zmiana slice — shared topology

```text
<= 1 sample locator request, jeżeli mapping niecached
<= 1 item page request
<= 1 projection request, gdy Analysis jest aktywne
0 field requests
0 topology requests
```

### Explicit Plot Field

```text
<= 1 result mesh metadata/topology request przy cache miss
<= 1 field metadata request
<= 1 binary field request
0 solver requests
```

Duplicate identical requests w jednej generation są failure.

## 13.3. Main thread

- brak powtarzalnych long tasks > 50 ms podczas idle;
- budowa visible Results rows nie skaluje się z totalCount;
- przejście F9 10k -> 100k samples przy tej samej page size nie może zwiększyć
  czasu budowy visible modelu proporcjonalnie do totalCount;
- chart model build jest związany z projection revision, nie każdym renderem;
- duże decode/projection operations używają workera, jeśli przekraczają budget
  pojedynczej klatki.

## 13.4. Render/idle

Po settling i bez animacji:

```text
viewport frames = 0
ECharts updates = 0
network polling = 0
result tree rebuilds = 0
field scans = 0
```

## 13.5. Memory/resources

Po 100 cyklach:

```text
Results open/close
Analysis open/close
3D <-> Field Map
field sample changes
animation start/stop
```

wymagane:

- active ECharts/WebGL/observer/worker counts wracają do baseline po unmount;
- brak context loss;
- drawing buffer po powrocie do 3D ma niezerowy wymiar;
- heap i GPU resource growth są bounded i nie wykazują monotonicznego trendu;
- dokładny próg MiB jest ustalany przez baseline scenario i zapisany w proof
  manifest, a nie domyślnie uznawany za zero;
- field cache respektuje limit i final consumer release.

## 13.6. Virtualization

- typowy viewport listy renderuje nie więcej niż visible rows + skonfigurowany
  overscan;
- test sprawdza bounded DOM count dla F9;
- scroll do item locator nie wymaga załadowania poprzednich stron;
- focus i aria-activedescendant pozostają poprawne przy recyklingu rows.

## 14. Browser scenarios

## 14.1. B1 — real 15-point antidot K0 field sweep

### Przygotowanie

1. Zbudować runtime zgodny z exact source snapshot.
2. Wykonać FEM CPU K0 field sweep dla warstwy z otworem.
3. Zweryfikować artifacts przed uruchomieniem UI.
4. Uruchomić Control Room interactive z tym samym run/artifact root.
5. Zapisać source/runtime/artifact digests.

### Scenariusz

1. Otwórz Results.
2. Wybierz właściwy run/stage/dataset.
3. Potwierdź `15/15` i units osi.
4. Wybierz pierwszy sample; porównaj listę modów z artifact.
5. Wybierz sample środkowy i ostatni; porównaj listy.
6. Włącz preserve branch i przejdź przez crossing/gap.
7. Wybierz dwa mody z field refs.
8. Otwórz Analysis spectrum; sprawdź highlight.
9. Kliknij inny mode na wykresie; sprawdź Results i Inspector.
10. Plot 3D: real, imag, magnitude, phase, phase-rotated, animate.
11. Podczas animacji zmień sample; sprawdź natychmiastowy brak starego field.
12. Plot nowy field.
13. Otwórz Field Map; sprawdź tę samą identity.
14. Wróć do 3D; sprawdź WebGL health/drawing buffer.
15. Przełącz Mocha/Latte, reduced motion i 200% zoom.
16. Eksportuj selected spectrum z provenance.
17. Zapisz screenshots, request trace i resource counters.

### Failure conditions

- etykieta tylko `Sample N`;
- lista modów z innego sample;
- preservation po raw index;
- stare pole widoczne po zmianie sample;
- field request przy samym scroll/wyborze osi;
- obca topologia;
- chart/Results selection mismatch;
- brak units/status/provenance;
- context loss/leak.

## 14.2. B2 — fixed-k/k-path

- exact k vector i convention;
- branch gaps;
- chart point round-trip;
- field reference cell;
- Gamma/fixed-k negative classification.

## 14.3. B3 — driven response

- outer sample -> response spectrum;
- observable units;
- response point selection;
- response field;
- peaks/fits;
- modal-driven relation;
- brak mylenia intensity i eigenfrequency.

## 14.4. B4 — LLG/FFT/DSF

- physical-time trace;
- sampling provenance;
- FFT spectrum/features;
- feature Inspector;
- optional field;
- S(k,f) response/source;
- cuts i point selection;
- legacy partial badge, jeśli użyty stary artifact.

## 14.5. B5 — geometry sweep

- trzy values/topologies;
- result mesh switching;
- mismatch negative test;
- missing mesh disabled reason;
- spectrum nadal dostępne;
- comparison field blocked bez transfer.

## 14.6. B6 — scale/performance

- F9 10k×100;
- scroll/search/filter/sort;
- item locator;
- bounded DOM/pages;
- request count;
- no long-task storm;
- unmount cleanup.

## 15. Accessibility proof

Każdy główny scenariusz sprawdza:

- keyboard-only navigation;
- visible focus;
- screen-reader labels dla osi/units/statusów;
- status nie tylko kolorem;
- tree semantics;
- virtualized list semantics;
- context menu keyboard;
- chart DOM summary/table;
- 200% zoom bez utraty primary actions;
- high-density data w czytelnej kolejności;
- `prefers-reduced-motion`;
- kontrast Mocha/Latte;
- tooltip nie jest jedynym nośnikiem informacji.

## 16. Proof manifest

Proponowany schema:

```json
{
  "schema_version": "fullmag.result_ui_qualification.v1",
  "scenario_id": "fem-k0-antidot-field-sweep-ui",
  "source": {
    "commit": "...",
    "snapshot_digest": "sha256:..."
  },
  "runtime": {
    "runtime_id": "...",
    "image_digest": "sha256:...",
    "backend": "fem",
    "device": "cpu",
    "precision": "float64"
  },
  "artifacts": [
    {"path": "eigen/field_sweep.v1.json", "digest": "sha256:..."},
    {"path": "eigen/spectrum.v2.json", "digest": "sha256:..."},
    {"path": "eigen/branches.v2.json", "digest": "sha256:..."}
  ],
  "browser": {
    "name": "chromium",
    "version": "...",
    "frontend_build": "sha256:...",
    "viewport": [1920, 1080],
    "device_scale_factor": 1
  },
  "checks": [
    {
      "id": "sample-mode-binding",
      "status": "pass",
      "evidence": ["trace.json", "screenshot.png"]
    }
  ],
  "metrics": {
    "requests": {},
    "timings_ms": {},
    "heap_bytes": {},
    "webgl_resources": {},
    "chart_instances": {}
  },
  "screenshots": [],
  "open_blockers": []
}
```

Proof manifest nie zawiera sekretów ani host paths. Każdy evidence file ma
digest.

## 17. CI i komendy

### Rust/API

```bash
cargo test -p fullmag-runner field_sweep
cargo test -p fullmag-api frequency_domain
cargo test -p fullmag-api analysis_results
```

Dla native changes użyć właściwych managed `just` recipes.

### Control Room

```bash
pnpm --dir apps/control-room run generate:api
pnpm --dir apps/control-room run test
pnpm --dir apps/control-room run typecheck
pnpm --dir apps/control-room run lint
pnpm --dir apps/control-room run check:architecture-hygiene
pnpm --dir apps/control-room run check:api-hygiene
pnpm --dir apps/control-room run audit:idle-performance
pnpm --dir apps/control-room run smoke:analysis-plots
pnpm --dir apps/control-room run smoke:results-mode-sweep
```

Nowe scripts są obowiązkiem odpowiednich PR; jeśli nie istnieją, status jest
NOT RUN, nie „covered elsewhere”.

### React diagnostics

```bash
npx -y react-doctor@latest apps/control-room --verbose --diff
```

Wyniki są przeglądane, nie automatycznie ignorowane. Każdy świadomy wyjątek ma
uzasadnienie.

## 18. Release gates

### Gate R1 — contract

- typed field sweep parity;
- result dataset schema;
- stable IDs/revisions;
- units/status/topology;
- generated client current.

### Gate R2 — ownership

- jeden Results owner;
- cursor/selection invariant;
- Analysis bez second primary dataset;
- Inspector typed route;
- field overlay generic.

### Gate R3 — functionality

- K0 field sweep end-to-end;
- non-K0;
- driven;
- LLG/FFT/DSF;
- generic sweeps w deklarowanym scope.

### Gate R4 — performance/lifecycle

- pagination/virtualization;
- request budgets;
- idle zero-work;
- ECharts/WebGL/worker cleanup;
- no stale overlay.

### Gate R5 — accessibility/visual

- keyboard;
- 200% zoom;
- reduced motion;
- Mocha/Latte;
- readable units/status.

### Gate R6 — scientific trust

- product semantics;
- no fake fields/branches/modes;
- topology identity;
- qualification scope;
- source revisions.

### Gate R7 — evidence

- proof manifests;
- screenshots/traces;
- exact commits/runtime/artifacts;
- open blockers empty dla promowanego scope.

## 19. Acceptance criteria matrix

| ID | Kryterium | Test/evidence |
|---|---|---|
| AC-01 | 15 fizycznych field values | API fixture + browser B1 |
| AC-02 | właściwe modes per sample | adapter test + B1 artifact comparison |
| AC-03 | stable IDs, no index join | domain/API negative tests |
| AC-04 | Results/Analysis/Inspector sync | integration + B1 |
| AC-05 | chart point round-trip | projection tests + browser |
| AC-06 | finite-open/Gamma/non-K0 | classification/adapters + B2 |
| AC-07 | branch tracking/gaps | F2/F4 + B1/B2 |
| AC-08 | driven point semantics | F5 + B3 |
| AC-09 | FFT feature semantics | F6 + B4 |
| AC-10 | DSF point/cuts | F7 + B4 |
| AC-11 | field owner/revision/topology | overlay unit + browser races |
| AC-12 | geometry result mesh | F8 + B5 |
| AC-13 | no field preload | request audit |
| AC-14 | large sweep bounded | F9 + B6 |
| AC-15 | multi-axis/sparse | F10 tests |
| AC-16 | status facets | component/API tests |
| AC-17 | units/provenance/export | unit/export/browser |
| AC-18 | active-only cleanup | lifecycle stress |
| AC-19 | accessibility | automated/manual browser evidence |
| AC-20 | no duplicate Results owner | registry/architecture scan |
| AC-21 | no direct fetch/cross-module store | hygiene scans |
| AC-22 | compatibility bounded | migration tests/telemetry |
| AC-23 | qualification not inflated | evidence review |

## 20. Final Definition of Done

Refaktor jest ukończony wyłącznie, gdy wszystkie poniższe warunki są spełnione:

### Kontrakt i API

- pełny writer/API/generated round-trip nie traci wymaganych pól;
- result datasets są run-scoped, revisioned i typed;
- osie, tokens, sample/items/branches/fields/relations są stabilne;
- pages są cursor-bound i bounded;
- fields/topologies mają oddzielny data-plane;
- partial/interrupted/corrupt są fail-closed.

### UI i ownership

- istnieje jeden kernelowy panel-left host i jeden owner Results;
- Results tree zawiera datasets, nie milion items;
- Results browser jest paged/virtualized;
- result cursor jest kernel-owned;
- selection i cursor są atomowo spójne;
- Analysis nie posiada drugiego primary datasetu;
- Inspector ma typed analysis-result route;
- viewport/field-map używają jednego generic field intent.

### Funkcje naukowe

- finite-open, Gamma, fixed-k, k-path i k-grid są rozróżnione;
- modal eigen i driven response są rozróżnione;
- FFT peak jest spectral feature;
- branch pochodzi z trackingu;
- response/source DSF są rozdzielone;
- geometry field używa właściwego result mesh;
- multi-axis/sparse sweeps nie fabrykują braków;
- optional relations są jawne i wersjonowane.

### Wydajność i lifecycle

- F9 nie jest materializowany w całości;
- request budgets przechodzą;
- field nie jest prefetchowany;
- idle wykonuje zero render/poll work;
- ECharts/WebGL/workers/observers/leases wracają do baseline po stress;
- brak stale field race;
- browser pozostaje bez context loss.

### UX i dostępność

- wszystkie główne przepływy działają klawiaturą;
- units/status/provenance są czytelne;
- 200% zoom i reduced motion przechodzą;
- Mocha/Latte są spójne;
- empty/partial/stale/corrupt/unsupported mają jednoznaczne komunikaty;
- cross-navigation działa między Model/Results/Resources/Jobs/Diagnostics,
  Analysis, Inspector i viewport.

### Dowody i release

- real 15-point antidot browser proof jest zapisany;
- non-K0, driven i LLG/FFT/DSF mają własne evidence;
- modal CPU/GPU i inne lanes są kwalifikowane oddzielnie;
- proof manifest wiąże commit/runtime/artifacts/browser;
- open blockers są puste dla promowanego scope;
- compatibility readers mają zamknięte lub jawne release gates;
- docs/ADR/specs odpowiadają finalnemu kodowi.

Sama obecność komponentów, zielony typecheck, screenshot fixture albo jeden
poprawny solve nie spełniają tej Definition of Done.
