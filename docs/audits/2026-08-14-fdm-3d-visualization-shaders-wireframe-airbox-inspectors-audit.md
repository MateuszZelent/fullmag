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
| B-01 | Airbox FDM jest błędnie kierowany do `fdm-domain` zamiast `fdm-universe-outside-support` | **Odrzucone** | Raport pomieszał publiczny Airbox z wewnętrznym nośnikiem nieaktywnych komórek. Dedykowany węzeł siatki `mesh.grid.universe-outside-support` zachowuje właściwy target. Legacy/publiczny `airbox.visualization` jest celowo kanonizowany inaczej. |
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

`resolveObjectVisualizationTargetForLane` zachowuje target `fdm-universe-outside-support`, gdy selekcja pochodzi z węzła `mesh.grid.universe-outside-support`. Potwierdza to test `keeps the FDM Airbox marker on the structured-grid target while FEM stays canonical Airbox` w `ObjectVisualizationPanelModel.test.ts`.

Jednocześnie selekcja legacy `airbox.visualization` bez jawnego ref ma fallback do `fdm-domain`. Jest on objęty osobnym testem i nie dowodzi, że bieżący węzeł siatki trafia do złego celu. Stara rekomendacja, aby każdy publiczny Airbox przekierować do `targetForFdmUniverseOutsideSupport()`, łamałaby kanoniczne rozdzielenie publicznej semantyki od wewnętrznego nośnika.

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
