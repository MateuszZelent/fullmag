# Physics-first authoring siatki FDM przez `mesh(cell_size=...)`

## Status i zakres

Dokument definiuje docelowy publiczny kontrakt konfiguracji siatki FDM.
Zakres obejmuje Python DSL, obniżenie do `ProblemIR`, planowanie siatek
natywnych i wspólnej domeny konwolucyjnej, walidację, proweniencję, migrację
starego API, testy oraz angielską dokumentację użytkownika.

Kontrakt FEM pozostaje bez zmian. Refaktoryzacja nie zmienia równań,
operatorów demagnetyzacji ani formatów danych runtime, jeśli nie jest to
konieczne do przeniesienia zatwierdzonej intencji użytkownika.

## Cel użytkownika

Kod FEM i FDM ma używać tych samych pojęć wysokiego poziomu:

```python
body.mesh(...)
study.universe.mesh(...)
study.demag()
```

Parametry numeryczne pozostają uczciwie różne:

- FEM używa `minimum_element_size` i `maximum_element_size`;
- FDM używa `cell_size=(dx, dy, dz)`, analogicznie do mumaksowego
  `SetCellSize(dx, dy, dz)`.

Normalny skrypt nie używa `study.fdm(...)`, `FDMGrid`, `FDMDemag`,
`default_cell`, `per_magnet`, `common_cells` ani `common_cells_xy`.

## Rozważone warianty

### Wariant A: `spacing=(dx, dy, dz)`

Nazwa jest neutralna numerycznie, ale mniej intuicyjna dla użytkownika MuMax
i nie mówi wprost, że wartości są fizycznymi rozmiarami komórki. Wariant
odrzucony.

### Wariant B: `cell=(dx, dy, dz)`

Nazwa jest krótka, lecz może oznaczać rozmiar komórki, obiekt komórki albo
liczbę komórek. Wariant odrzucony jako niejednoznaczny.

### Wariant C: `cell_size=(dx, dy, dz)`

Nazwa odpowiada praktyce MuMax, rozróżnia fizyczny rozmiar od przyszłego
`grid_size=(nx, ny, nz)` i jest już zgodna ze słownictwem runtime Fullmag.
Ten wariant jest przyjęty.

## Publiczny kontrakt Python

### FEM bez zmian

```python
study.engine("fem")
study.mode("strict")

study.universe.mesh(
    minimum_element_size=1e-9,
    maximum_element_size=5e-9,
)

study.demag()
```

`minimum_element_size` i `maximum_element_size` zachowują dotychczasową
semantykę nieustrukturyzowanej siatki FEM oraz airboxa FEM.

### Natywne siatki FDM per obiekt

```python
bottom.mesh(cell_size=(2e-9, 2e-9, 10e-9))
top.mesh(cell_size=(5e-9, 5e-9, 10e-9))
```

`cell_size` jest trójką dodatnich, skończonych długości SI. Dla FDM oznacza
dokładny rozmiar natywnej komórki kartezjańskiej danego obiektu, a nie cel
adaptacyjnego meshera.

### Wspólna domena konwolucyjna

```python
study.universe.mesh(cell_size=(2e-9, 2e-9, 2.5e-9))
```

Dla FDM `study.universe.mesh(cell_size=...)` opisuje rozmiar komórki wspólnej
domeny obliczeniowej wymaganej do sprzężenia obiektów. Nie zastępuje
natywnych siatek obiektów i nie oznacza, że airbox jest materiałem
ferromagnetycznym.

Pełny docelowy przykład:

```python
import fullmag as fm

nm = 1e-9

study = fm.Study("fdm_two_layers")
study.engine("fdm")
study.mode("strict")

bottom = study.geometry(
    fm.Box(size=(100 * nm, 50 * nm, 10 * nm)),
    name="layer_bottom",
)
top = study.geometry(
    fm.Box(size=(100 * nm, 50 * nm, 10 * nm)).translate((0, 0, 20 * nm)),
    name="layer_top",
)

material = fm.Material(Ms=800e3, A=13e-12)
bottom.material(material)
top.material(material)

bottom.mesh(cell_size=(2 * nm, 2 * nm, 10 * nm))
top.mesh(cell_size=(5 * nm, 5 * nm, 10 * nm))
study.universe.mesh(cell_size=(2 * nm, 2 * nm, 2.5 * nm))

study.demag()
study.exchange()
study.relax()
study.run()
```

## Reguły walidacji

1. Każda składowa `cell_size` musi być dodatnia i skończona.
2. Rozmiar obiektu w każdej osi musi być całkowitą wielokrotnością jego
   natywnego `cell_size` w granicach jednej udokumentowanej tolerancji
   numerycznej.
3. Rozmiar wspólnej domeny w każdej osi musi być całkowitą wielokrotnością
   `study.universe.mesh(cell_size=...)`; planner nie zaokrągla liczności.
4. `cell_size` nie może wystąpić w tym samym wywołaniu z parametrami FEM,
   takimi jak `minimum_element_size`, `maximum_element_size`, `hmin`, `hmax`,
   grading lub algorytmy Gmsh.
5. Obiekt FDM bez `cell_size` może użyć
   `study.objects.mesh.defaults(cell_size=...)`. Jeśli nie istnieje ani
   wartość obiektu, ani wartość domyślna, walidacja kończy się błędem.
6. Dla jednego obiektu wspólna domena może zostać wyprowadzona z natywnej
   siatki. Dla wielu niejednakowych siatek brak jawnego
   `study.universe.mesh(cell_size=...)` jest błędem w pierwszej wersji
   kontraktu; planner nie zgaduje kompromisowej rozdzielczości.

## Siatki 2 nm, 5 nm i wspólna domena 2 nm

W osi XY komórka 5 nm nie jest całkowitą wielokrotnością komórki wspólnej
2 nm. Dlatego nie wolno użyć kopiowania ani cichego zaokrąglenia. Planner
wybiera istniejący kontrakt transferu `push_pull`:

- `push_m` przenosi magnetyzację na raster roboczy z wagami objętości
  przecięcia;
- `pull_h` jest operatorem sprzężonym w objętościowo ważonym iloczynie
  skalarnym;
- transfer zachowuje całkowity moment magnetyczny;
- energia jest raportowana zgodnie z rastrem, na którym zdefiniowano
  operator, bez podwójnego liczenia oddziaływań wzajemnych.

W osi Z stosunek `10 nm / 2.5 nm = 4`, więc transfer jest zagnieżdżony.
Plan i proweniencja muszą osobno zapisać rodzaj transferu dla każdej warstwy;
nie wolno przedstawiać całego przypadku jako transferu `identity`.

## Znaczenie `strict`

`study.mode("strict")` jest polityką wykonania, a nie ustawieniem dokładności.
W tym kontrakcie oznacza:

- brak cichej zmiany rozmiaru komórki lub geometrii;
- brak zaokrąglania liczby komórek;
- brak niejawnego przejścia na inną strategię demagnetyzacji;
- odrzucenie nieobsługiwanego albo niezakwalifikowanego transferu;
- zachowanie w proweniencji wartości żądanych i rozwiązanych.

Jawnie wybrany i zakwalifikowany `push_pull` jest częścią metody, a nie
fallbackiem, dlatego może działać w trybie `strict`.

## Python do `ProblemIR`

Publiczne authoring intent jest obniżane do istniejącego słownictwa
backendowego bez wystawiania go użytkownikowi:

- `body.mesh(cell_size=...)` trafia do wpisu siatki natywnej dla stabilnego
  `object_id`;
- `study.objects.mesh.defaults(cell_size=...)` trafia do domyślnego rozmiaru
  komórki FDM;
- `study.universe.mesh(cell_size=...)` zachowuje żądany wspólny rozmiar
  komórki, z którego planner wylicza `common_cells` na podstawie dokładnych
  granic wspólnej domeny;
- `study.demag()` pozostaje fizycznym żądaniem oddziaływania, a planner
  wybiera `single_grid` albo `multilayer_convolution`.

`ProblemIR` i proweniencja przechowują zarówno wartości żądane przez
użytkownika, jak i rozwiązane liczności, padding, `convolution_cell_size`,
strategię, tryb oraz rodzaj transferu. Nie wolno odtwarzać żądanego
`cell_size` przez odwrotne dzielenie z zaokrąglonych liczności.

## Automatyczny wybór demagnetyzacji

`study.demag()` nie przyjmuje w normalnym skrypcie parametrów
`multilayer_convolution`, `two_d_stack` ani `three_d`.

- pojedynczy obiekt FDM wybiera `single_grid`;
- wiele obiektów FDM wybiera `multilayer_convolution`;
- wszystkie natywne siatki o jednej komórce Z pozwalają plannerowi wybrać
  `two_d_stack`;
- dowolny obiekt o więcej niż jednej komórce Z wybiera `three_d`;
- wartości rozwiązane są widoczne w planie i proweniencji.

Zaawansowane wymuszenia strategii pozostają możliwe wyłącznie przez jawny
kontrakt polityki wykonania. Nie należą do podstawowego tutorialu.

## Migracja starego API

Refaktoryzacja jest etapowa:

1. Nowy zapis staje się kanoniczny i jest jedynym zapisem emitowanym przez
   eksport skryptu oraz pokazywanym w dokumentacji.
2. `study.fdm(...)`, płaskie `fdm(...)`, `FDMGrid` i `FDMDemag` pozostają
   czasowo adapterami kompatybilności, emitują jednoznaczne ostrzeżenie o
   wycofaniu i obniżają się do tego samego IR.
3. Adapter odrzuca kombinacje, których nie da się przedstawić bez utraty
   intencji w nowym kontrakcie.
4. Usunięcie adapterów wymaga osobnej decyzji wersjonowania; nie następuje w
   tej refaktoryzacji.

Nie utrzymujemy dwóch niezależnych ścieżek planowania.

## Obsługa błędów

Błędy wskazują ścieżkę authoringową i oś, na przykład:

```text
layer_top.mesh.cell_size[x]=5e-9 m does not divide geometry size 101e-9 m;
strict mode does not resize geometry or round the grid
```

Konflikt parametrów FEM/FDM wskazuje poprawne alternatywy:

```text
layer_bottom.mesh cannot combine cell_size with maximum_element_size;
use cell_size for Cartesian FDM or element-size bounds for FEM
```

## Testy akceptacyjne

1. Python DSL eksportuje i round-tripuje oba przykłady FEM/FDM.
2. `body.mesh(cell_size=...)` ma pierwszeństwo przed wartością defaults.
3. Niepełna mapa per-obiekt kończy się błędem bez fallbacku.
4. Anizotropowe `2 x 2 x 10 nm` daje oczekiwane liczności natywne.
5. Różne siatki `2 x 2 x 10 nm` i `5 x 5 x 10 nm` z domeną
   `2 x 2 x 2.5 nm` planują `push_pull` i `three_d`.
6. Testy momentu, adjointności, wzajemności objętościowej i energii obejmują
   niezagnieżdżony stosunek 5/2.
7. CPU FP64 pozostaje oraklem; CUDA FP64 przechodzi parity, a FP32 zachowuje
   istniejące bramki kwalifikacji.
8. Plan, artefakty i v2 resource publikują requested/resolved cell sizes,
   liczności i transfer kind.
9. Stare API przechodzi testy adaptera i ostrzeżeń migracyjnych.
10. Angielska dokumentacja nie zawiera kanonicznych przykładów ze starym
    `study.fdm(...)`, `FDMGrid` ani `FDMDemag`.

## Kryteria zakończenia

Zmiana jest zakończona dopiero po przejściu testów Python, serializacji IR,
plannera, CPU, CUDA objętych zmianą, API/proweniencji, walidatorów dokumentacji
oraz builda publikacyjnego. Sam poprawny wygląd DSL nie stanowi zakończenia.
