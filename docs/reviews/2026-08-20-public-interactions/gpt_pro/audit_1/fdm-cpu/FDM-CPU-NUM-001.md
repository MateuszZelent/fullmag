# FDM-CPU-NUM-001 — Naprawa kontrolera retry adaptacyjnego RK23/RK45

| Pole | Wartość |
|---|---|
| Lane | **FDM CPU** |
| Priorytet | **P0** |
| Klasa | `numerics` |
| Status | `implementation plan` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | brak twardych zależności |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FDM-CPU-NUM-001`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

W wariantach AoS, SoA i state-SoA adaptacyjnych RK23/RK45 odrzucona próba nie przypisuje zmniejszonego `dt` przed kolejną iteracją. Dla deterministycznego `error > tolerance` następna próba odtwarza identyczny stan, czas, krok i błąd, co może prowadzić do nieskończonej pętli. W tym samym module istnieje wspólny `decide_adaptive_step`, lecz nie wszystkie gorące ścieżki go używają.

### Skutek

Możliwy hang produkcyjnego solvera, brak reakcji na przerwanie aż do granicy zewnętrznej oraz brak poprawnej semantyki `dt_min_exhausted`. NaN/Inf w estymatorze może trafić do tej samej pętli.

## 3. Docelowy kontrakt

Jeden backend-neutralny kontroler akceptacji dla wszystkich reprezentacji i obu metod embedded. Każda odrzucona próba musi mieć ściśle mniejszy lub jawnie ograniczony `dt`, licznik retry i jednoznaczny typed failure.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | integracja czasu i stan próby |
| `crates/fullmag-engine/src/fdm/shared/types.rs` | modyfikacja lub weryfikacja kontraktu |
| `crates/fullmag-engine/src/fdm/cpu/state.rs` | modyfikacja lub weryfikacja kontraktu |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | orkiestracja, provenance i publikacja |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Wyodrębnić publicznie testowalny `AdaptiveStepController` ze stanem PI (`previous_error`, `max_reject`, `dt_min`, `dt_max`).
- Zastąpić lokalne gałęzie accept/reject w sześciu wariantach RK23/RK45 wywołaniem jednego kontrolera.
- Dla `Retry(dt_next)` przypisać `dt = dt_next`, zwiększyć `rejected_attempts`, wyzerować niedozwolony cache FSAL i rozpocząć nową próbę bez commitowania stanu.
- Odrzucać `!error.is_finite()` jako `AdaptiveErrorNonFinite`; nie przepuszczać NaN do porównań.

### Etap C — integracja i migracja

- Jeżeli `error > 1` przy `dt <= dt_min * (1 + eps)`, zwrócić `DtMinExhausted` bez akceptacji kandydata.
- Zapisywać bounded attempt trace: numer próby, `dt`, norma błędu, decyzja, `dt_next` i powód.
- Usunąć duplikację regulatora między AoS/SoA; reprezentacja stanu nie może wpływać na decyzję.

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

- Golden test kontrolera dla kilku błędów, poprzedniego błędu, clampów wzrostu i kurczenia.
- Reproducer z wymuszonym `error=4` sprawdzający, że druga próba ma mniejszy `dt`.
- Test timeoutowy dla RK23 i RK45 w AoS, SoA i state-SoA.
- Test NaN/Inf kończący się typed failure bez zmiany stanu.
- Test `dt_min_exhausted` potwierdzający brak commitowania magnetyzacji, czasu, historii i RNG.
- Parity attempt trace między AoS i SoA dla identycznego problemu.

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

- accepted/rejected attempts
- minimalny i maksymalny `dt`
- liczba RHS na zaakceptowany krok
- liczba zakończeń `dt_min_exhausted`

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

- Zmiana harmonogramu kroków może zmienić istniejące trajektorie adaptacyjne; należy wersjonować solver policy.
- Nie wolno aktualizować `previous_error` po odrzuconej próbie, jeśli kontrakt PI tego nie przewiduje.

## 11. Poza zakresem

- Zmiana tableau Bogacki–Shampine lub Dormand–Prince.
- Automatyczne promowanie projected RK do metody geometrycznej.

## 12. Definition of Done

Ustalenie `FDM-CPU-NUM-001` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
