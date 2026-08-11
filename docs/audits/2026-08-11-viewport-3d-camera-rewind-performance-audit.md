# Audyt regresji kamery i płynności viewportu 3D

**Data:** 2026-08-11  
**Repozytorium:** `/home/kkingstoun/git/fullmag/fullmag`  
**Audytowany commit:** `15ab7482b0b6f5735684fb3bf7a51f155c778860`  
**Zakres:** frontend Control Room, R3F/Drei/Three.js, obrót, panorama, zoom, tłumienie, auto-fit, projekcja, synchronizacja lokalna i zdalna, demand rendering oraz testy wydajnościowe.  
**Status:** poprawki zaimplementowane i zakwalifikowane automatycznie; wszystkie P0/P1/P2 z tego audytu są zamknięte w kodzie i testach. Repozytoryjne smoke Chromium potwierdza ciągłość orbit/pan/zoom oraz zgodność końcowych snapshotów. Pozostaje niezależna ręczna obserwacja użytkownika, ponieważ most Codex Browser nadal nie inicjalizuje sesji.

## 0. Reaudyt po wdrożeniu naprawy

### 0.1. Zakres i wynik

Reaudyt wykonano na gałęzi `fix/viewport-camera-ownership` po commicie
`defc02fef` (`fix: synchronize settled camera snapshots`). Historyczne ustalenia
poniżej pozostają opisem stanu z commitu `15ab7482b0b6f5735684fb3bf7a51f155c778860`;
nie należy ich interpretować jako opis bieżącej implementacji.

Wynik implementacyjny: **wszystkie osiem problemów P0/P1/P2 zostało
naprawionych**. Kamera Three.js i Drei `OrbitControls` jest jedynym właścicielem
pozycji w trakcie gestu, każdy gest ma epokę `latest-wins`, zdalny snapshot i
zmiana bounds nie mogą nadpisać aktywnego ruchu, a po settle wykonywany jest
jeden zaakceptowany commit. Store otrzymuje wyłącznie końcowy kanoniczny
snapshot przyjęty przez registry; nie steruje trajektorią pośrednią.

### 0.2. Zamknięcie ustaleń priorytetowych

| Ustalenie | Status | Wdrożone rozwiązanie | Dowód |
|---|---|---|---|
| P0-1: OrbitControls poza lifecycle registry | zamknięte | orbit, pan i wheel otwierają tę samą epokę gestu w lokalnym guardzie i `CameraRegistryController`; starsze callbacki nie mogą zakończyć nowszego gestu | `a6ab27e8d`, `b6d58b8bd`, testy `viewport3DCameraGesture` i `CameraRegistryController` |
| P0-2: pętla registry → store → R3F | zamknięte | renderer czyta kanoniczną kamerę registry; usunięto bezwarunkowy mirror; store jest aktualizowany raz dopiero po zaakceptowaniu końcowego patcha registry | `b6d58b8bd`, `defc02fef`, browser gate live/registry/store |
| P0-3: auto-fit w środku gestu | zamknięte | asynchroniczna zmiana bounds jest ignorowana podczas aktywnego gestu; jawny Fit/Reset najpierw anuluje bieżącą epokę | `6706999da`, testy guardu bounds oraz Fit/Reset |
| P1-1: dwa lifecycle wheel | zamknięte | usunięto własne capture listenery i timeout 150 ms; wheel/dolly należy wyłącznie do Drei `OrbitControls` | `bb09aadd2`, browser smoke perspective i orthographic |
| P1-2: timer bez bariery wersji | zamknięte | każdy delayed settle/commit przenosi epokę; callback starszej epoki jest odrzucany | `a6ab27e8d`, test „stale gesture” |
| P1-3: snap-back do persisted shadow | zamknięte | `endInteraction()` nie przywraca opóźnionego `persistedShadow`; finalna lokalna pozycja wygrywa z remote revision przyjętą w trakcie gestu | `b6d58b8bd`, test „keeps the final local pose when a newer remote revision arrives during the gesture” |
| P2-1: absolutne, niespójne tolerancje | zamknięte | porównania pozycji i targetu używają tolerancji zależnej od odległości camera-target/skali sceny; próg minimalny chroni sceny nanometrowe | `4d9d72209`, testy `viewport3DCameraState` |
| P2-2: brak pomiaru trajektorii | zamknięte | dodano ograniczony do trybu audit probe klatkowy: epoch, aktywność, live camera/target, registry, store, persisted shadow i wersje; browser gate odrzuca krok wstecz >15% i więcej niż jeden commit | `3cae5b7e2`, `c48da33d4`, `defc02fef` |

### 0.3. Macierz kryteriów zamknięcia

| # | Kryterium z sekcji 11 | Wynik | Dowód bieżącego stanu |
|---:|---|---|---|
| 1 | orbit ≥2 s bez cofnięcia i auto-fit | PASS automatyczny, dowód warstwowy | smoke utrzymuje pointer przez 18 × 120 ms = 2,16 s; trajektoria nie może wykazać kroku wstecz >15%; field hold obejmuje cały gest, a osobne testy wymuszają remote revision i zmianę bounds |
| 2 | right-pan z monotonicznym target i position | PASS automatyczny | browser smoke: faza pan przeszła, `viewportFrameDelta=3`, trajectory gate bez odwrócenia kierunku |
| 3 | perspective i orthographic wheel: ruch wieloklatkowy, jeden commit | PASS automatyczny | perspective `viewportFrameDelta=7`; projekcja ortograficzna przeszła ten sam gate; dla każdej epoki wymagany dokładnie jeden `committedVersion` |
| 4 | deterministyczne projection/Fit/Reset/ViewCube | PASS kontraktowy i runtime projection | projection round-trip PASS; testy wymagają anulowania aktywnej epoki przez komendy i wyłączenia OrbitControls przed pointer-down HUD |
| 5 | zero requestów data/model/meshing/visualization podczas gestu | PASS runtime | smoke: `visualization_state_patches=0`, `background_resource_requests=0`; audyt bezczynności także wymaga pustej listy requestów |
| 6 | zgodność live camera, target, store i registry po settle | PASS runtime | `assertSettledCameraSnapshotsAgree()` porównuje position/target/up przy wspólnej tolerancji skalowej i przerywa smoke przy rozbieżności |
| 7 | zero klatek po wyciszeniu | PASS runtime | `audit:viewport-3d-memory-churn`: 5 s idle, wymagane `frames +0`, `drawCalls +0`, zero resource requests; przebieg PASS |
| 8 | widoczny canvas, zdrowy WebGL i niezerowy drawing buffer | PASS runtime | smoke: `contextLost=false`, drawing buffer `617×478`; canvas przeszedł kontrolę niepustego obrazu |
| 9 | remote revision i bounds update w środku gestu | PASS automatyczny, dowód warstwowy | registry zachowuje finalną lokalną pozycję mimo nowszej remote revision; osobny test efektu auto-fit wymaga guardu aktywnego gestu i braku zapisu store/registry; oba przypadki współdzielą tę samą epokę/guard |
| 10 | ręczna próba bez cofnięcia | oczekuje niezależnej obserwacji | automatyczny Chromium smoke powtarzalnie PASS; Codex Browser nie rozpoczyna nawigacji z powodu `sandboxCwd is not a local file URI`, więc nie przedstawiono ręcznego dowodu narzędziowego |

Kryterium 10 jest granicą kwalifikacji, nie znanym defektem implementacji. Wszystkie
automatycznie egzekwowalne kryteria 1–9 przechodzą. Ręczna obserwacja nadal jest
wymagana przed uznaniem poprawki za zweryfikowaną operatorsko na konkretnym
stanowisku i urządzeniu wejściowym.

### 0.4. Świeże dowody wykonawcze

Końcowy zestaw regresyjny:

```text
Pełny Control Room:
Test Files  516 passed (516)
Tests       4974 passed (4974)

Zawężona regresja kamery:
Test Files  10 passed (10)
Tests       318 passed (318)
```

Przechodzą również:

- `pnpm --dir apps/control-room typecheck`;
- `pnpm --dir apps/control-room audit:idle-performance`;
- `pnpm --dir apps/control-room audit:viewport-3d-memory-churn` — 120
  przełączeń pól, liczba geometrii `2 -> 2`, pięć sekund bezczynności bez klatek,
  draw calli i requestów;
- `pnpm --dir apps/control-room audit:viewport-3d-fem-topology-uploads` — 12
  konfiguracji FEM: 1/10/100 części × surface/wireframe/points/all;
- repozytoryjny smoke FDM/Chromium — orbit, pan, perspective wheel,
  orthographic wheel, projection round-trip, nieutracony WebGL i niezerowy
  drawing buffer;
- React Doctor: `90/100`, 21 zmienionych plików, brak zgłoszonych problemów.

Pełny disposable smoke doszedł poza fazy kamery i projekcji, a następnie zatrzymał
się w niezależnym przepływie Geometry na odpowiedzi `400 model/transactions`.
Nie jest to regresja kamery i nie osłabia przechodzących bramek viewportu, ale nie
jest też przedstawiane jako zielony test całego Control Room.

### 0.5. Commity naprawy

```text
4d9d72209 fix: scale viewport camera comparisons
a6ab27e8d fix: make camera gestures epoch based
b6d58b8bd fix: prevent stale camera registry commits
bb09aadd2 fix: unify orbit controls camera lifecycle
6706999da fix: cancel stale camera gestures on commands
3cae5b7e2 test: expose bounded camera trajectory audit
c48da33d4 test: gate viewport camera trajectory
5b0c0df9f test: repair viewport runtime qualification
3f389ab7b test: align viewport fixture autosave
defc02fef fix: synchronize settled camera snapshots
```

## 1. Werdykt

Zgłoszony efekt „kamera wraca do ustawienia sprzed sekundy” jest zgodny z rzeczywistą architekturą kodu. Nie jest to jeden błąd `OrbitControls`, lecz wyścig pomiędzy trzema właścicielami tej samej pozycji:

1. imperatywną kamerą Three.js sterowaną przez Drei `OrbitControls`;
2. `viewport3dStore`, który jest deklaratywnym wejściem ponownie nakładanym na kamerę;
3. `CameraRegistryController`, który hydratuje stan z `/visualization/state` i później jest kopiowany z powrotem do `viewport3dStore`.

Najbardziej prawdopodobna ścieżka cofnięcia podczas zwykłego orbitowania jest następująca:

```text
OrbitControls porusza kamerą imperatywnie
  -> CameraRegistry nie wie, że trwa zwykły orbit/pan/zoom
  -> zdalny lub zasobowy camera state może zostać przyjęty
  -> useViewport3DCameraRegistryStoreSync kopiuje go do viewport3dStore
  -> po zwolnieniu osłony gestu efekt CameraController / controls sync
     nakłada stan store na żywą kamerę
  -> widoczny skok do wcześniejszej pozycji
```

Istnieją dodatkowo dwie niezależne drogi resetu:

- auto-fit może imperatywnie zmienić kamerę w czasie aktywnego gestu, bo jego efekt nie sprawdza `cameraGestureRef`;
- własny smooth wheel zoom ma osobny timeout kończący osłonę po 150 ms, mimo że animacja zoomu może nadal trwać.

Wniosek: kod wykorzystuje poprawne elementy R3F (`frameloop="demand"`, Drei `OrbitControls`, `makeDefault`, `invalidate`), ale cały lifecycle kamery nie jest zgodny z zasadą jednego właściciela stanu podczas gestu. Priorytetem nie powinno być strojenie `dampingFactor`, lecz usunięcie wielokierunkowej synchronizacji i wprowadzenie jednej, monotonicznej granicy commitowania pozycji.

## 2. Granica dowodu

### Potwierdzone

- statycznie potwierdzono trzy źródła stanu kamery i dwukierunkową pętlę registry/store/R3F;
- zwykłe `OrbitCameraControls` nie wywołuje `CameraRegistryController.beginInteraction()` ani `endInteraction()`;
- synchronizacja registry → store nie ma własnego warunku `interactionActive`, `dirty` ani identyfikatora generacji gestu;
- efekt auto-fit nie ma osłony aktywnego gestu;
- wheel zoom kończy jedną z osłon po stałych 150 ms, niezależnie od stanu animacji;
- repozytoryjny browser smoke zakończył się błędem: `Camera wheel zoom was applied in too few viewport frames: viewportFrameDelta=1`;
- 302 zawężone testy jednostkowe i kontraktowe przechodzą, ale nie symulują opisanego wyścigu.

### Niepotwierdzone interaktywnie

Nie wykonano ręcznej sekwencji orbitowania w oknie Codex Browser. Most przeglądarki odrzucił inicjalizację przed nawigacją komunikatem `sandboxCwd is not a local file URI`. To awaria warstwy narzędziowej, nie dowód zachowania strony. Repozytoryjny smoke Chromium uruchomiony poza sandboxem wykonał rzeczywisty viewport i wykrył regresję wheel zoom, ale zatrzymał się przed panoramą.

## 3. Mapa właścicieli kamery

| Warstwa | Rola | Zapis | Odczyt / ponowne nałożenie | Ryzyko |
|---|---|---|---|---|
| Three.js camera + Drei `OrbitControls` | żywa pozycja w trakcie gestu | bezpośrednia mutacja `camera.position` i `controls.target` | render R3F | poprawny owner w trakcie gestu |
| `viewport3dStore` | lokalny snapshot modułu | `setCamera()` / `setCameraView()` | `CameraController` i efekt sync `OrbitControls` | może wstrzyknąć opóźniony snapshot do żywej kamery |
| `CameraRegistryController` | lokalny registry + persisted shadow | `patchCamera()` i `observeRemoteState()` | `useCameraRegistryCamera()` | nie jest informowany o zwykłym orbit/pan/zoom |
| `/v2/.../visualization/state` | trwały stan serwera | background PATCH | `useVisualizationStateResource()` | aktualizacja zasobu może wrócić do registry podczas gestu |
| auto-fit | pozycja zależna od bounds | bezpośrednio kamera, store i registry | efekt zależny od bounds | może nadpisać aktywny gest |
| Orientation HUD / ViewCube | snap i orbit pomocniczy | bezpośrednia zmiana + commit | registry/store | jako jedyny używa callbacków registry interaction |

## 4. Ustalenia priorytetowe

### P0-1 — zwykłe OrbitControls nie otwiera transakcji interakcji w CameraRegistry

`Viewport3DModule` poprawnie tworzy:

- `beginCameraInteraction()` → `kernel.cameraRegistry.beginInteraction()`;
- `endCameraInteraction()` → `kernel.cameraRegistry.endInteraction()`.

Callbacki dochodzą do `Viewport3DInteractionAndHudStack`, ale są przekazywane wyłącznie do `OrientationHudLayer`. `OrbitCameraControls` otrzymuje `cameraGestureRef`, lecz nie otrzymuje callbacków registry.

Dowód:

- `Viewport3DModule.tsx:1373-1378` — callbacki registry;
- `Viewport3DScene.tsx:1431-1443` — `OrbitCameraControls` bez callbacków;
- `Viewport3DScene.tsx:1445-1451` — callbacki trafiają tylko do HUD.

Skutek: podczas standardowego drag orbit, right-button pan i własnego wheel zoom `CameraRegistryController.interactionActive` pozostaje `false`. Registry może więc zaakceptować zdalną kamerę, dopóki końcowy commit nie ustawi `dirty`.

To jest naruszenie kontraktu samego `CameraRegistryController`, którego testy zakładają, że aktywna interakcja blokuje remote overwrite (`CameraRegistryController.test.ts:195-267`). Testy kontrolera są poprawne lokalnie, lecz integracja nie wywołuje chronionego API dla głównej ścieżki wejścia.

### P0-2 — registry jest bezwarunkowo kopiowane do store, a store steruje R3F

`useViewport3DCameraRegistryStoreSync()` reaguje na każdą zmianę obiektu `cameraResource`, wylicza sygnaturę i wywołuje:

```ts
viewport3dStore.setCameraView({ camera, orthographicScale, projection });
```

Nie sprawdza:

- czy trwa gest;
- czy lokalna kamera jest dirty;
- czy remote state poprzedza początek gestu;
- czy commit ma nowszy `localVersion`/gesture epoch;
- czy aktualizacja pochodzi z nowej sesji, czy tylko z kolejnej rewizji visualization state.

Następnie `resolveViewport3DSceneCameraView()` wybiera `commandState.camera` ze store jako `cameraState` renderera, a nie `cameraRegistryCamera`. Dwa efekty w `CameraControls.tsx` mogą nałożyć ten stan na aktywną kamerę po wyłączeniu lokalnej osłony.

Dowód:

- `useViewport3DSceneModel.ts:2493-2510` — pose renderera pochodzi ze store;
- `useViewport3DSceneModel.ts:2559-2564` — dołączenie synchronizacji registry;
- `useViewport3DSceneModel.ts:5561-5583` — bezwarunkowy zapis registry → store;
- `CameraControls.tsx:621-651` — deklaratywne ponowne nałożenie pozycji;
- `CameraControls.tsx:1022-1076` — osobne ponowne ustawienie kamery i `controls.target`.

Jest to pełna pętla sprzężenia zwrotnego, a nie pojedynczy zbędny render.

### P0-3 — auto-fit może zmienić kamerę podczas aktywnego gestu

Pierwszy efekt `CameraController` obsługujący początkowy fit, zmianę bounds, jawny fit i reset nie sprawdza `viewport3DCameraGestureActive(cameraGestureRef)`. Gdy spełni warunek, wykonuje kolejno:

- `camera.position.set(...)`;
- `camera.lookAt(...)`;
- zapis do `viewport3dStore`;
- zapis przez `onCameraChange` do registry.

To może przerwać orbitowanie natychmiast, bez oczekiwania na `onEnd`.

Ryzyko zwiększa `CAMERA_STATE_EPSILON = 1e-7`. Jest to absolutna tolerancja 100 nm, podczas gdy testowane obiekty i bounds mają skalę setek nanometrów. Kod może więc uznać realny ruch użytkownika za nadal równy poprzedniemu auto-fitowi i ponownie dopasować kamerę po zmianie sygnatury bounds.

Dowód:

- `CameraControls.tsx:91-92` — niespójne tolerancje `1e-7` i `1e-12`;
- `CameraControls.tsx:429-458` — absolutne porównanie stanu;
- `CameraControls.tsx:545-595` — auto-fit bez guardu gestu;
- `CameraControls.test.ts:601-619` — test utrwala uznanie przesunięcia `2e-8` za auto-managed;
- `useViewport3DSceneModel.ts:3086-3126` — bounds są składane z kilku asynchronicznych źródeł.

### P1-1 — lifecycle wheel zoom kończy osłonę przed końcem animacji

Wheel ma dwie niezależne ścieżki obsługi na tym samym canvasie:

1. pasywny capture listener rozpoczyna gest i kończy go po 150 ms;
2. własny niepasywny capture listener zatrzymuje propagację, prowadzi animację w `useFrame` i kończy gest po osiągnięciu celu.

Animacja używa tłumienia `18` i tolerancji względnej `1e-4`; typowy czas dojścia jest dłuższy niż 150 ms. Po odpaleniu pierwszego timeoutu `active=false`, choć `wheelZoomAnimatingRef` może nadal być prawdziwe. `fieldHoldActive` pozostaje przez chwilę, ale efekty kamery sprawdzają wyłącznie `active`, nie field hold.

Dowód:

- `CameraControls.tsx:774-987` — własny smooth zoom;
- `CameraControls.tsx:1078-1111` — drugi listener i timeout 150 ms;
- `viewport3DCameraGesture.ts:37-51` — `active=false` ustawiane natychmiast;
- browser smoke — `viewportFrameDelta=1`, test przerwany w `assertSmoothCameraWheelZoomPhase`.

Ta implementacja nie korzysta z normalnej ścieżki wheel w `OrbitControls`, mimo że Drei już obsługuje invalidację i damping w demand loop.

### P1-2 — commit po 180 ms jest poprawnym kierunkiem, ale nie stanowi bariery wersji

Commitowanie dopiero po `onEnd` i po wyciszeniu damping jest poprawą względem wcześniejszych commitów pośrednich. Komentarz w kodzie wprost opisuje poprzedni stale-pose rewind. Zmiana została dodana w commicie `ff2d4eaeee9163d0b00ed9b067ca20f2074316d1` z 2026-08-06.

Jednak timer 180 ms jest tylko opóźnieniem czasowym. Nie ma identyfikatora gestu ani sprawdzenia, że callback dotyczy nadal tej samej kamery/projekcji. Nowy gest, zmiana projekcji, auto-fit albo remote update mogą wejść pomiędzy zaplanowanie i wykonanie callbacku. Część przypadków czyści timer, ale nie istnieje ogólny kontrakt „latest gesture wins”.

### P1-3 — `endInteraction()` zawiera jawny mechanizm snap-back

Jeśli registry uzna, że po zakończeniu interakcji kamera nie jest dirty, a `persistedShadow` różni się od bieżącej kamery, `endInteraction()` bezpośrednio ustawia kamerę na `persistedShadow`.

Dowód: `CameraRegistryController.ts:149-168`.

To jest zamierzone zachowanie typu remote-wins, ale z perspektywy sterowania kamerą jest dokładnie operacją „wróć do zapisanego widoku”. Każda ścieżka HUD/debug, która nie wykona lokalnego patcha przed `endInteraction`, może wywołać skok. W modelu kamery lokalnej podczas gestu bezpieczniejsza jest reguła: pending remote może zostać przyjęty dopiero po potwierdzeniu, że od początku gestu nie zaszła żadna lokalna zmiana, z użyciem wersji/epoki, a nie tylko bieżącego bitu `dirty`.

### P2-1 — tolerancje nie są skalowo spójne

- `nearCameraState`: `1e-7` dla position/target/up;
- sync `OrbitControls`: `1e-12`;
- registry signature: `1e-12` dla wektorów i orthographic scale;
- store: porównanie dokładne.

W efekcie ten sam ruch może być jednocześnie:

- „bez zmian” dla auto-fit;
- „wymaga ponownego nałożenia” dla controls;
- nową wartością dla store;
- zmianą lub brakiem zmiany dla registry po kwantyzacji.

Tolerancja kamery powinna być zależna od skali sceny lub od odległości camera-target, a `up` powinien mieć osobną tolerancję bezwymiarową.

### P2-2 — diagnostyka nie mierzy ciągłości trajektorii kamery

Aktualny smoke sprawdza:

- zmianę sygnatury DOM po geście;
- brak niedozwolonych requestów;
- liczbę `recordDirtyFrame`;
- zdrowie canvasa/WebGL.

Nie próbkuje jednak w każdej klatce jednocześnie:

- `camera.position` z Three;
- `controls.target`;
- `viewport3dStore.camera`;
- `CameraRegistry.camera` i `persistedShadow`;
- aktywnej epoki gestu.

Dlatego końcowa pozycja może być poprawna, a krótkie cofnięcie w środku trajektorii pozostać niewykryte. Dodatkowo licznik nazwany `frames` jest inkrementowany przez `recordDirtyFrame()`, czyli mierzy zgłoszone powody zabrudzenia, nie bezpośrednio każde wywołanie `gl.render()`.

## 5. Zgodność z R3F / Drei / Three.js

| Obszar | Ocena | Uzasadnienie |
|---|---|---|
| `frameloop="demand"` | poprawne | zgodne ze specyfikacją Fullmag i dokumentacją R3F |
| Drei `OrbitControls` | poprawne bazowo | `makeDefault`, przypięcie do aktywnej kamery i canvasu są prawidłowe |
| Damping | poprawne w Drei | zainstalowany Drei wykonuje `controls.update()` w `useFrame` i invaliduje na `change` |
| Ręczne `invalidate()` | częściowo redundantne | Drei robi to automatycznie; własne animacje muszą invalidować, lecz lifecycle wymaga jednego ownera |
| Orbit / pan | matematyka Three poprawna | problem leży w zewnętrznym nadpisywaniu state, nie w algorytmie OrbitControls |
| Wheel zoom | niezgodne z docelowym prostym modelem | własny capture handler omija standardową obsługę wheel OrbitControls i tworzy drugi lifecycle |
| Aktualizacja targetu po programowej zmianie | poprawne | kod ustawia `controls.target` i wywołuje `controls.update()` |
| Projection swap | zasadniczo poprawne | poza gestem przełącza aktywną kamerę; efekt celowo nie zależy od każdej zmiany pose |
| Auto-fit | niepoprawne współbieżnie | może wejść w środek gestu i używa tolerancji nieadekwatnej do skali |
| Cleanup OrbitControls | poprawne przez Drei | wrapper łączy i `dispose()` na unmount |
| Custom R3F root | akceptowalne | używane API `createRoot/configure/render/unmountComponentAtNode` istnieje w zainstalowanym R3F; nie znaleziono bezpośredniej przyczyny rewind |

Źródła referencyjne:

- [R3F: Scaling performance — demand rendering i automatyczna invalidacja Drei controls](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
- [Drei: Controls — damping, cleanup, demand compatibility i `makeDefault`](https://drei.docs.pmnd.rs/controls/introduction)
- [Three.js: OrbitControls — orbit, dolly, pan, damping, target i eventy start/change/end](https://threejs.org/docs/pages/OrbitControls.html)

## 6. Analiza poszczególnych operacji

### 6.1. Obrót lewym przyciskiem

Sama ścieżka Drei jest właściwa. `onStart` aktywuje lokalny `cameraGestureRef`, `onChange` nie zapisuje już pozycji pośrednich do React state, a `onEnd` ponownie podtrzymuje guard do czasu wyciszenia damping. To naprawia wcześniejszy błąd commitowania co 180 ms podczas przytrzymanego drag.

Pozostaje jednak luka registry: `CameraRegistryController` nie dostaje begin/end. Remote update lub auto-fit może więc przygotować stary snapshot, który zostanie nałożony po zwolnieniu guardu. Długi drag jest szczególnie dobrym reproduktorem, bo zwiększa szansę na resource/realtime update.

### 6.2. Panorama prawym przyciskiem

Ryzyko jest większe niż przy obrocie, ponieważ zmieniają się jednocześnie `camera.position` i `controls.target`. Ponowne nałożenie starego targetu jest wizualnie bardziej gwałtowne niż niewielka korekta pozycji. Test smoke ma gate na long animation frames i rebuildy, ale w bieżącym przebiegu nie doszedł do fazy pan, ponieważ wcześniej zatrzymał się na wheel zoom.

### 6.3. Zoom kołem

To obecnie najsłabsza ścieżka:

- własny listener blokuje standardowy wheel `OrbitControls` przez `stopImmediatePropagation()`;
- osobny listener zarządza timeoutem gestu;
- własny `useFrame` animuje distance/orthographic zoom;
- commit następuje dopiero po settle;
- test runtime wykazał tylko jeden zarejestrowany krok/dirty frame.

Nie ma uzasadnienia, aby dwa niezależne listenery zarządzały tym samym gestem. Albo wheel w całości należy do Drei `OrbitControls`, albo własny zoom musi mieć jeden lifecycle oparty o jawny stan `animating`, bez niezależnego timeoutu.

### 6.4. Zoom ortograficzny

Przeliczenie `orthographicScale = viewportHeightPixels / camera.zoom` jest wewnętrznie spójne z tworzeniem klatki ortograficznej. Problemem pozostaje synchronizacja: końcowy commit zapisuje pose, projection i scale, a zdalna hydratacja kopiuje wszystkie trzy do store. Stara orthographic scale może zatem wywołać widoczny skok nawet przy niezmienionym position/target.

### 6.5. Fit, reset i zmiana projekcji

Jawne komendy fit/reset powinny móc przerwać gest, ale musi to być świadoma operacja z anulowaniem bieżącej epoki. Obecny auto-fit wywołany zmianą bounds nie jest jawny i nie powinien mieć takiego prawa. Projection swap jest lepiej odseparowany: pose jest nakładany przy zmianie projekcji, a nie przy każdym renderze.

### 6.6. Resize i aktualizacje zasobów

Custom `Viewport3DCanvas` aktualizuje size tylko przy realnej zmianie wymiarów. `resourceFrameKey` i `visualizationRevision` prawidłowo invalidują demand frame. Nie znaleziono stałego render loop ani bezpośredniego resetowania kamery przez resize.

Ryzyko pośrednie pozostaje w parent rerenderach: zmiany asynchronicznych bounds i camera resource uruchamiają efekty, które mogą zapisać pose. Problemem nie jest sam rerender, tylko efekty uboczne zależne od tych propsów.

## 7. Dlaczego istniejące testy są zielone

Zawężony przebieg:

```text
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/modules/viewport-3d/layers/CameraControls.test.ts \
  src/modules/viewport-3d/layers/viewport3DCameraGesture.test.ts \
  src/kernel/visualization/CameraRegistryController.test.ts \
  src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts \
  src/modules/viewport-3d/layers/Viewport3DScene.test.ts \
  src/modules/viewport-3d/Viewport3DModule.test.ts \
  src/modules/viewport-3d/Viewport3DCanvas.test.ts \
  src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
```

Wynik: **8 plików, 302 testy, wszystkie PASS**.

Testy pokrywają pojedyncze funkcje i kontrakty tekstowe, ale nie pełną kolejność:

```text
pointerdown -> remote revision -> store mirror -> pointerup -> damping
-> delayed commit -> kolejna remote revision
```

Brakuje również testu `bounds change during active orbit` i testu, który utrzymuje wheel animation dłużej niż 150 ms.

Pierwsze uruchomienie testów było nieważne: `pnpm test -- ...` zebrało cały suite, a Vitest nie utworzył katalogu Windows Temp. Poprawny przebieg użył `/tmp` i bezpośredniego `vitest run`.

## 8. Wynik próby runtime

Uruchomiono lokalny Next.js 16.2.6 na `127.0.0.1:3100`, a następnie:

```text
env TMPDIR=/tmp \
  CONTROL_ROOM_URL=http://127.0.0.1:3100/workspace \
  CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
  pnpm --dir apps/control-room smoke:viewport-3d
```

Smoke uruchomił Chromium i przeszedł do gestów kamery. Zatrzymał się na:

```text
Camera wheel zoom was applied in too few viewport frames: viewportFrameDelta=1.
```

To jest świeży dowód wykonawczy regresji płynności wheel zoom w bieżącym kodzie. Nie jest to jeszcze dowód dokładnego snap-back przy orbitowaniu, ponieważ smoke nie rejestruje trajektorii live camera vs store/registry, a po błędzie wheel nie wykonał fazy pan.

## 9. Zalecany projekt naprawy

### Etap 1 — jedna władza podczas gestu

W czasie orbit/pan/zoom jedynym właścicielem `position`, `target`, `up` i zoom ma być instancja Three + controls. React store, registry, remote hydrate i auto-fit nie mogą nakładać pose.

Każdy gest powinien otwierać jedną transakcję obejmującą równocześnie:

- lokalny guard R3F;
- `CameraRegistryController.beginInteraction()`;
- field update hold;
- unikalny `gestureEpoch`.

Transakcja kończy się dopiero po rzeczywistym `rest/settled`, nie po stałym timeoutie niezależnym od ruchu.

### Etap 2 — jeden commit, latest-wins

Po settle należy odczytać finalną pozycję bezpośrednio z camera/controls i wykonać jeden atomowy zapis do klientowego registry. Store renderera powinien albo:

- subskrybować dokładnie ten sam snapshot registry; albo
- być wyłącznie transient fallbackiem i nie duplikować kanonicznej pozycji.

Delayed callback musi zawierać `gestureEpoch`; callback starszej epoki jest ignorowany.

### Etap 3 — remote hydrate bez cofania

Remote camera należy stosować wyłącznie:

- przy pierwszej hydratacji nowej sesji;
- po jawnej zmianie sesji/presetu;
- gdy nie trwa gest, nie ma lokalnego dirty i remote revision jest nowsza od znanego persisted version.

Nie należy kopiować każdego `cameraResource` do store tylko dlatego, że zmieniła się rewizja visualization state. `persistedShadow` może się aktualizować w tle bez zmiany live view.

`endInteraction()` nie powinno automatycznie snapować do `persistedShadow`. Konflikt remote/local powinien być rozstrzygnięty przez wersje i regułę local-wins dla rozpoczętego gestu.

### Etap 4 — auto-fit jako jawna, anulowalna komenda

- zablokować auto-fit podczas aktywnego gestu;
- po pierwszym realnym ruchu użytkownika trwale wyłączyć auto-managed state do jawnego `Fit`/`Reset`;
- nie inferować „użytkownik nadal jest na auto-fit” przez absolutne `1e-7`;
- jeśli bounds zmienią się podczas gestu, zachować je jako pending i nie stosować automatycznie po `onEnd` bez jawnej polityki.

### Etap 5 — uprościć wheel

Preferowany wariant: usunąć własny smooth wheel i pozostawić wheel/dolly w Drei `OrbitControls`, który już zarządza update, damping, eventami i demand invalidation.

Jeśli wymagany jest niestandardowy zoom:

- jeden listener zamiast dwóch;
- jeden stan `idle | animating | settled`;
- brak stałego 150 ms kończącego guard;
- commit i `endInteraction` dopiero w `settled`;
- anulowanie przez gesture epoch przy nowym wheel/pointer/projection/fit.

## 10. Wymagane testy regresyjne

### Test integracyjny kontrolerów

Wstrzyknąć kolejno:

1. start orbit;
2. zdalną kamerę A;
3. lokalne ruchy kamery B/C/D;
4. pointerup i damping;
5. zdalną kamerę A z nowszą rewizją;
6. finalny commit D.

Oczekiwanie: żywa kamera nigdy nie przyjmuje A; store i registry kończą na D; persisted shadow może zawierać A do czasu zapisu, ale nie steruje renderem.

### Test auto-fit

Zmienić bounds podczas aktywnego orbitowania. Oczekiwanie: brak `camera.position.set`, brak store patch i brak registry patch do zakończenia gestu; po zakończeniu nie ma automatycznego fitu, jeśli użytkownik przejął kamerę.

### Test wheel

Uruchomić cztery ticki wheel, następnie próbkując każdą rAF przez co najmniej 750 ms. Oczekiwanie:

- co najmniej kilka monotonicznych kroków distance/zoom;
- brak zmiany znaku prędkości bez nowego inputu;
- brak chwilowego powrotu do wartości początkowej;
- guard registry aktywny aż do settle;
- dokładnie jeden końcowy commit.

### Browser trajectory probe

Dodać development/audit-only snapshot zawierający w każdej klatce:

```text
timestamp
gestureEpoch
gestureActive
three.camera.position
orbit.target
viewportStore.camera
cameraRegistry.camera
cameraRegistry.persistedShadow
cameraRegistry.localVersion
cameraRegistry.lastRemoteRevision
dirtyReason
```

Gate powinien liczyć maksymalny krok wstecz względem trajektorii gestu, nie tylko porównywać stan przed i po.

## 11. Kryteria zamknięcia poprawki

Naprawy nie należy uznać za zakończoną wyłącznie na podstawie testów funkcji. Wymagane są wszystkie poniższe dowody:

1. obrót przez co najmniej 2 s przy jednoczesnych aktualizacjach visualization/field nie powoduje cofnięcia ani auto-fit;
2. right-pan zachowuje monotoniczny target i position;
3. wheel perspective i orthographic wykonują wieloklatkowy, ciągły ruch i jeden commit;
4. przełączenie projection, jawny Fit, Reset i ViewCube mają deterministyczne reguły anulowania aktywnego gestu;
5. gesty nie wykonują requestów data/model/meshing/visualization;
6. po settle live camera, controls target, store i registry są zgodne w jednej skali tolerancji;
7. idle viewport renderuje zero klatek po wyciszeniu;
8. canvas jest widoczny, WebGL nie jest lost, drawing buffer ma niezerowy rozmiar;
9. test z wymuszoną remote revision oraz bounds update w środku gestu przechodzi;
10. ręczna próba w przeglądarce potwierdza brak „cofnięcia do pozycji sprzed sekundy”.

## 12. Kolejność wdrożenia

1. Połączyć lifecycle OrbitControls z lifecycle CameraRegistry i dodać gesture epoch.
2. Zablokować auto-fit oraz registry/store pose application podczas gestu.
3. Usunąć bezwarunkowy mirror registry → store albo ograniczyć go do hydratacji sesji.
4. Uprościć wheel do jednego ownera.
5. Ujednolicić tolerancje względem skali sceny.
6. Dodać trajectory probe i testy wyścigu.
7. Wykonać pełny browser smoke oraz ręczną kwalifikację na aktywnej sesji FDM i FEM.

## 13. Konkluzja

Najpilniejsza poprawka nie polega na zwiększeniu FPS ani zmianie `dampingFactor`. Cofanie kamery wynika z braku jednej granicy własności: żywa kamera jest sterowana przez OrbitControls, ale opóźniony store, remote registry i auto-fit nadal mają prawo ją nadpisać.

Kod jest blisko poprawnego modelu — istnieje lokalny gesture guard, registry z persisted shadow, demand rendering i commit po settle — lecz elementy te nie tworzą jednej transakcji. Dopiero połączenie ich wspólną epoką gestu i zasadą `local interaction wins` usunie zarówno reset pozycji, jak i znaczną część klatkowania wynikającego z niepotrzebnych synchronizacji.
