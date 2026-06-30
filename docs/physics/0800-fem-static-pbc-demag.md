# FEM static/time-domain demag PBC

**Status**: k=0 static/time-domain PBC demag is partial production executable
for the qualified CPU/MFEM shared-domain-airbox slice. The Rust reference path
and native MFEM reduced solve both have reduced-potential warm-start support;
strict GPU source support is present but remains unqualified until the managed
M5 GPU PBC relaxation gate proves device Poisson provenance and accepted
artifacts. Fully periodic 3D demag and frequency-domain dynamic demag remain
unqualified.

---

## 1. Physical problem statement

Micromagnetic samples that are periodic in one or two spatial directions,
including the film normal for stacked cells when the magnetostatic model allows
it, require demag (magnetostatic) fields that are self-consistent with the
periodic geometry.
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

For the Rust CPU reference time-domain path, the reduced CG solve may use the
previous reduced scalar potential `q` as the next initial guess. This
warm-start is a solver optimization only: it changes neither `A_p` nor `b_p`,
and a converged solve has the same physical solution as a zero-start solve.

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

For GPU relaxation, every accepted or trial magnetisation used by the
minimizer must also be projected onto the same static periodic classes after
nodal-sphere retraction:

$$
\mathbf{m}[i] \leftarrow \mathbf{m}[\text{representative}(c_i)]
$$

Without this step the periodic Poisson operator can be correct while the
magnetisation entering `b(M)` still contains a synthetic seam discontinuity.

---

## 5. Assumptions and validity limits

### v1 supported geometries

- Periodic in **one or two** spatial axes. The supported axis subset is not
  restricted to the film plane: `x`, `y`, `z`, `x/y`, `x/z`, and `y/z` are
  legal physical intents when the mesh provides matching periodic pairs.
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

The Rust CPU reference keeps the reduced potential in the reusable PBC demag
workspace and reuses it as the initial CG iterate on later reduced solves. The
non-PBC Robin/Dirichlet reference path remains zero-started in this slice.

---

## 9. Python API impact

```python
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.demag(realization="poisson_robin")
study.build_domain_mesh()
```

Validation on the Python side:
```python
if backend == "fem" and pbc:
    mesh_defaults.periodic_pair_ids = periodic_pair_ids_for_axes(problem.pbc.axes)
if backend == "fem" and demag and pbc and problem.pbc.demag != "periodic_airbox_k0":
    raise ValueError(
        "FEM demag PBC requires study.pbc(..., demag='periodic_airbox_k0')"
    )
if backend == "fem" and demag and pbc and not mesh.has_periodic_boundary_pairs:
    raise ValueError(
        "FEM demag PBC requires periodic_boundary_pairs and shared-domain airbox mesh"
    )
```

---

## 10. ProblemIR impact

`ProblemIR.pbc` is the physical source of truth for static/time-domain FEM
PBC. Mesh periodic-pair metadata is topology only: it tells the mesher/planner
which boundaries can be identified, but it must not enable periodic physics by
itself.

`MeshIR` must carry:
- `periodic_node_pairs: Vec<MeshPeriodicNodePairIR>`
- `periodic_boundary_pairs: Vec<MeshPeriodicBoundaryPairIR>` (with marker annotations)

The planner validates that:

- `ProblemIR.pbc.has_any_periodic()` is present before accepting static/time-domain
  FEM meshes with `periodic_node_pairs`;
- `periodic_node_pairs` are present when static/time-domain FEM PBC is requested;
- periodic axes inferred from `mesh.periodic_boundary_pairs` match
  `ProblemIR.pbc.axes`; mesh metadata may not add, remove, or replace physical
  PBC axes;
- `ProblemIR.pbc.demag == "periodic_airbox_k0"` before accepting
  static/time-domain FEM demag PBC;
- `periodic_boundary_pairs` are present when `enable_demag && pbc`.

---

## 11. Planner/capability impact

The current qualified CPU scope unlocks demag PBC via the Rust reference and
native MFEM CPU serial reduced-solve paths for:
- up to two periodic axes
- `periodic_boundary_pairs.len() > 0`
- `ProblemIR.pbc.demag == "periodic_airbox_k0"`

Native hypre/AMG promotion and strict GPU periodic demag are separate
qualification work. GPU acceptance requires the managed M5 gate to prove
`uses_cuda_kernels=true`, `uses_gpu_poisson=true`, and
`demag_operator_mode="device_hypre_poisson"`; source-contract support alone is
not production validation.

---

## 12. Runtime/session impact

The dispatcher must route demag PBC only to lanes that actually enforce the
static periodic reduction.  Current evidence covers the Rust reference
reduction and the native MFEM CPU serial reduced-solve path.  Provenance must
record the effective lane and must not silently downgrade requested periodic
demag to a finite isolated airbox.

---

## 13. Artifact/provenance impact

Every run with demag PBC records:

```json
{
  "pbc": {
    "axes": ["periodic", "periodic", "open"],
    "demag": "periodic_airbox_k0"
  },
  "mesh": {
    "periodic_boundary_pair_count": 2,
    "periodic_node_pair_count": 512,
    "periodic_pairs_v1_path": "mesh/periodic_pairs.v1.json"
  },
  "execution_provenance": {
    "execution_engine": "fem_cpu_native",
    "resolved_fallback": null
  }
}
```

The `mesh/periodic_pairs.v1.json` artifact must include explicit `node_pairs`
for each periodic boundary-pair id. Acceptance validators use those node pairs
to compute final `m_final.json`, same-step `fields/H_demag/step_*.json`, and
same-step `fields/demag_phi/step_*.json` seam mismatch, not only geometric
translation residuals or pair counts.

The top-level `pbc` block is copied from `ProblemIR.pbc` and proves the
physical intent. Mesh pair counts prove that the resolved mesh can realize that
intent; they are not a replacement for `ProblemIR.pbc`.
Accepted periodic-antidot relaxation gates also require
`mesh/periodic_pairs.v1.json` with `validation_status="ok"`, positive paired
node counts, zero unpaired source/destination nodes, and explicit `x_faces` and
`y_faces` pair diagnostics.
They also require the final equilibrium magnetization field at `m_final.json`
with observable `m`, dimensionless units, finite time metadata, and non-empty
finite vector values.
The demag field diagnostic is not implied by solver metadata: accepted runs
must request and publish at least one `fields/H_demag/step_*.json` snapshot
with observable `H_demag`, unit `A/m`, finite time metadata, and non-empty
finite vector values. The accepted `H_demag` snapshot step must match the
`m_final.json` step so demag diagnostics and equilibrium magnetization refer to
the same relaxed state.
The scalar potential diagnostic is equally explicit: accepted runs must request
and publish at least one `fields/demag_phi/step_*.json` snapshot with observable
`demag_phi`, unit `A`, finite time metadata, and non-empty finite scalar values.
The accepted `demag_phi` snapshot step must match the `m_final.json` step, and
its seam mismatch is checked across the same periodic node pairs.
The scalar history `scalars.csv` is part of the accepted equilibrium record: it
must contain at least the required relaxation step count, finite `E_demag`,
`E_total`, and `max_torque_Apm` values, non-negative final `E_demag`, bounded
final torque, and no increase of final `E_total` relative to the first accepted
scalar row.
The `demag_runtime` metadata must also prove that the Poisson solve actually
converged: `actual_iterations` is positive and does not exceed
`max_iterations`, and `final_residual_norm` is finite, non-negative, and no
larger than `relative_tolerance`.

For periodic-antidot relaxation gates, the accepted equilibrium artifact must
also publish the same final physical observables on CPU and GPU relaxation
qualification metadata:

- final energy terms in joules, including non-negative `E_demag`,
- final torque residual `final_torque_apm` and `final_torque_t`,
- magnetic-body magnetization norm defect,
- executed step count and stop reason,
- demag runtime policy, residual, iteration count, and requested/resolved
  device provenance.

For GPU qualification, `fem_gpu_relaxation_qualification.device_policy` must
prove that CUDA kernels and device Poisson demag were used:
`uses_cuda_kernels=true`, `uses_gpu_poisson=true`, and
`demag_operator_mode="device_hypre_poisson"`. A GPU PBC relaxation gate that
lacks these fields is an incomplete runtime smoke, not an accepted equilibrium.
The GPU minimizer source contract must also prove that projected-gradient BB
and nonlinear-CG project every trial magnetisation onto static periodic classes
before evaluating the trial demag energy.

---

## 14. Validation plan

### Golden test: periodic repeated supercell

1. Build a periodic primitive-cell mesh with periodic pairs in the lateral axes
   and open/Robin boundary only in the non-periodic axis.
2. Run once with PBC demag.
3. Build an explicitly repeated supercell with the same local discretization
   and lateral PBC on the outer supercell faces.
4. Extract the central unit-cell demag field/energy.
5. Assert relative central-cell energy error `<= 2e-2` and zero primitive-cell
   `H_demag`/`phi` seam mismatch within the documented tolerances.

A finite repeated supercell with lateral open/Robin outer faces is a diagnostic
for finite-array convergence, not an equivalence reference for the PBC gate.
The 2026-06-27 finite-array diagnostic converged too slowly (`6.894685e-01`
relative error at 3x3 and `4.201782e-01` at 5x5). The passing managed
qualification artifact uses outer-supercell lateral PBC and is written at
`.fullmag/reports/fem-demag-periodic-airbox-validation-supercell-pbc/periodic_airbox_validation.csv`.
It reports primitive `e_demag_J=1.8678852700529174e-19`, supercell central-cell
`e_demag_J=1.8633818564459878e-19`, and relative error
`2.4167958871934916e-3`.

### Class consistency test

Assert `max_i |H_demag[i] - H_demag[rep(i)]| < 1e-10 * |H_demag[rep(i)]|`
for all periodic pairs.

### CPU reference benchmark fixture

The repository CPU reference fixture uses a structured box with x-periodic
faces and open y/z boundaries. It is intentionally small and deterministic so
CI can check topology and finite demag observables. It reports elapsed time for
local comparisons, but CI must not use elapsed time as a pass/fail physics
oracle.

### Energy sign test

Assert `E_demag >= 0` for a uniform-magnetization state. In the convention
`E = -μ0/2 integral(H dot M) dV`, the demag field opposes the magnetization in
the tested state, so the stored demag energy is non-negative.

---

## 15. Completeness checklist

- [x] Algebraic reduction `reduce_csr_by_periodic_classes` implemented
- [x] RHS reduction `reduce_rhs_by_periodic_classes` implemented
- [x] Lift operator `lift_scalar_by_periodic_classes` implemented
- [x] Field projection `project_vector_field_by_periodic_classes` implemented
- [x] `build_boundary_mass_excluding_periodic_faces` implemented in `fem.rs`
- [x] `periodic_robin_demag_observables_from_vectors` integrated in `fem.rs`
- [x] Rust CPU reduced-CG warm-start reuses the previous potential in the PBC demag workspace
- [x] Rust CPU reference semantics accepts demag + static PBC on the reduced path
- [x] Rust CPU reference benchmark fixture with x-periodic/open-yz mesh
- [x] Golden repeated-supercell test passing for the Rust CPU reference path
- [x] Native MFEM CPU reduced solve reuses `x_p` as warm-start and keeps serial solver workspace in the context
- [x] Planner accepts demag + PBC only when `ProblemIR.pbc.demag == "periodic_airbox_k0"` and `periodic_boundary_pairs.len() > 0`
- [x] CSV artifact acceptance gate for periodic-airbox primitive/supercell comparison
- [x] Managed CPU/MFEM primitive-vs-periodic-supercell artifact passes the
      `2e-2` energy tolerance and primitive seam checks
- [x] Native MFEM CPU serial reduced solve path
- [x] Native MFEM/hypre/AMG periodic solve telemetry is emitted by the managed
      artifact
- [x] Periodic-antidot relaxation validator requires the resolved
      `mesh/periodic_pairs.v1.json` diagnostic artifact with explicit
      `node_pairs`, not only mesh pair counts in `metadata.json`
- [x] Periodic-antidot relaxation validator requires the final equilibrium
      magnetization field artifact `m_final.json`
- [x] Periodic-antidot examples request `H_demag` snapshots, and the validator
      requires a resolved `fields/H_demag/step_*.json` diagnostic artifact at
      the same step as `m_final.json`
- [x] Periodic-antidot relaxation validator checks final `m_final.json` and
      same-step `H_demag` seam mismatch across periodic node pairs
- [x] Periodic-antidot examples request `demag_phi` snapshots, and the
      validator requires a resolved `fields/demag_phi/step_*.json` scalar
      potential diagnostic artifact at the same step as `m_final.json`
- [x] Periodic-antidot relaxation validator checks same-step `demag_phi` seam
      mismatch across periodic node pairs
- [x] Periodic-antidot relaxation validator requires `scalars.csv` with finite
      energy/torque history and non-increasing final total energy
- [x] Periodic-antidot relaxation validator requires converged demag Poisson
      telemetry in `demag_runtime`
- [x] GPU projected-gradient BB and nonlinear-CG source contracts project trial
      magnetisation onto static periodic classes after retraction

---

## 16. Deferred work

- **Fully periodic 3D demag**: requires k=0 gauge convention (out of scope v1).
- **DMI PBC**: separate physics note `0810-fem-static-pbc-dmi.md` (PR-5).
- **Native MFEM/hypre demag PBC**: reduced sparse Poisson exists in the native
  CPU path, but hypre/AMG promotion remains unqualified.  The current native
  MFEM CPU path is a serial reduced CG/GSSmoother path with warm-start and
  context-owned workspace.
- **Floquet + dynamic demag**: not supported in static/time-domain path;
  frequency-domain Floquet demag is a separate problem.
