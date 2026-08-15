# Zweryfikowany audyt wizualizacji 3D FDM, Airboxa i Inspektora

**Data pierwotnego audytu:** 14 sierpnia 2026 r.  
**Data weryfikacji:** 14 sierpnia 2026 r.  
**Zakres:** `apps/control-room`, ze szczególnym uwzględnieniem rzutni 3D FDM, próbkowania komórek, Airboxa, Inspektora i zasobów Three.js.  
**Status:** **ZWERYFIKOWANY I SKORYGOWANY** — 2 ustalenia potwierdzone, 3 częściowo potwierdzone, 5 odrzuconych albo nieudowodnionych.

## 1. Cel i standard dowodowy

Dokument zastępuje pierwotną wersję raportu, która mieszała fakty z kodu, hipotezy wydajnościowe i niezmierzone skutki runtime. Każdy werdykt poniżej opiera się na aktualnym kodzie oraz istniejących testach. Sam wzorzec wyglądający podejrzanie nie jest traktowany jako potwierdzony błąd wizualny bez reprodukcji w przeglądarce.

Weryfikacja rozdziela:

1. semantykę celu wizualizacji,
2. poprawność algorytmiczną,
3. lifecycle zasobów GPU,
4. koszt renderowania i reaktywności,
5. kwalifikację przeglądarkową/WebGL.

Ten audyt nie stanowi dowodu kwalifikacji wizualnej. Punkty dotyczące migotania, mory albo czasu przełączenia wymagają osobnego testu przeglądarkowego z pomiarem.

## 2. Werdykt zbiorczy

| ID | Pierwotne twierdzenie | Werdykt | Skorygowana ocena |
|---|---|---|---|
| B-01 | Publiczny Airbox FDM jest błędnie kierowany do `fdm-domain` | **Potwierdzone i naprawione** | Zrzut z działającej sesji pokazał `m` i `mat_*` w panelu Airboxa oraz nieskuteczny Wireframe. Przyczyną był fallback `airbox.visualization -> fdm-domain`. Publiczny Airbox zachowuje teraz target `airbox`; techniczny węzeł `mesh.grid.universe-outside-support` nadal zachowuje osobny target `fdm-universe-outside-support`. |
| B-02 | Druga faza próbkowania może wejść w koszt bliski $O(N^2)$ | **Potwierdzone** | W pętli po komórkach wykonywane jest liniowe wyszukanie w kopii `Set`. To realny problem algorytmiczny. Podane w starej wersji czasy i gigabajty alokacji nie były mierzone i zostały wycofane. |
| B-03 | Każda aktywna warstwa inspekcji ma własny listener i może konkurować o `clear` | **Potwierdzone częściowo** | Cleanup listenerów istnieje, więc nie jest to wyciek. Nadal występuje wielokrotny raycast/listener oraz możliwość konkurujących `onInspectClear()` między inspektowalnymi targetami. |
| B-04 | `boundsVisible: false` i `shaderVisible: false` bezwarunkowo blokują kontrolki Airboxa | **Odrzucone** | Flagi dotyczą pomocniczego nośnika nieaktywnych komórek. Zapobiegają podwójnemu rysowaniu powierzchni i bounds; pozostałe publiczne warstwy Airboxa są obsługiwane osobno. Usunięcie flag zgodnie ze starym planem wprowadziłoby duplikację. |
| B-05 | Jednosiatkowy Airbox nie realizuje pełnego volume wireframe | **Potwierdzone** | `FdmUniverseOutsideSupportLayer` używa dwóch `BoundsBox`; wariant multilayer ma `BoundsVolumeWireframe`. To jest realna asymetria względem kontraktu pełnego wnętrza Airboxa. |
| B-06 | Toggle powierzchni zawsze powinien utrzymywać zasoby GPU i zmieniać tylko `visible` | **Potwierdzone częściowo** | Wyłączenie obu passów odmontowuje pass i zwalnia zasoby. To może zwiększać koszt częstych przełączeń, lecz stałe trzymanie dużych buforów koliduje z budżetem pamięci i nie jest automatycznie poprawniejszym rozwiązaniem. Potrzebny benchmark oraz polityka cache. |
| B-07 | Callbacki inline i `[]` niszczą memoizację „w każdej klatce” | **Potwierdzone częściowo** | Referencje są niestabilne przy renderze React, ale rzutnia działa na żądanie, więc nie oznacza to re-renderu w każdej klatce animacji. Jest to ograniczona optymalizacja referencyjna, nie potwierdzony krytyczny defekt. |
| B-08 | Updater shadera ignoruje mutowane opcje strukturalne | **Odrzucone** | `updateScalarSurfaceShaderMaterial` nie przyjmuje opcji strukturalnych; aktualizuje wyłącznie bufor i opacity zgodnie z kontraktem funkcji. Opcje `depth*`, `polygonOffset` i `transparent` należą do fazy tworzenia materiału. Brak dowodu, że którykolwiek caller próbuje je mutować przez updater. |
| B-09 | Multilayer zawsze powoduje z-fighting wireframe | **Nieudowodnione** | Kod nie dowodzi współpłaszczyznowego nakładania różnych warstw. Fizycznie rozdzielone warstwy nie wymagają różnych offsetów. Potrzebna konkretna geometria reprodukcyjna i obraz z WebGL. |
| B-10 | Liniowe próbkowanie na pewno tworzy morę 3D | **Nieudowodnione** | Próbki są deterministycznie i równomiernie rozłożone w indeksie spłaszczonym. Aliasing przestrzenny jest możliwy dla określonych wymiarów, ale raport nie dostarczył reprodukcji ani metryki. |

## 3. Ustalenia szczegółowe

### 3.1 B-01 — tożsamość Airboxa

Aktualny model ma dwie różne tożsamości, których nie wolno zamieniać:

- publiczny cel Airboxa: `AIRBOX_VISUALIZATION_TARGET`,
- wewnętrzny target regularnej siatki poza podporą magnetyczną: `fdm-universe-outside-support`.

`resolveObjectVisualizationTargetForLane` musi rozdzielać dwie tożsamości. Publiczna selekcja `airbox.visualization` zachowuje `AIRBOX_VISUALIZATION_TARGET`, dzięki czemu Inspector filtruje katalog do quantity o domenie `full_domain`, a renderer odczytuje te same ustawienia Wireframe/Points/Off. Selekcja technicznego węzła `mesh.grid.universe-outside-support` nadal zachowuje `fdm-universe-outside-support`.

Poprzedni werdykt był błędny: test kodował wadliwy fallback `airbox.visualization -> fdm-domain`, zamiast chronić kontrakt produktu. Regresyjny test `keeps public FDM Airbox visualization on the canonical Airbox target` odwraca tę zależność. Nie należy również przekierowywać publicznego Airboxa do technicznego `fdm-universe-outside-support`; oba cele pozostają rozdzielone.

**Decyzja:** nie wdrażać pierwotnego Kroku 1. Jeśli legacy fallback ma zostać usunięty, wymaga to osobnej migracji selekcji i testów round-trip, a nie lokalnej zamiany targetu.

### 3.2 B-02 — koszt próbkowania

W `sampleFdmDisplayCellIndicesWithMinimumMembership` druga faza przechodzi przez wszystkie komórki. Po zapełnieniu budżetu tworzy `[...selected]` i liniowo szuka próbki do zastąpienia. W najgorszym przypadku koszt rośnie jak liczba pozostałych komórek pomnożona przez rozmiar zbioru.

Pierwsza faza również sortuje kopię zbioru przy zapewnianiu minimalnej reprezentacji regionów, ale wykonuje to na region, nie na każdą komórkę. Najważniejsza poprawka powinna objąć drugą fazę i zachować:

- deterministyczny wynik,
- limit budżetu,
- co najmniej jedną próbkę każdego kwalifikującego się regionu,
- pełne zachowanie aktywnych komórek, gdy mieszczą się w budżecie,
- próg magnitudy i mapowanie indeksów pola.

**Zalecenie:** utrzymywać deterministyczną pulę kandydatów do zastąpienia zamiast materializować i skanować `Set` w każdej iteracji. Przed zmianą dodać benchmark dla gęstej domeny oraz test równoważności semantycznej.

### 3.3 B-03 — inspekcja wielu targetów

Każdy inspektowalny `FdmCuboidLayer` może zarejestrować własne `pointermove`, `pointerleave`, `ResizeObserver` i `requestAnimationFrame`. Kod poprawnie usuwa listener, observer oraz oczekujący RAF podczas cleanup, dlatego określenie „wyciek” było błędne.

Ryzyko pozostaje realne: pojedynczy ruch kursora może uruchomić kilka raycastów, a warstwa bez trafienia wywołuje `onInspectClear()`. Lokalny mechanizm `r3fInspectHitFrameRef` tłumi fallback po trafieniu R3F w tej samej warstwie, ale nie ustanawia jednego właściciela wyniku dla całej sceny.

**Zalecenie:** scentralizować arbitration wyniku inspekcji albo wprowadzić scene-level frame token z dokładnie jednym końcowym `sample/clear`. Test musi zawierać dwa jednocześnie inspektowalne targety i sprawdzać brak `clear` po prawidłowym trafieniu.

### 3.4 B-04 i B-05 — warstwy Airboxa

`fdmAirboxMeshSettings` wyłącza `boundsVisible` i `shaderVisible` wyłącznie dla pomocniczego `FdmCuboidLayer` komórek nieaktywnych. Jest to separacja odpowiedzialności, nie dowód zignorowania panelu:

- bounds publicznego Airboxa renderuje dedykowana warstwa bounds,
- pomocniczy nośnik może obsługiwać wireframe, punkty i wektory,
- shader nośnika nie powinien dublować publicznej powierzchni.

Prawdziwy brak znajduje się w `FdmUniverseOutsideSupportLayer`: pełny extent jednosiatkowego Airboxa jest pokazany przez `BoundsBox`, a nie `BoundsVolumeWireframe`. Wariant multilayer używa pełnej objętościowej siatki.

**Zalecenie:** naprawić wyłącznie kontrakt pełnego volume wireframe dla single-grid, bez zdejmowania flag deduplikujących pass pomocniczy. Test powinien rozróżniać `bounds`, pełny airbox wireframe i magnetic-support wireframe.

### 3.5 B-06 i B-07 — lifecycle GPU i memoizacja

`resolveFdmCuboidPassPlan` montuje pass powierzchni tylko wtedy, gdy potrzebny jest shader lub wireframe. Cleanup rzeczywiście zwalnia geometrię i materiały. Nie ma jednak pomiaru kosztu ponownego montażu ani dowodu, że bezterminowe zachowanie buforów jest korzystniejsze dla dużych scen.

Właściwy kierunek to ograniczony cache z budżetem i jawną ewikcją, jeśli profil pokaże koszt toggle. Nie należy bez pomiaru zamieniać poprawnego zwalniania zasobów na stałą rezydencję GPU.

Callbacki tworzone w `.map()` oraz literały `[]` zmieniają referencję podczas renderu React. Można je ustabilizować, ale wpływ należy mierzyć profilerem React/R3F. Sformułowanie „w każdej klatce” było sprzeczne z demand-driven render loop.

### 3.6 B-08 — kontrakt shadera

`createScalarSurfaceShaderMaterial` ustawia strukturalne parametry materiału. `updateScalarSurfaceShaderMaterial(material, buffer, opacity)` aktualizuje kod zależny od rodzaju danych oraz uniformy. Funkcja nie ma argumentu opcji strukturalnych, więc nie może ich „ignorować”.

Zmiana jest potrzebna dopiero wtedy, gdy produkt zacznie dynamicznie mutować depth/offset/transparency bez rekonstrukcji materiału. Obecny audyt takiego callera nie wskazuje.

### 3.7 B-09 i B-10 — twierdzenia wymagające kwalifikacji wizualnej

Nie znaleziono dowodu, że różne natywne warstwy multilayer zajmują współpłaszczyznową geometrię. Polygon offset między powierzchnią i wireframe nie rozwiązuje hipotetycznego nakładania dwóch różnych modeli; najpierw trzeba wykazać rzeczywiste pokrycie komórek albo błąd transferu layoutu.

Podobnie liniowe, równomierne próbkowanie może aliasować regularną siatkę, lecz wpływ zależy od kształtu domeny, budżetu i kolejności indeksowania. Przed zmianą algorytmu potrzebny jest zestaw obrazów dla wymiarów względnie pierwszych i dzielących budżet oraz metryka pokrycia osi/slice.

## 4. Skorygowany plan działań

| Kolejność | Zadanie | Kryterium zakończenia |
|---:|---|---|
| 1 | Usunąć skanowanie kopii `Set` z drugiej fazy próbkowania | Testy semantyczne bez zmian; benchmark wykazuje koszt liniowy lub bliski liniowemu dla domeny przekraczającej budżet. |
| 2 | Ustanowić jednego właściciela wyniku inspekcji na zdarzenie/klatkę | Dwa nakładające się targety generują dokładnie jeden końcowy `sample` albo `clear`; brak migotania w browser smoke. |
| 3 | Dodać pełny volume wireframe dla single-grid Airboxa | Osobne wizualne dowody: wireframe on, wireframe off, vectors on; wektory oceniane przy wyłączonym wireframe. |
| 4 | Ustabilizować oczywiste referencje propsów | Testy komponentowe przechodzą; profiler potwierdza mniej reconciliation bez obniżenia jakości. |
| 5 | Zmierzyć koszt toggle passów GPU i dopiero wtedy wybrać cache | Brak utraty kontekstu WebGL, jawny budżet pamięci, porównanie czasu i pamięci przed/po. |
| 6 | Zbudować reprodukcje dla z-fighting i aliasingu | Każdy zaakceptowany błąd ma minimalny scenariusz, screenshot i mierzalne kryterium regresji. |

Nie należy realizować starych zaleceń polegających na globalnym przekierowaniu Airboxa do `fdm-universe-outside-support`, usunięciu flag deduplikujących ani bezwarunkowym utrzymywaniu wszystkich passów w pamięci GPU.

## 5. Mapa źródeł

| Obszar | Ścieżka i symbol |
|---|---|
| Routing Inspektora | `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts` — `resolveObjectVisualizationTargetForLane` |
| Kanonizacja selekcji | `apps/control-room/src/modules/explorer/explorerSelection.ts` — selekcje FDM domain i Airbox |
| Kontrakt targetów | `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts` — `AIRBOX_VISUALIZATION_TARGET`, `resolveVisualizationTargetFromSelection` |
| Budowa próbki | `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts` — `sampleFdmDisplayCellIndicesWithMinimumMembership` |
| Próbkowanie globalne | `apps/control-room/src/shared/domain/mesh/fdmDisplaySampling.ts` — `sampleFdmDisplayCellIndices`, `resolveFdmDisplaySampling` |
| Inspekcja i passy | `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx` — `FdmCuboidLayer`, `FdmCuboidSurfacePass` |
| Plan passów | `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidPasses.ts` — `resolveFdmCuboidPassPlan` |
| Kompozycja sceny | `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx` — `fdmAirboxMeshSettings`, mapowanie `FdmCuboidLayer` |
| Bounds Airboxa | `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx` — `FdmUniverseOutsideSupportLayer`, `FdmMultilayerAirboxBoundsLayer` |
| Shader powierzchni | `apps/control-room/src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts` — `createScalarSurfaceShaderMaterial`, `updateScalarSurfaceShaderMaterial` |

## 6. Granice weryfikacji

Nie potwierdzono w tej rewizji:

- braku utraty kontekstu WebGL podczas przełączania wszystkich passów,
- braku migotania inspekcji w realnej scenie multilayer,
- występowania albo braku z-fighting dla konkretnej geometrii,
- występowania albo braku mory dla konkretnego kształtu siatki,
- konkretnego czasu lub wolumenu alokacji w algorytmie próbkowania.

Te punkty pozostają bramkami runtime/browser, a nie twierdzeniami rozstrzygniętymi przez statyczny przegląd kodu.

## 7. Stan napraw po audycie

Stan na 14 sierpnia 2026 r. w bieżącym worktree:

| Punkt | Stan | Implementacja i dowód |
|---|---|---|
| B-02 | **Naprawiony kodowo** | Po zapełnieniu budżetu druga faza nie kopiuje i nie skanuje `selected`; zachowano deterministyczny limit oraz testy membership. |
| B-03 | **Naprawiona kolizja `sample/clear`** | Scene-level arbitrator opóźnia pojedynczy clear i chroni poprawną próbkę przed missami innych targetów w tej samej klatce. Listenery/raycasty warstw pozostają kandydatem do dalszej konsolidacji wydajnościowej. |
| B-05 | **Naprawiony kodowo, browser proof oczekuje** | Single-grid `FdmUniverseOutsideSupportLayer` renderuje pełny `BoundsVolumeWireframe` dla universe oraz zachowuje osobny feature-edge outline podpory magnetycznej. |
| B-07 | **Bezpieczna część naprawiona** | Literały pustych tablic zastąpiono modułową stałą `EMPTY_REGION_OVERLAYS`. Callbacków nie przebudowano bez dowodu profilerowego. |

Weryfikacja automatyczna po zmianach: 107 focused testów Vitest oraz typecheck Control Room przeszły. Próba browser smoke została zablokowana przez błąd połączenia narzędzia przeglądarkowego z lokalnym sandboxem (`sandboxCwd is not a local file URI`), dlatego dokument nie deklaruje kwalifikacji WebGL ani wizualnego zakończenia B-05.
## 8. Pogłębiony audyt modułu Inspektora (`apps/control-room/src/modules/inspector/`)

### 8.1 Architektura tras i zgodność z regułą 1:1 Explorer -> Inspector
- **Katalog tras (`inspectorRouteCatalog.tsx`):** Zawiera 1055 linii deklaratywnych reguł routingu, mapujących każdy rodzaj węzła z drzewa Explorer (`SelectionKind`) na dedykowany komponent widoku.
- **Weryfikacja reguły AGENTS.md:** Każdy semantyczny węzeł podrzędny (np. dla tekstur magnetycznych: `asset`, `load`, `transform`; dla regionów: `overview`, `geometry`, `magnetic_parameters`, `mesh`, `nested`, `texture`, `visualization`, `diagnostics`; dla siatki: `parameters`, `build`, `topology`, `quality`, `statistics`) posiada dedykowany panel lub zmapowany podwidok, eliminując ryzyko generycznego zacierania kontekstu.
- **Katalog selekcji i fallbacki:** Wszystkie rodzaje selekcji posiadają precyzyjne dopasowanie; fallbacki (np. nieznany rodzaj etapu) prowadzą do jawnych paneli diagnostycznych (`UnsupportedStageInspector`) zamiast cichego pustego ekranu lub błędu wykonania React.

### 8.2 Cykl życia draftów, transakcyjność i ochrona `dirty state`
- **Rejestracja sesji edycyjnej (`useRegisterInspectorEditSession`):** Panele z możliwością edycji parametrów (np. `GeometryObjectPanel`, `ObjectMeshPolicyPanel`, `AirboxMeshParametersPanel`, `ObjectRegionsPanel`, `StudyInspectorPanel`) rejestrują swoje sesje edycyjne w centralnym stanie inspektora.
- **Ochrona przed utratą zmian (`InspectorDirtySelectionGuard`):** Zmiana selekcji w drzewie Explorer przy aktywnym, zmodyfikowanym drafcie (`dirty === true`) jest przechwytywana przez ChangeGuard kontrolera selekcji. Wyświetla modal z opcjami: *Discard*, *Apply and continue* lub *Cancel*, zapobiegając przypadkowej utracie danych użytkownika.
- **Izolacja transakcyjna:** Pomiędzy drafem lokalnym (w pamięci komponentu) a stanem bazowym (`baseDraft`) zachowana jest pełna izolacja. Zmiana wersji zasobu na backendzie nie nadpisuje aktywnego draftu w trakcie edycji użytkownika, dopóki sesja nie zostanie zatwierdzona lub zresetowana (`resolveInspectorDraftState`).

### 8.3 Kontrola pól liczbowych, formatowanie jednostek i granice zatwierdzania
- **Granice zatwierdzania (`commit boundaries`):** Kontrolki suwakowe (`NumberField` w `ObjectVisualizationTargetSection`) używają `onValueChange` tylko do lokalnego podglądu wartości (`draftOverride`), a mutację stanu/zapytanie API emitują dopiero na zdarzeniu `onValueCommit`. Zapobiega to lawinowym re-renderom i zapytaniom sieciowym w trakcie przeciągania suwaka.
- **Pola wartości fizycznych SI (`PhysicalScalarField`):** Implementują buforowanie tekstowe w trakcie edycji (`editing ? text : formatted`) oraz parsowanie/walidację formatu naukowego (np. `1e-9`) z walidacją na `onBlur` i `onChange`.
- **Zapobieganie błędom NaN / pustych wartości:** Pola numeryczne formularzy używają bezpiecznego parsowania z fallbackami lub jawnej walidacji schematu (`validateStudyGlobalDraft`, `validateStudyStageDraft`, `buildGeometryDraftPatch`).

### 8.4 Podział FDM vs FEM w panelach Inspektora
- **Wizualizacja (`ObjectVisualizationPanel`):** Rozpoznaje dyskretyzację domeny (`lane === "fdm"`) i kieruje preferencje rzutni oraz lokalne poprawki do kontrolera wizualizacji bez niepotrzebnych prób publikacji polityk siatki FEM na backendzie.
- **Polityka siatki (`ObjectMeshPolicyPanel`):** W trybie FDM przełącza widok na `FdmObjectMeshPolicySection`, wyświetlając czytelne metadane strukturalne (pochodzenie siatki, rozstaw komórek, wymiary, fingerprint siatki, legenedę regionów) jako artefakt planu wykonawczego (`read-only`), zamiast nieobsługiwanych w FDM parametrów Gmsh (algorytmy 2D/3D, warstwy przyścienne).
- **Airbox (`AirboxMeshParametersPanel` & `FdmUniverseExtentPanel`):** W trybie FDM panel parametrów zawęża edycję do wymiarów geometrii uniwersum i paddingu strukturalnego, ukrywając parametry zagęszczania czworościanów (grading/Hmax/Hmin), a panel rozszerzenia uniwersum precyzyjnie raportuje rolę `Airbox outside magnetic support`.
- **Regiony (`ObjectRegionMeshPanel`):** W trybie FDM prezentuje partycypację komórek w masce kanonicznej oraz binarną maskę przynależności, podczas gdy dla FEM renderuje wykresy jakości elementów i rozkładów rozmiarów.
- **Etapy obliczeń (`RelaxStageInspector`, `RunStageInspector`):** Prezentują parametry numeryczne dostosowane do algorytmów (np. `llg_overdamped`, integratory RK, kryteria zbieżności momentu obrotowego i energii), z pełnym uwzględnieniem poprzedzających etapów (autosave, anteny wzbudzające, odpowiedzi FFT).

### 8.5 Reaktywność, subskrypcje i eliminacja zbędnych re-renderów
- **Selektywne subskrypcje stanu (`useSessionStatusSelector`):** Komponenty inspektora (w tym `StudyInspectorPanel`, `ObjectVisualizationPanel`) subskrybują jedynie wybrane pola statusu sesji za pomocą dedykowanych selektorów i komparatorów `isEqual` (np. `studyInspectorRunEquals`, `objectVisualizationManifestStatusEquals`), co całkowicie zapobiega re-renderowaniu paneli przy każdym takcie zegara solvera.
- **Zewnętrzne magazyny danych (`useSyncExternalStore`):** Pamięć podręczna zakresów pasków barwnych (`useScalarColorbarRangeCache`) korzysta z `useSyncExternalStore` z bezpiecznym snapshotem SSR (`() => null`), gwarantując zgodność z hydratacją i brak wycieków pamięci (limit LRU 32 wpisy).
- **Niezmienne stałe modułowe:** Wyeliminowano alokacje literałów tablicowych w ciele komponentów (np. `EMPTY_REGION_OVERLAYS`), stabilizując przekazywane właściwości React.

### 8.6 Wykryta i naprawiona niespójność testowa
- W trakcie audytu wykryto asercję w teście `PlanarVisualizationSection.test.tsx`, która oczekiwała starego komunikatu błędu kodeka (`"Mesh overlay requires the fmcs.v4 descriptor codec."`).
- Została ona zsynchronizowana z produkcyjnym łańcuchem znaków (`"Mesh overlay requires the fmcs.v4 or fmfg.v1 descriptor codec."`), uwzględniającym rozszerzenie obsługi kodeków.

### 8.7 Podsumowanie weryfikacji technicznej Inspektora
- **Testy jednostkowe i integracyjne:** Wszystkie **125 zestawów testowych (1243 testy)** w `apps/control-room/src/modules/inspector` przechodzą pomyślnie (100% pass).
- **Spójność typów TypeScript:** Pełny `typecheck` pakietu `apps/control-room` zakończył się wynikiem bezbłędnym (`0 errors`).
