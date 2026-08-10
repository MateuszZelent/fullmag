# Projekt spójnego Explorera, Inspectorów i analiz frequency-domain

**Status:** projekt do przeglądu użytkownika
**Data:** 2026-08-11
**Zakres:** frontend v2 Control Room
**Cel nadrzędny:** spójny, responsywny i semantycznie jednoznaczny model drzewa, Inspectorów oraz powierzchni analiz naukowych.

## 1. Kontekst i zależności

Ten dokument rozwija, a nie zastępuje, istniejące decyzje:

- `docs/superpowers/specs/2026-08-07-explorer-inspectors-regions-fdm-fem-remediation-design.md` pozostaje źródłem prawdy dla lane-neutral targetów, membership regionów, zasobów FEM/FDM i dowodów renderowania;
- `docs/superpowers/specs/2026-07-17-inspector-design-system-reference-slice-design.md` pozostaje źródłem prawdy dla token-first design systemu i referencyjnego wycinka Visualization Inspector;
- `docs/superpowers/specs/2026-08-02-live-charts-analysis-separation-design.md` oraz `docs/specs/frontend-v2/16-charts-analysis-module.md` pozostają źródłem prawdy dla rozdziału Live Charts, Analysis i Quick Chart;
- `docs/specs/frontend-v2/11-explorer-view.md`, `13-inspector-and-property-editing.md`, `09-css-design-system.md` i `18-testing-quality-gates.md` definiują istniejące kontrakty architektoniczne.

Nie zmieniamy w tym projekcie równań fizycznych, semantyki ProblemIR, publicznego API Python ani lane-neutral ownership membership. Zmiana dotyczy sposobu adresowania, komponowania i prezentowania już istniejących zasobów.

## 2. Dowody aktualnego stanu

Aktualny checkout ma już znaczną część wymaganej funkcjonalności, ale nie ma jeszcze jednego kontraktu obejmującego wszystkie powierzchnie:

- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts` ma około 2067 linii i łączy korzenie modelu, obiekty, Airbox, mesh, physics, study i część wyników;
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` ma około 854 linii; część frequency-domain jest już routowana dedykowanymi panelami, lecz Visualization nadal łączy `airbox.visualization`, `object.visualization`, `mesh-part-airbox` i `mesh-part` z jednym panelem;
- rejestr ma wildcard `selectionKinds: ["*"]`, który może ukryć brak kontraktu dla nowego wybieralnego węzła;
- `InspectorShell` posiada właściwy globalny lifecycle panelu, lecz identity icon jest obecnie ogólny, a panel-specific composition nadal korzysta z wielu historycznych klas CSS;
- `InspectorOverviewFrame`, `InspectorGroup`, `InspectorPropertyRow` i prymitywy formularzy już istnieją, ale nie są jeszcze obowiązkowym wspólnym językiem wszystkich paneli;
- `AnalysisPlotsView` i `AnalysisFrequencySurface` mają poprawne resource-first seams, ale workflow summary, chart, tabela, selection point i handoff do 3D nie tworzą jeszcze jednego descriptor-driven modelu dla każdej rodziny fizycznej;
- obecny test rejestru świadomie potwierdza, że Airbox i Object Visualization trafiają do `object-visualization`, co jest sprzeczne z wymaganiem jednoznacznego właściciela semantycznego każdego węzła.

Istniejące zmiany `external_solvers/3` są niezwiązane z tym projektem i muszą pozostać nienaruszone.

## 3. Cele i kryteria sukcesu

### 3.1. Cele

1. Każdy wybieralny semantyczny węzeł Explorera ma jawny i testowalny route do własnego Inspector ownera.
2. Różne znaczenia fizyczne nie są prezentowane przez jeden generyczny panel tylko dlatego, że mają podobne kontrolki.
3. Wszystkie panele korzystają z jednego, responsywnego template’u i jednego systemu tokenów.
4. Airbox, obiekt, mesh-part, region, mode, branch, response point i diagnostyka zachowują własne identity, status, provenance i akcje.
5. FMR/Frequency Response, eigenmode spectrum, dispersion i mode visualization są osobnymi workflowami, ale używają wspólnych neutralnych prymitywów wykresu, tabeli, statusu i selection.
6. Zmiany UI nie wprowadzają bezpośredniego `fetch()`, drugiego store’a zasobów, drugiego modelu fizycznego ani drugiego transportu.
7. Responsywność, keyboard navigation, 200% zoom, reduced motion i lifecycle WebGL/ECharts są mierzone dowodami, nie oceniane wyłącznie wizualnie.

### 3.2. Definicja ukończenia

Pierwszy pionowy wycinek jest ukończony dopiero wtedy, gdy:

- route coverage test obejmuje wszystkie wybieralne `ExplorerNodeKind` wygenerowane przez bieżące buildery;
- żaden znany kind nie korzysta z wildcardu jako normalnego fallbacku;
- węzły Visualization Airbox/Object/Mesh-part/Mode mają odrębne route’y i odrębne panele, nawet jeśli współdzielą adaptery i prymitywy;
- wszystkie panele referencyjnego zakresu używają `InspectorShell` oraz wspólnej kompozycji i nie mają lokalnego, konkurencyjnego systemu kontrolek;
- każdy wynik frequency-domain ma własny descriptor, semantyczny selection ref i Inspector owner;
- przejście wykres → node/Inspector → 3D overlay zachowuje identyczną tożsamość zasobu i revision;
- typecheck, lint, testy architektury, testy modelu i browser qualification przechodzą, a brakujące bramy pozostają jawnie oznaczone jako pending.

## 4. Decyzja architektoniczna

Wybieramy inkrementalną refaktoryzację kontraktu drzewa i routingu, a dopiero na nim budujemy ujednolicenie wyglądu. Nie wykonujemy jednorazowego przepisywania całego Explorera ani samej kosmetycznej zmiany CSS.

### 4.1. Jeden kontrakt węzła

Każdy wybieralny `ExplorerNode` publikuje semantyczny kontrakt:

```ts
interface ExplorerNodeContract {
  id: string;
  kind: ExplorerNodeKind;
  parentId: string | null;
  label: string;
  icon: ExplorerIconToken;
  status: ExplorerNodeStatus;
  selectionKind: SelectionKind;
  inspectorRouteId: InspectorRouteId;
  capability?: CapabilityGate;
  resourceIdentity?: string;
}
```

Konkretne nazwy typów zostaną dopasowane do istniejących `explorerTypes`, `selectionTypes` i `inspectorTypes`; istotna jest jedna własność: route nie może być odgadywany z etykiety, prefiksu stringa ani kolejności wpisów w rejestrze.

Stabilne ID pozostają kompatybilne. W szczególności zachowujemy istniejące tożsamości Airboxa, obiektów, regionów i wyników, a migrację starych targetów wykonujemy wyłącznie przez istniejący migrator display-state.

### 4.2. Rozdzielenie builderów

`buildModelTree.ts` staje się kompozytorem. Nowe granice odpowiedzialności:

```text
explorer/builders/
  buildModelTree.ts              # kolejność korzeni i składanie wyników
  modelRootNodes.ts              # session, universe, definitions, objects
  objectExplorerNodes.ts         # obiekt i jego semantic children
  airboxExplorerNodes.ts         # Airbox mesh, visualization, debug
  meshExplorerNodes.ts           # shared-domain, FDM grid, quality, builds
  physicsExplorerNodes.ts        # interaction graph i couplings
  studyExplorerNodes.ts          # stage/execution/recovery
  frequencyDomainExplorerNodes.ts
  resultExplorerNodes.ts
  explorerNodeContract.ts        # invariants i wspólne konstruktory
```

Buildery są pure functions. Nie pobierają zasobów, nie zmieniają selection i nie zawierają JSX. Resource hooks pozostają w module/kernel, a builder otrzymuje już ograniczone snapshoty.

### 4.3. Exact inspector routing

Rejestr otrzymuje jeden jawny katalog route’ów. Route ID jest typem brandowanym, a jego pełny zbiór wynika wyłącznie z deklaracji katalogu; przykładowe wpisy pokazują nazewnictwo, nie osobną listę równoległą do implementacji:

```ts
type InspectorRouteId = string & {
  readonly __brand: "InspectorRouteId";
};

const INSPECTOR_ROUTE_CATALOG = createInspectorRouteCatalog({
  "airbox.overview": airboxOverviewPanel,
  "airbox.visualization": airboxVisualizationPanel,
  "object.overview": objectOverviewPanel,
  "object.visualization": objectVisualizationPanel,
  "frequency-domain.fmr-spectrum": fmrModalSpectrumPanel,
  "frequency-domain.fmr-response": fmrResponsePanel,
  "frequency-domain.eigen-dispersion": eigenDispersionPanel,
  "frequency-domain.diagnostics": frequencyDiagnosticsPanel,
});
```

`createInspectorRouteCatalog` waliduje unikalność i kształt wpisów, a route coverage test wymaga kompletności względem wszystkich `ExplorerNodeKind`; powyższe wpisy są skróconym przykładem wyłącznie dla opisanych rodzin. Katalog jest mapą `InspectorRouteId -> InspectorPanelContribution`. `SelectionKind -> InspectorRouteId` jest mapą exact-match, a nie tablicą z first-match semantics. `*` może pozostać wyłącznie jako developerski bezpiecznik, który renderuje widoczny błąd kontraktu i emituje diagnostykę; nie jest legalnym route’em dla node kind obecnego w katalogu.

Współdzielenie panelu jest zabronione dla różnych znaczeń fizycznych. Dopuszczone jest współdzielenie:

- pure formatterów i resource adapterów;
- `InspectorShell` i prymitywów form/layout;
- neutralnego modelu debug, jeśli route owner tworzy osobny panel-wrapper z własnym tytułem, opisem, targetem i akcjami;
- rendererów wykresów, tabel i colorbarów, jeśli descriptor dostarcza semantykę osi i jednostek.

## 5. Model Inspectorów i design system

### 5.1. Warstwy layoutu

Każdy Inspector składa się z czterech warstw:

1. `InspectorShell` — breadcrumbs, identity, status, tabs, scroll body i action bar;
2. `InspectorOverviewFrame` — summary/hero selection, krótki opis, status i primary action;
3. `InspectorGroup` — semantyczna sekcja bez zbędnego zagnieżdżania kart;
4. `InspectorPropertyRow`, `FieldRow`, `FormField`, `ValidationMessage` — jednolita prezentacja wartości, jednostek i błędów.

Panel nie tworzy własnego globalnego headera, action bara ani równoległych wariantów inputów.

### 5.2. Identity i hierarchia

Descriptor panelu dostarcza:

- ikonę węzła zamiast wspólnego `Box` dla wszystkich selekcji;
- tytuł domenowy i krótką nazwę typu;
- status lifecycle oraz osobny scientific trust/provenance state, gdy dotyczy wyniku;
- revision/resource identity;
- breadcrumbs prowadzące do rodzica bez zmiany semantycznego selection;
- akcje dopuszczone przez capability i edit session.

Wizualna hierarchia opiera się przede wszystkim na typografii, odstępach, alignmencie i kontrastach tokenów. Zagnieżdżone obramowane karty są zastępowane sekcjami i separatorami; border pozostaje sygnałem granicy lub błędu, nie domyślną dekoracją każdej grupy.

### 5.3. Tokeny, Tailwind i shadcn

- wartości kolorów, spacingu, radiusu, typografii i stanów pochodzą wyłącznie z `--fm-*`;
- Tailwind służy do lokalnej geometrii i responsywnego layoutu, używając tokenów;
- shadcn/Radix pozostaje właścicielem tabs, select, dialog, dropdown, switch, segmented control, tooltip i resizable behavior;
- nowe klasy CSS zawsze mają prefix `fm-`;
- `app/globals.css` pozostaje import-only;
- CSS specyficzny dla domeny trafia do `src/design/styles/*` lub jawnie nazwanej warstwy modułu;
- usuwamy tylko reguły, które stały się osierocone po migracji panelu; nie wykonujemy pobocznego formatowania.

### 5.4. Responsywność

Inspector jest projektowany dla szerokości panelu, nie tylko dla szerokości viewportu:

- label/control przełącza się na stacked layout przy wąskim panelu;
- wartości liczbowe nie mogą wypychać jednostek ani przycisków poza panel;
- długie ID, revision i provenance używają kontrolowanego truncation z pełną wartością w tooltipie/accessible name;
- tabele dostają poziomy overflow z nagłówkiem sticky tylko wtedy, gdy nie degraduje keyboard navigation;
- 200% zoom zachowuje czytelność, focus ring i dostęp do primary actions;
- `prefers-reduced-motion` wyłącza transform/opacity transitions bez zmiany stanu;
- breakpointy i container queries nie zmieniają semantyki ani nie tworzą drugiego layoutu aplikacji.

## 6. Macierz własności paneli

Poniższe route’y są wymaganym kierunkiem. Konkretne nazwy komponentów mogą pozostać kompatybilne z istniejącymi panelami, jeśli ich odpowiedzialność zostanie jednoznacznie zawężona.

| Węzeł | Inspector owner | Współdzielone tylko jako |
|---|---|---|
| `airbox.root` | Airbox overview | resource formatters |
| `airbox.mesh` | Airbox mesh overview | mesh summary adapters |
| `airbox.mesh.parameters` | Airbox mesh parameters | numeric field primitives |
| `airbox.mesh.quality-gates` | Airbox quality gates | status rows |
| `airbox.mesh.statistics` | Airbox statistics | bounded table primitives |
| `airbox.mesh.topology` | Airbox topology | topology formatters |
| `airbox.mesh.build` | Airbox build | command/status primitives |
| `airbox.visualization` | Airbox visualization | visualization controls model |
| `airbox.visualization.debug` | Airbox visualization debug | bounded debug data adapter |
| `object.root` | Object overview | object resource adapters |
| `object.visualization` | Object visualization | visualization controls model |
| `object.visualization.debug` | Object visualization debug | bounded debug data adapter |
| `mesh-part` | Mesh-part visualization | target carrier adapter |
| `object.mode_visualization` | Mode visualization overview | mode display primitives |
| `object.mode_visualization.group` | Mode group | mode field list primitives |
| `object.mode_visualization.field` | Mode field | colorbar/field metadata primitives |
| `object.mode_visualization.view` | Mode view | phase/render controls |
| `results.frequency_domain.fmr_modal_spectrum` | FMR modal spectrum | chart/table renderer |
| `results.frequency_domain.fmr_response_sweep` | FMR driven response | chart/table renderer |
| `results.frequency_domain.dispersion` | Dispersion | branch/chart renderer |
| `results.eigen.mode` | Eigen mode | mode provenance and 3D handoff primitives |
| `results.eigen.branch` | Eigen branch | k-path and branch primitives |
| frequency diagnostics | Frequency diagnostic owner | status/provenance primitives |

Pozostałe kinds otrzymają analogiczny wpis w katalogu. Tabela nie jest allowlistą zamykającą pozostałe węzły; test coverage ma wymusić aktualizację route catalogu przy każdym nowym kind.

## 7. UX analiz frequency-domain

### 7.1. Descriptor powierzchni

Każda powierzchnia analityczna ma descriptor:

```ts
interface AnalysisSurfaceDescriptor {
  surface: AnalysisSurface;
  title: string;
  xAxis: AxisDescriptor;
  yAxes: readonly AxisDescriptor[];
  selectionKind: SelectionKind;
  inspectorRouteId: InspectorRouteId;
  supportedViews: readonly string[];
  handoff: "mode-overlay" | "response-overlay" | "branch-overlay" | "none";
}
```

Descriptor nie posiada danych liczbowych ani nie tworzy requestów. Model zasobu dostarcza dane, revision, provenance i qualification/trust.

### 7.2. FMR modal spectrum

Powierzchnia pokazuje:

- częstotliwość rezonansową z jednostką Hz i właściwym SI display scaling;
- linewidth/damping, jeśli manifest go publikuje;
- mode index/branch/k-point oraz provenance equilibrium/operator/solver;
- widoczność serii, punkt wybrany i status zasobu;
- kontrolę `phase-rotated real`, `real`, `imag`, `abs`, `phase` oraz animation wyłącznie dla wybranego mode;
- explicit `Plot in 3D`/`Animate in 3D` handoff, który publikuje semantic selection ref.

Nie mieszamy modal spectrum z driven response na jednej osi ani nie przedstawiamy niedostępnego pola jako gotowego overlay.

### 7.3. Frequency-driven response

Powierzchnia pokazuje sweep i wybraną częstotliwość, response quantity, phase/magnitude, peak/resonance summary, status obliczenia, cancellation/progress i provenance. Punkt response ma własny Inspector, który nie jest kopią mode Inspectora. Overlay 3D jest dostępny tylko, gdy istnieje zgodny response field resource i revision.

### 7.4. Dispersion

Dispersion rozdziela:

- k-path/branch configuration;
- branch data i units `k`, `f`;
- selected branch point;
- linewidth/quality/warning metadata;
- mode overlay handoff.

Tooltipy i tabele używają nazw fizycznych, jednostek SI i bounded rows. `path_s` nie jest przedstawiane jako częstotliwość, a etykieta k-point nie zastępuje wartości liczbowej bez jawnego opisu.

### 7.5. Status i zaufanie naukowe

Lifecycle `loading`, `refreshing`, `stale`, `ready`, `unsupported`, `error` jest osobny od scientific trust/qualification. Background refresh zachowuje ostatni poprawny wykres i pokazuje nieblokujący status. Brak manifestu lub niezgodna rodzina danych blokuje renderowanie z wyjaśnieniem, zamiast tworzyć pusty sukces.

## 8. Przepływ danych i własność stanu

```text
v2 HTTP resource
  -> generated transport / ControlRoomApi facade
  -> revision-aware resource hook
  -> pure domain adapter / chart descriptor
  -> Explorer selection or Analysis selection
  -> exact Inspector route
  -> InspectorShell + route-specific panel
  -> explicit command for 3D field/mode handoff
```

Zasady:

- HTTP resources są źródłem prawdy; WebSocket tylko unieważnia revision;
- moduły nie wykonują bezpośredniego `fetch()` ani nie składają endpoint strings;
- resource snapshots i ciężkie arrays nie trafiają do store’a UI;
- kernel selection przechowuje małą semantic ref, nie snapshot panelu;
- draft edits przechodzą przez `InspectorEditSession` i jawny transaction;
- display preferences mogą być auto-applied wyłącznie tam, gdzie nie zmieniają physics/mesh/material/study;
- analiza nie zmienia kamery, warstw ani quantity viewportu bez jawnej, cancellable komendy.

## 9. Obsługa błędów

- brak route’u dla znanego kind: widoczny `Inspector contract error` i diagnostyka, nie generyczny pusty panel;
- brak resource: jawne `not configured`, `unsupported`, `stale` albo `not published`, zależnie od źródła;
- błędna revision/identity: zachowanie poprzedniego poprawnego renderu i status degraded/stale;
- błąd command/transaction: komunikat przy odpowiedniej sekcji/polu, draft pozostaje zachowany;
- niezgodny manifest frequency-domain: brak requestów do obcej rodziny i opis przyczyny;
- niespełnione capability: control pozostaje widoczny tylko wtedy, gdy wyjaśnia powód niedostępności;
- clipboard/export failure: niedestrukcyjny feedback w ownerze akcji;
- backend rejection nie jest zamieniany na generic toast bez kontekstu pola, zasobu i revision.

## 10. Wydajność i lifecycle

- route lookup jest O(1) i nie tworzy komponentów przy każdym renderze;
- buildery są memoizowane po jawnych snapshot revisions, a niezwiązane zmiany nie przebudowują całego drzewa;
- duże listy węzłów, tabel i punktów są bounded/virtualized/decimated;
- ECharts ma jednego ownera na zamontowaną surface, resize przez `ResizeObserver`, dispose przy unmount i brak polling/idle redraw;
- Inspector nie ładuje ciężkich resource hooks, dopóki route nie jest aktywny;
- zmiana display unit/series/phase korzysta z danych już w cache, jeśli identity/revision się nie zmienia;
- viewport utrzymuje `frameloop="demand"`, camera/topology/buffers i idle budget przy otwieraniu Quick Chart/Inspector;
- nie obniżamy domyślnej jakości renderingu jako pierwszej optymalizacji.

## 11. Plan migracji

### Faza A — katalog i coverage

1. Zidentyfikować wszystkie wybieralne kinds rzeczywiście generowane przez pięć zakładek Explorera.
2. Dodać route catalog i kontrakt node → selection → Inspector.
3. Wprowadzić coverage test oraz developerski error route.
4. Zachować istniejące stable IDs i migracje targetów.

### Faza B — builder i reference Inspector

1. Rozdzielić `buildModelTree.ts` na buildery domenowe.
2. Zmigrować Airbox i Object Visualization do odrębnych ownerów.
3. Ujednolicić `InspectorShell` identity/icon/status i reference composition Visualization.
4. Usunąć nieużywane reguły CSS wyłącznie w zasięgu przeniesionych paneli.

### Faza C — wszystkie semantic children

1. Rozdzielić Mode Visualization levels.
2. Rozdzielić mesh-part/region/debug ownerów.
3. Pokryć Resources, Results, Jobs i Diagnostics dedykowanymi overviewami.
4. Usunąć normalne użycie wildcardu dla znanych kinds.

### Faza D — analysis surfaces

1. Wprowadzić surface descriptors.
2. Przepiąć FMR modal spectrum, driven response, dispersion i eigen mode point na własne route owners.
3. Ujednolicić chart/table/legend/unit/status primitives bez łączenia znaczeń fizycznych.
4. Zweryfikować selection → Inspector → 3D overlay dla mode, branch i response point.

### Faza E — kwalifikacja

1. Typecheck, lint, unit/model/architecture tests.
2. Browser flows każdego wybieralnego kindu, bez PlaceholderPanel i nieoczekiwanych request errors.
3. Mocha/Latte, keyboard, reduced motion, 200% zoom, narrow/wide inspector.
4. WebGL context/drawing-buffer smoke po powrocie z analysis do viewportu.
5. Raport w języku polskim z rozdziałem implemented/partial/production-executable/validated.

## 12. Strategia testów

### Kontrakty drzewa i routingu

- każdy wygenerowany wybieralny kind ma route i panel;
- route jest stabilny dla tego samego selection kind;
- znane kinds nie rozwiązują się przez wildcard;
- każdy panel ma właściwy title/type/icon i nie dziedziczy przypadkowo identity rodzica;
- selection path/breadcrumbs zachowuje stabilne node IDs.

### Design system i Inspector

- każdy reference panel renderuje wspólny shell/frame/group/property-row;
- light/dark i token scan nie wykrywają raw colors w komponentach;
- klasy CSS mają prefix `fm-`;
- keyboard focus, aria labels, disabled/invalid/stale/dirty states są obecne;
- narrow panel i 200% zoom nie obcinają jednostek, action bar ani błędów;
- draft isolation, reset/apply i failed commit zachowują kontrakt edit session.

### Frequency-domain

- osobne route’y i tytuły dla FMR spectrum, response, dispersion, eigen branch/mode;
- poprawne osie, jednostki i nieprefiksowane dimensionless quantities;
- selected series/point nie wykonuje requestu, jeśli dane są już w cache;
- stale refresh zachowuje poprzedni wykres;
- unsupported/mismatched manifest nie tworzy sukcesu;
- 3D handoff publikuje właściwy semantic ref i nie zmienia niepowiązanego viewport state.

### Browser i wydajność

- wszystkie semantic nodes są wybieralne i mają właściwy Inspector;
- brak console errors, nieoczekiwanych 4xx/5xx i direct fetch w module/component;
- canvas po analysis handoff ma widoczny element, non-zero drawing buffer i zdrowy WebGL context;
- ECharts dispose, observer/listeners/object URLs są zwalniane;
- idle workspace nie wykonuje requestów, redrawów ani render-loop work.

## 13. Poza zakresem

- zmiana równań fizycznych, solverów, ProblemIR lub publicznego API Python;
- nowy backend/resource endpoint bez dowodu istniejącej luki kontraktu;
- osobne aplikacje lub drzewa dla FDM i FEM;
- drugi viewport WebGL lub panelowy fork workspace;
- wprowadzenie konkurencyjnego frameworka CSS/UI;
- ukrywanie brakujących zasobów przez hardcoded fake data;
- jednorazowy rewrite całego frontendu bez faz i dowodów.

## 14. Niezmienniki akceptacyjne

1. Jeden unified Explorer i jeden Inspector registry dla FDM/FEM.
2. Każdy wybieralny node kind ma dedykowany owner i nie wpada normalnie do wildcardu.
3. Stabilne semantic IDs, resource identity i revision są zachowane przez wybór, Inspector i viewport handoff.
4. Wszystkie panele korzystają z jednego token-first design systemu i responsywnego template’u.
5. Analizy nie mieszają odmiennych jednostek, statusów ani znaczeń fizycznych na jednej powierzchni bez jawnej kontroli.
6. HTTP v2/resource hooks pozostają jedyną drogą danych; ciężkie payloady nie trafiają do statusu ani UI store.
7. Wydajność i WebGL/ECharts lifecycle są dowiedzione testami/runtime smoke, nie tylko typecheckiem.
8. Każdy raport końcowy oddziela implementację, gotowość produkcyjną i walidację.
