# FDM-GPU-TRX-001 — Retry-safe termika, cache i checkpoint urządzeniowy

| Pole | Wartość |
|---|---|
| Lane | **FDM GPU** |
| Priorytet | **P1** |
| Klasa | `transactionality` |
| Status | `source/test remediated; global qualification pending` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FDM-GPU-PERF-004`, `FDM-GPU-NUM-001` |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FDM-GPU-TRX-001`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

Rejected step nie może zużywać nowego termicznego incrementu ani pozostawiać trial fields, FSAL, czasu, `dt` i transport cache. RNG jest liczony z seed/step counter, więc attempt identity musi być rozdzielone od accepted interval identity.

### Skutek

Bias stochastyczny, brak restart determinism i częściowo opublikowany stan po błędzie CUDA/transport.

## 3. Docelowy kontrakt

Accepted interval ma stabilny RNG key; retry używa tego samego `xi` z nową skalą. Device transaction ma minimalny backup accepted state i atomowy commit po wszystkich finalnych redukcjach.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `backends/fdm/include/context.hpp` | ABI, stan runtime lub deklaracje |
| `backends/fdm/gpu/cuda/runtime/llg_checkpoint.cpp` | modyfikacja lub weryfikacja kontraktu |
| `backends/fdm/gpu/cuda/integrators` | integracja czasu i stan próby |
| `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | operator fizyczny, pole lub energia |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | operator fizyczny, pole lub energia |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Rozdzielić `accepted_step_index` od `attempt_generation` i używać pierwszego w RNG.
- Precompute lub regenerować deterministyczne raw normals z accepted interval key; retry nie zmienia key.
- Snapshotować tylko accepted magnetization, minimalny integrator state i konieczne rozwiązania transportu.

### Etap C — integracja i migracja

- Trial fields oznaczać revision attempt i publikować dopiero po commit.
- Checkpoint schema musi obejmować RNG identity, FSAL, ABM/adaptive state i exact device policy.
- Fault CUDA po dowolnym stage uruchamia restore bez hostowego pełnego readbacku.

### Etap D — kwalifikacja i promocja

- Uruchomić unit, integration, physics-oracle i performance tests z dokładnym provenance.
- Porównać wyniki z bazowym backendem i niezależnym oracle.
- Promować capability dopiero po spełnieniu wszystkich kryteriów akceptacyjnych.

## 6. Szczegółowe zasady implementacyjne

### 6.1 Własność i lifecycle danych

- Dane niezmienne dla sesji muszą być budowane w setup i oznaczone revision/hash.
- Trial state nie może nadpisywać accepted state ani opublikowanych cache przed commit.
- Derived cache może być unieważniony i odtworzony; nie powinien być kopiowany bez dowodu konieczności.
- Hot loop nie może wykonywać ukrytej zmiany backendu, precision ani operator realization.
- Każdy fallback musi być requested jawnie albo zakończyć wykonanie błędem.

### 6.2 Obsługa błędów

- NaN, Inf, brak capability, OOM, błąd solvera i niespełnione kryterium zbieżności muszą mieć osobne reason codes.
- Błąd przed commit pozostawia authoritative state niezmieniony.
- Telemetryka próby może rosnąć po reject/failure, ale nie może być mylona ze stanem fizycznym.
- Błąd nie może zostać zamieniony na „sukces z pustymi danymi”.

### 6.3 Zgodność wsteczna

- Zmiana wyniku numerycznego wymaga nowej wersji solver policy lub realization ID.
- Stare checkpointy muszą zostać odrzucone z jasnym komunikatem albo zmigrowane przez wersjonowany adapter.
- Publiczne jednostki i nazwy quantities nie mogą zmienić znaczenia bez migracji schema.
- Okres przejściowy może utrzymywać starą implementację wyłącznie jako jawny `legacy` lane, nigdy jako silent default.

## 7. Plan testów

- Forced reject z temperaturą: raw draw identity pozostaje stała.
- Fault injection po każdym stage i po final stats.
- Checkpoint/restart trajectory determinism.
- Transport-coupled rollback parity.
- Compute Sanitizer i stale-revision publication test.

Każdy test integracyjny musi zapisać:

- commit i build identity;
- requested/resolved/executed backend;
- precision i device;
- aktywne interakcje oraz realization IDs;
- liczbę accepted/rejected attempts;
- operator evaluation counts;
- tolerancje i stop reason.

## 8. Telemetryka i kryteria wydajności

Obowiązkowe metryki:

- RNG draws/accepted step
- transaction D2D bytes
- rollback latency
- stale publication count

Minimalne wymagania:

- brak nieplanowanych alokacji, assembly, plan creation albo pełnych transferów w steady-state hot loop;
- brak regresji time-to-accuracy poza zaakceptowanym budżetem;
- koszt diagnostyki pełnej nie może być ukryty w zwykłym kroku bez outputu;
- benchmark musi porównywać tę samą fizykę, siatkę, precision policy i błąd końcowy.

## 9. Kryteria akceptacyjne

### Stan wykonania — 2026-08-29

Publiczna ścieżka multilayer omijała `StepTransactionController`: po wstrzyknięciu
awarii final-stats krok nie kończył się błędem i nie uruchamiał rollbacku. RED
reproducer zakończył się komunikatem `multilayer final-stats fault did not fail
the transaction`. Naprawa objęła jeden wspólny przebieg begin/capture/integrate/
final-stats/receipt/transport/commit/publish/rollback, setup-owned snapshot
magnetyzacji każdej warstwy oraz staged commit czasu, `dt`, licznika kroku i
`accepted_step_index`.

Fault-injection obejmuje Heun/RK4/RK23 × FP32/FP64 oraz fazy integratora,
final-stats, receipt i transport-commit. Każda awaria pozostawia statystyki
wywołującego bez zmian, przywraca magnetyzację bitowo, publikuje dokładną liczbę
bajtów D2D i pozwala na retry bitowo zgodny z czystym krokiem kontrolnym.
Istniejący kontrakt single-grid dodatkowo pokrywa RK23/DP45, stabilny termiczny
RNG key, FSAL i dynamiczny Oersted. Checkpoint/restart jest teraz wykonywany
zarówno dla przypadku deterministycznego, jak i Brown thermal.

Dowody wykonane na `NVIDIA GeForce RTX 3070 Laptop GPU`:

- `just verify-fdm-gpu-transaction-contract` — CTest **3/3**, dwa dokładne testy
  runnera **2/2**, termiczny oracle/retry **PASS**, requested `fdm`, resolved
  `fdm_cuda`, executed `cuda_fdm`, fallback `0`;
- `just verify-fdm-gpu-abi-contract` — Rust layout **2/2**, C sentinel **1/1** i
  `cargo check -p fullmag-runner --features cuda` — **PASS**;
- `just verify-fdm-gpu-transaction-compute-sanitizer` — **NIEZALICZONE**:
  testy poprzedzające sanitizer przechodzą, ale WDDM odrzuca inicjalizację,
  ponieważ systemowe klucze interfejsu debugowania NVIDIA są wyłączone. Nie jest
  to dowód braku błędów pamięci; gate pozostaje otwarty.

Drzewa CMake, targety Cargo i JSON evidence znajdują się na zewnętrznym
loop-backed ext4 i nie są częścią checkoutu ani indeksu Git.

- [x] Istnieje minimalny test, który przed poprawką odtwarza problem.
- [ ] Authoring, IR, planner, runner i backend transportują pełny kontrakt.
- [x] Niewspierane konfiguracje kończą się fail-closed przed rozpoczęciem kroku.
- [x] Accepted/rejected/failure semantics są objęte fault-injection.
- [x] Physics oracle i/lub directional derivative przechodzą w zadanej tolerancji.
- [ ] CPU/GPU albo AoS/SoA parity przechodzi na poziomie pola, RHS, stage i kroku, jeśli dotyczy.
- [x] Telemetryka dowodzi liczby operatorów, transferów, synchronizacji i rebuildów.
- [ ] Steady-state performance gate nie wykazuje regresji ponad ustalony próg.
- [ ] Dokumentacja publiczna i qualification registry odzwierciedlają faktyczny status.
- [ ] PR zawiera wynik wszystkich wymaganych testów i dokładne provenance.

## 10. Ryzyka

- Pełny snapshot może być zbyt kosztowny; potrzebny minimalny journal.
- Asynchroniczne błędy CUDA wymagają jednoznacznej granicy synchronizacji.

## 11. Poza zakresem

- Rollback z awarii procesu lub urządzenia bez checkpointu.

## 12. Definition of Done

Ustalenie `FDM-GPU-TRX-001` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
