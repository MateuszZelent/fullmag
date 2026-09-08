# Audyt implementacji demagnetyzacji FEM Fredkin–Koehler bez airboxu

**Data:** 1 września 2026  
**Repozytorium:** `MateuszZelent/fullmag`  
**Audytowany commit `master`:** `ed1fd1c7d2513ea2f7f6e12ddb2d4f3e2fc6a267`  
**Zakres:** natywna ścieżka FEM CPU/MFEM Fredkin–Koehler, jej kontrakt publiczny i runner, przygotowanie do strict GPU/CUDA oraz wąskie otoczenie współdzielonych operatorów Poissona.  
**Rodzaj dowodu:** audyt statyczny kodu, testów i dokumentacji. W ramach tego audytu nie uruchomiono zarządzanego obrazu FEM, benchmarków ani symulacji walidacyjnych na CPU/GPU. Twierdzenia o działaniu runtime pozostają ograniczone do tego, co wynika z kodu i istniejących testów.

Powiązane dokumenty:

- [plan ogólny](../plans/active/fem-fredkin-koehler-cpu-gpu-general-plan-2026-09-01.md),
- [szczegółowy playbook wdrożenia i refaktoryzacji](../plans/active/fem-fredkin-koehler-cpu-gpu-implementation-playbook-2026-09-01.md),
- [kanoniczna nota fizyczna FEM/BEM](../physics/0870-fem-bem-demag-open-boundary.md),
- [opis bieżącego modułu](../physics/fem_demag_fem_bem.md).

---

## 1. Werdykt wykonawczy

### 1.1. Odpowiedź na pytanie „czy implementacja CPU jest poprawna?”

**Rdzeń algorytmu jest zasadniczo zgodny z metodą Fredkina–Koehlera, ale bieżącej implementacji CPU nie można jeszcze uznać za fizycznie zwalidowaną ani produkcyjnie poprawną dla pełnego deklarowanego zakresu.**

Dla wąskiego przypadku:

- jedna spójna składowa magnetyczna,
- domknięty, orientowalny, zgodny objętościowo brzeg,
- siatka `TET4`,
- przestrzeń skalarna `H1/P1`,
- nieperiodyczna geometria,
- dobrze uwarunkowane trójkąty powierzchniowe,
- rozmiar granicy mieszczący gęstą macierz `O(N_b^2)`,

kod realizuje właściwy schemat:

1. rozwiązuje problem Neumanna dla `u1`,
2. stosuje operator całkowy Lindholma na śladzie `u1`,
3. rozwiązuje harmoniczną korektę Dirichleta `u2`,
4. odzyskuje `H_demag = -grad(u1 + u2)`,
5. oblicza energię `E_demag = -mu0/2 ∫ M·H_demag dV`.

Znaki słabej formy, członu diagonalnego operatora granicznego, rekonstrukcji pola i energii są spójne z deklarowaną konwencją Fullmag.

Jednocześnie znaleziono dwa blokery poprawności dla konfiguracji, które nie są obecnie jednoznacznie odrzucone:

1. **Niepełny lub zduplikowany zestaw `facet_nodes` może zostać zaakceptowany jako pełna powierzchnia BEM.** Kod weryfikuje każdą podaną ścianę osobno, ale nie porównuje zbioru z pełnym zewnętrznym brzegiem magnetyka.
2. **Problem Neumanna otrzymuje tylko jeden przypięty DOF.** Dla `C > 1` rozłącznych składowych magnetycznych macierz ma co najmniej `C` niezależnych modów stałych; jedno przypięcie pozostawia `C-1` zerowych modów i nie zapewnia jednoznacznego rozwiązania.

Ponadto nie istnieje zamykający zestaw walidacyjny: kula, elipsoida/prostopadłościan, zbieżność `h`, pochodna kierunkowa energii, porównanie z ekstrapolowanym airboxem oraz parity z niezależnym solverem. Dlatego rekomendowany status zdolności to:

```text
CPU dense Fredkin–Koehler:
  source_present
  planner_legal
  public_executable
  reference_executable
  NOT physics_validated
  NOT production_executable
```

### 1.2. Odpowiedź na pytanie o GPU

**Strict, device-resident Fredkin–Koehler GPU nie jest obecnie zaimplementowany.**

Bieżący strict GPU operator Poissona jawnie odrzuca `FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER`. Istnieje kompatybilnościowa ścieżka hybrydowa, która:

```text
m_device -> download do hosta
         -> CPU Fredkin–Koehler
         -> upload H_demag na urządzenie
```

Może ona służyć jako oracle przejściowy, ale nie jest implementacją GPU i nie powinna być raportowana jako taka. W każdym etapie RK płaci koszt transferu całego pola magnetyzacji oraz pola demagnetyzującego, a gęsty BEM i oba solve’y pozostają hostowe.

---

## 2. Kanoniczny model fizyczny i dyskretny

Niech `Omega_m` będzie obszarem magnetycznym, `Gamma = ∂Omega_m`, a

\[
\mathbf M = M_s \mathbf m
\]

magnetyzacją w `A/m`. Potencjał skalarny ma jednostkę `A`, ponieważ

\[
\mathbf H_\mathrm{demag} = -\nabla u
\]

ma jednostkę `A/m`.

W metodzie Fredkina–Koehlera potencjał rozdziela się na

\[
u = u_1 + u_2.
\]

### 2.1. Problem Neumanna

\[
\Delta u_1 = \nabla\cdot\mathbf M
\quad\text{w }\Omega_m,
\qquad
\partial_n u_1 = \mathbf M\cdot\mathbf n
\quad\text{na }\Gamma.
\]

Po całkowaniu przez części słaba postać używana w Fullmag ma postać

\[
\int_{\Omega_m}\nabla u_1\cdot\nabla v\,dV
=
\int_{\Omega_m}\mathbf M\cdot\nabla v\,dV.
\]

`demag_poisson_rhs.cpp` składa dokładnie prawą stronę `∫ M·grad(v)` przez `DomainLFGradIntegrator`, a `demag_fem_bem_rhs.cpp` narzuca obecnie gauge przez wyzerowanie jednego wpisu RHS.

### 2.2. Operator graniczny i harmoniczna korekta

Na granicy wyznaczany jest ślad

\[
g = \mathcal B_\Gamma(u_1|_\Gamma),
\]

gdzie `B_Gamma` jest operatorem podwójnej warstwy. Dla kolokacji w węzłach powierzchni i liniowych funkcji kształtu człon diagonalny ma postać

\[
\frac{\Omega_i}{4\pi} - 1,
\]

a składniki poza diagonalą są całkami Lindholma po trójkątach.

Następnie:

\[
\Delta u_2 = 0
\quad\text{w }\Omega_m,
\qquad
u_2 = g
\quad\text{na }\Gamma.
\]

`prepare_demag_fem_bem_dirichlet_rhs(...)` tworzy lifting przez:

\[
b_2 = -A g,
\]

po czym nadpisuje równania brzegowe wartościami Dirichleta. Dla macierzy po eliminacji wierszy i kolumn jest to właściwa konstrukcja.

### 2.3. Pole i energia

\[
\mathbf H_\mathrm{demag}
=
-\nabla(u_1+u_2),
\]

\[
E_\mathrm{demag}
=
-\frac{\mu_0}{2}
\int_{\Omega_m}
\mathbf M\cdot\mathbf H_\mathrm{demag}\,dV.
\]

`demag_poisson_recovery.cpp` stosuje znak minus przy gradiencie potencjału, a współdzielona implementacja energii używa powyższej konwencji.

---

## 3. Mapa rzeczywistego przepływu wykonania

```text
Python:
  Demag(model="fredkin_koehler")
    |
ProblemIR / planner:
  RequestedFemDemagIR::FredkinKoehler
    -> ResolvedFemDemagIR::FredkinKoehler
    -> requires_airbox() == false
    |
Rust runner / C ABI:
  FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER
    |
backends/fem/cpu/mfem/interactions/demag.cpp
  initialize_demag_runtime()
    -> context_initialize_demag_fem_bem()
  compute_demag_field_for_magnetization()
    -> context_compute_demag_fem_bem()
    |
workspace setup:
  demag_fem_bem_surface.cpp
  demag_fem_bem_operator.cpp
  demag_fem_bem_workspace.cpp
  demag_poisson_rhs.cpp
  demag_poisson_recovery.cpp
    |
hot path:
  assemble_demag_poisson_rhs()
  solve u1
  gather u1|Gamma
  dense BEM apply
  build Dirichlet lifting
  solve u2
  u = u1 + u2
  recover H = -grad(u)
  compute E
```

### 3.1. Właściciele kodu

| Odpowiedzialność | Bieżący właściciel |
|---|---|
| dispatch realizacji | `backends/fem/cpu/mfem/interactions/demag.cpp` |
| ekstrakcja powierzchni | `demag_fem_bem_surface.hpp/.cpp` |
| gęsty operator Lindholma | `demag_fem_bem_operator.hpp/.cpp` |
| FE spaces, macierze i lifecycle | `demag_fem_bem_workspace.hpp/.cpp` |
| RHS `u1` | `demag_poisson_rhs.*` + `demag_fem_bem_rhs.*` |
| dwa solve’y skalarne | `demag_fem_bem_linear_solve.*` |
| gather/scatter i lifting `u2` | `demag_fem_bem_potential.*`, `demag_fem_bem_boundary_values.*` |
| orkiestracja kroku | `demag_fem_bem_solve.*` |
| odzyskanie pola | `demag_poisson_recovery.*` |
| energia | `demag_poisson_energy.*`, cienki wrapper `demag_fem_bem_energy.*` |
| telemetria | `demag_fem_bem_telemetry.*` |
| strict GPU Poisson | `backends/fem/gpu/cuda/demag_poisson/*` |
| dispatch etapów GPU RK | `backends/fem/gpu/cuda/integrators/rk/rk_demag_dispatch.cu` |

---

## 4. Co jest wykonane poprawnie

### 4.1. Rozdział odpowiedzialności

Moduł nie został dopisany bezpośrednio do dużego mostu ABI. Powstały osobne pliki dla:

- powierzchni,
- operatora granicznego,
- workspace,
- RHS,
- solvera,
- wartości brzegowych,
- potencjału,
- odzyskania pola,
- energii,
- telemetrii.

To jest dobra baza do refaktoryzacji CPU/GPU bez duplikowania fizyki.

### 4.2. Brak airboxu

Ścieżka Fredkin–Koehler nie tworzy zewnętrznej objętości powietrza. Operator zewnętrzny jest reprezentowany na `Gamma`, zgodnie z intencją metody.

### 4.3. Znak i skala RHS

`DomainLFGradIntegrator` składa:

\[
b_i = \int_{\Omega_m}\mathbf M\cdot\nabla\phi_i\,dV.
\]

Nie znaleziono odwrócenia znaku względem przyjętego równania `Delta u1 = div M`.

### 4.4. Formuła Lindholma i człon diagonalny

Kod oblicza:

```text
edge_len[next] / (8*pi*area)
  * (eta0[next] * Omega - chi0 * gamma_times_log[i])
```

co jest algebraicznie zgodne z opublikowaną formułą Lindholma i referencyjną implementacją Tetmag dla regularnych, nieosobliwych przypadków. Diagonalę ustawia jako:

```text
omega_sum / (4*pi) - 1
```

co odpowiada operatorowi Fredkina–Koehlera.

### 4.5. Orientacja pojedynczej poprawnej ściany

Dla ściany należącej do jednego tetraedru normalna jest ustawiana na zewnątrz przez test iloczynu z wektorem do przeciwległego wierzchołka. Ten lokalny mechanizm jest poprawny dla prawidłowej objętościowej siatki tetraedralnej.

### 4.6. Dirichlet lifting

Kod liczy pełne `-A*g`, następnie zastępuje wpisy brzegowe przez `g`, a solve odbywa się na macierzy z wyeliminowanymi wierszami i kolumnami. To jest poprawny wzorzec dla niezerowych warunków Dirichleta.

### 4.7. Odrzucenie niezbieżnego solve’a

Bieżący kod:

- odczytuje status solvera,
- liczy niezależnie residual `A*x-b`,
- sprawdza residual względny i bezwzględny,
- publikuje kandydata dopiero po przejściu walidacji.

To jest istotna poprawa względem starszego ustalenia audytowego i nie należy jej usuwać podczas refaktoryzacji GPU.

### 4.8. Reuse solverów i warm start

Dla ścieżki Hypre przechowywane są osobne cache dla `u1` i `u2`, obejmujące operator, preconditioner, solver i wektory. `u1/u2` są ponownie używane jako initial guess, chyba że wymagany jest świeży start.

---

## 5. Ustalenia wymagające naprawy

## 5.1. `FK-CPU-COR-001` — niepełna powierzchnia caller-a jest akceptowana

**Priorytet:** P0  
**Właściciel:** `demag_fem_bem_surface.cpp::build_demag_boundary_surface`

Jeśli `ctx.mesh.facet_nodes` jest niepuste, kod:

1. sprawdza, czy każda podana ściana istnieje,
2. sprawdza, czy ma `count == 1`,
3. dodaje ją do operatora.

Nie wykonuje jednak:

```text
canonical_set(supplied_facets)
  == canonical_set(all exterior magnetic faces)
```

Skutki:

- jedna poprawna ściana tetraedru może udawać cały brzeg,
- brak jednej ściany nie jest wykrywany,
- zduplikowana ściana może zostać dodana wielokrotnie,
- operator BEM odpowiada innej geometrii niż objętościowy FEM,
- wynik może być skończony, lecz fizycznie błędny.

**Wymagana poprawka:**

- wyprowadzić dokładny kanoniczny zbiór zewnętrznych `FaceKey`,
- odrzucić `missing`, `extra`, `duplicate`, `interior`,
- pozwolić na dowolną kolejność i wejściowy winding, następnie kanonizować orientację,
- zapisać w provenance `boundary_source=derived|caller_verified`.

## 5.2. `FK-CPU-COR-002` — jeden gauge nie obsługuje wielu rozłącznych obiektów

**Priorytet:** P0  
**Właściciele:** `demag_fem_bem_workspace.cpp`, `demag_fem_bem_rhs.cpp`

Kod wykonuje:

```cpp
EliminateRowCol(0);
rhs[0] = 0.0;
```

To usuwa jeden globalny mod stały. Dla `C` rozłącznych składowych domeny macierz Laplace’a Neumanna ma `C` niezależnych stałych. W rezultacie:

- przy `C > 1` pozostaje `C-1` modów zerowych,
- PCG/AMG może nie zbiegać się lub zwracać rozwiązanie zależne od szczegółów solvera,
- deklarowana zaleta metody dla wielu oddzielnych magnetyków nie jest realizowana.

**Wymagana poprawka:**

- wykryć spójne składowe objętościowej siatki magnetycznej,
- utworzyć gauge dla każdej składowej:
  - wariant referencyjny: jeden stabilny true DOF na składową,
  - wariant docelowy: constraint średniej ważonej masą `∫_{Omega_c}u1 dV=0`,
- gauge musi być częścią fingerprintu operatora i provenance,
- testować dwa oddzielne ciała oraz interakcję wzajemną przez wspólny operator BEM.

## 5.3. `FK-CPU-COR-003` — „watertight” jest deklarowane, ale nie dowodzone

**Priorytet:** P1  
**Właściciel:** `demag_fem_bem_surface.cpp`

Dla automatycznie wyprowadzanej powierzchni:

- ściany o `count == 1` są dodawane,
- ściany o `count > 2` nie powodują błędu; są po prostu pomijane,
- nie ma walidacji, że każda krawędź powierzchni występuje dokładnie dwa razy,
- nie ma testu orientowalności i spójności wachlarza wierzchołka,
- komunikat „requires a watertight exterior” wynika tylko z niepustości.

**Wymagana poprawka:**

- `volume_face_incidence ∈ {1,2}`, każda wartość `>2` ma failować,
- `surface_edge_incidence == 2`,
- jawny raport liczby składowych powierzchni, genus opcjonalnie,
- walidacja zgodności normalnych z objętością.

## 5.4. `FK-CPU-COR-004` — ukryte założenie płaskiego `TET4/P1`

**Priorytet:** P1  
**Właściciele:** `demag_fem_bem_surface.cpp`, `demag_fem_bem_operator.cpp`, `demag_fem_bem_workspace.cpp`

Kod indeksuje:

```text
cell_nodes[elem*4 + local]
```

i mapuje:

```text
boundary node id == potential true DOF id
```

Planner obecnie ogranicza FEM do `fe_order=1`, ale natywny subsystem powinien sam odrzucić:

- `PRISM6`,
- `PYRAMID5`,
- mieszane topologie,
- niezgodne `cell_offsets`,
- `fe_order != 1`,
- niestandardowe ograniczenia true DOF.

Brak defensywnego kontraktu utrudnia późniejsze wsparcie swept-prism, high-order i MPI.

## 5.5. `FK-CPU-NUM-001` — absolutne tolerancje geometrii i ciche zerowanie wag

**Priorytet:** P1  
**Właściciel:** `demag_fem_bem_operator.cpp`

Bieżące stałe:

```text
kVertexCoincidenceTol2 = 1e-48
kAreaEps = 1e-300
```

nie są skalowane względem średnicy modelu, długości krawędzi ani precyzji maszynowej.

Dodatkowo dla:

- zerowej krawędzi,
- niedodatniego argumentu logarytmu,
- niedodatniego mianownika,

rutyna wag zwraca `{0,0,0}` bez przekazania błędu. Taki fallback może ukryć degenerację lub katastrofalną utratę cyfr.

**Wymagana poprawka:**

- znormalizować geometrię roboczo przez długość charakterystyczną albo używać tolerancji względnych,
- rozdzielić przypadek analitycznie osobliwy od numerycznie niepoprawnego,
- zwracać status i diagnostykę z numerem wiersza/ściany,
- dodać stabilne `log1p`/przekształcenia dla bliskich konfiguracji,
- wykonać testy skali od nm do µm bez zmiany bezwymiarowego wyniku.

## 5.6. `FK-CPU-VAL-001` — brak kwalifikacji fizycznej

**Priorytet:** P1

Obecny test sprawdza głównie:

- istnienie symboli i granice modułów,
- ekstrakcję powierzchni jednego tetraedru,
- skończoność macierzy,
- relację operatora dla stałego wektora,
- znak wspólnego helpera energii,
- odrzucenie wymuszonej niezbieżności.

Nie sprawdza pełnego rozwiązania `m -> H_demag, E_demag`.

Minimalny brakujący zestaw:

1. `M=0` — pole i energia równe zero.
2. Kula, jednorodne `M` — średnie pole `-M/3`.
3. Elipsoida — trzy analityczne współczynniki demagnetyzacji.
4. Prostopadłościan — porównanie energii/średniego pola z analityką lub wysokiej jakości referencją.
5. `h`-refinement — zbieżność pola i energii.
6. Translacja, rotacja i jednolite skalowanie geometrii.
7. Dwa rozłączne obiekty — samopole i pole wzajemne.
8. Pochodna kierunkowa energii:
   \[
   \frac{E(m+\epsilon\delta m)-E(m-\epsilon\delta m)}{2\epsilon}
   \approx
   -\mu_0\int M_s H_\mathrm{demag}\cdot\delta m\,dV.
   \]
9. Porównanie z airboxem `2x/4x/8x` i ekstrapolacją do nieskończonego paddingu.
10. Niezależna fixture Tetmag, generowana zewnętrznie; bez kopiowania kodu AGPL.

## 5.7. `FK-CPU-MEM-001` — brak limitu gęstego operatora

**Priorytet:** P1  
**Właściciel:** `DenseDemagBemOperator::build`

Macierz wymaga co najmniej:

\[
M_\mathrm{dense} = 8N_b^2\ \mathrm{bytes}
\]

dla samych wartości `double`. Przykładowo, bez uwzględnienia pozostałych danych:

| `N_b` | sama macierz |
|---:|---:|
| 10 000 | ok. 0,8 GB |
| 25 000 | ok. 5,0 GB |
| 50 000 | ok. 20,0 GB |
| 100 000 | ok. 80,0 GB |

Kod wykonuje `matrix_.assign(N_b*N_b, 0.0)` bez:

- overflow-safe sizing,
- budżetu pamięci,
- cap-u referencyjnego,
- kontrolowanego wyboru operatora skompresowanego.

**Wymagana poprawka:**

- policzyć bytes z kontrolą przepełnienia,
- wprowadzić `dense_reference_max_boundary_dofs` i/lub `max_memory_bytes`,
- ustalać cap na podstawie jawnego benchmarku i budżetu runtime,
- failować przed alokacją z propozycją `h2`/`fmm` albo airboxu,
- raportować `N_b`, bytes, setup time i mode.

## 5.8. `FK-CPU-PERF-001` — hot path wykonuje pracę zależną tylko od siatki

**Priorytet:** P1

W każdym odświeżeniu demag:

- RHS jest ponownie składany elementowo przez MFEM,
- tworzony jest lokalny `rhs_neumann`,
- tworzone są `u1_boundary` i `u2_boundary`,
- wykonywany jest pełny sparse matvec dla liftingu `-A*g`,
- recovery ponownie oblicza gradienty tetraedrów,
- nodalna akumulacja recovery używa atomików OpenMP,
- energia wykonuje kolejne przejście po danych.

Ponieważ wszystkie te operatory są liniowe względem bieżącego `m` lub `u`, należy preasemblować:

\[
b_1 = B_x M_x + B_y M_y + B_z M_z,
\]

\[
\mathbf H = -R u.
\]

Docelowo `B_x/B_y/B_z` i `R_x/R_y/R_z` powinny być jednymi współdzielonymi operatorami CPU/GPU, zbudowanymi raz na niezmiennej siatce.

## 5.9. `FK-CPU-PERF-002` — ręczny GEMV zamiast wyspecjalizowanego backendu

**Priorytet:** P1

`DenseDemagBemOperator::apply` wykonuje ręczną pętlę `O(N_b^2)` z OpenMP. Dla operatora referencyjnego lepsze są:

- `cblas_dgemv` / oneMKL / OpenBLAS na CPU,
- trwały, wyrównany bufor,
- rozsądne blokowanie NUMA,
- opcjonalnie batched apply, jeśli kilka wektorów ma być ocenianych razem.

Nie rozwiązuje to złożoności, ale daje szybszy oracle i poprawne zarządzanie wątkami BLAS bez oversubscription z OpenMP/Hypre.

## 5.10. `FK-CPU-PERF-003` — brak rzeczywistego MPI i NUMA

**Priorytet:** P2

`HypreParMatrix` jest opakowaniem pełnej macierzy na `fullmag_serial_comm()`. Nie ma:

- `ParMesh`,
- `ParFiniteElementSpace`,
- rozdzielonych true DOF,
- halo,
- rozdzielonego operatora granicznego.

To jest poprawna ścieżka jednorankowa, nie solver wielowęzłowy. Dla CPU produkcyjnego należy najpierw zakończyć shared-memory/H2, a dopiero potem zdefiniować MPI decomposition FEM i distributed H2/FMM.

## 5.11. `FK-CPU-ROB-001` — częściowa inicjalizacja nie jest failure-atomic

**Priorytet:** P2  
**Właściciel:** `initialize_demag_fem_bem_workspace`

`workspace` jest lokalnym `unique_ptr`, ale współdzielone:

- `initialize_demag_poisson_rhs_workspace(ctx, ...)`,
- `initialize_demag_poisson_recovery_workspace(ctx, ...)`

modyfikują `ctx`. Po ich sukcesie późniejsze zwykłe `return false` nie wywołuje `destroy_demag_fem_bem_workspace(ctx)`, ponieważ cleanup znajduje się dopiero po blokach `catch`.

Należy zastosować lokalny transaction/RAII guard i publikować wszystkie wskaźniki w `Context` dopiero po pełnym sukcesie.

## 5.12. `FK-CPU-ARCH-001` — workspace jest związany z konkretną macierzą dense

**Priorytet:** P1

`DemagFemBemWorkspace` posiada bezpośrednio `DenseDemagBemOperator`. To utrudnia:

- `dense_cpu_reference`,
- `dense_gpu_reference`,
- `h2_cpu`,
- `h2_gpu`,
- `fmm_gpu`,
- porównanie operatorów w tym samym solve pipeline.

Potrzebny jest stabilny interfejs/factory:

```cpp
class DemagBoundaryOperator {
public:
    virtual ~DemagBoundaryOperator() = default;
    virtual bool apply(
        const BoundaryVectorView& input,
        BoundaryVectorView output,
        ExecutionContext& exec,
        std::string& error) const = 0;
    virtual DemagBoundaryOperatorInfo info() const = 0;
};
```

Interfejs musi rozróżniać host/device residency, a nie przyjmować wyłącznie `std::vector<double>`.

## 5.13. `FK-CPU-TEL-001` — telemetria maskuje koszt BEM

**Priorytet:** P2

BEM apply, gather/scatter i lifting są włączone do ogólnego `solve_ns`, natomiast publikowane `solver_apply_wall_time` obejmuje tylko solve `u1+u2`.

Brakuje:

- `bem_setup_ns`,
- `bem_apply_ns`,
- `boundary_gather_ns`,
- `dirichlet_lift_ns`,
- `bem_mode`,
- `boundary_nodes`,
- `boundary_triangles`,
- `operator_bytes`,
- `compression_ratio`,
- osobnych iteracji/residuali `u1` i `u2`,
- transfer bytes/calls dla hybrydowego GPU.

Bez tego nie da się optymalizować na podstawie dowodów.

## 5.14. `FK-GPU-CAP-001` — strict GPU nie istnieje

**Priorytet:** P1 capability

`backends/fem/gpu/cuda/demag_poisson/operators.cpp` jawnie odrzuca Fredkina–Koehlera. Publiczne raportowanie powinno rozróżniać:

```text
CPU dense reference: executable, not validated
GPU hybrid CPU FK: compatibility only
GPU strict FK: unsupported
```

Dopiero zakończenie device-resident pipeline oraz parity może promować strict GPU.

## 5.15. `FK-GPU-HYB-001` — hybrydowy fallback łamie cel all-in-GPU

**Priorytet:** P1 performance

`rk_demag_dispatch.cu` pobiera całe `m`, wywołuje CPU `compute_demag_field_for_magnetization`, po czym odsyła całe `H_demag`.

Dla `s` etapów RK koszt transferów na próbę kroku jest co najmniej:

\[
T_\mathrm{transfer}
\sim
s\left(
3N\cdot 8\ \mathrm{B}
+
3N\cdot 8\ \mathrm{B}
\right),
\]

bez uwzględnienia synchronizacji i odrzuconych prób. Ta ścieżka ma pozostać wyłącznie oracle/compatibility mode z jawną telemetrią host fallback.

---

## 6. Ocena testów

### 6.1. Co obecnie wykazują

`fem_demag_fem_bem_contract` wykazuje m.in.:

- lokalny kontrakt modułów,
- poprawną ekstrakcję czterech ścian jednego tetraedru,
- orientację normalnych dla tej fixture,
- skończoność gęstej macierzy,
- test operatora na stałym wektorze,
- odrzucenie kandydata po jednej iteracji, jeśli residual nie spełnia tolerancji,
- znak helpera energii.

### 6.2. Czego nie wykazują

Nie wykazują:

- poprawnego `H_demag` dla żadnej niezerowej magnetyzacji,
- poprawnej energii pełnego solve’a,
- zbieżności przestrzennej,
- działania wielu obiektów,
- odporności na brakującą/zduplikowaną powierzchnię,
- near-singular geometry,
- niezależności od skali i numeracji,
- CPU/GPU parity,
- ograniczenia pamięci dense,
- braku alokacji w hot path.

### 6.3. Problem testów strukturalnych

Znaczna część testu analizuje tekst źródłowy i obecność nazw funkcji. Taki test chroni modularność, ale nie może zastąpić testu numerycznego. Docelowy podział:

```text
contract/source ownership tests
  !=
numerical unit tests
  !=
manufactured-solution tests
  !=
physics validation
  !=
performance qualification
```

---

## 7. Docelowa architektura CPU/GPU

### 7.1. Warstwa wspólna, niezależna od urządzenia

```text
DemagFemBemTopology
  - canonical exterior faces
  - boundary/global maps
  - connected volume components
  - connected boundary components
  - per-component gauges
  - normals, areas, characteristic scale
  - stable topology fingerprint

DemagFemBemDiscreteOperators
  - source maps Bx, By, Bz
  - scalar stiffness A
  - Neumann constrained operator A_N
  - Dirichlet constrained operator A_D
  - boundary gather G
  - boundary scatter/lifting L
  - recovery maps Rx, Ry, Rz
  - mass/energy weights

DemagBoundaryOperator
  - dense_cpu_reference
  - dense_gpu_reference
  - h2_cpu
  - h2_gpu / fmm_gpu
```

### 7.2. Persistent workspace

```text
m
rhs1
u1
trace_u1
trace_u2
boundary_values_global
rhs2
u2
u_total
H_demag
energy partials
solver workspaces
```

Po warm-upie nie powinny występować alokacje zależne od kroku.

### 7.3. Strict GPU stage

```text
1. rhs1 = Bx*Mx + By*My + Bz*Mz              [device]
2. apply component gauges                     [device]
3. solve A_N u1 = rhs1                         [device Hypre]
4. trace_u1 = G*u1                             [device gather]
5. trace_u2 = B_Gamma(trace_u1)                [device dense/H2/FMM]
6. rhs2 = L*trace_u2                           [device]
7. solve A_D u2 = rhs2                         [device Hypre]
8. u_total = u1 + u2                           [device]
9. H = -R*u_total                              [device]
10. E = -mu0/2 <M,H>_mass                      [device reduction]
```

W strict mode w krokach 1–10 nie ma `cudaMemcpy` D2H/H2D. Host otrzymuje dane wyłącznie przy jawnie żądanym quantity/snapshocie.

---

## 8. Priorytety napraw

| Kolejność | ID | Powód |
|---:|---|---|
| 1 | `FK-CPU-COR-001` | aktualnie może powstać skończony, lecz fizycznie błędny operator |
| 2 | `FK-CPU-COR-002` | wiele obiektów pozostawia osobliwość Neumanna |
| 3 | `FK-CPU-COR-003/004` | trzeba zamknąć kontrakt topologii przed GPU |
| 4 | `FK-CPU-NUM-001` | GPU nie może utrwalić niestabilnego kernela referencyjnego |
| 5 | `FK-CPU-VAL-001` | potrzebny oracle przed optymalizacją |
| 6 | `FK-CPU-MEM-001` | dense reference musi być bezpieczny |
| 7 | `FK-CPU-ARCH-001` | dopiero abstrakcja pozwala dodać H2/GPU bez duplikacji |
| 8 | `FK-CPU-PERF-001/002` | preasemblowane operatory i szybki dense oracle |
| 9 | `FK-GPU-CAP-001` | device-resident dense reference |
| 10 | H2/FMM CPU/GPU | produkcyjna skalowalność |
| 11 | MPI | dopiero po stabilnym shared-memory/device contract |

---

## 9. Kryteria promocji statusu

### 9.1. `reference_executable -> validated_reference`

Wymagane:

- wszystkie testy topologiczne,
- gauge per component,
- kula/elipsoida/prostopadłościan,
- zbieżność `h`,
- pochodna energii,
- niezależna fixture,
- jawny dense cap,
- pełne provenance.

### 9.2. `validated_reference -> production_executable CPU`

Wymagane dodatkowo:

- operator H2/FMM z błędem względem dense oracle,
- budżet pamięci i brak niekontrolowanego `O(N_b^2)`,
- zaakceptowany benchmark cold/warm,
- wielowątkowość i NUMA,
- brak alokacji w hot path,
- stabilny solver i telemetry.

### 9.3. `unsupported strict GPU -> validated_reference GPU`

Wymagane:

- cały pipeline na device,
- dense GPU parity z dense CPU,
- zero ukrytych transferów w hot loop,
- niezależny residual na device lub kontrolowany check,
- failure atomicity,
- device memory budget/provenance.

### 9.4. `validated_reference GPU -> production_executable GPU`

Wymagane dodatkowo:

- H2/FMM GPU,
- parity z dense oracle na małych problemach,
- kontrola błędu kompresji,
- benchmark crossover CPU/GPU,
- brak regresji czasu do zadanej dokładności fizycznej.

---

## 10. Wnioski końcowe

1. Nie należy usuwać bieżącej implementacji CPU. Jest wartościowym dense oracle.
2. Nie należy nazywać jej jeszcze produkcyjnym solverem Fredkin–Koehlera.
3. Pierwsza praca implementacyjna musi dotyczyć poprawności topologii i gauge, nie GPU.
4. GPU powinien współdzielić te same preasemblowane operatory i testy, a nie kopiować aktualne pętle CPU.
5. Gęsty GPU `DGEMV` jest potrzebny jako etap referencyjny, ale nie jako rozwiązanie docelowe.
6. Produkcyjny backend wymaga H2 albo FMM; sama wielowątkowość nie usuwa `O(N_b^2)`.
7. Hybrydowy CPU fallback należy zachować jako jawny tryb kompatybilności/oracle i nigdy nie zaliczać go do strict GPU.
8. Domyślny `Demag(model="auto")` powinien pozostać na zwalidowanej ścieżce airbox, dopóki Fredkin–Koehler nie przejdzie bramek opisanych powyżej.

---

## 11. Literatura i źródła zewnętrzne

- D. R. Fredkin, T. R. Koehler, *Hybrid method for computing demagnetizing fields*, IEEE Transactions on Magnetics 26, 415–417 (1990), DOI: [10.1109/20.106342](https://doi.org/10.1109/20.106342).
- D. A. Lindholm, *Three-dimensional magnetostatic fields from point-matched integral equations with linearly varying scalar sources*, IEEE Transactions on Magnetics 20, 2025–2032 (1984), DOI: [10.1109/TMAG.1984.1063254](https://doi.org/10.1109/TMAG.1984.1063254).
- R. Hertel, S. Christophersen, S. Börm, *Large-scale magnetostatic field calculation in finite element micromagnetics with H2-matrices*, [arXiv:1811.05731](https://arxiv.org/abs/1811.05731).
- Tetmag jest używane wyłącznie jako zewnętrzna referencja/fixture generator. Jego kod jest objęty AGPL; nie należy kopiować implementacji do Fullmag bez jawnej decyzji licencyjnej.
