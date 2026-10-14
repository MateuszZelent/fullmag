# Niezależny oracle Hessianu energii dla nodalnej retrakcji P1

## Domena fizyczna: mikromagnetyka
### Rodzina solvera: FEM
#### Backend: CPU
##### Podsystem numeryczny: niezależny algebraiczny oracle Tet4

(problem-statement)=
## Problem

Ta nota opisuje testowy oracle drugiej wariacji jawnie zadanej dyskretnej energii po nodalnej retrakcji wektorów magnetyzacji na sferę jednostkową. Fixture składa się z jednego prostego tetraedru Tet4, dokładnych macierzy masy i sztywności P1 oraz trzechwymiarowego, mean-zero układu Poissona rozwiązywanego od nowa dla każdego stanu energii. Jest to mały algebraiczny oracle, a nie produkcyjny solver ani model wspólnej domeny z airboxem.

**Granica dowodowa:** kod, rejestracja CMake i wybór testu w profilu `native-modal` są widoczne w źródłach. Nie uruchomiono jeszcze hostowanego GHA dla tego fragmentu. Nawet zielony wynik sprawdzi wyłącznie równoważność pochodnej energii w tym algebrze Tet4; nie kwalifikuje produkcyjnego operatora FEM, pola demagnetyzującego, stanu równowagi, częstotliwości ani GPU.

Dla jednostkowych wektorów nodalnych $\mathbf m_i$ oraz kierunków $\boldsymbol\xi_i$ stycznych do sfery w każdym węźle test porównuje drugą pochodną energii wzdłuż retrakcji $\mathbf m_i(h)=\operatorname{normalize}(\mathbf m_i+h\boldsymbol\xi_i)$ z niezależnym wzorem z pochodnych ambientowych. Teksturowany stan może być nierównowagowy. To celowe: oracle sprawdza rachunek wariacyjny, a nie przyjęcie fizycznego stanu równowagi.

(governing-equations)=
## Równania i dyskretny kontrakt

### Momenty P1 prostego Tet4

Węzłami elementu są $\mathbf x_0=(0,0,0)$, $\mathbf x_1=(L,0,0)$, $\mathbf x_2=(0,L,0)$ i $\mathbf x_3=(0,0,L)$. Długość każdej z trzech osiowych krawędzi wynosi $L$; tetraedr nie jest regularny, a jego objętość to $V=L^3/6$. Dla liniowych funkcji kształtu $N_i$ oracle używa dokładnych momentów:

```{math}
:label: eq-nodal-hessian-tet4-moments
K_{ij}=\int_T \nabla N_i\cdot\nabla N_j\,dV,\qquad
M_{ij}=\int_T N_iN_j\,dV=
\frac{V}{20}\begin{cases}2,&i=j,\\1,&i\ne j.\end{cases}
```

Ponadto $\int_T N_i\,dV=V/4$. Jednostką $K_{ij}$ jest metr, a $M_{ij}$ ma jednostkę metra sześciennego.

### Energia oracle

Dla stosu dwunastu bezwymiarowych składowych nodalnej magnetyzacji $\mathbf m$, oracle definiuje energię

```{math}
:label: eq-nodal-hessian-energy
E(\mathbf m)=
A\sum_{i,j}K_{ij}\,\mathbf m_i\cdot\mathbf m_j
-\mu_0M_s\sum_{i,j}M_{ij}\,\mathbf m_i\cdot\mathbf H_j
-K_u\sum_{i,j}M_{ij}(\mathbf m_i\cdot\mathbf u)(\mathbf m_j\cdot\mathbf u)
+E_d(\mathbf m).
```

Składniki to kolejno energia wymiany, energia Zeemana dla ustalonego nodalnego pola, pierwszorzędowa anizotropia jednoosiowa oraz algebraiczny surogat demagnetyzacji. Podczas różniczkowania $\mathbf H_j$ i jednostkowa oś $\mathbf u$ są stałymi wejściami. Ambientowy Hessian stałego pola Zeemana jest zerowy.

### Mean-zero algebraiczny surogat Poissona

Współczynnik źródła słabego układu ma postać $\mathbf s=B\mathbf m$. Test jawnie buduje ortonormalną bazę $Q$ podprzestrzeni potencjałów o średniej zero, a następnie rozwiązuje zredukowany układ:

```{math}
:label: eq-nodal-hessian-poisson-map
B_{j,(i,a)}=-\frac{M_sV}{4}\,\partial_aN_j,\qquad
P_Q=Q^{\mathsf T}KQ,\qquad
\boldsymbol\phi_Q=P_Q^{-1}Q^{\mathsf T}\mathbf s.
```

Demagnetyzująca część energii i jej pochodne ambientowe wynikają z tej samej jawnej funkcji kwadratowej:

```{math}
:label: eq-nodal-hessian-demag-energy
E_d=\frac{\mu_0}{2}\mathbf s^{\mathsf T}Q P_Q^{-1}Q^{\mathsf T}\mathbf s,\qquad
\mathbf g_d=\mu_0B^{\mathsf T}Q P_Q^{-1}Q^{\mathsf T}B\mathbf m,\qquad
\mathsf H_d=\mu_0B^{\mathsf T}Q P_Q^{-1}Q^{\mathsf T}B.
```

Dla dowolnego wektora $\mathbf z$ prawa strona spełnia

```{math}
:label: eq-nodal-hessian-demag-positivity
\mathbf z^{\mathsf T}\mathsf H_d\mathbf z=
\mu_0(Q^{\mathsf T}B\mathbf z)^{\mathsf T}P_Q^{-1}(Q^{\mathsf T}B\mathbf z)\ge 0,
```

gdyż sztywność Laplace'a jest dodatnio określona po ograniczeniu do podprzestrzeni mean-zero. Jest to algebraiczne uzasadnienie dodatniej półokreśloności Hessianu surogatu. Test dodatkowo sprawdza nieujemność dla każdego kierunku osi współrzędnych i dla badanego kierunku stycznego; te próbki same w sobie nie stanowią pełnego testu widma macierzy.

Surogatu nie należy utożsamiać z produkcyjnym polem demagnetyzującym: nie zawiera siatki zewnętrznej, airboxu ani produkcyjnego warunku brzegowego. Jego rolą jest dać mały, jawny i niezależnie różniczkowalny składnik nielokalny.

### Pochodne ambientowe i krzywizna retrakcji


Niech $\mathbf g=\nabla E$ i $\mathsf H=\nabla^2E$. Wymiana wnosi

```{math}
:label: eq-nodal-hessian-ambient-derivatives
\mathbf g_{\mathrm{ex},i}=2A\sum_jK_{ij}\mathbf m_j,\qquad
H_{\mathrm{ex},(i,a),(j,b)}=2AK_{ij}\delta_{ab}.
```

Stałe pole Zeemana wnosi

```{math}
:label: eq-nodal-hessian-zeeman-derivatives
\mathbf g_{Z,i}=-\mu_0M_s\sum_jM_{ij}\mathbf H_j,\qquad \mathsf H_Z=0.
```

Anizotropia wnosi

```{math}
:label: eq-nodal-hessian-anisotropy-derivatives
\mathbf g_{K,i}=-2K_u\sum_jM_{ij}(\mathbf m_j\cdot\mathbf u)\mathbf u,\qquad
H_{K,(i,a),(j,b)}=-2K_uM_{ij}u_au_b.
```

Demagnetyzację określają równania powyżej.

Dla $|\mathbf m_i|=1$ i $\mathbf m_i\cdot\boldsymbol\xi_i=0$ kod stosuje nodalną retrakcję normalizującą:

```{math}
:label: eq-nodal-hessian-retraction
\mathbf m_i(h)=\frac{\mathbf m_i+h\boldsymbol\xi_i}
{|\mathbf m_i+h\boldsymbol\xi_i|},\qquad
\mathbf m_i''(0)=-|\boldsymbol\xi_i|^2\mathbf m_i.
```

Jej druga wariacja jest zatem równa

```{math}
:label: eq-nodal-hessian-retracted-second-variation
\left.\frac{d^2}{dh^2}E(\mathbf m(h))\right|_{h=0}
=\boldsymbol\xi^{\mathsf T}\mathsf H\boldsymbol\xi
-\sum_i(\mathbf m_i\cdot\mathbf g_i)|\boldsymbol\xi_i|^2.
```

Równoważny składnik krzywizny to macierz diagonalna $C_{(i,a),(j,b)}=-\delta_{ij}\delta_{ab}(\mathbf m_i\cdot\mathbf g_i)$. Ten składnik jest potrzebny również wtedy, gdy każda perturbacja jest dokładnie styczna w swoim węźle.

### Niezależny sanity check anizotropii

Osobny oracle ustawia stałe $\mathbf m_i=\hat{\mathbf z}$ i $\boldsymbol\xi_i=\hat{\mathbf x}$, wyłącza wymianę, pole zewnętrzne i źródło demagnetyzacji, a oś wybiera jako $\mathbf u=(1,2,3)/\sqrt{14}$. Dla tej jednorodnej konfiguracji dokładna energia i pochodna kierunkowa wynoszą

```{math}
:label: eq-nodal-hessian-uniform-anisotropy-sanity
E_K=-\frac{9}{14}K_uV,\qquad
\left.\frac{d}{d\alpha}E_K(\mathbf m+\alpha\boldsymbol\xi)\right|_{\alpha=0}
=-\frac{3}{7}K_uV.
```

Ten check porównuje osobno wynik energii i gradientu z zamkniętym wzorem. Wykrywa utratę wyrazów mieszanych w $M_{ij}(\mathbf m_i\cdot\mathbf u)(\mathbf m_j\cdot\mathbf u)$, niezależnie od porównania różnic skończonych z Hessianem.

### Różnice skończone i raportowane estymaty

Test oblicza symetryczną różnicę

```{math}
:label: eq-nodal-hessian-richardson
D(h)=\frac{E(\mathbf m(h))-2E(\mathbf m(0))+E(\mathbf m(-h))}{h^2},\qquad
R(h)=\frac{4D(h/2)-D(h)}{3}.
```

W kodzie zmienna $\mathbf m$ oznacza stos dwunastu składowych $\mathbf m_i$. Dla każdego wywołania energii potencjał Poissona jest rozwiązywany od nowa.

```{math}
:label: eq-nodal-hessian-error-estimates
\mathbf r_Q=Q^{\mathsf T}\mathbf s-P_Q\boldsymbol\phi_Q,\qquad
P_Q\delta\boldsymbol\phi_Q=\mathbf r_Q,\qquad
\varepsilon_{\mathrm{solve}}=\frac{\mu_0}{2}\|Q^{\mathsf T}\mathbf s\|_2\|\delta\boldsymbol\phi_Q\|_2,\qquad
\varepsilon_{\mathrm{scale}}=128\epsilon_{\mathrm{mach}}\sum_{\ell\in\{\mathrm{ex},Z,K,d\}}|E_\ell|.
```

Dla błędu równania zredukowanego kod oblicza resztę $\mathbf r_Q=Q^{\mathsf T}\mathbf s-P_Q\boldsymbol\phi_Q$, rozwiązuje $P_Q\delta\boldsymbol\phi_Q=\mathbf r_Q$ i raportuje skalę estymaty energii $\varepsilon_{\mathrm{solve}}=\frac{\mu_0}{2}\|Q^{\mathsf T}\mathbf s\|_2\|\delta\boldsymbol\phi_Q\|_2$. Współczynnik $128\epsilon_{\mathrm{mach}}$ pomnożony przez sumę modułów czterech składników energii jest skalą estymaty zaokrągleń. To użyteczny diagnostyczny model skali, a nie rygorystyczna granica błędu: nie certyfikuje wszystkich zaokrągleń w składaniu macierzy, eliminacji Gaussa ani sumach po elementach.

Raportowana estymata niepewności różnicy obejmuje te estymaty skali dla trzech użytych energii. Estymata porównania łączy zmianę dwóch najdrobniejszych ekstrapolacji Richardsona $4|R_3-R_2|/15$ z przeniesioną estymatą dla $R_3$. Test osobno wymaga kontrakcji kolejnych zmian Richarsona. Te reguły są dowodem testu algebraicznego; nie są tolerancją produkcyjnego solvera.

Fixture używa bezwymiarowej rodziny kroków $h\in\{0.04,0.02,0.01,0.005,0.0025\}$. Przypadek jednorodny ustawia $\mathbf m_i=(0,0,1)$ i cztery różne kierunki w płaszczyźnie. Teksturowany przypadek używa $\mathbf m_i=\{(0,0,1),(1,0,0),(0,1,0),(1,0,1)/\sqrt2\}$ oraz $\boldsymbol\xi_i=\{(1,0,0),(0,1,0),(0,0,1),(0,1,0)\}$. Oba korzystają z tego samego, ustalonego nodalnego pola $\mathbf H_j$ oraz osi $\mathbf u$ z testu.

```{math}
:label: eq-nodal-hessian-interior-p1-normal
\widehat{\mathbf m}_c=\operatorname{normalize}\left(\frac14\sum_i\mathbf m_i\right),\qquad
\boldsymbol\xi_c=\frac14\sum_i\boldsymbol\xi_i,\qquad
\nu_c=\widehat{\mathbf m}_c\cdot\boldsymbol\xi_c.
```
Dodatkowy pomiar w barycentrum Tet4 oblicza $\widehat{\mathbf m}_c=\operatorname{normalize}(\frac14\sum_i\mathbf m_i)$, $\boldsymbol\xi_c=\frac14\sum_i\boldsymbol\xi_i$ i ich iloczyn skalarny. Nodalne warunki styczności sprawdzane są osobno. Dla teksturowanego przypadku dodatnia wartość bezwzględna tego iloczynu jest oczekiwanym ograniczeniem interpolacji P1 nodalnych wektorów stycznych; nie stanowi błędu retrakcji nodalnej ani błędu solvera.

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol LaTeX | Znaczenie | Jednostka SI |
|---|---|---|
| $T$, $i$, $j$, $a$, $b$ | tetraedr oraz indeksy węzłów i składowych | $1$ |
| $\mathbf x_i$ | położenie węzła $i$ | $\mathrm{m}$ |
| $dV$ | miara objętości fizycznej | $\mathrm{m^3}$ |
| $\partial_a$, $\delta_{ij}$, $\delta_{ab}$ | pochodna przestrzenna i symbole Kroneckera | $\mathrm{m^{-1}}$, $1$, $1$ |
| $\operatorname{normalize}(\cdot)$ | normalizacja wektora do długości jeden | $1$ |
| $\hat{\mathbf x}$, $\hat{\mathbf z}$ | jednostkowe wektory osi użyte w sanity checku | $1$ |
| $\mathbf z$ | dowolny wektor nodalny w postaci kwadratowej PSD | $1$ |
| $\mathbf m$ | stos dwunastu składowych magnetyzacji węzłowej | $1$ |
| $\lVert Q^{\mathsf T}\mathbf s\rVert_2$, $\lVert\delta\boldsymbol\phi_Q\rVert_2$ | normy euklidesowe źródła i korekty potencjału | $\mathrm{A\,m}$, $\mathrm{A}$ |
| $\widehat{\mathbf m}_c$, $\boldsymbol\xi_c$ | znormalizowana interpolacja magnetyzacji i interpolowany kierunek w barycentrum | $1$ |
| $\nu_c$ | normalny składnik nodalnej perturbacji w barycentrum | $1$ |
| $L$, $V$ | długość osiowej krawędzi i objętość Tet4 | $\mathrm{m}$, $\mathrm{m^3}$ |
| $N_i$, $\nabla N_i$ | liniowa funkcja kształtu i jej gradient fizyczny | $1$, $\mathrm{m^{-1}}$ |
| $K_{ij}$, $M_{ij}$ | moment sztywności P1 i zgodny moment masy | $\mathrm{m}$, $\mathrm{m^3}$ |
| $\mathbf m_i$, $\boldsymbol\xi_i$, $\mathbf u$ | nodalna magnetyzacja jednostkowa, kierunek styczny, oś anizotropii | $1$ |
| $h$, $\alpha$ | bezwymiarowe kroki retraction i sanity pochodnej | $1$ |
| $A$, $K_u$ | sztywność wymiany i gęstość energii anizotropii | $\mathrm{J\,m^{-1}}$, $\mathrm{J\,m^{-3}}$ |
| $M_s$, $\mathbf H_j$ | magnetyzacja nasycenia i ustalone pole węzłowe | $\mathrm{A\,m^{-1}}$, $\mathrm{A\,m^{-1}}$ |
| $\mu_0$, $\epsilon_{\mathrm{mach}}$ | przenikalność próżni i epsilon maszynowy | $\mathrm{N\,A^{-2}}$, $1$ |
| $B$, $\mathbf s$, $\mathbf r_Q$ | mapa źródła, źródło słabe, reszta układu zredukowanego | $\mathrm{A\,m}$, $\mathrm{A\,m}$, $\mathrm{A\,m}$ |
| $Q$, $P_Q$, $P_Q^{-1}$, $\boldsymbol\phi_Q$, $\delta\boldsymbol\phi_Q$ | baza mean-zero, zredukowana sztywność i jej odwrotność, potencjał i korekta reszty | $1$, $\mathrm{m}$, $\mathrm{m^{-1}}$, $\mathrm{A}$, $\mathrm{A}$ |
| $E$, $\mathbf g$, $\mathsf H$, $C$, $E_d$ | energia, gradient ambientowy, Hessian ambientowy, korekta retrakcji, energia demag | $\mathrm{J}$ |
| $D(h)$, $R(h)$, $\varepsilon_{\mathrm{solve}}$, $\varepsilon_{\mathrm{scale}}$, $E_\ell$, $\ell$ | różnica, ekstrapolacja, estymaty skali numerycznej, składnik i indeks energii | $\mathrm{J}$, $1$ |

### Parametry fixture

| Parametr | Wartość lub polityka | Jednostka |
|---|---|---|
| $L$ | $10^{-8}$ | $\mathrm{m}$ |
| $M_s$ | $8\cdot10^5$ | $\mathrm{A\,m^{-1}}$ |
| $A$ | $10^{-11}$ | $\mathrm{J\,m^{-1}}$ |
| $K_u$ | $10^4$ | $\mathrm{J\,m^{-3}}$ |
| $\mathbf H_j$ | deterministyczne, ustalone wartości nodalne rzędu $10^4$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf u$ | znormalizowany, stały wektor wejściowy | $1$ |
| rodzina $h$ | pięć wymienionych kroków bezwymiarowych | $1$ |

(assumptions-and-validity)=
## Założenia i zakres stosowalności

- Geometria to jeden prosty Tet4 z wierzchołkiem w początku układu i trzema prostopadłymi krawędziami osiowymi długości $L$. Zgodne momenty P1 są dokładne dla podanych całek.
- $M_s$ i $K_u$ są stałe w tym fixture, a pole zewnętrzne jest ustalonym nodalnym polem P1.
- Magnetyzacja ma długość jeden w każdym węźle; kierunek wejściowy jest w każdym węźle styczny przed retrakcją.
- Poisson jest algebraicznym, mean-zero rozwiązaniem na lokalnej przestrzeni potencjału Tet4. Brakuje zewnętrznej domeny i warunków otwartego brzegu.
- Teksturowany stan może być nierównowagowy. Oracle nie dokonuje admission fizycznego stanu.
- Zbieżność Richardsona i raportowane estymaty odnoszą się wyłącznie do tej funkcji energii i tych skończonych macierzy.

(python-api)=
## Publiczne API Python

Brak zmiany publicznego API. Test nie wprowadza parametru, konstruktora ani skryptu symulacyjnego. Poniższy blok pokazuje wyłącznie jawne wartości SI używane przez wewnętrzny oracle; nie importuje Fullmag, nie konstruuje `ProblemIR` i nie uruchamia symulacji.

```python
# %% Dane wejściowe algebry testowej; nie jest to skrypt symulacji.
edge_length_m = 1.0e-8
saturation_magnetization_A_per_m = 8.0e5
exchange_stiffness_J_per_m = 1.0e-11
uniaxial_density_J_per_m3 = 1.0e4
retraction_steps = [0.04, 0.02, 0.01, 0.005, 0.0025]
```

Ten blok nie definiuje publicznej składni ani lowering do IR.

(problem-ir)=
## ProblemIR

Bez zmian. Oracle nie tworzy pola IR, normalizacji, capability ani routingu.

(round-trip-and-failure-semantics)=
## Round-trip i błędy

Nie ma serializacji ani lowering do IR. W tym fragmencie `requested intent` i `resolved execution` pozostają bez zmian; nie dodano nowych `validation errors` ani `unsupported combinations`. Fixture kończy się błędem asercji procesu, jeśli wejścia nie spełniają warunków jednostkowości/styczności, układ zredukowany jest osobliwy albo pochodne i różnice skończone nie zgadzają się według jawnych testowych reguł. Te asercje nie określają zachowania produkcyjnego solvera.

(discrete-realization)=
## Dyskretna realizacja FEM CPU

Program sam konstruuje macierze Tet4 P1 w double precision i rozwiązuje macierz Poissona $3\times3$ przez eliminację Gaussa z wyborem pivota. Nie wywołuje MFEM, produkcyjnego assembly, solvera eigen ani providera demagnetyzacji. Dla każdej próbki energii odtwarza mapę źródła, bazę mean-zero i rozwiązuje potencjał od nowa. Wypisuje krótki marker oraz liczby drugiej wariacji, zbieżności, estymaty i diagnostyki interpolacji.

(lane-support)=
### Macierz backendów i kwalifikacji

| Rodzina | Urządzenie | Stan dla tego artefaktu | Granica dowodu |
|---|---|---|---|
| FEM | CPU | test algebraiczny Tet4; produkcja niekwalifikowana | Samodzielny standard-library oracle, uruchomienie GHA oczekuje. |
| FEM | GPU | niekwalifikowane przez ten artefakt | Brak kodu GPU i dowodu wykonania na urządzeniu. |
| FDM | CPU | nie dotyczy oracle P1; produkcja niekwalifikowana przez ten artefakt | Test nie tworzy dyskretyzacji regularnej siatki. |
| FDM | GPU | nie dotyczy oracle P1; produkcja niekwalifikowana przez ten artefakt | Test nie tworzy kodu CUDA ani dowodu parytetu. |

(implementation-mapping)=
## Mapowanie do implementacji i dowodów

| Równanie lub twierdzenie | Stabilny symbol źródłowy | Test / lane | Status |
|---|---|---|---|
| Momenty Tet4, energia i mean-zero Poisson | `backends/fem/tests/frequency_domain/nodal_energy_hessian_contract_test.cpp`: `make_tet4`, `evaluate_energy`, `analyze_energy` | `fem_modal_eigen_nodal_energy_hessian_contract`, CPU algebra | Źródło widoczne; kompilacja i GHA oczekują. |
| Hessian po nodalnej retrakcji, tekstura P1 i Richardson | ten sam plik: `retract`, `second_difference`, `run_case` | ten sam test | Nie wykonano. |
| Niezależny sanity energii i gradientu anizotropii | ten sam plik: `run_uniform_anisotropy_sanity` | marker `uniform_nodal_anisotropy_energy_gradient_sanity` | Źródło widoczne; wykonanie oczekuje. |
| Target i test CMake bez biblioteki produkcyjnej | `backends/fem/CMakeLists.txt`: `fem_modal_eigen_nodal_energy_hessian_contract` | test CTest | Źródło widoczne; nie zbudowano. |
| Wybór przez szybki kontrakt `native-modal` i receipt SHA | `scripts/ci/run_modal_cabi_contract.py`: `main`, `targets`, komenda CTest i `executable_sha256_by_target` | hosted `native-modal` | Źródło i selector widoczne; brak wyniku CI. |
| Granica produkcyjnego demag i dynamiki LLG | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`: `assemble_native_magnetic_a_qq`, `assemble_native_magnetic_a_phiq`; `docs/physics/0700-frequency-domain-linearized-llg.md`: tangent basis | poza oracle | Źródło kontekstowe; brak porównania operatora. |

(public-api-and-provenance)=
## Pochodzenie API, IR i runtime

Nie zmienia się konstruktor Python, ProblemIR, planner capability, requested intent, resolved execution ani provenance runu. Binarne fixture nie jest uruchamiane jako symulacja Fullmag. Receipt GHA, jeśli powstanie, będzie identyfikował kod źródłowy i target testu; nie będzie receiptem runtime ani dowodem naukowym dla produkcyjnej ścieżki.

(validation)=
## Weryfikacja

Odbiór hostowany wymaga uruchomienia targetu w jobie `native-modal` oraz przejścia sanity anizotropii, przypadku jednorodnego i teksturowanego, kontroli nodalnej jednostkowości i styczności, kontrakcji Richardsona i porównania w ramach raportowanych estymat. Pomiar P1 w barycentrum ma wykazać niezerowy normalny składnik dla tekstury, a zerowy dla pola jednorodnego.

Nie wykonano lokalnego kompilowania, parsera C++, testu ani benchmarku. Źródło/rejestracja były sprawdzane tekstowo; to nie potwierdza kompilacji. Pełna wspólna domena i demag, produkcyjny test gradientu/Hessiana, fizyczna równowaga, widmo oraz GPU pozostają poza walidacją tego fragmentu.

(limitations)=
## Ograniczenia i dalsza weryfikacja

Test weryfikuje niezależny algebraiczny kontrakt, nie produkcyjny operator. Osobnej walidacji wymaga gradient energii używany przez produkcyjne assembly, odwzorowanie pola/Riesz i wierszy $A_{qq}$, granice wspólnej domeny z airboxem oraz transport danych potential. Dodatni Hessian algebraicznego Poissona nie dowodzi zgodności produkcyjnej demagnetyzacji. Fixture nie dowodzi parytetu FEM/FDM ani CPU/GPU i nie kwalifikuje częstotliwości.

(scientific-bibliography)=
## Literatura i kontekst naukowy

- W. F. Brown, *Micromagnetics*, Interscience, 1963 — energia i ograniczenie magnetyzacji w mikromagnetyce.
- A. Hubert i R. Schäfer, *Magnetic Domains*, Springer, 1998 — model mikromagnetyczny i energia demagnetyzacji.
- A. Aharoni, *Introduction to the Theory of Ferromagnetism*, wyd. 2, Oxford University Press — kontekst energii ferromagnetyka.
- R. Anderson i in., “MFEM: A modular finite element methods library,” *Computers & Mathematics with Applications* 81, 42–74 (2021) — bibliografia implementacji produkcyjnej, której test nie wywołuje.
- Kontekst Fullmag: `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`, `docs/physics/0402-uniaxial-anisotropy.md` i `docs/physics/0700-frequency-domain-linearized-llg.md`.

(source-code-index)=
## Indeks źródeł

Źródła wskazują stabilne ścieżki i symbole, nie numery linii zależne od commita. Immutable linki można wygenerować dopiero po wskazaniu pełnego SHA publikowanego źródła. W tej chwili wszystkie stany wykonawcze i kompilacyjne są `NOT VERIFIED`.

| Twierdzenie | Stabilna ścieżka + symbol | Odpowiedzialność | Stan dowodu |
|---|---|---|---|
| Wejście i wywołanie regresji | `backends/fem/tests/frequency_domain/nodal_energy_hessian_contract_test.cpp` + `main`; test deleguje do `make_tet4`, `evaluate_energy` i `analyze_energy` | Tworzy fixture i uruchamia obliczenia energii, jet oraz przypadki kontrolne. | Źródło widoczne; brak kompilacji. |
| Nodalna retrakcja, Hessian i P1 w barycentrum | ten sam plik + `retract`, `run_case`, `run_textured_case` | Różnice skończone, estymaty skali, nodalna styczność i ograniczenie interpolacji. | Źródło widoczne; brak wykonania. |
| Anizotropia jednorodna | ten sam plik + `run_uniform_anisotropy_sanity` | Niezależne zamknięte wzory energii i pochodnej kierunkowej. | Źródło widoczne; brak wykonania. |
| Budowa i CTest | `backends/fem/CMakeLists.txt` + `fem_modal_eigen_nodal_energy_hessian_contract` | Samodzielny target i test bez linkowania produkcyjnej biblioteki FEM. | Rejestracja widoczna; nie zbudowano. |
| Hosted `native-modal` i tożsamość receipt | `scripts/ci/run_modal_cabi_contract.py` + `main`, `targets`, komenda CTest, `executable_sha256_by_target` | Buduje, selekcjonuje i identyfikuje oracle względem SHA checkoutu. | Selector widoczny; brak wyniku CI. |
| Produkcyjna granica demag | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `assemble_native_magnetic_a_qq`, `assemble_native_magnetic_a_phiq` | Porównywany operator produkcyjny pozostaje poza fixture. | Kontekst źródłowy; nieporównany. |