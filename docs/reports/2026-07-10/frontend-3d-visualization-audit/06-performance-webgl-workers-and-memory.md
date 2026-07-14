# 06. Performance, WebGL, workery i pamięć

## Stan reaudytu 2026-07-14

F3D-019–F3D-025 pozostają **naprawione w pierwotnie zdefiniowanym zakresie**.
W szczególności F3D-022 potwierdza współdzielenie uploadu positions na
syntetycznym FEM, ale nie obejmuje kosztu wyliczania surface colors i vector
segments dla około 833–909 tys. tetraedrów. Ten brak budżetu i progresywnego
renderowania jest nowym F3D-029.

Findings oznaczone **M** opisują realną lukę ownership lub brak ograniczenia w
kodzie, ale rozmiar efektu musi zostać potwierdzony pomiarem prawdziwego WebGL.
Plan naprawy zaczyna się wtedy od instrumentacji, nie od obniżania jakości obrazu.

## F3D-019 — workery 3D nie są zwalniane przy unmount ostatniego viewportu

**Priorytet:** P2 — średni
**Dowód:** S
**Kontrakt:** nieaktywny viewport nie utrzymuje własnych workerów, timerów ani
pending jobs; cleanup ma być związany z właścicielem modułu, nie tylko timeoutem.

### Dowód i mechanizm

Modułowe singletony tworzą worker clients i idle timers:

- `viewport3dTopologyIndexScheduler.ts:141-144,191-342`;
- `viewport3dColorTransformScheduler.ts:160-163,254-406`;
- `region-overlays/viewport3dRegionOverlayBuildScheduler.ts:110-113,154-287`;
- `layers/vectorGlyphBuildScheduler.ts:143-146,187-362`;
- `layers/fdmCuboidBuildScheduler.ts:140-268`.

Część ma eksport `dispose...ForTests`, lecz produkcyjny unmount viewportu nie
wywołuje wspólnego dispose. Workery kończą dopiero po timeoutach idle rzędu
dziesiątek sekund albo po błędzie.

### Wpływ

Po przełączeniu 3D -> 2D workery, bufory transferowe, timery i listenery mogą
pozostać aktywne mimo braku właściciela UI. Tracker viewportu nie obejmuje tych
modułowych singletonów.

### Plan naprawy

1. Wprowadzić `Viewport3DWorkerRuntime` jako jawnego właściciela schedulerów.
2. Użyć lease/refcount: pierwszy viewport nabywa runtime, ostatni unmount zwalnia
   go natychmiast.
3. Dispose ma anulować jobs, odrzucić pending promises z kontrolowanym AbortError,
   usunąć listenery, skasować timers i terminate workers.
4. Reaktywacja tworzy świeży runtime bez odziedziczonego fallback/error state.
5. Włączyć worker count/timers/jobs do audit hook i resource tracker.

### Test regresyjny i kryterium akceptacji

- Mount 3D, uruchomienie wszystkich lanes, przejście do 2D, unmount: natychmiast
  zero workerów, timeoutów i pending jobs.
- Powrót do 3D działa na świeżym runtime.
- StrictMode pozostaje wyłączony zgodnie z repo policy; test nie może polegać na
  sztucznym double-mount.

## F3D-020 — cache zbudowanych glyphów rośnie bez globalnego limitu

**Priorytet:** P1 — wysoki
**Dowód:** S
**Kontrakt:** duże typed arrays muszą mieć budżet bajtów i deterministyczną
eviction; zmiana quantity/style/budget nie może powodować nieograniczonego wzrostu.

### Dowód i mechanizm

- `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx:488-492`
  tworzy `Viewport3DDerivedBufferCache` na lifetime warstwy.
- Każdy zakończony build trafia przez `cache.putReady` w `:529-541`.
- Cache udostępnia `evictToMaxBytes` w
  `build-engine/cache/viewport3dDerivedBufferCache.ts:220-230`, lecz ta ścieżka
  nie wywołuje jej po insert/release.
- Revision eviction pracuje tylko w obrębie wskazanego lane/group; kolejne
  quantity/scope/style group keys mogą się kumulować.

### Wpływ

Długie sesje z przełączaniem quantity, color mode, shaft/head ratios, targetu i
budżetu glyphów mogą zatrzymywać kolejne duże wyniki workerów w pamięci JS.

### Plan naprawy

1. Zdefiniować limit bajtów i maksymalną liczbę entries dla vector-glyph lane.
2. Po `putReady` i po `release` wywoływać eviction, respektując refcount.
3. Usuwać nieaktywne group keys po zmianie target/quantity.
4. Dodać `dispose()` cache przy unmount warstwy/runtime.
5. Raportować entry count/bytes/retained bytes w diagnostics i memory gate.

### Test regresyjny i kryterium akceptacji

- Setki przełączeń quantity/style/budget nie przekraczają limitu entries/bytes.
- Aktualnie retainowany buffer nie jest usuwany; po release podlega LRU eviction.
- Browser heap i tracker wracają do ustalonego plateau po cyklach.

## F3D-021 — shader attribute slots nie mają udowodnionego lifecycle GPU

**Priorytet:** P2 — średni
**Dowód:** S + M
**Ryzyko:** przełączanie scalar/orientation/complex może tworzyć kolejne
`BufferAttribute`, podczas gdy samo `deleteAttribute` nie jest jawnym GPU dispose.

### Dowód i mechanizm

- `useViewport3DScalarColorUpload.ts:496-520` po uploadzie dołącza nowe attribute
  i usuwa nieaktywne przez `deleteShaderAttributeIfAbsent`.
- `:606-620` usuwa referencję z geometrii przez `geometry.deleteAttribute`.
- Przy ponownym trybie funkcja tworzy/wiąże nowy attribute slot. Nie ma jawnego,
  topology-lifetime ownera slotów ani runtime pomiaru `createBuffer/deleteBuffer`.
- Test `useViewport3DScalarColorUpload.test.ts:164+` sprawdza JS geometry
  attributes, nie rzeczywiste WebGL buffers.

### Wpływ

Nie ma obecnie dowodu, że wielokrotne przełączanie shader modes utrzymuje stałą
liczbę i bajty buforów GPU. To luka ownership/gate; przed zmianą implementacji
należy zmierzyć realny efekt.

### Plan naprawy

1. Najpierw zinstrumentować WebGL `createBuffer/deleteBuffer` i renderer info na
   100+ przełączeniach trybu.
2. Jeżeli liczba rośnie, utrzymywać stabilne topology-lifetime attribute slots i
   aktualizować arrays in-place (`needsUpdate`/update ranges).
3. Sloty nieużywane oznaczać w material defines/uniforms, nie zastępować nową
   tożsamością bez cleanup.
4. Dispose wszystkich slotów razem z owner geometry przy zmianie topologii/unmount.

### Test regresyjny i kryterium akceptacji

- Po warm-up liczba WebGL buffers nie rośnie liniowo z liczbą przełączeń.
- Po zmianie topologii/unmount stare bufory są zwolnione.
- Wynik wizualny i dokładność kolorów pozostają identyczne.

## F3D-022 — FEM może wielokrotnie uploadować pełne positions dla partów/passów

**Priorytet:** P2 — średni
**Dowód:** S + M
**Kontrakt:** liczba partów/passów nie powinna automatycznie mnożyć pełnego bufora
pozycji całej topologii.

### Dowód i mechanizm

- `MeshPartLayer.tsx:120-150` używa pełnego positions dla raw-nodal surface, ale
  dla `expandSurfaceFaces=true` tworzy face-expanded buffer. Wireframe w
  `:408-417` ponownie opakowuje pełne topology positions.
- Point geometry również używa pełnego positions wraz z indeksem selection
  (`viewport3dPointGeometry.ts:63+`).
- `BoundsLayers.tsx:224+` i `FallbackTopologyMeshLayer.tsx:113+` mają dodatkowych
  właścicieli geometry/position attributes.
- Różne `BufferAttribute` identities są dla Three.js osobnymi uploadami, nawet
  jeśli wskazują równoważne dane JS.
- Brak bramki mierzącej liczbę i bajty rzeczywistych WebGL buffer uploads na
  scenie wielopartowej.

### Wpływ

Górne ograniczenie kosztu GPU/uploadu dla raw-nodal surface, wireframe i points
może zbliżać się do `liczba partów × liczba tych passów × pełne positions`.
Projection-expanded surface ma inną charakterystykę i nie wolno wliczać go
automatycznie jako kolejnej kopii pełnej tablicy.

### Plan naprawy

1. Zmierzyć buffer uploads/bytes dla 1, 10 i 100 partów oraz kombinacji passów.
2. Jeżeli duplikacja się potwierdzi, wybrać jedną strategię:
   - współdzielony topology-scoped GPU position owner z refcount; albo
   - kompaktowe, zremapowane positions per part, jeśli oszczędzają więcej niż
     koszt mapowania.
3. Rozdzielić positions ownership od index ownership; passy mogą mieć różne
   indeksy, ale nie muszą kopiować pełnych positions.
4. Zachować current quality; nie obniżać geometrii jako domyślnej optymalizacji.

### Test regresyjny i kryterium akceptacji

- Budżet uploads/bytes skaluje się z unikalną topologią albo rzeczywistą liczbą
  węzłów partów, nie mechanicznie z pass count.
- Surface/wireframe/points pozostają wizualnie i topologicznie zgodne.

## F3D-023 — wyjątek uploadu może zatrzymać globalny GPU coordinator

**Priorytet:** P1 — wysoki
**Dowód:** S
**Kontrakt:** błąd jednego ticketu nie może blokować uploadów innych targetów ani
pozostawiać globalnego schedulera bez następnej klatki.

### Dowód i mechanizm

- `build-engine/gpu/viewport3dGpuUploadManager.ts:194-196` wywołuje
  `chunk.upload()` bez `try/catch/finally`. Wyjątek pojawia się przed przesunięciem
  indeksu i usunięciem ticketu, więc zatruwa head kolejki także po reschedule.
- `:233-237` wywołuje `ticket.onVisible()` bez ochrony.
- Wyjątek `onVisible` następuje już po `queue.shift()` i cleanupie. Zatrzymuje
  bieżący cykl, ale późniejsze enqueue może ponownie uruchomić coordinator; jego
  skutek jest węższy niż wyjątku `chunk.upload`.
- Global coordinator w `:313+` czyści `scheduledFrame` przed przetwarzaniem.
  Wyjątek przerywa callback przed bezwarunkowym reschedule/cleanup.

### Wpływ

Jeden wadliwy attribute/topology/glyph upload może zatrzymać wszystkie późniejsze
uploady, pozostawić ticket i listener oraz zamrozić viewport w częściowym stanie.

### Plan naprawy

1. Dodać per-ticket error boundary dla `chunk.upload` i `onVisible`.
2. W `finally` zawsze wykonać cleanup bieżącego ticketu i ponowne schedule, jeżeli
   kolejka nie jest pusta.
3. Wprowadzić terminalny status `failed` z lane/key/error i cleanup częściowych
   zasobów.
4. Dodać jawny rollback/disposal callback dla chunków wykonanych przed błędem.
5. Nie pozwalać jednemu managerowi przerwać round-robin innych aktywnych hostów.
6. Propagować error do viewport diagnostics/HUD bez throw przez globalny frame.

### Test regresyjny i kryterium akceptacji

- Pierwszy ticket rzuca w upload; drugi z innego managera kończy się poprawnie.
- Rzut w `onVisible` również nie blokuje kolejki.
- Failed ticket nie pozostawia listenerów, active host ani częściowych resources.

## F3D-024 — pointer-hold listenery nie są usuwane symetrycznie

**Priorytet:** P3 — niski
**Dowód:** S

### Dowód i mechanizm

- `Viewport3DModule.tsx:1212-1232` dodaje na `window` osobne `pointerup` i
  `pointercancel` z `{ once: true, capture: true }`.
- Zdarzenie kończące usuwa tylko listener, który zostało wywołany; drugi może
  pozostać.
- Cleanup w `:1236-1241` zwalnia hold, ale nie wykonuje
  `removeEventListener` dla obu callbacków.

### Plan naprawy

1. Zaimplementować jeden helper install/end/cleanup przechowujący stan instalacji.
2. Każda ścieżka end oraz unmount usuwa oba listenery z identycznym capture flag.
3. Nie dodawać duplikatów przy kolejnym pointerdown podczas aktywnego hold.

### Test regresyjny i kryterium akceptacji

- Pointerdown -> pointerup -> unmount: oba listenery usunięte dokładnie raz.
- Analogicznie pointercancel i unmount bez eventu kończącego.

## F3D-025 — mapowanie regionów zawiera koszt O(M × R)

**Priorytet:** P3 — niski
**Dowód:** S

### Dowód i mechanizm

`useViewport3DSceneModel.ts:2307-2320` dla kolejnych owner parts wyszukuje region
przez `allRegionOverlays.find(...)`. Dla `M` owner parts i `R` overlays daje
`O(M × R)`; tylko gdy M skaluje się z R, zachowanie wygląda kwadratowo.

### Plan naprawy

1. Zbudować memoizowany `Map<regionId, RegionOverlayInput>` raz na rewizję.
2. Używać lookup O(1) przy mapowaniu membership owner parts.
3. Nie wprowadzać nowego store; mapa jest czystym derived model. Złożoność po
   zmianie powinna wynosić `O(R + M)`.

### Test regresyjny i kryterium akceptacji

- Model test dla dużej listy potwierdza liniową liczbę lookup/build operacji.
- Wynik region ordering, labels i carriers pozostaje identyczny.
