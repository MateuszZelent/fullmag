# Spójna materializacja obserwabli FEM/FDM i wizualizacja Airbox — projekt

## Cel

Fullmag ma udostępniać pola i gęstości energii przez jeden backend-neutralny
kontrakt obserwacji, niezależnie od tego, czy aktywną realizacją jest FEM czy
FDM oraz CPU czy GPU. Dla pojedynczej siatki FDM CUDA oznacza to jednoczesne
domknięcie następujących braków:

- niezerowe, pełnodomenowe `H_demag` na zakresie Airbox;
- przestrzenne `eden_ex`, `eden_demag`, `eden_ext`, `eden_ani`, `eden_dmi`
  oraz `eden_total` dla aktywnych interakcji;
- obsługę CUDA FP64 i FP32 bez ukrytego fallbacku do CPU;
- jednoznaczne rozróżnienie capability, stanu materializacji i gotowego pola;
- automatyczną publikację pól terminalnych oraz poprawne `compute_fields`;
- frontend, w którym Wireframe i Points nie zależą od pola, a Vectors
  korzysta wyłącznie ze zgodnego domenowo nośnika numerycznego.

Wdrożenie jest jednym sekwencyjnym rolloutem. Kolejne etapy mają niezależne
bramy testowe, ale funkcja jest gotowa dopiero po przejściu całego łańcucha:
fizyka, backend, runner, API, frontend i kwalifikacja przeglądarkowa.

## Stan obecny i przyczyna problemu

Merge `codex/airbox-visualization-debug` jest obecny w `master`. Naprawił
przypisanie ustawień renderera Airbox oraz pełnorozmiarowy request jawnego
`compute_fields`, lecz nie zmienił semantyki bufora demagnetyzacji CUDA ani
zakresu obserwabli CUDA.

Aktualna realizacja FDM CUDA używa jednego `h_demag` zarówno jako pola
solverowego, jak i źródła podglądu. Kernel rozpakowania FFT zeruje wszystkie
komórki nieaktywne. API prawidłowo klasyfikuje te komórki jako Airbox, więc
otrzymuje kompletny, lecz całkowicie zerowy payload.

Lista aktywnych obserwabli `CudaFdm` nie zawiera żadnego `eden_*`. Ogólny
katalog materializacji zostaje zatem odfiltrowany przed wejściem do natywnego
backendu. Globalne energie pozostają dostępne w `data/scalars`, ale nie są
zamiennikiem przestrzennych gęstości energii.

`data/fields` opisuje wyłącznie już zmaterializowane pola. Control Room używa
go obecnie również jako katalogu wyboru i błędnie interpretuje brak cache jako
brak capability. Jednocześnie klient ma ścieżkę materializacji na żądanie,
której nie można osiągnąć z wyłączonej pozycji selektora.

## Zasada architektoniczna

Spójność z FEM dotyczy kontraktu, cyklu życia i proweniencji, nie współdzielenia
buforów solverowych ani kodu numerycznego.

FEM już rozdziela pole używane przez solver od pełnodomenowego pola
obserwacyjnego, przygotowuje snapshot na osobnym stagingu, synchronizuje
compute stream z I/O streamem i publikuje stan materializacji. FDM ma
implementować ten sam model odpowiedzialności przez własną realizację CUDA.

Nie wolno:

- używać pola maskowanego jako pełnodomenowego nośnika obserwacji;
- obliczać `H_demag` lub `eden_*` w React/Three.js;
- wykonywać niewidocznego przejścia GPU -> CPU;
- traktować `data/fields` jako katalog capability;
- uznawać HTTP 200 z zerowym Airbox za dowód poprawnej demagnetyzacji;
- budować osobnych ścieżek UI dla FEM i FDM.

## Projekt subsystemu obserwacji

### 1. Backend-neutralny kontrakt snapshotu

Runner otrzymuje jeden kontrakt żądania i wyniku obserwacji. Kontrakt zawiera:

- kanoniczny `quantity_id`;
- kształt `scalar_field` albo `vector_field` i liczbę komponentów;
- fizyczną lokalizację oraz domenę `magnetic_only` albo `full_domain`;
- siatkę/topologię i generation identity;
- źródłowy krok, rewizję, czas i precyzję;
- stan asynchroniczny `pending`, `complete` albo `error`;
- liczbę bajtów, czas materializacji i proweniencję urządzenia;
- jednoznaczny powód odrzucenia dla niewspieranej ilości lub zakresu.

Backend-specific producer rozpoczyna snapshot i zwraca uchwyt oczekujący.
Wspólny koordynator runnera odbiera gotowy payload, sprawdza tożsamość domeny
i atomowo publikuje go do field store. FEM i FDM zachowują osobne adaptery
producentów.

### 2. Rozdzielenie pola solverowego i obserwacyjnego FDM CUDA

FDM CUDA zachowuje maskowane `h_demag` używane przez LLG, energię magnetyczną
i redukcje solverowe. Dodatkowo demag runtime udostępnia pełnodomenowe pole
obserwacyjne przed zastosowaniem maski materiałowej.

Pełnodomenowy bufor:

- powstaje z tego samego wyniku konwolucji FFT co pole solverowe;
- nie uruchamia drugiego FFT dla tego samego snapshotu;
- jest aktualny dla tej samej magnetyzacji, kroku i generation identity;
- nie wpływa na RHS ani komórki nieaktywne solvera;
- jest źródłem `H_demag` dla `full_domain` i Airbox;
- może być pomijany poza aktywnym harmonogramem obserwacji, ale jego brak jest
  stanem `pending/unmaterialized`, nie kompletnym zerowym polem.

Jeżeli kanoniczny katalog zachowuje `H_eff` jako `full_domain`, snapshot
obserwacyjny składa go tak jak FEM: magnetyczne składniki lokalne pozostają
maskowane, a pełnodomenowy wkład demag jest dodawany w stagingu. Semantyka ta
ma być zapisana w nocie fizycznej i przetestowana osobno.

### 3. Asynchroniczny snapshot CUDA

FDM CUDA otrzymuje snapshot pool analogiczny odpowiedzialnościami do FEM:

- ograniczoną liczbę slotów stagingowych;
- bufory device staging i pinned host memory;
- osobny I/O stream;
- event gotowości po compute streamie;
- event zakończenia stagingu blokujący ponowną mutację źródła;
- bezpieczne zwolnienie slotu po sukcesie, błędzie i anulowaniu;
- brak globalnego `cudaDeviceSynchronize()` w zwykłej ścieżce;
- telemetrię czasu, bajtów, oczekiwania na slot i błędów kopiowania.

Snapshot pełnej domeny nie może przejmować własności buforów integratora.
Awaria opcjonalnej materializacji nie może uszkodzić solvera, ale musi
opublikować stan `error` z zachowaniem ostatniego zgodnego `stale_complete`.

### 4. Gęstości energii CUDA FP64 i FP32

Każde `eden_*` jest obliczane z tego samego zaakceptowanego stanu i tych samych
parametrów co odpowiadająca energia globalna:

```text
eden_ex    = -0.5 * mu0 * Ms * dot(m, H_ex)
eden_demag = -0.5 * mu0 * Ms * dot(m, H_demag)
eden_ext   = -1.0 * mu0 * Ms * dot(m, H_ext)
```

Anizotropia i DMI korzystają z kanonicznych lokalnych funkcjonałów energii,
a nie z przybliżenia wymyślonego przez warstwę obserwacji. `eden_total` jest
punktową sumą wyłącznie aktywnych i wspieranych składników.

Realizacja CUDA używa natywnych kerneli skalarnych i bufora scalar snapshot.
FP64 i FP32 mają ten sam zestaw quantity IDs, warunki aktywacji, jednostki i
proweniencję. Akumulacja oraz tolerancje kwalifikacyjne są zależne od precyzji,
ale publiczna semantyka nie rozgałęzia się według urządzenia.

Całka `sum(eden_i * cell_volume)` musi być zgodna z globalnym `E_i` tego samego
snapshotu. Dla komórek niemagnetycznych gęstość energii jest zerowa;
pełnodomenowy `H_demag` pozostaje tam niezerowy i jest odrębną obserwablą.

### 5. Wspólny koordynator materializacji

Jawne `compute_fields`, publikacja terminalna i materializacja wywołana przez
wybór ilości korzystają z jednego koordynatora.

Kolejność terminalna:

1. zatwierdzenie magnetyzacji i tożsamości domeny;
2. publikacja `m`;
3. rozpoczęcie snapshotów aktywnych pól i gęstości energii;
4. publikowanie kolejnych quantity jako `pending`;
5. atomowy commit każdego kompletnego payloadu;
6. jedno family-level invalidation katalogu oraz dokładne invalidacje payloadów;
7. przejście runtime do `awaiting_command` z możliwością ponownego
   `compute_fields` bez wykonania kroku solvera.

Aktualnie wybrana ilość ma priorytet, ale pełny aktywny zestaw terminalny musi
zostać domknięty. Koordynator deduplikuje równoczesne żądania tej samej
quantity i generation identity.

## Kontrakt capability i API

### 1. Rozdzielenie zasobów

- `data/quantities` opisuje aktywne capability bieżącego planu, obsługiwane
  zakresy i możliwość materializacji;
- `data/fields` opisuje pola zmaterializowane lub będące w materializacji;
- `data/fields/{quantity_id}/meta` opisuje dokładny stan, źródło i zakres;
- binarny data plane pozostaje właścicielem wartości;
- `status.capabilities` pozostaje źródłem globalnego UI gatingu aktywnej linii;
- WebSocket niesie wyłącznie invalidacje i completion events.

Brak deskryptora w `data/fields` nie może oznaczać `unsupported`, jeżeli
`data/quantities` deklaruje quantity jako aktywne i materializowalne.

### 2. Stany i błędy

Minimalne rozróżnienie UI/API:

- `unsupported`: backend lub aktywny plan nie realizuje quantity;
- `unmaterialized`: capability istnieje, ale nie rozpoczęto snapshotu;
- `pending`: snapshot jest w toku;
- `complete`: payload odpowiada bieżącemu źródłu;
- `stale_complete`: zachowany zgodny payload ze starszego kroku;
- `error`: jawna porażka materializacji z kodem przyczyny.

`compute_fields` musi być enabled w `awaiting_command` i po zakończonym etapie,
jeżeli runtime zachował stan umożliwiający obserwację. Endpoint submission,
readiness resource i faktyczne zachowanie kolejki muszą podejmować tę samą
decyzję.

### 3. Zakres Airbox

Airbox jest zakresem domeny, nie osobnym rodzajem pola. API wybiera komórki
niemagnetyczne na podstawie kanonicznego membership. Quantity
`magnetic_only` zwraca jawne `unsupported_scope`; quantity `full_domain`
zwraca wartości z tego samego nośnika co pełna domena.

Payload `H_demag` Airbox jest poprawny tylko wtedy, gdy:

- generation identity odpowiada domenie;
- liczba próbek i membership są zgodne;
- wszystkie wartości są skończone;
- fixture o niezerowym momencie magnetycznym daje niezerowe pole poza magnesem;
- statystyki zakresu są liczone z rzeczywistych próbek, nie z globalnego meta.

## Projekt Control Room

### 1. Wybór quantity

Selektor korzysta z `data/quantities` oraz `data/fields`:

- wspierane, niezmaterializowane quantity jest wybieralne i pokazuje stan
  „available — compute”;
- wybór rozpoczyna deduplikowane `compute_fields`;
- `pending` zachowuje ostatni zgodny bufor i pokazuje postęp;
- `unsupported` jest wyłączone z dokładnym powodem;
- `error` nie przełącza się na `m` i nie udaje sukcesu.

Frontend nie rozgałęzia logiki na FEM/FDM. Różnice domeny i lokalizacji
obsługują istniejące adaptery oraz render model.

### 2. Warstwy Airbox

- Wireframe i Points działają z samej geometrii/nośnika Airbox;
- ich przełączanie nie pobiera pola i nie zmienia quantity;
- Vectors wymaga kompletnego pola wektorowego kompatybilnego z Airbox;
- scalar `eden_*` używa koloru/punktów/surface, nigdy glyphów wektorowych;
- zmiana quantity aktualizuje field buffer bez przebudowy topologii;
- wyłączenie warstwy natychmiast usuwa ją z klatki, lecz nie usuwa cache
  należącego do resource layer.

Renderer pozostaje `frameloop="demand"`; materializacja i invalidacje powodują
tylko uzasadnione dirty frames.

## Capability i polityka precyzji

Docelowy status po całym rolloutcie:

| Realizacja | `H_demag` full domain | `eden_*` | Status końcowy |
|---|---:|---:|---|
| FDM CPU FP64 | tak | tak | referencyjna |
| FDM CUDA FP64 | tak | tak | produkcyjna po parytecie CPU |
| FDM CUDA FP32 | tak | tak | produkcyjna po parytecie FP64 |
| FEM CPU/GPU | bez regresji | bez regresji | istniejący kontrakt |

FP32 jest `supported` dla tego bounded slice dopiero po przejściu dedykowanych
managed bram parity. Nie wolno automatycznie materializować go przez FP64 lub
CPU i przedstawiać jako wynik FP32; przy braku kwalifikacji planner/API musi
pozostać fail-closed.

## Proweniencja

Każdy deskryptor i payload zachowuje:

- requested i resolved backend/device/precision;
- quantity, spatial domain i location;
- source step/revision/time;
- domain generation i membership/carrier identity;
- algorytm materializacji;
- liczbę bajtów i wall time;
- stan oraz stabilny reason code błędu lub degradacji.

Proweniencja odróżnia solver field od visualization snapshot, ale oba wskazują
na ten sam zaakceptowany stan magnetyzacji.

## Obsługa błędów

- Brak pełnodomenowego źródła demag powoduje `error` albo `unsupported`, nigdy
  kompletny zerowy payload.
- Niezgodność generation identity zatrzymuje publikację i zachowuje ostatni
  zgodny bufor jako `stale_complete`.
- Brak slotu snapshot pool stosuje bounded backpressure; nie alokuje
  nieograniczonych buforów.
- Błąd CUDA snapshotu nie przerywa ukończonego solvera, ale jest widoczny w
  command detail, diagnostics i field meta.
- Nieznane quantity nie może mapować się domyślnie na `m`.
- Częściowy sukces publikuje wyłącznie quantity zakończone poprawnie i podaje
  dokładny stan pozostałych.

## Walidacja i kryteria akceptacji

### Kontrakt i testy jednostkowe

1. Katalog aktywności zwraca identyczny zestaw wspieranych `eden_*` dla CPU i
   CUDA, ograniczony przez aktywne interakcje.
2. Nieznane i niewspierane quantity kończy się błędem, bez fallbacku do `m`.
3. Maskowane pole solverowe pozostaje zerowe poza magnesem.
4. Pełnodomenowy snapshot `H_demag` jest niezerowy w wybranych komórkach
   Airbox dla deterministycznego dipola.
5. Snapshot pool przechodzi testy sukcesu, anulowania, błędu i ponownego użycia.
6. Integracja każdego `eden_i` odpowiada globalnemu `E_i` tego samego stanu.

### Parytet numeryczny

1. FDM CUDA FP64 jest porównywane z FDM CPU FP64 dla `H_demag`, aktywnych pól,
   każdego `eden_i` i `eden_total`.
2. FP32 jest porównywane z zakwalifikowanym CUDA FP64 na tych samych siatkach,
   maskach i stanach.
3. Walidacja obejmuje pole wewnątrz magnesu, Airbox, całki energii i przypadki
   nieaktywnych interakcji.
4. Tolerancje są zapisane w nocie fizycznej przed implementacją i wynikają z
   conditioning oraz precision, nie z obserwowanego rozrzutu testów.

### API i frontend

1. Świeża sesja rozróżnia supported/unmaterialized od unsupported.
2. `compute_fields` nie wykonuje kroku solvera i publikuje dokładne invalidacje.
3. Bezpośredni port API i proxy Control Room zwracają identyczne deskryptory i
   ETagi.
4. Zmiana quantity nie przebudowuje topologii.
5. Sekwencja `wireframe on -> off -> points on -> off -> vectors on` commitują
   osobne klatki.
6. Klatka Vectors ma niezerową liczbę czytelnych glyphów Airbox.
7. Canvas pozostaje widoczny, drawing buffer jest niezerowy, a WebGL context
   nie jest utracony.
8. Po 100 przełączeniach quantity/warstw wzrost pamięci, liczba listenerów,
   workerów, geometrii i materiałów pozostają ograniczone.

## Kolejność rollout'u

1. Uzupełnienie noty fizycznej i capability matrix.
2. Backend-neutralny kontrakt snapshotu i testy zgodności istniejącego FEM.
3. Pełnodomenowy `H_demag` FDM CUDA FP64/FP32.
4. Scalar snapshot i wszystkie aktywne `eden_*` FDM CUDA FP64/FP32.
5. Wspólny koordynator terminalnej i jawnej materializacji.
6. Resource-first API, readiness, reason codes, OpenAPI i generated transport.
7. Backend-neutralny Control Room oraz warstwy Airbox.
8. Testy kontraktowe, numeryczne, wydajnościowe i browser/WebGL.
9. Aktualizacja capability na produkcyjny status dopiero po przejściu wszystkich
   wymaganych bram.

## Poza zakresem

- nowe termy fizyczne lub nowe quantity IDs;
- zmiana publicznej składni Python DSL albo ProblemIR;
- hybrydowa materializacja FDM/FEM;
- fallback GPU -> CPU;
- obliczanie pól lub energii w przeglądarce;
- przebudowa ogólnej architektury FEM;
- kwalifikowanie wszystkich możliwych modeli materiałowych, jeżeli aktywna
  macierz capability jawnie je odrzuca.

## Decyzje

1. Jeden sekwencyjny rollout obejmuje Airbox, pola wewnętrzne, `eden_*`, API i
   UI; częściowe etapy nie są przedstawiane jako ukończona funkcja.
2. FP64 i FP32 są implementowane w tym samym rolloutcie, lecz FP32 jest
   promowane dopiero po parytecie z FP64.
3. Architektura snapshotów jest spójna z FEM na poziomie kontraktu i lifecycle.
4. FDM zachowuje własne bufory, kernela, adapter i walidację.
5. Pełnodomenowy `H_demag` jest odrębnym nośnikiem obserwacyjnym, a nie zmianą
   pola solverowego.
6. Capability i materialization state są różnymi pojęciami w API i UI.
7. HTTP v2 pozostaje źródłem prawdy; realtime wyłącznie unieważnia zasoby.

## Evidence aktualizacji — 2026-08-16

Świeży managed launcher z `master` (`c8873c7d0d09a7831c48d294d1a9cfa8013bce51`)
został zbudowany przez `just build fullmag` w trybie `cuda-fem-gpu`. Dla
fixture `examples/fdm_cpu_relax_smoke.py` rozstrzygnięty lane był
`fdm_cuda`/FP32, bez fallbacku (`device=gpu`, `fallback=null`). Terminalny
snapshot opublikował `H_demag`, `H_eff`, `eden_*` i `m` z tym samym
`source_step=4`, `source_time_seconds=4e-13` oraz zgodną identyfikacją
generacji domeny.

Wcześniejszy błąd telemetrii obiektowej miał osobną przyczynę niż brak pola:
ścieżka scalar snapshotu aktualizowała średnią w `StepStats`, lecz nie
odświeżała `per_object_scalars`. API zwracało przez to zerowe `mx/my/mz`, mimo
że tabela scalar i binarne pole `m` były poprawne. Wspólny helper aktualizuje
teraz oba widoki atomowo. Świeży endpoint metryk zwrócił
`my=0.9999988093647432`, `mz=3.677104947078164e-5` oraz niezerowe energie.

Managed parity bramy FDM przeszły przez
`FULLMAG_CUDA_ARCHITECTURES=native FULLMAG_NATIVE_BUILD_JOBS=2 just
verify-fdm-observable-materialization-parity`. Evidence znajduje się w
`/mnt/fullmag-zfn2-native/fdm-observable-materialization-parity/evidence/qualification.json`
(`source_commit` i `source_diff_sha256` są zapisane w JSON): CPU↔CUDA FP64
obejmuje pola i gęstości (`max_density_abs_drift=1.082183e-2`),
CUDA FP32↔FP64, transfery F32→F64 oraz wszystkie sześć `eden_*` z całkami
zgodnymi z globalnymi energiami.

Pełny browser/WebGL gate przeszedł przez istniejący skrypt
`pnpm --dir apps/control-room smoke:fdm-terminal-webgl-gate` na świeżym
runtime FP32. Evidence znajduje się w
`/tmp/fullmag-observable-browser-proof-cuda-fp32-1/fdm-terminal-webgl-gate.json`:
Airbox nie oferuje `m`, `H_demag/H_eff` mają pełnodomenowe próbki, Wireframe,
Points i Vectors commitują osobne stany, a kontekst WebGL i drawing buffer są
zdrowe. Audyt 120 przełączeń quantity/layer znajduje się w
`/tmp/fullmag-observable-viewport-audit-fp32-1/metrics.json` (heap
`69.2MB -> 71.8MB`, cache `0B -> 0B`, geometria `2 -> 2`, GPU buffers
`4591/4595` usuniętych). Direct API i proxy zwróciły wcześniej identyczny
katalog quantity oraz meta `H_demag`; zmiana precision gate nie zmieniła
kształtu kontraktu v2.

Ten evidence kwalifikuje bieżący bounded slice jako
`validated / runtime-qualified` dla FDM CUDA FP64/FP32 oraz utrzymuje
`regression-qualified` status istniejącego FEM CPU/GPU snapshotu. Nie jest to
kwalifikacja hybrydowej materializacji ani każdego modelu materiałowego.
Lokalny `react-doctor` nie jest zainstalowany (`pnpm exec react-doctor` zwraca
`Command "react-doctor" not found`), więc ten review-tool gate pozostaje
jawnie `tooling_gap`, bez zastępowania go innym score.
