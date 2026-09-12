# Plan implementacji: korekta FEM Fredkin–Koehler i kontraktu Poisson–Robin

## Cel i zasady

Naprawić kontrakty wskazane w audytach dla FEM/BEM oraz filmu `500 x 500 x 10
nm`, zachowując bieżące niepowiązane zmiany w checkoutcie. Wszystkie raporty i
artefakty opisujemy po polsku. Kod FEM budujemy i uruchamiamy przez właściwy
recipe `just`; hostowe polecenia są wyłącznie diagnostyczne.

Nie zmieniamy capability FK na GPU, nie dodajemy H2/FMM i nie uznajemy testu
jednostkowego za walidację fizyczną. Każda nieposiadana ścieżka dowodowa ma
status `NOT VERIFIED`.

## Kolejność

### 1. Dokumentacja przed kodem

- [x] Dodać niniejszy plan i specyfikację.
- [x] Zaktualizować `docs/physics/fem_demag_fem_bem.md` do bieżących ścieżek
  `backends/fem`, z równaniami FK, tabelami symboli/SI, kontraktem P1/TET4,
  mapą Python/ProblemIR/planner/runtime, macierzą czterech lane’ów,
  ograniczeniami i walidacją.
- [x] Dodać
  `docs/physics/fem_demag_fem_bem.source-map.json` z mapowaniem każdej tezy
  do pliku i symbolu.

Weryfikacja: walidator dokumentacji physics przeszedł; końcowy
`git diff --check --` pozostaje bramką z kroku 8.

### 2. Testy RED

[x] Zmodyfikować `backends/fem/tests/demag_fem_bem_contract.cpp` i zachować
istniejące testy źródłowego podziału modułów. Dodać przypadki:

- niepełny, zduplikowany, wewnętrzny i nadmiarowy jawny zbiór faset;
- permutacja/odwrócenie kompletnych faset;
- trójkątny nie-manifold z trzema właścicielami;
- brakujące lub niespójne `cell_types`, `cell_offsets`, `cell_nodes` i maski;
- aktywny nie-TET4 oraz zdublowany węzeł elementu;
- skala `1e-100` i `1e100`, degeneracja oraz wartości niefinitywne;
- limit dense BEM przed alokacją;
- dwa rozspojone aktywne tetraedry i dwa niezależne gauge DOF.

Przed zmianą implementacji uruchomiono RED przez zarządzany target, ale ten
przebieg zatrzymał się na istniejącym błędzie inicjalizacji CUDA/Hypre przed
uruchomieniem kontraktu FK. Niezależny target FK potwierdził RED nowych
asercji, a po implementacji przeszedł GREEN.

```text
just --shell 'C:\Program Files\Git\bin\bash.exe' --shell-arg -lc verify-fem-demag-poisson-contract-focused
```

Pełne rozdzielenie RED od awarii środowiska zachowano w diagnostyce targetu
FK; kanoniczny przebieg nadal ma status środowiskowo zablokowany.

### 3. Powierzchnia i geometria

Stan: [x] Walidacja typed CSR, TET4, dokładnego zbioru faset, orientacji,
zamknięcia powierzchni i tolerancji względnej została zaimplementowana; testy
kontraktowe przechodzą w izolowanym targetcie FK.

W `demag_fem_bem_surface.*`:

1. walidować długości typed CSR i skończoność geometrii;
2. ograniczyć aktywne elementy do TET4/P1 i nie ufać samemu płaskiemu
   `cell_nodes`;
3. zbudować kanoniczny zbiór `count == 1`, odrzucić `count > 2`;
4. dla jawnych faset wymusić dokładną równość zbioru zewnętrznego;
5. orientować fasety względem wierzchołka przeciwległego;
6. sprawdzić krawędzie, orientacje i linki wierzchołków;
7. zastąpić stałe `1e-300` tolerancją względną względem bounding-box;
8. zwracać opisany błąd zamiast pustego/zerowego wyniku w przypadku
   niemożliwej geometrii.

Weryfikacja: testy powierzchni przechodzą; `git diff --check --` pozostaje
bramką końcową.

### 4. Gauge i przestrzeń MFEM

Stan: [x] Jednoznaczne mapowanie P1 node→true DOF, gauge dla każdej aktywnej
składowej oraz wielogauge RHS są zaimplementowane i objęte testami.

W `demag_fem_bem_workspace.*` i `demag_fem_bem_rhs.*`:

- wymagać `fe_order == 1`, `TET4`, zgodności liczby DOF z węzłami i braku
  niejawnej redukcji, zanim zostanie użyte mapowanie node→true DOF;
- znaleźć składowe aktywnego grafu elementów i wybrać stabilny węzeł gauge z
  każdej składowej;
- zastosować wszystkie gauge w operatorze Neumanna;
- przekazywać listę gauge do RHS i wyzerować dokładnie tę listę;
- odrzucić nieposortowaną, zdublowaną lub poza zakresem listę.

Weryfikacja: test rozspojonego magnetyka, test RHS i izolowany target
kontraktowy przechodzą.

### 5. Dense reference guard

Stan: [x] Limit przed alokacją, kontrola przepełnień/`bad_alloc` i błędy
geometryczne zamiast cichych zer są zaimplementowane.

W `demag_fem_bem_operator.*`:

- dodać limit `dense_reference_max_boundary_nodes` z kontrolą przed
  `matrix_.assign`;
- sprawdzić przepełnienie `N*N`, rozmiar bajtów i `std::bad_alloc`;
- zmienić pomocnicze obliczenia solid angle/Lindholma tak, aby niefinityczne
  lub geometrycznie niemożliwe dane kończyły się błędem;
- zachować O(N²) wyłącznie jako referencję walidacyjną i zwracać komunikat z
  alternatywą Poisson-airbox po przekroczeniu limitu.

Weryfikacja: test limitu przed alokacją oraz testy niefinitycznej i
degenerowanej geometrii przechodzą w izolowanym targetcie FK.

### 6. Kontrakt Poisson–Robin

Stan: [x] Dokumentacja i istniejący kontrakt planner/runtime zachowują jawne
mixed-P1 dla `prism6+pyramid5+tet4`, wymagają all-tet dla P2 i nie deklarują
kwalifikacji filmu bez artefaktu.

Nie zmieniać ogólnej semantyki mieszanego P1. Uzupełnić dokumentację i test
kontraktu tak, aby:

- mieszany `prism6+pyramid5+tet4` był opisany jako P1 z jawnym ograniczeniem;
- żądanie ścieżki dokładności P2 wymagało all-tet i odrzucało piramidę przed
  native downgrade;
- metadata/provenance rozróżniały `potential_order=1` mixed-P1 od all-tet P2;
- nie powstał claim, że film 500 nm ma poprawną energię bez świeżego artefaktu.

Weryfikacja: kontrakt źródłowy i testy Poisson są obecne; wykonanie pełnego
targetu zostało zablokowane przed tą fazą przez CUDA/Hypre. Aktualny artefakt
filmu/FK nie jest ważnym dowodem i pozostaje `NOT VERIFIED`.

### 7. Walidacja zarządzana i fizyczna

Stan: [x] Kanoniczna kompilacja i próba runtime zostały wykonane. Kompilacja
przeszła, runtime jest zablokowany przez CUDA/Hypre, a fizyczny CSV zawiera
`NaN`; wszystkie niepotwierdzone lane’y są jawnie `NOT VERIFIED`.

Uruchomić:

```text
just --shell 'C:\Program Files\Git\bin\bash.exe' --shell-arg -lc verify-fem-demag-poisson-contract-focused
```

Następnie, tylko jeśli środowisko i wejścia są dostępne, uruchomić
`tests/fem_demag_validation/fem_bem_body_validation.py` przez zarządzaną
ścieżkę FEM CPU. Sprawdzić skończoność CSV, konwergencję i porównanie
analityczne. NaN, brak runtime albo brak aktualnej tożsamości źródła oznacza
`NOT VERIFIED`, a nie PASS.

Osobno oznaczyć:

- FK GPU device-resident: `NOT VERIFIED`;
- H2/FMM: `NOT VERIFIED`;
- film 500×500×10 nm względem FDM/MuMax3: `NOT VERIFIED` do czasu świeżnego
  all-tet/P2 lub innego zatwierdzonego artefaktu.

Stan: [ ] Kanoniczna walidacja zarządzana wymaga naprawy dostępności
CUDA/Hypre; istniejący CSV body-only FK zawiera `NaN`, więc nie spełnia bramki
fizycznej.

### 8. Finalny przegląd

- [x] `git diff --check --`.
- [x] `git status --short` i diff ograniczony do plików zadania oraz nowych
  dokumentów; nie naruszać istniejących zmian.
- [x] powtórzyć kanoniczny target po zmianach kodu; kompilacja wszystkich
  targetów przeszła, lecz wykonanie zatrzymało się na CUDA/Hypre.
- [x] sprawdzić, że raport końcowy nie twierdzi o kwalifikacji GPU ani fizyki
  bez receipts.

Commit, push, merge i czyszczenie checkoutu są poza planem.
