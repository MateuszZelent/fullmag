# FDM-GPU-PHY-001 — Pełne spięcie pól materiałowych i warunków DMI w CUDA

| Pole | Wartość |
|---|---|
| Lane | **FDM GPU** |
| Priorytet | **P1** |
| Klasa | `physics` |
| Status | `source/test remediated; global qualification pending` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FDM-GPU-ABI-001`, `FDM-CPU-PHY-001`, `FDM-CPU-PHY-002` |

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FDM-GPU-PHY-001`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

ABI przewiduje `Ms/A/alpha` oraz pola DMI, ale konstrukcja runnera i Context/hot kernels opierają się częściowo na scalar fallbackach. DMI boundary correction nie ma jednolitego pokrycia dla masek wewnętrznych i bulk DMI.

### Skutek

Jedna publiczna konfiguracja może wykonywać inną fizykę na CPU i GPU, szczególnie w heterogenicznych regionach i przy boundary twist.

### Stan remediacji 2026-08-29

- CUDA stosuje wspólną korektę brakujących ścian dla iDMI i bulk DMI w
  pojedynczej siatce oraz w staged multilayer RHS/observable. Korekta obejmuje
  granice otwarte i wewnętrzne granice aktywnej maski; osie periodyczne nie
  otrzymują sztucznej korekty brzegu.
- `Ms/A/alpha/Dind/Dbulk` pozostają kontraktem fail-closed, dopóki CUDA nie ma
  pełnej realizacji pól komórkowych. Backend natywny odrzuca je przed krokiem;
  nie są już traktowane jako rzekomo obsługiwane skalary.
- Receipt staged multilayer księguje rzeczywiście wykonane DMI, maski,
  oddziaływania multilayer, anizotropię i pole zewnętrzne. Maska wymagana
  uwzględnia również lokalne `layer.active_mask`, dzięki czemu brak dowodu nie
  może zostać sklasyfikowany jako CUDA.
- Zarządzana recepta `just verify-fdm-gpu-dmi-boundary-runtime` wykonała na
  NVIDIA GeForce RTX 3070 Laptop GPU testy FP64/FP32 dla single-grid oraz
  staged multilayer Heun/RK4/RK23. Niezależny oracle CPU pola, rzeczywisty krok,
  zero fallbacku, kompletna maska device i brak pełnych transferów/host compute
  w hot loop przeszły. Razem z kontraktem fail-closed: CTest **2/2**.
- `just verify-fdm-gpu-abi-contract` przeszedł: layout Rust **2/2**, natywny
  sentinel **1/1** i `cargo check -p fullmag-runner --features cuda`.

To zamyka błąd źródłowy i jego test regresyjny, ale nie promuje szerokiej
capability. Nadal brakuje hash-bound publicznego Python→IR→planner→runner E2E,
directional-derivative/energy parity na CUDA, sanitizera, reprezentatywnego
time-to-accuracy oraz szerszej macierzy łączonych interakcji.

## 3. Docelowy kontrakt

Planner albo dostarcza wszystkie spatial fields i CUDA je konsumuje w każdym członie, albo fail-closed dla niewspieranej kombinacji. BC DMI odpowiada wspólnemu funkcjonałowi energii.

Po naprawie kontrakt musi być jednoznaczny na czterech poziomach:

1. **authoring/IR** — użytkownik może wyrazić politykę bez utraty informacji;
2. **planner** — niewspierana kombinacja jest odrzucana przed wykonaniem;
3. **runtime/backend** — implementacja ma jednego właściciela stanu i jawne revisions;
4. **provenance** — wynik zawiera requested, resolved i executed realization.

## 4. Zakres kodu

| Ścieżka | Odpowiedzialność w naprawie |
|---|---|
| `native/include/fullmag_fdm.h` | ABI, stan runtime lub deklaracje |
| `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs` | orkiestracja, provenance i publikacja |
| `backends/fdm/api/c_api.cpp` | modyfikacja lub weryfikacja kontraktu |
| `backends/fdm/include/context.hpp` | ABI, stan runtime lub deklaracje |
| `backends/fdm/gpu/cuda/interactions` | operator fizyczny, pole lub energia |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Dokończyć owned backing storage i upload `ms_field/a_field/alpha_field/dind_field/dbulk_field`.
- Kernelle exchange, LLG, thermal, anisotropy, DMI i energy używają wspólnego device material accessor.
- Zdefiniować pair/interface rule dla A i D oraz mask boundary geometry.

### Etap C — integracja i migracja

- Dodać capability bits per spatial field i fail-closed w plannerze.
- Zsynchronizować energy kernels z field kernels przez directional derivative tests.
- Zapisać digest pól i boundary realization w provenance.

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

- Dwa regiony z ostrym skokiem Ms/A/alpha/D.
- Field, energy, RHS i trajectory parity CPU/GPU.
- DMI boundary twist i directional derivative.
- Inactive/background cells.
- Negative capability test.

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

- field parity error
- energy derivative residual
- unsupported-plan rejection count

Minimalne wymagania:

- brak nieplanowanych alokacji, assembly, plan creation albo pełnych transferów w steady-state hot loop;
- brak regresji time-to-accuracy poza zaakceptowanym budżetem;
- koszt diagnostyki pełnej nie może być ukryty w zwykłym kroku bez outputu;
- benchmark musi porównywać tę samą fizykę, siatkę, precision policy i błąd końcowy.

## 9. Kryteria akceptacyjne

- [x] Istnieje minimalny test, który przed poprawką odtwarza problem.
- [ ] Authoring, IR, planner, runner i backend transportują pełny kontrakt.
- [x] Niewspierane konfiguracje kończą się fail-closed przed rozpoczęciem kroku.
- [ ] Accepted/rejected/failure semantics są objęte fault-injection.
- [x] Physics oracle pola przechodzi w zadanej tolerancji.
- [ ] CPU/GPU albo AoS/SoA parity przechodzi na poziomie pola, RHS, stage i kroku, jeśli dotyczy.
- [x] Telemetryka dowodzi wykonania operatorów oraz braku pełnych transferów i host compute w badanym hot loop.
- [ ] Steady-state performance gate nie wykazuje regresji ponad ustalony próg.
- [ ] Dokumentacja publiczna i qualification registry odzwierciedlają faktyczny status.
- [ ] PR zawiera wynik wszystkich wymaganych testów i dokładne provenance.

## 10. Ryzyka

- Dodatkowe global loads mogą obniżyć throughput; potrzebne region LUT/constant-memory optymalizacje.

## 11. Poza zakresem

- Dowolne ciągłe pola materiałowe bez kosztu pamięci.

## 12. Definition of Done

Ustalenie `FDM-GPU-PHY-001` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
