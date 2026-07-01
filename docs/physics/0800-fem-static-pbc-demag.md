# FEM static/time-domain demag PBC

**Status**: k=0 static/time-domain PBC demag has reference/source-visible
implementation support, and the managed periodic-antidot CPU/GPU relaxation
gates now pass the ordinary artifact validator with same-step `m`, `phi`,
`H_demag`, normal-flux, side-charge, pair-topology, and device-Poisson
provenance checks. The full M5 production gate is still not closed until the
same accepted workload also passes strict z-padding and controlled
primitive-vs-supercell comparison reports. A run that only pairs or projects magnetization while
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

For Poisson-Robin airbox realizations, the Robin reference radius is computed
from the non-periodic open-axis extent. It must not use the full bounding-box
maximum when a repeated supercell changes only periodic directions; otherwise a
primitive `x/y` periodic cell and its `3x3` repeated supercell would get
different open-`z` Robin impedances despite the same physical z-padding.

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
`E_total`, and `max_torque_Apm` values, non-negative final `E_demag` within
`1e-24 J` absolute numerical roundoff, bounded final torque, and no increase of
final `E_total` relative to the first accepted scalar row.
The `demag_runtime` metadata must also prove that the Poisson solve actually
used the periodic magnetostatic model, not only a finite-airbox solve with
periodic `m` postprocessing. For accepted PBC-demag runs it must publish
`magnetostatic_boundary_model = "periodic_airbox_k0"`,
`poisson_operator = "pbc_reduced_poisson"`, and
`periodic_reduction.enabled = true` with
`periodic_reduction.method = "P^T A P"`, positive periodic node/boundary-pair
counts, and `periodic_boundary_markers_excluded_from_robin = true`. It must
also prove convergence: `actual_iterations` is positive and does not exceed
`max_iterations`, and `final_residual_norm` is finite, non-negative, and no
larger than `relative_tolerance`.

For periodic-antidot relaxation gates, the accepted equilibrium artifact must
also publish the same final physical observables on CPU and GPU relaxation
qualification metadata:

- final energy terms in joules, including non-negative `E_demag` within
  `1e-24 J` absolute numerical roundoff,
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
# Minimal false-PBC diagnostic without the antidot hole.
just verify-fem-static-pbc-demag-uniform-slab-runtime

# Canonical managed z-padding report for the exchange-coupled antidot workload.
just verify-fem-static-pbc-demag-z-padding-runtime

# Canonical managed supercell report for the 3x3 exchange-coupled antidot workload.
just prepare-fem-static-pbc-demag-supercell-runtime-artifacts

just verify-fem-static-pbc-demag-supercell-runtime

# Canonical managed strict-M5 wrapper. This starts with the uniform slab
# false-PBC diagnostic, then runs the antidot z-padding and repeated-state
# supercell report path.
just verify-fem-static-pbc-demag-equilibrium-repeated-state-runtime

# Or compare already-produced artifact roots explicitly.
just verify-fem-static-pbc-demag-z-padding-artifacts \
  reference/artifacts candidate/artifacts reports/z_padding_validation.v1.json
just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto \
  supercell/artifacts 3 3
just write-fem-static-pbc-demag-repeated-unit-initial-state \
  unit/artifacts supercell/artifacts 3 3
just verify-fem-static-pbc-demag-supercell-repeated-state-runtime
just verify-fem-static-pbc-demag-supercell-artifacts \
  unit/artifacts supercell/artifacts 3 3 reports/supercell_validation.v1.json

FULLMAG_PBC_RELAX_Z_PADDING_REPORT=.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json \
FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT=.fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_validation.v1.json \
just verify-fem-static-pbc-demag-equilibrium-runtime
```

The report targets call
`scripts/compare_fem_static_pbc_equilibrium_artifacts.py` and compare real
artifact roots. They must not be replaced by hand-written placeholder JSON:
`verify-fem-static-pbc-demag-equilibrium-runtime` now rejects missing report
paths before running the CPU/GPU periodic-antidot gates. The report writer also
copies `problem_meta.runtime_metadata.initial_magnetization_state_override` from
a repeated-state supercell artifact into
`supercell_initial_magnetization_state_override`. When
`FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT` is set, the runtime
validator requires that provenance block and the same supercell-report workload
and metric checks. An ordinary independently relaxed primitive-vs-3x3 report
may be written as diagnostic evidence, but the repeated-state report is the
blocking controlled-supercell artifact for this wrapper. These comparison reports are
currently exchange-coupled antidot workload evidence; the managed CPU/GPU
periodic-antidot loops attach them only to `exchange_coupled`, while `air_gap`
continues to exercise the ordinary finite-gap periodic-array smoke without
claiming strict supercell/z-padding acceptance. The report writer also
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
The managed
`verify-fem-static-pbc-demag-equilibrium-repeated-state-runtime` target is the
one-command strict-M5 preparation wrapper: it generates the z-padding report,
ordinary primitive-vs-3x3 supercell diagnostic report, repeated-state
supercell report, and then runs
`verify-fem-static-pbc-demag-equilibrium-runtime` with the z-padding and
repeated-state report paths. Passing that wrapper still means the blocking
physical report metrics passed; the wrapper itself does not relax the
same-local-discretization or primitive-vs-supercell acceptance criteria.
The managed `verify-fem-static-pbc-demag-uniform-slab-runtime` target runs the
same static PBC-demag artifact validator on a uniform exchange-coupled
`200 nm x 200 nm x 10 nm` film slab with no hole, transverse initial
magnetization, and short explicit `max_steps=120`, on both CPU and GPU/device
Poisson demag. This is a minimal false-PBC diagnostic: because the magnetic body
crosses the lateral periodic seams, every selected side pair must have positive
magnetic and airbox coverage, periodic `H_demag`/gauge-adjusted `demag_phi`,
balanced normal flux, and no artificial side magnetic charge before the more
complex antidot geometry is interpreted.
The periodic-antidot runtime validator repeats that check when
`--require-z-padding-report`, `--require-supercell-report`, or
`--require-repeated-state-supercell-report` is used, so a hand-written
`status="ok"` report without matching `workload` cannot satisfy
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
the central-cell extraction artifact from node geometry plus runtime field
snapshots, and then writes the strict supercell report at the default strict-M5
report path.
The preparatory
`just prepare-fem-static-pbc-demag-supercell-runtime-artifacts` target runs the
same primitive and 3x3 workloads before strict report generation, then
validates the primitive artifact with the ordinary
periodic-antidot validator and the repeated artifact with
`--supercell-repeat 3 3`. The supercell validator accepts the run only when
`metadata.periodic_antidot_relaxation.supercell_repeat` matches the requested
repeat and the lateral `universe_size_m` is scaled by the repeat while the
open-`z` airbox remains present; it also requires the repeated root's
`mesh/node_geometry.v1.json` artifact. Repeated FEM artifact roots write
`mesh/node_geometry.v1.json` with node coordinates, the magnetic-node mask, and
node-index alignment for `m`, `H_demag`, `H_eff`, and `demag_phi`; this gives
the preparation workflow an auditable source for central-cell index selection
without deriving those indices from flattened field lengths.
`just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto` is the
default producer for that artifact. It selects magnetic-node and node-aligned
field indices from `mesh/node_geometry.v1.json` using the requested
`central_cell_index`, the repeated `film_size_m`, and the repeated
`universe_size_m`; for the canonical 3x3 case the default central cell is
`[1, 1]`. It computes central-cell demag
energy from the same native FEM Poisson convention by summing magnetic
tetrahedra whose `x/y` centroids lie in the selected central cell:
`E_d = -0.5*mu0*sum_e(V_e*mean_vertices(Ms_i*dot(m_i,H_demag_i)))`.
It computes the central-cell torque residual as
`max(norm(cross(m_i,H_eff_i)))` over selected magnetic nodes. It validates the
selected indices against
`m_final.json`, `fields/H_demag.zarr`, `fields/H_eff.zarr`, and
`fields/demag_phi.zarr`. Field Zarr inputs may contain one or more samples; the
producer requires `samples.csv` to match `.zarray.shape[0]` and uses the final
sample row, so runtime artifacts with both the requested step-0 field snapshot
and the final field snapshot remain valid central-cell extraction inputs. The
manual
`just write-fem-static-pbc-demag-supercell-central-cell-artifact` target remains
available when an external extraction workflow supplies explicit index lists;
those index inputs may be comma-separated lists or paths to files containing
comma-separated, newline-separated, or JSON `indices` lists. Both producers
reject central-cell demag energy or torque values that exceed the global
supercell `metadata.final_energy_terms_j.E_demag` or
`metadata.final_torque_apm`. They do not infer central-cell energy from the
total supercell energy or infer torque from global supercell statistics.
The supercell report also records `mesh_comparability` diagnostics with unit
magnetic-node/field-cell counts, central-cell counts, and count relative errors.
Large global count errors are not by themselves a failure, because the primitive
mesh has a periodic seam as a boundary while the central supercell extraction
does not. They are diagnostic evidence to interpret the strict physics metrics
and to decide whether a same-local-discretization mesh fixture is still needed.
The same report records `relaxation_state_comparability` diagnostics with the
primitive magnetic average, central-cell magnetic average, their L2 delta, and
the mean/max node-wise deviations from the primitive average. The strict report
also gates
`relaxation_state_mean_deviation_relative_error <= 2e-1`, and the runtime
validator requires that metric to match
`relaxation_state_comparability.mean_l2_deviation_relative_error`. These values
do not relax the supercell acceptance thresholds; they distinguish a true
magnetostatic-PBC/operator mismatch from a comparison between two different
relaxed equilibria.
The 2026-07-01 managed ordinary primitive-vs-3x3 run wrote
`.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json`
with `status="failed"`: `e_demag_density_relative_error=5.183127e-02`,
`h_demag_stats_relative_error=3.049715e-02`,
`central_cell_torque_residual_relative_error=8.435489e-01`, and
`relaxation_state_mean_deviation_relative_error=5.990150e-01`. Its
`mesh_comparability` diagnostics also showed large count mismatches
(`magnetic_node_count_relative_error=6.226461e-01`,
`field_cell_count_relative_error=5.979100e-01`). That report is useful
negative evidence, but it is not the controlled repeated-state acceptance
artifact and must not block the repeated-state diagnostic path from running.
`just write-fem-static-pbc-demag-repeated-unit-initial-state` is a preparatory
producer for controlled supercell fixtures. It consumes a primitive artifact
root, a repeated-supercell artifact root, and `repeat_x/repeat_y`, then writes a
file-backed sampled `m` state plus
`fem_static_pbc_repeated_unit_initial_state.v1` provenance by reducing each
supercell magnetic node into the primitive lateral period. The producer has two
explicit mapping modes. `nearest` copies the nearest primitive `m_final` vector
and is strict by default: `max_nearest_distance_m = 1e-12` is intended only for
same-local-discretization repeated meshes. Looser nearest thresholds are
diagnostic only and must be recorded in the provenance. The managed
repeated-state strict-M5 path uses `linear_tetrahedral_interpolation`, which
locates each reduced supercell magnetic node in primitive magnetic tetrahedra
and writes the barycentric interpolation of primitive `m_final`. This keeps the
state-generation contract aligned with the `interpolated_remesh` report basis
for independently remeshed supercells. A 2026-07-01 writer check on the current
independently remeshed 3x3 exchange-coupled artifacts mapped all `42953`
supercell magnetic nodes with `min_barycentric_weight =
-2.123200791492914e-14` at tolerance `1e-10`. This only proves that the seeded
state can now be generated consistently for a remesh; it does not close M5
until a fresh managed repeated-state runtime artifact and the corresponding
primitive-vs-supercell field/potential/energy/torque reports pass.
`just write-fem-static-pbc-demag-tiled-supercell-fixture` is an even narrower
diagnostic fixture producer: it copies a primitive artifact root into an
explicitly tiled repeated artifact with the same local node coordinates modulo
the primitive period, scales extensive energy terms by the repeated-cell count,
and writes `diagnostics/fem_static_pbc_supercell_central_cell.v1.json` from the
central copied tile. This is not a runtime solve and is not physical
primitive-vs-supercell evidence. Its purpose is to prove that the strict
same-local `fem_static_pbc_supercell_validation.v1` comparison path accepts a
known-good same-local artifact and therefore to separate comparator/plumbing
bugs from solver, mesh, or interpolation failures. Passing
`just verify-fem-static-pbc-demag-tiled-supercell-fixture ...` is a diagnostic
precondition only; M5 still requires a runtime-produced same-local supercell or
an explicitly validated interpolation path plus passing field, potential,
state, energy, torque, and seam metrics.
`just write-fem-static-pbc-demag-supercell-interpolated-diagnostic-report` adds
the first explicit interpolation diagnostic for independently remeshed
primitive-vs-supercell comparisons. It invokes the same strict supercell report
writer with `--include-interpolated-comparison`, producing
`interpolated_central_cell_comparability` by reducing central supercell nodes
modulo the primitive lateral periods and evaluating primitive nodal `m`,
`H_demag`, and `demag_phi` by linear barycentric interpolation on primitive
tetrahedra. The section reports field/magnetic coverage, missed samples,
barycentric tolerance, minimum barycentric weight, vector errors, and
gauge-adjusted `demag_phi` residuals. This remains diagnostic until explicit
coverage and interpolation-error thresholds are promoted into the M5 acceptance
contract; the strict nearest-node same-local gate is unchanged.
`just verify-fem-static-pbc-demag-supercell-interpolated-artifacts` is the
separate opt-in acceptance writer for that promoted contract. It invokes the
report writer with `--accept-interpolated-comparison`, writes
`acceptance_basis = "interpolated_remesh"`, and gates report `status` on zero
missed interpolated field/magnetic samples plus interpolated `m`,
`H_demag`, and gauge-adjusted `demag_phi` thresholds. The runtime artifact
validator consumes such a report only through the separate
`--require-interpolated-supercell-report` flag. This path is intentionally not
the default `--require-supercell-report` strict same-local gate and is not wired
into the managed strict-M5 wrapper until a real workload report passes the
interpolated metrics.
On the current independently remeshed runtime artifacts, this diagnostic writes
`.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_interpolated_validation.v1.json`
with full interpolation coverage (`field_coverage_ratio = 1.0`,
`magnetic_coverage_ratio = 1.0`) but still reports
`interpolated_h_demag_p99_relative_error = 2.179207e-01`,
`interpolated_demag_phi_max_abs_delta_after_offset_A = 1.062366e-04`,
`e_demag_density_relative_error = 3.224739e-02`, and
`central_cell_torque_residual_relative_error = 8.173551e-01`; interpolated
`m.p99_l2_delta = 8.775846e-03` is below the current `2e-2` threshold.
Therefore the current supercell mismatch is not only a nearest-node remesh
artifact: after primitive tetrahedral interpolation, the field, potential,
energy, and torque remain outside the strict M5 tolerances.
For controlled repeated-state supercells, an additional operator-level
diagnostic uses asymmetric states:

```bash
just verify-fem-static-pbc-demag-supercell-repeated-state-initial-operator-artifacts \
  unit/artifacts repeated-state-supercell/artifacts 3 3
```

The managed repeated-state runtime writes the same report as a diagnostic before
the strict final-state interpolated report:

```bash
just write-fem-static-pbc-demag-supercell-repeated-state-initial-operator-diagnostic-report \
  unit/artifacts repeated-state-supercell/artifacts 3 3
```

That diagnostic target uses `--allow-failed-status`, so the report is preserved
even when the current demag/PBC mismatch is expected to make the strict final
acceptance fail.

This writes
`supercell_interpolated_initial_operator_validation.v1.json` with
`comparison_state = "final_to_initial"`, `unit_comparison_state = "final"`,
and `supercell_comparison_state = "initial"`. The asymmetry is intentional:
the repeated supercell is seeded from primitive `m_final`, so comparing it to
primitive `m_initial` is physically wrong. This report does not gate final
energy or torque; it asks whether the first demag evaluation on the seeded
supercell agrees with the primitive final-state demag field. After regenerating
the repeated-state run from the interpolated and unit-normalized seed, the
report has full interpolation coverage and the seeded `m` check now passes
(`interpolated_m_p99_l2_delta = 5.254146e-04`). It still fails on the demag
operator observables with `interpolated_h_demag_p99_relative_error =
2.163426e-01` and `interpolated_demag_phi_max_abs_delta_after_offset_A =
1.068777e-04`. This is stronger negative evidence than a final-relaxation
mismatch: after removing the seed-mapping error, the primitive-vs-supercell
demag disagreement is already visible at the seeded operator evaluation.
The comparator now also separates removable gauge/affine artifacts from a real
demag-field-shape mismatch. On the regenerated `final_to_initial` report, the
best constant `H_demag` delta is only `[17.875229, -14.443734,
-32.324580] A/m`, and subtracting it does not improve the mismatch:
`p99_l2_delta_after_mean_delta = 3.589741e+04 A/m` and
`p99_relative_error_after_mean_delta = 2.164383e-01`. For `demag_phi`, the best
affine fit has gradient `[4.800680, 0.735719, 3.324225] A/m`, but the residual
remains `max_abs_delta_after_affine_A = 1.069810e-04` with
`p99_abs_delta_after_affine_A = 3.724454e-05`. Therefore the current blocker is
not a scalar-potential gauge offset and not a uniform-field offset; it is still
a demag/PBC operator, boundary-model, or remeshing/interpolation field-shape
disagreement.
The managed repeated-state wrapper now uses the `interpolated_remesh`
acceptance target for its final-state supercell report, because the repeated
supercell is independently remeshed. On the same regenerated artifacts that
report reaches the physical metrics and fails with
`interpolated_h_demag_p99_relative_error = 2.162412e-01`,
`interpolated_demag_phi_max_abs_delta_after_offset_A = 1.018032e-04`, and
`e_demag_density_relative_error = 2.404344e-02`; interpolated `m` and
central-cell torque are below their current thresholds. This keeps the managed
target's failure reason aligned with the demag/PBC operator mismatch instead
of the expected nearest-node mismatch of independent remeshes.
Headless script execution can consume that sampled state through
`--initial-magnetization-state PATH`, with optional
`--initial-magnetization-state-format`, `--initial-magnetization-state-dataset`,
and `--initial-magnetization-state-sample-index` matching the existing
magnetization-state loader semantics. This is a runtime initial-state override:
it does not change `ProblemIR.pbc`, mesh PBC, demag boundary conditions, or the
physics contract. Accepted diagnostic artifacts must preserve that runtime
intent in `problem_meta.runtime_metadata.initial_magnetization_state_override`
with at least the source path, normalized format, dataset/sample index when
provided, and loaded vector count, so a repeated-state supercell run cannot be
mistaken for a uniform-initial-state relaxation. The periodic-antidot validator
enforces this in repeated-state flows through
`--require-initial-magnetization-state-override`, which now requires a JSON
source state, resolves the recorded `source_path`, checks that the recorded and
source vector counts match the accepted `m_final.json` vector count, and checks
that artifact `m_initial.json` matches the source state component-wise within
`1e-12`. For shared-domain airbox meshes the repeated-state producer fills
air/non-magnetic nodes with `[0, 0, 0]`, matching the native FEM `m` artifact
semantics outside magnetic material; only magnetic nodes receive mapped unit-cell
magnetization. The strict-preflight
`just verify-fem-static-pbc-demag-supercell-repeated-state-runtime` target first
prepares primitive/supercell artifacts, writes the repeated-unit state, and then
reruns the 3x3 supercell with that state as the first-stage magnetization. After
the run passes the required initial-state override gate, the target writes a
central-cell extraction artifact for the repeated-state supercell and writes a
separate primitive-vs-repeated-state supercell report under
`.fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/`.
The target uses `FULLMAG_PBC_RELAX_REPEATED_STATE_MAX_NEAREST_DISTANCE_M` with a
strict default of `1e-12`, so the current independently remeshed fixture fails
at the repeated-unit mapping preflight instead of running a misleading loose
seeded supercell. A diagnostic `1e-8 m` mapping can still be produced manually
through `just write-fem-static-pbc-demag-repeated-unit-initial-state ... 1e-8`,
but it is not the managed M5 default. The last loose repeated-state report
failed strict M5 with `h_demag_stats_relative_error=6.591465e-02`,
`demag_phi_max_abs_delta_A=4.783996e-05`, and
`relaxation_state_mean_deviation_relative_error=5.578288e-01`. The report also
fails the mapped strict gates with
`mapped_m_p99_l2_delta=2.874209e-02`,
`mapped_h_demag_p99_relative_error=2.324448e-01`,
`mapped_demag_phi_max_abs_delta_after_offset_A=3.779693e-04`,
`mapped_max_nearest_field_node_distance_m=9.740109e-09`, and
`mapped_max_nearest_magnetic_node_distance_m=5.135622e-09`; its
`mapped_central_cell_comparability.same_local_discretization` flag is therefore
`false` for the strict `1e-12 m` nearest-node limit. Its demag-energy density
error and central-cell torque residual are within the current thresholds, so the
remaining blocker is the field/potential, state-comparability, and
same-local-discretization effect of the independently remeshed supercell, not
missing runtime provenance.
The supercell report now also writes
`mapped_central_cell_comparability` by reducing central-cell supercell nodes
modulo the primitive lateral periods and matching them to nearest primitive
nodes. This records nearest-node distances plus pointwise mapped errors for
`m`, `H_demag`, and gauge-adjusted `demag_phi`. The current repeated-state run
still shows a mapped-field discrepancy:
`mapped_h_demag_p99_relative_error=2.32444757146736e-01` and
`mapped_demag_phi_max_abs_delta_after_offset_A=3.7796929083539486e-04`,
with nearest field-node distance below `1e-8 m`. Therefore the present failure
is not only an artifact of comparing aggregate maxima on different meshes. These
mapped quantities are now part of the supercell report `thresholds`; diagnostic
nearest-node tolerances around `1e-8 m` may be used to write evidence, but
strict same-local acceptance requires `mapped_max_nearest_*_distance_m <= 1e-12`.
The report records this explicitly as
`mapped_central_cell_comparability.same_local_discretization`, and validators
reject a report whose boolean flag disagrees with the recorded max nearest-node
distances and `same_local_discretization_limit_m`.
Because the repeated-state
file is written against the prepared supercell mesh and then consumed by a
second headless run, the managed supercell prepare and repeated-state targets
default `FULLMAG_PBC_RELAX_GMSH_THREADS=1` to avoid multithreaded Gmsh
non-determinism changing the node count between those two materializations.

When those environment variables are set, the validator requires:

- `fem_static_pbc_z_padding_validation.v1` with `status="ok"` and finite,
  non-negative demag-energy relative error, `p99(|H_demag|)` relative error,
  and `demag_phi` range relative error below the strict z-padding thresholds;
  global `|H_demag|` maximum and absolute `demag_phi` range deltas are
  diagnostic fields, not standalone acceptance limits;
- `fem_static_pbc_supercell_validation.v1` with `status="ok"`, non-empty
  primitive/supercell artifact references, a repeated-cell count greater than
  one, a `central_cell_extraction` summary copied from
  `fem_static_pbc_supercell_central_cell.v1`,
  `mapped_central_cell_comparability` proving how central-cell nodes were
  matched back to primitive-cell nodes for pointwise diagnostics, and finite,
  non-negative
  central-cell `m`, demag-energy, `H_demag`, `demag_phi`, torque-residual,
  mapped pointwise `m`/`H_demag`/`demag_phi`, and mapped nearest-distance
  comparison metrics below the strict supercell thresholds. For strict M5
  acceptance, `mapped_central_cell_comparability.same_local_discretization`
  must be `true`; `false` marks the report as a diagnostic remesh comparison.
- `fem_static_pbc_supercell_validation.v1` may instead be used as an explicit
  independently remeshed supercell gate only when it has `status="ok"`,
  `acceptance_basis="interpolated_remesh"`, a valid
  `interpolated_central_cell_comparability` section, zero interpolated missed
  field/magnetic samples, and below-threshold interpolated `m`, `H_demag`,
  gauge-adjusted `demag_phi`, demag-energy, and central-cell torque metrics.
  This is accepted only through `--require-interpolated-supercell-report`; it
  does not change the strict same-local `--require-supercell-report` contract.

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
- [x] `examples/fem_periodic_uniform_slab_relax_exchange_coupled.py` and
      `just verify-fem-static-pbc-demag-uniform-slab-runtime` provide a
      managed CPU/GPU false-PBC diagnostic for a uniform film slab before the
      centered-hole antidot workload is interpreted
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
      produce and ordinary-validate the unit/supercell runtime artifact roots
      before central-cell extraction inputs are available, using explicit
      `--supercell-repeat 3 3` validation for the repeated artifact, so the
      index/scalar extraction workflow can operate on concrete runtime data
      instead of being blocked by the strict report preflight
- [x] Repeated FEM artifact roots write `mesh/node_geometry.v1.json` with
      coordinates, magnetic-node mask, and node-index field alignment, so
      central-cell index selection can be audited against mesh geometry rather
      than inferred from field-vector lengths
- [x] A managed `just` entry point can write the central-cell extraction
      artifact from automatically selected central-cell indices,
      automatically computed central-cell demag energy and central-cell torque
      residual while
      validating index ranges and scalar bounds against the resolved supercell
      artifacts; a manual target still accepts literal index lists or files
- [x] Central-cell extraction accepts multi-sample field Zarr artifacts and
      selects the final `samples.csv` row, so step-0 plus final field snapshots
      do not break strict-M5 supercell report generation
- [x] A diagnostic tiled same-local supercell fixture can prove the strict
      primitive-vs-supercell comparator accepts a known same-local artifact
      without treating that fixture as runtime or physical M5 closure
- [x] An opt-in interpolated primitive-vs-supercell diagnostic can compare
      independently remeshed central-cell nodes against primitive tetrahedral
      linear interpolation without relaxing the strict same-local gate
- [x] A separate opt-in `interpolated_remesh` supercell acceptance report and
      validator flag exist, while the strict same-local supercell gate remains
      unchanged
- [x] Repeated-state operator diagnostics can compare primitive final state
      against repeated-supercell initial state through an explicit
      `comparison_state="final_to_initial"` report
- [x] The managed repeated-state wrapper uses the explicit
      `interpolated_remesh` acceptance target for independently remeshed
      repeated supercells, so failures report physical demag-field/potential
      metrics rather than same-local nearest-node mismatch
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
