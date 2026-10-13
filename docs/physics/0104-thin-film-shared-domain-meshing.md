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
| $T$ | tetrahedron in the retriangulation cavity | $1$ |
| $Q_T$ | squared determinant/max-edge-cubed quality indicator | $1$ |
| $D_T$ | positive tetrahedron orientation determinant | $\mathrm{m}^3$ |
| $L_T$ | longest tetrahedron edge | $\mathrm{m}$ |

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

Bieżąca trasa tworzy podziały GEO w zadanych przedziałach z, wiąże body/air
tags i nakłada kompozycję upper/lower przed meshing3D. Parametry ekstruzji
jednocześnie definiują kopiowanie siatki capu; nie jest to niezależne
siatkowanie wnętrza każdej objętości. Nie nadaje nowego znaczenia `through_thickness_elements`:
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
Actual density gate pozostaje **FAILED**: w badanym regionie nie ma żadnych
próbek midpoint. Poprawne exact layer planes nie dowodzą lokalnego zagęszczenia.
Naprawa musi triangulować przekroje w rzeczywistych współrzędnych i owner scopes
oraz łączyć zgodnie warstwy bez nowych poziomów z. Przeniesienie lub projekcja
jednej siatki przez powietrze, rozszerzenie ROI i poluzowanie progów nie stanowią
naprawy. Obecny geometry admission jest szerszy niż potwierdzona realizacja;
pełna obsługa tej kombinacji pozostaje zadaniem otwartym.
Pomijanie parametrów warstwy pozwalało Gmsh dodać poziomy z i kończyło się
odmową exact-count. Poprawka zachowuje bramki liczby płaszczyzn i gęstości;
jej świeża regresja actualGmsh pozostaje **NOT VERIFIED** do wykonania w CI.

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

(thin-film-variable-section-conforming-insertion)=
### Zmienne przekroje — wewnętrzny kernel zgodnego wstawiania węzłów

Wewnętrzny kernel naprawy otrzymuje istniejące węzły SI na zadanych
płaszczyznach z i prostokątne granice XY. Każdy przekrój musi zawierać cztery
narożniki. Początkowy zgodny podział prostokątnych slabów jest następnie
zagęszczany przez wstawianie pozostałych punktów w porządku geometrii.
Dla punktu wewnątrz fasety dzielona jest ta faseta oraz oba przyległe
tetraedry; dla punktu na krawędzi dzielone są wszystkie tetraedry zawierające
tę krawędź. Wspólny interfejs zmienia się w jednej operacji topologicznej,
a nie jako dwa niezależne wyniki triangulacji. Punkty nie są dodawane ani
przesuwane i żaden tetraedr nie może przekraczać zadanego slabu.

Klasyfikacja położenia i orientacja mają używać dokładnych predykatów dla
liczb zapisanych w float64. Nie wolno wykorzystać tolerancji do zakrycia
szczeliny, usunąć zerowych komórek ani rozszerzyć zakresu regionalnego pola.
Wymagane kontrole końcowe: użycie wszystkich węzłów, dodatnia orientacja,
zgodność objętości, incydencja faset 1/2, zgodność shared caps i brak
zewnętrznych faset we wnętrzu Boxa. Brak narożnika, duplikat, węzeł poza
płaszczyznami lub granicami powoduje odmowę.

To **zaimplementowany wewnętrzny prototyp, nie trasa produkcyjna**. Python DSL,
ProblemIR i requested/resolved intent nie zmieniają się. FEM CPU/GPU nadal
wymagają właściwego producenta mesha i osobnych dowodów runtime; FDM CPU/GPU
nie dotyczą tej topologii. Sama zgodność topologii nie dowodzi jakości
komórek, PBC, realizacji dolnych/górnych ograniczeń pól ani poprawności
wyników eigensolve. Następne kroki muszą połączyć rzeczywiste przekroje
Gmsh, owner scopes, magnetic-air markers i certyfikat periodyczny.

Diagnostyka odrzuconej alternatywy: niezależne Delaunay na dwóch slabach
przy różnej gęstości wspólnej płaszczyzny dało zerowe tetraedry oraz
różne podziały capu. Nie zastosowano perturbacji QJ ani filtrowania komórek.
Wynik uzasadnia zmianę algorytmu; nie jest dowodem nowego kernela.

Owner: `packages/fullmag-py/src/fullmag/meshing/_layered_box_tetrahedralization.py::tetrahedralize_layered_box`.
Regresje `LayeredBoxTetrahedralizationTests`: **7 PASS, 13 subtests PASS**
w interpretowanym pytest. Obejmują coarse/fine/coarse z niepustym ROI,
cztery płaszczyzny, inserty na brzegu i przekątnej, permutację, dokładną
translację binarną oraz rzeczywiste dziesiętne współrzędne SI. Zespolone
współrzędne są odrzucane, zamiast cichego usunięcia części urojonej.
Dokładne centrowanie i wspólna dodatnia skala są wykonywane w arytmetyce
wymiernej; nie zmieniają proporcji geometrycznych ani wejściowych węzłów.
Każde wstawienie przegląda bieżącą topologię. Koszt dokładnej arytmetyki
oraz pełnych przeglądów ogranicza prototyp do małych przypadków; nie jest
to kwalifikowany algorytm wydajnościowy dla dużych meshy.
Regional-density actual Gmsh i managed eigensolve pozostają **OPEN**.

Actual-Gmsh4.15.2 fixture porównuje tę samą geometrię120×80×20nm,
trzy capy z=−10,0,+10nm i owner-scoped Box z target3nm w centralnym ROI
oraz20nm poza nim. Meshed extrusion (`numElements=[1]`, `recombine=True`)
dało43/43/43 węzły oraz3/3/3 węzły ROI; geometry-only extrusion bez tych
ograniczeń dało43/56/43 oraz3/11/3. W obu przypadkach potwierdzono wspólny
cap i Restrict z tymi samymi volume owners, IncludeBoundary=1 i z-planes.
To izoluje kopiowanie cap mesh przez meshed extrusion; nie dowodzi jeszcze
jakości tetów ani produkcyjnej realizacji wszystkich pól3D. W małym fixture
rzeczywiste142 węzły SI przekazane bez przesunięć do kernela dały404tets,
90 zgodnych faset middlecap i51tetcentroidów w ROI. Zgodność topologiczna
nie zastępuje jakości: minimalny determinant3.6786e-35m³ wymaga pomiaru
bezwymiarowego i ewentualnej naprawy elementów przed routingiem FEM.
Obserwacyjny pomiar tego fixture daje minimum det/max_edge³≈1.22e−14
oraz minimum per-vertex det/(iloczyn trzech krawędzi)≈3.10e−14. Najgorsze
trójki węzłów capu leżą około1e−19m od linii prostej. Jest to poważne
ryzyko sliverów i uwarunkowania operatora; nie wprowadzono arbitralnego
progu akceptacji. Te metryki nie są SICN ani gamma Gmsh i nie wolno
utożsamiać ich z bramką certyfikatu mixed-topology. Wzorzec naprawy
ma generować2D na geometrycznych capach, a exact slab volume realizować
kernelem. Nie wolno podmienić tej ścieżki na niekontrolowane generate(3).

Wewnętrzny adapter prototypowy przekazuje wynik kernela do istniejącego
kanonicznego `MeshData`, bez nowego formatu publicznego. Magnetic bounds
muszą być dwoma istniejącymi płaszczyznami; klasyfikacja markerów magnetic=1
oraz air=2 opiera się na pełnym zawieraniu slabu, nie tolerowanym centroidzie.
Fasety są wyprowadzone z incydencji rzeczywistych tetraedrów: zewnętrzne
mają orientację na zewnątrz, magnetic-air marker10 i normalną od magnetic
do air. Wewnętrzne fasety tego samego materiału nie są granicą fizyczną.

Dla par osiowych x/y wymagane jest bijektywne pokrycie wszystkich węzłów
przeciwległych boków oraz zgodność kompletnych zbiorów trójkątów po mapowaniu.
Translacja ma odpowiadać szerokości Boxa; wejściowe tolerancje SI nie są
rozszerzane. Samo równe liczenie węzłów nie jest dowodem zgodności. Adapter
nie może wytwarzać zaakceptowanego certyfikatu periodycznego, raportu jakości
ani realization proof bez odrębnego producenta i sprawdzonych bramek.
Adapter ma14 interpretowanych regresji PASS: objętości regionów, orientacja
interfejsów, kompletne pary węzłów/faset, jednoczesne x/y i odmowy błędnych
wejść. Nie wymyśla podziału air na near/far: cell_mesh_parts pozostaje puste.
Routing produkcyjny, jakość, pełne owner fields i Floquet nadal OPEN.

(thin-film-cap-quality-retriangulation)=
### Naprawa jakości przez zgodne zmiany przekątnych capów

Zaimplementowana realizacja wewnętrznego kernela może zmienić przekątną dwóch
sąsiednich trójkątów jednego capu tylko dla ściśle wypukłego czworokąta.
W każdym przyległym slabie oba tetraedry muszą mieć ten sam przeciwległy
wierzchołek. Dla interfejsu wewnętrznego operacja obejmuje jednocześnie oba
slaby; dla zewnętrznego capu jeden slab. Nie zmienia współrzędnych ani zbioru
węzłów, nie dodaje płaszczyzn i nie naprawia danych przez tolerancję.

Kandydat musi mieć dokładnie tę samą objętość cavity oraz identyczną granicę
poza retriangulowanym capem. Wymagane są dodatnie dokładne orientacje,
zachowanie wszystkich wierzchołków cavity i brak duplikatów komórek.
Wewnętrzny cap musi pozostać współdzielony przez oba slaby.

Do wyboru korzystnej zmiany służy bezwymiarowy wskaźnik geometrii:

```{math}
:label: eq-thin-film-cap-flip-quality
Q_T = \frac{D_T^2}{L_T^6}.
```

Symbole i jednostki definiuje kanoniczna tabela „Symbols and SI units”.

Współrzędne mogą być wycentrowane i izotropowo przeskalowane bez zmiany
$Q_T$. Kwadraty długości i wyznaczniki mają być porównywane dokładną
arytmetyką wymierną dla reprezentowanych float64. Posortowany rosnąco wektor
$Q_T$ nowej cavity musi być leksykograficznie większy od starego. Liczba
komórek pozostaje stała; ścisły wzrost wyklucza cykle. Kolejność kandydatów
ma wynikać z geometrii, a nie kolejności wejściowych node IDs.

Nie jest to próg akceptacji ani zamiennik SICN/gamma z istniejącej polityki
jakości. Niewspierane cavities pozostają niezmienione; brak legalnej poprawy
nie daje zgody na routing do FEM. Status: **wewnętrzny prototyp; produkcyjna jakość i runtime OPEN**.
Kernel oraz adapter mają24 regresje PASS/13subtests, w tym wspólny cap,
niezmienione węzły/objętość, pełne fasety x/y i odmowę częściowej naprawy
przy różnych apexach po drugiej stronie interfejsu. Actual-Gmsh probe:
2PASS/19.29s;142 węzły,404 tetraedry,90 middle cap faces,40 ROI centroidów,
minimum det/max_edge³2.088095e-4, minimum per-vertex det/product-edge-norms
4.440676e-4, relative volume error4.90e-16. Żaden próg produkcyjny nie został
zastosowany ani osłabiony. Te metryki nie są SICN/gamma.

Kernel kosztował15.08s wobec około0.64s przed optymalizacją dla tego samego
małego przypadku. Exact rescans/restarts pozostają prototypem; potrzebna
jest kontrola kosztu na większych siatkach, poprawa pozostałych komórek oraz
właściwa bramka jakości i lower/upper fields przed production routing.
Wymagany pozostaje późniejszy managed runtime, a nie tylko probe Python.

Redukcja kosztu zachowuje identyczną kolejność zaakceptowanych zmian
i końcową connectivity. Cache może obejmować tylko wyniki zależne od
niezmiennych węzłów: orientację uporządkowanej komórki, wypukłość danego
czworokąta i rangi geometrii. Nie wolno zapamiętywać jako stałej odmowy
zależnej od aktualnych ownerów, istnienia faset/przekątnych lub duplikatów.
Przejście z porównań współrzędnych na ich porządkowe rangi musi zachować
pierwotny porządek; oczekiwany dowód to identyczny wynik zapisanej
142-node fixture oraz dotychczasowe inwarianty. Zapisana fixture142/404 dała identyczną tablicę połączeń (`np.array_equal`).
W pojedynczej parze pomiarów NPZ koszt zmalał z17.779s do4.418s; ponowny
actual-Gmsh probe2PASS/8.58s zmierzył kernel4.216s przy tych samych metrykach
jakości i coverage. Focused24PASS/13subtests oraz odrębna regresja cache1PASS
potwierdzają zachowanie signed/zero orientations; cache nie utożsamia
permutacji o przeciwnym znaku. To pomiar małej fixture, nie kwalifikacja
dużych siatek. Zużycia pamięci cache nie zmierzono; cache jest lokalny dla
jednego wywołania i rośnie z liczbą unikalnych odwiedzanych krotek.

Owner: `_layered_box_tetrahedralization.py::tetrahedralize_layered_box`.
FEM CPU/GPU konsumują tę samą geometrię, ale wymagają oddzielnego runtime
proof; FDM CPU/GPU nie dotyczą tej realizacji.

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
| Cache predykatów | `packages/fullmag-py/src/fullmag/meshing/_layered_box_tetrahedralization.py` | `_cached_orient3d` | dokładny signed cache dla niezmiennych nodes; order/sign regression PASS |
| Adapter cap → MeshData | `packages/fullmag-py/src/fullmag/meshing/_layered_box_mesh_data.py` | `build_layered_box_mesh_data` | prototyp;14 regresji, brak production routing/quality/certificate |
| Zmienne przekroje | `packages/fullmag-py/src/fullmag/meshing/_layered_box_tetrahedralization.py` | `tetrahedralize_layered_box` | dokładny prototyp zgodnej topologii; brak production routing |
| Regresja kernela | `packages/fullmag-py/tests/test_layered_box_tetrahedralization.py` | `LayeredBoxTetrahedralizationTests` | 10 PASS, 13 subtests; kompletne source PBC, production quality/runtime OPEN |
| Actual cap sampling | `packages/fullmag-py/tests/test_layered_cap_field_sampling.py` | `TestLayeredCapFieldSampling` | porównanie mesh/geometry extrusion i rzeczywiste nodes→kernel; produkcja i quality OPEN |


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

Trasy ring używają bezwymiarowego współczynnika skali $S=10^6$ względem
metrów. Przy publikacji węzłów $x_{\mathrm{SI}}=x_{\mathrm{Gmsh}}/S$
raportowane objętości wymagają $V_{\mathrm{SI}}=V_{\mathrm{Gmsh}}/S^3$
z jednostką $\mathrm{m}^3$. Dotyczy to minimum, maksimum, średniej, odchylenia
standardowego oraz element_volume, globalnie i per-domain. SICN, gamma,
histogramy, quality_source, tagi i kolejność elementów nie zmieniają się.
Konwersja dotyczy dwóch tras ring; cylinder obliczający jakość już z węzłów SI
nie podlega ponownej konwersji. Bramki: raport syntetyczny bez mutacji wejścia,
zgodność ring z objętościami końcowych węzłów SI oraz kontrola cylinder.
Zmiana jest korektą jednostek metadanych, nie warstw, fizyki ani progów jakości.


Certyfikat periodyczny jest ponownie wyznaczany dla końcowych współrzędnych SI
przez `_recertify_scaled_periodic_mesh`, wywołujący
`_gmsh_extraction.py::certify_extracted_periodic_mesh`. `MeshData` jest
niemutowalny; zastępowanie certyfikatu tworzy nowy obiekt, a nie zmienia wejścia.
Certyfikat sprzed konwersji skali nie może być publikowany jako dowód dla
końcowego mesha. Aktualny managed runtime tej integracji: **NOT VERIFIED**.
