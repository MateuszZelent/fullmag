# Audyt solvera LLG — FDM GPU

**Repozytorium:** `MateuszZelent/fullmag`  
**Gałąź bazowa:** `master`  
**Data:** 2026-08-21  
**Metoda:** statyczny audyt ścieżki GPU, kontraktów planner/runtime, pamięci, synchronizacji, fizyki i numeryki. Rzeczywistą wydajność musi potwierdzić timeline na docelowym GPU.

## Werdykt

Najważniejszym kryterium nie jest obecność kerneli FDM, lecz pełna rezydencja kroku LLG na urządzeniu. Akcelerowany exchange lub demag przy hostowym RK, normie błędu, kryterium stopu i telemetryce może być wolniejszy od CPU dla małych i średnich siatek. Ścieżka nie jest produkcyjnym „FDM GPU LLG”, dopóki provenance nie potwierdza executed device dla każdego operatora, a profil nie wykazuje braku pełnych readbacków i barier per stage.

## Ustalenia priorytetowe

### Rejestr dowodów

| Ustalenie | Stan i pewność | Implementacja (`ścieżka + symbol`) | Test/reproducer |
|---|---|---|---|
| Requested/resolved/executed GPU | potwierdzone dla kontraktu receipt, wysoka | `backends/fdm/api/c_api.cpp` — `fullmag_fdm_backend_execution_receipt_v2`; `crates/fullmag-runner/src/types.rs` — `FdmGpuExecutionReceipt` | `fdm_gpu_execution_receipt_contract_tests` oraz `backends/fdm/tests/device_residency_receipt_contract.cpp` |
| Transfery i synchronizacje hot loop | potwierdzone liczniki, wynik sprzętowy otwarty | `backends/fdm/include/execution_receipt.hpp` — `ExecutionReceiptState`; `backends/fdm/api/c_api.cpp` — `execute_single_grid_step_transaction` | `backends/fdm/tests/fdm_gpu_host_transfer_callsites_v1.json` i sprzętowy strict-residency gate |
| Granulacja kerneli | luka profilowa, niska | `backends/fdm/api/c_api.cpp` — `launch_heun_step_fp64`, `launch_rk4_step_fp64`, `launch_rk23_step_fp64`, `launch_dp45_step_fp64` | Nsight: kernels/step, launch latency, occupancy i bandwidth |
| Trwałość buforów i FFT | częściowo potwierdzone statycznie, średnia | `backends/fdm/include/context.hpp` — `Context`; `backends/fdm/gpu/cuda/runtime/context.cu` — `context_alloc_device`, `context_prepare_multilayer_fft_workspace_v2` | test repeated-step bez wzrostu alokacji oraz licznik tworzenia planów FFT |
| Redukcja maksymalnego błędu | potwierdzone semantycznie, wysoka | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` — `vector_max_norm_blocks_kernel`, `adaptive_error_policy_kernel` | parity z `max_error_norm_buf` FDM CPU na lokalizowanym błędzie |
| Precyzja | częściowo potwierdzone, średnia | `backends/fdm/api/c_api.cpp` — `valid_precision`; osobne entry pointy `*_fp32` i `*_fp64` | field/RHS/stage/trajectory parity dla FP32 i FP64 |
| Rollback i FSAL | potwierdzone kontraktowo, wysoka | `backends/fdm/gpu/cuda/runtime/step_transaction_controller.hpp` — `StepTransactionController`; `backends/fdm/gpu/cuda/integrators/fsal_policy.hpp` — `context_reject_staged_step` | `backends/fdm/tests/fsal_retry_transaction_contract.cpp` |

### P0 — requested GPU nie może oznaczać częściowego lub niejawnego CPU fallbacku

Planner i wynik muszą rozróżniać requested backend, resolved plan i faktycznie wykonane urządzenie dla RHS, demag, exchange, redukcji, integratora i outputu.

**Naprawa:** strict mode bez fallbacku, `executed_device_receipts`, test wymuszający brak dostępnego CPU adaptera oraz kontrola vendor/device/precision w CI sprzętowym.

### P0 — readback/synchronizacja per stage niszczy przyspieszenie

RK45 może wykonywać wiele ocen pola na krok. Odczyt pełnego `m`, `H_eff`, normy błędu albo torque po każdym stage serializuje kolejkę GPU i kosztuje więcej niż sama algebra LLG.

**Naprawa:** urządzeniowe redukcje, accept/reject i update `dt` na urządzeniu albo batchowany command graph; host otrzymuje wyłącznie mały rekord telemetryczny okresowo lub przy zdarzeniu.

### P1 — zbyt drobna granulacja kerneli

Oddzielny kernel dla każdego lokalnego składnika, cross-productu, stage update, normalizacji i redukcji zwiększa launch overhead oraz ruch global memory.

**Naprawa:** fusion pointwise LLG + lokalne pola + update, trwałe bufory, graph capture/command reuse, profil occupancy/register pressure zamiast bezwarunkowej maksymalnej fuzji.

### P1 — tworzenie buforów, planów FFT lub descriptorów w pętli

Każdy `create_buffer`, alokacja scratch albo plan FFT w hot path jest błędem architektonicznym.

**Naprawa:** cache według `(grid, device, precision, PBC, kernel shape)`, trwały workspace FFT, pool buforów stage i jednoznaczna invalidacja po zmianie siatki.

### P1 — adaptacyjny integrator wymaga redukcji skalowalnej względem N

Norma błędu musi zachować kanoniczne maksimum wektorowe `LLG-TD-MAX-ERR-V1` po aktywnych komórkach, identycznie jak FDM CPU. Redukcja powinna być hierarchiczna na urządzeniu; atomiki do jednego skalara dla milionów komórek mogą stać się bottleneckiem i źródłem niedeterministyczności.

### P1 — precyzja i mixed precision nie mogą zmieniać fizyki

`f32` może wystarczać dla części algebraicznej, ale demag, redukcje energii, kryteria stopu i długie przebiegi mogą wymagać akumulacji `f64` lub compensated reduction.

**Naprawa:** jawny precision policy per operator, parity na poziomie RHS/stage/step/trajectory oraz brak silent promotion/demotion.

### P1 — publiczna termika FDM jest ścieżką fixed-step

Aktualny planner odrzuca połączenie adaptacyjnego FDM z Brown noise; wspierana publiczna ścieżka stochastyczna używa fixed-step. Kwalifikacja musi zatem testować poprawność wariancji i reprodukowalność wspieranego fixed-step lane oraz osobno jawne odrzucenie adaptive + Brown noise. Rollback RNG po odrzuconym kroku nie jest obecnie osiągalnym wymaganiem tej ścieżki i nie może być przedstawiany jako bieżąca remediacja runtime.

## Audyt fizyczny

- identyczna konwencja `gamma`, `mu0`, `H_eff/B_eff` jak w referencji CPU;
- identyczny czynnik `1/(1+alpha^2)` i kolejność operacji dla damping/precession;
- kontrola normy po accepted/rejected step;
- poprawne maski inactive cells i brak dzielenia przez `Ms=0`;
- poprawne linki exchange, PBC i DMI na brzegach bloków/kernel tiles;
- termika: wariancja zależna od `dt` i objętości komórki, niezależna od sposobu batchowania RNG.

## Audyt numeryczny

1. Porównać CPU/GPU: pojedynczy składnik pola, pełne `H_eff`, RHS, jeden stage, jeden krok i trajektorię.
2. Sprawdzić, czy order adaptacyjnej metody zachowuje się po normalizacji i mixed precision.
3. Ustalić tolerancje redukcji niedeterministycznych.
4. Dla deterministycznych metod adaptacyjnych rejected step musi przywracać `m`, cache pól, `dt` i counters bez hostowej rekonstrukcji; adaptive + Brown noise jest osobno odrzucane przez planner.
5. Stop criteria powinny używać urządzeniowych redukcji, nie pełnego readbacku.

## Plan optymalizacji

### Etap 1 — residency gate

- wszystkie state/stage/field buffers na GPU;
- zero pełnych D2H/H2D w steady-state step;
- strict executed-device receipt;
- timeline bez bariery między każdym małym kernelem.

### Etap 2 — koszt pola

- trwały FFT plan/workspace;
- ograniczenie liczby demag evaluations na osiągniętą dokładność;
- overlap możliwych pól lokalnych z przygotowaniem FFT;
- cache materiałów, linków i masek w formie przyjaznej coalescingowi.

### Etap 3 — algebra i redukcje

- kernel fusion oceniona profilem;
- SoA i wyrównane, zwarte bufory;
- hierarchical reductions i rzadsza telemetryka;
- graph capture albo persistent scheduling dla krótkich kroków.

## Obowiązkowe benchmarki

Raportować: kernels/step, launches/step, synchronizations/step, H2D/D2H bytes, FFT count, accepted/rejected ratio, occupancy, bandwidth, time-to-solution przy ustalonym błędzie oraz break-even size względem FDM CPU.

## Minimalne testy akceptacyjne

- macrospin dla kilku `alpha` i obu precyzji;
- norm/energy invariants przez długi przebieg;
- boundary/PBC fixture przekraczający granice bloków;
- CPU/GPU parity na każdym poziomie przepływu;
- test strict no-fallback;
- test bez readbacku pełnego pola przez zadany przedział kroków;
- termiczny fixed-step reproducibility/statistical test oraz test odrzucenia adaptive + Brown noise.

## Ograniczenia

Bez profilu Nsight/rocprof/WebGPU timestamp queries nie można uczciwie podać przyspieszenia. Raport rozróżnia ryzyko architektoniczne od wyniku benchmarku.

(fdm-gpu-problem-statement)=
## Kontrakt publikacyjny lane FDM GPU

Audyt ocenia pełną rezydencję i receipts kroku LLG FDM GPU względem kanonicznych kontraktów.

(fdm-gpu-governing-equations)=
### Równania kanoniczne

Wspólne równanie LLG i konwencje należą do `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`; raport nie duplikuje ich jako fizyki backendowej.

(fdm-gpu-symbols-and-si-units)=
### Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $H_{\mathrm{eff}}$ | efektywne pole magnetyczne używane przez RHS | $\mathrm{A\,m^{-1}}$ |
| $\Delta t$ | krok czasu wspieranej ścieżki fixed-step | $\mathrm{s}$ |

(fdm-gpu-assumptions-and-validity)=
### Założenia i zakres ważności

Kwalifikacja GPU wymaga receipt z faktycznym urządzeniem; obecna publiczna termika FDM jest fixed-step.

(fdm-gpu-python-api)=
### Python API

Raport nie dodaje publicznego konstruktora. Minimalny wykonywalny znacznik lane:

```python
# %%
audit_lane = "FDM GPU"
assert audit_lane == "FDM GPU"
```

(fdm-gpu-problem-ir)=
### ProblemIR

Raport nie zmienia `ProblemIR`; sprawdza zgodność resolved execution z requested intent.

(fdm-gpu-round-trip-and-failure-semantics)=
### Round-trip i błędy

`requested intent` i `resolved execution` są oddzielne. `validation errors` zachowują kontekst, a `unsupported combinations`, w tym adaptive + Brown noise, są jawnie odrzucane.

(fdm-gpu-discrete-realization)=
### Realizacja dyskretna

| Solver | CPU | GPU | Status na tej stronie |
|---|---|---|---|
| FDM | nie | tak | lane FDM GPU udokumentowany |
| FEM | nie | nie | lane FEM CPU/GPU mają osobne raporty |

(fdm-gpu-implementation-mapping)=
### Mapowanie implementacji

Receipt backendu jest eksportowany przez `fullmag_fdm_backend_execution_receipt_v2`.

(fdm-gpu-validation)=
### Walidacja

Wymagane są strict no-fallback, device receipt, parity i sprzętowy profil transferów.

(fdm-gpu-limitations)=
### Ograniczenia publikacyjne

Obecność kerneli nie dowodzi pełnego device-resident kroku ani przyspieszenia.

(fdm-gpu-scientific-bibliography)=
### Bibliografia naukowa

1. T. L. Gilbert, “A phenomenological theory of damping in ferromagnetic materials,” *IEEE Transactions on Magnetics* 40, 3443–3449 (2004), https://doi.org/10.1109/TMAG.2004.836740.

(fdm-gpu-source-code-index)=
### Indeks kodu źródłowego

| Twierdzenie | Ścieżka | Symbol | Odpowiedzialność | Lane | Test/dowód | Status |
|---|---|---|---|---|---|---|
| Receipt faktycznego wykonania | `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_execution_receipt_v2` | eksport wykonania backendu FDM | FDM GPU | contract tests receipt | dowód statyczny; runtime wymaga GPU |
