# T04: rzeczywista siatka CPW z sześcioma stacjami przewężenia

## Sprawdzony zakres

`packages/fullmag-py/tests/test_antenna_layout.py::test_six_station_cpw_mesh_preserves_constriction_volume_and_terminals`
realizuje sześć stacji z T04: pozycje `0, 0.4, 0.48, 0.52, 0.6, 1`,
szerokość sygnału odpowiednio `1, 1, 0.2, 0.2, 1, 1` mikrometra.
Długość wynosi 10 mikrometrów, grubość 100 nanometrów, stałe szczeliny
0.5 mikrometra, oba grounds mają szerokość 1 mikrometra.

Test wywołuje istniejący produkcyjny generator Gmsh, nie mock. Porównuje
sumę bezwzględnych objętości tetraedrów z niezależnym trapezowym całkowaniem
piecewise-linear szerokości sygnału plus dwa grounds. Oczekiwana objętość
wynosi `2.904e-18 m³`; tolerancja względna `1e-9`, bez dodatniej tolerancji
absolutnej maskującej mały rozmiar bryły.

Sprawdza też wszystkie wierzchołki i środki komórek po inverse rigid transform:
przedział długości/grubości i przynależność do sygnału albo jednego z grounds,
z wykluczeniem szczelin. Tolerancja pozycji `1e-14 m`. Szerokość lokalna jest
interpolowana niezależnie z tabeli stacji, bez używania sekcji producenta.
To obejmuje szeroki odcinek, taper i przewężenie.

Dwa przypadki: orientacja bazowa oraz obrót o 90 stopni z translacją i zmianą
nazwy geometrii. Oba wymagają sześciu terminal markers wyznaczonych z tego
samego `immutable-cpw`; round-trip parametrów layoutu również zachowany.

## Wynik i granice

2/2 przypadki PASS, Python 3.14.7 / Gmsh 4.15.2. Bez kompilacji testów,
solvera, LLG, Relax, zmian operatorów albo restartu sesji. Dane pytest poza
checkoutem, w storage na D. Wcześniejszy checkpoint terminal-owner nie miał
nowej kwalifikacji CPW rename/transform; niniejszy zapis dodaje właśnie ten dowód.

Źródła produkcyjne:

- `model/geometry.py::CPWAntennaLayout.{_sections,to_ir,from_ir}`
  w `packages/fullmag-py/src/fullmag/`;
- `meshing/_gmsh_waveguides.py::{add_antenna_layout_parts_to_occ,add_antenna_layout_terminal_physical_groups}`;
- `meshing/_gmsh_generators.py::{generate_mesh,_generate_csg_mesh}`.

Nie zalicza to całego T04/T05/T06, current crowding, closed circuit, reusable
basis ani czterech realizacji solvera. Wymagany nazwany scenariusz
`tests/antenna/scenarios/cpw_constriction.py` pozostaje do pełnego workflow;
nie zastąpiono go scenariuszem bez solve udającym odbiór runtime.

## Kolejny rzeczywisty blocker

`packages/fullmag-py/src/fullmag/model/problem.py::Problem.to_ir` zapisuje
`physics_objects`, natomiast `crates/fullmag-ir/src/lib.rs::{ProblemIR,ProblemIRWire}`
nie zachowują takiego pola. `crates/fullmag-plan/src/antenna_field_solve.rs::geometry_name_for_object`
może obecnie rozwiązać magnet albo geometry name, nie jawne auxiliary ID.
Nie istnieje gotowa typowana mapa, którą wystarczy odczytać w tym helperze.
Migracja modelu obiektów i modułów wymaga spójnego publicznego kontraktu,
nie dopisania syntetycznej magnetyzacji ani drugiego inventory w metadata.

Build 38 nadal ma aktywne Cargo/rustc w ostatnim odczycie, na niezmiennym
commicie `86810f37e21e95b3f8e24d967fdb2bad9511eff1`.
PR #147 Draft, pełny cel T00–T18 nadal aktywny.
