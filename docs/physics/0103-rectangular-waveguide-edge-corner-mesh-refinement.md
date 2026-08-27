# Prostokątne zagęszczanie FEM przy krawędziach i narożach

- Status: terminal contract
- Ostatnia aktualizacja: 2026-08-27
- Decyzja: [ADR 0027](../adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md)
- Gate produkcyjny: [0105](0105-fem-meshing-production-acceptance.md)

(edge-corner-problem-statement)=
## Problem statement

Polityka jest wyłącznie polityką dyskretyzacji współdzielonej domeny FEM.
Zagęszcza cztery pasy krawędziowe i cztery strefy narożne prostokątnego
ferromagnetyka oraz, na jawne żądanie, sąsiadujące powietrze. Nie zmienia
geometrii fizycznej, materiału, warunków brzegowych ani obserwabli.

(edge-corner-governing-equations)=
## Governing equations

Nie zmieniają się równania LLG ani słabe formy. Polityka rozmiaru spełnia

```{math}
:label: eq-edge-corner-size-composition

h_{\mathrm{target}}(\mathbf x)=
\max\!\left(\min_{u\in\mathcal U(\mathbf x)}u,
             \max_{\ell\in\mathcal L(\mathbf x)}\ell\right).
```

`edge_hmax` i `corner_hmax` są lokalnymi **upper targets**. Lower bounds,
w tym jawne minimum użytkownika, nigdy nie są obchodzone przez pas lub naroże.

```{math}
:label: eq-edge-corner-distance

d_E(\mathbf x)=\min_{\mathbf y\in E}\lVert\mathbf x-\mathbf y\rVert_2.
```

Odległość do odzyskanej krzywej lub punktu narożnego steruje tylko lokalnym
przejściem rozmiaru.

(edge-corner-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Znaczenie | SI |
|---|---|---|
| $\mathbf x$ | physical point | $\mathrm m$ |
| $\mathcal U$ | eligible upper size targets | $\mathrm m$ |
| $\mathcal L$ | eligible lower size bounds | $\mathrm m$ |
| $h_\mathrm{target}$ | resolved target size | $\mathrm m$ |
| $E$ | selected edge or corner set | $1$ |
| $d_E$ | Euclidean distance from the selected entity | $\mathrm m$ |

(edge-corner-assumptions-and-validity)=
## Assumptions and validity

Semantyka prostokątna dotyczy `Box`, `Translate(Box)` i płaskiego
`ArchWaveguide` z `arch_height=0`. Dwie największe osie są in-plane, najmniejsza
jest grubością; pasy obejmują pełną grubość. Dla geometrii komponentowej
realizacja może użyć odzyskanych krzywych i ich końców. Exact through-thickness
layers nie oznaczają structured in-plane meshing: ten kontrakt nie gwarantuje
regularnej siatki bocznej.

(edge-corner-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `GeometryMeshHandle.configure.edge_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | positive and paired with edge_thickness | edge-band upper target | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].edge_hmax` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.configure` |
| `GeometryMeshHandle.configure.edge_thickness` | `float \| None` | `None` | $\mathrm m$ | positive, paired, and below half the smaller in-plane dimension | edge-band width | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].edge_thickness` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.configure` |
| `GeometryMeshHandle.configure.edge_transition_distance` | `float \| str \| None` | `None` | $\mathrm m$ | dodatnia liczba albo `airbox_boundary` (akceptowane aliasy: `airbox-boundary`, `auto_boundary`); wymaga kompletnej pary edge, w przeciwnym razie `ValueError` | air-side edge transition span | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].edge_transition_distance` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.configure` |
| `GeometryMeshHandle.configure.corner_maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | positive, paired, and no larger than edge_hmax when both exist | corner upper target | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].corner_hmax` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.configure` |
| `GeometryMeshHandle.configure.corner_extent` | `float \| None` | `None` | $\mathrm m$ | positive, paired, and below half the smaller in-plane dimension | corner-zone extent | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].corner_extent` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.configure` |
| `GeometryMeshHandle.configure.corner_transition_distance` | `float \| str \| None` | `None` | $\mathrm m$ | dodatnia liczba albo `airbox_boundary` (akceptowane aliasy: `airbox-boundary`, `auto_boundary`); wymaga kompletnej pary corner, w przeciwnym razie `ValueError` | air-side corner transition span | FEM CPU/GPU | `runtime_metadata.mesh_workflow.per_geometry[].corner_transition_distance` | `packages/fullmag-py/src/fullmag/world.py::GeometryMeshHandle.configure` |

```python
# %% Complete canonical FEM study with edge and corner refinement.
import fullmag as fm

study = fm.study("edge-corner")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(320e-9, 200e-9, 120e-9))
study.universe.mesh(maximum_element_size=30e-9)

body = study.geometry(fm.Box(size=(200e-9, 80e-9, 4e-9)), name="strip")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(
    maximum_element_size=8e-9,
    edge_maximum_element_size=4e-9,
    edge_thickness=12e-9,
    edge_transition_distance=20e-9,
    corner_maximum_element_size=2e-9,
    corner_extent=10e-9,
    corner_transition_distance=20e-9,
)
study.exchange()
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1)
```

(edge-corner-problem-ir)=
## ProblemIR and provenance

Requested intent zapisuje sześć wartości per geometry w
`runtime_metadata.mesh_workflow.per_geometry[]`. Resolved execution zapisuje
rozpoznany typ geometrii, osie in-plane, wybrane encje, rozmiary i odległości.
Tagi Gmsh są dowodem realizacji, nie kanonicznym zamiennikiem intencji.
Wartości V04 przechodzą wyłącznie w jednym atomic cutover z ADR 0024 i 0027;
dual-write V03/V04 jest zabroniony.

(edge-corner-backend-matrix)=
## Backend matrix

| Lane | Status |
|---|---|
| FEM CPU | authoring i aktualny planner Gmsh; kwalifikacja według 0105 |
| FEM GPU | ta sama siatka i semantyka; brak osobnej polityki GPU |
| FDM CPU | not applicable |
| FDM GPU | not applicable |

(edge-corner-discrete-realization)=
## Discrete realization

Box/flat-arch realizations budują pola pasów i naroży w magnetic bulk; jawne
transition distances rozszerzają wyłącznie odpowiedni plume na transition air.
Wynik jest składany z innymi upper/lower constraints przed uruchomieniem Gmsh.

(edge-corner-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Eksport Python zachowuje requested intent bez normalizacji do tagów. Validation errors
odrzucają niekompletne pary i niepoprawne rozmiary; unsupported combinations
geometrii są odrzucane i nie wolno po cichu rozszerzyć celu na cały obiekt.
Brak encji lub niezdolność backendu jest błędem przed startem solvera.

(edge-corner-implementation-mapping)=
## Implementation mapping

`GeometryMeshHandle.configure` waliduje API. `_perimeter_refinement_config`
normalizuje pary, a `_build_field_stack` tworzy ograniczone pola tła. Ten mapping
opisuje stan bieżący; pełne dowody produkcyjne pozostają bramką 0105.

(edge-corner-validation)=
## Validation

- Unit: każda para, dodatniość, relacja corner/edge i granice wymiarów.
- Integracja Gmsh: dokładnie cztery pasy i cztery strefy dla box/flat arch.
- Naukowa: zliczenie komórek strefami i rozkład jakości według 0105.
- Regresja: identyczne requested intent i resolved execution dla FEM CPU/GPU.

(edge-corner-limitations)=
## Limitations

Dowolne krzywe i CAD wymagają stabilnej odzyskanej topologii. Polityka nie
obiecuje structured in-plane meshing ani niezależnego study-wide default.

(edge-corner-scientific-bibliography)=
## Scientific bibliography

- P. L. George, H. Borouchaki, *Delaunay Triangulation and Meshing*, 1998.
- Gmsh reference manual, background mesh fields and OCC entities.

(edge-corner-source-code-index)=
## Source-code index

| Warstwa | Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | walidacja i lowering sześciu parametrów |
| Normalizacja | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_perimeter_refinement_config` | pary edge/corner i ograniczenia |
| Gmsh | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_build_field_stack` | lokalne pola rozmiaru |
| Raport | `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py` | `_build_shared_domain_build_report` | resolved mesh evidence |
