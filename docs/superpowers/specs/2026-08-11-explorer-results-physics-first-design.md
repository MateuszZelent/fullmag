# Physics-first Explorer, Results i Analysis

Data: 2026-08-11

Status: zatwierdzony kierunek projektowy

Zakres: `apps/control-room` — Explorer, Results, Resources, Jobs, Diagnostics, Analysis, routing Inspectorów i wizualizacja modów

## 1. Cel

Control Room ma prezentować problem i wyniki w języku fizyki, a nie w języku artefaktów lub implementacji solvera. Użytkownik najpierw wybiera analizowane zjawisko, następnie metodę obliczeniową, a dopiero potem konkretną reprezentację wyniku.

W domenie częstotliwościowej obowiązuje kolejność:

1. `FMR · k = 0` albo `Relacja dyspersji · f(k)`;
2. `Eigensolve` albo `Frequency-Driven`;
3. widmo, mody, sweep, piki, gałęzie, mapa odpowiedzi lub pole.

Samodzielna etykieta `Spectrum` jest niedozwolona, ponieważ nie rozróżnia widma czasowego, widma fal spinowych, modalnego widma FMR i widma odpowiedzi wymuszonej.

## 2. Podział odpowiedzialności zakładek Explorera

### 2.1. Model

Zakładka `Model` odpowiada na pytanie: „co zostało zdefiniowane?”. Zawiera wyłącznie authoring i bieżącą konfigurację problemu:

```text
Model
└─ Session
   ├─ Definitions
   ├─ Universe
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
```

`Object → Visualization` opisuje tylko aktualny stan prezentacji obiektu. Nie jest drugim katalogiem wszystkich wyników. Aktywna wizualizacja modu lub odpowiedzi może pojawić się jako `Active Mode Overlay`, z informacją o źródle, reprezentacji i ustawieniach wyświetlania.

### 2.2. Results

Zakładka `Results` odpowiada na pytanie: „co zostało policzone?” i jest semantycznym katalogiem wyników.

```text
Results
├─ Time-Domain
│  ├─ Dynamics
│  ├─ FFT Analysis
│  │  ├─ Temporal Spectrum
│  │  └─ Spin-Wave Spectrum
│  └─ Saved States
├─ Frequency-Domain
│  ├─ FMR · k = 0
│  │  ├─ Eigensolve
│  │  │  ├─ Resonance Spectrum
│  │  │  ├─ Resonance Modes
│  │  │  └─ Provenance
│  │  ├─ Frequency-Driven
│  │  │  ├─ Response Spectrum
│  │  │  ├─ Resonance Peaks
│  │  │  ├─ Frequency Points
│  │  │  ├─ Response Fields
│  │  │  └─ Provenance
│  │  └─ Method Comparison
│  └─ Dispersion Relation · f(k)
│     ├─ Eigensolve
│     │  ├─ k-Path
│     │  ├─ Dispersion Diagram
│     │  ├─ Mode Branches
│     │  ├─ Modes at k
│     │  └─ Provenance
│     ├─ Frequency-Driven
│     │  ├─ Response Map · f(k)
│     │  └─ Provenance
│     └─ Method Comparison
├─ Hysteresis
└─ User Charts
```

Gałąź istnieje tylko wtedy, gdy jej wystąpienie wynika z opublikowanego zasobu, manifestu albo jawnego stanu wykonywania. Brak wyniku nie może być maskowany przez fikcyjny węzeł `ready`.

### 2.3. Resources

Zakładka `Resources` odpowiada na pytanie: „jakie dane opublikował runtime?” i pokazuje techniczną własność danych:

```text
Resources
├─ Fields
├─ Tables
├─ Mesh and Topology
├─ Analysis Artifacts
└─ Exports
```

Węzły pokazują revision, generation ID, status, format, rozmiar oraz zasób lub artefakt źródłowy. Nie powtarzają semantycznej hierarchii `Results`. Statyczne placeholdery udające opublikowane dane należy usunąć.

### 2.4. Jobs

Zakładka `Jobs` odpowiada na pytanie: „co aktualnie się wykonuje?”:

```text
Jobs
├─ Current Run
│  ├─ Active Stage
│  ├─ Progress
│  └─ Command State
├─ Queue
└─ Recent Runs
```

Węzeł kolejki lub runu istnieje tylko wtedy, gdy ma źródło runtime. Statyczny `Command queue · idle` nie jest wynikiem ani dowodem stanu.

### 2.5. Diagnostics

Zakładka `Diagnostics` odpowiada na pytanie: „dlaczego zasób, etap lub wynik nie jest poprawny?”:

```text
Diagnostics
├─ Problems
├─ Resource Health
├─ Solver Diagnostics
├─ Mesh Diagnostics
├─ Frequency-Domain Diagnostics
└─ Performance
```

Stany `stale`, `mismatch`, `unsupported`, `degraded`, `fallback` i błędy publikacji mają tu rozwinięte wyjaśnienie i działania naprawcze. W `Results` pozostaje zwięzły status semantycznego wyniku.

## 3. Kontrakt buildera

Wszystkie zakładki korzystają z jednego przepływu:

```text
revisioned resources
        ↓
typed tab snapshot
        ↓
pure semantic builder
        ↓
ExplorerNode descriptors
        ↓
selection adapter
        ↓
dedicated Inspector route
```

Builder:

- jest funkcją czystą;
- nie wykonuje fetchy;
- nie przechowuje stanu Reacta;
- nie odczytuje bezpośrednio store;
- buduje węzły wyłącznie z jawnego snapshotu;
- zachowuje stabilne ID przy zmianie etykiet i revision danych;
- rozdziela brak zasobu, ładowanie, stale, degraded i error;
- nie tworzy danych zastępczych wyglądających jak dane runtime;
- nie klasyfikuje tego samego wyniku równolegle według zjawiska, metody i formatu.

Każdy `ExplorerNode` musi mieć:

- stabilne semantyczne `id`;
- jednoznaczny `kind`;
- `parentId` zgodne z fizyczną hierarchią;
- status;
- jawny `resourceRef` lub inne wskazanie provenance, jeśli węzeł reprezentuje dane;
- dedykowany routing selekcji;
- zestaw legalnych komend kontekstowych;
- określony handoff do Analysis albo Viewport 3D, jeżeli dotyczy.

Indeks tablicy nie może być trwałą tożsamością modu, piku, gałęzi ani punktu częstotliwości, jeśli runtime publikuje identyfikator domenowy. Jeśli kontrakt źródłowy nie udostępnia stabilnego ID, builder tworzy deterministyczną tożsamość z revision-pinned klucza domenowego i dokumentuje jej zakres ważności.

## 4. Stabilna przestrzeń ID

Docelowe prefiksy opisują semantykę, nie aktualną etykietę UI:

```text
results:time-domain:...
results:frequency-domain:fmr:k0:eigensolve:...
results:frequency-domain:fmr:k0:driven:...
results:frequency-domain:dispersion:eigensolve:...
results:frequency-domain:dispersion:driven:...
```

Zmiana z istniejących ID odbywa się atomowo we wszystkich builderach, adapterach selekcji, Inspectorach, testach i komendach. Nie utrzymujemy dwóch równoległych drzew. Krótkotrwały parser kompatybilności jest dozwolony wyłącznie dla zapisanego stanu workspace i musi mieć termin usunięcia.

## 5. Analysis

Zakładki Analysis używają tego samego języka co `Results`:

```text
Dynamics
Temporal Spectrum
Spin-Wave Spectrum
FMR · Eigensolve
FMR · Frequency-Driven
Dispersion
Hysteresis
Comparison
```

Każda powierzchnia ma descriptor zawierający:

- kontekst fizyczny;
- metodę;
- tytuł reprezentacji;
- osie i jednostki;
- provenance;
- typ handoffu do 3D;
- docelową trasę Inspectora.

Nagłówek nie ogranicza się do nazwy zakładki. Przykładowo:

```text
FMR · k = 0
Eigensolve · Resonance Spectrum
```

oraz:

```text
Dispersion Relation · f(k)
Eigensolve · Branch-resolved modes
```

Na węższych ekranach powierzchnie Analysis używają przewijanego poziomo wspólnego komponentu tabs; nie zawijają etykiet w przypadkowe dwa wiersze. Sterowanie seriami, jednostkami i zakresem przechodzi do kompaktowego toolbara lub responsywnego panelu, bez zasłaniania wykresu.

## 6. Inspectory

Każdy semantycznie odmienny węzeł ma dedykowany Inspector. Współdzielenie komponentu jest dozwolone wyłącznie wtedy, gdy panel otrzymuje jawny typed model odpowiadający temu samemu typowi pojęcia. Generyczny fallback nie może udawać prawidłowego panelu; nieznany `kind` kończy się jawnym unsupported Inspector.

Wspólny wizualny template Inspectorów opiera się na wzorcu aktualnych paneli Visualization dla Airbox/Object/Mesh Part:

1. breadcrumb i jednoznaczny tytuł;
2. status oraz krótki opis kontekstu;
3. zwarta sekcja najważniejszych właściwości;
4. sterowanie i akcje;
5. provenance;
6. diagnostyka i stany niedostępności.

Template oznacza wspólne primitive, spacing, typography, status rows, section headers i action bars. Nie oznacza identycznej zawartości dla różnych pojęć.

Wymagane dedykowane rodziny obejmują co najmniej:

- FMR Eigensolve Spectrum;
- FMR Eigensolve Mode;
- FMR Frequency-Driven Response Spectrum;
- FMR Resonance Peak;
- FMR Frequency Point i Response Field;
- Dispersion Diagram;
- k-Path;
- Mode Branch;
- Mode at k;
- Response Map;
- aktywną wizualizację eigenmode;
- aktywną wizualizację response field;
- provenance, progress, cancel-requested i diagnostics.

Inspector modu pokazuje częstotliwość, indeks/tożsamość modu, próbkę lub `k`, normalizację, status pola i provenance. Inspector punktu frequency-driven pokazuje częstotliwość wymuszenia, obserwable, amplitudę/fazę, status pola i provenance; nie nazywa odpowiedzi eigenmodem.

## 7. Handoff do Viewport 3D

Wynik pozostaje w `Results`, natomiast aktywny stan prezentacji jest widoczny w `Model → Object → Visualization`.

```text
Result node
   ↓ Visualize in 3D
AnalysisFieldOverlayController
   ↓
Viewport 3D
   ↓
Model → Object → Visualization → Active Mode Overlay
```

Eigensolve i Frequency-Driven zachowują odrębne źródła pola. Dostępne reprezentacje (`real`, `imag`, `abs`, `phase`, `phase_rotated_real`) oraz animacja są capability-aware. Surface opacity nie może niejawnie zmieniać opacity wireframe. Zmiana jakości wizualizacji nie jest automatycznym sposobem optymalizacji.

## 8. Responsywność, styl i dostępność

- Wszystkie klasy w `apps/control-room` używają prefiksu `fm-`.
- Komponenty konsumują `--fm-*`; surowe kolory nie trafiają do modułów.
- Tabs, tooltipy, menu, dialogi, selecty, przyciski i segmented controls korzystają ze wspólnych primitive shadcn/ui-style.
- Układ Inspectora działa w wąskim prawym panelu bez poziomego overflow.
- Tabele i wykresy mają jawne jednostki, klawiaturową inspekcję i bounded rendering.
- Tekst statusu nie jest kodowany wyłącznie kolorem.
- Reduced motion wyłącza animacje dekoracyjne, ale nie usuwa informacji o postępie.

## 9. Wydajność i lifecycle

- Hooki zasobów są aktywowane wyłącznie dla zakładki i aktywnej wizualizacji, która ich potrzebuje.
- Buildery nie przetwarzają surowych dużych artefaktów podczas każdego renderu.
- Modele wykresów są revision-keyed i bounded.
- Ukryta powierzchnia Analysis nie utrzymuje instancji wykresu, observerów ani workerów.
- Aktywny Viewport 3D może posiadać pętlę animacji zgodną z jego lifecycle; idle chart nie może posiadać własnego ciągłego redraw.
- Stress gate obejmuje wielokrotne przełączanie Dynamics/FMR/Dispersion/3D i powrót do bazowej liczby zasobów.

## 10. Stany błędów

Każda gałąź rozróżnia:

- `loading` — zasób jeszcze nie został rozstrzygnięty;
- `ready` — dane są zgodne z bieżącą tożsamością run/stage/domain;
- `stale` — istnieją dane, ale revision lub generation nie odpowiada bieżącemu kontekstowi;
- `degraded` — wynik częściowy albo fallback;
- `unsupported` — metoda lub reprezentacja nie jest legalna dla capability;
- `error` — publikacja lub odczyt zakończyły się błędem.

Partial artifacts po anulowaniu sweepu pozostają dostępne jako `degraded`, z jawną informacją o zakresie i przyczynie zakończenia.

## 11. Kryteria akceptacji

1. `Results` jest physics-first i nie zawiera niekwalifikowanego `Spectrum`.
2. FMR `k = 0` i dyspersja `f(k)` są osobnymi gałęziami.
3. Eigensolve i Frequency-Driven są jawnie rozdzielone pod każdą legalną gałęzią fizyczną.
4. Model, Results, Resources, Jobs i Diagnostics używają typed snapshotów i czystych builderów bez fikcyjnych placeholderów.
5. Każdy selekcjonowalny `kind` ma dedykowany route Inspector albo jawny unsupported panel.
6. Analysis używa tego samego słownika i poprawnych jednostek osi.
7. Visualize in 3D zachowuje źródło, tożsamość pola, representation i provenance.
8. Układ jest responsywny i korzysta ze wspólnych primitive oraz tokenów projektu.
9. Typecheck, API hygiene, lint i testy builder/selection/Inspector/Analysis przechodzą.
10. Browser smoke potwierdza na desktop i wąskim viewport: poprawne drzewo, dedykowane Inspectory, handoff do Analysis i 3D, widoczny canvas, zdrowy WebGL oraz niezerowy drawing buffer.
11. Audyt chart/viewport lifecycle przechodzi bez wycieku instancji, requestów i chart-owned idle redraw.

## 12. Migracja

Implementacja jest wykonywana pionowymi, test-first slice'ami:

1. typed snapshots i wspólny kontrakt builderów;
2. nowe physics-first ID oraz drzewo Results;
3. selection adapter i dedykowane routing Inspectora;
4. nazwy i descriptors Analysis;
5. uproszczenie `Model → Visualization` do aktywnego overlay;
6. resource-driven Resources/Jobs/Diagnostics;
7. responsywność i wspólny template;
8. testy integracyjne, browser smoke i performance/lifecycle gates;
9. usunięcie tymczasowej kompatybilności po migracji zapisanego stanu.

Nie powstaje druga równoległa architektura ani osobna aplikacja FMR/Dispersion. Wszystkie przepływy pozostają częścią jednego workspace, jednego Explorera, jednego Analysis i jednego Viewportu.
