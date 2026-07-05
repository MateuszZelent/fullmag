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

