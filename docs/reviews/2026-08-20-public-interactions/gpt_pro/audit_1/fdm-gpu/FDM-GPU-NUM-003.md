# FDM-GPU-NUM-003 — Wyłączenie FSAL dla termiki i niezgodnych źródeł zależnych od czasu

| Pole | Wartość |
|---|---|
| Lane | **FDM GPU** |
| Priorytet | **P0** |
| Klasa | `numerics` |
| Status | `source/test remediated; global qualification open` |
| Pewność ustalenia | `high` |
| Audytowany snapshot | `04e362df5dd51b1e6acca3aab9033c8124d3d6d0` |
| Zależności | `FDM-GPU-TRX-001` |

## Stan implementacji — 2026-08-28

Stan ogólny: **SOURCE/TEST REMEDIATED, GLOBAL QUALIFICATION OPEN**. Kontrakt
źródłowy, ABI i bounded wykonanie na prawdziwym urządzeniu CUDA zostały
potwierdzone. Publiczna capability pozostaje `source_visible/unvalidated`, bo
ten dowód nie obejmuje pełnego Python--IR--runner E2E ani produkcyjnego
time-to-accuracy dla całej macierzy interakcji.

- `rhs_allows_fsal_reuse` jest jednym właścicielem decyzji dla RK23/DP45,
  FP32/FP64 i odrzuca termikę, nieznaną lub zmienioną tożsamość źródła,
  waveform, transport, projection oraz realization.
- Udany import checkpointu v3 zachowuje accepted stochastic identity, lecz
  zawsze unieważnia cache FSAL z typed reason `CHECKPOINT_RESTORE`.
- Append-only `fullmag_fdm_fsal_telemetry_v2` zachowuje ABI v1 i publikuje
  osobne liczniki dla każdego stabilnego reason code; odmowa reuse jest liczona
  dokładnie raz, bez podwójnego naliczania podczas accepted stage.
- Natywny build CPU-off, kontrakty FSAL/termiki/time-policy i linkowany test
  layoutu C/Rust przechodzą. Windows DLL generuje import library przez
  `WINDOWS_EXPORT_ALL_SYMBOLS`; buildy pozostają poza repozytorium.
- Managed CUDA 12.4 na RTX 3070 Laptop GPU przeszedł RK23/DP45 w FP64/FP32.
  Analityczny macrospin potwierdził trajektorię deterministyczną; każdy wariant
  oszczędził dokładnie 19 RHS na 20 kroków, bez rollbacku i fallbacku.
- Brown thermal i dynamiczny Oersted zaakceptowały po dwa kroki w każdym
  wariancie, nigdy nie użyły FSAL i raportowały dokładnie `THERMAL_ACTIVE` lub
  `WAVEFORM_DISCONTINUITY`; licznik losowań Browna rósł per accepted interval.
- Receipt `fullmag.fdm_gpu.fsal_thermal.runtime.v1` jest źródłowo związany z
  commitem i hashem diffu, zawiera device identity, requested/resolved/executed
  backend oraz puste `fallback_trail`. Artefakt i build pozostają poza Git.
- Pełny publiczny E2E, szersza stochastic-statistical qualification oraz
  produkcyjny time-to-accuracy pozostają **NOT VERIFIED**; nie promowano lane.

## 1. Cel dokumentu

Ten plik jest wykonawczym planem zamknięcia ustalenia `FDM-GPU-NUM-003`. Nie opisuje jedynie kierunku refaktoryzacji: definiuje docelowy invariant, właścicieli danych, wymagane zmiany w kodzie, testy regresyjne, dowody fizyczne i numeryczne oraz kryteria promocji do statusu produkcyjnego.

Zmiana nie może zostać uznana za zakończoną na podstawie samego przejścia kompilacji albo smoke testu. Wymagany jest dowód, że publiczny requested plan dotarł do naprawionej implementacji i że nie został zastąpiony fallbackiem.

## 2. Problem i mechanizm błędu

RK23/RK45 może zachować końcowy RHS jako początkowy RHS następnego kroku. Przy aktywnej termice kolejny accepted interval wymaga nowej realizacji szumu, więc reuse poprzedniego RHS jest fizycznie błędny. Podobnie FSAL jest nieważny po zmianie revision źródła lub discontinuity event.

### Skutek

Pierwszy stage nowego kroku używa starego szumu/pola, co jakościowo zmienia stochastic LLG i może przesunąć adaptację.

## 3. Docelowy kontrakt

Jedna funkcja `rhs_allows_fsal_reuse` uwzględnia termikę, dynamic source revision, transport state, projection policy i accepted endpoint identity. Brak pewności oznacza invalidation.

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
| `backends/fdm/include/context.hpp` | ABI, stan runtime lub deklaracje |

Lista jest punktem startowym. Implementujący powinien wykonać wyszukiwanie symboli oraz call graph od publicznego planu do gorącej pętli, aby nie pozostawić drugiej, niespójnej realizacji.

## 5. Plan implementacji

### Etap A — kontrakt i reproducer

- Dodać minimalny test odtwarzający defekt przed zmianą implementacji.
- Zapisać oczekiwany invariant, jednostki, source-of-truth i granicę commit/rollback.
- Dodać lub rozszerzyć typed telemetry tak, aby test potwierdzał wykonanie właściwej ścieżki.

### Etap B — implementacja rdzenia

- Dodać centralną politykę FSAL analogiczną do utrzymywanej ścieżki FEM GPU.
- Bezwarunkowo unieważniać FSAL dla `temperature>0` w obecnej realizacji szumu.
- Unieważniać po rejected attempt, checkpoint restore, zmianie field/transport revision i zdarzeniu waveform.

### Etap C — integracja i migracja

- FSAL cache przechowuje state/time/source revision; reuse wymaga exact match.
- Publikować `fsal_reused` i reason code.

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

- Termika: zero FSAL reuse i poprawny draw nowego interval.
- Deterministyczny stały problem: FSAL reuse działa i oszczędza jeden RHS.
- Dynamic Oersted/drive event invalidates cache.
- Reject i restart invalidation.
- CPU/GPU trajectory parity.

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

- FSAL reuse count
- invalidation reason counts
- RHS saved/step

Minimalne wymagania:

- brak nieplanowanych alokacji, assembly, plan creation albo pełnych transferów w steady-state hot loop;
- brak regresji time-to-accuracy poza zaakceptowanym budżetem;
- koszt diagnostyki pełnej nie może być ukryty w zwykłym kroku bez outputu;
- benchmark musi porównywać tę samą fizykę, siatkę, precision policy i błąd końcowy.

## 9. Kryteria akceptacyjne

- [x] Istnieje minimalny test, który przed poprawką odtwarza problem.
- [x] Authoring, IR, planner, runner i backend transportują pełny kontrakt.
- [x] Niewspierane konfiguracje kończą się fail-closed przed rozpoczęciem kroku.
- [x] Accepted/rejected/failure semantics są objęte fault-injection.
- [x] Physics oracle i/lub directional derivative przechodzą w zadanej tolerancji.
- [ ] CPU/GPU albo AoS/SoA parity przechodzi na poziomie pola, RHS, stage i kroku, jeśli dotyczy.
- [x] Telemetryka dowodzi liczby operatorów, transferów, synchronizacji i rebuildów.
- [ ] Steady-state performance gate nie wykazuje regresji ponad ustalony próg.
- [x] Dokumentacja publiczna i qualification registry odzwierciedlają faktyczny status.
- [x] PR zawiera wynik wszystkich wymaganych testów i dokładne provenance.

## 10. Ryzyka

- Nadmiernie konserwatywna polityka zmniejszy wydajność, ale zachowa poprawność.

## 11. Poza zakresem

- Stochastic FSAL scheme o specjalnie skorelowanym szumie.

## 12. Definition of Done

Ustalenie `FDM-GPU-NUM-003` jest zamknięte dopiero wtedy, gdy:

1. naprawiona ścieżka jest jedyną produkcyjną realizacją tego kontraktu albo stara ścieżka jest jawnie oznaczona jako legacy;
2. test reprodukujący nie może przejść przez fallback;
3. wynik fizyczny i numeryczny przechodzi niezależny oracle;
4. hot-loop telemetry spełnia budżet;
5. capability jest promowana w rejestrze wyłącznie dla dokładnie przetestowanych kombinacji backendu, precision, integratora i interakcji.
