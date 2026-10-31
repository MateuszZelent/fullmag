# FEM Static/Time-Domain PBC — Interfacial and Bulk DMI (PR-5)

## Status

**Implemented and validated** — PR-5A (Rust reference engine) and PR-5B (native MFEM/C++ backend) complete.

---

## 1. Physical problem statement

A micromagnetic body with Dzyaloshinskii–Moriya interaction (DMI) under periodic boundary
conditions (PBC) describes an infinite lattice of repeated unit cells in one or more spatial
directions.  The two standard DMI forms are:

- **Interfacial (Néel) DMI** — arises at symmetry-breaking interfaces (heavy-metal/ferromagnet);
  the effective field has the form

  $$\mathbf{H}_\text{DMI}^{\text{int}} = \frac{2D}{\mu_0 M_s} \bigl[ \nabla(\mathbf{m} \cdot \hat{n}) - \hat{n}(\nabla \cdot \mathbf{m}) \bigr]$$

  where $D$ [J/m²] is the surface DMI constant and $\hat{n}$ is the interface normal.

- **Bulk (Bloch) DMI** — arises in non-centrosymmetric bulk crystals; the effective field is

  $$\mathbf{H}_\text{DMI}^{\text{bulk}} = -\frac{2D_b}{\mu_0 M_s} \nabla \times \mathbf{m}$$

  where $D_b$ [J/m²] is the bulk DMI constant in the current Fullmag convention.

---

## 2. Governing equations

Both DMI forms involve **first-order spatial differential operators** applied to $\mathbf{m}$.
In the FEM context the discrete operators are assembled by integrating shape-function
gradients over elements, weighted by the local DMI constant.

In the presence of PBC the key constraint is that the periodic seam is **not** a physical
boundary — it is an internal interface.  No natural boundary correction terms (surface
integral contributions) should appear on periodic seam faces.

---

## 3. Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| $D$ | interfacial DMI constant | J/m² |
| $D_b$ | bulk DMI constant | J/m² |
| $M_s$ | saturation magnetisation | A/m |
| $\mu_0$ | permeability of free space | H/m |
| $\hat{n}$ | interface normal (unit vector) | — |
| $\mathbf{H}_\text{DMI}$ | DMI effective field | A/m |

---

## 4. Assumptions and validity limits

1. DMI constants are uniform within each magnetic domain (per-node variations via
   `Dind_field` / `Dbulk_field` are supported if consistent across periodic classes).
2. Static PBC: periodic seam faces are treated as internal — no free-surface DMI
   boundary terms appear there.
3. The periodic constraint applies to **volume** operators only; surface integral BC terms
   that would arise at physical boundaries are excluded from seam faces.
4. The implementation uses the **class-projection strategy**: after computing the FEM
   DMI field, values at all nodes within the same periodic equivalence class are averaged
   to enforce translational consistency.  This is correct for local-volume operators such
   as DMI (contrast with global operators like Poisson demag which require full P^T A P
   algebraic reduction).

---

## 5. FDM interpretation

FDM DMI PBC is handled separately (periodic axis wraps naturally in the FDM stencil).

---

## 6. FEM interpretation

### 6.1 Algebraic structure

DMI operators are **local** (element-local gradient evaluations).  Unlike the Poisson
demag operator — which is globally coupled and requires P^T A P algebraic reduction — DMI
only requires enforcing the periodicity constraint on the **output field**:

1. Input $\mathbf{m}$: apply static periodic constraints (all class nodes take the
   representative value) before element loops.
2. Compute DMI field element-by-element (standard FEM gradient assembly).
3. Output $\mathbf{H}_\text{DMI}$: project field values by periodic class (average /
   copy representative value to all class nodes).

This two-step input/output projection ensures the field is periodic and free from
spurious discontinuities at the seam.

### 6.2 Seam boundary treatment

Natural boundary condition terms that arise in the weak form of curl/div operators are
**excluded** from periodic seam faces.  In the native C++ backend, seam faces are
identified via `periodic_boundary_marker_set` (same marker-set used for demag PBC
seam exclusion in PR-4).

---

## 7. CPU/GPU/backend interpretation

| Path | Backend | Notes |
|---|---|---|
| Rust reference (PR-5A) | `fullmag-engine` `FemLlgProblem` | `dmi_fields_from_vectors` / `dmi_fields_add_into` apply class projection |
| Native C++ (PR-5B) | `mfem_bridge.cpp` | `project_static_periodic_aos` called after `compute_interfacial_dmi_field` and `compute_bulk_dmi_field` |

---

## 8. Public Python API impact

No API change required.  The existing `interfacial_dmi` and `bulk_dmi` parameters in the
Python DSL already flow to `EffectiveFieldTerms.interfacial_dmi` and `.bulk_dmi`.  The
PBC + DMI combination is now accepted where previously blocked.

---

## 9. ProblemIR impact

`crates/fullmag-plan/src/fem.rs`: the guard that rejected `periodic_node_pairs + DMI`
has been removed.  DMI + PBC now produces a valid `FemPlanIR`.

---

## 10. Planner/capability impact

`crates/fullmag-runner/src/dispatch.rs`:

- DMI + demag → `NativeDemagPoisson` (native MFEM Poisson for demag + class projection for DMI)
- DMI without demag → `NativeAnisotropy` (native exchange + class projection for DMI)
- `ReferenceReduction` variant is retained as future fallback for operator types requiring
  full algebraic reduction; no current routing path reaches it.

---

## 11. Runtime/session impact

No session lifecycle changes.  PBC + DMI problems now complete execution where previously
they failed at planning.

---

## 12. Artifact/provenance impact

The `periodic_boundary_pairs` and `periodic_node_pairs` metadata are carried through the
plan and visible in execution records.  No additional provenance fields required.

---

## 13. Validation plan

### Implemented tests

| Test | Location | What it checks |
|---|---|---|
| `reference_semantics_accepts_dmi_static_periodic` | `fem.rs` tests | planner accepts DMI + PBC |
| `periodic_pair_interfacial_dmi_field_equality` | `fem.rs` tests | H_DMI[node_a] == H_DMI[node_b] for pair |
| `bulk_dmi_uniform_magnetization_gives_zero_field` | `fem.rs` tests | ∇ × m = 0 for uniform m |
| `execute_fem_dmi_pbc_routes_to_native_after_pr5b` | `dispatch.rs` tests | DMI dispatch → NativeAnisotropy |

### Deferred validation

- Spin-spiral ground state comparison: 1D periodic chain with $m(x) = [\cos(kx), \sin(kx), 0]$,
  bulk DMI should prefer a specific handedness and wavelength consistent with $k = D_b / A$.
- Cross-validation with mumax3 periodic DMI for a square periodic cell.

---

## 14. Completeness checklist

- [x] Physics note
- [x] PR-5A: Rust reference engine (`dmi_fields_from_vectors`, `dmi_fields_add_into`, `validate_reference_semantics`)
- [x] PR-5A: Planner guard removed (`fullmag-plan`)
- [x] PR-5B: Native C++ guard removed (`context.cpp`)
- [x] PR-5B: DMI field class projection added (`mfem_bridge.cpp`)
- [x] PR-5B: DMI material field class validation (`context.cpp`)
- [x] Dispatch routing updated (`dispatch.rs`)
- [x] Unit tests (3 Rust engine + 1 dispatch)
- [ ] Spin-spiral ground-state benchmark (deferred)
- [ ] mumax3 cross-validation (deferred)

---

## 15. Deferred work

- **PR-5C**: spin-spiral ground-state validation against analytical or mumax3 reference
- Full periodic seam exclusion validation for per-node `Dind_field` / `Dbulk_field` with non-uniform constants
