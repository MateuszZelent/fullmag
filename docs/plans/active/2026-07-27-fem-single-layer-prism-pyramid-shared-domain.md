# Natywny FEM: jedna warstwa pryzmatów z przejściem piramidy–tetraedry — plan wdrożenia

> **Dla agentów wykonawczych:** przed implementacją użyj `executing-plans` albo
> `subagent-driven-development`, a dla każdej części fizycznej również
> `physics-publication`, `problem-ir-design`,
> `backend-golden-masterplan` i `fem-native-backend-architecture`.
> Zmiany Control Room wymagają właściwych umiejętności `frontend-v2-*`,
> `resource-first-api-check` oraz pełnych bramek frontendowych.

**Cel:** dostarczyć prawdziwy mieszany mesh FEM P1, w którym cienka warstwa
magnetyczna może mieć dokładnie jedną komórkę przez grubość i tylko dwie
płaszczyzny węzłów — dolną i górną — przy zachowaniu konformalnego airboxu
Poissona, ścisłych ścieżek CPU/GPU i pełnej widoczności w Pythonie, ProblemIR,
provenance, API oraz Control Room.

**Architektura:** Gmsh tworzy `prism6` w warstwie magnetycznej, `pyramid5`
wyłącznie w powietrznej strefie przejściowej przy czworokątnych ścianach
bocznych oraz `tet4` w pozostałej części airboxu. Fullmag nie rozcina tych
elementów do tetraedrów. Typowana, mieszana topologia przechodzi bez utraty
informacji przez Python, ProblemIR, planner, runner, C ABI, MFEM, binarny data
plane i viewport. Każdy solver lub rodzaj fizyki, który nie został
zakwalifikowany dla mixed P1, odrzuca plan przed uruchomieniem.

**Stos:** Python DSL, Gmsh 4.15.x, NumPy, Rust/Serde, C ABI, MFEM 4.8,
hypre/CUDA, OpenAPI v2, React/TypeScript/Three.js, pytest/Cargo/CMake/managed
`just`.

**Data analizy:** 2026-07-27.

**Stan dokumentu:** plan implementacyjny; nie jest dowodem produkcyjnego
wsparcia mixed FEM.

---

## 1. Decyzja w skrócie

### 1.1 Odpowiedź techniczna

Gmsh potrafi utworzyć dokładnie potrzebną klasę siatki. Oficjalna dokumentacja
Gmsh 4.15.2 podaje, że:

- ekstruzja powierzchni z warstwami i rekombinacją tworzy pryzmaty,
  heksaedry lub piramidy;
- nieustrukturyzowany mesher 3D tworzy tetraedry oraz piramidy, gdy siatka
  brzegowa zawiera czworokąty;
- `QuadTriNoNewVerts` i `QuadTriAddVerts` służą do konformalnego połączenia
  ekstruzji o ścianach czworokątnych z domeną tetraedryczną.

Źródło: [Gmsh 4.15.2 Reference Manual](https://gmsh.info/doc/texinfo/gmsh.html).

MFEM 4.8 również ma natywne elementy i konstruktory:
`Mesh::AddWedge`, `Mesh::AddPyramid`, `Mesh::AddTet` oraz `Mesh::AddBdrQuad`.
Nie ma więc blokady w bibliotekach bazowych:
[MFEM Mesh API](https://docs.mfem.org/4.8/classmfem_1_1Mesh.html) i
[MFEM Geometry API](https://docs.mfem.org/4.8/classmfem_1_1Geometry.html).

Typed topology/transport jest już obecna end-to-end od authoringu do Control
Room: generator zachowuje `prism6`/`pyramid5`/`tet4`, importer, `MeshIR`,
runner i ABI używają typów, offsetów oraz connectivity, a FMMT v2 i viewport
przenoszą tę reprezentację. Nie jest to jednak wykonanie solvera: CPU/GPU
native operators pozostają tet4/tri3-only, a planner fail-closed odrzuca mixed
P1 przed startem backendu.

### 1.2 Lokalny proof-of-concept

W środowisku repozytorium potwierdzono Gmsh `4.15.2`. Minimalny,
jednostkowo przeskalowany model Box-in-Box z:

- trójkątną powierzchnią źródłową filmu,
- ekstruzją `numElements=[1]` i `recombine=True`,
- zewnętrzną domeną powietrzną z filmem jako konformalną wnęką,

wygenerował:

| Domena | Typ | Liczba w próbie |
|---|---|---:|
| film magnetyczny | `Prism 6` | 50 |
| powietrzna strefa przejściowa | `Pyramid 5` | 18 |
| dalszy airbox | `Tetrahedron 4` | 890 |

Film miał 70 węzłów i dokładnie dwa poziomy współrzędnej normalnej:
`[-0.05, 0.05]`. Górna i dolna powierzchnia filmu składały się z trójkątów,
a cztery powierzchnie boczne z czworokątów. Dokładne liczby elementów są
wynikiem tej zamrożonej próby, nie uniwersalną gwarancją Gmsh. Kontrakt
produkcyjny ma sprawdzać typy, konformalność, markery i dwie płaszczyzny, a
nie przypadkową liczbę tetraedrów airboxu.

### 1.3 Rekomendowana decyzja

Wdrożyć natywny mieszany kontrakt P1:

```text
magnes:       prism6
przejście:    pyramid5 w domenie air
daleki air:   tet4
fasety:       tri3 | quad4
```

Nie promować podziału pryzmatów do tetraedrów jako rozwiązania docelowego.
Taki podział może zachować dwie płaszczyzny węzłów, ale:

- nie jest prawdziwym meshem pryzmatycznym;
- mnoży liczbę elementów;
- wprowadza sztuczne przekątne i możliwą orientacyjną preferencję;
- nie usuwa stałych założeń tet4 z całego stosu;
- nie spełnia celu użytkownika dotyczącego natywnych prism/pyramid.

---

## 2. Precyzyjny kontrakt fizyczny i numeryczny

### 2.1 Co oznacza „jedna komórka przez grubość”

Dla liniowego pryzmatu `prism6`:

- `layers=1` oznacza jedną warstwę elementów;
- istnieją dokładnie dwie płaszczyzny węzłów: źródłowa i docelowa;
- każdy pryzmat ma trzy węzły dolne i trzy odpowiadające im węzły górne;
- nie wolno dodać węzła w połowie grubości filmu;
- magnetyzacja jest nadal pełnym polem 3D P1 i może różnić się między dolną
  a górną powierzchnią.

Jedna warstwa pryzmatów nie jest automatycznie modelem 2D ani
thickness-averaged. Jeżeli kiedyś potrzebne będzie wymuszenie identycznej
magnetyzacji na obu powierzchniach, będzie to osobny kontrakt ograniczeń,
nie własność meshu.

### 2.2 Zakres pierwszej produkcyjnej ścieżki

Pierwsza kwalifikowana ścieżka ma być celowo wąska:

- geometria magnetyczna: osiowo ustawiony `Box`;
- jedna ciągła warstwa magnetyczna;
- `order=1`;
- `topology="prismatic"`;
- `layers >= 1`, z podstawowym przypadkiem `layers=1`;
- shared-domain airbox;
- `poisson_robin` i `poisson_dirichlet`;
- jednorodny `Ms` i `Aex`;
- exchange, demag Poissona oraz jednorodne pole Zeemana;
- relaksacja `projected_gradient_bb`, `nonlinear_cg` i
  `llg_overdamped`;
- FEM CPU/double oraz FEM GPU/double;
- tryb `strict` bez cichego fallbacku.

Pierwsza promocja nie obejmuje:

- `fredkin_koehler` FEM/BEM;
- PBC/Floquet;
- DMI, STT/SOT, termiki, magnetoelastyki i regionalnych profili pola;
- DG0 materiałów i skokowych interfejsów materiałowych;
- high-order FEM;
- AFEM/remesh zachowującego warstwy;
- modal/eigen/frequency-response;
- wielu magnesów i multilayerów;
- dowolnych brył OCC.

Każdy z tych przypadków ma otrzymać jawne odrzucenie capability, nie
tetraedryczny fallback.

### 2.3 Kontrakt demagu

Demag Poissona nadal rozwiązuje skalarne `u` w całej konformalnej domenie
magnes + airbox:

```text
laplace(u) = div(Ms m)
H_demag = -grad(u)
```

Wymagania:

- `Ms m` jest niezerowe tylko w pryzmatach magnetycznych;
- piramidy i tetraedry transition/air mają marker powietrza;
- ciągłość potencjału wynika z jednego H1 space na wspólnych węzłach;
- warunek Robin/Dirichlet jest nakładany wyłącznie na prawdziwą zewnętrzną
  granicę airboxu;
- interfejs magnes–air nie może zostać potraktowany jako zewnętrzny boundary;
- RHS, recovery `H_demag` i energia używają kwadratury właściwej dla
  prism/pyramid/tet;
- żaden kod nie może używać `volume / 4` albo stałego czterowęzłowego
  gradientu dla pryzmatu lub piramidy.

---

## 3. Stan obecny i rzeczywiste luki

### 3.1 Python i Gmsh

| Obszar | Stan obecny | Konsekwencja |
|---|---|---|
| `GeometryMeshHandle.thin_film` / `.swept` | zachowują requested `topology="prismatic"`, exact layers i transition policy | publiczny request jest semantyczny; nie jest legalnym solver runem |
| `_gmsh_swept.py` i `_gmsh_airbox.py` | zachowują `prism6`/`pyramid5`/`tet4` i wiążą certyfikat | legacy tet conversion pozostaje poza strict mixed path |
| `_gmsh_types.py` | obsługuje `tet4`, `hex8`, `prism6`, `pyramid5` oraz `tri3`/`quad4` | higher-order pozostaje fail-closed |
| `MeshData` | używa typed variable-width connectivity | nie stanowi to dowodu operatorów native |
| shared-domain airbox | generuje conforming mixed mesh z certyfikatem | planner nie dopuszcza go do aktualnego solvera |

Fail-closed path z planu `MESH-FEM-001` nadal chroni unsupported higher-order
oraz nieznane families. Linear Gmsh types 6/7 są już częścią typowanej
implementacji; fail-closed execution ma odrzucać mixed P1 na capability gate,
nie usuwać go podczas importu.

### 3.2 ProblemIR, runner i ABI

- `MeshIR`, runner payload i Python bridge przenoszą canonical cell/facet
  types, offsets i connectivity; legacy tet4/tri3 normalizuje się na granicy.
- topology fingerprint obejmuje type, offset, connectivity, role i marker.
- `fullmag_fem_mesh_desc` oraz `native_fem.rs` przenoszą typed,
  variable-width descriptors do native core.
- Native core importuje tę topologię, ale aktualne MFEM CPU i GPU operator
  modules zatrzymują ją na tet4/tri3 gate.

### 3.3 Backend FEM

- `backends/fem/core/fem_mesh.cpp` waliduje typed connectivity i importuje
  mixed topology do native state, lecz wymusza tet4/tri3 przed uruchomieniem
  aktualnych physics modules.
- `backends/fem/cpu/mfem/runtime/mfem_context.cpp` wywołuje wyłącznie
  `AddTet` i `AddBdrTriangle`.
- exchange jest składany przez generyczne MFEM `DiffusionIntegrator` i
  `MassIntegrator`, więc po poprawnym zbudowaniu mixed MFEM mesh jest dobrym
  kandydatem do szybkiego wsparcia.
- CPU Poisson RHS już korzysta z FE shape functions i kwadratury MFEM.
- CPU recovery ma generyczny path kwadraturowy, ale specjalny tet fast path
  używa `Weight()/6` i `volume/4`.
- strict GPU Poisson builder w
  `backends/fem/gpu/cuda/demag_poisson/operators.cpp` wymaga czterech DOF,
  jednego gradientu i `volume/4`.
- DMI, STT, termika, regionalny Zeeman, FEM/BEM i część material runtime
  zawierają jawne założenia tetraedryczne.

### 3.4 API i Control Room

- FMMT v2 niesie types, offsets, connectivity i markery; FMMT v1 pozostaje
  readerem tetrahedral compatibility.
- `DecodedTopology`, viewport, indeksowanie, selection i mesh-size highlighting
  obsługują typed cells/facets; display triangulation nie zmienia topologii.
- Inspector pokazuje mixed-topology provenance i certificate. Widoczność tych
  danych nie oznacza legalności solver execution.

### 3.5 Aktualny kontrakt SP4

`docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md` i
`tests/standard_problems/mumag/sp4/fem/problem.py` świadomie używają dziś P1
tetra i nie wymuszają warstw, ponieważ obecna konformalna ścieżka tworzyła
patologiczne tetraedry. Po wdrożeniu mixed FEM ten zapis ma zostać
zaktualizowany dopiero po przejściu nowych bramek.

Lokalnie zmodyfikowany
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`
ma obecnie `layers=0`, co publiczne API odrzuca, oraz więcej niż jeden stage
`relax` z tym samym `stage_id`. Tego pliku nie wolno użyć jako dowodu meshu ani
runtime, dopóki użytkownik nie rozdzieli eksperymentów lub nie przywróci jednej
polityki relaksacji. Plan nie nadpisuje tej lokalnej pracy.

---

## 4. Rozważone warianty

### Wariant A — natywny mixed P1 (wybrany)

Zalety:

- spełnia cel dwóch płaszczyzn węzłów;
- zachowuje prawdziwe prism/pyramid;
- MFEM ma wymagane typy;
- exchange i operator Poissona mogą używać generycznej asemblaży;
- usuwa fałszywe obietnice UI;
- daje podstawę dla prawdziwych layered FEM meshes.

Koszt:

- migracja topologii przez wszystkie warstwy;
- jawne capability gates dla tetra-only kernels;
- nowy format binarny i rendering;
- pełna ponowna kwalifikacja demagu i SP4.

### Wariant B — prism/pyramid dzielone do tet4

Może zachować dwie płaszczyzny węzłów i byłby krótszy do wdrożenia, ale nie
spełnia celu „prawdziwego meshu”. Może pozostać tylko jako jawnie nazwany
compatibility converter do testów porównawczych; nie może być wynikiem
`topology="prismatic"`.

### Wariant C — osobny mesh filmu i niekonformalny airbox

Wymaga mortar/Nitsche/interpolation interface dla potencjału i magnetyzacji.
Jest znacznie większą zmianą fizyczną, komplikuje zachowanie energii i nie jest
potrzebny, skoro Gmsh potrafi utworzyć konformalny mixed mesh.

### Wariant D — 2.5D/thickness-averaged FEM

Zmniejszyłby DOF bardziej, ale zmienia przestrzeń aproksymacji i model demagu.
To odrębna funkcja fizyczna, nie implementacja żądanego meshu 3D.

---

## 5. Docelowy publiczny kontrakt

### 5.1 Python DSL

Zachować bieżące domyślne zachowanie tetraedryczne i dodać jawny wybór:

```python
film.mesh.thin_film(
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    order=1,
)
```

Zaawansowana forma ma obniżać się do tego samego modelu:

```python
film.mesh.swept(
    elements=1,
    distribution="fixed",
    face_meshing="triangular",
    transition="pyramid_to_tetrahedra",
    exact_layers=True,
)
```

Reguły:

- `layers` / `elements` to liczba warstw komórek, nie liczba płaszczyzn
  węzłów;
- `topology="prismatic"` implikuje triangular source mesh i `prism6`;
- `exact_layers=True` jest domyślne dla prismatic;
- w `strict` brak zgodnej realizacji zawsze kończy build błędem;
- fallback do tetra może istnieć tylko w `extended` i tylko po jawnym
  `exact_layers=False`; provenance zapisuje degradację;
- `layers < 1` pozostaje błędem;
- `order != 1` jest odrzucane w pierwszym zakresie;
- skrypt wyeksportowany z UI musi odtworzyć wszystkie wartości.

Nie zmieniać domyślnej semantyki `thin_film()` na prismatic przed kwalifikacją
SP4 i decyzją ADR.

### 5.2 ProblemIR — requested intent

Rozszerzyć `SweptMeshHintsIR`:

```rust
pub struct SweptMeshHintsIR {
    pub sweep_direction: String,
    pub distribution: SweepDistributionIR,
    pub element_family: String,      // prism | hex
    pub transition_policy: String,   // pyramid_to_tetrahedra | reject
    pub exact_layer_count: bool,
}
```

To są semantyki żądane. Rzeczywista topologia nie może być wywnioskowana z
samych hintów; musi pochodzić z meshu i build report.

### 5.3 Kanoniczna mieszana topologia

Nie używać tablic padded do ośmiu węzłów ani Gmsh type ID jako publicznego
kontraktu. Wprowadzić stabilne enumy Fullmag:

```text
FemCellTypeIR:  tet4 | prism6 | pyramid5 | hex8
FemFacetTypeIR: tri3 | quad4
FemFacetRoleIR: exterior | material_interface | periodic_seam
```

Kanoniczny in-memory layout:

```rust
pub struct FemConnectivityIR {
    pub types: Vec<FemCellTypeIR>,
    pub offsets: Vec<u32>,  // len = types.len() + 1
    pub nodes: Vec<u32>,
}

pub struct FemFacetConnectivityIR {
    pub types: Vec<FemFacetTypeIR>,
    pub roles: Vec<FemFacetRoleIR>,
    pub offsets: Vec<u32>,
    pub nodes: Vec<u32>,
}
```

Inwarianty:

- `offsets[0] == 0`;
- offsety są monotoniczne;
- ostatni offset równa się długości connectivity;
- różnica offsetów odpowiada arity typu;
- każdy indeks jest mniejszy od `node_count`;
- markerów jest zero albo dokładnie tyle co elementów/faset;
- element ma unikalne lokalne węzły;
- Jacobian jest dodatni we wszystkich wymaganych punktach kontrolnych;
- globalny ordinal elementu pozostaje stabilny dla markerów, jakości,
  selection i artifacts.

### 5.4 Migracja legacy tet4

Nie utrzymywać dwóch równorzędnych źródeł prawdy.

1. Warstwa wire/Serde akceptuje przez jedno okno migracyjne stare
   `elements: Vec<[u32;4]>` i `boundary_faces: Vec<[u32;3]>`.
2. Deserializacja natychmiast normalizuje je do kanonicznej topologii typed.
3. Wewnętrzny planner, runner i backend używają tylko typed topology.
4. Nowe writery emitują wyłącznie schema v2.
5. Legacy reader zostaje usunięty, gdy wszystkie repo fixtures/artifacts i
   managed runtime manifest używają v2; kryterium usunięcia to zero wyników
   `rg` dla konstrukcji legacy poza testem migracyjnym.

### 5.5 Certyfikat topologii warstwowej

Build report ma zawierać `mixed_layer_topology_certificate.v1`:

- requested/resolved sweep direction;
- requested/realized layer count;
- liczba i pozycje klastrów płaszczyzn węzłów magnetycznych;
- tolerancja klastrowania;
- liczby `tet4/prism6/pyramid5/hex8` per marker i mesh part;
- liczby `tri3/quad4` per role/marker;
- liczba niekonformalnych, osieroconych i non-manifold faces;
- min Jacobian/scaled Jacobian per family;
- objętość magnesu i względny błąd względem CAD;
- objętość airboxu i bilans shared-domain;
- marker coverage;
- `fallbacks_triggered=[]` dla strict;
- topology fingerprint v2;
- Gmsh version i użyta strategia.

Dla `layers=1` certyfikat jest `accepted` tylko wtedy, gdy:

- wszystkie magnetyczne volume cells są `prism6`;
- wszystkie magnetyczne węzły należą do dokładnie dwóch płaszczyzn;
- żaden `pyramid5` ani `tet4` nie ma magnetycznego markera;
- każda wewnętrzna faseta ma dokładnie dwóch właścicieli;
- dozwolone styki są zgodne geometrycznie:
  prism–prism, prism–tet po trójkącie, prism–pyramid po czworokącie,
  pyramid–tet po trójkącie oraz odpowiednie styki air–air;
- nie ma inverted/degenerate elements.

Tolerancje certyfikatu v1 są jawne i w jednostkach SI:

- klastrowanie płaszczyzn:
  `max(1e-15 m, 1e-8 * film_thickness)`;
- względny błąd objętości filmu i bilansu shared-domain: `<= 1e-8`;
- współdzielona faseta musi używać tych samych globalnych node IDs po obu
  stronach; dopasowanie samych współrzędnych nie wystarcza do certyfikacji;
- determinant Jacobianu musi być ściśle dodatni we wszystkich punktach
  reguły integracyjnej rzędu co najmniej 2;
- per-family fifth-percentile SICN ma być `>= 0.1`; jeśli Gmsh nie udostępnia
  prawdziwego SICN dla danego typu, Fullmag liczy i nazywa `scaled_jacobian`
  zamiast podszywać proxy pod SICN;
- każda zmiana tych progów wymaga aktualizacji physics note i świeżego
  convergence report, nie tylko zmiany testu.

---

## 6. Capability i fail-closed

Dodać jednoznaczne capability IDs:

```text
mesh.topology.mixed_p1
mesh.swept.prism
mesh.transition.pyramid_tet
mesh.exact_layer_count
fem.cpu.exchange_demag.mixed_p1
fem.gpu.exchange_demag.mixed_p1
```

Planner ma oceniać kombinację:

```text
topologia × urządzenie × precyzja × demag × interakcje × typ studium
```

Pierwsza macierz:

| Funkcja | CPU mixed P1 | GPU mixed P1 | Stan początkowy |
|---|---|---|---|
| exchange | tak po testach | tak po device proof | gated |
| Poisson Robin/Dirichlet | tak po manufactured tests | tak po device proof | gated |
| uniform Zeeman | tak | tak | gated |
| PG-BB / NCG / overdamped LLG | tak po SP4 | tak po SP4 | gated |
| FEM/BEM | nie | nie | reject |
| DMI/STT/thermal/magnetoelastic | nie | nie | reject |
| regional field projection | nie | nie | reject |
| periodic/Floquet | nie | nie | reject |
| eigen/frequency response | nie | nie | reject |
| DG0/material interfaces | nie | nie | reject |
| order > 1 | nie | nie | reject |

Rejection musi wystąpić przed startem backendu i zawierać:

- typy elementów obecne w meshu;
- brakujące capability;
- żądaną fizykę/device/precision;
- brak fallbacku;
- wskazanie, że `free_tetrahedral` jest alternatywną jawną konfiguracją,
  nie automatyczną degradacją.

---

## 7. Plan wdrożenia

### Etap 0 — decyzje kanoniczne i zamrożony Gmsh fixture

#### Zadanie 0.1 — publikacja fizyczna i ADR

**Pliki:**

- nowy `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`;
- nowy `docs/adr/0021-native-mixed-p1-fem-topology.md`;
- `docs/physics/0101-swept-mesh-through-thickness.md`;
- `docs/physics/0104-thin-film-shared-domain-meshing.md`;
- `docs/physics/0105-fem-meshing-production-acceptance.md`;
- `docs/physics/fem_demag_poisson.md`;
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`;
- `docs/specs/capability-matrix-v0.md`;
- `docs/architecture/backend-golden-masterplan.md`.

**Kroki:**

- opisać shape functions, kwadraturę, jednostki, założenia i limity;
- formalnie wybrać typed mixed topology zamiast tet conversion;
- zapisać początkową macierz capability;
- skorygować bieżące sformułowania sugerujące, że swept prism jest już
  solver-native;
- zachować bieżący status SP4 jako tetrahedral do końca kwalifikacji.

**Weryfikacja:**

```bash
python3 scripts/check_repo_consistency.py
```

**Wyjście:** zatwierdzone znaczenie `layers=1` i brak sprzeczności między
notami.

#### Zadanie 0.2 — reprodukowalny Gmsh feasibility fixture

**Pliki:**

- nowy
  `packages/fullmag-py/tests/fixtures/gmsh/mixed_prism_pyramid_airbox.geo`;
- nowy
  `packages/fullmag-py/tests/test_mixed_element_meshing.py`;
- `packages/fullmag-py/uv.lock` pozostaje bez zmiany, ponieważ już utrwala
  Gmsh 4.15.2; test ma dodatkowo zapisać wykrytą wersję w diagnostyce.

**RED:**

- fixture generuje film z jedną warstwą i airbox;
- test oczekuje `prism6` w filmie, `pyramid5` w air i `tet4` w air;
- test oczekuje dokładnie dwóch płaszczyzn węzłów filmu;
- test oczekuje quad lateral interfaces i tri top/bottom interfaces;
- test oczekuje braku duplicate/non-manifold faces.

**Implementacja fixture:**

- użyć Gmsh GEO `Extrude ... Layers{1}; Recombine;`;
- utrzymać wspólne surface entities filmu i wnęki airboxu;
- osobno zachować wariant dokumentujący `QuadTriAddVerts`;
- nie używać production `_split_prism_to_tets`.

**Weryfikacja:**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_mixed_element_meshing.py \
  -k gmsh_feasibility -vv
```

**Wyjście:** fixture udowadnia wykonalność generatora, ale nie promuje
runtime.

### Etap 1 — kanoniczna typed topology v2

#### Zadanie 1.1 — Python `MeshData` bez stałej arity

**Pliki:**

- `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_infra.py`;
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`;
- `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`;
- `packages/fullmag-py/src/fullmag/meshing/surface_assets.py`;
- `packages/fullmag-py/tests/test_meshing.py`;
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`.

**RED:**

- mixed connectivity waliduje poprawne arity;
- zły offset, typ, marker, indeks lub kolejność jest odrzucany;
- prism/pyramid z odwróconym Jacobianem jest odrzucany;
- legacy tet fixture normalizuje się do v2;
- zapis/odczyt zachowuje globalne ordinale.

**Implementacja:**

- zastąpić macierze `(M,4)` strukturą types/offsets/nodes;
- dodać iteratory i typed block views do wydajnych operacji NumPy;
- rozdzielić volume cells od named facets i ich ról;
- zdefiniować stabilne permutacje Gmsh → Fullmag dla type 4, 5, 6, 7
  oraz boundary type 2, 3;
- zachować fail-closed dla wyższych rzędów;
- dodać family-aware walidację Jacobianu i objętości;
- nie stosować tetra quality thresholds do prism/pyramid bez kalibracji;
- eksportować mixed VTK/VTU bez triangulowania naukowej topologii.

**Weryfikacja:**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py \
  packages/fullmag-py/tests/test_mixed_element_meshing.py -vv
```

#### Zadanie 1.2 — ProblemIR i Rust canonical model

**Pliki:**

- `crates/fullmag-ir/src/mesh_hints.rs`;
- `crates/fullmag-ir/src/mesh_assets.rs`;
- `crates/fullmag-ir/tests/ir_tests.rs`;
- `crates/fullmag-cli/src/python_bridge.rs`;
- `crates/fullmag-cli/src/step_utils.rs`;
- `crates/fullmag-plan/src/mesh.rs`;
- `crates/fullmag-plan/src/tests.rs`;
- `crates/fullmag-runner/src/types.rs`;
- `crates/fullmag-runner/src/artifacts.rs`;
- test fixtures konstruujące `MeshIR` w crates dotkniętych przez zmianę.

**RED:**

- serde round-trip mixed topology;
- legacy tet input → canonical v2;
- writer nie emituje dual truth;
- fingerprint zmienia się po zmianie typu, offsetu, connectivity, roli fasety
  lub markera;
- element reordering aktualizuje segmenty, markery i quality arrays razem;
- object/mesh part slicing zachowuje lokalne typy i globalne ID.

**Implementacja:**

- wprowadzić `FemCellTypeIR`, `FemFacetTypeIR`, `FemFacetRoleIR`;
- usunąć stałą arity z wewnętrznego `MeshIR`;
- napisać jeden normalizer legacy na granicy serde;
- zastąpić `update_hash_tets` fingerprintem
  `fullmag:fem-mesh-topology-fingerprint:v2`;
- zaktualizować periodic face identity tak, by klucz obejmował arity;
- nie certyfikować PBC dla mixed topology w pierwszym rolloutcie;
- zachować stabilny global element ordinal.

**Weryfikacja:**

```bash
cargo test -p fullmag-ir --lib --tests
cargo test -p fullmag-plan --lib
cargo test -p fullmag-runner --lib fem_mesh
cargo test -p fullmag-cli --lib python_bridge
```

Jeżeli Rust target jest niewritable, użyć
`CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target`.

#### Zadanie 1.3 — C ABI typed mesh

**Pliki:**

- `native/include/fullmag_fem.h`;
- `crates/fullmag-fem-sys/src/lib.rs`;
- `crates/fullmag-runner/src/native_fem.rs`;
- `backends/fem/core/fem_mesh.hpp`;
- `backends/fem/core/fem_mesh.cpp`;
- `backends/fem/tests/fem_mesh_contract.cpp`;
- test layoutu ABI w `crates/fullmag-fem-sys/src/lib.rs`.

**Implementacja:**

- dodać wersjonowane pola types/offsets/nodes dla komórek i faset;
- dodać długości każdego bufora;
- zwiększyć/fingerprintować wersję layoutu w managed runtime manifest;
- walidować wszystkie wskaźniki, długości, offsety i enum values;
- przechowywać typed topology w `FemMeshRuntimeState`;
- dodać generyczne face/edge tables per element family;
- usunąć z bazowego mesh core komunikaty i helpery mówiące wyłącznie o tet,
  pozostawiając tetra-only helpery tylko w gated physics modules.

Nie zmieniać layoutu C i Rust niezależnie. Jedna zmiana musi zawierać
compile-time size/offset assertions po obu stronach.

**Weryfikacja:**

```bash
cargo test -p fullmag-fem-sys --lib
just verify-fem-time-domain-native-contract
```

Druga komenda jest dowodem container-backed, pierwsza tylko szybką bramką
Rust.

### Etap 2 — produkcyjny generator Gmsh dla Box + airbox

#### Zadanie 2.1 — body-only prism mesh

**Pliki:**

- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_extraction.py`;
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`.

**RED:**

- Box `layers=1` daje wyłącznie prism6 i dwie płaszczyzny;
- `layers=2/3` daje odpowiednio 3/4 płaszczyzny;
- explicit x/y/z sweep działa zgodnie z osią;
- `order>1` i niewspierana geometria fail closed;
- Gmsh connectivity jest poprawnie permutowane do Fullmag.

**Implementacja:**

- meshować powierzchnię źródłową trójkątami;
- użyć `gmsh.model.geo.extrude(..., numElements, heights,
  recombine=True)`;
- zachować prism6, nie wywoływać split helperów;
- usunąć lub odłączyć `_split_prism_to_tets` od production path;
- emitować dokładny requested/resolved report.

#### Zadanie 2.2 — konformalny shared-domain airbox

**Pliki:**

- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`;
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`;
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`;
- `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`;
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`;
- `packages/fullmag-py/tests/meshing_production_fixtures.py`.

**Algorytm pierwszej wersji:**

1. Zbudować source face Boxa w dolnej płaszczyźnie.
2. Wykonać jednowarstwową ekstruzję do prism volume.
3. Użyć tych samych surface entities jako wewnętrznej granicy air volume.
4. Zbudować zewnętrzny box airboxu.
5. Meshować air volume nieustrukturyzowanym 3D mesherem.
6. Zaakceptować `pyramid5` tylko w markerze air i tylko przy quad interface.
7. Zaakceptować `tet4` w pozostałym air.
8. Zachować outer boundary marker i osobne role interfejsów.
9. Uruchomić certyfikat konformalności i exact layers.

Nie wykonywać po ekstruzji OCC fragment, jeżeli niszczy on structured extrusion
lub duplikuje powierzchnie. Dla pierwszego Box path priorytetem jest wspólna
topologia GEO. Dowolne OCC shapes pozostają odrzucone.

`QuadTriAddVerts` należy utrzymać jako kontrolowany wariant dla dedykowanej
transition shell lub przyszłych geometrii. Pierwsza ścieżka Python nie może
zależeć od nieudokumentowanej funkcji API; jeżeli potrzebna jest składnia GEO,
ma być generowana i parsowana jawnie, z testem wersji Gmsh.

**Airbox grading:**

- zachować `maximum_element_size`, `minimum_element_size`,
  `maximum_element_growth_rate` i `grading`;
- pola rozmiaru przy source/top/bottom/lateral interface muszą działać na
  wspólnych entities;
- nie dopuszczać, by 3 nm thickness wymuszała 3 nm w całym airboxie;
- report ma rozdzielić jakość magnetycznego prism layer, pyramid transition i
  far-air tet.

**Weryfikacja:**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_mixed_element_meshing.py \
  packages/fullmag-py/tests/test_meshing_fallbacks.py -vv
just verify-fem-meshing-production
```

### Etap 3 — DSL, authoring round-trip i planner

#### Zadanie 3.1 — publiczne API i script export

**Pliki:**

- `packages/fullmag-py/src/fullmag/world.py`;
- `packages/fullmag-py/src/fullmag/model/discretization.py`;
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`;
- `packages/fullmag-py/tests/test_script_builder_roundtrip.py`;
- `crates/fullmag-authoring/src/builder.rs`;
- `crates/fullmag-authoring/src/adapters.rs`, wraz z modułami testowymi
  osadzonymi w tych dwóch plikach.

**RED:**

- Python → IR zachowuje topology/exact/transition;
- UI authoring JSON → Python export → IR jest równoważne;
- `layers=0`, `order>1` i sprzeczne opcje są odrzucane;
- istniejące `thin_film()` bez nowego pola pozostaje tetrahedral;
- `swept(elements=1)` i jawny prismatic thin-film obniżają się do tych samych
  requested hints.

**Weryfikacja:**

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_script_builder_roundtrip.py \
  packages/fullmag-py/tests/test_meshing.py -vv
cargo test -p fullmag-authoring
```

#### Zadanie 3.2 — planner capability matrix

**Pliki:**

- `crates/fullmag-plan/src/mesh.rs`;
- `crates/fullmag-plan/src/fem.rs`;
- `crates/fullmag-plan/src/validate.rs`;
- `crates/fullmag-plan/src/tests.rs`;
- `docs/specs/capability-matrix-v0.md`.

**RED:**

- dozwolony SP4 slice planuje CPU/GPU mixed P1;
- każda niezakwalifikowana fizyka kończy planning error;
- strict nie ma fallbacku;
- stale lub nieaccepted topology certificate jest odrzucany;
- requested/resolved topology jest zachowane w provenance.

**Implementacja:**

- planner sprawdza rzeczywiste typy elementów, nie tylko hint;
- plan zawiera accepted certificate fingerprint;
- runtime odrzuca mesh zmieniony po certyfikacji;
- capability state rozróżnia `implemented`, `production_executable` i
  `validated`.

### Etap 4 — natywny FEM CPU dla mixed P1

#### Zadanie 4.1 — budowa mixed MFEM mesh

**Pliki:**

- `backends/fem/cpu/mfem/runtime/mfem_context.cpp`;
- nowy `backends/fem/cpu/mfem/runtime/mfem_mesh_builder.hpp`;
- nowy `backends/fem/cpu/mfem/runtime/mfem_mesh_builder.cpp`;
- `backends/fem/core/fem_mesh.cpp`;
- `backends/fem/tests/fem_mesh_contract.cpp`;
- `backends/fem/tests/mfem_context_contract.cpp`.

**Implementacja:**

- dispatch `tet4 → AddTet`;
- `prism6 → AddWedge`;
- `pyramid5 → AddPyramid`;
- `hex8 → AddHex`, ale hex pozostaje capability-gated do późniejszej
  kwalifikacji;
- `tri3 → AddBdrTriangle`;
- `quad4 → AddBdrQuad`;
- stosować jawne permutation tables Gmsh/Fullmag/MFEM;
- wywołać general `Finalize`, nie `FinalizeTetMesh`;
- sprawdzić `H1_FECollection(order=1)` i `NDofs == n_nodes` na mixed fixture;
- wyprowadzać exterior boundary z ownership/role, nie z samego markera.

**Testy:**

- pojedynczy prism, pyramid, tet;
- mieszana domena prism–pyramid–tet;
- dodatnia orientacja i odrzucenie każdej złej permutacji;
- zachowanie volume/boundary attributes.

#### Zadanie 4.2 — miary, materiały i obserwable

**Pliki:**

- `backends/fem/core/fem_mesh.cpp`;
- `backends/fem/core/fem_material_runtime.cpp`;
- `backends/fem/core/fem_element_quadrature_material.*`;
- `backends/fem/cpu/mfem/runtime/step_metrics.cpp`;
- `backends/fem/tests/fem_material_fields_contract.cpp`;
- `backends/fem/tests/fem_element_quadrature_material_contract.cpp`.

**Implementacja:**

- zastąpić tetra `volume/4` lumped mass wynikiem generycznej MFEM mass
  assembly;
- suma nodal weights musi równać się objętości magnetycznej;
- średnia magnetyzacja nadal używa `Ms`/volume weighting;
- uniform material działa dla prism P1;
- element-DG0 pozostaje odrzucone do osobnej implementacji;
- usunąć fast paths, które wybierają algorytm po `order==1`, ale zakładają
  `local_ndof==4` bez sprawdzenia geometry type.

#### Zadanie 4.3 — exchange i CPU Poisson

**Pliki:**

- `backends/fem/cpu/mfem/interactions/exchange_operator.cpp`;
- `backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp`;
- `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp`;
- `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp`;
- `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`;
- `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp`;
- `backends/fem/tests/exchange_contract.cpp`;
- `backends/fem/tests/demag_poisson_contract.cpp`.

**Testy numeryczne:**

- constant-field patch: zero exchange;
- linear-field patch: analityczny gradient na prism/pyramid/tet;
- symetria i dodatnia półokreśloność stiffness;
- suma mass matrix i lumped mass;
- manufactured `u=x+2y-3z` na mixed domain;
- continuity potencjału i normalnego fluxu przez interfejsy;
- Robin mass na tri i quad outer boundary;
- energy/field sign i directional derivative;
- porównanie mixed vs niezależnie zagęszczany all-tet reference.

CPU demag recovery ma używać jednej generycznej reguły kwadraturowej dla
prism/pyramid; tet fast path może pozostać wyłącznie po jawnym sprawdzeniu
`Geometry::TETRAHEDRON`.

**Managed weryfikacja etapu 4:**

```bash
just verify-fem-time-domain-native-contract
just verify-fem-exchange-runtime
just verify-fem-meshing-production
```

Dodać nowy container-backed target `fem_mixed_p1_contract` do `justfile`, w
nowym recipe `verify-fem-mixed-p1-native-contract`; host-only test nie jest
końcowym dowodem.

### Etap 5 — strict FEM GPU bez utraty residency

#### Zadanie 5.1 — exchange GPU

Obecny GPU exchange konsumuje złożony przez MFEM CSR. Po mixed CPU assembly:

- udowodnić, że CSR zawiera prism/pyramid contributions;
- zachować canonical graph/laplacian checks;
- nie dodawać osobnych prism CUDA kernels, jeśli generyczny CSR daje ten sam
  operator;
- sprawdzić device allocation i brak element-wise host loop w hot path.

**Pliki:**

- `backends/fem/cpu/mfem/interactions/exchange_operator.cpp`;
- `backends/fem/cpu/mfem/interactions/exchange_legacy_gpu_upload.*`;
- `backends/fem/gpu/cuda/mesh/mesh_geometry_upload.cpp`;
- `backends/fem/gpu/cuda/mesh/mesh_geometry_state.hpp`;
- `backends/fem/tests/exchange_contract.cpp`;
- `backends/fem/tests/source_facade_gpu_state_contract.cpp`;
- `backends/fem/tests/gpu_state_runtime_contract.cpp`;
- `backends/fem/tests/transfer_audit.cpp`.

Tet-only geometry upload nie może blokować exchange+demag slice, jeżeli żadna
włączona fizyka go nie używa. DMI/STT pozostają odrzucone.

#### Zadanie 5.2 — generyczne GPU Poisson RHS i recovery

**Pliki:**

- `backends/fem/gpu/cuda/demag_poisson/operators.cpp`;
- `backends/fem/gpu/cuda/demag_poisson/operators.hpp`;
- `backends/fem/gpu/cuda/demag_poisson/poisson.cpp`;
- `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`;
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`;
- `backends/fem/tests/demag_poisson_contract.cpp`;
- `backends/fem/tests/cuda_demag_robin_energy_contract.cpp`;
- `backends/fem/tests/cuda_demag_timing_contract.cpp`.

**Implementacja:**

- podczas inicjalizacji złożyć generyczne operatory
  `B_x/B_y/B_z: m → rhs` z właściwą kwadraturą per element family;
- złożyć `R_x/R_y/R_z: u → H_demag` zgodnie z CPU recovery;
- złożyć Poisson stiffness i Robin boundary mass przez MFEM;
- przesłać CSR na GPU dokładnie raz na topology generation;
- zachować Hypre device solve i warm start;
- nie wykonywać host readback magnetyzacji, RHS, potencjału ani `H_demag` w
  kroku;
- fingerprint operatorów obejmuje typed topology i quadrature policy.

**RED:**

- builder nie odrzuca prism6/pyramid5;
- wartości operatorów zgadzają się z CPU mixed fixture;
- jeden krok GPU zgadza się z CPU w field/energy/torque;
- telemetry potwierdza `uses_gpu_poisson=true`,
  `demag_operator_mode="device_hypre_poisson"` i zero niedozwolonych
  transferów hot-loop;
- próba użycia `hybrid_cpu_poisson` w strict nadal fail closed.

#### Zadanie 5.3 — relaksatory

Sprawdzić osobno:

- PG-BB direct Armijo i energy increments;
- nonlinear CG;
- overdamped LLG przez każdy wspierany explicit RK.

Żaden relaksator nie może odwoływać się do tet connectivity, jeśli korzysta
tylko z operatorów/field buffers. Każdy tetra-only helper ma zostać
capability-gated albo uogólniony.

**Managed weryfikacja etapu 5:**

Dodać nowy recipe:

```text
just verify-fem-mixed-prism-airbox-runtime
```

Recipe ma:

1. wykonać `just ensure-managed-fem-runtime`;
2. uruchomić mixed fixture na CPU;
3. uruchomić identyczny topology fingerprint na GPU;
4. sprawdzić device identity i CUDA/Hypre telemetry;
5. porównać pola, energie i torque;
6. zapisać immutable JSON/CSV report;
7. zwrócić nonzero przy każdym fallbacku.

### Etap 6 — resource-first API i FMMT v2

#### Zadanie 6.1 — binarny topology codec

**Pliki:**

- `crates/fullmag-api/src/field_store.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data/domain.rs`;
- `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`;
- `crates/fullmag-api/src/router_v2/tests.rs`;
- `apps/control-room/src/kernel/api/codecs/topologyCodec.ts`;
- `apps/control-room/src/kernel/api/codecs/topologyCodec.test.ts`;
- `apps/control-room/src/kernel/api/codecs/types.ts`;
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`;
- `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`.

**FMMT v2 layout:**

- zachować magic `FMMT`;
- version = 2;
- 64-byte header zawiera node/element/facet/connectivity/marker counts oraz
  opcjonalne `cellGlobalOrdinalCount` pod offsetem 40 i
  `facetGlobalOrdinalCount` pod offsetem 44; każdy ordinal count jest równy
  zero dla legacy v2 albo dokładnie odpowiada liczbie elementów/facetów;
- sekcje są wyrównane do 8 bajtów;
- payload przenosi:
  positions, element types, element offsets, element nodes,
  facet types, facet roles, facet offsets, facet nodes oraz markery, a po
  markerach opcjonalne wyrównane do 8 bajtów sekcje
  `cellGlobalOrdinals: u64[]` i `facetGlobalOrdinals: u64[]`;
- type codes są kodami Fullmag, nie Gmsh;
- decoder obsługuje v1 tylko w oknie migracyjnym i normalizuje do v2 model;
- server po cutover emituje v2;
- range requests i expected byte length wynikają z nagłówka;
- ETag/topology hash obejmuje całą v2 topology.

**RED:**

- valid mixed decode;
- truncated/overflowed/misaligned sections reject;
- unknown type/role reject;
- v1 compatibility fixture;
- chunked fetch każdej sekcji;
- dokładne globalne ordinals powyżej bezpiecznego zakresu JavaScript `number`;
- scoped object/part topology zachowuje types i remapuje offsets.

#### Zadanie 6.2 — OpenAPI resources i provenance

**Pliki:**

- `crates/fullmag-api/src/schemas/mesh.rs`;
- `crates/fullmag-api/src/openapi_v2.rs`;
- `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`;
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`;
- `apps/control-room/src/kernel/api/generated/openapi-v2.json`;
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`.

Rozszerzyć shared-domain manifest/build report o:

- `topology_schema_version`;
- `element_counts_by_type`;
- `facet_counts_by_type_and_role`;
- requested/resolved layered policy;
- mixed topology certificate summary/status;
- capability/rejection reason;
- Gmsh version;
- fallback list.

Ciężka connectivity pozostaje wyłącznie w binary data plane. Status sesji
pozostaje cienki i revision-driven. WebSocket tylko unieważnia revision; HTTP
resource jest źródłem prawdy.

**Weryfikacja:**

```bash
cargo test -p fullmag-api --lib router_v2
pnpm --dir apps/control-room generate:api
just resource-first-gates strict
```

### Etap 7 — Control Room

#### Zadanie 7.1 — authoring i capability-aware UX

**Pliki:**

- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`;
- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`;
- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.test.ts`;
- `apps/control-room/src/modules/inspector/panels/ScopedMeshQualityPanels.test.tsx`;
- `apps/control-room/src/modules/overlay/mesh-build/MeshBuildParameterDiff.tsx`;
- `apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx`;
- `apps/control-room/src/modules/inspector/panels/mesh-details/*`;
- `apps/control-room/src/modules/inspector/panels/airbox/*`.

UI ma pokazywać:

- „Free tetrahedral”;
- „Layered prism (exact)”;
- „Swept hex” tylko jako disabled/unsupported, dopóki nie przejdzie
  capability;
- liczbę element layers i wynikową liczbę node planes;
- transition policy;
- requested vs resolved;
- family counts;
- accepted/rejected exact-layer certificate;
- jawny brak fallbacku w strict;
- ostrzeżenie, że jedna warstwa wymaga convergence evidence.

Zmienić etykietę airbox „Tetrahedra” na „Volume elements” i rozbić ją na
`tet4` / `pyramid5` / ewentualnie inne typy.

Nie renderować opcji jako działającej tylko dlatego, że istnieje w formularzu.
Kontrola jest enabled wyłącznie przy odpowiednim capability.

#### Zadanie 7.2 — mixed viewport

**Pliki:**

- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`;
- `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexModel.ts`;
- `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexScheduler.ts`;
- `apps/control-room/src/modules/viewport-3d/viewport3dMeshSizeHighlight.ts`;
- `apps/control-room/src/modules/viewport-3d/layers/TopologyMeshLayer.tsx`;
- `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`;
- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`;
- `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexModel.test.ts`;
- `apps/control-room/src/modules/viewport-3d/viewport3dTopologyIndexScheduler.test.ts`;
- `apps/control-room/src/modules/viewport-3d/viewport3dMeshSizeHighlight.test.ts`;
- `apps/control-room/scripts/smoke-viewport-3d-mixed-targets.mjs`.

**Implementacja:**

- dodać face/edge tables per cell type;
- deduplikować wewnętrzne faces po `arity + sorted node IDs`;
- tri i quad pozostają semantycznymi facets;
- quad można triangulować deterministycznie tylko w render layer;
- nie zmieniać scientific topology ani global element ID;
- selection/highlight działa per element family;
- quality histogram nie porównuje bezpośrednio nieporównywalnych metryk;
- surface-only i full-volume paths pozostają bounded;
- topology workers przenoszą typed arrays jako transferables;
- brak idle redraw i brak nowych WebGL lifecycle leaków.

#### Zadanie 7.3 — przekroje i analizy topology-dependent

**Pliki:**

- `crates/fullmag-api/src/fem_cross_section.rs`;
- topology slicing/scoping w
  `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`;
- projection/profile handlers opisane w OpenAPI;
- frontendowe modele przekroju i mesh highlight.

Wybrać jedną z dwóch jawnych dróg per endpoint:

1. uogólnić przecięcie convex prism/pyramid/tet przy użyciu face tables; albo
2. zwrócić `409 mixed_topology_not_supported` do czasu wdrożenia.

Nie wolno traktować pierwszych czterech węzłów jako tetraedru. Przed
produkcyjną promocją pełnego UI wszystkie powierzchnie dostępne dla SP4 muszą
działać albo prezentować jawny unsupported state.

**Frontend gates:**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
env TMPDIR=/tmp pnpm --dir apps/control-room test
just resource-first-gates strict
```

Browser smoke ma potwierdzić:

- widoczny canvas;
- `gl.isContextLost() == false`;
- niezerowy drawing buffer;
- prism/pyramid/tet są widoczne i poprawnie selectable;
- airbox wireframe zachowuje pełny extent i hidden-edge semantics;
- brak rosnącej pamięci po przełączaniu mesh parts.

### Etap 8 — SP4 i walidacja naukowa

#### Zadanie 8.1 — oddzielny topology smoke

**Pliki:**

- nowy
  `tests/standard_problems/mumag/sp4/fem/scenarios/mesh_single_prism_layer.py`;
- nowy
  `tests/standard_problems/mumag/sp4/fem/test_mixed_mesh_topology.py`;
- collector metadata w
  `tests/standard_problems/mumag/sp4/fem/collect_results.py`.

Smoke nie powinien łączyć kilku algorytmów relaksacji. Ma:

- zbudować 500 × 125 × 3 nm film;
- poprosić o `topology="prismatic", layers=1, exact_layers=True`;
- zbudować baseline airbox;
- zapisać certificate i topology report;
- przed długim solve sprawdzić dokładnie dwie node planes;
- odrzucić każdy tet/pyramid z markerem filmu.

#### Zadanie 8.2 — convergence matrix

Rozszerzyć istniejący kontrakt bez usuwania all-tet reference:

| Oś | Poziomy |
|---|---|
| in-plane `hmax` | 3 nm, 2 nm, 1.5 nm |
| prism layers | 1, 2, 3 |
| airbox | baseline 700×250×250 nm, expanded 1000×500×500 nm |
| device | CPU, GPU |
| relaxation | PG-BB, NCG, overdamped LLG |
| dynamics | istniejąca macierz case A/B i solverów |

Koszt należy ograniczyć etapami:

1. CPU medium/baseline: layers 1/2/3;
2. CPU medium: baseline/expanded dla layers=1;
3. CPU/GPU medium/baseline parity dla layers=1;
4. po przejściu 1–3 uruchomić pełną coarse/medium/fine i case A/B matrix.

Sprawdzać:

- relaxed torque i norm defect;
- exchange, demag i total energy;
- nodal/volume-weighted state difference;
- całe `mx/my/mz` trajectories;
- czas pierwszego przejścia `mx=0`;
- mapę magnetyzacji przy pierwszym `mx=0`;
- endpoint;
- mesh, airbox, thickness-layer i timestep convergence;
- CPU/GPU parity na identycznym topology fingerprint;
- brak fallbacku i poprawną runtime identity.

Nie kwalifikować na podstawie samego finalnego `m` ani jednego zielonego
uruchomienia.

#### Zadanie 8.3 — aktualizacja canonical SP4 dopiero po dowodzie

Po przejściu matrix:

- zaktualizować `tests/standard_problems/mumag/sp4/fem/problem.py`;
- zaktualizować wszystkie bezpośrednie scenario scripts;
- zmienić test w `test_scenarios.py`, który dziś wymaga braku
  `thin_film_tetrahedral` i through-thickness controls;
- zaktualizować `docs/physics/0980-mumag-standard-problem-4-fem-application-validation.md`;
- zachować all-tet wariant jako jawny comparator, nie ukryty fallback;
- nie nadpisywać lokalnie zmodyfikowanego
  `relax_projected_gradient_bb.py` bez wcześniejszego semantycznego
  uzgodnienia jego jednego stage.

**Managed gates:**

```bash
just verify-fem-mixed-prism-airbox-runtime
just verify-fem-standard-problem-4
```

Obie bramki muszą przejść po ostatniej zmianie kodu i na właściwym managed
runtime. Historyczny wynik all-tet nie kwalifikuje mixed topology.

### Etap 9 — benchmark i decyzja default/opt-in

#### Zadanie 9.1 — pomiar

Na identycznych CAD, material, airbox i in-plane target porównać:

- liczba magnetycznych node planes;
- magnetic nodes;
- full-domain nodes/DOFs;
- cell counts per type;
- mesh build time;
- operator setup time;
- pamięć host/device;
- Poisson iterations;
- median accepted-step time po warmup;
- total relaxation wall time;
- H2D/D2H counts/bytes;
- końcowe energy/torque/state.

Wyniki zapisać do wersjonowanego JSON/CSV i czytelnego Markdown report.

#### Zadanie 9.2 — kryterium promocji

Feature może zostać oznaczony jako `validated opt-in`, gdy przejdzie fizykę,
niezależnie od wyniku szybkości. Może zostać kandydatem do nowego defaultu
`thin_film(layers=1)` tylko jeśli:

- ma dokładnie dwie node planes;
- nie pogarsza żadnej zaakceptowanej miary fizycznej;
- pełna pamięć nie rośnie o więcej niż 10%;
- median accepted-step time nie pogarsza się o więcej niż 10%;
- co najmniej jedna z dwóch miar: full-domain memory albo total relaxation
  wall time poprawia się o co najmniej 10%;
- UI/API/provenance jasno pokazują mixed topology.

Jeżeli kryterium szybkości nie przejdzie, zachować jawny opt-in i
profilować bottleneck; nie obniżać jakości ani tolerancji solvera.

---

## 8. Kryteria akceptacji end-to-end

### Topologia

- [ ] `layers=1` daje dokładnie dwie magnetyczne node planes.
- [ ] Film zawiera wyłącznie `prism6`.
- [ ] Transition pyramids należą wyłącznie do air.
- [ ] Far air zawiera `tet4`.
- [ ] Shared domain jest conforming i manifold.
- [ ] Objętości CAD i mesh zgadzają się z błędem względnym nie większym niż
  `1e-8`.
- [ ] Nie ma silent split ani fallbacku.

### Semantyka

- [ ] Python, UI i script export dają ten sam requested ProblemIR.
- [ ] ProblemIR i artifact odróżniają requested od resolved.
- [ ] Stary tet-only payload ma kontrolowaną migrację.
- [ ] Fingerprint obejmuje typy, offsety, connectivity, role i markery.
- [ ] Unsupported combinations fail przed backendem.

### Solver CPU

- [ ] MFEM buduje wedge/pyramid/tet i tri/quad boundaries.
- [ ] P1 DOF count odpowiada węzłom.
- [ ] Mass/volume, exchange i Poisson patch tests przechodzą.
- [ ] Robin/Dirichlet działają tylko na outer boundary.
- [ ] Energie i directional derivatives są zgodne.

### Solver GPU

- [ ] Mixed exchange CSR jest wykonywany na urządzeniu.
- [ ] Mixed demag RHS/recovery CSR jest złożony raz i uploaded raz.
- [ ] Hypre solve działa z device execution policy.
- [ ] Hot-loop nie ma niedozwolonych transferów.
- [ ] CPU/GPU parity przechodzi na tym samym topology fingerprint.

### UI/API

- [ ] FMMT v2 przenosi pełną mixed topology.
- [ ] Resource manifest pokazuje family counts i certificate.
- [ ] UI nie nazywa całego airboxu tetraedrami.
- [ ] Viewport renderuje tri/quad/prism/pyramid/tet bez zmiany topology.
- [ ] Selection, scoping i quality są zgodne z global element IDs.
- [ ] Browser smoke i lifecycle gates przechodzą.

### SP4

- [ ] Thickness-layer convergence 1/2/3 przechodzi.
- [ ] In-plane mesh i airbox convergence przechodzą.
- [ ] Trzy rodziny relaksacji dają zaakceptowany S-state.
- [ ] Case A/B trajectories i pierwsze `mx=0` maps przechodzą.
- [ ] CPU/GPU strict double przechodzą.
- [ ] Managed runtime identity i post-change artifacts są zapisane.

---

## 9. Ryzyka i środki kontroli

| Ryzyko | Skutek | Kontrola |
|---|---|---|
| OCC niszczy structured extrusion | powrót tet lub niekonformalność | pierwszy path GEO Box; fail closed dla reszty |
| zła kolejność węzłów Gmsh/MFEM | ujemny Jacobian, zła fizyka | jawne permutation tables i per-family patch tests |
| pyramid quality jest słaba | kondycja Poissona | per-family quality report, `QuadTriAddVerts`/transition shell jako wariant |
| mixed topology ma dwa źródła prawdy | stale fingerprints i błędne slices | jeden canonical in-memory v2, legacy tylko na granicy |
| tetra-only kernel uruchomi się na prism | memory corruption lub zła fizyka | planner capability + runtime geometry assertion |
| GPU operator różni się od CPU | błędny demag | ta sama kwadratura/assembled matrix oracle i parity tests |
| UI trianguluje quad naukowo | selection/field drift | triangulacja tylko render-layer, stabilne element IDs |
| jedna warstwa jest zbyt gruba fizycznie | zły SP4 wynik | obowiązkowa layer convergence 1/2/3 |
| airbox dominuje koszt | brak oczekiwanej szybkości | oddzielne benchmarki magnetic/full-domain; opt-in jeśli brak zysku |
| dirty checkout nadpisze pracę użytkownika | utrata zmian | implementować w izolowanym worktree, nie resetować bieżącego drzewa |

---

## 10. Kolejność PR/commitów

Każdy punkt ma być osobnym, reviewable slice i przejść swoje bramki:

1. physics note + ADR + Gmsh fixture;
2. canonical topology v2 Python/Rust;
3. C ABI i native mesh core;
4. Gmsh Box body-only;
5. Gmsh conforming airbox + certificate;
6. DSL/IR/authoring/capability;
7. CPU MFEM exchange + Poisson;
8. GPU CSR exchange + Poisson;
9. FMMT v2 + OpenAPI;
10. Control Room mixed render/inspector;
11. SP4 topology/convergence;
12. benchmark, status promotion i usunięcie legacy/split leftovers.

Nie łączyć implementacji wszystkich tetra-only fizyk z pierwszym SP4 slice.
Każda późniejsza fizyka powinna dostać własny publication update, capability,
patch tests i managed qualification.

---

## 11. Stop rules

Przerwać promocję, ale zachować działający fail-closed slice, jeśli:

- Gmsh nie potrafi deterministycznie utrzymać prism-only magnetic marker;
- pyramid transition ma niedodatni Jacobian;
- MFEM P1 pyramid/wedge nie zachowuje oczekiwanego nodal H1 contract;
- CPU manufactured Poisson lub exchange patch nie przechodzi;
- GPU wymaga host round-trip w hot loop;
- SP4 layer convergence pokazuje, że jedna warstwa nie jest wystarczająca;
- UI/API nie potrafią zachować global element identity.

W takim przypadku nie wracać po cichu do tetra. Publiczny request
`topology="prismatic", exact_layers=True` ma zwrócić precyzyjny błąd i
zachować diagnostykę.

---

## 12. Definicja ukończenia

Praca jest ukończona dopiero wtedy, gdy użytkownik może uruchomić:

```python
film.mesh.thin_film(
    maximum_element_size=3e-9,
    layers=1,
    topology="prismatic",
    exact_layers=True,
    order=1,
)
```

a następnie:

```bash
just fullmag build=True fem cpu tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py
just fullmag build=True fem gpu tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py
```

i otrzyma:

- zaakceptowany `mixed_layer_topology_certificate.v1`;
- dokładnie dwie node planes w filmie;
- prism6 w filmie, pyramid5/tet4 w airboxie;
- brak fallbacku;
- poprawny strict CPU/GPU runtime;
- widoczną i zgodną topologię w Control Room;
- aktualny, post-change raport SP4/mesh/airbox/CPU-GPU;
- wynik kwalifikacji, który nie opiera się wyłącznie na tym, że program się
  uruchomił.
