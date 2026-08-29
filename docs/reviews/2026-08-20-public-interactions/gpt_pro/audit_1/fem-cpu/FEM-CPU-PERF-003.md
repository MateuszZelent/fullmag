# FEM-CPU-PERF-003 — Bez-alokacyjny snapshot pojedynczej próby adaptacyjnej

| Pole | Wartość |
|---|---|
| Lane | **FEM CPU** |
| Priorytet | **P1** |
| Klasa | `performance` |
| Status | `source/test remediation complete; qualification pending` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FEM-CPU-PERF-002` |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FEM-CPU-PERF-003`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

Każda adaptive attempt tworzy `std::make_unique<RkAttemptCacheSnapshot>` i głęboko kopiuje liczne wektory pól, cache oraz rozwiązania Poissona/FEM-BEM.

### Skutek

Najgorszy koszt pojawia się właśnie przy trudnych krokach z wieloma rejectami; allocator i memory bandwidth potęgują koszt solverów pola.

## 3. Docelowy kontrakt

Retry korzysta z prealokowanego attempt checkpointu o minimalnym zakresie. Derived caches są unieważniane, a nie kopiowane. Utworzenie kolejnej próby ma O(1) bookkeeping poza samym trial state.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `backends/fem/cpu/mfem/integrators/rk_step_transaction.cpp` | integracja czasu i stan próby |
| `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` | integracja czasu i stan próby |
| `backends/fem/include/context.hpp` | ABI, stan runtime lub deklaracje |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Zastąpić `unique_ptr` członem `StepperWorkspace::attempt_checkpoint` alokowanym w setup.
- Przechowywać tylko stan modyfikowany przed decyzją accept/reject: trial m, solver guess identity, RNG raw draw, callback transaction token.
- Derived fields z trial attempt nie mogą nadpisywać accepted cache; używać osobnych scratch buffers.

### Etap C — integracja i migracja

- Po reject resetować revision/guess policy i callback tokens bez kopiowania całego Context.
- Telemetry attempt counters zachować, ale nie przywracać ich wraz ze stanem.

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

- Allocation counter przy wielu wymuszonych rejectach.
- Attempt-cache payload budget zależny wyłącznie od koniecznych DOF.
- Po reject accepted fields/snapshot pozostają niezmienione.
- Poisson warm-start policy test.
- Transport/Oersted rollback callback test.

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

- attempt snapshot bytes
- allocations/reject
- reject overhead
- cache invalidations

Minimalne wymagania:

- brak nieplanowanych alokacji, assembly, plan creation albo pełnych transferów w steady-state hot loop;
- brak regresji time-to-accuracy poza zaakceptowanym budżetem;
- koszt diagnostyki pełnej nie może być ukryty w zwykłym kroku bez outputu;
- benchmark musi porównywać tę samą fizykę, siatkę, precision policy i błąd końcowy.

## 9. Kryteria akceptacyjne

- [x] Istnieje minimalny test, który przed poprawką odtwarza problem.
- [ ] Authoring, IR, planner, runner i backend transportują pełny kontrakt.
- [ ] Niewspierane konfiguracje kończą się fail-closed przed rozpoczęciem kroku.
- [x] Accepted/rejected/failure semantics są objęte fault-injection.
- [x] Physics oracle i/lub directional derivative przechodzą w zadanej tolerancji.
- [ ] CPU/GPU albo AoS/SoA parity przechodzi na poziomie pola, RHS, stage i kroku, jeśli dotyczy.
- [ ] Telemetryka dowodzi liczby operatorów, transferów, synchronizacji i rebuildów.
- [ ] Steady-state performance gate nie wykazuje regresji ponad ustalony próg.
- [x] Dokumentacja publiczna i qualification registry odzwierciedlają faktyczny status.
- [ ] PR zawiera wynik wszystkich wymaganych testów i dokładne provenance.

## 10. Ryzyka

- Zbyt mały checkpoint może pozostawić solver guess z trial state.
- Zbyt agresywne invalidation zwiększy koszt następnej próby.

## 11. Poza zakresem

- Usunięcie całej fault-injection infrastruktury.

## 12. Definition of Done

Ustalenie `FEM-CPU-PERF-003` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.

## 13. Wynik remediacji źródłowej i testowej — 2026-08-29

Audyt aktualnego call graphu potwierdził, że produkcyjny builder kontekstu już
tworzył `StepperWorkspace::attempt_checkpoint` w setupie, a `capture()` nie
kopiował payloadu O(N). Pozostawała jednak druga realizacja: gdy checkpointu
brakowało, `context_step_explicit_rk_mfem()` tworzył
`fallback_attempt_cache` podczas publicznego kroku. Była to ukryta alokacja i
silent fallback sprzeczny z docelowym kontraktem.

Test RED zakończył się komunikatem:

```text
FAIL: adaptive RK step execution must not allocate a compatibility checkpoint
```

Fallback został usunięty. Adaptive RK23/RK45 używa wyłącznie obiektu
utworzonego podczas setupu; brak obiektu kończy się jednoznacznym błędem przed
rozpoczęciem pętli prób. Dodano `attempt_cache_allocation_count`, a test z
wymuszonymi rejectami potwierdza jednocześnie:

- ten sam adres checkpointu przed i po wszystkich próbach;
- `attempt_cache_allocation_count == 0` w mierzonym hot loop;
- `attempt_cache_snapshot_payload_bytes == 0`;
- `attempt_cache_restore_payload_bytes == 0`;
- dokładnie jeden capture na próbę i jeden restore na reject;
- zachowanie accepted state oraz zgodność endpointu z niezależnym oracle RK.

Naprawiono również ujawnioną przez GREEN regresję telemetrii: checkpoint nie
zapamiętuje już stanu profilera z chwili setupu. Capture i restore odczytują
bieżącą politykę profilowania, dlatego włączenie profilera po utworzeniu
kontekstu nie gubi liczników retry.

Managed `just verify-fem-gpu-rk-transaction-contract` przeszedł:

- CTest: **5/5**;
- `fullmag-fem-sys`: **41/41**;
- `cargo check -p fullmag-runner`: PASS;
- mixed-P1 PGBB/NCG dla `exchange_only` i `device_hypre`: PASS.

Remediacja źródłowa/testowa jest zakończona. Status pozostaje
`qualification pending`, ponieważ osobny hash-bound publiczny E2E/provenance
oraz benchmark reject overhead/time-to-accuracy na reprezentatywnej siatce nie
zostały jeszcze wykonane. Capability nie została promowana.
