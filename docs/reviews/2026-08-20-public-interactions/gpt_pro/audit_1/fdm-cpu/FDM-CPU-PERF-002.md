# FDM-CPU-PERF-002 — Usunięcie klonów i alokacji z gorącej pętli

| Pole | Wartość |
|---|---|
| Lane | **FDM CPU** |
| Priorytet | **P1** |
| Klasa | `performance` |
| Status | `implementation plan` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FDM-CPU-TRX-001`, `FDM-CPU-PERF-001` |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FDM-CPU-PERF-002`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

Runner i integratory wykonują `to_vec`, `clone`, materializację dynamicznych pól i kopie stanów próbnych w pętli kroków. Step-doubling i output mogą zwielokrotniać ruch O(N) niezależny od kosztu fizyki.

### Skutek

Presja na alokator, cache i bandwidth/NUMA ogranicza skalowanie CPU; koszt jest szczególnie widoczny dla dużych siatek i tanich konfiguracji bez demag.

## 3. Docelowy kontrakt

Po warm-up zaakceptowany krok FDM CPU ma zero dynamicznych alokacji i zero pełnych klonów poza jawnie zaplanowanym snapshotem outputu.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `crates/fullmag-engine/src/fdm/cpu/state.rs` | modyfikacja lub weryfikacja kontraktu |
| `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | integracja czasu i stan próby |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | orkiestracja, provenance i publikacja |
| `crates/fullmag-runner/src/solver_runtime` | orkiestracja, provenance i publikacja |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Rozszerzyć `IntegratorBuffers` o wszystkie trial/backup/error/dynamic-field buffers i rezerwować je przy tworzeniu sesji.
- Używać podwójnego bufora magnetyzacji i `swap` zamiast `to_vec`/kopii do nowego `Vec`.
- Dynamiczne pola przechowywać jako wersjonowany owned buffer aktualizowany in-place.

### Etap C — integracja i migracja

- Step-doubling wykonywać w dwóch prealokowanych stanach próbnych; nie klonować kompletnego solver state.
- Snapshot outputu przekazywać do writer queue tylko zgodnie ze stride; jawnie księgować jego koszt.
- Dodać testowy global allocator counter oraz `allocation_budget=0` po warm-up.

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

- Allocation-count test dla 100 kroków Heun/RK4/RK23/RK45.
- Peak RSS i retained-capacity test po wielu sesjach.
- Fault-injection potwierdzający, że reuse buforów nie psuje rollbacku.
- Test równoległych sesji eliminujący aliasing workspace.
- Benchmark memory bandwidth przed/po dla siatek małej, średniej i dużej.

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

- allocations/accepted step
- bytes copied/step
- peak RSS
- memory bandwidth
- NUMA remote reads

Minimalne wymagania:

- brak nieplanowanych alokacji, assembly, plan creation albo pełnych transferów w steady-state hot loop;
- brak regresji time-to-accuracy poza zaakceptowanym budżetem;
- koszt diagnostyki pełnej nie może być ukryty w zwykłym kroku bez outputu;
- benchmark musi porównywać tę samą fizykę, siatkę, precision policy i błąd końcowy.

## 9. Kryteria akceptacyjne

- [ ] Istnieje minimalny test, który przed poprawką odtwarza problem.
- [ ] Authoring, IR, planner, runner i backend transportują pełny kontrakt.
- [ ] Niewspierane konfiguracje kończą się fail-closed przed rozpoczęciem kroku.
- [ ] Accepted/rejected/failure semantics są objęte fault-injection.
- [ ] Physics oracle i/lub directional derivative przechodzą w zadanej tolerancji.
- [ ] CPU/GPU albo AoS/SoA parity przechodzi na poziomie pola, RHS, stage i kroku, jeśli dotyczy.
- [ ] Telemetryka dowodzi liczby operatorów, transferów, synchronizacji i rebuildów.
- [ ] Steady-state performance gate nie wykazuje regresji ponad ustalony próg.
- [ ] Dokumentacja publiczna i qualification registry odzwierciedlają faktyczny status.
- [ ] PR zawiera wynik wszystkich wymaganych testów i dokładne provenance.

## 10. Ryzyka

- Aliasowanie buforów między aktywną próbą i accepted state.
- Zbyt agresywny pooling utrzymujący nadmierny peak memory.

## 11. Poza zakresem

- Asynchroniczny zapis wszystkich formatów artefaktów w pierwszej iteracji.

## 12. Definition of Done

Ustalenie `FDM-CPU-PERF-002` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
