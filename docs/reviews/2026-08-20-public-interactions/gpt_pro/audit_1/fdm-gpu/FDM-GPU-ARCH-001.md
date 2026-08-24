# FDM-GPU-ARCH-001 — Strict device-resident LLG i zakaz niejawnego fallbacku

| Pole | Wartość |
|---|---|
| Lane | **FDM GPU** |
| Priorytet | **P0** |
| Klasa | `architecture` |
| Status | `implementation plan` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FDM-GPU-ABI-001` |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FDM-GPU-ARCH-001`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

Samo `device=gpu` lub obecność operatora CUDA nie dowodzi, że integrator, redukcje, adaptacja i output wykonują się na urządzeniu. Hybrydowa ścieżka może być prezentowana jako GPU bez operator-level receipts.

### Skutek

Nieporównywalne wyniki wydajności, ryzyko niejawnego użycia CPU oraz brak możliwości odtworzenia faktycznie wykonanego backendu.

## 3. Docelowy kontrakt

Resolved plan klasyfikuje wykonanie jako `device_resident`, `gpu_operator_host_control`, `hybrid` lub `cpu`. Tryb strict akceptuje wyłącznie pierwszą klasę i dostarcza receipts dla każdego operatora.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `crates/fullmag-plan/src/fdm.rs` | planowanie, walidacja i transport konfiguracji |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | orkiestracja, provenance i publikacja |
| `crates/fullmag-runner/src/types.rs` | orkiestracja, provenance i publikacja |
| `backends/fdm/api/c_api.cpp` | modyfikacja lub weryfikacja kontraktu |
| `native/include/fullmag_fdm.h` | ABI, stan runtime lub deklaracje |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Rozszerzyć resolved execution o enum execution class i per-operator location.
- Backend native powinien raportować device id, precision, integrator implementation, FFT library, reduction/control location i fallback count.
- W strict mode każda niedostępna funkcja kończy plan przed alokacją; nie wolno przechodzić do reference CPU.

### Etap C — integracja i migracja

- Dodać capability handshake po utworzeniu kontekstu i zweryfikować go względem requested plan.
- Publikować receipts w provenance sesji i step stats.
- Dodać test, który blokuje CPU lane i nadal wykonuje poprawny GPU step; osobny test wymusza brak capability i oczekuje fail-closed.

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

- Requested/resolved/executed identity test.
- Strict no-fallback test z wyłączonym CPU backendem.
- Operator receipt matrix dla exchange, demag, DMI, anisotropy, LLG, integratora i redukcji.
- Negative test niekompletnego capability handshake.
- Hardware smoke potwierdzający device utilization i brak pełnego transferu.

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

- fallback count
- operator location receipts
- H2D/D2H bytes
- host sync count

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

- Zmiana może ujawnić, że część obecnych konfiguracji nie jest strict-GPU i przestanie się uruchamiać.

## 11. Poza zakresem

- Zakaz jawnie wybranego trybu hybrydowego do diagnostyki.

## 12. Definition of Done

Ustalenie `FDM-GPU-ARCH-001` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
