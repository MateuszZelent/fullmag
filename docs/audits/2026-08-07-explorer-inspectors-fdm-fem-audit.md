# Audyt Explorera i inspektorów Control Room dla FDM i FEM

Data audytu: 2026-08-07  
Zakres: całe drzewo `Model`, `Resources`, `Results`, `Jobs`, `Diagnostics`, mapowanie selekcji na Inspector oraz rzeczywiste sesje FDM i FEM.  
Status: **niekwalifikowane do zamknięcia produktowego** — hierarchia Model jest w większości sensowna, ale pozostałe zakładki zawierają dane statyczne, fałszywe gałęzie i placeholdery. Wykryto też dwa błędy liczników mesha oraz niespójność tożsamości Airboxa FDM.

## 1. Metoda i granice dowodu

Audyt objął cztery tory:

1. statyczne przejście `ExplorerNodeKind -> ExplorerNode -> SelectionRef -> inspectorRegistry -> panel`;
2. automatyczne kliknięcie wszystkich wybieralnych węzłów w pięciu zakładkach na żywej sesji FDM i żywej sesji FEM;
3. porównanie tekstu inspektorów z zasobami runtime i manifestami mesha;
4. przegląd kontraktów modułowych, fallbacków i globalnych akcji Inspector Shell.

Sesja FDM miała siatkę `20 × 12 × 6 = 1440` komórek: 120 komórek magnetycznych i 1320 komórek Airboxa. Sesja FEM miała wspólną siatkę 921 tetraedrów i 207 węzłów: 141 elementów filmu, 780 elementów powietrza oraz 180 ścian granicy zewnętrznej. Audyt nie ocenia poprawności solvera ani fizycznej jakości rozwiązania; ocenia prawdziwość i użyteczność Explorera/Inspectorów względem już opublikowanych zasobów.

## 2. Werdykt

| Obszar | FDM | FEM | Werdykt |
|---|---:|---:|---|
| Model: geometria, obiekty, materiały, fizyka | częściowo poprawny | częściowo poprawny | struktura dobra, kilka sprzecznych statusów |
| Universe / Airbox | rozbudowany, lecz dubluje Mesh i rozszczepia target | bogaty i zasadniczo sensowny | wymaga porządkowania kontraktu |
| Mesh | dobry model siatki strukturalnej, błędny mesh obiektu | sensowny model wspólnej siatki, błędne Boundary Faces | blokujące błędy danych |
| Resources | statyczne wartości i placeholdery | statyczne wartości i placeholdery | nieakceptowalne |
| Results | fałszywy Frequency Domain, zła jednostka `m`, placeholder | to samo | nieakceptowalne |
| Jobs | fałszywy Frequency Domain i statyczna kolejka | to samo | nieakceptowalne |
| Diagnostics | fałszywy Frequency Domain i placeholder cache | to samo | nieakceptowalne |
| Pokrycie rodzajów węzłów przez panele | wildcard ukrywa braki | wildcard ukrywa braki | testy nie chronią jakości semantycznej |

Najważniejszy wniosek: `Model` jest zasilany zasobami sesji, natomiast `Resources`, `Results`, `Jobs` i `Diagnostics` są nadal w znacznej części demonstracyjnym szkieletem. Wyświetlanie ich jako `ready` tworzy fałszywy obraz stanu naukowego i wykonawczego.

## 3. Znaleziska blokujące

### P0-1. Frequency Domain jest zawsze wstawiany do zwykłych sesji czasowych

Objaw występuje identycznie dla FDM i FEM. W sesjach bez etapu frequency-domain Explorer pokazuje rozbudowane gałęzie Frequency Domain w `Resources`, `Results`, `Jobs` i `Diagnostics`. Widać statusy typu `ready`/`running`, artefakty i capability, mimo że sesja nie posiada odpowiedniego etapu ani manifestu wynikowego.

Przyczyna jest bezpośrednia: `buildExplorerTree()` bezwarunkowo wywołuje wszystkie cztery buildery Frequency Domain. Brak manifestu zmienia jedynie status na `stale`/`missing`; nie usuwa nieistniejącej rodziny produktu. `buildFrequencyDomainJobsNode()` dodatkowo konstruuje drzewo oczekiwania nawet bez manifestu.

Skutek:

- użytkownik nie może odróżnić funkcji dostępnej platformowo od funkcji obecnej w bieżącym problemie;
- zwykła symulacja wygląda jak uruchomiony lub częściowo gotowy frequency-domain workflow;
- frontend odpytuje opcjonalne zasoby, generując m.in. 404 dla `response/cancel-requested.v1`;
- statusy nie są resource-first ani capability-gated.

Naprawa: gałęzie powinny istnieć tylko, gdy ProblemIR/study zawiera odpowiedni etap lub gdy sesja publikuje manifest/artefakty tej rodziny. Capability platformy może być pokazane w osobnym katalogu dostępnych funkcji, ale nie jako zasób/wynik/job bieżącej sesji.

### P0-2. Mesh obiektu FDM używa niepasującej tożsamości regionu

Dla `Object -> film -> Mesh` Inspector pokazał `Total cells 1440` oraz `0 active · 1320 outside support`, choć runtime publikuje 120 aktywnych komórek filmu i 1320 komórek Airboxa. Panel wyświetla również `Region metadata: none for selected object`.

Model `resolveFdmObjectMeshInspectorModel()` liczy komórki tylko dla rekordów legendy zgodnych jednocześnie z `regionId` i `objectId`. Gdy authoringowy identyfikator regionu przekazany przez Object Inspector nie jest identyczny z kanoniczną legendą membership, zbiór aktywnych numeric IDs jest pusty. Licznik komórek nieaktywnych nadal zlicza globalny sentinel Airboxa, przez co powstaje pozornie poprawna, ale fałszywa suma częściowa.

Naprawa: selection musi przenosić kanoniczny region ID z membership albo panel musi rozwiązać mapowanie `object -> canonical region legend` przed dekodowaniem maski. Test regresyjny musi używać rzeczywistego przypadku 120/1320 i odrzucać stan `ready`, gdy aktywne + inactive nie opisują pełnego, jednoznacznego podziału.

### P0-3. FEM Boundary Faces czyta błędny licznik

Inspector `Boundary Faces` pokazał `0`, mimo że carrier `part:outer_boundary` zawiera 180 wpisów `boundary_face_indices`. Panel sumuje wyłącznie `carrier.boundary_face_count`. W aktualnym manifeście pole skalarne ma wartość 0, a właściwy zbiór jest opublikowany jako tablica indeksów.

Naprawa: ujednolicić kontrakt backendu i UI. Preferowane jest naprawienie publikacji `boundary_face_count` i walidacja `count === boundary_face_indices.length`; Inspector nie powinien zgadywać przy sprzecznym manifeście, lecz pokazać diagnostykę niespójności.

### P0-4. Resources/Results/Jobs/Diagnostics zawierają hardkodowane dane udające runtime

W `buildExplorerTree()` wpisano na stałe:

- `Published fields` z badge `m, H_demag` i statusem `ready`;
- `Mesh topology` z `revision 0` i statusem `stale`;
- `Magnetization` z jednostką `A/m` i statusem `ready`;
- `Command queue` z `idle`;
- `Resource cache` z `revision-driven`.

Jest to niezgodne z aktualnymi sesjami: katalog pól zawiera więcej quantities, FEM miał bieżącą rewizję mesha inną niż 0, a `m` jest znormalizowaną magnetyzacją o jednostce `1`, nie `A/m`.

Naprawa: wszystkie te węzły budować z kanonicznego katalogu quantities, statusu sesji, rewizji zasobów oraz command state. Jeśli zasobu nie ma, wyświetlać `unavailable/not published`, nigdy wymyślone `ready`.

## 4. Znaleziska wysokiego priorytetu

### P1-1. Wildcard Inspector maskuje brak rzeczywistych inspektorów

Unia `ExplorerNodeKind` ma 199 rodzajów, a jawne wpisy registry obejmują 179. Część z pozostałych 20 jest celowo niewybieralnymi folderami lub jest remapowana do innego rodzaju selekcji. Jednak następujące aktywne węzły kończą w `PlaceholderPanel`: rooty `Resources`, `Results`, `Jobs`, `Diagnostics`, `Published fields`, `Magnetization`, `Command queue` i `Resource cache`.

Wildcard `selectionKinds: ["*"]` gwarantuje, że technicznie zawsze „jakiś panel” się otworzy. Obecny test utrwala nawet placeholder dla `results.field_quantity`. To jest zielony test implementacji zastępczej, nie test kompletności produktu.

Naprawa: dodać test allowlisty celowo niewybieralnych folderów oraz wymagać dedykowanego panelu dla każdego wybieralnego rodzaju. Placeholder dopuścić tylko w development z widocznym błędem kontraktu.

### P1-2. Airbox FDM ma dwie tożsamości wizualizacyjne

Explorer używa wspólnej nazwy `Airbox`, ale `explorerSelection.ts` jawnie remapuje jego Visualization/Debug na `type: fdm-domain` i target `fdm-universe-outside-support`. Równolegle renderer został już skierowany na kanoniczny target `airbox`. Inspector nadal więc opisuje inną tożsamość niż ścieżka renderowania.

To rozszczepienie może ponownie powodować różne ustawienia display, field target, mask i debug dla tego samego Airboxa. Komentarz w kodzie utrwala podział zamiast go usuwać.

Naprawa: jeden publiczny semantic target `airbox` w obu lane’ach. FDM/FEM różnią się carrier resolverem (`structured outside-support mask` kontra `FEM mesh parts`), nie identyfikatorem celu użytkownika.

### P1-3. Drzewo FDM dubluje tę samą siatkę w dwóch miejscach

FDM prezentuje zarówno `Universe -> Airbox -> Mesh -> Parameters/Quality/Statistics/Topology/Build`, jak i osobne `Mesh -> Structured Grid -> Descriptor/Mask/Regions/Provenance`. Pierwsza gałąź naśladuje FEM, choć topologia elementowa, standalone build i FEM quality są poprawnie oznaczone jako N/A.

Lepszy podział odpowiedzialności:

- `Universe/Airbox`: fizyczny zakres domeny, bounds, membership Airboxa, pole i display;
- `Mesh/Structured Grid`: descriptor, maska aktywności, region legend, rewizja i provenance;
- `Mesh/FEM`: części, topologia, quality gates, size fields i build.

Obecne dublowanie zwiększa ryzyko sprzecznych liczników i nie daje użytkownikowi dwóch różnych decyzji.

### P1-4. FEM Airbox nie pokazuje pełnej semantyki maski

Panel Statistics pokazuje 207 carrier nodes i 780 elementów powietrza, ale nie eksponuje 145 węzłów należących wyłącznie do powietrza. Węzły interfejsu są współdzielone z ferromagnetykiem. Dla wizualizacji pól jest to zasadnicza różnica: carrier geometry, exclusive-air mask i magnetic mask nie są tym samym zbiorem.

Naprawa: pokazać osobno `carrier nodes`, `exclusive air nodes`, `shared interface nodes`, `air elements` oraz identyfikator/revision maski użytej do filtrowania pola. Analogiczny zestaw powinien istnieć dla każdego obiektu ferromagnetycznego.

### P1-5. Zapisany display state może być niemożliwy dla celu

FEM Airbox Inspector pokazał zapisany tryb `surface`, a jednocześnie komunikat, że zapisany tryb nie jest dostępny dla tego targetu. Stan kanoniczny dopuszcza więc konfigurację, której target nie może wykonać.

Naprawa: przy zmianie capability/carriera wykonać jawne v2 state migration lub zachować wartość jako `requested` i publikować osobno `resolved` z przyczyną fallbacku. Nie wolno jednocześnie przedstawiać jej jako bieżącej wartości i jako niedostępnej.

### P1-6. Object General miesza authoring geometry z realized mesh

W obu lane’ach Object General pokazuje `Mesh: primitive-only`, podczas gdy węzeł obiektu ma status `mesh-ready`, a runtime posiada zrealizowaną siatkę/grid. Najprawdopodobniej Inspector odczytuje reprezentację sceny authoringowej, a badge Explorera stan wykonawczy.

Naprawa: rozdzielić pola na `Geometry source` i `Realized discretization`. Nie używać jednej etykiety `Mesh` dla dwóch warstw kontraktu.

## 5. Znaleziska średniego priorytetu

### P2-1. Debug Airboxa FDM jest martwym końcem

Panel informuje, że visualization debug nie dotyczy lane’u FDM. To błędny model produktu. FDM powinien publikować co najmniej: grid fingerprint, membership revision, liczbę komórek targetu, field sample count, mask coverage, render mode, glyph budget i resolved carrier.

### P2-2. Opcjonalne interaction resources generują błędy konsoli

W sesji FEM odnotowano 404 dla nieobecnych `uniaxial_anisotropy` i `interfacial_dmi`. Nieobecna opcjonalna interakcja nie powinna wyglądać jak awaria. Hook powinien być włączany przez snapshot/capability albo klient powinien normalizować oczekiwane 404 do stanu `not configured` bez `console.error`.

### P2-3. Globalne akcje Inspector Shell nie zależą od rodzaju selekcji

`Focus` jest zawsze aktywny, także dla jobs, diagnostics i resource roots; `Isolate` jest zawsze wyłączony. Akcje powinny pochodzić z descriptor/capability panelu. Globalny przycisk bez sensownego działania obniża wiarygodność interfejsu.

### P2-4. Copy node ID omija wspólny adapter schowka

Inspector Shell wywołuje bezpośrednio `navigator.clipboard?.writeText`, mimo że repo posiada wspólny adapter z fallbackiem. To tworzy rozbieżne zachowanie w kontekstach bez Clipboard API.

### P2-5. `Visualizations 2D` zachowuje starszy model produktu

Drzewo nadal buduje `Visualizations 2D` z cross-section workspace obok nowszych Planar Monitors i Results. Powinno to zostać skonsolidowane: authoring monitorów w Model, wyniki map 2D w Results, a stary cross-section-image tylko jako jawny compatibility export/fallback.

## 6. Co działa sensownie

- Główna hierarchia `Session Model -> Definitions / Universe / Objects / transport / Mesh / Study` jest zgodna z jednym workspace i wspólnym modelem FEM/FDM.
- Foldery `session.root`, `definitions.root`, `universe.root`, `objects.root` są celowo niewybieralne; to spójniejsze niż wybieralne rooty z placeholderem.
- FDM `Structured Grid` ma dedykowany Inspector i prawidłowo rozróżnia descriptor, maskę, magnetic support, inactive/outside-support, regiony i provenance.
- FEM Airbox ma osobne panele Parameters, Quality Gates, Statistics, Topology i Build; braki w publikacji są zazwyczaj oznaczone uczciwie jako `not published` zamiast wymyślanych wartości.
- FDM Airbox Statistics poprawnie pokazał 1440 wszystkich komórek, 1320 Airboxa i 120 magnetic support.
- Panele fizyki są wspólne dla FEM/FDM, co jest właściwe: lane nie powinien tworzyć dwóch modeli fizycznych. Wymagają jednak testów capability oraz poprawnego wyciszenia nieobecnych interakcji.
- Explorer rows mają semantykę wyboru, statusy i sterowanie expand/collapse; problemem nie jest podstawowa mechanika drzewa, tylko prawdziwość danych i kompletność paneli.

## 7. Docelowy kształt drzewa

```text
Model
├─ Definitions
├─ Universe
│  ├─ Airbox
│  │  ├─ Scope & membership
│  │  ├─ Visualization
│  │  └─ Debug
│  └─ Boundary Faces (FEM, gdy istnieją)
├─ Objects
│  └─ <object>
│     ├─ Geometry
│     ├─ Regions
│     ├─ Material
│     ├─ Physics
│     ├─ Initial state / texture
│     └─ Visualization / debug
├─ Mesh
│  ├─ Structured Grid (FDM)
│  └─ Shared Domain Mesh (FEM)
└─ Study

Resources       tylko faktycznie opublikowane zasoby + revision/freshness
Results         tylko wyniki istniejących etapów, z units i provenance
Jobs            tylko rzeczywiste run/stage/command resources
Diagnostics     tylko aktualne diagnostyki i capability bieżącej sesji
```

## 8. Kolejność napraw

1. **Gate Frequency Domain** przez stage/manifest i usunąć wszystkie statyczne statusy `ready`.
2. **Naprawić tożsamość regionu FDM** w Object Mesh oraz dodać test 120/1320.
3. **Naprawić kontrakt Boundary Faces FEM** i walidację count/indices.
4. **Zasilić Resources/Results/Jobs/Diagnostics** realnymi resource hooks; poprawić jednostkę `m` na `1`.
5. **Usunąć split targetu Airbox FDM** i przeprowadzić display-state migration v2 do jednego targetu `airbox`.
6. **Zastąpić placeholdery** dedykowanymi overview panelami albo ustawić rooty jako niewybieralne.
7. **Rozdzielić authoring od realized discretization** w Object Inspector.
8. **Ujednolicić mask diagnostics** dla Airboxa i wszystkich ferromagnetyków w FEM/FDM.
9. **Skonsolidować 2D** pod Planar Monitors/Results.
10. Dodać browser gate, który dla minimalnych sesji FDM i FEM klika każdy wybieralny węzeł i odrzuca: placeholder, niespodziewany 404, niemożliwy status, brak jednostki/provenance oraz gałąź nieobecną w study.

## 9. Kryteria zamknięcia

Audyt można uznać za naprawiony dopiero, gdy:

- żadna zakładka nie pokazuje nieistniejącego workflow;
- każdy wybieralny węzeł ma dedykowany, znaczący Inspector;
- badge/status/unit/revision pochodzą z bieżącego zasobu, nie z literału w builderze;
- FDM Object Mesh pokazuje 120 active i 1320 outside-support dla sesji dowodowej;
- FEM Boundary Faces pokazuje 180 i kontrakt count/indices jest spójny;
- Airbox ma jeden semantic target w FDM i FEM, z lane-specific carrierem;
- Inspector maski rozróżnia air-only, magnetic-only i shared-interface ownership;
- browser smoke przechodzi bez nieoczekiwanych 4xx/5xx i błędów konsoli;
- przed/po są potwierdzone zrzutami dla Model, Resources, Results, Jobs i Diagnostics w obu lane’ach.

## 10. Dowody wizualne

Zrzuty z bieżącego audytu zapisano poza repozytorium, aby nie mieszać artefaktów testowych ze źródłami:

- `fdm-model-explorer-inspector.png`
- `fdm-results-explorer-inspector.png`
- `fem-model-explorer-inspector.png`
- `fem-results-explorer-inspector.png`

Katalog: `/mnt/c/Users/Mateusz/.codex/visualizations/2026/08/07/019fdb57-8c10-7ac2-9f1e-185e370ec524/`.

## 11. Mapa źródeł odpowiedzialnych za regresje

- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`: bezwarunkowe i hardkodowane gałęzie pozamodelowe;
- `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`: drzewa Frequency Domain również przy braku manifestu;
- `apps/control-room/src/modules/explorer/explorerSelection.ts`: specjalny target `fdm-universe-outside-support` dla Airboxa;
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`: wildcard placeholder;
- `apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts`: ścisłe mapowanie object/region legend i zliczanie maski;
- `apps/control-room/src/modules/inspector/panels/boundary-faces/BoundaryFacesOverviewPanel.tsx`: użycie wyłącznie `boundary_face_count`;
- `apps/control-room/src/modules/inspector/InspectorShell.tsx`: globalne akcje i bezpośredni Clipboard API.

## 12. Granica kwalifikacji

Ten dokument jest audytem i nie zawiera poprawek źródłowych. Zrzuty potwierdzają aktualny stan UI, ale same nie dowodzą poprawności pól ani masek. Zamknięcie wymaga zgodności API/manifest/selection/renderer, testów kontraktowych oraz ponownego dowodu runtime dla obu lane’ów.
