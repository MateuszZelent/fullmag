# 10. Macierz weryfikacji i pokrycia ustaleń

**Baza planu:** `4c7897f218eb0c32612db1f43a844502a316b4f6`

**Zweryfikowano względem:** `c3f49db708868f3649a3e894416d230269718920`

**Zakres:** kod, testy kontraktowe i `justfile`; managed GPU runtime oraz wyniki
wydajnościowe: `NOT VERIFIED`.

Werdykt dotyczy diagnozy bieżącego kodu. Nowe symbole/pliki/testy opisane w
dokumentach 01–09 są planem, dopóki dowód poniżej nie wskazuje ich istnienia.

| ID | Werdykt diagnozy | Dowód w aktualnym kodzie | Korekta / stan celu | Runtime i wydajność | PR |
|---|---|---|---|---|---|
| EX-01 | `POTWIERDZONE` | `backends/fem/gpu/cuda/exchange/exchange_kernels.cu::periodic_legacy_sparse_exchange_kernel` skanuje `source_row=0..rows`; energy/difference nadal używają full CSR | Reduced `PᵀKP`, reduced mass, lift oraz wspólna semantyka field/energy/Armijo nie istnieją | `NOT VERIFIED` | PR-10 |
| EX-02 | `POTWIERDZONE` | `rk_exchange_dispatch.cu::gpu_rk_compute_legacy_sparse_exchange` uruchamia x/y/z osobno | Fused XYZ kernel i typed state nie istnieją | `NOT VERIFIED` | PR-08 |
| EX-03 | `CZĘŚCIOWO` | `exchange_kernels.cu` ma `ExchangeDoubleDouble`/`gpu_relax_dd` | Brak typed strict/FMA modes; koszt i zwycięski wariant wymagają profilu | `NOT VERIFIED` | PR-09 |
| EX-04 | `CZĘŚCIOWO` | Obecny kernel: jeden thread/row, `kBlockSize=256`; brak histogramu | Problem nieregularności jest wiarygodny, ale mapping/planner i jego zysk nie są dowiedzione | `NOT VERIFIED` | PR-09 |
| EX-05 | `POTWIERDZONE` | `exchange_plan.cpp::gpu_exchange_plan_stage_exchange` już odrzuca consistent mass w strict GPU | Fail-closed zachować; device consistent-mass solver nie istnieje | `NOT VERIFIED` | później |
| EX-06 | `POTWIERDZONE` | `cpu/mfem/interactions/exchange_operator.cpp::initialize_exchange_operator_mfem` używa `AssemblyLevel::LEGACY` | Produkcyjny exchange PA/libCEED nie istnieje; ogólny `pa_benchmark.cpp` nie jest dowodem exchange | `NOT VERIFIED` | PR-15 |
| EX-07 | `POTWIERDZONE` | `legacy_sparse_exchange_kernel` liczy skalę z `Ms` i inverse lumped mass przy apply | Precomputed `row_scale` nie istnieje | `NOT VERIFIED` | PR-08 |
| EX-08 | `POTWIERDZONE` | Kernel ma branch `col != row`; canonicalizer zeruje, lecz zachowuje diagonalny wpis CSR | GPU off-diagonal CSR builder nie istnieje | `NOT VERIFIED` | PR-08 |
| RK-01 | `POTWIERDZONE` | `fields/vector_field_kernels.cu::fullmag_cuda_normalize_vectors` robi D2H flagi i `cudaStreamSynchronize` | Deferred validation/typed packet/fallback nie istnieją; transfer audit ma tu blind spot | `NOT VERIFIED` | PR-04 |
| RK-02 | `CZĘŚCIOWO` | `rk_adaptive_decision_readback.cu` już czyta trzy scalary jednym copy+fence | Brak wspólnego packetu z flags/decision/dt; host nadal wykonuje PI decision | `NOT VERIFIED` | PR-04 |
| RK-03 | `POTWIERDZONE` | `rk_stage_schedule.cu` liczy BS23 endpoint k3, a `rk_final_refresh.cu` zawsze liczy final RHS ponownie | Endpoint token/FSAL slot nie istnieją; DP54 exact identity wymaga osobnego testu | `NOT VERIFIED` | PR-06/07 |
| RK-04 | `POTWIERDZONE` | Fused LLG zapisuje metric/block maxima dla każdego RHS | Global max nie jest redukowany na każdym stage; `NoMetric` nie istnieje | `NOT VERIFIED` | PR-03 |
| RK-05 | `POTWIERDZONE` | `rk_attempt_setup.cu` backup i reject restore używają pełnych D2D; journal obejmuje m+k0 | Typed buffer roles/swap accept nie istnieją | `NOT VERIFIED` | PR-07+ |
| RK-06 | `POTWIERDZONE` | `rk_step_stats.cu::finalize_step_stats_impl` zawsze liczy finalne energie/observables | Step request/output mask v2 nie istnieje | `NOT VERIFIED` | PR-03 |
| AD-01 | `POTWIERDZONE` | `adaptive_error_norm_blocks_kernel` zawsze liczy dot i `acos` per node | Policy `ErrorOnly/ErrorAndNorm/Rotation` nie istnieje | `NOT VERIFIED` | PR-05 |
| AD-02 | `POTWIERDZONE` | `rk_error_norm_runtime.cu` uruchamia trzy globalne max reductions | Typed `AdaptivePartial` i pojedynczy combine nie istnieją | `NOT VERIFIED` | PR-05 |
| AD-03 | `POTWIERDZONE` | Jeden kernel przyjmuje k0…k6 i runtime `stages > s` | BS23/DP54 specialization nie istnieje; wpływ na register pressure niezmierzony | `NOT VERIFIED` | PR-05 |
| DM-01 | `POTWIERDZONE` | `demag_poisson/stage_compute.cpp` zawsze recovery + energy blocks/reduction | `FieldOnly` request/mode nie istnieje | `NOT VERIFIED` | PR-02 |
| DM-02 | `POTWIERDZONE` | `hypre_device_solver.cpp::validate_demag_linear_solve_result` bezwarunkowo wywołuje `b_par->Norml2()` | Conditional truth-table helper nie istnieje | `NOT VERIFIED` | PR-01 |
| DM-03 | `POTWIERDZONE` | `operators.cpp`/`demag_kernels.cu` mają oddzielne recovery x/y/z i sześć map/CSR | Shared-pattern fused recovery nie istnieje; legalność patternu trzeba wykryć po assembly | `NOT VERIFIED` | PR-11 |
| DM-04 | `CZĘŚCIOWO` | `hypre_stream_interop.*` i timing contract mają wait/host API/device/iterations | Brak AMG level metrics i aktualnego A/B solverów; „host-paced bottleneck” nieudowodniony | `NOT VERIFIED` | tuning |
| DM-05 | `CZĘŚCIOWO` | Wszystkie purpose używają jednego `ctx.demag.solver.relative_tolerance` | Purpose-dependent tolerance jest hipotezą; default pozostaje bez zmian do pełnej kwalifikacji | `NOT VERIFIED` | PR-14 |
| HF-01 | `POTWIERDZONE` | `rk_effective_field.cu::gpu_rk_accumulate_effective_field` wywołuje compose osobno x/y/z i przekazuje `has_ext=true` | Fused base compose nie istnieje; ext on/off wymaga jawnego planu/testu | `NOT VERIFIED` | PR-11 |
| HF-02 | `POTWIERDZONE` | Separate field buffers i component-wise adds w `rk_effective_field.cu` | Lazy materialization i masks nie istnieją w plannerze/API | `NOT VERIFIED` | PR-11+ |
| RD-01 | `POTWIERDZONE` | `reduction_kernels.*` ma osobne scalar sum/max i 32 generyczne sloty | Typed adaptive/Armijo/NCG/observable reducers nie istnieją | `NOT VERIFIED` | PR-12 |
| RL-01 | `POTWIERDZONE` | CPU `exchange_mass_preconditioned_gradient`; GPU `relaxation/nonlinear_cg.cpp` jawnie unpreconditioned | GPU PR+ jest dziś poprawny dla raw gradient; zysk diagonal/Chebyshev/PCG nieudowodniony | `NOT VERIFIED` | PR-13 |
| RT-01 | `NIEPRAWDA` w pierwotnym brzmieniu | `rk_plan.cpp::gpu_rk_plan_is_strict_device_resident`, `runtime/execution_receipt.cpp`, Rust `validate_strict_fem_gpu_execution_receipt` już failują dla hybrid/host/unknown/masks/transfers | Rzeczywista luka: brak scalonego work snapshotu i niepełne liczenie bezpośrednich sync/readback | `NOT VERIFIED` | PR-00 |
| MEM-01 | `CZĘŚCIOWO` | Normalizer używa stack scalar; reduction workspace ma pinned host scalar buffer z pageable fallback | Dedykowany pinned attempt-control packet nie istnieje | `NOT VERIFIED` | PR-04 |
| BL-01 | `CZĘŚCIOWO` | Inspektor i walidator bundle mają `--require-native-cubin`; `export_fem_gpu_runtime.sh` już wymaga domyślnie `8.9`, `fullmag_fem=sm_89` i `hypre=sm_89` | Brak ogólnego wykryte CC→`sm_xy` zamiast stałego `sm_89` oraz immutable benchmark receipt; historyczne `sm_52` nie dowodzi aktualnego `sm_89` | `NOT VERIFIED` | PR-00 |
| PA-01 | `POTWIERDZONE` | `exchange_plan.hpp::GpuExchangePlan` rozwiązuje tylko `legacy_sparse_gpu` | Typed planner, profiles, SpMM i exchange PA nie istnieją; enum musi być jeden dla 02/08 | `NOT VERIFIED` | PR-15 |
| NEW-HYPRE-01 | `POTWIERDZONE` | `runtime/hypre_device_policy.cpp` i `demag_poisson/hypre_device_solver.cpp::configure_hypre_device_vendor_kernels` dublują process-wide setters | Usunąć lokalne global setters; solver-local tolerancje/iteracje pozostają w solver owner | `NOT VERIFIED` | PR-01 |

## Reguła zamknięcia

Ustalenie może zostać oznaczone jako zamknięte wyłącznie, gdy jednocześnie:

1. wskazany kod produkcyjny jest zmieniony;
2. test RED został pokazany przed zmianą albo istnieje równoważny reproducer;
3. test GREEN przechodzi w managed runtime;
4. licznik dowodzi usunięcia pracy/barier, a nie tylko zmiany etykiety;
5. physics/numerics parity przechodzi;
6. benchmark pełnego kroku/time-to-solution nie regresuje;
7. capability/provenance odzwierciedla resolved implementation.

## Zależności

- `EX-03`, `EX-04`, `DM-04`, `DM-05`, `RL-01` i `PA-01` wymagają sprzętowej kwalifikacji; plan nie przesądza zwycięskiego wariantu.
- `RK-05` jest po `RK-03`, aby nie mieszać oszczędności duplicate RHS z refaktorem własności buforów.
- `DM-05` nie wchodzi przed stabilną telemetrią odrzuceń i trajektorii.
- `HF-02` zależy od output mask `RK-06`.
- `EX-01` obejmuje field, energy i direct-energy paths w jednym PR.
