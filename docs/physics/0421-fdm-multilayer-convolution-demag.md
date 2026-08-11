# FDM: wielowarstwowa konwolucja demagnetyzacyjna

> Status: kanoniczna specyfikacja fizyczno-numeryczna. CPU FP64 ma już aktywny
> katalog kerneli i współdzielony workspace dla descriptorowego runtime, ale
> żaden lane shifted, heterogeneous, transferowy ani GPU nie jest obecnie
> production-qualified. Macierz poniżej rozdziela zgodność z BORIS od dowodu
> wykonania i od kwalifikacji produkcyjnej.

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
różnicy wyłącznie Z. Checked pair builder w
`crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel_pair`
korzysta z tego kontraktu i ma niezależne porównanie GL8 oraz test odwrotnej
transformaty FFT w
`crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs`. To jest dowód
matematyczny i wykonywalny, nie kwalifikacja produkcyjna: aktywny runner CPU
używa tej ścieżki dla nierównych grubości 2D, natomiast pełny per-layer
transfer/crop, CUDA i świeże artefakty runtime nadal pozostają bramami otwartymi.

Dokładny layout FFT dla pary ma source insertion offset $a_s$, lag-zero
$z_{d,s}$ i crop celu $C_d$. Współczynnik o lagu $q$ trafia do
$K[(q+z_{d,s})\bmod F]$, magnetyzacja do $M[(i+a_s)\bmod F]$, a wynik celu
czyta się z $H[C_d(l)]$. Forward nie normalizuje, inverse mnoży przez
$1/\prod_\alpha F_\alpha$ dokładnie raz. To są wymagane formuły descriptoru;
test ma pokryć wrap-around i niezerowy crop.

(boris-gap-matrix)=
## Macierz różnic względem BORIS

Poniższa macierz rozdziela zgodność fizyczną od zgodności interfejsu. Źródła
referencyjne BORIS są lokalne: `external_solvers/BORIS/Boris/SDemag.h`,
`SDemag.cpp`, `SDemag_MConv.cpp`, `SDemag_Demag.cpp`,
`BorisLib/VEC_MeshTransfer.h` oraz `Simulation.cpp` (komendy
`multiconvolution`, `2dmulticonvolution`, `ncommon`). Brak odpowiednika w
kolumnie Fullmag jest świadomą luką, a nie aliasem pod inną nazwą.

| Kontrakt BORIS | Co robi BORIS | Stan Fullmag | Granica i wymagany dowód |
|---|---|---|---|
| `multiconvolution=true` | Osobne FFT spaces i `Rect_collection` dla każdego mesh/layer; transfer do wspólnego scratchu i z powrotem. | `strategy="multilayer_convolution"`; każdy layer zachowuje native/scratch descriptor, a CPU FP64 buduje `kernel_catalog` i `pair_bindings` oraz używa jednego workspace na refresh. | To jest implementacyjny odpowiednik katalogu BORIS w ograniczonej ścieżce CPU. Nadal trzeba wykazać pełny per-layer insertion/crop, transfer i energię dla wszystkich centrów/extents oraz osobną kwalifikację CUDA. |
| `multiconvolution=false` | Jedna konwolucja na supermesh; komórka supermesh musi być pusta albo należeć w całości do jednego input mesh. | `strategy="single_grid"` dla wielu magnetów jest fail-closed, więc nie jest odpowiednikiem BORIS supermesh. | Brak implementacji/kwalifikacji supermesh; UI i docs nie mogą przedstawiać `single_grid` jako zamiennika. |
| `2dmulticonvolution=0` | Tryb automatyczny: 3D jest dozwolone, jeśli geometria tego wymaga. | Najbliższe `mode="three_d"`/`auto`; translacyjny FFT wymaga wspólnego pitchu na osiach próbkowanych. | Potrzebny pełny 3D cross-layer oracle dla offsetu XYZ i raport runtime. |
| `2dmulticonvolution=1` | Każdy mesh traktowany jako niezależny 2D mesh, nawet przy własnej dyskretyzacji Z. | `two_d_stack` jest legalny tylko wtedy, gdy każda warstwa ma dokładnie jedną natywną komórkę Z; dla tego podzbioru CPU ma descriptorowy katalog i workspace. | To nie jest pełne BORIS `=1`: BORIS redukuje dowolną dyskretyzację Z, a Fullmag wielokomórkowe Z odrzuca fail-closed. |
| `2dmulticonvolution=2` | Każdy mesh jest dzielony na warstwy 2D w Z; każda warstwa uczestniczy w layered convolution. | Brak implementacji i pól Python/IR/UI. | To osobna luka funkcjonalna, nie alias `two_d_stack`; potrzebne zdefiniowanie layer decomposition, transferu i testu. |
| `ncommonstatus=false` | BORIS automatycznie dobiera `n_common` z największych rozmiarów meshów (dla 2D `n_common.z=1`). | Brak flagi status; brak `common_cells*` uruchamia politykę planner-auto, opartą o union scratch i native Z. | Semantyka nie jest 1:1; provenance musi zapisywać auto-policy i resolved grid, a dokumentacja nie może nazywać jej odpowiednikiem BORIS largest-mesh default. |
| `ncommon=(nx,ny,nz)` | Użytkownik wymusza wspólną liczbę komórek; `nz=1` jest częścią polityki BORIS 2D. | `common_cells=(nx,ny,nz)` lub `common_cells_xy=(nx,ny)`; `nz=1` nie redukuje legalnie warstwy z wieloma natywnymi komórkami Z. | Walidacja wspólnego scratchu, originu i granic insertion/crop; CUDA z transferem pozostaje fail-closed. |
| Common-cell pitch | BORIS wyznacza `h_common = convolution_rect / n_common` i używa maksymalnej komórki do normalizacji wymiarów transferu. | Fullmag traktuje common-cell size, native-cell size i transform layout jako osobne pola descriptoru; transfer lub odrzucenie jest jawne, a różna geometria nie zmienia po cichu native grid. | Potrzebny osobny dowód pitch/volume oraz tolerancji transferu dla każdej klasy cell-size; samo równe `n_common` nie jest dowodem równych komórek. |
| Różne XY extents/centers | `Rect_collection` rozszerza i wyrównuje prostokąty do maksymalnego wspólnego rozmiaru, próbując zachować wspólne rzuty XY. | Planner materializuje union XY i `push_pull`; runtime waliduje insertion offset, lag-zero i destination crop, a katalog wiąże kernel z dokładnym layoutem. | CPU ma kontrakt fail-closed i testy layoutu, ale pełne różne extents/centers oraz GPU wymagają świeżych artefaktów runtime. |
| Różne grubości Z | W 2D wspólny XY cell size, ale dowolne `h_z`; kernel ma niezależne `h_src`, `h_dst`. | Checked `compute_shifted_kernel_pair` + Appendix-A Newell; aktywny CPU runner obsługuje nierówne `h_z` przy `two_d_stack`. | GL8, inverse-FFT i focused CPU test przechodzą; brak production-qualified runtime/CUDA. |
| Transfer M/H | Weighted-average do scratchu i transfer wyniku z powrotem; `VEC_MeshTransfer` ma coverage/weighting. | `push_pull` i `VolumeWeightedTransfer` istnieją oraz mają testy momentu/adjointness, ale nie są dowodem pełnej integracji każdego runnera. | Należy raportować native→scratch→native, maski aktywne, objętości i błąd transferu osobno od kernela. |
| Pełny offset XYZ | Pair kernels używają pozycji celu minus źródła; BORIS nie ogranicza się do samego `z_shift`. | Pair API przyjmuje pełny offset center-to-center; runner konwertuje lower-corner origin na środek komórki. | Dla różnych pitchów 3D translacyjny FFT jest odrzucany; direct tensor jest oracle. |
| Kernel reuse i parzystość | BORIS ma katalog kernel modules, reuse identycznych par i kontrolowane symetrie ±Z. | CPU runtime ma `kernel_catalog` (jeden tensor na unikalny `KernelReuseKey`) oraz `pair_bindings`; klucz obejmuje tryb, zorientowany offset, oba rozmiary komórek, objętości, transform/padding/crop, reprezentację, precyzję, schemat i boundary. Telemetria raportuje hit/miss, liczbę par, FFT i pamięć cold/warm. | Implementacja katalogu i workspace jest domknięta dla CPU descriptor path, lecz nie kwalifikuje jeszcze wszystkich rodzin BORIS (reduced/full, X/Y/XYZ shift) ani CUDA. Każda zmiana fingerprintu musi unieważnić reuse. |
| Storage/symmetry | BORIS rozróżnia real/reduced i full-complex; 2D zShift ma specyficzne składowe real/imag. | `TensorDemagKernel` przechowuje sześć pełnych składowych complex; reduced-storage fast path nie jest runtime-qualified. | Potrzebne testy redukcji, rekonstrukcji znaków i pamięci, osobno dla CPU/CUDA. |
| CPU/GPU | BORIS ma FFTW CPU i CUDA realizację tej samej metody. | CPU FP64 jest referencją; CUDA ma ABI/guardy i authoring/IR, lecz brak świeżej managed parity. FP32 również nie jest qualified. | Nie deklarować wsparcia wykonawczego GPU bez artefaktu urządzenia, parity i telemetry FFT. |
| PBC images | `demag_pbc_images` i `Set_PBC` stosują tę samą liczbę obrazów PBC do wszystkich meshów w supermesh i multilayer convolution. | Fullmag ma tylko boundary `open`; planner odrzuca PBC dla multilayer, a UI nie oferuje cichego fallbacku. | PBC jest pełną luką funkcjonalną: potrzebne są jawne pola Python/IR, kernel images, energia, provenance i osobna kwalifikacja CPU/CUDA. |
| Puste komórki i energia | BORIS prowadzi `non_empty_cells` oraz `total_nonempty_volume`, a energię normalizuje względem niepustej objętości; obsługuje też maski i mesh exclusion. | Fullmag zachowuje active mask na native layer, liczy energię objętościowo i publikuje target-only Airbox `H_demag`; solver mask i wizualny full-domain field są rozdzielone. | Trzeba utrzymać osobny dowód maski, objętości i energii dla każdej klasy transferu; implementacja/source test nie zastępują świeżego artefaktu runtime. |
| Antiferromagnetyczne i atomistyczne meshe | BORIS prowadzi `antiferromagnetic_meshes_present`, osobne moduły i wymuszony transfer dla atomistycznych meshów. | Fullmag publiczny multilayer contract obejmuje nazwane ferromagnetyczne obiekty FDM; nie ma semantyki AFM, atomistic mesh ani ich transferu do wspólnego scratchu. | To jawna luka zakresu produktu, nie dozwolony fallback. Wymagałaby osobnego modelu materiału, maski, transferu, energii i kwalifikacji. |
| Re-konfiguracja i invalidation | BORIS `UpdateConfiguration_MConv_Demag` niszczy i tworzy moduły po zmianie meshów, `n_common`, trybu lub PBC. | Fullmag rozwiązuje nowy plan per topology fingerprint; CPU runtime przechowuje fingerprint invalidation dla katalogu/workspace i odrzuca niezgodną geometrię. | Brakuje jeszcze end-to-end dowodu dynamicznej zmiany konfiguracji w sesji i parity po replanie; nie wolno traktować samego fingerprintu jako takiego dowodu. |
| Mesh/UI/obserwacja | BORIS operuje na input meshes i transferach; supermesh nie jest fizyczną warstwą. | Explorer/Inspector pokazuje native layers; `CommonTransformLayout` ma `physical_mesh=false`; Airbox `H_demag` jest target-only. | Scratch nie może być rysowany jako ferromagnetyczna geometria; potrzebna świeża macierz viewport/WebGL po integracji. |

Wniosek: obecny Fullmag implementuje i testuje część matematyczną BORIS-style
multilayer convolution, a CPU ma już aktywny per-layer katalog reuse i
współdzielony workspace. Nie oferuje jednak pełnego zestawu BORIS: brakuje
supermesh, pełnych semantyk `2dmulticonvolution=1/2`, PBC images, wszystkich
reprezentacji reduced/full, dynamicznej re-konfiguracji z dowodem sesyjnym oraz
kwalifikowanego CUDA. Te luki są wymaganiami implementacyjnymi, nie opcjonalnymi
ulepszeniami.

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
| FDM.cell | Sequence[float] or None | None | $\mathrm m$ | exclusive with default_cell; three positive values when present | legacy/default native cell size | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.cell | implemented authoring |
| FDM.default_cell | Sequence[float] or None | None | $\mathrm m$ | three positive values when present; needed when per_magnet is incomplete and for the current common-scratch policy | default native cell size | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.default_cell | implemented authoring |
| FDM.per_magnet | dict[str, FDMGrid] or None | None | $1$ | non-empty names and FDMGrid values | per-object native grid overrides | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.per_magnet | implemented authoring |
| FDM.demag | FDMDemag or None | None | $1$ | no explicit type check in FDM.__init__; a valid FDMDemag is required during lowering | demagnetization policy wrapper | FDM CPU/GPU authoring; runtime lane gated | backend_policy.discretization_hints.fdm.demag | implemented authoring |
| FDM.boundary_correction | str or None | None | $1$ | Python accepts none, volume, full; multilayer accepts exactly None or none and rejects volume/full before layer construction | sub-cell boundary-correction tier | FDM single-grid authoring; multilayer neutral intent only | backend_policy.discretization_hints.fdm.boundary_correction | authoring implemented; multilayer containment source-tested only |
| FDM.boundary_phi_floor | float or None | None | $1$ | Python requires $0<\phi_{\min}<1$; multilayer requires None and rejects every explicit value, including direct-IR 0.0 | minimum volume fraction for boundary correction | FDM single-grid authoring; unsupported for multilayer | backend_policy.discretization_hints.fdm.boundary_phi_floor | authoring implemented; multilayer containment source-tested only |
| FDM.boundary_delta_min | float or None | None | $\mathrm m$ | Python requires $\delta_{\min}\geq0$; multilayer requires None and rejects every explicit value, including 0.0 | minimum intersection distance for T1 stability | FDM single-grid authoring; unsupported for multilayer | backend_policy.discretization_hints.fdm.boundary_delta_min | authoring implemented; multilayer containment source-tested only |
| FDMGrid.cell | Sequence[float] | required | $\mathrm m$ | three positive values | native cell size | FDM CPU/GPU | backend_policy.discretization_hints.fdm.per_magnet.*.cell | implemented authoring |
| FDMDemag.strategy | Literal[str] | auto | $1$ | auto, single_grid, multilayer_convolution | requested demag realization | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.strategy | implemented; multilayer runtime gated |
| FDMDemag.mode | Literal[str] | auto | $1$ | auto, two_d_stack, three_d | requested multilayer mode | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.mode | implemented; runtime not qualified |
| FDMDemag.common_cells | tuple[int, int, int] or None | None | $1$ | three positive ints | explicit 3D working cell count | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.common_cells | implemented; runtime not qualified |
| FDMDemag.common_cells_xy | tuple[int, int] or None | None | $1$ | two positive ints | explicit 2D working XY count | FDM CPU/GPU | backend_policy.discretization_hints.fdm.demag.common_cells_xy | implemented; runtime not qualified |
| FDMDemag.explain | bool | True | $1$ | raw script builder requires bool; constructor does not type-check it | planner explanation request | FDM CPU/GPU authoring | not serialized by FDMDemag.to_ir | implemented authoring |
| FDMDemag.allow_single_grid_fallback | bool or None | None | $1$ | every non-None value raises ValueError | removed compatibility input; silent fallback is forbidden | unsupported | not serialized |

Parametry FDM.boundary_correction, FDM.boundary_phi_floor i
FDM.boundary_delta_min są publicznie obniżane do FDM hints. Ponieważ
FdmMultilayerPlanIR nie ma pól zachowujących tę intencję, planner przed budową
warstw akceptuje dokładnie boundary_correction równe None albo none przy obu
parametrach tuningowych równych None. Odrzuca volume/full oraz każde jawne
boundary_phi_floor lub boundary_delta_min, także 0.0. Ta sama reguła obejmuje
jawne strategy=multilayer_convolution dla jednej warstwy. Jest to wyłącznie
dowód containment planera; nie stanowi dowodu wykonania runtime ani urządzenia.

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

Publiczny stage builder rejestruje `study.fdm(...)`, niezależny termin
`study.demag(enabled=True)`, outputs, solver i etapy. Samo `to_ir()` dowodzi
jedynie authoringu. Multilayer relaxation jest obecnie legalne tylko dla
`llg_overdamped`; direct minimizers PG-BB/NCG pozostają fail-closed.

(problem-ir)=
## ProblemIR i normalizacja

FDMGrid.to_ir obniża cell do listy SI. FDMDemag.to_ir obniża strategy, mode,
common_cells i common_cells_xy do
backend_policy.discretization_hints.fdm.demag. Planner materializuje
FdmMultilayerPlanIR, FdmLayerPlanIR i FdmMultilayerSummaryIR z requested oraz
selected strategy, eligibility i oszacowaniem kerneli. FDM.to_ir zachowuje też
trzy publiczne parametry boundary w FDM hints, lecz planner multilayer nie
materializuje ich w FdmMultilayerPlanIR: przepuszcza wyłącznie neutralną
kombinację i odrzuca pozostałe przed budową FdmLayerPlanIR.

(round-trip-and-failure-semantics)=
## Round-trip i semantyka błędów

Requested intent jest intencją strategy, mode i common grid. Resolved execution
jest decyzją planera, zapisaną osobno w planner_summary i provenance runtime.
Validation errors odrzucają nielegalne counts, warstwy nakładające się,
niezgodne $h_x,h_y$ bez możliwego transferu do wspólnego scratchu, PBC i brak
transferu. Różne XY extents/centers są zachowywane jako native geometrie i
materializowane przez union computational scratch oraz `push_pull`; nie są
automatycznie odrzucane ani rysowane jako jeden fizyczny supermesh.
Unsupported combinations nie mogą potajemnie spaść do single_grid ani innej
precyzji. Jawny multilayer_convolution z jedną warstwą podlega identycznej
walidacji boundary: None/none bez tuningów przechodzi, natomiast volume/full i
każde jawne phi_floor/delta_min kończą planowanie błędem.

(discrete-realization)=
## Realizacje backendowe

| Solver | Device | Status | Stan dowodu |
|---|---|---|---|
| FDM | CPU | reference_executable | 2D exact Newell; świeże pełne oracles L=1/L=2 identity, osobny CPU `push_pull` equal + mały unequal transfer oraz target-only Airbox convergence; ogólny 3D/heterogeneous production path nadal gated |
| FDM | GPU | implemented; executable contract partial; runtime-verified no; physically-validated no; production-qualified no | CUDA istnieje, lecz current managed gate jest `not_qualified`; assisted heterogeneous operator wymaga fail-close lub ujednolicenia z CPU descriptor path |
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
Runtime utrzymuje katalog unikalnych tensorów oraz ordered pair bindings;
workspace FFT, linie pomocnicze i bufory konwolucji są alokowane raz i używane
ponownie między refreshami. Telemetria rozróżnia cold/warm bytes, hit/miss,
liczbę FFT i par oraz fingerprint invalidation, ale `residency=host` nie jest
dowodem CUDA device residency.
push_m zachowuje moment objętościowy; pull_h musi realizować $P^*$. Jeżeli
transfer nie spełni tej tożsamości, energia jest liczona na convolution grid
albo lane pozostaje gated.

(implementation-mapping)=
## Mapowanie implementacji

compute_newell_kernels i compute_newell_kernels_shifted budują 2D exact corner
tensor, a dla 3D jawnie ograniczony shifted tensor; accumulate_tensor_convolution
wykonuje mnożenie spektralne; negate_field umieszcza konwencyjny znak pola.
Transfery są push_m_with_boundary_policy oraz pull_h_with_boundary_policy, a
plannerem jest plan_fdm_multilayer. Zanim planner zbuduje warstwy, sprawdza on,
czy boundary_correction jest pominięte lub równe none oraz czy oba tuningi są
pominięte; nieneutralny intent kończy planowanie, ponieważ
FdmMultilayerPlanIR nie potrafi go zachować. `build_kernel_catalog` deduplikuje kernel
per pełny `KernelReuseKey`, `pair_bindings` zachowują orientację d←s, a
`compute_demag_fields_checked` uruchamia forward/pair/inverse z jednym
współdzielonym workspace i guardami długości. Nie jest to dowód kompletności
matematycznej: direct high-precision/cubature oracle ma należeć do osobnego
testowego ownera, niezależnego od production buildera.

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
Plannerowe testy multilayer_planner_accepts_exactly_neutral_boundary_intent i
multilayer_planner_rejects_every_non_neutral_boundary_intent sprawdzają
neutralne None/none, volume/full, jawne tuningi zerowe i dodatnie oraz jawny
single-layer multilayer_convolution. Są dowodem fail-closed source contract,
nie runtime/device proof.

(limitations)=
## Ograniczenia

Niepromowane produkcyjnie: supermesh, PBC, pełne semantyki
`2dmulticonvolution=1/2`, ogólny XY offset (authoring/planner mają ścieżkę
union-scratch + `push_pull`, lecz brak pełnego dowodu transfer/insertion/crop),
pełny 3D/heterogeneous production path, reduced/full storage classes,
dynamiczna re-konfiguracja sesji, device-resident parity, CUDA/D-07 i FP32. CPU
target-only Airbox convergence jest
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

Kolumna `Immutable link` wskazuje źródłowy snapshot lub świadomie opisuje
brak świeżego artefaktu runtime. Samo wskazanie symbolu nie podnosi statusu
kwalifikacji.

| Claim | Path | Symbol | Responsibility | Lane | Tests | Evidence status | Immutable link |
|---|---|---|---|---|---|---|---|
| Python FDM wrapper | packages/fullmag-py/src/fullmag/model/discretization.py | class FDM | lowers the full public FDM wrapper | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py::test_two_object_two_d_policy_preserves_requested_auto_in_ir | executable authoring contract only | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Python demag intent | packages/fullmag-py/src/fullmag/model/discretization.py | class FDMDemag | validates and lowers requested demag policy | FDM public API | packages/fullmag-py/tests/test_fdm_multilayer_contract.py::test_auto_mode_preserves_common_cells_for_planner_resolution | executable authoring contract only | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Continuous kernel definition (theory only) | crates/fullmag-fdm-demag/src/newell.rs | newell_f | anchors the continuous Newell primitive; no discrete runtime ownership claim | theory/oracle boundary | crates/fullmag-fdm-demag/src/newell.rs::tests::nxy_absolute_values_match_reference | theoretical-only | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Appendix A g primitive (theory only) | crates/fullmag-fdm-demag/src/newell.rs | newell_g | anchors the off-diagonal Newell primitive; no unequal-cell production owner | theory/oracle boundary | crates/fullmag-fdm-demag/src/newell.rs::tests::nxy_absolute_values_match_reference | theoretical-only | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| CPU production Newell tensor | crates/fullmag-fdm-demag/src/newell.rs | compute_newell_kernels | exact 64-corner 2D lane with bounded 3D asymptotic branch | FDM CPU reference | crates/fullmag-fdm-demag/src/newell.rs::tests::two_d_corner_kernel_matches_independent_reference_at_near_and_far_lags | runtime-verified CPU FP64; not production-qualified | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Volume-weighted reciprocity oracle | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs | unequal_cell_cubature_obeys_nontrivial_volume_weighted_reciprocity | independent unequal-volume oracle; not production proof | FDM numerical oracle | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs::unequal_cell_cubature_obeys_nontrivial_volume_weighted_reciprocity | oracle-only | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Shifted tensor | crates/fullmag-fdm-demag/src/shifted_kernel.rs | compute_shifted_kernel | builds current shifted tensor spectrum | FDM CPU oracle input | crates/fullmag-fdm-demag/tests/shifted_newell_oracle.rs::shifted_kernel_matches_independent_cubature_for_both_z_lag_directions | code/test only; not production-qualified | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Tensor product | crates/fullmag-fdm-demag/src/multiply.rs | accumulate_tensor_convolution | accumulates source into destination spectrum | FDM CPU oracle input | crates/fullmag-fdm-demag/src/multiply.rs::tests::diagonal_kernel_scales_components_independently | code/test only; not production-qualified | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Field sign | crates/fullmag-fdm-demag/src/multiply.rs | negate_field | applies the single demagnetizing minus sign to the accumulated destination spectrum before inverse FFT | FDM CPU oracle input | sign-convention source contract; independent end-to-end fixture still required | code/test only | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| CPU multilayer energy | crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs | observe_multilayer | reports current CPU demag energy | FDM CPU, current owner | crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::multilayer_reference_run_executes_two_layers | code/test only; no independent energy oracle | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| CUDA demag energy blocks | backends/fdm/gpu/cuda/runtime/reductions_fp64.cu | demag_energy_blocks_kernel | reduces FP64 demag-energy blocks | FDM CUDA FP64, current owner | planned managed CUDA energy parity | planned; no fresh managed device run | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| CUDA demag energy reduction | backends/fdm/gpu/cuda/runtime/reductions_fp64.cu | reduce_demag_energy_fp64 | launches and reduces FP64 demag energy | FDM CUDA FP64, current owner | planned managed CUDA energy parity | planned; no fresh managed device run | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Irregular Newell A1--A4 | crates/fullmag-fdm-demag/src/shifted_kernel.rs | compute_shifted_kernel_pair | current unequal-cell pair-kernel owner; `newell.rs::newell_g` remains the publication-formula anchor | FDM CPU kernel plus theory/oracle boundary | crates/fullmag-fdm-demag/tests/irregular_shifted_kernel.rs | implemented and oracle-tested in scoped CPU cases; not production-qualified | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Push transfer | crates/fullmag-fdm-demag/src/transfer.rs | push_m_with_boundary_policy | maps magnetization to convolution grid | FDM CPU transfer | local/source-unbound verifier: field, energy, and adjoint checks for different extents and $V_{native}\ne V_{scratch}$ with equal native $h_z$ | physically validated in the stated local scope; no unequal-native-cell-thickness continuum oracle | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Pull transfer | crates/fullmag-fdm-demag/src/transfer.rs | pull_h_with_boundary_policy | samples field onto native grid | FDM CPU transfer | local/source-unbound verifier: field, energy, and adjoint checks for different extents and $V_{native}\ne V_{scratch}$ with equal native $h_z$ | physically validated in the stated local scope; no unequal-native-cell-thickness continuum oracle | [master@15ab7482b](https://github.com/MateuszZelent/fullmag/commit/15ab7482b0b6f5735684fb3bf7a51f155c778860) |
| Planner | crates/fullmag-plan/src/fdm.rs | plan_fdm_multilayer | resolves public multilayer FDM plan and rejects non-neutral boundary intent before layer construction | FDM planner | crates/fullmag-plan/src/tests.rs::multilayer_planner_accepts_exactly_neutral_boundary_intent; crates/fullmag-plan/src/tests.rs::multilayer_planner_rejects_every_non_neutral_boundary_intent | executable fail-closed planner contract only; no runtime/device proof | [ed0dd3061](https://github.com/MateuszZelent/fullmag/commit/ed0dd3061c6725a9547312fbce23394ea769cb36) |
| CPU catalog and workspace | crates/fullmag-engine/src/multilayer.rs | build_kernel_catalog | deduplicates kernels and binds ordered layer pairs to one descriptor | FDM CPU FP64 | crates/fullmag-engine/src/multilayer.rs::runtime_telemetry_counts_actual_fft_pairs_and_cold_to_warm_workspace | runtime-verified CPU, not production-qualified | [dd25252ecd](https://github.com/MateuszZelent/fullmag/commit/dd25252ecd184fe60835e518ae0e466ed2fd2544) |
| CPU checked refresh | crates/fullmag-engine/src/multilayer.rs | compute_demag_fields_checked | validates native/scratch geometry and executes catalog/workspace refresh | FDM CPU FP64 | crates/fullmag-engine/src/multilayer.rs::identity_path_rejects_native_scratch_cell_count_mismatch_without_panicking | fail-closed contract; no managed production artifact | [dd25252ecd](https://github.com/MateuszZelent/fullmag/commit/dd25252ecd184fe60835e518ae0e466ed2fd2544) |
