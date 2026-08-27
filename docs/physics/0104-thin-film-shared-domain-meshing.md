# Thin-film shared-domain meshing

- Status: terminal contract
- Ostatnia aktualizacja: 2026-08-27
- Decyzje: [ADR 0021](../adr/0021-native-mixed-p1-fem-topology.md), [ADR 0027](../adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md)
- Gate produkcyjny: [0105](0105-fem-meshing-production-acceptance.md)

(thin-film-mesh-problem-statement)=
## Problem statement

Cienki ferromagnetyk ma nanometrową grubość i znacznie większy wymiar boczny.
Publiczna metoda `body.mesh.thin_film(...)` zapisuje jedną kanoniczną intencję:
kontrolować rozdzielczość grubości, interfejsu, krawędzi i naroży bez
nadmiernego zagęszczenia całego airboxu. Domena magnetyczna i powietrzna
pozostają zgodne geometrycznie.

(thin-film-mesh-governing-equations)=
## Governing equations

Polityka nie zmienia równań mikromagnetycznych. Dla exact layers:

```{math}
:label: eq-thin-film-layer-height

h_z=\frac{t}{N_z},\qquad N_z^{\mathrm{realized}}=N_z^{\mathrm{requested}}.
```

W każdej strefie obowiązuje kanoniczna kompozycja:

```{math}
:label: eq-thin-film-size-composition

h_{\mathrm{target}}(\mathbf x)=
\max\!\left(\min_{u\in\mathcal U(\mathbf x)}u,
             \max_{\ell\in\mathcal L(\mathbf x)}\ell\right).
```

(thin-film-mesh-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Znaczenie | SI |
|---|---|---|
| $t$ | film thickness | $\mathrm m$ |
| $N_z$ | requested and realized exact layer count | $1$ |
| $h_z$ | fixed layer height | $\mathrm m$ |
| $\mathbf x$ | physical point | $\mathrm m$ |
| $\mathcal U$ | eligible upper targets | $\mathrm m$ |
| $\mathcal L$ | eligible lower bounds | $\mathrm m$ |
| $h_\mathrm{target}$ | resolved target size | $\mathrm m$ |

(thin-film-mesh-assumptions-and-validity)=
## Assumptions and validity

Preset tetrahedralny jest bieżącą realizacją ogólną. `topology="prismatic"`
żąda ograniczonego mixed-P1 lane z ADR 0021 i musi przejść jego gates. Exact
through-thickness layers gwarantują wyłącznie liczbę warstw 3D i ich płaszczyzny;
**nie** gwarantują structured in-plane meshing. Wspólne równania, znaki, jednostki
i obserwable FEM CPU/GPU pozostają backend-neutral.

(thin-film-mesh-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `GeometryMeshHandle.thin_film.hmax` | `float \| str \| None` | `None` | $\mathrm m$ | compatibility alias used only when maximum_element_size is None; if both are provided, canonical maximum_element_size wins without error; conflict rejection is planned | body upper-target alias | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].maximum_element_size` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.maximum_element_size` | `float \| Literal["auto"] \| None` | `None` | $\mathrm m$ | positive finite float or exactly `auto`; any other string gives ValueError; canonical value wins over hmax | canonical body upper target | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].maximum_element_size` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.hmin` | `float \| None` | `None` | $\mathrm m$ | compatibility alias used only when minimum_element_size is None; if both are provided, canonical minimum_element_size wins without error; conflict rejection is planned | body lower-bound alias | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].minimum_element_size` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.minimum_element_size` | `float \| None` | `None` | $\mathrm m$ | positive and not above a numeric maximum_element_size; canonical value wins over hmin | canonical body lower bound | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].minimum_element_size` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.order` | `int \| None` | `None` | $1$ | prismatic topology accepts only 1 or None; otherwise ValueError | FEM basis order | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].order` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.curvature_factor` | `float \| None` | `None` | $1$ | positive when provided; otherwise ValueError | curvature upper-target factor | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].curvature_factor` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.narrow_region_resolution` | `float \| None` | `None` | $1$ | positive when provided; otherwise ValueError | elements across a narrow gap | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].narrow_region_resolution` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.layers` | `int` | `1` | $1$ | integer at least one; otherwise ValueError | through-thickness layer count | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].through_thickness_elements` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.topology` | `Literal["tetrahedral", "prismatic"] \| None` | `None` | $1$ | any other token gives ValueError | requested mesh topology | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].topology` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.exact_layers` | `bool \| None` | `None` | $1$ | non-bool gives TypeError; requires prismatic topology; False requires extended mode | exact layer-count intent | bounded mixed-P1 FEM | `runtime_metadata.mesh_workflow.per_geometry[].exact_layer_count` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.transition` | `Literal["pyramid_to_tetrahedra"] \| None` | `None` | $1$ | requires prismatic topology; the only accepted explicit token is pyramid_to_tetrahedra; reject or any other token gives ValueError | shared-domain transition policy | bounded mixed-P1 FEM | `runtime_metadata.mesh_workflow.per_geometry[].transition_policy` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.interface_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | compatibility alias used only when surface_maximum_element_size is None; if both are provided, canonical surface value wins without error; conflict rejection is planned | interface upper-target alias | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].interface_maximum_element_size` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.surface_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | positive when provided; canonical value wins over interface_maximum_element_size | canonical surface/interface upper target | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].interface_maximum_element_size` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.interface_thickness` | `float \| None` | `None` | $\mathrm m$ | compatibility alias used only when surface_thickness is None; if both are provided, canonical surface value wins without error; conflict rejection is planned | interface-halo thickness alias | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].interface_thickness` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.surface_thickness` | `float \| None` | `None` | $\mathrm m$ | positive when provided; canonical value wins over interface_thickness | canonical surface/interface halo thickness | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].interface_thickness` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.transition_distance` | `float \| str \| None` | `None` | $\mathrm m$ | compatibility alias used only when surface_transition_distance is None; non-negative number or airbox_boundary; aliases airbox-boundary and auto_boundary normalize to airbox_boundary; canonical surface value wins without error; conflict rejection is planned | surface-transition alias | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].transition_distance` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.surface_transition_distance` | `float \| str \| None` | `None` | $\mathrm m$ | non-negative number or airbox_boundary; aliases airbox-boundary and auto_boundary normalize to airbox_boundary; any other value gives ValueError; canonical value wins over transition_distance | canonical surface transition span | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].transition_distance` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.edge_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | positive and paired with edge_thickness; otherwise ValueError | edge upper target | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].edge_hmax` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.edge_thickness` | `float \| None` | `None` | $\mathrm m$ | positive and paired with edge target; below half the smaller in-plane dimension for boxes; otherwise ValueError | edge-zone width | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].edge_thickness` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.edge_transition_distance` | `float \| str \| None` | `None` | $\mathrm m$ | positive number or airbox_boundary; aliases airbox-boundary and auto_boundary normalize to airbox_boundary; requires complete edge pair; otherwise ValueError | edge air-transition span | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].edge_transition_distance` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.corner_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | positive and paired with corner_extent; no larger than edge target when both exist; otherwise ValueError | corner upper target | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].corner_hmax` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.corner_extent` | `float \| None` | `None` | $\mathrm m$ | positive and paired with corner target; below half the smaller in-plane dimension for boxes; otherwise ValueError | corner-zone extent | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].corner_extent` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
| `GeometryMeshHandle.thin_film.corner_transition_distance` | `float \| str \| None` | `None` | $\mathrm m$ | positive number or airbox_boundary; aliases airbox-boundary and auto_boundary normalize to airbox_boundary; requires complete corner pair; otherwise ValueError | corner air-transition span | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].corner_transition_distance` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.thin_film` |
```python
# %% Complete canonical FEM thin-film study.
import fullmag as fm

study = fm.study("thin-film")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(320e-9, 220e-9, 120e-9))
study.universe.mesh(maximum_element_size=30e-9)

film = study.geometry(fm.Box(size=(200e-9, 100e-9, 4e-9)), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh.thin_film(
    maximum_element_size=8e-9,
    minimum_element_size=2e-9,
    layers=4,
    topology="prismatic",
    exact_layers=True,
    transition="pyramid_to_tetrahedra",
    surface_maximum_element_size=4e-9,
    surface_thickness=8e-9,
    surface_transition_distance="airbox_boundary",
)
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1)
```

(thin-film-mesh-problem-ir)=
## ProblemIR and provenance

Requested intent trafia do `runtime_metadata.mesh_workflow.per_geometry[]` w
bieżącym modelu. Resolved execution zapisuje rzeczywistą topologię, warstwy,
strefy i quality evidence. Planowany typowany V04 zastępuje to atomowo razem z
ADR 0024/0027; bez dual-write, heurystycznego odczytu lub ukrytego fallbacku.

(thin-film-mesh-backend-matrix)=
## Backend matrix

| Lane | Status |
|---|---|
| FEM CPU tetra | bieżący |
| FEM GPU tetra | wspólna siatka; runtime zależny od capability |
| FEM CPU/GPU mixed prism | ograniczony lane ADR 0021, nie ogólna obietnica |
| FDM CPU/GPU | not applicable; regularna siatka ma odrębny kontrakt |

(thin-film-mesh-discrete-realization)=
## Discrete realization

Tetra lane stosuje wspólny OCC mesh i lokalne pola surface/edge/corner/air.
Ograniczony prismatic lane wyciąga source-face triangulation do prism6, łączy ją
z pyramid5 transition i tet4 far air, zachowując jedną conforming domain.

(thin-film-mesh-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Eksport zachowuje requested intent i aliasy normalizuje do nazw kanonicznych.
Validation errors obejmują niepoprawne pary, liczby, topologię i order.
Unsupported combinations, brak wymaganej capability oraz różnica exact layers
muszą przerwać przygotowanie; silent tetrahedral/CPU fallback jest zabroniony.

(thin-film-mesh-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle.thin_film` waliduje i obniża preset. `generate_swept_box_mesh`
realizuje ograniczony box mixed-P1 lane. `_build_field_stack` realizuje obecne
strefy tetrahedralne. Te symbole nie dowodzą jeszcze produkcyjności; wymagane są
metryki i artifacts z 0105.

(thin-film-mesh-validation)=
## Validation

- Unit/round-trip wszystkich parametrów i aliasów.
- Exact layer count, plane coordinates i topology histogram.
- Jakość oraz coverage per zone według 0105, oddzielnie CPU/GPU.
- Scenariusz demag/relaxation z material+air shared domain.

(thin-film-mesh-limitations)=
## Limitations

Mixed prism pozostaje ograniczony do jawnie wspieranej geometrii i P1. Exact
layers nie stanowią dowodu uporządkowania in-plane. Sama obecność fixture Gmsh
nie kwalifikuje operatora ani managed runtime.

(thin-film-mesh-scientific-bibliography)=
## Scientific bibliography

- P. Monk, *Finite Element Methods for Maxwell's Equations*, 2003.
- Gmsh reference manual, transfinite and extrusion meshing.

(thin-film-mesh-source-code-index)=
## Source-code index

| Warstwa | Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | publiczny thin-film contract |
| Sweep | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_box_mesh` | ograniczona mixed-P1 realizacja box |
| Tetra fields | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_build_field_stack` | strefy surface/edge/corner/air |
| Quality | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_extract_quality_metrics` | bieżące metryki Gmsh |
