# Frequency-driven solver — implementation roadmap

Plan jest ułożony tak, aby jak najszybciej uzyskać solver dokładny diagnostycznie, a dopiero potem maksymalnie szybki. Bez tego GPU będzie tylko szybciej produkował stagnację.

---

## Faza 0 — dokumentacja i kontrakt, bez przenoszenia kodu

**Cel:** zamrozić docelowy model przed refaktorem.

Zakres:

```text
- COMSOL-aligned physics contract
- solver tree
- honest lanes
- source layout
- validation gates
```

Nie robić:

```text
- przenoszenia .cpp/.hpp
- zmiany include tree
- zmiany runtime behavior
```

Output:

```text
docs/physics/frequency_domain_solver_physics.md
docs/architecture/backend-golden-masterplan.md
docs/plans/active/.../05-frequency-driven-backend-refactor-plan.md
docs/frequency_domain_solver_files.md
```

Acceptance:

```text
review przyjmuje, że production_gpu zostanie rozdzielone na gpu_operator_host_krylov i gpu_device_krylov
```

---

## Faza 1 — planner descriptors i honest lane names

**Cel:** bez zmiany algorytmu dodać prawdziwy opis tego, co się dzieje.

Patch:

```text
- FrequencySolvePlan
- FrequencyBackendCapabilities
- FrequencyExecutionLane
- diagnostics: krylov_vector_location, operator_buffer_location, preconditioner_buffer_location
```

Obecny solver powinien raportować:

```json
{
  "execution_lane": "gpu_operator_host_krylov",
  "krylov_vector_location": "host",
  "operator_backend": "gpu_hypre_poisson_if_enabled",
  "gpu_device_resident_solver": false
}
```

Acceptance:

```text
wyniki numeryczne identyczne jak przed patchem
JSON diagnostyczny bardziej uczciwy
```

---

## Faza 2 — physics gates: COMSOL-compatible algebra

**Cel:** zanim dodamy backendi, upewnić się, że rozumiemy równanie.

Testy:

```text
1. exp(+iωt) sign convention
2. δh phasor -> RHS projection
3. Cartesian 3D constrained -> tangent 2D equivalence
4. zero drive policy
5. DMI dynamic volume operator
6. Floquet boundary phase
```

Pierwszy kod:

```text
validation/comsol_phase_convention_test.cpp
validation/cartesian_tangent_equivalence_test.cpp
validation/drive_projection_test.cpp
```

Acceptance:

```text
small macrospin + uniform film test przechodzą z dense reference
```

Current implementation evidence, 2026-07-06:

```text
- RED: just verify-fem-frequency-domain-native-contract failed on
  "zero physical drive emits warning diagnostic" after adding the tiny driven
  response contract for dynamic_field_phasor_a_per_m with zero complex RHS and
  require_nonzero_rhs=false.
- Added the minimal tiny driven-response zero-drive policy: physical
  dynamic-field drive with zero projected RHS returns ok, reports
  max_abs_response=0, emits zero_drive_warning=true, and records
  zero_drive_policy="zero_response_allowed".
- The existing tangent_rhs + require_nonzero_rhs=true validation_error test
  remains the benchmark/debug-mode counterexample.
- GREEN: just verify-fem-frequency-domain-native-contract passed after managed
  FEM runtime rebuild and native contract execution.
- RED: the assembled MFEM validation path initially returned ok for a zero
  physical drive but omitted the zero-drive diagnostics.
- Added the same zero physical dynamic-field drive policy to the assembled
  MFEM validation diagnostics: zero_drive_warning=true and
  zero_drive_policy="zero_response_allowed" when require_nonzero_rhs=false.
- GREEN: just verify-fem-frequency-domain-native-contract passed again after
  managed FEM runtime rebuild and native contract execution.
```

---

## Faza 3 — dense full-coupled magnetostatic oracle

**Cel:** złapać błędy Schura, zanim dotkną dużego GPU workloadu.

Dla małych problemów składamy jawne bloki:

```text
A_full = [A_qq A_qφ; A_φq A_φφ]
S_explicit = A_qq - A_qφ inv(A_φφ) A_φq
```

Testy:

```text
S_apply(q) == S_explicit q
full residual reconstruction
Poisson/gauge/nullspace consistency
```

Acceptance:

```text
relative error < 1e-10 dense
relative error < 1e-8 matrix-free CPU
```

---

## Faza 4 — CPU sparse/direct baseline

**Cel:** pierwszy brakujący backend najbardziej użyteczny diagnostycznie.

Dlaczego przed GPU:

```text
- daje robust solution per frequency
- wykrywa złe uwarunkowanie vs zły preconditioner
- daje true residual baseline
- umożliwia porównanie Schura i host GMRES
```

Implementacja:

```text
- assembled real split CSR/BSR
- direct solve przez PETSc KSPPREONLY/PCLU lub adapter sparse LU
- reuse symbolic structure across frequencies
- JSON: factorization time, nnz, fill-in, residual
```

Acceptance:

```text
średni problem bez demag i z demag-small przechodzi
wynik zgodny z dense dla tiny
```

---

## Faza 5 — full-coupled field-split backend

**Cel:** production core dla dynamic demag/airbox.

Układ:

```text
[ A_qq(ω) A_qφ ] [q] = [b_q]
[ A_φq    A_φφ ] [φ]   [b_φ]
```

Preconditioner:

```text
P_qq ≈ local/block Jacobi/ILU/AMG for magnetic block
P_φφ ≈ Poisson AMG/HYPRE
Schur preconditioner optional
```

Solver:

```text
FGMRES recommended
```

Acceptance:

```text
full residual decreases in 64/256 iterations
Poisson residual consistent
field split beats unpreconditioned by clear factor
```

---

## Faza 6 — Schur-reduced certified fast path

**Cel:** przyspieszyć airbox/demag po certyfikacji.

Wymagane przed użyciem:

```text
- dense full-vs-Schur oracle pass
- full/reduced residual reconstruction pass
- schur_preconditioner_quality contraction pass
- tracked residual ≈ recomputed residual
```

Runtime policy:

```text
if schur_certified and quality_good:
    use Schur-reduced
else:
    use full-coupled field-split or sparse direct
```

Acceptance:

```text
64 iterations: residual ratio significantly better than current stagnant logs
256 iterations: residual < target staging threshold or clear contraction trend
```

---

## Faza 7 — modal-reduced response for sweeps

**Cel:** najszybsza ścieżka dla wielu częstotliwości.

Źródło modów:

```text
SLEPc shift-invert
contour interval solver
window partition
mode deduplication
```

Response:

```text
x(ω) ≈ V c(ω)
```

Wymagane:

```text
modal response vs sparse direct for small/medium
mode completeness policy
residual correction outside modal subspace
```

Acceptance:

```text
sweep 100-1000 frequencies szybciej niż direct per frequency
błąd response integral kontrolowany względem sparse direct sample points
```

---

## Faza 8 — device-resident GPU FGMRES

**Cel:** przyspieszyć duże problemy, gdy algebra i preconditioner są już dobre.

Warunek startu:

```text
preconditioner certified
64/256 host run has contraction
full residual consistent
```

Implementacja:

```text
- device complex vector views
- fused apply_Aomega_gpu
- device preconditioner
- FGMRES basis on device
- cuBLAS/cuSPARSE orthogonalization
- no per-iteration host readback
- CUDA Graphs only after stable device workflow
```

Acceptance:

```text
gpu_device_resident_solver=true
cuda_d2h_count not O(iterations)
GPU utilization high for matvec/preconditioner phases
same residual history as host reference within tolerance
```

---

## Faza 9 — performance productionization

Dopiero po Faza 8:

```text
- BSR 2x2/4x4 tangent operators
- batched RHS for real/imag or multiple excitations
- frequency sweep recycling
- modal/direct hybrid
- adaptive backend selection
- artifact throttling
- async telemetry
```

---

## Najkrótsza ścieżka do użytecznego wyniku

```text
1. docs + planner contract
2. honest lane diagnostics
3. dense Schur/full oracle
4. CPU sparse direct baseline
5. run same big case with sparse/direct or full-coupled sample
6. fix Schur/preconditioner based on oracle
7. only then GPU device Krylov
```
