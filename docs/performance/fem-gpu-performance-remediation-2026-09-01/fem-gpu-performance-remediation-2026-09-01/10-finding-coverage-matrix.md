# 10. Macierz weryfikacji i pokrycia ustaleń

**Baza planu:** `4c7897f218eb0c32612db1f43a844502a316b4f6`

**Zweryfikowano względem:** `c3f49db708868f3649a3e894416d230269718920`

**Zakres:** kod, testy kontraktowe i `justfile`; managed GPU runtime oraz wyniki
wydajnościowe: `NOT VERIFIED`.

Werdykt dotyczy diagnozy bieżącego kodu. W tym worktree część kontraktów
źródłowych, implementacji i testów kontraktowych z dokumentów 01–09 została
dodana. Samo istnienie symbolu nie oznacza jeszcze poprawnej kompilacji,
parytetu fizycznego ani kwalifikacji managed GPU; te lanes pozostają jawnie
oznaczone jako `NOT VERIFIED`.

| ID | Werdykt diagnozy | Dowód w aktualnym kodzie | Korekta / stan celu | Runtime i wydajność | PR |
|---|---|---|---|---|---|
| EX-01 | `POTWIERDZONE` | `exchange_operator.cpp::build_gpu_exchange_periodic_reduced_csr`, upload metadanych, `fullmag_cuda_periodic_reduced_exchange_xyz`, `fullmag_cuda_periodic_reduced_exchange_energy_blocks` i `fullmag_cuda_periodic_reduced_exchange_difference_blocks` tworzą/używają reduced CSR/mass/lift; stary kernel nadal istnieje jako kompatybilność | Reduced field/energy/direct-energy consumers są teraz spójne źródłowo; dowód stałości `m` w klasie periodycznej, parytet i promocja runtime nadal wymagają kwalifikacji | `NOT VERIFIED` | PR-10 |
| EX-02 | `POTWIERDZONE` | `rk_exchange_dispatch.cu::gpu_rk_compute_legacy_sparse_exchange` wybiera fused XYZ dla nieperiodycznego row-scale; split x/y/z pozostaje ścieżką zgodności | Fused XYZ i typed state istnieją źródłowo, lecz profil nie jest jeszcze publicznie zakwalifikowany | `NOT VERIFIED` | PR-08 |
| EX-03 | `CZĘŚCIOWO` | `exchange_operator.hpp` ma typed kinds `LegacySparse/FusedXYZ/PeriodicReduced/CuSparse/PartialAssembly`; DD pozostaje w kernelach relaksacji | Brak typowanych trybów strict/FMA i zwycięskiego wariantu precision; wymagana kwalifikacja profilu | `NOT VERIFIED` | PR-09 |
| EX-04 | `CZĘŚCIOWO` | `exchange_operator.cpp` ma deterministyczny resolver fail-closed i builder CSR; brak histogramu/autotune | Planner nie wybiera jeszcze wariantu na podstawie kosztu/nieregularności, a zysk pozostaje niezmierzony | `NOT VERIFIED` | PR-09 |
| EX-05 | `POTWIERDZONE` | `exchange_plan.cpp::gpu_exchange_plan_stage_exchange` już odrzuca consistent mass w strict GPU | Fail-closed zachować; device consistent-mass solver nie istnieje | `NOT VERIFIED` | później |
| EX-06 | `POTWIERDZONE` | `cpu/mfem/interactions/exchange_operator.cpp::initialize_exchange_operator_mfem` używa `AssemblyLevel::LEGACY` | Produkcyjny exchange PA/libCEED nadal nie istnieje; ogólny `pa_benchmark.cpp` nie jest dowodem exchange | `NOT VERIFIED` | PR-15 |
| EX-07 | `POTWIERDZONE` | `exchange_kernels.cu::exchange_row_scale_kernel` oraz lazy setup w dispatchu precomputują skalę wiersza | Row-scale istnieje źródłowo, ale koszt i poprawność dla wszystkich ścieżek nie mają jeszcze runtime proof | `NOT VERIFIED` | PR-08 |
| EX-08 | `POTWIERDZONE` | `build_gpu_exchange_off_diagonal_csr` usuwa diagonalę i deterministycznie scala duplikaty; obecny upload nadal może używać pełnego CSR | Builder kontraktowy istnieje, lecz off-diagonal CSR nie jest jeszcze globalnie podłączony do wszystkich konsumentów | `NOT VERIFIED` | PR-08 |
| RK-01 | `POTWIERDZONE` | `rk_attempt_control_kernels.cu` wykonuje deferred validation, a RK używa pinned `GpuRkAttemptControlPacket`; stary normalizer pozostaje kompatybilnością | Hot path ma odroczony packet i fail-closed fallback; pełny transfer audit oraz każda ścieżka legacy nie są jeszcze zunifikowane | `NOT VERIFIED` | PR-04 |
| RK-02 | `CZĘŚCIOWO` | `rk_adaptive_decision_readback.cu` czyta packet flags/error/norm/rotation jednym pinned D2H i fence | PI decision nadal jest hostowy, a packet nie jest jeszcze publicznym API v2 | `NOT VERIFIED` | PR-04 |
| RK-03 | `POTWIERDZONE` | `rk_stage_schedule.cu` publikuje endpoint token dla BS23/DP54 na ścieżce bez aktywnej projekcji okresowej, a `rk_final_refresh.cu` ma exact-time/signature FSAL reuse | Przy aktywnej mapie okresowej projekcja `m` jest wykonywana przed RHS, lecz FSAL jest fail-closed; bitowa tożsamość DP54 i wpływ na trajektorię wymagają testu managed/scientific | `NOT VERIFIED` | PR-06/07 |
| RK-04 | `POTWIERDZONE` | `gpu_rk_compute_rhs_for_magnetization(..., compute_metric)` pozwala pominąć stage metric; final RHS jawnie żąda metryki | Typed `NoMetric`/global reducer dla wszystkich konsumentów nie istnieje; obecny kontrakt jest częściowy | `NOT VERIFIED` | PR-03 |
| RK-05 | `POTWIERDZONE` | Attempt-control packet/journal i endpoint invalidation ograniczają rollback; pełne D2D backupy nadal są używane | Typed buffer roles i swap-on-accept nie są wdrożone | `NOT VERIFIED` | PR-07+ |
| RK-06 | `POTWIERDZONE` | `rk_step_stats.cu::finalize_step_stats_impl` nadal liczy finalne energie/observables bez output mask | Step request/output mask v2 nie istnieje | `NOT VERIFIED` | PR-03 |
| AD-01 | `POTWIERDZONE` | `adaptive_error_norm_blocks_kernel` używa dot/cosine zamiast per-node `acos`, z policy resolverem dla kanałów | Generic kernel nadal oblicza wspólne kanały; pełne wyspecjalizowane `ErrorOnly/ErrorAndNorm/Rotation` nie są gotowe | `NOT VERIFIED` | PR-05 |
| AD-02 | `POTWIERDZONE` | `rk_error_norm_runtime.cu` warunkowo uruchamia redukcje kanałów; rotation kończy się jednym device min + scalar `acos` | Typed `AdaptivePartial` i pojedynczy wspólny combine nie istnieją | `NOT VERIFIED` | PR-05 |
| AD-03 | `POTWIERDZONE` | Kernel nadal przyjmuje k0…k6 i runtime `stages > s` | BS23/DP54 specialization nie istnieje; wpływ na register pressure niezmierzony | `NOT VERIFIED` | PR-05 |
| DM-01 | `POTWIERDZONE` | `stage_compute.cpp` ma typed `GpuDemagEvaluationMode::FieldOnly`; RK i frequency tangent żądają FieldOnly | FieldOnly jest w źródle, ale parity każdego konsumenta i brak energii w publicznym snapshotcie wymagają runtime proof | `NOT VERIFIED` | PR-02 |
| DM-02 | `POTWIERDZONE` | `hypre_validation_policy.cpp` rozstrzyga RHS normę/independent residual; solver wywołuje je warunkowo | Force-independent policy nie jest jeszcze publiczną konfiguracją, a managed HYPRE proof nie istnieje | `NOT VERIFIED` | PR-01 |
| DM-03 | `POTWIERDZONE` | `operators.cpp`/`demag_kernels.cu` mają wspólny-pattern fused recovery z digestem i split fallback | Fused path jest fail-closed do zgodnego patternu; legalność i przewaga nie są zakwalifikowane | `NOT VERIFIED` | PR-11 |
| DM-04 | `CZĘŚCIOWO` | Istnieją wait/host API/device/iterations oraz fazowe timingi zapisywane do performance snapshot | Brak AMG level metrics i aktualnego A/B solverów; „host-paced bottleneck” pozostaje nieudowodniony | `NOT VERIFIED` | tuning |
| DM-05 | `CZĘŚCIOWO` | Wszystkie purpose nadal używają jednego `ctx.demag.solver.relative_tolerance`; nie dodano cichej zmiany defaultu | Purpose-dependent tolerance pozostaje hipotezą kwalifikacyjną | `NOT VERIFIED` | PR-14 |
| HF-01 | `POTWIERDZONE` | `rk_effective_field.cu` nadal składa component-wise, ale przekazuje rzeczywiste `has_external_field` zamiast stałego `true` | Fused base compose nie istnieje; ext on/off wymaga jawnego planu/testu | `NOT VERIFIED` | PR-11 |
| HF-02 | `POTWIERDZONE` | Separate field buffers i component-wise adds pozostają w `rk_effective_field.cu` | Lazy materialization i masks nie istnieją w plannerze/API | `NOT VERIFIED` | PR-11+ |
| RD-01 | `POTWIERDZONE` | `reduction_kernels.*` ma scalar sum/max, a LLG metric można wyłączyć dla stage RHS | Typed adaptive/Armijo/NCG/observable reducers nadal nie istnieją | `NOT VERIFIED` | PR-12 |
| RL-01 | `NOT VERIFIED` | `gpu_relaxation_preconditioner.cpp::build_gpu_relaxation_diagonal` tworzy tylko diagonalę; błędnie nazwana klasa nie używa off-diagonal CSR, setup nie jest podłączony do NCG/PG-BB, a benchmark odrzuca `exchange_mass` | Historyczny no-go pozostaje osobny; `diagonal` i pełny sparse `exchange_mass_cg4\|cg8` są zatwierdzonym projektem fazy 1. Capability, runtime, parity, physics i performance są nieudowodnione; default pozostaje `none` | `NOT VERIFIED` | faza 1 |
| RT-01 | `NIEPRAWDA` w pierwotnym brzmieniu | Istniejący strict receipt nadal odrzuca hybrid/host/unknown/maski/transfers; dodano transactional `GpuPerformanceCounterState`, C ABI snapshot i Rust validator | Snapshot nie jest jeszcze wpięty do pełnego publicznego provenance, a managed runtime pozostaje niezweryfikowany | `NOT VERIFIED` | PR-00 |
| MEM-01 | `CZĘŚCIOWO` | RK ma dedykowany pinned `GpuRkAttemptControlPacket`; inne redukcje nadal mają pinned scalar buffer z pageable fallback | Packet nie obejmuje jeszcze wszystkich control/data-plane readbacków | `NOT VERIFIED` | PR-04 |
| BL-01 | `CZĘŚCIOWO` | Inspektor i walidator bundle mają `--require-native-cubin`; `export_fem_gpu_runtime.sh` już wymaga domyślnie `8.9`, `fullmag_fem=sm_89` i `hypre=sm_89` | Brak ogólnego wykryte CC→`sm_xy` zamiast stałego `sm_89` oraz immutable benchmark receipt; historyczne `sm_52` nie dowodzi aktualnego `sm_89` | `NOT VERIFIED` | PR-00 |
| PA-01 | `POTWIERDZONE` | `exchange_operator.hpp/.cpp` ma jeden typed resolver dla legacy/fused/reduced/cuSPARSE/PA z fail-closed profile/VRAM/runtime gates | Planner i profile są kontraktem źródłowym, ale nie są jeszcze podłączone do publicznego runtime; SpMM/PA nie są produkcyjną realizacją | `NOT VERIFIED` | PR-15 |
| NEW-HYPRE-01 | `POTWIERDZONE` | `runtime/hypre_device_policy.cpp` jest jedynym właścicielem process-wide setterów; lokalna konfiguracja z solvera została usunięta | Solver-local tolerancje/iteracje pozostają w solver owner; trzeba potwierdzić build i HYPRE runtime | `NOT VERIFIED` | PR-01 |

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
