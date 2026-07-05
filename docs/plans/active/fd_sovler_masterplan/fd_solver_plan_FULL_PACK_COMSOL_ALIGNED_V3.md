# Frequency-driven solver masterplan — COMSOL-aligned v3 full pack



---

<!-- source: fd_solver_plan_00_index.md -->

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




---

<!-- source: fd_solver_plan_01_comsol_physics_contract.md -->

# Frequency-driven solver — COMSOL-aligned physics contract

Ten dokument definiuje fizykę, którą solver ma rozwiązywać. Jest to najważniejszy dokument planu, bo wszystkie backendy — dense, sparse, Schur, modal i GPU — muszą rozwiązywać **to samo równanie**.

---

## 1. Kanoniczny model fizyczny

Manual Frequency Domain zaczyna od time-domain LLG bez dodatkowych torque terms:

```text
∂m/∂t = -γ m × H_eff + α m × ∂m/∂t
```

z małym zaburzeniem wokół równowagi:

```text
m(r,t) = m0(r) + δm(r) exp(+iωt)
```

gdzie:

```text
δm << m0
m0 · δm = 0
```

oraz:

```text
H_eff = h_eff0 + δh_eff exp(+iωt)
```

Po linearyzacji:

```text
iω δm = -γ m0 × δh_eff - γ δm × h_eff0 + iω α m0 × δm
```

To jest kanoniczne równanie fizyczne solvera.

### Konwencja fazowa

Default:

```text
PhaseConvention::exp_plus_i_omega_t
m(t) = m0 + Re(δm exp(+iωt))
```

Nie wolno mieszać z `exp(-iωt)` bez jawnego adaptera. Każdy backend musi wypisywać w diagnostyce:

```json
{
  "phasor_convention": "exp_plus_i_omega_t",
  "time_reconstruction": "m(t)=m0+Re(delta_m*exp(+i*omega*t))"
}
```

---

## 2. Unknown zewnętrzny i unknown wewnętrzny

### 2.1. Unknown fizyczny

Zewnętrzny, COMSOL-compatible unknown:

```text
δm_i = [δmx_i, δmy_i, δmz_i] ∈ C^3
```

z warunkiem:

```text
m0_i · δm_i = 0
```

Dla całej siatki:

```text
δm ∈ C^(3N), constrained by N scalar constraints.
```

### 2.2. Unknown obliczeniowy tangent 2-DOF

Dla wydajności używamy lokalnej bazy stycznej:

```text
e1_i ⟂ m0_i
e2_i = m0_i × e1_i
T_i = [e1_i e2_i] ∈ R^(3x2)
q_i = [u_i, v_i] ∈ C^2
δm_i = T_i q_i
```

Wymagane inwarianty:

```text
|m0_i| = 1
|e1_i| = 1
|e2_i| = 1
e1_i · m0_i = 0
e2_i · m0_i = 0
e1_i · e2_i = 0
cross(e1_i, e2_i) · m0_i > 0
```

### 2.3. Równoważność Cartesian↔tangent

Każdy operator musi przejść test:

```text
project_full_to_tangent( A_cartesian( lift_tangent(q) ) )
    == A_tangent(q)
```

oraz test rekonstrukcji:

```text
m0 · lift_tangent(q) = 0
project_full_to_tangent(lift_tangent(q)) = q
```

---

## 3. Dynamic effective field

Manual rozkłada effective field na static i dynamic parts. Dla podstawowych pól:

```text
h_eff0 = A ∇² m0 + K (eK · m0) eK + h0
δh_eff = A ∇² δm + K (eK · δm) eK + δh
```

W naszym solverze `δh_eff` ma rozszerzalną strukturę:

```text
δh_eff = δh_exchange
       + δh_anisotropy
       + δh_zeeman_drive
       + δh_DMI
       + δh_demag
       + δh_STT_equivalent
       + δh_custom
```

Wszystkie efektywne pola są w jednostkach:

```text
A/m
```

Parametry materiałowe muszą być zapisane w tej samej konwencji co moduł: exchange coefficient `A` w module może być reprezentowany jako efektywna wielkość o wymiarze `A·m`, a nie klasyczne `J/m`. Konwerter jednostek musi być jawny w materiale.

---

## 4. Drive semantics

W trybie COMSOL-compatible użytkownik podaje dynamiczne pole zewnętrzne:

```text
δh = [δhx, δhy, δhz] ∈ C^3, jednostka A/m
```

bez składnika czasowego. Solver sam interpretuje:

```text
δh(t) = Re(δh exp(+iωt))
```

Nie wolno wymagać, aby użytkownik wpisywał `cos(ωt+φ)`.

### DriveKind

API musi rozróżnić poziomy wejścia:

```cpp
enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,  // COMSOL-compatible δh
    tangent_rhs = 2,                   // niskopoziomowy RHS w C^2 tangent
    cartesian_torque_phasor = 3,       // bezpośredni torque w C^3
    stt_current_phasor = 4,            // prąd/STT jako źródło
    coupled_external_provider = 5,     // np. RF/AC/DC provider
};
```

Transformacja `δh -> RHS` musi być oddzielną funkcją, testowaną niezależnie od solvera liniowego:

```text
b_tangent = project_full_to_tangent( γ m0 × δh plus sign according to canonical equation )
```

Dokładny znak musi być potwierdzony dense Cartesian oracle.

---

## 5. Równowaga i linearyzacja

Warunek fizyczny:

```text
m0 × h_eff0 = 0
|m0| = 1
```

Manual ostrzega, że `m0` musi być ground state albo przynajmniej stabilnym stanem dla danych pól. W przeciwnym razie solver może dać matematyczne rozwiązanie, które nie ma sensu fizycznego.

### LinearizationState

```cpp
struct LinearizationState {
    CartesianVectorFieldView m0_unit;          // N x 3
    CartesianVectorFieldView h_eff0_a_per_m;   // N x 3
    CartesianVectorFieldView h_demag0_a_per_m; // optional
    MaterialSnapshot material_snapshot;
    PhysicsTermSnapshot enabled_terms;
    RelaxationProvenance relaxation;
    double max_m0_norm_error;
    double max_m0_cross_heff0_norm;
};
```

Wymagane gate’y:

```text
max | |m0| - 1 | < eps_norm
max |m0 × h_eff0| / max(|h_eff0|, h_floor) < eps_equilibrium
physics_hash(time_domain_relaxation) == physics_hash(frequency_domain_linearization)
```

---

## 6. Damping i operator częstotliwościowy

Linearyzacja z dampingiem:

```text
iω δm = ... + iω α m0 × δm
```

Po projekcji do tangent space damping wchodzi do operatora `M/Bα` zależnie od przyjętej postaci algebraicznej. Najważniejsze: backendy nie mogą interpretować damping inaczej.

Wewnętrzna postać dopuszczalna:

```text
A(ω) q = b
A(ω) = K - iω M
```

Real split:

```text
[ K      +ωM ] [q_R] = [b_R]
[ -ωM     K ] [q_I]   [b_I]
```

Ale tylko wtedy, gdy `K` i `M` są zdefiniowane przez formalny adapter z kanonicznego równania COMSOL-compatible. Test znaku jest obowiązkowy.

---

## 7. DMI

Manual rozdziela DMI na static i dynamic components:

Bulk:

```text
h0_bDMI = -D ∇×m0
δh_bDMI = -D ∇×δm
```

Interfacial:

```text
h0_iDMI = D[(∇·m0) ẑ - ∇m0_z]
δh_iDMI = D[(∇·δm) ẑ - ∇δm_z]
```

Status produkcyjny:

```text
DMI volume operator: allowed after Cartesian↔tangent tests
DMI boundary condition in frequency domain: experimental/unsupported unless separately certified
```

Nie wolno po cichu oznaczyć frequency-domain DMI boundary terms jako production, ponieważ manual wskazuje, że poprawne modelowanie DMI boundary condition w frequency domain pozostaje nieustalone.

---

## 8. Spin-transfer torque

Dla static current manual podaje linearized STT:

```text
τ_STT = (μB P / e Ms) (j·∇)δm
      - β m0 × ((μB P / e Ms)(j·∇)δm)
      - β δm × ((μB P / e Ms)(j·∇)m0)
```

W planie backendów STT należy traktować jako operator liniowy względem `δm`, z osobnym testem dla:

```text
uniform m0
nonuniform m0
β = 0
β ≠ 0
```

---

## 9. Boundary conditions

### Pinning

```text
δm = prescribed value on boundary
```

Domyślnie `δm=0`, czyli dynamical excitation frozen on boundary.

### Periodic

```text
δm_dst = δm_src
```

### Floquet

```text
δm_dst = δm_src exp(-i kF · (r_dst - r_src))
```

Floquet musi być częścią core problem spec, nie dodatkiem modal-only. Wymagane dla:

```text
frequency response
modal eigen
band structure
periodic demag-k operator
```

### EASA

Frequency-domain EASA boundary condition jest liniaryzowana przez:

```text
m = m0 + δm
```

Należy traktować jako osobny boundary operator z testem Cartesian↔tangent.

---

## 10. Zero drive policy

Manual mówi: dla Frequency Domain bez external perturbation system nie jest pobudzony i rozwiązanie jest zero everywhere.

Dlatego:

```text
study_type = driven_response:
    zero δh -> valid zero response + warning, nie zawsze validation_error

study_type = solver_benchmark:
    zero RHS -> validation_error, bo nie testuje solvera

study_type = eigenfrequency:
    zero drive normalny
```

Obecna walidacja „finite non-zero drive required” powinna zostać ograniczona do niskopoziomowego `tangent_rhs benchmark mode`, nie do COMSOL-compatible study mode.

---

## 11. Minimalny physics contract JSON

Każdy wynik solvera powinien zawierać:

```json
{
  "physics_contract": "micromagnetics_frequency_domain_v2",
  "phasor_convention": "exp_plus_i_omega_t",
  "unknown_physics_representation": "cartesian3_complex_constrained",
  "unknown_internal_representation": "tangent2_complex",
  "constraint": "m0_dot_delta_m_zero",
  "drive_kind": "dynamic_field_phasor_a_per_m",
  "effective_field_units": "A_per_m",
  "frequency_units": "Hz_input_rad_per_s_internal",
  "time_reconstruction": "m(t)=m0+Re(delta_m*exp(+i*omega*t))"
}
```

---

## 12. Najważniejsze gate’y fizyczne

```text
G1. phase_convention_sign_test
G2. cartesian3_to_tangent2_equivalence_test
G3. drive_delta_h_to_rhs_projection_test
G4. equilibrium_state_consistency_test
G5. full_coupled_dynamic_demag_test
G6. schur_reconstruction_test
G7. zero_drive_policy_test
G8. floquet_phase_boundary_test
G9. dmi_status_gate
```

---

## 10. Relaxed texture handoff requirement

Frequency-domain analysis around a nonlinear state, e.g. skyrmion/domain wall/antidot equilibrium, must consume an accepted `EquilibriumArtifact`. The artifact provides the exact `m0`, static demag field, static effective field, material snapshot, mesh snapshot, periodic-pair metadata, airbox metadata, and relaxation diagnostics used for linearization.

The solver must reject periodic-airbox frequency-domain runs that do not reference an accepted equilibrium artifact. A short relaxation smoke is not a valid linearization state.

For noncollinear textures, tangent frames are node-local and must be transported across periodic seams. The physical public output remains Cartesian constrained `delta_m = (dmX, dmY, dmZ)`, while tangent `u/v` is internal provenance.

See: `fd_solver_plan_10_relaxed_texture_handoff.md`.




---

<!-- source: fd_solver_plan_02_algebra_representations.md -->

# Frequency-driven solver — algebra representations

Ten dokument opisuje wszystkie reprezentacje algebraiczne, które solver planner może wybrać. Ich wspólnym źródłem jest fizyczny kontrakt `δm ∈ C^3`, `m0·δm=0`, `exp(+iωt)`.

---

## 1. Warstwy reprezentacji

```text
Physics layer:
    δm ∈ C^3 per node, m0·δm = 0

Adapter layer:
    δm = T q, q ∈ C^2 per node

Algebra layer:
    A(ω)x = b

Backend layer:
    dense / CSR / BSR / matrix-free / full-coupled / Schur / modal / GPU
```

Nigdy nie wolno mieszać tych poziomów w jednym callbacku bez opisu. Callback typu „apply_stiffness” nie powinien po cichu wykonywać projekcji, dynamic demag, Schura i real split bez diagnostyki.

---

## 2. Cartesian constrained reference

Najbardziej fizyczna reprezentacja:

```text
unknown: δm_cart ∈ C^(3N)
constraint: C δm_cart = 0, gdzie C_i δm_i = m0_i · δm_i
```

Dwie implementacje referencyjne:

### 2.1. Eliminacja przez tangent basis

```text
δm = T q
A_t = T^H A_cart T
b_t = T^H b_cart
```

### 2.2. Constraint/Lagrange multiplier oracle

Dla małych problemów:

```text
[ A_cart   C^T ] [δm] = [b]
[ C        0   ] [λ ]   [0]
```

To jest bardzo dobry test dla tangent projection i warunku `m0·δm=0`.

---

## 3. Tangent 2-DOF complex representation

Docelowa reprezentacja obliczeniowa dla magnetyzacji:

```text
q ∈ C^(2N)
δm = T q
```

Wariant real-split:

```text
x = [q_R, q_I] ∈ R^(4N)
```

Jeżeli wewnętrzny kontrakt ma postać:

```text
A(ω) = K - iωM
```

to real split:

```text
[ K      +ωM ] [q_R] = [b_R]
[ -ωM     K ] [q_I]   [b_I]
```

Ten blok jest zgodny z aktualnym dense validation style, ale musi być traktowany jako **internal algebra form**, nie bezpośrednio jako równanie manuala. Związek z równaniem manuala musi być potwierdzony testem znaku.

---

## 4. Full coupled magnetostatic representation

Dla dynamic demag/airbox podstawowy model produkcyjny powinien istnieć jako pełny układ sprzężony:

```text
[ A_mm(ω)   A_mφ ] [δm] = [b_m]
[ A_φm      A_φφ ] [δφ]   [b_φ]
```

albo w tangent form:

```text
[ A_qq(ω)   A_qφ ] [q]  = [b_q]
[ A_φq      A_φφ ] [φ]    [b_φ]
```

Gdzie:

```text
A_φφ  — magnetostatic/Poisson/airbox block
A_φq  — source from dynamic magnetization
A_qφ  — feedback from dynamic demag field to LLG
```

### Dlaczego full coupled jest core

1. Można liczyć true full residual.
2. Można diagnozować Poisson/gauge/nullspace.
3. Można użyć field-split preconditionera.
4. Schur jest pochodną, nie jedyną prawdą.
5. Łatwiej porównać z COMSOL-style multiphysics coupling.

---

## 5. Schur-reduced representation

Eliminacja `φ`:

```text
φ = A_φφ^{-1}(b_φ - A_φq q)
```

Po podstawieniu:

```text
S(ω) q = b_q - A_qφ A_φφ^{-1} b_φ
S(ω) = A_qq(ω) - A_qφ A_φφ^{-1} A_φq
```

### Status

Schur jest:

```text
certified fast path
```

nie:

```text
default source of truth
```

### Certyfikacja Schura

Dla małych problemów:

```text
S_explicit = A_qq - A_qφ inv(A_φφ) A_φq
```

Test:

```text
||S_matrix_free q - S_explicit q|| / ||S_explicit q|| < tolerance
```

Rekonstrukcja full residual:

```text
φ(q) = A_φφ^{-1}(b_φ - A_φq q)
r_full = A_full [q, φ(q)] - b_full
r_reduced = S q - b_reduced
```

Wymaganie:

```text
||project_magnetic_part(r_full) - r_reduced|| small
||poisson_part(r_full)|| small
```

---

## 6. Sparse direct representation

Dla pojedynczej częstotliwości i średnich problemów wymagany jest assembled sparse baseline.

Tangent real split:

```text
A_real(ω) = [ K      +ωM ]
            [ -ωM     K ]
```

Formaty:

```text
CSR: najłatwiejszy pierwszy backend
BSR 2x2/4x4: docelowo lepszy dla tangent blocks
MatNest/block CSR: dla full coupled field split
```

Wynik sparse/direct jest punktem odniesienia dla:

```text
GMRES residual
Schur sign/scale
preconditioner quality
GPU matrix-free apply
```

---

## 7. Modal/eigen representation

Frequency-domain response może być liczony przez modal expansion:

```text
A(ω) x(ω) = b
```

Jeżeli operator jest bliski gyrotropic first-order pencil:

```text
K v = λ M v
```

mody można wykorzystać do response:

```text
x(ω) ≈ Σ_j v_j (w_j^H b) / (λ_j - iω)
```

albo odpowiedniej postaci zależnej od definicji `λ` i konwencji fazy.

### Konieczne testy modalne

```text
1. eigenmode residual ||K v - λ M v||
2. positive-frequency partner policy
3. conjugate-pair policy
4. mode normalization with mass inner product
5. modal response vs dense direct for tiny problems
```

---

## 8. GPU device representation

GPU backend nie może być definiowany przez „operator używa GPU”. Musi spełnić:

```text
Krylov vectors on device
operator input/output on device
preconditioner input/output on device
no per-iteration host readback
no CPU dot/norm/axpy in inner loop
```

Lane names:

```text
gpu_operator_host_krylov  // obecny/prototypowy model
gpu_device_krylov         // docelowy model
```

---

## 9. Algebra diagnostics schema

Każdy backend ma raportować:

```json
{
  "algebraic_form": "cartesian3_constrained|tangent2_real_split|full_coupled|schur_reduced|modal_pencil",
  "phasor_convention": "exp_plus_i_omega_t",
  "real_split_convention": "[K,+omegaM;-omegaM,K]",
  "unknown_internal_representation": "tangent2_complex",
  "full_coupled_available": true,
  "schur_certified": false,
  "true_residual_verified": true
}
```

---

## 10. Błędy, które ta architektura ma wykrywać

```text
1. odwrócony znak iω
2. odwrócona orientacja tangent frame
3. δh potraktowane jako RHS bez poprawnego momentu γ m0×δh
4. Schur z błędnym znakiem A_qφ A_φφ^-1 A_φq
5. niespójny gauge/nullspace Poissona
6. residual reduced niezgodny z full residual
7. preconditioner, który poprawia probe RHS, ale szkodzi aktualnym residualom GMRES
8. modal eigenvalue mapowane na złą część λ
```



---

<!-- source: fd_solver_plan_03_solver_tree_architecture.md -->

# Frequency-driven solver — solver tree architecture

Docelowy solver nie jest jedną funkcją `solve`. To system planowania, certyfikacji i wyboru backendu.

---

## 1. Główne komponenty

```text
frequency_domain/
├── algebra/
│   ├── canonical_frequency_pencil.hpp
│   ├── cartesian_tangent_adapter.hpp
│   ├── full_coupled_blocks.hpp
│   ├── schur_reduction.hpp
│   └── residual_norms.hpp
├── planner/
│   ├── frequency_solve_planner.hpp
│   ├── frequency_solve_plan.hpp
│   ├── backend_capabilities.hpp
│   └── solver_policy.hpp
├── operators/
│   ├── tangent_operator_bsr.hpp
│   ├── dynamic_demag_operator.hpp
│   ├── floquet_operator.hpp
│   └── drive_projection.hpp
├── engines/
│   ├── dense_reference/
│   ├── sparse_direct/
│   ├── full_coupled_fieldsplit/
│   ├── schur_reduced/
│   ├── modal_reduced/
│   └── gpu_device_krylov/
├── validation/
│   ├── comsol_physics_gates.hpp
│   ├── schur_certification.hpp
│   ├── residual_consistency.hpp
│   └── backend_crosscheck.hpp
└── diagnostics/
    ├── telemetry_schema.hpp
    ├── progress_throttle.hpp
    └── artifact_schema.hpp
```

---

## 2. Honest execution lanes

Obecne `production_gpu` jest za szerokie. Nowe nazwy:

```cpp
enum class FrequencyExecutionLane : std::uint32_t {
    dense_cartesian_reference = 1,
    dense_tangent_reference = 2,
    cpu_sparse_direct = 3,
    cpu_host_krylov = 4,
    gpu_operator_host_krylov = 5,
    full_coupled_field_split = 6,
    schur_reduced = 7,
    modal_reduced = 8,
    gpu_device_krylov = 9,
};
```

Definicje:

| Lane | Znaczenie |
|---|---|
| `dense_cartesian_reference` | mały oracle `δm ∈ C^3` z constraintem |
| `dense_tangent_reference` | mały oracle tangent real-split |
| `cpu_sparse_direct` | assembled CSR/BSR + direct solve |
| `cpu_host_krylov` | Krylov i operator na CPU |
| `gpu_operator_host_krylov` | Krylov na CPU, operator/preconditioner może używać GPU |
| `full_coupled_field_split` | pełny blok `δm/φ` + preconditioner blokowy |
| `schur_reduced` | certyfikowany Schur fast path |
| `modal_reduced` | response przez mody/reduced basis |
| `gpu_device_krylov` | Krylov, operator i preconditioner device-resident |

---

## 3. FrequencySolvePlan

```cpp
struct FrequencySolvePlan {
    FrequencyExecutionLane lane;
    OperatorRepresentation operator_representation;
    LinearSolverFamily linear_solver;
    PreconditionerFamily preconditioner;

    bool use_cartesian_reference;
    bool use_tangent_internal_representation;
    bool use_full_coupled_system;
    bool use_schur_reduction;
    bool use_modal_reduction;
    bool use_device_resident_krylov;

    bool require_phase_convention_gate;
    bool require_cartesian_tangent_gate;
    bool require_true_residual_verification;
    bool require_schur_certification;

    const char* selection_reason;
    const char* fallback_reason;
};
```

---

## 4. Planner inputs

```cpp
struct FrequencySolvePlanningInput {
    std::uint64_t node_count;
    std::uint64_t tangent_dof_count;
    std::uint64_t cartesian_dof_count;
    std::uint64_t phi_dof_count;
    std::uint64_t frequency_count;

    bool has_dynamic_demag;
    bool has_airbox;
    bool has_periodic_boundary;
    bool has_floquet_boundary;
    bool has_dmi;
    bool has_easa;
    bool has_stt;

    bool dense_oracle_allowed;
    bool sparse_assembly_available;
    bool full_coupled_available;
    bool schur_certified;
    bool modal_basis_available;
    bool gpu_available;
    bool gpu_device_krylov_available;

    double memory_budget_bytes;
    double target_relative_tolerance;
    double target_absolute_tolerance;
};
```

---

## 5. Decision tree

```text
if tiny and validation_requested:
    dense_cartesian_reference

else if phase/cartesian/tangent gates missing:
    dense_tangent_reference or dense_cartesian_reference

else if single_frequency and sparse_direct_memory_ok:
    cpu_sparse_direct

else if dynamic_demag or airbox:
    if full_coupled_available:
        full_coupled_field_split
    else if schur_certified:
        schur_reduced
    else:
        reject with certification_required

else if frequency_count is large and modal_basis_available:
    modal_reduced

else if gpu_device_krylov_available and preconditioner_certified:
    gpu_device_krylov

else:
    cpu_sparse_direct or cpu_host_krylov fallback
```

---

## 6. Backend matrix

| Backend | Szybkość | Dokładność | Ryzyko | Cel |
|---|---:|---:|---:|---|
| Dense Cartesian reference | niska | najwyższa | niskie | oracle fizyczny |
| Dense tangent reference | niska | wysoka | niskie | oracle tangent/sign |
| CPU sparse/direct | średnia | wysoka | niskie/średnie | robust baseline |
| Full coupled field-split | średnia/wysoka | wysoka | średnie | core demag/airbox |
| Schur-reduced | wysoka | wysoka po certyfikacji | wysokie bez certyfikacji | fast path |
| Modal-reduced | bardzo wysoka dla sweepów | zależna od bazy | średnie | response spectrum |
| GPU device Krylov | wysoka | zależna od preconditionera | wysokie | duże układy |

---

## 7. Planner diagnostics

Każdy solve powinien zapisywać:

```json
{
  "selected_backend": "full_coupled_field_split",
  "fallback_backend": "cpu_sparse_direct",
  "execution_lane": "full_coupled_field_split",
  "operator_representation": "full_coupled_tangent2_phi",
  "solver_family": "fgmres",
  "preconditioner_family": "field_split_schur",
  "selection_reason": "dynamic_demag_airbox_requires_full_coupled_reference",
  "schur_certified": false,
  "gpu_residency": {
    "krylov_vectors": "host|device",
    "operator_buffers": "host|device",
    "preconditioner_buffers": "host|device"
  }
}
```

---

## 8. Separation of concerns

Zakazane w docelowym kodzie:

```text
solver wybiera Schura wewnątrz callbacka bez planu
operator callback robi ukryte H2D/D2H bez telemetry
execution_lane nazywa się GPU, mimo że Krylov jest hostowy
RHS może znaczyć δh albo tangent RHS bez drive_kind
phase_convention jest w dwóch strukturach jako dwa źródła prawdy
```

Wymagane:

```text
planner wybiera backend
engine wykonuje backend
operator tylko aplikuje operator
preconditioner tylko aplikuje preconditioner
diagnostics opisują wszystko jawnie
```

---

## 9. Minimalny source layout patch

Pierwszy physical split bez zmiany zachowania:

```text
backends/fem/src/frequency_domain/driven_response_solver.cpp
    pozostaje entrypointem

nowe pliki:
backends/fem/src/frequency_domain/planner/frequency_solve_plan.cpp
backends/fem/src/frequency_domain/planner/frequency_solve_planner.cpp
backends/fem/src/frequency_domain/engines/host_krylov/host_gmres_engine.cpp
backends/fem/src/frequency_domain/diagnostics/frequency_diagnostics_json.cpp
```

W pierwszym patchu engine może nadal wywoływać istniejący hostowy GMRES. Celem jest separacja, nie zmiana wyniku.



---

<!-- source: fd_solver_plan_04_implementation_roadmap.md -->

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



---

<!-- source: fd_solver_plan_05_api_code_skeletons.md -->

# Frequency-driven solver — API and code skeletons

Fragmenty są szkicami kontraktu. Nie są finalnym API ABI, ale pokazują docelowy podział odpowiedzialności.

---

## 1. Konwencje fizyczne

```cpp
enum class FrequencyPhaseConvention : std::uint32_t {
    exp_plus_i_omega_t = 1,
    exp_minus_i_omega_t = 2,
};

enum class FrequencyUnknownRepresentation : std::uint32_t {
    cartesian3_complex_constrained = 1,
    tangent2_complex = 2,
    full_coupled_cartesian3_phi = 3,
    full_coupled_tangent2_phi = 4,
};

enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};
```

---

## 2. LinearizationState

```cpp
struct CartesianVectorFieldView {
    const double* x;
    const double* y;
    const double* z;
    std::uint64_t node_count;
};

struct MaterialSnapshot {
    const double* ms_a_per_m;
    const double* alpha;
    const double* exchange_a_m;
    const double* anisotropy_a_per_m;
    std::uint64_t node_count;
    std::uint64_t material_hash;
};

struct PhysicsTermSnapshot {
    bool exchange_enabled;
    bool anisotropy_enabled;
    bool zeeman_enabled;
    bool dmi_enabled;
    bool demag_enabled;
    bool stt_enabled;
    bool easa_enabled;
    std::uint64_t physics_hash;
};

struct LinearizationState {
    CartesianVectorFieldView m0_unit;
    CartesianVectorFieldView h_eff0_a_per_m;
    CartesianVectorFieldView h_demag0_a_per_m;
    MaterialSnapshot material;
    PhysicsTermSnapshot terms;
    double max_m0_norm_error;
    double max_m0_cross_heff0_relative;
};
```

---

## 3. Cartesian↔tangent adapter

```cpp
struct TangentFrameNodeView {
    double m0[3];
    double e1[3];
    double e2[3];
};

inline void lift_tangent_to_cartesian_node(
    const TangentFrameNodeView& f,
    double u_re,
    double v_re,
    double u_im,
    double v_im,
    double out_re[3],
    double out_im[3]) noexcept
{
    for (int c = 0; c < 3; ++c) {
        out_re[c] = u_re * f.e1[c] + v_re * f.e2[c];
        out_im[c] = u_im * f.e1[c] + v_im * f.e2[c];
    }
}

inline void project_cartesian_to_tangent_node(
    const TangentFrameNodeView& f,
    const double in_re[3],
    const double in_im[3],
    double& u_re,
    double& v_re,
    double& u_im,
    double& v_im) noexcept
{
    u_re = v_re = u_im = v_im = 0.0;
    for (int c = 0; c < 3; ++c) {
        u_re += f.e1[c] * in_re[c];
        v_re += f.e2[c] * in_re[c];
        u_im += f.e1[c] * in_im[c];
        v_im += f.e2[c] * in_im[c];
    }
}
```

---

## 4. Drive projection

```cpp
struct DynamicFieldPhasorView {
    const double* hx_re;
    const double* hy_re;
    const double* hz_re;
    const double* hx_im;
    const double* hy_im;
    const double* hz_im;
    std::uint64_t node_count;
};

struct TangentComplexVectorView {
    double* real;
    double* imag;
    std::uint64_t tangent_dof_count;
};

FrequencyDomainStatus project_dynamic_field_drive_to_tangent_rhs(
    const TangentFrameNodeView* frames,
    std::uint64_t node_count,
    double gamma0,
    FrequencyPhaseConvention convention,
    const DynamicFieldPhasorView& drive,
    TangentComplexVectorView out_rhs,
    FrequencyDiagnostics* diagnostics) noexcept;
```

W testach znak `γ m0×δh` musi zostać potwierdzony względem dense Cartesian oracle.

---

## 5. Solve plan

```cpp
enum class FrequencyExecutionLane : std::uint32_t {
    dense_cartesian_reference = 1,
    dense_tangent_reference = 2,
    cpu_sparse_direct = 3,
    cpu_host_krylov = 4,
    gpu_operator_host_krylov = 5,
    full_coupled_field_split = 6,
    schur_reduced = 7,
    modal_reduced = 8,
    gpu_device_krylov = 9,
};

enum class OperatorRepresentation : std::uint32_t {
    dense_cartesian_constrained = 1,
    dense_tangent_real_split = 2,
    sparse_csr_real_split = 3,
    sparse_bsr_tangent_blocks = 4,
    full_coupled_matnest = 5,
    schur_reduced_matrix_free = 6,
    modal_reduced_basis = 7,
    gpu_matrix_free = 8,
};

struct FrequencySolvePlan {
    FrequencyExecutionLane lane;
    OperatorRepresentation representation;
    bool require_phase_gate;
    bool require_cartesian_tangent_gate;
    bool require_schur_certification;
    bool verify_true_residual_on_convergence;
    bool use_full_coupled_system;
    bool use_schur_reduction;
    bool use_modal_reduction;
    bool use_device_resident_krylov;
    const char* selection_reason;
};
```

---

## 6. Planner skeleton

```cpp
FrequencySolvePlan plan_frequency_solve(
    const FrequencyProblemDescriptor& problem,
    const FrequencySolverPolicy& policy,
    const HardwareCapabilities& hardware,
    const CertificationState& cert) noexcept
{
    FrequencySolvePlan plan{};
    plan.require_phase_gate = true;
    plan.require_cartesian_tangent_gate = true;
    plan.verify_true_residual_on_convergence = true;

    if (policy.validation_mode || problem.tangent_dof_count <= 32) {
        plan.lane = FrequencyExecutionLane::dense_cartesian_reference;
        plan.representation = OperatorRepresentation::dense_cartesian_constrained;
        plan.selection_reason = "tiny_or_validation_requires_cartesian_oracle";
        return plan;
    }

    if (problem.has_dynamic_demag || problem.has_airbox) {
        if (cert.full_coupled_available) {
            plan.lane = FrequencyExecutionLane::full_coupled_field_split;
            plan.representation = OperatorRepresentation::full_coupled_matnest;
            plan.use_full_coupled_system = true;
            plan.selection_reason = "dynamic_demag_uses_full_coupled_core";
            return plan;
        }
        if (cert.schur_certified && cert.schur_quality_good) {
            plan.lane = FrequencyExecutionLane::schur_reduced;
            plan.representation = OperatorRepresentation::schur_reduced_matrix_free;
            plan.use_schur_reduction = true;
            plan.selection_reason = "certified_schur_fast_path";
            return plan;
        }
    }

    if (problem.frequency_count > policy.modal_frequency_count_threshold &&
        cert.modal_basis_available) {
        plan.lane = FrequencyExecutionLane::modal_reduced;
        plan.representation = OperatorRepresentation::modal_reduced_basis;
        plan.use_modal_reduction = true;
        plan.selection_reason = "many_frequencies_use_modal_reduction";
        return plan;
    }

    if (cert.sparse_direct_available && cert.sparse_direct_memory_ok) {
        plan.lane = FrequencyExecutionLane::cpu_sparse_direct;
        plan.representation = OperatorRepresentation::sparse_csr_real_split;
        plan.selection_reason = "sparse_direct_baseline_available";
        return plan;
    }

    if (hardware.cuda_available && cert.gpu_device_krylov_available &&
        cert.preconditioner_certified) {
        plan.lane = FrequencyExecutionLane::gpu_device_krylov;
        plan.representation = OperatorRepresentation::gpu_matrix_free;
        plan.use_device_resident_krylov = true;
        plan.selection_reason = "device_krylov_available_and_preconditioner_certified";
        return plan;
    }

    plan.lane = FrequencyExecutionLane::gpu_operator_host_krylov;
    plan.representation = OperatorRepresentation::schur_reduced_matrix_free;
    plan.selection_reason = "fallback_to_existing_host_krylov_path";
    return plan;
}
```

---

## 7. Sparse direct engine interface

```cpp
struct SparseDirectFrequencySystem {
    CsrMatrixView k_real_split_base;
    CsrMatrixView m_real_split_base;
    std::uint64_t block_dof_count;
    bool symbolic_pattern_frequency_independent;
};

struct SparseDirectSolveRequest {
    double frequency_hz;
    const double* rhs;
    double* solution;
    double relative_tolerance;
    double absolute_tolerance;
};

class CpuSparseDirectEngine {
public:
    FrequencyDomainStatus analyze_pattern(
        const SparseDirectFrequencySystem& system,
        SparseDirectDiagnostics& diagnostics);

    FrequencyDomainStatus factorize_shifted(
        double omega_rad_s,
        SparseDirectDiagnostics& diagnostics);

    FrequencyDomainStatus solve(
        const SparseDirectSolveRequest& request,
        SparseDirectDiagnostics& diagnostics);
};
```

---

## 8. Full coupled operator interface

```cpp
struct FullCoupledBlockSizes {
    std::uint64_t q_dof_complex;
    std::uint64_t phi_dof_complex;
};

struct FullCoupledOperator {
    FullCoupledBlockSizes sizes;

    FrequencyDomainStatus apply_Aqq(
        double omega,
        ComplexVectorView q,
        ComplexVectorView out_q) noexcept;

    FrequencyDomainStatus apply_Aqphi(
        ComplexVectorView phi,
        ComplexVectorView out_q) noexcept;

    FrequencyDomainStatus apply_Aphiq(
        ComplexVectorView q,
        ComplexVectorView out_phi) noexcept;

    FrequencyDomainStatus apply_Aphiphi(
        ComplexVectorView phi,
        ComplexVectorView out_phi) noexcept;
};
```

---

## 9. Schur certification interface

```cpp
struct SchurCertificationResult {
    bool certified;
    double relative_apply_error;
    double full_reconstruction_relative_error;
    double poisson_block_relative_residual;
    char failure_reason[128];
};

FrequencyDomainStatus certify_schur_reduction(
    const FullCoupledOperator& full,
    const SchurReducedOperator& schur,
    const SchurCertificationPolicy& policy,
    SchurCertificationResult* out) noexcept;
```

---

## 10. Device-resident GPU interface

```cpp
struct DeviceComplexVectorView {
    double* real;
    double* imag;
    std::uint64_t n;
};

struct GpuOperatorContext {
    void* device_operator_data;
    void* stream; // cudaStream_t hidden from public C ABI if needed
    std::uint64_t tangent_dof_count;
};

using ApplyAomegaGpu = FrequencyDomainStatus (*)(
    GpuOperatorContext* ctx,
    double omega_rad_s,
    DeviceComplexVectorView x,
    DeviceComplexVectorView y) noexcept;

using ApplyRightPreconditionerGpu = FrequencyDomainStatus (*)(
    GpuOperatorContext* ctx,
    double omega_rad_s,
    DeviceComplexVectorView r,
    DeviceComplexVectorView z) noexcept;
```

---

## 11. Progress throttling

```cpp
struct ProgressThrottlePolicy {
    std::uint64_t iteration_interval = 128;
    std::uint64_t min_interval_ms = 250;
    bool publish_initial = true;
    bool publish_final = true;
};

bool should_publish_progress(
    const ProgressThrottlePolicy& p,
    std::uint64_t iteration,
    std::uint64_t elapsed_ms_since_last,
    bool final_event) noexcept
{
    if (final_event && p.publish_final) return true;
    if (iteration == 0 && p.publish_initial) return true;
    if (p.iteration_interval == 0) return false;
    return iteration % p.iteration_interval == 0 &&
           elapsed_ms_since_last >= p.min_interval_ms;
}
```

---

## 12. Stagnation diagnostics, bez nowego ABI statusu na start

```cpp
struct StagnationDetector {
    std::uint64_t window_iterations = 256;
    double minimum_required_ratio_drop = 0.10;
    double residual_floor_to_ignore = 1e-2;
};

bool gmres_is_stagnating(
    double relres_before_window,
    double relres_now,
    const StagnationDetector& d) noexcept
{
    if (!(relres_now > d.residual_floor_to_ignore)) return false;
    if (!(relres_before_window > 0.0)) return false;
    const double ratio = relres_now / relres_before_window;
    return ratio > (1.0 - d.minimum_required_ratio_drop);
}
```

Na początku raportować jako:

```json
{
  "status": "solve_error",
  "stop_reason": "stagnated"
}
```

bez dodawania nowego enum ABI.



---

<!-- source: fd_solver_plan_06_backend_algorithms.md -->

# Frequency-driven solver — backend algorithms

Ten dokument opisuje algorytmy dla każdego backendu i kolejność ich wdrażania.

---

## 1. Dense Cartesian reference backend

### Cel

Najwyższa dokładność i pełna kontrola znaku, constraintu i drive projection.

### Algorytm

Dla małego `N`:

```text
1. Zbuduj A_cart(ω) w C^(3N x 3N).
2. Zbuduj constraint C δm = 0.
3. Rozwiąż saddle-point system:

   [ A_cart C^T ] [δm] = [b]
   [ C      0   ] [λ ]   [0]

4. Sprawdź m0·δm.
5. Porównaj z tangent result.
```

### Zastosowanie

```text
- macrospin
- 1-4 node toy models
- sign convention tests
- drive projection tests
```

---

## 2. Dense tangent reference backend

### Cel

Szybki oracle dla istniejącego tangent formulation.

### Algebra

```text
A(ω) = K - iωM
```

Real split:

```text
[ K      +ωM ] [q_R] = [b_R]
[ -ωM     K ] [q_I]   [b_I]
```

### Uwaga

Ten backend jest zgodny z aktualnym dense validation style, ale musi mieć test mapowania do COMSOL-compatible `exp(+iωt)`.

---

## 3. CPU sparse/direct baseline

### Cel

Pierwszy brakujący backend produkcyjno-diagnostyczny.

### Dlaczego jest priorytetem

W obecnym problemie log pokazuje stagnację residualu. Sparse/direct odpowiada na pytanie:

```text
czy problem jest rozwiązywalny i dobrze złożony?
```

bez wpływu GMRES/preconditionera.

### Implementacja v1

```text
- Assemble tangent real-split CSR.
- Dla każdej częstotliwości wstaw bloki ±ωM.
- Użyj sparse LU/direct solve.
- Policz true residual.
```

### Reuse

Pattern macierzy jest zwykle niezależny od `ω`, więc:

```text
symbolic analysis / ordering można reuse across frequencies
numeric factorization trzeba zwykle powtarzać per ω
```

### Diagnostics

```json
{
  "backend": "cpu_sparse_direct",
  "nnz": 123456,
  "symbolic_reused": true,
  "factorization_ms": 0.0,
  "solve_ms": 0.0,
  "relative_residual": 0.0
}
```

---

## 4. Full coupled field-split backend

### Cel

Robust core dla dynamic demag/airbox.

### Układ

```text
[ A_qq(ω) A_qφ ] [q] = [b_q]
[ A_φq    A_φφ ] [φ]   [b_φ]
```

### Solver

```text
FGMRES
```

ponieważ preconditioner może być zmienny/inexact.

### Preconditionery

#### Block diagonal

```text
P^-1 ≈ diag(P_qq^-1, P_φφ^-1)
```

#### Block triangular

```text
P = [ P_qq  A_qφ ]
    [ 0     P_φφ ]
```

#### Field-split Schur

```text
S ≈ A_qq - A_qφ P_φφ^-1 A_φq
```

### Minimalny P_qq

```text
node block-Jacobi 2x2 complex / 4x4 real
```

### Minimalny P_φφ

```text
Poisson AMG/HYPRE albo sparse direct dla małych/średnich
```

### Acceptance

```text
- full residual spada szybciej niż unpreconditioned
- δφ residual osobno raportowany
- Poisson solve count i setup count kontrolowane
```

---

## 5. Schur-reduced backend

### Cel

Szybka ścieżka dla dynamic demag po certyfikacji.

### Operator

```text
S(q) = A_qq q - A_qφ solve(A_φφ, A_φq q)
```

### Problem z wydajnością

Jeżeli każde `S(q)` robi pełny Poisson solve, koszt iteracji może być duży. Dlatego:

```text
- Poisson setup musi być reuse
- solve tolerances muszą być inexact/adaptive
- FGMRES wymagany dla zmiennego preconditionera
```

### Preconditioner Schura

Pierwszy sensowny:

```text
P_S^-1 ≈ block-Jacobi/local magnetic + approximate demag correction
```

Lepszy:

```text
graph/demag Schur residual correction
```

### Quality diagnostic

Dla aktualnego residualu `r`:

```text
z = P^-1 r
η = ||r - A z|| / ||r||
```

Interpretacja:

```text
η < 0.3      dobry
0.3-0.7      średni
0.7-1.0      słaby
> 1.0        szkodliwy albo zły znak/skala
```

---

## 6. Modal-reduced backend

### Cel

Największy zysk przy sweepach częstotliwości.

### Źródła reduced basis

```text
- SLEPc shift-invert
- contour interval
- window partition
- deduplication by frequency and mass-overlap
```

### Workflow

```text
1. Wybierz okno częstotliwości.
2. Policz mody w oknie + guard modes.
3. Normalizuj względem mass inner product.
4. Zbuduj reduced response.
5. Dla wybranych frequency sample sprawdź full residual.
6. Jeżeli residual correction duży, dodać mody albo użyć full solve.
```

### Kiedy używać

```text
frequency_count >= 20-50
wiele punktów w jednym paśmie
interesuje response integral/spectrum
```

### Nie używać jako jedynej prawdy, gdy

```text
drive pobudza mody poza oknem
silny non-normal operator
brak completeness certificate
```

---

## 7. GPU device Krylov backend

### Cel

Przyspieszyć duże problemy po potwierdzeniu preconditionera.

### Minimalny architecture contract

```text
x_d, r_d, b_d, v_basis_d, z_basis_d, w_d on GPU
operator/preconditioner input/output device pointers
orthogonalization on GPU
progress readback throttled
true residual recompute rare
```

### FGMRES(m)

```text
m = 30, 50, 80, 100 sweep
```

Przechowywać:

```text
V: Krylov basis
Z: preconditioned basis, bo FGMRES
H: small Hessenberg, host or device
Givens: small
```

### Orthogonalization

Unikać pętli `dot + axpy` z host readback. Użyć:

```text
h = V^H w
w = w - V h
CGS2 albo MGS blocked
```

### Fused operator

Nie:

```text
stiffness(real)
mass(imag)
stiffness(imag)
mass(real)
combine
```

Tylko:

```cpp
apply_Aomega_gpu(omega, x_re_d, x_im_d, y_re_d, y_im_d, stream)
```

### CUDA Graph

Dopiero gdy:

```text
workflow operator/preconditioner jest device-resident i powtarzalny
adresy buforów stabilne
brak host sync w inner loop
```

---

## 8. Performance counters mandatory

Każdy backend ma raportować:

```text
operator_apply_count
preconditioner_apply_count
stiffness_apply_count
mass_apply_count
demag_apply_count
poisson_setup_count
poisson_solve_count
cuda_h2d_count
cuda_d2h_count
cuda_sync_count
cpu_orthogonalization_ms
gpu_operator_ms
gpu_preconditioner_ms
progress_callback_count
snapshot_sync_count
```

Bez tych liczników nie wolno robić performance claims.

---

## 9. Wybór „najszybciej i najdokładniej”

Dla pojedynczej częstotliwości:

```text
small/medium: sparse direct
large demag: full coupled field-split
huge certified: Schur/GPU FGMRES
```

Dla wielu częstotliwości:

```text
modal-reduced + sample direct/full residual checks
```

Dla debugowania:

```text
dense Cartesian/tangent oracle
```

To jest szybsze niż jedna ścieżka GMRES, bo planner wybiera właściwy model do zadania.



---

<!-- source: fd_solver_plan_07_validation_benchmarks.md -->

# Frequency-driven solver — validation and benchmarks

Walidacja jest częścią architektury. Bez niej nie da się odróżnić wolnego solvera od błędnej algebry.

---

## 1. Testy fizyczne COMSOL-aligned

### 1.1. Macrospin uniform equilibrium

Cel:

```text
sprawdzić znak precesji, damping, exp(+iωt), drive projection
```

Konfiguracja:

```text
m0 = ẑ
h0 = H0 ẑ
δh = hx x̂
no exchange, no demag, no DMI
```

Sprawdzić:

```text
response phase
resonance frequency
chirality
m0·δm = 0
```

### 1.2. Standing spin waves in film

Zgodne z manualowym przykładem Frequency Domain: film 2D, m0 w +z, exchange + uniaxial anisotropy, eigenfrequency i frequency sweep.

Testy:

```text
eigenfrequencies vs analytic/mesh-refined trend
mode parity
frequency sweep response integral
```

### 1.3. Skyrmion modes from relaxed m0

Manual pokazuje workflow: time-domain relaxation -> import mX,mY,mZ do frequency-domain m0.

Testy:

```text
physics_hash consistency
m0_norm_error
m0_cross_heff0 residual
breathing/rotation mode sanity
```

### 1.4. Magnetostatic thin film dynamic demag

Manualowy multiphysics workflow używa static demag z relaxation oraz dynamic demag coupling w frequency domain.

Testy:

```text
full coupled residual
Poisson block residual
dynamic demag linearity
Schur reconstruction
```

### 1.5. Floquet band structure

Boundary:

```text
δm_dst = δm_src exp(-i kF·(r_dst-r_src))
```

Testy:

```text
k=0 equals periodic
k and -k conjugacy policy
band curve continuity
```

### 1.6. DMI and EASA status tests

```text
DMI volume dynamic operator: testowany
DMI boundary condition frequency domain: experimental/unsupported unless certified
EASA frequency-domain boundary: separate boundary operator tests
```

---

## 2. Algebra gates

### G1. Phase convention

Dla jednego znanego układu:

```text
exp(+iωt) result must reconstruct A cos(ωt+φ)
```

Backend musi raportować:

```text
phasor_convention=exp_plus_i_omega_t
```

### G2. Cartesian↔tangent equivalence

Dla losowych `q`:

```text
δm = T q
A_tangent q ≈ T^H A_cart δm
```

Tolerancja:

```text
dense: 1e-12..1e-10
sparse/matrix-free CPU: 1e-9..1e-8
GPU: 1e-7..1e-6 depending on inner tolerance
```

### G3. Drive projection

Dla `δh`:

```text
b_tangent_from_drive == projected Cartesian torque RHS
```

### G4. Real split

```text
A_complex(q_R + i q_I) == split([q_R,q_I])
```

### G5. Full coupled vs Schur

```text
S_apply(q) == S_explicit q
full residual reconstruction consistent
```

---

## 3. Solver gates

### Sparse direct gate

```text
relative true residual < 1e-10 for tiny
relative true residual < requested tolerance for production
```

### GMRES/FGMRES gate

```text
tracked residual and recomputed residual agree at restarts
true residual verified on convergence
```

### Schur preconditioner quality

Dla residualu `r`:

```text
η = ||r - A P^-1 r|| / ||r||
```

Acceptance staging:

```text
η < 0.7   minimum to continue 256 iterations
η < 0.3   good enough for production candidate
η > 1.0   preconditioner harmful
```

### Stagnation gate

Nie uruchamiać 8192 iteracji, jeżeli 256 mówi, że nie ma kontrakcji.

```text
if relres_256 / relres_0 > 0.9 and relres_256 > 1e-2:
    stop_reason = stagnated
```

---

## 4. Performance gates

### Progress/snapshot

Do benchmarku:

```text
progress_callback = null
live_snapshot = false
write_partial_artifacts = false
```

Do UI:

```text
progress every >=128 iterations or >=250ms
snapshot every >=2000ms
no blocking GPU sync for snapshot
```

### GPU residency gate

`gpu_device_krylov` może być raportowane tylko jeśli:

```text
krylov_vector_location = device
operator_input_location = device
operator_output_location = device
preconditioner_location = device
cuda_d2h_count not O(iterations)
cpu_orthogonalization_ms ~ 0 in inner loop
```

---

## 5. Benchmark matrix

| Case | Cel | Backendy |
|---|---|---|
| macrospin | sign/phase/damping | dense Cartesian, dense tangent |
| 2D film exchange | eigen/standing waves | modal, sparse direct |
| skyrmion small | nonuniform m0 | dense tangent, modal |
| thin film demag small | full vs Schur | full coupled, Schur, sparse direct |
| periodic antidot small | Floquet/demag | full coupled, Schur |
| periodic antidot large | production perf | full coupled, Schur, GPU device |
| wide frequency sweep | speed | modal-reduced, sparse sample checks |

---

## 6. Required JSON diagnostics

```json
{
  "physics_contract": "micromagnetics_frequency_domain_v2",
  "phasor_convention": "exp_plus_i_omega_t",
  "backend": "full_coupled_field_split",
  "execution_lane": "full_coupled_field_split",
  "unknown_physics_representation": "cartesian3_complex_constrained",
  "unknown_internal_representation": "tangent2_complex",
  "cartesian_tangent_equivalence_passed": true,
  "phase_convention_gate_passed": true,
  "true_residual_verified": true,
  "schur_certified": false,
  "relative_residual_l2_norm": 0.0,
  "last_recomputed_relative_residual_l2_norm": 0.0,
  "operator_apply_count": 0,
  "preconditioner_apply_count": 0,
  "poisson_setup_count": 0,
  "poisson_solve_count": 0,
  "progress_callback_count": 0,
  "snapshot_sync_count": 0
}
```

---

## 7. Acceptance milestones

### M1 — physics correctness

```text
macrospin + film dense tests pass
COMSOL phasor convention pass
Cartesian↔tangent pass
```

### M2 — sparse/direct baseline

```text
sparse direct solves small/medium cases
true residual reliable
used as oracle for Schur and GMRES
```

### M3 — full-coupled demag

```text
full coupled dynamic demag passes residual gates
Poisson setup reuse confirmed
```

### M4 — Schur fast path

```text
Schur certified
preconditioner quality good
64/256 runs show strong contraction
```

### M5 — modal sweep

```text
modal response matches sparse sample points
wide sweep faster than per-frequency direct
```

### M6 — GPU production

```text
device Krylov actually device-resident
GPU run matches CPU/reference residual trend
performance scales with problem size
```

---

## 9. Relaxed texture and symmetric mesh gates

Additional v3 gates:

```text
verify_equilibrium_artifact_schema
verify_m0_unit_norm
verify_equilibrium_torque_residual
verify_material_physics_hash_match
verify_static_demag_available_if_required
verify_no_mesh_mutation_after_relaxation
verify_periodic_pair_bijection
verify_translation_residual
verify_boundary_element_topology_match
verify_material_periodic_match
verify_m0_periodic_seam_match
verify_airbox_periodic_pair_match
verify_open_axis_boundary_labels
verify_tangent_frame_periodic_transport
verify_cartesian3_to_tangent2_lift_project_roundtrip
verify_full_coupled_vs_schur_residual_reconstruction
```

The first production PBC/Floquet FEM path requires a matched symmetric mesh. Non-matching periodic boundaries must be rejected until a mortar/Nitsche/interpolated constraint backend exists.




---

<!-- source: fd_solver_plan_08_patch_queue.md -->

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



---

<!-- source: fd_solver_plan_09_sources_and_traceability.md -->

# Frequency-driven solver — sources and traceability

Ten dokument mapuje najważniejsze decyzje masterplanu do źródeł: manuala Micromagnetics Module i obecnego kodu/logów.

---

## 1. Manual Micromagnetics Module User’s Guide V2.13

### Frequency Domain jako linearized LLG

Manual, rozdział V.A, s. 16:

```text
m = m0 + δm exp(iωt)
manual follows exp(+iωt), not exp(-iωt)
m0 · δm = 0
iωδm = -γ m0×δh_eff - γ δm×h_eff0 + iωα m0×δm
```

Decyzja w masterplanie:

```text
default phasor convention = exp_plus_i_omega_t
canonical unknown = complex Cartesian δm ∈ C^3
constraint = m0·δm = 0
```

### Dependent variables i rekonstrukcja czasu

Manual, rozdział V.B, s. 17:

```text
Frequency Domain dependent variables are complex δm=(δmx,δmy,δmz), named dmX, dmY, dmZ.
m(t)=m0+Re(δm exp(iωt)).
```

Decyzja:

```text
Cartesian3 complex constrained is external physics contract.
Tangent2 complex is internal optimized representation.
```

### Dynamic external field semantics

Manual, s. 18:

```text
δh is entered as the magnitude/amplitude of dynamical external field.
Do not include sinusoidal term; harmonic factor exp(iωt) is attached by solver.
```

Decyzja:

```text
drive_kind=dynamic_field_phasor_a_per_m is default COMSOL-compatible drive.
tangent_rhs is low-level/debug mode, not default user-facing physics.
```

### Equilibrium state

Manual, s. 18-19 and skyrmion example s. 26-27:

```text
m0 should be ground/stable state for given effective fields.
Complex textures should be inherited from time-domain relaxation.
Parameters/effective fields must be consistent between time-domain and frequency-domain.
```

Decyzja:

```text
LinearizationState with material/physics hash, m0 norm error, m0×h_eff0 residual.
```

### DMI

Manual, s. 20:

```text
DMI has static and dynamic components.
Note: it is still unknown how DMI boundary condition can be correctly modelled.
```

Decyzja:

```text
DMI volume operator can be production after tests.
Frequency-domain DMI boundary terms remain experimental/unsupported unless certified.
```

### Zero drive

Manual, s. 21:

```text
For Frequency Domain study, external perturbation δh needs to be applied; otherwise solution is zero everywhere.
```

Decyzja:

```text
zero drive is valid zero response in COMSOL-compatible driven study mode.
zero RHS can still be validation_error in solver-benchmark mode.
```

### Floquet

Manual, s. 22-23:

```text
δm_dst = δm_src exp(-i kF·(r_dst-r_src))
Floquet is especially useful for eigenfrequency/band structure.
```

Decyzja:

```text
Floquet belongs in core FrequencyProblemSpec for modal and driven response.
```

### Magnetostatic coupling in frequency domain

Manual, rozdział VII.A.2, s. 35-36:

```text
frequency-domain magnetostatic modes require dynamic spin-wave excitation and dynamic demagnetizing field solved consistently.
Workflow uses time-domain relaxation/static demag and a second Magnetic Fields No Currents interface for dynamic demag.
```

Decyzja:

```text
full coupled δm/φ system is production core for dynamic demag/airbox.
Schur is certified fast path only.
```

---

## 2. Obecny kod — najważniejsze obserwacje

### Tangent layout

`mfem_tangent_space(1).cpp`:

```text
full_dof_count = 3 per node
tangent_dof_count = 2 per node
```

Decyzja:

```text
tangent2 is already natural internal representation.
Add explicit Cartesian↔tangent equivalence gates.
```

### Hostowy GMRES

`production_cpu_driven_response.cpp`:

```text
basis, preconditioned_basis, Hessenberg, residuals and workspaces are std::vector<double>.
Orthogonalization uses CPU dot/norm/loops.
should_publish_progress uses max(1, progress_interval_iterations).
```

Decyzja:

```text
current GPU path should be named gpu_operator_host_krylov.
progress_interval=0 must not mean every iteration.
GPU device Krylov is a future backend, not current behavior.
```

### Dense real split

`dense_driven_response(1).cpp`:

```text
real split uses [K, +ωM; -ωM, K].
```

Decyzja:

```text
this is internal algebra form requiring phase-convention gate against exp(+iωt).
```

### Modal infrastructure

`modal_eigen_solver.hpp/cpp`, `slepc_modal_eigen.cpp`, `contour_interval_solver.cpp`, `window_partition.cpp`, `mode_deduplication.cpp`:

```text
existing direction includes SLEPc shift-invert, contour windows and mode deduplication.
```

Decyzja:

```text
modal-reduced backend should be a major backend for sweeps, not an afterthought.
```

### Log stagnation

Runtime logs:

```text
periodic_airbox_k0 single frequency at 2 GHz.
GMRES residual decreases very slowly, e.g. about 0.7429 -> 0.7274 over ~192 iterations.
Snapshot sync warnings ~350-400 ms appear, but residual stagnation is the main numerical blocker.
```

Decyzja:

```text
fix algebra/preconditioner before investing in device-resident FGMRES.
Do bounded 64/256 runs and Schur quality diagnostics; stop 8192-run guessing.
```

---

## 3. Traceability table

| Masterplan decision | Primary source |
|---|---|
| `exp(+iωt)` default | Manual V.A, p.16 |
| `δm ∈ C^3`, `dmX/dmY/dmZ` | Manual V.B, p.17 |
| `δh` as phasor amplitude | Manual V.B.1, p.18 |
| `m0` from stable/relaxed state | Manual V.B.1 and V.G, p.18-19, p.26-27 |
| DMI boundary experimental | Manual V.B.3, p.20 |
| Floquet phase formula | Manual V.E.3, p.22-23 |
| full coupled dynamic demag core | Manual VII.A.2, p.35-36 |
| tangent2 internal representation | current mfem tangent layout |
| current path = host Krylov | current production_cpu_driven_response.cpp |
| sparse/direct baseline before GPU | log stagnation + need for oracle |
| modal-reduced for sweeps | manual frequency sweep/eigenfrequency + current SLEPc/contour code |



---

<!-- source: fd_solver_plan_10_relaxed_texture_handoff.md -->

# Frequency-driven solver — relaxed nonlinear texture handoff

Status: **COMSOL-aligned v3 addendum**  
Scope: transfer of a relaxed nonlinear magnetic texture, e.g. skyrmion/domain wall/antidot equilibrium, from relaxation/static demag into modal and driven frequency-domain solvers.

---

## 1. Decision

The frequency-domain solver must **not** build its own hidden equilibrium state. It must consume an explicitly accepted and versioned `EquilibriumArtifact` produced by a relaxation/static-demag stage.

The canonical workflow is:

```text
mesh/material/physics/BC
  -> relaxation/static demag solve
  -> accepted equilibrium artifact
  -> linearization state builder
  -> tangent/cartesian equivalence gates
  -> frequency solve planner
  -> backend solve
```

For nonlinear textures such as skyrmions, the relaxed field is not an optional initial guess. It is the **linearization point**:

```text
m(r,t) = m0(r) + delta_m(r) exp(+i omega t)
```

where `m0(r)` is the relaxed texture and `delta_m` is constrained by:

```text
m0(r) · delta_m(r) = 0
```

Any frequency-domain response or eigenfrequency result is physically meaningful only for the exact `m0`, static fields, material snapshot, boundary conditions, demag model, mesh and periodic-pair mapping used to construct the linearized operator.

---

## 2. Physics contract after relaxation

### 2.1. Inputs from relaxation

The frequency-domain stage consumes:

```text
m0_unit(r)                relaxed unit magnetization
H_demag0(r)               static demagnetizing field, if demag enabled
phi_demag0(r)             static scalar potential, if airbox Poisson is used
h_ext0(r)                 static external/bias field
material_snapshot(r)      Ms, alpha, A, K, D, anisotropy axes, region IDs
physics_terms             exchange/aniso/Zeeman/DMI/demag/STT/EASA flags
mesh_snapshot             magnetic mesh, airbox mesh, FE spaces, node ordering
periodic_pairs            magnetic and airbox pair maps, translations, orientations
relaxation_diagnostics    torque residual, energy trend, unit norm, seam residuals
```

The frequency-domain solver may recompute some static fields from `m0`, but the artifact must still record whether the consumed static field was:

```text
stored_from_relaxation
recomputed_for_frequency
recomputed_and_compared_to_relaxation
```

### 2.2. Linearized LLG around nonuniform texture

The physical equation is:

```text
i omega delta_m
  = - gamma m0 x delta_h_eff
    - gamma delta_m x h_eff0
    + i omega alpha m0 x delta_m
    + linearized source terms
```

where:

```text
h_eff0 = h_exchange0 + h_anisotropy0 + h_ext0 + h_DMI0 + h_demag0 + ...
delta_h_eff = delta_h_exchange[delta_m]
            + delta_h_anisotropy[delta_m]
            + delta_h_drive
            + delta_h_DMI[delta_m]
            + delta_h_demag[delta_m]
            + ...
```

For a skyrmion or any noncollinear equilibrium, `m0`, `h_eff0`, tangent frames and projected operator blocks vary spatially. The solver must never assume a global transverse plane.

### 2.3. Equilibrium quality gate

The artifact is usable for frequency-domain analysis only if:

```text
max_i ||m0_i|| - 1                      <= tolerance
max_i ||m0_i x h_eff0_i|| / scale       <= tolerance
energy trend near final relaxation      is stable
static demag seam residual              <= tolerance, if PBC/airbox enabled
magnetization seam residual             <= tolerance, if PBC enabled
material/BC periodic compatibility      passes
```

The frequency-domain stage must reject a short smoke relaxation artifact unless it carries an explicit `accepted_for_linearization=true` flag and the required diagnostics.

---

## 3. Artifact contract

### 3.1. EquilibriumArtifact schema

Minimum schema:

```json
{
  "schema_version": "frequency_domain_equilibrium.v1",
  "accepted_for_linearization": true,
  "equilibrium_id": "sha256:...",
  "mesh_snapshot_id": "sha256:...",
  "magnetic_mesh_id": "sha256:...",
  "airbox_mesh_id": "sha256:...",
  "material_snapshot_id": "sha256:...",
  "physics_snapshot_id": "sha256:...",
  "boundary_snapshot_id": "sha256:...",
  "demag_model": "periodic_airbox_k0",
  "phase_convention_for_frequency": "exp_plus_i_omega_t",
  "fields": {
    "m0_unit": "fields/m0_unit.zarr",
    "h_eff0_a_per_m": "fields/h_eff0.zarr",
    "h_demag0_a_per_m": "fields/h_demag0.zarr",
    "phi_demag0": "fields/phi_demag0.zarr"
  },
  "periodic_pairs": {
    "magnetic": "mesh/periodic_pairs.v1.json",
    "airbox_scalar_potential": "mesh/airbox_periodic_pairs.v1.json"
  },
  "diagnostics": {
    "max_m0_norm_error": 0.0,
    "max_relative_torque_residual": 0.0,
    "max_magnetic_seam_mismatch": 0.0,
    "max_static_demag_seam_mismatch": 0.0,
    "primitive_supercell_parity": "accepted"
  }
}
```

The solver must store and compare all IDs. If any relevant ID changes, the frequency-domain plan must invalidate the artifact.

### 3.2. Required field layouts

`m0_unit`:

```text
node_count magnetic nodes
components x,y,z
unitless
same node order as magnetic mesh snapshot
```

`h_eff0_a_per_m`:

```text
node_count magnetic nodes
components x,y,z
A/m
contains all static effective field terms included in the linearized operator
```

`h_demag0_a_per_m`:

```text
node_count magnetic nodes, and optionally airbox nodes
components x,y,z
A/m
static demag field used in h_eff0
```

`phi_demag0`:

```text
airbox scalar-potential FE nodes
units documented by demag backend
same gauge policy as the static demag solve
```

---

## 4. LinearizationState builder

### 4.1. Builder responsibilities

The builder turns a relaxation artifact into native data used by frequency-domain backends:

```text
EquilibriumArtifact
  -> verified mesh/material/BC snapshot
  -> m0 normalization check
  -> h_eff0 recompute/verify
  -> tangent frame construction
  -> periodic frame transport
  -> operator descriptors
  -> drive projection
  -> solver planner input
```

### 4.2. C++ skeleton

```cpp
struct EquilibriumArtifactDescriptor {
    const char* equilibrium_id;
    const char* mesh_snapshot_id;
    const char* magnetic_mesh_id;
    const char* airbox_mesh_id;
    const char* material_snapshot_id;
    const char* physics_snapshot_id;
    const char* boundary_snapshot_id;

    const double* m0_xyz;       // length = 3 * magnetic_node_count
    const double* h_eff0_xyz;   // optional but preferred
    const double* h_demag0_xyz; // optional if demag disabled
    const double* phi0;         // optional scalar potential on airbox mesh

    uint64_t magnetic_node_count;
    uint64_t airbox_node_count;
    bool accepted_for_linearization;
    const char* demag_model;
};

struct LinearizationBuildOptions {
    double m0_norm_tolerance = 1.0e-10;
    double equilibrium_torque_relative_tolerance = 1.0e-6;
    double periodic_seam_tolerance = 1.0e-8;
    bool allow_m0_renormalization = true;
    bool require_static_demag_if_enabled = true;
    bool require_symmetric_periodic_mesh = true;
    bool recompute_h_eff0_and_compare = true;
};

struct LinearizationStateNative {
    uint64_t node_count;
    std::vector<TangentFrameNode> tangent_frames;
    std::vector<double> m0_xyz;
    std::vector<double> h_eff0_xyz;
    std::vector<double> h_demag0_xyz;
    std::vector<double> tangent_lumped_mass;
    std::string equilibrium_id;
    std::string linearization_signature_hash;
};

FrequencyDomainStatus build_linearization_state_from_equilibrium(
    const EquilibriumArtifactDescriptor& artifact,
    const MeshSnapshot& mesh,
    const MaterialSnapshot& material,
    const BoundaryConditionSnapshot& boundary,
    const LinearizationBuildOptions& options,
    LinearizationStateNative& out_state,
    LinearizationDiagnostics& out_diagnostics) noexcept;
```

---

## 5. Tangent frames for nonlinear textures

### 5.1. Why this matters

For a collinear equilibrium, all nodes share approximately the same tangent plane. For a skyrmion, `m0` changes rapidly, so every node has its own tangent plane. The local unknown is:

```text
q_i = [u_i, v_i] in C^2
```

and:

```text
delta_m_i = e1_i u_i + e2_i v_i
```

A bad frame gauge can create artificial discontinuities across periodic seams or inside smooth textures.

### 5.2. Deterministic frame construction

Use a deterministic reference axis with fallback:

```cpp
inline TangentFrameNode make_tangent_frame_from_m0(
    const double m0[3],
    const double preferred_axis[3]) noexcept
{
    TangentFrameNode f{};
    f.m[0] = m0[0]; f.m[1] = m0[1]; f.m[2] = m0[2];

    double a[3] = {preferred_axis[0], preferred_axis[1], preferred_axis[2]};
    if (std::abs(dot3(a, f.m)) > 0.95) {
        a[0] = 1.0; a[1] = 0.0; a[2] = 0.0;
        if (std::abs(dot3(a, f.m)) > 0.95) {
            a[0] = 0.0; a[1] = 1.0; a[2] = 0.0;
        }
    }

    // e1 = normalized(a - (a.m)m)
    double e1[3] = {
        a[0] - dot3(a, f.m) * f.m[0],
        a[1] - dot3(a, f.m) * f.m[1],
        a[2] - dot3(a, f.m) * f.m[2]
    };
    normalize3(e1);

    double e2[3];
    cross3(f.m, e1, e2);
    normalize3(e2);

    f.e1[0] = e1[0]; f.e1[1] = e1[1]; f.e1[2] = e1[2];
    f.e2[0] = e2[0]; f.e2[1] = e2[1]; f.e2[2] = e2[2];
    return f;
}
```

For periodic meshes, this is not sufficient by itself. Paired boundary frames must be repaired or transported.

### 5.3. Periodic frame transport

For a zero-phase periodic unit cell:

```text
delta_m_dst = delta_m_src
```

With tangent bases:

```text
T_dst q_dst = T_src q_src
q_dst = T_dst^T T_src q_src
```

For Floquet/Bloch perturbations:

```text
delta_m_dst = exp(-i k · delta_r) delta_m_src
q_dst = exp(-i k · delta_r) (T_dst^T T_src) q_src
```

The periodic constraint is scalar-only **only when**:

```text
T_dst^T T_src ≈ I
```

Otherwise the backend must either enforce the full 2x2 transport matrix or reject the request.

### 5.4. Frame seam repair

For strict matched periodic meshes, the preferred approach for k=0 static periodic slices is:

```text
1. Build frames on source side.
2. Copy/transport source frame orientation to destination side when m0_dst ≈ m0_src.
3. Re-orthonormalize destination frame against m0_dst.
4. Record frame transport residual.
```

Diagnostics:

```json
{
  "periodic_frame_transport": {
    "max_TdstT_Tsrc_minus_I_frobenius": 2.0e-12,
    "max_m0_pair_mismatch": 4.0e-13,
    "transport_policy": "source_to_destination_reorthonormalized"
  }
}
```

---

## 6. Symmetric mesh contract

### 6.1. Strict v1 policy

For production PBC/Floquet frequency-domain FEM, v1 requires a **matched symmetric mesh** on periodic boundaries.

Required properties:

```text
same number of source/destination boundary nodes
bijective node pairing
x_dst = x_src + translation within tolerance
same FE order and boundary element topology
same material labels and region IDs across paired nodes/elements
same magnetic/airbox boundary classification
consistent normal orientation
no duplicate source or destination nodes
no missing seam vertices/edges/faces
```

If this is not true, v1 rejects PBC/Floquet frequency-domain solve. Future versions can add mortar/Nitsche/interpolation constraints, but not in the first production path.

### 6.2. Magnetic mesh and airbox mesh must both be compatible

For periodic-airbox demag, the symmetry requirement is not only magnetic:

```text
magnetic periodic pairs      required for m0 and delta_m
airbox scalar-potential pairs required for phi / demag Poisson
open-axis airbox labels       required for nonperiodic direction
```

For a thin-film unit cell with lateral PBC and open z:

```text
x/y periodic faces: matched pairs
z open faces: Robin/Dirichlet/open-airbox policy, not periodic pairs
```

### 6.3. MeshSymmetryCertificate

```cpp
struct MeshSymmetryCertificate {
    bool accepted;
    uint64_t source_node_count;
    uint64_t destination_node_count;
    uint64_t pair_count;
    double max_translation_residual_m;
    double max_material_mismatch;      // 0 for exact categorical match
    double max_m0_pair_mismatch;
    double max_frame_transport_error;
    double max_airbox_phi_pair_mismatch;
    const char* rejection_reason;
};
```

### 6.4. Runtime rejection examples

Reject with detailed reason:

```text
periodic_mesh_pair_count_mismatch
periodic_mesh_translation_residual_too_large
periodic_material_mismatch
periodic_airbox_pair_missing
periodic_tangent_frame_transport_unsupported
nonzero_k_dynamic_demag_unsupported
```

---

## 7. Static demag and airbox handoff

### 7.1. Static demag belongs to h_eff0

The relaxation/static stage computes:

```text
H_demag0 = -grad(phi0)
```

or equivalent demag field. This field enters `h_eff0`, hence the linearized term:

```text
- gamma delta_m x h_eff0
```

If `H_demag0` is omitted, the frequency operator is linearized around the wrong equilibrium.

### 7.2. Dynamic demag belongs to delta_h_eff

The frequency solve also needs the derivative:

```text
delta_m -> delta_H_demag[delta_m]
```

Representations:

```text
full coupled:
  [ A_mm(omega)  A_mphi ] [delta_m] = [b_m]
  [ A_phim       A_phiphi] [delta_phi] [b_phi]

Schur reduced:
  S(omega) delta_m = b_m - A_mphi A_phiphi^{-1} b_phi
```

The full coupled representation is the reference path. Schur is a certified fast path only.

### 7.3. Same airbox, same gauge, same pair map

The dynamic demag operator must use the same geometric and boundary-condition model as the static demag solve unless an explicit remap has been certified:

```text
same airbox mesh ID
same magnetic submesh ID
same periodic pair map
same open-axis treatment
same Poisson gauge/nullspace policy
same Ms scaling convention
```

---

## 8. Operator assembly around a skyrmion

### 8.1. Local terms

Local terms become nodewise tangent blocks depending on `m0_i` and material:

```text
Zeeman/static field:        T_i^T d[-gamma delta_m x h0] T_i
Anisotropy derivative:      T_i^T d[-gamma m x h_aniso] T_i
Damping/mass/gyrotropic:    T_i^T [m0_i x] T_i
```

### 8.2. Exchange/nonlocal terms

Exchange for a noncollinear texture is not a scalar-only global plane operator. Between nodes `i` and `j` the tangent block is conceptually:

```text
K_ij^tan = T_i^T K_ij^cart T_j
```

For strict production, edge operators should be able to represent full 2x2 tangent blocks, not only scalar stiffness. A scalar edge can still be used as a compact storage only if the apply function receives both endpoint frames and constructs the correct `T_i^T T_j` coupling.

### 8.3. Dynamic demag derivative

Dynamic demag should be tested as a Frechet derivative:

```text
D_demag[m0](delta_m) = H_demag[m0 + epsilon delta_m] - H_demag[m0]
                       ---------------------------------------------
                                      epsilon
```

for small problems or diagnostic fixtures.

---

## 9. API additions

### 9.1. Frequency response request references equilibrium

```cpp
struct FrequencyLinearizationInput {
    const char* equilibrium_artifact_uri;
    const char* equilibrium_id;
    const char* mesh_snapshot_id;
    const char* material_snapshot_id;
    const char* physics_snapshot_id;
    const char* boundary_snapshot_id;
    bool require_accepted_equilibrium;
    bool require_symmetric_periodic_mesh;
    bool require_static_demag_consistency;
};
```

### 9.2. Planner feature flags

```cpp
struct FrequencyProblemDescriptor {
    bool has_relaxed_texture;
    bool has_noncollinear_m0;
    bool has_periodic_pairs;
    bool has_symmetric_periodic_mesh_certificate;
    bool has_airbox;
    bool has_static_demag0;
    bool has_dynamic_demag_operator;
    bool has_full_coupled_demag_blocks;
    bool has_schur_certificate;
    uint64_t magnetic_node_count;
    uint64_t tangent_dof_count;
};
```

Planner rule:

```cpp
if (problem.has_periodic_pairs &&
    !problem.has_symmetric_periodic_mesh_certificate &&
    policy.strict_periodic_fem) {
    return reject("periodic_frequency_domain_requires_symmetric_mesh_certificate");
}

if (problem.has_airbox && !problem.has_static_demag0) {
    return reject("frequency_domain_airbox_requires_static_demag_equilibrium_field");
}
```

---

## 10. Validation gates

### 10.1. Equilibrium artifact gate

```text
verify_equilibrium_artifact_schema
verify_m0_unit_norm
verify_equilibrium_torque_residual
verify_material_physics_hash_match
verify_static_demag_available_if_required
verify_no_mesh_mutation_after_relaxation
```

### 10.2. Symmetric mesh gate

```text
verify_periodic_pair_bijection
verify_translation_residual
verify_boundary_element_topology_match
verify_material_periodic_match
verify_m0_periodic_seam_match
verify_airbox_periodic_pair_match
verify_open_axis_boundary_labels
```

### 10.3. Linearization gate

```text
verify_cartesian3_to_tangent2_lift_project_roundtrip
verify_m0_dot_delta_m_zero
verify_tangent_frame_periodic_transport
verify_drive_delta_h_projection_sign
verify_dense_cartesian_vs_dense_tangent
```

### 10.4. Demag gate

```text
verify_static_demag_sign
verify_static_demag_seam
verify_dynamic_demag_linearity
verify_full_coupled_vs_schur_residual_reconstruction
verify_primitive_vs_supercell_static_demag_parity
```

---

## 11. Implementation patch queue

### Patch R1 — documentation and schema only

- Add this document.
- Add `EquilibriumArtifact` and `FrequencyLinearizationInput` schemas to docs.
- Document symmetric mesh certificate.
- No behavior changes.

### Patch R2 — runner consumes accepted equilibrium artifact

- Frequency-response and modal stages must receive an `equilibrium_artifact_uri`.
- Reject periodic-airbox frequency solves without accepted static PBC equilibrium.
- Preserve legacy path only behind `allow_unaccepted_relaxation_smoke=true` for tests.

### Patch R3 — native LinearizationState builder

- Load `m0`, `h_eff0`, `h_demag0` and material snapshot.
- Build tangent frames.
- Emit tangent-frame diagnostics.
- Validate `m0 · delta_m` and `|m0|`.

### Patch R4 — symmetric mesh certificate

- Build magnetic periodic-pair certificate.
- Build airbox scalar-potential pair certificate.
- Enforce strict v1 matched mesh policy for periodic frequency-domain FEM.

### Patch R5 — full coupled demag reference path

- Build full coupled block operator using accepted equilibrium.
- Add tiny/dense full-vs-Schur oracle.
- Only then promote Schur-reduced path.

### Patch R6 — artifact export in physical coordinates

- Export `dmX/dmY/dmZ` as public fields.
- Export `u/v` tangent fields as internal provenance.
- Export `m0`, `m0_dot_delta_m`, tangent leakage, frame transport diagnostics.

---

## 12. Non-negotiable rule

A frequency-domain result for a nonlinear texture is valid only if it can answer:

```text
Which exact equilibrium was linearized?
Which exact mesh and periodic pair map were used?
Which static demag field and gauge were used?
How was Cartesian delta_m constrained/projected to tangent unknowns?
Was the periodic seam symmetric and frame-transported?
Was full coupled demag consistent with Schur, if Schur was used?
```

If any answer is missing, the backend may still be a diagnostic experiment, but it is not production.



---

<!-- source: fd_solver_plan_11_decision_closures_adr.md -->

# Frequency-driven solver — ADR decision closures

Status: **accepted recommendations for next patch queue**  
Scope: public naming, drive/RHS semantics, zero-drive policy, phasor tokens, artifact representation, Schur certification, sparse backend choice, modal basis policy, GPU Krylov entry gate, and relaxed texture handoff.

---

## ADR-001 — GPU execution lane names

Decision:

```text
gpu_operator_host_krylov is public as a transitional/debug lane.
gpu_device_krylov is reserved for true device-resident Krylov.
production_gpu remains a legacy alias only.
```

Artifacts must emit:

```json
{
  "requested_execution_lane": "production_gpu",
  "resolved_execution_lane": "gpu_operator_host_krylov",
  "gpu_device_resident_krylov": false
}
```

C ABI may keep `PRODUCTION_GPU` temporarily, but native diagnostics and UI should not call it true device GPU.

---

## ADR-002 — Drive/RHS contract

Decision:

```text
Add drive_kind.
Default public drive is dynamic_field_phasor_a_per_m.
Raw tangent RHS remains expert/internal/test mode.
```

```cpp
enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};
```

Pipeline:

```text
delta_h phasor [A/m]
  -> cartesian linearized LLG source/torque
  -> tangent RHS projection
  -> backend solve
```

---

## ADR-003 — Zero-drive policy

Decision:

```text
FrequencyResponse + physical drive_kind: zero drive is valid zero response + warning.
SolverBenchmark + require_nonzero_rhs: zero drive is validation error.
Eigenfrequency/modal: drive is not required.
```

Implementation sequence:

```text
D1 runner short-circuits zero physical drive to zero response + warning.
D2 native receives drive_kind and require_nonzero_rhs.
D3 native GMRES no longer globally rejects zero RHS.
```

---

## ADR-004 — Phasor token

Decision:

```text
Canonical artifact token: exp_plus_i_omega_t
Legacy accepted aliases: exp_i_omega_t, exp(+i omega t)
Do not emit aliases from new artifacts.
```

Every backend must pass a sign gate against the canonical phasor convention and the internal real split used by that backend.

---

## ADR-005 — Public field representation

Decision:

```text
Public physics artifact: cartesian3_complex_constrained delta_m.
Internal solver representation: tangent2_complex unless backend states otherwise.
```

Public fields:

```text
dmX_real, dmX_imag
dmY_real, dmY_imag
dmZ_real, dmZ_imag
abs_delta_m
phase_dmX, phase_dmY, phase_dmZ
m0_dot_delta_m_real, m0_dot_delta_m_imag
```

Internal/provenance fields:

```text
tangent_u_real, tangent_u_imag
tangent_v_real, tangent_v_imag
tangent_frame_e1/e2 diagnostics
```

---

## ADR-006 — Schur certificate key and scope

Decision:

A Schur certificate is bound to the full problem signature:

```text
mesh topology + geometry
FE space
material snapshot
equilibrium m0
static effective field
static demag field and gauge
physics terms
boundary conditions
periodic/Floquet pairs
k vector or k=0 declaration
demag/airbox operator
projection/tangent-frame policy
phase convention
backend version
frequency or frequency window
```

Default scope:

```text
single_frequency
```

Frequency-window certificates require multiple sample checks and stable correction/preconditioner behavior across the window.

---

## ADR-007 — Schur gates

Decision:

Algebraic gates:

| Gate | tiny/dense | CPU matrix-free | GPU/HYPRE |
|---|---:|---:|---:|
| Schur matrix-free vs reference | 1e-10 | 1e-8 | 1e-6 |
| full-vs-reduced residual reconstruction | 1e-10 | 1e-8 | 1e-6 |
| cartesian3 vs tangent2 | 1e-10 | 1e-8 | 1e-6 |

Runtime Schur preconditioner quality:

```text
eta = ||r - A P^-1 r|| / ||r||
```

| eta | Decision |
|---:|---|
| <= 0.30 | good |
| 0.30 - 0.70 | acceptable if pilot confirms |
| 0.70 - 0.90 | weak, not default unless it beats fallback |
| > 0.90 | do not choose by default |
| > 1.05 | harmful, auto-disable |

Pilot selection:

```text
primary_schur_pilot_relres <= 0.8 * min(fallback_pilot_relres, unpreconditioned_pilot_relres)
```

---

## ADR-008 — CPU sparse/direct backend

Decision:

```text
First direct sparse backend: PETSc.
```

MVP:

```text
PETSc Mat AIJ
KSPPREONLY
PCLU
default LU package first; MUMPS/SuperLU_DIST optional by build capability
real-split A(omega) as first implementation
```

This backend is a diagnostic and production fallback oracle, not necessarily the fastest backend for the largest workloads.

---

## ADR-009 — Modal reduced sweep basis policy

Decision:

```text
modal_reduced primarily consumes existing modal_eigen artifacts.
It may compute its own basis only when policy allows.
```

```cpp
enum class ModalBasisPolicy : std::uint32_t {
    use_existing_required = 1,
    use_existing_or_compute = 2,
    force_recompute = 3,
};
```

The modal basis cache key must include operator/equilibrium/material/boundary/demag/phase/frequency-window signatures.

---

## ADR-010 — Entry gate for true GPU device Krylov

Decision:

Do not start `gpu_device_krylov` until these pass:

```text
phase and drive gates
dense cartesian/tangent gates
accepted equilibrium handoff
CPU sparse/direct oracle for target slices
Schur certificate for Schur path, if Schur is used
host-GMRES bounded 64/256 shows real residual decline
tracked residual approximately matches recomputed residual
telemetry shows no unexpected per-iteration H2D/D2H in intended GPU path
```

Then implement:

```text
device-resident FGMRES
fused A(omega)x
GPU preconditioner
cuBLAS/cuSPARSE orthogonalization
CUDA Graphs only after residency is proven
```

---

## ADR-011 — Relaxed nonlinear texture handoff

Decision:

```text
Frequency-domain stages must consume an accepted EquilibriumArtifact.
They must not silently linearize around a transient/short relaxation smoke state.
```

For skyrmions/noncollinear textures:

```text
m0 is spatially varying
h_eff0 must correspond to the same m0 and physics settings
tangent frames are node-local
periodic frame transport is part of the constraint
demag static field belongs to h_eff0
dynamic demag derivative belongs to delta_h_eff
```

The strict v1 periodic FEM policy requires a symmetric matched mesh certificate. If the mesh is not pairwise compatible, periodic/Floquet frequency-domain solve is rejected until a mortar/Nitsche/interpolated constraint backend exists.

---

## ADR-012 — Symmetric periodic mesh policy

Decision:

```text
For production PBC/Floquet FEM v1, matched symmetric meshes are required.
```

Required certificate:

```text
bijective source/destination node pairs
translation residual below tolerance
matched boundary element topology
matched FE order/material labels
magnetic and airbox pair maps where needed
m0 seam mismatch below tolerance
static demag seam mismatch below tolerance
tangent frame transport supported
```

Planner rule:

```text
periodic requested + no symmetric mesh certificate => reject with actionable reason
```

---

## Patch order after these ADRs

```text
A. Docs/ADR update.
B. Rename/provenance lanes: production_gpu -> gpu_operator_host_krylov resolved lane.
C. Add drive_kind in IR/Python/native schema, keep UX stable.
D. Add zero-drive physical policy in runner.
E. Add EquilibriumArtifact and LinearizationInput schemas.
F. Build native LinearizationState from accepted equilibrium.
G. Add symmetric mesh certificate enforcement.
H. Add CPU sparse/direct PETSc baseline.
I. Add full-coupled demag oracle/field-split path.
J. Certify Schur.
K. Modal-reduced basis cache.
L. True gpu_device_krylov.
```

