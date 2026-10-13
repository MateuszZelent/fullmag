# A1 — dokładne płaszczyzny warstw i granica kwalifikacji

## Wynik

Zapisana kanoniczna siatka A1 ma trzy konformne warstwy względem swoich
rzeczywistych płaszczyzn. Trzy z czterech płaszczyzn różnią się jednak o jeden
ULP binary64 od zadanych poziomów. To naruszenie kontraktu exact-Z z
`docs/physics/0104-thin-film-shared-domain-meshing.md`; nie jest dowodem
przyczyny dużej rozbieżności częstotliwości ani wynikiem solvera.

Odczyt dotyczy checkoutu `dispersion-mode-ui-20261008`, HEAD
`3ee2a7c04e56cbb737feb8bd2bad42a45d1e2ecf` (względem checkpointu
`181b4e7b4e8b749cc5de3af0c15b3317e468306b` zmieniono tylko plan).
Siatka została wcześniej wygenerowana przez publiczny harness A1, lokalny
Gmsh 4.15.2; odczyt exact i replay nie generowały jej ponownie.

## Geometria i pomiar

Film 200 × 200 × 10 nm, otwór o promieniu 50 nm, trzy warstwy P1/Tet4.
Airbox: 200 × 200 × 4010 nm, padding po 2 µm w Z; PBC x/y. Film i
interfejs hmax 5 nm, przejście 20 nm, powietrze hmax 100 nm, growth 1.3.
Siatka: 102424 węzły, 574620 Tet4; domena magnetyczna ma 27558 Tet4
oraz 6572 węzły. PBC: zaakceptowane dwie osie i 5084 pary węzłów.

Porównanie binary64 odbywa się po tej samej sekwencji konwersji co producer:
poziomy helpera SI → mnożenie przez SCALE=1e6 → dzielenie przez SCALE.
Nie użyto tolerancji, zaokrąglania ani snapowania.

| Plane | Zadane Z w SI (hex) | Obserwowane Z w SI (hex) | Różnica ULP | Węzły |
|---:|---|---|---:|---:|
| 0 | -0x1.5798ee2308c3ap-28 | -0x1.5798ee2308c3ap-28 | 0 | 1643 |
| 1 | -0x1.ca213d840baf8p-30 | -0x1.ca213d840baf9p-30 | -1 | 1643 |
| 2 | 0x1.ca213d840baf8p-30 | 0x1.ca213d840baf7p-30 | -1 | 1643 |
| 3 | 0x1.5798ee2308c3ap-28 | 0x1.5798ee2308c39p-28 | -1 | 1643 |

| Warunek | Względem zadanych planes | Względem obserwowanych planes |
|---|---|---|
| Tet4 w jednym sąsiednim slab | 9186/27558 | 27558/27558 |
| Komórki poza wszystkimi slabami | 18372 | 0 |
| Ścisłe przecięcia każdego wewnętrznego plane | 9186 | 0 |
| Komórki na każdy slab | tylko slab0: 9186 | po 9186 |

Przecięcia zadanych planes mają zakres jednego ULP. Nie oznaczają
przeskoku przez całą warstwę. Obserwowane cap faces mają po 3062 trójkąty;
incydencja jest równa 2 wewnątrz filmu i 1 na jego końcach.

## Źródło hipotezy i ograniczenia

Legacy ring producer `_generate_coincident_ring_airbox_mesh` w
`packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` wyznacza
`step = levels[i + 1] - levels[i]` i wykonuje kolejne `geo.extrude`.
Niezależny replay binary64 `z += step`, od pierwszego poziomu, odtworzył
bitowo wszystkie cztery obserwowane Z (interpretowany Python, exit 0).
To wspiera kumulacyjny dryf arytmetyczny jako wyjaśnienie; nie jest
bezpośrednim pomiarem operacji wewnętrznych Gmsh.

A1 używa `Difference(Box, Cylinder)` oraz legacy `generate(3)` i
`subdivide_layered_prisms`. Poprawka absolute parametric caps i kernel
compatible-cap z 181b4e7b dotyczą scoped Box. Obecny kernel
`tetrahedralize_layered_box_delaunay` przyjmuje prostokątne bounds i nie
przyjmuje ograniczonego konturu otworu lub wewnętrznych interfejsów.
Rozszerzenie samego `isinstance(Box)` mogłoby utracić otwór i tagi domen.

Raport globalny wskazuje p05 SICN 0.06318 przy celu 0.1 oraz min gamma
0.04231 przy celu 0.08. Magnetic scope ma min SICN 0.616 i min gamma
0.589; ostrzeżenia pochodzą z airboxu. Harness `benchmark_mesh_status=accepted`
nie sprawdza tej bramki jakości i nie zastępuje `MeshRealizationReport`,
którego legacy artefakt nie zawiera. Przyczyna proporcji elementów
powietrza wymaga osobnego pomiaru; nie przyjmujemy kopiowania drobnego XY
jako potwierdzonej diagnozy.

## Kolejny fragment naprawy i kryteria odbioru

1. Wytwarzać ring caps na absolutnych zadanych Z, zachowując ograniczone
   kontury annulus/otworu i interfejs film–powietrze. Nie naprawiać gotowych
   współrzędnych przez snapping ani nie zastępować exact guard tolerancją.
2. Zachować tagi domen, owner-scoped size fields i patch-scoped mapy PBC;
   dobrać generator obsługujący rzeczywiste ograniczenia przekrojów.
3. Dodać regresję tej samej kanonicznej A1: dokładne authored planes,
   brak Tet4 przecinających planes, poprawna incydencja, objętość domen,
   węzły interfejsu, fresh PBC oraz końcowy raport realizacji i jakości.
4. Na podstawie pomiarów proporcji elementów skorygować airbox, a potem
   przeprowadzić zbieżność jego siatki/rozmiaru. Jakość magnetyczna sama
   nie kwalifikuje rozwiązania demag.
5. Dopiero wynik native FEM/SLEPc z residualami, pełnym widmem i zgodnością
   parametryczną stanowi wejście do porównania COMSOL. Mesh-only nie zamyka
   S00–S12, runtime ani kwalifikacji naukowej.

## Dowody i odtwarzalność

Katalog dowodów lokalnych:
`C:/Users/Mateusz/.codex/visualizations/2026/09/14/01a09ee1-29e6-7d51-98f0-082c5539a0d6/layered-cap-sliver-diagnostic-20261013`.

| Artefakt | SHA-256 |
|---|---|
| a1-mesh-only-source-20261013-01/problem_ir.json | 529689d6e1ab664c7b19478df3f8e0eb22fd145f13b03c585eb54999c5303434 |
| a1-mesh-only-source-20261013-01/materialization_summary.json | 98d27b9e31b161e9d0b0f39e39cecaf1f85893505689467bb0e40a13ec8e090e |
| a1-authored-z-plane-exactness-2026-10-13.md | 69b8c14b965423dfaede0d55ca859b979a35eb8566d4c59d76fd1b4a5eb1b801 |
| a1-incremental-z-step-replay-20261013.json | 057d8c027041652cf9e502283e7187f60e26ede3b0f8a922487c101bd81e821a |
| _gmsh_swept.py | f4d453a0f7548954fd886150996042ac6fce96b90cdbe499f1049048fe2dc237 |

Brak nowych obliczeń solvera, managed-image materializacji A1, zbieżności
lub browser/WebGL proof w tym audycie. Wynik: source/mesh diagnostic;
kwalifikacja solvera pozostaje NOT VERIFIED.
