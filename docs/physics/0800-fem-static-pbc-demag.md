# FEM static/time-domain demag PBC

**Status**: k=0 static/time-domain PBC demag has reference/source-visible
implementation support, and the managed periodic-antidot CPU/GPU relaxation
gates now pass the ordinary artifact validator with same-step `m`, `phi`,
`H_demag`, normal-flux, side-charge, pair-topology, and device-Poisson
provenance checks. The full M5 production gate is still not closed until the
same accepted workload also passes strict z-padding and primitive-vs-supercell
comparison reports. A run that only pairs or projects magnetization while
`phi`/`H_demag` still behave like a finite isolated airbox is false or
incomplete PBC and must be rejected. Fully periodic 3D demag and
frequency-domain dynamic demag remain unqualified.

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

Periodic seam faces on any selected periodic axis (`x`, `y`, or `z`) must
**not** carry Robin or Dirichlet boundary conditions.
They are handled purely by the algebraic reduction:
- source nodes are merged into their target class by `P^T A P`;
- Robin surface mass is excluded from periodic side boundary faces.

For `k=0`, the potential itself is gauge-dependent. The accepted diagnostic is
therefore direct seam continuity for `H_demag = -grad(phi)` and seam continuity
of `phi` after subtracting the best constant offset for each periodic
boundary-pair id.

The common thin-film antidot qualification uses `x/y` periodicity with an open
`z` airbox. That is a geometry-specific gate, not a public API limit. A
different non-fully-periodic cell may instead declare `x/z`, `y/z`, or a single
periodic `z` axis when the mesh publishes matching periodic node and boundary
pairs and at least one remaining axis supplies the open airbox boundary.

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

The current CPU scope exposes a diagnostic/reference demag-PBC path via the
Rust reference and native MFEM CPU serial reduced-solve implementations for:
- up to two periodic axes
- `periodic_boundary_pairs.len() > 0`
- `ProblemIR.pbc.demag == "periodic_airbox_k0"`

This is not a blanket production claim for magnonic-crystal equilibrium. The
planner/runtime may execute the narrow path, but promotion requires the M5
artifact gate to prove that magnetization, scalar potential modulo gauge,
`H_demag`, and normal `B` flux are all periodic across the seam and that the
primitive cell matches a repeated-supercell central extraction.

Native hypre/AMG promotion and strict GPU periodic demag are separate
qualification work. GPU acceptance requires the managed M5 gate to prove
`uses_cuda_kernels=true`, `uses_gpu_poisson=true`, and
`demag_operator_mode="device_hypre_poisson"`; source-contract support alone is
not production validation.

---

## 12. Runtime/session impact

The dispatcher must route demag PBC only to lanes that actually enforce the
static periodic reduction for the scalar potential on the full shared domain
`Omega_magnetic union Omega_air`. Current implementation evidence covers the
Rust reference reduction and the native MFEM CPU serial reduced-solve path, but
that evidence is insufficient by itself to accept a production antidot
equilibrium. Provenance must record the effective lane and must not silently
downgrade requested periodic demag to a finite isolated airbox.

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
for each requested periodic boundary-pair id. It must also prove that the
periodic class reduction covers both the magnetic body and the shared-domain
airbox:

```json
{
  "pair_id": "x_faces",
  "domain_node_pair_counts": {"magnetic": 128, "airbox": 384},
  "boundary_face_pairs": [
    {
      "face_a": 10,
      "face_b": 11,
      "translation_m": [2.0e-7, 0.0, 0.0],
      "normal_dot": -1.0,
      "orientation": "opposed_normals"
    }
  ]
}
```

Acceptance validators use those node pairs to compute final `m_final.json`,
same-step `fields/H_demag/step_*.json`, and same-step
`fields/demag_phi/step_*.json` seam mismatch, not only geometric translation
residuals or pair counts. A periodic artifact that pairs only magnetic nodes
but does not pair airbox nodes/faces is classified as incomplete PBC for
magnetostatics.

The top-level `pbc` block is copied from `ProblemIR.pbc` and proves the
physical intent. Mesh pair counts prove that the resolved mesh can realize that
intent; they are not a replacement for `ProblemIR.pbc`.
The v2 read-model at `/v2/sessions/current/meshing/mesh/periodic_pairs.v1`
must preserve the same `domain_node_pair_counts` and `boundary_face_pairs`
diagnostics for live mesh payloads and artifact fallback responses; otherwise
the control room cannot distinguish full airbox PBC from magnetic-only periodic
projection.
Accepted periodic-antidot relaxation gates also require
`mesh/periodic_pairs.v1.json` with `validation_status="ok"`, positive `airbox`
paired node counts, non-empty `boundary_face_pairs` with opposed normals, zero
unpaired source/destination nodes, and explicit `x_faces` and `y_faces` pair
diagnostics. When the magnetic body crosses the selected periodic seam, as in
the `exchange_coupled` fixture, each selected pair must also have positive
`magnetic` paired node counts. When the magnetic body is a separated island
inside a periodic air gap, as in the `air_gap` fixture, `magnetic = 0` on the
side seam is physically valid; acceptance then comes from airbox pair coverage,
`phi`/`H_demag` seam continuity, balanced normal `B` flux, and zero artificial
side magnetic charge.
Those `x_faces/y_faces` ids are the contract for the current antidot film
fixture only. General FEM static PBC accepts any non-empty subset of selected
axes except the fully periodic `x/y/z` case, provided the `ProblemIR.pbc.axes`
intent and mesh pair ids agree.
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
its seam mismatch is checked across the same periodic node pairs after removing
the best constant offset independently for each periodic boundary-pair id. This
prevents an arbitrary `k=0` scalar-potential gauge offset from being mistaken
for a physical demag discontinuity, while still rejecting non-smooth `phi`
across the seam.
The accepted run must also publish
`diagnostics/fem_static_pbc_demag_seams.v1.json` at the same step. That
diagnostic records per periodic pair:

- `m_seam_max`,
- `h_demag_seam_max_Apm`,
- `demag_phi_seam_max_after_offset_A`,
- `b_normal_flux_seam_max_T`,
- `side_magnetic_charge_sum_abs_Am`.

The last two fields are the explicit false-PBC guard: a run with smooth `m` but
unbalanced normal `B` flux or non-cancelled side magnetic charge is still an
isolated-airbox result, not accepted magnetostatic PBC.
The runner emits this artifact for FEM static/time-domain runs that request
`ProblemIR.pbc.demag = "periodic_airbox_k0"`, enable demag, and carry periodic
mesh boundary pairs. If the required same-step `H_demag`/`demag_phi` snapshots,
full-domain field lengths, node pairs, or boundary-face pairs are missing, the
artifact is written with `status = "failed"` so the run remains rejectable by
the acceptance validator.
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

The managed periodic-antidot validator can also be run in strict M5 mode with
explicit static comparison reports:

```bash
# Canonical managed z-padding report for the exchange-coupled antidot workload.
just verify-fem-static-pbc-demag-z-padding-runtime

# Canonical managed supercell report for the 3x3 exchange-coupled antidot workload.
# First produce the unit/supercell runtime artifacts if central-cell extraction
# inputs are not available yet.
just prepare-fem-static-pbc-demag-supercell-runtime-artifacts

FULLMAG_PBC_RELAX_SUPERCELL_MAGNETIC_NODE_INDICES=magnetic_node_indices \
FULLMAG_PBC_RELAX_SUPERCELL_FIELD_CELL_INDICES=field_cell_indices \
FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_DEMAG_ENERGY_J=central_cell_E_demag_J \
FULLMAG_PBC_RELAX_SUPERCELL_CENTRAL_CELL_TORQUE_APM=central_cell_torque_Apm \
just verify-fem-static-pbc-demag-supercell-runtime

# Or compare already-produced artifact roots explicitly.
just verify-fem-static-pbc-demag-z-padding-artifacts \
  reference/artifacts candidate/artifacts reports/z_padding_validation.v1.json
just write-fem-static-pbc-demag-supercell-central-cell-artifact \
  supercell/artifacts 3 3 magnetic_node_indices field_cell_indices \
  central_cell_E_demag_J central_cell_torque_Apm
just verify-fem-static-pbc-demag-supercell-artifacts \
  unit/artifacts supercell/artifacts 3 3 reports/supercell_validation.v1.json

FULLMAG_PBC_RELAX_Z_PADDING_REPORT=.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json \
FULLMAG_PBC_RELAX_SUPERCELL_REPORT=reports/supercell_validation.v1.json \
just verify-fem-static-pbc-demag-equilibrium-runtime
```

The report targets call
`scripts/compare_fem_static_pbc_equilibrium_artifacts.py` and compare real
artifact roots. They must not be replaced by hand-written placeholder JSON:
`verify-fem-static-pbc-demag-equilibrium-runtime` now rejects missing report
paths before running the CPU/GPU periodic-antidot gates. The report writer also
rejects self-comparison: z-padding `reference` and `candidate` roots must be
different, and supercell `unit-cell` and `supercell` roots must be different.
It also records and enforces workload identity: both roots must have
`metadata.pbc.demag = "periodic_airbox_k0"`, matching `metadata.pbc.axes`,
matching `periodic_antidot_relaxation.scenario`, matching `film_size_m`,
matching lateral air-gap and periodic-pair identity, and matching
exchange-coupling intent. The runtime validator repeats the same identity check
when consuming reports, so a hand-written report cannot satisfy the strict gate
by matching only `scenario` and `film_size_m`. A z-padding report is valid only
for the `x/y` periodic, open-`z` antidot workload when the reference artifact
has the same lateral `universe_size_m` and a strictly larger open-`z`
`universe_size_m` than the candidate artifact. Comparing two roots with the
same airbox, for example CPU and GPU ordinary relaxation artifacts, is not
z-padding evidence and must be rejected.
The managed `verify-fem-static-pbc-demag-z-padding-runtime` target produces
the canonical exchange-coupled candidate artifact from
`examples/fem_periodic_antidot_relax_exchange_coupled.py`, the larger open-`z`
reference artifact from
`examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py`,
and writes the strict z-padding report at the default strict-M5 report path.
The periodic-antidot runtime validator repeats that check when
`--require-z-padding-report` or `--require-supercell-report` is used, so a
hand-written `status="ok"` report without matching `workload` cannot satisfy
the strict gate. It also requires the z-padding report to carry
`reference_universe_size_m` and `candidate_universe_size_m` with the same
open-`z` ordering, and independently checks the report metrics against the same
strict limits as the report writer; `status="ok"` alone is not accepted.
The z-padding field comparison uses relative convergence of demag energy,
`p99(|H_demag|)`, and the scalar-potential range. The global `|H_demag|`
maximum and absolute `phi` range delta are retained as diagnostics only,
because changing open-`z` padding changes the mesh and can move isolated local
peaks without changing the accepted energy, seam, or robust-field convergence.
For primitive-vs-supercell comparison, the report writer must consume
`diagnostics/fem_static_pbc_supercell_central_cell.v1.json` from the supercell
artifact root. The report is invalid if the supercell artifact does not have
the same open-`z` `universe_size_m` as the unit cell and lateral
`universe_size_m` scaled by `repeat_x` and `repeat_y`; otherwise a second
ordinary unit-cell run could masquerade as a repeated-cell validation. The
report is also invalid if it only divides total supercell energy or global
supercell statistics by the repeat count. The central-cell extraction artifact
supplies the magnetic-node indices, field-cell indices, central-cell demag
energy, and central-cell torque residual used in the comparison.
The managed `verify-fem-static-pbc-demag-supercell-runtime` target produces the
canonical primitive artifact from
`examples/fem_periodic_antidot_relax_exchange_coupled.py`, the 3x3 repeated
artifact from
`examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py`, writes
the central-cell extraction artifact from the supplied index/value inputs, and
then writes the strict supercell report at the default strict-M5 report path.
`just write-fem-static-pbc-demag-supercell-central-cell-artifact` is the
explicit producer for that artifact when the central-cell index sets and
central-cell scalar values have been determined by the supercell preparation
workflow. It validates the supplied indices against `m_final.json`,
`fields/H_demag.zarr`, and `fields/demag_phi.zarr`; it also rejects
central-cell demag energy or torque values that exceed the global supercell
`metadata.final_energy_terms_j.E_demag` or `metadata.final_torque_apm`. It does
not infer central-cell energy from the total supercell energy. The index inputs
may be comma-separated lists or paths to files containing comma-separated,
newline-separated, or JSON `indices` lists, so a preparation workflow can write
auditable index files before the strict report is generated.

When those environment variables are set, the validator requires:

- `fem_static_pbc_z_padding_validation.v1` with `status="ok"` and finite,
  non-negative demag-energy relative error, `p99(|H_demag|)` relative error,
  and `demag_phi` range relative error below the strict z-padding thresholds;
  global `|H_demag|` maximum and absolute `demag_phi` range deltas are
  diagnostic fields, not standalone acceptance limits;
- `fem_static_pbc_supercell_validation.v1` with `status="ok"`, non-empty
  primitive/supercell artifact references, a repeated-cell count greater than
  one, a `central_cell_extraction` summary copied from
  `fem_static_pbc_supercell_central_cell.v1`, and finite, non-negative
  central-cell `m`, demag-energy, `H_demag`, `demag_phi`, and torque-residual
  comparison metrics below the strict supercell thresholds.

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
relative error at 3x3 and `4.201782e-01` at 5x5). A previous managed
outer-supercell-PBC comparison artifact was written at
`.fullmag/reports/fem-demag-periodic-airbox-validation-supercell-pbc/periodic_airbox_validation.csv`
and reported primitive `e_demag_J=1.8678852700529174e-19`, supercell
central-cell `e_demag_J=1.8633818564459878e-19`, and relative error
`2.4167958871934916e-3`. That artifact is useful evidence for the reduced
Poisson path, but it does not replace the current M5 antidot equilibrium gate:
the accepted run must publish same-step `m`, `phi`, `H_demag`, flux/seam
diagnostics, periodic-pair coverage for every domain that actually intersects
the selected seam plus shared-airbox coverage, and
primitive-vs-supercell comparison artifacts for the actual accepted workload.

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
- [x] Planner regression accepts single-axis `z` static FEM demag PBC with open
      `x/y` airbox boundaries, so the public contract is not limited to the
      current lateral `x/y` antidot-film fixture
- [x] CSV artifact acceptance gate for periodic-airbox primitive/supercell comparison
- [x] Historical managed CPU/MFEM primitive-vs-periodic-supercell artifact
      passes the `2e-2` energy tolerance and primitive seam checks for its
      fixture
- [ ] Strict managed M5 antidot/magnonic-crystal equilibrium gate proves the
      accepted workload has periodic `m`, gauge-adjusted `phi`, periodic
      `H_demag`, balanced normal `B` flux, no artificial side-edge magnetic
      charges, strict z-padding convergence, and primitive-vs-supercell
      agreement
- [x] Native MFEM CPU serial reduced solve path
- [x] Native MFEM/hypre/AMG periodic solve telemetry is emitted by the managed
      artifact
- [x] Periodic-antidot relaxation validator requires the resolved
      `mesh/periodic_pairs.v1.json` diagnostic artifact with explicit
      `node_pairs`, not only mesh pair counts in `metadata.json`
- [x] Periodic-antidot relaxation validator requires each periodic pair to
      prove airbox node coverage plus non-empty opposed-normal boundary face
      pair diagnostics; it additionally requires magnetic node coverage for
      `exchange_coupled` seams and explicitly permits `magnetic = 0` for
      separated-island `air_gap` seams
- [x] Runner `mesh/periodic_pairs.v1.json` artifact writer emits magnetic vs
      airbox node-pair counts and boundary-face translation/orientation
      diagnostics for each periodic pair
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
      mismatch across periodic node pairs after removing the best constant
      offset per periodic boundary-pair id
- [x] Periodic-antidot relaxation validator requires same-step
      `diagnostics/fem_static_pbc_demag_seams.v1.json` with normal `B` flux and
      side magnetic charge diagnostics
- [x] Periodic-antidot relaxation validator requires `scalars.csv` with finite
      energy/torque history and non-increasing final total energy
- [x] Periodic-antidot relaxation validator requires converged demag Poisson
      telemetry in `demag_runtime`
- [x] Periodic-antidot managed runtime recipes can require strict static
      z-padding and primitive-vs-supercell comparison reports before accepting
      the M5 equilibrium gate
- [x] Static M5 comparison report writer exists for artifact-backed z-padding
      and primitive-vs-supercell JSON reports, and the strict equilibrium
      runtime target rejects missing report paths instead of silently running
      only the ordinary CPU/GPU relaxation gates
- [x] Static M5 comparison report writer rejects self-comparison so a repeated
      reference/candidate or unit/supercell artifact root cannot generate a
      trivial zero-delta acceptance report
- [x] Static M5 comparison report writer rejects incompatible workloads, so
      `exchange_coupled` cannot be compared against `air_gap` and a non-PBC
      demag artifact cannot satisfy a periodic-airbox report
- [x] Periodic-antidot runtime validator requires strict comparison reports to
      carry a `workload` matching the accepted run's `pbc.axes`, scenario,
      `film_size_m`, lateral air gap, periodic pair ids, and exchange-coupling
      intent
- [x] Static z-padding report writer and runtime validator reject same-airbox
      comparisons; accepted z-padding reports must compare an `x/y` periodic,
      open-`z` candidate against a same-lateral-size reference with larger
      open-`z` `universe_size_m`
- [x] `examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py`
      and `just verify-fem-static-pbc-demag-z-padding-runtime` provide a
      canonical managed path to generate the exchange-coupled z-padding report
      from candidate/reference runtime artifacts
- [x] Static supercell report writer and runtime validator require lateral
      `universe_size_m` scaled by `repeat_x/repeat_y` and matching open-`z`
      `universe_size_m`, so an ordinary same-size artifact root cannot satisfy
      primitive-vs-supercell acceptance
- [x] Periodic-antidot runtime validator independently rejects required strict
      comparison reports whose static-demag metrics exceed the z-padding or
      primitive-vs-supercell thresholds, even when the report says
      `status="ok"`
- [x] Static M5 supercell report writer and validator require explicit
      `diagnostics/fem_static_pbc_supercell_central_cell.v1.json` provenance,
      so primitive-vs-supercell acceptance uses central-cell extraction rather
      than global supercell averages
- [x] `examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py`
      and `just verify-fem-static-pbc-demag-supercell-runtime` provide a
      canonical managed path to run the primitive/3x3 supercell artifacts and
      generate the strict report from supplied central-cell extraction inputs
- [x] `just prepare-fem-static-pbc-demag-supercell-runtime-artifacts` can
      produce the unit/supercell runtime artifact roots before central-cell
      extraction inputs are available, so the index/scalar extraction workflow
      can operate on concrete runtime data instead of being blocked by the
      strict report preflight
- [x] A managed `just` entry point can write the central-cell extraction
      artifact from explicit magnetic-node indices, field-cell indices,
      central-cell demag energy, and central-cell torque residual while
      validating index ranges and scalar bounds against the resolved supercell
      artifacts; index inputs may be literal lists or files
- [x] GPU projected-gradient BB and nonlinear-CG source contracts project trial
      magnetisation onto static periodic classes after retraction
- [x] GPU device Poisson demag recovery projects recovered `H_demag` onto
      static periodic classes before energy/snapshot diagnostics, preventing a
      false-PBC state where `m` is periodic but `H_demag` has a side-seam
      discontinuity

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
