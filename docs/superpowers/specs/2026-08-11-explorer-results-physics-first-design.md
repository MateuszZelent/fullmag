# Physics-first Explorer, Results i Analysis

Data: 2026-08-11

Status: kierunek zatwierdzony; projekt skorygowany po audycie fizyki, kontraktów Fullmag i oficjalnej dokumentacji COMSOL

Zakres: `apps/control-room` — Explorer, Results, Resources, Jobs, Diagnostics, Analysis, routing Inspectorów, postprocessing i wizualizacja modów

## 1. Decyzja projektowa

Control Room używa hierarchii physics-first: użytkownik najpierw wybiera klasę zjawiska lub analizy, następnie produkt obliczeniowy, a dopiero potem reprezentację danych.

W domenie częstotliwościowej obowiązuje kolejność:

1. `Resonance & FMR` albo `Dispersion & k-resolved response`;
2. `Eigenmodes (modal eigensolve)` albo `Frequency Response (driven)`;
3. widmo, mody, piki, sweep, gałęzie, mapa odpowiedzi lub pole.

Kierunek physics-first jest lepszy od method-first i artifact-first, ponieważ użytkownik nie musi znać solvera ani nazwy pliku przed znalezieniem interesującego zjawiska. Metoda i artefakt pozostają jawne, ale nie sterują główną nawigacją.

## 2. Korekty fizyczne i reguły nazewnictwa

### 2.1. FMR nie oznacza automatycznie `k = 0`

Wektor Blocha $\mathbf{k}$ jest właściwością problemu periodycznego/Floqueta. Dla skończonej geometrii z otwartymi brzegami nie należy pokazywać `k = 0`; poprawny kontekst to `finite/open · k not applicable`.

Dla problemu periodycznego pojedyncza próbka Γ ma `k = 0`. Nie oznacza to jeszcze, że każdy znaleziony mod jest obserwowalny w FMR.

Inspector i nagłówek Analysis pokazują jeden z jawnych kontekstów:

| Kontekst | Etykieta użytkowa | Znaczenie |
|---|---|---|
| skończona geometria, open/free | `Finite system · k n/a` | brak wektora Blocha |
| periodyczna próbka Γ | `Γ point · k = 0` | zerowy wektor Blocha |
| pojedyncza próbka niezerowa | `Fixed k` z wartością i jednostką | jeden problem Blocha/Floqueta, jeszcze nie relacja dyspersji |
| path/grid/wiele próbek | `k path` albo `k grid` | dane wavevector-resolved |

### 2.2. Eigenmode nie jest automatycznie modem FMR-active

Eigensolver zwraca częstotliwości i profile modów własnych. Mod można nazwać `FMR-active` dopiero wtedy, gdy artefakt publikuje sprzężenie z określonym polem RF, oscillator strength, projekcję drive-mode albo równoważną wielkość o udokumentowanych jednostkach i provenance.

Dlatego modalny wynik bez wag sprzężenia nazywa się `Eigenfrequency Spectrum`, nie `FMR Spectrum`. Węzeł `RF Coupling / FMR Activity` pojawia się warunkowo po publikacji odpowiedniego observable.

### 2.3. Driven response i FMR

Driven frequency response rozwiązuje wymuszoną odpowiedź harmoniczną. Etykieta `FMR Response Spectrum` jest legalna, jeśli manifest identyfikuje magnetyczny drive RF oraz publikuje fizycznie określony observable, na przykład susceptibility, absorbed power albo drive-projected response.

Jeśli taki kontrakt nie jest spełniony, UI używa neutralnej nazwy `Harmonic Response Spectrum` i pokazuje dokładną wielkość oraz jednostkę osi.

### 2.4. Dyspersja i mapa odpowiedzi nie są tym samym

Modalna relacja dyspersji ma postać $f_n(\mathbf{k})$ albo $\omega_n(\mathbf{k})$. Driven response map jest funkcją co najmniej dwóch zmiennych, na przykład $A(\mathbf{k}, f)$, $\chi(\mathbf{k}, f)$ albo $P_{\mathrm{abs}}(\mathbf{k}, f)$. Mapa odpowiedzi może ujawniać grzbiety dyspersji, ale sama nie jest relacją $f(\mathbf{k})$.

| Symbol | Znaczenie | Jednostka UI |
|---|---|---|
| $\mathbf{k}$ | wektor Blocha/Floqueta | $\mathrm{rad\,m^{-1}}$ zgodnie z kontraktem Fullmag |
| $f$ | częstotliwość | $\mathrm{Hz}$ z kontrolowanym display unit |
| $f_n(\mathbf{k})$ | modalna gałąź dyspersji | $\mathrm{Hz}$ |
| $A(\mathbf{k},f)$ | amplituda odpowiedzi | zależna od observable; zawsze jawna |
| $\chi(\mathbf{k},f)$ | susceptibility | zgodna z opublikowanym kontraktem, bez zgadywania |
| $P_{\mathrm{abs}}(\mathbf{k},f)$ | moc absorbowana | $\mathrm{W}$ albo jawnie opisana gęstość mocy |

### 2.5. Kanoniczne nazwy produktów

Manifest `study_product = "modal_eigen"` zachowuje nazwę użytkową `Eigenmodes`. Manifest `study_product = "driven_response"` zachowuje nazwę `Frequency Response`. `Eigensolve` i `Frequency-Driven` są objaśnieniami metody, nie konkurencyjnymi nazwami produktu.

Samodzielna etykieta `Spectrum` jest niedozwolona. Każde widmo ma kwalifikator, na przykład `Temporal Spectrum`, `Spin-Wave Spectrum`, `Eigenfrequency Spectrum` albo `FMR Response Spectrum`.

## 3. Podział odpowiedzialności zakładek Explorera

Zakładki odpowiadają na rozłączne pytania:

| Zakładka | Pytanie użytkownika | Własność |
|---|---|---|
| `Model` | Co zostało zdefiniowane? | authoring i konfiguracja |
| `Results` | Co policzono i jak to analizować? | semantyczne wyniki i postprocessing |
| `Resources` | Jakie dane opublikował runtime? | surowe, revisioned zasoby |
| `Jobs` | Co się wykonuje lub oczekuje? | run, stage, command lifecycle |
| `Diagnostics` | Dlaczego coś jest niepoprawne lub niedostępne? | problemy, capability, mismatch i wydajność |

Nie powstają osobne aplikacje FMR, Dispersion, FDM ani FEM. Wszystkie zakładki pozostają kontekstami jednego workspace, jednej selekcji, jednego Inspectora i zunifikowanego Viewportu.

## 4. Model — authoring

```text
Model
└─ Session
   ├─ Definitions
   ├─ Universe
   │  └─ Airbox / Outside Magnetic Support
   ├─ Objects
   │  └─ Object
   │     ├─ Geometry
   │     ├─ Regions
   │     ├─ Material
   │     ├─ Magnetic Texture
   │     ├─ Mesh
   │     ├─ Physics
   │     └─ Visualization
   ├─ Couplings
   ├─ Physics
   ├─ Mesh
   └─ Study
      └─ Stages
```

`Model` nie zawiera katalogu policzonych wyników. `Object → Visualization` opisuje bieżący, trwały stan prezentacji obiektu. Aktywna wizualizacja wyniku pojawia się jako `Active Analysis Overlay`, z typem źródła, field identity, reprezentacją i ustawieniami wyświetlania.

Etapy `Eigenmodes` i `Frequency Response` pozostają odrębnymi produktami w `Study`. Ich Inspector pokazuje equilibrium source, boundary/Floquet context, k sampling, solver request, outputs i capability przed uruchomieniem.

## 5. Results — semantyczne wyniki i postprocessing

### 5.1. Result context

Każdy wynik ma immutable owner identity obejmujące co najmniej `run_id`, `stage_id`, `study_product`, artifact revision oraz equilibrium provenance. Results nie może mieszać dwóch etapów, runów, stanów równowagi ani k sampling w jednym węźle tylko dlatego, że mają podobną etykietę.

Zakładka ma kompaktowy `Result context` selector nad drzewem. Domyślnie wskazuje bieżący run; pozwala przejść do zachowanego runu bez dodawania kolejnego poziomu zagnieżdżenia do każdej ścieżki. Porównanie runów jest jawną powierzchnią Analysis, nie niejawnie scalonym drzewem.

W obrębie wybranego runu wyniki pozostają physics-first. Jeśli run ma kilka etapów tej samej rodziny, każda rodzina zawiera osobny węzeł stage z czytelną etykietą i stabilnym `stage_id`.

### 5.2. Docelowe drzewo

```text
Results · context: <run>
├─ Dynamics
│  ├─ <Time stage>
│  │  ├─ Magnetization vs Time
│  │  ├─ Energy vs Time
│  │  ├─ Other Published Observables
│  │  └─ Saved States
│  └─ Spectral Analysis
│     ├─ Temporal Spectrum
│     └─ Spin-Wave Spectrum · S(k,f)
├─ Resonance & FMR
│  ├─ <Eigenmodes stage> · Modal
│  │  ├─ Eigenfrequency Spectrum
│  │  ├─ Mode Shapes
│  │  ├─ RF Coupling / FMR Activity [conditional]
│  │  └─ Equilibrium & Provenance
│  ├─ <Frequency Response stage> · Driven
│  │  ├─ FMR Response Spectrum [when qualified]
│  │  ├─ Harmonic Response Spectrum [otherwise]
│  │  ├─ Resonance Peaks
│  │  ├─ Frequency Points
│  │  ├─ Response Fields
│  │  └─ Equilibrium & Provenance
│  └─ Modal–Driven Comparison [only for compatible owners]
├─ Dispersion & k-resolved response
│  ├─ <Eigenmodes stage> · Modal
│  │  ├─ k-Path / k-Grid
│  │  ├─ Dispersion Relation · fₙ(k)
│  │  ├─ Mode Branches
│  │  ├─ Modes at k
│  │  └─ Equilibrium & Provenance
│  ├─ <Frequency Response stage> · Driven
│  │  ├─ Spectral Response Map · A(k,f)
│  │  ├─ k Samples
│  │  ├─ Frequency Points
│  │  └─ Equilibrium & Provenance
│  └─ Modal–Driven Comparison [only for compatible owners]
├─ Hysteresis
├─ Analysis Views
├─ Derived Values
├─ Tables
└─ Exports
```

`Analysis Views`, `Derived Values`, `Tables` i `Exports` są definicjami postprocessingu użytkownika. Odwołują się do dataset/resource identity; nie kopiują surowych tablic. To zachowuje mocny wzorzec COMSOL Results, ale dodaje jawny run/stage/revision provenance.

Węzeł semantycznego wyniku istnieje tylko po opublikowaniu manifestu, zasobu albo jawnego partial artifact. Skonfigurowany, lecz niewykonany etap pozostaje w `Model → Study`, nie udaje wyniku w `Results`.

### 5.3. Klasyfikator physics-first

Klasyfikacja jest funkcją czystą z typed manifestu, a nie analizą etykiety lub ścieżki pliku:

```text
study_product
k_sampling kind and sample count
boundary/Floquet context
drive/probe contract
published observables
run_id + stage_id + equilibrium identity
```

Reguły:

- modal lub driven z brakiem k sampling dla finite/open trafia do `Resonance & FMR` z `k n/a`;
- periodyczna pojedyncza próbka Γ trafia do `Resonance & FMR` z `Γ · k=0`;
- pojedyncza próbka nonzero-k trafia do `Dispersion & k-resolved response → Fixed k`, ale nie otrzymuje etykiety `Dispersion Relation`;
- path/grid/wiele próbek trafia do `Dispersion & k-resolved response`;
- `FMR` pojawia się na liściu tylko przy spełnionym kontrakcie drive/observable albo modal coupling;
- modal–driven comparison wymaga zgodnych equilibrium, geometry/mesh identity, boundary context, k context, units i porównywalnej definicji observable; w przeciwnym razie Inspector wyjaśnia mismatch i nie rysuje mylącego overlay.

## 6. Resources — surowe dane runtime

```text
Resources
├─ Fields
├─ Table Resources
├─ Mesh and Topology
├─ Analysis Artifacts
├─ Binary Payloads
└─ Export Artifacts
```

Węzły pokazują resource key, schema/media type, revision, generation ID, owner run/stage, status, rozmiar, cache state i artifact location, jeśli dotyczy. Nie powtarzają fizycznej hierarchii `Results`.

`Results → Tables` jest użytkową definicją tabeli i selekcji kolumn. `Resources → Table Resources` jest opublikowanym datasetem. To świadome rozdzielenie definicji postprocessingu od danych, nie duplikacja.

Statyczne wpisy typu `Published fields`, `Mesh topology` lub sztywne badge udające bieżący runtime należy zastąpić rzeczywistymi katalogami zasobów. Brak katalogu jest jawnym empty/unavailable state.

## 7. Jobs i Diagnostics

### 7.1. Jobs

```text
Jobs
├─ Current Run
│  ├─ Active Stage
│  ├─ Progress
│  └─ Command State
├─ Queue [when resource exists]
└─ Recent Runs [when resource exists]
```

Statyczny `Command queue · idle` nie jest dowodem stanu. Jobs pokazuje wyłącznie resource-backed lifecycle i przechowuje requested oraz resolved execution oddzielnie.

### 7.2. Diagnostics

```text
Diagnostics
├─ Problems
├─ Resource Health
├─ Capability and Execution
├─ Solver Diagnostics
├─ Mesh Diagnostics
├─ Frequency-Domain Diagnostics
└─ Performance
```

Stany stale, mismatch, unsupported, degraded, fallback i błędy publikacji mają tu pełne wyjaśnienie, dowód i działanie naprawcze. W `Results` pozostaje zwięzły status oraz link `Open diagnostics`.

## 8. Kontrakt buildera

Wszystkie zakładki korzystają z jednego pipeline'u:

```text
revisioned resource hooks
        ↓
typed tab snapshot
        ↓
pure domain classifier
        ↓
pure semantic tree builder
        ↓
ExplorerNode descriptors
        ↓
selection adapter
        ↓
dedicated Inspector route / Analysis handoff / Viewport handoff
```

Builder:

- nie wykonuje fetchy;
- nie odczytuje store ani browser state;
- nie przechowuje stanu Reacta;
- nie parsuje dużych payloadów numerycznych;
- buduje węzły wyłącznie z jawnego typed snapshotu;
- nie zgaduje fizyki z label, filename albo kolejności tablicy;
- nie tworzy placeholderów wyglądających jak dane runtime;
- zachowuje stabilność ID przy zmianie etykiety, display unit i revision danych;
- pozostaje deterministyczny dla tego samego snapshotu.

### 8.1. Rozdzielenie stanów

Jedno pole `status` nie może mieszać świeżości transportu, lifecycle wykonania i semantycznej dostępności. Docelowy descriptor ma trzy osie:

```text
resourceState: idle | loading | ready | stale | error
executionState: not_started | queued | running | paused | completed | cancelled | failed
availability: available | partial | unavailable | unsupported
```

Warstwa prezentacji wyprowadza z nich jeden priorytetowy status wiersza i dostępne akcje. Nie traci jednak pełnych stanów używanych przez Inspector i diagnostykę.

### 8.2. Tożsamość węzłów

Każdy selekcjonowalny węzeł ma:

- stabilne `id` oparte na immutable owner identity;
- jednoznaczny `kind`;
- `parentId` zgodne z hierarchią physics-first;
- typed `resultRef` albo `resourceRef`;
- `runId`, `stageId`, `studyProduct` i revision/generation, jeśli dotyczą;
- source/observable/k context;
- legalne komendy;
- dedykowany routing Inspector;
- jawny handoff do Analysis lub Viewport.

Przykładowa przestrzeń ID:

```text
results:run:<run-key>:stage:<stage-key>:resonance:modal:spectrum
results:run:<run-key>:stage:<stage-key>:resonance:driven:response
results:run:<run-key>:stage:<stage-key>:k-resolved:modal:dispersion
results:run:<run-key>:stage:<stage-key>:k-resolved:driven:response-map
```

`run-key`, `stage-key`, mode ID, branch ID, peak ID i frequency point ID używają kanonicznego kodowania. Indeks tablicy jest dozwolony tylko jako revision-scoped fallback, gdy kontrakt źródłowy nie publikuje domenowego ID; taki fallback jest jawny w provenance.

## 9. Analysis — physics-first workbench

Analysis nie powiela wszystkich liści drzewa jako płaskich zakładek. Top-level surfaces są stabilne i fizyczne:

```text
Dynamics | Resonance & FMR | Dispersion | Hysteresis | Comparison
```

Wewnątrz powierzchni znajduje się kontekstowy subview:

- `Dynamics`: `Time Traces`, `Temporal FFT`, `S(k,f)`;
- `Resonance & FMR`: `Eigenmodes`, `Frequency Response`, `Modal–Driven`;
- `Dispersion`: `Modal fₙ(k)`, `Driven A(k,f)`, `Branches`;
- `Hysteresis`: branch/loop views;
- `Comparison`: jawne source A/source B z compatibility verdict.

Subview jest widoczny tylko wtedy, gdy istnieje legalny dataset albo capability. Niepełne dane pokazują empty/degraded state, nie pusty wykres.

Każda powierzchnia ma descriptor zawierający:

- physical family;
- study product i method explanation;
- run/stage/equilibrium identity;
- k context;
- observable i SI/display units;
- osie;
- source dataset/resource identity;
- provenance i compatibility;
- handoff do 3D;
- route Inspectora.

Przykładowe nagłówki:

```text
Resonance & FMR
Eigenmodes · Finite system · k n/a
Eigenfrequency Spectrum
```

```text
Resonance & FMR
Frequency Response · Γ point · k = 0
FMR Response Spectrum · Im χₓₓ(f)
```

```text
Dispersion
Eigenmodes · k path Γ–X–M–Γ
Dispersion Relation · fₙ(k)
```

Na wąskim panelu top-level tabs korzystają ze wspólnego przewijanego komponentu. Subview przechodzi do kompaktowego segmented control lub menu. Sterowanie datasetem, seriami, jednostkami i zakresem nie zasłania wykresu i pozostaje dostępne klawiaturą.

## 10. Inspectory

Każdy semantycznie odmienny `kind` ma dedykowany Inspector. Współdzielenie komponentu jest dozwolone tylko dla tego samego typed panel modelu. Nieznany `kind` kończy się jawnym unsupported Inspector; generyczny panel nie może udawać właściwej semantyki.

Wspólny template wizualny korzysta z dojrzałego wzorca Visualization dla Airbox/Object/Mesh Part:

1. breadcrumb i jednoznaczny tytuł;
2. physical context i method badge;
3. resource/execution/availability status;
4. najważniejsze właściwości z jednostkami;
5. sterowanie i akcje;
6. provenance;
7. diagnostyka i unavailable reason.

Template współdzieli primitive, typography, spacing, section headers, status rows i action bars. Nie współdzieli przypadkowej treści.

Wymagane rodziny obejmują co najmniej:

- Eigenfrequency Spectrum;
- Eigenmode i Mode at k;
- RF Coupling / FMR Activity;
- FMR albo Harmonic Response Spectrum;
- Resonance Peak;
- Frequency Point;
- Response Field;
- Dispersion Relation;
- k-Path/k-Grid;
- Mode Branch;
- Spectral Response Map $A(\mathbf{k},f)$;
- modal–driven comparison i mismatch;
- Analysis View, Derived Value, Table i Export;
- active eigenmode overlay i active response-field overlay;
- provenance, progress, cancel-requested i diagnostics.

Inspector eigenmode nie nazywa modu FMR-active bez coupling evidence. Inspector driven point nie nazywa odpowiedzi eigenmodem. Oba pokazują equilibrium, phasor convention, normalization, backend/device/precision, readiness i validated scope, jeśli manifest je publikuje.

## 11. Handoff do Viewport 3D

Wynik pozostaje w `Results`, a aktywny stan prezentacji jest widoczny w `Model → Object → Visualization`:

```text
Result node
   ↓ Visualize in 3D
AnalysisFieldOverlayController
   ↓
Unified Viewport 3D
   ↓
Model → Object → Visualization → Active Analysis Overlay
```

Overlay zachowuje `run_id`, `stage_id`, field identity, source (`eigen-mode` albo `frequency-response`), k/f sample, representation, phase i provenance. Zmiana result context nie może pozostawić wizualnie aktywnego, ale semantycznie obcego overlay bez ostrzeżenia.

Dostępne reprezentacje (`real`, `imag`, `abs`, `phase`, `phase_rotated_real`) i animacja są capability-aware. Animacja jest rekonstrukcją fazora, nie time integration. Surface opacity nie zmienia niejawnie wireframe opacity. Optymalizacja nie obniża domyślnej jakości wizualizacji.

## 12. Co przejmujemy z COMSOL i gdzie Fullmag ma być lepszy

Z COMSOL przejmujemy sprawdzone zasady:

- wyraźne oddzielenie `Study` od `Results`;
- dataset jako źródło plotu i derived value;
- `Plot Groups`, `Derived Values`, `Tables` i `Export` jako first-class postprocessing;
- ustawienia zależne od selekcji w drzewie;
- tworzenie sensownych default plots po rozwiązaniu.

Nie kopiujemy dosłownie drzewa COMSOL. Fullmag ma dodatkowe wymagania live/control-room i jest lepszy tam, gdzie zapewnia:

- physics-first default views zamiast listy generycznych `1D Plot Group 1`;
- jawne `run/stage/equilibrium/revision` provenance;
- requested intent oddzielone od resolved execution;
- surowe revisioned resources oddzielone od user-facing postprocessing;
- jeden Analysis i jeden Viewport dla FDM/FEM;
- capability-aware actions i fail-closed mismatch;
- typed API i round-trip do kanonicznego modelu Fullmag.

„Lepszy od COMSOL” nie jest twierdzeniem marketingowym. Jest zestawem mierzalnych kryteriów: mniej niejednoznacznych nazw, krótsza ścieżka do poprawnego wykresu, jawna tożsamość danych, brak cichego mieszania runów oraz reprodukowalny handoff do Python/ProblemIR/artifacts.

Oficjalne referencje interakcji COMSOL:

- [Results Overview](https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_results.37.002.html)
- [Results API and tree categories](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/application_programming_guide.15.28.html)
- [Plot Groups and Plots](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_results.37.108.html)
- [Study and Study Step Types](https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.010.html)
- [Frequency Domain, Modal](https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.031.html)

## 13. Responsywność, dostępność i styl

- Wszystkie klasy mają prefiks `fm-`.
- Komponenty konsumują `--fm-*`; raw Catppuccin hex pozostaje w centralnych tokenach.
- Tabs, menu, tooltipy, dialogi, selecty, przyciski i segmented controls używają shared shadcn/ui-style primitives.
- Explorer i Inspector działają przy wąskim docku oraz 200% zoom bez poziomego overflow.
- Tree row zachowuje czytelną etykietę; provenance i długie identity trafiają do tooltip/Inspector, nie wypychają głównej nazwy.
- Wykresy mają jawne osie, units, keyboard cursor, DOM summary i bounded points table.
- Status nie jest kodowany wyłącznie kolorem.
- Reduced motion usuwa dekoracyjną animację, nie informację o postępie.

## 14. Wydajność i lifecycle

- Resource hooks są aktywne tylko dla zakładki, result context i aktywnego overlay, które ich potrzebują.
- Builder nie buduje chart models ani nie dekoduje dużych payloadów.
- Chart models są revision-keyed, bounded i nie używają variadic min/max dla dużych tablic.
- Ukryta Analysis surface nie utrzymuje ECharts instance, observera, workera, requestu ani własnego RAF.
- Aktywny Viewport 3D może posiadać kontrolowaną pętlę zgodną z lifecycle; chart-owned idle redraw pozostaje zerowy.
- Stress gate przełącza Dynamics/Resonance/Dispersion/Comparison/3D oraz result contexts i wymaga powrotu do bazowej liczby zasobów.
- Duże mode fields i response maps pozostają na binary/Zarr data plane; JSON przenosi tylko kontrolę, summary i provenance.

## 15. Migracja

Implementacja odbywa się pionowymi test-first slice'ami:

1. uzupełnienie kanonicznego dokumentu fizyki o user-facing classification i FMR naming boundary;
2. typed result/resource/job/diagnostic snapshots i rozdzielenie trzech osi statusu;
3. pure physics classifier z fixtures finite/open, Γ, fixed nonzero-k, k path i k grid;
4. run/stage-scoped physics-first Results i nowe ID;
5. selection adapter i dedykowane routing Inspectorów;
6. Analysis top-level surfaces i subviews;
7. aktywny overlay zamiast katalogu wyników w `Model → Visualization`;
8. resource-backed Resources/Jobs/Diagnostics bez statycznych placeholderów;
9. Analysis Views, Derived Values, Tables i Exports;
10. responsywność oraz wspólny Inspector template;
11. testy integracyjne, desktop/narrow browser smoke i performance/lifecycle gates;
12. usunięcie starego drzewa i bounded compatibility reader po migracji zapisanego workspace state.

Zmiana ID jest atomowa dla builderów, selection refs, commands, Inspectors, preferences i testów. Nie utrzymujemy dwóch równoległych drzew jako trwałej kompatybilności.

### 15.1. Jawne contract gaps przed implementacją

Obecny v2 kontrakt ma `simulation/runs/current` i `simulation/runs/{run_id}`, ale nie publikuje katalogu runów potrzebnego do kompletnego historycznego `Result context` selectora. Do czasu dodania resource-first collection endpoint selector pokazuje wyłącznie bieżący run oraz jawnie znane, bezpośrednio wskazane run IDs; nie skanuje artefaktów i nie wymyśla `Recent Runs`.

User-defined `Analysis Views`, `Derived Values` i trwałe `Plot Groups` nie mają jeszcze kompletnego publicznego owner resource. Pierwszy slice może prezentować istniejące table/chart descriptors, ale nie może nazywać ich trwałymi definicjami COMSOL-class. Docelowy owner należy zaprojektować w rodzinie `analysis` albo `workspace`, a payloady danych pozostawić w `data`.

Nie wszystkie modalne artefakty publikują RF coupling/oscillator strength, a nie wszystkie driven artifacts publikują wymiarową susceptibility lub absorbed power. Do czasu domknięcia producer → schema → OpenAPI → generated transport → facade → hook UI używa neutralnych nazw i pokazuje `contract gap`.

Nie wszystkie mode, peak, branch i frequency-point payloads mają domenowe stabilne ID. Revision-scoped fallback pozostaje jawnie przejściowy i nie jest podstawą cross-run persistence.

Zmiana drzewa, result context, status facets i właścicieli postprocessingu wymaga krótkiego ADR albo jawnego addendum do ADR 0011, 0016 i 0022 przed zmianą publicznych zasobów. ADR musi wskazać owner resources, migrację workspace preferences, legacy IDs oraz removal gates.

Każdy nowy lub rozszerzony zasób przechodzi pełny resource-first łańcuch: backend schema, OpenAPI v2, generated types/transport, facade, resource hook, domain adapter, UI i stale/error tests. HTTP v2 pozostaje source of truth; websocket tylko invaliduje resource keys.

## 16. Kryteria akceptacji

1. `Results` jest physics-first, ale nie utożsamia FMR z każdym `k=0` ani każdego eigenmode z rezonansem aktywnym FMR.
2. Finite/open, Γ, fixed nonzero-k i k path/grid mają poprawne, testowane konteksty.
3. Modalna dyspersja jest $f_n(\mathbf{k})$, a driven map jest $A(\mathbf{k},f)$ lub dokładnie nazwaną opublikowaną wielkością.
4. `Eigenmodes` i `Frequency Response` pozostają odrębnymi study products i UI routes.
5. Każdy wynik jest scoped przez run/stage/equilibrium/resource identity; dwa runy nie są scalane.
6. Model, Results, Resources, Jobs i Diagnostics korzystają z typed snapshotów i czystych builderów bez fikcyjnych placeholderów.
7. Results ma first-class Analysis Views, Derived Values, Tables i Exports powiązane z dataset identity.
8. Każdy selekcjonowalny `kind` ma dedykowany Inspector route albo jawny unsupported panel; completeness test nie pozostawia orphan kind.
9. Analysis używa tego samego słownika, poprawnych osi/jednostek oraz fail-closed compatibility.
10. Visualize in 3D zachowuje run/stage/field/k/f/representation/provenance i nie pozostawia obcego overlay po zmianie context.
11. Układ jest responsywny, dostępny i używa shared primitives oraz tokenów projektu.
12. Typecheck, API/resource hygiene, architecture checks, lint i testy builder/classifier/selection/Inspector/Analysis przechodzą.
13. Browser smoke na desktop i narrow viewport potwierdza drzewo, Inspectory, Analysis, handoff 3D, widoczny canvas, zdrowy WebGL i niezerowy drawing buffer.
14. Chart/viewport stress audit przechodzi bez wycieku instancji, requestów, observerów, workerów i chart-owned idle RAF.

## 17. Kanoniczne źródła Fullmag

Ten dokument projektuje informację i interakcję; nie jest właścicielem równań ani capability. Implementacja musi pozostać zgodna z:

- `docs/physics/0700-frequency-domain-linearized-llg.md` — modal versus driven, phasor, equilibrium i operator semantics;
- `docs/physics/0600-fem-eigenmodes-linearized-llg.md` — eigenproblem, k/Floquet boundaries i qualification;
- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md` — konwencja Blocha/Floqueta i jednostki k;
- `docs/specs/frequency-domain-artifacts-v2.md` — artifact identity, study products, readiness i provenance;
- `docs/specs/eigenmode-artifacts-v1.md` — mode, k sampling i dispersion artifacts;
- `docs/specs/frontend-v2/16-charts-analysis-module.md` — ownership i lifecycle Analysis;
- `docs/specs/resource-first-control-room-api-v2.md` — typed resource-first browser contract.

Jeśli któreś z tych źródeł nie publikuje danych potrzebnych do uczciwej klasyfikacji FMR lub comparison, UI używa neutralnej etykiety i pokazuje contract gap. Nie uzupełnia fizyki przez inferencję.
