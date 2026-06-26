# CoFeB rings mesh refinement audit - 2026-06-26

## Zakres

Problem: w ukladzie `permalloy_layer_cofeb_rings_relax_300nm` mesh wyglada tak,
jakby lokalne zageszczenie dzialalo glownie wokol warstwy, a wokol dwoch
ringow CoFeB bylo znacznie rzadsze.

Analiza objela:

- przyklad `examples/permalloy_layer_cofeb_rings_relax_300nm.py`,
- DSL mesh API w `packages/fullmag-py/src/fullmag/world.py`,
- planowanie size-field w `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`,
- wybor sciezki OCC/STL w `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` i `asset_pipeline.py`,
- airbox/GEO grading w `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`.

Nie uruchamialem pelnego generowania mesha dla oryginalnego przykladu, bo to
ciezka sciezka Gmsh. Uruchomilem natomiast pure-data check planisty size-field
dla tej samej geometrii i istniejacy test jednostkowy rozrozniania wielu
obiektow.

## Wniosek glowny

Nie widze bledu typu "planner bierze tylko pierwszy/glowny obiekt" na poziomie
planowania size-field. Dla odtworzonego ukladu planista generuje pola dla
warstwy i obu ringow:

```text
default_hmax_nm 500.00000000000006
hmin_nm None
Counter({'ComponentVolumeConstant': 3, 'TransitionShellThreshold': 3})
ComponentVolumeConstant permalloy_layer_geom VIn=8 nm
ComponentVolumeConstant cofeb_top_ring_geom VIn=25 nm
ComponentVolumeConstant cofeb_bottom_ring_geom VIn=25 nm
TransitionShellThreshold permalloy_layer_geom SizeMin=8 nm SizeMax=500 nm DistMax=24 nm
TransitionShellThreshold cofeb_top_ring_geom SizeMin=25 nm SizeMax=500 nm DistMax=75 nm
TransitionShellThreshold cofeb_bottom_ring_geom SizeMin=25 nm SizeMax=500 nm DistMax=75 nm
```

To tlumaczy wazna czesc obserwacji: aktualny skrypt sam deklaruje ringi jako
znacznie grubsze numerycznie niz warstwe. Warstwa ma
`maximum_element_size=8 nm`, ringi maja `maximum_element_size=25 nm`
(`examples/permalloy_layer_cofeb_rings_relax_300nm.py:78,96,104`). Auto halo
jest liczone jako `3 * hmax`, wiec ringi dostaja przejscie `25 -> 500 nm` na
`75 nm`, a warstwa `8 -> 500 nm` na `24 nm`
(`_size_field_plan.py:920-979`). To nie jest rowne zageszczenie.

## Potwierdzone problemy / ryzyka

### 1. `minimum_element_size` z wielu obiektow nie trafia do `MeshOptions.hmin`

Pure-data check pokazal `hmin_nm None`, mimo ze skrypt ustawia
`minimum_element_size=2.5 nm` dla warstwy i obu ringow. Przyczyna jest w
`_mesh_options_from_runtime_metadata`: `hmin` jest czytany przez
`_mesh_option_value("hmin", "minimum_element_size", reducer="min")`, ale ta
funkcja dla `mesh_workflow.per_geometry` uzywa tylko `_single_geometry_value`.
Dla wielu geometrii zwraca `None` (`_size_field_plan.py:1481-1544,1652-1654`).

To jest realny blad kontraktu API. Nie wyjasnia bezposrednio rzadkiego mesha
wokol ringow, bo `hmin` jest dolnym limitem, a nie prosba o halo. Ale oznacza,
ze uzytkownik moze myslec, ze `minimum_element_size=2.5 nm` dziala globalnie dla
shared-domain mesh, podczas gdy w multi-object path moze nie byc przekazane do
Gmsh jako `Mesh.CharacteristicLengthMin`.

### 2. Ringi nie ida natywna sciezka multi-OCC

`is_occ_compatible()` odrzuca:

- multi-body geometrie, jezeli ktorykolwiek obiekt zawiera boolean CSG,
- cylindry, ktorych os nie jest `(0, 0, 1)`.

To dotyczy ringow CoFeB, bo sa `Cylinder - Cylinder` i maja os X
(`_gmsh_occ.py:111-130`). W praktyce przyklad idzie przez komponentowa sciezke
STL/GEO, nie przez natywny conformal OCC.

Ta sciezka powinna zachowac osobne komponenty, ale jezeli runtime wlaczy
fallback `concatenated_stl_fallback`, per-component identity slabsnie i lokalne
fieldy sa przebudowywane jako pola bbox. To jest kandydat na obserwacje typu
"ringi nie dostaja dobrego zageszczenia", jezeli w logach/build report jest
`component_aware_import_failed`.

### 3. GEO airbox grading jest globalny, nie per-komponent jak OCC

W sciezce GEO `_add_airbox_geo()` buduje jedno pole airbox grading z:

- `surface_tags=body_surf_tags`, czyli laczna lista powierzchni wszystkich cial,
- `object_bounds_min/max` z globalnego bbox calego ukladu,
- jednym `h_inner` z `airbox.minimum_element_size` albo `hmax`
  (`_gmsh_airbox.py:191-214`).

W sciezce OCC istnieje bardziej precyzyjna logika per component: iteruje po
geometriach, wybiera ich powierzchnie interfejsu i bierze per-component target
z `_component_interface_size_targets()` (`_gmsh_occ.py:586-653`).

Dla obecnego skryptu `airbox_hmin=10 nm`, wiec GEO grading powinien byc drobny
przy wszystkich powierzchniach, nie tylko przy warstwie. Ale brak parytetu
per-komponent z OCC jest slabym miejscem: przy innych ustawieniach albo przy
braku `airbox_hmin` ringi moga nie dostac takiego samego airbox targetu jak
obiekty na sciezce OCC.

### 4. Sciezka `per_object_recipes` moze kasowac halo z `mesh_workflow`

W `asset_pipeline.py` jezeli `per_object_recipes` sa przekazane bezposrednio,
kod najpierw buduje pelne size fields z `mesh_workflow`, a potem wycina pola
dla nadpisanych geometrii i dokleja wynik `_resolve_per_object_mesh_options()`
(`asset_pipeline.py:1244-1268`). Ten wynik, mimo komentarza o
"surface-driven threshold field", dodaje tylko `ComponentVolumeConstant` albo
`Box` plus reczne `recipe.size_fields` (`_size_field_plan.py:1393-1447`).

Nie wyglada to na aktywna sciezke dla normalnego `study` skryptu, bo problem
builder przekazuje `mesh_workflow`, a nie osobne `per_object_recipes`. Jest to
jednak realny regresyjny risk dla bezposrednich wywolan helperow lub testow:
mozna stracic `TransitionShellThreshold`/`InterfaceShellThreshold` i zostawic
tylko rozmiar wewnatrz obiektu.

## Co najbardziej pasuje do obserwacji

Najbardziej prawdopodobne wyjasnienia sa dwa:

1. Skrypt rzeczywiscie prosi o rzadszy mesh dla ringow niz dla warstwy:
   `25 nm` vs `8 nm`. Jezeli oczekiwane jest rowne zageszczenie wokol wszystkich
   obiektow, ringi musza miec taki sam `maximum_element_size` albo jawne
   `interface_maximum_element_size` / `transition_distance` / `edge_*`.

2. Jezeli rzeczywisty build report pokazuje fallback do
   `concatenated_stl_fallback`, to obserwacja moze byc skutkiem degradacji z
   komponentowego STL/GEO do sklejonego STL. Wtedy trzeba naprawiac przyczyne
   `component_aware_import_failed`, a nie tylko zmieniac parametry mesha.

## Rekomendowane poprawki

1. Dodac regresje pure-data dla dokladnego ukladu `permalloy_layer + top/bottom
   CoFeB ring`, sprawdzajaca ze `size_fields` zawieraja po jednym
   `ComponentVolumeConstant` i `TransitionShellThreshold` dla kazdego z trzech
   obiektow.

2. Naprawic merge `minimum_element_size` dla multi-object `per_geometry`:
   `_mesh_options_from_runtime_metadata()` powinno brac minimum z wartosci
   `hmin/minimum_element_size` w `raw_per_geometry`, analogicznie do
   `per_object_recipes` z `reducer="min"`.

3. Dodac runtime/Gmsh regresje dla CoFeB-like CSG ringow:
   - build mode nie moze spasc do `concatenated_stl_fallback` bez jawnego
     raportu,
   - `size_fields_realized` musi miec status `applied` dla warstwy i obu
     ringow,
   - statystyki rozmiaru elementow w airboxie przy warstwie, top ringu i bottom
     ringu musza byc porownywalne przy takich samych targetach.

4. Zrownac GEO airbox grading z OCC: `_add_airbox_geo()` powinien budowac
   per-component grading fields z `component_surface_groups` i per-component
   targetami, zamiast jednego globalnego pola po `body_surf_tags` i globalnym
   bbox.

5. Dla bezposredniej sciezki `per_object_recipes` albo usunac strip
   `TransitionShellThreshold`, albo sprawic, zeby `_resolve_per_object_mesh_options()`
   lowerowal pelna recepture: bulk, interface, transition, edge/corner i reczne
   size fields.

## Natychmiastowa konfiguracja do sprawdzenia

Jezeli celem jest takie samo zageszczenie wokol warstwy i ringow, obecny skrypt
nie deklaruje tego. Minimalny test konfiguracyjny:

```python
for ring in (bottom_ring, top_ring):
    ring.mesh(
        maximum_element_size=8 * NM,
        minimum_element_size=2.5 * NM,
        interface_maximum_element_size=8 * NM,
        transition_distance="airbox_boundary",
        order=1,
    )
```

Dla ostrych/perymetrycznych efektow demag przy ringach lepszy test powinien
dodatkowo ustawic `edge_maximum_element_size`, `edge_thickness` i
`edge_transition_distance`, bo zwykle samo `maximum_element_size` kontroluje
glownie objetosc obiektu, nie gwarantuje szerokiego halo w powietrzu wokol
krawedzi.

## Weryfikacja wykonana

```text
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover \
  -s packages/fullmag-py/tests -p test_meshing.py \
  -k test_two_objects_different_bulk_hmax_produce_distinct_fields

Ran 1 test in 0.000s
OK
```

Pure-data check planisty dla odtworzonego ukladu CoFeB wykazal 3 pola bulk i 3
pola transition, ale `hmin=None`. Pelny runtime/Gmsh proof dla oryginalnego
przykladu nadal jest potrzebny, jezeli mamy potwierdzic rzeczywiste rozklady
rozmiaru elementow w gotowym meshu.
