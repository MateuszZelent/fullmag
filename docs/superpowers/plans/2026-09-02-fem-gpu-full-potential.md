# FEM GPU Full-Potential Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wdrożyć i osobno zakwalifikować wszystkie poprawki faz 0–6 z audytu FEM GPU/CUDA, zachowując FEM CPU/double jako oracle oraz brak cichego fallbacku GPU→CPU.

**Architecture:** Kod produkcyjny pozostaje w wyodrębnionych właścicielach `backends/fem`; trwały setup operatorów jest oddzielony od bezalokacyjnego apply, a attempted-step publikuje stan dopiero po accept. Każda optymalizacja ma czerwony test, managed runtime przez `just`, porównanie A/B i niezależną decyzję promote/reject.

**Tech Stack:** C++17, CUDA, MFEM, HYPRE, libCEED, cuSPARSE, CUB/CCCL, PETSc/SLEPc, MPI, Rust FFI/runner, Python benchmark harness, CMake/CTest, Docker Desktop zarządzany przez `just`.

## Global Constraints

- Bazowy commit to `31f4e65e91f22bbe85ff5c6a06f03fc7ab63b755`; izolowana gałąź to `codex/fem-gpu-full-potential-20260902`.
- Budowa i dowód runtime FEM/MFEM/CUDA/HYPRE/libCEED zaczynają się od kontenerowych receptur `just`; hostowe CMake/Cargo są wyłącznie diagnostyką.
- Wymuszony GPU nigdy nie przechodzi na CPU; requested, resolved i executed muszą być jawne w receipcie.
- FEM CPU i FEM GPU współdzielą równania, znaki, jednostki i obserwable, lecz mają osobne realizacje runtime.
- Test source/contract, managed runtime, profil wydajności i walidacja fizyczna są osobnymi pasami dowodowymi.
- Benchmark porównuje identyczne ProblemIR, geometrię, mesh/topologię, seed, precision, tolerancje i stan początkowy; minimum jeden warm-up i pięć prób, raport p50/p95.
- Żaden wariant A/B nie staje się domyślny bez parity oraz poprawy pełnego workloadu; przegrane warianty są usuwane albo zostają diagnostyczne.
- Nie dodawać fizyki do `Context`, `mfem_bridge.cpp` ani runnera; nie tworzyć drugiego stosu FEM obok MFEM/HYPRE/libCEED.
- Wszystkie jawnie wspierane explicit RK muszą przejść fixed/adaptive oraz accept/reject parity.
- Upgrade CUDA, MFEM/HYPRE i PETSc/SLEPc jest oddzielony od zmian algorytmicznych i ma własny obraz oraz rollback.

---

## Mapa plików i odpowiedzialności

| Właściciel | Pliki główne | Odpowiedzialność |
|---|---|---|
| FEM/BEM CPU contract | `backends/fem/cpu/mfem/interactions/demag_fem_bem_*` | wspólna geometria, H2/ACA, workspace, CPU oracle |
| FEM/BEM GPU | `backends/fem/gpu/cuda/demag_fem_bem/*` | spłaszczony operator, upload, apply, dwa solve’y HYPRE |
| Demag sparse | `backends/fem/gpu/cuda/demag_poisson/*` | RHS/recovery CSR, HYPRE policy, stream interop |
| DMI | `backends/fem/gpu/cuda/interactions/dmi/*` | geometria tet, pole, energia i diagnostyka |
| Exchange/H_eff | `backends/fem/gpu/cuda/interactions/exchange/*`, `backends/fem/gpu/cuda/effective_field/*` | sparse apply i akumulacja pola |
| Integratory | `backends/fem/gpu/cuda/integrators/rk/*` | output/control mask, attempt, accept/reject, FSAL |
| Relaksacja | `backends/fem/gpu/cuda/relaxation/*` | NCG/PG-BB i preconditioner exchange-mass |
| Frequency | `backends/fem/gpu/frequency_domain/*`, `backends/fem/gpu/cuda/frequency_domain/*` | PETSc/SLEPc i małe dense solvery |
| ABI/receipt | `native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`, `crates/fullmag-fem-sys`, `crates/fullmag-runner/src/fem/*` | wersjonowane wykonanie i proweniencja |
| Qualification | `scripts/analysis/fem_gpu_benchmark.py`, `scripts/analysis/capture_fem_gpu_nsight.py`, `justfile` | źródłowo przypięty benchmark i profile |

---

### Task 1: Reprodukowalny import baseline’u FEM/BEM

**Files:**
- Add: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_dispatch.hpp`
- Add: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu`
- Add: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.hpp`
- Add: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`
- Add: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.hpp`
- Add: `backends/fem/tests/demag_fem_bem_gpu_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify selectively: `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`
- Modify selectively: `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.hpp`
- Modify selectively: `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp`
- Modify selectively: `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.hpp`
- Modify: `docs/physics/fem_demag_fem_bem.md`
- Add: `docs/audits/2026-09-02-fem-gpu-solver-audit.md`
- Add: `docs/superpowers/specs/2026-09-02-fem-bem-scalable-operator-design.md`

**Interfaces:**
- Consumes: `AcaHMatrixDemagBemOperator`, `DemagFemBemWorkspace`, `cudaStream_t` przekazany jako `void *`.
- Produces: `GpuDemagFemBemWorkspace`, `gpu_demag_fem_bem_initialize`, `compute_device_demag_fem_bem_for_device_stage`, target `fem_demag_fem_bem_gpu_contract`.

- [ ] **Step 1: Dodać czerwony test source-manifest**

W `scripts/test_fem_gpu_full_potential_contract.py` zapisać dokładne SHA-256 z sekcji 3 projektu i asercję, że CMake wymienia oba źródła GPU oraz target kontraktu:

```python
def test_fem_bem_baseline_is_tracked_and_wired():
    cmake = (ROOT / "backends/fem/CMakeLists.txt").read_text(encoding="utf-8")
    assert "gpu/cuda/demag_fem_bem/fem_bem.cpp" in cmake
    assert "gpu/cuda/demag_fem_bem/fem_bem_kernels.cu" in cmake
    assert "fem_demag_fem_bem_gpu_contract" in cmake
```

- [ ] **Step 2: Uruchomić test i potwierdzić czerwony stan**

Run: `python scripts/test_fem_gpu_full_potential_contract.py`

Expected: `FAIL` dla brakującego wpisu CMake albo brakującego pliku manifestu.

- [ ] **Step 3: Odzyskać tylko wymagane hunki**

Do `backends/fem/CMakeLists.txt` dodać:

```cmake
gpu/cuda/demag_fem_bem/fem_bem.cpp
gpu/cuda/demag_fem_bem/fem_bem_kernels.cu
add_executable(fem_demag_fem_bem_gpu_contract tests/demag_fem_bem_gpu_contract.cpp)
target_link_libraries(fem_demag_fem_bem_gpu_contract PRIVATE fullmag_fem)
add_test(NAME fem_demag_fem_bem_gpu_contract COMMAND fem_demag_fem_bem_gpu_contract)
```

Odzyskać kompletne task-specific pliki operatora/workspace, lecz z plików ogólnych przenosić wyłącznie hunki wywołujące powyższe interfejsy.

- [ ] **Step 4: Zaktualizować physics note przed aktywacją runtime**

Zachować etykiety MyST, osobne lane’y CPU/GPU, symbole SI, ograniczenie TET4/P1, status `source/contract VERIFIED`, a managed runtime i fizykę pozostawić `NOT VERIFIED`.

- [ ] **Step 5: Uruchomić kontrakty w managed container**

Run: `just rebuild-fem-runtime`

Run: `just ensure-managed-fem-runtime`

Run: właściwa receptura CTest obejmująca `fem_demag_fem_bem_contract` i `fem_demag_fem_bem_gpu_contract`; jeśli jej brak, dodać `verify-fem-demag-fem-bem-native-contract` do `justfile`, która uruchamia te dwa targety w profilu `fem-gpu`.

Expected: oba targety `PASS`; manifest wskazuje pełny SHA tej gałęzi.

- [ ] **Step 6: Commit**

```bash
git add backends/fem docs/physics/fem_demag_fem_bem.md docs/audits/2026-09-02-fem-gpu-solver-audit.md docs/superpowers/specs/2026-09-02-fem-bem-scalable-operator-design.md scripts/test_fem_gpu_full_potential_contract.py justfile
git commit -m "feat(fem): import reproducible GPU FEM-BEM baseline"
```

---

### Task 2: Wersjonowany performance receipt i baseline faz

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `backends/fem/gpu/cuda/runtime/execution_receipt.hpp`
- Modify: `backends/fem/gpu/cuda/runtime/execution_receipt.cpp`
- Modify: `backends/fem/src/api.cpp`
- Modify: `crates/fullmag-fem-sys/build.rs`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Test: `backends/fem/tests/gpu_execution_receipt_contract.cpp`

**Interfaces:**
- Consumes: istniejący append-only `fullmag_fem_gpu_execution_receipt_v1`.
- Produces: `fullmag_fem_gpu_performance_snapshot_v2`, `FemGpuPerformancePhase`, liczniki setup/apply/fence/launch i wybrany kernel ID bez zmiany ABI v1.

- [ ] **Step 1: Napisać czerwony test ABI v2**

```cpp
fullmag_fem_gpu_performance_snapshot_v2 out{};
out.abi_version = FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION;
out.struct_size = sizeof(out);
require(fullmag_fem_backend_gpu_performance_snapshot_v2(handle, &out) == FULLMAG_FEM_OK);
require(out.setup_count <= out.apply_count + 1);
require(out.compute_fence_count == 0);
```

- [ ] **Step 2: Uruchomić kontrakt i potwierdzić brak symbolu v2**

Run: managed target `fem_gpu_execution_receipt_contract`.

Expected: build `FAIL` z brakiem typu lub symbolu v2.

- [ ] **Step 3: Dodać append-only v2**

```c
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint64_t setup_count;
    uint64_t apply_count;
    uint64_t kernel_launch_count;
    uint64_t compute_fence_count;
    uint64_t snapshot_fence_count;
    uint64_t export_fence_count;
    uint64_t selected_sparse_kernel_id;
    uint64_t setup_wall_time_ns;
    uint64_t apply_wall_time_ns;
    uint64_t accepted_finalization_wall_time_ns;
} fullmag_fem_gpu_performance_snapshot_v2;
```

W Rust odwzorować pola 1:1 i generować offset assertions w `build.rs`. V1 pozostawić niezmienione.

- [ ] **Step 4: Opublikować receipt dopiero po accepted commit**

`gpu_execution_receipt_commit_attempt` aktualizuje accepted liczniki i finalization; reject/failed zwiększa wyłącznie własny licznik i nie zastępuje masek ostatniego zaakceptowanego wykonania.

- [ ] **Step 5: Zweryfikować kontrakt ABI i artefaktu**

Run: managed CTest `fem_gpu_execution_receipt_contract`.

Run: `cargo +nightly test -p fullmag-fem-sys gpu_performance_snapshot_v2_has_stable_layout_and_symbol -- --exact` wewnątrz receptury kontenerowej.

Expected: oba `PASS`; serializowany artefakt ma wszystkie pola v2 bez domyślania braków.

- [ ] **Step 6: Commit**

```bash
git add native/include/fullmag_fem.h backends/fem/gpu/cuda/runtime backends/fem/src/api.cpp backends/fem/tests/gpu_execution_receipt_contract.cpp crates/fullmag-fem-sys crates/fullmag-runner/src/types.rs crates/fullmag-runner/src/artifacts.rs
git commit -m "feat(fem): publish versioned GPU phase counters"
```

---

### Task 3: Źródłowo przypięty benchmark fazy 0

**Files:**
- Modify: `scripts/analysis/fem_gpu_benchmark.py`
- Modify: `scripts/analysis/capture_fem_gpu_nsight.py`
- Modify: `justfile`
- Test: `scripts/test_fem_gpu_benchmark_contract.py`

**Interfaces:**
- Consumes: manifest managed runtime, ProblemIR digest, performance snapshot v2.
- Produces: `benchmark.v2.json`, CSV z p50/p95, trace Nsight obejmujący setup→export.

- [ ] **Step 1: Dodać czerwone testy kompletności rekordu**

```python
REQUIRED = {
    "source_commit", "source_snapshot_sha256", "runtime_manifest_sha256",
    "problem_ir_sha256", "mesh_sha256", "gpu_uuid", "precision",
    "wall_time_p50_ns", "wall_time_p95_ns", "setup_count", "apply_count",
    "compute_fence_count", "kernel_launch_count",
}
assert REQUIRED <= set(record)
assert record["measured_repetitions"] >= 5
```

- [ ] **Step 2: Usunąć historyczny drift preconditionerów**

Lista CLI benchmarku ma pochodzić z jednego mapowania `none`, `diagonal`, `exchange_mass`; nie emitować nazwy strategii, której runtime C++ nie potrafi rozwiązać.

- [ ] **Step 3: Wymusić poprawność przed statystyką**

`collect_case` odrzuca próbę przed agregacją, jeśli digest ProblemIR/mesh/source różni się, receipt jest niepełny, strict GPU ma host mask/transfer/fence albo CPU oracle przekracza tolerancję.

- [ ] **Step 4: Rozszerzyć managed recipes**

`capture-fem-gpu-pre-remediation-performance-baseline` zapisuje immutable baseline tej rewizji; `capture-fem-gpu-nsight` profiluje setup, attempt, accepted finalization, snapshot i export.

- [ ] **Step 5: Uruchomić testy i baseline**

Run: `python -m unittest scripts.test_fem_gpu_benchmark_contract`

Run: `just capture-fem-gpu-pre-remediation-performance-baseline`

Run: `just capture-fem-gpu-nsight`

Expected: testy `PASS`; baseline i trace zawierają zgodne source/runtime digests. Jeśli Nsight nie jest dostępny, artefakt ma jawny `NOT VERIFIED` i nie promuje fazy.

- [ ] **Step 6: Commit**

```bash
git add scripts/analysis/fem_gpu_benchmark.py scripts/analysis/capture_fem_gpu_nsight.py scripts/test_fem_gpu_benchmark_contract.py justfile
git commit -m "perf(fem): pin GPU baseline to source and workload"
```

---

### Task 4: DMI field-only i bezpieczna redukcja energii

**Files:**
- Modify: `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu`
- Modify: `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu`
- Test: `backends/fem/tests/dmi_gpu_contract.cpp`

**Interfaces:**
- Produces: `DmiApplyRequest { bool field; bool energy; }`, `DmiDiagnostics { degenerate_tet_count, nonfinite_count }`.

- [ ] **Step 1: Czerwony test field-only**

```cpp
DmiApplyRequest request{true, false};
launch_dmi(request, stream);
require(field_matches_reference());
require(diagnostics.energy_atomic_count == 0);
require(diagnostics.nonfinite_count == 0);
```

- [ ] **Step 2: Potwierdzić FAIL obecnego kernela**

Run: managed target `fem_dmi_gpu_contract`.

Expected: energy atomic count jest niezerowy albo interfejs nie istnieje.

- [ ] **Step 3: Rozdzielić field-only od energy**

Caller RK przekazuje `nullptr` dla energii; kernel nie wykonuje obliczeń ani atomików energii, gdy wskaźnik jest pusty.

- [ ] **Step 4: Zastąpić globalny atomic redukcją**

Użyć CUB `DeviceReduce::Sum` z trwałym scratch przy zwykłej ścieżce oraz deterministycznej pairwise reduction w trybie kwalifikacji. Dodać liczniki degeneratów i niefinitych wyników; oba są fail-closed według polityki.

- [ ] **Step 5: Testy i A/B**

Run: managed `fem_dmi_gpu_contract` oraz DMI CPU/GPU parity.

Run: benchmark RHS z DMI field-only i field+energy.

Expected: identyczne pole w tolerancji FP64, energia w tolerancji oracle, zero energy atomics field-only i nie gorszy pełny RHS p50/p95.

- [ ] **Step 6: Commit**

```bash
git add backends/fem/gpu/cuda/interactions/dmi backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu backends/fem/tests/dmi_gpu_contract.cpp
git commit -m "perf(fem): skip unused GPU DMI energy work"
```

---

### Task 5: FEM/BEM stream interop i warunkowa walidacja

**Files:**
- Modify: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp`
- Test: `backends/fem/tests/cuda_demag_timing_contract.cpp`
- Test: `backends/fem/tests/demag_fem_bem_gpu_contract.cpp`

**Interfaces:**
- Produces: `HypreStreamLease` z eventami wejścia/wyjścia i `should_validate_independent_residual(reported_converged, forced)`.

- [ ] **Step 1: Czerwony test zakazujący twardych sync**

```cpp
require(source.find("cudaStreamSynchronize(stream)") == std::string::npos);
require(receipt.compute_fence_count == 0);
require(validation_count == 0); // reported_converged=true, forced=false
```

- [ ] **Step 2: Potwierdzić obecne cztery host waits**

Run: managed FEM/BEM contract i baseline v2.

Expected: czerwony test wskazuje twarde synchronizacje.

- [ ] **Step 3: Wdrożyć dwukierunkową zależność eventów**

Przed solve: record na strumieniu Fullmag i wait na rzeczywistym strumieniu HYPRE. Po solve: record HYPRE i wait Fullmag. Brak założenia o default stream; brak host synchronize.

- [ ] **Step 4: Warunkować `A*x-b`**

Niezależne residuum uruchamiać tylko, gdy HYPRE zgłasza brak zbieżności, polityka wymusza walidację lub działa qualification mode. Normę RHS reużywać do tolerancji absolutnej.

- [ ] **Step 5: Managed parity i Nsight**

Run: FEM/BEM CPU/GPU field-energy-residual parity.

Run: `just capture-fem-gpu-nsight`.

Expected: zero compute host sync, jawne event dependencies, brak dodatkowego SpMV po zwykłym sukcesie.

- [ ] **Step 6: Commit**

```bash
git add backends/fem/gpu/cuda/demag_fem_bem backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.* backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp backends/fem/tests
git commit -m "perf(fem): remove host fences from GPU FEM-BEM"
```

---

### Task 6: Sparse autotuning demag i Exchange

**Files:**
- Create: `backends/fem/gpu/cuda/sparse/sparse_apply_plan.hpp`
- Create: `backends/fem/gpu/cuda/sparse/sparse_apply_plan.cpp`
- Create: `backends/fem/gpu/cuda/sparse/sparse_apply_kernels.cu`
- Modify: `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu`
- Modify: `backends/fem/gpu/cuda/exchange/exchange_kernels.cu`
- Test: `backends/fem/tests/gpu_sparse_apply_contract.cpp`

**Interfaces:**
- Produces: `enum class SparseApplyVariant { ScalarRow, Subwarp, Warp, CusparseSpmv, CusparseSpmm3 }` i `SparseApplyPlan::apply_xyz`.

- [ ] **Step 1: Czerwony test wariantów i provenance**

```cpp
for (auto variant : all_sparse_variants()) {
    plan.force_variant_for_test(variant);
    plan.apply_xyz(x, y, stream);
    require(vector_rms(y, oracle) <= tolerance);
}
require(plan.selected_variant_name()[0] != '\0');
```

- [ ] **Step 2: Implementować scalar/subwarp/warp**

Każdy wariant używa tego samego CSR i trwałego scratch. Subwarp dobiera szerokość 2/4/8/16 według bucketu długości wierszy; warp używa `__shfl_down_sync`.

- [ ] **Step 3: Implementować cuSPARSE SpMV i SpMM3**

Deskryptory oraz preprocessing powstają w setupie; `apply_xyz` nie tworzy descriptorów ani buforów. SpMM3 przechowuje XYZ w układzie zgodnym z jednym wywołaniem.

- [ ] **Step 4: Dodać accuracy policy Exchange**

FP64 jest oracle. Wariant DD/pairwise lub compensated accumulation może być promowany tylko, gdy przechodzi energy/field tolerance i full-workload A/B; mixed precision pozostaje opt-in.

- [ ] **Step 5: Autotuning i test pełnego kroku**

Setup benchmarkuje wyłącznie reprezentatywną, ograniczoną liczbę apply; wybór zapisuje ID w performance snapshot v2. Test obejmuje krótkie, mieszane i długie wiersze.

- [ ] **Step 6: Commit**

```bash
git add backends/fem/gpu/cuda/sparse backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu backends/fem/gpu/cuda/exchange backends/fem/tests/gpu_sparse_apply_contract.cpp
git commit -m "perf(fem): select GPU sparse apply by row shape"
```

---

### Task 7: Precomputed DMI geometry, H_eff fusion i ACA batching

**Files:**
- Create: `backends/fem/gpu/cuda/interactions/dmi/dmi_geometry_cache.hpp`
- Create: `backends/fem/gpu/cuda/interactions/dmi/dmi_geometry_cache.cu`
- Modify: `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu`
- Modify: `backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu`
- Test: `backends/fem/tests/gpu_operator_fusion_contract.cpp`

**Interfaces:**
- Produces: immutable `DmiGeometryCache`, `EffectiveFieldApplyMask`, batched ACA row map.

- [ ] **Step 1: Czerwone testy setup/apply**

```cpp
require(cache.build_count == 1);
apply_dmi_twice(cache);
require(cache.build_count == 1);
require(performance.apply_allocation_count == 0);
require(field_matches_unfused_reference());
```

- [ ] **Step 2: Precompute gradienty i objętości tet**

Cache jest przebudowywany wyłącznie po zmianie mesh/version; degenerate flags są trwałe i sprawdzane przed apply.

- [ ] **Step 3: Porównać atomiki DMI**

Wprowadzić wariant coloring/segmented reduction, zmierzyć przeciw 12 atomikom/tet i promować tylko zwycięzcę full RHS.

- [ ] **Step 4: Wprowadzić maskowaną akumulację H_eff**

Jedno wywołanie akumuluje zgodne lokalne pola według `EffectiveFieldApplyMask`; demag i inne kosztowne operatory zachowują osobnych właścicieli.

- [ ] **Step 5: Zbatchować ACA**

Setup tworzy mapę pracy po `(rank, row_count)`; małe far-blocki są batchowane, a duże mapowane adaptacyjnie. Fingerprint operatora i wynik pozostają identyczne semantycznie.

- [ ] **Step 6: Managed A/B i commit**

Run: operator parity, allocation counter, pełny RHS benchmark i FEM/BEM benchmark.

```bash
git add backends/fem/gpu/cuda/interactions/dmi backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu backends/fem/gpu/cuda/demag_fem_bem backends/fem/tests/gpu_operator_fusion_contract.cpp
git commit -m "perf(fem): reuse GPU geometry and batch field work"
```

---

### Task 8: Output/control mask i transakcyjny adaptive step na GPU

**Files:**
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_output_control.hpp`
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_output_control.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_attempt_control_kernels.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp`
- Modify: `backends/fem/gpu/cuda/transfer/snapshot_pool.cpp`
- Test: `backends/fem/tests/gpu_rk_device_controller_contract.cpp`

**Interfaces:**
- Produces: `RkOutputControlMask`, `RkCandidateState`, `RkDecisionSlot[2]`, `commit_candidate` i `rollback_candidate`.

- [ ] **Step 1: Czerwony test reject nie publikuje stanu**

```cpp
const auto accepted = snapshot_state(ctx);
run_forced_rejected_attempt(ctx);
require(snapshot_state(ctx) == accepted);
require(receipt.rejected_attempt_count == 1);
require(receipt.accepted_step_count == 0);
```

- [ ] **Step 2: Dodać maskę i validity bits**

RHS liczy tylko pola potrzebne przez kontroler lub output; snapshot jest odroczony do accept. Cache ma version/valid bit powiązany z kandydatem.

- [ ] **Step 3: Przenieść normę błędu i PI na device**

`rk_device_controller.cu` zapisuje `accept`, `next_dt`, `error_norm`, `decision_version` do naprzemiennego slotu. Kolejna próba nie nadpisuje slotu jeszcze konsumowanego.

- [ ] **Step 4: Atomowy commit/rollback**

Accept publikuje magnetyzację, czas, cache, FSAL, kontroler i telemetrykę razem. Reject unieważnia wyłącznie kandydata.

- [ ] **Step 5: Pełna macierz RK**

Test parametryczny iteruje wszystkie publiczne explicit RK oraz fixed/adaptive, forced accept/reject, snapshot on/off i demag modes. Porównuje decyzje z CPU golden vectors w tolerancji.

- [ ] **Step 6: Managed benchmark i commit**

Expected: zero hot-loop scalar readback, mniej host-sync/launches, identyczna sekwencja decyzji w kontrakcie.

```bash
git add backends/fem/gpu/cuda/integrators/rk backends/fem/gpu/cuda/transfer/snapshot_pool.cpp backends/fem/tests/gpu_rk_device_controller_contract.cpp
git commit -m "perf(fem): keep adaptive RK control on GPU"
```

---

### Task 9: Warunkowe CUDA Graphs

**Files:**
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_graph.hpp`
- Create: `backends/fem/gpu/cuda/integrators/rk/rk_graph.cpp`
- Test: `backends/fem/tests/gpu_rk_graph_contract.cpp`

**Interfaces:**
- Produces: `RkGraphPlan::capture`, `RkGraphPlan::launch`, `RkGraphPlan::invalidate`; wyłączenie grafu pozostaje kwalifikowanym GPU fallbackiem.

- [ ] **Step 1: Test capture compatibility i rollback**

```cpp
require(graph.capture(plan, error));
run_forced_reject(graph);
require(last_accepted_state_unchanged());
require(graph.host_callback_count() == 0);
```

- [ ] **Step 2: Przechwycić wyłącznie stałą topologię kroku**

Alokacje, eksport, profiler hostowy i zmiana operatorów pozostają poza capture. Conditional node wybiera retry/accept bez utraty cancel semantics.

- [ ] **Step 3: A/B graph on/off**

Promować tylko dla zakresów, w których pełny krok p50/p95 wygrywa; wybrany wariant trafia do receiptu.

- [ ] **Step 4: Commit**

```bash
git add backends/fem/gpu/cuda/integrators/rk/rk_graph.* backends/fem/tests/gpu_rk_graph_contract.cpp
git commit -m "perf(fem): qualify conditional CUDA graphs for RK"
```

---

### Task 10: GPU exchange-mass preconditioner relaksacji

**Files:**
- Modify: `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.hpp`
- Modify: `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb.cpp`
- Test: `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp`

**Interfaces:**
- Produces: `GpuRelaxationPreconditionerKind::ExchangeMass` realizujący `(M + wK)^{-1}M`, reusable setup i device apply.

- [ ] **Step 1: Manufactured SPD czerwony test**

```cpp
preconditioner.setup(mass, exchange, weight, stream);
preconditioner.apply(rhs, solution, stream);
require(relative_residual(mass_plus_weight_exchange, solution, mass_rhs) <= 1e-10);
require(preconditioner.setup_count() == 1);
```

- [ ] **Step 2: Wdrożyć reusable HYPRE/libCEED setup i apply**

Macierz/operator i preconditioner powstają raz na wersję mesh/material/weight. Hot apply nie alokuje i nie wykonuje D2H.

- [ ] **Step 3: Podłączyć NCG i PG-BB**

Oba algorytmy używają wspólnego kontraktu, lecz zachowują własne kryteria kroku. Brak preconditionera i `Diagonal` pozostają wariantami A/B.

- [ ] **Step 4: Time-to-tolerance qualification**

Run: `just verify-fem-gpu-relaxation-preconditioner-qualification` dla `none,diagonal,exchange_mass`.

Expected: identyczna tolerancja, końcowa energia/pole w kontrakcie, raport liczby kroków i p50/p95; default zmienia się tylko, jeśli exchange-mass wygrywa.

- [ ] **Step 5: Commit**

```bash
git add backends/fem/gpu/cuda/relaxation backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp
git commit -m "feat(fem): add GPU exchange-mass relaxation preconditioner"
```

---

### Task 11: Oddzielne upgrade’y stosu i mixed precision

**Files:**
- Modify: `docker/fem-gpu/Dockerfile`
- Modify: `compose.windows.yaml`
- Modify: `scripts/export_fem_gpu_runtime.sh`
- Modify: `scripts/validate_managed_fem_runtime_bundle.py`
- Modify: `justfile`
- Test: `scripts/test_export_fem_gpu_runtime_copy_helpers.py`

**Interfaces:**
- Produces: nazwane warianty runtime dla current, MFEM 4.10+/HYPRE 3.2, PETSc/SLEPc 3.25 i eksperymentalnego CUDA 13.3; aktywny alias zmienia się atomowo.

- [ ] **Step 1: Czerwony test manifestu wersji**

```python
assert manifest["dependencies"]["mfem_version"] >= "4.10.0"
assert manifest["dependencies"]["hypre_version"] >= "3.2.0"
assert manifest["source_provenance"]["commit"] == expected_commit
```

- [ ] **Step 2: Zbudować osobny wariant MFEM/HYPRE**

Nie nadpisywać aktywnego runtime przed przejściem build, ABI, parity i benchmark. Użyć `build-fem-gpu-task6-runner-harness`, `validate-fem-gpu-runtime-variant` oraz atomowego `select-fem-gpu-runtime-variant`.

- [ ] **Step 3: CUDA 13.3 jako eksperyment**

Sprawdzić driver, Docker Desktop, wszystkie zależności i pełną macierz runtime. Odrzucić wariant, jeśli dowolny wymagany target lub parity nie przechodzi.

- [ ] **Step 4: Mixed precision z refinement**

FP32/tensor wariant pozostaje opt-in; końcowe residuum jest liczone w FP64 i iterative refinement trwa do tej samej tolerancji. Brak zbieżności failuje, nie wraca po cichu do CPU.

- [ ] **Step 5: Commit upgrade’ów osobno**

```bash
git commit -m "build(fem): qualify MFEM and HYPRE GPU upgrade"
git commit -m "build(fem): add experimental CUDA 13.3 runtime"
git commit -m "perf(fem): refine mixed-precision GPU solves in FP64"
```

---

### Task 12: Frequency-domain PETSc/SLEPc i małe solvery

**Files:**
- Modify: `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Modify: `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu`
- Create: `backends/fem/gpu/cuda/frequency_domain/small_dense_dispatch.cu`
- Test: `backends/fem/tests/frequency_domain/gpu_small_dense_contract.cpp`
- Test: `backends/fem/tests/frequency_domain/gpu_petsc_slepc_runtime_test.cpp`

**Interfaces:**
- Produces: `SmallDenseVariant { Current, CpuLapack, MfemBatched, Cusolver }`, rozmiarowy dispatch i równoległe final metrics.

- [ ] **Step 1: Czerwone testy widma/odpowiedzi**

Każdy wariant porówna eigenvalues, eigenvectors do znaku/fazy oraz driven response z CPU double oracle dla `N=8,16,32,64`.

- [ ] **Step 2: Migrować PETSc/SLEPc 3.25 w osobnym wariancie**

Run: managed modal GPU contract, dynamic-pencil residuals, orthogonality i requested frequency window. Modal i driven nie promują się wzajemnie.

- [ ] **Step 3: A/B małych solverów**

CPU LAPACK pozostaje dozwolonym jawnym wariantem dla małych układów tylko w trybie auto; forced strict GPU nie może go wybrać. cuSOLVER/MFEM batched są mierzone po pełnym koszcie transferów.

- [ ] **Step 4: Zrównoleglić final metrics**

Zastąpić sekwencyjny scan redukcją blokową tylko, gdy Nsight potwierdza koszt; sprawdzić identyczność metryk w tolerancji.

- [ ] **Step 5: Commit**

```bash
git add backends/fem/gpu/frequency_domain backends/fem/gpu/cuda/frequency_domain backends/fem/tests/frequency_domain docker/fem-gpu/Dockerfile
git commit -m "perf(fem): qualify GPU frequency-domain solver dispatch"
```

---

### Task 13: Multi-GPU po zamknięciu single-GPU

**Files:**
- Create: `backends/fem/gpu/cuda/runtime/multi_gpu_binding.hpp`
- Create: `backends/fem/gpu/cuda/runtime/multi_gpu_binding.cpp`
- Modify: `backends/fem/cpu/mfem/runtime/availability.cpp`
- Modify: `scripts/export_fem_gpu_runtime.sh`
- Create: `scripts/analysis/fem_gpu_multi_gpu_scaling.py`
- Test: `backends/fem/tests/gpu_multi_gpu_binding_contract.cpp`

**Interfaces:**
- Produces: `GpuRankBinding { world_rank, local_rank, device_ordinal, device_uuid }`, per-rank receipt i GPU-aware MPI preflight.

- [ ] **Step 1: Czerwony test rank→device**

```cpp
auto binding = resolve_gpu_rank_binding(env, visible_devices);
require(binding.device_ordinal == binding.local_rank % visible_devices.size());
require(!binding.device_uuid.empty());
```

- [ ] **Step 2: Fail-closed GPU-aware MPI preflight**

Forced multi-GPU odrzuca brak CUDA-aware transportu lub host staging. Każdy rank publikuje własny UUID, maski, transfery i fence.

- [ ] **Step 3: Strong/weak scaling**

Skrypt zapisuje single-GPU baseline przed progami, następnie 2+ GPU: czas całkowity, compute, communication, imbalance, efficiency i parity.

- [ ] **Step 4: Brama promocji**

Nie promować, jeśli receipt wykazuje host staging/fallback, parity nie przechodzi albo ustalony wcześniej próg efektywności nie jest spełniony.

- [ ] **Step 5: Commit**

```bash
git add backends/fem/gpu/cuda/runtime/multi_gpu_binding.* backends/fem/cpu/mfem/runtime/availability.cpp backends/fem/tests/gpu_multi_gpu_binding_contract.cpp scripts/export_fem_gpu_runtime.sh scripts/analysis/fem_gpu_multi_gpu_scaling.py
git commit -m "feat(fem): add fail-closed multi-GPU execution binding"
```

---

### Task 14: Końcowa kwalifikacja i completion matrix

**Files:**
- Modify: `docs/audits/2026-09-02-fem-gpu-solver-audit.md`
- Create: `docs/audits/2026-09-02-fem-gpu-solver-completion.md`
- Modify: odpowiednie `docs/physics/*.md` oraz sąsiednie `.source-map.json`

**Interfaces:**
- Consumes: wszystkie immutable receipts, benchmarki, Nsight traces i walidatory faz 0–6.
- Produces: requirement-by-requirement status `VERIFIED`, `REJECTED` albo `NOT VERIFIED` z linkiem do dowodu.

- [ ] **Step 1: Uruchomić pełny managed gate**

Run: `just rebuild-fem-runtime`.

Run: `just ensure-managed-fem-runtime`.

Run: wszystkie dodane kontrakty operatorów i RK.

Run: `just verify-fem-gpu-performance-regression`.

Run: `just verify-fem-gpu-demag-performance-benchmark`.

Run: `just verify-fem-gpu-relaxation-preconditioner-qualification`.

Run: `just capture-fem-gpu-nsight`.

- [ ] **Step 2: Walidacja publikacji**

Run: repozytoryjny validator page/source-map dla każdej zmienionej terminalnej strony.

Run: `python scripts/check_public_doc_examples.py --root public_docs/site`.

Expected: wszystkie wymagane etykiety, źródła i przykłady przechodzą; runtime claims mają device identity.

- [ ] **Step 3: Wypełnić completion matrix**

Każdy punkt audytu wskazuje commit implementacji, test, managed receipt, benchmark i physics evidence. Brak któregokolwiek dowodu pozostaje `NOT VERIFIED`; nie wolno oznaczyć całego celu jako ukończony.

- [ ] **Step 4: Niezależny review**

Użyć `requesting-code-review`, a następnie `google-eng-review-practices`. Naprawić każde P0/P1 i powtórzyć właściwy gate.

- [ ] **Step 5: Final commit**

```bash
git add docs/audits docs/physics
git commit -m "docs: publish FEM GPU optimization qualification"
```

---

## Kolejność wykonania i checkpointy

1. Faza 0: Tasks 1–3; checkpoint po czystym baseline, zanim wynik wydajności zostanie użyty do decyzji.
2. Faza 1: Tasks 4–5; checkpoint po quick wins i Nsight.
3. Faza 2: Tasks 6–7; checkpoint z mikrobenchmarkiem i pełnym workloadem.
4. Faza 3: Tasks 8–9; checkpoint wszystkich explicit RK.
5. Faza 4: Tasks 10–11; checkpoint time-to-tolerance i osobnych runtime variants.
6. Faza 5: Task 12; checkpoint modal/driven osobno.
7. Faza 6: Task 13; start wyłącznie po kwalifikacji single-GPU.
8. Publikacja: Task 14; pełny completion audit przed integracją.

Każdy checkpoint może odrzucić konkretny wariant bez cofania wcześniejszych,
samodzielnie poprawnych faz. Odrzucenie wariantu A/B nie zwalnia z zapisania
wyniku i przyczyny w completion matrix.
