### Task 4: DMI field-only i bezpieczna redukcja energii

**Files:**
- Modify: `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu`
- Modify: `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu`
- Test: `backends/fem/tests/dmi_gpu_contract.cpp`
- Minimal wiring: `backends/fem/CMakeLists.txt`, `justfile`,
  `scripts/windows/run_fullmag_fem.ps1` i testy kontraktu launchera.

Target i managed recipe nie istniały w bazie Task 4. Ich minimalne dodanie jest
konieczne, aby czerwony i zielony przebieg używały kanonicznej, kontenerowej
trasy Windows FEM zamiast host-first build.

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
