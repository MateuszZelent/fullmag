# FDM: wielowarstwowa konwolucja demagnetyzacyjna

> Status: kanoniczna specyfikacja fizyczno-numeryczna. Żaden lane shifted,
> heterogeneous, transferowy ani GPU nie jest obecnie production-qualified.

(problem-statement)=
## Problem fizyczny

Dla $L$ rozłącznych ferromagnetycznych obiektów FDM para $(d,s)$ oznacza
odpowiednio cel i źródło. Jedyną konwencją jest
$\boldsymbol\delta_{d,s}=\mathbf o_d-\mathbf o_s$ oraz
$\mathbf H_d=-\sum_s\mathsf N_{d\leftarrow s}\mathbf M_s$. Nie wolno uzależniać
jej od kolejności warstw ani od znaku przesunięcia. Metoda używa osobnych
native i scratch grids, zachowując fizykę magnetostatyczną. Kwalifikowany
boundary mode to open; PBC jest fail-closed.

(governing-equations)=
## Równania rządzące

Model ciągły jest wyłącznie definicją pola:
$\mathbf H(\mathbf r)=-\int\mathcal N(\mathbf r-\mathbf r')\mathbf M(\mathbf r')\,\mathrm dV'$.
Podstawowym kontraktem FDM jest dyskretna suma Eq. (3) publikacji, strona 2 PDF:

```{math}
:label: eq-lepadatu-3-discrete-fdm
\mathbf H'_{k,l}=-\sum_{i=1}^{L}\sum_{\mathbf r_{i,j}\in V_i}
\mathsf N(\mathbf r'_{k,l}-\mathbf r_{i,j},\mathbf h_k,\mathbf h_i)
\mathbf M(\mathbf r_{i,j}),\qquad \mathbf r'_{k,l}\in V_k .
```

```{math}
:label: eq-multilayer-demag-field
\mathbf H_d(\mathbf r_d)=-\sum_{s=1}^{L}\int_{V_s}
\mathcal N_{d\leftarrow s}(\mathbf r_d-\mathbf r_s)\mathbf M_s(\mathbf r_s)\,\mathrm dV_s .
```

```{math}
:label: eq-multilayer-reciprocity
V_d\,\mathsf N_{d\leftarrow s}(\mathbf r)
=V_s\,\mathsf N_{s\leftarrow d}^{\mathsf T}(-\mathbf r).
```

```{math}
:label: eq-multilayer-energy
E_d=-\frac{\mu_0}{2}\sum_{c\in\mathcal A_d}V_c\,
\mathbf M_{d,c}\mathbin\cdot\mathbf H_{d,c}.
```

```{math}
:label: eq-multilayer-transfer-adjoint
\langle P\mathbf M,\mathbf H_c\rangle_{V_c}
=\langle\mathbf M,P^*\mathbf H_c\rangle_{V_n}.
```

Tensor ma sześć niezależnych składowych
$N_{xx},N_{yy},N_{zz},N_{xy},N_{xz},N_{yz}$. Reciprocity jest zawsze
volume-weighted; prosta równość tensorów jest legalna tylko przy równych
objętościach komórek. Cross-energy raportuje wkłady zorientowane
$d\leftarrow s$ oraz fizycznie symetryzowaną sumę, nie nieważony
$\mathbf M\mathbin\cdot\mathbf H$.

Równanie ciągłe powyżej wyjaśnia pole, lecz implementowany kontrakt FDM jest
sumą po komórkach. Zgodnie z równaniem (3) Lepadatu (2019),
$\mathbf H_{k,l}'=-\sum_{i=1}^{L}\sum_{\mathbf r_{i,j}\in V_i}
\mathsf N(\mathbf r_{k,l}'-\mathbf r_{i,j},\mathbf h_k,\mathbf h_i)
\mathbf M(\mathbf r_{i,j})$. Wymiar źródła i celu jest częścią kernela.
Macierz $\mathsf N$ ma sześć składowych niezależnych:
$\mathsf N=[N_{xx},N_{xy},N_{xz};N_{xy},N_{yy},N_{yz};N_{xz},N_{yz},N_{zz}]$.

```{math}
:label: eq-lepadatu-4-transfer
\mathbf M(\mathbf r')=\sum_{i\in P}w_i\mathbf M(\mathbf r_i).
```

```{math}
:label: eq-lepadatu-5-weights
w_i=\frac{\widetilde d_i\delta_i}{\widetilde d_T},\quad
\widetilde d_T=\sum_{i\in P}\widetilde d_i\delta_i,\quad
\widetilde d_i=\frac{\lvert\mathbf h'+\mathbf h\rvert}{2}-\lvert\mathbf r'-\mathbf r_i\rvert .
```

Równania (4)--(5) publikacji są transferem weighted-average: dla punktu
scratch $\mathbf r'$ i komórek wejściowych $c_i$,
$\mathbf M(\mathbf r')=\sum_i w_i\mathbf M(\mathbf r_i)$,
$w_i=\widetilde d_i\delta_i/\sum_j\widetilde d_j\delta_j$,
$\widetilde d_i=\lvert(\mathbf h'+\mathbf h)/2\rvert-\lvert\mathbf r'-\mathbf r_i\rvert$,
gdzie $\delta_i$ wybiera komórki zachodzące. To jest cytowany model
transferu, nie dowód, że obecny Fullmag realizuje adjoint $P^*$; ten warunek
jest kanoniczną, planowaną bramą orakla.

Appendix A publikacji, strony 6--7 PDF, definiuje nieregularny Newell:

```{math}
:label: eq-lepadatu-a1
N_{xx}(\mathbf s)=L[f;\mathbf h_s,\mathbf h_d](\mathbf s),\qquad
N_{xy}(\mathbf s)=L[g;\mathbf h_s,\mathbf h_d](\mathbf s).
```

```{math}
:label: eq-lepadatu-a2
L[w;\mathbf h_s,\mathbf h_d](\mathbf s)=\frac{1}{\tau}
\sum_{\epsilon_1,\epsilon_2=-1}^{1}(-1)^{|\epsilon_1|+|\epsilon_2|}
\bigl[-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-h_{s,z})
-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z+h_{d,z})
+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z)
+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-\Delta)\bigr].
```

```{math}
:label: eq-lepadatu-a3
R^2=x^2+y^2+z^2,\quad \tau=\pi h_xh_yh_{d,z},\quad\Delta=h_{s,z}-h_{d,z},
\qquad f=\frac{(2x^2-y^2-z^2)R}{6}
+\frac{y(z^2-x^2)}{4}\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)
+\frac{z(y^2-x^2)}{4}\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right)
-xyz\arctan\!\frac{yz}{xR}.
```

```{math}
:label: eq-lepadatu-a4
g=-\frac{xyR}{3}-\frac{z^3}{6}\arctan\!\frac{xy}{zR}
-\frac{zy^2}{2}\arctan\!\frac{xz}{yR}
-\frac{zx^2}{2}\arctan\!\frac{yz}{xR}
+\frac{y(3z^2-y^2)}{12}\ln\!\left(1+\frac{2x(x+R)}{y^2+z^2}\right)
+\frac{x(3z^2-x^2)}{12}\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)
+\frac{xyz}{2}\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right),
\qquad\mathbf h_s=(h_x,h_y,h_{s,z}),\quad\mathbf h_d=(h_x,h_y,h_{d,z}).
```

To literalne formy Appendix A, strony 6--7 lokalnego PDF; permutacje osi
dają pozostałe elementy tensora zgodnie z Newell et al. (1993).

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf H$ | pole magnetostatyczne w modelu ciągłym | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_d$ | pole demagnetyzujące celu | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H'_{k,l}$ | dyskretne pole celu k,l | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{d,c}$ | pole demagnetyzujące aktywnej komórki celu c | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_c$ | pole na siatce konwolucyjnej | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M_s$ | magnetyzacja źródła | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M$ | magnetyzacja komórkowa | $\mathrm{A\,m^{-1}}$ |
| $\mathbf M_{d,c}$ | magnetyzacja aktywnej komórki celu c | $\mathrm{A\,m^{-1}}$ |
| $\mathsf N_{d\leftarrow s}$ | dyskretny tensor demagnetyzujący | $1$ |
| $\mathsf N$ | tensor demagnetyzujący pary komórek Eq. (3) | $1$ |
| $\mathcal N$ | ciągłe jądro magnetostatyczne | $\mathrm{m^{-3}}$ |
| $\mathcal N_{d\leftarrow s}$ | ciągłe jądro kierunkowane od źródła s do celu d | $\mathrm{m^{-3}}$ |
| $\mathbf r_d$ | środek komórki celu | $\mathrm m$ |
| $\mathbf r_s$ | środek komórki źródła | $\mathrm m$ |
| $\mathbf r$ | wektor przesunięcia w reciprocity | $\mathrm m$ |
| $\mathbf r'_{k,l}$ | pozycja komórki celu w Eq. (3) | $\mathrm m$ |
| $\mathbf r_{i,j}$ | pozycja komórki źródła w Eq. (3) | $\mathrm m$ |
| $V_i$ | objętość domeny źródłowej i | $\mathrm{m^3}$ |
| $V_d$ | objętość komórki celu | $\mathrm{m^3}$ |
| $V_s$ | objętość komórki źródła | $\mathrm{m^3}$ |
| $V_c$ | objętość aktywnej komórki | $\mathrm{m^3}$ |
| $V_n$ | objętość komórki siatki native | $\mathrm{m^3}$ |
| $\mathrm dV'$ | element objętości źródła | $\mathrm{m^3}$ |
| $\mathrm dV_s$ | element objętości źródła s | $\mathrm{m^3}$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{N\,A^{-2}}$ |
| $E_d$ | energia demagnetyzacyjna celu | $\mathrm J$ |
| $\mathbf h_k$ | rozmiar komórki celu Eq. (3) | $\mathrm m$ |
| $\mathbf h_i$ | rozmiar komórki źródła Eq. (3) | $\mathrm m$ |
| $\mathbf h_s$ | rozmiar komórki źródła Appendix A | $\mathrm m$ |
| $\mathbf h_d$ | rozmiar komórki celu Appendix A | $\mathrm m$ |
| $\mathbf h'$ | cell size transferu | $\mathrm m$ |
| $\mathbf h$ | cell size wejściowej siatki transferu | $\mathrm m$ |
| $h_x$ | rozmiar komórki w osi x Appendix A | $\mathrm m$ |
| $h_y$ | rozmiar komórki w osi y Appendix A | $\mathrm m$ |
| $h_{s,z}$ | grubość komórki źródła | $\mathrm m$ |
| $h_{d,z}$ | grubość komórki celu | $\mathrm m$ |
| $\mathbf r_i$ | środek komórki transferu | $\mathrm m$ |
| $\mathbf r'$ | punkt transferu | $\mathrm m$ |
| $P$ | transfer native do scratch | $1$ |
| $P^*$ | adjoint transferu scratch do native | $1$ |
| $\mathcal A_d$ | aktywne komórki celu | $1$ |
| $w_i$ | waga transferu | $1$ |
| $\delta_i$ | wskaźnik nakładania komórki | $1$ |
| $\widetilde d_i$ | odległość ważona transferu | $\mathrm m$ |
| $\widetilde d_T$ | suma odległości ważonych | $\mathrm m$ |
| $L$ | operator ośmiu narożników Newella | $1$ |
| $f$ | funkcja bazowa Newella diagonalna | $\mathrm{m^3}$ |
| $g$ | funkcja bazowa Newella off-diagonal | $\mathrm{m^3}$ |
| $\mathbf s=(x,y,z)$ | wektor argumentu Appendix A | $\mathrm m$ |
| $x$ | współrzędna x Appendix A | $\mathrm m$ |
| $y$ | współrzędna y Appendix A | $\mathrm m$ |
| $z$ | współrzędna z Appendix A | $\mathrm m$ |
| $R$ | $\sqrt{x^2+y^2+z^2}$ | $\mathrm m$ |
| $\tau$ | normalizacja stencila | $\mathrm{m^3}$ |
| $\Delta$ | różnica grubości źródła i celu | $\mathrm m$ |
| $\epsilon_1,\epsilon_2$ | indeksy stencila | $1$ |
| $\epsilon_1$ | indeks narożnika x/y | $1$ |
| $\epsilon_2$ | indeks narożnika x/y | $1$ |
| $N_{xx}$ | składowa diagonalna xx | $1$ |
| $N_{xy}$ | składowa off-diagonal xy | $1$ |
| $N_{dd}$ | składowa diagonalna celu w Table I | $1$ |
| $N_{xz}$ | składowa off-diagonal xz w Table I | $1$ |
| $N_{yz}$ | składowa off-diagonal yz w Table I | $1$ |
| $w$ | funkcja bazowa Newella w Appendix A | $\mathrm{m^3}$ |
| $k,l,i,j,V_i$ | indeksy komórek celu i źródła oraz domena źródłowa Eq. (3) | $1$ |

(assumptions-and-validity)=
## Założenia i granice ważności

Każda warstwa ma native_grid, scratch_grid, origin i $h_z$.
common_transform_layout opisuje wyłącznie shape FFT, strides, padding i
konwencję transformacji, nie fizyczny grid. Dla osi liniowej
$n_{\mathrm{linear}}=n_{\mathrm{source}}+n_{\mathrm{destination}}-1$; fft_shape
nie może być mniejszy. Descriptor zawiera source insertion offset, lag-zero,
mapę lagów ujemnych, destination crop window, R2C na osi X o długości
$N_x/2+1$, x-fastest indexing, normalizację inverse i zerowanie paddingu.

two_d_stack ma jedną roboczą komórkę Z na warstwę. Tekstura
$\mathbf M(z)$ wymaga jawnego transferu i testu 2D-vs-3D albo wyboru three_d.
2D używa moment-zachowującej średniej przez grubość. Appendix-A dla nierównych
grubości wymaga wspólnego $h_x,h_y$ pary; inne XY wymagają transferu do
wspólnego scratch XY albo odrzucenia. Reuse $+\Delta z/-\Delta z$ jest legalny
wyłącznie dla two_d_stack, czystego shift Z i zorientowanej pary o równych $h$.

Tabela I Lepadatu rozróżnia 2D-self, 3D-self, 2D-zShift, 3D-zShift oraz
2D/3D-full: self używa kerneli real i reduced storage; 2D-zShift ma
diagonalne i $xy$ real oraz $xz,yz$ imaginary w reduced storage; 3D-zShift
i full są complex, przy czym full wymaga full storage. Tabela I jest celem
reprezentacji; obecny Fullmag nie ma jeszcze runtime evidence tej redukcji.
Appendix A, równania (A1)--(A4), określa irregular Newell dla
$\mathbf h_s=(h_x,h_y,h_{s,z})$ i $\mathbf h_d=(h_x,h_y,h_{d,z})$, a więc
różnicy wyłącznie Z. Implementacja produkcyjna musi przejść niezależny oracle
tych równań; nie jest nim aktualny shifted builder.

Dokładny layout FFT dla pary ma source insertion offset $a_s$, lag-zero
$z_{d,s}$ i crop celu $C_d$. Współczynnik o lagu $q$ trafia do
$K[(q+z_{d,s})\bmod F]$, magnetyzacja do $M[(i+a_s)\bmod F]$, a wynik celu
czyta się z $H[C_d(l)]$. Forward nie normalizuje, inverse mnoży przez
$1/\prod_\alpha F_\alpha$ dokładnie raz. To są wymagane formuły descriptoru;
test ma pokryć wrap-around i niezerowy crop.

| Table I class | Warunek | $N_{dd}$: x/y/z | $N_{xy}$: x/y/z | $N_{xz}$: x/y/z | $N_{yz}$: x/y/z | DFT/storage |
|---|---|---|---|---|---|---|
| 2D-self | jeden cell Z | even/even/n.a. | odd/odd/n.a. | zero | zero | real/reduced |
| 3D-self | $\mathbf h_i=\mathbf h_j$ | even/even/even | odd/odd/even | odd/even/odd | even/odd/odd | real/reduced |
| 2D-zShift | $h_{x,y,i}=h_{x,y,j}$ | even/even/n.a. | odd/odd/n.a. | odd/even/n.a. | even/odd/n.a. | dd,xy real; xz,yz imaginary; reduced |
| 3D-zShift | $\mathbf h_i=\mathbf h_j$ | even/even/even | odd/odd/even | odd/even/odd | even/odd/odd | complex/reduced |
| 2D-full | $h_{x,y,i}=h_{x,y,j}$ | none/none/n.a. | none/none/n.a. | none/none/n.a. | none/none/n.a. | complex/full |
| 3D-full | $\mathbf h_i=\mathbf h_j$ | none/none/none | none/none/none | none/none/none | none/none/none | complex/full |

(python-api)=
## Publiczny Python API

| Parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR | Qualification |
|---|---|---|---|---|---|---|---|
| FDM.cell | Sequence[float] or None | None | $\mathrm m$ | exclusive with default_cell; three positive values when present | legacy/default native cell size | FDM CPU/GPU authoring; runtime lane gated | discretization.fdm.cell | implemented authoring |
| FDM.default_cell | Sequence[float] or None | None | $\mathrm m$ | three positive values when present | default native cell size | FDM CPU/GPU authoring; runtime lane gated | discretization.fdm.default_cell | implemented authoring |
| FDM.per_magnet | dict[str, FDMGrid] or None | None | $1$ | non-empty names and FDMGrid values | per-object native grid overrides | FDM CPU/GPU authoring; runtime lane gated | discretization.fdm.per_magnet | implemented authoring |
| FDM.demag | FDMDemag or None | None | $1$ | FDMDemag instance | demagnetization policy wrapper | FDM CPU/GPU authoring; runtime lane gated | discretization.fdm.demag | implemented authoring |
| FDMGrid.cell | Sequence[float] | required | $\mathrm m$ | three positive values | native cell size | FDM CPU/GPU | discretization.fdm.per_magnet.*.cell | implemented authoring |
| FDMDemag.strategy | Literal[str] | auto | $1$ | auto, single_grid, multilayer_convolution | requested demag realization | FDM CPU/GPU | discretization.fdm.demag.strategy | implemented; multilayer runtime gated |
| FDMDemag.mode | Literal[str] | auto | $1$ | auto, two_d_stack, three_d | requested multilayer mode | FDM CPU/GPU | discretization.fdm.demag.mode | implemented; runtime not qualified |
| FDMDemag.common_cells | tuple[int, int, int] or None | None | $1$ | three positive ints | explicit 3D working cell count | FDM CPU/GPU | discretization.fdm.demag.common_cells | implemented; runtime not qualified |
| FDMDemag.common_cells_xy | tuple[int, int] or None | None | $1$ | two positive ints | explicit 2D working XY count | FDM CPU/GPU | discretization.fdm.demag.common_cells_xy | implemented; runtime not qualified |
| FDMDemag.explain | bool | True | $1$ | boolean | planner explanation request | FDM CPU/GPU authoring | discretization.fdm.demag.explain (authoring metadata; no lowered physics field) | implemented authoring |

Parametry FDM.boundary_correction, FDM.boundary_phi_floor i
FDM.boundary_delta_min są publicznie obniżane do FDM hints, lecz nie są
semantyką multilayer-convolution tej noty: pozostają wykluczone z tego
kontraktu, dopóki planner nie poda ich per-layer wpływu na transfer/kernel.
Wykluczenie jest jawne; nie oznacza pominięcia wartości przez obecny wrapper.

```python
# %% Imports
import fullmag as fm

# %% Discretization intent
grid = fm.FDMGrid(cell=(3.90625e-9, 3.90625e-9, 3.0e-9))
demag = fm.FDMDemag(strategy="multilayer_convolution", mode="two_d_stack", common_cells_xy=(128, 32))

# %% Lowering check
assert grid.to_ir()["cell"][2] == 3.0e-9
assert demag.to_ir()["strategy"] == "multilayer_convolution"
```

Obecna biblioteka nie udostępnia pełnej rejestracji tej interakcji przez
publiczny stage builder. Dokumentacja nie udaje działającego stage workflow
przed implementacją i runtime proof tej granicy.

(problem-ir)=
## ProblemIR i normalizacja

FDMGrid.to_ir obniża cell do listy SI. FDMDemag.to_ir obniża strategy, mode,
common_cells i common_cells_xy do discretization.fdm.demag. Planner materializuje
FdmMultilayerPlanIR, FdmLayerPlanIR i FdmMultilayerSummaryIR z requested oraz
selected strategy, eligibility i oszacowaniem kerneli.

(round-trip-and-failure-semantics)=
## Round-trip i semantyka błędów

Requested intent jest intencją strategy, mode i common grid. Resolved execution
jest decyzją planera, zapisaną osobno w planner_summary i provenance runtime.
Validation errors odrzucają nielegalne counts, warstwy nakładające się,
niekwalifikowane offsety, niezgodne $h_x,h_y$, PBC i brak transferu.
Unsupported combinations nie mogą potajemnie spaść do single_grid ani innej
precyzji.

(discrete-realization)=
## Realizacje backendowe

| Solver | Device | Status | Stan dowodu |
|---|---|---|---|
| FDM | CPU | reference_executable | 2D exact Newell; świeże pełne oracles L=1/L=2 identity, osobny CPU `push_pull` equal + mały unequal transfer oraz target-only Airbox convergence; ogólny 3D/heterogeneous production path nadal gated |
| FDM | GPU | implemented | CUDA istnieje; wymaga świeżej parity device |
| FEM | CPU | not-applicable | nota opisuje FDM FFT/Newell, nie FEM magnetostatykę |
| FEM | GPU | not-applicable | nota opisuje FDM FFT/Newell, nie FEM magnetostatykę |

CPU FP64 jest referencyjnym lane’em wykonawczym, nie niezależnym oraklem
matematyki kernela. W lane’ach 2D (`n_z=1`) produkcyjny `newell.rs` liczy
całkę po objętości przez stabilną sumę 64 narożników dla każdego laga; dla
ogólnego 3D odległe pary mogą nadal korzystać z jawnie ograniczonego
point-dipole asymptotic branch. Niezależny verifier ma własny Newell/GL8 i
kanonikalizuje znaki laga przez parzystość tensora, więc nie porównuje
niestabilnych, osobno obliczonych ujemnych lagów. Pełne pokrycie pola i energii
dla zweryfikowanych L=1/L=2 identity zostało wykonane; mały heterogeneous
`push_pull` ma osobny pełny verifier. Każdy destination spectrum jest
zerowany, sumuje źródła, potem inverse FFT i pull_h zwracają pole do native grid.
push_m zachowuje moment objętościowy; pull_h musi realizować $P^*$. Jeżeli
transfer nie spełni tej tożsamości, energia jest liczona na convolution grid
albo lane pozostaje gated.

(implementation-mapping)=
## Mapowanie implementacji

compute_newell_kernels i compute_newell_kernels_shifted budują 2D exact corner
tensor, a dla 3D jawnie ograniczony shifted tensor; accumulate_tensor_convolution
wykonuje mnożenie spektralne; negate_field
umieszcza konwencyjny znak pola. Transfery są push_m_with_boundary_policy oraz
pull_h_with_boundary_policy, a plannerem jest plan_fdm_multilayer. Nie jest to
dowód kompletności matematycznej: direct high-precision/cubature oracle ma
należeć do osobnego testowego ownera, niezależnego od production buildera.

(validation)=
## Plan walidacji

Małe asymetryczne przypadki porównują niezależną cubature lub high-precision
fixtures dla sześciu składowych i znaków $\pm x,\pm y,\pm z$. Testy obejmują
linear extent, crop, padding, source offset, weighted reciprocity, energy
finite difference, transfer adjointness, stałe pola, moment i active mask.

sp4-derived-multilayer, a nie kanoniczny µMAG SP4, sprawdza L=1, bilayer,
three-layer, równe/nierówne grubości oraz identity/push_pull. CPU target-only
Airbox convergence ma osobny świeży dowód dla meshów `160×40×18` i
`160×40×24` przy `115200/115200` wspólnych centrach; nie zastępuje to
kwalifikacji device ani pełnej macierzy wizualnej. Paper-reproduction
lane ma osobno odtworzyć geometrię publikacji: trilayer Ni80Fe20
$640\times320\,\mathrm{nm^2}$, grubości $20/10/20\,\mathrm{nm}$ i szczeliny
$1\,\mathrm{nm}$ przy polu $20\,\mathrm{kA\,m^{-1}}$ pod $5^\circ$, a następnie
Co skyrmion disks o średnicy $512\,\mathrm{nm}$, grubości $1\,\mathrm{nm}$ i
spacerze $3\,\mathrm{nm}$. To lane traceability, nie zastępstwo dla orakla
ani kwalifikacji SP4. Airbox jest
target-only observation carrier: pierwsza promocja publikuje H_demag; H_eff
poza domeną magnetyczną ma versioned unavailable reason. CPU FP64, CUDA FP64 i
CUDA FP32 wymagają osobnych artefaktów runtime, urządzenia i tolerancji.

(limitations)=
## Ograniczenia

Niepromowane: PBC, ogólny XY offset, pełny 3D/heterogeneous production path,
device-resident parity, CUDA/D-07 i FP32. CPU target-only Airbox convergence jest
kwalifikowane wyłącznie w opisanym zakresie dwóch meshów. Test źródłowy, build albo
screenshot nie są dowodem fizycznej ani produkcyjnej kwalifikacji.

(scientific-bibliography)=
## Bibliografia naukowa

1. S. Lepadatu, Efficient computation of demagnetizing fields for magnetic
   multilayers using multilayered convolution, Journal of Applied Physics
   **126**, 103903 (2019),
   [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
2. A. J. Newell, W. Williams i D. J. Dunlop, A generalization of the
   demagnetizing tensor for nonuniform magnetization, Journal of Geophysical
   Research: Solid Earth **98**, 9551--9555 (1993),
   [doi:10.1029/93JE01171](https://doi.org/10.1029/93JE01171).
3. A. Aharoni, Demagnetizing factors for rectangular ferromagnetic prisms,
   Journal of Applied Physics **83**, 3432 (1998),
   [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).

Jedynym snapshotem BORIS użytym do traceability jest manifest
multilayer_convolution/boris-reference-manifest.v1.json. Nie jest to źródło
kwalifikacji, orakl numeryczny ani licencja na kopiowanie kodu.

(source-code-index)=
## Indeks kodu źródłowego

Dokumentacja jest obecnie niecommitowana. Kolumna `Immutable link` jawnie
raportuje brak SHA; po commitcie musi zostać zastąpiona linkiem do pełnego
SHA i stabilnego symbolu.

| Claim | Path | Symbol | Responsibility | Lane | Tests | Evidence status | Immutable link |
|---|---|---|---|---|---|---|---|
| Python FDM wrapper | packages/fullmag-py/src/fullmag/model/discretization.py | class FDM | lowers the full public FDM wrapper | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py::test_two_object_two_d_policy_preserves_requested_auto_in_ir | executable authoring contract only | UNCOMMITTED (no SHA) |
| Python demag intent | packages/fullmag-py/src/fullmag/model/discretization.py | class FDMDemag | validates and lowers requested demag policy | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py::test_auto_mode_preserves_common_cells_for_planner_resolution | executable authoring contract only | UNCOMMITTED (no SHA) |
| Continuous kernel definition (theory only) | crates/fullmag-fdm-demag/src/newell.rs | newell_f | anchors the continuous Newell primitive; no discrete runtime ownership claim | theory/oracle boundary | crates/fullmag-fdm-demag/src/newell.rs::tests::nxy_absolute_values_match_reference | theoretical-only | UNCOMMITTED (no SHA) |
| Appendix A g primitive (theory only) | crates/fullmag-fdm-demag/src/newell.rs | newell_g | anchors the off-diagonal Newell primitive; no unequal-cell production owner | theory/oracle boundary | crates/fullmag-fdm-demag/src/newell.rs::tests::nxy_absolute_values_match_reference | theoretical-only | UNCOMMITTED (no SHA) |
| CPU production Newell tensor | crates/fullmag-fdm-demag/src/newell.rs | compute_newell_kernels | exact 64-corner 2D lane with bounded 3D asymptotic branch | FDM CPU reference | crates/fullmag-fdm-demag/src/newell.rs::tests::two_d_corner_kernel_matches_independent_reference_at_near_and_far_lags | runtime-verified CPU FP64; not production-qualified | UNCOMMITTED (no SHA) |
| Volume-weighted reciprocity oracle | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs | unequal_cell_cubature_obeys_nontrivial_volume_weighted_reciprocity | independent unequal-volume oracle; not production proof | FDM numerical oracle | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs::unequal_cell_cubature_obeys_nontrivial_volume_weighted_reciprocity | oracle-only | UNCOMMITTED (no SHA) |
| Shifted tensor | crates/fullmag-fdm-demag/src/shifted_kernel.rs | compute_shifted_kernel | builds current shifted tensor spectrum | FDM CPU oracle input | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs::shifted_kernel_matches_independent_cubature_for_both_z_lag_directions | code/test only; not production-qualified | UNCOMMITTED (no SHA) |
| Tensor product | crates/fullmag-fdm-demag/src/multiply.rs | accumulate_tensor_convolution | accumulates source into destination spectrum | FDM CPU oracle input | crates/fullmag-fdm-demag/src/multiply.rs::tests::diagonal_kernel_scales_components_independently | code/test only; not production-qualified | UNCOMMITTED (no SHA) |
| Field sign | crates/fullmag-fdm-demag/src/multiply.rs | negate_field | applies the field-sign convention after inverse transform | FDM CPU oracle input | planned sign-convention fixture | planned | UNCOMMITTED (no SHA) |
| CPU multilayer energy | crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs | observe_multilayer | reports current CPU demag energy | FDM CPU, current owner | crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::multilayer_reference_run_executes_two_layers | code/test only; no independent energy oracle | UNCOMMITTED (no SHA) |
| CUDA demag energy blocks | backends/fdm/gpu/cuda/runtime/reductions_fp64.cu | demag_energy_blocks_kernel | reduces FP64 demag-energy blocks | FDM CUDA FP64, current owner | planned managed CUDA energy parity | planned; no fresh managed device run | UNCOMMITTED (no SHA) |
| CUDA demag energy reduction | backends/fdm/gpu/cuda/runtime/reductions_fp64.cu | reduce_demag_energy_fp64 | launches and reduces FP64 demag energy | FDM CUDA FP64, current owner | planned managed CUDA energy parity | planned; no fresh managed device run | UNCOMMITTED (no SHA) |
| Irregular Newell A1--A4 | crates/fullmag-fdm-demag/src/newell.rs | newell_g | publication formulas only; no unequal-cell production owner | planned theory/oracle | planned independent Appendix-A oracle | theoretical-only; implementation planned | UNCOMMITTED (no SHA) |
| Push transfer | crates/fullmag-fdm-demag/src/transfer.rs | push_m_with_boundary_policy | maps magnetization to convolution grid | FDM CPU transfer | crates/fullmag-fdm-demag/src/transfer.rs::tests::push_m_coarsening_averages | code/test only; adjointness unqualified | UNCOMMITTED (no SHA) |
| Pull transfer | crates/fullmag-fdm-demag/src/transfer.rs | pull_h_with_boundary_policy | samples field onto native grid | FDM CPU transfer | crates/fullmag-fdm-demag/src/transfer.rs::tests::identity_transfer_is_noop | code/test only; adjointness unqualified | UNCOMMITTED (no SHA) |
| Planner | crates/fullmag-plan/src/fdm.rs | plan_fdm_multilayer | resolves public multilayer FDM plan | FDM planner | crates/fullmag-plan/src/tests.rs::multilayer_planner_resolves_common_grid_modes_without_overriding_explicit_mode | executable planner contract only | UNCOMMITTED (no SHA) |
