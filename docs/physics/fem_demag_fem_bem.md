# FEM Fredkin–Koehler: demagnetyzacja otwartej granicy

- Status: źródło zaimportowane; wykonywalny kontrakt CPU full-solve oraz smoke
  kernela i initialize→apply GPU VERIFIED; ścisły managed receipt, parity i
  walidacja fizyczna filmu 500 x 500 x 10 nm pozostają NOT VERIFIED
- Wersja dokumentu: 2026-09-02
- Zakres: body-only tet4, skalarne FEM P1, dense BEM CPU i diagnostyczny
  ACA H-matrix BEM dla CUDA/Hypre GPU
- Powiązane dokumenty: docs/physics/fem_demag_poisson.md,
  docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md,
  docs/physics/0870-fem-bem-demag-open-boundary.md,
  docs/specs/capability-matrix-v0.md
- Source map: docs/physics/fem_demag_fem_bem.source-map.json

(problem-statement)=
## 1. Problem fizyczny

Jednorodny lub niejednorodny magnetyk zajmuje domenę $\Omega_m$ bez sztucznego
airboxa. Szukane pole demagnetyzujące ma spełniać warunek otwartej przestrzeni
oraz zanikać w nieskończoności. Realizacja Fredkina–Koehlera rozdziela problem
na objętościowy problem Neumanna FEM i korektę harmoniczną wyznaczaną przez
operator całkowy na rzeczywistej granicy $\Gamma=\partial\Omega_m$.

W Fullmag jest to osobna rodzina od Poisson–Robin na domenie magnetyk + airbox.
Nie wolno utożsamiać zgodności solvera z jedną granicą, jednym rzędem lub
jednym artefaktem z konwergencją rozwiązania w otwartej przestrzeni.

Aktualny kontrakt wykonawczy jest celowo wąski: aktywny magnetyk musi mieć
typowane elementy tet4, skalarna przestrzeń potencjału jest P1, a kwalifikowany
domyślny wariant CPU używa `DenseDemagBemOperator`. Diagnostyczny
`AcaHMatrixDemagBemOperator` nie zastępuje dense bez osobnego dowodu A/B i
parity. GPU ma osobną, spłaszczoną realizację ACA H-matrix CUDA z Hypre dla obu
potencjałów i nie może przejść na CPU. prism6, pyramid5 i P2 są poza kontraktem
FK.

(governing-equations)=
## 2. Równania i konwencja znaków

### 2.1. Magnetostatyka

Niech $\mathbf m$ będzie zredukowaną magnetyzacją, a
$\mathbf M=M_s\mathbf m$ magnetyzacją w jednostkach SI. W domenie bez prądu
swobodnego:

```{math}
:label: eq-fem-bem-magnetostatics
\nabla\cdot(\mathbf H_\mathrm{demag}+\mathbf M)=0,
\qquad
\mathbf H_\mathrm{demag}=-\nabla u,
\qquad
\Delta u=\nabla\cdot\mathbf M.
```

Potencjał skalarny $u$ ma jednostkę $\mathrm A$, a jego gradient jest polem w
$\mathrm{A\,m^{-1}}$. Energia demagnetyzacji używana przez FEM/BEM jest:

```{math}
:label: eq-fem-bem-energy
E_\mathrm d=-\frac{\mu_0}{2}
\int_{\Omega_m}M_s\,\mathbf m\cdot\mathbf H_\mathrm{demag}\,\mathrm dV.
```

Współczynnik $1/2$ zapobiega podwójnemu zliczeniu energii pola własnego.

### 2.2. Rozdział Fredkina–Koehlera

Pierwszy potencjał $u_1$ rozwiązuje objętościowy problem Neumanna z tym samym
źródłem $\nabla\cdot\mathbf M$ i naturalnym strumieniem magnetycznym na
$\Gamma$. Jest określony z dokładnością do stałej; dla każdej spójnej
składowej magnetyka wprowadzany jest osobny warunek gauge.

Drugi potencjał $u_2$ jest harmoniczny w $\Omega_m$:

```{math}
:label: eq-fem-bem-harmonic-correction
\Delta u_2=0\quad\text{w } \Omega_m,
\qquad
u=u_1+u_2,
\qquad
\mathbf H_\mathrm{demag}=-\nabla(u_1+u_2).
```

Jego wartości brzegowe wynikają z reprezentacji całkowej Green’a z
$G(\mathbf x,\mathbf y)=1/(4\pi\lVert\mathbf x-\mathbf y\rVert)$ oraz z
wartości $u_1$ na $\Gamma$. W dyskretyzacji Fullmag near-blocki przechowują
dokładny kernel Lindholma, a admissible far-blocki deterministyczne czynniki
ACA $UV^T$. Globalna macierz $N_b\times N_b$ jest tworzona w domyślnej ścieżce
CPU; nie jest tworzona w diagnostycznej ścieżce ACA H-matrix używanej do
eksportu GPU.

### 2.3. Kontrast z Poisson–Robin

Poisson–Robin rozwiązuje pojedynczy potencjał na domenie z airboxem i stosuje
warunek truncacji na sztucznej granicy $\Gamma_R$:

```{math}
:label: eq-poisson-robin-truncation
\Delta u=\nabla\cdot\mathbf M\quad\text{w } \Omega_m\cup\Omega_a,
\qquad
a_Ru+b_R\,\partial_nu=0\quad\text{na } \Gamma_R.
```

Parametry $a_R,b_R$ należą do kontraktu airbox i nie są parametrami FK.
Mieszana topologia prism6+pyramid5+tet4 pozostaje w bieżącym solverze
Poisson jawnym kontraktem P1. Specjalny fem_demag_accuracy_contract wymaga
all-tet i potencjału P2; planner odrzuca piramidy przed uruchomieniem zamiast
udawać P2 przez ciche obniżenie rzędu.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol / nazwa | Znaczenie | Jednostka SI |
|---|---|---:|
| $\Omega_m$ | domena magnetyczna | $\mathrm{m^3}$ |
| $\Gamma$ | zewnętrzna granica magnetyka | $\mathrm{m^2}$ |
| $\mathbf m$ | zredukowana magnetyzacja | $1$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M$ | magnetyzacja, $M_s\mathbf m$ | $\mathrm{A\,m^{-1}}$ |
| $u,u_1,u_2$ | potencjał skalarny | $\mathrm A$ |
| $\mathbf H_\mathrm{demag}$ | pole demagnetyzujące | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | przenikalność próżni | $\mathrm{H\,m^{-1}}$ |
| $G$ | funkcja Green’a 3D | $\mathrm{m^{-1}}$ |
| $N_b$ | liczba węzłów granicy BEM | $1$ |
| $E_\mathrm d$ | energia demagnetyzacji | $\mathrm J$ |
| $a_R,b_R$ | współczynniki warunku Robin | zależne od normalizacji |

W kodzie długości są przechowywane w metrach. Nie wolno zastępować
względnych tolerancji geometrycznych stałymi absolutnymi dobranymi dla jednej
skali nanometrowej.

(assumptions-and-validity)=
## 4. Założenia i granice ważności

- brak prądu swobodnego i skalarna reprezentacja pola w domenie objętości;
- body-only: brak elementów airbox w tym operatorze;
- aktywna topologia: tet4, bez zduplikowanych węzłów elementu i z dodatnią
  objętością;
- potencjał: P1, bez niejawnego mapowania wielomianowego rzędu wyższego;
- granica: dokładny zbiór faset count == 1 aktywnych tetraedrów, zamknięty
  krawędziowo i wierzchołkowo;
- materiał i magnetyzacja spoza $\Omega_m$ nie są dodawane do RHS ani energii;
- dense BEM jest domyślną kwalifikowaną realizacją CPU; limit alokacji jest
  sprawdzany przed utworzeniem macierzy;
- diagnostyczny ACA H-matrix BEM raportuje deterministyczny fingerprint, near/far
  blocks, observed rank, resident bytes i estymatę błędu z niezależnych probes;
  estymata nie jest dowodem analitycznego error bound;
- GPU uploaduje spłaszczone near/far blocks raz w setupie. Każdy solve Hypre
  ma dwukierunkową zależność eventową między rzeczywistym strumieniem Fullmag
  i pożyczonym strumieniem obliczeniowym Hypre; hot loop nie może wykonywać
  hostowego `cudaStreamSynchronize` ani zakładać strumienia domyślnego;
- niezależne residuum $A x-b$ jest wymagane po braku zbieżności raportowanej
  przez Hypre lub po jawnym wymuszeniu przez politykę kwalifikacyjną. Zwykły
  sukces reużywa residuum solvera, a norma RHS jest liczona co najwyżej raz,
  gdy jest potrzebna do tolerancji absolutnej albo niezależnego residuum;
- model nie jest dowodem jakości meshera ani dowodem zbieżności dla filmu
  500 x 500 x 10 nm.

(python-api)=
## 5. Python DSL

Publiczny wybór realizacji zachowuje istniejący kontrakt:

```python
# %%
import fullmag as fm

fm.Demag(model="fredkin_koehler")
# równoważnie:
fm.Demag(realization="fredkin_koehler")
```

| Python | Typ | Domyślnie | Jednostka SI | Walidacja | Znaczenie | Wsparcie backendu | ProblemIR |
|---|---|---|---|---|---|---|---|
| Demag.model | str or None | None | 1 | airbox, bem, fredkin_koehler lub fmm | żądany model demagnetyzacji | FEM CPU | energy_terms[kind=demag].realization |
| Demag.variant | str or None | None | 1 | auto, dirichlet lub robin wyłącznie dla airbox | wariant modelu airbox | FEM CPU | energy_terms[kind=demag].realization |
| Demag.realization | str or None | None | 1 | istniejąca nazwa realization; nie łączyć z model | zgodność wsteczna wyboru realizacji | FEM CPU | energy_terms[kind=demag].realization |

Kanoniczny fragment IR jest:

```json
{"kind": "demag", "realization": "fredkin_koehler"}
```

Python nie przyjmuje osobnego przełącznika na dense/ACA H-matrix/FMM. To jest szczegół
resolved realization, capability i provenance, a nie nowa semantyka fizyczna.

(problem-ir)=
## 6. ProblemIR, planner i provenance

RequestedFemDemagIR::FredkinKoehler wymaga body-only mesh i nie wymaga
airboxa. Planner rozwiązuje go do
ResolvedFemDemagIR::FredkinKoehler. CPU i GPU są osobnymi realizacjami tego
samego modelu: CPU domyślnie używa dense, a GPU buduje diagnostyczne bloki
ACA H-matrix near/far oraz używa Hypre na device. Plan powinien zachować requested model,
resolved model, device, precision, topology, FE order, boundary-node count i
operator mode; sama obecność resolved planu nie jest dowodem runtime ani
walidacji fizycznej.

Metadata fem_demag_accuracy_contract ma schemat
fullmag.fem.demag_accuracy.v1. Wymaga Poisson airbox,
required_potential_order=2, required_topology=all_tet i odrzuca każdą
piramidę oraz PBC. Jest to osobny profil dokładności, nie automatyczna zmiana
ścieżki zwykłego mieszanego P1.

(round-trip-and-failure-semantics)=
## 7. Round-trip i semantyka błędów

Eksport i ponowne wczytanie zachowują nazwę fredkin_koehler; brak airboxa nie
może zostać zamieniony na airbox bez jawnej decyzji planner’a. Walidacja
kończy się przed złożeniem macierzy, jeżeli:

Kontrakt rozróżnia `requested intent` od `resolved execution`; `validation errors`
opisują odrzucone dane, a `unsupported combinations` kończą się
fail-closed zamiast niejawnego fallbacku.

- CSR elementów lub faset jest niekompletny, niezgodny typowo albo ma indeks
  poza zakresem;
- aktywny element nie jest TET4, ma powtórzony węzeł, niefinitywne punkty lub
  zerową/zdegenerowaną objętość;
- jawne fasety są niepełne, zdublowane, wewnętrzne, dodatkowe albo nie tworzą
  dokładnie zewnętrznego zbioru;
- powierzchnia ma krawędź o liczności innej niż dwa, niespójne orientacje lub
  rozspojony link wierzchołka;
- dense reference przekracza dense_reference_max_boundary_nodes albo
  przepełnia rozmiar/budżet bajtów;
- diagnostyczny operator ACA H-matrix przekracza budżet bloków/pamięci albo probe błędu
  przekracza tolerancję;
- liczba gauge nie pasuje do spójnych składowych Neumanna.

Każdy taki przypadek zwraca opisany błąd. Nie wolno zastępować błędu pustą
macierzą, zerowym kątem bryłowym, zerowymi wagami ani cichym CPU fallbackiem
dla żądania GPU.

(discrete-realization)=
## 8. Dyskretna realizacja

### 8.1. Ekstrakcja granicy

build_demag_boundary_surface buduje rekordy czterech ścian każdego aktywnego
TET4. Klucz ściany jest posortowaną trójką węzłów; ściany występujące raz są
zewnętrzne, a występujące dwa razy są wewnętrzne. Trzeci właściciel jest
nie-manifold i kończy się błędem.

Jeżeli wejście zawiera jawne fasety, ich zbiór kluczy musi być identyczny ze
zbiorem ścian zewnętrznych. Kolejność węzłów może być permutowana lub
odwrócona, ponieważ normalna jest ponownie orientowana względem węzła
przeciwległego tetraedru. Wynik publikuje:

- boundary_nodes — globalne węzły granicy;
- global_to_boundary — mapowanie węzeł → gęsty wiersz lub -1;
- triangles — zewnętrzne trójkąty z normalną na zewnątrz;
- unit_normals — skończone normalne jednostkowe;
- triangle_areas — dodatnie pola;
- charakterystyczną długość używaną przez testy względnej geometrii.

Po ekstrakcji sprawdzane są krawędzie bez orientacji, przeciwne kierunki
każdej pary oraz ciągłość linku każdego wierzchołka. Sam fakt znalezienia
faset count == 1 nie jest dowodem watertight surface.

### 8.2. Gauge Neumanna

Graf aktywnych tetraedrów łączy elementy przez wspólny węzeł. Dla każdej
spójnej składowej wybierany jest deterministycznie najmniejszy globalny węzeł.
Workspace mapuje go na prawidłowy true DOF P1, a operator Neumanna eliminuje
wszystkie te DOF-y. RHS kopiuje wspólny demag RHS i zeruje dokładnie tę listę.

### 8.3. Dense CPU i diagnostyczny operator ACA H-matrix

`AcaHMatrixDemagBemOperator` buduje jedno deterministyczne, medianowe drzewo
klastrów węzłów brzegowych, współdzielone przez stronę docelową i źródłową
każdej pary bloków. Pary nieadmissible zapisują dokładne wpisy
Lindholma w blokach near. Pary admissible są kompresowane deterministycznym
ACA do czynników $UV^T$ z limitem rzędu i kontrolą pivotu. Diagonalny wkład
kątów bryłowych pozostaje jawny; globalna macierz $N_b^2$ nie jest
materializowana. Workspace operatora zawiera scratch dla `apply`, więc
powtórne zastosowanie nie alokuje buforów zależnych od liczby węzłów. Nie jest
to H2: implementacja nie ma zagnieżdżonych baz klastrowych. Wariant pozostaje
diagnostyczny i jest budowany jawnie przez inicjalizację GPU.

DenseDemagBemOperator składa macierz wierszami. Diagonalny wkład używa sumy
kątów bryłowych przy węźle granicy, a pozadiagonalne wkłady liniowych funkcji
kształtu trójkąta w formulacji Lindholma. Wszelkie przypadki pokrywającego się
wierzchołka, zerowej krawędzi, niedozwolonego logarytmu lub niefinitycznego
wyniku są błędem kontrolowanym.

Dense reference ma złożoność i pamięć $O(N_b^2)$ i jest chroniony guardem
przed `matrix_.assign`; pozostaje domyślnym wariantem CPU. Wspólna
inicjalizacja FK tworzy tylko geometrię granicy, przestrzeń P1, gauge oraz
operatory Neumanna i Dirichleta. Dopiero jawnie wybrana realizacja CPU buduje
`DenseDemagBemOperator`; wymuszona realizacja GPU przechodzi bez jego alokacji
i bez kosztu $O(N_b^2)$.
Kontrola jakości hierarchii wykonuje ograniczoną, deterministyczną serię
niezależnych probes/residual estimates. `relative_error_estimate` jest
estymatą diagnostyczną, nie analityczną gwarancją błędu; przekroczenie
tolerancji kończy budowę błędem. Budżety pamięci, liczby bloków i wpisów są
sprawdzane przed alokacją.

### 8.4. Ścieżka GPU, interop strumieni i residuum

`GpuDemagFemBemWorkspace` spłaszcza deterministyczne bloki ACA H-matrix near/far
oraz ich fingerprint do buforów CUDA. Setup wykonuje jeden upload operatora;
kernel liczy near sumy i $U(V^Tx)$ dla far blocks. Dwa układy Hypre rozwiązują
$u_1$ i $u_2$, a recovery pola i redukcja energii są wykonywane na device.
W hot loop nie ma pełnego wektora H2D/D2H ani wywołania CPU FK. Trwały
`HypreStreamLease` pożycza do wersji przypięty strumień obliczeniowy Hypre i
przechowuje event wejściowy oraz wyjściowy. Przed każdym `Mult` event nagrany
na strumieniu Fullmag jest oczekiwany przez Hypre; po `Mult` odwrotna para
eventów blokuje dalszego konsumenta Fullmag bez zatrzymywania hosta.

Po zwykłym sukcesie Hypre wynikowa norma residuum solvera jest używana bez
dodatkowego SpMV. `should_validate_independent_residual` wymusza $A x-b$ tylko
po zgłoszonym braku zbieżności albo w jawnym trybie kwalifikacyjnym. Jeżeli
włączono tolerancję absolutną, jedna norma RHS służy zarówno do przeliczenia
residuum solvera, jak i do niezależnej walidacji. Kontrakt nie zmienia równań,
znaków, jednostek ani wyboru solvera.

Wskaźnik device workspace ma dokładnie jednego właściciela lifecycle:
`DemagFemBemWorkspace` przechowuje callback destruktora dostarczony przez moduł
CUDA. Reinicjalizacja FK oraz zwykły `context_destroy_mfem` wywołują go przed
niszczeniem wspólnych operatorów MFEM, po czym zerują wskaźnik, readiness i
accounting. Powtórny teardown jest no-op.

(implementation-mapping)=
## 9. Mapa implementacji i własność modułów

| Odpowiedzialność | Plik | Symbol |
|---|---|---|
| typed mesh i topologia | backends/fem/core/fem_mesh.hpp/.cpp | FemMesh, element_topology |
| granica BEM | backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.hpp/.cpp | build_demag_boundary_surface |
| dense default i diagnostyczny ACA H-matrix | backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.hpp/.cpp | DenseDemagBemOperator oraz AcaHMatrixDemagBemOperator::build, apply |
| RHS Neumanna | backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.hpp/.cpp | prepare_demag_fem_bem_neumann_rhs |
| workspace, gauge i lifecycle CPU/GPU | backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.hpp/.cpp | DemagFemBemWorkspace, initialize_demag_fem_bem_workspace, context_initialize_demag_fem_bem, destroy_attached_demag_fem_bem_gpu_workspace |
| solve | backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.hpp/.cpp | context_compute_demag_fem_bem |
| wartości brzegowe | backends/fem/cpu/mfem/interactions/demag_fem_bem_boundary_values.* | boundary transfer |
| potencjał | backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.* | potential combine |
| odzysk pola i energia | backends/fem/cpu/mfem/interactions/demag_poisson_recovery.*, demag_fem_bem_energy.* | H_demag, E_d |
| operator GPU i Hypre | backends/fem/gpu/cuda/demag_fem_bem/fem_bem.* | GpuDemagFemBemWorkspace, device FK apply |
| interop CUDA/Hypre | backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.* | HypreStreamLease, hypre_wait_for_fullmag, fullmag_wait_for_hypre |
| polityka residuum | backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.* | should_validate_independent_residual, resolve_hypre_residual_validation_needs |
| kontrakt testowy | backends/fem/tests/demag_fem_bem_contract.cpp | fem_demag_fem_bem_contract |

Operator FK nie dodaje nowej fizyki do Context ani mfem_bridge.cpp.
Poisson, FK CPU i przyszłe lane’y GPU współdzielą tylko kontrakt fizyczny;
realizacje MFEM/CUDA pozostają osobne.

(validation)=
## 10. Plan i dowód walidacji

### 10.1. Testy źródłowe i kontraktowe

Kanoniczny target sprawdza kompilację i uruchamia:

```text
just --shell 'C:\Program Files\Git\bin\bash.exe' --shell-arg -lc verify-fem-demag-poisson-contract-focused
```

fem_demag_fem_bem_contract musi obejmować granicę kompletną, fasety
niepoprawne, nie-manifold, skalowanie, typy/CSR, gauge wielu składowych,
pełny CPU solve, fingerprint geometrii/opcji i bezpieczny pusty output `apply`.
Osobny target GPU sprawdza pełne initialize→apply, upload true-DOF, device
apply, cztery event waits dla dwóch solve’ów, zerowy przyrost compute host sync
i brak niezależnego SpMV po zwykłej zbieżności. Istniejące
testy energii, skończoności macierzy i własności modułów pozostają aktywne.

### 10.2. Walidacja fizyczna

Wymagane są niezależne artefakty dla:

- jednorodnej kuli — czynnik demagnetyzacji i zbieżność;
- elipsoidy — czynniki Osborna i suma osi;
- prostopadłościanu/filmu i pręta — kierunkowa zależność pola;
- siatek o rosnącej rozdzielczości oraz przeskalowanych geometrii;
- dwóch rozspojonych ciał — niezależność gauge;
- pochodnej kierunkowej energii względem pola;
- porównania z Poisson-airbox, FDM i zewnętrznym fixture Tetmag po ustaleniu
  identycznej geometrii, magnetyzacji, jednostek i scope.

Aktualny skrypt tests/fem_demag_validation/fem_bem_body_validation.py jest
przygotowany do serii sferycznej, ale istniejący CSV zawiera NaN; dopóki
świeży managed receipt nie zawiera skończonych wyników, status wynosi
NOT VERIFIED.

### 10.3. Macierz lane’ów

| Lane | Implementacja | Walidacja runtime | Status |
|---|---|---|---|
| FEM CPU + tet4 + P1 + dense default | kod i pełny CPU solve contract | wymagany managed receipt | source/contract VERIFIED; managed runtime/physics NOT VERIFIED |
| FEM CPU + all-tet/P2 Poisson accuracy | osobny planner contract | brak świeżego artefaktu filmu | NOT VERIFIED |
| FEM GPU FK + diagnostyczny ACA H-matrix | initialize→apply, kernel smoke i event interop contract | wymagany produkcyjny receipt, parity i profil | source/contract oraz focused managed GPU VERIFIED; produkcyjny runtime/physics NOT VERIFIED |
| H2/FMM lub skalowalny BEM | brak prawdziwej implementacji H2/FMM | brak świeżego managed receiptu | NOT VERIFIED |

Przejście do physics_validated lub production_qualified wymaga źródłowej
tożsamości, managed receipt, artefaktu, validatora i pełnego scope. Test
kompilacji ani dowód, że istnieje funkcja build, nie jest takim przejściem.

(limitations)=
## 11. Ograniczenia i prace odroczone

- dense BEM nie skaluje się do dużych powierzchni; limit chroni pamięć, ale nie
  jest benchmarkiem produkcyjnego rozmiaru;
- diagnostyczny ACA H-matrix nie jest H2 i nie zastępuje dense default bez A/B;
  event interop usuwa jawne host fences, lecz bez świeżego managed receipt,
  Nsight i CPU/GPU parity nie dowodzi przyspieszenia ani kwalifikacji fizycznej;
  FMM pozostaje poza zakresem;
- dopasowanie pojedynczego wyniku filmu 500 x 500 x 10 nm nie rozstrzyga, czy
  przyczyną rozbieżności jest rząd P1, topologia piramid, grading, granica czy
  błąd energii;
- mieszany Poisson P1 pozostaje wspieranym kontraktem topology-specific, a
  niezależny profil P2 wymaga all-tet; nie wolno mieszać tych statusów;
- brak aktualnego artefaktu lub nieudany runtime oznacza NOT VERIFIED, nie
  „prawdopodobnie poprawne”.

Odroczone są: analityczny error bound i adaptacja hierarchii, FMM,
automatyczny wybór rzędu, większa macierz filmu oraz pełna kwalifikacja filmu
na managed CPU i GPU.

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. A. A. Fredkin i T. R. Koehler, A boundary element solution for
   micromagnetic problems, IEEE Transactions on Magnetics 23 (1987),
   3385–3387, DOI: 10.1109/TMAG.1987.1065289.
2. J. A. Osborn, Demagnetizing factors of the general ellipsoid, Physical
   Review 67 (1945), 351–357, DOI: 10.1103/PhysRev.67.351.
3. R. Hertel, Tetmag, zewnętrzny fixture porównawczy w
   external_solvers/tetmag; kod nie jest źródłem implementacji Fullmag.

(source-code-index)=
## 13. Indeks źródeł

| Plik | Symbol | Odpowiedzialność |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/energy.py | class Demag | publiczny wybór modelu i aliasu realization |
| crates/fullmag-ir/src/plan.rs | enum ResolvedFemDemagIR | kanoniczna realizacja resolved |
| crates/fullmag-plan/src/fem.rs | validate_fem_demag_accuracy_contract | fail-closed profil all-tet/P2 Poisson |
| backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp | build_demag_boundary_surface | typed TET4 i watertight boundary |
| backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.hpp | class AcaHMatrixDemagBemOperator | diagnostyczny ACA H-matrix, eksport device i limit budżetu; dense pozostaje CPU default |
| backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp | initialize_demag_fem_bem_workspace, context_initialize_demag_fem_bem, destroy_attached_demag_fem_bem_gpu_workspace | wspólna przestrzeń P1, wielokrotny gauge, CPU-only dense selection i teardown podpiętego GPU workspace |
| backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp | prepare_demag_fem_bem_neumann_rhs | zerowanie gauge w RHS |
| backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp | combine_demag_fem_bem_total_potential | suma potencjałów u1 i u2 |
| backends/fem/cpu/mfem/interactions/demag_fem_bem_energy.cpp | demag_fem_bem_energy_from_field | energia demagnetyzacji |
| backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp | gpu_demag_fem_bem_initialize | jednorazowy upload i trwały workspace CUDA/Hypre |
| backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp | destroy_owned_gpu_workspace | callback teardownu podpiętego GPU workspace wywoływany przed operatorami CPU i MFEM |
| backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu | fullmag_cuda_fem_bem_apply | device apply bloków near/far i mapowania P1 true DOF |
| backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.hpp | initialize_hypre_stream_interop, HypreStreamLease | trwały pożyczony strumień Hypre oraz eventy zależności wejścia/wyjścia |
| backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp | should_validate_independent_residual | czysta polityka pomijania dodatkowego $A x-b$ po zwykłej zbieżności |
| backends/fem/tests/demag_fem_bem_contract.cpp | main | wykonywalny kontrakt testowy |
| backends/fem/tests/demag_fem_bem_gpu_contract.cpp | main | wykonywalny kontrakt CUDA near/far apply |

- backends/fem/cpu/mfem/interactions/demag_fem_bem_surface.cpp — rekordy
  ścian, orientacja, mapowanie węzłów i kontrola zamknięcia;
- backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp — kąty
  bryłowe, wagi Lindholma, dense default, diagnostyczny ACA H-matrix, apply i limity pamięci;
- backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp — FK CUDA/Hypre,
  spłaszczone bloki near/far, upload operatora i audit synchronizacji;
- backends/fem/gpu/cuda/demag_fem_bem/fem_bem_kernels.cu — kernel near/far
  oraz mapa scalar true DOF;
- backends/fem/cpu/mfem/interactions/demag_fem_bem_workspace.cpp — MFEM P1,
  workspace, operatory Neumanna/Dirichleta i gauge;
- backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp — transformacja
  RHS i zerowanie gauge;
- backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp — kolejność
  u1 → BEM → u2 → pole → energia;
- crates/fullmag-ir/src/plan.rs — requested/resolved demag IR;
- crates/fullmag-plan/src/fem.rs — planner i
  validate_fem_demag_accuracy_contract;
- backends/fem/tests/demag_fem_bem_contract.cpp — executable contract gate;
- tests/fem_demag_validation/fem_bem_body_validation.py — fizyczny producer,
  obecnie bez aktualnego skończonego receipt.

## 14. Checklist kompletności

- [x] problem fizyczny i rozdział od Poisson–Robin;
- [x] równania, znaki, jednostki SI i energia;
- [x] założenia, zakres P1/TET4 i ograniczenia;
- [x] Python DSL, ProblemIR, planner i round-trip;
- [x] realizacja dyskretna, ownership i semantyka błędów;
- [x] osobne lane’y CPU, GPU, P2 i ACA H-matrix/H2/FMM z jawnym statusem
  implementacji oraz walidacji;
- [x] plan walidacji i statusy bez nieuprawnionej promocji;
- [x] bibliografia i source index;
- [x] machine-readable source map.
