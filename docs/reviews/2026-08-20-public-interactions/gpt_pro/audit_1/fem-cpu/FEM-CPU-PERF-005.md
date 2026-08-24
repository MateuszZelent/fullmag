# FEM-CPU-PERF-005 — Reuse operatora i warm-start demag Poissona/Airbox

| Pole | Wartość |
|---|---|
| Lane | **FEM CPU** |
| Priorytet | **P1** |
| Klasa | `performance` |
| Status | `implementation plan` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FEM-CPU-PERF-001`, `FEM-CPU-PERF-002` |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FEM-CPU-PERF-005`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

Demag jest rozwiązywany wielokrotnie w etapach RK. Operator zależy głównie od mesh/BC, natomiast RHS od m. Istnieje cache pola i initial-guess state, ale wymagany jest jednoznaczny lifecycle i kontrola świeżości.

### Skutek

Odbudowa setup lub zerowy guess w każdym stage zwielokrotnia najdroższy składnik FEM; zbyt agresywny field cache może z kolei zmienić równanie.

## 3. Docelowy kontrakt

Macierz, gauge, boundary operators i preconditioner są trwałe. Każdy stage aktualizuje RHS i używa kwalifikowanego warm-start. Frozen-field interval jest jawną aproksymacją z error/refresh policy.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `backends/fem/cpu/mfem/interactions/demag.cpp` | operator fizyczny, pole lub energia |
| `backends/fem/cpu/mfem/interactions/demag_poisson_cache.cpp` | operator fizyczny, pole lub energia |
| `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` | operator fizyczny, pole lub energia |
| `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | operator fizyczny, pole lub energia |
| `backends/fem/include/context.hpp` | ABI, stan runtime lub deklaracje |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Rozdzielić operator setup, RHS assembly, solve, recovery i energy phases w API i telemetryce.
- Cache operator key obejmuje mesh, Airbox realization, Robin factor, PBC/gauge i material membership.
- Warm-start używa poprzedniego stage/accepted solution, ale jest resetowany po reject/failure/operator change.

### Etap C — integracja i migracja

- Field refresh interval otrzymuje nazwę approximation policy i maksymalny lag/error guard.
- Energię końcową liczyć z polem odpowiadającym accepted state; nie publikować stale cached energy.
- Dodać adaptive linear tolerance tied to LLG local error.

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

- Setup count=1 przez wiele stage/kroków.
- Warm-start zmniejsza iteracje bez zmiany rozwiązania ponad tolerancję.
- Reject reset/restore initial guess.
- Airbox Dirichlet/Robin/FEM-BEM oracles.
- Frozen-field approximation error sweep.

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

- Poisson iterations/stage
- setup/reuse counts
- fresh-zero guesses
- demag time
- cache lag

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

- Warm-start z trial state po reject może pogorszyć lub zbiasować solve.
- Frozen field to zmiana modelu, nie czysta optymalizacja.

## 11. Poza zakresem

- Pomijanie demag bez jawnej approximation policy.

## 12. Definition of Done

Ustalenie `FEM-CPU-PERF-005` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
