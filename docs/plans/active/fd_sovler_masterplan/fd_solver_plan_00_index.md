# Frequency-driven solver — masterplan v2, COMSOL-aligned

**Status:** aktualizacja po audycie kodu, logów GPU/GMRES oraz po analizie rozdziału Frequency Domain z *Micromagnetics Module User’s Guide V2.13*.

**Cel nadrzędny:** zbudować solver frequency-driven, który jest jednocześnie:

1. **fizycznie zgodny z modelem COMSOL Micromagnetics Frequency Domain**,
2. **numerycznie stabilny i diagnostyczny**, czyli ma ścieżki referencyjne i potrafi udowodnić poprawność Schura/preconditionera,
3. **wydajny**, czyli dla dużych problemów ma backendy matrix-free/GPU/modalne, ale nie kosztem utraty kontroli nad algebrą.

---

## 1. Decyzja strategiczna po wszystkich wnioskach

Obecny kierunek „jeden frequency-driven GMRES + Schur + GPU-backed demag” nie jest wystarczający jako docelowa architektura. Jest dobry jako prototyp, ale nie jako production core.

Docelowy model:

```text
FrequencyDomainSolver
├── FrequencySolvePlanner
├── Algebra/Physics Contract
├── DenseCartesianReferenceBackend
├── DenseTangentReferenceBackend
├── CpuSparseDirectBackend
├── FullCoupledFieldSplitBackend
├── SchurReducedBackend
├── ModalReducedBackend
└── GpuDeviceKrylovBackend
```

Kluczowa zmiana względem wcześniejszego planu:

```text
canonical physics contract = COMSOL-compatible Cartesian complex δm, exp(+iωt), m0·δm = 0
optimized internal representation = tangent 2-DOF complex q
```

Tangent space pozostaje świetną reprezentacją obliczeniową, ale nie może być jedynym formalnym modelem fizycznym. Formalny kontrakt zewnętrzny musi odpowiadać temu, co opisuje manual: trzy zespolone komponenty `δm = (δmx, δmy, δmz)` i warunek ortogonalności do `m0`.

---

## 2. Najważniejsze korekty po analizie manuala

### 2.1. Konwencja fazowa

Default produkcyjny:

```text
m(t) = m0 + Re(δm exp(+iωt))
```

To musi być jawnie zakodowane w API, diagnostyce i testach. Jeżeli wewnętrzny real split ma postać:

```text
[ K      +ωM ] [q_R] = [b_R]
[ -ωM     K ] [q_I]   [b_I]
```

to trzeba udowodnić, że odpowiada on tej samej konwencji fazowej po definicji `K`, `M` i znaku przeniesienia równań na jedną stronę.

### 2.2. Unknown fizyczny

Manualowy unknown:

```text
δm ∈ C^3 per node
m0 · δm = 0
```

Wewnętrzny unknown:

```text
q ∈ C^2 per node
δm = T q,   T = [e1 e2]
```

Wymagany test:

```text
Cartesian constrained operator == tangent projected operator
```

### 2.3. Drive semantics

COMSOL-compatible drive to nie „dowolny RHS”. To dynamiczne pole zewnętrzne jako phasor amplitude:

```text
δh [A/m]
```

bez dopisywania `cos(ωt + φ)`, bo harmonic factor `exp(+iωt)` jest częścią solvera.

API musi rozróżniać:

```text
dynamic_field_phasor_a_per_m
tangent_rhs
full_cartesian_torque
current_stt_phasor
coupled_external_provider
```

### 2.4. Magnetostatic coupling

Dla dynamic demag/airbox nie wolno traktować Schura jako jedynej prawdy. Manualowy model odpowiada sprzężeniu dynamicznej magnetyzacji z dynamicznym polem demagnetyzującym. Dlatego core powinien wspierać pełny układ sprzężony:

```text
[ A_mm(ω)   A_mφ ] [δm] = [b_m]
[ A_φm      A_φφ ] [δφ]   [b_φ]
```

Schur:

```text
S(ω) = A_mm(ω) - A_mφ A_φφ^{-1} A_φm
```

jest certyfikowanym fast path, nie bazowym założeniem.

### 2.5. Modal backend jest filarem, nie dodatkiem

Manual pokazuje, że Frequency Domain naturalnie służy zarówno do response sweepów, jak i eigenmodes/eigenfrequency. Dla wielu częstotliwości najwydajniejsza ścieżka często nie będzie „solve liniowy od zera dla każdego f”, tylko:

```text
modal reduction / SLEPc shift-invert / contour / rational Krylov / recycling
```

---

## 3. Obecny stan kodu — interpretacja architektoniczna

Obecna ścieżka `production_gpu` jest semantycznie bliższa:

```text
gpu_operator_host_krylov
```

niż:

```text
gpu_device_krylov
```

Powód: GMRES ma bazę Krylov, Hessenberga, residuale i ortogonalizację na CPU. GPU jest używany przez operator/preconditioner/demag, ale Krylov nie żyje na device. To tłumaczy niski GPU utilization i częste synchronizacje, ale nie jest jedyną przyczyną czasu 30 minut/częstotliwość. Główny problem z logów to stagnacja residualu, czyli nieskuteczny Schur/preconditioner albo niezgodność algebry/skali/znaku/projekcji.

---

## 4. Priorytet wdrożeniowy

Nie zaczynać od pełnego device-resident FGMRES. Kolejność:

```text
P0  COMSOL-aligned physics contract
P1  source layout + planner descriptors, bez zmiany zachowania
P2  Cartesian↔tangent equivalence tests
P3  dense full-coupled oracle for demag/Schur
P4  CPU sparse/direct baseline
P5  full-coupled field-split backend
P6  Schur-reduced backend jako certified fast path
P7  modal-reduced backend dla sweepów
P8  device-resident GPU FGMRES tylko po potwierdzeniu zbieżności
```

---

## 5. Pliki w pakiecie

1. `fd_solver_plan_01_comsol_physics_contract.md` — fizyka, konwencje, LLG, δm, δh, DMI, STT, demag, Floquet.
2. `fd_solver_plan_02_algebra_representations.md` — Cartesian constrained, tangent 2-DOF, real split, full coupled, Schur, modal pencil.
3. `fd_solver_plan_03_solver_tree_architecture.md` — planner, engine matrix, honest lanes, source layout.
4. `fd_solver_plan_04_implementation_roadmap.md` — patch-by-patch plan wdrożenia.
5. `fd_solver_plan_05_api_code_skeletons.md` — fragmenty C++ dla API, plannerów, backendów i walidacji.
6. `fd_solver_plan_06_backend_algorithms.md` — dense, sparse direct, field-split, Schur, modal, GPU.
7. `fd_solver_plan_07_validation_benchmarks.md` — testy fizyczne, algebraiczne, numeryczne i performance.
8. `fd_solver_plan_08_patch_queue.md` — konkretna kolejka patchy i kryteria merge.

---

## 6. Definicja sukcesu

Minimalny solver produkcyjny v1:

```text
1. Zgodność z exp(+iωt) i δm ∈ C^3, m0·δm=0.
2. Dense Cartesian reference przechodzi testy.
3. Tangent 2-DOF jest równoważny Cartesian constrained.
4. Sparse/direct baseline rozwiązuje średni problem i służy jako oracle.
5. Full-coupled magnetostatic backend daje residual zgodny z fizyką.
6. Schur przechodzi full/reduced residual reconstruction gate.
7. Planner wybiera backend i uczciwie raportuje lane.
8. Sweep częstotliwościowy używa modal/recycling, gdy to korzystne.
9. GPU backend jest uruchamiany tylko wtedy, gdy dane i Krylov faktycznie są device-resident.
```

---

## 7. Zasada nadrzędna

**Dokładność fizyczna i algebraiczna jest gate’em wydajności.**

Nie optymalizować GPU dla operatora, który nie ma potwierdzonego znaku, skali, residual norm i równoważności full-vs-Schur. Najszybszy solver to taki, który wybiera właściwą reprezentację problemu, a nie taki, który najszybciej wykonuje błędne iteracje.

---

## v3 addenda

- [10 — Relaxed nonlinear texture handoff](fd_solver_plan_10_relaxed_texture_handoff.md)
- [11 — ADR decision closures](fd_solver_plan_11_decision_closures_adr.md)

v3 adds the missing handoff contract between relaxation/static demag and frequency-domain linearization. Frequency-domain solvers must consume an accepted equilibrium artifact, including `m0`, static demag, mesh/material/BC signatures, periodic-pair maps, tangent-frame transport diagnostics, and symmetric mesh certificates for PBC/Floquet FEM.

