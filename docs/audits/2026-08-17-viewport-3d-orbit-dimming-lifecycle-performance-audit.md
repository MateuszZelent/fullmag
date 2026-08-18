# Audyt przygaszania podczas orbitowania i wydajności wizualizacji 3D

**Data:** 2026-08-17  
**Repozytorium:** `fullmag/fullmag`  
**Rewizja bazowa:** `e8c08d4b17a358ecbf5a8547567622ea13a5c3a0`  
**Stan analizowany:** bieżący working tree; w `viewport-3d` istnieją niezacommitowane zmiany użytkownika  
**Zakres:** Control Room v2, R3F/Three.js, orbitowanie, materiały, post-processing, render loop, warstwy FDM/FEM, workery, upload GPU, diagnostyka, zasoby i testy wydajności  
**Charakter pracy:** audyt źródłowy, analiza historii Git, wdrożenie zatwierdzonych poprawek i uruchomienie dostępnych bramek

## 1. Werdykt

Wizualizacja 3D **nie jest w pełni zoptymalizowana**. Jej fundamenty są sensowne: jeden canvas, `frameloop="demand"`, brak publikowania kamery do Reacta na każdej klatce, workery dla cięższych transformacji i jawne zwalnianie wielu zasobów WebGL. W ścieżce orbitowania nadal występują jednak operacje, które nie powinny należeć do krytycznej pętli interakcji.

Zgłoszone „przygaszanie” nie jest obniżeniem DPR ani celowym wariantem materiału. Jest to **deterministyczny błąd utrzymania ostatniego gotowego bufora pola** uruchamiany przez `pointerdown` na root viewportu. W trybie zależnym wyłącznie od pola — w szczególności „tylko wektory” — błąd zeruje źródło renderu na czas gestu, a następnie przywraca je po `pointerup`. Użytkownik widzi zanik i ponowne wyrenderowanie całej wizualizacji.

Najważniejsze ustalenia:

1. **Historyczna redukcja jakości R3F nie jest obecnie aktywna.** DPR jest stałe dla profilu, canvas pozostaje w `frameloop="demand"`, `DreiOrbitControls` nie używa `regress`, a test `does not regress Canvas DPR during orbit interactions` chroni ten kontrakt.
2. **Każdy pointer-down w obszarze viewportu przełącza globalny hold pól i zeruje podstawowy bufor renderowany.** Dla gotowego zasobu `incomingFieldVectorReady=true`, lecz `previousFieldVectorCompatible=false`, ponieważ warunek wymaga `status !== "ready"`. Przy aktywnym holdzie wywołanie sprowadza się więc do `resolveViewport3DDisplayedLiveValue(incomingEnvelope, null, true)`, co zwraca `null`.
3. **Build deweloperski i audytowy rejestruje pełną próbkę trajektorii na każdej zmianie kamery.** Powstają obiekty, tablice i klony; bufor 4096 elementów używa `shift()`. Sam audyt może przez to pogarszać zachowanie, które mierzy.
4. **N8AO pozostaje osobnym ryzykiem przygaszania, ale nie jest potrzebny do wyjaśnienia zgłoszonego zaniku.** Efekt ma mocne, stałe parametry (`intensity=2.5`, `aoRadius=0.5`) i jest ekranowy. Błąd hold/last-good występuje również przy AO wyłączonym.
5. **Drugim źródłem ryzyka są transparentne passy.** Powierzchnie o opacity mniejszym niż 1 są `DoubleSide`, `transparent=true`, `depthWrite=false` i sortowane jako całe obiekty. Zmiana kąta może zmieniać liczbę nakładających się fragmentów i kolejność blendowania, dając wrażenie przygaszania.
6. **Kontrolka Anti-Aliasing jest niespójna z rzeczywistym rendererem.** Gdy AO i Bloom są wyłączone, `PostProcessingLayer` zwraca `null`, więc przełącznik nie zmienia niczego. Antialias bazowego WebGL zależy od profilu jakości i wymaga odtworzenia kontekstu.
7. **Obecny `audit:idle-performance` jest testem tekstowych wzorców, nie pomiarem runtime.** Jego PASS nie dowodzi zera klatek idle, braku long tasków ani braku wzrostu pamięci.
8. **Bieżąca kwalifikacja browser/WebGL nie została uzyskana.** Build audytowy zatrzymuje się na osieroconym linku katalogu Next.js. Nie wolno zastępować tego braku statycznym PASS-em.
9. **Tryb „tylko wektory” omija istniejący ogranicznik lokalnej skali.** Globalna długość żądana wynosi `5% * najdłuższy wymiar sceny * lengthScale`. Standardowa ścieżka cuboidu ogranicza ją przez `resolveFdmVectorGlyphScale(...)`, ale early-return `vectorOnly` przekazuje `request.vectorScale` bezpośrednio do `buildFdmVectorSegmentsFromAnchors(...)`. Wyłączenie shadera może więc natychmiast powiększyć strzałki, mimo że pole, target i ustawienia użytkownika się nie zmieniły.
10. **Proporcje glyphu wzmacniają błąd skali.** Promień główki to 20% długości, czyli średnica główki zajmuje 40% długości całej strzałki; promień trzonu to 8%. Przy zawyżonej długości strzałki stają się jednocześnie zbyt długie i zbyt masywne.

## 2. Status dowodu

| Teza | Status | Dowód |
|---|---|---|
| Istnieje celowy efekt dim podczas orbitowania | **nie** | Historyczny R3F `regress` nie jest podłączony; test zabrania jego powrotu. |
| Pointer-down usuwa gotowy podstawowy bufor pola z modelu renderu | **tak, potwierdzone deterministycznie** | `resolveViewport3DDisplayedLiveValue(incomingReady, null, true)` zwraca `null`; wynik trafia do `committedFieldVector`. |
| Orbitowanie publikuje stan React na każdej klatce | **nie** dla kamery | `recordOrbitControlFrame` zapisuje commit dopiero po `onEnd` i damping settle. |
| Pointer gesture zmienia stan React całego modelu sceny | **tak** | `useViewport3DFieldUpdateHoldActive()` przełącza się na pointer-down/up. |
| AO może zmieniać jasność podczas ruchu | **ryzyko wysokie, dynamicznie niepotwierdzone** | N8AO jest ekranowym post-processem o wysokiej intensywności; domyślnie OFF. |
| Transparentne passy mogą dawać view-dependent dimming | **ryzyko wysokie, dynamicznie niepotwierdzone** | `transparent`, `DoubleSide`, `depthWrite=false`, obiektowe sortowanie. |
| Canvas jest demand-driven | **potwierdzone źródłowo i testowo** | `VIEWPORT_3D_FRAMELOOP = "demand"`; statyczny audit PASS. |
| Idle runtime ma dokładnie zero klatek | **niezmierzone** | Obecny audit nie uruchamia przeglądarki. |
| Orbit p95 i GPU frame time mieszczą się w budżecie | **niezmierzone** | Brak świeżego profilu runtime. |
| Zasoby nie rosną po 100–120 przełączeniach | **niezweryfikowane w tym audycie** | Browser memory-churn gate zablokowany przed startem. |
| WebGL context jest zdrowy po interakcji | **niezweryfikowane w tym audycie** | Brak bieżącego browser smoke. |
| Skala glyphów odpowiada lokalnemu rozstawowi próbek | **nie we wszystkich ścieżkach** | Standardowy cuboid ma lokalny cap; `vectorOnly` go omija i używa globalnych 5% sceny. |

## 3. Przepływ orbitowania

```text
pointerdown na root viewportu
  -> beginViewport3DFieldUpdateHold()
  -> ResourceRuntimeStore.beginPauseMatching(.../fields/.../samples/vector)
  -> useViewport3DFieldUpdateHoldActive() publikuje nowy snapshot
  -> szeroki useViewport3DSceneModel wykonuje się ponownie
  -> wiele hooków pola dostaje pauseLoad=true

OrbitControls onStart
  -> begin camera gesture / CameraRegistry.beginInteraction

OrbitControls onChange dla każdej klatki ruchu i dampingu
  -> tracker.recordDirtyFrame("camera-control")
  -> zapis diagnostycznej trajektorii kamery
  -> R3F renderuje żądaną klatkę
  -> HUD wykonuje useFrame
  -> opcjonalny EffectComposer wykonuje AO/Bloom

pointerup
  -> endViewport3DFieldUpdateHold()
  -> ResourceRuntimeStore wznawia requesty
  -> ponowne wykonanie szerokiego modelu sceny

OrbitControls onEnd + 180 ms ciszy po dampingu
  -> jeden commit kamery do rejestru/store
```

Krytyczna obserwacja: zatrzymanie transportu pól podczas gestu może być uzasadnione, ale **nie wymaga subskrypcji React po stronie całego modelu sceny**. Kamera porusza się lokalnie w Three.js; immutable topology i aktualnie przyjęte bufory pola powinny pozostać nietknięte.

## 4. Ustalenia dotyczące przygaszania

### D-01 — P1: brak testu odróżniającego celowe dimming od artefaktu kompozycji

Nie istnieje test porównujący luminancję tego samego obiektu przy tej samej pozycji kamery: raz w trakcie aktywnego gestu i raz po settle. Testy kamery sprawdzają stan, commit i brak rewind, ale nie wynik pikselowy.

**Znaczenie:** bez testu każda hipoteza — AO, blendowanie, utrata bufora koloru, post-processing albo CSS — pozostaje częściowo spekulacyjna.

**Pliki i symbole:**

- `layers/CameraControls.tsx`: `recordOrbitControlFrame`, `handleTransitionStart`, `handleEnd`;
- `layers/PostProcessingLayer.tsx`: `PostProcessingLayer`;
- `layers/viewport3DRenderPolicy.ts`: `RENDER_POLICIES`, `surfaceMaterialPolicyProps`;
- `scripts/smoke-viewport-3d.mjs` i nowy test browserowy orbit/luminance.

**Naprawa:**

1. Dodać audytowy hook odczytu bieżącej kamery i aktywności gestu bez zmiany produkcyjnego stanu.
2. Przygotować deterministyczny fixture z jednym nieprzezroczystym obiektem, stałym kolorem i wyłączonym AO/Bloom.
3. Ustawić pozycję A, rozpocząć orbitę, przejść przez pozycję B i zapisać histogram luminancji maski obiektu.
4. Zakończyć gest, ustawić dokładnie tę samą pozycję B i ponownie zapisać histogram.
5. Powtórzyć macierz: opaque, opacity 35%, Airbox, AO ON/OFF, Bloom ON/OFF, FDM/FEM.
6. Zapisywać PNG oraz metryki; nie akceptować oceny „na oko”.

**Brama:** dla opaque i post-processingu OFF różnica mediany luminancji tej samej maski nie przekracza 2%; żadna ramka gestu nie zmienia opacity/uniformów materiału.

### D-02 — P1: N8AO może powodować niepożądane przyciemnienie zależne od kamery

`PostProcessingLayer` tworzy N8AO z `intensity={2.5}`, `aoRadius={0.5}` i `halfRes`. Parametry nie są związane ze skalą domeny, rozmiarem komórki ani profilem jakości. W scenie naukowej o rozmiarach od nanometrów do mikrometrów stały promień ekranowo/światowy nie ma stabilnej interpretacji.

AO jest domyślnie wyłączone, ale użytkownik może je włączyć z dialogu „3D Render Effects”. Jeżeli problem występuje po takim włączeniu, D-02 jest pierwszym kandydatem do potwierdzenia.

**Naprawa:**

1. Natychmiastowo kwalifikować problem z AO OFF; nie zmieniać innych zmiennych.
2. Jeżeli dimming znika, usunąć N8AO z kanonicznego profilu interaktywnego albo pozostawić je wyłącznie jako jawny efekt prezentacyjny.
3. Nie obniżać jakości powierzchni podczas ruchu jako „fix”. Domyślna jakość ma pozostać niezmienna.
4. Jeśli AO zostaje, wprowadzić skalowany model promienia, profilowane parametry i test obrazu dla ruchu oraz settle.
5. Zmierzyć koszt GPU osobno dla OFF/ON; raportować p50/p95 i liczbę passów.

**Brama:** AO OFF daje stabilną luminancję; AO ON nie zmienia średniej luminancji globalnej podczas ruchu o więcej niż zatwierdzony próg i ma udokumentowany budżet GPU.

### D-03 — P1: transparentne powierzchnie mają niestabilny wizualnie kontrakt sortowania

Dla `opacity < 1` powierzchnia przechodzi na `contextSurface`: `transparent=true`, `depthWrite=false`, `DoubleSide`, stały `renderOrder=10`. Three.js sortuje transparentne obiekty, a nie pojedyncze trójkąty. W modelach wieloczęściowych, przy Airboxie i nakładających się powierzchniach kolejność blendowania może zależeć od kamery.

To nie powinno dotyczyć zwykłego obiektu o domyślnym opacity 100%, ale dotyczy Airboxa (domyślnie 28%), stale/ghost view (limit 35%) oraz ręcznie ustawionych półprzezroczystych obiektów.

**Naprawa:**

1. Rozdzielić testy opaque i transparent; nie naprawiać opaque przez zmianę globalnego blendingu.
2. Dla objętości zamkniętych rozważyć jawne passy back-face/front-face zamiast jednego `DoubleSide`.
3. Utrzymać Airbox surface i wireframe jako niezależne passy.
4. Nie włączać `depthWrite=true` globalnie dla transparentnych powierzchni — ukryje to część geometrii.
5. Dodać fixture dwóch przecinających się targetów i obrót 360° z analizą luminancji/coverage.

**Brama:** brak skoków luminancji i znikających fragmentów w macierzy transparentnych targetów; kolejność passów jest jawna i pokryta testami.

### D-04 — P2: nie ma jednego przełącznika „bez efektów” gwarantującego naukowy rendering

AO, Bloom, antyaliasing kompozytora, profile DPR, tone mapping i materiały są sterowane w kilku miejscach. Profile mają obecnie `toneMapping="none"`, co jest właściwe dla stabilności koloru, ale UI nie pokazuje użytkownikowi jednoznacznie, czy obraz jest renderem naukowym czy prezentacyjnym.

**Naprawa:**

1. Zdefiniować profil `Scientific` jako kanoniczny: AO OFF, Bloom OFF, tone mapping none, stała jakość podczas interakcji.
2. Efekty prezentacyjne trzymać za jawnym profilem `Presentation`, nie jako luźne przełączniki bez provenance.
3. Eksport PNG powinien zapisywać identyfikator profilu i efekty w metadanych/provenance.

**Brama:** domyślny profil ma deterministyczne kolory i nie zmienia wyglądu w zależności od aktywności gestu.

## 5. Ustalenia wydajności i lifecycle

### P-01 — P1: pointer hold niepotrzebnie rerenderuje cały model sceny

Root `.fm-viewport-3d` uruchamia hold dla przycisków 0–2 na `onPointerDownCapture`. `useViewport3DFieldUpdateHoldActive()` jest subskrypcją zewnętrznego store'u wewnątrz `useViewport3DSceneModel`. Zmiana `false -> true -> false` powoduje dwa przejścia całego hooka, który ma ponad 6000 linii i dziesiątki `useMemo`/resource hooks.

Hold obejmuje również kliknięcia kontrolek i HUD-u znajdujących się w root, nie tylko realne orbitowanie.

**Naprawa:**

1. Przenieść sterowanie pauzą do `ResourceRuntimeStore`/kontrolera gestu poza React render path.
2. Rozpoczynać hold dopiero po faktycznym `OrbitControls.onStart`, a nie na każdym pointer-down rootu.
3. Kończyć go na settle/cancel z ochroną epoch, analogicznie do `CameraRegistryController`.
4. Hooki zasobów powinny odczytywać pause policy w runtime store, bez zmiany propsów render modelu.
5. Zachować last-good field buffers i immutable topology przez cały gest.

**Testy:** licznik renderów `Viewport3DModule`, request log i build diagnostics podczas 100 gestów; kliknięcie legendy/HUD nie może pauzować pól.

**Brama:** czyste orbitowanie generuje 0 renderów React rootu i 0 zmian resource identity; dopuszczalne są wyłącznie demand frames kamery.

### P-02 — P1: trajectory probe wykonuje alokacje na każdej klatce w dev/audit

`recordCameraTrajectory("change", epoch)` buduje pełny snapshot: `camera.position.toArray()`, target/up, store camera i timestamp. Aktywny probe klonuje próbkę ponownie. Po osiągnięciu 4096 elementów wykonuje `samples.shift()`, czyli przesuwa tablicę.

W produkcji probe jest NOOP, ale obiekt próbki nadal jest konstruowany przed wywołaniem no-op. W dev/audit probe jest aktywny, więc może zafałszować profil interakcji.

**Naprawa:**

1. Eksportować `viewport3DCameraTrajectoryProbeEnabled()` i sprawdzać ją przed budową próbki.
2. Domyślnie wyłączyć probe także w development; włączać go osobną flagą audytową.
3. Zastąpić `shift()` buforem pierścieniowym o stałym koszcie O(1).
4. W trybie ciągłym próbkować maksymalnie raz na frame budget albo co N-tą klatkę; start/commit/settle zachować bez próbkowania.
5. Audyt wydajności uruchamiać osobno z probe OFF i diagnostycznie z probe ON.

**Brama:** produkcyjna i bazowa deweloperska ścieżka `onChange` nie alokuje snapshotu diagnostycznego; probe nie zmienia orbit p95 o więcej niż 2%.

### P-03 — P2: Orientation HUD i View Cube dokładają pracę do każdej klatki orbitowania

HUD używa `useFrame` do przeliczania screen anchor i skali. Każda z sześciu etykiet View Cube wykonuje osobny `Matrix4.copy().invert()` oraz aktualizację rotacji. Każda ściana mapuje też wiele osobnych meshów i linii, zamiast jednego zbatchowanego/instancjonowanego modelu.

Nie jest to pętla idle, bo `frameloop="demand"`, ale jest to stały narzut każdej aktywnej klatki kamery.

**Naprawa:**

1. Wyliczać orientację kamery raz na klatkę w komponencie nadrzędnym.
2. Przekazać wynik sześciu etykietom albo ustawić wspólny quaternion grupy.
3. Zbatchować siatki i komórki View Cube; zmiany hover realizować atrybutem instancji/uniformem.
4. Zmierzyć draw calls z HUD ON/OFF przed refaktorem.

**Brama:** HUD nie wykonuje więcej niż jednego obliczenia basis/inverse na klatkę; liczba draw calls spada bez zmiany funkcjonalności i dostępności.

### P-04 — P2: pełny snapshot `viewport3dStore` jest subskrybowany przez root

`useViewport3DCommandState()` zwraca cały snapshot store'u. Zmiana dialogu, efektu, inspect, profilu, colorbar range lub dowolnego widgetu rerenderuje `Viewport3DModule` i przekazuje cały `commandState` do szerokiego modelu sceny.

**Naprawa:**

1. Dodać selektory `useViewport3DCommandSelector(selector, isEqual)`.
2. Rozdzielić camera controls, visual profile, overlays, dialogs i diagnostics na niezależne subskrypcje.
3. Do render modelu przekazywać tylko pola zmieniające scenę.
4. Dialogi i HUD DOM trzymać poza subskrypcją ciężkiego modelu R3F.

**Brama:** otwarcie Camera/Settings dialogu nie przebudowuje field/topology render modelu i nie invaliduje canvasu.

### P-05 — P2: `useViewport3DSceneModel` łączy za dużo domen i utrudnia izolację kosztu

Hook obejmuje zasoby sceny, topologię, Airbox, targety, pola, kolory, scalar ranges, wektory, regiony, analizę zespoloną, replay, diagnostics i debug publication. Sama liczba `useMemo` nie jest problemem, ale wspólny owner oznacza, że granice invalidacji są trudne do zmierzenia i utrzymać.

**Naprawa:**

1. Najpierw dodać render-reason i build-reason measurements; nie dzielić pliku mechanicznie.
2. Wydzielić stabilne kontrolery według ownership: topology, field demand/data, derived buffers, overlays, diagnostics.
3. Każdy kontroler ma zwracać revisioned immutable snapshot i własny equality contract.
4. Finalny assembler ma składać referencje bez kopiowania typed arrays.
5. Zachować wspólny renderer FDM/FEM; nie tworzyć dwóch viewportów.

**Brama:** unrelated revision nie wykonuje żadnego builda; quantity switch nie przebudowuje topology; selection nie refetchuje field data.

### P-06 — P2: ustawienie Anti-Aliasing jest częściowo no-op i nie opisuje kosztu

Bazowy canvas dostaje `antialias` z profilu jakości. Przełącznik `effectAntialias` steruje wyłącznie `EffectComposer.multisampling`, ale composer nie istnieje, gdy AO i Bloom są wyłączone. Użytkownik może więc przełączyć opcję bez efektu wizualnego i bez zmiany kosztu.

**Naprawa:**

1. Rozdzielić etykiety `Canvas MSAA` i `Post-process MSAA`, jeśli oba mechanizmy są potrzebne.
2. Jeśli wspierany ma być tylko jeden mechanizm, usunąć drugi przełącznik.
3. Pokazywać, kiedy zmiana wymaga remountu kontekstu WebGL.
4. Dodać test DOM i browser screenshot dla ON/OFF.

**Brama:** każda dostępna kontrolka powoduje mierzalną i opisaną zmianę renderera; brak przełączników no-op.

### P-07 — P2: statyczny idle audit daje zbyt silny komunikat PASS

`audit-idle-performance.mjs` wyszukuje tekst: `frameloop="always"`, `setInterval`, liczbę `requestAnimationFrame` i komentarze allow-listy. Nie uruchamia workspace, nie odczytuje frame count, requestów, long tasków, heap ani WebGL resources.

**Naprawa:**

1. Zachować skrypt jako `check:idle-architecture`.
2. Dodać prawdziwy `audit:idle-performance` z 10–30 s oknem po settle.
3. Mierzyć frames, dirty reasons, requesty, long tasks, heap i renderer.info.
4. Failować na każdej klatce bez jawnego dirty reason.

**Brama:** statyczny check i runtime audit są osobnymi bramkami; runtime raportuje liczby, nie samo `passed`.

### P-08 — P2: browser memory gate jest obecnie zablokowany przez stan katalogów build

`audit:viewport-3d-memory-churn` przed uruchomieniem browsera wykonuje `build:audit:webpack`. Next.js kończy się na `ENOENT` dla osieroconego `.next-audit-target-smoke-spin-authoring-unblocked-019f`, którego link wskazuje na nieistniejący `/dev/shm/...`.

W repo istnieje wiele historycznych `.next-audit-target-smoke-*`. Sam audyt nie ma bezpiecznego, izolowanego dist dir oraz preflightu odrzucającego uszkodzone targety.

**Naprawa:**

1. Nie usuwać katalogów automatycznie w ramach kodu produktu.
2. Dodać read-only preflight z jednoznaczną listą osieroconych linków.
3. Każdy browser audit ma używać własnego `FULLMAG_NEXT_DIST_DIR` i cleanupu wyłącznie katalogu, który sam utworzył.
4. Dodać owner marker i trap cleanup; nie skanować historycznych targetów jako wejścia builda.
5. Osobną operację porządkową wykonywać dopiero po potwierdzeniu, że żaden proces/agent nie używa targetu.

**Brama:** 120-switch memory churn kończy się raportem heap/WebGL/listeners/workers, a nie błędem preflight/build.

### P-09 — P3: LightingRig jest obecnie semantycznie martwy dla głównych powierzchni

`Viewport3DLightingRig` tworzy ambient light, ale główne powierzchnie używają `MeshBasicMaterial` albo własnego `ShaderMaterial` bez oświetlenia. Rig nie ma directional ani hemisphere lights. Nazwy profili `lighting` sugerują różne oświetlenie, którego renderer powierzchni nie konsumuje.

To nie jest źródło dimmingu; przeciwnie, potwierdza, że standardowa powierzchnia nie powinna zmieniać jasności przy obrocie względem światła.

**Naprawa:**

1. Dla naukowego renderingu usunąć martwy LightingRig i pole `lighting`, jeżeli służy tylko do opacity chrome/HUD.
2. Jeśli potrzebny jest opcjonalny rendering lit, wprowadzić jawny osobny materiał/profil i jego kwalifikację kolorystyczną.
3. Nie mieszać lit shading z kolormapą pola bez legendy/provenance.

**Brama:** brak martwych świateł i mylących nazw profili; obrót opaque scientific surface nie zmienia luminancji.

### P-10 — P3: damping jest poprawny funkcjonalnie, ale nie ma budżetu settle

`enableDamping=true`, `dampingFactor=0.08`, a commit następuje po 180 ms ciszy. Jest to poprawna, quality-preserving animacja, lecz liczba klatek po pointer-up zależy od OrbitControls i nie jest raportowana.

**Naprawa:**

1. Zmierzyć liczbę i czas klatek od `onEnd` do settle.
2. Ustalić budżet czasu settle oraz sprawdzić touch/mouse/trackpad.
3. Nie wyłączać dampingu wyłącznie po to, by ukryć koszt innych passów.

**Brama:** settle jest ograniczony, nie publikuje wielu commitów i nie uruchamia buildów/resource fetches.

## 6. Co jest już zrobione dobrze

1. Jeden canvas R3F i `frameloop="demand"`.
2. Brak `setInterval` w produkcyjnym module viewportu.
3. Kamera live pozostaje własnością OrbitControls podczas gestu; React nie nadpisuje jej co 180 ms.
4. Commit kamery jest odroczony do zakończenia gestu i dampingu.
5. Canvas używa `ResizeObserver` z porównaniem wymiarów.
6. Cięższe transformacje mają schedulery/workery, cache i anulowanie.
7. Geometrie, materiały i tekstury mają w wielu warstwach jawne `dispose`/tracker release.
8. Zmiana quantity jest projektowana jako zmiana buforów, nie topology.
9. Profile nie obniżają jakości automatycznie podczas interakcji — zgodnie z zasadą zachowania jakości.
10. WebGL context loss i drawing buffer mają instrumentation.

Te elementy należy zachować podczas naprawy. Optymalizacja nie może polegać na ukrywaniu warstw, redukcji glyphów albo niższym DPR jako nowym domyślnym zachowaniu.

## 7. Minimalna kolejność naprawy

### Etap 0 — reprodukcja i pomiar

1. Odblokować izolowany audit build bez kasowania współdzielonych targetów.
2. Dodać orbit luminance matrix.
3. Zmierzyć AO OFF/ON i opacity 100/35.
4. Zmierzyć React renders, draw calls, CPU/GPU frame p50/p95, settle frames i requesty.

### Etap 1 — usunięcie zbędnej pracy z gestu

1. Przenieść field-update pause poza React scene model.
2. Uruchamiać pauzę tylko z prawdziwego OrbitControls gesture.
3. Wyłączyć/ograniczyć trajectory probe i zastosować ring buffer.

### Etap 2 — naprawa przygaszania

1. Jeżeli winny jest AO: usunąć z profilu naukowego i skorygować profil prezentacyjny.
2. Jeżeli winne jest transparency sorting: wdrożyć jawne passy front/back dla właściwych targetów.
3. Jeśli żadne: użyć pixel testu do zawężenia shader/color-buffer adoption i post-processingu.

### Etap 3 — redukcja kosztu renderer/HUD

1. Zbatchować View Cube.
2. Jedno obliczenie orientacji HUD na frame.
3. Wprowadzić selektory store i rozdzielić ownership modelu sceny.

### Etap 4 — bramki produkcyjne

1. Runtime idle audit.
2. 120 quantity/profile/3D–2D switches.
3. WebGL context health po każdym scenariuszu.
4. Browser screenshots i luminance diff.

## 8. Mierzalne bramki akceptacji

### Poprawność wizualna

- opaque scientific surface: różnica luminancji active/settled przy tej samej kamerze <= 2%;
- brak interaction-dependent zmian opacity, exposure, palette, scalar range i visible layers;
- transparent Airbox: brak skoków blendowania podczas pełnego obrotu;
- AO/Bloom OFF jest domyślnym i jednoznacznym profilem naukowym;
- osobne dowody FDM i FEM oraz surface/wireframe/points/vectors.

### Interakcja

- 0 React root renders podczas czystego orbitowania;
- 0 topology builds, 0 field refetches i 0 scalar-color rebuilds spowodowanych kamerą;
- maksymalnie jeden commit kamery po settle;
- brak nieograniczonego RAF po pointer-up;
- p50/p95 CPU i GPU frame są raportowane dla jawnego fixture i sprzętu.

### Idle

- 0 viewport frames po settle w oknie co najmniej 10 s;
- 0 requestów 3D-only przy nieaktywnym tabie;
- 0 aktywnych viewport RAF/timer po unmount;
- brak powtarzalnych long tasks.

### Pamięć i lifecycle

- po 120 przełączeniach ilość canvas/context/listener/observer/worker wraca do baseline;
- zasoby module-owned wracają do zera po unmount;
- bounded heap i WebGL resource growth z raportowanymi wartościami;
- `gl.isContextLost() === false` i niezerowy drawing buffer po powrocie do 3D.

## 9. Wykonana weryfikacja

| Polecenie | Wynik | Interpretacja |
|---|---|---|
| `pnpm --dir apps/control-room audit:idle-performance` | **PASS** | Tylko statyczne wzorce architektury idle. |
| Focused Vitest: CameraControls, layer performance, LightingRig, Canvas, Module | **PASS: 5 plików, 110 testów** | Potwierdza obecne kontrakty źródłowe; nie mierzy obrazu ani runtime GPU. |
| `pnpm --dir apps/control-room typecheck` | **FAIL** | Istniejący test `viewport3dDiagnostics.test.ts` nie przekazuje wymaganych `fieldRevision` i `topologyRevision`. |
| `pnpm --dir apps/control-room audit:viewport-3d-memory-churn` | **BLOCKED** | Build audit kończy się na osieroconym `.next-audit-target-smoke-spin-authoring-unblocked-019f`. |
| In-app browser reproduction | **BLOCKED** | Połączenie z browser runtime nie zostało zestawione w bieżącym środowisku. |

Pierwsza próba focused Vitest została uruchomiona z niepoprawnym zagnieżdżonym `--run`; discovery nie wykonało testów i trafiło na Windows Temp `ENOENT`. Poprawne uruchomienie z `TMPDIR=/tmp` przeszło 110/110.

## 10. Mapa kluczowych źródeł

- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx` — root, pointer hold, canvas, profile i HUD DOM;
- `apps/control-room/src/modules/viewport-3d/Viewport3DCanvas.tsx` — lifecycle custom R3F root i ResizeObserver;
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts` — zasoby i szeroki assembler sceny;
- `apps/control-room/src/modules/viewport-3d/layers/CameraControls.tsx` — OrbitControls, damping, commit i trajectory recording;
- `apps/control-room/src/modules/viewport-3d/layers/viewport3DCameraTrajectoryProbe.ts` — bufor diagnostyczny;
- `apps/control-room/src/modules/viewport-3d/viewport3dFieldUpdateHold.ts` — globalny hold pól;
- `apps/control-room/src/modules/viewport-3d/layers/PostProcessingLayer.tsx` — N8AO/Bloom/EffectComposer;
- `apps/control-room/src/modules/viewport-3d/layers/viewport3DRenderPolicy.ts` — transparent/depth/render order;
- `apps/control-room/src/modules/viewport-3d/layers/Viewport3DLightingRig.tsx` — martwe dla unlit surfaces oświetlenie;
- `apps/control-room/src/modules/viewport-3d/orientation/OrientationHudLayer.tsx` — screen anchor per frame;
- `apps/control-room/src/modules/viewport-3d/orientation/ViewCube3DBox.tsx` — draw calls i AutoOrientText per frame;
- `apps/control-room/src/modules/viewport-3d/viewport3dVisualProfile.ts` — DPR, MSAA i tone mapping;
- `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts` — frame/resource instrumentation;
- `apps/control-room/scripts/audit-idle-performance.mjs` — statyczna bramka idle;
- `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs` — runtime stress gate.

## 11. Kryterium zamknięcia zgłoszenia

Problem można uznać za rozwiązany dopiero, gdy:

1. pixel/luminance test odtwarza błąd przed poprawką i przechodzi po poprawce;
2. przyczyna jest wskazana jako AO, transparent sorting albo inna konkretna operacja, nie jako „wrażenie użytkownika”;
3. nie ma zmiany jakości, opacity ani koloru zależnej od stanu gestu;
4. orbitowanie nie rerenderuje rootu React i nie pauzuje zasobów przez React props;
5. browser smoke potwierdza zdrowy WebGL context i niezerowy drawing buffer;
6. runtime idle i memory-churn przechodzą z liczbowym raportem;
7. testy są wykonane osobno dla FDM/FEM i najważniejszych passów.

Na podstawie samego źródła właściwy kierunek produktu jest jasny: **usunąć wszystkie niejawne efekty zależne od ruchu z kanonicznego renderingu naukowego, zachować pełną jakość podczas orbitowania i optymalizować przez ograniczenie zbędnych obliczeń/stanu, nie przez przygaszanie lub ukrywanie geometrii.**

## 12. Aktualizacja wdrożeniowa — wariant A

Po zatwierdzeniu wariantu A wdrożono następujące zmiany:

1. `viewport3dFieldUpdateHold.ts` nie publikuje już stanu przez `useSyncExternalStore`; hold jest wyłącznie mechanizmem transportowym `ResourceRuntimeStore`.
2. Root viewportu nie rozpoczyna hold na każdym `pointerdown`. Hold rozpoczyna i kończy rzeczywisty lifecycle OrbitControls przez `beginCameraInteraction`/`endCameraInteraction`.
3. `useViewport3DSceneModel` nie subskrybuje aktywności hold i nie przekazuje jej do resource hooks. Ruch kamery nie zmienia już wejść modelu pola.
4. Gotowy zgodny envelope pola nie jest zerowany przez gest; `committedFieldVector` pozostaje stabilny.
5. Dodano `resolveViewport3DAdaptiveVectorGlyphLength`, który wyznacza długość z efektywnego rozstawu próbek. Dla `surface` używa rozstawu powierzchniowego, a dla `full` objętościowego.
6. FDM domain, targety, single-grid Airbox, multilayer Airbox i native layers używają lokalnego budżetu, scope i spacing.
7. Standardowa i `vectorOnly` ścieżka otrzymują tę samą rozstrzygniętą skalę; usunięto wtórny cap zależny od obecności modelu cuboidu.
8. Magnituda pozostaje w `relMag` i jest kodowana kolorem; długość przedstawia kierunek i czytelność lokalnego układu.

### Dowody po wdrożeniu

- skupione Vitest: **7 plików, 322/322 testy PASS**;
- `pnpm --dir apps/control-room typecheck`: **PASS**;
- `pnpm --dir apps/control-room lint`: **PASS**;
- `pnpm --dir apps/control-room audit:idle-performance`: **PASS**;
- `git diff --check`: **PASS**;
- browser/WebGL smoke: **nadal niewykonany**, ponieważ integracja przeglądarki Codex odrzuca poprawny lokalny `sandboxCwd`; nie zastąpiono tej bramy testem statycznym.

### Pozostała brama produkcyjna

Przed kwalifikacją wydania należy uruchomić browser smoke na działającym Control Room i potwierdzić podczas orbitowania: stałą liczbę adopted glyphs, brak utraty kontekstu, dodatnie wymiary drawing buffer oraz brak ramki z pustym renderem. Kod i testy jednostkowe naprawiają deterministyczną przyczynę, ale świeży dowód pikselowy/WebGL pozostaje obowiązkowy.

## 13. Aktualizacja po logu Airbox i wdrożeniu wariantu A

**Data aktualizacji:** 2026-08-17  
**Źródło:** log z debug Inspectora przekazany w załączniku oraz aktualny kod working tree

### Potwierdzona przyczyna logu `H_eff`

W logu `H_eff` backend odpowiadał `200` i zwrócił 1200 punktów. Błąd był po stronie diagnostyki tożsamości zakresu: request FDM Airbox prawidłowo pomija `scope_id`, natomiast payload FMVP zwraca kanoniczne `scopeId=airbox`. Diagnostyka porównywała te wartości literalnie i fałszywie zgłaszała `scope-id-mismatch`, a następnie prezentowała bufor jako „not adopted”.

Zmieniono porównanie tak, aby dla `scope_kind=airbox` oraz braku `scope_id` uznawało `airbox` za prawidłową tożsamość odpowiedzi. Dodano test regresyjny dla dokładnego przypadku z logu.

### Potwierdzona przyczyna `H_ext` / `ResourcePartialLoadError`

W ścieżce runtime statyczny profil capabilities publikował `H_ext` niezależnie od tego, czy bieżący `ExecutionPlanIR` miał składnik Zeeman. Frontend traktował więc `H_ext` jako requestowalny, a runtime odrzucał materializację. Błąd był wzmacniany przez możliwość pozostawienia starego identyfikatora w katalogu pól po zmianie planu.

Naprawa jest plan-aware i nie jest wyjątkiem dla pojedynczego ID:

- `resolve_planned_runtime_capabilities` filtruje `preview_quantities` i `snapshot_quantities` przez aktywne składniki planu dla FDM/FDM multilayer/FEM;
- `H_ext` jest reklamowane tylko przy aktywnym polu zewnętrznym, a `H_demag` tylko przy aktywnym demagu;
- frontend usuwa z planowania stare identyfikatory, które aktualny katalog capabilities oznacza jako `unsupported`;
- on-demand materializacja nadal pozostaje możliwa dla ilości faktycznie wspieranych, lecz jeszcze niezbuforowanych.

To rozwiązuje źródło planowania błędnego żądania. Nie twierdzę, że wykonano live reprodukcję konkretnego `H_ext` na aktywnej sesji użytkownika — smoke używa izolowanego fixture — ale kontrakt źródłowy i test plan-aware pokrywają dokładny mechanizm błędu.

### Copy log w Inspectorze diagnostycznym

W `VisualizationDebugPanel` dodano ikonę `Copy log` z etykietą ARIA i tooltipem. Kopiowany jest czytelny, ograniczony do 64 KiB log tekstowy zawierający m.in.:

- planner request ID i kanoniczny resource key;
- query, `scope_kind`, `scope_id`, komponent i limit próbek;
- status, czas, rozmiar, ETag oraz `detail` transportu, w tym `ResourcePartialLoadError`;
- metadata backendu, payload po dekodowaniu, statystyki, próbki, pamięć i render adoption;
- revisions/provenance oraz wszystkie wykryte niespójności.

Akcja korzysta z istniejącego fallbacku Clipboard API/`execCommand`, ma feedback sukcesu/błędu i test DOM aktywacji klawiaturą.

### Aktualne dowody weryfikacyjne

| Bramka | Wynik |
|---|---|
| Focused Vitest: Airbox/viewport/Inspector/debug | **PASS: 11 plików, 536 testów** |
| Runtime runner capability contract | **PASS: test planu bez Zeemana odrzuca `H_ext`, plan z Zeemanem go reklamuje** |
| ESLint dla komponentów i eksportu debug | **PASS** |
| Browser camera/WebGL smoke | **PASS** — `contextLost=false`, drawing buffer `617×478`, orbit/pan/wheel: 0 requestów sesji i 0 patchy wizualizacji |
| Browser FDM/Airbox/Inspector smoke | **PASS** — obiekt, region, Airbox wireframe/points/vectors; `fieldFailures=null`, dodatnie delty pikseli |
| `git diff --check` | **PASS** |
| Typecheck | **PASS** — wygenerowano route types, brak błędów TypeScript |

Pozostają niezależne bramki: live session z rzeczywistym payloadem `H_ext` oraz pełny memory-churn audit. Nie są podstawą do twierdzenia, że cała aplikacja jest już production-qualified; potwierdzają natomiast naprawiony mechanizm i brak regresji w izolowanym browser smoke.

## 14. Aktualizacja — przełączanie HSL / X / Y / Z / magnitude

### Potwierdzona przyczyna

Problem nie wynikał z nakładania kilku shaderów powierzchniowych ani ze zmiany opacity. Warstwa FEM montuje dla powierzchni dokładnie jeden materiał: `ShaderMaterial` dla kolorowania polem albo `MeshBasicMaterial` dla zwykłego koloru. Warstwa FDM również używa jednego materiału powierzchniowego; wireframe jest osobnym, jawnym passem i nie zastępuje shadera powierzchni.

Błąd znajdował się wcześniej w planowaniu danych. HSL/orientation żądał kompletnego bufora wektorowego `component=full`, natomiast X, Y, Z i magnitude tworzyły nowe żądania komponentowe. Zmiana samego sposobu prezentacji zmieniała więc resource key, odłączała przyjęty bufor i czekała na drugi payload. W tej szczelinie powierzchnia przechodziła na neutralny materiał zastępczy, co użytkownik widział jako przyciemnienie. Gdy nowe żądanie nie było gotowe lub nie zostało zaadoptowane, zmiana wyglądała na całkowicie nieskuteczną.

### Wdrożona naprawa

Wszystkie wektorowe tryby kolorowania powierzchni — HSL/orientation, X, Y, Z i magnitude — korzystają teraz z jednego kompletnego bufora `component=full`. Wybór komponentu jest lokalną transformacją prezentacyjną istniejących danych i nie zmienia już resource key, topologii, materiału ani opacity. Zmienia się wyłącznie bufor kolorów lub uniform trybu shadera.

Dodano test regresyjny porównujący plan żądania przed i po przełączeniu orientation → component X. Oba warianty muszą mieć identyczne query i ten sam scope. Zaktualizowano również kontrakty planera dla zasobów primary, target-specific, scoped part, replay i Airbox.

### Dowody po poprawce

| Bramka | Wynik |
|---|---|
| Planner i scene model | **PASS: 3 pliki, 184 testy** |
| Field mapping i materiały FDM/FEM | **PASS: 5 plików, 173 testy** |
| Browser FDM/Inspector/WebGL smoke | **PASS** — canvas widoczny, kontekst nieutracony, drawing buffer dodatni |
| Typecheck i ESLint zmienionych plików | **PASS** |
| React Doctor, scope changed | **PASS (exit 0, bez zgłoszonych diagnostyk)** |
| `git diff --check` | **PASS** |

Wniosek: nie było niejawnego stacku shaderów. Główną przyczyną przyciemniania przy zmianie sposobu kolorowania był cold resource switch dla danych, które już znajdowały się w buforze pełnego wektora.

## 15. Audyt migania Inspectora wizualizacji obiektu i Airboxa

### Werdykt

Zgłoszone przygaszanie Inspectora jest potwierdzone źródłowo i ma inną przyczynę niż wcześniejsze przygaszanie viewportu. `AirboxVisualizationPanel` oraz `ObjectVisualizationPanel` używają dokładnie tego samego `VisualizationTargetInspectorPanel`, dlatego błąd występuje w obu miejscach.

Głównym problemem jest zbyt szeroki kontrakt mutacji: dowolna zdalnie utrwalana zmiana jednego pola ustawia `pending` dla całego targetu. Ten jeden boolean jest przekazywany do wszystkich sekcji i wyłącza około 20 kontrolek. Style disabled obniżają opacity przycisków i kafelków do 0,40–0,48. Użytkownik widzi więc synchroniczne przygaszenie dużej części panelu przy każdym PATCH-u, mimo że optimistic state zawiera już nową wartość i nie ma powodu blokować pozostałych pól.

### I-01 — P1: target-wide `pending` wizualnie przygasza cały formularz

**Łańcuch przyczynowy:**

1. `patch()` wykonuje `visualizationSync.queuePatch(...)` i `visualization.patchTargetPending(...)`.
2. `resolveVisualizationTargetMutationStatus(...)` oznacza target jako pending.
3. `pending` z `ObjectVisualizationPanel.tsx` jest przekazywany do wszystkich sekcji.
4. `ObjectVisualizationTargetSection.tsx` używa go w około 20 atrybutach `disabled` — również dla kontrolek niezwiązanych ze zmienianym polem.
5. `.fm-button:disabled`, `.fm-viz-render-mode-tile:disabled` i `.fm-viz-layer-chip:disabled` ustawiają opacity odpowiednio na 0,48, 0,45 i 0,40.
6. Po ACK wszystkie kontrolki wracają jednocześnie do pełnego kontrastu. Powtarzany cykl daje efekt mrugania.

**Naprawa produkcyjna:** zastąpić boolean `pending` mapą pól lub transakcji. Blokować tylko kontrolkę, której commit jest w locie, a pozostałe pozostawić interaktywne. Dla sliderów utrzymać istniejący podział `onValueChange`/`onValueCommit`. Status zapisu pokazywać jako mały, stabilny wskaźnik bez zmiany opacity całej sekcji.

**Brama:** zmiana `surfaceColorSource` nie zmienia stanu disabled ani computed opacity kontrolek vectors, wireframe, points i render mode; kolejna zmiana innego pola może zostać zakolejkowana bez oczekiwania na ACK pierwszej.

### I-02 — P1: bezwarunkowe animacje wejścia odtwarzają miganie przy montowaniu sekcji

`inspector-visualization.css` przypisuje animacje opacity/transform bezpośrednio do trwałych elementów instrumentu:

- zawartość Display: `fm-slide-down`;
- accounting rows: `fm-fade-in`;
- scope note: `fm-slide-down`;
- vector subgroup: `fm-fade-in`;
- dzieci overview: `fm-rise` od opacity 0 przez 220 ms.

Sekcje vectors, points, wireframe i surface coloring są montowane warunkowo na podstawie bieżących ustawień. Ich prawidłowe pojawienie się po zmianie ustawienia uruchamia więc dodatkowy fade/slide, który wizualnie nakłada się na cykl disabled/pending. To jest zbędne w Inspectorze będącym trwałym instrumentem sterującym; animacja wejścia nie powinna sygnalizować każdej aktualizacji danych.

**Naprawa produkcyjna:** usunąć animacje opacity z kontrolek i sekcji dynamicznych. Pozostawić co najwyżej transformację otwarcia wywołaną świadomą akcją użytkownika na collapsible, bez startu od opacity 0. `prefers-reduced-motion` nie wystarcza, ponieważ problem występuje w domyślnym profilu.

**Brama:** po zmianie passu żaden widoczny element Inspectora nie ma aktywnej animacji wpływającej na opacity; test browserowy sprawdza `getAnimations()` i histogram panelu przed, podczas i po ACK.

### I-03 — P1: Inspector subskrybuje cały snapshot synchronizacji zamiast statusu bieżącego targetu

`useObjectVisualizationPanelState` wywołuje `useSyncExternalStore` z pełnym `visualizationSync.getSnapshot()`. Każda zmiana pending/inflight/error/version w globalnym kontrolerze ponownie renderuje cały, liczący ponad 1400 linii panel — również gdy mutacja dotyczy innego targetu. Dopiero po renderze wyliczany jest target-scoped status.

**Naprawa produkcyjna:** dodać selector/hook zwracający wyłącznie `VisualizationTargetMutationStatus` dla stabilnego zbioru target IDs z własnym equality contract. Globalna zmiana kamery, Planar lub innego obiektu nie może renderować bieżącego Inspectora.

**Brama:** PATCH targetu B nie zwiększa render count Inspectora targetu A; test wykorzystuje `WorkspaceRenderProfiler` i target-scoped mutation store.

### I-04 — P2: ten sam zasób visualization state jest montowany dwa razy w jednym panelu

`useObjectVisualizationPanelState` pobiera `useVisualizationStateResource({ enabled })`, a `VisualizationTargetInspectorPanel` wywołuje drugi `useVisualizationStateResource()` tylko po to, aby odczytać `planar`. Cache ogranicza podwójny transport, ale nadal powstają dwie subskrypcje resource runtime, dwa efekty `observeRemoteState`/ACK i dwa źródła rerenderu tego samego drzewa.

**Naprawa produkcyjna:** zwrócić potrzebny `planar` lub wspólny snapshot z pierwszego hooka albo zastosować selektor zasobu. Jeden panel powinien mieć jednego ownera subskrypcji visualization state.

**Brama:** jedno zamontowanie Inspectora tworzy jedną subskrypcję resource key `/visualization/state`; pojedyncza rewizja wywołuje jeden przebieg obserwacji i najwyżej jeden render panelu.

### I-05 — P2: kosztowne baseline i kolekcje są budowane przy każdym renderze

Każdy render ponownie filtruje wszystkie override'y, mapuje targety, rozwiązuje settings i wykonuje `structuredClone` preferencji. Następnie `ObjectVisualizationPanelView` wykonuje dwa `JSON.stringify` baseline'u do obliczenia dirty. W tym samym przebiegu powstają nowe tablice target IDs, `Map` dostępności pól, sekcje i obiekty props. Przy częstym cyklu pending/ACK koszt ten jest mnożony, choć większość wejść nie zmieniła się.

**Naprawa produkcyjna:** przygotować revisioned, target-scoped baseline w memoizowanym modelu; dirty obliczać przez stabilny fingerprint albo porównanie pól, nie pełną serializację na każdym renderze. Nie używać memoizacji do ukrycia złego ownership — najpierw zawęzić subskrypcje z I-03.

**Brama:** aktualizacja statusu mutacji bez zmiany canonical revision nie wykonuje `structuredClone`, `JSON.stringify`, przebudowy capacity ani map field availability.

### I-06 — P2: pełna zamiana drzewa na ekran loading pozostaje ryzykiem lifecycle

Gdy `visualizationState.data` jest chwilowo `null`, `VisualizationTargetInspectorPanel` usuwa całe `ObjectVisualizationPanelView` i zastępuje je krótkim blokiem „Loading applied visualization state”. Powrót danych montuje panel od nowa, resetuje stan lokalny i ponownie uruchamia animacje wejścia. Obecny resource cache zwykle zachowuje last-good data przy zwykłej invalidacji, ale cold mount, zmiana lane/targetu lub błąd identity nadal może uruchomić ten mechanizm.

**Naprawa produkcyjna:** po pierwszym gotowym snapshotcie zachować last-good target-scoped view podczas odświeżenia i pokazać nieinwazyjny status stale/syncing. Pełny placeholder stosować wyłącznie przed pierwszym payloadem albo po faktycznej utracie target identity.

**Brama:** refetch tej samej resource identity nie odłącza root elementu overview, nie resetuje pozycji scroll i nie zmienia liczby zamontowań `ObjectVisualizationPanelView`.

### I-07 — P2: testy wydajności są głównie testami tekstu, nie zachowania runtime

`ObjectVisualizationPanel.performance.test.ts` sprawdza obecność fragmentów kodu przez `readFileSync` i `toContain`. Potwierdza intencję architektoniczną, ale nie mierzy render count, remountów, aktywnych animacji, opacity ani liczby subskrypcji. Istniejący `smoke-inspector.mjs` sprawdza czy disabled control pozostaje czytelny, lecz nie sprawdza przejściowego cyklu normal → disabled → normal podczas commitowania.

**Naprawa produkcyjna:** dodać browser regression dla Object i Airbox osobno: MutationObserver dla remountów, React profiler count, computed opacity wszystkich kontrolek, aktywne animacje, request count oraz stabilność scroll/focus podczas sekwencji minimum 20 zmian.

### Kolejność wdrożenia

1. I-01: field-scoped pending i brak globalnego disabled/dim.
2. I-02: usunięcie animacji opacity z dynamicznych sekcji.
3. I-03 i I-04: target-scoped sync selector oraz jedna subskrypcja visualization state.
4. I-05: stabilny model baseline/derived collections.
5. I-06: last-good Inspector view podczas refetch.
6. I-07: runtime browser gate dla obu targetów.

Nie należy naprawiać tego przez wydłużenie debounce, skrócenie animacji ani globalne ustawienie wyższej opacity dla disabled. Takie zmiany zmniejszyłyby widoczność objawu, ale pozostawiły target-wide blokowanie, zbędne rendery i remounty.

### Status wdrożenia — 2026-08-17

Wariant A został wdrożony dla wspólnego Inspectora Object/Airbox:

- **I-01 zamknięte:** pending jest wyliczany z patchy bieżącego targetu na poziomie pól. Nie blokuje już całego formularza. Aktywny select `surfaceColorSource` pozostaje fokusowalny także podczas zapisu; natywny `disabled` odbierał fokus i był dodatkową, potwierdzoną w smoke teście przyczyną mrugania.
- **I-02 zamknięte:** usunięto `fm-slide-down`, `fm-fade-in`, `fm-rise` oraz stagger opacity z dynamicznych części Inspectora.
- **I-03 zamknięte:** panel subskrybuje target-scoped `VisualizationTargetMutationStatus` z equality contract zamiast pełnego snapshotu synchronizacji.
- **I-04 zamknięte:** w drzewie panelu pozostał jeden owner `useVisualizationStateResource`; dane Planar są przekazywane z tego samego snapshotu.
- **I-05 zamknięte:** dirty baseline nie używa już render-time `JSON.stringify`; porównanie jest jawne i płytkie dla kanonicznych rekordów, a lokalne pending overrides są wykluczone z canonical baseline.
- **I-06 zamknięte:** panel zachowuje last-good view wyłącznie dla tej samej tożsamości targetu podczas odświeżenia. Zmiana targetu nie może odziedziczyć starego widoku.
- **I-07 zamknięte:** `smoke-inspector.mjs` wykonuje 20 celowo opóźnionych mutacji (Object + Airbox) i sprawdza stabilność elementu root, computed opacity, brak opacity animations, focus, scroll, brak blokady niezwiązanej kontrolki, request budget oraz WebGL.

### Dowody po wdrożeniu

| Bramka | Wynik |
|---|---|
| Testy Inspector/model/smoke contract | **PASS: 5 plików, 181 testów** |
| ESLint zmienionych plików | **PASS** |
| Browser Inspector smoke | **PASS:** 20 mutacji, Object i Airbox, 0 console errors, 0 preview requests, reset i WebGL zweryfikowane |
| `git diff --check` i syntax check smoke script | **PASS** |
| React Doctor `--scope changed` | **PASS procesu, score 84/100:** 69 ostrzeżeń w szerokim współdzielonym diffie; brak nowego błędu wskazującego na zmienione komponenty panelu, jedno istniejące ostrzeżenie modelu o chained iterations |
| Pełny typecheck Control Room | **BLOCKED poza zakresem:** `viewport3dDiagnostics.test.ts:124` nie przekazuje wymaganych pól `fieldRevision` i `topologyRevision`; zmieniane pliki Inspectorów nie występują w diagnostyce |

Zasada zapobiegająca regresji została również dodana do głównego `AGENTS.md`: Inspector ma zachowywać strukturę, fokus, scroll i kontrast przez optimistic update/invalidation/ACK; wymagane są field-scoped pending, jeden owner zasobu, last-good dla tej samej identity i osobny browser gate Object/Airbox.

## 11. Domknięcie wariantu A — Airbox H_demag i pojedyncza rama Inspectora

### Przyczyna źródłowa niewidocznych wektorów

Backend nie był przyczyną bieżącego zaniku H_demag. Dokładne zapytanie `scope_kind=airbox&scope_id=airbox` zwraca HTTP 200 i poprawny FMVP v3: 1200 punktów, 3600 skończonych wartości i 1200 indeksów węzłów. Worker również budował 1200 segmentów. Błąd znajdował się dopiero na granicy adopcji renderera:

1. ścieżka Airbox „tylko wektory” celowo nie buduje ciężkiego `FdmCuboidInstanceModel`;
2. `FdmCuboidLayer` miał bezwarunkowy early-return dla `!model || !preparedInstances`;
3. `VectorFieldLayer`, mimo gotowego `vectorSegments`, znajdował się poniżej tej bramki i był nieosiągalny;
4. przełączenie Points/Surface mogło przypadkowo przywrócić model komórek i maskować błąd jako niestabilny re-render.

Naprawa oddziela pass wektorowy od passów wymagających instancji komórek. Samodzielny `VectorFieldLayer` może zostać zamontowany, gdy target jest widoczny, globalna bramka wektorów jest otwarta, pass vectors jest aktywny i istnieje niepusty bufor segmentów. Surface, points i picking nadal failują zamknięte bez modelu. Telemetria klatki stosuje ten sam kontrakt i nie wymaga modelu komórek do uznania samych wektorów za widoczne.

### Tożsamość zakresu

- FDM: `scope_kind=airbox&scope_id=airbox`;
- FEM: `scope_kind=airbox&scope_id=<bieżąca część powietrza>`, preferencyjnie `part:__air__`;
- brak jednoznacznej tożsamości: brak niekompletnego requestu.

Ta sama tożsamość jest przekazywana przez availability, metadata, request wektorowy, klucz cache, diagnostykę i renderer. Usunięto wcześniejszy request FDM zawierający tylko `scope_kind=airbox`.

### Organizacja Inspectora

Trasa `Airbox Visualization` jest samoramująca. Zewnętrzny `DedicatedInspectorRouteFrame` został usunięty, więc `View` występuje bezpośrednio w głównym panelu przed ogólnymi sekcjami kontekstowymi. `Status`, `Physical properties` i `Provenance` nie poprzedzają już narzędzi wizualizacji.

### Świeży dowód runtime

| Bramka | Wynik |
|---|---|
| Dokładny request H_demag Airbox | **PASS:** HTTP 200, FMVP v3, scope `airbox:airbox` |
| Payload | **PASS:** 1200 punktów, 3600 wartości, 1200 node indices, 0 non-finite |
| Build wektorów | **PASS:** 1200 segmentów, `not degraded` |
| Render bez modelu komórek | **PASS:** wektory widoczne przy Surface/Points/Wireframe OFF |
| Inspector | **PASS:** jedna rama; `View` przed sekcjami kontekstowymi |
| WebGL | **PASS:** `isContextLost=false`, drawing buffer 703 x 556 |
| Konsola czystego Chromium | **PASS:** 0 błędów |
| Regresja warstwy i frame state | **PASS:** 94/94 testów |
| TypeScript | **PASS:** pełny `apps/control-room` typecheck |

Artefakty dowodowe:

- `apps/control-room/.artifacts/airbox-h-demag-variant-a/airbox-h-demag-vectors-canvas.png`;
- `apps/control-room/.artifacts/airbox-h-demag-variant-a/airbox-h-demag-vectors-workspace.png`;
- `apps/control-room/.artifacts/airbox-h-demag-variant-a/browser-proof.json`.

Hydration mismatch zawierający `ext-megabonus-*` pochodzi z rozszerzenia modyfikującego DOM przeglądarki użytkownika przed hydracją. Nie występuje w izolowanym Chromium i nie został ukryty ani wyciszony w kodzie aplikacji.

## 12. Korekta automatycznej skali wektorów — 2026-08-17

Świeży przegląd obrazu kwalifikacyjnego z sekcji 11 ujawnił, że poprzednia automatyka nadal była wizualnie nieakceptowalna. Długość glyphu była zależna od bounds, liczby próbek i scope, ale współczynnik wypełnienia wynosił 86% lokalnego odstępu 3D. Jednocześnie średnica główki wynosiła 40% długości strzałki, a średnica trzonu 16%. Przy 1200 próbkach groty i trzony zasłaniały kierunek oraz trajektorię H_demag.

### Zmiana

- pełna objętość: długość bazowa 42% charakterystycznego odstępu próbek;
- powierzchnia: długość bazowa 50% charakterystycznego odstępu 2D;
- główka: długość 28%, promień 10% długości glyphu;
- trzon: promień 3,5% długości glyphu;
- mnożnik `vectorLengthScale` nadal działa po automatycznym wyznaczeniu długości;
- mnożnik `vectorThickness` nadal działa po wyznaczeniu zwartych proporcji;
- skala nie zależy od kamery i nie jest obliczana w pętli klatki.

Dla kwalifikacyjnego Airboxa 500 x 125 x 54 nm i 1200 glyphów długość domyślna zmienia się z około 12,14 nm na około 5,93 nm. Zwiększenie liczby renderowanych próbek o czynnik 8 zmniejsza długość dokładnie dwukrotnie. Długość nie koduje magnitudy pola; magnituda pozostaje osobnym kanałem kolorowania.

### Weryfikacja

| Bramka | Wynik |
|---|---|
| Testy resolvera, geometrii, stylu, workera i modelu sceny | **PASS: 188/188** |
| RED przed implementacją | **PASS procesu:** 3 oczekiwane failure dla długości, główki i trzonu |
| Build statyczny aktualnego Control Room | **PASS:** Next.js build, TypeScript i static export |
| Świeży browser/WebGL screenshot po korekcie | **BLOCKED:** integracja karty 3100 odrzuca lokalny `sandboxCwd`; izolowany runtime nie może zbindować portu API 8081 ani 8082 |

Poprzednie screenshoty dokumentują przyczynę wizualną, ale nie są dowodem obrazu po tej korekcie. Nie wolno promować tej zmiany do pełnej kwalifikacji wizualnej, dopóki nie powstanie nowy kadr `wireframe off -> vectors on`, na którym 1200 glyphów pozostaje czytelne i WebGL jest zdrowy.
