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
