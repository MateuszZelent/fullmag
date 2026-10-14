# Domena fizyczna: nodalne $M_s$ w źródle przekroju falowodu

## Rodzina solvera: FEM

### Backend wykonania: CPU

#### Podsystem numeryczny: dokładne momenty P1

(problem-statement)=
## Problem statement

Ta nota określa interpretację nodalnego pola nasycenia $M_s$ i dokładne
momenty elementowe używane przez bounded assembler przekroju waveguide.
Wartości nodalne definiują pole P1 w trójkącie; nie są stałymi pobieranymi
z węzła źródłowego. Zaburzenie znormalizowane $\delta\mathbf{m}$ jest
bezwymiarowe, a fizyczne zaburzenie $\delta\mathbf{M}=M_s\delta\mathbf{m}$
ma jednostkę $\mathrm{A\,m^{-1}}$.

Stan dowodów: FEM CPU ma widoczny bounded helper, ale pozostaje
source-visible / unvalidated. Nie ma dowodu managed MFEM runtime, realizacji
GPU ani walidacji fizycznej. S09 typed provider, realizacja falowodu 2.5D
i routing są proposed / unimplemented; sam helper nie zamyka S09.b. Zakres
tej poprawki nie zmienia publicznego API, ProblemIR, planera ani capability.

Kanoniczny model fizyczny i znaki znajdują się w [kontrakcie waveguide 0828](0828-fem-frequency-domain-floquet-demag.md#waveguide-envelope-contract).
Reguła parametrów materiałowych w punktach całkowania jest opisana w
[kontrakcie materiałowym 0104](0104-material-regions-parameter-fields-and-interface-couplings.md).

(governing-equations)=
## Governing equations and element moments

Indeksy $i,j,\ell$ oznaczają lokalne węzły trójkąta, a $\alpha$ wybiera
jeden z dwóch kierunków lokalnej ramy stycznej.

```{math}
:label: eq-waveguide-nodal-ms-field
M_s(\mathbf{r}) = \sum_{\ell=1}^{3} M_{s,\ell}N_\ell(\mathbf{r}),\qquad
\delta\mathbf{m}(\mathbf{r}) =
\sum_{j=1}^{3}\sum_{\alpha=1}^{2}
N_j(\mathbf{r})\mathbf{e}_{j\alpha}q_{j\alpha},\qquad
\delta\mathbf{M}(\mathbf{r}) =
M_s(\mathbf{r})\delta\mathbf{m}(\mathbf{r}).
```

Iloczyn $M_sN_j$ jest stopnia drugiego. Jego dokładny moment poprzeczny
wynosi:

```{math}
:label: eq-waveguide-nodal-ms-transverse-moment
W_{\perp,j}
= \int_T M_s(\mathbf{r})N_j(\mathbf{r})\,\mathrm{d}A
= \frac{|T|}{12}\sum_{\ell=1}^{3}M_{s,\ell}
\begin{cases}
2, & \ell=j,\\
1, & \ell\ne j.
\end{cases}
```

Iloczyn $M_sN_iN_j$ jest stopnia trzeciego. Dokładna całka barycentryczna
ma postać:

```{math}
:label: eq-waveguide-nodal-ms-axial-moment
c_{ij\ell} =
\begin{cases}
6, & i=j=\ell,\\
2, & \text{dokładnie dwa z }i,j,\ell\text{ są równe},\\
1, & i,j,\ell\text{ są parami różne},
\end{cases}
\qquad
W_{\mathrm{axial},ij}
= \int_T M_s(\mathbf{r})N_i(\mathbf{r})N_j(\mathbf{r})\,\mathrm{d}A
= \frac{|T|}{60}\sum_{\ell=1}^{3}M_{s,\ell}c_{ij\ell}.
```

Dla konwencji $\exp(-\mathrm{i}kz)$ fizyczne źródło słabe ma osiowy człon
$+\mathrm{i}k$. Blok deskryptora $A_{\phi q}$ przechowuje negację obu
składowych źródła:

```{math}
:label: eq-waveguide-physical-and-descriptor-source
S_i =
\int_T M_s(\mathbf{r})\left[
\nabla_\perp N_i(\mathbf{r})\cdot
\delta\mathbf{m}_\perp(\mathbf{r})
+\mathrm{i}kN_i(\mathbf{r})\delta m_z(\mathbf{r})
\right]\,\mathrm{d}A
= S_{\perp,i}+\mathrm{i}kS_{z,i},\qquad
A_{\phi q}(k)
= A_{\phi q,\perp}+\mathrm{i}kA_{\phi q,\mathrm{axial}},\qquad
P(k)\phi+A_{\phi q}(k)\mathbf{q}=0.
```

Zatem elementy $A_{\phi q,\perp}$ i $A_{\phi q,\mathrm{axial}}$ są ujemnymi
odpowiednikami odpowiednio części poprzecznej i osiowej fizycznego źródła.
Silna postać z kontraktu 0828 zachowuje znaki $-\mathrm{i}k\delta M_z$
oraz $+\mathrm{i}k\phi$; znak całki słabej wynika z całkowania przez części.
Ta zmiana nie dotyka qphi_feedback_scale: bounded helper ma wartość domyślną
$1$ dla konwencji algebraiczno-testowej, a przyszły fizyczny konsument wymaga
$-\mu_0$. Obecnie nie ma produkcyjnego konsumenta tej struktury.

Historyczna reguła source-node traktowała $M_{s,j}$ jako stałą dla kolumny
źródłowej. Dla zmiennego pola nie daje dokładnego momentu P1:

```{math}
:label: eq-waveguide-old-source-node-mismatch
W_{\perp,j}^{\mathrm{old}} = \frac{|T|M_{s,j}}{3},\qquad
W_{\mathrm{axial},ij}^{\mathrm{old}} =
|T|M_{s,j}
\begin{cases}
\frac{1}{6}, & i=j,\\
\frac{1}{12}, & i\ne j.
\end{cases}
```

Pusty bufor nodalny zachowuje starą gałąź jednorodną z parametrem
$M_s^{\mathrm{uniform}}$:

```{math}
:label: eq-waveguide-uniform-branch
W_{\perp,j}^{\mathrm{uniform}}
= \frac{|T|M_s^{\mathrm{uniform}}}{3},\qquad
W_{\mathrm{axial},ij}^{\mathrm{uniform}}
= |T|M_s^{\mathrm{uniform}}
\begin{cases}
\frac{1}{6}, & i=j,\\
\frac{1}{12}, & i\ne j.
\end{cases}
```

Całki assemblera są całkami na przekroju i nie są skalowane dodatnią
metadaną długości porównawczej:

```{math}
:label: eq-waveguide-per-length-section
A_{\phi q}(k;\ell_{\mathrm{norm}})=A_{\phi q}(k),
\qquad \ell_{\mathrm{norm}}>0.
```

W porównaniu z modelem 3D należy podzielić jego całkę przez rzeczywistą
długość ekstrudowania. Sama metadana normalization_length_m nie dowodzi
zgodności z 3D.

(symbols-and-si-units)=
## Symbols and SI units

Tokeny LaTeX poniżej są tymi użytymi w równaniach. Jednostki bezwymiarowe
zapisano jako $1$.

| Symbol LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf{r}$ | położenie w przekroju | $\mathrm{m}$ |
| $T$ | trójkątny element przekroju | $1$ |
| $i$ | indeks węzła testowego | $1$ |
| $j$ | indeks węzła źródłowego | $1$ |
| $\ell$ | indeks nodalnego współczynnika $M_s$ | $1$ |
| $\alpha$ | indeks kierunku ramy stycznej | $1$ |
| $M_s(\mathbf{r})$ | interpolowane pole nasycenia P1 | $\mathrm{A\,m^{-1}}$ |
| $M_{s,\ell}$ | nodalna wartość nasycenia | $\mathrm{A\,m^{-1}}$ |
| $M_{s,j}$ | wartość nasycenia z historycznej reguły source-node | $\mathrm{A\,m^{-1}}$ |
| $M_s^{\mathrm{uniform}}$ | stała nasycenia w gałęzi jednorodnej | $\mathrm{A\,m^{-1}}$ |
| $N_i(\mathbf{r})$ | funkcja kształtu P1 | $1$ |
| $N_\ell(\mathbf{r})$ | funkcja kształtu P1 dla nodalnego współczynnika ell | $1$ |
| $\delta\mathbf{m}(\mathbf{r})$ | znormalizowane zaburzenie magnetyzacji | $1$ |
| $\delta\mathbf{m}_\perp(\mathbf{r})$ | poprzeczna składowa zaburzenia | $1$ |
| $\delta m_z(\mathbf{r})$ | osiowa składowa zaburzenia | $1$ |
| $\mathbf{e}_{j\alpha}$ | wektor lokalnej ramy stycznej | $1$ |
| $\mathbf{q}$ | wektor amplitud magnetycznych stopni swobody | $1$ |
| $q_{j\alpha}$ | amplituda kierunku ramy w węźle źródłowym | $1$ |
| $\delta\mathbf{M}(\mathbf{r})$ | fizyczne zaburzenie $M_s\delta\mathbf{m}$ | $\mathrm{A\,m^{-1}}$ |
| $|T|$ | pole trójkąta | $\mathrm{m^2}$ |
| $\mathrm{d}A$ | miara pola przekroju | $\mathrm{m^2}$ |
| $W_{\perp,j}$ | poprzeczny moment materiałowy | $\mathrm{A\,m}$ |
| $W_{\mathrm{axial},ij}$ | osiowy moment materiałowy | $\mathrm{A\,m}$ |
| $c_{ij\ell}$ | współczynnik potrójnego iloczynu P1 | $1$ |
| $W_{\perp,j}^{\mathrm{old}}$ | historyczny moment poprzeczny | $\mathrm{A\,m}$ |
| $W_{\mathrm{axial},ij}^{\mathrm{old}}$ | historyczny moment osiowy | $\mathrm{A\,m}$ |
| $W_{\perp,j}^{\mathrm{uniform}}$ | moment poprzeczny gałęzi jednorodnej | $\mathrm{A\,m}$ |
| $W_{\mathrm{axial},ij}^{\mathrm{uniform}}$ | moment osiowy gałęzi jednorodnej | $\mathrm{A\,m}$ |
| $\nabla_\perp N_i(\mathbf{r})$ | gradient poprzeczny funkcji testowej | $\mathrm{m^{-1}}$ |
| $k$ | podpisana liczba falowa wzdłuż $z$ | $\mathrm{rad\,m^{-1}}$ |
| $\mathrm{i}$ | jednostka urojona | $1$ |
| $S_i$ | fizyczne słabe źródło dla węzła testowego | $\mathrm{A}$ |
| $S_{\perp,i}$ | poprzeczna część słabego źródła | $\mathrm{A}$ |
| $S_{z,i}$ | osiowa całka przed mnożeniem przez $k$ | $\mathrm{A\,m}$ |
| $A_{\phi q,\perp}$ | poprzeczna część bloku deskryptora | $\mathrm{A}$ |
| $A_{\phi q,\mathrm{axial}}$ | osiowa część przed mnożeniem przez $k$ | $\mathrm{A\,m}$ |
| $A_{\phi q}(k)$ | zespolony blok deskryptora | $\mathrm{A}$ |
| $A_{\phi q}(k;\ell_{\mathrm{norm}})$ | blok przekroju z metadaną długości | $\mathrm{A}$ |
| $P(k)$ | bezwymiarowy blok potencjału | $1$ |
| $\phi$ | skalarny potencjał magnetyczny | $\mathrm{A}$ |
| $\ell_{\mathrm{norm}}$ | dodatnia długość porównawcza, bez wpływu na blok | $\mathrm{m}$ |

(assumptions-and-validity)=
## Assumptions and validity

- W każdym trójkącie $M_s$ i $\delta\mathbf{m}$ są interpolowane liniowo
  przez barycentryczne funkcje P1.
- Konwencja osiowa to $\exp(-\mathrm{i}kz)$ z podpisanym $k$. Geometria,
  przekrój i materiał są niezmienne wzdłuż $z$. Zwężenie lub taper nie spełnia
  założeń 2.5D.
- Dokładne momenty potwierdzają całkowanie tych wielomianowych integrandów.
  Nie dowodzą poprawności całego modelu, zbieżności rozwiązania, granicy
  $k\to0$ ani zgodności z pełnym 3D.
- $W_{\perp,j}$ ma jednostkę $\mathrm{A\,m}$; mnożenie osiowego momentu przez
  $k$ daje $\mathrm{A}$, zgodnie z poprzecznym blokiem.

(python-api)=
## Python API and authoring scope

Nie ma publicznego konstruktora Python ani workflow
fm.study(...).stages dla tego bounded helpera. Nie pokazuj go jako wspieranego
API i nie twórz fikcyjnego ProblemIR. Poniższy kopiowalny przykład to wyłącznie
niezależne od Fullmag sprawdzenie momentów referencyjnych; nie tworzy
symulacji, nie uruchamia solvera i nie kwalifikuje FEM.

```python
# %% Dane jednego trójkąta i nodalne Ms
from math import isclose

area_m2 = 0.5
nodal_ms_a_per_m = (1.5, 2.5, 4.0)
points = (
    (1 / 3, 1 / 3, 1 / 3),
    (0.6, 0.2, 0.2),
    (0.2, 0.6, 0.2),
    (0.2, 0.2, 0.6),
)
weights = (-27 / 48, 25 / 48, 25 / 48, 25 / 48)

# %% Analityczne momenty P1
def triple_coefficient(i, j, ell):
    equal_pairs = (i == j) + (i == ell) + (j == ell)
    return 6 if equal_pairs == 3 else 2 if equal_pairs == 1 else 1


def moments(ms_values):
    transverse = [
        area_m2 / 12 * sum(v * (2 if ell == j else 1)
                           for ell, v in enumerate(ms_values))
        for j in range(3)
    ]
    axial = [
        [
            area_m2 / 60 * sum(v * triple_coefficient(i, j, ell)
                               for ell, v in enumerate(ms_values))
            for j in range(3)
        ]
        for i in range(3)
    ]
    return transverse, axial


exact_perp, exact_axial = moments(nodal_ms_a_per_m)

# %% Niezależna kwadratura barycentryczna stopnia trzeciego
quad_perp = [0.0, 0.0, 0.0]
quad_axial = [[0.0 for _ in range(3)] for _ in range(3)]
for bary, weight in zip(points, weights):
    ms = sum(bary[i] * nodal_ms_a_per_m[i] for i in range(3))
    scale = area_m2 * weight * ms
    for j in range(3):
        quad_perp[j] += scale * bary[j]
        for i in range(3):
            quad_axial[i][j] += scale * bary[i] * bary[j]

# %% Porównanie dokładnych momentów i gałęzi jednorodnej
assert all(isclose(a, b, rel_tol=1e-13, abs_tol=1e-13)
           for a, b in zip(exact_perp, quad_perp))
assert all(isclose(exact_axial[i][j], quad_axial[i][j],
                   rel_tol=1e-13, abs_tol=1e-13)
           for i in range(3) for j in range(3))

uniform_ms = 2.0
uniform_perp, uniform_axial = moments((uniform_ms,) * 3)
assert all(isclose(v, area_m2 * uniform_ms / 3,
                   rel_tol=1e-13, abs_tol=1e-13) for v in uniform_perp)
assert all(isclose(uniform_axial[i][j],
                   area_m2 * uniform_ms * (1 / 6 if i == j else 1 / 12),
                   rel_tol=1e-13, abs_tol=1e-13)
           for i in range(3) for j in range(3))
print("P1 moments match independent degree-three quadrature.")
```

Przykład sprawdza tylko momenty na syntetycznym trójkącie. Nie testuje ramek
stycznych, znaków zespolonego źródła, assembly C++, planera ani runtime.

(problem-ir)=
## ProblemIR impact

Nie dodano publicznego parametru, konstruktora, węzła ProblemIR,
normalizacji ani providera planera. Nie istnieje kanoniczny serializowany
ProblemIR dla tego helpera; przykład JSON sugerowałby nieistniejący kontrakt.
Przyszły mapping musi zachować nodalne wartości SI, topologię i interpolację
P1, zamiast zastępować je wartością z węzła źródłowego.

(round-trip-and-failure-semantics)=
## Round-trip and failure semantics

- **requested intent:** brak publicznego requestu wybierającego falowód 2.5D
  lub nodalne $M_s$; intencja nie wynika z samego istnienia helpera.
- **resolved execution:** helper nie przechodzi przez planner ani managed
  runtime; nie ma publicznego rozstrzygnięcia backendu, urządzenia, precyzji
  ani provenance.
- **Python-to-IR round-trip:** nie istnieje publiczny obiekt, serializacja
  ani odtworzenie tego wejścia przez ProblemIR.
- **validation errors:** przy niepustym wskaźniku nodalnym liczność musi
  równać się node_count, a wartości muszą być skończone i nieujemne. Przy
  pustym wskaźniku liczność musi wynosić zero, a jednorodne $M_s$ musi być
  skończone i nieujemne. Źródło zwraca validation_error z komunikatem dla
  błędnych danych; nie jest to publiczny błąd DSL.
- **unsupported combinations:** typed provider i realizacja 2.5D są
  proposed / unimplemented. Poprawka nie obsługuje publicznego żądania GPU,
  routingu ProblemIR ani geometrii zmieniającej się wzdłuż osi. Nie ma
  fallbacku do FDM, bo brak publicznej trasy żądania.

(discrete-realization)=
## Discrete realization and backend matrix

Poprzeczny moment całkuje $M_sN_j$ stopnia 2, a osiowy całkuje
$M_sN_iN_j$ stopnia 3. Dla stałego $M_s$ oba wzory redukują się do wag
gałęzi jednorodnej. Historyczne $M_{s,j}$ razy macierz masy daje inną
interpolację dla zmiennego pola.

| Solver | Urządzenie | Stan | Zakres i powód |
|---|---|---|---|
| FEM | CPU | source-visible / unvalidated | Bounded assembler liczy momenty P1; brak managed MFEM i walidacji fizycznej. |
| FEM | GPU | not-applicable | Ta zmiana nie dodaje realizacji ani trasy GPU. |
| FDM | CPU | not-applicable | Całka przekroju należy do helpera FEM. |
| FDM | GPU | not-applicable | Całka przekroju należy do helpera FEM. |

Pusty wskaźnik zachowuje starą gałąź jednorodną. normalization_length_m jest
walidowane jako dodatnie i zapisywane w wyniku, ale nie skaluje macierzy
sekcji ani długości brzegu.

(implementation-mapping)=
## Implementation mapping

Pola poniżej należą do wewnętrznego wejścia C++; nie są parametrami Python API.

| Pole | Typ i domyślna wartość | SI | Walidacja | Znaczenie i wsparcie | ProblemIR |
|---|---|---|---|---|---|
| saturation_magnetization_a_per_m | const double*, nullptr | $\mathrm{A\,m^{-1}}$ na węzeł | Gdy wskaźnik jest niepusty: liczność równa node_count; wszystkie wartości skończone i $\ge0$. | Nodalny współczynnik P1, tylko bounded FEM CPU helper. | Brak mapowania. |
| saturation_magnetization_count | std::uint64_t, 0 | $1$ | Wskaźnik pusty wymaga zera; niepusty wymaga node_count. | Liczba wartości nodalnych, tylko bounded FEM CPU helper. | Brak mapowania. |
| uniform_saturation_magnetization_a_per_m | double, 0.0 | $\mathrm{A\,m^{-1}}$ | Przy pustym wskaźniku wartość skończona i nieujemna. | Stare wejście gałęzi jednorodnej, tylko bounded FEM CPU helper. | Brak mapowania. |

Blok przekroju trafia do algebraicznego helpera
build_floquet_waveguide_demag_k_real_split; nie jest to publiczny provider.
qphi_feedback_scale zachowuje wartość domyślną $1$ konwencji testowej.
Nagłówek wymaga od przyszłego fizycznego konsumenta wartości $-\mu_0$.
Produkcja i fizyczny caller pozostają nieobecne.

(validation)=
## Validation

1. Źródło kopiuje trzy lokalne wartości $M_s$, oblicza moment stopnia 2 i
   potrójny moment stopnia 3 oraz zachowuje arytmetykę gałęzi jednorodnej.
2. Przykład # %% porównuje wzory z niezależną kwadraturą barycentryczną
   stopnia trzeciego i sprawdza redukcję dla stałego pola.
3. Istniejący skrypt Python zawiera dodatkowe kontrole znaków podpisanego $k$
   i różnicy od historycznej reguły; jego testów nie uruchamiano.
4. Test C++ zawiera przygotowaną regresję nodalnego $M_s$ dla $k=-3,0,+3$;
   nie jest kompilowany ani uruchamiany w tej kontroli.
5. Managed FEM CPU/GPU, granica $k\to0$, residuale, compareextruded3D i
   niezależne porównanie TetraX są NOT VERIFIED.

(limitations)=
## Limitations, completeness checklist, and deferred work

Ta poprawka ustanawia tylko moment elementowy. Nie dowodzi produkcyjnego FEM
ani wyników naukowych.

- [x] Nodalne $M_s$, $\delta\mathbf{m}$, fizyczne $\delta\mathbf{M}$ oraz SI.
- [x] Dokładny moment poprzeczny stopnia 2 i osiowy stopnia 3.
- [x] Stan wszystkich czterech ścieżek FEM/FDM CPU/GPU.
- [x] Publiczne API, ProblemIR, requested intent, resolved execution,
      validation errors i unsupported combinations.
- [ ] S09 typed provider, typ realizacji 2.5D i routing pozostają proposed /
      unimplemented.
- [ ] Managed runtime, ekstrudowane 3D i niezależna walidacja fizyczna są
      otwarte.

S09 wymaga jawnej niezmienności geometrii i równowagi wzdłuż osi, semantyki
nodalnych pól w Python i ProblemIR, resolved execution, provenance oraz norm
na jednostkę długości. Kwalifikacja musi porównać rzeczywisty runtime z pełnym
3D i niezależnym TetraX. Sam bounded helper nie zastępuje tych bramek.

(scientific-bibliography)=
## Scientific bibliography

- Fullmag, [FEM frequency-domain Floquet demagnetization](0828-fem-frequency-domain-floquet-demag.md),
  kanoniczna silna postać, znaki i ograniczenia modelu.
- Fullmag, [Material regions, parameter fields, and interface couplings](0104-material-regions-parameter-fields-and-interface-couplings.md),
  kontrakt pól materiałowych w quadrature owner.
- L. Körber, G. Quasebarth, A. Otto, A. Kákay (2021),
  [Finite-element dynamic-matrix approach for spin-wave dispersions in magnonic waveguides with arbitrary cross section](https://arxiv.org/abs/2104.06943),
  DOI: [10.1063/5.0054169](https://doi.org/10.1063/5.0054169).
  To kontekst metody przekrojowej; nie dowodzi zgodności ani kwalifikacji Fullmag.

(source-code-index)=
## Source-code index

| Twierdzenie | Ścieżka | Symbol / anchor | Odpowiedzialność i stan |
|---|---|---|---|
| Kontrakt pól i momentów | backends/fem/include/frequency_domain/floquet_waveguide_cross_section.hpp | assemble_floquet_waveguide_cross_section_blocks | Typowane wejście bounded helpera, semantyka nodalna i wzory P1. |
| Walidacja i assembly | backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp | assemble_floquet_waveguide_cross_section_blocks | Moment stopnia 2/3 i gałąź uniform; bez managed runtime. |
| Regresja natywna | backends/fem/tests/frequency_domain/floquet_waveguide_cross_section_test.cpp | main | Wywołuje nodalne Ms dla signed k; przygotowana, niekompilowana. |
| Regresja interpretowana | scripts/test_waveguide_nodal_ms_quadrature_source.py | class WaveguideNodalMsQuadratureTests | Niezależna kwadratura, znaki i stara reguła; nieuruchomiona w tej kontroli. |
| Kanoniczna fizyka falowodu | docs/physics/0828-fem-frequency-domain-floquet-demag.md | DOC-ANCHOR:waveguide-envelope-contract | Silne znaki źródła i pola oraz granice modelu. |
