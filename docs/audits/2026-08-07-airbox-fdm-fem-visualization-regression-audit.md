# Audyt regresji wizualizacji Airboxa FDM/FEM

**Data:** 2026-08-07  
**Zakres:** Control Room `viewport-3d`, Explorer/Inspector, zasoby domeny i pola, renderowanie `wireframe`, `points` i wektorów `H_demag` dla FDM i FEM.  
**Status:** diagnoza i naprawa zakończone; FDM CPU oraz zarządzany FEM GPU potwierdzone w izolowanych sesjach runtime i aktualnym browser/WebGL.

## 1. Kryteria sukcesu

Naprawa jest zamknięta dopiero wtedy, gdy dla bieżącej, zgodnej domeny:

1. FDM Airbox renderuje rzeczywiste komórki outside-support wybrane z aktualnej maski FMRM, a nie proceduralny frame o stałej liczbie podziałów;
2. FEM Airbox renderuje rzeczywiste `volumeEdgeIndices` w `wireframe` oraz air-only node selection w `points`;
3. oba backendy pozwalają niezależnie przełączyć `wireframe` i `points` bez zmiany semantyki meshu;
4. `H_demag` jest pobierane z HTTP v2, ma zgodną identity domeny/topologii/scope i daje widoczne glyphy wyłącznie na właściwym carrierze Airboxa;
5. browser smoke potwierdza widoczny canvas, aktywny WebGL, niezerowy drawing buffer i mierzalną zmianę obrazu dla każdego przełączanego passu.

## 2. Stan repozytorium i granica audytu

Checkout jest współdzielony i dirty. Istnieją niezacommitowane zmiany w `Viewport3DModule`, `useViewport3DSceneModel`, `Viewport3DScene`, Inspectorze, API pól i runtime FDM. Audyt ich nie cofał ani nie nadpisywał. Wnioski rozdzielają:

- zachowanie `HEAD`;
- bieżące niezacommitowane zmiany;
- historię od 2026-08-03 do 2026-08-07;
- wcześniejsze, zatwierdzone kontrakty Airboxa z lipca.

## 3. FDM: pełny przepływ danych do błędnego frame'u

### 3.1 Źródła danych

`GET /v2/sessions/current/data/domain/meta` publikuje regularną domenę FDM:

- `grid.shape`;
- `grid.spacing`;
- `grid.origin`;
- `counts.cells`;
- `generation_id` i bounds.

`GET /v2/sessions/current/data/fdm-region-memberships` oraz binarny FMRM publikują:

- `counts`, `cell_m`, `origin_m`;
- `cell_count`;
- `grid_fingerprint`;
- region id każdej komórki, w tym `FMRM_INACTIVE_REGION_ID` dla outside-support.

`membershipCompatible()` w `shared/domain/mesh/domainPresentation.ts` poprawnie porównuje count, shape, spacing, origin i fingerprint. Na tym poziomie nie znaleziono hardcodowanego `4` ani utraty rozdzielczości.

### 3.2 Adapter domeny

`adaptDomainPresentation()` zachowuje prawdziwy structured-grid descriptor. `adaptFdmDomainPresentation()` przekazuje do `FdmGridRenderDomain` rzeczywiste:

- `shape`;
- `spacing`;
- `origin`;
- `totalCells`;
- sampling budget/stride.

Te dane są kompatybilne z FMRM i wystarczają do odtworzenia rzeczywistych centrów oraz rozmiarów komórek Airboxa.

### 3.3 Punkt utraty semantyki

`resolveFdmAirboxPassPlan()` koduje:

```text
needsInactiveCellGeometry: false
```

dla wszystkich stanów. `wireframeVisible` wybiera tylko `needsExtentOverlay`. `pointsVisible` nie jest nawet wejściem planu. Oznacza to, że poprawny grid i maska membership zostają świadomie pominięte przed rendererem.

### 3.4 Hardcodowany generator 4×4×4

`FdmUniverseOutsideSupportLayer` otrzymuje wyłącznie:

- `universeBounds`;
- `magneticSupportBounds`;
- opacity i kolor;
- liczniki aktywnych/nieaktywnych komórek.

Nie otrzymuje `shape`, `spacing`, `origin`, indeksów inactive cells ani fingerprintu. Dla zrealizowanego membership wywołuje `BoundsVolumeWireframe`, a ten korzysta z:

```text
AIRBOX_VOLUME_WIREFRAME_DIVISIONS = 4
```

`buildBoundsVolumeWireframePositions()` interpoluje pięć płaszczyzn na każdej osi niezależnie od rzeczywistego `grid.shape`. To bezpośrednie źródło objawu „4 warstwy przez grubość i 4 segmenty w płaszczyźnie”. Renderowany obiekt jest proceduralną klatką AABB, nie meshem FDM.

### 3.5 Istniejąca, lecz niewykorzystana poprawna geometria

`buildFdmCuboidInstanceModel()` już obsługuje `cellSelection: "inactive"`. Używa:

- rzeczywistego `domain.shape`, `spacing`, `origin`;
- aktualnego `realizedRegionIds` z FMRM;
- canonical inactive region id;
- sampled cell ordinals zachowujących proweniencję.

`useViewport3DSceneModel()` buduje `fdmAirboxInstanceModel` z `cellSelection: "inactive"`, lecz włącza ten build tylko wtedy, gdy `needsVectorAnchors` jest prawdziwe. Następnie `Viewport3DScene` tworzy kopię ustawień Airboxa i wymusza:

```text
boundsVisible: false
pointsVisible: false
shaderVisible: false
wireframeVisible: false
```

Dlatego prawidłowy model komórek trafia do `FdmCuboidLayer` wyłącznie jako kotwice wektorów. Nie może narysować points ani wireframe.

## 4. FEM: pełny przepływ danych i regresja passów

FEM pozostaje na właściwej architekturze topology-first:

1. manifest wyznacza magnetic/airbox carriers;
2. binarna topologia dostarcza pozycje, komórki i boundary facets;
3. `buildViewport3DTopologyRenderModel()` wyprowadza `edgeIndices`, `volumeEdgeIndices`, `fullNodeSelection` i `surfaceNodeSelection` dla części Airboxa;
4. `AirboxMeshPartLayer` potrafi z tych danych zbudować prawdziwe line geometry i indexed point geometry.

Regresja jest późniejsza. `resolveAirboxRuntimeVisualizationSettings()` od commitu `1760d689c` z 2026-08-06 wymusza `pointsVisible: false` i `shaderVisible: false`. Testy zostały zmienione tak, aby traktować points jako „stale flag”, mimo że zatwierdzony projekt z 2026-07-18 definiuje podstawowe tryby Airboxa jako `off | wireframe | points`.

Dodatkowo dla `geometryScope: "full"` `AirboxMeshPartLayer` renderuje prawdziwe `volumeEdgeIndices`, ale zawsze dokłada też `AirboxWireframeFallback`, który korzysta z tej samej proceduralnej klatki z czterema podziałami. Overlay może wizualnie dominować nad rzeczywistą nieregularną siatką i sprawiać wrażenie fałszywej regularnej dyskretyzacji.

## 5. Proweniencja i kompatybilność `H_demag`

### 5.1 FDM

Plan requestu używa HTTP v2:

```text
GET /v2/sessions/current/data/fields/H_demag/samples/vector
  ?component=full
  &scope_kind=airbox
  &max_samples=...
```

Aktualna logika sprawdza quantity, `domain_generation_id`, point count i grid fingerprint przed zaakceptowaniem pola. Fizycznie CPU FDM publikuje observable full-domain `H_demag`; inactive cells mają `M=0`, ale pole stray nie jest zerowane. To poprawna podstawa dla wektorów Airboxa. GPU FDM nie ma jeszcze równoważnie zakwalifikowanego full-domain observable bufferu.

Fixture przeglądarkowy potwierdził request `H_demag` dla `scope_kind=airbox` i gotowy resource, ale przełączenie Vectors zmieniło tylko 10 z wymaganych 18 próbkowanych pikseli. Smoke zakończył się błędem `Airbox vectors did not change rendered viewport pixels`. Jest to dowód, że poprawny request nie wystarcza do potwierdzenia widocznego renderu.

### 5.2 FEM

FEM żąda pola z `scope_kind=airbox` i dokładnym `scope_id` części Airboxa. Render model odrzuca współdzielone węzły interfejsu przez air-only selection i mapuje sampled node indices na globalne pozycje topologii. Testy modelu pokrywają tę ścieżkę, lecz bieżący smoke FEM zatrzymał się wcześniej na braku pixel delta dla fallback targetu i nie dostarczył końcowego dowodu Airboxa.

## 6. Dowody wykonane w audycie

### 6.1 Testy modelu

Wąski zestaw 5 plików zakończył się wynikiem `315 passed`. Ten wynik nie kwalifikuje funkcji, ponieważ test `fdmAirboxPassPlan.test.ts` jawnie wymusza błędne `needsInactiveCellGeometry: false`, a testy FEM wymuszają odrzucenie points.

Pierwsza próba testów była nieważna: błędne przekazanie argumentów zebrało cały suite, a środowisko zakończyło się `ENOENT` dla Windows Temp przed uruchomieniem testów. Poprawny rerun użył `TMPDIR=/tmp` i bezpośredniego `vitest run`.

### 6.2 Browser/WebGL

- pełny smoke FDM/FEM zatrzymał się na niezależnym braku pixel delta dla regionu FDM;
- zawężony FDM Airbox smoke potwierdził zdrowy canvas i request `H_demag`, ale nie potwierdził widocznych glyphów;
- FEM-only smoke zatrzymał się na fallback target przed fazą Airboxa;
- nie ma jeszcze dowodu `points` dla żadnego backendu, ponieważ bieżący kontrakt UI/renderer ten pass blokuje.

## 7. Przyczyna źródłowa

Regresja nie jest pojedynczym błędem materiału Three.js. Jest zmianą kontraktu produktu wprowadzoną podczas rozbudowy frontendu FDM:

1. FDM Airbox zredukowano do extent/vector-only;
2. prawdziwą inactive-cell geometry odłączono od wireframe/points;
3. proceduralny bounds overlay z czterema podziałami zaczęto prezentować jak mesh;
4. wspólny FEM Airbox znormalizowano tak, aby odrzucał points;
5. testy i Inspector utrwaliły tę redukcję, mimo że wcześniejsze zatwierdzone specyfikacje wymagały `wireframe | points` oraz jednego air-only carriera dla points i vectors.

## 8. Minimalny projekt naprawy

### 8.1 Wspólny kontrakt UI

Przywrócić Airboxowi podstawowe tryby `off | wireframe | points` dla FDM i FEM. `Vectors` pozostają niezależnym overlayem. Surface shader pozostaje wyłączony, ponieważ Airbox nie jest materiałem magnetycznym.

### 8.2 FDM renderer

- rozszerzyć plan passów o `needsInactiveCellGeometry` i `needsPointGeometry`;
- włączać istniejący build `cellSelection: "inactive"` dla wireframe, points lub vectors;
- przekazywać do `FdmCuboidLayer` prawdziwe ustawienia wireframe/points zamiast je zerować;
- zachować `FdmUniverseOutsideSupportLayer` wyłącznie jako osobny bounds/frame pass;
- nie nazywać proceduralnego AABB meshem i nie używać go jako wireframe dyskretyzacji;
- sampling musi pozostać deterministyczny i bounded, ale zachowywać realne cell ordinals oraz grid identity.

### 8.3 FEM renderer

- przestać zerować `pointsVisible` w runtime normalization;
- points budować z `fullNodeSelection` lub `surfaceNodeSelection` zależnie od scope;
- wireframe budować z `volumeEdgeIndices`/`edgeIndices`;
- proceduralny interior bounds overlay zachować tylko jako rozróżnialny fallback/depth cue, nigdy jako substytut realnego meshu; nie może dominować, gdy realne volume edges są dostępne.

### 8.4 Wektory

- FDM: użyć tego samego inactive-cell carrier identity dla geometrii i kotwic `H_demag`;
- FEM: użyć tego samego air-only node selection dla points i `H_demag`;
- wymagać zgodności quantity, scope, generation, topology/grid fingerprint i sampled indices;
- browser proof ma osobno mierzyć wireframe, points i vectors, zamiast uznawać dowolny pixel delta za pełną kwalifikację Airboxa.

## 9. Granica kwalifikacji

Po naprawie fixture browserowy będzie dowodem poprawności UI/renderer i kontraktu danych. Nie zastąpi produkcyjnego dowodu solvera. Finalne twierdzenia o `H_demag` wymagają:

- FEM: aktualnej sesji z realnym shared-domain Airboxem i polem z produkcyjnego solvera;
- FDM CPU: aktualnej sesji z full-domain observable demag buffer;
- FDM GPU: osobnego full-domain observable bufferu i parytetu CPU/GPU; obecny aktywnie maskowany buffer GPU nie kwalifikuje Airbox `H_demag`.

## 10. Zamknięcie naprawy i końcowy dowód

Stan z sekcji 5–6 opisuje reprodukcję regresji przed naprawą. Po wdrożeniu minimalnego projektu z sekcji 8 oba izolowane smoke testy przeglądarkowe przeszły na finalnym kodzie:

| Backend | Wireframe | Points | `H_demag` vectors | Request pola |
|---|---:|---:|---:|---|
| FDM | 39 533 zmienione piksele | 4 286 | 12 338 | `scope_kind=airbox`, `max_samples=1200` |
| FEM | 1 713 zmienionych pikseli | 30 | 80 | `scope_kind=airbox`, `scope_id=part-airbox`, `max_samples=4` |

Każda wartość została zmierzona względem osobnego obrazu bazowego przy 294 926 próbkowanych pikselach. Smoke sprawdził również widoczny canvas, nieutracony kontekst WebGL oraz niezerowy drawing buffer. Obrazy dowodowe zapisano w `apps/control-room/.artifacts/viewport-3d-browser-audit/` jako osobne pliki dla `wireframe`, `points` i `H_demag` obu backendów.

FDM renderuje teraz rzeczywistą topologię nieaktywnych komórek siatki 8 × 8 × 8. Stała czterech podziałów pozostaje wyłącznie implementacją zdegradowanego pomocniczego bounds-volume fallbacku; nie jest już używana jako carrier meshu Airboxa FDM ani jako zamiennik dostępnych krawędzi objętościowych FEM.

Końcowy test na rzeczywistej sesji 20 × 12 × 6 wykrył i usunął dodatkowe rozszczepienie targetu: stan v2 zapisywał canonical `airbox/airbox`, podczas gdy renderer outside-support FDM czytał lokalny `fdm-universe-outside-support`. Po skierowaniu renderera i przełącznika widoczności na jeden canonical target aktualne obrazy runtime różnią się o 144 142 piksele między `wireframe` i `points`; `points` pokazuje 1320 centrów komórek outside-support, a `wireframe` ich rzeczywiste krawędzie. Komplet obrazów FDM znajduje się w `runtime-fdm-airbox-*.png`, a montaż w `runtime-fdm-airbox-proof-montage.png`.

Końcowa kwalifikacja frontendowa obejmuje kontrakt danych, selekcję carriera, rendering i browser/WebGL. Granica produkcyjnej kwalifikacji solverów z sekcji 9 pozostaje bez zmian.

## 11. Maski obszarów oraz `H_eff` i `H_ext`

Maska jest kontraktem carriera, nie operacją zerowania pola. Pole pełnodomenowe zachowuje jedną tablicę wartości i jeden `domain_generation_id`, natomiast `scope_kind` wybiera indeksy próbek należące do Airboxa albo ferromagnetyka:

- FDM: FMRM oznacza komórkę powietrza jako `u32::MAX`, a komórki obiektów i regionów identyfikatorami legendy;
- FEM: część magnetyczna wybiera globalne indeksy węzłów swojej części, a Airbox wybiera węzły części powietrznej po odjęciu wszystkich węzłów magnetycznych;
- binarny FMVP zwraca `sampled_node_indices`, `scope_kind`, `scope_id` i identity generacji domeny, więc frontend może renderować to samo `H_demag` wyłącznie wewnątrz albo wyłącznie na zewnątrz ferromagnetyka.

Test kontraktowy FEM potwierdza rozłączne maski `part/body = [0,1,2,3]` i `airbox/airbox-b = [6,7]` dla tego samego pełnodomenowego `H_demag`. Izolowana sesja FDM CPU na siatce 20 × 12 × 6 potwierdziła odpowiadający podział runtime: 120 komórek `object/film` i 1320 komórek `airbox`, razem 1440. Tę samą liczność i ten sam `domain_generation_id` zwróciły `H_demag`, `H_eff` oraz `H_ext`.

FDM CPU nie maskuje już wizualizacyjnego `H_ext` i `H_eff` poza materiałem. `H_ext` jest rozgłaszane na całą domenę, a wizualizacyjne `H_eff` w nieaktywnych komórkach jest rekonstruowane z pełnodomenowych składników (`H_demag + H_ext + H_oe + H_ant`). Pole efektywne używane przez LLG pozostaje maskowane solverowo, więc naprawa nie zmienia dynamiki w pustce.

Browser smoke przełączył na obu backendach trzy osobne źródła wektorów Airboxa:

| Backend | `H_demag` | `H_eff` | `H_ext` |
|---|---:|---:|---:|
| FDM | 12 338 pikseli | 15 962 | 15 853 |
| FEM | 80 pikseli | 112 | 112 |

FEM fixture ma tylko cztery węzły air-only, dlatego jego delty są małe, ale przekraczają ustalony próg, mają poprawny request `scope_kind=airbox&scope_id=part-airbox` i przechodzą kontrolę WebGL.

Świeża zarządzana sesja FEM GPU zamknęła granicę runtime. Produkcyjny shared-domain mesh zawierał 921 tetraedrów i 207 węzłów: 141 elementów/62 węzły filmu oraz 780 elementów/145 węzłów wyłącznego powietrza. `compute_fields` opublikował `H_demag`, `H_eff` i `H_ext` jako `full_domain` z jednym `domain_generation_id=2340956268700658583`. Dekodowanie rzeczywistych FMVP v3 dało dla każdego pola ten sam wynik:

| Pole | Maska Airbox | Maska filmu | Przecięcie | Suma |
|---|---:|---:|---:|---:|
| `H_demag` | 145 (`62..206`) | 62 (`0..61`) | 0 | 207 |
| `H_eff` | 145 (`62..206`) | 62 (`0..61`) | 0 | 207 |
| `H_ext` | 145 (`62..206`) | 62 (`0..61`) | 0 | 207 |

Aktualny frontend wyrenderował z tej sesji pięć osobnych dowodów: pełny FEM Airbox `wireframe`, `points` oraz wektory `H_demag`, `H_eff` i `H_ext`. Wszystkie przebiegi miały `contextLost=false`, drawing buffer 617 × 478 i zero błędów konsoli. Obrazy `runtime-fem-airbox-*.png` oraz montaż `runtime-fem-airbox-proof-montage.png` znajdują się w `apps/control-room/.artifacts/viewport-3d-browser-audit/`.

## 12. Odblokowanie zarządzanego runtime FEM

Legacy lock `.fem-gpu-host.export.lock` pozostawał odziedziczony przez obcy proces w stanie `D`. Eksporter został przeniesiony na `.fem-gpu-host.export.v2.lock` i uruchamia właściwy proces przez `flock --close`, więc deskryptor blokady nie przechodzi do długowiecznych potomków. Test procesu potwierdził blokowanie konkurenta podczas eksportu oraz możliwość natychmiastowego przejęcia locka po jego zakończeniu.

Drugi punkt blokujący znajdował się w prunerze: `readlink -f /proc/<pid>/cwd` próbował kanonizować ścieżkę na nieodpowiadającym systemie plików. Pruner odczytuje teraz sam tekst linków procfs bez dereferencji celu. Test regresyjny z celowo opóźnionym `readlink -f` kończy się w 0,53 s. Dzięki temu zarządzany build zakończył profil `release` w 12 min 32 s, pakiet przeszedł walidację exact-match (3996 wpisów), a sesja FEM uruchomiła się bez restartu WSL i bez ingerencji w obcy proces.
