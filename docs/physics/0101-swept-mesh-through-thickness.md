# Swept mesh through thickness

- Status: authoring and Box/Cylinder generation implemented; bounded Box mixed-P1 execution has source/contract status only; managed production qualification remains pending
- Last updated: 2026-08-27
- Governing ADRs: `docs/adr/0021-native-mixed-p1-fem-topology.md`, `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`

(swept-mesh-problem-statement)=
## 1. Problem statement

Swept meshing resolves a thin three-dimensional body with controlled layers in
one direction without forcing the whole airbox to the thickness scale. It is a
discretization strategy, not a shell, 2.5D, macrospin, or new physical model.

(swept-mesh-governing-equations)=
## 2. Governing equations

For fixed layers of thickness $t$ and exact count $N_z$, node-plane positions
are

```{math}
:label: eq-swept-fixed-planes

z_j=z_0+\frac{j}{N_z}t,
\qquad j=0,\ldots,N_z.
```

For a non-uniform distribution, positive layer heights must sum to thickness:

```{math}
:label: eq-swept-layer-sum

h_i>0,
\qquad \sum_{i=0}^{N_z-1}h_i=t.
```

(swept-mesh-symbols-and-si-units)=
## 3. Symbols and SI units

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $z_0$ | first node-plane coordinate along the sweep direction | $\mathrm m$ |
| $z_j$ | coordinate of node plane $j$ | $\mathrm m$ |
| $j$ | node-plane index | $1$ |
| $N_z$ | number of three-dimensional element layers | $1$ |
| $t$ | physical swept thickness | $\mathrm m$ |
| $h_i$ | physical height of layer $i$ | $\mathrm m$ |
| $i$ | layer index | $1$ |
| $\tau_\mathrm{plane}$ | plane grouping tolerance | $\mathrm m$ |

(swept-mesh-assumptions-and-validity)=
## 4. Assumptions and validity

- Sweepability is geometry-specific; current generation supports Box and
  Cylinder, while ArchWaveguide uses layered surface-constrained tetrahedra
  unless a separately qualified volume sweep exists.
- `exact_layers=True` requires fixed distribution, unit ratio, no symmetric
  grading, and an exact $N_z+1$ plane certificate.
- Exact layers do **not** mean structured in-plane mesh. A triangular source
  face may be unstructured and still extrude to exact `prism6` layers.
- Quadrilateral source faces request `hex8`; the current bounded mixed-P1
  execution contract is prism/pyramid/tet and does not admit hex silently.

(swept-mesh-python-api)=
## 5. Python API

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `GeometryMeshHandle.swept.elements` | `int` | `6` | $1$ | integer $\ge1$; otherwise `ValueError` | layer count | FEM CPU/GPU authoring | `runtime_metadata.mesh_workflow.per_geometry[].through_thickness_elements` | `world.py::GeometryMeshHandle.swept` |
| `GeometryMeshHandle.swept.distribution` | `"fixed" \| "linear" \| "exponential"` | `"fixed"` | $1$ | other token gives `ValueError`; exact layers require `fixed` | layer-height law | FEM CPU/GPU authoring | `runtime_metadata.mesh_workflow.per_geometry[].through_thickness_distribution` | `world.py::GeometryMeshHandle.swept` |
| `GeometryMeshHandle.swept.element_ratio` | `float` | `1.0` | $1$ | finite positive; exact layers require $1$ | last/first layer-height ratio | FEM CPU/GPU authoring | `runtime_metadata.mesh_workflow.per_geometry[].through_thickness_element_ratio` | `world.py::GeometryMeshHandle.swept` |
| `GeometryMeshHandle.swept.symmetric` | `bool` | `False` | $1$ | exact layers reject `True` | mirror grading about mid-plane | FEM CPU/GPU authoring | `runtime_metadata.mesh_workflow.per_geometry[].through_thickness_symmetric` | `world.py::GeometryMeshHandle.swept` |
| `GeometryMeshHandle.swept.face_meshing` | `"triangular" \| "quadrilateral"` | `"triangular"` | $1$ | other token gives `ValueError` | source-face topology | FEM CPU/GPU authoring | `runtime_metadata.mesh_workflow.per_geometry[].sweep_face_meshing` | `world.py::GeometryMeshHandle.swept` |
| `GeometryMeshHandle.swept.sweep_direction` | `"auto" \| "x" \| "y" \| "z"` | `"auto"` | $1$ | other token gives `ValueError` | requested sweep axis | FEM CPU/GPU authoring | `runtime_metadata.mesh_workflow.per_geometry[].sweep_direction` | `world.py::GeometryMeshHandle.swept` |
| `GeometryMeshHandle.swept.transition` | `"pyramid_to_tetrahedra" \| "reject" \| None` | `None` | $1$ | hex plus pyramid transition gives `ValueError` | shared-domain transition policy | bounded prism lane only when supported | `runtime_metadata.mesh_workflow.per_geometry[].transition_policy` | `world.py::GeometryMeshHandle.swept` |
| `GeometryMeshHandle.swept.exact_layers` | `bool \| None` | `None` | $1$ | non-bool gives `TypeError`; strict prism resolves `None` to `True` | require requested=realized layer count | bounded mixed-P1 FEM | `runtime_metadata.mesh_workflow.per_geometry[].exact_layer_count` | `world.py::GeometryMeshHandle.swept` |

```python
# %% Author exact three-dimensional prism layers.
import fullmag as fm

fm.reset()
study = fm.study("swept-film")
study.engine("fem")
study.mode("strict")
study.universe(mode="manual", size=(120e-9, 80e-9, 60e-9))
study.universe.mesh(maximum_element_size=20e-9)
film = study.geometry(fm.Box(size=(24e-9, 12e-9, 3e-9)), name="film")
film.Ms, film.Aex, film.m = 800e3, 13e-12, fm.texture.uniform(1, 0, 0)
film.mesh(maximum_element_size=3e-9, order=1)
film.mesh.swept(elements=3, distribution="fixed", face_meshing="triangular", exact_layers=True)
study.relax(algorithm="projected_gradient_bb", max_steps=1)
```

(swept-mesh-problem-ir)=
## 6. ProblemIR

Requested sweep fields remain under
`runtime_metadata.mesh_workflow.per_geometry[]`. Realized cell types, layer
planes and certificate remain derived mesh evidence. Numeric Gmsh element IDs
never enter canonical IR.

Typowany model V04 przechodzi wyłącznie w jednym atomic writer cutover z ADR
0024/0027; dual-write V03/V04 jest zabroniony.

(swept-mesh-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Python/UI export preserves requested intent. Resolved execution records the
actual axis, cell families, plane count, transition and fallback list.
Validation errors reject malformed or internally contradictory tuples.
Unsupported combinations reject before backend startup. Strict execution never
splits prisms to tets, turns exact off, or falls back GPU to CPU.

(swept-mesh-discrete-realization)=
## 8. Discrete realization

| Solver | Device | Status |
|---|---|---|
| FDM | CPU | not applicable: Cartesian cells already carry directional size |
| FDM | GPU | not applicable: Cartesian cells already carry directional size |
| FEM | CPU | authoring/generation implemented; bounded mixed-P1 source contract, managed qualification pending |
| FEM | GPU | same topology contract; strict device evidence remains lane-specific and pending |

Layer height, plane count, manifoldness, topology and quality sampling use the
exact gates in notes 0105 and 0106. `structured in-plane` is not a resolved
method for this API.

(swept-mesh-implementation-mapping)=
## 9. Implementation mapping

`GeometryMeshHandle.swept` validates and lowers authoring;
`classify_sweepability` resolves geometry eligibility;
`_compute_layer_heights` constructs distributions; and
`generate_swept_mesh` dispatches current generators. Bounded Box mixed topology
is owned by `generate_swept_box_mesh`.

(swept-mesh-validation)=
## 10. Validation

Tests require Python/IR/export round-trip; positive heights summing to $t$;
exact $N_z+1$ planes within
$\tau_\mathrm{plane}=\max(10^{-15}\,\mathrm m,10^{-8}t)$; correct cell/facet
families; manifold shared-domain ownership; no hidden splitter; and the 0105
Jacobian/quality/evidence gates. Runtime claims additionally require managed
CPU/GPU proof.

(swept-mesh-limitations)=
## 11. Limitations

- Full curved-volume ArchWaveguide prism/hex sweep is not qualified.
- Hex shared-domain execution is unsupported by the bounded mixed-P1 lane.
- Non-fixed distributions cannot claim exact layer spacing/count.
- Structured in-plane authoring is not implemented.

(swept-mesh-scientific-bibliography)=
## 12. Scientific bibliography

- Gmsh 4.15.2 reference manual, extrusion and transfinite meshing,
  <https://gmsh.info/doc/texinfo/gmsh.html>.
- P. M. Knupp, “Algebraic mesh quality metrics,”
  <https://doi.org/10.1137/S1064827500371499>.

(swept-mesh-source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public sweep API | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | validates and lowers sweep intent | FEM CPU/GPU | Python contract tests |
| Sweepability | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `classify_sweepability` | resolves supported geometry and thickness | FEM generation | Gmsh tests |
| Layer heights | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_compute_layer_heights` | computes fixed/linear/exponential heights | FEM generation | unit tests |
| Sweep dispatch | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_mesh` | dispatches current swept generators | FEM generation | meshing tests |
| Mixed Box generation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_box_mesh` | produces bounded prism/pyramid/tet shared domain | FEM CPU/GPU contract | mixed topology tests; managed proof pending |
