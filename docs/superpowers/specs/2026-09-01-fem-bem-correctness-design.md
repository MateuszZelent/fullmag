# Projekt: korekta kontraktu FEM Fredkin–Koehler i Poisson–Robin

**Status:** zaakceptowany do wykonania w ramach żądania `wykonaj poprawki`
**Data:** 2026-09-01
**Zakres:** FEM CPU, kontrakt powierzchni BEM, operator referencyjny, gauge
  Neumanna, jawny kontrakt rzędu/topologii Poisson–Robin oraz walidacja

## Cel

Usunąć błędy kontraktowe wskazane w audycie Fredkina–Koehlera oraz oddzielić
wykonalność kodu od dowodu fizycznej poprawności filmu `500 x 500 x 10 nm`.
Zmiana ma zakończyć się kodem działającym w kanonicznym container-backed
recipe `just`, testami kontraktowymi i aktualną dokumentacją naukową.

## Ustalenia

1. Powierzchnia BEM jest dokładnym zbiorem zewnętrznych ścian aktywnych
   elementów magnetycznych. Jawnie dostarczone fasety muszą być kompletne,
   bez duplikatów, bez faset wewnętrznych i bez dodatkowych faset. Wygenerowana
   powierzchnia musi być zamknięta topologicznie: każda krawędź występuje dwa
   razy, orientacje są przeciwne, a link wierzchołka nie jest rozspojony.
2. Aktualna realizacja FK pozostaje jawnie ograniczona do `tet4`, skalarnego
   P1 i FEM CPU. Inna topologia, niezgodna struktura CSR lub inny rząd kończy
   się błędem przed złożeniem operatora. Nie rozszerzamy w tej zmianie FK na
   `prism6`, `pyramid5`, P2 ani GPU.
3. Problem Neumanna otrzymuje jeden stopień swobody gauge na każdą spójną
   składową aktywnego magnetyka, a nie arbitralnie tylko pierwszy węzeł.
4. Tolerancje geometrii są względne względem skali siatki. Odległość,
   orientacja, pole i objętość muszą być skończone; niemożliwe przypadki nie
   mogą być kodowane jako ciche zero.
5. Gęsty operator BEM jest referencją walidacyjną. Przed alokacją sprawdza
   limit liczby węzłów, przepełnienie rozmiaru i budżet bajtów. Przekroczenie
   zwraca kontrolowany błąd z żądanym rozmiarem i wskazaniem ścieżki Poisson z
   airboxem. H2/FMM nie jest częścią tej poprawki.
6. Mieszany Poisson `prism6+pyramid5+tet4` pozostaje świadomie kontraktem P1.
   Ścieżka dokładności P2 jest osobnym eksperymentem all-tet i odrzuca
   piramidy przed potencjalnym downgrade. Nie deklarujemy naprawy błędu
   `E_demag` bez świeżego artefaktu zbieżności.

## Rozważone warianty

- **Naprawa minimalna w istniejących modułach** — wybrana. Zachowuje ABI,
  istniejący podział `surface/operator/workspace/rhs` i ogranicza ryzyko
  regresji.
- **Pełne przeniesienie do nowego backend-neutralnego modelu BEM** — odrzucone
  w tym kroku; wymagałoby migracji runtime i nie jest potrzebne do usunięcia
  wykazanych błędów.
- **Natychmiastowe H2/FMM lub ścisły GPU FK** — odroczone. Bez niezależnego
  orakla CPU i limitów referencji zwiększałoby powierzchnię błędu, a nie
  dostarczało dowodu produkcyjnego.

## Kryteria akceptacji

- testy odrzucają niekompletne, zduplikowane, wewnętrzne i niezamknięte fasety;
- testy akceptują kompletny zbiór faset po permutacji i odwróceniu orientacji;
- testy odrzucają nieobsługiwany typ/układ elementów i wadliwe bufory;
- ta sama geometria przeskalowana w dół i w górę przechodzi, a degeneracja
  kończy się błędem;
- każda składowa magnetyczna ma własny gauge i RHS zeruje dokładnie te DOF-y;
- limit gęstego operatora jest sprawdzany przed alokacją, a błąd jest
  deterministyczny;
- kontrakt Poisson jawnie publikuje P1 dla mieszanego airboxa i all-tet P2 jako
  oddzielną, fail-closed ścieżkę;
- kanoniczny target `fem_demag_fem_bem_contract` przechodzi przez `just`;
- brak dowodu dla FK GPU, H2/FMM i fizycznej zgodności filmu pozostaje
  oznaczony `NOT VERIFIED`, a nie awansem capability.

## Właściciele zmian

| Warstwa | Plik / symbol | Odpowiedzialność |
|---|---|---|
| powierzchnia | `backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp`, `build_demag_boundary_surface` | walidacja CSR, zbiór faset, zamknięcie i skala |
| operator | `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp`, `DenseDemagBemOperator::build` | względna geometria, kontrola rozmiaru i błędy numeryczne |
| workspace | `backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp` | P1/TET4 i komponenty gauge |
| RHS | `backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp`, `prepare_demag_fem_bem_neumann_rhs` | zerowanie wszystkich gauge DOF |
| test | `backends/fem/tests/demag_fem_bem_contract.cpp` | RED/GREEN dla kontraktów i regresji |
| Poisson | `crates/fullmag-plan/src/fem.rs`, `demag_poisson_lifecycle.cpp` | jawny kontrakt P1/P2 bez cichego downgrade |
| dokumentacja | `docs/physics/fem_demag_fem_bem.md` i source map | równania, jednostki, ograniczenia i dowód |

## Poza zakresem

Nie implementujemy w tej zmianie ścisłego device-resident FK GPU, kompresji
H2/FMM, automatycznej adaptacji siatki, naprawy jakości meshera ani promowania
wyników filmu do `physics_validated` lub `production_qualified`. Te lane’y
pozostają jawnie niezweryfikowane.
