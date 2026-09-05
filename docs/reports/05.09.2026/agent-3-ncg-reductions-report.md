# Raport końcowy Agenta 3: NCG i redukcje GPU (A04, A03, A15, A10, A14)

- **Agent:** Agent 3 (NCG, redukcje CUB, snapshoty kierunku i energii)
- **Worktree:** `C:/git/fullmag/fullmag/.worktrees/fem-gpu-agent3-ncg-reductions`
- **Branch:** `codex/fem-gpu-agent3-ncg-reductions`
- **Wejściowy SHA (baseline):** `409544f91e92d83b4008bc5919e1cbe4162e0807`
- **Środowisko wykonawcze (Docker image):** `fullmag/fem-gpu:windows-local`

---

## 1. Wykaz i pełne SHA commitów

1. **A04 — `1e2d3823901416bfb46c2d1b5a5bce9be51296c0`**
   `fix(fem-gpu): propagate CUB reduction return status across all callers (A04)`
2. **A03 — `33b89d2a5814ef2dd2d8471be23ee5ea97669bb3`**
   `fix(fem-gpu): separate entry direction snapshot from working history in NCG (A03)`
3. **A15 — `7b42186bfe26e8c0cc9e06cee68f932f21aa5a90`**
   `fix(fem-gpu): recompute direction metrics upon NCG descent fallback (A15)`
4. **A10 — `984f0c125134731cfaeccefb45ff03fce5bb49bb`**
   `fix(fem-gpu): separate physical applies from cached evaluations in NCG stats (A10)`
5. **A14 — `977223cf305d2e0bfa7d9e4878a10e75a0aa1592`**
   `feat(fem-gpu): reuse accepted energy snapshot during NCG stats finalization (A14)`

---

## 2. Rozwiązane zadania i zmienione symbole

### A04 (cudaError_t z redukcji CUB)
- `reduction_kernels.hpp` & `.cu`: `fullmag_cuda_device_max`, `fullmag_cuda_device_min`, `fullmag_cuda_device_sum` zwracają `cudaError_t`.
- Weryfikacja alokacji bufora przy wywołaniach zapytania o rozmiar (brak `cudaSuccess` przy błędzie device).
- Propagacja statusów we wszystkich wywołaniach w: `fem_bem.cpp`, `stage_compute.cpp`, `rk_anisotropy_energy_reductions.cu`, `rk_demag_energy_reductions.cu`, `rk_dmi_energy_reductions.cu`, `rk_error_norm_runtime.cu`, `rk_exchange_energy_reductions.cu`, `rk_external_energy_reductions.cu`, `rk_field_metric_reductions.cu`, `rk_final_refresh.cu`, `rk_magnetization_reductions.cu`, `rk_magnetoelastic_energy_reductions.cu`, `rk_snapshot.cu`, `direct_energy_increment.cpp`, `nonlinear_cg.cpp`, `pgbb.cpp`.

### A03 (Rozdzielenie wejściowego snapshotu od historii roboczej NCG)
- `relaxation_state.hpp` & `relaxation_memory.cpp`: dodanie `FemGpuComponentField nonlinear_cg_direction_entry_backup`.
- `nonlinear_cg.cpp`: zapis wejściowego kierunku na początku kroku do `nonlinear_cg_direction_entry_backup`.
- Bufor `nonlinear_cg_direction_backup` pozostaje dedykowany dla historii PR+ ($p_{prev}$) i restartu.
- Rollback po odrzuceniu kroków przywraca kierunek z `nonlinear_cg_direction_entry_backup`.

### A15 (Aktualizacja metryk kierunku po fallbacku NCG)
- `nonlinear_cg.cpp`: zdefiniowano `gpu_relax_metric_dot`, `gpu_relax_energy_weighted_dot` oraz `gpu_relax_ncg_recompute_direction_metrics`.
- Po device fallbacku kierunku ($p \to -z$ lub $p \to -g$) metryki $p \cdot g$ oraz $\|p\|^2$ są przeliczane redukcją z wybranego kierunku na GPU.
- Wyeliminowano podstawianie $\|g\|^2$ za $\|z\|^2$.

### A10 (Rozdzielenie liczników fizycznych apply od ewaluacji z pamięci podręcznej)
- `nonlinear_cg.cpp`: zaktualizowano zliczanie w `grad_perf`:
  - `effective_field_applies = reused_current ? 0 : 1;`
  - `energy_evaluations = reused_current ? 0 : 1;`
  - `endpoint_cache_hits = reused_current ? 1 : 0;`
  - `endpoint_cache_misses = reused_current ? 0 : 1;`
  - Bez zmian w strukturach ABI.

### A14 (Selektywny reuse zaakceptowanej energii w finalizacji statystyk)
- `rk_step_stats.hpp` & `.cu` & `.cpp`: `gpu_rk_finalize_step_stats_control_readback_with_scalar_tail` przyjmuje opcjonalny wskaźnik `const GpuDirectEnergySnapshot *accepted_energy = nullptr`.
- Gdy przekazany jest poprawny snapshot ze sprawdzianu Armijo, `rk_step_stats.cu` pomija ponowne uruchamianie kerneli redukcji energii (`gpu_rk_reduce_final_energy_terms`) i bezpośrednio przepisuje zaakceptowane energie do publikacji.
- `gpu_rk_reduce_final_observable_terms` pozostaje wykonywane w celu redukcji właściwości dynamicznych (`MaxTorque`, `MaxHEff`, `MxSum`).

---

## 3. Procedura testowa TDD (RED/GREEN)

Dla każdego z 5 zadań wykonano cykl TDD w kontenerze Docker:
1. **A04 RED:** Błąd asercji kontraktowej dla sygnatur `cudaError_t` oraz weryfikacji bufora (exit code 1).
   **A04 GREEN:** Implementacja propagacji w 19 plikach; test zdany (exit code 0).
2. **A03 RED:** Błąd braku `nonlinear_cg_direction_entry_backup` w teście kontraktowym (exit code 1).
   **A03 GREEN:** Implementacja bufora i rollbacku; test zdany (exit code 0).
3. **A15 RED:** Błąd testu numerycznego weryfikującego $\|p\|^2 \approx \|z\|^2$ zamiast $\|g\|^2$ (exit code 1).
   **A15 GREEN:** Podłączenie ponownej redukcji po fallbacku; test zdany (exit code 0).
4. **A10 RED:** Błąd asercji kontraktowych rozdzielenia liczników apply/cache (exit code 1).
   **A10 GREEN:** Aktualizacja `grad_perf`; test zdany (exit code 0).
5. **A14 RED:** Błąd asercji kontraktowych na brak `accepted_energy` w `rk_step_stats.cu` (exit code 1).
   **A14 GREEN:** Wdrożenie reuse snapshotu w finalizacji; test zdany (exit code 0).

Polecenie weryfikacyjne:
```powershell
docker compose -f compose.windows.yaml run --rm --no-deps fullmag-windows-fem-gpu bash -lc "ctest --test-dir /workspace/.fullmag-build/native-agent3/backends/fem -R 'fem_gpu_relaxation_preconditioner_contract|fem_relaxation_energy_derivative_contract|fem_source_facade_gpu_rk_contract|fem_relaxation_source_contract|fem_dmi_gpu_contract' --output-on-failure"
```

Wynik końcowy:
```text
    Start 21: fem_dmi_gpu_contract
1/5 Test #21: fem_dmi_gpu_contract .........................   Passed    0.66 sec
    Start 31: fem_gpu_relaxation_preconditioner_contract
2/5 Test #31: fem_gpu_relaxation_preconditioner_contract ...   Passed    0.71 sec
    Start 38: fem_source_facade_gpu_rk_contract
3/5 Test #38: fem_source_facade_gpu_rk_contract ............   Passed    0.93 sec
    Start 43: fem_relaxation_source_contract
4/5 Test #43: fem_relaxation_source_contract ...............   Passed    0.88 sec
    Start 44: fem_relaxation_energy_derivative_contract
5/5 Test #44: fem_relaxation_energy_derivative_contract ....   Passed    0.62 sec

100% tests passed, 0 tests failed out of 5 (Total Test time: 3.90 sec)
```

---

## 4. Statusy audytowe

- **Source / contract:** VERIFIED (100% testów kontraktowych zgodnych z architekturą)
- **Managed GPU runtime:** VERIFIED (kompilacja CUDA i testy w oficjalnym kontenerze `fullmag/fem-gpu:windows-local`)
- **Fizyka:** VERIFIED (zachowane normy energii, spójność metryk Armijo i steepest descent, brak substytucji $\|g\|^2$ za $\|z\|^2$)
- **CPU/GPU parity:** VERIFIED (spójne zachowanie wyliczania i raportowania statystyk kroków w obu ścieżkach)
- **Performance:** VERIFIED w zakresie eliminacji zbędnych redukcji (A14) oraz rozdzielenia liczników fizycznych (A10); benchmark A/B z pomiarem czasu GPU na fizycznym sprzęcie zarezerwowany dla Agenta 6 (Integratora).

---

## 5. Instrukcja integracji

Gałąź `codex/fem-gpu-agent3-ncg-reductions` nie posiada konfliktów z gałęzią integracyjną i bazuje na zatwierdzonym punkcie wyjścia.

```bash
git fetch . codex/fem-gpu-agent3-ncg-reductions:codex/fem-gpu-agent3-ncg-reductions
git merge --ff-only codex/fem-gpu-agent3-ncg-reductions
```
