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

