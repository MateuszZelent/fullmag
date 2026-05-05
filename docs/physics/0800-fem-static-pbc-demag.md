# FEM static/time-domain demag PBC

**Status**: PR-3 implementation (Rust reference path); PR-4 native MFEM/hypre path planned.

---

## 1. Physical problem statement

Micromagnetic samples that are periodic in one or two spatial directions —
magnonic crystals, periodic thin films, nanowire arrays — require demag
(magnetostatic) fields that are self-consistent with the periodic geometry.
A single-unit-cell FEM simulation must reproduce the magnetostatic potential
of an infinite array without actually meshing all neighbours.

---

## 2. Governing equations

The magnetostatic scalar potential `φ` satisfies the Poisson equation:

$$
\nabla \cdot \bigl( \nabla \varphi \bigr) = \nabla \cdot \mathbf{M}
$$

inside the magnetic body and

$$
\nabla^2 \varphi = 0
$$

in the air region.  The demagnetising field is:

$$
\mathbf{H}_\text{demag} = -\nabla \varphi
$$

The demagnetising energy is:

$$
E_\text{demag} = -\frac{\mu_0}{2} \int \mathbf{H}_\text{demag} \cdot \mathbf{M} \, dV
$$

---

## 3. Symbols and SI units

| Symbol | Description | SI unit |
|--------|-------------|---------|
| `φ` | Magnetostatic scalar potential | A |
| `M` | Magnetisation vector field | A/m |
| `H_demag` | Demagnetising field | A/m |
| `μ₀` | Permeability of free space | T·m/A |
| `E_demag` | Demagnetising energy | J |
| `P` | Periodic injection matrix (full→reduced) | dimensionless |

---

## 4. Periodic reduction algebra (v1)

Let `full_to_reduced[i]` map every full node `i` to its periodic class
representative index `c`.  Define the injection operator `P` such that
`(P q)[i] = q[full_to_reduced[i]]`.

The open-boundary (non-periodic) Poisson system assembled on the full mesh is:

$$
A_\text{open} \, \varphi_\text{full} = b(\mathbf{M})
$$

Applying periodic constraints:

$$
A_p = P^T A_\text{open} P, \quad b_p = P^T b(\mathbf{M})
$$

Solve the reduced system:

$$
A_p \, q = b_p
$$

Lift back to full space:

$$
\varphi_\text{full} = P q
$$

Recover the demagnetising field:

$$
\mathbf{H}_\text{demag} = -\nabla \varphi_\text{full}
$$

Project to periodic classes to remove rounding mismatches:

$$
\mathbf{H}_\text{demag}[i] \leftarrow \text{class\_average}(\mathbf{H}_\text{demag}, c_i)
$$

---

## 5. Assumptions and validity limits

### v1 supported geometries

- Periodic in **one or two** spatial axes.
- At least one axis is open (non-periodic) with air/Robin boundary.
- Shared-domain mesh that includes the airbox around the magnetic body.
- Periodic node pairs are provided via `mesh.periodic_node_pairs`.
- Periodic boundary pairs (with marker information for open-boundary exclusion)
  are provided via `mesh.periodic_boundary_pairs`.

### v1 rejected geometries

- **Fully periodic in all three axes**: the k=0 component of the demag tensor
  is undefined without a gauge convention.  Hard error:
  > "fully periodic FEM demag is not supported in static/time-domain v1; use at
  >  least one open axis."
- **Periodic magnetic mesh without shared-domain airbox**: periodic PBC on the
  magnetic surface without a matching periodic treatment of the airbox leads to
  incorrect Robin/open boundary leakage on the periodic seam.

---

## 6. Boundary semantics

### Open (non-periodic) boundaries

The Robin boundary condition `∂φ/∂n + β φ = 0` (or Dirichlet `φ = 0`) is
applied only on faces that belong to the **open** (non-periodic) airbox
boundaries.

### Periodic seam

Periodic side faces must **not** carry Robin or Dirichlet boundary conditions.
They are handled purely by the algebraic reduction:
- source nodes are merged into their target class by `P^T A P`;
- Robin surface mass is excluded from periodic side boundary faces.

Implementation: `build_boundary_mass_excluding_periodic_faces(mesh)` is used
instead of the full `boundary_mass_csr`.

---

## 7. FDM interpretation

FDM demag PBC uses the truncated-dipole-image convolution method (see
`0421-fdm-multilayer-convolution-demag.md`). There is no equivalent scalar
Poisson reduction for FDM; the demag kernel is handled in Fourier space with
PBC implicitly encoded by the convolution.

---

## 8. FEM interpretation

FEM demag PBC is implemented via explicit `P^T A P` reduction of the Poisson
operator assembled on the shared-domain mesh (magnetic body + airbox).
The Robin boundary is assembled only on open airbox faces (excluding periodic
seam faces).

---

## 9. Python API impact

```python
study.pbc(
    axes=["x", "y"],
    mode="static_node_pairs",
    demag="periodic_unit_cell_open_z",
    require_airbox_pairs=True,
)
```

Validation on the Python side:
```python
if backend == "fem" and demag and pbc and not mesh.has_periodic_boundary_pairs:
    raise ValueError(
        "FEM demag PBC requires periodic_boundary_pairs and shared-domain airbox mesh"
    )
```

---

## 10. ProblemIR impact

`MeshIR` must carry:
- `periodic_node_pairs: Vec<MeshPeriodicNodePairIR>`
- `periodic_boundary_pairs: Vec<MeshPeriodicBoundaryPairIR>` (with marker annotations)

The planner validates that both are present when `enable_demag && !periodic_node_pairs.is_empty()`.

---

## 11. Planner/capability impact

PR-3 unlocks demag PBC via the Rust reference solver for:
- up to two periodic axes
- `periodic_boundary_pairs.len() > 0`

PR-4 will unlock native MFEM/hypre CPU/GPU path.

---

## 12. Runtime/session impact

The dispatcher returns `FemStaticPbcLane::ReferenceReduction` for demag PBC,
which routes to `fem_baseline::execute_reference_fem`.  The provenance record
carries `effective_lane = "rust_reference"` and `unsupported_interactions = []`.

---

## 13. Artifact/provenance impact

Every run with demag PBC records:

```json
{
  "pbc": {
    "kind": "static_node_pairs",
    "node_pair_count": 512,
    "effective_lane": "rust_reference",
    "fallback": null,
    "unsupported_terms": []
  }
}
```

---

## 14. Validation plan

### Golden test: repeated supercell

1. Build a mesh of a thin disk with periodic pairs in x.
2. Run once with PBC demag.
3. Build a 3× repeated supercell (no PBC).
4. Extract the central unit-cell demag field.
5. Assert relative L2 error `≤ 5e-3`.

### Class consistency test

Assert `max_i |H_demag[i] - H_demag[rep(i)]| < 1e-10 * |H_demag[rep(i)]|`
for all periodic pairs.

### Energy sign test

Assert `E_demag < 0` for a uniform-magnetization state (demagnetising energy
is always negative in the convention `E = -μ₀/2 ∫ H·M dV`).

---

## 15. Completeness checklist

- [x] Algebraic reduction `reduce_csr_by_periodic_classes` implemented
- [x] RHS reduction `reduce_rhs_by_periodic_classes` implemented
- [x] Lift operator `lift_scalar_by_periodic_classes` implemented
- [x] Field projection `project_vector_field_by_periodic_classes` implemented
- [ ] Planner accepts demag + PBC when `periodic_boundary_pairs.len() > 0`
- [ ] `build_boundary_mass_excluding_periodic_faces` implemented in `fem.rs`
- [ ] `periodic_robin_demag_observables_from_vectors` integrated in `fem.rs`
- [ ] Golden repeated-supercell test passing
- [ ] Native MFEM/hypre path (PR-4)

---

## 16. Deferred work

- **Fully periodic 3D demag**: requires k=0 gauge convention (out of scope v1).
- **DMI PBC**: separate physics note `0810-fem-static-pbc-dmi.md` (PR-5).
- **Native MFEM/hypre demag PBC**: PR-4 — reduced sparse Poisson + hypre/AMG solve.
- **Floquet + dynamic demag**: not supported in static/time-domain path;
  frequency-domain Floquet demag is a separate problem.
