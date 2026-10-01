# Geometry-aware quadrature exchange dla P1 tet4/prism6 w operatorze frequency-domain FEM

- Status: implementacja źródłowa i niezależny dowód matematyczny gotowe; natywny build/test oraz runtime managed pozostają `NOT VERIFIED`
- Owners: Fullmag FEM frequency-domain
- Last updated: 2026-10-01
- Related physics: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`, `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- Related numerics: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`, `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- Related audit: `docs/audits/2026-10-01-gpt-pro-eigensolve-remediation.md`, F01

(problem-statement)=
## 1. Dziedzina fizyczna i problem

Magnetyczny obszar cienkiej warstwy może być dyskretyzowany przez elementy
`prism6`, podczas gdy powietrze wspólnej domeny Poissona może używać `tet4`.
Ta nota dotyczy wyłącznie składnika exchange w magnetycznym bloku `A_qq`
operatora liniowego FEM frequency-domain. Nie wprowadza nowej energii,
demagnetyzacji, warunku brzegowego ani zmiany parametru `A_ex`.

Wcześniejsza reguła centroid trójkąta razy środek odcinka miała jeden punkt
całkowania. Dla `prism6` prowadziła do rangi skalarnego bloku najwyżej trzy,
chociaż poprawny blok sześciowęzłowego elementu ma rangę pięć i tylko jeden
nullspace stałej. Powstawały sztuczne mody hourglass, które mogą zmieniać
częstotliwości własne.

(governing-equations)=
## 2. Model fizyczny i równania

### 2.1 Energia exchange

```{math}
:label: eq-prism6-exchange-energy
E_{\mathrm{ex}} = \int_{\Omega_m} A_{\mathrm{ex}}
\,\nabla\mathbf m : \nabla\mathbf m\,\mathrm dV.
```

Dla perturbacji stycznej zapisanej w bazie węzłowej
`\mathbf q_i=(q_{i1},q_{i2})` implementowany lokalny wkład jest:

```{math}
:label: eq-prism6-exchange-local
K_{(i,c),(j,d)} = 2 A_{\mathrm{ex}}
\int_{K}(\mathbf e_c(i)\cdot\mathbf e_d(j))
\,\nabla N_i\cdot\nabla N_j\,\mathrm dV.
```

`\mathbf e_1` i `\mathbf e_2` są zaakceptowanymi kartezjańskimi bazami
stycznymi w węzłach. Transformacja gradientu wykorzystuje Jacobian elementu:

```{math}
:label: eq-prism6-gradient-transform
\nabla_x N_i = J_K^{-T}\nabla_{\hat x}N_i,
\qquad
\mathrm dV = |\det J_K|\,\mathrm d\hat V.
```

### 2.2 Funkcje kształtu prism6 i stopień całkowania

Na trójkącie referencyjnym `\xi\geq0`, `\eta\geq0`,
`\xi+\eta\leq1` oraz `0\leq\zeta\leq1` funkcje są:

```{math}
:label: eq-prism6-shape-functions
\begin{aligned}
N_1&=(1-\xi-\eta)(1-\zeta), &N_2&=\xi(1-\zeta), &N_3&=\eta(1-\zeta),\\
N_4&=(1-\xi-\eta)\zeta, &N_5&=\xi\zeta, &N_6&=\eta\zeta.
\end{aligned}
```

Gradienty `N_i` są liniowe, więc ich iloczyn skalarny jest wielomianem
stopnia dwa. Reguła `triangle order2 × segment order2` ma trzy punkty na
trójkącie i dwa na odcinku, czyli sześć punktów o wagach `1/12`; jest dokładna
dla afinicznego prism6. Reguła `order1` ma tylko centroid i środek odcinka,
więc nie jest dopuszczalna dla exchange prism6.

Implementacja wybiera regułę względem topologii elementu, a nie jedną liczbę
order dla wszystkich geometrii:

| Topologia P1 | Reguła żądana przez backend | Własność wag | Rola |
|---|---:|---|---|
| `tet4` | MFEM order5 | wszystkie wagi referencyjne dodatnie | omija historyczną ujemną wagę simplex order4 w MFEM 4.7; zachowuje stopień co najmniej 4 |
| `prism6` | MFEM order4 | wszystkie wagi referencyjne dodatnie | overintegration wspólna z pozostałymi blokami; realizuje triangle6 × segment3 w MFEM 4.7 |

Wagi fizyczne są dodatkowo sprawdzane po pomnożeniu przez Jacobian elementu.
Wspólna polityka obejmuje exchange, field/anisotropy oraz bloki `A_phiq`,
`A_qphi` i `B_qq`; poprzednia signed quadrature w tych blokach nie była sama
w sobie błędem fizycznym. Problem F01 dotyczył ścieżki exchange, która jawnie
wymaga dodatniej wagi fizycznej. `rule.GetNPoints()` jest rejestrowane jako
rzeczywista wartość w digest, ponieważ liczba punktów zależy od wersji MFEM.

(symbols-and-si-units)=
### 2.3 Symbole i jednostki SI

| Token LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $E_{\mathrm{ex}}$ | energia exchange | $\mathrm{J}$ |
| $A_{\mathrm{ex}}$ | sztywność exchange | $\mathrm{J\,m^{-1}}$ |
| $\mathbf m$ | zredukowana magnetyzacja | $1$ |
| $\mathbf q_i$ | dwuskładowa perturbacja styczna w węźle | $1$ |
| $\mathbf e_c(i)$ | węzłowa baza styczna | $1$ |
| $N_i$ | skalarna funkcja kształtu P1 | $1$ |
| $K$ | element fizyczny | $\mathrm{m^3}$ |
| $\hat x=(\xi,\eta,\zeta)$ | punkt referencyjny | $1$ |
| $J_K$ | Jacobian mapy elementu | $\mathrm{m}$ |
| $\det J_K$ | wyznacznik Jacobiego | $\mathrm{m^3}$ |
| $\nabla_x$ | gradient fizyczny | $\mathrm{m^{-1}}$ |
| $\nabla_{\hat x}$ | gradient referencyjny | $1$ |
| $\mathrm dV$ | miara objętości | $\mathrm{m^3}$ |
| $K_{(i,c),(j,d)}$ | wpis macierzy exchange | $\mathrm{J}$ |
| $\xi$ | pierwsza współrzędna trójkąta referencyjnego | $1$ |
| $\eta$ | druga współrzędna trójkąta referencyjnego | $1$ |
| $\zeta$ | współrzędna odcinka referencyjnego | $1$ |

(assumptions-and-validity)=
## 3. Założenia i zakres ważności

- Zakres operatora pozostaje P1 `tet4 | prism6`; `pyramid5` i wyższy rząd są
  odrzucane przez istniejący kontrakt.
- Dla afinicznego prism6 reguła order2 jest dokładna matematycznie. Kod używa
  geometry-aware order4, ponieważ pozostałe bloki frequency-domain już używają
  co najmniej order4 i wszystkie bloki muszą mieć tę samą politykę quadrature.
- Dla tet4 kod używa order5. W MFEM 4.7 order4 ma 11 punktów z ujemną wagą
  `-74/5625`, więc nie może zasilić exchange, który wymaga `finite_positive`.
  MFEM 4.10 zmieniło reguły simplex na dodatniowagowe; wybór order5 pozostaje
  zgodny wstecznie i nie zależy od tej zmiany biblioteki.
- Dla zdeformowanego prism6 mapowanie może być nieafiniczne, a całkowany
  wyrażenie nie musi być wielomianem. Order4 jest wtedy polityką
  overintegration, a nie dowodem dokładności; wymagane jest porównanie z
  order5/7 i zbieżność siatkowa.
- `A_ex` pozostaje jednorodne w istniejącym kontrakcie i nie jest korygowane
  współczynnikiem kompensującym błąd quadrature.
- Znaki orientacji DOF, mapy klas globalnych i transport baz stycznych pozostają
  własnością istniejącej ścieżki assembly. Ta zmiana nie zmienia global reduction
  map ani polityki gauge.

### 3.1 Macierz i nullspace

Dla jednostkowego prism6 i skalarnego bloku bez współczynnika `2A_ex` niezależny
proof daje:

```text
rank(order2) = 5
rank(order1 centroid) = 3
K_exact(1,1) = 5/12
K_centroid(1,1) = 11/36
```

Wektor węzłowy
`u=[0,1,-1,0,-1,1]` odpowiada polu
`u(\xi,\eta,\zeta)=(1-2\zeta)(\xi-\eta)`. Ma zerowy gradient w punkcie
centroidu, ale dodatnią dokładną energię:
`\int|\nabla u|^2\,\mathrm dV=2/3`. Jest więc niezależnym testem
wykrywającym sztuczny nullspace.

(python-api)=
## 4. Python API i authoring

Ta poprawka nie dodaje parametru Python. Użytkownik nadal wybiera geometrię,
P1/prism6 i badanie eigenmodes przez istniejące API. Order quadrature jest
wewnętrzną polityką backendu FEM i nie jest obecnie publicznym parametrem
authoringu. Nie wolno deklarować użytkownikowi, że samo `order=1` oznacza
regułę całkowania elementu.

Przykład kontrolny jest wykonywalnym, niezależnym dowodem matematycznym:

```python
# %%
from pathlib import Path
import subprocess
import sys

# %%
repo = Path.cwd()
subprocess.run(
    [sys.executable, str(repo / "scripts/test_prism_exchange_quadrature.py")],
    check=True,
)
```

Obsługa backendów:

| Solver | Urządzenie | Stan tej noty |
|---|---|---|
| FEM | CPU | źródło i kontrakt przygotowane; runtime `NOT VERIFIED` |
| FEM | GPU | brak tego operatora w zakresie tej noty; `NOT APPLICABLE` dla tej implementacji |
| FDM | CPU | `NOT APPLICABLE`; FDM ma osobny operator exchange |
| FDM | GPU | `NOT APPLICABLE`; FDM ma osobny operator exchange |

(problem-ir)=
## 5. ProblemIR i lowering

Nie zmieniono `ProblemIR`, serializacji, normalizacji ani capability matrix.
Istniejące pola topologii, rzędu P1, `A_ex` i wykonania FEM pozostają źródłem
intencji użytkownika. Zmiana jest materializacją backendu CPU: operator zapisuje
politykę `p1_geometry_aware_tet5_prism4_positive` oraz topologię, rząd FE,
żądany rząd quadrature, rzeczywisty rząd i `GetNPoints()` w digest rezultatu,
aby artefakt był związany z faktyczną regułą quadrature bez zmiany publicznego
schematu.

(round-trip-and-failure-semantics)=
## 6. Round-trip, błędy i provenance

Nie zmieniono odrzuceń dla nieobsługiwanej topologii ani map klas. Element
`pyramid5` i nie-P1 nadal kończą się `unavailable`; nie ma cichego przejścia na
tetrahedron. Wspólny digest assembly zawiera teraz `quadrature_policy` o wartości
`p1_geometry_aware_tet5_prism4_positive` oraz per-element topology, FE order,
requested quadrature order, actual quadrature order i actual point count. Stare
artefakty nie mogą być traktowane jako dowód tej polityki bez zgodnego digestu.
`requested intent` pozostaje niezmienione, natomiast `resolved execution`
wskazuje na geometry-aware positive policy. Nieprawidłowe wejścia nadal kończą
się przez jawne `validation errors`, a nieobsługiwane topologie pozostają
`unsupported combinations`.

(discrete-realization)=
## 7. Realizacja dyskretna

### 7.1 FEM CPU

`frequency_domain_p1_quadrature` zwraca `mfem::IntRules.Get(geometry, 5)` dla
`tet4` i `mfem::IntRules.Get(geometry, 4)` dla `prism6`, po sprawdzeniu dodatnich
wag referencyjnych. Ta sama polityka jest używana przez exchange, statyczny
field/anisotropy oraz bloki `A_phiq`, `A_qphi` i `B_qq`; wszystkie te ścieżki
sprawdzają również dodatnią wagę fizyczną po uwzględnieniu Jacobianu. Exchange
używa `CalcPhysDShape` po ustawieniu punktu transformacji, mnoży przez
`transformation->Weight()` i zachowuje znaki orientacji DOF oraz kartezjański
iloczyn baz stycznych.

### 7.2 Pozostałe lane

FDM CPU/GPU nie konsumują tego operatora. FEM GPU nie ma w tej zmianie osobnej
implementacji ani dowodu parytetu; nie należy promować go na podstawie samego
istnienia wspólnej noty.

(implementation-mapping)=
## 8. Mapowanie implementacji

(source-native-exchange)=
`assemble_native_magnetic_a_qq` owns the native exchange weak form.

(source-quadrature-policy)=
`frequency_domain_p1_quadrature` owns the geometry-aware tet5/prism4 positive rule.

(source-shared-digest)=
`assemble_poisson_airbox_shared_domain` binds the quadrature policy to the digest.

(source-exact-oracle)=
`independent_prism_exchange_exact_affine_oracle` is the independent affine oracle.

(source-deformed-oracle)=
`independent_deformed_prism_exchange_oracle` uses analytic prism shape gradients,
the isoparametric Jacobian and independent Duffy/Gauss GL4/GL5/GL7 rules
(points per axis); it is the high-order reference for warped prism6 validation.

(source-native-regression)=
The native test `main` contains MFEM positive-rule checks, exact tetrahedral and
deformed-prism gradient oracles, rank, nullspace, hourglass, PSD, Jacobian
chain-rule, and orientation-preserving permutation checks.

(source-math-proof)=
The Python `main` runs the dependency-free rank proof.

| Kontrakt | Źródło i symbol | Odpowiedzialność |
|---|---|---|
| geometry-aware polityka dodatnich wag | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` — `frequency_domain_p1_quadrature` | wybór tet5/prism4 dla wszystkich bloków P1 |
| exchange prism6 | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` — `assemble_native_magnetic_a_qq` | transformacja gradientów i lokalny weak form |
| digest quadrature | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` — `assemble_poisson_airbox_shared_domain` | provenance operatora |
| niezależna macierz exact | `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp` — `independent_prism_exchange_exact_affine_oracle` | affine prism6 oracle bez MFEM rule/CalcPhysDShape |
| zdeformowany prism oracle | `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp` — `independent_deformed_prism_exchange_oracle` | niezależny Jacobian i Duffy/Gauss GL4/GL5/GL7, punkty na osi |
| dowód matematyczny | `scripts/test_prism_exchange_quadrature.py` — `main` | rank, diagonal, nullspace i hourglass |
| source-map exchange | `docs/physics/prism6-exchange-quadrature.md` — `DOC-ANCHOR:source-native-exchange` | stabilne mapowanie claimu exchange |
| source-map quadrature | `docs/physics/prism6-exchange-quadrature.md` — `DOC-ANCHOR:source-quadrature-policy` | stabilne mapowanie polityki quadrature |
| source-map digest | `docs/physics/prism6-exchange-quadrature.md` — `DOC-ANCHOR:source-shared-digest` | stabilne mapowanie provenance |
| source-map oracle | `docs/physics/prism6-exchange-quadrature.md` — `DOC-ANCHOR:source-exact-oracle` | stabilne mapowanie niezależnej macierzy |
| source-map deformed oracle | `docs/physics/prism6-exchange-quadrature.md` — `DOC-ANCHOR:source-deformed-oracle` | stabilne mapowanie niezależnej macierzy prism6 zdeformowanego |
| source-map native regression | `docs/physics/prism6-exchange-quadrature.md` — `DOC-ANCHOR:source-native-regression` | stabilne mapowanie regresji native |
| source-map math proof | `docs/physics/prism6-exchange-quadrature.md` — `DOC-ANCHOR:source-math-proof` | stabilne mapowanie checku Python |

(validation)=
## 9. Walidacja

### 9.1 Wykonany check interpretowany

Uruchomiono:

```text
python scripts/test_prism_exchange_quadrature.py
```

Wynik `PASS`:

```text
exact_rank = 5
centroid_rank = 3
exact_diagonal_N1 = 0.4166666666666667
centroid_diagonal_N1 = 0.3055555555555556
exact_hourglass_energy = 0.6666666666666667
centroid_hourglass_energy = 0.0
```

### 9.2 Przygotowana regresja native

`poisson_airbox_shared_domain_test.cpp` sprawdza dostępność dodatnich reguł MFEM
bez zakładania stałej liczby punktów między wersjami biblioteki, a następnie używa
niezależnej macierzy afinicznej i sprawdza:

- pozytywność reguły tet5 i prism4 oraz obecność diagnostycznej reguły tet4,
- zgodność tetrahedralnego exact-gradient oracle z natywnym exchange,
- zgodność macierzy/action z exact oracle,
- rangę 5 i zerowy residual stałej,
- dodatnią energię hourglass `8/3` po uwzględnieniu `2A_ex` dla `A_ex=2`,
- PSD,
- izolację węzłów powietrza,
- zgodność po niezależnych obrotach baz stycznych.
- dla zdeformowanego prism6: niezależne Duffy/Gauss GL4/GL5/GL7 (punkty na osi),
  zbieżność do GL7, dodatni Jacobian, transformację `J^{-T}`, PSD, stały nullspace oraz
  cycliczną permutację węzłów zachowującą orientację.

Kompilacja i uruchomienie testu native są obecnie `NOT VERIFIED` zgodnie z
polityką repozytorium zakazującą kompilacji testów jednostkowych.

### 9.3 Bramy pozostałe

Runtime managed FEM CPU, uruchomienie przygotowanej regresji deformed-prism
z niezależną referencją GL4→GL5→GL7, osobne porównanie produkcyjnych reguł
MFEM order4→order5→order7 oraz zbieżność siatkowa,
airbox convergence, porównanie z COMSOL oraz pełny nonzero-`k` eigen-solve są
`NOT VERIFIED` i nie wynikają z tego przyrostu.

(limitations)=
## 10. Ograniczenia i prace odroczone

- Nie wykonano native build/test ani runnera.
- Regresja zdeformowanego prism6 i jej niezależna GL4→GL5→GL7 convergence są
  przygotowane w źródle testu, ale nie zostały skompilowane ani uruchomione;
  produkcyjne porównanie MFEM order4→order5→order7 pozostaje osobną bramką,
  a MFEM order4 jest tylko overintegration.
- Nie zmieniono i nie zwalidowano global map, nullspace gauge ani demag.
- Nie wykonano runtime comparison z COMSOL/TetraX.
- Jeśli w przyszłości quadrature stanie się publicznym parametrem, trzeba
  rozszerzyć Python API, `ProblemIR`, planner, capability i provenance zamiast
  wprowadzać ukryty override.

(scientific-bibliography)=
## 11. Bibliografia naukowa

- MFEM 4.7, `IntegrationRules::PrismIntegrationRule` i reguły simplex:
  [intrules.cpp source](https://docs.mfem.org/4.7/intrules_8cpp_source.html).
  W tej wersji tetra order4 zawiera ujemną wagę, a order5 jest dodatni; prism
  order4 jest iloczynem reguł triangle6 i segment3.
- MFEM 4.10 changelog, zmiana reguł simplex na dodatniowagowe:
  [MFEM v4.10 CHANGELOG](https://raw.githubusercontent.com/mfem/mfem/v4.10/CHANGELOG).
  Liczba punktów pozostaje właściwością uruchomionej wersji i jest zapisywana
  przez digest zamiast być kontraktem źródłowym.
- Wersje bibliotek są pinowane w obrazach wykonawczych: CPU historycznie
  `MFEM_REF=v4.7`, a ścieżka GPU ma osobny pin; upgrade CPU do v4.10 jest
  odrębną zmianą obrazu i nie stanowi dowodu parytetu GPU.
- J. N. Reddy, *An Introduction to the Finite Element Method*, rozdziały o
  izoparametrycznych elementach pryzmatycznych i całkowaniu numerycznym.
- J. M. Melenk i I. Babuška, „The partition of unity finite element method:
  Basic theory and applications”, *Computer Methods in Applied Mechanics and
  Engineering*, DOI: [10.1016/S0045-7825(95)00844-2](https://doi.org/10.1016/S0045-7825(95)00844-2).

(source-code-index)=
## 12. Indeks źródeł i dowodów

| Twierdzenie | Źródło/symbol | Lane | Status dowodu |
|---|---|---|---|
| weak form exchange | `poisson_airbox_shared_domain.cpp` / `assemble_native_magnetic_a_qq` | FEM CPU | źródło; native `NOT VERIFIED` |
| geometry-aware tet5/prism4 positive rule | `poisson_airbox_shared_domain.cpp` / `frequency_domain_p1_quadrature` | FEM CPU | źródło + digest |
| affine rank/nullspace | `poisson_airbox_shared_domain_test.cpp` / `independent_prism_exchange_exact_affine_oracle` | FEM CPU | regresja przygotowana; native `NOT VERIFIED` |
| rank3 vs rank5 | `scripts/test_prism_exchange_quadrature.py` / `main` | niezależny proof | wykonano, `PASS` |
| deformed reference convergence | `poisson_airbox_shared_domain_test.cpp` / niezależny Duffy-Gauss GL4/GL5/GL7 | FEM CPU | przygotowane; native `NOT VERIFIED` |
| production MFEM quadrature convergence | osobna bramka MFEM order4/5/7 względem niezależnej referencji | FEM CPU | `NOT VERIFIED` |
| managed runtime / COMSOL | przyszły artefakt runnera | FEM CPU | `NOT VERIFIED` |

Maszynowa mapa dokumentu znajduje się w
`docs/physics/prism6-exchange-quadrature.source-map.json`.
