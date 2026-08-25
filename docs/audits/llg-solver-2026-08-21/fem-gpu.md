# Audyt solvera LLG — FEM GPU

**Repozytorium:** `MateuszZelent/fullmag`
**Gałąź bazowa:** `master`
**Audytowana rewizja źródeł:** [`969efa0941905825ac569d525f4bdaefc059e2af`](https://github.com/MateuszZelent/fullmag/tree/969efa0941905825ac569d525f4bdaefc059e2af)
**Data:** 2026-08-21
**Metoda:** statyczny audyt kompletności device lane, host/device ownership, operatorów FEM, redukcji, integratora, fizyki i testów executed-device.

## Werdykt

FEM GPU należy klasyfikować według faktycznego poziomu rezydencji: (1) etykieta/planner GPU, (2) wybrane operatory FEM na urządzeniu przy hostowym sterowaniu, (3) pełny device-resident krok LLG. Tylko poziom trzeci uzasadnia nazwę produkcyjnego FEM GPU LLG. Audytowana rewizja zawiera fail-closed plan, attempt-scoped execution receipt, kontrolę transferów hot loop oraz publikację zweryfikowanego receipt do provenance. Jest to statyczny dowód implementacji kontraktu, ale nie sprzętowa kwalifikacja całego lane; bez zielonego managed GPU workflow i rzeczywistych receiptów dla reprezentatywnych operatorów status produkcyjny pozostaje niepotwierdzony.

## Ustalenia priorytetowe

### Rejestr dowodów

| Ustalenie | Stan i pewność | Implementacja (`ścieżka + symbol`) | Test/reproducer |
|---|---|---|---|
| Executed-device proof | fail-closed receipt i walidacja potwierdzone statycznie; kwalifikacja sprzętowa otwarta | `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` — `gpu_execution_receipt_commit_attempt`; `crates/fullmag-runner/src/fem/execution_receipt.rs` — `validate_strict_fem_gpu_execution_receipt` | `backends/fem/tests/gpu_strict_execution_contract.cpp` plus managed GPU runtime receipt |
| Device-resident integrator | częściowo potwierdzone, wysoka | `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` — `gpu_rk_plan_device_resident`; `backends/fem/gpu/cuda/integrators/rk/rk_step.cu` — `gpu_rk_device_resident_step`; `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` — `context_step_explicit_rk_mfem` | strict no-fallback dla Heun, RK4, RK23 i RK45 |
| Trwałość danych FEM | potwierdzone struktury, wynik hot-loop otwarty | `backends/fem/gpu/cuda/state/gpu_state.cpp` — `gpu_state_initialize`; `backends/fem/include/context.hpp` — `Context` | `backends/fem/tests/gpu_state_runtime_contract.cpp` i profiler alokacji |
| Partial assembly/matrix-free | zależne od operatora, średnia | `backends/fem/gpu/cuda/exchange/exchange_plan.cpp` — `gpu_exchange_plan_stage_exchange` | `backends/fem/examples/pa_benchmark.cpp` dla macierzy rozmiarów/operatorów |
| Redukcje i transfery | potwierdzone liczniki, wynik runtime otwarty | `backends/fem/cpu/mfem/runtime/state_io.cpp` — `record_device_to_host`; `backends/fem/gpu/cuda/transfer/transfer_audit.hpp` — `TransferAuditRuntimeState` | `backends/fem/tests/transfer_audit.cpp` plus hardware strict-residency |
| Lokalizacja preconditionera | jawna dla planów demag, średnia | `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` — `initialize_demag_poisson_hypre_device_solver`, `configure_demag_poisson_hypre_preconditioner` | telemetryka backendu i sweep preconditionera bez host fallbacku |
| Single/mixed precision | single obecnie nieobsługiwane, wysoka | `crates/fullmag-runner/src/native_fem/tests/runtime_smoke.rs` — `native_fem_single_precision_rejection_is_gpu_specific` | najpierw zachować jawne odrzucenie; po przyszłej implementacji osobno parity i time-to-accuracy |
| Stiffness explicit RK | luka pomiarowa, średnia | `backends/fem/gpu/cuda/integrators/rk/rk_step.cu` — `gpu_rk_device_resident_step` | sweep `h_min` dla każdego wspieranego integratora |

### P0 — sprzętowy executed-device proof nadal blokuje deklarację produkcyjną

Requested `gpu` nie wystarcza. Audytowana implementacja odrzuca receipt z hostowym lub nieznanym operatorem, fallbackiem, transferem hot loop, brakującym wymaganym operatorem albo bez zaakceptowanego kroku i publikuje zweryfikowany receipt do provenance. Nadal potrzebny jest wynik z rzeczywistego urządzenia, który potwierdza mass/exchange/demag/local fields, LLG algebra, integrator, redukcje i output dla kwalifikowanego przypadku.

**Naprawa:** utrzymać hardware workflow, strict no-fallback, vendor/device/driver/precision receipt oraz test, który celowo uniemożliwia CPU execution; archiwizować zweryfikowany receipt jako dowód kwalifikacji, nie tylko dowód istnienia kodu.

### P0 — hostowy integrator lub Krylov może zdominować GPU operators

Jeśli wektory są odczytywane albo mapowane na host per stage/iteration, akceleracja operatora zostaje zjedzona przez PCIe/NVLink latency i synchronizacje.

**Naprawa:** trwałe device vectors, device-resident RK oraz urządzeniowe dot products/reductions i asynchroniczna telemetryka. Bieżący `tangent_plane_implicit` jest wyłącznie CPU/MFEM algorytmem relaksacji pseudoczasowej, nie fizyczno-czasowym integratorem GPU.

### P0/P1 — assembly, restrictions i quadrature data muszą być trwałe na urządzeniu

Rebuilding partial-assembly data, essential constraints, prolongation/restriction lub preconditioner w kroku LLG jest krytycznym defektem wydajności.

**Naprawa:** cache zależny od mesh/material/boundary revision; osobne setup/apply; jawne invalidation receipts.

### P1 — matrix-free/partial assembly powinno być domyślne dla repeated apply

Assembled sparse GPU może być uzasadnione dla niektórych operatorów, ale wielokrotne stage LLG zwykle korzystają z matrix-free/partial assembly, które ogranicza pamięć i transfery.

**Naprawa:** benchmark per operator i time-to-solution; wybór przez planner na podstawie order, DOF, device memory i expected stage count.

### P1 — redukcje i kryterium stopu nie mogą wymuszać synchronizacji globalnej per stage

Norma błędu, torque, energia i iteracje solvera powinny być agregowane na GPU. Odczyt kilku skalarów może być batchowany; odczyt pełnego pola jest niedopuszczalny.

### P1 — preconditioner musi mieć jawną lokalizację wykonania

GPU operator z hostowym preconditionerem lub hostowym sparse solve jest ścieżką hybrydową. Planner i provenance muszą używać istniejącego, ograniczonego słownika kontraktu wykonania: między innymi `device_resident`, `hybrid_cpu_poisson` oraz obowiązujących pól FEM GPU execution contract. Audyt nie wprowadza wartości `gpu_operator_host_solver`; nowa wartość wymagałaby wspólnej zmiany ProblemIR, macierzy capability, runtime provenance i wszystkich konsumentów.

### P1 — single precision wymaga najpierw implementacji, potem kwalifikacji

Bieżący planner/runtime jawnie odrzuca FEM GPU `execution_precision="single"`, ponieważ kernels tej ścieżki nie istnieją. Nie jest to wykonywalny lane oczekujący jedynie parity. Po przyszłej implementacji niższa precyzja będzie wymagała kontroli iteracji Krylov, energy/torque reductions, accept/reject i time-to-accuracy.

### P1 — explicit RK nadal pozostaje ograniczony przez stiffness

GPU przyspiesza krok, ale nie usuwa ograniczenia `dt ~ h_min^2`. Fizyczno-czasowy tangent-plane/semi-implicit/IMEX na urządzeniu jest planowaną, obecnie nieobsługiwaną capability; nie należy utożsamiać go z istniejącym relaksacyjnym TPI CPU.

## Audyt fizyczny

- identyczna słaba postać i warunki brzegowe jak FEM CPU;
- airbox/auxiliary DOF wykluczone z przestrzeni `m` i redukcji;
- zgodna konwencja `gamma`, `mu0`, `H/B` i mianownik Gilbert;
- norm projection na magnetycznych DOF bez niejawnego hostowego round-trip;
- poprawne material interfaces, periodic constraints i DMI boundary terms;
- termika FEM GPU pozostaje obecnie nieobsługiwaną kombinacją publiczną: strict planning odrzuca `CAP-THERM-GPU-001`; wymagany jest test tego odrzucenia, a rollback RNG nie jest bieżącą ścieżką wykonawczą lane.

## Audyt numeryczny

1. Parity na poziomie operator apply, RHS, stage, step i trajectory.
2. Test temporal order z kontrolą tolerancji solverów liniowych.
3. Adaptacyjna redukcja błędu zachowuje kanoniczne maksimum po aktywnych węzłach; normy ważone miarą FEM są wyłącznie odrębną diagnostyką globalną.
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
- przyszły fizyczno-czasowy tangent-plane/IMEX dla stiffness, po implementacji capability;
- tolerancje Krylov zależne od błędu czasowego;
- single/mixed precision dopiero po implementacji lane i time-to-accuracy qualification.

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

(fem-gpu-problem-statement)=
## Kontrakt publikacyjny lane FEM GPU

Audyt ocenia rezydencję, routing i receipts realizacji FEM GPU bez utożsamiania operator acceleration z pełnym krokiem GPU.

(fem-gpu-governing-equations)=
### Równania kanoniczne

Wspólne równanie LLG należy do `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`; raport mapuje jedynie realizację urządzeniową.

(fem-gpu-symbols-and-si-units)=
### Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $H_{\mathrm{eff}}$ | efektywne pole magnetyczne na aktywnych DOF | $\mathrm{A\,m^{-1}}$ |
| $\Delta t$ | krok czasu integratora | $\mathrm{s}$ |

(fem-gpu-assumptions-and-validity)=
### Założenia i zakres ważności

Produkcję dowodzi wyłącznie strict hardware runtime z device identity; termika FEM GPU jest obecnie odrzucana przez publiczny planner.

(fem-gpu-python-api)=
### Python API

Raport nie dodaje publicznego konstruktora. Poniższy scenariusz stage-first przechodzi przez publiczny DSL; launcher może go załadować w trybie lightweight, aby wykonać lowering ProblemIR i planowanie FEM GPU bez uruchamiania długiego solve:

```python
# %%
import fullmag as fm

nm = 1.0e-9
study = fm.study("llg_audit_fem_gpu")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(32 * nm, 32 * nm, 8 * nm))
study.universe.mesh(maximum_element_size=16 * nm)
magnet = study.geometry(fm.Box(size=(24 * nm, 24 * nm, 4 * nm), name="audit_fem_gpu"), name="audit_fem_gpu")
magnet.Ms = 8.0e5
magnet.Aex = 13.0e-12
magnet.alpha = 0.1
magnet.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
magnet.mesh(maximum_element_size=8 * nm, order=1)
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1.0e-8, max_iterations=20)
study.build_domain_mesh()
study.stages.add_relax(stage_id="audit", algorithm="projected_gradient_bb", tolT=5.0e-9, max_steps=1)
```

(fem-gpu-problem-ir)=
### ProblemIR

Raport nie dodaje wartości capability ani residency; używa wyłącznie istniejącego słownika kontraktu.

(fem-gpu-round-trip-and-failure-semantics)=
### Round-trip i błędy

`requested intent` pozostaje oddzielony od `resolved execution`. `validation errors` zachowują intencję, a `unsupported combinations`, w tym `CAP-THERM-GPU-001`, są jawnie odrzucane.

(fem-gpu-discrete-realization)=
### Realizacja dyskretna

| Solver | CPU | GPU | Status na tej stronie |
|---|---|---|---|
| FEM | nie | tak | lane FEM GPU udokumentowany |
| FDM | nie | nie | lane FDM CPU/GPU mają osobne raporty |

(fem-gpu-implementation-mapping)=
### Mapowanie implementacji

Plan rezydentnego kroku jest własnością `gpu_rk_plan_device_resident`.

(fem-gpu-validation)=
### Walidacja

Wymagane są strict no-fallback, receipt urządzenia, wszystkie legalne integratory i managed GPU runtime.

(fem-gpu-limitations)=
### Ograniczenia publikacyjne

Statyczny kod nie dowodzi produkcyjnej rezydencji ani przyspieszenia.

(fem-gpu-scientific-bibliography)=
### Bibliografia naukowa

1. W. F. Brown Jr., “Micromagnetics,” Wiley (1963), https://doi.org/10.1002/9780470172914.

(fem-gpu-source-code-index)=
### Indeks kodu źródłowego

| Twierdzenie | Ścieżka | Symbol | Odpowiedzialność | Lane | Test/dowód | Status |
|---|---|---|---|---|---|---|
| Plan device-resident RK | `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` | `gpu_rk_plan_device_resident` | planowanie rezydentnego kroku FEM GPU | FEM GPU | testy planu i managed runtime | dowód statyczny; runtime wymaga GPU |
| Device-resident step | `backends/fem/gpu/cuda/integrators/rk/rk_step.cu` | `gpu_rk_device_resident_step` | wykonanie kroku RK | FEM GPU | `gpu_rk_plan` plus managed receipt | dowód statyczny; hardware gate wymagany |
| GPU state | `backends/fem/gpu/cuda/state/gpu_state.cpp` | `gpu_state_initialize` | trwały state urządzenia | FEM GPU | `gpu_state_runtime_contract` | test kontraktu |
| Exchange plan | `backends/fem/gpu/cuda/exchange/exchange_plan.cpp` | `gpu_exchange_plan_stage_exchange` | kwalifikacja device exchange | FEM GPU | `gpu_rk_plan` | test planu |
| Transfer audit | `backends/fem/gpu/cuda/transfer/transfer_audit.cpp` | `record_device_to_host` | licznik D2H | FEM GPU | `transfer_audit` plus hardware gate | test kontraktu; wynik hardware otwarty |
| Device demag solver | `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `initialize_demag_poisson_hypre_device_solver` | lokalizacja solvera/preconditionera | FEM GPU | `cuda_periodic_demag_contract` | dowód statyczny |
| Single precision rejection | `crates/fullmag-runner/src/native_fem/tests/runtime_smoke.rs` | `native_fem_single_precision_rejection_is_gpu_specific` | jawne odrzucenie niezaimplementowanego lane | FEM GPU | ten sam test | test regresji |
| TPI GPU rejection | `crates/fullmag-runner/src/fem/relax/algorithm.rs` | `tangent_plane_implicit_is_not_reported_as_gpu_supported` | relaksacyjny TPI pozostaje poza GPU capability | FEM GPU | ten sam test | test regresji |
