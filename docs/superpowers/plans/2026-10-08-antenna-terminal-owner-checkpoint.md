# T04→T05: niezmienny właściciel terminali niezależnej siatki

## Zakres i przyczyna

Generator markerów przyjmował `object_id`, lecz jego produkcyjny caller
przekazywał nazwę geometrii. Python pozwala nadać pomocniczemu obiektowi osobne
`auxiliary_geometry_object_ids`; zmiana nazwy mogła więc zmienić terminale
bez zmiany tożsamości obiektu. Poprawka realizuje istniejący kontrakt T04,
nie wprowadza nowych równań, fizyki ani źródła pola.

## Produkcyjny łańcuch

- `packages/fullmag-py/src/fullmag/model/problem.py::Problem._geometry_object_ids`
  zbiera jawne ID auxiliary i ID magnetów z dotychczasowym fallbackiem legacy.
  `Problem.to_ir` i `Problem._build_geometry_assets` przekazują tę mapę.
- `packages/fullmag-py/src/fullmag/world.py::_build_explicit_mesh_assets`
  przekazuje ID handle i nazwy **resolved** geometrii; nazwa surowego shape
  nie jest nazwą per-object assetu.
- `model/problem.py::build_geometry_assets_for_request` wiąże owner z
  `meshing/asset_pipeline.py::realize_fem_mesh_asset`, następnie
  `meshing/_gmsh_generators.py::{generate_mesh,_generate_csg_mesh}` oraz
  `meshing/_gmsh_waveguides.py::add_antenna_layout_terminal_physical_groups`.
- `model/problem.py::{_geometry_asset_cache_key,_fem_mesh_cache_key}` zawierają
  owner binding. Cache z innym ID nie może dostarczyć markerów poprzednika.
  FDM-only cache nadal pomija ten niekonsumowany parametr.
- `meshing/_gmsh_waveguides.py::antenna_terminal_marker` zachowuje ten sam
  algorytm hash, identyfikator wersji i selectors. Nie dodano drugiego ownera
  do fizycznego layoutu. Wywołania bez jawnego ownera zachowują fallback nazwy.

## Dowody

Interpretowane regresje w `packages/fullmag-py/tests/test_antenna_layout.py`:

- `test_independent_terminal_markers_follow_owner_not_name`: rzeczywisty
  Gmsh, tapered microstrip, rename oraz obrót/przesunięcie, identyczny zestaw
  czterech markerów; każdy wierzchołek oznaczonego facet leży na odpowiedniej
  płaszczyźnie inlet/outlet, tolerancja pozycji `1e-14 m`.
- `test_geometry_asset_caches_and_realizer_preserve_owner`: dwaj ownerzy tej
  samej geometrii, dwa rzeczywiste meshingi i dwa pliki cache, niezależne keys;
  hit w RAM oraz hit z dysku po wyczyszczeniu RAM nie uruchamiają Gmsh.
- `test_problem_mesh_callers_pass_authored_geometry_owners`: oba callery
  `Problem` przekazują osobne ID magnetu i przewodnika; mock obejmuje tylko
  granicę materializacji, nie jest dowodem solve.
- `test_explicit_world_mesh_uses_resolved_geometry_owner`: explicit world
  przekazuje mapping resolved geometry→owner do wspólnej materializacji.
  Kontrola tej granicy jest mockowana, bez wykonania solvera.

RED: brak argumentów `object_id` i `geometry_object_ids` odrzucał nowe
regresje przed poprawką. Poprawiono również niekompletne konfiguracje testowe
FEM/material/study; ich błędy nie są dowodem regresji produktu.

GREEN: 30/30 testów layoutów oraz istniejących cache/API PASS, 292 testy poza
zakresem deselected; po dodaniu kontroli world oba testy callerów 2/2 PASS
(łącznie 31 różnych testów). Jedno historyczne ostrzeżenie deprecation `solver(dt=...)`.
Python 3.14.7, pytest 9.1.1, Gmsh 4.15.2. Nie kompilowano testów Rust/C++.
Artefakty testów zapisano w resolverowym storage na D, poza checkoutem.

## Niezamknięte bramki

To **nie zamyka T04/T05/T06**. Niezależne meshing działa bez airbox
fragmentation; wymagane pozostają independent source asset obok target domain,
lookup auxiliary owner w plannerze, jawny circuit/source preparation,
produkcyjna baza wielokrotnego użytku, standalone bez magnetu, FFT i LLG.
Nie zmieniono wspólnego domain mesh ani imported terminal markers.
CPW używa tego samego poprawionego dispatch, lecz nowe rename/transform
regresje rzeczywistego meshingu w tym checkpointcie obejmują microstrip.

FDM CPU/GPU: bez zmiany operatora, brak nowej kwalifikacji. FEM CPU:
kwalifikacja przygotowania niezależnej siatki przez Gmsh, nie solvera.
FEM GPU: brak runtime i dowodu parytetu.

Build seq 38 `ff4035657e4a40ad84e15ca2a07764a0` nadal running w ostatnim
odczycie; aktywne Cargo/rustc potwierdzone. Buduje immutable commit
`86810f37e21e95b3f8e24d967fdb2bad9511eff1`, więc nie kwalifikuje tej poprawki.
Nie restartowano aktywnej sesji. PR #147 pozostaje Draft; bez merge.
