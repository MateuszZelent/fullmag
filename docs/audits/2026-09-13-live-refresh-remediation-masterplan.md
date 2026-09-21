# Migotanie wizualizacji live — konsolidacja trzech audytów, weryfikacja stanu i plan naprawczy

**Data:** 2026-09-13
**Baza:** `master` = `origin/master` = **`6e047055c9615ab15cc88a638d6e93101972dcf8`**
**Zastępuje:** rozproszone ustalenia z trzech dokumentów z 2026-09-11 (Codex, Claude, porównanie). Tamte pozostają bez zmian jako źródła; ten dokument jest jedynym rejestrem stanu i kolejności prac.

---

## 1. Decyzja

**Nie zaczynamy od nowa.** Uzasadnienie jest dowodowe, nie uznaniowe: dzisiejszy `master` jest **bajtowo tożsamy** z kodem, na którym powstały oba audyty, w każdym pliku niosącym choćby jedno ustalenie. Ponowna analiza dałaby te same wnioski przy tym samym koszcie.

Co zrobiono, żeby to stwierdzić (2026-09-13):

1. Pobrano z `master` pięć plików decydujących i porównano bajt po bajcie z wersjami audytowanymi: `layers/Viewport3DScene.tsx`, `hooks/useViewport3DScalarColorUpload.ts`, `viewport3dResources.ts`, `kernel/realtime/RealtimeInvalidationBridge.ts`, `hooks/useViewport3DSceneModel.ts`. Cztery pierwsze — **identyczne**. Piąty — jedna zmiana 17 bajtów (`fdmLaneActive &&` dodane przed `fdmFieldCompatibility?.status === "mismatch"`), dotycząca bannera zgodności, bez związku z ustaleniami.
2. Zweryfikowano rozmiary pozostałych plików nośnych na `master`: `build-engine/gpu/viewport3dGpuUploadManager.ts` (14 063 B), `hooks/useViewport3DChunkedScalarColors.ts` (45 417 B), `kernel/resources/{useResource,ResourceRuntimeStore,ResourceInvalidationController,resourceState,planarFieldResources}.ts` — wszystkie zgodne z wersjami audytowanymi.
3. Przejrzano **18 worktree'ów**. Jedyny z edycjami w `viewport-3d` to `frontend-refactoring-20260912` (gałąź `codex/frontend-refactoring-20260912`, edycje 2026-09-12 ok. 20:00). Zakres tych edycji: `layers/vectorGlyphGeometry.ts` (+1520 B), `layers/VectorFieldLayer.tsx` (+730 B), `layers/vectorGlyphBuildScheduler.ts` (+406 B), `layers/vectorGlyphBuildModel.ts` (+154 B), drobne dotknięcia `BoundsLayers.tsx`, `FallbackTopologyMeshLayer.tsx`, `MeshPartLayer.tsx`, `FdmCuboidLayer.tsx` (23–50 B), oraz `modules/field-map/FieldMapModule.tsx`. **To praca nad glifami wektorowymi, nie nad ciągłością odświeżania.** Pliki nośne ustaleń są tam identyczne z `master`.

Metoda porównania worktree'ów: korekta o końce linii (worktree'e są checkoutowane z CRLF, `master` trzyma LF, część blobów ma CRLF w sobie). Plik niezmieniony ma dokładnie `rozmiar_master` albo `rozmiar_master + liczba_linii`; każdy taki plik pasował co do bajta. Zastrzeżenie: dla plików w worktree'ach to porównanie rozmiarów, nie diff treści — most do plików nie sięga tej głębokości ścieżki.

**Wniosek:** żadne ustalenie z trzech audytów nie zostało dotąd naprawione. Zaczynamy wykonanie, nie analizę.

---

## 2. Co faktycznie jest zrobione — i czego to nie zamyka

| Zrobione | Gdzie | Co zamyka | Czego NIE zamyka |
|---|---|---|---|
| **S-16** — progi bloom i skalowanie promienia AO | `layers/PostProcessingLayer.tsx`, na `master` | postprocessing | nic z ciągłości klatki |
| **S-18/S-19** — martwe ścieżki uploadu, `DynamicDrawUsage` | `hooks/useViewport3DScalarColorUpload.ts`, `viewport3dGeometryColors.ts`, `viewport3dScalarSurfaceShader.ts`, commit `61121583`, na `master` | ponowne użycie atrybutu zamiast realokacji; brak zerowania atrybutu przy `colorBuffer === null` | **LR-02** — bramkowanie po zwracanej wartości hooka, nie po stanie atrybutu, więc ochrona jest omijana |
| **Backend, publikacja pól** — klasyfikacja paczek terminalnych, rotacja katalogu | audyt 2026-08-27, zadeklarowane jako FIXED | źródło obserwowanych dziur w publikacji | nic po stronie frontendu; status live tam to `NOT VERIFIED` |
| **ETag / `If-None-Match`** | `viewport3dResources.ts:854, 1410–1412, 1525–1527` | **LR-23a** — rewalidacja warunkowa działa w pętli live | delty między rewizjami (LR-23b) |

Krytyczna uwaga do S-18/S-19: mój audyt z 11.09 analizował kod **po** tych poprawkach. LR-02 nie jest długiem, który się właśnie domknął — opisuje stan po S-19.

---

## 3. Rejestr ustaleń — zdeduplikowany, zweryfikowany na `6e047055`

Kolumna „Źródło" podaje oryginalne ID: `VPF/VPD` = raport Claude, `R/S/D/T` = raport Codex.

### Ciągłość obrazu — P0/P1

| ID | Ustalenie | Źródło | Plik | Weryfikacja |
|---|---|---|---|---|
| **LR-01** | Staged reveal resetuje etap **synchronicznie w renderze**; klucz zawiera flagi `fdmTargetViews.length > 0` / `fdmNativeLayerViews.length > 0`, więc chwilowe opróżnienie kolekcji odmontowuje `FdmCuboidLayer` i zeruje `fieldVector`/`surfaceColors`/`vectorSegments` na ~3 klatki, z `invalidate()` na każdym kroku | VPF-001 + R5 | `layers/Viewport3DScene.tsx` | OTWARTE — kod odczytany |
| **LR-02** | `publish(null, geometry, null)` (4 miejsca) gasi próbkowanie kolorów przy odrzuconej retencji, mimo poprawnych danych w atrybucie GPU | VPF-002 | `hooks/useViewport3DScalarColorUpload.ts` | OTWARTE — kod odczytany |
| **LR-03** | `status === "ready"` + niezgodne identity ⇒ `continue`, **poprzedni zgodny envelope nie jest zachowywany** (fallback działa tylko dla `error/loading/stale`) | R1 | `viewport3dResources.ts`, `resolveViewport3DFieldVectorCollectionLastGood` | OTWARTE — potwierdzone niezależnie 13.09 |
| **LR-04** | Matcher tożsamości sprawdza quantity, `scope_kind/scope_id`, `expected_generation_id`, `expected_carrier_revision`, `component` — **nie sprawdza `snapshot_id`, stage, phase, view** | R4 | `viewport3dResources.ts`, `viewport3DFieldVectorMatchesRequestIdentity` | OTWARTE — potwierdzone niezależnie 13.09 |
| **LR-05** | Koordynator uploadu GPU startuje każdą klatkę od `activeHosts[0]` (brak rotacji, wspólny budżet 3/5 ms); rollback wyłącznie dla `status === "failed"`, nie dla `aborted`; tickety wektorów nie mają wspólnego commitu | VPF-003 + R3 | `build-engine/gpu/viewport3dGpuUploadManager.ts`, `layers/VectorFieldLayer.tsx` | OTWARTE — kod odczytany |
| **LR-06** | Gate budowy kolorów przy niepustym `currentBuildKey` porównuje wyłącznie klucze i **ignoruje `currentFieldVector`**; globalny `modesKey` bez rewizji pola ⇒ nowa próbka może nie wystartować budowy | R2 | `hooks/useViewport3DChunkedScalarColors.ts` | OTWARTE — potwierdzone niezależnie 13.09 |

### Synchronizacja i zasoby — P1/P2

| ID | Ustalenie | Źródło | Plik | Weryfikacja |
|---|---|---|---|---|
| **LR-07** | `queueFieldSampleQuantityInvalidation` unieważnia całe poddrzewo `/{quantity}/` (wektory wszystkich części + `meta` + `availability`); dodatkowo każdy udany fetch wektora unieważnia `…/meta` **poza oknem koalescencji rAF** | VPF-004 | `kernel/realtime/RealtimeInvalidationBridge.ts`, `viewport3dResources.ts` | OTWARTE. **Korekta:** liczby GET-ów i renderów z raportu Claude nieudowodnione — `invalidateMatching` chodzi tylko po kluczach z aktywną subskrypcją. Zmierzyć request graph przed optymalizacją |
| **LR-08** | `abortStaleInflight: true` + kolejne rewizje szybsze niż transfer ⇒ możliwe ciągłe anulowanie bez przyjęcia żadnej próbki | S1 | `kernel/resources/ResourceRuntimeStore.ts` | OTWARTE |
| **LR-09** | Błąd odświeżenia przy zachowanych danych jest maskowany: warunek `state.data === null` przepuszcza do `markResourceLoading`, które zeruje `error` i zwraca `stale` | S4 | `kernel/resources/useResource.ts`, `visibleResourceState` | OTWARTE — potwierdzone niezależnie 13.09 |
| **LR-10** | Mapa 2D: rewizja w `resourceKey` (`#revision=…`) ⇒ każda nowa rewizja to nowy wpis store bez danych ⇒ rodzic renderuje `FieldMapStatus` zamiast `PlanarSurface` ⇒ **cleanup zwalnia renderer i zeruje canvas**. Brak wspólnej granicy commitu warstw | D1 + D2 | `kernel/resources/planarFieldResources.ts:290`, `modules/field-map/FieldMapModule.tsx` | OTWARTE — potwierdzone niezależnie 13.09 |

### Higiena — P2/P3

| ID | Ustalenie | Źródło | Status |
|---|---|---|---|
| **LR-11** | `FallbackTopologyMeshLayer` tworzy `ShaderMaterial` zależny od bufora kolorów i nie podaje `retentionKey`. **Nie jest renderowany w ścieżce produkcyjnej** (tylko definicja + testy) | VPF-005 | OTWARTE, niski priorytet — usunąć albo doprowadzić do wzorca „S-08" |
| **LR-12** | `REFRESH_FLASH_MS = 650` przy cyklu 2 s ⇒ 2–3 zmiany stanu HUD na cykl; `syncVectorGlyphColorState` przełącza `vertexColors` i `needsUpdate` przy zaniku `glyphColors` | VPF-006 | OTWARTE, kosmetyka + latentna klasa błędu |
| **LR-13** | Brak backpressure dekodowania; `queueWaitMs` nie mierzy oczekiwania w kolejce workera | S2 | OTWARTE |
| **LR-14** | Rozdzielić `requestedRevision / receivedRevision / preparedRevision / displayedRevision` w diagnostyce | S3 | OTWARTE — wejście do Fazy 0 |

### Transport — po pomiarze

| ID | Ustalenie | Źródło | Status |
|---|---|---|---|
| **LR-20** | FMVP dopuszcza wyłącznie `float64` (dekoder rzuca dla innego `kind`) | VPD-001 | OTWARTE. **Korekta:** f32 zmniejsza o połowę **sekcję wartości**, nie cały payload, i **nie** o połowę czas dekodowania (dekod to widok na buforze). Wymaga jawnego kontraktu reprezentacji; f64 zostaje dla eksportu i inspekcji naukowej |
| **LR-21** | Brak kompresji odpowiedzi HTTP — zero wystąpień `gzip/brotli/zstd/content-encoding/CompressionLayer` w `crates/fullmag-api/src` poza testami. (Wystąpienia `CompressionProfile`/`zarr_compressor` dotyczą persystencji, nie HTTP) | VPD-002 | OTWARTE. Zyski 2–4× i „pomijalny CPU" — **do zmierzenia**, nie deklarowane |
| **LR-22** | `max_samples` opcjonalne; przy braku serwer wysyła pełne pole | VPD-003 | OTWARTE. **Korekta:** nie wymuszać globalnie — kolorowanie powierzchni i budżet glifów mają różne wymagania |
| **LR-23** | (a) ETag — **ZAMKNIĘTE**, działa w pętli live. (b) Delty między rewizjami — otwarte, opcja badawcza | VPD-004 | a: ZAMKNIĘTE / b: OTWARTE |
| **LR-24** | Jeden współdzielony worker dekodujący; błąd konstruktora zapamiętywany jako `null` na całą sesję | VPD-005 | OTWARTE. Pula 2–4 workerów wymaga benchmarku |
| **LR-25** | Most CLI/runner → API nadal wysyła ciężkie payloady JSON (`.json(&CurrentLiveFieldFrameRequest…)`) | T1 | OTWARTE — potwierdzone niezależnie 13.09. Osobne zadanie od migania |
| **LR-26** | `proto/fullmag/control/v1/jobs.proto` bez żadnych referencji w repo | VPD-006 | OTWARTE, higiena, poza zakresem naprawy viewportu |

Poza rejestrem, do osobnych zadań: T2 (spójność cyklu publikacji), T3 (locki API przy przygotowaniu odpowiedzi), T5 (limity kontraktu binarnego, koalescencja WS), D3 (kolejka colorizera 2D), D4 (matcher `planar_fields` dla źródła Default), D5 (przypięte datasety `analysis-plots` — **zamierzony kontrakt, nie błąd**).

---

## 4. Errata do raportu `2026-09-11-viewport-3d-live-refresh-flicker-audit.md`

Przyjęte korekty z porównania z 2026-09-11, obowiązujące od tego dokumentu:

1. **VPD-004 / ETag** — zalecenie „podłączyć ETag" nieaktualne; działa (`viewport3dResources.ts:854, 1410–1412, 1525–1527`). Pozostaje wyłącznie wątek delt.
2. **VPD-001 / „−50 % czasu dekodowania"** — błędne. Dekod FMVP to utworzenie widoku `Float64Array`, nie parsowanie elementów. Bajty maleją o połowę, czas dekodowania nie.
3. **VPD-001 / „bez zmiany kontraktu semantycznego"** — zbyt swobodne. f32 wymaga jawnego kontraktu reprezentacji i kontroli błędu.
4. **Zalecenie A5 (`retentionKey = geometry + vertexCount`)** — **wycofane jako niebezpieczne.** Ta sama geometria i liczba wierzchołków mogą dotyczyć innej quantity, snapshotu, fazy lub etapu. Zastąpione przez LR-04: retencja domyślnie włączona, ale na **pełnej** tożsamości.
5. **VPF-004 / liczby** — „N dodatkowych renderów", „10–15 GET-ów", „2 ACK na rewizję" nie wynikają z kodu. Zastąpione wymogiem pomiaru request graph.
6. **VPD-002 / „zero wystąpień compression"** — literalnie za szerokie. Poprawnie: zero wystąpień `gzip/brotli/zstd/content-encoding/CompressionLayer`; `CompressionProfile` i `zarr_compressor` dotyczą persystencji.
7. **VPF-001 / „jedyną ochroną jest szczęście"** — niechlujne. Porównanie stringów jest deterministyczne; ryzyko leży w **wejściach** klucza, nie w porównaniu.

Utrzymane wbrew porównaniu: zarzut o „mieszankę wersji bazowych" jest bezprzedmiotowy — dzisiejszy `master` jest bajtowo tożsamy z kodem audytowanym w każdym pliku nośnym ustaleń (§1).

---

## 5. Ustalenie, którego nie ma w żadnym z trzech dokumentów

Sprawdzono hipotezę łańcucha: **LR-03 opróżnia kolekcję → `fdmTargetViews.length === 0` → klucz etapu przeskakuje `fdm-ready → fdm-empty` → LR-01 wykonuje teardown.**

**Łańcuch się nie domyka tą drogą.** `mergeFdmCuboidBuildResult` (`layers/fdmCuboidBuildState.ts:118–129`) zachowuje poprzedni `model`, gdy nowy jest `null`, a `topologyKey` budowy FDM nie zawiera rewizji pola. Brak pola nie opróżnia zatem target views przez model.

Pozostałe drogi opróżnienia (`buildViewport3DFdmTargetViews`): niedostępny `membership`, `membership-not-current`, brak `realizedRegionIds`, `membership-cell-count-mismatch`, `invalid-region-legend`. **Trace ma szukać tych pięciu warunków**, nie churnu wartości pola.

Jedyny **zaobserwowany w runtime** mechanizm opróżniania tych kolekcji jest opisany w `2026-08-27-control-room-field-data-instability-diagnostic.md` (rotacja katalogu `/data/fields` usuwająca całą mapę żądań `H_demag`). Roboczy model przyczynowy: **backend jako wyzwalacz, LR-01 jako wzmacniacz** zamieniający chwilową dziurę w twardy teardown zamiast miękkiego `stale`.

---

## 6. Plan wykonania

Gałąź: `fix/live-refresh-continuity-20260913`, odgałęziona od `master` `6e047055`.

### Faza 0 — trace (blokuje wszystko)

Bez tego żadna faza nie może zostać zamknięta, bo wszystkie ustalenia są potwierdzone **w kodzie**, a żadne **w runtime**.

Instrumentacja do dodania (część istnieje w `Viewport3DResourceTracker` i `viewport3dGpuUploadDiagnostics`):

- `stageKey`, `stageResetReason`, aktualny `stage`;
- `requestedRevision / receivedRevision / preparedRevision / displayedRevision` (LR-14);
- powód odrzucenia retencji (który człon tożsamości nie pasował);
- wariant materiału i stan `vertexColors` per warstwa;
- czas od przyjęcia rewizji do `onVisible` ticketu, per host uploadu;
- liczba ticketów `aborted` na tick.

Przebieg referencyjny: aktywny solver, ≥ 60 s, ≥ 30 aktualizacji, scena z nakładką demag i ≥ 3 częściami, zapis **klatek pośrednich** (nie stanu po ustabilizowaniu).

### Faza 1 — granica retencji (P0, jedno PR)

**LR-03 + LR-04 + LR-02 idą razem**, bo dotyczą jednej decyzji: „kiedy wolno pokazać poprzednią klatkę".

1. `resolveViewport3DFieldVectorCollectionLastGood` — przy `ready` z niezgodnym envelope zachować poprzedni **zgodny** envelope, oznaczyć jako nieaktualny, zgłosić stan; nie `continue`.
2. `viewport3DFieldVectorMatchesRequestIdentity` — domknąć tożsamość o `snapshot_id`, stage, phase, view. Retencja nie może pokazać starej fazy pod etykietą nowej.
3. `useViewport3DScalarColorUpload` — rozdzielić `buffer: null` od `buffer: <ostatni dobry>, fresh: false`; materiał gasi kolory tylko w pierwszym przypadku. Retencja domyślnie włączona, ale **na tożsamości z punktu 2**, nie na `geometry + vertexCount`.

Bramka: sekwencja A → odpowiedź B z niezgodnym identity → C; A widoczna przez całe przejście. Zmiana domeny/remesh/usunięcie targetu nadal odrzuca stare pole.

### Faza 2 — staged reveal (P0)

`layers/Viewport3DScene.tsx`:

1. Z klucza resetu usunąć `fdmNativeLayerViews.length > 0` i `fdmTargetViews.length > 0`; zostawić tożsamość topologii/sceny.
2. Reset przenieść z ciała renderu do efektu **z histerezą bramkowaną zgodnością identity**, nie samym czasem — puste przez ≥ N klatek **i** brak zgodnej poprzedniej klatki.
3. Zamiast `: null` dla `fieldVector`/`surfaceColors`/`vectorSegments` — ostatni dobry bufor (wzorzec `retainLastGood` z `FdmCuboidLayer`).
4. Wygaszenie przy realnej zmianie siatki: przez `opacity`, nie przez odmontowanie poddrzewa.

Bramka: licznik `model-layer-stage-reset` = **0** poza zdarzeniami zmiany siatki.

### Faza 3 — transakcja uploadu (P1)

`build-engine/gpu/viewport3dGpuUploadManager.ts` + `layers/VectorFieldLayer.tsx`:

1. Rotacja round-robin lub wiekowanie ticketów zamiast startu od `activeHosts[0]`.
2. Jawna transakcja upload/commit/abort. Sam warunek `failed || aborted` nie wystarczy — rollback musi umieć odtworzyć poprzednie wartości; docelowo staging/copy-on-write albo podwójny atrybut z kontrolowanym budżetem pamięci.
3. Macierze, kolory i count wektorów przyjmowane jednym commitem.

Bramka: A widoczna → B zapisuje pierwszy chunk → B anulowana przez C → render kamery → C kończy. Brak `count=0`, brak częściowych B, kompletne C.

**Koordynacja:** `VectorFieldLayer.tsx` jest aktywnie edytowany na `codex/frontend-refactoring-20260912` (+730 B, praca nad glifami). Punkty 2–3 wykonać **po** merge tamtej gałęzi albo na niej. Punkt 1 dotyka tylko managera i jest bezkolizyjny.

### Faza 4 — aktualność kolorów (P1, równolegle)

`hooks/useViewport3DChunkedScalarColors.ts`: globalny build key musi zawierać semantyczną tożsamość i rewizję/ID bufora pola. Klucz retencji pozostaje **osobny**, żeby nowa rewizja nie usuwała poprzedniego obrazu.

Bramka: A → B przy stałym manualnym zakresie i niezmienionej topologii zmienia kolory.

### Faza 5 — zasoby i diagnostyka (P1/P2)

LR-08 (kolejka najnowszej rewizji zamiast ciągłego anulowania), LR-09 (rozdzielić `dataStatus` od `refreshStatus/refreshError`), LR-07 (najpierw **pomiar** request graph, dopiero potem zawężanie invalidacji i ewentualny endpoint zbiorczy; zakres kolorbara docelowo w bloku FMMI razem z wektorem).

### Faza 6 — mapa 2D (P1, osobne PR)

LR-10: oddzielić logiczny klucz zasobu od żądanej rewizji albo jawnie przenosić ostatnią zgodną klatkę między wpisami; utrzymać `PlanarSurface` dla tej samej semantycznej tożsamości widoku; commit warstw wg zestawu faktycznie włączonych. Pierwsza regresja: test rodzica `ready → invalidacja podczas running → pending → ready` mierzący tożsamość canvasu i każdą klatkę pośrednią.

### Faza 7 — transport (po pomiarze)

Kolejność: zmierzyć bajty/tick i czasy (Faza 0) → LR-21 (kompresja, najtańsza) → LR-20 (f32 jako osobna reprezentacja prezentacyjna) → LR-22 (budżety per ścieżka) → LR-24 (pula workerów) → LR-23b / LR-25 jako osobne programy.

---

## 7. Kryteria akceptacji

**Twarde, przyjmowane bez benchmarku:**

- 0 resetów etapu przy samej zmianie wartości pola;
- 0 klatek bez wcześniej dostępnej zgodnej warstwy przy zwykłym field refresh;
- 0 zastosowań niezgodnego snapshotu/fazy pod etykietą nowego;
- 0 przebudów topologii wywołanych samą zmianą wartości pola;
- brak cofnięcia `displayedRevision`.

**Do ustalenia po baseline, nie narzucane z góry:** p95 czasu do widoczności, liczba GET-ów na przyjętą próbkę, liczba commitów React na tick, udział dekodowania na wątku głównym, procentowe zyski transportu. Mierzyć zbędną pracę i zagłodzenie, nie wymuszać arbitralnych liczb kosztem poprawności.

**Test migania musi obserwować klatki pośrednie**, nie stan przed i po ustabilizowaniu. Naturalna zmiana koloru fizycznego nie jest miganiem; wzorcem błędu jest niezamierzony blank/baseline/partial frame.

Do CI dodać jeden skrypt `smoke:viewport-3d-live-refresh` egzekwujący trzy pierwsze kryteria. Kontekst: dziś CI uruchamia 2 z 24 istniejących skryptów `smoke:*` (audyt 2026-09-03), a ten obszar jest ewidentnie regresogenny.

---

## 8. Czego nie robić

- Nie wydłużać `field_sample_publish_ms`. To schowa objaw i pogorszy płynność. Poprawnie zrobiony cykl pozwoli **skrócić** okno.
- Nie zastępować `frameloop="demand"` stałą pętlą, nie maskować przejść opóźnieniem CSS, nie obniżać jakości ani gęstości wektorów.
- Nie interpolować pól fizycznych między snapshotami bez jawnej, opisanej funkcji prezentacyjnej.
- Nie przenosić ciężkich payloadów na WebSocket — nie naprawi retencji ani uploadu, a łamie podział odpowiedzialności v2.
- Nie luzować retencji „na czas naprawy" bez domknięcia tożsamości (LR-04). Pokazanie starej fazy pod nową etykietą jest gorsze niż mignięcie.
- Nie mieszać LR-25 (JSON mostu wewnętrznego) z naprawą migania.

---

## 9. Stan weryfikacji

- Wszystkie ustalenia: **CONFIRMED w kodzie na `6e047055`**, żadne **nie potwierdzone w runtime**.
- Nie uruchamiano aplikacji, solvera, przeglądarki, buildów ani testów.
- Przyczyna zgłoszonego przez użytkownika migania w rzeczywistym scenariuszu pozostaje **NOT VERIFIED** do czasu Fazy 0.
- Niezacommitowane zmiany w drzewie roboczym nie były weryfikowane — dostępny był wyłącznie odczyt plików (środowisko powłoki na maszynie użytkownika niedostępne od aktualizacji Windows z 2026-09-08).

## 10. Źródła

- `docs/audits/2026-09-11-active-simulation-render-synchronization-audit.md` (Codex)
- `docs/audits/2026-09-11-viewport-3d-live-refresh-flicker-audit.md` (Claude)
- `docs/audits/2026-09-11-live-refresh-audits-comparison.md`
- `docs/audits/2026-08-27-control-room-field-data-instability-diagnostic.md`
- `docs/audits/2026-09-03-control-room-frontend-full-audit-and-refactor-plan.md`
