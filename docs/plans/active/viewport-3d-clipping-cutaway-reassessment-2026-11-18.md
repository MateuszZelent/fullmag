# Clipping / cutaway 3D — ponowny audyt mastera i plan domknięcia

**Data audytu:** 2026-11-18. **Zakres:** analiza i dokumentacja, bez zmian implementacji.

**Baza:** `D:/git/fullmag`, branch `master`, po `git fetch --no-tags origin master`:
`HEAD = origin/master = 1a680074b666c8dd799c83d3a7fb41dca0d31dd6`.
Commit z 2026-11-17, `Merge pull request #446 from MateuszZelent/codex/buckyball-ui-3350-20261116`.
Ustalenia dotyczą tego SHA, nie dowolnego późniejszego mastera.

**Poprzedni dokument:** [plan z 23 sierpnia](viewport-3d-clipping-cutaway-plan-2026-08-23.md).
Ten audyt zastępuje jego diagnozę i kolejność prac. Zalecenia poniżej są propozycją domknięcia, a nie twierdzeniem o wykonanej implementacji lub zatwierdzonej migracji API.

## 1. Werdykt

**Pełny mechanizm nie jest ukończony.** Istnieje globalne odrzucanie fragmentów jedną płaszczyzną oraz kontrolki przekroju. Nie ma kompletnego przepływu „wytnij narożnik / pozostaw warstwę → pokaż rzeczywiste wnętrze i wartości pola → wybieraj tylko widoczną geometrię”.

Nie należy zaczynać od ponownego pisania shaderów ani kontrolek. Należy domknąć wspólną semantykę cięcia, geometrię odsłonięcia, capy (powierzchnie powstałe w miejscu cięcia), interakcję i kwalifikację.

Najważniejsze blokery:

1. `trim` jest kanonicznym stanem, ale renderer konsumuje tylko jego stratną projekcję `clip`; dodatkowo znak zachowywanej półprzestrzeni jest odwrócony względem konwersji backendu.
2. FDM w domyślnym trybie `surface` nie renderuje wewnętrznych komórek. Sam clipping shadera ich nie ujawni. FEM renderuje powłoki; nie ma capów pól.
3. Globalne płaszczyzny nie mają izolacji od HUD i eksportu, a mapy cieni Three nie korzystają z globalnego clippingu.
4. Picking i alternatywne ścieżki selekcji ignorują odciętą część.
5. „3D trim” pozostaje wyłączonym szkieletem UI, a testy nie kwalifikują całego scenariusza cutaway.

**Świeże dowody:** 10/10 interpretowanych sprawdzeń kontrolek; reprodukcja matematyczna obu błędnych stron `flip`; reprodukcja raycastu trafiającego odciętą stronę; reprodukcja wyłączenia globalnej płaszczyzny w stanie shadow pass. **Browser/WebGL end-to-end, pełny Vitest, typecheck, lint i build: nieuruchomione w tym audycie.** Nie jest to kwalifikacja funkcji.

## 2. Co zmieniło się od starego planu

| Obszar | Stan na przypiętym masterze | Konsekwencja |
|---|---|---|
| Shadery scalar/vector/complex/tensor | Wspólny `ShaderMaterial` ma `clipping:true` i chunki GLSL; shader prądu anteny również | Stara „główna luka shadera” jest nieaktualna; zachować i przetestować wszystkie warianty |
| Inspector | Wspólne `ViewportClippingControls` w Object/Airbox oraz przez alias w antenie | Rozbudować istniejący mechanizm, nie tworzyć drugiego store ani panelu |
| Ribbon Clip | Global enable, oś, pozycja, flip, środkowe płaszczyzny i powiązanie z monitorem | Działa ścieżka komend; nie oznacza pełnego cutaway |
| Ribbon 3D trim | Stałe `checked:false`, `disabled:true`, brak wykonawczych resetów | Nadal do wdrożenia |
| Stan / zapis sesji | `trim`, zgodnościowy `clip`, optimistic sync oraz persistencja v10 istnieją | Problemem jest spójność i migracja, nie brak zapisu |
| Profile renderowania | Scientific i Presentation/PBR, cienie, osobny HUD oraz eksport PNG | Kwalifikacja musi obejmować więcej niż podstawowy shader |
| Przekrój FEM | FMCS v2 ma poligony i identyfikację przecięć; 3D używa ich tylko jako markerów | Dane geometryczne częściowo istnieją, cap-mesh nie |
| Topologie mieszane | Zasób meshing/FMCS v2 odrzuca komórki inne niż Tet4; nowszy PlanarMonitor ma osobny pipeline FMCS v4 | Ponownie użyć nowszych elementów; nie mylić ograniczeń legacy endpointu z całym backendem |

## 3. Ustalenia wymagające naprawy

### A. Kanoniczny stan i przeciwna strona cięcia — bloker poprawności

`VisualizationStateResource` opisuje `trim` jako stan kanoniczny, `clip` jako projekcję zgodności. `compatibility_clip_from_trim` bierze pierwszą włączoną oś X → Y → Z oraz tylko jedną granicę. `apply_compatibility_clip_to_trim` wyłącza pozostałe osie. Wspólny PATCH obu pól może pozostawić ich niespójne wartości. Źródła: S1–S3.

Przykład: zakres Z `[0,50]%` daje `clip.flipped=false`. Backend opisuje dolną połowę, ale `resolveClipPlaneFrame` tworzy normalną `+Z`; Three zachowuje górną połowę. Dla `flipped=true` występuje odwrotna niespójność. Reprodukcja w §7.

Ponadto `normalize_trim_axis` wymusza co najmniej **1% grubości** i koryguje nieprawidłowy przedział bez błędu, np. `90/10` do `49.5/50.5`. PATCH clip nie stosuje tej samej walidacji, PUT całego zasobu także nie normalizuje trim. To istotne przy cienkich warstwach, nie tylko detal suwaka.

Naprawa wymaga jednej semantyki PATCH/PUT/restore oraz jawnej migracji istniejących sesji. Zmiana samego znaku w rendererze naprawi zgodność z trim, ale zmieni obraz dawnych zapisanych clipów; nie wolno ukryć tej konsekwencji.

### B. Odrzucanie fragmentów nie tworzy wnętrza — bloker celu użytkownika

FDM: `DEFAULT_OBJECT_VISUALIZATION.geometryScope` to `surface`. `resolveExactTargetSurfaceInstances` wybiera zewnętrzne komórki według sąsiadów, bez clippingu. `FdmCuboidLayer` renderuje ten zbiór; kolory i wektory również korzystają z ograniczonych indeksów. W trybie `full` przecięcie pojedynczego prostopadłościanu nadal nie dodaje jego zamykającej ściany. Źródła: S8.

FEM: `createMeshPartSurfaceGeometry` korzysta z `surfaceIndices`. Airbox ma analogiczną powierzchnię. `useViewport3DSceneModel` pobiera FMCS z poligonami, ale buduje tylko markery; `ClipPlaneLayer` rysuje prostokąt, obrys i punkty. Półprzezroczysty prostokąt nie jest powierzchnią przekroju materiału ani mapą wartości pola. Źródła: S4, S8–S9.

### C. Globalne płaszczyzny, HUD, eksport i cienie — bloker spójności obrazu

`applyRendererClipping` nadal przypisuje `gl.clippingPlanes`. Oddzielna maska warstw, `renderOrder`, `depthTest:false` i wyczyszczenie depth **nie wyłączają clippingu**. `PostProcessingLayer.renderAnnotations` oraz `renderScenePixels` przy eksporcie nie izolują płaszczyzn. Potwierdzony jest brak izolacji; konkretny obraz uszkodzonego HUD wymaga testu przeglądarkowego. Źródła: S4, S10.

Presentation dodaje osobny problem: `clipShadows:true` w materiale pola nie wystarcza bez `material.clippingPlanes`. Three r186 podczas shadow pass wyłącza płaszczyzny globalne. Reprodukcja stanu silnika dała `colorPlanes=1`, `shadowPlanes=0`; wniosek ze źródeł: usunięta część może nadal rzucać cień. Nie wykonano kwalifikacji wizualnej cienia. [Three r186: WebGLClipping.setState](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgl/WebGLClipping.js), [WebGLShadowMap.getDepthMaterial](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgl/WebGLShadowMap.js).

### D. Niewidoczna geometria pozostaje wybieralna — bloker interakcji

`createViewport3DEventManager.filter` nie sprawdza clippingu. Dotyczy to też handlerów mesh/airbox, FDM raycastu i fallbacku projekcyjnego, natywnego pickingu regionów oraz `PlanarMonitorFacePicker`. `viewport3DPickShouldDefer` ocenia priorytety także niewidocznych trafień. Źródła: S11.

Raycast Three testuje trójkąty, nie wynik fragment shadera. Odtworzono hit na odciętej ścianie `z=-0.5`, mimo istnienia dalszej widocznej ściany. R3F przekazuje pierwsze trafienie danego obiektu: filtr wykonany dopiero po takiej deduplikacji może usunąć pierwszą ścianę i zgubić drugą. Predykat należy stosować przed wyborem najbliższego trafienia, semantycznymi priorytetami i deduplikacją; objąć również ścieżki poza R3F. [Three Mesh.raycast](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/objects/Mesh.js), [R3F events](https://r3f.docs.pmnd.rs/api/events).

### E. Przekrój FEM: ograniczenia danych i układu odniesienia

Obecny endpoint `meshing/meshes/shared-domain/cross-section` zwraca `204` dla braku FEM i `409 mixed_topology_not_supported` dla komórek innych niż Tet4. FMCS v2 zawiera m.in. poligony, `parentElementIds`, `intersectionEdgeNodeIds`, `intersectionEdgeT`, rodzaje punktów i współrzędne świata. Nie jest uniwersalnym buforem wartości pól. Źródła: S9.

Renderer wyznacza płaszczyznę z bounds przekazanych przez scenę. Zapytanie FMCS przekazuje ten sam procent, ale backend rozwiązuje go względem węzłów siatki. Jeżeli zakresy różnią się, np. przez dodatkowy obiekt/antenę lub inny zakres airboxa, procent nie oznacza tej samej płaszczyzny świata. To ryzyko kontraktu wymagające fixture z różnymi bounds; nie wykonano jego reprodukcji przeglądarkowej.

Cap wymaga wspólnego `planeWorld`, generation/topology revision i zgodnej identyfikacji pola. `parentElementId` nie jest automatycznie indeksem próbki pola węzłowego, krawędziowego ani współczynników FEM. Nie wolno zgadywać mapowania lub kolorować nieaktualnym polem po remeshu.

**Istotna nowość mastera:** `planar_sampling/fem.rs::build_overlay` przecina krawędzie elementów `FemPlanarField`; `serialize_planar_overlay_fmcs_v4` zapisuje poligony, parent IDs, pełną ramkę świata i klasy segmentów. Obsługuje to osobna ścieżka `planar_mesh_overlay_response`, nie legacy endpoint meshing używany przez `clipCrossSection`. Frontendowe `decodePlanarMeshOverlay` obecnie pomija blok poligonów i zwraca segmenty/ramkę; nie daje gotowego cap-mesh. Dla FDM ta ścieżka może zwracać FMFG v1, czyli overlay linii gridu, nie wypełnienie przekroju. Źródło: S16.

Nota PlanarMonitor opisuje nodal first-order Tet4/Prism6/Pyramid5/Hex8 i ograniczenia scope, association oraz kwalifikacji runtime. Nie należy ani deklarować braku całej obsługi mixed, ani traktować jej jako już zakwalifikowanego cutaway. Przed nowym algorytmem przecięć trzeba ocenić reuse tego pipeline'u oraz brakujące powiązanie danych 3D.

### F. UX i potwierdzenie transakcji są częściowe

Kontrolki w Inspectorze są **globalne**; `ownerKey` izoluje draft i błąd, nie zakres geometryczny. Slider aktualizuje lokalną liczbę podczas gestu, lecz wysyła stan dopiero na commit — nie zapewnia ciągłego podglądu płaszczyzny. „3D trim” nie ma czynnych zakresów, resetów i presetów. Źródła: S5–S6.

`VisualizationRegistrySyncController.flushNow` podczas inflight może zwrócić promise poprzedniego żądania, a kolejne wysłać później; błąd jest zapisany w sync, ale nie musi odrzucić promise komendy. `completed` komendy nie jest zatem ścisłym ACK konkretnego gestu. Panel pokazuje `sync.error`, więc nie jest to całkowicie ukryty błąd. Testy powinny czekać na właściwy patch/revision, nie tylko wynik komendy. Źródło: S7.

### G. Dodatkowe ryzyka i dowody

Ramka płaszczyzny X ma `width=sizeY`, `height=sizeZ`, ale quaternion Z→X ustawia jej światowe rozmiary odwrotnie dla niesymetrycznych bounds. To ustalenie analityczne dotyczące prostokąta pomocniczego, nie nieskończonej płaszczyzny. Dodać test transformacji narożników i widok X przy `sizeY != sizeZ` (S4).

Aktualne testy anteny obejmują tylko syntetyczne powierzchnie V/J/H. Offscreen pixel probe ukrywa dekoracje i ręcznie renderuje klatkę. Nie dowodzi odświeżenia widocznego canvasa ani niecięcia HUD. Browser CI dla pamięci korzysta z wyłączonych `clip` i `trim`. Szczegóły w §7.

## 4. Zalecany kierunek architektury

### 4.1 Zakres i alternatywy

**Rekomendacja audytu:** clipping materiałowy + jawna geometria odsłonięcia/capów. Ponownie użyć obecnych shaderów, typed API, command registry i resource hooks. Jest to większe zadanie niż poprawka renderera, ale realizuje cel oglądania wnętrza z danymi i stabilnymi identyfikatorami.

Alternatywy: globalne płaszczyzny z save/restore każdego passu są mniejszą zmianą, lecz pozostawiają trudną politykę HUD/cieni i nie tworzą capów. Stencil może dać wizualne zamknięcie bryły, ale sam nie rozwiązuje wartości pola, topologii ani pickingu; nie jest rekomendowaną podstawą przekroju naukowego. Nie dodawać CSG/remeshingu geometrii solvera do interakcji wizualnej.

Zakres bazowy: cięcia osiowe X/Y/Z, połowa, zachowana warstwa, pozostawiony box oraz usunięty narożnik; obiekty, airbox i dostępne pola. Stan pozostaje session-wide i visualization-only. Oblique plane, wiele niezależnych boxów, per-target exclusions i drag-gizmo to osobne rozszerzenia, nie warunek podstawowych scenariuszy użytkownika.

### 4.2 Jeden kanoniczny stan, dwie różne operacje

Zachować `trim` jako źródło prawdy, `clip` jako adapter zgodności. Nie sumować bezwarunkowo `1 clip + 6 trim` z sierpniowego planu. Dla osiowego boxa potrzeba maksymalnie sześciu granic. Nie zakładać gwarancji „Three wspiera co najmniej osiem” — sprawdzić warianty shaderów i sprzęt objęty wsparciem.

Rozdzielić:

| Operacja proponowana | Znaczenie | Przykład |
|---|---|---|
| `keep_inside` | Zachowaj część wspólną aktywnych przedziałów | Połowa, cienka warstwa, box |
| `remove_inside` | Usuń część wspólną aktywnych przedziałów | Narożnik / wnęka, pozostaw resztę bryły |

To **proponowane rozszerzenie**, nie istniejące pola API. Obecny `trim` nie przenosi operacji odejmowania. Nowa semantyka wymaga schematu Rust, OpenAPI, wygenerowanych typów, normalizacji, persistencji i testów starych sesji. Nie da się uczciwie zachować obietnicy starego planu „zero zmian schematu” dla obu operacji.

Ustalić kontrakt świata w SI i stabilne bounds pełnej domeny fizycznej workspace (z airboxem, bez ramek/HUD). Zmiana wyboru lub ukrycie obiektu nie może samoczynnie przesuwać cięcia. Przeliczenie procentu na świat ma jednego właściciela; shader, picking i cap korzystają z tego samego wyniku.

Dla legacy clip rekomendowana semantyka zgodna z obecnym backendowym trim: `flipped=false` zachowuje `axis <= position`, `true` zachowuje `axis >= position`. Dla równania płaszczyzny `d(p)=n·p+c`, gdzie Three odrzuca `d<0`, oznacza to odpowiednio `n=-axis,c=position` oraz `n=+axis,c=-position`. [Kontrakt WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html).

Dla `keep_inside` użyć normalnych skierowanych do zachowywanego boxa i `clipIntersection=false`. Dla `remove_inside` normalne skierować na zewnątrz usuwanego boxa i zastosować `clipIntersection=true`: odrzucana jest część wspólna ujemnych półprzestrzeni. CPU musi realizować identyczną logikę, a nie zawsze `planes.every(distance >= 0)`. [Material: clippingPlanes / clipIntersection](https://threejs.org/docs/pages/Material.html).

`enabled=true` przy **zerowej liczbie aktywnych granic** oznacza no-op w obu operacjach. Trzeba to obsłużyć przed predykatem boolowskim: negacja pustego `every()` po stronie CPU mogłaby usunąć całą scenę, podczas gdy shader bez płaszczyzn niczego nie odrzuci.

Nie narzucać arbitralnej tolerancji `1e-6 m` dla nanometrowych modeli. Granice i tolerancję numeryczną wyprowadzić ze skali/transformacji i przetestować dla nm, µm, mm oraz przesuniętego originu. Walidację odwróconych, pustych i bardzo cienkich zakresów uzgodnić jawnie, bez nieudokumentowanego rozszerzania do 1%.

### 4.3 Polityka materiałów i passów

| Rola | Polityka |
|---|---|
| Powierzchnie obiektów, pola, fizyczne powierzchnie airboxa, topologia i regiony | Wspólne lokalne płaszczyzny i operacja boolowska |
| Fizyczny wireframe / punkty siatki, w tym wnętrze airboxa | Cięcie zgodne z geometrią; zachowane semantyki surface/full i hidden edges |
| Zewnętrzne bounds referencyjne, wymiary, osie, ViewCube, HUD, uchwyty i podglądy monitorów | Bez cięcia; oddzielne role od fizycznej geometrii airboxa |
| Cap danej granicy | Osobny predykat ograniczenia do rzeczywistego przekroju; nie odrzucać przez jego własną płaszczyznę |
| Cienie, depth/normal pass i AO | Ten sam widoczny podzbiór co color pass; jawna weryfikacja materiałów zastępczych |
| Eksport i screenshot | Ta sama polityka co widok; przywracanie stanu także po błędzie |

Włączyć lokalny clipping w właścicielu renderera, a globalną listę pozostawić pustą. Płaszczyzny podawać jawnie do materiałów posiadających daną rolę; nie skanować całej sceny po każdym renderze. Współdzielony materiał nie może mieć jednocześnie roli ciętej i referencyjnej bez rozdzielenia własności. Obejmować tablice materiałów, materiałowe fallbacki i późno dołączane warstwy.

Przesunięcie istniejącej płaszczyzny aktualizuje jej dane i invalidation; nie zmienia klucza bazowej topologii ani źródłowego pola. Zmienia natomiast tożsamość capu i może wymagać nowego samplingu przekroju. Zmiana liczby płaszczyzn/operacji może zmienić wariant programu — zmierzyć to, nie wymuszać `needsUpdate` na każdy ruch. Scientific zachowuje ilościową paletę bez oświetlenia, Presentation dotychczasową optykę i poprawnie przycięte cienie.

Proponowana semantyka glyphów: kwalifikować całą strzałkę po anchorze próbki, nie udawać, że połowa strzałki jest nową próbką. To oznacza, że poprawny glyph przy granicy może nieznacznie wystawać poza nią; udokumentować ten kontrakt i stosować go także do hover. Linie topologii tnie się geometrycznie. Nie zmieniać wartości, gęstości ani długości glyphów jako ukrytej optymalizacji.

### 4.4 Geometria odsłonięcia i capy

**FDM:** zbudować widoczną granicę po cięciu, nie tylko filtrować wcześniej wyznaczoną zewnętrzną powierzchnię. Dla przeciętych komórek utworzyć właściwe powierzchnie przecięcia ze stabilnym `cellIndex` i identyfikacją obiektu/warstwy. Uwzględnić zajętość, nieaktywne komórki, wielowarstwowość i rozdzielenie magnetyka od airboxa. Nie przełączać po cichu całej sceny na `full`.

Geometryczny cap wymaga rzeczywistych danych wnętrza. Jeżeli bieżący nośnik pola zawiera tylko próbki powierzchniowe, pobrać właściwy zasób przez typed resource layer lub zgłosić brak obsługi; nie wypełniać wnętrza najbliższą wartością z powłoki. Samo GPU discard nie zastępuje tej ścieżki.

**FEM Tet4:** ponownie wykorzystać poligony i provenance FMCS. Dla osiowego trim można żądać przekrojów poszczególnych granic, a następnie ograniczyć ich poligony pozostałymi granicami. Nie jest konieczny specjalny endpoint „box cap” tylko dlatego, że granic jest kilka. Konieczne są jednak wspólna pozycja świata, identyfikacja domeny i limit/cancel zapytań.

**FEM mixed:** najpierw ponownie użyć istniejących `FemPlanarField`, `build_overlay` i FMCS v4, zamiast pisać nowy backend przecięć. Uzupełnić dekodowanie poligonów, scope, mapping/provenance oraz powiązanie wartości i capów z kanonicznym cięciem. Bieżące sterowanie PlanarMonitor nie może być mutowane po cichu przez clipping; potrzebna jest jawna, niezależna tożsamość zapytania przekroju 3D. Kwalifikować rzeczywiste rodziny/association, nie tylko obecność kodu. Nie rozbijać arbitralnie komórek na Tet4 bez kontraktu interpolacji. Ograniczenie do Tet4 może być etapem dostawy, ale nie końcem pełnego celu FEM.

**Kolor i probe:** użyć kanonicznego quantity catalog, association oraz samplingu. Dla zgodnego pola węzłowego identyfikatory krawędzi i parametr `t` mogą umożliwić interpolację, lecz tylko przy potwierdzonej bazie i mapowaniu. W pozostałych przypadkach wykorzystać backendowy sampling zgodny z kontraktem PlanarMonitor, bez implementowania drugiej fizyki w shaderze. `parentElementId` służy identyfikacji komórki, nie automatycznie indeksowaniu wartości.

Każdy cap musi rozróżniać `ready`, `loading`, `empty`, `unsupported`, `stale/error` i podawać przyczynę. Brak wsparcia jest jawny, lecz nie zalicza kryterium „pełne cutaway”. Przy błędzie nie wyświetlać starego capu na nowej płaszczyźnie.

Dla `keep_inside` cap ogranicza się do pozostałych zachowywanych przedziałów. Dla `remove_inside` cap jest ścianą wnęki, ograniczoną pozostałymi przedziałami **usuwanej** bryły. Nie wystarczy bezmyślnie zastosować do niego predykatu zachowania powłoki. Obsłużyć normalne, szwy, dziury, styk materiałów, przezroczystość i z-fighting; nie zamykać przestrzeni poza materiałem jednym prostokątem.

### 4.5 Sterowanie, lifecycle i cache

Jeden panel globalnego przekroju, dostępny także przez obecne Inspectory i ribbon. Presety „połowa”, „warstwa”, „pozostaw box”, „usuń narożnik” atomowo ustawiają operację i zakresy jednym patchem. Reset nie zmienia kamery, pól ani fizyki. To samo nazewnictwo w każdym miejscu; nie sugerować cięcia tylko zaznaczonego obiektu.

Podczas gestu dopuszczalny jest krótkotrwały draft lokalnego podglądu; po commit właścicielem jest nadal zasób serwera. Escape anuluje draft, off/on zachowuje uzgodnione ustawienia, focus/scroll i tożsamość Inspectora pozostają stabilne. Pending dotyczy danej transakcji; ACK starej zmiany nie nadpisuje nowszego gestu. Nie wysyłać żądania na każdy event pointer.

Cache bazowej topologii oddzielić od capów i field buffers. Klucz capu obejmuje session/domain generation, topology revision/hash, płaszczyzny świata, operację, zakres obiektów oraz właściwą identyfikację pola. Wynik starego workera/żądania odrzucić po zmianie klucza. Ruch płaszczyzny może przebudować małą geometrię capu — stary zakaz dowolnego rebuildu geometrii był zbyt szeroki — ale nie całą bazową topologię ani niepowiązane pola.

Demand-render: po zakończeniu gestu i settle zasobów brak samoczynnych klatek. Unmount/zmiana zakładki zwalnia capy, materiały, buforowane pochodne, worker jobs i subskrypcje, bez mutowania współdzielonych zasobów innych widoków.

## 5. Kolejność domknięcia i bramki etapów

To plan naprawczy wynikający z audytu, nie autoryzacja implementacji. Nazwy nowych plików są propozycjami; istniejące punkty wejścia identyfikuje §8. Każdy etap obejmuje test reprodukujący brak, minimalną implementację, review i dowód jego kryterium. Nie wykonywać szerokich podziałów plików wyłącznie według liczby linii.

| Etap | Zakres i pliki | Kryterium wyjścia |
|---|---|---|
| 1. Semantyka i migracja | S1–S3, `clipPlaneModel.ts`; proponowany `layers/clippingModel.ts` i test. Jedna definicja płaszczyzn, operacji, bounds i widoczności punktu. PATCH/PUT/restore, walidacja cienkich przedziałów i stare sesje | Zgodność oczekiwanej strony X/Y/Z/flip; wieloosiowy trim nie redukuje się do pierwszej osi; keep/remove mają różne, poprawne wyniki; round-trip nie zmienia intencji |
| 2. Materiały i passy | `Viewport3DCanvas.tsx`, `ClipPlaneLayer.tsx`, warstwy S8, shadery S12 i passy S10; proponowany `clippingMaterialPolicy.ts` | Wszystkie role cięte respektują model; HUD/ramki niecięte; Scientific/PBR/shadow/depth/AO i live/export zgodne. Test WebGL, nie tylko source-string |
| 3. Picking | S11; wspólny predykat z etapu 1, zastosowany przed wyborem hit | Klik przez usuniętą ścianę trafia widoczne wnętrze tego samego obiektu; brak ghost hover/select; regiony, airbox, FDM fallback i pick-from-face zgodne |
| 4. Wnętrze FDM | S8; proponowane `model/fdmCutawayGeometry.ts`, test i warstwa capu | Domyślne surface pokazuje rzeczywiste odsłonięte komórki i dane, bez wymuszenia full; poprawne cięcia przez komórkę, pustkę i granice warstw/airboxa |
| 5. Capy FEM i dane | S9, warstwy sceny; proponowane `model/femCutawayGeometry.ts` i `layers/CutSurfaceLayer.tsx`. Najpierw Tet4, następnie kwalifikowane mixed i association pól | Zgodność przecięć, wartości i ID dla wszystkich zadeklarowanych topologii; world-plane identyczny z shaderem; brak stale cap po remeshu/zmianie pola |
| 6. UI trim / presety / ACK | S5–S7; wykorzystanie istniejącego `ViewportClippingControls`, bez drugiego systemu | Jeden gest = jedna logiczna transakcja; Object/Airbox/antenna pokazują ten sam stan; klawiatura, cancel, reset, błędy i stary ACK nie psują nowszego stanu |
| 7. Kwalifikacja i dokumentacja | S13–S15; spec viewportu, API, nowy clipping-specific browser gate w zgodnej grupie Compose | Pełna macierz §6, aktualny source/fixture receipt, kadry i pomiary; bramka podpięta do CI; brak otwartych blokerów |

Zależności: 1 → 2 → 3; geometria 4/5 korzysta z 1–2, a jej picking musi spełniać 3. UI 6 można rozwijać po ustaleniu 1, lecz nie publikować „pełnego cutaway” przed 4/5/7. Etap z jawnym ograniczeniem można dostarczyć osobno, bez oznaczania całego celu jako zakończonego.

## 6. Macierz odbioru — co znaczy „ukończone”

Wszystkie pozycje poniżej są **otwartymi bramkami pełnej funkcji**, nie wynikami tego audytu. Test porównuje oczekiwany geometrycznie obraz/dane, nie sam fakt zmiany pikseli.

| ID | Scenariusz | Wymagany dowód |
|---|---|---|
| C01 | Połowa ±X/±Y/±Z, pozycje 0/25/50/75/100% | Znane punkty po obu stronach, shader i CPU zachowują właściwą stronę; poprawny flip |
| C02 | Warstwa i box, 0–6 granic, przejścia off/on | Zero granic to no-op keep/remove; obie granice każdej osi działają; poza zakresem keep nic nie zostaje; brak stratnej projekcji do jednej osi |
| C03 | Usunięcie narożnika vs pozostawienie narożnika | Test ośmiu oktantów: odejmowanie usuwa tylko wskazany obszar, nie jego dopełnienie; brak przypadkowej zamiany AND/OR |
| C04 | FDM surface/full, wielowarstwowość, otwory i airbox | Wnętrze faktycznie istnieje w renderze; cap pokazuje właściwe `cellIndex`, occupied mask i wartości; brak ukrytej zmiany gęstości |
| C05 | FEM Tet4 i obsługiwane mixed | Poligony, pole i probe zgodne z referencją; szwy, materiały i pustki poprawne; capability zgodne z realnym zakresem |
| C06 | Obiekty/regiony/airbox, surface/wireframe/points/vectors, scalar/complex/tensor | Każda aktywna warstwa respektuje właściwą politykę; brak nieciętych danych lub podwójnych powłok |
| C07 | Scientific i Presentation | Zachowana paleta ilościowa; ucięte części nie rzucają cieni ani nie występują w depth/normal/AO |
| C08 | HUD, ViewCube, bounds referencyjne, wymiary, ramki monitorów | Niezmienione referencje dla wszystkich osi i flip; prostokąt X ma właściwe rozmiary Y/Z |
| C09 | Click/hover/probe, region native pick, FDM fallback, pick-from-face | Brak ghost hits; dalsza zachowana ściana tego samego mesha nadal wybieralna; cap ma prawdziwą tożsamość |
| C10 | Inspector Object i Airbox oraz antena; held ACK/reject | Stabilny root, focus/scroll, zero obcych disabled/opacity/animacji; starszy ACK nie cofa nowszego gestu; kontrolowany rollback |
| C11 | PATCH, PUT, zapis/odtworzenie oraz stare sesje | Jeden kanoniczny stan; jawne reguły migracji flip/trim/operacji; brak cichej zmiany intencji |
| C12 | nm/µm/mm, przesunięty origin, różne scene/mesh bounds | Zgodny world-plane cap/shader/pick; cienkie warstwy nie znikają wskutek tolerancji lub minimum 1% |
| C13 | Remesh, nowa sesja, szybkie gesty, zmiana ilości/fazy pola | Odrzucone spóźnione odpowiedzi; cap nigdy nie korzysta z obcej generacji/association |
| C14 | PNG 1×/2×/4×, transparent, efekty i annotations on/off | To samo cięcie co live; poprawne capy i HUD; stan renderera odtworzony także po błędzie eksportu |
| C15 | 100 cykli on/off i mount/unmount, gest oraz idle | Zasoby wracają do baseline po settle; brak narastania programów/buforów/listenerów; 0 samoczynnych klatek podczas ustalonego idle |
| C16 | Duży rzeczywisty FDM i FEM, stała jakość | Zapisane p50/p95 czasu klatki i gestu, draw calls, uploads, liczba capów/instancji/żądań; brak rebuildu bazowej topologii przy samym ruchu cięcia; spełniony budżet projektu |

Każdy browser gate dodatkowo sprawdza widoczny canvas, `gl.isContextLost() === false`, niezerowy drawing buffer i brak błędów shaderów. Kadry off / połowa / warstwa / narożnik / flip / restore zapisuje po osobnych, ukończonych stanach. Sam ręczny offscreen render nie zastępuje asercji odświeżenia widocznego canvasa.

**Warunek zamknięcia:** wszystkie scenariusze objęte deklarowanym wsparciem mają świeże dowody na scalonej wersji. „Unsupported”, pusta zaślepka, screenshot bez oracle lub samo zaznaczenie checkboxów planu nie zastępują ukończenia celu.

## 7. Weryfikacja wykonana i granice dowodów

### 7.1 Tożsamość i środowisko

- Sprawdzono `git status --short`, pełny HEAD i `origin/master`; odświeżono wyłącznie ref przez fetch. Nie wykonywano checkout/pull/reset, commitów ani zmian aplikacji.
- Na początku brak tracked diff; zastane untracked `.cargo/`, dokumenty material-database, `exports/`, `reviews/`, `session-backups/` pozostawiono bez zmian.
- Hostowe `node_modules` są stare: Three `0.183.2`, mimo że lock aktualnego mastera wskazuje `0.186.1`. Nie użyto ich do kwalifikowania kodu.
- Odczyt istniejącej grupy Compose potwierdził `fullmag-master-frontend-1`, bind źródeł `D:/git/fullmag`, Three `0.186.1`, R3F `9.8.1`, Vitest `5.0.4`, TypeScript `6.0.2`.
- Nie uruchamiano ani nie restartowano usług, nie modyfikowano aktywnej sesji, nie instalowano pakietów i nie budowano frontendu/backendu.

### 7.2 Świeże kontrole interpretowane — wszystkie zakończone exit 0

W istniejącym kontenerze mastera, working directory `/state/development/workspace/apps/control-room`:

```text
node --experimental-vm-modules scripts/check-viewport-clipping-controls.mjs
=> status: passed, checks: 10
=> browser_qualification: false, unit_test_compilation: false
```

Sprawdzono alias antena/Universe, canonical/optimistic state, SSR disabled, draft do commit, izolację ownera, komendę i session context, błąd oraz unavailable. To interpretacja TSX z mock React/komendami, nie zamontowany Inspector.

Reprodukcja znaku użyła rzeczywistego `resolveClipPlaneFrame` i `Plane` z Three. Minimalny fragment do powtórzenia przez `node --input-type=module` w tym samym katalogu:

```js
import { resolveClipPlaneFrame } from './src/modules/viewport-3d/layers/clipPlaneModel.ts';
import { Plane, Vector3 } from 'three';
const bounds = { center: [0, 0, 0], size: [2, 2, 2], radius: 2 };
for (const flipped of [false, true]) {
  const f = resolveClipPlaneFrame({ enabled: true, axis: 'z', position_percent: 50, flipped }, bounds);
  const p = new Plane(new Vector3(...f.normal), f.planeConstant);
  console.log(flipped, [-0.5, 0.5].filter(z => p.distanceToPoint(new Vector3(0, 0, z)) >= 0));
}
// Observed: false -> [0.5], true -> [-0.5].
// The backend trim intervals require the opposite results.
```

W wykonanej kontroli dodatkowo asercja `notDeepEqual` potwierdziła obie niespójności. Nie uruchamiano handlera Rust; porównanie do backendu opiera się na odczytanym `apply_compatibility_clip_to_trim`.

Druga kontrola, również na Three z kontenera:

- `BoxGeometry(1,1,1)`, DoubleSide, lokalna płaszczyzna `+Z`, promień z `(0,0,-3)` w `+Z`: najbliższy surowy hit `z=-0.5` leży po odrzuconej stronie, a dalszy zachowany hit istnieje. To reprodukcja zachowania silnika, nie browser click przez produkcyjne handlery.
- `WebGLClipping.init([plane],true)` i `setState` materiału bez lokalnych płaszczyzn: `numPlanes=1`; po `beginShadows` i ponownym `setState`: `numPlanes=0`, mimo `clipShadows=true`. To reprodukcja stanu silnika, nie screenshot mapy cieni.

Node zgłosił ostrzeżenia o eksperymentalnych VM modules i rozpoznaniu modułu TS jako ESM; kontrole zakończyły się poprawnie. Nie zmieniano konfiguracji projektu w celu uciszenia ostrzeżeń.

### 7.3 Co pokrywają istniejące testy, ale nie było tu uruchamiane

`clipPlaneModel.test.ts` sprawdza pozycję/normalną, nie zgodność półprzestrzeni z backendowym trim. `viewport3dScalarSurfaceShader.test.ts` S-04 sprawdza flagę i tekst chunków, nie kompilację GLSL. Testy pick priority nie przyjmują punktu i płaszczyzn. Testy eksportu używają mocked renderer, bez oracle cięcia. Źródła: S13.

`verifyAntennaClipping` ma użyteczne kontrole: V/J/H na powierzchni czterech trójkątów, flip, zachowanie UUID/range/sample count, wyłączenie i odtworzenie piksela, limit PATCH oraz held ACK. Jednak używa jednego piksela i gestu `End` do 100%, nie macierzy przekrojów wewnętrznych. `FieldCanvasProbe` ukrywa dekoracje i wymusza render offscreen. Nie jest testem całej sceny, capów ani pary Inspector Object/Airbox. Źródło: S14.

W śledzonych materiałach nie znaleziono kompletnego clipping-specific receipt dla audytowanego SHA. Historyczny PASS anteny z 12 października odnosi się do źródeł sprzed dodania helpera clippingu; checkpoint Universe z 26 października jawnie oznacza Browser/WebGL jako NOT VERIFIED. Nie wolno przenosić tych wyników na bieżący master.

CI uruchamia Vitest oraz ogólne browser memory/topology gates, ale fixture tego gate ma clipping i trim wyłączone. Standalone check kontrolek i smoke anteny nie są podpięte do tych bramek. `audit:idle-performance` jest skanerem źródeł, nie pomiarem klatek. Źródło: S15.

### 7.4 Jak uruchomić pełną kwalifikację później

Użyć grupy Compose przypisanej do checkoutu/worktree i aktualnych recept `justfile`, zgodnie z `AGENTS.md`. Payload skupionych testów w poprawnym środowisku frontendu:

```text
pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/clipPlaneModel.test.ts src/modules/viewport-3d/viewport3dScalarSurfaceShader.test.ts src/modules/viewport-3d/viewport3dFieldPresentationMaterial.test.ts src/modules/viewport-3d/layers/viewport3DPickPriority.test.ts src/modules/viewport-3d/layers/regionOverlayPicking.test.ts src/modules/viewport-3d/viewport3dInspect.test.ts src/modules/viewport-3d/viewport3dImageExport.test.ts
```

To wskazanie istniejących testów, nie zastępstwo nowych C01–C16. Zmiany API/backendu wymagają własnych testów i właściwej zarządzanej ścieżki; brak potrzeby ponownego Solve przy samym cięciu.

**Uwaga wykonawcza:** `just verify-antenna-visualization-browser` istnieje, ale `verify_pinned_dataset_browser.py::run` przygotowuje hostowy snapshot i uruchamia `node next dev --webpack` na hoście. Nie uruchomiono tej trasy, ponieważ nie spełnia obecnego kontraktu budowania w przypisanej grupie Compose. Najpierw dostosować runner lub użyć już zgodnej ścieżki grupy; nie obchodzić reguły hostowym buildem.

Receipt pełnej kwalifikacji powinien przypinać SHA/source digest, fixture hash, lock/runtime versions, backend/device danych, topology/field generations, browser/GPU, rozmiar canvasa/DPR, wyniki asercji, PNG i pomiary. Sam istniejący kontener ani źródła testu nie są takim receiptem.

## 8. Mapa dowodów źródłowych

Ścieżki względem `D:/git/fullmag`; numery linii odnoszą się do przypiętego SHA. `V` oznacza `apps/control-room/src/modules/viewport-3d`, `I` — `apps/control-room/src/modules/inspector`, `K` — `apps/control-room/src/kernel`, `R` — `apps/control-room/src/modules/ribbon`. To skróty katalogów w tym raporcie, nie nowe moduły.

| ID | Plik : linia / symbol | Co potwierdza |
|---|---|---|
| S1 | `crates/fullmag-api/src/schemas/visualization_state.rs:32` — `VisualizationStateResource`; `:1031` — `TrimVisualizationPatch`; `:1073` — `ClipVisualizationState` | Kanoniczny trim, zgodnościowy clip, brak operacji odejmowania |
| S2 | `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs:1389` — `normalize_trim_axis`; `:1430` — `first_enabled_trim_axis`; `:1445` — `compatibility_clip_from_trim`; `:1465` — `apply_compatibility_clip_to_trim`; `:1753` — PATCH trim; `:184` — `replace_visualization_state` | Normalizacja, stratna konwersja, różnica PATCH/PUT |
| S3 | `crates/fullmag-api/src/types.rs:61` — `DisplayPresentationState`; `crates/fullmag-api/src/session_persistence.rs:138` — `DISPLAY_PRESENTATION_SCHEMA_VERSION`; `:146` — `restore_display_presentation` | Persistencja v10 obu stanów; potrzeba uzgodnionej migracji |
| S4 | `V/layers/clipPlaneModel.ts:26` — `resolveClipPlaneFrame`; `V/layers/ClipPlaneLayer.tsx:51` — `ClipPlaneLayer`, `:296` — `resolveClipPlaneFrameQuaternion`, `:407` — `applyRendererClipping` | Znaki, ramka, globalny setter, brak capu |
| S5 | `I/visualization/ViewportClippingControls.tsx:17` — `ViewportClippingControls`; `I/panels/ObjectVisualizationPanel.tsx:1611`; `I/panels/antenna/AntennaClippingControls.tsx:3` | Istniejące globalne kontrolki i alias |
| S6 | `R/ribbonContributions.tsx:2844` — `buildMeshViewAction`, `:2901` — trim stub, `:2962` — `buildClipAction`; `R/ribbonTabViews.tsx:570` | Działający clip i nieczynny trim |
| S7 | `R/ribbonCommands.ts:568` — `patchVisualizationStateFromCommand`, `:1045` — `patchVisualizationState`; `K/visualization/VisualizationRegistrySyncController.ts:285` — `flushNow` | Wspólna komenda, optimistic/inflight, ograniczenie ACK |
| S8 | `K/visualization/ObjectVisualizationController.ts:445` — `DEFAULT_OBJECT_VISUALIZATION`; `V/model/viewport3DFdmTargetViews.ts:342` — `resolveExactTargetSurfaceInstances`; `V/layers/FdmCuboidLayer.tsx:423` — `resolveFdmCuboidGeometryScopeInstanceOrdinals`; `V/layers/MeshPartLayer.tsx:163` — `createMeshPartSurfaceGeometry`; `V/layers/BoundsLayers.tsx:258` — geometria powierzchni | Powierzchniowe nośniki, wybór instancji, odrębny airbox |
| S9 | `V/hooks/useViewport3DSceneModel.ts:3981` — `clipCrossSectionQuery`, `:3994` — `clipIntersectionMarkers`; `apps/control-room/src/shared/domain/mesh/crossSectionQuery.ts:20` — `resolveCrossSectionQueryFromVisualizationState`; `K/api/codecs/crossSectionCodec.ts:19` — `decodeCrossSection`; `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs:886` — `require_tet4_cross_section_topology`, `:929` — `get_mesh_shared_domain_cross_section`; `crates/fullmag-api/src/fem_slice_overlay.rs:282` — wyznaczanie `cut_world` | Legacy FMCS v2, ograniczenie Tet4, procenty i markery |
| S10 | `V/layers/PostProcessingLayer.tsx:96` — `renderAnnotations`; `V/viewport3dImageExport.ts:466` — `renderScenePixels`; `V/viewport3dFieldPresentationMaterial.ts:22` — constructor | Brak izolacji globalnego clippingu, PBR i capture |
| S11 | `V/viewport3dEventManager.ts:144` — `createViewport3DEventManager`; `V/layers/viewport3DPickPriority.ts:11` — `viewport3DPickShouldDefer`; `V/layers/MeshPartLayer.tsx:1231` — `handlePointerDown`; `V/layers/FdmCuboidLayer.tsx:1611` — raw raycast; `V/layers/Viewport3DScene.tsx:1715` — `RegionOverlayNativePickingLayer`; `V/layers/PlanarMonitorFacePicker.tsx:45` — wybór hit | Niezależne ścieżki interakcji wymagające jednego predykatu |
| S12 | `V/viewport3dScalarSurfaceShader.ts:75` — `createScalarSurfaceShaderMaterial`, `:98` — `clipping:true`; `V/layers/antennaCurrentSurfaceMaterial.ts:16`; `V/viewport3dFieldPresentationMaterial.ts:38` — `onBeforeCompile` | Obecna integracja clippingu shaderów, reuse PBR |
| S13 | `V/layers/clipPlaneModel.test.ts:32`; `V/viewport3dScalarSurfaceShader.test.ts:485`; `V/layers/viewport3DPickPriority.test.ts:8`; `V/layers/regionOverlayPicking.test.ts:35`; `V/viewport3dInspect.test.ts:37`; `V/viewport3dImageExport.test.ts:168` | Zakres istniejących testów modelu i mocków |
| S14 | `apps/control-room/scripts/check-viewport-clipping-controls.mjs:58`; `apps/control-room/scripts/lib/antenna-clipping-browser-checks.mjs:4` — `verifyAntennaClipping`; `apps/control-room/scripts/fixtures/antenna-visualization-page.tsx:329` — `FieldCanvasProbe` | Kontrolki, wąski browser fixture i wymuszony offscreen pixel probe |
| S15 | `scripts/ci/run_frontend3d_required_gate.sh:56`, `:105`; `.github/workflows/bootstrap.yml:704`; `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs:3605`, `:3657`; `apps/control-room/scripts/audit-idle-performance.mjs:1`; `justfile:926`; `scripts/verify_pinned_dataset_browser.py:403` | Faktyczny zakres CI i niezgodna z obecnym DEV ścieżka hostowego runnera |
| S16 | `crates/fullmag-api/src/planar_sampling/fem.rs:96` — `build_overlay`; `crates/fullmag-api/src/fem_cross_section.rs:144` — `serialize_planar_overlay_fmcs_v4`; `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs:1402` — `planar_mesh_overlay_response`; `K/api/codecs/crossSectionCodec.ts:165` — `decodePlanarMeshOverlay` | Nowszy pipeline do reuse; poligony w payloadzie, obecnie pomijane przez dekoder overlay |

Dokumenty kontraktowe i historyczne:

- [Architektura viewportu](../../specs/frontend-v2/05-viewport-architecture.md) oraz [moduł 3D](../../specs/frontend-v2/14-viewport-3d-module.md): jeden viewport, demand-render, ownership, Scientific/Presentation i eksport.
- [Kontrakt PlanarMonitor](../../physics/0970-planar-monitor-sampling-and-projection.md): kanoniczny sampling i jawne ograniczenia kwalifikacji; użyto jako referencji, nie zmieniano publikacji naukowej.
- [Historyczny audyt anteny](../../superpowers/plans/2026-10-11-microwave-antenna-pro-review-follow-up.md) (linia 127) i [checkpoint Universe](../../superpowers/plans/2026-10-25-antenna-universe-repair-plan.md) (linia 1090): wcześniejsze dowody nie kwalifikują pełnego cutaway na obecnym SHA.

## 9. Decyzje przed implementacją

Audyt można zamknąć bez zmiany zachowania aplikacji. Wykonanie wymaga zapisania w specyfikacji trzech decyzji produktowo-kontraktowych:

1. **Migracja starych sesji:** czy zachowujemy dawny widoczny kierunek legacy clip, czy intencję przedziału trim? Rekomendacja: nowy kontrakt zgodny z trim, jawna migracja zapisów legacy i test przed/po; bez zgadywania w każdej klatce.
2. **Zakres dostawy:** rekomendowane są oba tryby keep/remove i capy ilościowe, etapowane FDM/Tet4/mixed. Ograniczenie do pustej powłoki lub samego Tet4 nie oznacza ukończenia pierwotnego celu.
3. **Granice i cienkie warstwy:** rekomendacja to wspólny world-plane oraz jawna walidacja, bez obecnego nieudokumentowanego minimum 1%. Kontrakt musi określać zachowanie równego/odwróconego zakresu i granic domeny.

**Pierwszy sensowny fragment implementacji:** regresja znaku + kanoniczny model cięcia i migracja/normalizacja. Dopiero potem podłączanie kolejnych kontrolek. Pozwala to uniknąć sytuacji, w której nowe UI utrwala niespójną semantykę, a zielony test przycisków ponownie zostaje uznany za ukończony mechanizm przekrojów.
