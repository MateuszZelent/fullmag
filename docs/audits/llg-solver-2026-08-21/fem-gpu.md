# Audyt solvera LLG — FEM GPU

**Repozytorium:** `MateuszZelent/fullmag`  
**Gałąź bazowa:** `master`  
**Data:** 2026-08-21  
**Metoda:** statyczny audyt kompletności device lane, host/device ownership, operatorów FEM, redukcji, integratora, fizyki i testów executed-device.

## Werdykt

FEM GPU należy klasyfikować według faktycznego poziomu rezydencji: (1) etykieta/planner GPU, (2) wybrane operatory FEM na urządzeniu przy hostowym sterowaniu, (3) pełny device-resident krok LLG. Tylko poziom trzeci uzasadnia nazwę produkcyjnego FEM GPU LLG. Najpoważniejszym ryzykiem jest ścieżka hybrydowa, w której każda ocena stage przechodzi przez hostowe GridFunction/Vector, redukcje, solver Krylov lub konfigurację operatora. Bez sprzętowego CI i operator receipts wsparcie GPU pozostaje niezakwalifikowane.

## Ustalenia priorytetowe

### Rejestr dowodów

| Ustalenie | Stan i pewność | Implementacja (`ścieżka + symbol`) | Test/reproducer |
|---|---|---|---|
| Executed-device proof | potwierdzone planowanie, kwalifikacja runtime otwarta | `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` — `gpu_rk_plan_device_resident`; `crates/fullmag-runner/src/types.rs` — `fem_gpu_rk_stage_exchange_device_resident` | `backends/fem/tests/gpu_rk_plan.cpp` plus managed GPU runtime receipt |
| Device-resident integrator | częściowo potwierdzone, wysoka | `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` — `gpu_rk_device_resident_step`; `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` — `context_step_explicit_rk_mfem` | strict no-fallback dla Heun, RK4, RK23 i RK45 |
| Trwałość danych FEM | potwierdzone struktury, wynik hot-loop otwarty | `backends/fem/gpu/cuda/state/gpu_state.cpp` — `gpu_state_initialize`; `backends/fem/include/context.hpp` — `Context` | `backends/fem/tests/gpu_state_runtime_contract.cpp` i profiler alokacji |
| Partial assembly/matrix-free | zależne od operatora, średnia | `backends/fem/gpu/cuda/exchange/exchange_plan.cpp` — `gpu_exchange_plan_stage_exchange` | `backends/fem/examples/pa_benchmark.cpp` dla macierzy rozmiarów/operatorów |
| Redukcje i transfery | potwierdzone liczniki, wynik runtime otwarty | `backends/fem/cpu/mfem/runtime/state_io.cpp` — `record_device_to_host`; `backends/fem/gpu/cuda/transfer/transfer_audit.hpp` — `TransferAuditRuntimeState` | `backends/fem/tests/transfer_audit.cpp` plus hardware strict-residency |
| Lokalizacja preconditionera | jawna dla planów demag, średnia | `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` — `initialize_demag_poisson_hypre_device_solver`, `configure_demag_poisson_hypre_preconditioner` | telemetryka backendu i sweep preconditionera bez host fallbacku |
| Mixed precision | luka kwalifikacyjna, średnia | `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` — `gpu_rk_plan_device_resident` | parity pola/RHS/kroku/trajektorii i time-to-accuracy |
| Stiffness explicit RK | luka pomiarowa, średnia | `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` — `gpu_rk_device_resident_step` | sweep `h_min` dla każdego wspieranego integratora |

### P0 — brak executed-device proof blokuje deklarację produkcyjną

Requested `gpu` nie wystarcza. Wynik musi potwierdzać urządzenie i implementację dla mass/exchange/demag/local fields, LLG algebra, integrator, redukcje i output.

**Naprawa:** hardware workflow, strict no-fallback, vendor/device/driver/precision receipt oraz test, który celowo uniemożliwia CPU execution.

### P0 — hostowy integrator lub Krylov może zdominować GPU operators

Jeśli wektory są odczytywane albo mapowane na host per stage/iteration, akceleracja operatora zostaje zjedzona przez PCIe/NVLink latency i synchronizacje.

**Naprawa:** trwałe device vectors, device-resident RK/tangent-plane control, urządzeniowe dot products/reductions i asynchroniczna telemetryka.

### P0/P1 — assembly, restrictions i quadrature data muszą być trwałe na urządzeniu

Rebuilding partial-assembly data, essential constraints, prolongation/restriction lub preconditioner w kroku LLG jest krytycznym defektem wydajności.

**Naprawa:** cache zależny od mesh/material/boundary revision; osobne setup/apply; jawne invalidation receipts.

### P1 — matrix-free/partial assembly powinno być domyślne dla repeated apply

Assembled sparse GPU może być uzasadnione dla niektórych operatorów, ale wielokrotne stage LLG zwykle korzystają z matrix-free/partial assembly, które ogranicza pamięć i transfery.

**Naprawa:** benchmark per operator i time-to-solution; wybór przez planner na podstawie order, DOF, device memory i expected stage count.

### P1 — redukcje i kryterium stopu nie mogą wymuszać synchronizacji globalnej per stage

Norma błędu, torque, energia i iteracje solvera powinny być agregowane na GPU. Odczyt kilku skalarów może być batchowany; odczyt pełnego pola jest niedopuszczalny.

### P1 — preconditioner musi mieć jawną lokalizację wykonania

GPU operator z hostowym preconditionerem lub hostowym sparse solve jest ścieżką hybrydową. Planner powinien nazwać ją `gpu_operator_host_solver`, nie `gpu` bez kwalifikatora.

### P1 — mixed precision wymaga kontroli solvera i dynamiki

Niższa precyzja może zwiększyć iteracje Krylov, pogorszyć energy/torque reductions i zmienić accept/reject. Należy optymalizować time-to-accuracy, nie FLOP/s.

### P1 — explicit RK nadal pozostaje ograniczony przez stiffness

GPU przyspiesza krok, ale nie usuwa ograniczenia `dt ~ h_min^2`. Dla wysokiego order i lokalnych refinement potrzebna jest kwalifikacja tangent-plane/semi-implicit/IMEX na urządzeniu.

## Audyt fizyczny

- identyczna słaba postać i warunki brzegowe jak FEM CPU;
- airbox/auxiliary DOF wykluczone z przestrzeni `m` i redukcji;
- zgodna konwencja `gamma`, `mu0`, `H/B` i mianownik Gilbert;
- norm projection na magnetycznych DOF bez niejawnego hostowego round-trip;
- poprawne material interfaces, periodic constraints i DMI boundary terms;
- termika z urządzeniowym RNG, poprawną wariancją i rollbackiem po rejected step.

## Audyt numeryczny

1. Parity na poziomie operator apply, RHS, stage, step i trajectory.
2. Test temporal order z kontrolą tolerancji solverów liniowych.
3. Norm/error reductions skalowane względem miary FEM, nie surowej liczby DOF.
4. Rejected step cofa wszystkie device buffers i RNG bez kopiowania pełnego stanu na host.
5. Preconditioner reuse nie może zmieniać operatora po zmianie mesh/material constraints.
6. Deterministyczność GPU reductions ma jawny tolerance policy.

## Plan optymalizacji

### Etap 1 — prawda o backendzie

- rozdzielić `gpu requested`, `gpu operator accelerated` i `device-resident`;
- receipts per operator i brak silent fallback;
- CI na rzeczywistym GPU.

### Etap 2 — trwały graph danych

- device vectors dla state/stages/fields;
- cache restrictions, quadrature, sparse/partial-assembly data i preconditioner;
- zero buffer creation/assembly w steady state.

### Etap 3 — sterowanie na urządzeniu

- device reductions i integrator control;
- batchowanie telemetryki;
- graph capture/command reuse;
- brak pełnego D2H/H2D per stage/iteration.

### Etap 4 — algorytm

- matrix-free/partial assembly selection;
- tangent-plane/IMEX dla stiffness;
- tolerancje Krylov zależne od błędu czasowego;
- mixed precision wyłącznie po time-to-accuracy qualification.

## Obowiązkowe benchmarki

Raportować: device memory, setup/assembly, apply, Krylov iterations, preconditioner location/rebuilds, kernels, synchronizations, H2D/D2H bytes, occupancy/bandwidth, accepted/rejected ratio oraz break-even względem FEM CPU dla tej samej dokładności.

## Minimalne testy akceptacyjne

- strict no-fallback i executed-device receipts;
- FEM CPU/GPU operator parity;
- macrospin, norm i damping-energy oracles;
- periodic/airbox/interface fixtures;
- brak assembly i pełnego readbacku w steady state;
- temporal/spatial refinement;
- solver/preconditioner tolerance sweep;
- GPU memory leak i repeated-session test.

## Ograniczenia

Bez rzeczywistego GPU i timeline nie można potwierdzić przyspieszenia. Jeżeli obecna implementacja obejmuje wyłącznie wybrane operatory, status powinien pozostać eksperymentalny lub operator-accelerated do czasu spełnienia pełnego device-resident gate.
