# FDM-GPU-NUM-001 — Kanoniczna norma błędu adaptacyjnego na GPU

| Pole | Wartość |
|---|---|
| Lane | **FDM GPU** |
| Priorytet | **P1** |
| Klasa | `numerics` |
| Status | `implementation plan` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FDM-CPU-NUM-002`, `FDM-GPU-PERF-001` |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FDM-GPU-NUM-001`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

Device reductions muszą odpowiadać normie zdefiniowanej dla fizyki, a nie surowej liczbie komórek. Należy także jednoznacznie ustalić, czy błąd jest liczony przed czy po projekcji.

### Skutek

Zależność harmonogramu `dt` od rozmiaru siatki, różne decyzje CPU/GPU i niekontrolowane zachowanie FP32.

## 3. Docelowy kontrakt

Wspólna norma per-spin (max lub RMS/kątowa zgodnie z policy) z maską aktywną, skalą atol/rtol, guardami normy/rotacji i identycznym kontrolerem CPU/GPU.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu` | integracja czasu i stan próby |
| `backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu` | integracja czasu i stan próby |
| `backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu` | integracja czasu i stan próby |
| `backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu` | integracja czasu i stan próby |
| `crates/fullmag-engine/src/fdm/shared/types.rs` | modyfikacja lub weryfikacja kontraktu |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Przenieść definicję normy do wersjonowanego solver policy i mapować ją do CUDA descriptor.
- Redukować tylko aktywne, niefrozen spins; jawnie obsłużyć zero aktywnych komórek.
- Dla RMS dzielić przez liczbę aktywnych spinów na urządzeniu; dla max zachować per-vector normę.

### Etap C — integracja i migracja

- W FP32 akumulować krytyczne redukcje w FP64 lub kwalifikowanym compensated scheme.
- Zwracać Inf i typed numerical failure po wykryciu NaN.
- Zapisywać max norm defect i max spin rotation osobno od embedded error.

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

- Grid replication invariance normy.
- CPU/GPU golden error vectors.
- Mask/frozen-spin exclusion.
- FP32/FP64 decision parity w pobliżu progu.
- NaN injection i zero-active-domain.

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

- error norm
- max norm defect
- max spin rotation
- decision divergence count

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

- Zmiana normy wymaga nowego baseline tolerancji.
- RMS może ukryć lokalny outlier bez dodatkowego max guard.

## 11. Poza zakresem

- Automatyczne dobieranie tolerancji z fizycznych parametrów.

## 12. Definition of Done

Ustalenie `FDM-GPU-NUM-001` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
