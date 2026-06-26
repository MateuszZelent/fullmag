# FEM exchange and FEM viewport audit: tetraX, Tetmag, Fullmag

Date: 2026-06-26

Scope:

- reference implementations under `external_solvers/tetrax` and `external_solvers/tetmag`;
- Fullmag native FEM CPU/GPU exchange implementation;
- Fullmag v2 field/topology data path used by the 3D viewport;
- likely explanation for a surface that looks as if the mesh changes the field texture.

This audit is based on source inspection. I did not run a native FEM rebuild or
runtime validation in this pass. For native FEM/MFEM/CUDA proof, the project
route is the managed/container-backed `just` flow, not host-side `cmake` or
direct binaries.

## Executive verdict

The strongest finding is not a wrong exchange sign or missing `2 A/(mu0 Ms)`
factor in the main Fullmag FEM exchange operator. The CPU and current legacy GPU
exchange paths match the documented Fullmag convention:

```text
H_ex = -2 M_lumped^-1 K_A m / (mu0 Ms)
```

where `K_A` is the assembled weak-form stiffness for
`integral A_ex grad(phi_i).grad(phi_j) dV`. This is consistent with tetraX and
Tetmag once their different field-normalization conventions are accounted for.

The much higher-risk area is visualization/data compatibility: Fullmag splits
topology and field payloads into separate resources, allows full, scoped, and
sampled field buffers, and often validates compatibility by point count and
revision metadata instead of by an explicit value-to-node map embedded in the
field payload. tetraX and Tetmag avoid most of this class of bug by rendering or
exporting point data together with the exact mesh points/cells.

My current root-cause hypothesis for the "artificial texture" symptom is:

1. a field buffer can be considered compatible with the current mesh when only
   the point count matches;
2. a mesh/topology update can avoid a revision bump if `generation_id`,
   `mesh_id`, and element/node/boundary-face counts remain constant;
3. scoped or magnetic-only field buffers do not carry explicit node-index maps
   inside the binary FMVP payload;
4. the viewport has retention paths that intentionally keep stale-compatible
   color buffers, but some compatibility checks reduce to vertex count plus
   display settings.

That combination can make a physically smooth FEM field appear as if the mesh
has changed or scrambled the texture, even when the underlying exchange
operator is correct.

## Expected FEM exchange contract

For reduced magnetization `m = M/Ms`, the exchange energy and field are:

```text
E_ex = integral_Omega A_ex |grad m|^2 dV
H_ex = 2 A_ex / (mu0 Ms) Delta m
```

In a P1 tetrahedral weak form, a positive stiffness matrix

```text
K_A,ij = integral A_ex grad(phi_i).grad(phi_j) dV
```

gives the variation

```text
delta E_ex / delta m = 2 K_A m
H_ex = -2 M^-1 K_A m / (mu0 Ms)
```

The minus sign appears because the weak Laplacian is represented by the positive
gradient stiffness; it is not a bug by itself.

Fullmag's physics note states the same contract: the CPU exchange module returns
`H_ex` in `A/m`, assembles the MFEM stiffness for `integral A_ex grad(phi_i).
grad(phi_j) dV`, applies mass projection and `Ms` scaling in
`exchange_mass_projection.*`, and zeros nonmagnetic nodes before the field
leaves the module (`docs/physics/fem_exchange.md:21-47`). The explicit default
projection is:

```text
H_ex,i = -2 (K_A m)_i / (mu0 Ms_i M_lumped,i)
```

(`docs/physics/fem_exchange.md:67-80`). The GPU note in the same file documents
the same lumped projection and energy convention (`docs/physics/fem_exchange.md:
96-116`).

## tetraX exchange implementation

tetraX defines symmetric exchange as:

```text
w_ex = A_ex (grad m)^2
h_ex = 2/(mu0 Ms^2) div(A grad m)
```

(`external_solvers/tetrax/tetrax/interactions/exchange.py:40-57`). In
`prepare_matrices`, it picks a geometry-specific exchange matrix builder and a
mesh-scale factor (`exchange.py:77-92`). In `update_matrices`, it builds
`sparse_mat_with_Aex` and left-multiplies it by

```text
2 / (mu0 * Msat_avrg * Msat * scale^2)
```

(`exchange.py:94-119`). The field call then returns the negative matrix product
(`exchange.py:121-122`). That is the same sign structure as Fullmag: a positive
gradient stiffness is turned into a Laplacian-like effective field by an
external negative factor.

For the 3D tetrahedral C path, tetraX computes P1 shape gradients and element
volumes in `Shape3DFGrad` (`galerkin.c:60-107`), computes nodal Wigner-Seitz
volumes, allocates exchange CSR structures, and fills exchange matrices in
`ExchangeLaplacian` (`galerkin.c:196-208`). The sparse matrix builder uses
node-local `A` on diagonal entries and a nodal-volume weighted average of `A`
for off-diagonals (`opmatspm.c:83-144`). The Cython wrapper returns the negated
CSR matrix (`cythoncore.pyx:715-760`).

For 1D/axisymmetric cases, the pure-Python builder `CalcLaPl` uses the same
pattern: off-diagonal `Aex` is volume-weighted between nodes, diagonal terms use
node-local `Aex`, and the result is divided by nodal volume
(`fempreproc.py:354-448`). Axisymmetric radial exchange also adds a `1/rho`
gradient correction with `Aex` weighting (`fempreproc.py:627-731`).

Important reference note: tetraX's 3D C helper sets
`elm->vol_el[nel] = fabs(v6)/2.0` (`galerkin.c:82-83`), while Tetmag uses
`abs(volume6)/6`. I am not treating this as a Fullmag bug. It may be an internal
convention coupled to tetraX's volume and scaling code, but it is not evidence
that Fullmag's MFEM stiffness sign or `2/(mu0 Ms)` projection is wrong.

## Tetmag exchange implementation

Tetmag's preprocessing constructs the standard FEM ingredients:

- constructor-owned sparse gradient and stiffness matrices
  (`external_solvers/tetmag/preproc/FEMprocessing.cpp:57-68`);
- element and nodal volumes, with tetra volume `abs(volume6)/6` and `V/4` nodal
  accumulation (`FEMprocessing.cpp:104-112`);
- P1 shape-function gradients from the signed tetra volume
  (`FEMprocessing.cpp:153-195`);
- gradient operators and transpose-like operators (`FEMprocessing.cpp:228-253`);
- element stiffness as `grad_i dot grad_j * element_volume`
  (`FEMprocessing.cpp:266-277`);
- global stiffness assembly (`FEMprocessing.cpp:281-286`).

Tetmag then forms the exchange field operator by taking the geometric stiffness
matrix, left-multiplying by `A/NodeVol`, and multiplying by `-2`
(`external_solvers/tetmag/main/EffFieldCalc.cpp:59-63`). The field is just
`XC_field_OP * Mag` (`EffFieldCalc.cpp:97-100`). The exchange energy computes
`NodeVol^T * Hexc * Mag / -2` (`EffFieldCalc.cpp:65-69`), and the direct energy
check computes squared gradients times `A * NodeVol` (`EffFieldCalc.cpp:
177-200`).

Tetmag's field appears differently scaled than Fullmag because it does not show
the explicit `mu0 Ms` projection in this operator. That is a convention
difference, not a sign error proof. Tetmag works with its own normalized field
units in the surrounding solver.

## Fullmag exchange implementation

### CPU/MFEM operator

Fullmag's MFEM operator setup does the expected magnetic-domain selection and
form assembly:

- builds an attribute marker from `ctx.mesh.magnetic_element_mask`
  (`backends/fem/cpu/mfem/interactions/exchange_operator.cpp:47-60`);
- rejects exchange-enabled domains with no active magnetic attributes
  (`exchange_operator.cpp:62-71`);
- assembles a legacy MFEM `DiffusionIntegrator(a_coeff)` over magnetic
  attributes (`exchange_operator.cpp:73-81`);
- assembles an `Ms`-weighted mass form and an unweighted volume mass form
  (`exchange_operator.cpp:92-103`);
- prepares lumped mass and inverse lumped mass (`exchange_operator.cpp:
104-110`);
- rejects all-zero magnetic lumped mass when exchange is enabled
  (`exchange_operator.cpp:114-124`).

The choice of legacy assembly is intentional: the code notes that MFEM 4.7
tetrahedral H1 partial assembly can abort in the relevant `GetDofToQuad` path
(`exchange_operator.cpp:73-75`).

### CPU/MFEM mass projection and field

`apply_exchange_component_mass_projection` first computes `tmp = K_A m`
(`backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp:169-184`).
Then:

- periodic consistent-mass projection solves a reduced mass system and writes
  `-(2/mu0) * solution` back to full nodes (`exchange_mass_projection.cpp:
47-139`);
- periodic lumped projection aggregates `tmp` and mass by reduced node and uses
  representative-node `Ms` (`exchange_mass_projection.cpp:204-244`);
- nonperiodic consistent projection solves `mass_form * h = tmp`, then scales by
  `-(2/mu0)` (`exchange_mass_projection.cpp:247-272`);
- nonperiodic lumped projection writes
  `-(2/(mu0*Ms_i)) * tmp_i * inv_lumped_mass_i`
  (`exchange_mass_projection.cpp:273-285`);
- energy is accumulated as `m_component * tmp` (`exchange_mass_projection.cpp:
287-289`).

`compute_exchange_for_magnetization` applies that projection to x/y/z
components, packs the result into AoS `h_ex_xyz`, and zeros nonmagnetic nodes
from `ctx.mesh.magnetic_node_mask` (`backends/fem/cpu/mfem/interactions/
exchange_field.cpp:81-149` and `151-166`). Optional `H_eff` export adds Zeeman
after exchange (`exchange_field.cpp:168-177`).

This is consistent with the Fullmag physics note and with the FEM weak-form sign.

### GPU legacy sparse exchange

The current CUDA exchange kernel applies the same lumped projection:

```cpp
h_component[row] = -(2.0 / (kMu0 * ms_i)) * km * inv_mass;
```

after skipping nonmagnetic nodes and invalid `Ms`/mass values
(`backends/fem/gpu/cuda/exchange/exchange_kernels.cu:15-51`). The energy kernel
computes `m dot (K_A m)` per row and reduces it (`exchange_kernels.cu:53-87`).

I do not see evidence that CPU and current GPU exchange disagree on the main
field sign/scaling. A remaining validation gap is that the local contract tests
are mostly ownership/source-contract tests, not a complete numerical regression
suite. The documented numerical gate is
`tests/fem_exchange_validation/sinusoidal_mode.py`, which compares `H_ex` against
`(2A/(mu0 Ms))*Delta m` and energy against `A k^2 V` (`sinusoidal_mode.py:1-20`,
`65-75`, `95-140`, `220-252`). That script still requires a built PyO3/MFEM
runtime to produce runtime evidence.

## Reference visualization/export behavior

### tetraX

tetraX only accepts fields whose shape matches the mesh:

- scalar field: `(mesh.nx,)`;
- vector field: `(mesh.nx, 3)`.

The check and plotting branch are explicit in `Sample.show`
(`external_solvers/tetrax/tetrax/sample/sample.py:556-638`). Scalar fields and
vector components are passed to `k3d.mesh` as `attribute=...` over the same
`self.xyz` and triangle cells (`sample.py:579-632`). Vector glyphs use the same
`self.xyz` positions (`sample.py:591-603`). The mesh overlay itself is built
from `self.xyz` and `self._meshio_mesh.get_cells_type(...)`
(`external_solvers/tetrax/tetrax/sample/mesh/sample_mesh.py:414-447`).

For file output, tetraX writes `points=sample.xyz`, `cells=sample.mesh.
_meshio_mesh.cells`, and `point_data=save_dict` in one `meshio.write_points_cells`
call (`external_solvers/tetrax/tetrax/common/io.py:127-182`). Eigenmode profile
export uses the same pattern (`external_solvers/tetrax/tetrax/experiments/eigen/
utils.py:223-248`), and relaxation output saves initial/final magnetization
through that field-to-file path (`external_solvers/tetrax/tetrax/experiments/
_relax/result.py:188-204`).

### Tetmag

Tetmag defines one `vtkUnstructuredGrid` from original points and tetra cells
(`external_solvers/tetmag/io/MeshWriter.cpp:61-78`). It writes vector point data
with `SetNumberOfTuples(nx)` and `SetTuple3(i, ...)` (`MeshWriter.cpp:
118-127`), writes scalar point data with `SetNumberOfValues(nx)`
(`MeshWriter.cpp:141-148`), and exports magnetization as point vectors in `.vtu`
(`MeshWriter.cpp:152-173`).

The key difference from Fullmag is architectural: both tetraX and Tetmag bind
field values to the exact mesh node ordering at the render/export boundary.
Fullmag's browser path intentionally separates topology and field resources, so
it must be stricter about compatibility metadata than these reference solvers.

## Fullmag field/topology visualization path

### API payloads

Fullmag's FMVP field-vector binary payload stores:

- magic/version/value kind;
- component count;
- value count;
- grid dimensions;
- a short quantity id;
- the raw values.

It does not store a topology revision, generation id, mesh hash, node index map,
scope node list, or sampling index list
(`crates/fullmag-api/src/field_store.rs:11-65`,
`apps/control-room/src/kernel/api/codecs/fieldVectorCodec.ts:17-85`).

The HTTP response adds useful headers (`x-fullmag-field-revision`,
`x-fullmag-domain-generation-id`, point/value counts, quantity id, component,
encoding), but those headers are not part of the decoded `DecodedFieldVector`
object (`crates/fullmag-api/src/router_v2/handlers/data/fields.rs:531-598`;
`ControlRoomApi.ts:1988-2130`).

The field endpoint builds ETags from quantity, field revision, current domain
generation id, component, scope token, sample token, and snapshot token
(`fields.rs:1493-1504`). This is good for cache invalidation when the domain
revision is trustworthy. It does not prove that the field values themselves were
computed on the current topology.

### Compatibility checks

The server-side field/domain check accepts:

- exact full-node count;
- for `magnetic_only` quantities, exact magnetic-node count.

It does not compare an embedded field-domain id, mesh hash, node ordering, or
node index map (`crates/fullmag-api/src/router_v2/handlers/data/
field_resolution.rs:10-39`). The magnetic-node count is derived from mesh parts,
object segments, or nonzero element markers (`field_resolution.rs:98-150`).

Scoped field requests are created by resolving scope node indices from mesh
parts, object segments, airbox, or selection (`fields.rs:944-1026`). The API then
physically filters the value array in that order and sets the output grid to the
scoped point count (`fields.rs:1250-1272`, `1505-1516`). Sampling also changes
the point sequence without returning the sampled indices (`fields.rs:1274-1338`).

This is a contract gap: after decoding FMVP, the frontend sees a shorter field
with `pointCount = N`, but does not receive the exact node indices that define
what those N values correspond to.

### Mesh revision identity

The API mesh revision bump is based on:

```text
generation_id : mesh_id : nodes.len : elements.len : boundary_faces.len
```

(`crates/fullmag-api/src/session.rs:786-819`). It does not include node
positions, tetra connectivity, boundary connectivity, mesh parts, surface faces,
object segments, markers, or part node-index ordering.

Therefore, a mesh update that keeps those IDs and counts stable but changes
connectivity/positions/part mappings will not bump mesh revision. That is
especially dangerous because the viewport spec explicitly says topology changes
release geometry while field changes update attributes/textures
(`docs/specs/frontend-v2/25-viewport-3d-field-data-architecture.md:318-323`).

The live-state application also intentionally carries forward heavy
magnetization and mesh payloads across frames that omit them, to avoid stale or
static textures on intermediate scalar-only frames (`session.rs:1458-1488`).
That is reasonable for sparse solver updates, but it makes domain identity
checks more important: stale payload carry-forward must never cross an actual
topology change that happens to keep counts stable.

### Frontend render model

The frontend has several good protections:

- surface shader demand is unsampled and complete when field-valued surface
  coloring is active (`viewport3DFieldDataPlan.ts:279-320`);
- `viewport3DTargetFieldBufferCanServeSurface` rejects sampled buffers and
  scalar buffers when a full-vector mode is required
  (`viewport3DTargetFieldBuffer.ts:155-177`);
- `buildViewport3DFieldRenderModel` treats a field as full-domain only when
  `fieldVector.pointCount === topology.nodeCount` (`viewport3dRenderModel.ts:
639-649`, `1393-1398`);
- if a compressed magnetic-only field is detected, it tries to map local field
  values to global node indices via magnetic parts (`viewport3dRenderModel.ts:
650-659`, `1466-1488`);
- target buffers include `fieldRevision` and `topologyRevision` in their
  buffer id (`viewport3DTargetFieldBuffer.ts:51-105`, `246-272`);
- chunked color build keys include topology and field revisions
  (`useViewport3DChunkedScalarColors.ts:125-195`).

The remaining weak points are:

1. `buildMagneticFieldNodeIndices` sorts the magnetic node indices before mapping
   (`viewport3dRenderModel.ts:1466-1488`). That is only correct if a compressed
   magnetic-only payload is also sorted by global node id. The API count check
   does not enforce or describe that ordering.
2. Scoped payloads are mapped on the frontend by reconstructing part selection
   indices (`viewport3dRenderModel.ts:1614-1655`) or sampled stride resolvers
   (`viewport3dRenderModel.ts:2698-2746`). That can match the backend only if
   both sides use the same scope object and node ordering. The payload itself
   does not carry the order.
3. Scalar color retention for a mesh part accepts previous colors if mode,
   palette, quantity, and `vertexCount` match (`apps/control-room/src/modules/
   viewport-3d/layers/MeshPartLayer.tsx:119-202`). The retention key includes
   vertex count and visual settings, but not topology revision (`MeshPartLayer.
   tsx:340-367`). If the topology changes without changing node count, retained
   color buffers can still look compatible.
4. `buildVertexScalarColors` allows `fieldVector.pointCount <= vertexCount`
   and writes values in order from zero (`viewport3dFieldMapping.ts:51-80`,
   `367-399`). That is harmless only when shorter field vectors are never used
   as full-domain buffers. Other guards try to prevent that, but the primitive
   utility itself is permissive.
5. FMVP decode validates `grid * nComp == valueCount` but cannot validate
   mesh compatibility (`fieldVectorCodec.ts:51-85`).

The frontend spec forbids exactly the failure class involved here: sampled vector
payloads used as per-vertex shader sources, airbox/object scope merges without
scope semantics, and stale field/topology handling that does not distinguish
topology revision from field revision (`docs/specs/frontend-v2/25-viewport-3d-
field-data-architecture.md:17-33`, `98-108`, `405-416`, `444-466`).

## Findings

### F1. Fullmag exchange sign and scaling look correct

Severity: Not a bug based on source evidence.

The Fullmag CPU/MFEM path assembles `K_A` as a diffusion/stiffness form, then
projects `K_A m` to `H_ex` with `-2/(mu0 Ms)` and lumped or consistent mass.
That matches the documented weak-form convention and is structurally equivalent
to the tetraX/Tetmag reference patterns.

Do not "fix" the apparent negative sign unless a runtime numerical validation
proves a sign error. Changing it would likely invert exchange dynamics.

### F2. Mesh revision identity is too weak for viewport correctness

Severity: High.

`fem_mesh_identity` ignores the data that actually defines a rendered tetra mesh:
positions, element connectivity, boundary faces, part membership, surface faces,
object segments, and markers. It only compares IDs and counts.

If any remesh or mesh synchronization path keeps `generation_id`, `mesh_id`, and
counts stable while changing connectivity or node ordering, the viewport can
reuse topology/color resources as if the mesh were unchanged. This directly
matches the reported symptom: field texture looks as if the mesh changed it.

Required fix:

- replace `fem_mesh_identity` with a stable topology fingerprint that includes
  node positions, element connectivity, boundary faces, markers, mesh parts,
  object segments, and part node ordering;
- bump mesh/topology revisions whenever that fingerprint changes;
- add a regression test where two meshes have identical node/element counts but
  different connectivity or node ordering, and the revision must change.

### F3. Field vectors do not carry enough topology/index metadata

Severity: High.

FMVP does not carry topology revision or value-to-node mapping. Response headers
carry revisions, but the decoded field vector used by render-model code only
contains values, grid, component count, point count, and quantity id.

This is acceptable for full-domain fields only if the resource key, ETag, and
domain revision are always correct. It is not sufficient for scoped,
magnetic-only, or sampled data unless the consumer can reconstruct the exact same
node order.

Required fix:

- extend the binary field contract or companion metadata to include
  `domain_generation_id`, `mesh_topology_revision` or hash, `scope_kind`,
  `scope_id`, and an explicit node-index vector for non-full-domain payloads;
- alternatively, disallow scoped/magnetic-only field payloads for surface shader
  coloring and always return full-node buffers for surface fields.

### F4. Magnetic-only compressed fields rely on an unstated sorted-node order

Severity: Medium to high, depending on whether producers emit compressed
magnetic-only fields today.

The server permits `magnetic_only` fields with `point_count == magnetic node
count`. The frontend maps such a compressed field onto full topology by sorting
all magnetic node indices. The server-side compatibility check counts magnetic
nodes but does not define the ordering of values. If a producer emits values in
mesh-part order, object-segment order, solver-local order, or original insertion
order, the renderer will color the wrong nodes while still passing point-count
validation.

Required fix:

- define a canonical ordering for compressed magnetic-only payloads and enforce
  it at every producer;
- or include explicit node indices with each compressed payload;
- or make magnetic-only render payloads full-node buffers with nonmagnetic
  entries zero/masked.

### F5. Scoped field payloads reconstruct mapping instead of receiving it

Severity: Medium.

The API filters scoped payloads using `scope.node_indices`; the frontend maps
scoped payloads by rebuilding node selections from the target part. That can
work when the same exact part selection is used on both sides, but it is brittle
for object scopes, multi-part objects, airbox exclusions, selection scopes, and
sampled vectors. A mismatch will show up visually as scrambled or artificial
surface color, not as a clean error.

Required fix:

- return scope node indices or sampled node indices with the payload;
- make render-model compatibility compare the explicit node-index list against
  the target surface/part selection;
- mark the pass degraded instead of rendering when the mapping is absent or
  incompatible.

### F6. Stale-compatible color retention can cross topology changes with same node count

Severity: Medium.

`MeshPartLayer` retains previous scalar colors when the new candidate is missing
and the previous buffer still matches color mode, palette, quantity, and vertex
count. It does not require matching topology revision in the retention predicate.
The upload store itself only retains for the same geometry object, but the
higher-level retained buffer can still be selected for a new geometry when the
node count matches.

This is a good anti-flicker mechanism for normal field updates. It is risky when
topology identity is weak.

Required fix:

- include topology revision/hash in scalar color retention compatibility;
- clear retained colors on topology changes, not only on vertex-count changes;
- add a test for same-node-count topology replacement with temporarily missing
  new field colors.

### F7. Numerical validation exists but is not yet enough to rule out all exchange regressions

Severity: Medium.

`exchange_contract.cpp` is valuable, but it mostly pins ownership and source
contracts (`backends/fem/tests/exchange_contract.cpp:1-7`, `58-120`,
`284-319`). The sinusoidal validation script is the right runtime-level check,
but it requires a native runtime and produces CSV convergence evidence only when
run in that environment (`tests/fem_exchange_validation/sinusoidal_mode.py:
22-35`).

Missing proof I would add:

- managed-runtime sinusoidal exchange run through the repo `just` route;
- heterogeneous `Aex`/`Ms` FEM exchange test against a manufactured solution;
- direction-derivative energy/field consistency test:
  `dE(m + eps v)/deps == -mu0 integral Ms H_ex.v dV`;
- nonmagnetic-node mask test for both field and visualization payloads;
- periodic-node projection test with a known smooth mode.

## Most likely visual failure paths

### Path A: topology changes, counts stay constant, old field remains accepted

1. Solver or mesh pipeline sends a new FEM mesh.
2. `fem_mesh_identity` sees the same generation id, mesh id, node count, element
   count, and boundary-face count.
3. Mesh revision does not bump.
4. Field/resource caches and retained color buffers remain compatible.
5. The same field values are applied to changed connectivity or node ordering.

Visual result: the scalar surface looks like it has a new artificial texture or
the mesh changed the field pattern.

### Path B: compressed magnetic-only field order differs from renderer order

1. A field contains only magnetic nodes.
2. API accepts it because point count equals magnetic node count.
3. Frontend maps it to sorted magnetic global node ids.
4. Producer used a different magnetic-node order.

Visual result: field values are assigned to the wrong vertices, producing a
high-frequency mosaic that can look like a mesh artifact.

### Path C: scoped or sampled field lacks explicit node mapping

1. API returns a scoped or sampled buffer.
2. Frontend reconstructs the expected selection or stride.
3. The scope differs because object, part, airbox, or selection semantics are not
   identical between backend and frontend.

Visual result: vectors may look roughly plausible while scalar surface colors
look shifted or discontinuous.

### Path D: auto color range amplifies exchange-field singularity/noise

Even with correct indexing, `H_ex` can be visually harsh on tetra meshes because
it is a second-derivative-like quantity recovered through mass projection. If
auto range is per-target/per-update, outliers can dominate the colormap. This is
a display problem, not necessarily an exchange-operator bug. It should be
investigated after the topology/index compatibility issues above are closed.

## Recommended remediation plan

1. Strengthen FEM mesh identity.
   Include positions, elements, boundary faces, markers, object segments,
   mesh parts, surface faces, node ranges, and explicit node indices in a stable
   topology fingerprint. Use it for mesh revision bumps and topology ETags.

2. Make field payload compatibility explicit.
   Full-domain surface payloads must declare the topology revision/hash they
   match. Non-full-domain payloads must include node indices or be rejected for
   surface coloring.

3. Remove implicit magnetic-only ordering assumptions.
   Either emit full-node buffers for magnetic-only quantities or include
   explicit magnetic node indices in the payload. Do not rely on sorted-node
   reconstruction unless the API contract says every producer must sort that
   way.

4. Tighten viewport retention.
   `stale-compatible` must mean same topology identity, not same vertex count.
   Add topology revision/hash to scalar color retention compatibility and clear
   retained colors on topology changes.

5. Add regression tests for the actual suspected bug class.
   Required cases:
   - same node/element counts but changed connectivity bumps topology revision;
   - field revision update does not rebuild topology, topology revision update
     does rebuild topology;
   - sampled payload is rejected for surface shader;
   - compressed magnetic-only payload without node map is rejected for surface
     shader or scattered by explicit indices;
   - scoped object/part payload carries and uses node indices;
   - retained colors are not reused after topology hash change.

6. Add runtime exchange proof through managed `just`.
   Use the repo-managed runtime path, for example `just ensure-managed-fem-runtime`
   before the relevant managed headless validation route. Do not treat host
   `cmake` or raw native binaries as final FEM proof.

## Confidence and open questions

High confidence:

- Fullmag's CPU exchange sign and `2/(mu0 Ms)` scaling match the documented weak
  form and reference solver structure.
- tetraX and Tetmag bind fields to mesh nodes much more directly at visualization
  and export boundaries.
- Fullmag's current field/topology split has real compatibility gaps that can
  produce artificial surface textures without a solver-physics bug.

Medium confidence:

- The highest-probability concrete bug is stale field/color reuse across a mesh
  change that keeps node/element counts stable.
- Compressed magnetic-only ordering is a serious latent bug even if the current
  main runtime mostly emits full-node fields.

Open questions that need runtime/browser evidence:

- Which quantity was being visualized when the artifact appeared: `m`, `H_ex`,
  `H_eff`, energy density, mesh quality, or an analysis eigen/response field?
- Was the payload full-domain, scoped object/part, airbox, magnetic-only, or
  sampled?
- Did mesh revision change in the browser diagnostics at the moment the texture
  changed?
- Did the field payload point count equal total node count or magnetic-node
  count?

## Bottom line

Do not start by changing the FEM exchange operator. Start by hardening the
field/topology contract and adding a browser/API regression that reproduces a
same-count topology change with a retained or scoped field buffer. If that test
fails, it explains the reported "mesh changed the texture" effect directly. If
it passes, the next step is a managed-runtime sinusoidal exchange run plus a
captured viewport payload dump for the exact problematic quantity.
