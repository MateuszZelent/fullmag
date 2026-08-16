# Audyt produkcyjny wizualizacji Airboxa, obiektów i pól wektorowych

**Data:** 2026-08-16
**Repozytorium:** `fullmag/fullmag`
**Rewizja źródła:** `28a953c515212fbda76fbd372e14264ca672d519`
**Zakres:** Control Room v2, API v2, materializacja `compute_fields`, FDM single-grid, FDM multilayer, FEM Airbox, lifecycle zasobów i pierwsze włączenie wektorów
**Charakter pracy:** audyt read-only; poza tym dokumentem nie zmieniono kodu produktu

## 1. Werdykt

Zgłoszone zachowanie nie ma jednej przyczyny i nie jest zwykłym problemem „za krótkiego timeoutu”. To nałożenie się niespójnego protokołu gotowości backendu z atomowym zarządzaniem zbyt szerokimi zasobami po stronie frontendu.

Najważniejsze ustalenia:

1. **Chwilowy `404`, po którym pole zaczyna działać, jest zgodny z realnymi wyścigami backendu.** `compute_fields` może zostać uznane za zakończone bez dowodu, że żądane `H_demag` i właściwy nośnik Airboxa są gotowe. W ścieżce multilayer payload i manifest są publikowane osobno, więc czytelnik może chwilowo zobaczyć mieszaną generację i hash mismatch mapowany na `404`.
2. **Frontend nie traktuje początkowego `404` jako stanu materializacji.** Automatyczna materializacja i pięciosekundowy polling dotyczą odpowiedzi `204`; binarny `404` kończy request błędem. Hook FEM Airboxa tłumi taki błąd do pustego wyniku, a późniejsze powodzenie zależy od innej invalidacji, remountu albo akcji użytkownika.
3. **Zmiana quantity Airboxa może chwilowo usunąć field-driven warstwy innych targetów.** Wiele żądań FDM jest zgrupowanych pod jednym kluczem i rozwiązywanych przez `Promise.all`. Zmiana jednego żądania tworzy nową kolekcję bez poprzednich danych; do jej pełnego ukończenia pozostałe targety dostają `null` jako pole.
4. **Istnieje drugi, niezależny wyścig stanu targetów.** Patch Airboxa odtwarza pełną tablicę `overrides` z ostatniego stanu autorytatywnego, a synchronizator zastępuje tablice zamiast scalać je po `(scope, scope_id)`. Równoległy, jeszcze niepotwierdzony override obiektu może zniknąć z optimistic state i kolejnego payloadu PATCH.
5. **Pierwsze włączenie wektorów wykonuje więcej pracy niż sugeruje limit 1200 glyphów.** W ścieżce multilayer pobierane jest pełne pole, a worker FDM buduje pełny model nośny przed próbkowaniem wektorów. Dodatkowo zmiana quantity lub gotowości pola zmienia klucz całej przebudowy Airboxa i zeruje poprzedni model na czas pracy workera.
6. **Inspektor błędnie wyznacza zakres Arrow budget dla wszystkich targetów FDM.** Dla Airboxa pokazuje liczbę komórek całej siatki, a następnie nazywa ją liczbą „air-only nodes”. Pomija dokładne `inactive_cell_count`, maskę membership, target, native layer i wybór `Surface | Full`. Użytkownik trafnie zidentyfikował ten błąd.

Nie znaleziono statycznego dowodu, że sama zmiana quantity odmontowuje cały canvas albo globalnie zmienia quantity sceny. Potwierdzone jest znikanie warstw zależnych od pola oraz możliwość utraty targetowych override'ów. Zniknięcie całej geometrii wymaga śladu runtime.

## 2. Status dowodu

| Obszar | Status | Znaczenie |
|---|---|---|
| Rejestracja endpointu i kanoniczne `H_demag` | **zaimplementowane, zweryfikowane źródłowo** | Endpoint istnieje, `H_demag` jest quantity pełnej domeny w A/m. |
| Materializacja i publikacja Airboxa | **zaimplementowane, ryzykowne** | Istnieją potwierdzone race windows i zbyt słaba semantyka completion. |
| Retry `204` | **zaimplementowane, pokryte testami** | Frontend uruchamia `compute_fields` i polluje do 5 s. |
| Retry `404` | **niezaimplementowane** | `404` nie przechodzi przez ścieżkę materializacji. |
| Izolacja targetów podczas zmiany quantity | **niezapewniona** | Kolekcja wielu pól jest atomowa; override'y są scalane niesemantycznie. |
| Accounting wektorów w Inspektorze FDM | **błędny** | Maksimum pochodzi z całej siatki, a etykieta opisuje je jako targetowe węzły Airboxa. |
| Worker i cache glyphów | **zaimplementowane** | Są workery, bounded cache i batched GPU upload. |
| Produkcyjny cold-toggle benchmark | **brak** | Nie ma p50/p95 ani pełnego podziału czasu i bajtów. |
| Bieżąca kwalifikacja przeglądarkowa | **nieuzyskana** | Audit build zablokował osierocony target katalogu Next.js. |
| Kwalifikacja produkcyjna | **nieosiągnięta** | Brak E2E dla race, target isolation i zimnej ścieżki. |

## 3. Oczekiwany kontrakt architektoniczny

Wizualizacja FDM i FEM powinna być spójna na poziomie zasobów oraz adopcji, ale nie powinna udawać, że ich nośniki są identyczne.

```text
quantity capability
  -> materialization command(quantity, scope, generation)
  -> readiness state z reason code
  -> niezmienny carrier topologii
  -> niezależny field resource(target, quantity, scope, generation)
  -> sampled vector resource zgodny z budżetem glyphów
  -> last-good render adoption per target/pass
  -> surface / wireframe / points / vectors jako niezależne passy
```

Wspólne dla FEM i FDM muszą być:

- słownik quantity i units;
- stan `unmaterialized | pending | complete | error`;
- jawne identity targetu, scope i generacji;
- HTTP jako źródło prawdy, realtime tylko jako invalidacja;
- utrzymanie ostatniej zgodnej ramki do atomowej adopcji nowej;
- targetowa izolacja błędów i odświeżeń;
- bounded transport oraz jawny budżet wizualizacji.

Różne pozostają realizacje nośników:

- FDM single-grid: pełna regularna siatka plus membership aktywnych/nieaktywnych komórek;
- FDM multilayer: niezależne native grids i osobny nośnik Airboxa;
- FEM: topologia mesh oraz jawna część Airboxa, np. `part:__air__`.

## 4. Przepływ zgłoszonego przypadku

### 4.1 Włączenie wektorów Airboxa

```text
Inspector patch vectors=true
  -> optimistic visualization state
  -> Airbox demand plan
  -> GET .../H_demag/samples/vector?scope_kind=airbox&max_samples=1200
  -> 204: compute_fields + polling do 5 s
     albo
     404: błąd requestu, bez tej ścieżki materializacji
  -> ewentualna późniejsza invalidacja/remount
  -> ponowny GET
  -> dekodowanie FMVP
  -> worker FDM: model nośny + segmenty
  -> worker glyphów: macierze instancji
  -> batched upload GPU
  -> adopcja passu vectors
```

To wyjaśnia obserwację „dwa razy 404, po chwili działa”: późniejszy sukces nie jest gwarantowanym retry tego samego żądania. Musi wystąpić dodatkowy impuls, np. publikacja revision, invalidacja realtime, zmiana ustawienia albo remount.

### 4.2 Zmiana quantity Airboxa

```text
Airbox activeQuantityId = Q2
  -> zmienia się plan żądań wielu targetów
  -> powstaje nowy zbiorczy resourceKey
  -> nowa kolekcja zaczyna z data=null
  -> Promise.all czeka na wszystkie requesty
  -> field-driven warstwy targetów chwilowo dostają null

równolegle:
  -> zmienia się fdmAirboxBuildKey
  -> begin(newKey) publikuje result=null/status=pending
  -> poprzedni instance model Airboxa nie jest zachowany
  -> po workerze następuje ponowna adopcja modelu i glyphów
```

## 5. Ustalenia backendu i API

### B-01 — P1: completion `compute_fields` nie jest związane z żądanym quantity i carrierem

`compute_fields` uruchamia odświeżenie pełnej listy quantity, ale stan komendy może zostać domknięty po dowolnym readbacku pola, również po samym `m`. Nie istnieje warunek: „`H_demag` dla Airboxa, oczekiwana generacja i zwalidowany nośnik są czytelne przez endpoint”.

**Dowód źródłowy:**

- `crates/fullmag-cli/src/orchestrator.rs`, ścieżka `compute_fields`, linie 5743–5785 i 7997–8022;
- `crates/fullmag-api/src/session.rs`, completion pola, linie 140–152 i 240–242;
- test utrwalający szeroką semantykę: `crates/fullmag-api/src/session.rs`, linie 3166–3184.

**Skutek:** UI może zobaczyć komendę zakończoną, a następnie dostać `404`/`204` dla konkretnego quantity.

### B-02 — P1: nieatomowa publikacja nośnika Airboxa w multilayer

`crates/fullmag-cli/src/live_workspace.rs` w liniach 376–438 podmienia payload i manifest w dwóch kolejnych operacjach. Między nimi czytelnik może połączyć stary manifest z nowym payloadem albo odwrotnie. Walidator wykrywa hash mismatch, ale API klasyfikuje go jako `404`.

**Skutek:** chwilowy `404` jest możliwy nawet wtedy, gdy obliczenie ostatecznie produkuje poprawne dane.

### B-03 — P2: `404` łączy brak, pending i niespójność nośnika

Endpoint deklaruje 200/204/304/400/404/409, bez 202. Rozpoznane quantity bez żadnego źródła daje `204`, ale istniejące i nierozwiązywalne albo niespójne źródło daje szerokie `404`.

**Dowód źródłowy:** `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`:

- handler i kontrakt odpowiedzi: linie 3453–3484;
- wybór `204` kontra `404`: linie 3587–3608;
- stan `pending`/`error` dostępny w meta: linie 2031–2126;
- szerokie mapowanie błędów nośnika multilayer: linie 251–257 i 537–571.

**Skutek:** klient nie potrafi wybrać poprawnej polityki retry ani odróżnić korupcji od gotowości w toku.

### B-04 — P2: transport multilayer nie respektuje budżetu glyphów

Frontendowy request multilayer Airboxa nie wysyła `max_samples`, a dekoder wymaga pełnego `pointCount === totalCells`. Backend również ignoruje `max_samples` dla scope z native grid. Jest to utrwalone testem, w którym `max_samples=1` nadal zwraca cztery punkty.

**Dowód źródłowy:**

- `apps/control-room/src/modules/viewport-3d/model/viewport3DFdmMultilayerAirbox.ts`, linie 16–29 i 45–78;
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`, `resolve_field_vector_sample_limit`, linie 3326–3347;
- `crates/fullmag-api/src/router_v2/tests.rs`, linie 24181–24300.

**Skutek:** dla `N` komórek sam `Float64Array` wartości to `24N` bajtów przed kopiami, metadanymi i modelem renderera. Limit 1200 ogranicza końcowe glyphy, nie transport.

### B-05 — P3: invalidacja realtime może przyjść do 2 s później

QoS dla `fields/samples` dopuszcza opóźnienie 2000 ms. To jest akceptowalne, jeśli HTTP ma jednoznaczny readiness contract; obecnie wzmacnia wrażenie losowego odzyskania.

**Dowód źródłowy:** `crates/fullmag-api/src/schemas/realtime.rs`, linie 112–133; `crates/fullmag-api/src/main.rs`, linie 1501–1536.

### Co nie jest przyczyną

- Brak `scope_id` w zgłoszonym URL nie łamie kontraktu zwykłego FDM. Backend normalizuje Airbox do `scope_id=airbox`.
- `H_demag` nie jest quantity tylko magnetycznym. Katalog definiuje je jako wektorowe pole pełnej domeny w A/m.
- ETag zawiera quantity, revision, component, scope i topologię; nie znaleziono kolizji klucza cache jako źródła problemu.

## 6. Ustalenia frontendowego stanu i transportu

### F-01 — P1: atomowa kolekcja pól unieważnia wiele targetów naraz

`useViewport3DQuantityFieldVectors` tworzy jeden klucz z całego zbioru requestów i czeka na `Promise.all`. Zmiana tylko Airboxowego quantity zmienia klucz kolekcji. Nowy wpis `ResourceRuntimeStore` zaczyna bez danych; stary wpis jest osobnym zasobem i nie jest używany jako last-good.

**Dowód źródłowy:**

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`, linie 1033–1079;
- `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts`, `createEntry`, `ensureLoad` i `releaseUnobservedEntry`;
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, linie 4646–4801.

**Skutek:** pole, kolormapę albo wektory innych targetów można chwilowo wyzerować przez request Airboxa. Geometria bazowa powinna pozostać, o ile nie działa drugi mechanizm przebudowy lub utraty override'u.

### F-02 — P1: pełna tablica `overrides` ma race pomiędzy targetami

Patch Airboxa tworzy pełną tablicę na podstawie `visualizationState.data`, czyli ostatniego stanu autorytatywnego. Synchronizator scala rekordy generycznie, lecz tablice zastępuje w całości. Nie scala ich po tożsamości targetu.

**Dowód źródłowy:**

- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`, linie 1947–2040;
- `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`, linie 319–345, 514–542 i 562–581.

**Sekwencja błędu:**

1. obiekt A ma jeszcze niepotwierdzony lokalny override;
2. autorytatywne `visualizationState.data` jeszcze go nie zawiera;
3. patch Airboxa buduje tablicę bez A;
4. tablica zastępuje optimistic `overrides` i może zostać wysłana do backendu.

### F-03 — P2: `404` nie wchodzi do ścieżki on-demand materialization

`ControlRoomApi.requestFieldVectorOnDemand` reaguje na wynik `not-applicable`, odpowiadający HTTP 204. `requestBinaryResource` rzuca wyjątek dla 404, zanim wrapper może uruchomić materializację. Ogólny retry GET obejmuje 408/429/502/503/504, nie 404.

**Dowód źródłowy:**

- `apps/control-room/src/kernel/api/ControlRoomApi.ts`, linie 2734–2871;
- test bez retry po 404: `ControlRoomApi.test.ts`, linie 2711–2723;
- test propagacji binarnego 404: `ControlRoomApi.test.ts`, linie 3833–3864.

### F-04 — P2: deklarowany retry zasobu nie uruchamia własnego timera po błędzie

`useResource` przechowuje licznik błędów i oblicza backoff, lecz potrzebuje kolejnego renderu, refetchu albo invalidacji, aby rozpocząć następną próbę. Nie istnieje samodzielny timer retry po zakończonym błędzie. Fetch pola nie ma też ogólnego deadline.

**Skutek:** odzyskanie jest zależne od zewnętrznego zdarzenia, a zawieszony request może trwać do zmiany klucza, abortu albo unmountu.

### F-05 — P3: FEM Airbox ukrywa 404 jako pusty, gotowy wynik

`useViewport3DAirboxFieldVectors` przechwytuje każdy `ControlRoomApiError` 404, zwraca `null` dla danego requestu i publikuje mapę pozostałych wyników jako gotową. Nie ma lokalnego bounded retry ani reason code per part.

**Dowód źródłowy:** `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`, linie 866–955.

**Skutek:** użytkownik widzi brak wektorów bez informacji „materializacja w toku”, a network console nadal pokazuje 404.

### F-06 — P3: istniejąca funkcja last-valid nie jest podłączona

`resolveViewport3DDisplayedLiveValue` implementuje semantykę zachowania poprzedniej wartości, ale występuje tylko w definicji i testach. Produkcyjny model używa bezpośrednio `fieldVector.data ?? null` oraz danych nowej kolekcji.

**Skutek:** obecność helpera i zielonych testów nie gwarantuje last-good adoption w działającej scenie.

## 7. Ustalenia renderera i wydajności

### P-01 — P1: przebudowa Airboxa łączy topologię z quantity i gotowością pola

`fdmAirboxBuildKey` zawiera quantity, field revision oraz token `field=ready|pending`. Każda taka zmiana rozpoczyna nowy `useFdmCuboidBuildResult`. `createFdmCuboidBuildStateController.begin()` ustawia `result: null`, zamiast zachować poprzedni zgodny model.

**Dowód źródłowy:**

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, linie 4592–4644;
- `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.ts`, `begin` i `resolveFdmCuboidBuildState`.

**Skutek:** field-only switch powoduje ponowną budowę geometrii nieaktywnych komórek i może wygasić Airbox do zakończenia workera. Jest to sprzeczne z kontraktem viewportu: zmiana pola nie powinna przebudowywać topologii.

### P-02 — P1: worker buduje pełny model przed samplingiem wektorów

`buildViewport3DFdmCuboid` najpierw tworzy `FdmCuboidInstanceModel`, a dopiero potem próbuje ograniczyć segmenty przez `maxVectorGlyphs`. Native-layer alokuje centra, indeksy, regiony i macierze dla `displayCellCount`.

**Dowód źródłowy:**

- `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts`, linie 121–159 i 306–369;
- kopia pola przed transferem: `fdmCuboidBuildScheduler.ts`, linie 296–338.

Minimalny trwały zestaw czterech tablic modelu to około `84 * displayCellCount` bajtów, bez tablic tymczasowych, pola, payloadu transportowego i zasobów Three.js.

### P-03 — P1: fallback workera może przenieść ciężką pracę na main thread

FDM cuboid builder przechodzi na main thread bez analogicznego limitu. Glyph builder dopuszcza main-thread fallback do 4096 segmentów, więc domyślne 1200 glyphów mieści się w tej ścieżce.

**Dowód źródłowy:**

- `fdmCuboidBuildScheduler.ts`, linie 93–115;
- `vectorGlyphBuildScheduler.ts`, linie 67–140.

Brakuje pomiaru częstości fallbacku i long tasks. Nie można obecnie stwierdzić, czy zgłoszona sesja użyła workera.

### P-04 — P2: budżet 1200 jest per target, nie per scena

Każdy widoczny target może otrzymać własny budżet do 1200 glyphów. Nie ma alokatora dzielącego globalny budżet między Airbox, obiekty i regiony.

**Skutek:** jednoczesna wizualizacja kilku targetów może wielokrotnie przekroczyć koszt zakładany dla pojedynczej warstwy.

### P-05 — P2: upload GPU jest porcjowany, lecz pojedynczy batch nie ma twardego deadline

Macierze instancji są składane na main thread w batchach po 256; scheduler ma budżet 3 ms, ale sprawdza go między host callbacks, nie wewnątrz pojedynczego batcha. Dla 1200 glyphów capacity rośnie do 2048, a oba `InstancedMesh` mają wyłączony frustum culling.

**Dowód źródłowy:**

- `VectorFieldLayer.tsx`, linie 52–59, 469–474, 959–1042 i 1279–1291;
- `viewport3dGpuUploadManager.ts`, linie 371–405.

### P-06 — P3: lifecycle cache/workera jest w większości poprawny

Derived glyph cache jest ograniczony do 64 MiB i 12 wpisów oraz zwalniany po ostatnim lease. Runtime workerów zwalnia wszystkie lane'y przy ostatnim unmount. Te własności należy zachować podczas refaktoru.

## 8. Dlaczego obecne testy tego nie wykrywają

Zielone testy potwierdzają lokalne kontrakty, ale nie sekwencję zgłoszoną przez użytkownika.

Brakuje:

1. E2E `POST compute_fields -> Completed -> GET exact URL = 200`, osobno dla FDM single-grid, multilayer i FEM;
2. testu równoległego odczytu podczas atomowej publikacji nośnika;
3. testu `404 -> pending/materialization -> invalidation -> 200`;
4. testu dwóch szybkich patchy targetów i zachowania obu override'ów;
5. testu, że zmiana Airbox quantity nie zeruje buforów pozostałych targetów;
6. testu partial success kolekcji pól;
7. cold-toggle benchmarku na produkcyjnym rozmiarze;
8. pomiaru request bytes, point count, decode, transfer, worker, GPU upload i time-to-first-visible-glyph;
9. bramy wymuszonego worker fallback;
10. browser smoke z zachowaniem innych targetów i nieutraconym WebGL;
11. zakresu budżetu FDM osobno dla `fdm-domain`, Airboxa, regionu i native layer;
12. różnicy `Surface | Full` dla pojedynczej siatki FDM;
13. zgodności wartości pokazanej, żądanej, efektywnie ograniczonej i rzeczywiście zaadoptowanej liczby glyphów.

Istniejący `audit-viewport-3d-memory-churn.mjs` używa małego fixture `24 x 16 x 2`, rozgrzewa wszystkie quantity przed właściwą pętlą i mierzy przede wszystkim lifecycle/cache. Nie jest benchmarkiem pierwszego włączenia Airbox vectors.

## 9. Docelowe rozwiązanie

### 9.1 Protokół backend/API

1. Komenda `compute_fields` musi przechowywać wymagane canonical quantity IDs, scope, carrier generation i oczekiwaną rewizję.
2. `Completed` wolno ustawić dopiero po walidacji, że każdy wymagany zasób jest czytelny przez publiczny endpoint.
3. Nośnik Airboxa publikować generacyjnie i atomowo: immutable katalog generacji plus atomowy pointer manifestu albo jeden samosprawdzalny artefakt.
4. Rozdzielić odpowiedzi:
   - `204` tylko gdy quantity nie ma danych i nie rozpoczęto materializacji;
   - `202` albo problem JSON `state=pending`, `reason_code`, `retry_after_ms`, `command_id` podczas pracy;
   - `404` tylko dla nieistniejącego quantity/scope;
   - `409` dla trwałej niespójności identity/generation/carrier.
5. Dodać expected revision/generation do requestu lub precondition, aby klient odróżniał stary zasób od braku.
6. Dla vectors-only wspierać certyfikowany sampled payload `pointCount <= max_samples`, z explicit node/cell ordinals. Pełne pole pozostawić tylko dla passów, które go naprawdę wymagają.

Każda zmiana JSON musi przejść przez OpenAPI i wygenerowane typy. Endpointy pozostają w `/v2/sessions/current/...`; komponenty React nie mogą składać URL-i ręcznie.

### 9.2 Frontendowy runtime zasobów

1. Kluczować pole pojedynczo przez `(session, target, quantity, scope, scope_id, generation, component, budget)`.
2. Zbiorczą mapę targetów budować jako derived view częściowych stanów, bez `Promise.all` unieważniającego wszystkich.
3. Zachować per target ostatni zgodny bufor do czasu atomowej adopcji następnego. Stan UI może pokazywać `stale/pending`, lecz renderer nie powinien znikać.
4. Wprowadzić jawny bounded retry sterowany reason code i `retry_after_ms`; nie retryować trwałego 404/409.
5. Dodać AbortSignal deadline dla pola oraz telemetrię request ID, target, quantity, scope, bytes i duration.
6. Nie tłumić FEM 404 do pustej mapy. Publikować per-part status oraz błąd materializacji.

### 9.3 Target state

1. Zastąpić pełną tablicę `overrides` operacjami adresowanymi `(scope, scope_id)` albo semantycznym merge'em po identity.
2. Patch budować z aktywnego optimistic state synchronizatora, nie tylko z ostatniego stanu serwera.
3. Backend PATCH powinien przyjmować operację targetową lub CAS po revision; konflikt rewizji ma być jawny.

### 9.4 Renderer i wydajność

1. Oddzielić immutable Airbox topology/instance model od field buffer i vector glyph stream.
2. Quantity switch nie może zmieniać klucza topologii ani przebudowywać macierzy cuboidów.
3. Dla vectors-only worker powinien otrzymać sampled anchors i sampled values, bez budowania pełnego modelu nieaktywnych komórek.
4. Zachować worker scheduling, latest-wins cancellation i bounded derived cache.
5. Po baseline rozważyć przeniesienie składania macierzy glyphów do workera i redukcję kopii transportowych.
6. Wprowadzić jawny globalny allocator budżetu visible vector layers. Obniżenie jakości musi być widocznym trybem, nie ukrytym fallbackiem.

### 9.5 Inspektor i accounting wektorów

1. Zastąpić wejście `fdmCellCount` targetowym deskryptorem capacity, zawierającym `targetId`, `carrierId`, `anchorKind`, `fullCount`, `surfaceCount`, `exact` i revision/generation.
2. Dla single-grid FDM wyznaczać:
   - `fdm-domain`: aktywne komórki aktualnej maski;
   - Airbox: nieaktywne komórki aktualnej maski;
   - region/obiekt: komórki przypisane przez membership;
   - `Surface`: podzbiór wyznaczony tą samą funkcją sąsiedztwa, której używa renderer.
3. Dla native layer używać jego własnego `total_cell_count`, `active_cell_count`, mask identity i grid fingerprint; nie używać globalnego `DomainMeta.grid.shape`.
4. Dla FEM zachować semantykę węzłową i union indeksów. W UI użyć wspólnej etykiety „Available vector anchors” oraz osobno pokazać `cells` albo `nodes`.
5. Pokazywać cztery odrębne wartości: `available candidates`, `requested target budget`, `effective scene allocation` i `adopted arrows`.
6. Nie pozwalać ustawić wartości powyżej efektywnego cap albo jawnie pokazywać clamp/degradation. Obecna kontrolka akceptuje wartości, które nie zmieniają renderingu.
7. Accounting musi być związany z oczekiwanym quantity, scope, generation, topology hash i visualization revision. Poprzednia wewnętrznie spójna migawka nie może być prezentowana jako stan nowego quantity.
8. Pełny skan statystyk debugowych uruchamiać dopiero po jawnej ekspansji sekcji diagnostycznej albo wykonywać poza main thread. Zwykłe otwarcie Inspektora nie powinno skanować całego pola.

## 10. Kolejność wdrożenia

### Etap 0 — obserwowalność i reprodukcja

- dodać trace command/request/generation/carrier;
- dodać benchmark cold i warm;
- utrwalić reprodukcję 404 oraz multi-target disappearing;
- nie zmieniać jeszcze progów wydajności bez baseline.

**Gate:** każda próba ma pełną oś czasu od toggle do pierwszego widocznego glyphu.

### Etap 1 — poprawność readiness backendu

- quantity-aware completion;
- atomowa publikacja carrier generation;
- jednoznaczne status/reason codes;
- E2E dokładnego URL użytkownika.

**Gate:** zero przejściowych 404 i hash mismatch w 100 równoległych odczytach podczas publikacji.

### Etap 2 — izolacja zasobów frontendowych

- per-request resource entries;
- partial derived collection;
- last-good per target;
- bounded retry i deadline.

**Gate:** zmiana Airbox quantity nie zmienia carrier ID, buffer ID ani widoczności żadnego innego targetu.

### Etap 3 — semantyczny target patch

- merge override'ów po identity albo target-specific command;
- optimistic state jako źródło kolejnego patcha;
- testy szybkich, równoległych patchy.

**Gate:** 100 przeplatanych zmian dwóch targetów zachowuje wszystkie override'y i revision order.

### Etap 4 — odseparowanie topologii od wektorów

- niezależne cache i build keys;
- sampled vector carrier;
- vector-only worker path;
- globalny budżet sceny.

**Gate:** quantity switch wykonuje zero topology fetches i zero topology/instance rebuilds.

### Etap 4A — naprawa Inspektora i targetowego capacity

- jeden target-aware capacity adapter współdzielony przez Inspektor, planner requestu i renderer;
- dokładne count/unit/revision dla FDM i FEM;
- jawny effective cap oraz scene allocation;
- przeniesienie diagnostycznego skanu poza domyślną ścieżkę Inspektora.

**Gate:** dla każdego targetu liczba w Inspektorze jest równa liczbie kandydatów użytych przez renderer przed samplingiem, a zmiana `Surface | Full` daje zgodny zakres i zgodny zestaw anchorów.

### Etap 5 — kwalifikacja browser/WebGL

- FDM single-grid, multilayer oraz FEM;
- zimny i rozgrzany cache;
- worker i wymuszony fallback;
- target isolation, 3D↔2D i rapid toggle.

**Gate:** niezerowy drawing buffer, `gl.isContextLost() === false`, bounded resources po unmount i brak anulowanej adopcji.

## 11. Mierzalne bramy produkcyjne

### Poprawność

- po `compute_fields` stan `Completed` oznacza `meta.state=complete` oraz HTTP 200 dla każdego wymaganego quantity/scope;
- zero 404 dla rozpoznanego pola będącego w stanie pending;
- `pointCount <= 1200` dla vectors-only, jeśli efektywny budżet wynosi 1200;
- hash, topology ID, generation i explicit ordinals są spójne;
- błąd jednego targetu nie zmienia danych pozostałych targetów;
- podczas refreshu pozostaje ostatnia poprawna ramka z widocznym statusem stale/pending.

### Wydajność

Dla każdego wariantu wykonać co najmniej 20 zimnych i 20 rozgrzanych prób. Raportować p50/p95, bez ustanawiania arbitralnego progu przed baseline:

- toggle → pierwszy request;
- bytes i pointCount;
- response → decode;
- clone/transfer;
- FDM worker;
- glyph worker;
- GPU upload;
- toggle → pierwszy widoczny glyph;
- long tasks > 50 ms;
- dirty frames oraz draw calls;
- heap, decoded cache i WebGL resources przed/po;
- worker fallback count i reason.

Po zapisaniu wersjonowanego baseline gate regresji powinien blokować pogorszenie p95, bajtów i pamięci o więcej niż uzgodniony budżet, przykładowo 15%, bez jawnej akceptacji.

### Stabilność

- 50 szybkich `vectors on/off` podczas pending workerów;
- 100 zmian quantity przy co najmniej trzech widocznych targetach;
- 100 przejść 3D↔2D;
- brak adopcji anulowanych wyników;
- worker, timer, listener i GPU resource counts wracają do baseline po unmount;
- osobne klatki kwalifikacyjne `wireframe on -> wireframe off -> vectors on`.

## 12. Wykonana weryfikacja

| Polecenie | Wynik |
|---|---|
| `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run ControlRoomApi.test.ts viewport3dResources.test.ts viewport3DFieldDataPlan.test.ts` | **PASS**, 3 pliki, 183 testy |
| `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run useViewport3DSceneModel.test.ts fdmCuboidBuildState.test.ts vectorGlyphBuildScheduler.test.ts vectorGlyphDerivedBufferRuntime.test.ts` | **PASS**, 4 pliki, 151 testów |
| `pnpm --dir apps/control-room audit:idle-performance` | **PASS** |
| `pnpm --dir apps/control-room check:api-hygiene` | **PASS** |
| `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run ObjectVisualizationPanelModel.test.ts VisualizationDebugPanel.dom.test.tsx ObjectVisualizationPanel.route.test.tsx ObjectVisualizationPanel.performance.test.ts ObjectVisualizationPanel.accessibility.test.tsx` | **PASS**, 5 plików, 149 testów; zestaw nie zawiera targetowego FDM Airbox capacity |
| `env TMPDIR=/tmp pnpm --dir apps/control-room audit:viewport-3d-memory-churn` | **BLOCKED przed uruchomieniem browsera**: Next build wykonał `stat` na nieistniejącym `.next-audit-target-smoke-spin-authoring-unblocked-019f` |

Pierwsze uruchomienie Vitest bez `TMPDIR=/tmp` nie rozpoczęło testów z powodu niedostępnej ścieżki Windows Temp. Po wskazaniu `/tmp` wszystkie wybrane testy przeszły. Nie jest to błąd produktu.

Live API na `localhost:8081` ani na adresie sesji przeglądarkowej nie było osiągalne z bieżącego środowiska audytu. Nie wykonano świeżej kwalifikacji runtime ani pomiarów p50/p95. Wnioski P1–P3 są potwierdzone źródłowo; przypisanie konkretnego 404 do hash race versus niegotowego readbacku wymaga trace z działającej sesji.

## 13. Mapa kluczowych źródeł

| Kontrakt | Plik / symbol |
|---|---|
| Kanoniczne `H_demag` | `crates/fullmag-quantities/src/catalog.rs`, definicja quantity, linie 50–69 |
| Vector endpoint | `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`, `get_field_vector` |
| FDM Airbox scope | ten sam plik, `resolve_fdm_field_scope`, linie 2644–2741 |
| Sample limit | ten sam plik, `resolve_field_vector_sample_limit`, linie 3326–3347 |
| Materializacja | `crates/fullmag-cli/src/orchestrator.rs`, `compute_fields` |
| Publikacja carrier | `crates/fullmag-cli/src/live_workspace.rs`, linie 376–438 |
| API on-demand | `apps/control-room/src/kernel/api/ControlRoomApi.ts`, `requestFieldVectorOnDemand` |
| Runtime zasobów | `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts` i `useResource.ts` |
| Kolekcja pól targetów | `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`, `useViewport3DQuantityFieldVectors` |
| Plan Airboxa | `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts` |
| Scene model | `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts` |
| Patch targetu | `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts` |
| Synchronizacja patchy | `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts` |
| FDM build | `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts` |
| FDM build state | `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.ts` |
| Glyph build/upload | `vectorGlyphBuildScheduler.ts`, `VectorFieldLayer.tsx` |
| Zakres Arrow budget | `ObjectVisualizationPanel.tsx`, `fdmCellCount` i `vectorBudgetRanges` |
| Obliczenie capacity | `ObjectVisualizationPanelModel.ts`, `resolveVisualizationVectorBudgetRange` |
| Accounting Inspektora | `VisualizationVectorAccountingRows.tsx`, `resolveVisualizationVectorAccounting` |
| Debug scan pola | `useViewport3DVisualizationDebugPublisher.ts`, `scanFieldVectorDebugStatistics.ts` |
| Performance contract | `docs/specs/frontend-v2/17-performance-memory-profiler.md` |

## 14. Kryterium zamknięcia problemu

Problem można uznać za naprawiony dopiero wtedy, gdy jedna świeża macierz kwalifikacyjna dla FDM single-grid, FDM multilayer i FEM wykaże jednocześnie:

1. brak przejściowych 404 i jednoznaczny lifecycle materializacji;
2. `H_demag` dostępne dla poprawnego Airbox scope;
3. brak znikania innych targetów oraz utraty override'ów;
4. brak topology/instance rebuild przy field-only switch;
5. bounded sampled transport dla vectors-only;
6. cold/warm p50/p95 i brak niedopuszczalnych long tasks;
7. stabilny WebGL, niezerowy drawing buffer i zasoby wracające do baseline;
8. osobne, czytelne wizualne dowody wireframe, points i vectors.

Do tego momentu funkcję należy opisywać jako częściowo zaimplementowaną i testowaną jednostkowo, ale nie produkcyjnie zakwalifikowaną.

## 15. Uzupełnienie: pełny audyt Inspektora wektorów

### 15.1 Potwierdzenie błędu wskazanego przez użytkownika

Przepływ wartości maksymalnej jest następujący:

```text
DomainMeta.grid.shape
  -> fdmGridCellCount() = nx * ny * nz
  -> fdmTarget = true dla każdego targetu w aktywnej lane FDM
  -> resolveVisualizationVectorBudgetRange({ fdmCellCount })
  -> natychmiastowy return max = wszystkie komórki siatki
  -> NumberField "Arrow budget"
  -> etykieta "Available air-only nodes"
```

`apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx` w liniach 160–162 ustawia `fdmTarget` dla każdego niepustego targetu w lane FDM. W liniach 663–706 wylicza jedno `fdmCellCount` z globalnej domeny i przekazuje je zarówno dla `full`, jak i `surface`.

`apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`, `resolveVisualizationVectorBudgetRange`, w liniach 992–1021 zwraca globalny cell count przed jakąkolwiek analizą:

- `target.kind`;
- `geometryScope`;
- `FdmRegionMembershipResource.magnetic_support`;
- binarnej maski membership;
- native-layer identity.

W pokazanej sesji domena ma `128 x 52 x 30 = 199 680` komórek, z czego aktywnych jest 1600. Dla pełnego single-grid Airboxa dokładna liczba kandydatów przed samplingiem powinna więc wynosić `199 680 - 1600 = 198 080`, o ile aktualny descriptor i maska mają tę samą generację. Bieżący Inspektor używa `199 680`.

To nie jest wyłącznie błąd etykiety. Ta sama zła wartość jest używana jako `max` kontrolki i jako `availableNodeCount` w accounting.

### 15.2 Zakres błędu w targetach FDM

| Target | Obecna wartość maksymalna | Właściwe źródło |
|---|---:|---|
| `fdm-domain` | wszystkie komórki globalnej siatki | aktualne komórki aktywne/magnetyczne zgodne z membership |
| publiczny Airbox | wszystkie komórki globalnej siatki | `magnetic_support.inactive_cell_count` lub dokładna liczba `u32::MAX` w FMRM |
| region FDM | wszystkie komórki globalnej siatki | liczba komórek z numeric region ID oraz zgodnym ownerem |
| obiekt FDM | wszystkie komórki globalnej siatki | suma/union jego zrealizowanych komórek |
| FDM native layer | wszystkie komórki globalnego `DomainMeta` | targetowy native grid i jego active mask |
| multilayer Airbox | wszystkie komórki globalnego `DomainMeta` | targetowy Airbox carrier domain |

Backend już udostępnia potrzebne dane. `FdmRegionMembershipResource.magnetic_support` zawiera `active_cell_count` i `inactive_cell_count`, a Inspektor pobiera także binarny FMRM z `regionIds`. Problem jest frontendowym pominięciem istniejącego targetowego nośnika, nie brakiem API dla pełnego zakresu.

### 15.3 `Surface` i `Full` są niespójne dla FDM

Dla FDM oba zakresy suwaka dostają identyczne `nx * ny * nz`, ponieważ early return ignoruje `geometryScope`.

Dodatkowo single-grid Airbox ma błąd wykonawczy: `useFdmCuboidBuildResult` zawsze wpisuje `vectorGeometryScope: "full"`. W rezultacie zmiana Inspektora na `Surface` może ograniczyć surface/points, ale prebuilt `vectorSegments` nadal powstają z pełnego modelu Airboxa. `VectorFieldLayer` otrzymuje gotowe segmenty i nie filtruje ich ponownie przez `geometryScopeInstanceOrdinals`.

W multilayer Airbox `vectorGeometryScope` jest przekazywany do batch workera, więc nie wolno naprawiać problemu jednym globalnym warunkiem bez osobnych testów single-grid i multilayer.

### 15.4 Kontrolka pokazuje budżet żądany, lecz ukrywa budżet efektywny

`Arrow budget` jest targetowym żądaniem. Renderer następnie ogranicza je przez `resolveViewport3DMaxVectorGlyphs` i `clampViewport3DInteractiveVectorBudget`. Inspektor nie pokazuje tej drugiej wartości.

Przykład: jeżeli globalny cap wynosi 1200, kontrolka FDM Airboxa może pozwolić wpisać 50 000 albo 199 680, ale renderer nadal utworzy najwyżej 1200 glyphów dla tej ścieżki. Użytkownik dostaje kontrolkę, której duża część zakresu nie ma żadnego efektu.

Przy wielu targetach sytuacja jest jeszcze mniej czytelna: część ścieżek dzieli budżet, a część clampuje targety niezależnie. Inspektor nie pokazuje przydziału sceny ani degradation reason.

### 15.5 Accounting miesza pojęcia `cells`, `nodes`, `samples` i `arrows`

`VisualizationVectorAccountingRows` pokazuje:

- `Available air-only nodes`;
- `Decoded field samples`;
- `Adopted arrows`.

Dla FEM pierwszy termin jest właściwie liczbą unikalnych węzłów Airboxa. Dla FDM wektory są zakotwiczone w centrach komórek, więc wpisanie globalnego cell count pod etykietą „nodes” jest semantycznie błędne.

Accounting powinien jawnie rozdzielać:

1. **available anchors** — targetowy zbiór komórek lub węzłów;
2. **requested budget** — wartość targetowego ustawienia;
3. **effective allocated budget** — wynik globalnego cap/allocatora;
4. **decoded samples** — liczba próbek transportu, która może być większa od liczby glyphów;
5. **adopted arrows** — liczba faktycznie przyjęta przez render pass.

Obecny resolver zna tylko błędne `availableNodeCount`, topology hash i najnowszą debug snapshot. Nie dostaje oczekiwanego quantity, scope, visualization revision ani efektywnego budżetu. W czasie zmiany quantity może więc chwilowo prezentować poprawną wewnętrznie, ale starą migawkę.

Dla targetów innych niż Airbox komponent przekazuje `snapshots: []`, więc `Decoded field samples` i `Adopted arrows` pozostają stale jako `waiting`, mimo że wiersze są renderowane. To jest osobny defekt jakości Inspektora.

### 15.6 Inspektor może dokładać koszt do pierwszego włączenia

`VisualizationVectorsSection` jest montowany w głównej części overview. Dla Airboxa `AirboxVectorAccountingRows` natychmiast wywołuje `controller.request("airbox")`. Publisher przygotowuje snapshot diagnostyczny i, gdy nie ma gotowych exact range diagnostics, uruchamia `scanFieldVectorDebugStatistics` na całym zdekodowanym `Float64Array`.

Skan jest liniowy względem liczby wartości. Dzieli pracę na fragmenty po 65 536 elementów, lecz domyślne „yield” to `Promise.resolve()`, czyli kolejna mikrokolejka, a nie gwarantowane oddanie klatki przeglądarce. Przy pełnym polu multilayer może to dołożyć pracę main-thread dokładnie podczas materializacji i pierwszej adopcji wektorów.

Accounting jest użyteczny, ale pełny skan statystyczny nie powinien być ukrytym skutkiem zwykłego otwarcia Inspektora. Liczniki `pointCount` i adopted item count są już dostępne bez skanowania wartości.

### 15.7 Brakujące testy Inspektora

Minimalny zestaw regresyjny musi obejmować:

1. FDM `199 680 total / 1600 active` daje Airbox `198 080`, a nie `199 680`;
2. `fdm-domain` używa active count;
3. region i obiekt używają targetowej maski;
4. native layer nie używa globalnej siatki;
5. `Surface` ma dokładny, mniejszy capacity i ten sam zbiór anchorów co renderer;
6. wartość powyżej globalnego cap jest blokowana albo pokazuje jawny effective clamp;
7. `requested`, `allocated`, `decoded` i `adopted` są prezentowane oddzielnie;
8. quantity/revision switch nie pokazuje starego accounting jako bieżącego;
9. non-Airbox target nie pokazuje permanentnego `waiting`;
10. samo otwarcie zwykłego Inspektora nie uruchamia pełnego skanu wartości pola;
11. browser test porównuje tekst Inspektora z faktycznym `adoptedVectorItemCount` oraz liczbą glyphów w scenie.

### 15.8 Pozostałe błędy wspólnego Inspektora Airbox/obiekt/region/part/native-layer

Wszystkie panele wskazane przez użytkownika przechodzą przez wspólny `VisualizationTargetInspectorPanel` albo bezpośrednio przez `ObjectVisualizationPanel`. Oznacza to, że poniższe defekty nie są lokalnym problemem jednego wrappera:

- `airbox/AirboxVisualizationPanel.tsx`;
- `MeshPartVisualizationPanel.tsx`;
- `region/ObjectRegionVisualizationPanel.tsx`;
- native-layer osadzony przez `fdm-grid/FdmGridInspectorPanel.tsx`.

#### Stan zapisu jest zawsze przedstawiany jako nieoczekujący

`useObjectVisualizationPanelState` ustawia `const pending = false`. Panel subskrybuje wprawdzie wersję `VisualizationRegistrySyncController` przez `useVisualizationStateResource`, ale nie mapuje `pendingPatch`, `inflightPatch`, `retrying` ani `rejected` na stan kontrolek. Użytkownik może wykonać następny patch lub reset, gdy poprzednia pełna tablica `overrides` nie została jeszcze potwierdzona. Komponenty mają poprawnie poprowadzony parametr `pending`, ale jego produkcyjna wartość nigdy nie staje się prawdziwa.

#### Reset używa stanu serwera zamiast aktywnego stanu optymistycznego

`resetTarget`, `resetChildRegionTargets` i baseline restore budują nowe `overrides` z `visualizationState.data`, nie z `optimisticData`/aktywnego patcha synchronizatora. Reset wykonany w trakcie oczekującej zmiany może więc przywrócić starszą tablicę, usunąć zmianę innego targetu albo lokalnie wyczyścić target przed rozstrzygnięciem mutacji zdalnej. Jest to ten sam rodzaj utraty aktualizacji co F-02, ujawniony przez UI resetu.

#### FEM sumuje części, zamiast liczyć unię węzłów

Dla targetu FEM z wieloma matching mesh parts `resolveVisualizationVectorBudgetRange` redukuje `meshPartVectorNodeCount` przez sumowanie. W shared-domain te same globalne indeksy węzłów mogą należeć do kilku części, więc suma `part.node_count` albo rozmiarów surface setów może być większa od unii rzeczywistych anchorów. Tylko ścieżka Airboxa wykonuje targetową selekcję/odjęcie i liczy zbiór; zwykły obiekt i część wielonośnikowa nie mają wspólnego union contract.

#### Kontrolka może pokazywać inną wartość niż ustawienie

`VisualizationVectorsSection` wylicza `vectorBudgetValue` przez clamp do bieżącego zakresu i przekazuje go do suwaka, ale nie normalizuje `settings.vectorBudget`. Po zmianie topologii albo targetu UI może pokazywać np. `1200`, gdy zapisany override nadal wynosi `50000`. Następnie `geometryScopeVectorBudgetPatch` liczy coverage z surowego `settings.vectorBudget`, nie z jednoznacznie uzgodnionej wartości. To tworzy trzy różne liczby: zapisaną, wyświetloną i wyrenderowaną.

#### `Lift above surface` jest wystawione dla FDM, lecz ścieżka FDM go nie konsumuje

`vectorSurfaceOffsetEnabled` i `vectorSurfaceOffsetScale` są przechowywane w viewport preferences i widoczne w każdym targetcie wspierającym vectors. FEM przekazuje je przez `useViewport3DFieldRenderOptions` do `viewport3dRenderModel`, gdzie wyliczany jest offset względem normalnych powierzchni. Ścieżki FDM w `useViewport3DSceneModel` i `FdmCuboidLayer` przekazują do builderów scale, budget, anchor mode i geometry scope, ale nie przekazują surface-offset ani normalnych wymaganych do jego zastosowania. Dla FDM kontrolka jest obecnie no-op.

#### Fallback `4096` jest interaktywną zgadywanką, a nie stanem fail-closed

Gdy dokładny target capacity nie jest dostępny, `fallbackVisualizationVectorBudgetRange` zwraca `availableNodeCount=max=4096`, `exact=false`. Suwak pozostaje aktywny, a tylko wiersz tekstowy dodaje `est.` albo dla Airboxa pokazuje `waiting`. Liczba 4096 nie pochodzi z targetu, transportu ani globalnego cap renderera. Nie powinna być traktowana jako dozwolone maksimum ustawienia.

#### Quantity i status `Live` nie są związane z targetowym carrierem

Dla targetów FDM katalog jest ładowany bezwarunkowo, ale `visualizationQuantityItems` filtruje głównie po ogólnej zdolności spatial/full-domain. Dla FEM obiektu/regionu katalog nie jest ładowany początkowo (`requested=false`), a dropdown może użyć statycznej listy wszystkich quantities. Żadna z tych ścieżek nie dowodzi, że bieżący target ma carrier/sample endpoint dla danej quantity i generacji. Dodatkowo `dataState` przyjmuje `Live`, gdy sam `fieldCatalog.status === "ready"`; nie sprawdza targetowego payloadu, field revision ani adopcji renderera. Inspektor może więc równocześnie pokazać `Live` i brak pola/wektorów.

#### FDM i FEM mają różną trwałość tych samych kontrolek

Gałąź `fdmTarget` zapisuje `persistentVisualizationTargetPatch` wyłącznie do klientowego `ObjectVisualizationController`; nie wywołuje `visualizationSync.queuePatch`. Dla FEM odpowiednik trafia do wersjonowanego `/v2/sessions/current/visualization/state`. W efekcie quantity, budget, opacity, render mode i kolory o tych samych nazwach mają inną trwałość po reloadzie zależnie od backendu. Notatka `ViewportPreferenceScopeNote` opisuje tylko jawne preferencje viewportowe, nie wyjaśnia, że cała pozostała konfiguracja FDM również jest lokalna.

#### Dwa poboczne edytory omijają kanoniczną ścieżkę synchronizacji

`fdm-grid/FdmGridInspectorPanel.tsx` wystawia osobny `FdmUniverseDisplayControls` dla tego samego targetu `FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET`. Kontrolki `Visible`, `Bounds`, `Grid wireframe` i opacity wywołują bezpośrednio `visualization.patchTarget`; nie korzystają z `VisualizationTargetInspectorPanel`, targetowego pending, optimistic rebase ani zdalnego sync. Ten sam Airbox ma więc dwa edytory o różnym zakresie i lifecycle.

`ObjectGeneralPanel.tsx` podobnie pozwala zmieniać `shaderMonoColor` i `wireframeColor` obiektu przez bezpośredni lokalny `patchTarget`, podczas gdy panel `Object visualization` dla FEM przechodzi przez `visualizationSync`. Kolor ustawiony w jednym panelu może mieć inną trwałość, status override i reset niż ten sam kolor ustawiony w drugim.

Panele `FdmAirboxMeshFactsPanel` i `FdmMultilayerAirboxTargetPanel` są diagnostyczne, nie edycyjne. Pierwszy poprawnie pokazuje `inactive_cell_count` jako komórki Airboxa, a drugi targetowy grid/carrier multilayer. To dodatkowo potwierdza, że poprawne dane liczbowe już istnieją, tylko edytor wizualizacji ich nie konsumuje.

### 15.9 Klasyfikacja

| ID | Priorytet | Ustalenie |
|---|---|---|
| I-01 | **P1** | Wszystkie targety FDM używają globalnego grid cell count jako maksymalnego budżetu. |
| I-02 | **P1** | Single-grid Airbox ignoruje `Surface` przy budowie vector segments. |
| I-03 | **P1** | Zwykły Inspektor Airboxa może uruchomić pełny skan pola na main thread. |
| I-04 | **P2** | Kontrolka nie pokazuje globalnego cap ani efektywnej alokacji. |
| I-05 | **P2** | Etykieta `air-only nodes` opisuje komórki FDM i może zawierać komórki magnetyczne. |
| I-06 | **P2** | Accounting nie jest związany z bieżącym quantity/revision/budget. |
| I-07 | **P2** | Non-Airbox accounting stale pokazuje `waiting`. |
| I-08 | **P1** | `pending=false` pozwala nakładać patch/reset podczas oczekującej mutacji. |
| I-09 | **P1** | Reset i restore bazują na nieoptymistycznym `visualizationState.data`. |
| I-10 | **P2** | FEM obiekt wieloczęściowy sumuje współdzielone węzły zamiast liczyć unię. |
| I-11 | **P2** | Suwak może pokazywać wartość inną niż zapisana i użyta do przeliczenia scope. |
| I-12 | **P2** | `Lift above surface` jest no-op dla FDM mimo aktywnej kontrolki. |
| I-13 | **P2** | Nieznane capacity jest zastępowane aktywnym, arbitralnym maksimum 4096. |
| I-14 | **P1** | Quantity availability i `Live` nie dowodzą istnienia targetowego carriera/payloadu. |
| I-15 | **P2** | Te same ustawienia FDM i FEM mają niejawnie różną trwałość. |
| I-16 | **P2** | `FdmUniverseDisplayControls` jest drugim, częściowym edytorem Airboxa omijającym sync. |
| I-17 | **P2** | `ObjectGeneralPanel` edytuje te same kolory inną, lokalną ścieżką. |

Wniosek: błąd Inspektora jest potwierdzony i szerszy niż sam Airbox. Naprawa powinna wprowadzić jeden target-aware capacity/adoption contract współdzielony przez Inspektor, request planner i renderer, zamiast kolejnego lokalnego wyjątku dla `airbox`.

## 16. Instrukcja naprawy każdego ustalenia

Poniższe kroki są planem wykonawczym. Każdy punkt kończy się własnym testem i bramą; nie należy scalać etapów tylko po to, by szybciej uzyskać zielony test jednostkowy.

### B-01 — quantity/carrier-aware completion `compute_fields`

**Kontrakt docelowy:** completion przechowuje dokładny zestaw `(quantity_id, component, scope_kind, scope_id, domain_generation_id, carrier_id)` i kończy się dopiero po publicznym odczycie każdej pozycji.

**Zmiany:**

1. W `crates/fullmag-cli/src/orchestrator.rs` zastąpić szeroki warunek „jakikolwiek readback” strukturą oczekiwanych rezultatów utworzoną z wejścia `compute_fields`.
2. W `crates/fullmag-api/src/session.rs` rozszerzyć stan completion o listę oczekiwanych i potwierdzonych zasobów; potwierdzenie musi zawierać revision/generation, nie tylko quantity ID.
3. Użyć tego samego resolvera carriera, którego używa handler `data/fields.rs`, aby completion nie implementowało drugiej, luźniejszej definicji gotowości.
4. Dodać test komendy, w którym `m` jest czytelne, `H_demag/airbox` jeszcze nie, i sprawdzić, że status pozostaje pending.
5. Dodać E2E exact URL dla single-grid FDM, multilayer FDM i FEM.

**Gate:** `Completed` implikuje natychmiastowe HTTP 200 i zgodną generation dla każdego żądanego pola; samo `m` nie może domknąć żądania `H_demag`.

### B-02 — atomowa publikacja nośnika Airboxa

**Kontrakt docelowy:** czytelnik widzi w całości generację N albo N+1; nigdy manifest z jednej i payload z drugiej.

**Zmiany:**

1. W `crates/fullmag-cli/src/live_workspace.rs` zapisywać payload i manifest pod immutable identyfikatorem generacji.
2. Po zapisaniu, flushu i walidacji obu artefaktów atomowo podmienić mały wskaźnik `current generation`.
3. W handlerze API najpierw odczytać wskaźnik, potem oba artefakty tej samej generacji; po zmianie wskaźnika w trakcie odczytu ponowić próbę w ograniczonej pętli.
4. Zachować hash payloadu w manifeście i walidować go przed publikacją pointera, nie dopiero po ekspozycji generacji.
5. Dodać test współbieżny: jeden writer publikuje kolejne generacje, 100 czytelników odpytuje pole; dopuszczalne są tylko kompletne N/N+1.

**Gate:** zero przejściowych hash mismatch i zero 404 podczas kontrolowanej publikacji.

### B-03 — jednoznaczna maszyna stanów HTTP

**Kontrakt docelowy:** `204=not materialized/not requested`, `202=pending`, `404=unknown quantity/scope`, `409=trwała niespójność`, `200=kompletny payload`.

**Zmiany:**

1. W `crates/fullmag-api/src/router_v2/handlers/data/fields.rs` zamienić szerokie mapowanie błędów na wewnętrzny enum reason codes.
2. Dla pending zwracać `202` z małym JSON/problem payloadem zawierającym `reason_code`, `retry_after_ms`, `command_id`, oczekiwaną generation i resource key.
3. Uzupełnić OpenAPI route responses i schematy; następnie odtworzyć generowane typy frontendowe zgodnie z repozytoryjnym workflow.
4. W testach routera pokryć osobno unknown quantity, not materialized, pending readback, generation mismatch i corrupt carrier.

**Gate:** klient może wybrać retry wyłącznie na podstawie statusu i reason code, bez parsowania tekstu błędu.

### B-04 — sampled transport dla vectors-only

**Kontrakt docelowy:** request z `max_samples=K` zwraca najwyżej K jawnie zidentyfikowanych anchorów i wartości, także dla native grid oraz multilayer Airbox.

**Zmiany:**

1. W `resolve_field_vector_sample_limit` usunąć wyjątek ignorujący limit native-grid i zdefiniować deterministyczny sampling zachowujący explicit cell ordinals.
2. Rozszerzyć binarny format/metadata o ordinals, sampling method, unsampled candidate count i generation.
3. W `viewport3DFdmMultilayerAirbox.ts` wysyłać efektywny transport budget, a dekoderowi pozwolić na `pointCount <= candidateCount`; przestać wymagać `pointCount === totalCells` dla vectors-only.
4. Surface sampling wykonywać po target/surface selection, nie na całej domenie przed filtrem.
5. Zmienić test API utrwalający ignorowanie `max_samples=1` na asercję jednego punktu i poprawnego ordinalu.

**Gate:** `pointCount <= effective transport budget`, a wyrenderowane strzałki odnoszą się do poprawnych komórek targetu.

### B-05 — realtime jako invalidacja, nie mechanizm gotowości

**Zmiany:** zachować WS jako sygnał invalidacji, lecz nie uzależniać retry od jego nadejścia. Po `202` klient ma timer z `retry_after_ms`; event może tylko przyspieszyć ponowny GET. Dodać test z opóźnionym o 2 s eventem i wcześniejszym powodzeniem HTTP.

**Gate:** pole staje się widoczne bez eventu WS, a opóźniony event nie uruchamia duplikatu adopcji.

### F-01 — zasoby per target zamiast atomowego `Promise.all`

**Zmiany:**

1. W `viewport3dResources.ts` stworzyć osobny resource key dla pojedynczego requestu pola: target, quantity, component, scope, scope ID, generation i budget.
2. Zbiorczą mapę zwracać jako derived snapshot z wpisów indywidualnych; błąd/pending jednego wpisu nie może usuwać `data` pozostałych.
3. W `useViewport3DSceneModel.ts` pobierać targetowe `lastCompatibleData` oraz targetowy status, a nie zerować całą mapę.
4. Dodać test trzech targetów: zmienić quantity tylko Airboxa, utrzymać identyczne buffer IDs dwóch pozostałych.

**Gate:** zmiana jednego request key nie powoduje unmountu ani `null` w warstwach innych targetów.

### F-02 — semantyczne patche targetów

**Zmiany:**

1. W `VisualizationRegistrySyncController` dodać operację merge override po canonical target identity; nie scalać tablic przez zastąpienie.
2. `airboxVisualizationStatePatchFromTargetPatch`, `queueTargetVectorVisibilityPatch`, reset i child-region patch mają przyjmować aktywny optimistic state albo target operation, nigdy surową historyczną tablicę.
3. Docelowo wystawić w API target-specific PATCH z CAS revision. Do czasu migracji frontend ma rebase'ować target operation na najnowszym optimistic snapshot przed wysyłką.
4. Testować przeplot A1, Airbox1, A2, reset Airboxa przed odpowiedzią serwera.

**Gate:** 100 przeplatanych operacji nie traci żadnego niezależnego override'u.

### F-03 — on-demand materialization również dla stanu pending

**Zmiany:** `ControlRoomApi` ma zwracać typowany wynik `ready | not-materialized | pending | unavailable | conflict`; wrapper uruchamia `compute_fields` tylko dla `not-materialized`, a dla `pending` wykonuje bounded retry. Trwałego 404/409 nie wolno retryować. Testy mają potwierdzić 204→command→200, 202→retry→200 oraz 404 bez retry.

**Gate:** konsola nie dostaje dwóch niekontrolowanych 404, a liczba prób jest ograniczona i raportowana.

### F-04 — rzeczywisty timer retry i deadline

**Zmiany:** w `useResource`/resource runtime zaplanować timer po błędzie retryable niezależny od React renderu; timer ma być anulowany przy zmianie key, unmount i sukcesie. Każdy field GET otrzymuje AbortSignal deadline. Zapisać attempts, nextRetryAt i terminal reason w snapshotcie.

**Gate:** test fake timers przechodzi bez wymuszonego rerenderu; unmount pozostawia zero timerów i zero requestów.

### F-05 — per-carrier status FEM Airbox

**Zmiany:** `useViewport3DAirboxFieldVectors` nie może mapować każdego 404 na `null`. Zwracana mapa powinna zawierać dla każdego part ID `status`, `data`, `lastValidData`, `reasonCode` i revision. Renderer zachowuje zgodny last-valid buffer, a Inspektor pokazuje dokładnie brakujący carrier.

**Gate:** awaria jednego FEM Airbox part nie usuwa wektorów pozostałych i nie jest raportowana jako `ready`.

### F-06 — produkcyjne podłączenie last-valid

**Zmiany:** użyć `resolveViewport3DDisplayedLiveValue` w targetowym adapterze zasobu, z warunkiem zgodności quantity, scope, topology i generation. Stan stale musi być jawny; nie wolno zachować bufora po zmianie niezgodnej topologii.

**Gate:** refresh tego samego pola zachowuje klatkę, ale zmiana generation/topology fail-closed odrzuca stary bufor.

### P-01 — rozdzielenie topology key od field/glyph key

**Zmiany:**

1. Klucz `fdmAirboxBuildKey` geometrii ma zawierać tylko domain generation, membership/topology, cell selection i geometry style.
2. Quantity, field revision, vector budget, vector scale oraz ready/pending przenieść do osobnego vector build key.
3. `fdmCuboidBuildState.begin()` ma zachować poprzedni zgodny model podczas vector refreshu; nowy topology key może wyczyścić model dopiero po jawnej niezgodności.
4. Test spy ma wykazać zero wywołań topology buildera podczas 100 zmian quantity.

**Gate:** field switch zmienia tylko vector buffer/build reference.

### P-02 — sampling przed pełnym modelem vectors-only

**Zmiany:** wyodrębnić ścieżkę vector-only przyjmującą sampled ordinals, centers i values. Nie tworzyć `FdmCuboidInstanceModel` dla Airboxa, jeśli jedynym aktywnym passem są vectors. Pełny model zachować dla points/wireframe. Profilować alokacje obu ścieżek osobno.

**Gate:** koszt pamięci vectors-only jest O(K), nie O(N), gdzie K to efektywny budżet, a N liczba komórek Airboxa.

### P-03 — fail-closed worker fallback

**Zmiany:** scheduler powinien raportować `worker | main-thread-fallback` i reason. Main-thread fallback musi mieć jawny limit pracy oraz porcjowanie przez scheduler oddający realną klatkę (`requestAnimationFrame`/scheduler host callback), nie nieograniczone synchroniczne O(N). W trybie produkcyjnym przekroczenie limitu powinno pokazać degradation reason zamiast zamrozić UI.

**Gate:** wymuszony brak Workera nie tworzy long task >50 ms w uzgodnionym fixture i jest widoczny w diagnostyce.

### P-04 — jeden allocator budżetu sceny

**Zmiany:** dodać planner przydzielający globalny `maxInteractiveVectorGlyphs` widocznym targetom deterministycznie. Wejściem są requested budget, available anchors, visibility i priorytet targetu; wyjściem targetowe allocations, których suma nie przekracza cap. Inspector konsumuje dokładnie ten wynik.

**Gate:** suma adopted arrows wszystkich warstw nie przekracza globalnego cap, a zmiana jednego targetu nie powoduje niejawnego przekroczenia.

### P-05 — ograniczony upload GPU

**Zmiany:** mierzyć czas wewnątrz batcha 256, adaptacyjnie zmniejszać batch przy przekroczeniu budżetu i zachować latest-wins cancellation między porcjami. Frustum culling włączać dopiero po poprawnym bounding volume dla instanced glyphs. Test schedulerowy ma używać sztucznie wolnej aktualizacji pojedynczej instancji.

**Gate:** pojedynczy callback uploadu respektuje budżet, a anulowany build nie publikuje częściowej adopcji.

### P-06 — własności, których nie wolno utracić

W każdym refaktorze zachować limit 64 MiB/12 wpisów derived cache, lease-based release, worker teardown po ostatnim unmount, AbortSignal i latest-wins. Istniejące testy lifecycle pozostają obowiązkowe; jest to brama zachowania, nie zadanie usunięcia kodu.

### I-01 — jeden target-aware capacity contract

**Kontrakt do wprowadzenia:**

```ts
interface VisualizationVectorCapacity {
  targetKey: string;
  carrierId: string;
  anchorKind: "cell" | "node";
  geometryScope: "full" | "surface";
  availableAnchorCount: number | null;
  exact: boolean;
  topologyIdentity: string;
  generationId: string | null;
}
```

**Zmiany:** resolver w `ObjectVisualizationPanelModel.ts` nie może przyjmować samego `fdmCellCount`. Ma przyjmować target, membership descriptor/binary oraz native/multilayer carrier descriptor. Dla single-grid: magnetic domain=`active_cell_count`, Airbox=`inactive_cell_count`, region=liczba matching numeric ID, obiekt=unia jego numeric IDs. Dla native layer liczyć maskę tego layera, dla multilayer Airbox użyć jego carrier domain.

**Test:** tabela targetów na wspólnej siatce `199680/1600/198080`, dwa regiony i native layer o innym shape.

**Gate:** wartość Inspektora równa liczbie kandydatów przekazanych do sampling buildera.

### I-02 — wspólny algorytm `Surface`

**Zmiany:** wyodrębnić czystą funkcję target cell selection + neighbor adjacency używaną zarówno przez capacity, jak i builder. Dla single-grid przekazać `vectorGeometryScope` do `useFdmCuboidBuildResult` zamiast hardcoded `"full"` i uwzględnić scope w request/build key. Testować zewnętrzną granicę oraz wewnętrzną granicę Airbox–magnetic support. Multilayer zachować jako osobny przypadek regresyjny.

**Gate:** hash/ordinals zbioru `Surface` w Inspektorze i rendererze są identyczne; `Surface` jest właściwym podzbiorem `Full` dla fixture z wnętrzem.

### I-03 — usunięcie pełnego skanu z domyślnego Inspektora

**Zmiany:** `VisualizationVectorAccountingRows` ma pobierać point/adoption counts z metadanych bez żądania statystyk. `controller.request("airbox")` przenieść do jawnie rozwijanej sekcji Debug. Jeżeli min/max/mean są potrzebne, wykonać skan w workerze albo przez scheduler oddający klatki.

**Gate:** otwarcie standardowego panelu nie wywołuje `scanFieldVectorDebugStatistics`; profiler nie pokazuje dodatkowego O(N).

### I-04 — requested kontra effective allocation

**Zmiany:** pod suwakiem pokazać `Requested budget` i `Effective scene allocation`. Maksimum suwaka powinno być `min(availableAnchorCount, policyMax)` albo kontrolka ma jawnie oznaczyć clamp. Renderer i Inspector muszą konsumować jeden snapshot allocatora z P-04.

**Gate:** każda zmiana suwaka ma widoczny efekt do maksimum; powyżej niego nie istnieje martwy zakres.

### I-05 — poprawne nazwy i jednostki

**Zmiany:** zastąpić `Available air-only nodes` przez `Available vector anchors`; dodać osobny unit/badge `cells` dla FDM i `nodes` dla FEM. Nie formatować komórek jako węzłów w typie ani nazwie pola (`availableAnchorCount`).

**Gate:** test DOM dla FDM Airboxa zawiera `cells`, FEM Airboxa `nodes`.

### I-06 — revision-bound accounting

**Zmiany:** `resolveVisualizationVectorAccounting` musi przyjmować oczekiwane quantity ID, component, scope, target key, topology identity, generation, visualization revision i vector build key. Snapshot niespełniający któregokolwiek warunku jest `stale`, nie bieżący. Nie sumować nośników bez deduplikacji anchor ordinals.

**Gate:** po quantity switch stara migawka nigdy nie jest pokazana jako aktualne decoded/adopted.

### I-07 — accounting dla targetów innych niż Airbox

**Zmiany:** usunąć produkcyjne `snapshots: []`. Publisher ma publikować target-keyed liczniki dla obiektu, regionu, part i native layer, albo wiersze accounting należy ukryć do czasu wdrożenia tej obsługi. Preferowana jest wspólna targetowa telemetria z I-06.

**Gate:** widoczny target nie pozostaje permanentnie `waiting`; stan jest liczbowy, pending, stale albo unavailable z reason.

### I-08 — prawdziwy stan mutacji w kontrolkach

**Zmiany:** wyprowadzić z `VisualizationRegistrySyncController.getSnapshot()` targetowy stan `queued | inflight | retrying | rejected | acknowledged`. Zastąpić `const pending=false`; blokować tylko konfliktujące mutacje tego samego targetu, nie cały panel. Pokazać błąd i przycisk retry dla rejected.

**Gate:** test DOM z nierozstrzygniętym Promise pokazuje pending i nie wysyła drugiego konfliktującego patcha.

### I-09 — reset/revert na optimistic state

**Zmiany:** reset ma być targetową operacją synchronizatora, rebase'owaną na aktywnym optimistic snapshot. Lokalny `clearTarget` wykonać jako część tej samej transakcji optymistycznej; przy rejection przywrócić poprzedni target snapshot. Baseline restore musi zachować niezależne późniejsze zmiany innych targetów.

**Gate:** reset Airboxa podczas oczekującej zmiany obiektu nie usuwa zmiany obiektu; rejection resetu odtwarza UI.

### I-10 — unia węzłów FEM

**Zmiany:** dla matching parts budować `Set<number>` z `node_indices` albo `surface_node_indices` i liczyć unię. Jeżeli manifest nie publikuje explicit indices, wynik ma być `exact=false` i kontrolka fail-closed; nie przedstawiać sumy `node_count` jako dokładnej. Membership `node_indices` również znormalizować do unii.

**Gate:** dwie części współdzielące 10 ze 100 węzłów dają 190, nie 200; analogiczny test dla surface.

### I-11 — jedna zapisana i wyświetlana wartość budgetu

**Zmiany:** nie clampować tylko wartości propsa suwaka. Po zmianie capacity policzyć jawne `requested`, `normalizedRequested` i `effective`; zapisać normalizację targetową albo zachować raw requested, ale wyświetlić wszystkie trzy bez udawania, że raw się zmienił. `geometryScopeVectorBudgetPatch` ma używać uzgodnionego requested/effective contract, nie ukrytej wartości UI.

**Gate:** odczyt kontrolki, snapshot controller i request planner zgadzają się co do znaczenia każdej wartości.

### I-12 — surface offset dla FDM albo usunięta możliwość

**Zmiany:** preferowana naprawa to przekazanie offset settings do FDM vector buildera i wyliczenie normalnych dla surface anchors. Dla `geometryScope=full` kontrolkę wyłączyć z opisem, bo wewnętrzny anchor nie ma jednoznacznej normalnej powierzchni. Jeżeli implementacja normalnych nie wchodzi do zakresu, capabilities FDM muszą jawnie ukryć tę kontrolkę; nie wolno pozostawić no-op.

**Gate:** test segment positions wykazuje dokładny offset dla surface, a full scope nie oferuje kontrolki.

### I-13 — brak arbitralnego fallback maximum

**Zmiany:** `VisualizationVectorBudgetRange` powinien dopuszczać `max:null`. Przy nieznanym capacity suwak jest disabled/pending, zachowuje poprzedni requested budget, ale nie nadaje liczbie 4096 semantyki targetowego maksimum. Po nadejściu zgodnego descriptoru kontrolka aktywuje dokładny zakres.

**Gate:** brak membership/manifest nie pozwala edytować fałszywego zakresu i pokazuje konkretny brakujący zasób.

### I-14 — targetowa availability quantity i prawdziwy `Data State`

**Zmiany:**

1. Katalog availability musi publikować per target/scope: `supported`, `materialized`, `pending`, `carrier_id`, generation i reason code.
2. `VisualizationQuantitySection` ma renderować opcje na podstawie tego kontraktu; statyczna lista może być wyłącznie opisem capability, nie dowodem dostępności.
3. `dataState=Live` wyliczać z bieżącego targetowego payloadu oraz zgodnej adopcji/revision; rozdzielić `Supported`, `Materializing`, `Ready`, `Stale`, `Adopted`, `Unavailable`.
4. Dla obiektu i regionu ładować availability przed otwarciem dropdownu albo przy pierwszym focus, nie dopiero po zmianie wartości.

**Gate:** `H_demag` nie jest oznaczone jako unavailable, jeśli trwa materializacja, i nie jest oznaczone jako ready bez targetowego carriera. `Live` wymaga zgodnej adopcji.

### I-15 — spójna trwałość FDM/FEM

**Zmiany:** podzielić pola jawnie na `session visualization state` i `device-local viewport preferences`. Quantity, render mode, visibility, colors i requested budget powinny przechodzić tym samym wersjonowanym kontraktem dla FDM i FEM. Tylko rzeczy rzeczywiście lokalne, np. centering/surface offset jeśli tak stanowi specyfikacja, pozostają w viewport preferences i są tak oznaczone przy konkretnej kontrolce.

**Gate:** reload tej samej sesji odtwarza identyczne ustawienia Airboxa/obiektu dla FDM i FEM; drugi klient widzi pola session-scoped, ale nie device-local.

### I-16 — usunięcie drugiego edytora Airboxa w FDM grid inspector

**Zmiany:** `FdmGridInspectorPanel` powinien osadzić wspólny `VisualizationTargetInspectorPanel` dla scope `universe-outside-support` albo użyć tej samej targetowej command facade co panel główny. Nie utrzymywać osobnego komponentu zapisującego podzbiór ustawień bez pending/sync. Jeżeli widok siatki ma pozostać skrótem, jego przyciski muszą konsumować dokładnie ten sam snapshot, capabilities, mutation state i `patchTargetOperation`; należy dodać link/etykietę, że edytowany jest canonical Airbox target.

**Test:** wyrenderować oba wejścia nad jednym kontrolerem; zmiana wireframe w grid inspector ma być natychmiast widoczna w Airbox visualization, przejść przez tę samą mutację i zachować się identycznie po rejection/reload.

**Gate:** istnieje jedna ścieżka zapisu Airboxa i jeden status mutacji niezależnie od miejsca otwarcia kontrolki.

### I-17 — jedna command facade dla kolorów obiektu

**Zmiany:** `ObjectGeneralPanel` nie powinien wywoływać `visualization.patchTarget` bezpośrednio dla `shaderMonoColor`/`wireframeColor`. Przenieść te akcje do wspólnej targetowej command facade używanej przez `ObjectVisualizationPanel`; command facade rozstrzyga session-scoped kontra device-local, optimistic update, CAS/retry i rollback. Alternatywnie usunąć duplikaty z panelu General i pozostawić link do dedykowanego panelu Visualization.

**Test:** ustawić kolor z panelu General, sprawdzić ten sam override/revision w Visualization, zasymulować rejection i sprawdzić rollback w obu miejscach; powtórzyć dla FDM oraz FEM.

**Gate:** ten sam field nie ma dwóch mechanizmów trwałości ani dwóch niezależnych resetów.

## 17. Minimalna kolejność implementacji pełnej naprawy Inspektora

1. Najpierw testy reprodukujące I-01, I-02, I-08, I-09, I-10, I-11, I-12, I-14, I-16 i I-17.
2. Następnie wspólny target-aware capacity contract I-01/I-02/I-05/I-10/I-13.
3. Potem semantyczny state/patch/reset F-02/I-08/I-09/I-15.
4. Następnie targetowa availability i accounting I-04/I-06/I-07/I-14.
5. Dopiero po poprawności usunąć koszt I-03 i wdrożyć transport/renderer B-04/P-01/P-02/P-04/P-05.
6. Na końcu wykonać browser/WebGL qualification dla Airbox, object, region, part i native layer w FDM single-grid, FDM multilayer i FEM.

Każdy etap ma być scalany tylko po przejściu własnej bramy. Zielone testy modeli bez browser smoke nie kwalifikują zmiany viewportu jako zakończonej.
