# FFT anteny: przegląd transferu, dekodowania i retencji pamięci

Data: 12.10.2026. Zakres uzgodniony z wątkiem `01a12a56-002e-7660-8424-c7e07fb0907a`: **read-only review**, bez implementacji polityki, edycji produkcyjnego UI, fixture, native buildu ani nowego browser run. Dokument rozstrzyga wymagania T10/T14/T15; nie zmienia fizyki, rozdzielczości solvera ani kwalifikacji naukowej.

## 1. Tożsamość odczytu i ograniczenia dowodów

Źródła integratora: `D:/git/fullmag/worktrees/antenna-transport-e2e-20261011`, bazowy HEAD `147d8b1f723135229cfff0a90e8b2a8bb18cfd9d` **plus WIP**. HEAD sam nie identyfikuje badanych zmian. Piny niżej przypinają poszczególne pliki, nie cały snapshot. Odczyt jest analizą źródeł, nie pomiarem heap, profilerem czasu ani runtime reprodukcją. Dotychczasowy browser GREEN 14/14 nie pokrywa łącznego budżetu pamięci ani błędu odświeżenia samego payloadu.

| Plik względem źródeł integratora | SHA-256 |
|---|---|
| `apps/control-room/src/modules/inspector/panels/antenna/AntennaSourceSpectrumPayloadView.tsx` | `dcf008be0f027de8c78e5fa4f2237294c8be7ba64816e8c0a6b8d188f685bbe7` |
| `apps/control-room/src/kernel/api/codecs/antennaSpectrumManifestCodec.ts` | `d28e93f2bd89f6a34b96959cec243f89534d6439348eb92168a13c61e7785fc2` |
| `apps/control-room/src/kernel/resources/antennaResources.ts` | `5278afc41b605ca87681793c27320727b5a5c0beebe9070c64d9517cec460be5` |
| `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts` | `b8a5f347db8c0ee7e314cbbc14b477b33d248782a4364fc50795a73c15cd3254` |
| `apps/control-room/src/kernel/resources/useResource.ts` | `916a8a40f369c8ee41302aa1f487d89510de406865a49011b9622ef63e489fab` |
| `apps/control-room/src/kernel/resources/resourceState.ts` | `ae18588321dd5c9e4be2b1c16e9f2ab910fa1ca4b653221df2541edfd398a6a5` |
| `apps/control-room/src/kernel/api/ControlRoomApi.ts` | `709c23ac0cb5485b974de6f83d60feabf542e8fc9615ac971a858014e4106ca4` |
| `apps/control-room/src/kernel/api/boundedBinaryResponse.ts` | `521cc76251057a422fd1a4e5fc47329ed7b6fb04d9d8e7fa2c7bedd076bd66f5` |
| `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` | `39b7c3a83dc0318d892b3838ee1077cfd06dce312ac348e11672af679297be6a` |
| `crates/fullmag-api/src/router_v2/handlers/shared.rs` | `e6a17f4c979749956c16a593ea15b18e8b43f78ed8213d8587c27d3efa79060e` |
| `apps/control-room/src/kernel/api/binaryDecodeScheduler.ts` | `bfd3ff1d56aad609fa67bcdc339c0b92f1a72fdf1176eb64f000032fe963d9f6` |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `b5ff019d70033d6793e76d6ea69ad9ec96f3b8c7eb9ff0bc093cf63a01ace879` |

## 2. Potwierdzone zachowanie

1. `antennaSpectrumManifestCodec.ts::antennaSpectrumPayloadByteLengths` sprawdza semantykę deskryptorów i bezpieczną arytmetykę przed odczytem. Zwraca cztery długości oraz `total`. Nie deklaruje polityki pamięci i nie powinien jej samodzielnie definiować.
2. `AntennaSourceSpectrumPayloadView.tsx::AntennaSourceSpectrumPayloadView` wywołuje codec przed czterema hooks. Niepoprawny manifest ustawia `enabled=false`; poprawny przekazuje dokładne `maxResponseBytes`. Hooks pozostają w stałej kolejności. To usuwa lukę braku per-response limitu, ale `lengths.total` nie jest użyte.
3. `ControlRoomApi.ts::requestBinaryResource` nakłada `boundedBinaryResponse` przed `parseAs: "arrayBuffer"`. `boundedBinaryResponse.ts::boundedBinaryResponse` odrzuca nadmierny Content-Length lub przekroczenie limitu streamu, anuluje reader; przy kompresji nie traktuje długości wire jako długości zdekodowanych bajtów. Nie rezerwuje wspólnego budżetu kilku odpowiedzi.
4. `antennaResources.ts::useAntennaSourceSpectrumPayloadResource` używa jednej fasady, scoped resource key, expected ETag i opcjonalnego Range. ETag jest sprawdzany po pobraniu, nie przed alokacją odpowiedzi. Nie ma drugiego cache domenowego w tym hooku.
5. `ResourceRuntimeStore.ts::subscribe` po odejściu ostatniego listenera wywołuje `releaseUnobservedEntry`: abort, anulowanie timerów, usunięcie wpisu. **Nie ma podstaw do twierdzenia, że ta ścieżka zatrzymuje wszystkie historyczne widma bezterminowo.** Usunięcie wpisu nie jest dowodem natychmiastowego GC ani zwolnienia referencji w innych aktywnych konsumentach.

## 3. Findings i warunki niepowodzenia

| ID / wymaganie | Źródło i przyczyna | Kiedy występuje / odbiór |
|---|---|---|
| M01 — Required: admission całego widoku | `AntennaSourceSpectrumPayloadView` uruchamia cztery hooks bez rezerwacji sumy. Codec kontroluje overflow, nie fizyczną dostępną pamięć. | Manifest może być poprawny, a jego całkowity koszt nie mieścić się w polityce interaktywnego klienta. Odmowa lub tryb dużego wyniku musi nastąpić przed pierwszym numeric GET. |
| M02 — Required: ograniczyć kopie i pracę main thread | `ControlRoomApi::requestBinaryResource` omija scheduler dla `raw-bytes`; `decodePayloads`/`decodeF64LE` tworzą cztery `number[]` w `useMemo`. `validatePayloads`, `heatmapCells` i `reduce` wykonują pełne przebiegi na głównym wątku. | Duży zgodny wynik może blokować Inspector. `MAX_AXIS_CELLS=64` ogranicza dopiero DOM, nie transfer, dekodowanie ani skan. Pomiar main-thread i pamięci musi obejmować walidację oraz peak, nie tylko liczbę komórek. |
| M03 — Required: uwzględnić retencję przy odświeżaniu | `ResourceRuntimeStore::ensureLoad` zachowuje stare `snapshot.data`, gdy pobiera nową odpowiedź; `markResourceLoading` nie usuwa danych. | Dla tego samego aktywnego klucza stare i nowe bufory mogą współistnieć podczas load. Zmiana ETag/klucza może zwolnić starego ownera, lecz nie gwarantuje natychmiastowego GC. Budżet nie może liczyć wyłącznie nowych bajtów. |
| M04 — Required: terminalna diagnoza błędu payload refresh | `useResource.ts::visibleResourceState` → `resourceState.ts::markResourceLoading` przedstawia retained-data error jako `stale` z `refreshError`. `AntennaSourceSpectrumPayloadView.tsx::decodePayloads` czyta wyłącznie `status === "error"`, potem zamienia `stale` na pending. | Po nieudanym odświeżeniu binarnego payloadu, bez zmiany gotowych metadanych, źródłowa ścieżka prowadzi do `Loading binary FFT payloads…` zamiast błędu. Nie wyświetla nieaktualnego grid, ale ukrywa przyczynę. Potrzebna browser reprodukcja przez rzeczywistą invalidację payload resource; istniejące metadata/catalog refresh cases nie wystarczają. |
| M05 — Required dla large-result: Range nie ogranicza serwera | `antenna.rs::get_antenna_source_spectrum_payload` najpierw weryfikuje pozostałe payloady, wczytuje wybrany przez `std::fs::read`, hashuje go; dopiero `shared.rs::conditional_binary_response_with_content_type` rozstrzyga 304/Range. | Mały Range lub 304 nie zapobiega pełnemu odczytowi wybranego pliku. Pozostałe payloady są hashowane strumieniowo przez `verify_antenna_binary_payload` z buforem 64 KiB — nie należy przypisywać im pełnej alokacji. Cztery równoległe żądania mogą ponawiać pełną weryfikację tego samego bundle. |

W kodzie runnera `antenna_spectrum.rs::MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT` wynosi 10 000 000. Przykładowy zgodny `vector_power` przy tej liczności ma 480 000 000 B amplitud i 80 000 000 B mocy, plus osie. To **rachunek rozmiaru wire**, nie pomiar RSS/heap i nie twierdzenie, że każda publiczna ścieżka osiąga limit. `number[]`, transport, stary snapshot, layout silnika JS i chwilowe bufory zwiększają koszt w sposób wymagający pomiaru. Nie wolno podać stałego mnożnika JS jako zmierzonej gwarancji.

## 4. Proponowany kontrakt — wymaga uzgodnienia, nie został wdrożony

### Etap A: jawna polityka interaktywna

Polityka należy do istniejącej granicy resource/data plane, nie do codeca semantycznego, solver capability ani wielkości siatki. Rozdzielić: limit jednej odpowiedzi, rezerwację całego aktywnego widoku, koszt dekodowania, retained last-good oraz wszystkie jednoczesne widoki. Parametr operacyjny klienta musi mieć właściciela, wartość ustaloną z pomiarów i widoczną diagnostykę. Nie proponuje się arbitralnej liczby bajtów ani nowego scientific grid cap.

Po walidacji manifestu obliczyć wymagany koszt dla faktycznie wybranej strategii. **Przed pierwszym GET atomowo uzyskać rezerwację** w jednym właścicielu; dopiero sukces admission włącza istniejące hooks. Kilka paneli tego samego immutable resource nie może naliczać współdzielonego bufora wielokrotnie ani omijać limitu przez cztery niezależne wpisy. Cleanup, abort, błąd, zmiana tożsamości i utrata ostatniego obserwatora zwalniają rezerwację dokładnie raz, bez usuwania danych innego aktywnego ownera.

Przekroczenie oznacza jawnie „wynik opublikowany, pełny odczyt interaktywny poza budżetem”, nie `unsupported physics`, `not published` ani `ready`. Użytkownik zachowuje dostęp do metadanych i eksportu pełnego artefaktu. Nie zmniejszać samowolnie siatki, liczby komponentów, jakości widoku ani rozdzielczości solvera. Sama odmowa dużego widoku jest zabezpieczeniem etapu A, **nie ukończoną obsługą dużych wyników**.

### Etap B: duży wynik bez cichej redukcji

Preferowany kierunek: sekwencyjny, bounded odczyt Range istniejących payloadów oraz walidacja w workerze; nie cztery pełne kopie `number[]`. Rozszerzenie istniejącego schedulera wymaga własnego kontraktu ownership: transfer `[buffer]` odłącza ArrayBuffer, więc nie wolno przekazać w ten sposób bufora wciąż współdzielonego w runtime cache. Nie dodawać drugiego fetch klienta w React ani workerze.

Każdy fragment ma pinned session/output/manifest/ETag, dokładny zakres, liczność i Content-Range; chunks nie mogą pochodzić z różnych rewizji. Pełna walidacja finite i zgodności mocy z sumą wszystkich komponentów pozostaje obowiązkowa. Globalny peak musi wynikać z całego widma. Jeżeli model widoku używa istniejącego max-pooling, zachować dokładnie jego semantykę i etykietę; nie wolno przedstawiać próbkowanego podzbioru jako pełnego widma. Inspekcja wybranego punktu pobiera jego dokładne dane, a eksport zachowuje kompletny artefakt. Ostateczny kontrakt interakcji, nie tylko miniatury 64×64, wymaga uzgodnienia produktu.

Po stronie API Range wymaga bounded odczytu wybranego fragmentu z **zweryfikowanego immutable ownera**. Wcześniejsza weryfikacja pełnego bundle może być współdzielona tylko przy udowodnionej niezmienności i invalidacji; nie wystarczy path/mtime ani zaufanie do samego ETag. Nie przesuwać 304 przed wymagane kontrole integralności wyłącznie dla szybkości. Reuse istniejącego wzorca verified store należy ocenić osobno; ten review nie zatwierdza migracji artefaktów ani nowego endpointu.

### Etap C: odświeżenie i diagnostyka

Po rezerwacji nowej rewizji zachować stabilny root, focus i scroll. Nowa rewizja nie staje się gotowa przed walidacją wszystkich wymaganych danych. Nieudane odświeżenie musi pokazać `error ?? refreshError`, a nie bezterminowy loading; retained dane mogą pozostać w cache, ale nie udawać current FFT. Błędy deterministyczne integralności/budżetu powinny być terminalne, bez ponownego pełnego transferu w ogólnej polityce transient retry; wymaga to uzgodnienia typowanego reason code, nie zmiany globalnego retry dla wszystkich zasobów.

## 5. Weryfikacja odbioru

1. **Admission:** kilka poprawnych manifestów łącznie przekracza budżet; zero numeric GET dla odmowy, stabilne diagnostyki, brak zmiany scientific capability. Pokryć także ponowne otwarcie, inne client/session scopes i kilku obserwatorów.
2. **Transport:** Content-Length, brak nagłówka, kompresja, nadmiarowy chunk, abort i zmiana właściciela w trakcie Range. Odmowy przed pełną alokacją; anulowanie readera i zwolnienie reservation.
3. **Cache:** last-good + refresh nowej odpowiedzi, błąd, ACK, szybka zmiana selection; liczyć rzeczywiście żywych ownerów i peak, nie sumę zakończonych requestów. Potwierdzić usunięcie nieobserwowanego wpisu oraz brak usunięcia współdzielonego aktywnego bufora.
4. **Dekodowanie:** identyczne scalar/vector i obie normalizacje, komponent-major, finite/power oraz globalny peak. Porównać wynik worker/range z obecnym pełnym oracle dla tego samego artefaktu; mierzyć main-thread long tasks i użycie pamięci na przypiętych źródłach.
5. **Payload refresh error:** gotowy grid → invalidacja wyłącznie power → retained pending → terminalne 422 lub transport error. Wymagać root stability, ukrytego current grid, konkretnej diagnozy, bounded retries i skutecznego ponownego ACK. Nie zastępować tego testem refresh metadanych.
6. **Serwer:** mały Range nie alokuje całego payloadu, równoległe odczyty dzielą bezpieczną weryfikację ownera; corruption i zmiana pliku nadal odrzucane. Same statusy 206/304 nie dowodzą bounded RAM/I/O.
7. **Produkt:** pełne dane pozostają dostępne, wszelkie ograniczenie/tryb widoku jest jawny; brak cichego obniżenia jakości. Osobny browser receipt, CPU/heap evidence oraz API/runtime dowód; żaden z nich nie zastępuje kwalifikacji fizycznego FFT i LLG.

## 6. Wynik review

Per-response admission po integracji codeca jest postępem. **Łączna polityka pamięci pozostaje otwarta.** Najbliższa chirurgiczna poprawka niezależna od jej wartości to diagnostyka `refreshError` samego payloadu z reprodukcją przez publiczny hook. Nie zmieniono żadnego produkcyjnego źródła integratora i nie uruchamiano jednostkowych testów, przeglądarki ani solvera. Raport przekazano właścicielowi przed implementacją polityki; jej kontrakt musi zostać zatwierdzony przed zmianami.
