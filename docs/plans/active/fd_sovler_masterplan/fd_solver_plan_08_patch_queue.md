# Frequency-driven solver — patch queue

Kolejka patchy jest ułożona tak, aby review i bisekcja były proste. Nie mieszać refaktoru, zmiany algebry i optymalizacji GPU w jednym diffie.

---

## Patch A — docs-only COMSOL alignment

Pliki:

```text
docs/physics/frequency_domain_solver_physics.md
docs/architecture/backend-golden-masterplan.md
docs/plans/active/dynamics-analysis-interface-comsol-inspired/05-frequency-driven-backend-refactor-plan.md
docs/frequency_domain_solver_files.md
```

Treść:

```text
- exp(+iωt) default
- δm ∈ C^3, m0·δm=0 as physical contract
- tangent2 as optimized internal representation
- δh phasor amplitude as default drive
- full coupled demag core
- Schur as certified fast path
- honest execution lanes
```

Nie dotykać:

```text
C++ source
headers
include tree
build graph
runtime behavior
```

---

## Patch B — lane diagnostics and progress throttling

Cel:

```text
naprawić mylące production_gpu i ograniczyć UI/progress overhead
```

Zmiany:

```text
- execution_lane = gpu_operator_host_krylov for current path
- krylov_vector_location diagnostics
- operator_buffer_location diagnostics
- progress_interval=0 no longer means every iteration
- live snapshot disabled/throttled for solve benchmark
```

Acceptance:

```text
same numerical result
less progress spam
JSON says gpu_device_resident_solver=false for current path
```

---

## Patch C — planner descriptors, no behavior change

Dodaj:

```text
FrequencySolvePlan
FrequencySolvePlanner skeleton
FrequencyBackendCapabilities
FrequencySolverPolicy
```

Current behavior:

```text
plan selects existing host GMRES path
```

Acceptance:

```text
all tests pass
runtime result identical
```

---

## Patch D — COMSOL physics gates

Dodaj testy:

```text
phase convention
cartesian tangent equivalence
drive projection
zero drive policy
floquet phase
```

Acceptance:

```text
macrospin and tiny film pass
```

---

## Patch E — dense full-coupled oracle

Dodaj:

```text
DenseFullCoupledMagnetostaticProblem
DenseSchurExplicitBuilder
FullReducedResidualReconstructionTest
```

Acceptance:

```text
S_matrix_free vs S_explicit pass for tiny
full residual reconstruction pass
```

---

## Patch F — CPU sparse/direct baseline

Dodaj:

```text
engines/sparse_direct/
assemble_real_split_csr.cpp
cpu_sparse_direct_engine.cpp
```

Pierwszy solver:

```text
PETSc KSPPREONLY + PCLU if available
fallback unavailable with clear diagnostics
```

Acceptance:

```text
small and medium problem solve with true residual
matches dense tiny
```

---

## Patch G — full-coupled field-split prototype

Dodaj:

```text
FullCoupledBlockOperator
FieldSplitPreconditioner
PoissonBlockSolverAdapter
```

Acceptance:

```text
bounded 64/256 run improves residual trend
Poisson setup_count not O(iterations) unless explicitly expected
```

---

## Patch H — Schur certification gate

Dodaj:

```text
SchurCertificationState
schur_certified flag in planner
quality thresholds
fallback to full coupled when not certified
```

Acceptance:

```text
Schur cannot be selected as production fast path without certificate
```

---

## Patch I — modal response backend

Rozszerz istniejące modal pieces:

```text
SLEPc shift-invert sparse payload
contour interval for windows
modal response projection
sparse direct sample validation
```

Acceptance:

```text
frequency sweep response matches sparse direct at sample frequencies
```

---

## Patch J — GPU device FGMRES

Warunek startu:

```text
Schur/full coupled preconditioner shows contraction
```

Dodaj:

```text
DeviceComplexVectorView
GpuFrequencyOperatorContext
FGMRESDeviceEngine
fused apply_Aomega_gpu
```

Acceptance:

```text
krylov_vector_location=device
no D2H per iteration
same residual trend as CPU reference
```

---

## Patch K — production optimization

Dopiero po J:

```text
BSR tangent blocks
batched real/imag/different drives
CUDA Graphs
frequency recycling
modal-direct hybrid
async telemetry
```

---

## Merge rules

1. Każdy patch ma mieć jeden cel.
2. Refactor bez zmiany zachowania musi mieć output byte-for-byte albo residual-equivalent.
3. Nowy backend zaczyna jako opt-in.
4. Planner nie wybiera nowego backendu defaultowo, dopóki nie przejdzie gates.
5. GPU performance claim wymaga telemetry counters.
6. Schur performance claim wymaga full-vs-reduced certificate.
7. Modal speed claim wymaga sparse/direct sample validation.
