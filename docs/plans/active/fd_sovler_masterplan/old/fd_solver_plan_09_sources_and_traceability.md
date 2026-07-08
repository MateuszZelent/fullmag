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
