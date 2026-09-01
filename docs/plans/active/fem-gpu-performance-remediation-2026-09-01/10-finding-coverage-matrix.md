# 10. Macierz pokrycia ustaleń

**Baza:** `4c7897f218eb0c32612db1f43a844502a316b4f6`

| ID | Problem | Dokument | Główne pliki | Test | Telemetria | PR |
|---|---|---|---|---|---|---|
| EX-01 | Periodic exchange O(N²) | 02 §8 | exchange_operator_builder.*, exchange_state.hpp, exchange_kernels.cu | cuda_exchange_periodic_reduced_contract | visited_nnz, operator kind | PR-10 |
| EX-02 | Trzy CSR x/y/z | 02 §5 | exchange_kernels.cu, rk_exchange_dispatch.cu | cuda_exchange_fused_xyz_contract | kernel launches | PR-08 |
| EX-03 | Double-double cost | 02 §6 | exchange_accumulator.cuh, exchange_plan.cpp | cuda_exchange_accuracy_contract | mode, registers | PR-09 |
| EX-04 | Nieregularne wiersze | 02 §7; 08 | exchange kernels/benchmark/planner | row mapping benchmark | histogram, kind | PR-09 |
| EX-05 | Consistent mass host | 02 §9 | exchange_plan.cpp, consistent_mass_solver.* | gpu_rk_plan + parity | mass mode | osobny późniejszy PR |
| EX-06 | LEGACY/no PA | 02 §10; 08 | exchange_operator.cpp, PA owner | PA operator parity | operator kind | PR-15 |
| EX-07 | Powtórna skala wiersza | 02 §3 | exchange builder/upload/state | row-scale contract | operator setup/apply | PR-08 |
| EX-08 | Przekątna i branch | 02 §4 | exchange builder | off-diagonal CSR test | nnz full/gpu | PR-08 |
| RK-01 | Normalizer D2H+sync | 03 §2–3 | vector_field_kernels.cu, rk_attempt_control_* | invalid vector/rollback | normalization readbacks | PR-04 |
| RK-02 | Adaptive host sync | 03 §4 | rk_adaptive_decision_readback.cu | one packet/attempt | control fences | PR-04 |
| RK-03 | Duplicate endpoint RHS | 03 §5 | rk23/rk45/final_refresh/workspace | FSAL endpoint tests | cache hits, RHS, solves | PR-06/07 |
| RK-04 | Max RHS per stage | 03 §6; 06 §5 | llg_rhs_kernels.cu/dispatch | no-metric contract | metric reductions | PR-03 |
| RK-05 | Pełne D2D copies | 03 §7; 06 §6 | workspace/memory/transaction | role/leak/rollback tests | D2D bytes | PR-07+ |
| RK-06 | Pełne stats co krok | 03 §8 | native ABI v2, step_stats.cu, runner | v1/v2 cadence tests | output mask work | PR-03 |
| AD-01 | acos per node | 04 §3 | adaptive_error_bs23/dp54 | rotation policy tests | policy kind | PR-05 |
| AD-02 | Trzy reductions | 04 §4 | adaptive_error_reduction, reduction workspace | custom reduction parity | reduction count | PR-05 |
| AD-03 | Generic stage kernel | 04 §5 | method-specific kernels | BS23/DP54 goldens | registers | PR-05 |
| DM-01 | Stage demag energy | 05 §3 | stage_compute.*, rk_demag_dispatch | FieldOnly test | stage energy count | PR-02 |
| DM-02 | Unconditional rhs norm | 05 §4 | hypre_validation_policy, hypre_device_solver | truth table/runtime | rhs norm count | PR-01 |
| DM-03 | Recovery x/y/z | 05 §5 | operators/state/demag_kernels | shared/split pattern | recovery launches | PR-11 |
| DM-04 | Host-paced HYPRE | 05 §6 | stream interop/perf counters/benchmark | timeline artifact | host/device times | tuning wave |
| DM-05 | rtol 1e-12 each stage | 05 §7 | solve purpose/policy | tolerance sweep | purpose/rtol/steps | PR-14 |
| HF-01 | Base H_eff x3 | 06 §1 | vector_field_kernels, rk_effective_field | compose parity | launches/time | PR-11 |
| HF-02 | Pole po polu x3 | 06 §2 | local field owners, output mask | materialization tests | field writes | PR-11+ |
| RD-01 | Wiele reductions | 06 §3; 07 §7 | reduction_kernels/workspace/direct energy | typed partial parity | reduction/readback count | PR-12 |
| RL-01 | NCG bez preconditionera | 07 | ncg_preconditioner_* / relaxation state | PR+ and tolA | setup/apply/time-to-tolA | PR-13 |
| RT-01 | Hybrid może udawać GPU | 01 §5 | plan/receipt/runner | strict execution contract | execution class/masks | PR-00 |
| MEM-01 | Stack scalar normalizer | 03 §2; 06 §4 | RK control packet memory | pinned/pageable | packet pinned/readbacks | PR-04 |
| BL-01 | Final CUDA arch | 01 §6 | build.rs/CMake/inspect script/manifest | sm fixture tests | cubin list | PR-00 |
| PA-01 | Brak operator planner | 08 | exchange_plan/profile/PA owner | deterministic planner | qualification ID | PR-15 |
| NEW-HYPRE-01 | Podwójne settery HYPRE | 05 §2 | hypre_device_solver.cpp, hypre_device_policy.cpp | source owner test | policy snapshot | PR-01 |

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
