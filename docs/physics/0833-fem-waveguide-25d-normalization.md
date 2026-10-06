# Proponowana norma amplitudy dla waveguide FEM 2.5D

- Status: planned contract / source-visible / runtime unverified. Ta nota
  definiuje przyszłą semantykę S09 i nie zmienia istniejących pól artefaktów,
  tokenów Python ani ProblemIR.
- Właściciel: Fullmag FEM frequency-domain waveguide backend.
- Ostatnia aktualizacja: 2026-10-03.
- Powiązane dokumenty: 0828 (eq-0828-waveguide-envelope-demag),
  0831 (eq-fem-waveguide-envelope-demag, eq-fem-waveguide-weak-source-sign,
  eq-fem-waveguide-section-measure), 0832 (FloquetWaveguideCrossSectionProblem).
- Powiązana decyzja: docs/adr/0031-fem-nonzero-k-dispersion-representations.md.
  Publiczna reprezentacja waveguide i jej ProblemIR wymagają osobnej decyzji;
  ta nota nie edytuje ADR ani planu.
- Proponowany kontrakt do review: docs/adr/0035-eigen-spatial-representation-contract.md
  oraz docs/specs/fem-waveguide-spatial-representation-v1.md. Oba dokumenty są
  projektowane i nie stanowią dowodu działającego runtime.

(problem-statement)=
## 1. Domena fizyczna i problem

Waveguide 2.5D opisuje magnetyczny przekrój $\Sigma_m$ niezmienny wzdłuż
wybranej osi propagacji $\hat{\mathbf z}$. Dla konwencji
$\exp(-\mathrm{i}kz)$ surowy kształt zaburzenia jest zespolonym,
bezwymiarowym polem stycznym
$\delta\mathbf m:\Sigma_m\rightarrow\mathbb C^3$. Jest to shape modu,
nie jego fizyczna amplituda.

Dokumenty 0828 i 0831 ustalają równanie zmodyfikowanego Helmholtza, znaki
$-\mathrm{i}k\delta M_z$ i $+\mathrm{i}k\phi$ oraz fakt, że całki sekcji są
raportowane na jednostkę długości. 0832 ustala nodalną interpolację $M_s$ i
jednostki bloków źródłowych. Brakuje jednej reguły wiążącej surowe
$\delta\mathbf m$, pole wynikowe, potencjał, energię i długość ekstrudowania.
Ta nota proponuje tę regułę wyłącznie dla przyszłego typed waveguide contract.

Nie wolno odczytywać tej propozycji jako zmiany obecnego
normalization=unit_l2 lub normalization=unit_max_amplitude. Obecne źródła i
artefakty zachowują własną semantykę do czasu przyjęcia nowej reprezentacji
w Pythonie, ProblemIR, plannerze i native ABI.

(governing-equations)=
## 2. FEM waveguide: równania i skala

### 2.1 Surowy shape i norma geometryczna

Niech $dA$ będzie miarą pola magnetycznego przekroju. Definiujemy:

(eq-0833-raw-shape-area-norm)=
```{math}
:label: eq-0833-raw-shape-area-norm
\begin{aligned}
\delta\mathbf m(\mathbf r_\perp)
  &\in \mathbb C^3,\qquad
    \mathbf m_0(\mathbf r_\perp)\cdot\delta\mathbf m(\mathbf r_\perp)=0,\\
I_2[\delta\mathbf m]
  &=\int_{\Sigma_m}\delta\mathbf m^\dagger
    \delta\mathbf m\,\mathrm dA,
  &&[I_2]=\mathrm{m^2}.
\end{aligned}
```

Warunek ciągły odnosi zaburzenie do lokalnej magnetyzacji równowagowej
$\mathbf m_0(\mathbf r_\perp)$, a nie do osi propagacji. Dlatego składowa
osiowa względem $\hat{\mathbf z}$ może być niezerowa, gdy wymaga tego rama
styczna (np. stan DE/BV). W dyskretyzacji przyjmujemy tylko warunek nodalny
$T_i^\mathsf T\mathbf m_{0,i}=0$; przy zmiennym $\mathbf m_0$ nie wynika z
niego dokładna styczność punktowa wewnątrz elementu do interpolowanego
$\mathbf m_0$.

Kreska $\dagger$ oznacza sprzężenie hermitowskie. Norma $I_2$ obejmuje tylko
obszar magnetyczny, nie airbox. Dla $I_2>0$ definiujemy envelope unit L2:

(eq-0833-unit-l2-envelope)=
```{math}
:label: eq-0833-unit-l2-envelope
\mathbf u_{L2}
  =\frac{\delta\mathbf m}{\sqrt{I_2}},
\qquad
[\,\mathbf u_{L2}\,]=\mathrm{m^{-1}},
\qquad
\int_{\Sigma_m}\mathbf u_{L2}^\dagger\mathbf u_{L2}\,\mathrm dA=1.
```

Fizyczne, bezwymiarowe zaburzenie magnetyzacji jest odtwarzane przez
amplitudę długościową:

(eq-0833-unit-l2-restoration)=
```{math}
:label: eq-0833-unit-l2-restoration
\delta\mathbf m_{\mathrm{phys}}
  =a_{L2}\mathbf u_{L2},
\qquad
[\,a_{L2}\,]=\mathrm m,
\qquad
\delta\mathbf M_{\mathrm{phys}}
  =M_s a_{L2}\mathbf u_{L2},
\qquad
[\,\delta\mathbf M_{\mathrm{phys}}\,]=\mathrm{A\,m^{-1}}.
```

### 2.2 Potencjał i pole dla unit L2

Dla envelope waveguide obowiązuje:

(eq-0833-unit-l2-demag-equation)=
```{math}
:label: eq-0833-unit-l2-demag-equation
\begin{aligned}
(\nabla_\perp^2-k^2)\phi_{L2}
  &=\nabla_\perp\cdot(M_s\mathbf u_{L2,\perp})
    -\mathrm{i}kM_su_{L2,z},\\
\mathbf h_{L2,\perp}&=-\nabla_\perp\phi_{L2},
&h_{L2,z}&=\mathrm{i}k\phi_{L2}.
\end{aligned}
```

Przed amplitudą [phi_L2] = A m^-1 i [h_L2] = A m^-2. Po amplitudzie:

(eq-0833-unit-l2-field-restoration)=
```{math}
:label: eq-0833-unit-l2-field-restoration
\phi_{\mathrm{phys}}=a_{L2}\phi_{L2},
\qquad
\mathbf h_{\mathrm{phys}}=a_{L2}\mathbf h_{L2},
\qquad
[\phi_{\mathrm{phys}}]=\mathrm A,
\qquad
[\mathbf h_{\mathrm{phys}}]=\mathrm{A\,m^{-1}}.
```

Jedna skala musi objąć całe sprzężone rozwiązanie. Nie wolno normalizować
$q$, $\phi$ ani mnożnika gauge niezależnie.

### 2.3 Unit max amplitude

Niech $T_j\in\mathbb R^{3\times2}$ będzie lokalną ortonormalną ramą
styczną, a $q_j\in\mathbb C^2$ surowym nodalnym współczynnikiem. Nodalny
Cartesian shape to $\delta\mathbf m_j=T_jq_j$. Norma unit max jest normą
zespolonego wektora Cartesian:

(eq-0833-unit-max-envelope)=
```{math}
:label: eq-0833-unit-max-envelope
\begin{aligned}
A_{\max}
  &=\max_{j\in\mathcal N_m}\|\delta\mathbf m_j\|_{\mathbb C^3,2}
   =\max_{j\in\mathcal N_m}
    \left(\sum_{\alpha\in\{x,y,z\}}|\delta m_{j,\alpha}|^2\right)^{1/2},\\
\mathbf u_{\max}&=\frac{\delta\mathbf m}{A_{\max}},
&&[\,\mathbf u_{\max}\,]=1,\\
\delta\mathbf m_{\mathrm{phys}}&=a_{\max}\mathbf u_{\max},
&&[\,a_{\max}\,]=1.
\end{aligned}
```

$A_{\max}$ nie jest maksimum pojedynczej składowej $q_{j,1}$ lub $q_{j,2}$.
Przy ortonormalnym $T_j$ jest to
$(|q_{j,1}|^2+|q_{j,2}|^2)^{1/2}$ dla każdego węzła, a następnie maksimum
po węzłach. Definicja pozostaje Cartesian przy różnych lokalnych ramach.

### 2.4 Energia na jednostkę długości

Energia na jednostkę długości jest fizyczna dopiero po amplitudzie:

(eq-0833-energy-amplitude-scaling)=
```{math}
:label: eq-0833-energy-amplitude-scaling
\begin{aligned}
\frac{E}{\ell}&=|a_{L2}|^2\mathcal E_{L2},
&&[\,\mathcal E_{L2}\,]=\mathrm{J\,m^{-3}},\\
\frac{E}{\ell}&=|a_{\max}|^2\mathcal E_{\max},
&&[\,\mathcal E_{\max}\,]=\mathrm{J\,m^{-1}}.
\end{aligned}
```

Nie należy publikować $\mathcal E_{L2}$ ani $\mathcal E_{\max}$ jako energii
fizycznej bez podania normy i amplitudy.

### 2.5 Jednorodny pełny residual descriptora

Niech $x=(q,\phi,g)$ zawiera pola magnetyczne, potencjał i mnożnik lub
wektor gauge. Dla jednostkowo zgodnej normy blokowej:

(eq-0833-homogeneous-full-residual)=
```{math}
:label: eq-0833-homogeneous-full-residual
\begin{aligned}
\mathscr R(x;\lambda)
  &=\begin{bmatrix}R_q(q,\phi;\lambda)\\R_\phi(q,\phi,g)\\R_g(q,\phi,g)\end{bmatrix},\\
\varepsilon_{\mathrm{full}}
  &=\frac{\|\mathscr R(x;\lambda)\|_{\mathcal D}}
  {\|\mathscr A(x;\lambda)\|_{\mathcal D}
    +\|\mathscr b(x;\lambda)\|_{\mathcal D}},\\
\mathscr R(\alpha x;\lambda)&=\alpha\mathscr R(x;\lambda),
\qquad
\mathscr A(\alpha x;\lambda)+\mathscr b(\alpha x;\lambda)
  =\alpha(\mathscr A(x;\lambda)+\mathscr b(x;\lambda)),
\quad\alpha\in\mathbb C\setminus\{0\}.
\end{aligned}
```

Wszystkie bloki $q$, $\phi$ i $g$ otrzymują ten sam zespolony mnożnik
$\alpha$. Gauge nie może pozostać w starej skali. Próg residualu jest
bezwymiarowy i niezależny od globalnej amplitudy.

### 2.6 Zgodność z ekstrudowanym 3D

Dla osiowo niezmiennego kształtu i odcinka długości $\ell$ relacja unit L2
jest:

(eq-0833-extruded-l2-scaling)=
```{math}
:label: eq-0833-extruded-l2-scaling
\mathbf u_{3D}(\mathbf r_\perp,z)
  =\frac{\mathbf u_{2D}(\mathbf r_\perp)}{\sqrt{\ell}},
\qquad
a_{3D}=a_{2D}\sqrt{\ell},
\qquad
a_{3D}\mathbf u_{3D}=a_{2D}\mathbf u_{2D}.
```

Wtedy $\int_{\Omega_\ell}|\mathbf u_{3D}|^2\,\mathrm dV=1$, a pola po
odtworzeniu amplitudy są takie same. Porównanie energii wykonuje się jako
$E_{3D}/\ell$ z $E_{2D}/\ell$. Surowe pola znormalizowane nie są jednak
identycznymi obiektami. Relacja dotyczy unit L2; unit max pozostaje normą
punktową i porównuje się po odtworzeniu amplitudy.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Token LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $\Sigma_m$ | magnetyczny przekrój waveguide | $\mathrm{m^2}$ |
| $\mathbf r_\perp$ | położenie w przekroju | $\mathrm m$ |
| $\hat{\mathbf z}$ | jednostkowa oś propagacji | $1$ |
| $\mathbf m_0$ | równowagowa magnetyzacja jednostkowa | $1$ |
| $z$ | współrzędna osiowa | $\mathrm m$ |
| $k$ | podpisana liczba falowa | $\mathrm{rad\,m^{-1}}$ |
| $N_i$ | funkcja kształtu P1 | $1$ |
| $N_j$ | funkcja kształtu P1 dla węzła j | $1$ |
| $T_i$ | lokalna rama styczna | $1$ |
| $T_j$ | lokalna rama styczna dla węzła j | $1$ |
| $q_i$ | zespolony współczynnik styczny | $1$ |
| $q_j$ | zespolony współczynnik styczny dla węzła j | $1$ |
| $\delta\mathbf m$ | surowy shape względnej magnetyzacji | $1$ |
| $A_{\max}$ | maksimum nodalnej zespolonej normy Cartesian | $1$ |
| $I_2$ | norma pola po przekroju | $\mathrm{m^2}$ |
| $\mathbf u_{L2}$ | unit L2 envelope | $\mathrm{m^{-1}}$ |
| $a_{L2}$ | amplituda unit L2 | $\mathrm m$ |
| $\mathbf u_{\max}$ | unit max envelope | $1$ |
| $a_{\max}$ | amplituda unit max | $1$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $\delta\mathbf M$ | zaburzenie magnetyzacji | $\mathrm{A\,m^{-1}}$ |
| $\phi_{L2}$ | potencjał przed amplitudą L2 | $\mathrm{A\,m^{-1}}$ |
| $\mathbf h_{L2}$ | pole przed amplitudą L2 | $\mathrm{A\,m^{-2}}$ |
| $\phi_{\mathrm{phys}}$ | fizyczny potencjał | $\mathrm A$ |
| $\mathbf h_{\mathrm{phys}}$ | fizyczne pole | $\mathrm{A\,m^{-1}}$ |
| $\ell$ | długość ekstrudowania | $\mathrm m$ |
| $E$ | energia odcinka | $\mathrm J$ |
| $E/\ell$ | energia na długość | $\mathrm{J\,m^{-1}}$ |
| $\mathcal E_{L2}$ | współczynnik energii unit L2 | $\mathrm{J\,m^{-3}}$ |
| $\mathcal E_{\max}$ | współczynnik energii unit max | $\mathrm{J\,m^{-1}}$ |
| $G_{ij}^{T}$ | blok geometrycznej consistent mass P1 | $\mathrm{m^2}$ |
| $\mathbf u_{2D}$ | przekrojowy unit-L2 envelope przed ekstrudowaniem | $\mathrm{m^{-1}}$ |
| $\mathbf u_{3D}$ | ekstrudowany unit-L2 envelope | $\mathrm{m^{-3/2}}$ |
| $a_{2D}$ | amplituda przekroju | $\mathrm m$ |
| $a_{3D}$ | amplituda ekstrudowanego shape | $\mathrm{m^{3/2}}$ |
| $s_{L2}$ | dyskretna skala geometrycznej normy L2 | $\mathrm m$ |
| $s_{\max}$ | dyskretna skala Cartesian max | $1$ |
| $q_{L2}$ | współczynniki po skali unit L2 | $\mathrm{m^{-1}}$ |
| $q_{\max}$ | współczynniki po skali unit max | $1$ |
| $\mathscr R$ | pełny residual descriptora | zależna od descriptora |
| $R$ | blok residualu descriptora | zależna od descriptora |
| $g$ | mnożnik lub wektor gauge | zależna od descriptora |
| $\varepsilon_{\mathrm{full}}$ | pełny względny residual | $1$ |

(assumptions-and-validity)=
## 4. Założenia i zakres ważności

- Geometria, topologia, $M_s$, $A_{\mathrm{ex}}$, anizotropia, DMI, równowaga
  i dane brzegowe muszą być niezmienne wzdłuż $\hat{\mathbf z}$. Brak
  certyfikatu oznacza odrzucenie reprezentacji 2.5D.
- $I_2$ całkuje wyłącznie magnetyczny przekrój i tę samą równowagę, która
  zasila operator.
- $T_i$ musi być ortonormalną ramą. Geometric mass używa
  $T_i^\mathsf T T_j$; nie jest to metryka dynamiczna.
- Geometric mass nie może być utożsamiona z gyroscopic $B$ ani z metryką
  ważoną przez $M_s$. $B$ należy do linearized dynamic pencil i nie definiuje
  $I_2$ ani unit max.
- Globalna faza shape jest dowolna. Amplituda przywraca skalę, lecz nie
  wybiera fazy ani nie zastępuje gauge.
- $\ell$ jest parametrem porównania 3D i nie skaluje macierzy sekcyjnych.
- Nota nie twierdzi o wykonaniu MFEM, SLEPc, GPU, TetraX ani
  compareextruded3D.

(python-api)=
## 5. Python API: planowane mapowanie

Obecny study.stages.add_eigenmodes przyjmuje tylko ogólne tokeny unit_l2 i
unit_max_amplitude; ich walidacja i serializacja pozostają bez zmian. Nie ma
parametru wybierającego waveguide 2.5D, $\Sigma_m$, ramy styczne, $\ell$ ani
jednostki amplitudy.

Obecna tabela kontraktu pozostaje jawna:

| Python parameter | Type | Default | SI unit | Validation domain and validation errors | Physical meaning | Backend support | ProblemIR destination and normalization |
|---|---|---|---|---|---|---|---|
| study.stages.add_eigenmodes.normalization | str | unit_l2 | $1$ | unit_l2 or unit_max_amplitude; future waveguide mapping is not introduced | Current generic mode-normalization request | FEM CPU/GPU authoring; waveguide 2.5D runtime unavailable | study.normalization; unchanged by this note |

Current API serialization fragment, included only to freeze the existing
surface, is not a 2.5D execution example:

```python
# %%
import fullmag as fm

# %%
study = fm.study("waveguide_25d_normalization_contract")
study.stages.add_eigenmodes(
    count=1,
    normalization="unit_l2",
    k_vector=(0.0, 0.0, 0.0),
    magnetostatic_bc="open",
)
```

The fragment is a current authoring shape, not evidence that a waveguide
provider exists. It must not be extended with an invented public parameter.

Przyszłe API może przyjąć typed waveguide_2p5d realization z osobnym
descriptorem normy, ale nazwa i publiczny zakres wymagają decyzji S01/S02.
Decyzja musi opisać realizację, oś i znak $k$, domenę i certyfikat
niezmienniczości, wybór normy, jednostkę amplitudy, geometryczny metric,
regułę $\ell$ oraz błąd danych niezgodnych.

Ta nota nie dodaje konstruktora ani przykładu udającego działającą trasę
2.5D. Przyszły przykład musi być stage-first fm.study(...) z jawnym
study.stages.add_eigenmodes(...) i kanonicznym ProblemIR.

(problem-ir)=
## 6. ProblemIR i requested/resolved

Nie zmieniamy obecnego ProblemIR. Przyszły typ powinien przenosić semantykę
normy razem z realizacją, zamiast dopasowywać ją po samym tokenie
normalization. Kandydacki kontrakt wymaga pól: realization kind
full_3d (open lub periodic) lub waveguide_2p5d, oś i rama, podpisany skalar $k$,
magnetic_area_geometric_p1, jednostka amplitudy, polityka ekstrudowania
oraz digest/status certyfikatu niezmienniczości.

requested zachowuje normę i realizację autora. resolved opisuje faktyczny
provider i urządzenie. Brak providera 2.5D, geometrycznego metric lub
certyfikatu daje unavailable. Nie wolno cicho przechodzić do pełnej
komórki Floquet, K0 ani bounded fixture.

(round-trip-and-failure-semantics)=
## 7. Round-trip i błędy

Przyszła walidacja musi odrzucić $I_2\le0$, zerowy $A_{\max}$, pusty
przekrój, nieortogonalne ramy, niezgodną maskę magnetic/air, nie-dodatnią
$\ell$, brak certyfikatu osi, próbę podania seam $C(\mathbf k)$ jako
waveguide scalar $k$ oraz brak pełnego residualu dla wyniku qualified.

Round-trip zachowuje requested intent, requested normalization, requested
realization, resolved execution i provenance. Validation errors odrzucają
malformed lub sprzeczny request przed plannerem. Unsupported combinations
pozostają unavailable i nie są zastępowane inną reprezentacją. Obecne
normalization=unit_l2 nie może zostać po cichu przepisane na
$\mathbf u_{L2}$ 2.5D.

(discrete-realization)=
## 8. Dyskretna realizacja FEM

Na elemencie trójkątnym:

(eq-0833-p1-cartesian-shape)=
```{math}
:label: eq-0833-p1-cartesian-shape
\delta\mathbf m_h(\mathbf r_\perp)
  =\sum_{i\in T}N_i(\mathbf r_\perp)T_iq_i,
\qquad q_i\in\mathbb C^2.
```

Ramy lokalne spełniają warunek nodalny
$T_i^\mathsf T\mathbf m_{0,i}=0$. Jest to realizacja ograniczenia w węzłach;
dla przestrzennie zmiennego $\mathbf m_0$ interpolacja P1 nie gwarantuje
ciągłej, punktowej relacji $\mathbf m_0(\mathbf r_\perp)\cdot
\delta\mathbf m_h(\mathbf r_\perp)=0$ w całym elemencie.

Geometryczny P1 consistent mass jest blokowa:

(eq-0833-p1-geometric-mass)=
```{math}
:label: eq-0833-p1-geometric-mass
\begin{aligned}
G_{ij}^{T}
  &=\int_TN_iN_jT_i^\mathsf TT_j\,\mathrm dA
   =\frac{|T|}{12}c_{ij}T_i^\mathsf TT_j,\\
c_{ij}&=
\begin{cases}2,&i=j,\\1,&i\ne j.\end{cases}
\end{aligned}
```

Złożenie daje $I_2=q^\dagger Gq$. Wspólna rotacja Cartesian $R$ zachowuje
$T_i^\mathsf TT_j$. Lokalna zmiana współrzędnych
$T_i\mapsto T_iU_i$, $q_i\mapsto U_i^\mathsf Tq_i$ z $U_i\in SO(2)$
zachowuje pole i normę.

Skale oblicza się przed eksportem wszystkich bloków:

(eq-0833-discrete-common-scale)=
```{math}
:label: eq-0833-discrete-common-scale
\begin{aligned}
s_{L2}&=(q^\dagger Gq)^{1/2},
&q_{L2}&=q/s_{L2},
&a_{L2}&\in\mathrm m,\\
s_{\max}&=\max_j\|T_jq_j\|_{\mathbb C^3,2},
&q_{\max}&=q/s_{\max},
&a_{\max}&\in1.
\end{aligned}
```

Geometric mass jest metryką obserwacji i normalizacji. Nie jest gyroscopic
$B$ ani $M_s$-weighted metric używaną w pencil.

(implementation-mapping)=
## 9. Mapa implementacji i aktualne luki

| Aktualne źródło | Faktyczna semantyka | Luka względem 2.5D |
|---|---|---|
| crates/fullmag-ir/src/study.rs / EigenNormalizationIR | Tylko UnitL2 i UnitMaxAmplitude. | Brak jednostki amplitudy, domeny i metryki realizacji. |
| crates/fullmag-runner/src/fem/eigen_solve.rs / normalize_complex_mode | Mass quadratic form albo maksimum po spłaszczonych skalarach. | Brak 2D $T_i^\mathsf TT_j$; max nie jest nodalnym Cartesian max. |
| crates/fullmag-runner/src/fem/eigen_native_result.rs / normalize_complex_block_mode | Dla bloku 2N bieżąca normalizacja nadal działa na spłaszczonych składowych q. | Dwie składowe węzła nie są łączone przed proponowaną normą Cartesian max. |
| crates/fullmag-runner/src/fem/eigen_mass_metric.rs / SharedDomainSparseMass | Objętościowa metryka Tet4 z V/10 i V/20. | To full-cell metric, nie powierzchniowy metric z ramami. |
| crates/fullmag-runner/src/fem/eigen_projection.rs / project_complex_2x2_mode_to_tangent_basis_with_periodic_map | Cartesian amplitude po projekcji artefaktu. | Postprocess po wcześniejszej skali, nie owner unit max. |
| crates/fullmag-runner/src/fem/eigen_native_result.rs / native_floquet_mode_certificate_from_json | Przenosi bieżącą skalę do certyfikatu potencjału. | Brak jawnego kontraktu wspólnej skali q/phi/g dla waveguide. |
| backends/fem/include/frequency_domain/floquet_waveguide_cross_section.hpp / FloquetWaveguideCrossSectionProblem | Bounded 2D oracle i metadata normalization_length_m. | Brak produkcyjnego MFEM ownera, osi, invariance i modalnej normy. |

Planowany owner po decyzji kontraktowej:

- backends/fem/include/frequency_domain/waveguide_modal_problem.hpp dla osi,
  certyfikatu, $\Sigma_m$, normy i jednostek;
- backends/fem/cpu/frequency_domain/operators/floquet_waveguide_operator.hpp
  i .cpp dla 2D MFEM, $K_\perp+k^2M_\perp$, źródeł i geometrycznego metric;
- crates/fullmag-runner/src/fem/waveguide_normalization.rs dla wspólnej skali
  $q/\phi/g$, pól po amplitudzie i energii na długość;
- późniejsze append-only połączenie przez FemEigenPlanIR,
  eigen_execution_resolution, native request/ABI i planner.

Istniejącą fizykę posiadają: 0828 / eq-0828-waveguide-envelope-demag,
waveguide-envelope-contract i eq-0828-waveguide-section-measure; 0831 /
waveguide-envelope-operator-contract, waveguide-weak-source-sign i
waveguide-section-measure; 0832 / FloquetWaveguideCrossSectionProblem,
W_perp i W_axial.

(validation)=
## 10. Bramy walidacji

Kontrola scripts/test_waveguide_25d_normalization_source.py ma bez native
compilation sprawdzać:

1. ciągłą kwadraturę stopnia 3 i blokową P1 mass $T_i^\mathsf TT_j$;
2. stałe Cartesian pole i $I_2=|\Sigma_m|\|\delta\mathbf m\|^2$;
3. niezmienniczość po lokalnej rotacji ramy;
4. normę Cartesian zespolonego wektora unit max;
5. $u_{3D}=u_{2D}/\sqrt{\ell}$, $a_{3D}=a_{2D}\sqrt{\ell}$, pola i $E/\ell$;
6. bezwymiarowy pełny residual przy wspólnym skalowaniu q, phi i gauge.
7. DE: przy osi propagacji $\hat{\mathbf z}$, $\mathbf m_0\parallel\hat{\mathbf x}$
   rama $(\hat{\mathbf y},\hat{\mathbf z})$ dopuszcza niezerową składową osiową.

Jest to dowód algebraiczny źródła, nie dowód MFEM, SLEPc, residualu
natywnego ani kwalifikacji fizycznej. Przed przyjęciem potrzebne są native
regression, managed FEM CPU, compareextruded3D, TetraX i osobna bramka GPU.

| Solver | Urządzenie | Status | Granica dowodu |
|---|---|---|---|
| FEM | CPU | planned / source-visible / unvalidated | Bounded oracle nie jest produkcyjnym MFEM waveguide. |
| FEM | GPU | planned contract only / unsupported | Brak operatora, residency, device evidence i parity. |
| FDM | CPU | not applicable | Inny owner demag-k i inna norma. |
| FDM | GPU | not applicable | Brak wspólnej realizacji z FEM waveguide. |

Brak bramy pozostawia wynik NOT VERIFIED; test interpretowany nie promuje
resolved production capability.

(limitations)=
## 11. Ograniczenia i odłożone decyzje

- Nie ma publicznego typu realizacji 2.5D ani mapowania do ProblemIR.
- normalization_length_m z 0832 jest metadanymi porównania i nie staje się
  automatycznie amplitudą ani skalą macierzy.
- Istniejące normalization, max_amplitude, mode_phi_*, residual_* i energy_*
  nie są przez tę notę reinterpretowane.
- Nie rozstrzygnięto, czy norma będzie częścią przyszłego
  FemWaveguide2p5DConfigIR, wspólnego EigenNormalizationIR, czy osobnego
  kontraktu wyniku.
- Nie ma dowodu zbieżności przekroju, outer boundary, k-to-zero, TetraX,
  compareextruded3D, managed storage ani urządzenia GPU.

(scientific-bibliography)=
## 12. Referencje

1. Fullmag, docs/physics/0828-fem-frequency-domain-floquet-demag.md,
   eq-0828-waveguide-envelope-demag i waveguide-envelope-contract.
2. Fullmag, docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md,
   eq-fem-waveguide-envelope-demag, waveguide-weak-source-sign i
   waveguide-section-measure.
3. Fullmag, docs/physics/0832-fem-waveguide-nodal-ms-quadrature.md,
   nodalne $M_s$, momenty P1 i jednostki bloków źródłowych.
4. Fullmag, docs/adr/0031-fem-nonzero-k-dispersion-representations.md,
   rozdzielenie pełnej komórki Blocha i waveguide 2.5D.
5. Proposed review pair: docs/adr/0035-eigen-spatial-representation-contract.md
   oraz docs/specs/fem-waveguide-spatial-representation-v1.md; definiują
   kandydackie warianty full_3d i waveguide_2p5d, ale nie dowodzą runtime.

Literatura TetraX pozostaje referencją porównawczą przywołaną w 0828/0831;
ta nota nie przenosi jej API, warunków brzegowych ani wyników do Fullmag.

(source-code-index)=
## 13. Indeks źródeł

| Source ID | Path + symbol / DOC-ANCHOR | Odpowiedzialność | Lane | Status |
|---|---|---|---|---|
| source-0833-raw-l2 | ten dokument / eq-0833-raw-shape-area-norm, eq-0833-unit-l2-envelope | Surowy shape, I2 i unit L2 | FEM 2.5D | planned |
| source-0833-max | ten dokument / eq-0833-unit-max-envelope | Cartesian complex max | FEM 2.5D | planned |
| source-0833-energy | ten dokument / eq-0833-energy-amplitude-scaling | Energia po amplitudzie | FEM CPU/GPU | unvalidated |
| source-0833-residual | ten dokument / eq-0833-homogeneous-full-residual | Skala q/phi/g | native descriptor | planned |
| source-0833-extrusion | ten dokument / eq-0833-extruded-l2-scaling | Relacja 2D/3D | cross-discretization | planned |
| source-existing-equations | docs/physics/0828-fem-frequency-domain-floquet-demag.md / eq-0828-waveguide-envelope-demag | Równania waveguide | FEM CPU/GPU | source-visible |
| source-existing-weak | docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md / waveguide-weak-source-sign | Słabe źródło i jednostki | FEM CPU | source-visible |
| source-existing-measure | docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md / waveguide-section-measure | Całka sekcji na długość | FEM CPU | source-visible |
| source-existing-ms | backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp / assemble_floquet_waveguide_cross_section_blocks | Nodalne Ms bounded assembler opisany w 0832 | FEM CPU bounded | unvalidated |
| source-current-enum | crates/fullmag-ir/src/study.rs / EigenNormalizationIR | Obecne tokeny normy | common IR | current |
| source-current-normalization | crates/fullmag-runner/src/fem/eigen_solve.rs / normalize_complex_mode, complex_mass_norm | Full-cell normalizacja | FEM CPU | current |
| source-current-block | crates/fullmag-runner/src/fem/eigen_native_result.rs / normalize_complex_block_mode | Norma bloku 2N; max nadal skaluje spłaszczone składowe q | FEM CPU | current |
| source-current-mass | crates/fullmag-runner/src/fem/eigen_mass_metric.rs / SharedDomainSparseMass::from_topology | Volumetric Tet4 metric | FEM CPU | current |
| source-current-projection | crates/fullmag-runner/src/fem/eigen_projection.rs / project_complex_2x2_mode_to_tangent_basis_with_periodic_map | Cartesian amplitude po projekcji | FEM CPU | postprocess |
| source-interpreted-0833 | scripts/test_waveguide_25d_normalization_source.py / Waveguide25DNormalizationTests | Niezależna regresja algebraiczna | source verification | planned |

### Stabilne deklaracje użyte w mapie źródeł

| Source ID | Path | Symbol | Status |
|---|---|---|---|
| source-0833-raw | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-raw-shape-area-norm | planned_contract |
| source-0833-l2 | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-unit-l2-envelope | planned_contract |
| source-0833-l2-restoration | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-unit-l2-restoration | planned_contract |
| source-0833-demag | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-unit-l2-demag-equation | planned_contract |
| source-0833-field | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-unit-l2-field-restoration | planned_contract |
| source-0833-max | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-unit-max-envelope | planned_contract |
| source-0833-energy | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-energy-amplitude-scaling | planned_contract |
| source-0833-residual | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-homogeneous-full-residual | planned_contract |
| source-0833-extrusion | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-extruded-l2-scaling | planned_contract |
| source-0833-p1-shape | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-p1-cartesian-shape | planned_contract |
| source-0833-p1-mass | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-p1-geometric-mass | planned_contract |
| source-0833-discrete | docs/physics/0833-fem-waveguide-25d-normalization.md | DOC-ANCHOR:eq-0833-discrete-common-scale | planned_contract |
| source-existing-equations | docs/physics/0828-fem-frequency-domain-floquet-demag.md | DOC-ANCHOR:waveguide-envelope-contract | planned_contract |
| source-existing-weak | docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md | DOC-ANCHOR:waveguide-weak-source-sign | planned_contract |
| source-existing-measure | docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md | DOC-ANCHOR:waveguide-section-measure | planned_contract |
| source-existing-ms | backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp | assemble_floquet_waveguide_cross_section_blocks | source_visible_unqualified |
| source-current-enum | crates/fullmag-ir/src/study.rs | EigenNormalizationIR | source_visible_unqualified |
| source-current-normalize | crates/fullmag-runner/src/fem/eigen_solve.rs | normalize_complex_mode | source_visible_unqualified |
| source-current-mass-norm | crates/fullmag-runner/src/fem/eigen_solve.rs | complex_mass_norm | source_visible_unqualified |
| source-current-block-normalize | crates/fullmag-runner/src/fem/eigen_native_result.rs | normalize_complex_block_mode | source_visible_unqualified |
| source-current-mass | crates/fullmag-runner/src/fem/eigen_mass_metric.rs | SharedDomainSparseMass | source_visible_unqualified |
| source-current-projection | crates/fullmag-runner/src/fem/eigen_projection.rs | project_complex_2x2_mode_to_tangent_basis_with_periodic_map | source_visible_unqualified |
| source-interpreted-0833 | scripts/test_waveguide_25d_normalization_source.py | class Waveguide25DNormalizationTests | source_verified |

## Surowy typed mesh przekroju a walidacja normy

Źródłowy `WaveguideCrossSectionMeshIR` w
`crates/fullmag-ir/src/waveguide_mesh.rs` opisuje wyłącznie authored dane:
nodes_uv_m [m], trójkąty P1, edges/half-edge incidence oraz region/object/
material i ordered boundary contours. [Specyfikacja wire v1](../specs/fem-waveguide-spatial-representation-v1.md#typowany-surowy-descriptor-przekroju--wire-v1)
ustala lokalną numerację 0,1,2 i zamknięte tagged warianty. Nieznany token,
pole lub jawne null nie otrzymują defaultu. Typ RAW jest serializowalny;
nie twierdzi, że dane przeszły kontrolę geometrii, mappingu lub invariance.

Całki norm i energii z tej noty wymagają wcześniejszego niezależnego
sprawdzenia dodatniej orientacji/quality, kompletnej incidence i konturów,
konformności, mapowania regionów i materiałów oraz powiązania z ramą i
zaakceptowaną równowagą. Sam round-trip JSON nie spełnia tych założeń.
Nie aktywowano normalizacji 2D, providera, V04/admission, Python/UI ani
nowego artefaktu wyniku. FEM CPU pozostaje planned/runtime NOT VERIFIED;
FEM GPU unsupported, FDM not-applicable. Prepared regresje serde nie były
kompilowane. To kolejny wymagany składnik S09, nie ukończone S09.

| Source ID | Path + symbol | Zakres dowodu |
|---|---|---|
| source-0833-mesh-wire | crates/fullmag-ir/src/waveguide_mesh.rs + WaveguideCrossSectionMeshIR | Surowy typed descriptor; nie validated mesh ani runtime proof |


## Lokalne kontrole elementów i incydencji — przyrost źródłowy S09

Przed przyszłym compilerem/providerem przekroju przygotowujemy osobne
walidatory `validate_waveguide_mesh_elements` oraz
`validate_waveguide_mesh_incidence`. Ich raporty dotyczą wyłącznie
sprawdzonych właściwości lokalnej geometrii lub kombinatorycznej topologii.
Nie są certyfikatem całego mesha, embeddingu, invariance ani admission.
Nie dodają nowej legalności Python/IR/planner i nie zmieniają norm/artefaktów
obecnego pełnego 3D.

### Skalowanie P1, orientacja i reprezentowalność

```{math}
:label: eq-0833-mesh-element-quality
\begin{aligned}
s_T&=\max\{\|x_1-x_0\|_2,\|x_2-x_1\|_2,\|x_0-x_2\|_2\}>0,\\
r_i&=(x_i-x_0)/s_T,\quad i=1,2,\\
d_T&=r_{1,u}r_{2,v}-r_{1,v}r_{2,u}>0,\qquad a_T=d_T/2,\\
A_T&=(s_T a_T)s_T,\\
q_T&=\frac{4\sqrt3\,a_T}
 {\|r_1\|_2^2+\|r_2-r_1\|_2^2+\|r_2\|_2^2}
 >64\epsilon_{\mathrm{f64}},\qquad \epsilon_{\mathrm{f64}}=2^{-52}.
\end{aligned}
```

```{math}
:label: eq-0833-mesh-p1-geometry
\begin{aligned}
g_0&=\frac{(r_{1,v}-r_{2,v},\;r_{2,u}-r_{1,u})}{d_Ts_T},\\
g_1&=\frac{(r_{2,v},-r_{2,u})}{d_Ts_T},\qquad
g_2=\frac{(-r_{1,v},r_{1,u})}{d_Ts_T},\\
M^\Sigma_{ij}&=\int_T N_iN_j\,dA=
 \begin{cases}A_T/6&i=j,\\A_T/12&i\ne j,\end{cases}\\
K^\Sigma_{ij}&=\int_T\nabla N_i\cdot\nabla N_j\,dA
 =a_T\,(s_Tg_i)\cdot(s_Tg_j).
\end{aligned}
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $x_i$ | lokalne współrzędne węzła elementu | $\mathrm m$ |
| $s_T$ | największa długość krawędzi, obliczona przez hypot | $\mathrm m$ |
| $r_i$ | współrzędne krawędzi po skalowaniu; u,v są jej składowymi | $1$ |
| $d_T$ | wyznacznik w skali elementu | $1$ |
| $a_T$ | pole w skali elementu | $1$ |
| $A_T$ | fizyczne pole dodatnio zorientowanego elementu | $\mathrm{m^2}$ |
| $q_T$ | bezwymiarowa jakość trójkąta | $1$ |
| $\epsilon_{\mathrm{f64}}$ | epsilon maszynowy binary64, oddzielny od solver tolerance | $1$ |
| $g_i$ | fizyczny gradient skalarnej funkcji P1 | $\mathrm{m^{-1}}$ |
| $M^\Sigma_{ij}$ | skalarna geometryczna consistent mass | $\mathrm{m^2}$ |
| $K^\Sigma_{ij}$ | skalarna geometryczna stiffness, bez materiału | $1$ |

Różnice współrzędnych i długości muszą być finite, krawędzie niezerowe.
Utrata niezerowej składowej przy skalowaniu, zły determinant, q nieprzekraczające
granicy roundoff oraz overflow/underflow wymaganych fizycznych area/mass/
gradientów są jawnym błędem. Pole liczymy w podanej kolejności bez osobnego
s_T²; stiffness używa scaled gradients, nie iloczynu ogromnych fizycznych
gradientów. Mass entries muszą pozostać dodatnie i reprezentowalne. Dokładne
zera składników gradientu i off-diagonal stiffness są legalne. q nie jest
certyfikatem dokładności FEM ani rekomendowanym progiem meshera. Nie kopiować
absolute area floor bounded oracle. Każde publiczne wywołanie sprawdza IEEE
gradual underflow bez zmiany FPU; frame i elements korzystają z jednego
crate-private guardu. Sprawdzone elementy nie dowodzą braku ich przecięć.

M^Sigma nie jest kompletną tangent metric tej noty: ta nadal wymaga T_i^T T_j,
m0, mapping magnetic subspace i materiałów. K^Sigma nie jest kompletnym
exchange/demag pencil. Helper nie tworzy operatora ani certyfikatu residualu.
Raport publikuje rzeczywiste minima q, area, positive mass entry oraz maxima
gradientu i scalar stiffness; liczby są mierzone z danych, nie synthetic pass.

### Incydencja, kontury i lokalny manifold

Osobny walidator sprawdza: wszystkie indeksy i niepowtarzane węzły trójkątów;
niepuste i unikalne region/boundary IDs; istniejący region każdej komórki;
brak orphan nodes/regions/edges, duplikatów komórek i krawędzi; kompletne
edge→triangle-side incidence, co najwyżej dwie różne komórki na krawędź
i przeciwne kierunki dwóch incidences. Node index jest sprawdzany jako u64
przed konwersją do usize. Object/material IDs muszą być niepuste; ich
istnienie w kanonicznych rejestrach sprawdza odrębny binding validator.

Boundary half-edges wynikają z incidence: jeden właściciel na zewnętrznym
brzegu całej domeny, dwóch po obu stronach interfejsu różnych regionów;
wnętrze jednego regionu nie jest konturem. Każdy wymagany half-edge jest
pokryty dokładnie raz we właściwym konturze regionu. Kontury są skierowane,
zamknięte, mają co najmniej trzy różne węzły i brak powtarzanej półkrawędzi.
Kontury tego samego regionu nie mogą dotykać się tylko w węźle. Vertex stars
całej scalar domeny są połączonym fanem; odrzucamy point-contact mesh.
Nie rozdzielamy składowych po samym regionie air. Raport wyznacza składowe
całego scalar mesh oraz liczbę zewnętrznych air edges w każdej; nie tworzy
Dirichlet BC ani synthetic anchoring certificate na podstawie samego kind.

Topologia nie ustala geometrycznego znaczenia loop_kind outer/hole:
signed contour area/nesting, intersections/overlap/T-junction,
registry bindings, frame/fingerprint, structural fields/interactions/BC,
equilibrium i provider są odrębnymi nadal wymaganymi bramkami. Żaden z tych
dwóch raportów nie ma statusu validated_structural_2d ani nie może być
zdeserializowany jako zwalidowany obiekt. Metryki mają prywatne pola,
Serialize oraz tylko accessors; powstają z checked funkcji.

Prepared regresje Rust muszą obejmować skalę nm/tiny/huge (także finite area
mimo overflow s_T²), odwrócenie/degenerację/NaN/nielegalne indeksy oraz
uszkodzone incidence/contours i poprawną zamkniętą wyspę air w magnetic.
Ich kompilacja pozostaje zakazana; source review/parser i niezależne oracle
inputs nie są wykonaniem Rust ani kwalifikacją solvera. FEM CPU provider
planned/runtime NOT VERIFIED, FEM GPU unsupported; FDM not-applicable.

| Source ID | Path + symbol | Zakres |
|---|---|---|
| source-0833-mesh-elements | crates/fullmag-ir/src/waveguide_mesh_elements.rs + validate_waveguide_mesh_elements | Lokalna geometria i representability; embedding/runtime NOT VERIFIED |
| source-0833-mesh-incidence | crates/fullmag-ir/src/waveguide_mesh_incidence.rs + validate_waveguide_mesh_incidence | Incidence/fan/closed contours; nie pełny mesh certificate |
| source-0833-fp-guard | crates/fullmag-ir/src/floating_point_guard.rs + require_ieee_gradual_underflow | Wspólny sprawdzany FP guard, bez zmiany środowiska |


## Globalna konformność geometryczna przekroju — przyrost źródłowy S09

Zapisany przed implementacją kontrakt `validate_waveguide_mesh_embedding`
ma teraz realizację źródłową o następującym zakresie:
po istniejących kontrolach elements/incidence sprawdza cały scalar mesh,
nie tylko region magnetic. Odrzuca przecięcia i nakładające się odcinki,
kontakt niezgodny z tożsamością wspólnego węzła (w tym T-junction) oraz
trójkąt całkowicie zawarty we wnętrzu innego trójkąta. Wspólne krawędzie
i węzły zgodne z incidence są dozwolone. Raport nadal nie jest całym
validated mesh, invariance/boundary certificate ani admission.

### Dokładny znak orientacji zapisanych współrzędnych binary64

Nie wprowadzamy tolerancji odległości ani absolute area floor. Dla finite
binary64 odczyt bitów daje dokładną liczbę całkowitą w jednostce najmniejszej
subnormalnej współrzędnej. Dla bitu znaku, kodu wykładnika i frakcji:

```{math}
:label: eq-0833-mesh-exact-binary64-coordinate
\begin{aligned}
h_{64}&=2^{-1074}\,\mathrm m,\qquad x=h_{64}J(x),\\
J(x)&=(-1)^{\sigma_{64}}
\begin{cases}F_{64}&E_{64}=0,\\ (2^{52}+F_{64})2^{E_{64}-1}&1\le E_{64}\le2046.\end{cases}
\end{aligned}
```

Całkowite dodawanie, odejmowanie i mnożenie używają BigInt; nie zamieniamy
ich z powrotem na f64. Orientację określa znak:

```{math}
:label: eq-0833-mesh-exact-orientation
O(a,b,c)=[J(b_u)-J(a_u)][J(c_v)-J(a_v)]
       -[J(b_v)-J(a_v)][J(c_u)-J(a_u)].
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $h_{64}$ | kwant dokładnego kodowania współrzędnej binary64 | $\mathrm m$ |
| $J(x)$ | dokładny całkowity kod współrzędnej w jednostce h64 | $1$ |
| $\sigma_{64}$ | bit znaku współrzędnej | $1$ |
| $E_{64}$ | zapisany kod wykładnika finite binary64 | $1$ |
| $F_{64}$ | zapisane 52 bity frakcji binary64 | $1$ |
| $a,b,c$ | punkty lokalnego przekroju użyte w predykacie orientacji | $\mathrm m$ |
| $O(a,b,c)$ | dokładny wyznacznik całkowity trzech punktów; u,v oznaczają składowe | $1$ |

Signed zero koduje ten sam punkt; NaN/Inf odrzuca wcześniejsza kontrola.
Predykat jest dokładny dla zapisanych wartości, nie dla geometrii przed
jej zaokrągleniem przez generator. Nie usuwa zatem wymagań mesher accuracy,
orientacji/quality i reprezentowalności fizycznych area/mass/gradients.
Nie potrzebuje materializacji h64 jako f64 ani iloczynu fizycznych długości.

Segmenty testujemy przez znaki czterech orientacji i dokładne inclusive
przedziały końców. Kontakt w jednym punkcie jest legalny wyłącznie przy
wspólnym indeksie końcowego węzła obu krawędzi. Kollinearny odcinek o
niezerowej wspólnej długości jest błędem także przy wspólnym końcu.
Po kontroli wszystkich krawędzi nadal sprawdzamy strict containment
wierzchołka w dodatnio zorientowanym obcym trójkącie; sam brak przecięć
krawędzi nie wyklucza całkowitego nakładania zagnieżdżonych komórek.

Broad phase ma używać sortowania po min-u i aktywnego indeksu przedziałów v,
z usuwaniem odcinków/komórek, których max-u leży przed aktualnym min-u.
Nie stosujemy bezwarunkowego porównania każdej pary elementów. Inclusive
AABB nie zaokrągla współrzędnych i nie pomija kontaktów granicznych.
Liczba kandydatów i exact orientation tests są metrykami rzeczywistego
wykonania. W najgorszym przypadku liczba kandydatów nadal może być kwadratowa;
nie deklarujemy ogólnego liniowego skalowania lub kwalifikacji HPC.

Źródłowa zależność `num-bigint` ma użyć istniejącej w Cargo.lock wersji
0.4.6, bez aktualizacji pozostałych pakietów. To pomocnicza walidacja IR
przed przyszłym native MFEM providerem, nie własny backend FEM.
Prepared regresje mają obejmować legalny shared edge/vertex, crossing,
collinear overlap, T-junction, containment i disjoint components; osobno
bitowe zera, subnormale i duże finite wartości predykatu.
Rust tests i kompilacja pozostają nieuruchomione zgodnie z zakazem;
parser/input oracle nie zastępują managed wykonania tego kodu.

Outer/hole area/nesting, frame/world/fingerprint, object/material registry,
structural fields/interactions/BC i equilibrium/invariance pozostają osobnymi
bramkami S09. Python/ProblemIR/planner/ABI nie uzyskują nowej legalności.
FEM CPU planned/runtime NOT VERIFIED, FEM GPU unsupported, FDM not-applicable.

Referencje: [Rust binary64/to_bits](https://doc.rust-lang.org/std/primitive.f64.html#method.to_bits),
[num-bigint release history](https://github.com/rust-num/num-bigint/blob/main/RELEASES.md).

| Source ID | Path + symbol | Zakres |
|---|---|---|
| source-0833-mesh-exact-coordinate | crates/fullmag-ir/src/waveguide_mesh_embedding.rs + exact_binary64_integer | Dokładne kodowanie zapisanej finite współrzędnej; runtime NOT VERIFIED |
| source-0833-mesh-exact-orientation | crates/fullmag-ir/src/waveguide_mesh_embedding.rs + orient2d_exact | Znak całkowitego wyznacznika; runtime NOT VERIFIED |
| source-0833-mesh-embedding | crates/fullmag-ir/src/waveguide_mesh_embedding.rs + validate_waveguide_mesh_embedding | Globalna konformność; nie contour nesting/certificate/runtime proof |


## Geometryczna orientacja i nesting konturów — kontrakt przyrostu S09

Przed implementacją zapisaliśmy zakres validate_waveguide_mesh_contours;
źródło jest teraz zaimplementowane, wykonanie Rust/runtime pozostaje NOT VERIFIED.
Prerequisite to validate_waveguide_mesh_embedding, więc lokalne elementy,
incidence i cały scalar embedding muszą wcześniej przejść. Kontury są
skierowane przez trójkąty CCW, proste i zamknięte; region leży po lewej.
Incidence już wymaga kompletnego pokrycia regionalnych half-edges,
niepowtarzanego węzła w konturze i braku wspólnych węzłów dwóch konturów
tego samego regionu. Nie dodajemy redundantnego region-fan checku.

Samo loop_kind dotąd było tokenem wire. Nowa kontrola wiąże outer/hole
z geometrią, bez aktywowania providera lub pełnego certyfikatu mesha.
Dla ordered start nodes x_j konturu C, kodowania J i cyklicznego x_n=x_0:

```{math}
:label: eq-0833-contour-exact-area
S_C=\sum_{j=0}^{n_C-1}
\left[J(x_{j,u})J(x_{j+1,v})-J(x_{j,v})J(x_{j+1,u})\right],
\qquad A_C=\tfrac12 h_{64}^{2} S_C.
```

S_C jest BigInt; sprawdzamy jego znak, nie materializujemy h64 squared ani
fizycznego A_C w binary64. Dodatni znak oznacza CCW/outer, ujemny CW/hole;
zero jest błędem. To nie zmienia wcześniejszych kontroli representability
area/mass/gradients trójkątów. Sign check nie potrzebuje area floor.

Nesting liczymy osobno dla każdego region_id. Kontury różnych regionów
mogą być dwiema przeciwnie skierowanymi stronami tego samego interfejsu.
Nie wolno więc policzyć konturu magnetic jako dodatkowego rodzica air.
Dla punktu p_i będącego pierwszym start node konturu C_i:

```{math}
:label: eq-0833-contour-nesting-depth
d_i=\sum_{\substack{j\ne i\\ r_j=r_i}}
\mathbf{1}\!\left[p_i\in\operatorname{Int}(C_j)\right],
\qquad
\operatorname{role}(C_i)=
\begin{cases}\mathrm{outer}&d_i\bmod2=0,\\ \mathrm{hole}&d_i\bmod2=1.\end{cases}
```

Brak przecięć z embeddingu i brak styku konturów tego samego regionu
z incidence pozwalają użyć jednego rzeczywistego wierzchołka jako
representative: cały jego kontur ma tę samą relację do wnętrza innego.
Nie przesuwamy punktu o epsilon ani nie przyjmujemy bbox jako containment.
Wyspa tego samego regionu wewnątrz jego hole ma depth 2 i jest outer;
rozłączne outer contours pozostają legalne. Nie narzucamy jednej outer
na region ani limitu liczby poziomów.

Point location używa exact orient2d i poziomego promienia w kierunku +u.
Najpierw exact collinearity i inclusive bounds rozróżniają on-boundary.
Następnie przejścia o końcach po przeciwnych stronach poziomu p_v
stosują half-open warunek (a_v>p_v)!=(b_v>p_v). Parzystość zmieniamy,
gdy upward edge ma positive orient albo downward edge negative orient.
To odd-even rule bez dzielenia, wyznaczania przecięcia jako f64 lub
tolerancji. Horizontal edges i promień przez vertex wymagają tego samego
half-open warunku. On-boundary dla dwóch konturów tego samego regionu
jest błędem, nie wynikiem inside/outside; nie dotyczy interfejsów różnych
regionów pominiętych przed point location.

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $S_C$ | exact doubled signed area konturu w jednostce h64 squared | $1$ |
| $A_C$ | fizyczna signed area prostego konturu; nie materializowana przez helper | $\mathrm{m^2}$ |
| $C_i$ | ordered kontur o indeksie i w boundary_components | $1$ |
| $n_C$ | liczba half-edges prostego zamkniętego konturu | $1$ |
| $x_j$ | lokalny start node półkrawędzi konturu | $\mathrm m$ |
| $p_i$ | reprezentatywny pierwszy start node konturu C_i | $\mathrm m$ |
| $r_i$ | jawny identyfikator regionu konturu C_i | $1$ |
| $d_i$ | liczba zawierających konturów tego samego regionu | $1$ |

Broadphase dla punktów representative i regionalnych contour AABB
używa sweepu po u: wstawiamy min-u <= p-u, wygaszamy max-u < p-u,
a aktywny indeks v pyta o [p-v,p-v]. Pary i-identity pomijamy, każdy inny
kandydat przechodzi exact point location. Reuse istniejącego crate-private
ExactPoint/orient2d/AABB/ActiveIntervalIndex ma zachować arytmetykę,
algorytm i publiczne wyniki poprzedniego embedding validatora.
Nie tworzymy pełnej macierzy relacji ani unconditional all-pairs.
Koszt może nadal wzrosnąć dla zagnieżdżonych/overlapping bbox; brak
deklaracji liniowego HPC performance. Exact area terms, point-location
orientation tests, candidate counts i depth mają checked counters.

Raport contours ma prywatne pola, Serialize-only/accessors: boundary
component count, outer/hole counts, max regional depth, rzeczywiste
containment candidates, area-edge terms i point-location orientations.
Typed prerequisite errors pozostają zachowane. Ten raport nie tworzy
validated_structural_2d, immutable registry/frame/fingerprint,
invariance/equilibrium, boundary anchor, operatora ani admission.
FEM CPU planned/runtime NOT VERIFIED, FEM GPU unsupported, FDM not-applicable.
Kompilacja/testy Rust pozostają zakazane; parser i independent Fraction
oracle wejść nie są wykonaniem tego kodu.

Przygotowano 10 regresji Rust bez kompilacji lub uruchomienia. Niezależny
Fraction input oracle potwierdza 88 przypadków na czterech skalach,
wspólny fixture oraz nested fixture 12 węzłów/18 trójkątów/5 konturów
(depth 2, 4 containment candidates, 20 area terms, 16 orientations).
Korekta concave fixture ma osobne cztery rational input checks;
te dowody dotyczą danych, nie wykonania validatora Rust.

Źródło definicji signed area, odd-even point location i boundary case:
[CGAL polygon functions](https://doc.cgal.org/latest/Polygon/group__PkgPolygon2Functions.html).
Używamy tych standardowych definicji geometrycznych; nie dodajemy zależności CGAL.

| Source ID | Path + symbol | Zakres |
|---|---|---|
| source-0833-contour-area | crates/fullmag-ir/src/waveguide_mesh_contours.rs + signed_contour_area_exact | Sign prostego regionalnego konturu; source implemented/runtime NOT VERIFIED |
| source-0833-contour-location | crates/fullmag-ir/src/waveguide_mesh_contours.rs + point_in_contour_exact | Exact odd-even inside/outside/boundary; source implemented/runtime NOT VERIFIED |
| source-0833-contours | crates/fullmag-ir/src/waveguide_mesh_contours.rs + validate_waveguide_mesh_contours | Regionalne orientation/nesting; nie pełny mesh certificate/runtime |


(waveguide-world-representability)=
## Reprezentowalność współrzędnych świata — prywatny prerequisite S09

Przekrój UV pozostaje źródłem geometrii operatora 2D. Pomocnicze współrzędne
świata wiążą dokładny mesh z canonical frame i nie są importem mesha3D,
certyfikatem invariance ani admission do providera.

```{math}
:label: eq-waveguide-world-coordinates
\mathbf x_i=\mathbf o+u_i\mathbf e_u+v_i\mathbf e_v.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf x_i$ | Zaokrąglona pozycja węzła w świecie | $\mathrm m$ |
| $\mathbf o$ | Początek canonical frame | $\mathrm m$ |
| $u_i,v_i$ | Lokalne współrzędne węzła UV | $\mathrm m$ |
| $\mathbf e_u,\mathbf e_v$ | Dodatnio znormalizowane osie przekroju | $1$ |
| $\mathbf a$ | Canonical jednostkowa oś falowodu | $1$ |

Kolejność f64 jest jawna: oddzielne produkty u*Eu i v*Ev, następnie
(origin+u*Eu)+v*Ev. Nie stosować milczącego FMA, Gram–Schmidta, zmiany znaków
ani clampu. Nonfinite produkt/intermediate/result jest błędem. Guard IEEE
gradual underflow jest współdzielony i sprawdzany ponownie przy mapowaniu.
Wszystkie world nodes muszą być różne, z +0/-0 traktowanym jako ta sama
współrzędna. Duży origin może skasować małe różnice UV i musi zostać odrzucony.

Orientacja ma być sprawdzana na rzeczywistych zaokrąglonych world nodes,
a nie wyprowadzona wyłącznie z dodatniego determinant UV lub ramy:

```{math}
:label: eq-waveguide-rounded-world-orientation
\left[(\mathbf x_1-\mathbf x_0)\times(\mathbf x_2-\mathbf x_0)\right]
\cdot\mathbf a>0.
```

Znak wyznacza exact dyadic predicate z BigInt i wspólnego kodowania finite f64,
bez geometrycznego absolute epsilon. Pozostałe arytmetyczne kontrole P1
stosują skalowane krawędzie, normę iloczynu wektorowego oraz istniejącą
bezwymiarową granicę jakości64*EPS. Fizyczne pole trójkąta i mass entries
$\mathrm{m^2}$, gradienty $\mathrm{m^{-1}}$ oraz stiffness $1$ muszą pozostać reprezentowalne.
Nie naprawiać nieudanej orientacji przez permutację connectivity.

Wynik wiąże pożyczony Dirichlet/registry mesh i zwalidowaną ramę, zachowuje
world nodes oraz zmierzone minima jakości/pola i błędy projekcji/plane deviation.
Te kontrole nie dowodzą zachowania całego embeddingu ani accuracy transformacji.
Geometric equivalence zaokrąglonego world mesha pozostaje osobną bramką przed
jego użyciem do interpretacji fizycznych pól. Structural invariance,
equilibrium, fingerprint i owner MFEM również pozostają wymagane.

FEM CPU/GPU: wspólna prywatna walidacja danych, bez wykonania operatora lub GPU.
FDM CPU/GPU: ten descriptor nie jest ich siatką. Publiczny Python/ProblemIR,
capability, OpenAPI i UI nie otrzymują nowej dostępnej realizacji z tego helpera.
Regresje obejmują identity/rotated frame, huge origin collapse, overflow,
małą poprawną geometrię bez absolute floor oraz niezmienność wejść.
Rust unit tests tylko w CI; parser/source review nie dowodzą runtime.

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| crates/fullmag-ir/src/waveguide_mesh_world.rs | validate_waveguide_world_mapping | Prywatne powiązanie world representability z dokładnymi borrowed wejściami |
| crates/fullmag-ir/src/waveguide_mesh_embedding.rs | exact_binary64_integer | Wspólne exact dyadic kodowanie skończonego f64, także signed zero |


### Skalowane wielkości P1 zaokrąglonego trójkąta świata

Każdą krawędź wyznacza się oddzielnie z zapisanych world coordinates, a następnie
dzieli przez największą długość krawędzi. Odejmowanie/scaling ma własne guards;
nie zastępuje się jednej krawędzi różnicą innych z inną kolejnością roundingu.

```{math}
:label: eq-waveguide-world-p1-geometry
\mathbf r_{ij}=(\mathbf x_j-\mathbf x_i)/s_T,\quad
\mathbf n_T=\mathbf r_{01}\times\mathbf r_{02},\quad
A_T=\frac{s_T^2}{2}\|\mathbf n_T\|,\quad
Q_T=\frac{2\sqrt{3}\|\mathbf n_T\|}
{\|\mathbf r_{01}\|^2+\|\mathbf r_{02}\|^2+\|\mathbf r_{12}\|^2}.
```

```{math}
:label: eq-waveguide-world-p1-gradients
\nabla N_1=\frac{\mathbf r_{02}\times\mathbf n_T}{s_T\|\mathbf n_T\|^2},\quad
\nabla N_2=\frac{\mathbf n_T\times\mathbf r_{01}}{s_T\|\mathbf n_T\|^2},\quad
\nabla N_0=-\nabla N_1-\nabla N_2.
```

```{math}
:label: eq-waveguide-world-p1-integrals
M_{ij}^{T}=\frac{A_T}{12}(1+\delta_{ij}),\qquad
K_{ij}^{T}=\frac{\|\mathbf n_T\|}{2}
(s_T\nabla N_i)\cdot(s_T\nabla N_j).
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $s_T$ | Największa długość krawędzi trójkąta świata | $\mathrm m$ |
| $\mathbf r_{ij}$ | Oddzielnie obliczona skalowana krawędź świata | $1$ |
| $\mathbf n_T$ | Iloczyn wektorowy skalowanych krawędzi | $1$ |
| $A_T$ | Fizyczne pole trójkąta świata | $\mathrm{m^2}$ |
| $Q_T$ | Bezwymiarowa jakość trójkąta świata | $1$ |
| $\nabla N_j$ | Fizyczny gradient liniowej funkcji P1 | $\mathrm{m^{-1}}$ |
| $M_{ij}^{T}$ | Geometryczny wpis macierzy masy P1 bez Ms | $\mathrm{m^2}$ |
| $K_{ij}^{T}$ | Geometryczny wpis scalar stiffness P1 | $1$ |
| $\delta_{ij}$ | Delta Kroneckera lokalnych indeksów P1 | $1$ |

Kod materializuje area jako (scale*normalized_area)*scale i stiffness ze
scaled gradients, aby nie tworzyć pośredniego scale² lub physical gradient².
Nonfinite i zanik niezerowych gradients po przeskalowaniu są błędami.
Mass/stiffness służą tu wyłącznie sprawdzeniu reprezentowalności; helper nie
składa operatora demag, exchange ani pencil. Publiczne normy modów nadal
używają właściwego descriptoru i miary dA, a nie tego pomocniczego raportu.

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| crates/fullmag-ir/src/waveguide_mesh_world.rs | validate_world_triangles | Skala/area/quality/gradient/mass/stiffness na rzeczywistych world nodes |
