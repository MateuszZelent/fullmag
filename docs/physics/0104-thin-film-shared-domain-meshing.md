# Thin-film shared-domain meshing

- Status: terminal contract
- Ostatnia aktualizacja: 2026-10-09
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

(thin-film-exact-plane-local-target)=
### Local target on exact layer cross-sections

One candidate for realizing a finite regional target in a layered tetrahedral
Box is to evaluate the existing 3D target at the actual coordinates of each
exact, body-owned layer cross-section. It must not project values through the
film thickness:

```{math}
:label: eq-thin-film-exact-plane-local-target
z_k=-\frac{t}{2}+k h_z,\qquad
k\in\{0,\ldots,N_z\},\qquad
h_{\Sigma,k}(x,y)=h_{\mathrm{target}}(x,y,z_k),
\quad (x,y)\in\Sigma_k .
```

Here $\Sigma_k$ is the 2D cross-section of the exact body-layer GEO volumes
at the requested plane $z_k$. The intended method keeps the existing
upper/lower composition and evaluates it at that plane; a shared internal
plane must be triangulated once and reused by both adjacent slabs. This is a
testable implementation hypothesis, not evidence that the current Gmsh
generation path actually evaluates those regional fields there.

If realized, cross-section-local sizing would let a finite region intersecting
an exact plane receive local in-plane edges before the adjacent slab
tetrahedra are formed. It would not change $N_z$, introduce intermediate $z$
levels, enlarge the ROI, or refine the whole source cap through unrelated air.
The actual field-evaluation and layer-mesh timing still require GHA evidence.

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
| $k$ | exact layer-plane index | $1$ |
| $z_k$ | requested exact layer-plane coordinate | $\mathrm m$ |
| $\Sigma_k$ | body-owned cross-section at $z_k$ | $\mathrm{m^2}$ |
| $h_{\Sigma,k}$ | resolved target size evaluated on $\Sigma_k$ | $\mathrm m$ |

(thin-film-mesh-assumptions-and-validity)=
## Assumptions and validity

Preset tetrahedralny jest bieżącą realizacją ogólną. `topology="prismatic"`
żąda ograniczonego mixed-P1 lane z ADR 0021 i musi przejść jego gates. Exact
through-thickness layers gwarantują wyłącznie liczbę warstw 3D i ich płaszczyzny;
**nie** gwarantują structured in-plane meshing. Wspólne równania, znaki, jednostki
i obserwable FEM CPU/GPU pozostają backend-neutral.

(thin-film-scoped-lower-bound-contract)=
### Zakres dolnych ograniczeń — kontrakt naprawy 2026-10-07

Dolne ograniczenie obiektu obowiązuje w jego rzeczywistej domenie geometrycznej,
a dolne ograniczenie regionu w przecięciu geometrycznego rdzenia regionu i domeny
jego właściciela. W rdzeniu oba ograniczenia są eligible i równanie
`eq-thin-film-size-composition` zachowuje większe z nich. Poza własnym zakresem
wkład regionalnego lub obiektowego lower field wynosi zero, neutralne dla
agregacji `Max`. Jawne globalne minimum nadal obowiązuje globalnie.

`ObjectRegion.mesh.transition_distance` opisuje istniejące przejście górnego
celu rozmiaru do celu obiektu. Nie rozszerza geometrycznego członkostwa regionu
ani nie definiuje interpolacji dolnego ograniczenia. W halo przejścia obowiązuje
lower obiektu, jeśli punkt należy do obiektu; lower regionu pozostaje ograniczony
do rdzenia. Nie zmienia to materiałów, interakcji ani stanu równowagi.

Realizacja wymaga exact component ownership. Fallback bez przypisanych volume
tags nie może zastępować go AABB, które obejmuje również inne obiekty lub
powietrze. Dla żądanego scoped lower i brakującego exact owner binding kontrakt
wymaga jawnego błędu przed generacją, zamiast ignorowania wartości lub cichego
obniżenia globalnego minimum. Pełne wsparcie tego fallbacku pozostaje otwarte.

Owner kompozycji to
`packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py::_configure_mesh_size_fields`;
caller `_apply_mesh_options`, producent `_size_field_plan.py::_build_field_stack`.
Należy wykorzystać istniejące `Min` upper, `Max` lower i końcowe `Max`.
Zakres musi być neutralny poza domeną również po ograniczeniu polem Gmsh;
nie należy wymyślać opcji `OutsideValue` dla `Restrict`. Opcje `Restrict` oraz
semantykę `Threshold` określa [oficjalny manual Gmsh](https://gmsh.info/doc/texinfo/gmsh.html).

Stan źródeł po review 2026-10-07: scoped producer/consumer, lower-only region
i exact owner propagation są zaimplementowane; regresje oczekują świeżego CI.
FEM CPU/GPU: zamierzona wspólna semantyka generatora; kwalifikacja obu realizacji
pozostaje **NOT VERIFIED**. FDM CPU/GPU: nie dotyczy siatki Gmsh. Wymagane są
regresje scope/precedence/lower-only/hscale, rzeczywisty rozkład rozmiarów elementów
oraz managed meshing evidence. Zielony parser dokumentacji nie zamyka tych bramek.

(thin-film-scoped-layer-realization)=
### Scoped fields i exact layers — realizacja GEO

Dla exact-cell Box z geometrycznym airboxem scoped pola muszą zostać
skomponowane po utworzeniu dokładnych objętości właściciela. Dotychczasowa
triangulacja jednej ściany źródłowej airboxu, ekstruzowana przez wszystkie
warstwy, ignorowała te pola przed powstaniem body tags. Projekcja regionalnego
minimum na tę ścianę rozszerzałaby jego zakres na powietrze i inne wysokości.

Nowa trasa tworzy najpierw niesiatkowane objętości GEO w zadanych przedziałach
z, następnie wiąże body/air tags, nakłada tę samą kompozycję upper/lower i
uruchamia meshing3D. Nie nadaje nowego znaczenia `through_thickness_elements`:
wynik musi przejść istniejący exact count, wszystkie węzły magnetyczne muszą
leżeć na dokładnie zadanych płaszczyznach, każda warstwa musi być niepusta,
a żaden tetraedr magnetyczny nie może przecinać wewnętrznej płaszczyzny.
Dodatkowe poziomy z są błędem, nie dopuszczoną przybliżoną realizacją.
Każdy zadany przedział GEO ma jawnie jedną warstwę ekstrudowania
(`numElements=[1]`, znormalizowane `heights=[1.0]`, `recombine=True`).
Dotyczy to także trasy scoped, lecz meshed extrusion nadal replikuje jedną
triangulację źródłowego capu airboxu. Samo odłożenie meshingu do czasu owner tags
nie realizuje lokalnego pola 3D wewnątrz filmu, którego zakres nie obejmuje capu.
Źródła zachowują definicję regionalną, ale geometria nie zapewnia jej realizacji.
Actual density gate pozostaje **FAILED** w GHA 37911565494/job113757705367.
Regresja test_direct_layered_box_region_floor_beats_eligible_upper_actual_density
zwróciła 108 tetraedrów i 45 węzłów dla dwóch warstw na dokładnych płaszczyznach
$-10,0,+10\,\mathrm{nm}$, po 15 węzłów na płaszczyznę. W cylindrycznym ROI
promienia $15\,\mathrm{nm}$ i półwysokości $4\,\mathrm{nm}$ nie było żadnego
środka krawędzi; najbliższy miał $z=5\,\mathrm{nm}$, czyli leżał $1\,\mathrm{nm}$
poza zakresem regionalnym. Poprawne exact layer planes nie dowodzą lokalnego
zagęszczenia.

W GHA wszystkie pięć pól scoped ma status `applied`, lecz pole nie realizuje
lokalnej topologii w ROI. Źródła wskazują na meshed extrusion z jedną warstwą
na przedział: kopiuje triangulację początkowej ściany airboxu, położonej poza
skończonym ROI. Jest to zgodne z jednakową liczbą węzłów na płaszczyznach
w wyniku CI; komentarz producenta opisuje to ograniczenie wprost.

Nie wystarcza rozszerzenie `SurfacesList`: `Restrict` i `Constant` obejmują
granice owner-volumes przy domyślnym `IncludeBoundary=1`, zgodnie z
[manualem Gmsh](https://gmsh.info/doc/texinfo/gmsh.html#Gmsh-mesh-size-fields).
Odrzucono także swobodne tetrahedralizowanie bez parametrów meshed extrusion,
ponieważ mogłoby wprowadzić węzły poza zadanymi płaszczyznami i naruszyć
istniejący guard oraz regresję exact-plane.

Naprawa musi umożliwić konformne przejście między lokalnymi triangulacjami
przekrojów, przy węzłach wyłącznie na istniejących płaszczyznach. Potrzebuje
zgodnej aktualizacji incydentnych tet4, faset, interfejsów właścicieli i PBC
oraz zachowania pointwise upper/lower bounds. Projekcja jednego pola przez
całą grubość, rozszerzenie ROI, nowe poziomy z i poluzowanie progów nie są
naprawą tego kontraktu. Działająca realizacja tej metody pozostaje do
zaimplementowania; runtime oraz świeża actualGmsh regresja są **NOT VERIFIED**.
Regresja gęstości cienkiej warstwy klasyfikuje próbki według środków krawędzi
w zadanym regionie, mierząc pełne długości tych krawędzi; centroid tetraedru
może leżeć poza regionem przecinającym środkową płaszczyznę warstwy.
Próbka pusta nadal jest błędem, a progi median pozostają bez zmiany.
Negatywna geometria testowa zachowuje 40 nm krawędź przecinającą region i nie
przycina jej do dopuszczalnych 12 nm; powietrze jest wyłączone z pomiaru.
Ten pomiar median nie stanowi gwarancji jakości każdej krawędzi ani kwalifikacji
solvera. Regresja free-tet zachowuje wcześniejszą klasyfikację centroidową.

Raport rozróżnia plan od wyniku. Przed meshingiem oraz po błędzie nie wolno
emitować potwierdzenia `layer_planes_realized`. Dowód powstaje dopiero po
walidacji `MeshData`, jest unieważniany przy następnej próbie i nie trafia jako
prywatny token do serializowanych metadanych. Brak exact-cell/geometric route
wymaga jawnej odmowy; nie wprowadza cichego free-tet fallbacku bez warstw.

Owner pozostaje `_generate_coincident_ring_airbox_mesh` w `_gmsh_swept.py`.
Source review/AST PASS; świeże actualGmsh density/plane/periodicity CI oraz
managed runtime pozostają **NOT VERIFIED**. Model regresji i threshold12nm
nie zostały zmienione. Jest to metoda wspólnego mesha FEM CPU/GPU; solver GPU
wymaga oddzielnej kwalifikacji. Nie zmienia równań ani FDM CPU/GPU.

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

Scoped layer-plane producer uses Gmsh `Constant` and `Restrict` fields on
exact owner volumes. `VolumesList`, `SurfacesList`, and the default
`IncludeBoundary=1` are defined in the [official Gmsh reference manual](https://gmsh.info/doc/texinfo/gmsh.html).
That API contract does not override the current meshed-extrusion topology or
prove that the final mesh satisfies the ROI density gate; only hosted
actual-Gmsh evidence can qualify a transition implementation.

(thin-film-mesh-scientific-bibliography)=
## Scientific bibliography

- P. Monk, *Finite Element Methods for Maxwell's Equations*, 2003.
- Gmsh reference manual, transfinite and extrusion meshing.
- [Gmsh reference manual, mesh size fields](https://gmsh.info/doc/texinfo/gmsh.html).

(thin-film-mesh-source-code-index)=
## Source-code index

| Warstwa | Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/world.py` | `class GeometryMeshHandle` | publiczny thin-film contract |
| Sweep | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `generate_swept_box_mesh` | ograniczona mixed-P1 realizacja box |
| Layered GEO producer | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` | `_generate_coincident_ring_airbox_mesh` | meshed extrusion replikuje źródłową triangulację; conforming scoped in-plane transition pozostaje do implementacji |
| Tetra fields | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_build_field_stack` | strefy surface/edge/corner/air |
| Scoped field composition | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `_configure_mesh_size_fields` | składa upper/lower pola; ich lokalna ewaluacja w layered GEO wymaga dalszej diagnostyki |
| Owner binding | `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` | `_geometry_owner_alias_index` | exact-name-first roster, jednoznaczne aliasy i izolacja polityk obiektów |
| Actual density regression | `packages/fullmag-py/tests/test_meshing.py` | `test_direct_layered_box_region_floor_beats_eligible_upper_actual_density` | rzeczywisty ROI/bulk density i dokładne planes; wynik GHA oczekiwany po poprawce |
| Quality | `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py` | `_extract_quality_metrics` | bieżące metryki Gmsh |


(thin-film-periodic-tetrahedral-layer-realization)=
## Warstwowa triangulacja periodyczna — korekta realizacji

Dla ograniczonego przypadku Box lub Box minus współosiowy Cylinder, z airboxem
współbieżnym bocznie, GEO generuje pomocnicze pryzmaty z zadaną liczbą warstw.
Jedna reguła podziału obejmuje wszystkie magnetic i air volumes oraz ich ściany:
trzy wierzchołki dolnej podstawy porządkuje się leksykograficznie po współrzędnych
w płaszczyźnie filmu, a górne odpowiadają im po przesunięciu wzdłuż z.
Pryzmat o podstawie a,b,c i górze A,B,C dzieli się na tetraedry
(a,b,c,C), (a,b,B,C), (a,A,B,C). Wspólna pionowa ściana między a i b ma
przekątną a–B. Ten sam wybór stosuje się do powierzchni zapisanej w Gmsh.
Kolejność lokalna komórki nie steruje wyborem przekątnej. Orientacja tetraedrów
jest dodatnia; zerowy wyznacznik jest błędem.

Reguła nie dodaje węzłów i zachowuje płaszczyzny warstw oraz regiony.
Współrzędne bliskie w granicach błędu maszynowego klasyfikuje się do wspólnych
rang osi; tolerancja służy wyłącznie deterministycznemu porządkowaniu geometrii,
nie akceptacji błędnego certyfikatu. Dla par osiowych translacja nie zmienia
kolejności końców krawędzi, więc nie zmienia przekątnej. Inne rodziny komórek,
podstawy niepoziome i sweep inny niż z nie należą do tej realizacji.

Owner: `packages/fullmag-py/src/fullmag/meshing/_gmsh_layered_tetrahedra.py::
subdivide_layered_prisms`; caller `_generate_coincident_ring_airbox_mesh`.
Publiczne Python/ProblemIR nie zmieniają semantyki: końcowy mesh nadal jest
tet4/tri3 z exact layers. FEM CPU i FEM GPU konsumują tę samą topologię;
nie jest to dowód wykonania GPU. FDM CPU/GPU: nie dotyczy.

Regresja `test_layered_periodic_triangles_are_conforming` wymaga certyfikatu
par obu osi, zgodności facet–cell, objętości, dodatnich wyznaczników i dokładnych
płaszczyzn dla 3/6/9 warstw Box oraz 1/2/3 warstw filmu z otworem (obecny limit ring). Status przed poprawką: RED,
niepełna bijekcja x_faces. Po poprawce: 31 lekkich testów PASS (26 integracyjnych i 5 podziału); nie jest to
kwalifikacja runtime. Granicę zewnętrzną wybiera się z brzegu połączonych volumes,
co usuwa interfejsy magnetic–air z Gamma_out. Każdy facet interfejsu musi mieć
incydencję dwóch komórek, a każdy facet exterior/periodic jedną. Jednowłaścicielskie
ściany komórek muszą dokładnie pokrywać exterior/periodic facets; brak takiej
równości oznacza szczelinę lub błędną klasyfikację. Status managed runtime i Rust v6: NOT VERIFIED;
nie wolno utożsamiać lekkiej kontroli Gmsh z wynikiem eigensolve.

### Konwersja objętości raportu ring do SI

Trasy ring używają współrzędnych Gmsh powiększonych przez S=10^6 względem
metrów. Przy publikacji węzłów x_SI=x_Gmsh/S raportowane objętości wymagają
V_SI=V_Gmsh/S^3 (m³). Dotyczy to minimum, maksimum, średniej, odchylenia
standardowego oraz element_volume, globalnie i per-domain. SICN, gamma,
histogramy, quality_source, tagi i kolejność elementów nie zmieniają się.
Konwersja dotyczy dwóch tras ring; cylinder obliczający jakość już z węzłów SI
nie podlega ponownej konwersji. Bramki: raport syntetyczny bez mutacji wejścia,
zgodność ring z objętościami końcowych węzłów SI oraz kontrola cylinder.
Zmiana jest korektą jednostek metadanych, nie warstw, fizyki ani progów jakości.


### Certyfikat periodyczny końcowej reprezentacji SI

Fingerprint certyfikatu v6 obejmuje bajty współrzędnych, facetów i markerów.
Po konwersji ring z mikrometrów do metrów nie wolno zachować certyfikatu
sprzed skalowania. `_recertify_scaled_periodic_mesh` ponownie sprawdza
bijekcję węzłów i ścian, przeciwne normalne oraz domknięcie narożników na
końcowym MeshData, używając przeskalowanych translacji i tolerancji SI.
MeshData jest niezmienny: helper tworzy kandydata bez starego certyfikatu,
a po sukcesie zwraca nowy obiekt z certyfikatem SI. Wejście pozostaje niezmienione.
Błąd certyfikacji zatrzymuje publikację; sama podmiana fingerprintu nie wystarcza.
Dotyczy obu tras ring, wspólnych dla FEM CPU/GPU; FDM nie dotyczy.
Nie zmienia geometrii ani tolerancji. Regresja syntetyczna porównuje certyfikat
z niezależnym przeliczeniem na SI i wymaga odrzucenia błędnej translacji.
Aktualny status wykonania tej regresji i integracji Gmsh: NOT VERIFIED.


(thin-film-canonical-owner-precedence)=
## Kanoniczny właściciel i precedence parametrów siatki

Roster całej sceny rozróżnia nazwy `left` oraz `left_geom` także podczas
budowania pojedynczego obiektu. Dokładna nazwa po usunięciu zewnętrznych spacji
ma pierwszeństwo przed historycznym aliasem; alias można użyć tylko przy jednym
właścicielu. Nieznana lub niejednoznaczna aktywna polityka jest błędem, a polityka
znanego innego obiektu nie wpływa na bieżącą siatkę.

Recepta wybierana jest jako całość: docelowy rozmiar i dolna granica nie mogą
pochodzić z różnych wpisów aliasów. Precedence górnego celu to recepta obiektu,
polityka per-geometry, workflow default, a następnie domyślny FEM target.
Pierwszy wpis powtarzanej polityki per-geometry zachowuje pierwszeństwo.
Wybór grubszej recepty musi usunąć zastępowane, generowane pola workflow
tego właściciela przed ich przekazaniem do Gmsh; sam większy scalar target nie
wystarcza, ponieważ minimum pól zachowałoby drobniejszy cel. Jawne manual
hotspots i polityki regionów pozostają oddzielnymi ograniczeniami.

Zmiana dotyczy wspólnego przygotowania siatki FEM CPU i FEM GPU; nie zmienia
fizyki ani nie dowodzi wykonania solvera GPU. FDM CPU/GPU nie korzystają z tego
kontraktu siatki tetraedralnej. Namespace cache v9 zapobiega ponownemu użyciu
siatek utworzonych przy starszym rozstrzyganiu aliasów. Nie usuwa starych danych.

Kotwice: `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py` +
`_geometry_owner_alias_index`, `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
+ `_build_field_stack`, oraz `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
+ `realize_fem_mesh_asset`. Regresja przechodzi rzeczywisty builder i realizer,
kontrolując przekazane cele i pola z mockiem wyłącznie granicy generowania
siatki. Aktualny wynik hosted CI, rzeczywista gęstość siatki i kwalifikacja
fizyczna tej poprawki: **NOT VERIFIED**.
