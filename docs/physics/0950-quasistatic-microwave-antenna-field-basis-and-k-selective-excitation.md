# Three-dimensional separable quasistatic microwave-antenna field basis and k-selective spin-wave excitation

- Status: proposed canonical physics and numerics contract
- Owners: Fullmag core
- Last updated: 2026-09-08
- Related ADRs:
  - `docs/adr/0004-backend-canonical-quantities.md`
  - `docs/adr/0011-resource-first-api.md`
  - `docs/adr/0017-staged-antenna-field-basis-workflow.md`
- Related specs:
  - `docs/superpowers/specs/2026-07-10-microwave-antenna-field-basis-design.md`
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/resource-first-control-room-api-v2.md`
- Related physics notes:
  - `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`
  - `docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md`
  - `docs/physics/0860-fdm-generalized-oersted-from-prescribed-current.md`
  - `docs/physics/0920-regional-time-domain-field-drive.md`

(antenna-problem-statement)=
## 1. Problem statement

Fullmag needs two deliberately different microwave-field source families:

1. a three-dimensional conductor-backed microstrip or coplanar-waveguide
   source whose geometry determines the spatial field profile and therefore the
   wave vectors available for spin-wave excitation;
2. a MuMax-style prescribed regional magnetic field for fast FMR, pulse, and
   controlled spin-wave tests that do not claim to represent a conductor.

The conductor-backed source must support a width profile that varies along the
current-flow direction. A CPW may therefore contain a taper or a constriction
in the middle of the line. This is not representable by a translationally
invariant 2.5D cross-section. The source calculation must see the full
three-dimensional conductor geometry, current crowding, signal line, and
return-current paths.

The scientific target is not a full transient Maxwell solve. Fullmag will
calculate a spatial magnetic-field basis once and reuse it in subsequent LLG
stages:

(antenna-separable-field-basis)=
```{math}
:label: antenna-separable-field-basis
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
= \sum_p I_p(t)\,\mathbf H_{p,1\mathrm A}(\mathbf r),
```

<!-- DOC-ANCHOR: antenna-separable-field-basis -->

where $p$ identifies an independent antenna port mode. For the common
single-mode case this reduces to

$$
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
= I(t)\,\mathbf H_{1\mathrm A}(\mathbf r).
$$

This separable model is intentionally cheaper than harmonic or full-wave
electromagnetics. It captures finite three-dimensional geometry and
quasistatic current redistribution, but it does not claim microwave impedance,
propagation, or frequency-dependent current profiles.

The design is motivated by the established transduction mechanism: the
spatial Fourier spectrum of the microwave field acts as a wave-vector filter.
A CPW whose dimensions vary along its axis can make a desired wave vector
available only in a localized section, creating a spin-wave beam. The source
field spectrum and the actual magnetization response must remain separate
observables.

(antenna-assumptions-and-validity)=
## 2. Model hierarchy and selected fidelity level

Fullmag uses an explicit fidelity ladder. The selected implementation target is
Tier 1.

| Tier | Public meaning | Field model | Intended use |
|---|---|---|---|
| 0 | prescribed regional field | authored spatial mask or profile multiplied by a waveform | MuMax-style excitation, FMR, controlled tests |
| 1 | separable 3D quasistatic antenna | DC/quasistatic conduction plus 3D Biot-Savart field basis normalized per ampere | tapered or constricted microstrip/CPW, k-selective time-domain LLG |
| 2 | harmonic magnetoquasistatic antenna | complex frequency-specific current and field basis | narrowband phase-aware excitation, skin/proximity studies |
| 3 | full-wave microwave antenna | frequency-domain Maxwell solve with dielectric and wave ports | impedance, S-parameters, radiation, matched-power efficiency |

Tier 1 is the production MVP because it is the least expensive model that can
respond to a three-dimensional constriction. Tier 0 remains a separate source;
it is not a fallback that may be silently substituted for Tier 1. Tiers 2 and
3 require separate capabilities and must not be inferred from a Tier 1 result.

The existing `mqs_2p5d_az` implementation is not Tier 2. Its current runner
realization samples the infinite-line Biot-Savart field of rectangular strips,
ignores finite length and the authored `center_y`, and does not solve an
$A_z$ finite-element problem. It must be treated as a compatibility
approximation and renamed in provenance to
`legacy_infinite_strip_biot_savart`; it is not exposed by the new authoring UI.

(antenna-governing-equations)=
## 3. Physical model

(antenna-symbols-and-si-units)=
### 3.0 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $p,Q_\ell^{\mathrm{lo}},Q_\ell^{\mathrm{hi}}$ | indeks próbki i zbiory reguł low/high globalnego ledgeru | $1$ |
| $\mathbf w_{\ell p},S_\ell,R_t$ | ważony wkład, suma norm próbek i heurystyczny wskaźnik roundoff | $\mathrm{A\,m^{-1}}$ |
| $u_{64}$ | binary64 epsilon, dokładnie $2^{-52}$ | $1$ |
| $b$ | indeks obserwowanej gałęzi device | $1$ |
| $\mathcal D_b,\mathcal F_b$ | różne wierzchołki P1 oraz jawne interface faces gałęzi po stronie device | $1$ |
| $F_b^{\mathrm{H1}},F_b^{\mathrm{RT0}}$ | podpisane outward pomiary reakcji H1 i całki RT0 gałęzi | $\mathrm A$ |
| $H_{\mathrm{expected}},H_{\mathrm{measured}}$ | oczekiwana i zmierzona składowa H w regresji odd linearity/doubling, nie globalne oszacowania błędu | $\mathrm{A\,m^{-1}}$ |
| $w_f$ | rzeczywisty podpisany integralny współczynnik owned RT0 DOF→canonical face flux, zawierający orientację i normalizację bazy | $1$ |
| $\mathbf A_f,\mathbf p_{f,r}$ | canonical wektor pola trójkąta i jego trzy wierzchołki; indeks $r=1,2,3$ | odpowiednio $\mathrm{m^2}$ i $\mathrm m$ |
| $w_{f,j}^{\mathrm{RT}},\Phi_f^{\mathrm{RT}}$ | całka lokalnej generic bazy na canonical ścianie i całka pełnej shared rekonstrukcji | odpowiednio $1$ i $\mathrm A$ |
| $c_j^{\mathrm{loc}},s_j$ | rzeczywisty lokalny signed raw MFEM coefficient i jego znak mapowania DOF | odpowiednio $\mathrm A$ i $1$ |
| $q_{d(f)},\Phi_f$ | współczynnik owned RT0 przypisany ścianie oraz physical canonical moment tej ściany | $\mathrm A$ |
| $\Omega_{\mathrm{modeled}}$ | skończona objętość device+lead objęta całką, bez generatora i pominiętego powrotu | $\mathrm{m^3}$ |
| $\mathbf H_{\mathrm{modeled}},\mathbf H_{\mathrm{full}},\mathbf H_{\mathrm{omitted}}$ | wkład skończonej domeny, pole kompletnego obwodu i pominięty wkład | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{high}},\mathbf H_{\mathrm{low}}$ | lokalne dwa oszacowania kwadratury | $\mathrm{A\,m^{-1}}$ |
| $a_q,h_q$ | lokalna tolerancja absolutna oraz jawny legacy floor 1 A/m | $\mathrm{A\,m^{-1}}$ |
| $r_q$ | lokalna tolerancja względna z jawnym dimensional floor, nie globalny error certificate | $1$ |
| $\mathbf H_{\mathrm{ant}}$ | instantaneous summed antenna magnetic field strength | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{p,1\mathrm A}$ | spatial field basis of port mode $p$, normalized per ampere | $\mathrm{A\,m^{-1}\,A^{-1}}$ |
| $I_p$ | signed current waveform of port mode $p$ | $\mathrm A$ |
| $\mathbf J$ | conventional electric-current density | $\mathrm{A\,m^{-2}}$ |
| $V$ | electric scalar potential | $\mathrm V$ |
| $\sigma$ | electrical conductivity | $\mathrm{S\,m^{-1}}$ |
| $\Omega_c$ | union of conducting volumes in the mode | $\mathrm{m^3}$ |
| $\Gamma_{\mathrm{term}}$ | terminal surface set | $\mathrm{m^2}$ |
| $\mathbf n$ | outward unit normal | $1$ |
| $w_{p,q}$ | signed branch weight for mode $p$ and branch $q$ | $1$ |
| $\mathbf r$ | target position | $\mathrm m$ |
| $\mathbf r'$ | source position | $\mathrm m$ |
| $\mathbf m$ | normalized magnetization | $1$ |
| $\mathbf k$ | spin-wave wave vector | $\mathrm{rad\,m^{-1}}$ |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $\varphi_i$ | scalar P1 basis function for degree of freedom $i$ | $1$ |
| $K_{ij}$ | assembled charge-diffusion stiffness entry | $\mathrm{A\,V^{-1}}$ |
| $b_i$ | assembled charge right-hand-side entry | $\mathrm A$ |
| $V_i$ | nodal electric potential | $\mathrm V$ |
| $R_i$ | uneliminated discrete charge reaction | $\mathrm A$ |
| $\mathcal D_t$ | essential degrees of freedom owned by terminal $t$ | $1$ |
| $F_t$ | signed outward terminal current | $\mathrm A$ |
| $F_t^{\mathrm{requested}}$ | prescribed signed outward terminal current | $\mathrm A$ |
| $G_{ts}$ | terminal conductance response | $\mathrm{A\,V^{-1}}$ |
| $U_s$ | equipotential value on terminal $s$ | $\mathrm V$ |
| $V^{(s)}$ | solution for unit potential on terminal $s$ | $\mathrm V$ |
| $N_s$ | number of source tetrahedra in one direct Oersted evaluation | $1$ |
| $N_t$ | number of target points in one direct Oersted evaluation | $1$ |
| $P$ | source-target pair count | $1$ |
| $P_{\max}$ | versioned maximum direct-Oersted pair count | $1$ |
| $\mathbf v,\mathbf u,\mathbf d$ | pełny wektor potencjału, wolne współrzędne quotient oraz niezależne napięcia/skoki trace | $\mathrm V$ |
| $Q,L$ | mapy jednorodnych i wymuszonych relacji trace po usunięciu gauge | $1$ |
| $K,A$ | pełny operator H1 i jego ograniczenie do wolnych DOF | $\mathrm{A\,V^{-1}}$ |
| $\Pi$ | mapa niezależnych napięć/skoków na rozwiązany potencjał | $1$ |
| $S$ | macierz wskaźników rozłącznych essential DOF terminali equipotential | $1$ |
| $\mathbf R,\mathbf F,\mathbf F^{\mathrm{requested}}$ | reakcje H1, zmierzone prądy outward i żądane prądy terminalowe | $\mathrm A$ |
| $\mathcal G$ | odpowiedź prądów terminalowych na niezależne napięcia/skoki | $\mathrm{A\,V^{-1}}$ |
| $\mathsf U_\alpha,\mathsf U$ | bezwymiarowe rozwiązanie jednostkowego voltage control i macierz jego kolumn; indeksy $\alpha,\beta$ oznaczają controls | $1$ |
| $\mathbf v^{(\alpha)}$ | nodalny potencjał dla jednostkowego napięcia control $\alpha$ | $\mathrm V$ |
| $\alpha,\beta$ | indeksy niezależnych voltage controls | $1$ |
| $\mathsf E$ | dodatnia macierz odpowiedzi energetycznej controls | $\mathrm{A\,V^{-1}}$ |
| $\mathbf i,\mathbf i^{\mathrm{requested}}$ | zmierzone i żądane prądy sprzężone z voltage controls; nie są automatycznie prądami terminali | $\mathrm A$ |
| $\mathsf C$ | diagonalna skala dodatniej macierzy energetycznej | $\mathrm{(A\,V^{-1})^{1/2}}$ |
| $\mathsf B$ | diagonalnie przeskalowana macierz energetyczna | $1$ |
| $\mathbf y$ | przeskalowane współrzędne napięć sterujących | $\mathrm{(A\,V)^{1/2}}$ |
| $\mathsf A_c,\mathsf D_c$ | macierz zadanych relacji trace i anchorów oraz macierz współczynników controls | $1$ |
| $\mathsf N$ | macierz wskaźników pierwotnych objętości połączonych ścianami, przed identyfikacją trace | $1$ |
| $\boldsymbol c$ | stałe potencjały pierwotnych objętości przewodzących | $\mathrm V$ |
| $\mathsf W$ | macierz warunków zgodności controls ze stałymi potencjałami objętości | $1$ |
| $n_{\mathrm{ctrl}}$ | liczba autorskich controls | $1$ |
| $\mathbf q,\mathbf h$ | orientowane całki strumieni RT0 oraz prawe strony ograniczeń całkowych | $\mathrm A$ |
| $\mathcal T,\lvert\mathcal T\rvert$ | prosty tetraedr i jego dodatnia objętość w audycie normalizacji RT0 | $\mathrm{m^3}$ |
| $\mathbf x,\mathbf v_j$ | punkt fizyczny oraz wierzchołek przeciwległy do ściany lokalnej $j$ | $\mathrm m$ |
| $f_i,dS$ | lokalna ściana outward i jej miara powierzchniowa | $\mathrm{m^2}$ |
| $i,j,a,\delta_{ij}$ | indeksy lokalnej ściany/bazy, globalnego DOF i delta Kroneckera | $1$ |
| $\boldsymbol\phi_j,\boldsymbol\phi_a$ | surowa lokalna oraz podpisana globalna baza MFEM | $\mathrm{m^{-2}}$ |
| $\beta_{\mathrm{RT}},\mu_a,\mathsf S_{\mathrm{RT}}$ | moment lokalnej bazy, dodatnia skala globalnego DOF i jej macierz diagonalna | $1$ |
| $\mathbf c$ | surowe owned współczynniki MFEM, nie fizyczne momenty jednostkowo znormalizowanej bazy | $\mathrm A$ |
| $M^{\mathrm{MFEM}}$ | metryka złożona z surowej bazy | $\mathrm{V\,A^{-1}}$ |
| $\mathbf f^{\mathrm{MFEM}}$ | load złożony z surowej bazy | $\mathrm V$ |
| $\boldsymbol\psi_a,\boldsymbol\psi_b$ | baza RT0 znormalizowana do jednostkowego momentu normalnego; indeksy $a,b$ oznaczają DOF | $\mathrm{m^{-2}}$ |
| $M$ | macierz ważonej normy RT0 w współrzędnych całek strumienia | $\mathrm{V\,A^{-1}}$ |
| $\mathbf f,\boldsymbol\lambda$ | ważona projekcja surowego prądu i mnożniki ograniczeń | $\mathrm V$ |
| $D$ | stos wierszy całkowej dywergencji, par trace i prądów terminalowych | $1$ |
| $\mathbf J_{\mathrm{raw}},\mathbf J(\mathbf q)$ | prąd z gradientu zaakceptowanego V i jego rekonstrukcja RT0 | $\mathrm{A\,m^{-2}}$ |
| $\mathcal E$ | połowa kwadratu normy korekty ważonej odwrotnością przewodności | $\mathrm W$ |
| $\mathbf z$ | współczynniki liniowej zależności wierszy ograniczeń | $1$ |
| $\nabla,d\Omega$ | gradient przestrzenny oraz miara objętości | $\mathrm{m^{-1}},\mathrm{m^3}$ |
| $h_u,h_v$ | odstępy punktów próbkowania w dwóch osiach płaszczyzny | $\mathrm m$ |
| $h_{\min},h_{\max}$ | mniejszy i większy z odstępów $h_u,h_v$ | $\mathrm m$ |
| $X_{\max}$ | największa bezwzględna współrzędna obwiedni żądanej płaszczyzny, ograniczona od dołu przez $h_{\max}$ | $\mathrm m$ |
| $L_u,L_v$ | pełne długości boków żądanej płaszczyzny próbkowania | $\mathrm m$ |
| $r_{0,j}$ | składowa $j$ początku płaszczyzny | $\mathrm m$ |
| $u_j,v_j$ | składowe $j$ jednostkowych osi płaszczyzny | $1$ |
| $j$ | indeks współrzędnej kartezjańskiej | $1$ |
| $\epsilon_{\mathrm{mach}}$ | względna precyzja typu `f64` | $1$ |
| $\tau_{\mathrm{id}}$ | tolerancja dopasowania współrzędnych w ścieżce `identity_coordinates_v1` | $\mathrm m$ |
| $i,N,N_u,N_v,h$ | indeks próbki, liczność osi, liczności obu osi i całkowity numer harmonicznej okna | $1$ |
| $a_0,a_1,a_2$ | współczynniki kosinusowego okna dyskretnego | $1$ |
| $g_i^{(N)}$ | wartość okna dla próbki $i$ na osi długości $N$ | $1$ |
| $C_h(N)$ | suma dyskretnego kosinusa harmonicznej $h$ | $1$ |
| $W_1(N),W_2(N)$ | suma wartości okna i suma ich kwadratów na jednej osi | $1$ |
| $G_c$ | dwuwymiarowy coherent gain | $1$ |
| $B_{\mathrm{ENBW}}$ | dwuwymiarowa równoważna szerokość szumowa w binach | $1$ |

### 3.1 Conductor domain and electric potential

Let $\Omega_c$ be the union of all conducting volumes participating in one
antenna port mode. In each conductor with scalar conductivity $\sigma(\mathbf
r)>0$, Tier 1 solves

$$
\nabla\cdot\mathbf J=0,
\qquad
\mathbf J=-\sigma\nabla V
\quad\text{in }\Omega_c.
$$

The exterior conductor boundary is insulating except on declared terminal
faces:

$$
\mathbf J\cdot\mathbf n=0
\quad\text{on }\partial\Omega_c\setminus\Gamma_{\mathrm{term}}.
$$

Terminals use an integral-current/equipotential formulation. For conductor
branch $q$, `current_weight` is signed relative to the common local $+u$
orientation from its inlet face to its outlet face. Each terminal face is
equipotential, while the current constraints for mode $p$ are

$$
\int_{\Gamma^{\mathrm{in}}_{p,q}}
\mathbf J_p\cdot\mathbf n\,dS
=-w_{p,q} I_{p,\mathrm{ref}},
\qquad
\int_{\Gamma^{\mathrm{out}}_{p,q}}
\mathbf J_p\cdot\mathbf n\,dS
=+w_{p,q} I_{p,\mathrm{ref}},
\qquad
\sum_q w_{p,q}=0.
$$

The reference current is

$$
I_{p,\mathrm{ref}}=1\ \mathrm A.
$$

The zero-sum condition is mandatory. It prevents a physically open current
source across a common transverse section and makes the signal/return
convention explicit. A negative weight reverses current relative to local
$+u$; authors do not also reverse the inlet/outlet selectors.

For a symmetric CPW mode, the initial production convention is

$$
(w_{\mathrm{signal}},w_{\mathrm{ground,left}},
w_{\mathrm{ground,right}})=(+1,-1/2,-1/2).
$$

An asymmetric design may author different weights whose sum is zero, or define
multiple independent port modes. A microstrip layout is invalid without an
explicit return conductor or return plane. The Tier 1 solver does not infer a
return current through a dielectric substrate.

Disconnected signal and ground conductors are solved as parts of the same
current mode through their own terminal face pairs and signed integral-current
constraints. The scalar-potential solves determine the distribution inside
each connected metal body; the authored port-mode weights determine how the
total source current is divided between disconnected return bodies. Automatic
RF return splitting requires a harmonic circuit/field model and belongs to
Tier 2 or 3.

(antenna-terminal-weak-reaction)=
The production terminal-current solve must measure each terminal with the
**uneliminated discrete reaction of the same H1 operator** used to solve the
potential. For the assembled P1 charge form and its right-hand side, define

```{math}
:label: antenna-terminal-weak-reaction
K_{ij}=\int_{\Omega_c}\sigma\nabla\varphi_i\cdot\nabla\varphi_j\,d\Omega,
\qquad R_i=\sum_jK_{ij}V_j-b_i,
\qquad F_t=-\sum_{i\in\mathcal D_t}R_i.
```

The minus sign follows from $\mathbf J=-\sigma\nabla V$: a high-potential
terminal on a straight bar has negative outward conventional-current flux.
Terminal sets must be disjoint at the essential-DOF level; touching terminal
selectors are invalid rather than double-counted. The historical face
quadrature of the recovered gradient is only a diagnostic and must not define
the terminal response or a current certificate.

For each electrically connected component, one terminal is the gauge. Solve
one H1 problem per non-gauge unit terminal potential, with all other terminal
potentials zero, to obtain the response matrix. The prescribed signed-current
vector must have zero sum on that component. Remove the gauge row and column,
check the reduced matrix rank without regularization, solve for the remaining
terminal voltages, and reconstruct the field from the same H1 operator:

```{math}
:label: antenna-terminal-response
G_{ts}=F_t[V^{(s)}]/(1\,\mathrm V),
\qquad \sum_sG_{ts}U_s=F_t^{\mathrm{requested}},
\qquad \sum_tF_t^{\mathrm{requested}}=0.
```

The final solve must verify every signed $F_t$ against the authored current,
including the gauge terminal; equality of magnitudes is insufficient. A V3
charge-only ABI and H1 response implementation now exist in source, but native
runtime and numerical qualification remain open.

The numerical current certificate uses the requested magnitude of each
terminal, not the maximum of a port or conductor component. Thus neither a
disconnected high-current conductor nor a high-current branch on the same
conductor can mask a reversed low-current return:

```{math}
:label: antenna-terminal-current-certificate
|F_t-F_t^{\mathrm{requested}}|
\leq 10^{-8}|F_t^{\mathrm{requested}}|+10^{-18}\,\mathrm A.
```

The relative term accommodates the iterative H1 solve and response inversion;
the absolute floor is a numerical acceptance floor, not a physical current
source. If the discretization or solver cannot certify a small return at this
threshold, the result fails closed rather than silently relaxing the threshold
using another terminal's current. The measured weak reaction, rather than a
recovered-gradient surface quadrature, is used on both sides of this
certificate.

(antenna-resolved-terminal-current-adapter)=
#### Adapter fizycznych terminali po meshingu

**Kontrakt kolejnego etapu native T05, przed kwalifikacją RT0.** Terminal
jest zadany przez niepusty stabilny identyfikator i jawne trójki stable
vertex IDs jego ścian brzegowych w tej samej siatce co charge workspace.
Native adapter odnajduje rzeczywiste ściany, wyznacza ich H1/P1 DOF i
odrzuca nieobecną ścianę, duplikaty, współdzielone essential DOF oraz
terminal obejmujący więcej niż jeden komponent elektryczny. Nie wybiera
elektrody po nazwie, osi, współrzędnych ani arbitralnym numerze DOF.
Lista ścian musi być domknięta względem zbioru essential DOF: jeżeli
wszystkie trzy P1 DOF innej ściany brzegowej należą do tego samego
terminala, ściana ta także musi występować w jego jawnej liście. W
przeciwnym razie dyskretne warunki Dirichleta tworzyłyby dodatkową
powierzchnię elektrody, której nie obejmuje zapis do pomiarów RT0.
Adapter odrzuca taką niepełną listę, zamiast dopisywać ukryte ściany.
Odrzuca też niezadeklarowaną ścianę, której wszystkie DOF należą do
różnych terminali: otrzymałaby ona w całości interpolowany Dirichlet
trace zamiast niezależnego warunku izolującego. W tej realizacji
separator elektrod musi zachować co najmniej jeden wolny P1 DOF na
każdej swojej ścianie. Jest to ograniczenie kwalifikowanej dyskretyzacji,
nie stwierdzenie, że taka geometria nie ma rozwiązania ciągłego.

Wszystkie DOF wszystkich terminali stają się anchorami, również terminali
o żądanym prądzie zero. W każdym komponencie z terminalami referencją
jest terminal o najmniejszym stable vertex ID w swojej grupie. Jego
napięcie wynosi zero tylko jako gauge; jego prąd jest mierzony i
weryfikowany tak samo jak pozostałe. Komponent bez terminali zachowuje
jedną wewnętrzną referencję i nie otrzymuje ukrytego wymuszenia.

Ten adapter dopuszcza jawne relacje ciągłości interface z zerowym skokiem
potencjału. Bilans i gauge liczy po electrical union tych relacji;
pierwotne objętości przed union nadal wyznaczają jądro K w exact rank gate.
Terminal DOF identyfikowany z innym DOF trace jest w tej realizacji
odrzucany: pomiar tylko jednej strony takiego aliasu nie byłby pełnym
prądem sprzężonym z jego napięciem. Obsługa jawnie certyfikowanych
trace-closed grup elektrod wymaga oddzielnej kwalifikacji. Niezerowy
cut actuator nie jest interpretowany jako terminal equipotential.

Jeden owned workspace składa K raz. Zerowy solve tego samego właściciela
ustala owned mapę komponentów i DOF→vertex; następnie każdy terminal
niebędący referencją tworzy voltage control z coefficient 1 na swoich
anchorach i 0 na pozostałych. Prądy żądane controls są podpisanymi
prądami outward tych terminali. Przy spełnieniu wolnego residualu H1
pomiar reakcji przez rozwiązany unit control jest równoważny sumie
reakcji jego essential DOF, według równań
`antenna-terminal-weak-reaction` i `antenna-conjugate-current-response`.
Wspólny prepared response core nie składa drugiego K. Jego topologia,
stable IDs i polityka solve muszą odpowiadać przygotowanemu workspace;
nie wolno podmienić ich innym requestem. Właściciel nie odczytuje ponownie
borrowed mesh/material po assembly.

Finalny pomiar każdego terminala sumuje nieeliminowane reakcje przez
rzeczywistą owned mapę DOF→vertex, nie zakłada vertex index = DOF index.
Kontrola `antenna-terminal-current-certificate` obowiązuje również dla
referencji, małego returnu i requested-zero. Preflight odrzuca niezbilansowany
prąd na każdym komponencie oddzielnie; globalne zniesienie bilansów dwóch
rozłącznych przewodników nie wystarcza. Gdy żaden komponent nie ma
niezależnej kolumny, wykonywany jest tylko zerowy solve i pełne pomiary;
nie konstruuje się pustej macierzy response ani sztucznego control.
Wstępny bilans używa progu $10^{-18}\,\mathrm A +
10^{-10}\sum_t |F_t^{\mathrm{requested}}|$ na swoim komponencie.
Jest to wyłącznie preflight wejścia: nie zastępuje końcowego progu
$10^{-18}\,\mathrm A + 10^{-8}|F_t^{\mathrm{requested}}|$ dla
każdego terminala oddzielnie.

Wewnętrzne typy adaptera, bez nowych parametrów Python ani pól IR:

| Pole | Typ i default | Jednostka SI | Walidacja i znaczenie |
|---|---|---|---|
| `ChargeTerminalCurrentRequest.conductor` | `ChargeTraceSolveRequest`, wymagany | jednostki pól bazowych | straight tet4/P1, scalar positive conductivity, prawdziwe stable IDs, brak autorskich anchorów; tylko zero-jump interface trace |
| `ChargeTerminalCurrentRequest.terminals` | lista `ResolvedChargeTerminal`, wymagana | $1$ | niepusta, unikalne ID, rzeczywiste boundary faces, rozłączne essential DOF; łącznie co najwyżej 64 niezależne controls |
| `ResolvedChargeTerminal.id` | `string`, wymagany | $1$ | jawny stabilny identyfikator fizycznego terminala |
| `ResolvedChargeTerminal.boundary_face_vertex_ids` | lista rosnących trójek `uint64`, wymagana | $1$ | niepuste, unikalne canonical face keys w stable-ID ordering tej siatki; brak interior/unknown face; lista domknięta względem essential DOF |
| `ResolvedChargeTerminal.requested_outward_current_a` | `double`, `0.0` | $\mathrm A$ | finite signed current, bilans per electrical component i finalna kontrola każdego terminala |

Wynik jest owned: accepted V i K V, kolejność terminal IDs, napięcia,
requested/measured outward currents, signed residuals oraz referencje
komponentów oraz zweryfikowane, domknięte grupy physical boundary faces.
Nie stanowi certyfikatu terminal moments RT0 ani kompletnego
V/J/H. Nowe append-only wejście RT0-current i typed accepted-charge
carrier muszą używać tego samego wyniku, a nie wykonywać ponowny solve
z legacy napięciem closure. Istniejące entrypointy zachowują znaczenie.
Nie przepina się starego V3/oracle bez stable IDs przez sfabrykowaną
tożsamość wierzchołków.

(antenna-current-terminal-authoring-contract)=
The intended public terminal selector is an equipotential current terminal:
`CurrentTransport.boundaries[]` identifies its stable `id` and nonempty surface
set, but contains **neither** an authored voltage nor a current density. A
dedicated antenna port mode references these terminal ids and supplies the
signed integral currents through its branch weights and $I_{p,\mathrm{ref}}$.
The canonical `ProblemIR` boundary kind is to be
`equipotential_current_terminal`; `gauge=terminal_reference` means one
terminal per connected conductor component is fixed to $0\,\mathrm V$ only
to remove the potential nullspace. It does not prescribe the physical current.
The planner must resolve the selector surfaces after meshing, reject shared H1
essential degrees of freedom or voltage/current terminal overlap, and retain
the requested current weights separately from the resolved terminal voltages.
Existing `voltage_electrode` and `normal_current_electrode` keep their distinct
meanings: a voltage is not a placeholder terminal label, and a prescribed
normal current density is not an integral-current constraint. Python,
`ProblemIR`, and the dedicated planner now resolve this terminal kind without
voltage electrodes. This is **source-level integration, not native-runtime
qualification**; the V3 solve, RT0 reconstruction, and field artifact still
require managed execution and numerical evidence.

(antenna-accepted-charge-workspace)=
### 3.1.1 Wspólny charge workspace: terminale, wiele cutów i RT0

**Kontrakt docelowy T05/T06, nie wynik wykonanego solvera.** Poniższe
wyprowadzenie dotyczy FEM CPU, przewodności skalarnej dodatniej, H1/P1 na
pełnej domenie 3D device+closure oraz braku objętościowych źródeł ładunku
($b_i=0$). Nie definiuje nowego publicznego konstruktora Python ani nie
zmienia znaczenia istniejącego `ProblemIR`. FEM GPU i oba FDM pozostają
konsumentami bazy zgodnie z macierzą wsparcia; te równania nie dowodzą
implementacji ich solverów charge.

Po meshingu należy zbudować jawne relacje między trace DOF: ciągłość na
interfejsie metalu, zadany skok na parze cutu i equipotential na terminalu.
Jedna ściana nie może być równocześnie terminalem i cutem, jeżeli kontrakt
nie definiuje sposobu rozdzielenia ich reakcji. Relacje affine rozwiązuje
graf DOF z kontrolą sum skoków w każdym cyklu samych relacji trace;
nie jest to cykl fizycznego przewodzenia przez objętość. Niezgodnego cyklu nie
naprawia regularizacja. Współrzędne świata służą do zweryfikowania par,
nie do sumowania geometrycznych liftów wielu niezależnych cutów.

Komponenty elektryczne wyznacza graf rzeczywistego połączenia objętości i
zaakceptowanych relacji trace, nie nazwy obiektów ani bliskość punktów.
Sam kontakt punktowy przez wspólny węzeł nie jest kwalifikowanym kontaktem
wolumetrycznym metalu.
Każdy komponent zachowujący swobodę stałego potencjału wymaga jednego gauge;
dotyczy to również niewzbudzonego izolowanego metalu. Nie dodaje się drugiego
gauge do komponentu z już ustaloną referencją potencjału. Po jego usunięciu
i kontroli niezależności relacji:

```{math}
:label: antenna-affine-charge-response
\mathbf v=Q\mathbf u+L\mathbf d,\qquad
A=Q^T KQ,\qquad
A\mathbf u=-Q^T KL\mathbf d,\qquad
\Pi=L-QA^{-1}Q^T KL,\qquad \mathbf v=\Pi\mathbf d.
```

Pierwszy układ wynika z testowania równania H1 przez wszystkie dopuszczalne
jednorodne wariacje $Q\mathbf u$. Zapis $A^{-1}$ oznacza rozwiązanie układu,
nie tworzenie gęstej odwrotności. Ten sam operator i preconditioner mogą
obsłużyć wiele prawych stron; każda baza portu zachowuje własny certyfikat.
Właściciel wielokrotnego solve przechowuje własną kopię złożonego K,
mapowanie vertex→DOF, stable IDs i współrzędne. Po assembly nie odwołuje
się ponownie do borrowed siatki ani przewodności. W kolejnych solve
zmieniają się tylko wartości skoków i anchorów; endpointy trace, anchor
DOF, tolerancje i identyfikacja komponentów pozostają ustalone.
Zmiana geometrii lub materiału wymaga nowego właściciela operatora.
Samo ponowne wywołanie assembly z tą samą zmienną wskaźnikową materiału
nie dowodzi użycia tej samej dyskretnej przewodności.
Jeżeli nie ma wolnych DOF, mapa potencjału jest samym $L$, bez pustego solve.
Macierze powstają z pełnego operatora przed eliminacją essential DOF, zgodnie
z rozróżnieniem warunków essential i natural w
[dokumentacji MFEM](https://mfem.org/fem_bc/).

Dla fizycznych terminali equipotential obowiązuje:

```{math}
:label: antenna-affine-terminal-measurement
\mathbf R=K\mathbf v,\qquad
\mathbf F=-S^T\mathbf R,\qquad
\mathcal G=-S^TK\Pi,\qquad
\mathcal G\mathbf d=\mathbf F^{\mathrm{requested}}.
```

Nie należy z góry zakładać kwadratowego układu ostatniego równania. Liczba
niezależnych wymuszeń musi wystarczać do realizacji autorskich wag; jeden
cut nie może sterować dowolną liczbą niezależnych returnów. Po usunięciu
udokumentowanych zależności należy sprawdzić zgodność prawej strony i
jednoznaczność fizycznego rozwiązania. Niedostateczny rząd oznacza odrzucenie
portu albo brakujący actuator, nie dowolne rozwiązanie pseudoodwrotne.
Sumy prądów outward na każdym komponencie pozostają zerowe.
Reakcja sprzężona energetycznie ze skokiem trace jest natomiast
$-L^T\mathbf R$; nie jest automatycznie prądem pojedynczego terminala.
Jej związek ze strumieniem jednej strony cutu wymaga jawnej orientacji i
niezależnej kontroli. Zsumowanie obu przeciwległych stron daje bilans zero,
a nie prąd wzbudzenia.

(antenna-conjugate-response-controls)=
#### Odpowiedź prądów sprzężonych z niezależnymi controls

**Kontrakt numeryczny przed integracją publicznych terminali.** Każda
kolumna sterowania ustala współczynniki skoków i anchorów dla jednego
napięcia. Zbiór wszystkich anchor DOF pozostaje ten sam również wtedy,
gdy współczynnik danej kolumny wynosi zero. Baseline wszystkich wartości
jest zerowy; gauge nie wprowadza dodatkowego źródła. Jednostkowe i końcowe
rozwiązania korzystają z tego samego owned K, quotient i mapy komponentów.

```{math}
:label: antenna-conjugate-current-response
\mathsf U_\alpha=\frac{\mathbf v^{(\alpha)}}{1\,\mathrm V},\qquad
\mathsf E_{\alpha\beta}=\mathsf U_\alpha^T K\mathsf U_\beta,\qquad
\mathbf i=-\mathsf U^T\mathbf R,\qquad
\mathsf E\mathbf d=-\mathbf i^{\mathrm{requested}}.
```

Ujemny znak wynika z konwencji $\mathbf J=-\sigma\nabla V$ i outward
reaction. Wektor jednostkowy rozwiązany różni się od pełnego affine liftu
o dopuszczalną jednorodną wariację; ich pomiar reakcji jest równoważny
tylko po niezależnej kontroli residualu wolnych quotient DOF.
Pomiar przez $\mathsf U$ certyfikuje prąd sprzężony energetycznie z
actuatorem. Interpretację jako prądu fizycznego terminala lub jednej
strony cutu musi zapewnić osobny jawny adapter postmeshing.

Macierz $\mathsf E$ jest półokreślona dodatnio. Do Cholesky wymagane są
controls niezależne modulo stały potencjał każdego komponentu, nie tylko
różne autorskie tablice współczynników. Common-mode, controls powielone,
przeciwne lub niewzbudzające pola należy odrzucić, także dla zgodnej albo
zerowej prawej strony. Nie używa się pseudoodwrotności ani diagonal shift.

(antenna-authored-control-rank-contract)=
**Dokładny rząd autorskiego wymuszenia, niezależny od residualu FEM.**
Dla dodatniej przewodności i kwalifikowanej prostej siatki tet4 jądro
oryginalnego, nieeliminowanego K składa się ze stałych na każdej pierwotnej
objętości połączonej ścianami. Identyfikacje trace nie mogą wcześniej
scalić tych objętości w tej kontroli: niezerowy skok między dwiema
rozłącznymi objętościami może wyłącznie przesunąć ich stałe potencjały.

```{math}
:label: antenna-authored-control-nullspace-rank
\ker K=\operatorname{range}\mathsf N,\qquad
\mathsf A_c\mathbf v=\mathsf D_c\mathbf d,\qquad
\mathsf A_c\mathsf N\boldsymbol c=\mathsf D_c\mathbf d,\qquad
\operatorname{rank}[\mathsf A_c\mathsf N\mid\mathsf D_c]
-\operatorname{rank}(\mathsf A_c\mathsf N)=n_{\mathrm{ctrl}}.
```

Wiersz trace w $\mathsf A_c$ mierzy plus minus minus; wiersz anchor
mierzy zadany DOF. Kryterium obowiązuje dopiero po sprawdzeniu, że każda
kolumna $\mathsf D_c$ jest wykonalna w pełnej przestrzeni nodalnej.
Niespójny cykl trace albo sprzeczne anchory są błędem wejścia, nie
certyfikatem niezerowej energii.

Eliminacja stałych objętości jest grafowa. Trace stanowi orientowaną
krawędź między pierwotnymi objętościami, a anchor między objętością
i syntetycznym węzłem odniesienia; ten węzeł nie jest fizycznym kontaktem.
Las rozpinający wyznacza symboliczne przesunięcia. Pozostałe krawędzie,
w tym pętle wewnątrz jednej objętości, dają warunki zgodności:

```{math}
:label: antenna-authored-control-compatibility-rank
\exists\boldsymbol c:\mathsf A_c\mathsf N\boldsymbol c=\mathsf D_c\mathbf d
\quad\Longleftrightarrow\quad\mathsf W\mathbf d=0,\qquad
\operatorname{rank}\mathsf W=n_{\mathrm{ctrl}}.
```

Analogiczny graf pełnych DOF sprawdza wykonalność wszystkich kolumn:
każdy warunek cyklu musi być identycznie zerowy. Współczynniki finite
binary64 traktuje się jako dokładne liczby dyadyczne, nie wartości
porównywane tolerancją H1. Wspólne przeskalowanie przez $2^{1074}$
zamienia je w liczby całkowite; sumy grafowe i eliminacja rzędu są
całkowitoliczbowe. Przekroczenie jawnego budżetu arytmetyki oznacza
odmowę, nigdy przybliżenie rzędu. Ten etap nie certyfikuje dobrego
uwarunkowania ani odtwarzalności amplitud w double. Osobna bramka
symetrii i scaled Cholesky pozostaje obowiązkowa po dokładnym rzędzie.

```{math}
:label: antenna-conjugate-current-diagonal-scaling
\mathsf C_{\alpha\alpha}=\sqrt{\mathsf E_{\alpha\alpha}},\qquad
\mathsf B=\mathsf C^{-1}\mathsf E\mathsf C^{-1},\qquad
\mathsf B\mathbf y=-\mathsf C^{-1}\mathbf i^{\mathrm{requested}},\qquad
\mathbf d=\mathsf C^{-1}\mathbf y.
```

Przed faktoryzacją sprawdza się finite entries, dodatnie diagonale oraz
niezależnie symetrię; nie naprawia się asymetrii uśrednianiem.
Próg scaled pivot uwzględnia dokładność H1 i arytmetyki. Normalizacja
diagonalna nie używa globalnej przewodności jako progu, aby mały rozłączny
komponent nie został odrzucony tylko z powodu obecności dużego.
Finalny solve kontroluje superpozycję potencjału i podpisane prądy
sprzężone każdego actuatora na własnej skali. Niezależny pomiar wszystkich
fizycznych terminali oraz zgodność H1→RT0 pozostają osobnymi wymaganiami.

Wewnętrzny kontrakt native (nie nowe konstruktory Python ani pola IR):

| Pole | Typ i wartość domyślna | Jednostka SI | Walidacja i znaczenie |
|---|---|---|---|
| `ChargeCurrentResponseRequest.zero_baseline` | `ChargeTraceSolveRequest`, wymagany | jednostki pól bazowego request | identyczna siatka/operator/trace/anchor DOF dla wszystkich solve; wszystkie jumps/anchor values muszą wynosić zero |
| `ChargeCurrentResponseRequest.columns` | lista `ChargeVoltageControlColumn`, wymagana | $1$ | 1–64 energetycznie niezależne controls; zero RHS nie pomija kontroli rzędu |
| `ChargeVoltageControlColumn.id` | `string`, wymagany | $1$ | niepusty, unikalny identyfikator wewnętrznego control |
| `trace_jump_coefficients` | `vector<double>`, wymagany rozmiar, dopuszczalny pusty przy braku trace | $1$ | finite coefficient na każdą relację trace bazowego request, w tej samej kolejności; mnożnik napięcia sterującego |
| `anchor_potential_coefficients` | `vector<double>`, wymagany rozmiar, dopuszczalny pusty przy braku anchorów | $1$ | finite coefficient na każdy anchor; także zero zachowuje anchor w przestrzeni essential |
| `requested_conjugate_current_a` | `double`, `0.0` | $\mathrm A$ | finite signed prąd sprzężony z tym control, nie deklaracja wszystkich physical terminal currents |

Powyższe typy są szczegółem realizacji FEM CPU. Docelowy adapter musi
pochodzić z jawnych resolved terminal/closure semantics; nie eksportować
tych macierzy jako alternatywnego publicznego authoringu.

Wewnętrzna polityka zasobów `validate_charge_control_rank` (FEM CPU,
source-only; nie parametr Python/IR) odmawia po przekroczeniu dowolnego
limitu: 64 controls, 65 536 łącznych relacji trace i anchorów, 131 073
węzłów jednego grafu, 262 144 komórek całkowitoliczbowych, 4096 bitów
jednej liczby pośredniej, 100 mln jednostek pracy ważonych długością
limbów oraz 128 MiB konserwatywnego budżetu pamięci. Wszystkie liczności
i długości bitowe są bezwymiarowe. Budżet obejmuje mapy, offsety,
echelon, wzrost pojemności limbów i temporaries. Grafy pełnych DOF i
pierwotnych objętości przetwarzane są kolejno, nie jednocześnie.
Przy wielu controls bramka pamięci ogranicza dopuszczalną liczbę węzłów
wcześniej niż sam limit węzłów. Odmowa zasobowa nie oznacza braku rzędu;
zwiększanie tych limitów wymaga kwalifikacji pamięci i czasu.

Rekonstrukcja RT0 nie może zmieniać prądów portowych. Używa prądu
$\mathbf J_{\mathrm{raw}}=-\sigma\nabla V$ z tego samego zaakceptowanego
snapshotu oraz momentów normalnych z orientacją outward. Momenty normalne
i ciągłość składowej normalnej są własnością
[elementu Raviarta–Thomasa](https://defelement.org/elements/raviart-thomas.html);
nie należy utożsamiać canonical stable-ID orientation z outward.

```{math}
:label: antenna-port-constrained-rt0
\mathbf J(\mathbf q)=\sum_a q_a\boldsymbol\psi_a,\qquad
\mathcal E(\mathbf q)=\frac12\int_{\Omega_c}\sigma^{-1}
|\mathbf J(\mathbf q)-\mathbf J_{\mathrm{raw}}|^2\,d\Omega,
\qquad D\mathbf q=\mathbf h,
```

```{math}
:label: antenna-port-constrained-rt0-kkt
M_{ab}=\int_{\Omega_c}\sigma^{-1}\boldsymbol\psi_a\cdot
\boldsymbol\psi_b\,d\Omega,\qquad
f_a=\int_{\Omega_c}\sigma^{-1}\boldsymbol\psi_a\cdot
\mathbf J_{\mathrm{raw}}\,d\Omega,\qquad
\begin{bmatrix}M&D^T\\D&0\end{bmatrix}
\begin{bmatrix}\mathbf q\\\boldsymbol\lambda\end{bmatrix}
=\begin{bmatrix}\mathbf f\\\mathbf h\end{bmatrix}.
```

Wiersze $D$ obejmują całki dywergencji każdego elementu, bilans każdej pary
cut/interface i sumę outward na każdym terminalu. Wiersze terminalowe mają
prawe strony z reakcji zaakceptowanego H1, a nie z ponownie zadanych napięć
closure. Izolacja ustala momenty normalne na zero przed redukcją. Dla
conforming RT0 ciągłość wnętrza jest już zakodowana przez współdzielony DOF;
nie dodaje się jej ponownie jako identycznego ograniczenia.

```{math}
:label: antenna-rt0-dependent-row-compatibility
\mathbf z^TD=0\quad\Longrightarrow\quad\mathbf z^T\mathbf h=0.
```

Certyfikat rzędu musi objąć rozszerzony $D$, nie tylko dotychczasowe wiersze
div/pair. Każdy pominięty wiersz zachowuje stabilny identyfikator i zależność
w proweniencji; po solve sprawdza się również wszystkie pominięte warunki.
Prądy requested, zmierzone H1 oraz niezależnie zsumowane RT0 porównuje się
osobno dla każdego terminala przy tolerancji
`antenna-terminal-current-certificate`. Przekroczenie którejkolwiek bramki
zatrzymuje publikację V/J/H, zamiast poprawiać sam dzielnik H.

Właściciel nowego native workflow to
`backends/fem/cpu/mfem/workflows/antenna_field_solve`. Źródła zawierają już
etap napięciowy `solve_charge_trace_workspace`; nie jest to jeszcze cały
zaakceptowany port-current workflow.
Istniejące `PeriodicChargePotentialSolver::Solve` i
`solve_weighted_rt0_projection` są punktami ponownego użycia, lecz nie
realizują jeszcze całego powyższego kontraktu. Kolejność wdrożenia:
relacje trace i gauge → odpowiedź podpisanych prądów → RT0 z ograniczeniami
portowymi → wspólny immutable snapshot → ABI i producent artefaktu.
Regresje obejmują dwa rozłączne komponenty, CPW $(1,-0.5,-0.5)$,
asymetryczne returny, prądy $1\,\mathrm A$ i $10^{-4}\,\mathrm A$,
odwrócenie znaku, niezgodny cykl skoków, zależne actuatory oraz niezmienność
wyniku przy zmianie niewykorzystywanego legacy seed napięcia closure.
Każdy przypadek wymaga osobno H1 i RT0 current certificate; zielony parser
dokumentu ani pełny build nie są dowodem tej zgodności.

(antenna-rt0-native-normalization-audit)=
#### Audyt normalizacji natywnej bazy RT0 — 2026-10-05

**Stan: dowód źródłowy i kod korekty współrzędnych; native/runtime niezweryfikowane.**
W MFEM v4.7 `RT_FECollection(0,3)` wybiera generic
`RT_TetrahedronElement(0)`, a nie fixed `RT0TetFiniteElement`.
Generic element jest dualny do nodalnych normalnych dwukrotnie większych
od wektorów pól referencyjnych trójkątów. Transformacja Pioli zachowuje
całkę normalną; sama nie zmienia jej normalizacji. Dla prostego affine
tetraedru lokalna baza ma zatem następujący moment:

```{math}
:label: antenna-rt0-native-basis-moment
\boldsymbol\phi_j(\mathbf x)=
\frac{\beta_{\mathrm{RT}}(\mathbf x-\mathbf v_j)}{3\lvert\mathcal T\rvert},\qquad
\int_{f_i}\boldsymbol\phi_j\cdot\mathbf n\,dS
=\beta_{\mathrm{RT}}\delta_{ij},\qquad
\beta_{\mathrm{RT}}=\begin{cases}
\frac12 & \text{generic},\\
1 & \text{fixed}.
\end{cases}
```

Wzór jest lokalny, z orientacją outward; znak globalnego DOF i orientacja
canonical stable-ID pozostają osobnymi mapami. Nie wolno używać informacji
o fixed elemencie do interpretacji generic elementu wybranego przez collection.
Wynika to z primary źródeł MFEM:
[`RT_FECollection::RT_FECollection`](https://docs.mfem.org/4.7/fe__coll_8cpp_source.html),
[`RT_TetrahedronElement::nk`, konstruktora i `CalcVShape`](https://docs.mfem.org/4.7/fe__rt_8cpp_source.html)
oraz [`VectorFiniteElement::CalcVShape_RT`](https://docs.mfem.org/4.7/fe__base_8cpp_source.html).

Przed korektą `conservative_current_view.cpp::solve_weighted_rt0_projection`
składał mass/load z surowej MFEM `CalcVShape`, używał samych znaków DOF
w ograniczeniach i wpisywał rozwiązanie wprost do `GridFunction`.
Przy powyższej generic normalizacji niezerowy terminalowy RHS H1 narzucał
więc połowę żądanego fizycznego prądu. Jednorodne divergence/interface rows
nadal opisują prawidłowe zera: wspólny czynnik nie zmienia ich nullspace.
Nie jest to dowód przyczyny wcześniejszej odmowy **interior continuity**;
ta wymaga osobnego pomiaru. Niezależny physical certificate nie może
zostać zastąpiony terminalowym RHS ani kopią współdzielonego DOF.

Źródłowa korekta zachowuje istniejące fizyczne współrzędne
$\mathbf q$ i integer incidence $D$, lecz jawnie oddziela je od surowych
współczynników $\mathbf c$. Dodatnia skala wynika z referencyjnej
normalizacji rzeczywiście wybranego elementu; pomiar owned basis pozostaje
niezależnym sprawdzeniem tej skali, nie osobnym zaokrąglonym skalowaniem
każdej strony ściany.

```{math}
:label: antenna-rt0-native-flux-coordinate-change
\mathsf S_{\mathrm{RT}}=\operatorname{diag}(\mu_a),\qquad
\mu_a=\frac12,\qquad
\mathbf q=\mathsf S_{\mathrm{RT}}\mathbf c,\qquad
\boldsymbol\psi_a=\frac{\boldsymbol\phi_a}{\mu_a},\qquad
M=\mathsf S_{\mathrm{RT}}^{-1}M^{\mathrm{MFEM}}\mathsf S_{\mathrm{RT}}^{-1},\qquad
\mathbf f=\mathsf S_{\mathrm{RT}}^{-1}\mathbf f^{\mathrm{MFEM}},\qquad
\mathbf c=\mathsf S_{\mathrm{RT}}^{-1}\mathbf q.
```

Symbole i jednostki zdefiniowano we wspólnej tabeli SI powyżej.

Wszystkie składniki KKT, residuale i correction energy muszą operować
w tych samych współrzędnych; eksport zachowuje surowe owned coefficients
i rzeczywiste signed physical weights. Samo podwojenie końcowego pola
nie jest poprawką constrained objective. Alternatywa: zachować surowe
współczynniki i umieścić fizyczne wagi w każdym row ograniczeń, z jawnym
odwzorowaniem rank ledger. Wariant z fizycznymi współrzędnymi wymaga mniej
zmian semantyki istniejącego $D$ i jego exact rank owner.

Aktualny kod stosuje `inverse_rt0_face_moment=2.0` przy tworzeniu obu
lokalnych test/trial vectors, przed wspólnym assembly mass/load dla dense
i sparse KKT. Sprawdza generic typ `RT_TetrahedronElement`, order 1 i cztery
DOF. Współczynniki `GridFunction` konwertuje dopiero po niezmienionych
residual/energy gates; rank, terminal RHS i physical certificate nie są
przeskalowywane. Regresja
`scripts/test_antenna_rt0_normalization_source.py::test_mass_and_load_use_unit_flux_coordinates_before_both_kkt_lanes`
była RED; wraz z kontrolą zapisu przechodzi po korekcie. Pięć dodatkowych
exact-rational testów niezależnego dwuwspółczynnikowego modelu sprawdza
signed/zero/small prąd, objective i odmowę samego podwojenia końcowego
pola. Razem z niezmienioną diagnostyką: 9 interpretowanych testów PASS.
To **nie wykonanie MFEM ani sparse solvera**. Źródła korekty powstały po
capture buildu diagnostyki `a88fb51824264026a7fca17d89f1e30f`; ten pakiet
nie zawiera nowego skalowania. Potrzebny jest osobny immutable build
oraz rzeczywisty odbiór terminalów i pola przed kwalifikacją.

Zakres: obecny serial affine tet4 FEM CPU/double. Publiczny Python,
`ProblemIR`, planner i quantity units nie zmieniają się; pozostałe trzy
realizacje nadal nie mają dowodu solve-to-drive parity. Metadane prefiksu
`/opt/fullmag-deps` odczytane w dokładnym workerze aktywnego buildu wskazują
`PACKAGE_VERSION=4.7.0`, `MFEM_VERSION=40700`. To dowód konfiguracji prefiksu,
nie dynamiczny test normalizacji załadowanej biblioteki. Receipt buildu nie
zawiera pełnej dependency identity. Wymagany pozostaje rzeczywisty test RAM
oraz późniejsze bramki terminalów, wszystkich momentów, V/H, skali i odwrócenia
prądu. Nie dodano fallbacku, zerowania małych momentów ani zmiany tolerancji.

**Wynik piątego rzeczywistego testu RAM (20:29 UTC):** pełny build
`a88fb51824264026a7fca17d89f1e30f` zakończył się `succeeded`, exit 0;
walidatory receipt, artefaktów, kapsuły i izolacji przeszły przed startem
oraz podczas odbioru. Run `fdf15e1ac6a347009b9e25a50d151c8d` zakończył się
exit 1, bez OOM. Ściana o stable IDs `[9,10,15]` miała outward momenty
według kolejności leksykograficznej elementów:
$1.1102230246251565\cdot10^{-16}\,\mathrm A$ oraz
$-1.2490009027033011\cdot10^{-16}\,\mathrm A$.
Signed jump w kolejności MFEM Elem1 minus Elem2 wyniósł
$-1.3877787807814457\cdot10^{-17}\,\mathrm A$.
Ze **zmierzonych momentów i niezmienionego predykatu** odtworzono skalę
$2.3592239273284576\cdot10^{-16}\,\mathrm A$ i próg około
$1.0000000235922393\cdot10^{-18}\,\mathrm A$; nie odczytano tych dwóch
wartości z logu, ponieważ fixed ABI `error_message[256]` obciął końcówkę.
To dowód odmowy przy prawie zerowym strumieniu, nie dowód, że rzeczywisty
owned współczynnik ściany jest zerowy ani że zmiana normalizacji naprawi jump.
Pakiet tego runu nie zawiera opisanej wyżej korekty współrzędnych.

Przy przygotowaniu naprawy należy rozdzielić matematyczną reprezentację
RT0 od punktowego zaokrąglonego evaluatora. Obecne
`conservative_current_view.cpp::evaluate_field_at` oraz
`direct_tetra_quadrature.cpp::evaluate_current` korzystają z
`GridFunction::GetVectorValue`. Generic `CalcVShape` wykonuje wcześniej
floating-point `Ti.Factor(T)` i `Ti.Mult(...)`; samo przeniesienie iloczynu
z normalną przed sumowanie współczynników nie gwarantuje progu na dowolnej
geometrii. Geometryczna rekonstrukcja powyższej bazy wymaga wszystkich
czterech rzeczywistych signed local coefficients, jawnego affine/basis
contract i niezależnej orientacji każdej strony, nie kopii face DOF.
Nie wolno podmienić tylko certyfikatu na idealną rekonstrukcję, pozostawiając
inne próbkowanie prądu do H, bez jawnego discrepancy/error budget.
Następny implementowany wariant musi współdzielić stabilną reprezentację
między pomiarem i konsumentami albo osobno ograniczyć ich rozbieżność.
`long double` sam nie dowodzi wymaganej dokładności dla arbitrary skew/scale;
niepewny wynik ma zostać odrzucony, a nie wyzerowany przez epsilon.
Niezależny review tego wymagania był read-only; poprawki pomiaru jeszcze
nie wdrożono. Zaakceptowane native V/RT0/H nadal **NOT VERIFIED**.

(antenna-rt0-stable-shared-reconstruction)=
#### Wspólna stabilna rekonstrukcja affine RT0 — kontrakt naprawy

Stan na 2026-10-05, 21:47 UTC: 25 interpretowanych regresji PASS oraz pełny
managed build `76c2851f50454866aba697c672b30b56` succeeded/0. Przypięty
RAM `444b0769d1524dc6b6d4899d8ef2a941` wykonał native solve bez LLG/Relax:
108 geometrycznych momentów RT0 PASS (maksymalny błąd
`2.220446049250313e-16 A`), 36 sum elementowych zero. Dokładność H względem
niezależnego oracle FAIL w 3/4 punktów; pełne V/RT0/H **NOT VERIFIED**.
Ten jeden fixture nie kwalifikuje arbitrary skew/scale ani rzeczywistych
signed map MFEM dla odwróconych elementów.
Nie wprowadzamy fixed collection ani nowej publicznej reprezentacji pola.
Zachowujemy generic `RT_3D_P0` i owned raw coefficients. Właściciel FEM CPU
`transport/affine_rt0_element` realizuje jawnie matematyczną bazę z równania
`antenna-rt0-native-basis-moment` dla generic normalizacji. Lokalny row $j$
odpowiada przeciwległemu vertex $j$ w kolejności MFEM elementu, nie stable IDs.
Wspólny helper dostarcza basis rows do weighted mass/load, pełne J do
kwadratury Oersteda i wszystkie cztery momenty bazy do certyfikatu.
Nie pozostawiamy rounded `CalcVShape` jako innej bazy objective.

Całkę affine bazy obliczamy przez dokładną vertex quadrature, a następnie
łączymy wszystkie cztery rzeczywiste lokalne współczynniki:

```{math}
:label: antenna-rt0-stable-geometric-moments
\mathbf A_f=\tfrac12(\mathbf p_{f,2}-\mathbf p_{f,1})
\times(\mathbf p_{f,3}-\mathbf p_{f,1}),\qquad
w_{f,j}^{\mathrm{RT}}=
\frac{\beta_{\mathrm{RT}}}{9\lvert\mathcal T\rvert}
\sum_{r=1}^{3}(\mathbf p_{f,r}-\mathbf v_j)\cdot\mathbf A_f,\qquad
\Phi_f^{\mathrm{RT}}=\sum_{j=0}^{3}c_j^{\mathrm{loc}}w_{f,j}^{\mathrm{RT}},\qquad
c_j^{\mathrm{loc}}=s_j c_j.
```

Canonical face vertices są uporządkowane stable IDs. Geometria, różnice,
cross/dot, objętość i cztery terms cold face certificate używają dokładnych
rational wartości zapisanych binary64 wejść; konwersja końcowego momentu
do double następuje dopiero po sumie. Zera geometryczne nie pochodzą z
epsilon ani z odczytu shared face DOF. Niezerowy moment podlegający underflow
ma zostać jawnie odrzucony. Fundamental binary64 i stała liczba wejść/operacji
ograniczają rozmiar lokalnej arytmetyki; nie ma rekursywnego exact solve.
Boost dokumentuje exact double→`cpp_rational` i nearest rational→binary
conversion w [primary opisie konwersji](https://www.boost.org/doc/libs/1_74_0/libs/multiprecision/doc/html/boost_multiprecision/tut/conversions.html).

Point J i basis w assembly używają tej samej jawnej rekonstrukcji w
`long double`, z końcową konwersją double i kontrolą finite oraz odmową
niezerowego wyniku traconego przy konwersji do zera. Geometria oraz
signed coefficients dla H są zamrożone raz na element przed kwadraturą;
`ProjectField` współdzieli jeden snapshot także między trzema składowymi
projekcji H1. Basis-only snapshot nie może oceniać J/momentu bez field
coefficients, a pusty `FESpace` odmawia przed dereferencją.
point evaluator nie alokuje, nie pobiera DOF i nie wykonuje exact arithmetic.
Jego błąd zaokrąglenia nadal należy do naukowego error budget, podobnie jak
assembly i kwadratura H. Nie deklarujemy uniwersalnego bound dla arbitrary
skew/scale ani literalnej identyczności rounded `GetVectorValue` z exact
certificate. Usprawnienie evaluatora nie zamyka globalnej kwalifikacji.

Preflight: scalar-DOF generic RT0, właściwy typ/order/range/map, serial,
conforming, straight tet4, finite geometry i współczynniki, poprawna local
face/DOF mapa, brak nieobsługiwanego `DofTransformation`, niezerowy
reprezentowalny determinant. Reference basis sprawdzana niezależnie dla
czterech rows; znaki globalnych DOF zastosowane dokładnie raz. Błędna mapa,
geometry order, typ FE lub niereprezentowalna arytmetyka mają odmawiać;
nie dodajemy automatycznego `sign(det)` ani naprawy orientacji po pomiarze.
Interpretowany model obejmuje oba znaki determinant i wszystkie permutacje
wierzchołków, ale rzeczywiste signed map MFEM dla odwróconych elementów
pozostają osobną niezamkniętą bramką; nie jest to dowód ich kwalifikacji.

Publiczny Python, `ProblemIR`, planner, jednostki i cztery backend statusy
pozostają niezmienione. To realizacja istniejącego operatora FEM CPU,
nie migracja fixed/generic, nowy solver w runnerze ani GPU qualification.
Weryfikacja wymaga wszystkich basis moments, signed/tiny/zero currents,
skew/scale/translation/permutation, odmów map i typed preflight, wspólnego
assembly/J/H oraz nowego source-pinned managed buildu i rzeczywistego RAM
V/RT0/H. Interpretowany model i review źródłowe nie zastępują ostatniej bramki.

(antenna-rt0-terminal-projection-prerequisite)=
#### Prywatny operator RT0 z sumami terminalowymi

Pierwszy krok rekonstrukcji jest osobnym operatorem numerycznym FEM CPU,
nie nowym `ConservativeCurrentView::Build` ani certyfikatem accepted V/J/H.
Przyjmuje straight serial tet4, rzeczywiste stable IDs, raw current oraz
dodatnią scalar conductivity. Jawne grupy exterior boundary faces
tworzą wiersze sum outward z RHS `measured_outward_current_a` pochodzącym
z reakcji H1. Opcjonalne jawne zero-jump interface pairs opisano poniżej;
pozostałe boundary faces są izolujące. Właściciel workflow
musi osobno dowieść wspólnej tożsamości V/mesh/material, przed użyciem
wyniku do H lub artefaktu. Dowolny raw coefficient nie jest accepted charge.

Każda grupa ma unikalny ID i rozłączne, niepuste canonical face keys;
face nie może obejmować więcej niż jednej elektrody. Pełny układ
divergence i terminal rows przechodzi istniejący exact rank/compatible
RHS gate. Legacy callers podają pustą listę nowych rows, zachowując
dotychczasowe znaczenie, rząd i proweniencję. Wiersz pominięty jako
zależny nadal podlega niezależnej kontroli fizycznej po solve.

Wszystkie akumulowane residuale, lokalne skale i progi muszą być
skończone przed porównaniem. Skończone pojedyncze strumienie nie
wykluczają overflow ich sum; porównanie `inf <= inf` nie jest certyfikatem.
Po rekonstrukcji outward sumę każdej grupy mierzy się z rzeczywistego
RT0 pola i geometrycznej normalnej. Dla affine RT0 normalna składowa
jest stała na trójkącie, więc wartość w centroidzie razy oriented area
jest dokładną całką normalnego strumienia, nie centroid approximation
całki Biota–Savarta. Pomiar nie korzysta z RHS ani multiplierów KKT.
Próg każdego terminala to $10^{-18}\,\mathrm A +
10^{-8}|F_t^{H1}|$; osobno sprawdzane są dywergencja elementów,
ciągłość wnętrza i izolacja. To pomiar H1→RT0; końcowy workflow nadal
musi sprawdzić requested↔H1 i requested↔RT0 na requested scale.

| Prywatne wejście | Typ/default | Jednostka SI | Walidacja |
|---|---|---|---|
| `mesh` | `mfem::Mesh`, wymagany | współrzędne w $\mathrm m$ | serial, straight conforming tet4, niepusty; owned copy wyniku |
| `stable_vertex_identities` | `StableMeshVertexIdentities`, wymagany | $1$ | wersja v1, ordered nonzero unique IDs zgodne z mesh |
| `raw_current` | `mfem::VectorCoefficient`, wymagany | $\mathrm{A\,m^{-2}}$ | 3 finite components; sam input nie certyfikuje jego pochodzenia |
| `conductivity` | `mfem::Coefficient`, wymagany | $\mathrm{S\,m^{-1}}$ | scalar finite positive podczas kwadratury |
| `terminals` | lista `Rt0TerminalFluxConstraint`, wymagana | $1$ | niepusta, rozłączne canonical exterior face groups, bounded exact rank resources |
| `Rt0TerminalFluxConstraint.id` | `string`, wymagany | $1$ | nonempty unique valid UTF-8, limit istniejącego rank owner |
| `Rt0TerminalFluxConstraint.boundary_face_vertex_ids` | lista trójek `uint64`, wymagana | $1$ | niepuste, strictly increasing nonzero keys, actual exterior faces, global uniqueness |
| `Rt0TerminalFluxConstraint.measured_outward_current_a` | `double`, `0.0` | $\mathrm A$ | finite signed RHS; caller dostarcza measured H1, nie legacy voltage |

Owned wynik utrzymuje mesh/RT0 space/field, stable IDs, pełny rank ledger,
terminal IDs oraz niezależne measured/residual outward currents i pomiary
opcjonalnych interfejsów. Nie
zawiera nowej publicznej konfiguracji Python/IR, nie rozwiązuje ponownie
H1 i nie publikuje accepted-source digestu. Pierwsza regresja musi wykazać
zadany przez H1 prąd odmienny od raw projection, jego reversal,
niezgodny dependent RHS, zero current i izolację. Testy źródeł podlegają
obowiązującemu zakazowi kompilacji; runtime pozostaje oddzielną bramką.

(antenna-owned-terminal-charge-source)=
#### Wspólny właściciel H1, materiału i terminal-constrained RT0

Prywatny workflow `solve_accepted_terminal_charge_source` ma rozwiązywać
otwarty problem przewodnika z elektrodami, nie kompletną domkniętą antenę.
Nie przyjmuje dowolnego raw J ani zmiennego w czasie borrowed coefficient.
Przed H1 kopiuje siatkę i jawny wektor dodatnich scalar wartości
`conductivity_spm_per_element`, stałych wewnątrz każdego elementu.
Element ordering i attributes pozostają niezmienione. Jedna zamrożona
funkcja materiałowa jest używana do assembly H1, obliczenia
$\mathbf J_{\mathrm{raw}}=-\sigma_e\nabla V_h$ i metryki RT0.
Próbkowanie arbitralnego przestrzennego coefficient w centroidzie nie
jest dozwolonym sposobem jego zamrożenia.

Wynik H1 jest importowany do P1 wyłącznie przez rzeczywistą bijekcję
`GetVertexDofs`. Ordered stable IDs, współrzędne i rozmiary owned V
muszą odpowiadać zamrożonej siatce. Dla straight tet4, P1 i elementwise
constant scalar $\sigma_e$ gradient i raw J są stałe na każdym elemencie;
ich ewaluacja w jednym punkcie referencyjnym jest dokładna, nie stanowi
aproksymacji pola Oersteda ani nie rozszerza wsparcia na curved/high-order.
RT0 otrzymuje tylko validated owned face groups i **zmierzone** prądy H1.
Po projekcji każdy terminal musi przejść także bezpośredni requested→RT0
próg $10^{-18}\,\mathrm A+10^{-8}|F_t^{\mathrm{requested}}|$.
Nie zastępuje go suma progów dwóch wcześniejszych certyfikatów.

Transfer własności siatki do RT0 zachowuje dokładnie jedną kopię geometrii.
Tymczasowe P1 użyte do obliczenia raw J musi zostać zniszczone przed
transferem, również gdy RT0 odrzuci układ. Dopiero po udanej projekcji
odtwarza się utrzymywane P1 V na tej samej RT0-owned siatce, bez drugiego
solve H1. Destrukcja V/space/collection poprzedza zniszczenie RT0 i mesh.
Żaden wskaźnik caller mesh/material ani dowolny raw coefficient nie jest
utrzymywany w wyniku. Borrowed wrapper projekcji sprawdza ParMesh przed
kopiowaniem, aby nie zamienić błędnie żądania MPI w serial przez slicing.

Nowa terminal projection sprawdza kształt tetra przez determinant
krawędzi podzielonych przez lokalną skalę ich składowych. Próg `1e-12`
jest bezwymiarowy i nie narzuca minimalnej objętości w metrach sześciennych.
Regularny element o krawędzi nanometra nie jest z tego powodu
zdegenerowany. Legacy `Build` zachowuje własną dotychczasową walidację;
jej historyczny metr-scale floor nie jest dowodem gotowości nanoscale.
Obliczenia rzeczywistych pól/strumieni nadal używają SI, a underflow,
overflow i niereprezentowalna geometria muszą kończyć się odmową.
Pozostałe historyczne absolute pivot/solver thresholds i globalne
skale residualu w weighted KKT nadal wymagają oddzielnej analizy
conditioning oraz dowodu wykonania w SI. Zmiana shape preflight nie
kwalifikuje sama solvera dla dowolnej skali lub kontrastu przewodności.

| Prywatne wejście | Typ/default | Jednostka SI | Walidacja |
|---|---|---|---|
| `AcceptedTerminalChargeRequest.mesh` | `mfem::Mesh*`, wymagany | współrzędne w $\mathrm m$ | borrowed tylko podczas snapshotu, serial straight conforming tet4 |
| `AcceptedTerminalChargeRequest.stable_vertex_identities` | `StableMeshVertexIdentities`, wymagany | $1$ | ordered nonzero unique v1 IDs, odpowiadają zamrożonej siatce |
| `AcceptedTerminalChargeRequest.conductivity_spm_per_element` | lista `double`, wymagana | $\mathrm{S\,m^{-1}}$ | dokładnie NE, finite positive, kolejność elementów wejściowej siatki, owned copy |
| `AcceptedTerminalChargeRequest.terminals` | lista `ResolvedChargeTerminal`, wymagana | $1$ | rzeczywiste exterior faces, podpisane prądy i complete P1 face closure według tabeli adaptera powyżej |
| `AcceptedTerminalChargeRequest.interface_pairs` | lista `Rt0InterfaceFacePair`, domyślnie pusta | $1$ | wspólny geometryczny preflight przed H1; te same jawne face/vertex maps w H1 i RT0 |
| `AcceptedTerminalChargeRequest.trace_relations` | lista `AffineTraceRelation`, domyślnie pusta | skok w $\mathrm V$ | każda niepusta lista odrzucana, także zero-jump; identyfikacje P1 wyprowadza wyłącznie owner ze zwalidowanych typed interfaces |
| `AcceptedTerminalChargeRequest.absolute_jump_tolerance_v` | `double`, `1e-12` | $\mathrm V$ | finite nonnegative, istniejący gate trace/anchor/reference |
| `AcceptedTerminalChargeRequest.relative_jump_tolerance` | `double`, `1e-12` | $1$ | finite nonnegative |
| `AcceptedTerminalChargeRequest.algebraic_relative_tolerance` | `double`, `1e-12` | $1$ | finite, zakres (0,1) |
| `AcceptedTerminalChargeRequest.maximum_iterations` | `int`, `1000` | $1$ | dodatni |

Owned wynik utrzymuje pełne H1 V/reakcje/component/gauge, frozen element
conductivity i RT0 z pełnym rank ledger oraz niezależnymi prądami.
Regresje wymagają layered conductivity, signed/reversal/zero currents,
tej samej mesh pointer identity dla P1 i RT0, zachowania danych po
mutacji/destrukcji wejść, odmowy trace i malformed materiału oraz
bezpiecznej ścieżki odmowy RT0. Nie ma wpływu na publiczny Python ani
ProblemIR. Pełne cut/lead closure, digest/ABI, Oersted producer i runtime
qualification nadal pozostają oddzielnymi wymaganiami T05/T06.
Called-main źródłowe fixtures obejmują dwa szeregowo połączone obszary
o przewodnościach 4/8 S/m: dla 1 A, długości 1 m i przekroju 1 m²
potencjał prawej elektrody względem lewej wynosi $-3/16\,\mathrm V$,
a prąd $J_x=1\,\mathrm{A\,m^{-2}}$. Osobny regularny fixture 1 nm,
przewodność $10^7\,\mathrm{S\,m^{-1}}$ i prąd $10^{-9}\,\mathrm A$
wymaga $J_x=10^9\,\mathrm{A\,m^{-2}}$, gradientu $-100\,\mathrm{V\,m^{-1}}$
i prawego potencjału $-10^{-7}\,\mathrm V$. Collapsed element o tej samej
skali ma zostać odrzucony przed H1. Fixture nie modeluje rzeczywistej
metalowej anteny o przekroju 1 nm² ani transportu balistycznego;
sprawdza tylko spójność jednostek i skali w przyjętym modelu kontinuum.
Testy nie zostały skompilowane ani wykonane.

(antenna-terminal-rt0-explicit-interfaces)=
#### Jawne pary interfejsów w terminal RT0

Prywatna projekcja terminalowa może przyjąć dodatkowe
`Rt0InterfaceFacePair`. Jest to numeryczne ograniczenie zero-jump
metal–metal, nie source cut z niezerowym skokiem napięcia i nie
samodzielne domknięcie obwodu. Para obejmuje dwa rzeczywiste exterior
trójkąty i jawne trzy pary stable vertex IDs. Bijection musi pokrywać
dokładnie oba face keys; współrzędne odpowiadających węzłów muszą być
identyczne w zamrożonych danych binary64. To celowo ścisły pierwszy
kontrakt, bez automatycznego wyszukiwania styku lub tolerancyjnego weld.
Przeciwne geometryczne outward normals wykluczają sklejenie dwóch
nakładających się objętości po tej samej stronie. Terminal face nie
może być jednocześnie interfejsem; każda ściana ma najwyżej jedną parę.

Wiersz interfejsu dodaje do pełnego układu sumę dwóch outward fluxes
równą zero. Istniejące rank i KKT operators otrzymują jednocześnie
divergence, explicit pairs oraz terminal rows ze zmierzonym H1 RHS.
Pair faces nie są izolujące. Każdy interfejs jest ponownie mierzony
z RT0 po solve, niezależnie od tego, czy jego row zachowano w KKT.
Próg mismatch wynosi $10^{-18}\,\mathrm A+10^{-10}$ razy suma modułów
obu zmierzonych strumieni; residual, skala i próg muszą być finite.
Pusta lista zachowuje dotychczasowe no-interface zachowanie.

| Prywatne wejście | Typ/default | Jednostka SI | Walidacja |
|---|---|---|---|
| `interfaces` | lista `Rt0InterfaceFacePair`, domyślnie pusta | $1$ | jawna topologia, najwyżej NBE/2 par, brak overlap z terminalami |
| `Rt0InterfaceFacePair.id` | `string`, wymagany | $1$ | unique nonempty bounded UTF-8 bez NUL |
| `Rt0InterfaceFacePair.first_face_vertex_ids` | trójka `uint64`, wymagana | $1$ | strictly increasing nonzero actual exterior face key |
| `Rt0InterfaceFacePair.second_face_vertex_ids` | trójka `uint64`, wymagana | $1$ | strictly increasing nonzero actual exterior face key, odrębny od pierwszego |
| `Rt0InterfaceFacePair.vertex_pairs` | tablica trzech par `uint64`, wymagana | $1$ | pierwsza/ druga strona tworzą bijekcje dokładnie z odpowiednim face key; exact coincident xyz |

Wynik zachowuje independently measured outward flux obu stron i
mismatch każdego interfejsu. Sam operator nadal nie certyfikuje
pochodzenia arbitrary raw J ani H1 continuity. Prywatny
`AcceptedTerminalChargeSource` zamraża typed interfaces z całą siatką
i materiałem. Wspólny preflight H1/RT0 sprawdza pełne face/vertex maps,
geometrię oraz brak overlap z terminalami przed assembly H1. Owner
wyprowadza P1 zero-jumps przez stable ID → rzeczywisty vertex →
`GetVertexDofs`; usuwa wyłącznie powtórzenia tych samych authored par
węzłów na sąsiednich trójkątach. Nie wyszukuje styku po współrzędnych.
H1 rozwiązuje całą połączoną domenę, a RT0 dostaje dokładnie te same
zamrożone pary. Dowolne caller DOF traces pozostają zabronione. Dodanie
leadów po solve zmienia fizykę i jest zabronione. Nadal nie jest to
versioned closure certificate, source cut ani publiczny producent/ABI.
Wymagane regresje źródłowe obejmują dwa stykające się bloki z odrębnymi
stable IDs, pełny div/pair/terminal rank, signed interface measurements,
reversal oraz malformed vertex pairing, repeated faces, terminal overlap
i nieprzeciwne normals. Nie ma promocji publicznego API ani kwalifikacji.

Owned source fixture rozwiązuje dwa odrębnie siatkowane bloki o długości
1 m i przekroju 1 m², z przewodnościami 4/8 S/m oraz dwiema jawnymi
parami trójkątów. Dla signed I rezystancja wynosi 3/8 Ω, potencjał
interfejsu względem lewej elektrody $-I/4$ V, a prawej $-3I/8$ V
(I w amperach). W każdym bloku $J_x=I\,\mathrm{A\,m^{-2}}$,
a obie strony każdego interface triangle mają outward currents
$\pm I/2$. Regresja obejmuje I=1/−1/0 A, frozen maps/material/mesh
po mutacji i destrukcji wejść oraz konkretne geometric/topological
odmowy przed H1. Test jest źródłowy, niekompilowany i niewykonany.

(antenna-owned-terminal-content-digest)=
#### Identyfikator zawartości wspólnego wyniku charge

Private `AcceptedTerminalChargeSource` potrzebuje własnego content digest,
nie caller `source_field_digest` ani digestu nieistniejącego domknięcia.
Schema `accepted_terminal_charge_source.ordered.v1` wiąże rzeczywisty
owned payload z operator version `fem_accepted_terminal_charge_source.v1`.
To ordered snapshot: kolejność vertex/element/boundary/face/RT0 DOF,
terminali i par jest częścią tożsamości. Zmiana kolejności może zmienić
digest mimo równoważnej fizyki; nie jest to permutation-invariant mesh
hash ani dowód bitowej zgodności solve na różnych platformach.

Używany jest istniejący native `CanonicalDigestBuilder`: każdy field ma
big-endian u64 długość nazwy UTF-8, nazwę, jednobajtowy type tag,
big-endian u64 długość wartości i wartość. Type tags: string=1, u64=2,
binary64=4; liczby są big-endian, oba signed zeros reprezentuje +0.
Wszystkie double muszą być finite przed kodowaniem; normalizacja NaN
w ogólnym builderze nie jest dopuszczalnym obejściem tego kontraktu.
SHA-256 wiąże cały typed stream. Istniejąca utility namespace nie
przenosi fizyki frequency-domain do transportu.

| Grupa pól, kolejność strumienia | Dane i jednostki SI |
|---|---|
| `schema`, `operator`, solver policy | wymagane wersje; absolute jump tolerance [V], relative jump i algebraic tolerance [1], maximum iterations [1] |
| `vertices` | count, stable-ID version i dla każdego vertex: actual stable ID [1], xyz [m], accepted V [V], original K*V reaction [A], electrical component ID [1] |
| `elements` | count; dla każdego actual element: attribute [1], cztery actual stable IDs w lokalnym vertex ordering [1], frozen σ [S/m] |
| `boundary` | count; dla każdego boundary triangle: attribute [1], trzy stable IDs w actual ordering [1] |
| `faces` | count; actual face vertex ordering, adjacent element indices i signed RT0 face DOF; wszystkie [1], signed integer zapisany jako two's-complement u64 |
| `rt0` | actual FE size i ordered signed coefficients [A]; basis/sign map wynika z poprzedniej grupy, nie z nodal xyz |
| `terminals` | count; dla każdego terminal: ID, canonical face groups [1], requested/H1/RT0 currents i residuals [A], voltage [V], component ID [1] |
| `references`, `components`, `gauges` | reference terminal IDs/component IDs, component IDs/relative residuals oraz gauge stable vertex IDs; wszystkie poza tekstem [1] |
| `interfaces` | count; owned IDs, oba face keys i trzy authored vertex pairs [1], oba outward currents i mismatch [A] |
| `rank` | rows-before/rank/omitted count [1]; każdy omitted row ID, reason, residual [A] i component anchor element key [1] |

Counts rozdzielają listy, a repeated field names zachowują powyższą
kolejność. Bound preimage wynosi 128 MiB; długość jest sprawdzana przed
każdym dopisaniem field (włącznie z framing), bez overflow i bez
publikacji częściowego digestu. Przekroczenie limitu jest resource
refusal, nie rozluźnieniem gate ani potwierdzeniem zaakceptowanego
źródła. Limit dotyczy preimage, nie peak RAM: istniejąca implementacja
SHA kopiuje bufor. Schema nie serializuje osobno wszystkich auxiliary
response diagnostics, lecz opisany wspólny payload fizyczny i policy.
Digest powstaje dopiero po wszystkich H1/RT0/current gates
i odtworzeniu V na tej samej siatce. Retained result go nie przelicza
po zmianie caller danych. Nie zawiera H, waveformu ani czasu LLG.

Regresja wymaga niezależnego od production buildera byte-codec/SHA
oracle, stabilności retained digest oraz zmiany przy σ, currents,
geometry/stable IDs/attributes, terminal IDs, interface IDs i solver
policy. Żadne API/ProblemIR capability nie jest przez ten prywatny
digest promowane. Append-only ABI, consumer i typed closure pozostają
osobnymi bramkami; kod/test źródłowy nie zastępuje numerical qualification.

(antenna-accepted-terminal-charge-record-abi)=
#### Append-only ABI wspólnego rekordu charge

`fullmag_fem_solve_accepted_terminal_charge_v1` przekazuje jeden rekord
`accepted_terminal_charge_source.ordered.v1`, dokładnie ten, którego
SHA-256 utrzymuje owner. Nie publikuje obok innych niesprawdzonych
buforów V/J. Consumer najpierw sprawdza hash i pełną strukturę rekordu,
następnie dekoduje pola z tego samego strumienia. To serial CPU/double,
straight conforming tet4/P1, scalar σ. Nie ma spin solve, waveformu,
source cuts, closure ani H. Istniejące charge V1/V2/V3 i RT0 V1 pozostają
byte-for-byte niezmienione. Nowy layout fingerprint jest
`fullmag:fem-accepted-terminal-charge:abi:v1:canonical-owned-record`.

| Pole żądania | Typ/default | SI | Walidacja |
|---|---|---|---|
| `abi_version` | `uint32`, wymagane 1 | 1 | dokładna wersja |
| `reserved_flags`, `reserved_execution`, `reserved_solver` | `uint32`, 0 | 1 | każde równe zero |
| `struct_size` | `uint64`, wymagane sizeof(request) | byte | dokładny layout |
| `execution_lane` | istniejący enum CPU_DOUBLE | 1 | wyłącznie CPU/double; GPU odrzucane bez fallbacku |
| `mesh` | istniejący `fullmag_fem_mesh_desc` | xyz [m] | pełny typed CSR tet4/tri3, bez periodic metadata/seams; finite nondegenerate geometry i complete actual exterior boundary przed importem MFEM |
| `stable_vertex_identities` | istniejący descriptor v1 | 1 | dokładnie NV, nonzero unique authored IDs; nie ordinals wygenerowane przez adapter |
| `conductivity_spm_per_element`, `conductivity_spm_per_element_len` | `double*`, NE | S/m | dokładnie NE, finite positive |
| `terminals`, `terminal_count` | lista `terminal_v1`, wymagana | 1 | 1..NBE, nonempty disjoint actual exterior face groups |
| `terminal_v1.id` | nonnull bounded UTF-8 | 1 | unique, nonempty, bez NUL, najwyżej 4096 bytes |
| `terminal_v1.boundary_face_vertex_ids`, `face_count` | flattened u64 triples | 1 | 1..NBE, canonical increasing actual keys, complete P1 closure |
| `terminal_v1.requested_outward_current_a` | `double` | A | finite signed; balance per electrical component i existing controls rank |
| `interfaces`, `interface_count` | optional `interface_v1*`, NULL/0 | 1 | count≤NBE/2, pointer/count zgodne; wspólny preflight przed H1 |
| `interface_v1.id` | nonnull bounded UTF-8 | 1 | unique, nonempty, bez NUL, najwyżej 4096 bytes |
| `interface_v1.first_face_vertex_ids`, `second_face_vertex_ids` | u64[3] | 1 | canonical actual exterior keys, bez face reuse/terminal overlap |
| `interface_v1.vertex_pairs` | u64[3][2] | 1 | pełna jawna bijekcja, exact coincident xyz i przeciwne normals |
| `absolute_jump_tolerance_v` | `double`, jawne 1e-12 | V | finite nonnegative |
| `relative_jump_tolerance` | `double`, jawne 1e-12 | 1 | finite nonnegative |
| `algebraic_relative_tolerance` | `double`, jawne 1e-12 | 1 | finite (0,1) |
| `maximum_iterations` | `uint32`, jawne 1000 | 1 | 1..INT_MAX |

| Pole wyniku | Typ/default | SI | Kontrakt |
|---|---|---|---|
| `abi_version`, `struct_size`, `reserved_flags` | wersja 1/sizeof(result)/0 | 1/byte | initialized przez caller, sprawdzane przed solve |
| `canonical_payload`, `canonical_payload_capacity` | caller-owned u8 buffer | byte | nonnull i capacity 1..128 MiB; pełna pojemność sprawdzana przed publikacją |
| `canonical_payload_len` | u64, 0 przed sukcesem | byte | tylko długość dokładnego zaakceptowanego typed stream |
| `digest_schema`, `operator_version`, `layout_fingerprint` | fixed char[96] | 1 | NUL-terminated dokładne wersje |
| `content_sha256` | fixed char[65] | 1 | lower-case 64 hex SHA-256 tych samych published bytes |
| `error_message` | fixed char[256] | 1 | tekst odmowy, nie scientific artifact |

Caller gwarantuje dostępny co najmniej 16-byte prefix każdego request/result
(`abi_version`, `reserved_flags`, `struct_size`). Skrócony wynik jest odrzucany
bez zapisu pozostałych pól lub canary; nie można wyczyścić pól, dla których
caller nie zapewnił pamięci. Dla pełnego result layoutu każda odmowa zeruje
długość i pierwsze znaki acceptance metadata, nie zapisuje payloadu.

Prywatny Rust consumer `solve_accepted_terminal_charge` wykonuje jeden call
z bounded caller buffer, następnie sprawdza dokładne wersje, długości,
SHA-256 i dekoduje tylko opublikowany typed stream. `Reader` wymaga kolejności
name/tag/length, finite canonical binary64 (bez negative zero), bounded
counts/UTF-8 oraz pełnego consumption. Sprawdzane są real vertex IDs,
tetrahedral face incidence, complete boundary, actual adjacency i signed
face→RT0-DOF bijekcja. Terminale, references, component/gauge maps,
interfaces oraz rank ledger muszą być strukturalnie spójne; terminal
currents zachowują bramki signed requested→H1→RT0. H1 residual to
`h1_current-requested`, RT0 residual to `rt0_current-h1_current`;
bezpośredni `rt0_current-requested` także musi przejść physical gate.
Native prefix w constraint ID ma osobny bound 8192 bytes; authored IDs
pozostają bounded 4096 bytes. Rekord jest dodatkowo porównywany z
request: exact IDs/xyz/σ/attributes/controls/policy, sorted element i
boundary keys dopuszczają wyłącznie zmianę orientacji importera.

Input counts i checked sum terminal faces sprawdzane są przed kopiami
Rust. Reference/component/anchor lookup ma indeksy, nie full scan
per row. Buffer przekazany do C ma 128 MiB; limit nie jest ograniczeniem
peak RAM, a retained `Vec` może zachować tę pojemność po skróceniu długości.
To jawny koszt prywatnego precompute adaptera wymagający pomiaru przed
kwalifikacją. Publiczny producer nadal używa wcześniejszych ścieżek;
nowy adapter nie jest jeszcze podłączony do artifact/closure workflow.
Regresje C ABI (58 odmów, cztery solves), native exact-preimage oracle
i trzy testy Rust codec są zapisane w źródłach, ale niekompilowane i
niewykonane. Hash/structural validation nie zastępuje numerical gates,
geometry qualification, closed-source balance ani H/runtime evidence.

Limit counts przed allocation/import wynika także z existing bounded
rank owner (najwyżej $2^{20}$ elementów oraz proporcjonalne vertex/facet
support). CSR jest pełny: pierwszy offset 0, ostatni dokładnie długość
nodes, każde tet4/tri3 ma właściwy arity. Wszystkie actual exterior
triangles muszą być obecne dokładnie raz; nie wolno importować fake
boundary, interior face jako exterior ani nonmanifold face incidence.
Adapter zachowuje dodatnie, representable `cell_markers`, gdy podano
pełną listę; bez niej stosuje istniejące MFEM adapter attributes
element+1. To metadane dyskretyzacji, nie aktywacja fizyki. Boundary
markers są dodatnie i representable. Elementwise σ nie zależy od tych
attributes. Jawne material-interface facets należą do conforming
domeny; nie zastępują typed pairs dwóch osobnych exterior ścian.

Owner wykonuje jedno H1→RT0 solve i przesuwa swój już zakodowany
preimage do retained result, bez drugiego assembly ani odtworzenia
rekordu z obcych danych. C boundary kopiuje tylko ten rekord. Capacity
failure nie publikuje częściowego wyniku, schema, fingerprint ani hash;
wszystkie lengths/identity pozostają puste. C caller odpowiada za
rzeczywistą dostępność zadeklarowanych buforów. Brak MFEM zwraca
unavailable, nie solve zastępczy. Na etapie source-only nowe ABI nie
kwalifikuje publicznego producenta anteny ani H.

Wymagane source regressions: dokładne layouty C/Rust, record/owner/hash
spójność, signed/reversal/zero currents, wszystkie header/reserved/
pointer/count/capacity refusals, malformed mesh przed MFEM, real stable
IDs i typed interface preflight. Consumer musi odrzucać błędny hash,
schema, type/length/count, nonfinite values, trailing bytes i niespójne
mapowania; nie ufać tylko JSON label. Native numerical/runtime proof
oraz current-driven closure i multi-cut controls nadal wymagane.

### 3.2 Per-ampere normalization

For every independent mode $p$, normalize the solved current density so that

$$
\sum_{q:w_{p,q}>0}
\int_{\Gamma^{\mathrm{out}}_{p,q}}
\mathbf J_{p,1\mathrm A}\cdot\mathbf n\,dS
=1\ \mathrm A.
$$

The normalized electric potential is gauge-fixed by one terminal reference or
a mean-zero constraint on each otherwise free connected component. The
artifact records the selected gauge; voltage values are not comparable across
solutions with different gauges.

### 3.3 Magnetostatic field basis

The Tier 1 magnetic-field realization is the three-dimensional Biot-Savart
integral evaluated from the normalized volume current:

$$
\mathbf H_{p,1\mathrm A}(\mathbf r)
=\frac{1}{4\pi}
\int_{\Omega_c}
\frac{\mathbf J_{p,1\mathrm A}(\mathbf r')
\times(\mathbf r-\mathbf r')}
{\lVert\mathbf r-\mathbf r'\rVert^3}
\,dV'.
$$

For the MVP field medium,

$$
\mathbf B_{p,1\mathrm A}=\mu_0\mathbf H_{p,1\mathrm A}.
$$

This equation computes the imposed free-current field in a nonmagnetic
background. It does not solve magnetic-material backreaction, eddy currents in
the ferromagnet, or frequency-dependent permeability. Those effects require a
later magnetoquasistatic or full-wave realization.

Near-source evaluation requires singular or near-singular quadrature. A simple
centroid sum with equivalent-sphere regularization is retained only as a
reference/debug oracle. Production Tier 1 must use element-aware adaptive
quadrature or an analytically integrated near-field rule and must expose the
near-field error/convergence evidence.

The executable direct-Oersted preflight requires a nonempty source carrier and
target set before using the pair product as a cost bound:

```{math}
:label: antenna-direct-oersted-pair-budget
N_s\geq1,\qquad N_t\geq1,\qquad
P=N_sN_t\leq P_{\max},\qquad P_{\max}=10^6.
```

The versioned default limit is a computational policy, not an accuracy
guarantee. A zero source count cannot make an arbitrarily large target buffer
look free; zero active evaluations are handled separately without entering the
direct kernel. Both planner and runtime check this boundary before native
allocation. A separate memory budget, bounded target blocking and full
cross-retry accounting remain unqualified.
The FEM CPU direct-Oersted planner also reports $96N_t$ bytes for four
concurrent target-sized triplet buffers: flattened coordinates and field output
on the Rust side, and target coordinates and field output in the native call.
This is a checked lower bound for these known buffers, not a peak-memory
estimate or a memory admission limit; mesh, charge solve, quadrature and
allocator overhead are excluded.

### 3.4 Time-domain LLG coupling

The antenna contribution enters the effective field additively:

$$
\mathbf H_{\mathrm{eff}}
=\mathbf H_{\mathrm{ex}}
+\mathbf H_{\mathrm{demag}}
+\mathbf H_{\mathrm{ext}}
+\mathbf H_{\mathrm{ant}}
+\cdots.
$$

For port mode $p$ with scalar waveform $f_p(t)$ and peak/reference current
$I_{p,0}$,

$$
I_p(t)=I_{p,0}f_p(t),
$$

and therefore

$$
\mathbf H_{\mathrm{ant}}(\mathbf r,t)
=\sum_p I_{p,0}f_p(t)\mathbf H_{p,1\mathrm A}(\mathbf r).
$$

The Zeeman energy contribution is

$$
E_{\mathrm{ant}}(t)
=-\mu_0\int_{\Omega_m}
M_s(\mathbf r)\mathbf m(\mathbf r,t)
\cdot\mathbf H_{\mathrm{ant}}(\mathbf r,t)\,dV.
$$

The field basis is independent of magnetization and may be solved before
relaxation. The component that efficiently drives small oscillations around an
equilibrium $\hat{\mathbf m}_0$ is derived after an equilibrium exists:

$$
\mathbf h_\perp(\mathbf r)
=\mathbf H_{\mathrm{ant}}(\mathbf r)
-(\mathbf H_{\mathrm{ant}}(\mathbf r)\cdot
\hat{\mathbf m}_0(\mathbf r))\hat{\mathbf m}_0(\mathbf r).
$$

The LLG solver receives the full vector field, not $\lVert\mathbf H\rVert$ and
not only $\mathbf h_\perp$. The transverse field is a derived analysis and
visualization product.

### 3.5 Supported time dependences

The separable field basis can be multiplied by any canonical, serializable
`TimeDependenceIR` supported by the selected LLG lane:

- constant;
- sinusoidal;
- rectangular pulse;
- piecewise-linear sampled waveform;
- normalized sinc pulse.

Raw Python callbacks are not part of the public model because they cannot
round-trip through `ProblemIR`, UI authoring, or device execution. A future
restricted expression language requires one shared parser and evaluator
contract across Python, Rust, CPU, GPU, and script export.

### 3.6 Separability and validity limits

Tier 1 assumes

$$
\mathbf H(\mathbf r,\omega)
\approx a(\omega)\mathbf H_0(\mathbf r)
$$

over the waveform bandwidth. It is valid only when the normalized spatial
current profile is effectively frequency independent.

The approximation excludes:

1. frequency-dependent skin and proximity effects;
2. capacitive/displacement-current return paths;
3. transmission-line propagation, standing waves, reflections, and radiation;
4. port impedance and S-parameters;
5. frequency-dependent relative phase between field components;
6. absolute conversion from dBm or delivered microwave power to current;
7. induced detector voltage and electrical-to-magnon efficiency;
8. feedback of magnetization dynamics onto the conductor field.

Validity diagnostics resolve the conductor geometry from the immutable
`source_object_id` through the same object/region binding used by the field
solve planner. A display name or geometry name is not a substitute for that
identity; a changed name must not turn a known $\eta_{\mathrm{wave}}$ or
$\eta_{\mathrm{skin}}$ into `unknown`. An explicit object ID takes precedence
over an unrelated geometry with the same display name.

The solve and UI publish two advisory validity ratios at the declared maximum
waveform frequency $f_{\max}$:

$$
\eta_{\mathrm{wave}}=\frac{L_{\max}f_{\max}}{c},
\qquad
\eta_{\mathrm{skin}}=\frac{t_{\max}}{\delta(f_{\max})},
$$

with

$$
\delta(f)=\sqrt{\frac{2}{2\pi f\mu\sigma}}.
$$

If either ratio is at least $0.1$, Fullmag emits
`separable_field_basis_validity_warning`. This threshold is an engineering
warning, not a proof that results below it are exact and not an automatic
rejection above it. A sinc pulse uses its declared cutoff as $f_{\max}$; a
piecewise-linear drive must provide `declared_bandwidth_hz` for this diagnostic
or report `validity_bandwidth_unknown`.

Wykonywalny preflight publikuje obie liczby tylko wtedy, gdy ich obliczenie
pozostaje skończone w `f64`. Przepełnienie arytmetyki lub zanik obliczonej
głębokości naskórkowej do zera daje
`status=unknown reason=validity_numeric_overflow`, wraz z parametrami wejścia,
bez pozornego wyniku `inf` i bez klasyfikacji `status=warning`. Nie oznacza to
fizycznej akceptacji modelu; użytkownik musi zweryfikować zakres parametrów.

The executable classifier is versioned as `antenna_waveform_bandwidth.v1`.
It records the source of a known $f_{\max}$ (`constant`, `sinusoidal`, or
`sinc_cutoff`) in plan provenance. Rectangular and piecewise-linear drives
remain explicitly unknown until a finite bandwidth or rise-time contract is
authored; the implementation never substitutes the inverse pulse duration.

## 4. Geometry contract

### 4.1 Local frame and transform

The MVP antenna layout is planar and straight in its local frame:

- local $u$: direction of current flow and profile stations;
- local $v$: transverse width direction;
- local $w$: conductor-thickness direction.

A rigid scene transform positions and rotates the entire layout in 3D. Curved
centerlines and arbitrary swept paths are deferred. This keeps the first
geometry realization focused while still supporting a constriction anywhere
along a straight microstrip or CPW.

### 4.2 Width stations

The width profile is a piecewise-linear loft between ordered stations. Each
station uses a normalized coordinate $s\in[0,1]$ along local $u$.

Microstrip station:

```text
{ s, signal_width_m }
```

CPW station:

```text
{
  s,
  signal_width_m,
  left_gap_m,
  right_gap_m,
  left_ground_width_m,
  right_ground_width_m
}
```

Rules:

1. station coordinates are finite, strictly increasing, and include $0$ and
   $1$;
2. every width and gap is positive;
3. conductor thickness is positive and constant for the MVP;
4. lofted signal and ground volumes may not self-intersect;
5. terminal end sections must have nonzero face area;
6. a named constriction is authored as at least two stations around a narrower
   section, not as a visual-only annotation;
7. geometry validation reports the minimum width, minimum gap, taper slope,
   and any meshing-size requirement implied by them.

### 4.3 Return paths

A CPW layout includes the signal conductor and both ground conductors. A
microstrip layout includes the signal strip plus an explicit return conductor
or plane geometry. The return path is part of the physical source and the
field-basis hash. Omitting it is a validation error for Tier 1.

The dielectric substrate may be present as scene geometry for placement and
future Tier 3 work, but it does not affect the Tier 1 conduction/Biot-Savart
solution and provenance states this explicitly.

## 5. k-selective excitation products

### 5.1 Source spectrum

For a chosen analysis plane and equilibrium magnetization, the source
wave-vector weighting is computed from the vector transverse field:

$$
\widetilde{\mathbf h}_\perp(\mathbf k)
=\mathcal F_{\mathbf r}
\left[w(\mathbf r)\mathbf h_\perp(\mathbf r)\right],
$$

$$
W_H(\mathbf k)
=\sum_{a\in\{x,y,z\}}
\left|\widetilde h_{\perp,a}(\mathbf k)\right|^2.
$$

The analysis artifact records the coordinate frame, sampled plane or volume,
window, spatial resolution, normalization, and whether components were
combined or inspected separately. Fourier transforming the scalar magnitude
$\lVert\mathbf H\rVert$ before LLG is forbidden because it discards sign,
polarization, and component information.

#### 5.1.1 Normative sampling and Fourier convention

An executable request must declare an orthonormal right-handed frame
$(\mathbf e_u,\mathbf e_v,\mathbf e_n)$, plane origin $\mathbf r_0$, extents
$L_u,L_v$, and sample counts $N_u,N_v\geq2$. The uniform lattice is

$$
\mathbf r_{pq}=\mathbf r_0+
\left(-\frac{L_u}{2}+p\Delta u\right)\mathbf e_u+
\left(-\frac{L_v}{2}+q\Delta v\right)\mathbf e_v,
\qquad
\Delta u=\frac{L_u}{N_u-1},\quad
\Delta v=\frac{L_v}{N_v-1}.
$$

FEM values are evaluated at these physical points by element-local
interpolation on the immutable solution mesh. A nearest-node substitution is
not a production realization. Points outside the declared carrier fail the
request unless the authored outside policy is `zero`; the policy and outside
count are recorded in provenance. FDM values use the same physical lattice
contract and an explicitly selected interpolation policy.

For window samples $w_{pq}$ and vector-component samples $h_{a,pq}$, Fullmag
uses the discrete approximation

$$
\widetilde h_a(k_{u,m},k_{v,n})=
\Delta u\Delta v\sum_{p=0}^{N_u-1}\sum_{q=0}^{N_v-1}
w_{pq}h_{a,pq}
\exp[-i(k_{u,m}u_p+k_{v,n}v_q)],
$$

with angular wave numbers in $\mathrm{rad\,m^{-1}}$,

$$
k_{u,m}=2\pi\,\operatorname{fftfreq}(N_u,\Delta u),\qquad
k_{v,n}=2\pi\,\operatorname{fftfreq}(N_v,\Delta v).
$$

The mandatory normalization enum is `integral_si` for the expression above
or `unitary_discrete` for division of the unscaled DFT by
$\sqrt{N_uN_v}$. The request must also author one of `rectangular`, `hann`,
`hamming`, or `blackman`; there is no implicit window. The artifact stores the
coherent gain $G_c=(N_uN_v)^{-1}\sum_{pq}w_{pq}$ and equivalent noise
bandwidth so amplitudes from different windows are not compared silently.

The v2 manifest read path verifies these two metrics without constructing
sample-length arrays. For each axis, the implemented cosine windows have
coefficients $(a_0,a_1,a_2)=(1,0,0)$ (rectangular),
$(0.5,-0.5,0)$ (Hann), $(0.54,-0.46,0)$ (Hamming), and
$(0.42,-0.5,0.08)$ (Blackman). Their endpoint-inclusive samples obey

```{math}
:label: antenna-window-harmonic-sum
g_i^{(N)}=a_0+a_1\cos\frac{2\pi i}{N-1}+a_2\cos\frac{4\pi i}{N-1},\quad
C_h(N)=\sum_{i=0}^{N-1}\cos\frac{2\pi h i}{N-1}
=\begin{cases}N,&(N-1)\mid h,\\1,&\text{otherwise.}\end{cases}
```

The second identity follows by summing the $N-1$ roots of unity and adding
the repeated endpoint. Expanding the squared cosine window gives

```{math}
:label: antenna-window-analytic-metrics
W_1(N)=a_0N+a_1C_1(N)+a_2C_2(N),\qquad
W_2(N)=\left(a_0^2+\frac{a_1^2+a_2^2}{2}\right)N
+(2a_0a_1+a_1a_2)C_1(N)
+\left(2a_0a_2+\frac{a_1^2}{2}\right)C_2(N)
+a_1a_2C_3(N)+\frac{a_2^2}{2}C_4(N),
\qquad G_c=\frac{W_1(N_u)W_1(N_v)}{N_uN_v},\qquad
B_{\mathrm{ENBW}}=\frac{N_uN_vW_2(N_u)W_2(N_v)}{[W_1(N_u)W_1(N_v)]^2}.
```

The verifier compares these constant-work values to the serialized metrics
within relative $10^{-10}$, accommodating floating-point summation order in
the executed FFT while rejecting materially inconsistent metadata. This
identity depends on the current endpoint-inclusive cosine windows; a new
window family must supply its own verified metric rule.

Transverse analysis requires an equilibrium unit vector
$\widehat{\mathbf m}_0(\mathbf r_{pq})$ and computes

$$
\mathbf h_{\perp,pq}=\mathbf h_{pq}
-(\mathbf h_{pq}\!\cdot\!\widehat{\mathbf m}_{0,pq})
\widehat{\mathbf m}_{0,pq}.
$$

If no equilibrium resource is supplied, only explicit Cartesian or local-frame
components are legal; `transverse` must fail closed.
`equilibrium_ref` is only meaningful for `transverse` and is rejected for every
other component, rather than silently ignored. Even with a reference,
`transverse` remains unsupported until a certified equilibrium is loaded and
projected onto the exact sampling lattice. Python authoring and both ProblemIR
validators reject it even when an equilibrium reference is present. Python also
rejects `mode_basis_ref` until a verified modal analysis exists. The publishable
runner entry point
also rejects manually supplied equilibrium arrays and ignored mode references;
the isolated projection kernel is not a certificate. A structured FFT is legal
only after the interpolation certificate above is published. Direct nonuniform
Fourier evaluation is a separate realization and must declare its exact
$\mathbf k$ grid, quadrature weights, tolerance, and implementation identity.

#### 5.1.2 Current executable sampling lane

Każdy czytnik rozwiązania sprawdza normalizację wszystkich baz, również
niewybranego portu: zmierzony prąd dodatniego terminala musi być skończony
i dodatni, prąd normalizacji wynosi dokładnie $1\,\mathrm A$, a skończona,
dodatnia skala jest równa odwrotności zmierzonego prądu. Ponowne obliczenie
digestu manifestu nie zastępuje tej walidacji. Payloady są już znormalizowane;
czytnik ich ponownie nie skaluje. Implementacja:
`crates/fullmag-runner/src/antenna_field_solution.rs` +
`validate_basis_normalization`; regresja źródłowa:
`readers_reject_rehashed_invalid_normalization_in_an_unselected_port`
(niewykonana przy obowiązującym zakazie kompilacji testów Rust).

The first executable `antenna_source_spectrum.v1` lane consumes the immutable
`antenna_field_solution.v1` sample carrier. A current carrier may publish both
finite nodal coordinates/field values and a hashed `tet4_connectivity` payload.
Nowy manifest rozwiązania zapisuje również `sample_carrier`: domenę fizyczną
(`global`, `object` albo `region`), rodzaj nośnika, lokalizację `node` i
`topology_digest` pochodzący z planu próbkowania. Są to metadane pochodzenia
siatki, a nie dowód zgodności z bieżącą siatką obiektu lub airboxu. Starszy
manifest bez `sample_carrier` pozostaje czytelny, lecz nie może być automatycznie
przypisany do viewportu; przed wizualizacją konieczne jest osobne porównanie
identyfikacji domeny, digestu topologii i transformacji nośnika docelowego.
Zasób API samej bazy nie publikuje certyfikatu docelowej projekcji:
`target_projection_signature` pozostaje `null`, również gdy plan zawiera
tylko jeden target. Obecna mapa `signatures.target_projection_signatures`
w manifeście zawiera podpisy zależności deklarowanych targetów; nie jest
potwierdzeniem wykonania projekcji na ich aktualną topologię. Takie
potwierdzenie wymaga materializacji pola docelowego i podpisu obejmującego
faktyczną metodę, mapowanie, maskę oraz siatkę docelową. Odróżnienie w zasobie
realizuje `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` +
`get_antenna_field_solution`.
Mapowanie implementacji: `crates/fullmag-ir/src/plan.rs` +
`AntennaFieldSamplingPlanIR`, `crates/fullmag-plan/src/antenna_field_solve.rs` +
`resolve_field_sampling`, `crates/fullmag-runner/src/antenna_field_solution.rs` +
`AntennaSampleCarrier` i `validate_sample_carrier` oraz
`crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` +
`AntennaSampleCarrierResource`. Regresje źródłowe obejmują
`rejects_invalid_sample_carrier_before_publication`; kompilacja i wykonanie tych
testów natywnych pozostają niezweryfikowane przy obowiązującym zakazie repo.
When that topology is present, the sampler performs deterministic BVH point
location followed by P1 barycentric interpolation in the containing tetrahedron.
The executed realization is recorded as `fem_p1_interpolation_v1`; shared-face
ownership is deterministic: if the boundary tolerance admits more than one
tetrahedron, the cell with the lowest ordinal in the stored
`tet4_connectivity` payload owns the point. No nearest-node substitution is
allowed.

Older point-only carriers remain readable through the explicit compatibility
realization `identity_coordinates_v1`: every requested lattice point must
coincide with one and only one source sample within the declared floating-point
coordinate tolerance. This path is not FEM interpolation and its provenance
must never be presented as such. For a validated tet4 carrier, the physical
sampling domain is the union of its tetrahedra, not the axis-aligned bounds of
all source nodes. A point in a gap between tetrahedra is outside that domain:
`outside_policy="zero"` assigns zero and records the outside count; the error
policy rejects it. Degenerate tetrahedra are rejected before point location,
so invalid topology cannot be mistaken for an outside point. For a legacy
point-only asset, a missing identity match inside the source-node bounds still
fails closed; only a point outside those bounds can be zeroed. Neither path
turns a missing or corrupt payload into a zero. The P1 sampler also rejects a
non-finite weighted field at an inside or tolerance-admitted boundary point,
even when every nodal value is finite; numerical overflow is an error, not an
outside-zero sample.

Tolerancja ścieżki `identity_coordinates_v1` zależy od rozdzielczości lokalnej
siatki, a nie wyłącznie od odległości geometrii od początku układu. Dla
próbek zapisanych jako `f64` stosuje się

```{math}
:label: antenna-identity-coordinate-tolerance
\tau_{\mathrm{id}}=\max\!\left(10^{-9}h_{\min},
2\epsilon_{\mathrm{mach}}X_{\max}\right),\qquad
h_{\min}=\min(h_u,h_v),\quad h_{\max}=\max(h_u,h_v),\quad
X_{\max}=\max\!\left(h_{\max},\max_j\left[|r_{0,j}|+
\tfrac12(L_u|u_j|+L_v|v_j|)\right]\right).
```

Warunek $2\tau_{\mathrm{id}}<h_{\min}$ jest obowiązkowy; gdy rozdzielczość
zmiennoprzecinkowa nie pozwala odróżnić sąsiednich punktów, żądanie kończy
się błędem. Ta tolerancja służy wyłącznie do identyczności współrzędnych,
nie zastępuje interpolacji FEM ani nie dopuszcza ekstrapolacji. Próbki źródłowe
poza obwiednią płaszczyzny (poszerzoną o $\tau_{\mathrm{id}}$) nie wchodzą
do indeksu dopasowania i nie zwiększają tolerancji.

The lattice uses the plane origin as its centre, exactly as in the equation
above. `interpolation="fem_element"` is executable only when a valid tet4
carrier is available; `interpolation="fdm_trilinear"` remains rejected because
the current asset does not contain an FDM grid origin, spacing, and dimensions.
The artifact records the executed realization separately from the authored
interpolation label so it cannot silently claim a spatial interpolation that
was not executed.

The thin manifest also records the authored transform (`spatial_fft` or
`nonuniform_spatial_fft`), window, and a versioned executable Fourier identity
(`structured_fft_rustfft_centered_v1` or
`direct_nonuniform_dft_centered_v1`). Array shape alone is not a sufficient
description of the numerical realization.

The published artifact records the solution digest, source port, lattice frame,
outside count, coordinate mapping digest, window, normalization, and complex
amplitudes. It is a source-field spectrum only; it is not a magnetization
response or an eigenmode overlap.
Before publication, the spectrum manifest digest and the four binary payload
lengths and SHA-256 values are verified against the generated immutable set;
the verifier also checks axis/component counts, payload layouts and SI units
against the declared transform normalization, so a rehashed but inconsistent
manifest cannot be published;
it recomputes coherent gain and equivalent noise bandwidth from the authored
sampling lattice and window, including when the output k grid is nonuniform;
the same semantic manifest check runs before the v2 API exposes thin spectrum
metadata or any of its binary payloads, independently of binary payload integrity;
it also checks that the sampling record names the same solution/source/port,
the transform matches its executed Fourier realization, and the phase-origin
convention is consistent with the stated plane extent;
sampling axes must be finite, unit-length and mutually orthogonal, the source
carrier and coordinate mapping must be nonempty, and both wave-vector axes must
be nonempty; for structured FFT their bin counts must equal the sampling counts;
the authored interpolation must be `fem_element` for either current carrier
realization (`fem_p1_interpolation_v1` or legacy `identity_coordinates_v1`);
the private staging files are then compared byte-for-byte before atomic rename.
This guards artifact integrity, not the scientific accuracy of the transform.
Within one stage artifact directory, an identical source-spectrum request may
reuse an existing result only after matching the current field-solution digest,
port, target, plane, transform, window, normalization, component and wave-vector
axes, and after streaming verification of all four payload hashes. A changed
input or damaged result fails closed. This local reuse is not a cross-run
analysis cache or equilibrium-dependent cache.

Both executable Fourier realizations apply the same fail-closed lattice
preflight before allocating transform work: axis counts are checked before the
`N-1` spacing calculation, their checked product must match the sampled field,
the plane frame and positive finite spacing must be valid, and every field
sample must be finite. The direct nonuniform realization additionally requires
non-empty finite `k` axes and checked output/operation counts. These checks are
runtime guards for callers that construct an IR request programmatically; they
do not replace the canonical IR validators.
Both realizations also reject non-finite computed complex amplitudes or power;
the direct transform rejects a non-finite $\mathbf k\cdot\mathbf r$ phase
before evaluating its exponential. Finite inputs alone therefore cannot
publish a non-finite spectrum. This is an overflow guard, not a claim of
accurate phase for arbitrarily large finite wave vectors.

### 5.2 Local spectrum for a constricted antenna

For a layout whose profile changes along local $u$, a global FFT hides where a
wave vector is available. Fullmag therefore defines an optional windowed local
spectrum

$$
W_H(u_0,k_v)
=\sum_a
\left|
\int h_{\perp,a}(u,v)g(u-u_0)e^{-ik_vv}\,du\,dv
\right|^2,
$$

where $g$ is a declared spatial window. This `local_k_spectrum` product is the
primary diagnostic for a CPW constriction. It shows whether a target $k_v$ is
present only in the narrowed section.

For an idealized four-edge-current CPW, the first characteristic maximum and
zero scale approximately as

$$
k_{\max}\approx\frac{\pi}{w+s},
\qquad
k_{\mathrm{zero}}\approx\frac{2\pi}{w+s},
$$

where $w+s$ denotes the relevant signal-plus-gap scale of that approximation.
These expressions are validation trends, not substitutes for the computed
three-dimensional field.

### 5.3 Magnetization response

The actual excited spin-wave response is a different product:

$$
S_m(\mathbf k,\omega)
=\left\lVert
\mathcal F_{\mathbf r,t}
[\mathbf m(\mathbf r,t)-\mathbf m_0(\mathbf r)]
\right\rVert^2.
$$

`source_k_spectrum` answers which wave vectors are supplied by the antenna.
`dynamic_structure_factor` answers which magnetization waves were actually
excited and propagated. The UI and artifacts must not label the first as the
second.

For an available normalized eigenmode $\mathbf m_n$, an optional later product
is the overlap

$$
C_n=
\frac{
\left|\int_{\Omega_m}\mathbf h_\perp\cdot\mathbf m_n^*\,dV\right|^2
}{
\int_{\Omega_m}|\mathbf h_\perp|^2dV
\int_{\Omega_m}|\mathbf m_n|^2dV
}.
$$

Mode overlap is deferred until the modal field normalization and spatial
transfer contracts are validated.

(antenna-discrete-realization)=
## 6. Numerical interpretation

(antenna-cpu-gpu-separation)=
### 6.1 Solver ownership

The first production field solve belongs to `backends/fem` even when the
downstream LLG discretization is FDM. This is explicit cross-discretization
state transfer with provenance, not a hidden hybrid solver.

The initial production lane is:

```text
FEM CPU / MFEM H1 conduction
  -> normalized volume current J_1A
  -> CPU adaptive 3D Biot-Savart target evaluation
  -> field-basis artifact
  -> projection to FDM cells and/or FEM nodes
```

GPU field-solve acceleration is deferred. GPU consumption of an already solved
basis is a separate capability and may arrive earlier.

### 6.2 Conductor mesh

The conductor mesh is independent from the magnetic solver mesh. It must:

1. conform to all conductor boundaries and terminal faces;
2. refine the minimum constriction width, ground gap, thickness, and taper;
3. retain stable conductor-body and terminal marker identities;
4. record element order, size policy, quality metrics, and mesh hash;
5. pass a current-conservation convergence study before the field basis is
   promoted beyond reference status.

The initial solve uses P1/H1 potential on tetrahedra. Higher order is deferred
until the P1 validation suite is complete.

### 6.3 Field sampling domains

Tier 1 produces three related but distinct spatial representations:

1. `conductor_domain`: $V$ and $\mathbf J$ on the conductor mesh;
2. `field_sampling_domain`: $\mathbf H_{p,1\mathrm A}$ on a user-selected
   regular lattice or explicit point cloud covering conductor, air, and
   magnetic regions for heatmaps and line cuts;
3. `target_projection`: $\mathbf H_{p,1\mathrm A}$ sampled on one concrete
   magnetic runtime topology.

The field sampling domain must not be truncated to the ferromagnet. Its purpose
is to show range and decay in air. The target projection is the buffer used by
LLG and is separately invalidated when the magnetic mesh/grid changes.

When a target FEM or FDM carrier differs from the immutable field-sampling
carrier, the executable projection first reuses identical source coordinates
and otherwise performs deterministic tet4 point location followed by affine P1
barycentric interpolation. The stored topology ordering owns points on shared
faces by the lowest element ordinal. An inactive target mask is applied before
point location and receives an explicit zero. A point outside every certified
tetrahedron, a missing active sample, an invalid topology payload, or a legacy
point-only carrier without an exact coordinate match fails closed; nearest-node
substitution and point-count broadcasting are forbidden. The projection
signature records the interpolation realization and mapping digest. Direct
RT0 reevaluation and native MFEM transfer remain separate, not silently
substituted by this stored-basis projection.

(antenna-fdm-interpretation)=
### 6.4 FDM consumption

For FDM, evaluate or transfer the basis at active magnetic cell centers. The
reference CPU lane stores double-precision cell-centered vectors and is the
oracle for waveform composition. The production CUDA lane uploads each active
port-mode basis once, keeps it resident, evaluates the canonical waveform, and
adds the scaled vector to `H_eff` during every RHS evaluation.

Topology identity, cell ordering, active mask, precision, and projection method
are part of the target-projection signature. A basis for one grid may not be
reused on another grid merely because point counts match.

(antenna-fem-interpretation)=
### 6.5 FEM consumption

For FEM P1 time evolution, the MVP projection is a nodal vector coefficient
with explicit `sampling=node_lumped`. A later $L^2$ projection or
quadrature-owned coefficient may be added for high-order or sharp field
variation, but it must have a distinct realization identifier and parity test.

CPU and GPU FEM implementations consume the same backend-neutral field-basis
contract through separate MFEM/hypre/libCEED runtime realizations. The field
must remain backend-resident between steps; host readback occurs only for
requested outputs or diagnostics.

### 6.6 Error metrics

Every accepted solve records at least:

- normalized residual of the conduction equation;
- per-terminal requested and realized current;
- net current imbalance;
- elementwise or sampled $\lVert\nabla\cdot\mathbf J\rVert$ diagnostic;
- conductor-mesh convergence level;
- near-field quadrature tolerance and refinement count;
- minimum distance between field samples and conductor elements;
- target-projection method and topology identity;
- finite-value and maximum-field checks.

The default acceptance gate requires finite fields, solver convergence, and a
relative net current imbalance no greater than $10^{-8}$ for double-precision
CPU reference fixtures. Production tolerances for large models may be relaxed
only by a documented workload-specific validation gate and must remain visible
in provenance.

(antenna-runtime-session-impact)=
## 7. Runtime stage and artifact contract

(antenna-scripted-interactive-output-handoff)=
<!-- DOC-ANCHOR:antenna-scripted-interactive-output-handoff -->
### Przekazanie opublikowanej bazy ze skryptu do sesji interaktywnej

Wdrożona źródłowo, niezakwalifikowana runtime korekta granicy
`crates/fullmag-cli/src/orchestrator.rs::run_script_mode`:
szablon interaktywnego problemu jest kopią authored IR, nie lokalnego
wykonanego stage. Dlatego rozwiązanie `StageOutput` w stage nie rozwiązuje
automatycznie szablonu. Po zakończeniu skryptu bez pauzy aktywne referencje
szablonu rozwiązujemy przez istniejący
`resolve_active_antenna_stage_outputs`, zanim opublikowano gotowość
`awaiting_command` i utworzono `InteractiveRuntimeHost`.
Pauza nie jest ukończeniem pipeline: nie wolno wymagać przyszłych outputów
ostatniego authored stage podczas przekazania paused runtime.

Każdy nowy stage z `step_utils.rs::build_interactive_command_stage` wymaga
osobnego rozwiązania aktywnych referencji przed utworzeniem nowej
`single_current` sequence, walidacją, planowaniem i ładowaniem baz.
Nie jest to dowód transakcyjności wcześniej istniejącej sekwencji,
która mogła już usunąć bieżący element z `remaining_stages`.
Przykład: RF nieaktywny w Relax
pozostaje symboliczny w szablonie; następny Run zmienia study kind i dopiero
wtedy musi znaleźć właściwy prior ready output dla dokładnego portu.
Odmowa ma być powiązana z ID komendy i nie publikować rozpoczętego stage.

Ta korekta nie zmienia fizyki, jednostek, parametrów publicznych ani lowering
Python→`ProblemIR`. Zachowuje activation, czas i waveform origin;
nie uruchamia source solve i nie wybiera latest asset. Istniejący resolver
rozwiązuje atomowo wszystkie aktywne referencje albo odmawia brakującego,
failed/cancelled, future lub obcego portu. Loader nadal osobno sprawdza
integralność, aktualność i source/target/projection identity.

Zakres walidacji: źródłowe RED 2 FAIL / 27 PASS → GREEN 29/29 PASS:
caller ordering i zachowanie istniejących odmów, nie wykonanie Rust.
Native/Rust unit-test compilation jest obecnie zabroniona.
Rzeczywiste scripted→interactive `compute_fields`, binarne pole, zachowanie
magnetyzacji/czasu, stale refusals oraz Run/resume pozostają osobnymi
runtime gates. FEM CPU/GPU i FDM CPU/GPU nie otrzymują kwalifikacji na
podstawie tych kontroli. Obecny build R3 jest wcześniejszą kapsułą i nie
może dowodzić wykonania tej nowej korekty. Atomicity resolvera nie oznacza
transakcyjności `paused_stage.take()`, resume lub zastąpienia pauzy.
Nowy log zachowuje ID komendy i marker `failed`; obecny API reconciler
wymaga obecności ID tylko dla compute/import; każde jawnie zapisane ID
sprawdza dokładnie dla wszystkich rodzajów, także Run/Relax/Solve.
Kwalifikacja korelacji całego lifecycle pozostaje otwarta.

(antenna-command-log-explicit-id-isolation)=
<!-- DOC-ANCHOR:antenna-command-log-explicit-id-isolation -->
#### Izolacja terminalnych logów posiadających ID komendy

Źródłowo wdrożona korekta T12: `crates/fullmag-api/src/session.rs::command_has_terminal_log`
nie ignoruje jawnego ID tylko dlatego, że rodzaj komendy nie wymaga
jeszcze jego obecności. Każdy wpis posiadający `command_id` musi odpowiadać
dokładnemu ID rekordu ledger, niezależnie od Run/Relax/Solve lub compute/import.
Obcy wpis `failed`, `Error` albo `cancelled`, także z tej samej milisekundy,
nie jest dowodem terminalnym tej komendy. Czas wpisu nadal musi być nie
wcześniejszy od dispatch; bez czasu dispatch obowiązuje dotychczasowy czas
utworzenia komendy. `compute_fields`, `compute_energies` i `load_state`
dalej wymagają obecności ID; anonimowy log nadal może obsłużyć pozostałe
rodzaje zgodnie z historycznym bridge, nie jako nowa gwarancja ukończenia.

Zmiana dotyczy globalnego właściciela API, nie osobnego antenowego ledgera
ani nowej tabeli wyników. Chroni również nowy log odmowy rozwiązania
`StageOutput`, który CLI wiąże z ID. Nie zmienia markerów, readiness pola,
przedziału świeżości, publicznego OpenAPI/DSL, `ProblemIR`, fizyki, SI,
czasu waveform ani realizacji FEM/FDM CPU/GPU.

Wykonana walidacja interpretowana: RED 1 FAIL / 29 PASS przed poprawką,
końcowe GREEN 30/30 PASS po poprawce. Nowa regresja
`scripts/test_antenna_observation_source.py::test_terminal_log_named_identity_applies_to_all_command_kinds`
sprawdza faktyczne źródło wspólnego matcher oraz zachowanie guards.
Zapisany test Rust
`crates/fullmag-api/src/session.rs::snapshot_reconciliation_does_not_apply_foreign_identified_logs_to_solver_commands`
obejmuje 24 przypadki obcych, anonimowych, nieświeżych i własnych wpisów
dla Run/Relax/Solve; jest **niewykonany**, nie wolno go obecnie kompilować.
Obcy wpis nie nadpisuje wyniku błędem lub anulowaniem; oczekiwane `Completed`
w fixture zachowuje wcześniejsze idle inference, nie dowodzi wykonania komendy.
Niezależny bounded review kodu nie pozostawił Required/Blocker;
wskazaną nieścisłość poprzedniego akapitu handoff poprawiono.
Source GREEN nie jest dowodem wykonania Rust, całego ledger reconciliation
ani runtime anteny. Kapsuła buildu seq 36 poprzedza tę korektę;
jej odbiór nie będzie dowodem kompilacji zmienionego matcher.
Idle-based completion pozostałych komend i anonimowe logi pozostają
historycznymi ograniczeniami; bridge wymaga typed durable outcome,
replay/recovery i burst/eviction gate przed pełną kwalifikacją lifecycle.

Samodzielny commit `140987ee9b4a2d896132a050dfbf3c193b579e5d`
zapisuje wyłącznie globalną izolację obecnego ID i jej helper/test Rust.
Zachowuje wcześniejsze `None => true` dla wszystkich rodzajów; docelowy
wymóg obecności ID dla compute/import pozostaje w zależnym WIP wraz
z producentami CLI i fixtures API/router. Są to różne zakresy dowodów:
pełny bieżący WIP ma source GREEN 30/30, a wydzielony staged blob ma osobne
source RED 2 FAIL → GREEN 2/2 PASS. Oba wyniki są źródłowe, nie Rust/runtime.
Commit blob jest identyczny ze zweryfikowanym indexem; pełny working file
pozostał byte-identical. Ten etap nie zmienia fizyki ani kryteriów naukowych
i nie zastępuje pełnej migracji lub kwalifikacji czterech realizacji.

(antenna-command-result-correlation-commit)=
<!-- DOC-ANCHOR:antenna-command-result-correlation-commit -->
#### Zapisana migracja producentów i odbiorców wyników compute/import

Commit `48e8f622427856b70a044bc1a8e18cf09f4b27dd` na rodzicu
`140987ee9b4a2d896132a050dfbf3c193b579e5d` zapisuje spójne siedem plików:
opcjonalne ID CLI, konstruktor i ochronę tail upsert, atomowy bridge,
16 istniejących producentów terminalnych wyników, wspólny matcher API,
readiness fixtures oraz niezależny skrypt źródłowy. Obecność ID jest wymagana
dla `compute_fields`, `compute_energies` i `load_state`; każde obecne ID
jest dokładnie dopasowywane także dla pozostałych rodzajów. Pola wymagają
równocześnie świeżego własnego sukcesu i dotychczasowego quantity/scope/
generation/carrier readiness; stare scalar rows ani idle nie kończą energii.
Brak ścieżki, odmowa importu podczas pauzy i błąd zastosowania importu
korzystają ze wspólnego markera porażki i własnego ID. Pięć fixtures routera
publikuje wyniki jawnie, bez ukrytego wstrzykiwania w reconcile helper.

Wykonany niezależny source regression
`scripts/test_command_result_identity_source.py::CommandResultIdentitySourceTests`
na dokładnym rodzicu był RED: 8 testów, 7 failures (w tym subtests) i 2 errors
(brak nowych deklaracji). Na rzeczywistym indexie był GREEN 8/8; staged
whitespace PASS. Przejrzano każdą staged linię i sprawdzono niezmienione
bajty sześciu pełnych working files. Niezależny review bez Required/Blocker
obejmował tylko ten fragment. Zapisane fixtures Rust nie były kompilowane
ani wykonywane; kontrole źródłowe nie dowodzą działania runtime.

Otwarte: `crates/fullmag-cli/src/interactive_runtime_host.rs::compute_current_energies`
w HEAD commita `48e8f622427856b70a044bc1a8e18cf09f4b27dd` może zwrócić
`Ok` bez runtime po błędzie przygotowania.
Skorelowany wpis potwierdza rezultat zgłoszony przez producenta, nie faktyczne
obliczenie energii. Wymagana jest propagacja błędu lub jawna odmowa braku
runtime, potem test wykonania; nie akceptować no-op jako sukcesu naukowego.
Nadal otwarte są trwałe typed outcomes, burst/eviction/replay, anonimowe logi
pozostałych rodzajów, generic idle completion i paused-resume atomicity.
Seq 36 ma wcześniejszą kapsułę i nie kwalifikuje tego commita. OpenAPI ma już
opcjonalne ID w API; kształt schematu, DSL, IR, SI i fizyka nie zmieniają się.
Zgoda RAM nadal wyłącznie fixed V/RT0/H, bez LLG/Relax i nowych fixtures.

(antenna-observation-readiness-commit)=
<!-- DOC-ANCHOR:antenna-observation-readiness-commit -->
#### Zapisana propagacja błędów przygotowania obserwacji

Commit `46daf528dc529f02888a09e6e2746e406082f2a5`, parent
`48e8f622427856b70a044bc1a8e18cf09f4b27dd`, domyka źródłowo wcześniejszy
no-op energii. `ensure_base_runtime_ready` zwraca `Result`; błędy stworzenia
lub resync wracają do jawnych fields/energies/import zamiast ostrzeżenia
zakończonego pozornym sukcesem. Energia wymaga obecnego runtime i udanego
`snapshot_step_stats` przed publikacją. Idle pozostaje odrębną ścieżką:
ostrzeżenie nie wyłącza polling kolejnych komend.

`load_state` waliduje wejście i przygotowuje runtime przed zmianą
continuation/generation oraz live state. Usunięto drugi upload; zachowany
runtime uploaduje w helperze, a nowy otrzymuje continuation w konstruktorze.
HEAD `crates/fullmag-runner/src/lib.rs::create_planned_interactive_runtime_with_stage_fem_mesh_asset_preview_cadence_and_frozen_spins_lifecycle`
ustawia `activation_plan.initial_magnetization` przed konstrukcją backendu
zarówno FDM, jak FEM. To uzasadnienie źródłowe kolejności, nie wykonany test
urządzenia lub całego importu. Błąd resync usuwa runtime; zmiana nie gwarantuje
zachowania starego runtime ani rollbacku urządzenia/locków/metadata.

Wykonane źródłowo: dokładny parent RED 5 testów / 6 failures z subtests;
rzeczywisty INDEX GREEN 5/5 oraz wcześniejsze kontrole korelacji 8/8.
Finalny staged whitespace PASS po usunięciu wyłącznie pustej linii EOF.
Main review wszystkich staged linii i niezależny review bez Required/Blocker.
Dwa pliki, 84 dodane / 38 usunięte linie; tree index/commit identyczny.
Pełny plik working hosta zachowany byte-identical.
`scripts/test_interactive_observation_readiness_source.py::InteractiveObservationReadinessSourceTests`
używa istniejącego helpera source/INDEX z poprzedniego commita, bez zależności
od observation WIP. Nie kompilowano ani nie wykonywano Rust/native testów;
to nie runtime qualification.

Fragment zachowuje HEAD-owe sygnatury konstruktorów i snapshotów.
Przygotowanie planu z rozwiązanymi bazami anteny oraz jego wspólne fasady
pozostają zależnym WIP, nie zostały zastąpione wariantem bez bazy.
T09/T12 nadal wymagają tego podłączenia i rzeczywistej obserwacji/importu;
T06/T13/T16/T18, cztery realizacje, UI i integracja pozostają otwarte.
OpenAPI/DSL/IR/SI i równania nie zmieniają się. Seq 36 ma starszą kapsułę,
więc jego odbiór nie jest kwalifikacją tego commita. Zgoda RAM nadal fixed
V/RT0/H, bez LLG/Relax, nowych fixtures i kwalifikacji trwałego zapisu.

(antenna-consumer-activation-preflight)=
<!-- DOC-ANCHOR:antenna-consumer-activation-preflight -->
#### Aktywacja konsumenta przed root i czyszczenie nieaktualnych baz

Commit `ecd3d392a14acd603a59e4067df5083a92d8cac4`, parent
`46daf528dc529f02888a09e6e2746e406082f2a5`, zapisuje samodzielną
centralną granicę
`crates/fullmag-cli/src/orchestrator.rs::prepare_solved_antenna_drive_activation`.
Najpierw sprawdza zgodność rodzaju study i aktywnego stage między IR i planem
przy authored drive. Przy braku aktywnego drive, w tym pustej liście,
czyści `solved_antenna_drive_bases` w FDM/FEM i zwraca `false`.
Nie wymaga katalogu ani assetu. Aktywne nieobsługiwane lane kończą się
błędem, a poprawne zwracają `true`. Nie zmienia czasu, waveformu,
aktywacji, etapu ani modelu fizycznego. To wspólna polityka sterowania,
nie dowód wykonania którejkolwiek realizacji CPU/GPU.

`attach_solved_antenna_drive_bases` zawsze korzysta z tej samej granicy
przed materializacją. W commitowanym fragmencie cała dalsza ścieżka
published-loader, integralność, current-signatures i projekcja v0.3
pozostaje byte-identical względem rodzica. Silniejsze
`current_antenna_solution_expectation` oraz
`load_expected_antenna_field_solution` pozostają zachowane w zależnym
pełnym WIP; nie wolno uznać prostszego commitowanego routingu za ukończenie
tego kontraktu.

Poprawiony WIP
`crates/fullmag-cli/src/antenna_workflow.rs::materialize_antenna_consumer_plan`
wywołuje preflight **zawsze**, również przy pustej liście drive. Dopiero
wynik `true` pozwala wywołać
`crates/fullmag-cli/src/live_workspace.rs::current_artifact_dir`.
Wcześniej nieaktywne przyszłe anteny mogły niepotrzebnie wymagać root,
a brak anten mógł zachować starą bazę w klonowanym kandydacie
`InteractiveRuntimeHost::prepare_base_problem`.
Nie zastosowano dummy path, środowiskowego fallbacku ani drugiej polityki
aktywacji. Drugie sprawdzenie w attach używa tego samego właściciela.

Wykonane źródłowo: trzy nowe observation regressions były RED 3 failures;
pełne WIP GREEN **33/33**, exit 0. Niezależny skrypt
`scripts/test_antenna_activation_preflight_source.py::AntennaActivationPreflightSourceTests`
na dokładnym rodzicu był RED **3 failures**, a na rzeczywistym INDEX
GREEN **3/3**; korelacja komend pozostała **8/8**. Staged whitespace PASS,
tree INDEX/commit `19765aced528d32ff38ef3292d72798f59919f95`;
committed orchestrator SHA
`bd8902dc33e2d97fd8fb77fe1f4c125a4199dd14b9ac99810056a9360bb14740`.
Pełny working orchestrator zachowany byte-identical po commicie.
Niezależny ograniczony review lazy-root/clear-bases bez Required/Blocker.
Nie kompilowano testów Rust ani nie uruchomiono nowego solvera; source
GREEN nie jest dowodem runtime, aktualnego buildu ani pełnej kwalifikacji.

**Domknięcie do dalszej pracy, nie redukcja zakresu T00–T18:**

| Granica | Źródła i wymagane wspólne domknięcie |
|---|---|
| Świeżość | `orchestrator.rs::current_antenna_solution_expectation`, `antenna_stage.rs::ExpectedAntennaSolution`, podpisy/revisions w readerze i plannerze; jawny stale/recompute dla historycznych podpisów. |
| Referencje etapów | `fullmag-ir/src/antenna.rs::AntennaSolutionRefIR`, walidatory v0.3/v0.4, ready catalog, resolver przed scripted/final/new stage i spectrum loader; nie omijać paused-resume. |
| Integralność i producent | `antenna_field_solution.rs::parse_verified_manifest`, `antenna_external_lead_solution.rs::reject_unqualified_external_lead_source`, owned-bundle reader, current-source IR; snapshot adapter, native producent i ABI muszą być zgodne. |
| Projekcja | `antenna_fields.rs`, topology/count/finite guards, jawny nośnik współrzędnych oraz wszyscy konsumenci FDM CPU/CUDA/FEM; ciche `zip` nie dowodzi zgodności długości. |
| Obserwacja | Moduł workflow, workspace root, plan-aware runner facades, host reconstruction/snapshot/async/remesh i obaj pre-solve konsumenci muszą zachować rozwiązane bazy. Nie zastępować bare-IR runtime. |
| Czas sygnału | `waveform_origin_time_s`: spójne IR/planner/events/backendy/orchestrator i Run/Relax/resume qualification; zachowanie metadata nie dowodzi fazy. |

Kolejność spójnych zależnych etapów: podpisy/readery → referencje i katalog
→ projekcja/guards → komplet routingu → zegary/resume. Mniejsze samodzielne
foundation commits nie mogą usuwać końcowych silniejszych bramek.
Seq 36 jest starszą kapsułą i nie kwalifikuje żadnej z powyższych nowych
zmian. OpenAPI/DSL/IR, SI i równania w tym fragmencie bez zmian.
Zgoda naukowa pozostaje fixed V/RT0/H w RAM, bez LLG/Relax, nowych fixtures
i kwalifikacji trwałego zapisu. Pozostałe gate są `NOT VERIFIED`.

(antenna-build36-terminal-package-acceptance)=
<!-- DOC-ANCHOR:antenna-build36-terminal-package-acceptance -->
#### Terminalny odbiór pakietu seq 36, bez promocji do kwalifikacji fizyki

Job `ba55fc79175c4a57a335bab7b1efc0e8` zakończył się `succeeded`, exit 0.
Wykonano ponownie kanoniczny odbiór
`scripts/run_managed_browser.py::validate_managed_build`: terminalny journal,
zgodne context/profile/image/source, komplet trzech trusted documents i ich SHA
oraz `scripts/local_runner/build_executor.py::validate_build_receipt` z hashami
**126 artefaktów** — PASS. `scripts/local_runner/worker_entrypoint.py::verify_source`
potwierdził pełne bajty i membership kapsuły: **7453 pliki**, **79 jawnie
included untracked**, snapshot bazujący na
`6de68ca35e41b617f21d05e264856630e0741aff`.

Source digest `6115532bdbe5bd93d14ac8802d65de2074caf5ce72212ba9074e9beadcf430a6`;
native snapshot `dff597e0229601109906d34e500b980c754216d45d1dfdf570853c8ac9d0b0f1`.
Build receipt SHA `84211621c8c1c30679666f612bc2bc84faa13f97ad6ff21b0a00ffb3f382c64e`;
journal SHA `eef8241f4a876da61b6a0a4a69f986a163a6c2503612195dda47d00b6e6cc812`.
To dowód zbudowania dokładnego starszego pakietu, nie commitów
`46daf528dc529f02888a09e6e2746e406082f2a5` i
`ecd3d392a14acd603a59e4067df5083a92d8cac4`, trajektorii LLG, nowych
zdarzeń API/UI, reusable basis lub fizycznej zbieżności. Nie uruchomiono
dodatkowego solvera, nie kompilowano testów jednostkowych, nie zmieniono
zabezpieczeń SessionStore i nie usunięto zasobów. Następny odbiór aktualnych
źródeł oraz runtime/science i T00–T18 nadal wymagane.

### 7.1 Stage graph

The source solve is a first-class study stage:

```text
AntennaFieldSolve
  -> optional Relaxation
  -> TimeEvolution using SolvedAntennaDrive
  -> SpinWaveResponseAnalysis
```

`AntennaFieldSolve` may run before relaxation because it does not depend on
$\mathbf m$. A derived $\mathbf h_\perp$ or source k-spectrum that references
$\mathbf m_0$ runs only after the equilibrium artifact is available.

Downstream execution rejects a missing, failed, incompatible, or stale field
basis. It must not start a hidden solve inside an LLG RHS call.

(antenna-artifact-provenance-impact)=
### 7.2 Field-solution artifact

The canonical artifact family is `antenna_field_solution.v1`. Its manifest
contains:

- solution id, source id, stage id, and creation time;
- immutable references to the source `PhysicsObject`, shared geometry revision,
  material assignment and charge-only `CurrentTransport`;
- port-mode ids, references to the transport terminal selectors, signed branch
  weights, measured terminal-current certificate and 1 A normalization;
- conductor mesh identity, statistics, and hash;
- requested and resolved solver/backend/device/precision;
- gauge policy and linear-solver policy;
- $V_{p,1\mathrm A}$ and $\mathbf J_{p,1\mathrm A}$ field references;
- $\mathbf H_{p,1\mathrm A}$ field-sampling references;
- target-projection references;
- convergence, current-balance, and quadrature diagnostics;
- Tier 1 assumptions and validity ratios;
- content signatures and dependency revisions.

The manifest references heavy binary payloads instead of embedding arrays in
JSON.

### 7.3 Staleness signatures

Staleness is split into three signatures:

1. `current_solution_signature`: referenced source-object/geometry/material and
   `CurrentTransport` revisions, port binding, conductor mesh, gauge, and
   conduction solver;
2. `field_solution_signature`: current solution plus Biot-Savart realization,
   quadrature policy, and field-sampling domain;
3. `target_projection_signature`: field solution plus target topology,
   ordering, scope, and projection method.

Changing a waveform or peak current invalidates none of these signatures.
Changing equilibrium magnetization invalidates only derived
`h_perp`/source-spectrum products. Changing geometry, conductivity, terminal
faces, or return weights invalidates all downstream signatures.

### 7.4 Quantities and units

The accepted quantity identities remain:

| Quantity/resource | Unit | Domain | Meaning |
|---|---|---|---|
| `H_ant` | A/m | full field or magnetic target | instantaneous summed antenna field |
| `H_ant_basis` | A/m/A | field sampling or target | one port-mode field per ampere |
| `J_charge` | A/m^2 | conductor mesh | solved charge-current density |
| `V_electric` | V | conductor mesh | gauge-dependent electric potential |
| `h_perp` | A/m | magnetic target | field component transverse to an equilibrium |

`H_ant` is frozen by ADR 0004 and must not be renamed or overloaded as
`B_ext`. The UI may display the derived quantity $\mu_0\mathbf H_{\mathrm{ant}}$
in T or mT through a unit transform. That display transform does not change the
canonical stored field or imply magnetic-material polarization.

## 8. Public Python, ProblemIR, and planner impact

(antenna-python-api)=
### 8.1 Wykonywalny authoring stage-first: inspekcja samego pola anteny

Pierwszy przykład jest aktualnym skryptem
`examples/fem_antenna_current_source_inspection.py::lead_cubes`, nie projektowanym
API. Skopiuj cały blok do pliku w katalogu `examples/` checkoutu: korzysta z
dwóch wersjonowanych siatek w sąsiednim `assets/`. Ten sam skrypt można
wczytać przez publiczny loader i wyeksportować ponownie bez solvera.

Jawnie wybiera FEM CPU/double/strict. Autor dostarcza rzeczywistą siatkę 3D,
przewodność i podpisane prądy zewnętrznych terminali; nie wymyśla rozwiązania,
digestu ani RT0 view. Jedyny stage to `antenna_field_solve`. Nie ma Run ani
Relax, propagacji fal ani FFT. Osobny magnetyczny probe jest obecnym carrierem
sesji: przykład nie dowodzi standalone bez magnetu. Wymiary tego wzorca są
w metrach, nie są projektem mikrofalowego CPW w skali mikrometrowej.

Wyjście tego workflow pozostaje `inspection_only`: raw $\mathbf H$ w
$\mathrm{A\,m^{-1}}$, nie zakwalifikowana baza na amper. Nazwa selektora
`H_ant_basis` w bieżącym stage schema nie zmienia jednostek ani kwalifikacji
wyniku. Nie podłączać go do LLG, projekcji ani widma jako gotowej bazy.
Zachowane wykonanie V/RT0/H fixed RAM jest opisane oddzielnie w sekcji
`antenna-global-target-v3-fixed-ram-evidence`; nie obejmuje nowego R3 ani
trwałości storage.

Kontrakt kopiowania, lowering i Python export/reimport sprawdza
`packages/fullmag-py/tests/test_antenna_documented_example.py::AntennaDocumentedExampleTests`.
To interpretowany test authoringu, nie kolejne wykonanie native ani dowód
solve→LLG. Pełne tabele parametrów i SI są w sekcjach public API oraz
`antenna-current-driven-source-input` poniżej; pliki źródłowe i
mapa źródeł pozostają właścicielami mapowania Python→ProblemIR.

```python
"""Stage-first current-driven antenna inspection, without Relax or Run.

This meter-scale, 1 A fixture tests the accepted V/RT0/H producer. Two disjoint
rectangular conductors share one original MeshIR; four explicit leads carry
opposite signal/return currents. It is not a closed-circuit or RF qualification:
the external electrodes truncate the modeled source. The result remains
inspection_only, H in A/m, not a reusable H-per-ampere basis for LLG or FFT.
The separate magnetic probe supplies the session's existing mesh/m carrier;
this example does not establish a standalone session without any magnet.
"""

from collections import Counter
import json
from pathlib import Path

import fullmag as fm


# %% Explicit execution and independently authored sampling carrier
ROOT = Path(__file__).resolve().parent
SOURCE_MESH = ROOT / "assets" / "fem_antenna_current_source.mesh.json"
PROBE_MESH = ROOT / "assets" / "fem_antenna_current_probe.mesh.json"

study = fm.study("fem_antenna_current_source_inspection")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(maximum_element_size=1.0, order=1)

study.antenna_object(fm.ImportedGeometry(source=str(SOURCE_MESH)), name="antenna")
probe = study.geometry(fm.ImportedGeometry(source=str(PROBE_MESH)), name="probe")
probe.Ms = 8.0e5
probe.Aex = 13.0e-12
probe.alpha = 0.02
probe.m = fm.init.UniformMagnetization((0.0, 0.0, 1.0))


# %% Small geometry helper: four explicit volumetric leads, no mesh generator
def lead_cubes() -> dict:
    nodes, tets = [], []
    for x, y in ((-1.0, 0.0), (1.0, 0.0), (-1.0, 2.0), (1.0, 2.0)):
        offset = len(nodes)
        nodes.extend([[x, y, 0.0], [x + 1, y, 0.0], [x + 1, y + 1, 0.0], [x, y + 1, 0.0],
                      [x, y, 1.0], [x + 1, y, 1.0], [x + 1, y + 1, 1.0], [x, y + 1, 1.0]])
        tets.extend([[offset + v for v in tet] for tet in
                     ((0, 1, 2, 6), (0, 2, 3, 6), (0, 3, 7, 6),
                      (0, 7, 4, 6), (0, 4, 5, 6), (0, 5, 1, 6))])
    incidence = Counter()
    for tet in tets:
        for omitted in range(4):
            incidence[tuple(sorted(tet[:omitted] + tet[omitted + 1:]))] += 1
    faces = sorted(face for face, count in incidence.items() if count == 1)
    return {"mesh_name": "antenna_four_external_leads_v1", "nodes": nodes,
            "cells": {"types": ["tet4"] * len(tets), "offsets": list(range(0, 4 * len(tets) + 1, 4)),
                      "nodes": [v for tet in tets for v in tet]},
            "element_markers": [1] * len(tets),
            "facets": {"types": ["tri3"] * len(faces), "roles": ["exterior"] * len(faces),
                       "offsets": list(range(0, 3 * len(faces) + 1, 3)), "nodes": [v for face in faces for v in face]},
            "boundary_markers": [1] * len(faces)}


def plane_faces(mesh: dict, ids: list[int], x: float, y: float) -> list[list[int]]:
    facets = mesh["facets"]
    faces = [facets["nodes"][start:stop] for start, stop in zip(facets["offsets"], facets["offsets"][1:])]
    return [sorted(ids[v] for v in face) for face in faces
            if all(mesh["nodes"][v][0] == x and y <= mesh["nodes"][v][1] <= y + 1.0 for v in face)]


# %% Input-only current source: no caller-authored solution digest or RT0 view
device_mesh = json.loads(SOURCE_MESH.read_text(encoding="utf-8"))
lead_mesh = lead_cubes()
device_ids = list(range(1, len(device_mesh["nodes"]) + 1))
lead_ids = list(range(101, 101 + len(lead_mesh["nodes"])))
device_xyz = dict(zip(device_ids, device_mesh["nodes"]))
lead_xyz = dict(zip(lead_ids, lead_mesh["nodes"]))
interfaces, observations, terminals, currents = [], [], [], {}
for branch, y, direction in (("signal", 0.0, 1.0), ("return", 2.0, -1.0)):
    for end, x, outer_x, sign in (("in", 0.0, -1.0, -1.0), ("out", 1.0, 2.0, 1.0)):
        pair_ids = []
        for face in plane_faces(device_mesh, device_ids, x, y):
            lead_face = next(candidate for candidate in plane_faces(lead_mesh, lead_ids, x, y)
                             if {tuple(lead_xyz[v]) for v in candidate} == {tuple(device_xyz[v]) for v in face})
            pairs = [[v, next(w for w in lead_face if lead_xyz[w] == device_xyz[v])] for v in face]
            pair_id = f"{branch}-{end}-{len(pair_ids)}"
            pair_ids.append(pair_id)
            interfaces.append(fm.CurrentSourceInterfacePair(pair_id, face, lead_face, pairs))
        observations.append(fm.CurrentSourceTerminalObservation(f"{branch}-{end}", "antenna", pair_ids))
        terminal_id = f"outer-{branch}-{end}"
        terminals.append(fm.CurrentSourceOuterTerminal(terminal_id, plane_faces(lead_mesh, lead_ids, outer_x, y)))
        # Signed OUTWARD flux: inflow negative, outflow positive.
        currents[terminal_id] = sign * direction

source = fm.ExternalLeadCurrentSource(
    revision="antenna_signal_return_input_v1",
    device_stable_vertex_ids=device_ids,
    lead_mesh=lead_mesh,
    lead_stable_vertex_ids=lead_ids,
    lead_conductivity_spm_per_element=[8.0] * len(lead_mesh["cells"]["types"]),
    interface_pairs=interfaces,
    outer_terminals=terminals,
    terminal_observations=observations,
    drives=[fm.CurrentSourceDrive("drive", "port", currents)],
)
region = fm.RegionRef("antenna")
study.current_transport(
    name="antenna_charge", model="ohmic_poisson", coupling="one_way",
    domain=[region],
    materials=[fm.ChargeTransportMaterialAssignment(region, fm.ChargeTransportMaterial(4.0))],
    boundaries=[], gauge=fm.ChargePotentialGauge("terminal_reference"),
    solver=fm.ChargeSolverPolicy(operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
    conservative_current_source=source,
)
port = fm.AntennaPortMode(
    id="port", source_object_id="antenna", current_transport_id="antenna_charge",
    normalization_current_a=1.0,
    branches=[fm.AntennaPortBranch("signal", "signal-in", "signal-out", 1.0),
              fm.AntennaPortBranch("return", "return-in", "return-out", -1.0)],
)
study.add_antenna_port_mode(port_mode=port)


# %% Only the antenna solve; never attach this unqualified output to a consumer
study.stages.add_antenna_field_solve(
    id="inspect_antenna",
    definition=fm.AntennaFieldSolveStage(
        id="inspect_antenna", source_object_id="antenna", current_transport_id="antenna_charge",
        port_mode_ids=["port"], field_sampling_domain=fm.FieldTarget.object("probe"),
        target_refs=[fm.FieldTarget.object("probe")],
        # Existing stage schema uses this selector; the inspection publisher
        # emits raw H (A/m), NOT a qualified H_ant_basis (A/m/A) asset.
        outputs=[fm.AntennaNamedOutput("inspection", "H_ant_basis")],
    ),
)
```

The existing constant-width `MicrostripAntenna` and `CPWAntenna` constructors
remain deserializable migration adapters. They must lower once to shared
geometry, `PhysicsObject`, material assignment, charge-only `CurrentTransport`
and thin port-mode references; they are not a second geometry/material/current
model. Existing `AntennaFieldSource(model="prescribed_zeeman_mask")`
round-trips through a compatibility adapter to the separate regional-drive
contract described by note 0920.

(antenna-problem-ir)=
### 8.2 ProblemIR target

The canonical IR adds thin composition and lifecycle types instead of adding
more optional fields to the current conflated `AntennaFieldSource` variant or
duplicating existing geometry/material/current owners:

```text
AntennaPortModeIR
  id
  source_object_ref -> PhysicsObjectIR
  current_transport_ref -> CurrentModuleIR::CurrentTransport
  terminal_selector_refs[]
  signed_branch_weights[]
  normalization_current_a = 1

CurrentTransport.definition.boundaries[]::EquipotentialCurrentTerminal
  id
  surfaces[] -> conductor terminal faces (no voltage or density value)
CurrentTransport.definition.gauge = terminal_reference

StudyIR::AntennaFieldSolve
  source_object_ref
  current_transport_ref
  port_mode_refs[]
  conservative_current_view_ref? (legacy view only; omitted for dedicated source)
  model = quasistatic_conduction_biot_savart_3d
  conductor_mesh_policy
  field_sampling_domain
  target_refs[]
  solver_policy

SolvedAntennaDriveIR
  name
  solution_ref = { stage_id, output_id }
  port_mode
  peak_current_a
  waveform
  time_origin

RegionalFieldDriveIR
  name
  region_ref
  amplitude_B_T
  direction
  spatial_profile
  waveform
  time_origin
```

The existing `StudyPipelineDocument` primitive node owns `stage_id` and stage
ordering. `ProblemIR` retains one singular `study: StudyIR` for the currently
lowered primitive stage. A downstream stage-output reference is resolved to a
concrete solution manifest id and content hash before backend execution.

Shared IR describes physical intent. MFEM spaces, CUDA buffer layouts,
quadrature work arrays, and artifact file paths remain plan/runtime details.

In the FEM CPU reference integrator the numerical state clock restarts at zero
for each stage. The solved antenna basis still has one physical current:
`stage_local` evaluates the waveform at the stage-relative clock, whereas
`absolute` evaluates it at the stage-start time plus that clock. Prescribed masks and
legacy current modules use the absolute clock. The same mapping is applied to
the dynamic RHS term and its observation field; it does not change the
per-ampere spatial basis. This is a source-level correction, not a qualified
multi-integrator trajectory result. The native FEM carrier has its own absolute
clock and subtracts the stage start only for `stage_local`.
For a scripted sequence, the Rust CLI replaces the helper's estimated stage
start with the preceding executed stage's reported physical end before
replanning. Its typed runner clock contract distinguishes absolute single-grid
FDM CPU/native FEM samples from stage-local FDM CUDA, multilayer FDM and
FEM-reference samples; only stage-local samples receive the accumulated start offset in live updates
and aggregate `StepStats`. The synthetic initial update remains stage-local.
An adaptive native FEM relaxation follow-up now replans with the preceding
pass's reported physical end and does not add that end to absolute native
samples a second time. New interactive stages follow the same clock contract;
pause computes elapsed segment time in its runner frame. Resume with an active
time-dependent drive fails closed because the current magnetization-only
continuation does not restore the original waveform clock. These source-level
paths do not yet qualify native multi-stage/adaptive runs or exact RF resume.
Początek segmentu solvera i początek przebiegu są odrębnymi chwilami.
Przy wznowieniu w chwili $T_r$ przebieg `stage_local` musi nadal otrzymywać
argument $t-T_0$, gdzie $T_0$ jest początkiem pierwotnego etapu, podczas gdy
integrator startuje od $T_r$. Typowany plan ma teraz opcjonalne
`waveform_origin_time_s` (stary plan przyjmuje $T_0=T_r$); referencyjne
ewaluatory solved drive i harmonogram zdarzeń FDM CPU respektują ten
początek. Nie oznacza to obsługi exact RF resume: CLI nadal blokuje
wznowienie dynamicznego napędu. Natywne FEM ma wersjonowane
`begin_stage_v2`, które przekazuje oddzielnie $T_r$ i $T_0$ do zegara
stanu oraz przebiegów Zeemana/SOT. Runner pomija wczesne obliczenie pola
przed tym wywołaniem przy rozdzielonych zegarach; snapshot odświeża pole
po ustawieniu $T_0$. Interaktywny FEM GPU ustawia $T_0$ i odświeża snapshot
przed zapisem początkowych pól. Nie ma jeszcze kontenerowej kwalifikacji
tych ścieżek.
Interaktywny harmonogram zdarzeń przebiegu używa tego samego $T_0$ co
ewaluator pola, również po rozpoczęciu nowego segmentu w $T_r$. Harmonogramy
uwzględniają też krawędzie impulsów i punkty przebiegu `piecewise` z
rozwiązanych baz antenowych, nie tylko z regionalnych `field_drives`.
Gdy rozwiązany drive jest jawnie aktywny podczas relaksacji FEM, jego
nieciągłości wchodzą również do harmonogramu unieważniania cache integratora.
Artefakt `regional_field_drive.v1` zapisuje oba czasy $T_r$ i $T_0$ oraz
absolutne chwile zdarzeń i unieważnień FSAL, aby replay nie wywnioskowywał
origin z samych próbek.
CUDA FDM ma osobny deskryptor ABI v2 z początkiem
segmentu i origin przebiegu; adapter v1 zachowuje dotychczasowe znaczenie
jednego początku. Kernel wykorzystuje wspólny offset dla wszystkich
ewaluacji RHS, a statyczna baza jest uploadowana raz. Baza pola na amper
pozostaje niezmienna.
Próba wykonania takiego rozdzielenia w natywnym FEM albo FDM CUDA jest
odrzucana przed uruchomieniem backendu, jeśli plan zawiera dynamiczne
wymuszenie; stała baza pola nie zależy od początku fazy. Nie ma ukrytego
przejścia na CPU. CUDA pozostaje za tą bramką do testu urządzeniowego
ABI v1/v2, fazy pola w punktach RK i porównania trajektorii z FDM CPU.
Pauza przechowuje pierwotny początek przebiegu dla
ponownie planowanego segmentu, lecz samo to nie odtwarza stanu integratora.
After target projection, the shared FEM/FDM materializer checks that every
component of the per-ampere basis multiplied by the signed peak current is
finite in `f64`. Finite inputs alone do not guarantee a finite product. A
failed check stops before LLG starts and leaves the immutable `H/A` asset
unchanged; it does not silently clip the applied field or alter $mu_0$.
At observation time, the FEM reference consumer additionally checks the
waveform-scaled current multiplier and each accumulated component of the
observed `H_ant` after adding a solved port. Thus a finite preflight product
cannot silently become an infinite observation through a waveform offset or
port superposition. The observation boundary also rejects non-finite fields
from legacy Zeeman masks and legacy antenna-current sources. These source-level
guards do not establish finite RHS, energy or torque for every native
integrator and do not qualify T13.

### 8.3 Validation and normalization

Validation requires:

1. globally unique port-mode, stage, solution-output, projection and drive ids;
2. an existing source `PhysicsObject` with explicitly authored antenna or
   conductor presentation type and shared geometry/material references;
3. an existing complete charge-only `CurrentTransport` bound to that object;
4. valid referenced terminal selectors on conductor boundary faces;
5. finite signed branch weights summing to zero;
6. explicit return conductors and a complete conservative-current closure;
7. one or more target objects or Airbox/inspection sampling targets;
8. a solved-drive reference to an earlier compatible published field solution;
9. finite peak currents and canonical waveform parameters;
10. an explicit time-origin policy.

Normalization converts convenience symmetric CPW definitions to explicit
terminal references and weights. It must not copy geometry, conductivity or
terminal definitions into the antenna layer and must not invent a missing
return path.

The current mapping below covers the principal thin-contract bindings. It is
not yet the complete parameter inventory required for T18 publication; the
remaining fields of the stage, projection, waveform, activation and spectrum
types must be indexed against the public constructors and `ProblemIR`.

### Tożsamość obiektu pomocniczego w Python i eksporcie sceny

`object_id` identyfikuje obiekt, `name` jest nazwą użytkownika, a
`geometry_id` wskazuje osobny zasób geometrii. Nie wolno zastępować nazwy
przez ID jako obejścia błędu eksportu. Opcjonalne keyword-only `object_id`
w `fm.geometry_object`, `fm.antenna_object`, `study.geometry_object`,
`study.conductor` i `study.antenna_object` zachowuje kompatybilność: bez
jawnego ID identyfikator pozostaje równy nazwie. Jawny ID jest zachowywany
przy eksporcie i ponownym capture, także po zmianie nazwy; referencje portów,
transportu i projekcji nie są przepisywane na etykietę. Istniejący namespace
geometrii, regionów i masek nadal używa `geometry_name`, nie `object_id`.

Stan autorski przenosi mapę `auxiliary_geometry_object_ids` z nazw geometrii
na ID do `Problem`; brak wpisu oznacza legacy ID równe nazwie. Mapę obejmuje
sygnatura scenariusza, aby eksport nie zgubił zmiany ID między etapami.
Rejestracja odrzuca kolizję ID z magnesem lub innym obiektem pomocniczym
przed zmianą stanu. `Problem` odrzuca nieznane klucze mapy i powtórzone ID.
Samo `type="antenna"` nie dodaje transportu, pola, LLG ani etapu obliczeń.

Źródła kontraktu: `packages/fullmag-py/src/fullmag/world.py` +
`geometry_object`, `packages/fullmag-py/src/fullmag/model/problem.py` +
`Problem.to_ir`, `packages/fullmag-py/src/fullmag/model/physics_scope.py` +
`build_physics_graph`, `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
+ `_export_auxiliary_geometry_entry`, `_render_scene_document_bootstrap`,
`_render_geometry_and_materials`, `_render_geometries_from_override`, `_stage_signature`.
Regresja: `packages/fullmag-py/tests/test_auxiliary_object_identity.py`.
To kontrakt authoring/capture wspólny dla FDM CPU, FDM GPU, FEM CPU i FEM GPU,
nie dowód kwalifikacji solvera. Migracja Rust legacy v0.3 → v0.4 wymaga
osobnej bramki zachowania ID; dotychczas wylicza ID geometrii pomocniczej.

Dowód bieżących źródeł: interpretowane `AuxiliaryObjectIdentityTests` —
11/11 PASS, bez solvera i kompilacji testów natywnych. Poprzednia próba
wykryła utratę ID w `_render_geometries_from_override`; po naprawie
przechodzą bootstrap, final export, capture, rename i zachowanie translacji.
Pełna rzeczywista scena revision 5 nadal jest odrzucana przez
`_scene_antenna_stage_sequence`: `antenna_field_solve_stages contains
definitions without an authored action`. Nie usunięto tych definicji ani
nie zmieniono ID/nazwy jako obejścia. Round-trip wszystkich portów,
transportu, projekcji i etapów tej sceny pozostaje **NOT VERIFIED**;
zmiana źródeł Python nie jest dowodem wdrożenia do działającego pakietu.

(antenna-authoring-inventory-execution-separation)=
### Obowiązkowe rozdzielenie deklaracji od aktywacji — kontrakt wdrożenia

**Stan: źródłowe WIP, runtime niezakwalifikowany.** Typowany
`AntennaAuthoringInventory` oddziela cztery kolekcje deklaracyjne od stanu
wykonania; publiczne metody `StudyBuilder.declare_*` nie dodają action ani
aktywnego drive. `test_antenna_authoring_inventory.py` ma 11 interpretowanych
regresji PASS: definitions-only, snapshots przed/po aktywacji, samodzielna
projekcja, eksport/reimport oraz błędne referencje. Nie wykonują solvera.
Pełny authoring w `workspace_problem` nie dowodzi jeszcze zachowania całego
requested intent w runtime provenance; tej bramki nie zamykamy.
Odczyt rzeczywistej scene revision 5
potwierdza jeden port, jedną definicję solve i brak projekcji, drive'ów oraz
FFT; `study_pipeline` jest `null`. Brak action nie pozwala dopisać action
z domysłu ani zgubić definicji. Problem dotyczy jednak całego inventory,
nie wyłącznie tego pojedynczego solve.

Zakazane obejście: `declare_only=True` dopisujące drive do aktywnego
`Problem.solved_antenna_drives`, lecz pomijające `CapturedStage`.
`LoadedProblem.pipeline_base_problem` usuwa obecnie tylko ID odnalezione
w actions. W `crates/fullmag-cli/src/orchestrator.rs` +
`run_script_mode` niescheduled drive przechodzi filtr
`!scheduled || activated`. Taki drive nie staje się pasywny przez brak
action ani przez `auto_execute_stages=False`.

Implementacja posiada źródłowo jawny, typowany owner deklaracji oddzielony od
stanu wykonania. Nie może to być blob w `runtime_metadata`, zmiana authored
`enabled` na `False`, dodatkowy fikcyjny drive dla projekcji ani kopia
niekanonicznej fizyki w rendererze. `world.py::capture_workspace_problem`
zachowuje execution state, a `capture_antenna_authoring_inventory` zwraca
oddzielny immutable inventory. Loader składa pełny authoring snapshot,
natomiast `LoadedProblem.pipeline_base_problem` usuwa nieaktywne deklaracje
z root execution IR. Renderery emitują niewykorzystane definicje przez
`_render_antenna_inventory_declarations`, nie przez fikcyjne etapy.
Scene5 przechodzi dawne blokady ID i braku actions, lecz nadal jest odrzucana
przez publiczny konstruktor solve z powodu faktycznie pustego `target_refs`.
Nie filtrujemy definicji ani nie dopisujemy celu w eksportującym helperze.

| Granica | Wymagana semantyka | Dowód odbioru |
|---|---|---|
| Konstruktor/capture | Typowane definicje portów, solve, projekcji, drive i spectrum trafiają do authoring inventory; deklaracja nie generuje action ani nie ustawia `wait_for_solve` | definitions-only capture: zero actions, zero wykonania, pełne inventory |
| Workspace/scena | Pełne inventory pozostaje w kanonicznym authoringu i eksporcie; istniejąca scena nie wymaga aktywnego pipeline | actual scene5 → Python → capture → scena, bez filtrowania kolekcji |
| Run/Relax snapshot | Wyłącznie aktywowane drives; przyszłe lub nigdy nieaktywowane deklaracje nie trafiają do RHS | declaration → Run; Run → activation → Run; future drive po wcześniejszym Run |
| Root execution IR | Nie podstawiać pełnego authoring snapshot jako execution base; requested definitions zachowane przez authoring owner, nie jako aktywne pola | `LoadedProblem.to_ir` i `export-run-config` bez nieaktywnych drives, bez solvera |
| Action | Jawne odwołanie do wcześniejszej definicji; identyczne payload/ID użyte ponownie bez duplikowania; sprzeczne odrzucone atomowo | conflict/reuse, dangling ref, kolejność solve/output/projection/drive/spectrum |
| Projekcja | Może istnieć samodzielnie, bez drive; zachowuje target ID i solution ref | standalone projection capture/export i brak dołączonego pola |
| Skrypt finalny | Trzy ścieżki renderowania zachowują pełne inventory oraz dokładnie authored actions; nie syntetyzują Run/Relax/solve/FFT | bootstrap, override i loaded final export, mixed declarations/actions |
| Runtime Rust | Materializacja etapów otrzymuje wyłącznie stan wykonania; brak action nie może oznaczać implicit activation nowego declaration-only inventory | managed runtime przed i po jawnej aktywacji, pola/bazy i kolejność etapów |

Stary publiczny workflow aktywnego `add_solved_antenna_drive` pozostaje
kompatybilny. Nowe nieaktywne deklaracje wymagają jawnej semantyki; nie wolno
globalnie zmienić zachowania wszystkich legacy unscheduled drives bez
migracji. Powyższe dotyczy authoringu wspólnie dla FDM CPU/GPU i FEM CPU/GPU;
odbiór pola/LLG wymaga oddzielnych dowodów każdej realizacji. Żadnej bramki
wykonania nie zastępuje zgodność JSON ani zielony test konstruktora.

(antenna-execution-config-inventory)=
#### Typowany transport deklaracji do materializera

Execution config posiada opcjonalne pole `antenna_inventory`, oddzielone od
aktywnego `ir`. Brak pola oznacza pusty owner i zachowuje historyczny kontrakt.
Python serializuje go z `AntennaAuthoringInventory` tylko dla niepustych
deklaracji; Rust odbiera jako `ScriptAntennaAuthoringInventory`. Nie jest to
blob w `runtime_metadata` ani dodatkowa lista etapów.

| Pole ownera | Typ | Default | SI unit | Walidacja i znaczenie | Destination |
|---|---|---|---|---|---|
| `antenna_field_solve_stages` | lista `AntennaFieldSolveStageIR` | `[]` | $1$ | unikalne ID; definicje dostępne przy jawnej akcji solve, nie implicit solve | `ScriptExecutionConfig.antenna_inventory` |
| `antenna_target_projections` | lista `AntennaTargetProjectionRefIR` | `[]` | $1$ | unikalne ID; zgodność jawnego payloadu z deklaracją | `ScriptExecutionConfig.antenna_inventory` |
| `solved_antenna_drives` | lista `SolvedAntennaDriveIR` | `[]` | $1$ | unikalne ID; deklaracja nie trafia do RHS bez aktywacji | `ScriptExecutionConfig.antenna_inventory` |
| `antenna_spectrum_requests` | lista `AntennaSpectrumRequestIR` | `[]` | $1$ | unikalne ID; deklaracja nie uruchamia analizy | `ScriptExecutionConfig.antenna_inventory` |

Jednostka $1$ dotyczy kolekcji jako kontraktu transportowego; jednostki ich
parametrów fizycznych pozostają określone w tabelach odpowiednich typów powyżej.
Nie zmieniają się równania pola ani interpretacja FDM CPU/GPU i FEM CPU/GPU.
Nieznane pola ownera i powtarzające się ID są odrzucane. Przy włączonej akcji
solve materializer wybiera wyłącznie wskazaną definicję, sprawdza konflikt ze
stanem aktywnym i planuje na tymczasowym stanie. Dopiero udane planowanie
publikuje stan etapu. Wyłączony liść lub grupa nie importują definicji.
Drive/projekcja/spectrum zachowują dotychczasowy typowany payload akcji;
jeżeli istnieje deklaracja tego samego ID, payload musi być identyczny.

Źródła kontraktu: `packages/fullmag-py/src/fullmag/model/antenna_inventory.py`
+ `AntennaAuthoringInventory.to_ir`,
`packages/fullmag-py/src/fullmag/runtime/run_config_export.py` +
`export_run_config`, `crates/fullmag-application/src/script_stage_contract.rs`
+ `ScriptAntennaAuthoringInventory`, oraz
`crates/fullmag-application/src/script_stage_materialization.rs` +
`materialize_script_stages_with_stage_limit` i `walk_study_pipeline_nodes`.
Regresja `test_execution_config_carries_typed_inventory_without_active_root_fields`
w `packages/fullmag-py/tests/test_antenna_authoring_inventory.py` sprawdza
rzeczywisty eksport sceny bez solvera. Odbiór wykonania Rust/managed runtime
pozostaje **NOT VERIFIED** do odrębnego uruchomienia właściwych bramek.

Źródła obecnej granicy: `packages/fullmag-py/src/fullmag/world.py` +
`CapturedStage`, `capture_workspace_problem`, `_build_problem`;
`packages/fullmag-py/src/fullmag/runtime/loader.py` + `class LoadedProblem`;
`packages/fullmag-py/src/fullmag/runtime/script_builder.py` +
`_scene_antenna_stage_sequence`, `export_builder_draft`;
`crates/fullmag-cli/src/orchestrator.rs` + `run_script_mode`.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `StudyBuilder.declare_antenna_field_solve.definition` | `AntennaFieldSolveStage` | required; keyword-only | `$1$` | błędny typ: `TypeError`; duplikat ID, konflikt payload lub brak dokładnie jednego `H_ant_basis`: `ValueError` | zwraca definicję; nie planuje solve ani LLG | backend-neutral authoring; wykonanie czterech realizacji osobno niezakwalifikowane | authoring `antenna_field_solve_stages[]`; brak action i nieaktywnej definicji w root execution IR |
| `StudyBuilder.declare_antenna_target_projection.projection` | `AntennaTargetProjection` | required; keyword-only | `$1$` | błędny typ: `TypeError`; duplikat/konflikt ID, nieznany solve lub output inny niż `H_ant_basis`: `ValueError` | zwraca projekcję; bez wymaganego drive | backend-neutral authoring; runtime niezakwalifikowany | authoring `antenna_target_projections[]`; nieaktywny wpis wyłączony z execution base |
| `StudyBuilder.declare_solved_antenna_drive.drive` | `SolvedAntennaDrive` | required; keyword-only | $1$; parametry prądu w A i czasu w s w typie drive | błędny typ: `TypeError`; duplikat/konflikt ID, nieznana projekcja lub port spoza solve: `ValueError` | zwraca drive; nie dołącza pola do RHS | backend-neutral authoring; runtime niezakwalifikowany | authoring `solved_antenna_drives[]`; nieaktywny wpis wyłączony z execution base |
| `StudyBuilder.declare_antenna_spectrum_request.request` | `AntennaSpectrumRequest` | required; keyword-only | $1$; jednostki próbkowania w typie request | błędny typ: `TypeError`; duplikat/konflikt ID lub output ID, nieznany solve/output lub port: `ValueError` | zwraca request; nie uruchamia FFT ani nie oznacza odpowiedzi fal spinowych | backend-neutral authoring; runtime niezakwalifikowany | authoring `antenna_spectrum_requests[]`; brak action, nieaktywny wpis wyłączony z execution base |
| `geometry_object/antenna_object/conductor.shape` | obiekt geometrii | required | `$1$`; parametry geometrii w `$\mathrm m$` | wymagane niepuste `geometry_name`; błędny obiekt: `TypeError` | istniejący zasób geometrii, bez aktywacji fizyki | authoring/capture wspólne dla czterech realizacji, nie kwalifikacja solvera | `geometry.entries[]`, `physics_objects[].geometry_id` |
| `geometry_object/antenna_object/conductor.name` | `str` | odpowiednio `object` / `antenna` / `conductor` | `$1$` | trim, niepusty; duplikat nazwy geometrii odrzucony przez `ValueError` | nazwa użytkownika i obecny namespace geometrii | authoring/capture wspólne dla czterech realizacji | `physics_objects[].name`, nazwa zasobu geometrii |
| `geometry_object/antenna_object/conductor.object_id` | `str \| None` | `None` → nazwa geometrii | `$1$` | trim, niepusty i unikalny także względem magnesów; `ValueError`; keyword-only | stabilna tożsamość niezależna od etykiety | authoring/capture wspólne dla czterech realizacji; migracja Rust legacy osobno niezweryfikowana | `physics_objects[].object_id`; scena `objects[].id` |
| `geometry_object.type` | `str` | `geometry` | `$1$` | trim/lower; `geometry`, `conductor`, `electrode`, `antenna`; inne: `ValueError` | wyłącznie typ prezentacyjny; wrapper conductor/antenna ustawia go jawnie | authoring/capture wspólne dla czterech realizacji | `physics_objects[].type`, bez automatycznych modułów |
| `Problem.auxiliary_geometry_object_ids` | `Mapping[str, str]` | `{}` → legacy ID = nazwa | `$1$` | niepuste nazwy i ID, klucze istniejących obiektów pomocniczych, globalna unikalność ID; `ValueError` | przeniesienie identity przez snapshot/capture | authoring/capture wspólne dla czterech realizacji | nazwa klucza → `geometry_id`; wartość → `object_id` |
| `EquipotentialCurrentTerminal.id` | `str` | required | `$1$` | nonempty stable id; dedicated antenna current solve only | stable equipotential terminal identity | FEM CPU/double source implemented, runtime unqualified; other lanes unsupported | `current_modules[].definition.boundaries[kind=equipotential_current_terminal].id` |
| `EquipotentialCurrentTerminal.surfaces` | `tuple[SurfaceRef, ...]` | required | `$1$` | nonempty surface set; disjoint terminal H1 dofs | selector whose signed total current is supplied by the port | FEM CPU/double source implemented, runtime unqualified; other lanes unsupported | `current_modules[].definition.boundaries[kind=equipotential_current_terminal].surfaces` |
| `CurrentTransport.gauge=terminal_reference` | `str` | required for current-constrained antenna solve | `$1$` | one reference terminal per connected conductor component; no voltage electrode overlap | remove potential nullspace without imposing a physical terminal current | FEM CPU/double source implemented, runtime unqualified; generic standalone voltage solve unsupported | `current_modules[].definition.gauge` |
| `AntennaPortMode.source_object_id` | `str` | required | `$1$` | nonempty; ProblemIR validation requires a referenced conductor or antenna physics object | stable conductor-source identity without copied geometry | backend-neutral authoring; execution remains capability-scoped | `antenna_port_modes[].source_object_id` |
| `AntennaPortMode.current_transport_id` | `str` | required | `$1$` | nonempty; ProblemIR validation requires a compatible charge-only transport on the source | owner of solved electric potential and conventional current | FEM CPU/double initial reference lane | `antenna_port_modes[].current_transport_id` |
| `AntennaPortBranch.signed_weight` | `float` | required | `$1$` | finite; one mode requires positive weights summing to one, negative return and total zero within 1e-12 | signed current share relative to the common positive orientation | backend-neutral contract | `antenna_port_modes[].branches[].signed_weight` |
| `SolvedAntennaDrive.peak_current_a` | `float` | required | `$\mathrm A$` | finite; zero disables the drive without invalidating the spatial basis | signed peak multiplying the immutable per-ampere field basis | lane-specific artifact consumer | `solved_antenna_drives[].peak_current_a` |
| `AntennaSpectrumRequest.sampling_plane` | `AntennaSpectrumSamplingPlane` | required | m for origin/extents; 1 for counts and frame | orthonormal in-plane axes, positive extents, at least two samples per axis; current executable lane requires valid tet4 P1 topology or unique identity-coordinate carrier matches and fails closed for unsupported interpolation | centred physical lattice on which the per-ampere source field is sampled before the spatial Fourier transform | immutable FEM antenna asset with tet4 P1 or legacy identity sampling; FDM trilinear, direct RT0 evaluation, mixed topology, and native MFEM transfer remain explicitly unsupported | `antenna_spectrum_requests[].sampling_plane` |
| `AntennaSpectrumRequest.port_mode_id` | `str | None` | `None` | `$1$` | when present, nonempty and bound to the solve stage; omission is valid only when the solve has exactly one port | selects the immutable per-ampere field basis used by source-spectrum analysis | immutable FEM antenna asset; multi-port assets require explicit selection | `antenna_spectrum_requests[].port_mode_id` |
| `AntennaSpectrumRequest.component` | `str` | required | `$1$` | one of `x`, `y`, `z`, `u`, `v`, `normal`, `vector_power`, `transverse`; Python and ProblemIR reject `transverse` until certified equilibrium loading and projection exist | selects the analysed field component or vector power | Cartesian/local-frame source spectra supported for certified FEM carrier; `transverse` unsupported | `antenna_spectrum_requests[].component` |
| `AntennaSpectrumRequest.equilibrium_ref` | `str | None` | `None` | `$1$` | valid only for `component="transverse"`; Python and ProblemIR reject that component until certified equilibrium loading and projection exist | identifies the equilibrium needed for the pointwise transverse source-field projection | unsupported in executable spectrum lane | `antenna_spectrum_requests[].equilibrium_ref` |
| `AntennaSpectrumRequest.mode_basis_ref` | `str | None` | `None` | `$1$` | any nonempty value is rejected by Python and ProblemIR until verified modal analysis exists | reserved identity of a future modal basis, not a source-field spectrum coefficient | unsupported in executable spectrum lane | `antenna_spectrum_requests[].mode_basis_ref` |

(The optional `AntennaSpectrumRequest.port_mode_id` selects the immutable
per-ampere basis used by the source-spectrum transform. It may be omitted only
when the solve stage has exactly one port; a multi-port asset must name one of its
solved port modes. The value is recorded in the spectrum provenance and never
changes the solved field itself.

(antenna-planner-capability-impact)=
### 8.4 Planner and execution selection

The field-solve stage and the downstream LLG stage have separate requested and
resolved execution records. An FDM LLG request may resolve its antenna
precomputation to FEM CPU only when that cross-discretization state transfer is
explicit in the plan and provenance.

Initial capability target:

**Evidence status (2026-10-03):** the source implementations now include
FEM CPU field precomputation, immutable field-basis publication, projection to
FEM nodes and certified FDM cell centres, and downstream CPU/GPU drive paths.
This is not a qualified four-lane capability matrix: the managed native runner
has no container configuration on the current host, and a complete public
solve-to-LLG trajectory, device parity, and field-map observation have not
been verified. The table below describes the intended allocation of work,
not an availability promise.

| Capability | FDM CPU reference | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| Tier 1 field solve | consumes artifact only | consumes artifact only | reference then production solve | unsupported initially |
| Tier 1 drive consumption | reference oracle | after double parity | production | after double parity |
| Tier 0 regional drive | current partial reference | deferred until implemented | deferred until native implementation | deferred until native implementation |
| local source k-spectrum | backend-neutral artifact analysis | same artifact | backend-neutral artifact analysis | same artifact |

(antenna-round-trip-and-failure-semantics)=
### 8.5 Round-trip and failure semantics

Python and UI authoring preserve the **requested intent**: object, transport,
terminal references, signed weights, waveform, target and requested execution.
The planner records **resolved execution** separately, including backend,
device, precision, operator and projection realization. Round-trip export must
not replace either record with the other.

Dangling references, stale solution digests, invalid terminal balance and
unsupported lanes produce typed **validation errors**. **Unsupported combinations**
fail closed; they do not trigger a hidden antenna solve, a regional-field
fallback, CPU fallback, or synthetic spin transport.

Forced unsupported lanes fail clearly. `auto` may resolve the Tier 1 field solve
to FEM CPU, but it preserves both requested downstream discretization and
resolved precompute lane.

## 9. Runtime, OpenAPI, and unified workspace impact

The exact resource and module contract is specified in
`docs/superpowers/specs/2026-07-10-microwave-antenna-field-basis-design.md`.
Physics-level obligations are:

1. `AntennaFieldSolve` appears as a real stage in
   `simulation/stages/execution`;
2. field solutions are named, revisioned resources, not hidden runner cache;
3. heavy $V$, $\mathbf J$, and $\mathbf H$ payloads use the binary data plane;
4. standard field slice/projection resources visualize the field on either the
   field-sampling domain or a magnetic target projection;
5. the UI exposes exact stale reasons and requested/resolved execution;
6. HTTP v2 remains authoritative and websocket events only invalidate changed
   resources;
7. one unified Explorer, ribbon, inspector, and viewport tree serves FDM and
   FEM;
8. the 3D viewport shows procedural layout intent before meshing and realized
   conductor topology after solve;
9. an active-only `field-map` center surface owns interactive heatmaps,
   contours, probes, and slices without keeping the 3D WebGL canvas mounted;
10. source k-spectrum and dynamic structure factor are labeled as distinct
    analysis products.

(antenna-validation)=
## 10. Validation strategy

### 10.1 Analytical current and field checks

1. Uniform straight bar: $V$ is linear along the bar and integrated current is
   constant across transverse cuts.
2. Infinite-wire far field: $H_\varphi\to I/(2\pi r)$ away from a sufficiently
   long finite fixture.
3. Rectangular strip symmetry: field components have the expected parity about
   conductor center planes.
4. CPW balance: signal and ground terminal currents sum to zero and the far
   field decays faster than an unbalanced single conductor.
5. Linearity: doubling the authored current doubles `H_ant` and Zeeman drive
   while leaving the stored per-ampere basis unchanged.

### 10.2 Mesh and quadrature convergence

Run at least three conductor-mesh levels. Track:

- terminal current imbalance;
- $L^2$ change in $\mathbf J$ away from geometric corners;
- $L^2$ and $L^\infty$ changes in $\mathbf H$ on fixed observation surfaces;
- convergence of source-spectrum peak locations;
- sensitivity to near-field quadrature tolerance.

Corner-current density may be singular in the ideal sharp-edge model. Pointwise
$\mathbf J$ at a sharp corner is not a convergence target; integrated current,
field away from the corner, and spectrum peaks are.

### 10.3 Cross-lane checks

1. FDM CPU and FEM CPU consume the same field artifact at matched physical
   points and agree within interpolation error.
2. FDM GPU matches FDM CPU in double precision for static `H_ant`, waveform
   samples, and a short LLG trajectory.
3. FEM GPU matches FEM CPU for the same quantities before promotion.
4. Artifact reload produces the same field hash and LLG result as an in-memory
   solution.
5. Changing only the waveform reuses the solution; changing one geometry
   station makes it stale.

### 10.4 Spin-wave benchmark

The publication-aligned benchmark uses a thin YIG waveguide and two CPW
profiles whose wide and constricted sections place a chosen $k$ near a source
spectrum minimum and maximum respectively. Acceptance evidence includes:

- `local_k_spectrum` localizing the selected $k$ to the constriction;
- a time-domain $S_m(k,\omega)$ ridge compatible with an independently
  calculated dispersion;
- a beam or localized source region in the dynamic magnetization map;
- correct qualitative changes when width/gap stations are varied;
- explicit statement that propagation length is not validated from a fixture
  using artificially reduced damping.

The primary literature targets are Gruszecki et al. for localized CPW beam
excitation and Höfinger et al. for realistic vector-field k weighting. Absolute
transduction efficiency is not an acceptance metric for Tier 1.

### 10.5 UI and API checks

1. CPW stations round-trip Python -> ProblemIR -> scene -> exported Python.
2. Geometry, terminal, and field-solve edits invalidate only their documented
   signatures; waveform edits do not stale the field solve.
3. Slice/projection resources work for the field-sampling domain and FDM/FEM
   target projections with ETag/304 behavior.
4. The heatmap displays component, magnitude, $\mu_0H$ unit transform,
   contours, probe, and empty-mask status correctly.
5. Explorer selection maps every antenna child node to a dedicated Inspector.
6. `field-map` and `viewport-3d` obey active-only lifecycle and bounded-memory
   tests.
7. Browser smoke proves a visible 3D canvas with a live WebGL context when 3D
   is active and no 3D canvas when `field-map` is active.

(antenna-completeness-checklist)=
## 11. Implementation status and completeness checklist

This note is implementation-ready as a physics contract. It does not claim the
new Tier 1 path is implemented.

- [x] physical problem and fidelity decision
- [x] governing equations and SI units
- [x] validity limits and prohibited claims
- [x] variable-width microstrip/CPW geometry semantics
- [x] return-current and port-mode semantics
- [x] per-ampere normalization
- [x] FDM interpretation
- [x] FEM interpretation
- [x] CPU/GPU separation
- [x] source-spectrum and dynamic-response distinction
- [x] Python and ProblemIR target
- [x] planner and runtime-stage impact
- [x] artifacts, quantities, provenance, API, and UI impact
- [x] validation strategy
- [ ] Python/ProblemIR implementation (current-terminal authoring source exists; full workflow qualification remains)
- [ ] native FEM CPU field solver
- [ ] FDM/FEM field-basis consumers
- [ ] GPU parity
- [ ] OpenAPI and control-room implementation
- [ ] publication benchmark artifacts

(antenna-limitations)=
## 12. Deferred work

### 12.1 Bieżąca blokada produkcyjna: wspólne źródło V/J/H

Audyt źródeł z 2026-10-03 wykazał, że
`crates/fullmag-runner/src/native_fem/charge_transport.rs` +
`execute_native_fem_charge_transport` publikuje V/J i zmierzony prąd z
`solve_native_fem_charge_transport`, natomiast H i certyfikat RT0 pochodzą
z osobnego wywołania `solve_native_fem_steady_transport_rt0`.
Przekazanie rozwiązanych napięć przez `charge_request_for_rt0` nie dowodzi
wspólnego solve: `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` +
`solve_rt0` wykonuje dla `closed_geometry` nowy periodic charge solve
sterowany `source_cut.potential_drop_v`. Dla `external_lead_extension`
`backends/fem/cpu/mfem/transport/conservative_current_view.cpp` +
`ConservativeCurrentView::Build` wykonuje charge solve na połączonej
domenie device+lead, sterowany `outer_electrode_potential_drop_v`.
Bilans tego RT0 nie poświadcza zgodności z prądem pierwszego solve.
Nie można zatem uznać normalizacji całego zestawu V/J/H tym pierwszym
prądem za wykonaną realizację kontraktu bazy per ampere.

Kontrprzykład wynika z liniowego przepływu danych, nie z wykonanego testu:
przy niezmienionym porcie integral-current zmiana wyłącznie napięcia closure
może zmienić H, pozostawiając publikowane V/J i dzielnik normalizacji
niezmienione. Regresja musi obejmować cały producent artefaktu, a nie jedynie
RT0 lub zgodność hashy. Wynik `NativeFemSteadyTransportRt0Result` sprzed
kroku snapshotu nie eksportował V ani J z charge solve closure; obecny
adapter odbiera V, ale nie zastępuje legacy J ani prądu normalizacji. Normalizacja
wyłącznie H na podstawie jego strumienia nie naprawi wspólnego pochodzenia
V/J/H ani zadanych proporcji returnów.

Wymagane domknięcie T05/T06: jeden zaakceptowany charge snapshot pełnej
trójwymiarowej domeny przewodnika i zamknięcia, podpisane ograniczenia prądu
każdego portu, RT0 z tego snapshotu i H z tego samego RT0. Native workflow
oraz append-only ABI muszą przenieść V, jawnie zlokalizowane J, podpisane
prądy terminalowe i wspólną tożsamość zaakceptowanego źródła. Rust pozostaje
właścicielem orkiestracji, nie solvera MFEM. Wariant wielu niezależnych
cutów wymaga rzeczywistego układu odpowiedzi cut/terminal→prąd; obecne
ograniczenie `solve_rt0` do jednego source cut nie realizuje ogólnego
CPW z niezależnie zadanymi returnami. Taper nadal wymaga pełnego 3D.
Ta blokada jest obowiązkową pracą produkcyjną, nie opcjonalnym przyszłym
rozszerzeniem fizyki.

Krok przygotowawczy z 2026-10-03: `ConservativeCurrentView::Build`
zachowuje własną kopię węzłowego potencjału charge solve użytego do
rekonstrukcji RT0. `charge_potential_vertex_values_v()` zwraca wartości
w woltach w kolejności wierzchołków własnej siatki;
`stable_vertex_identities()` identyfikuje tę kolejność. Kopiowanie korzysta
z `copy_charge_potential_vertices` i mapy `GetVertexDofs`, nie z założenia
vertex=DOF. Wariant external obejmuje device i wszystkie leady.
`ConservativeCurrentView::Import` nie otrzymuje potencjału i zwraca
`nullptr`, zamiast tworzyć pozorne V. Aktualny broadcast MPI importuje RT0
na rangach innych niż zero bez tego payloadu; nie jest jeszcze transportem
wspólnego V/J/H. Legacy entrypointy i producent artefaktu nie
eksportują nowego payloadu. Retencja danych nie usuwa powyższej blokady.
Regresje w `backends/fem/tests/conservative_current_view_contract.cpp` +
`identity_and_source_snapshot_are_immutable`,
`certified_imported_rt0_is_accepted_and_deep_owned` oraz
`coupled_volumetric_external_lead_extension_is_accepted` sprawdzają własność,
brak sfabrykowanego V i analityczny potencjał połączonej domeny.
Są to zmiany źródeł testów, bez wykonanego testu natywnego: obowiązuje
tymczasowy zakaz kompilacji testów jednostkowych. Zlecone wcześniej buildy
nie zawierają tego kroku i nie mogą być jego dowodem.

Implementacja źródłowa kolejnego kroku ABI: nowy
`fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1` przekazuje
własne V, stable IDs i współrzędne węzłów w kolejności siatki RT0 oraz
`source_view_identity_digest`. Nowe symbole `*_with_charge_snapshot_v1`
przyjmują wynik pomocniczy obok niezmienionego wyniku RT0/OE-F1/OE-F2.
Nie zmienia się layoutów istniejących wersji. Pojemności nowego payloadu
są sprawdzane przed zapisem RT0, a jego długości publikowane dopiero po
powodzeniu całego solve pola; każdy błąd zeruje długości obu poprawnie
adresowanych wyników i tożsamość źródła. Nie wolno odczytywać payloadów
po niezerowym statusie: bufory callerów mogą być częściowo zapisane.
Wynik z nagłówkiem deklarującym mniejszy layout jest odrzucany bez zapisu
poza zadeklarowany rozmiar. Wartości V mają jednostkę wolta,
współrzędne metra. Jest to eksport źródła, nie certyfikat zgodności
prądów z portem: podpisane ograniczenia portowe i wspólny producent
artefaktu pozostają obowiązkową częścią T05/T06.
Native właścicielem eksportu jest
`backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` + `solve_rt0`;
`call_with_charge_snapshot` waliduje nagłówek i resetuje wynik pomocniczy
po błędzie. Deklaracje Rust odpowiadają strukturze
`crates/fullmag-fem-sys/src/lib.rs` +
`fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1`.
Regresje ABI w `backends/fem/tests/steady_transport_rt0_contract.cpp` +
`run_closed_geometry_rt0_contract` oraz test layoutu Rust pozostają
nieuruchomione. Parser Rust przeszedł; to nie jest dowód kompilacji,
zgodności ABI w wykonaniu ani bramka naukowa. Build
`9a47e3713ca444e9ba05599af7fc331f` powstał przed
zmianami ABI i nie może ich weryfikować.

Źródłowy adapter `crates/fullmag-runner/src/native_fem/steady_transport.rs` +
`solve_native_fem_steady_transport_rt0` korzysta już z nowych entrypointów,
również bez żądania pola. Zwraca `NativeFemChargePotentialSnapshot` na całej
domenie device+lead. `validate_charge_potential_snapshot` wymaga liczności,
dokładnej kolejności IDs i współrzędnych zgodnej z wejściową siatką,
skończonych V/xyz, unikalnych IDs, wersji `stable_mesh_vertex_u64.v1` i
64-znakowego małego hex digestu równego RT0. Bufory V/xyz startują z NaN,
aby fałszywie zadeklarowany kompletny wynik nie ukrył niewypełnionego ogona.
Pojemności używają sprawdzanej arytmetyki. OE-F2 alokuje ND/H1/RT/H na
połączonej domenie; nie jest to certyfikat próbkowania H na docelowym obiekcie
ani airboxie. Producent nadal publikuje legacy V/J i dzielnik normalizacji:
nowe odebrane V nie usuwają blokady wspólnego źródła ani braku ograniczeń
portowych. Regresje `charge_snapshot_consumer_rejects_inconsistent_combined_payload`
oraz `external_lead_public_rt0_adapter_solves_one_coupled_volumetric_circuit`
pozostają źródłowe, bez kompilacji i wykonania.

Dalszy audyt natywny ujawnił dwie odrębne bramki, których retencja V ani
eksport ABI nie naprawiają. `PeriodicChargePotentialSolver::Solve` w
`backends/fem/cpu/mfem/transport/periodic_charge_potential.cpp` ma nadal jeden
cut w request, lecz zleca H1 do nowego `solve_charge_trace_workspace`.
W źródłach geometryczny lift został
zastąpiony przez `reduce_affine_trace_relations` z
`backends/fem/cpu/mfem/transport/affine_trace_relations.hpp`: graf relacji
DOF wyznacza quotient i lift, sprawdza wszystkie cykle oraz każdą relację
po konwersji do `double`. Skala akceptacji zależy od żądanego skoku danej
relacji, nie największego skoku innego komponentu. Operator przyjmuje wiele
relacji z niezależnymi skokami, ale publiczny request nadal ma jeden cut.
Ta zmiana nie realizuje publicznego wielocutowego sterowania port-current.
Workspace wyznacza niezależne gauge komponentów po identyfikacji trace,
lecz nie wystarczy dołożyć pętli wywołań jednocutowego solvera, aby
uzyskać docelową odpowiedź niezależnych prądów gałęzi.
Operator nie określa łączności elektrycznych objętości, gauge ani prądów
portowych; jest etapem budowy affine trace, nie drugim solverem H1.
Jego canonical lift przyjmuje zerowy offset najniższego pełnego DOF każdej
klasy trace. Odmowa reprezentowalności dotyczy tego wybranego liftu w
`double`, nie dowodzi sprzeczności fizycznej relacji we wszystkich gauge.
Przyszły workspace musi jawnie rozróżnić tę odmowę od niezgodnego cyklu.
Regresja źródłowa `affine_trace_relations_preserve_independent_jumps_and_reject_cycles`
obejmuje niezależne dodatnie/ujemne skoki, permutację relacji, sprzeczny
cykl, błędny mały return, niezerowy self-jump, brak reprezentowalności
małego skoku na dużym offsecie i błędne dane. Nie kompilowano tego testu.

Źródłowy etap `ChargeTraceSolveRequest` / `ChargeTraceSolution` w
`backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.hpp`
oraz `solve_charge_trace_workspace` w sąsiednim `.cpp` realizuje H1 dla
podanych skoków i opcjonalnych napięciowych anchorów. Nie przyjmuje jeszcze
żądanych prądów portowych. Łączność objętości wyznacza z face adjacency;
współdzielony węzeł lub krawędź między rozłącznymi komponentami powierzchni
jest odrzucany jako niekwalifikowany kontakt. Relacje trace mogą jawnie
łączyć te objętości, bez heurystyki bliskości współrzędnych.
Gauge wybiera najniższy stable vertex ID każdego niezakotwiczonego
komponentu; komponent z podanym anchorem nie otrzymuje dodatkowego pin.
Zerowe wymuszenie pozostawia izolowany metal na stałym potencjale.
Result ma własne kopie V, nieeliminowanego K V, współrzędnych, stable IDs,
identyfikatorów komponentów, gauge i residuali. Nie zawiera referencji do
tymczasowego MFEM space ani borrowed materiału. Wartości są w kolejności
wierzchołków, przez jawne `GetVertexDofs`, a nie vertex=DOF.

Workspace składa K raz dla jednego napięciowego solve, ogranicza go do
wolnych quotient DOF, usuwa jawne anchor/gauge przez podstawienie i używa
MFEM CG/GSSmoother. Reakcje mierzy z oryginalnego K. Sprawdza normę
projektowanych reakcji wolnych DOF oddzielnie na każdym komponencie,
względem jego własnej normy RHS (numeryczny floor $10^{-30}\,\mathrm A$).
Przed pomiarem reakcji sprawdza ponownie każdą zadaną relację na końcowym
V, już po dodaniu anchorów i rozwiązania quotient. Tolerancja skoku
zależy od wartości tego skoku, nie wspólnego offsetu potencjału.
Kontroluje także końcowe anchory i zerowe gauge komponentów.
Jest to osobna bramka: przy wszystkich quotient DOF ustalonych nie ma
wolnych wierszy residualu, a offset $10^{20}\,\mathrm V$ może w `double`
zatrzeć skok $1\,\mathrm V$. Takiego wyniku nie wolno zwrócić jako poprawny.
Ta kontrola nie zastępuje tolerancji podpisanych prądów portowych ani
bilansu wszystkich terminali. Nie obsługuje ParMesh, nonconforming H1,
krzywizny, wyższych rzędów ani elementów innych niż straight tet4/P1;
σ i Jacobian weight muszą być skończone i dodatnie. Result nie ma jeszcze
pełnej accepted-source identity z constraint/material/mesh digestami;
nie jest samodzielnym opublikowanym assetem antenowym.

Późniejszy etap źródłowy wydziela `ChargeTraceWorkspace::Impl::solve`:
konstruktor składa K raz, przechowuje jego deep-copy wraz z mapami,
stable IDs i współrzędnymi, a kolejne solve przyjmują tylko wartości
skoków i anchorów. Nie dereferencjonują borrowed mesh/material.
`solve_charge_trace_workspace` pozostaje zgodnym wrapperem jednego solve.
Regresja `charge_trace_workspace_reuses_owned_operator_after_sources_are_destroyed`
sprawdza brak ponownego odczytu zmutowanej conductivity, rozwiązanie po
zniszczeniu wejść i niezmienność wcześniejszych owned V/reakcji.
Jest źródłowa i niekompilowana. Snapshot `8df9b8ef235d4eaa8402498347a3d033`
powstał przed tym refaktorem i nie może go kwalifikować.

Źródłowy `charge_current_response.cpp::solve_charge_current_response`
buduje jeden `ChargeTraceWorkspace` i deleguje do jawnego
`solve_charge_current_response_prepared`. Prepared core sprawdza ordered
stable IDs, topologię trace/anchorów i solver policy względem frozen
owner. Nie odczytuje borrowed mesh/material ponownie; request z innymi
metadanymi nie może podmienić przygotowanego problemu. Następnie
rozwiązuje wszystkie unit controls,
mierzy dodatnią macierz energetyczną, sprawdza common-mode, symetrię
i rząd w skali diagonalnej, następnie wykonuje finalny solve na tym samym K.
Nie symetryzuje macierzy, nie regularizuje i nie pomija rzędu przy zerowym
RHS. Próg scaled pivot wynosi `max(1e-10, 100 * algebraic_relative_tolerance)`;
zbyt luźna tolerancja H1 uniemożliwiająca taki gate jest odrzucana.
Przed unit solve `ChargeTraceWorkspace::Impl::is_component_constant_control`
rozpoznaje authored common-mode: wszystkie skoki są zerowe, a wartości
anchorów są jednakowe wewnątrz każdego komponentu. Stałe różnych
komponentów mogą się różnić. Kontrola korzysta z owned map łączności,
nie z zakresu przybliżonego V, więc błąd iteracyjnego solve nie tworzy
fałszywej dodatniej energii tego pojedynczego control. Regresja wymaga
tej konkretnej odmowy przy tolerancjach H1 1e-12 i 1e-3.
Kolejny etap źródłowy `validate_charge_control_rank` rozpoznaje również
ogólne zależne kombinacje: najpierw sprawdza dokładną wykonalność w pełnych
DOF, następnie rząd modulo stałe każdej pierwotnej objętości przed trace.
Używa dwóch kolejnych weighted union-find grafów, dokładnego decode
binary64 do `cpp_int` oraz gcd-normalized integer echelon.
`ChargeTraceWorkspace::Impl::original_volume_component_for_full_dof`
odczytuje owned mapę pierwotnych objętości, nie electrical quotient.
Kontrola poprzedza wszystkie jednostkowe solve; numerical energy gate
pozostaje osobną kontrolą uwarunkowania i dokładności. Ten nowy helper
nie należy do wcześniejszych snapshotów builda `8df9` ani `9c541`.
Obecny private response jest źródłowym etapem wdrożenia, nie solverem
kwalifikowanym do publicznego solve.
Sprawdza osobno przewidywane prądy z macierzy odpowiedzi, końcowe
`-U^T K V` i lokalną superpozycję V. Każdy signed current ma tolerancję
`1e-18 A + 1e-8 * abs(requested)`; nie skaluje jej prądem innej gałęzi.
Owned wynik zawiera control IDs, napięcia, prądy sprzężone, residuale,
macierz energetyczną w S, symmetry/pivot diagnostics oraz accepted V/K V.
Nie jest certyfikatem physical terminal flux, RT0 ani produkcyjnego CPW.
Publiczna ścieżka charge/closure nie jest jeszcze przełączona na ten owner.

Kolejny źródłowy `charge_terminal_current_constraints.cpp::solve_charge_terminal_current_constraints`
wiąże jawne stable-ID physical boundary faces z rzeczywistymi P1 DOF,
sprawdza ich rozłączność i Dirichlet face closure oraz odrzuca pełny
essential separator między elektrodami. Wybiera referencję przez
najmniejszy stable vertex ID na komponencie, sprawdza preflight bilansu,
używa jednego przygotowanego workspace i mierzy wszystkie terminale
oddzielnie z nieeliminowanego K V. Zwraca owned, zweryfikowane grupy
ścian wraz z podpisanymi prądami i residualami; nie tylko jedną stronę
portu ani globalny bilans. Dopuszcza zero-jump interfaces z rzeczywistymi
stable IDs, ale nie nonzero cut actuators ani trace-aliased electrodes.
Nie jest podłączony do nowego RT0-current ABI ani publicznego producenta
V/J/H. Stan pozostaje source-only; sukces wcześniejszego buildu nie
obejmuje tego kodu.

Regresje źródłowe
`charge_current_response_preserves_sign_and_independent_component_scales`
oraz `charge_current_response_uses_terminal_anchors_and_rejects_common_mode`
obejmują dwa rozłączne przewodniki o przewodnościach 4 i 0.0004 S/m,
podpisane prądy 1 i 0.0001 A, niezależne napięcia, odwrócenie orientacji,
zero RHS, zależne controls, odmowę hidden baseline, anchory terminalowe
i common-mode. Testy nie były kompilowane ani wykonywane.
Regresja `charge_current_controls_require_exact_rank_modulo_original_volumes`
obejmuje niewzbudzający skok między rozłącznymi objętościami, zgodne
anchory takich stałych, niezależne skoki wewnątrz objętości, dwie kolumny
różniące się o jeden krok binary64, współczynnik min-subnormal,
zależność ukrytą przez common-mode $2^{40}$, permutację controls/anchorów,
niespójny cykl DOF oraz odmowy budżetu liczby krawędzi i bitów pośrednich.
Sprawdzenie dokładnego rzędu near-binary64/subnormal nie jest dowodem
wykonalności takiego response solve w double. Regresja jest źródłowa,
niekompilowana i niewykonana.

Regresja `prepared_charge_current_response_reuses_owned_operator_and_checks_topology`
sprawdza jeden frozen operator po mutacji conductivity i zniszczeniu
borrowed wejść, rzeczywistą mapę P1 DOF→vertex oraz odmowę podmiany
ordered stable IDs, anchorów i solver policy. Trzy regresje
`physical_charge_terminal_currents_preserve_signed_references_and_scale`,
`physical_charge_terminal_currents_keep_components_and_zero_jump_interfaces`
oraz `physical_charge_terminal_faces_require_complete_dirichlet_closure`
sprawdzają referencję wybraną stable IDs na prawej elektrodzie,
analityczny potencjał i signed current obu elektrod, reversal, scaling,
permutację authored order, single-zero bez response, rozłączne skale
1 i 0.0001 A, izolowany metal oraz pełny szereg dwóch objętości
z jawnym zero-jump interface. Odrzucenia wymagają konkretnej bramki
unknown/duplicate/shared face-DOF, per-component balance, spanning,
trace alias lub nonzero cut. Tetrahedral pyramid sprawdza pominiętą
czwartą ścianę fan przy trzech wybranych i pełnym DOF coverage;
coarse cube sprawdza fully essential mixed separator. Wszystkie te
regresje są podłączone do `main`, lecz niekompilowane i niewykonane.
Żadna nie stanowi dowodu RT0, publicznego workflow ani kwalifikacji
małego returnu w silnie sprzężonym CPW.

`PeriodicChargePotentialSolver::Solve` korzysta z tego samego nowego
napięciowego solve, kopiuje V przez vertex→DOF i zachowuje legacy globalny
mean-zero shift oraz diagnostykę par. Nie eksportuje nowych reakcji ani
komponentowego ledgeru przez stare ABI; nie ma drugiego solve H1 w tym
delegowaniu. Oddzielny wcześniejszy solve w runnerze nadal wymaga usunięcia
po ukończeniu odpowiedzi portowej. Regresja
`charge_trace_workspace_preserves_component_gauges_and_weak_reactions`
obejmuje dwa niezależne podpisane skoki, trzeci niewzbudzony przewodnik,
brak dodatkowego gauge po voltage anchor, analityczne V, niezależne małe
prądy i trwałość owned wyniku po zniszczeniu źródeł. Jest źródłowa,
niekompilowana; obecny build `ed910` nie zawiera tego późniejszego workflow.
Regresja `charge_trace_workspace_rejects_jumps_lost_after_anchoring`
buduje jeden tet4 z całą przestrzenią quotient ustaloną przez anchor.
Najpierw sprawdza rozwiązanie ze skokiem 1 V przy anchorze 0 V, następnie
wymaga konkretnej odmowy utraty skoku po zmianie anchora na $10^{20}\,\mathrm V$.
Regresja jest źródłowa; nie kompilowano ani nie wykonano jej w ramach
obowiązującego zakazu kompilacji testów jednostkowych.

`solve_weighted_rt0_projection` w
`backends/fem/cpu/mfem/transport/conservative_current_view.cpp` buduje w KKT
wiersze zerowej dywergencji i zgodności przeciwległych strumieni par ścian.
W legacy `Build` mają one zerowe RHS; `terminal_faces` jedynie zwalnia
momenty z izolacji i nie zadaje sum prądów. Nowy prywatny
`project_terminal_constrained_rt0` dodaje optional aggregate terminal rows
ze zmierzonym signed H1 RHS. `analyze_physical_constraint_rank` analizuje
pełny układ, a niezależny pomiar RT0 sprawdza wszystkie elementy,
ściany i terminale, również omitted rows. Wynik jest owned numeric
projection, nie accepted charge/closure source. Nie wiąże jeszcze
samodzielnie proweniencji mesh/material/V. Prywatne explicit zero-jump
interface constraints są dostępne, lecz nie pełny cut/lead workflow; operator nie
publikuje artefaktu ani nowego ABI. Legacy callers nadal podają empty
terminal constraints. Kanoniczny certyfikat H1 z równania
`antenna-terminal-current-certificate` pozostaje oparty na nieeliminowanej
słabej reakcji; nie zastępować go kwadraturą odzyskanego gradientu lub
skalowaniem H według strumienia RT0. Nowy operator jest source-only,
nie został jeszcze zakwalifikowany numerycznie ani jako publiczny workflow.
Nowy prywatny `solve_accepted_terminal_charge_source` łączy tę projekcję
z H1 na jednym owned mesh i frozen elementwise scalar conductivity,
odtwarza dokładne P1 i kontroluje requested→RT0 każdego terminala.
Nie obsługuje trace interfaces, nie nadaje otwartemu przewodnikowi
pozornego closure i nadal nie zastępuje publicznego producenta V/J/H.

Dodatkowo `integrate_boundary_flux` w periodic solverze całkuje
przewodność razy normalną składową gradientu V po fizycznej ścianie.
Mimo legacy nazwy `max_paired_weak_flux_mismatch_a` jest to kwadratura
odzyskanego gradientu, a nie suma nieeliminowanych reakcji H1. Jej znak
jest przeciwny do outward conventional current przy definicji J jako
ujemnego gradientu ważonego przewodnością. Bilans par nie zależy od tego
globalnego znaku, lecz nie wolno używać tej wielkości jako podpisanego
certyfikatu terminalowego portu. Docelowy workflow musi rozróżniać reakcję
terminalu equipotential od prądu sprzężonego z actuator trace-jump,
sumować jedną zorientowaną stronę cutu i certyfikować H1 oraz RT0 osobno.

(antenna-accepted-external-electrode-truncation)=
#### Prywatny finalizator domeny z elektrodami zewnętrznymi

Ten etap T06 nie zmienia otwartego `AcceptedTerminalChargeSource` w pełną
zamkniętą pętlę. Dodaje osobny owner `AcceptedExternalLeadCurrentSource`
w `backends/fem/cpu/mfem/workflows/antenna_field_solve/`. Jego zakres pola
jest zawsze `external_electrode_truncation`: objętość urządzenia oraz jawnie
zamodelowanych przewodów, bez pominiętego generatora i dalszego powrotu.
Nie wolno eksportować go pod tożsamością legacy `ConservativeCurrentView`
ani oznaczać `closed_loop`. Publiczny producent bazy pozostaje niepodłączony.

Rozdzielamy outer-electrode actuators od device-port observations. Prąd zadany
na elektrodzie kończącej lead nie jest automatycznie prądem konkretnej gałęzi
urządzenia. Każda obserwowana gałąź jest jawną grupą istniejących par interface,
ze stroną pierwszą po stronie device i drugą po stronie lead. Wszystkie pary
muszą należeć do dokładnie jednej obserwacji; różne obserwacje nie mogą
współdzielić wierzchołków device, aby nie dublować reakcji H1. Finalizator
nie wymusza nowych prądów, nie skaluje V/J/H i nie wykonuje nowego solve.
Niezgodny naturalny podział prądów zostaje odrzucony; dobór dodatkowych
actuators i rozwiązanie odwrotnego problemu pozostają kolejnym etapem.

```{math}
:label: antenna-external-observed-branch-current
F_b^{\mathrm{H1}}=-\sum_{i\in\mathcal D_b}R_i,
\qquad
F_b^{\mathrm{RT0}}=\sum_{f\in\mathcal F_b}
\int_f\mathbf J_{\mathrm{RT0}}\cdot\mathbf n_{\mathrm{device}}\,\mathrm dS.
```

Tutaj $b$ jest indeksem obserwowanej gałęzi [$1$],
$\mathcal D_b$ zbiorem różnych wierzchołków P1 jej powierzchni device [$1$],
$\mathcal F_b$ zbiorem tych powierzchni [$1$], a
$F_b^{\mathrm{H1}},F_b^{\mathrm{RT0}}$ są podpisanymi prądami outward [$\mathrm A$].
$R_i=(KV)_i$ pochodzi z tego samego, nieeliminowanego operatora device+lead.
Reakcje po dwóch stronach zero-jump nie są sumowane przed pomiarem strony
device. Tożsamość z całką oznacza dyskretny weak-reaction contract, nie
twierdzenie o punktowej zgodności raw P1 current z RT0.

Oba pomiary osobno muszą spełnić
$|F_b-F_b^{\mathrm{requested}}|\leq10^{-18}\,\mathrm A+
10^{-8}|F_b^{\mathrm{requested}}|$. Wszystkie outer terminals, łącznie
z referencją, zerem i ograniczeniami zależnymi, podlegają tej samej bramce.
Każdy elektrycznie połączony komponent jest mierzony osobno:
$|\sum_t F_t|\leq10^{-18}\,\mathrm A+10^{-10}\sum_t|F_t|$.
Nie używamy wspólnej skali największego prądu dla rozłącznych komponentów.
Pomiary RT0 powstają ponownie przez fizyczne całki Pioli na niezmienionym
owned polu, nie przez skopiowanie zadanych RHS.

```{math}
:label: antenna-external-modeled-domain-field
\mathbf H_{\mathrm{modeled}}(\mathbf r)=\frac{1}{4\pi}
\int_{\Omega_{\mathrm{modeled}}}
\frac{\mathbf J_{\mathrm{RT0}}(\mathbf r')\times(\mathbf r-\mathbf r')}
{|\mathbf r-\mathbf r'|^3}\,\mathrm dV',
\qquad
\mathbf H_{\mathrm{full}}=\mathbf H_{\mathrm{modeled}}+
\mathbf H_{\mathrm{omitted}}.
```

$\Omega_{\mathrm{modeled}}$ to skończona domena device+lead [$\mathrm{m^3}$],
$\mathbf H_{\mathrm{modeled}},\mathbf H_{\mathrm{full}},\mathbf H_{\mathrm{omitted}}$
to odpowiednio wkład modelowany, pole kompletnego obwodu i pominięty wkład
[$\mathrm{A\,m^{-1}}$]. Zerowy bilans elektrod nie ogranicza
$\mathbf H_{\mathrm{omitted}}$. Wynik prywatnego integratora jest wkładem
Biota–Savarta domeny skończonej, nie samodzielnie zakwalifikowanym pełnym
rozwiązaniem magnetostatycznym. Promocja do fizycznej bazy LLG wymaga jawnego
domknięcia lub odrębnej kwalifikacji wpływu długości/przebiegu przewodów.

| Prywatny parametr | Typ / default | SI | Walidacja i znaczenie | Lane / Python→IR |
|---|---|---|---|---|
| `accepted_source` | immutable shared owner / required | $1$ | jedyny owner V, materiału, mesh i RT0; żadnej drugiej siatki | FEM CPU/double; brak nowego Python/IR pola |
| `required_charge_content_digest` | string / required | $1$ | dokładnie retained SHA-256 tego ownera, nie etykieta caller | prywatny native pin |
| `closure_revision` | string / required | $1$ | niepusty tekst UTF-8 bez NUL, do 4096 bytes | prywatny native provenance |
| `device_vertex_ids`, `lead_vertex_ids` | stable-ID sets / required | $1$ | niepuste, rozłączne, pokrywają każdy rzeczywisty vertex; każdy tet należy w całości do jednej części | materializacja jawnego closure, nie rozpoznawanie nazw |
| `boundary_faces` | typed stable face keys / required | $1$ | dokładna klasyfikacja wszystkich exterior faces jako insulating, outer electrode albo device–lead interface | brak source-cut w tym wariancie |
| `circuit_id` | string / required dla electrode/interface, pusty dla insulating | $1$ | dokładny owned terminal/interface ID; każdy outer terminal ma wyłącznie lead faces | nie utożsamiać actuator z portem |
| `branch_observations` | typed ID, pair-ID list, requested outward current / required | $\mathrm A$ dla prądu, $1$ dla ID | wszystkie istniejące pary, bez powtórzeń i wspólnych device vertices; finite signed current, także zero | prywatny pomiar, nie dodatkowy solve |
| `field_scope` | fixed `external_electrode_truncation` | $1$ | niezmienna semantyka wyniku, nie opcja caller | public producer nadal unsupported |
| local physical gates | fixed $10^{-18}\,\mathrm A+10^{-10}s$ | $\mathrm A$ | każdy div, interior jump, insulating face i interface; $s$ jest lokalną sumą modułów strumieni | FEM CPU source-only |

Każdy komponent musi zawierać device, lead, co najmniej jedną jawną parę
device–lead i co najmniej dwa zewnętrzne terminale. Ten wąski wariant odrzuca
samodzielne floating bodies, lead–lead pairs, device–device pairs i source
cuts, zamiast pozorować ich obsługę. Mierzone residual KKT i norma korekcji
pochodzą z rzeczywistej weighted projection; finalizator nie wpisuje zer
zastępczych. Zachowuje pełny rank/omission ledger z terminalowymi RHS.
Wersjonowany rekord finalizacji wiąże accepted SHA, znormalizowane partycje,
wszystkie role i obserwacje oraz niezależne pomiary. Limit preimage wynosi
128 MiB, nie jest deklaracją limitu peak RAM.

(antenna-duffy-singular-transformation)=
### Całka w źródle: transformacja Duffy i znak pola

Korekta numeryczna T06 dotyczy FEM CPU/double, prostych Tet4 i zaakceptowanej
afinicznej rekonstrukcji RT0. Nie dodaje solve transportu, LLG ani relaksacji.
Dla celu wewnątrz zamkniętego tetraedru dekompozycja tworzy do czterech
niezdegenerowanych tetraedrów z celem jako wspólnym wierzchołkiem. Na jednej
takiej części wybieramy trzy wektory od celu do pozostałych wierzchołków:

```{math}
:label: antenna-duffy-source-map
\mathbf e_i=\mathbf v_i-\mathbf t,\quad
\mathbf q=(1-\eta)\mathbf e_1+\eta(1-\zeta)\mathbf e_2+\eta\zeta\mathbf e_3,
\quad \mathbf r'=\mathbf t+\xi\mathbf q,
\qquad (\xi,\eta,\zeta)\in[0,1]^3.
```

Macierz pochodnych ma kolumny $\mathbf q$, $\xi\partial_\eta\mathbf q$
oraz $\xi\partial_\zeta\mathbf q$. Wieloliniowość wyznacznika daje
dodatnią miarę objętości, niezależną od orientacji kolejności wierzchołków:

```{math}
:label: antenna-duffy-jacobian
D=|\det(\mathbf e_1,\mathbf e_2,\mathbf e_3)|,\qquad
dV=D\xi^2\eta\,d\xi\,d\eta\,d\zeta.
```

W jądrze Biota–Savarta przemieszczenie to **cel minus źródło**:
$\mathbf t-\mathbf r'=-\xi\mathbf q$. Po podstawieniu i skróceniu
$\xi^2$ z miary oraz odwrotności kwadratu odległości otrzymujemy:

```{math}
:label: antenna-duffy-regular-field
\mathbf H_{\mathrm{child}}(\mathbf t)=
-\frac{D}{4\pi}\int_0^1\!\int_0^1\!\int_0^1
\eta\frac{\mathbf J(\mathbf t+\xi\mathbf q)\times\mathbf q}{\|\mathbf q\|^3}
\,d\xi\,d\eta\,d\zeta.
```

Nie pozostaje dodatkowe $\xi^2$ ani cutoff. Gauss–Legendre MFEM już używa
punktów i wag na $[0,1]$ [8]; powtórne przekształcenie $(x+1)/2$ i mnożnik
wag $1/8$ byłyby błędem dziedziny. Test kontrolny stałej funkcji przed
skróceniem daje $D/6$, czyli rzeczywistą objętość części. Dla stałego
$\mathbf J$ po skróceniu całka radialna wynosi $1$, nie $1/3$.

| Dokładny symbol | Znaczenie | SI |
|---|---|---|
| $\mathbf t,\mathbf r',\mathbf v_i$ | cel, źródło i trzy pozostałe wierzchołki części | $\mathrm m$ |
| $i$ | indeks wierzchołka $1,2,3$ | $1$ |
| $\mathbf e_i,\mathbf q$ | wektory krawędzi i promień mapowania | $\mathrm m$ |
| $\xi,\eta,\zeta,x$ | bezwymiarowe parametry na przedziale jednostkowym | $1$ |
| $D,dV$ | moduł wyznacznika oraz miara objętości | $\mathrm{m^3}$ |
| $\partial_\eta,\partial_\zeta,\det,\lVert\cdot\rVert,\times,\pi$ | pochodne parametrów, wyznacznik, norma euklidesowa, iloczyn wektorowy i stała | $1$ jako operatory; jednostki argumentów zachowane |
| $\mathbf J$ | zaakceptowana gęstość prądu konwencjonalnego RT0 | $\mathrm{A\,m^{-2}}$ |
| $\mathbf H_{\mathrm{child}}$ | wkład części do H; bez czynnika $\mu_0$ | $\mathrm{A\,m^{-1}}$ |

| Parametr prywatny | Typ / default | SI | Walidacja i znaczenie | Backend / Python→IR |
|---|---|---|---|---|
| `source` | frozen `AffineRt0Element` / required | $\mathrm{A\,m^{-2}}$ w `current_at` | ta sama zaakceptowana rekonstrukcja co w zwykłej całce; żadnego rescale | FEM CPU/double; bez nowego pola DSL/IR |
| `vertices`, `target` | odpowiednio 4 i 1 trójki double / required | $\mathrm m$ | część z celem jako pierwszym wierzchołkiem, dodatni finite D, finite niezerowy promień reguły | prywatne dane geometrii, nie nowy model publiczny |
| `order` | int / resolved order | $1$ | rząd pochodzi z istniejącego `base_quadrature_order+2*depth` oraz reguły high o dwa większej | existing resolved field policy |
| `quadrature_operator_version` | string / `fem_oersted_direct_tetra_quadrature.v2` | $1$ | v2 oznacza poprawione Duffy; **nadal lokalna polityka legacy**, nie globalny certyfikat | native producer, canonical IR constant, retained field bytes i SHA |
| `direct_field_policy.policy_version` | string / `external_lead_direct_defaults.unqualified.v2` | $1$ | rozróżnia aktualną materializację od v1; adapter wymaga aktualnego tokenu i niezmienionego floor 1 | resolved `AntennaDirectFieldInputPolicyIR`; `solver_sampling_sha256` obejmuje policy, więc zmienia pin cache bez edycji authored DSL |

Wpływ na publiczny Python: brak nowych parametrów; `solver_policy` nadal
zachowuje requested intent, a wersja rozwiązanego operatora rozróżnia wynik.
`ProblemIR`/planner: `ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION` wiąże aktualny
operator; nie ma nowej capability ani promocji stanu support. Runtime:
`ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION` wiąże resolved preset z v2,
a pin solver/sampling obejmuje ten token. Stare wejście v1 nie może być
podane do adaptera nowej realizacji; należy je ponownie materializować.
producer v2 i request-bound decoder muszą być zgodne. Owned inspection może
odczytać literalne v1 lub v2 i zachowuje tę wersję, ale v1 nie może spełnić
żądania aktualnego operatora. Outer/field framing v1 pozostaje bez zmian,
bo zmienia się wartość wersji operatora, a nie kształt rekordu. Artifact digest
obejmuje wersję; nie przepisywać historycznych bytes, hashów ani receiptów.

FDM CPU/GPU nie wykonuje tej gałęzi; nie wprowadza się tam równoległej kopii
transformacji. FEM GPU pozostaje unsupported dla tej realizacji. H1 projection
wykorzystuje ten sam kernel, ale jej błędy projekcji i kwadratury targetowej
wymagają odrębnej kwalifikacji. Istniejący snap barycentric do granicy nie
jest tą korektą objęty; jego wpływ dla near-boundary targets pozostaje bramką.

Stan przed korektą: źródła v1 mają ponowne mapowanie segmentu, zły znak
`J×ray` oraz pozostawione `xi²` i `0.125`. Niezależny przegląd potwierdził
te trzy defekty. Szósty test RAM ma cztery cele **poza źródłem**: ten defekt
nie jest ustaloną przyczyną jego FAIL. Regresje interpretowane sprawdzają
Jacobiany, miarę, znak, radialny moment i wyrażenia źródła; nie wykonują
C++/MFEM i nie kwalifikują runtime. Przed nowym runem wymagane są zgodne
wersjonowanie, managed build i osobny niezależny near/inside/face/edge oracle.

Weryfikacja 2026-10-06 (lokalnie; 2026-10-05 UTC): pierwsze RED obejmowało
4 błędy/6 PASS, następnie 33 PASS dla Duffy, observable association i drivera.
Osobny RED aktualnego input policy/pinu zakończył się jednym oczekiwanym
FAIL; po poprawce cały plik Duffy ma 11 PASS. Łącznie 34 różne przypadki
interpretowane PASS w tych zakresach. Pierwsze uruchomienie łącznego zestawu
miało 25 PASS i 8 błędów **setup** pytest temp permissions; po skierowaniu
basetemp do zatwierdzonego storage na D: uzyskano 33 PASS, bez zmiany asercji.
Source review Duffy/codec oraz osobny review policy/pin/cache PASS,
bez Required/Blocker w tych zakresach.
Żaden z tych wyników nie jest nowym buildem ani powtórzeniem science runu.

(antenna-global-target-quadrature-design)=
### Docelowy budżet błędu T06 — projekt, jeszcze nie implementacja

Alternatywy: równy rozdział budżetu źródeł i ośmiorga dzieci jest prosty,
lecz może nadmiernie refinować łatwe części i wymaga ponownego zaostrzenia,
gdy zmieni się suma pola. Wybrany projekt to deterministyczna adaptacja
największego estymatora na zbiorze **finalnych liści całego targetu**:

```{math}
:label: antenna-global-target-quadrature-budget
\widehat{\mathbf H}_t=\sum_{\ell\in\mathcal L_t}\mathbf I_\ell^{\mathrm{hi}},\qquad
e_\ell=\|\mathbf I_\ell^{\mathrm{hi}}-\mathbf I_\ell^{\mathrm{lo}}\|_2,\qquad
E_{q,t}=\sum_{\ell\in\mathcal L_t}e_\ell,\qquad
E_{q,t}\le\tau_t=a_q+r_q\|\widehat{\mathbf H}_t\|_2.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $t,\ell,\mathcal L_t$ | indeks celu, liścia i zbiór finalnych liści źródłowych | $1$ |
| $\mathbf I_\ell^{\mathrm{hi}},\mathbf I_\ell^{\mathrm{lo}},\widehat{\mathbf H}_t$ | dwa wkłady kwadratury i końcowa suma H | $\mathrm{A\,m^{-1}}$ |
| $e_\ell,E_{q,t},\tau_t,a_q$ | estymator liścia, suma estymatorów, tolerancja końcowa i atol | $\mathrm{A\,m^{-1}}$ |
| $r_q$ | względna tolerancja sumy H | $1$ |

Pilot obejmuje wszystkie źródła. Każde refinement zastępuje rodzica sumą
ośmiu dzieci zarówno w H, jak i w E; rodzic przestaje być finalnym liściem.
Norm błędów nie wolno kasować między źródłami. Tolerancja jest przeliczana
od aktualnej sumy H po każdym podziale i na końcu, bez `1 A/m` floor.
Deterministyczne remisy rozstrzyga kolejność source/child IDs. Schemat
zastępowania globalnego estymatora i wyboru największego błędu ma precedent
w QUADPACK [9]; powyższa norma wektorowa i addytywna tolerancja są kontraktem
Fullmag, nie dosłowną semantyką QUADPACK.

Warunki implementacji: bounded leaf/queue memory oraz liczba rzeczywistych
ewaluacji jądra, niezależnie od limitu root pairs; stabilna suma wewnątrz
reguł i liści; jawna diagnostyka cancellation/roundoff bez podnoszenia
tolerancji. Liść na maksymalnej głębokości nie kończy zadania, gdy inne
liście mogą jeszcze spełnić globalny budżet. Brak dostępnej poprawy,
stagnacja lub wyczerpanie pracy powodują failure, nie publikację accepted H.
Pure-relative warunek dla niemal zerowego H może być nieosiągalny i nie
usprawiedliwia ukrytego floor. Dokładne limity zasobów, pola per-target
diagnostics i następna wersja operatora wymagają wdrożenia przed deklaracją
globalnej kontroli; **nie należą do semantyki Duffy-v2**.

Różnica low/high jest estymatorem, nie rygorystyczną granicą rzeczywistego
błędu. Trzeba zachować niezależne zbieżności i oracle, w tym małe i kasujące
się pola. Native rtol `1e-5` sam nie gwarantuje oracle rtol `1e-6`;
kwalifikacja wymaga uprzedniej alokacji dokładności źródła, kwadratury i
wzorca, bez zmiany progu po FAIL. Regresje: wiele zgodnych małych błędów,
przeciwne źródła, osiem dzieci, zmiana tolerancji po pilocie, depth/work
exhaustion, zero/mały/odwrócony prąd oraz błędny lecz pozornie zbieżny integrand.

(antenna-global-target-quadrature-v3)=
### Kontrakt wdrażanej adaptacji globalnej v3

Poniższy kontrakt zapisano przed implementacją zmiany T06. Źródła v3
realizują teraz ten ledger. Zgodny managed build oraz siódmy fixed RAM
V/RT0/H przeszły weryfikację opisaną niżej; jest to odbiór jednego modelu,
nie kwalifikacja całego operatora ani modułu.
Operator `fem_oersted_direct_tetra_quadrature.v3` zachowuje korektę Duffy v2,
lecz zastępuje niezależne lokalne stop-testy jednym ledgerem finalnych liści
każdego targetu. Wszystkie źródła są dodawane przed pierwszym stop-testem.
Zaakceptowane H jest dokładnie końcową sumą binary64 używaną do tolerancji.

Dla reguły low/high sumujemy skompensowanie wektorowe wkłady jądra i osobno
sumę ich norm. Wprowadzamy jawny, heurystyczny wskaźnik zaokrągleń:

```{math}
:label: antenna-global-target-roundoff-indicator
S_\ell=\sum_{p\in Q_\ell^{\mathrm{lo}}\cup Q_\ell^{\mathrm{hi}}}
\|\mathbf w_{\ell p}\|_2,\qquad
R_t=u_{64}\left(\sum_{\ell\in\mathcal L_t}S_\ell+
\sum_{\ell\in\mathcal L_t}\|\mathbf I_\ell^{\mathrm{hi}}\|_2\right),\qquad
E_{q,t}+R_t\le\tau_t.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $p,Q_\ell^{\mathrm{lo}},Q_\ell^{\mathrm{hi}}$ | indeks próbki i zbiory próbek dwóch reguł na liściu | $1$ |
| $\mathbf w_{\ell p},S_\ell,R_t$ | ważony wkład jądra, suma jego norm low/high i wskaźnik roundoff targetu | $\mathrm{A\,m^{-1}}$ |
| $u_{64}$ | `numeric_limits<double>::epsilon()`, dokładnie $2^{-52}$ | $1$ |

Ten wskaźnik **nie jest granicą** błędu floating-point ani błędu geometrii,
rekonstrukcji J lub samego jądra. Nie używa arbitralnej skali `1 A/m`.
Wartości `estimated_error`, `roundoff_indicator` i `tolerance` pozostają
odrębne w provenance. Normę H realizuje łańcuch `hypot(hypot(Hx,Hy),Hz)`,
a tolerancję jawne binary64 `fma(rtol,norm,atol)`; Rust sprawdza ten sam
kontrakt przez `hypot` i `mul_add`, bez dodawania acceptance slack.

Akumulatory Kahana używają `long double`, a publikowane H ma typ binary64.
Estymator E i wskaźnik R po końcowym recompute są konwertowane do binary64
z zaokrągleniem w górę (`nextafter`, jeżeli zwykła konwersja zaniżyła wartość).
Nie czyni to estymatora rygorystyczną granicą. Bramkę sumy dwóch zapisanych
nieujemnych doubles sprawdzamy przez uporządkowane FastTwoSum [10]: zachowujemy
resztę sumowania, gdy zaokrąglona suma jest równa tolerancji. Dodatnie R
mniejsze niż ULP tolerancji nie może zniknąć w przypadku E równego tolerancji.
Kontrakt wymaga round-to-nearest i zachowania subnormals, bez fast-math
lub reassociation; kwalifikacja obejmuje również te warunki wykonania.

Ledger finalnych liści jest aktualizowany kompensowanym odejmowaniem
rodzica i dodawaniem ośmiu dzieci. Ujemny/niefinitywny ledger nie może
akceptować wyniku. Przed każdym accepted result, po wyczerpaniu kolejki
oraz przy takim podejrzeniu sumę H/E/S trzeba policzyć ponownie ze wszystkich
finalnych liści; zachowane parents nie są składnikami. Kolejka zawiera tylko
liście z dostępnym podziałem. Remis rozstrzyga deterministyczny monotoniczny
numer wstawienia, w kolejności źródeł i istniejącej kolejności ośmiu dzieci.

Próbka dokładnie w singularity oznacza osobny `needs_refine`, nie `inf`
w sumie Kahana. Taki liść blokuje akceptację; singularity na maksymalnej
głębokości powoduje jawny failure. Inny niefinitywny wynik geometrii/prądu/
jądra powoduje failure natychmiast, nie jest ukrywany broad runtime-error
refinementem. Zwykła reguła nie wprowadza wymiarowego cutoff odległości.
Mianownik jądra i jego odwrotność muszą być dodatnie i skończone w binary64;
inny zakres daje `biot_savart_denominator_exceeds_binary64_range`, nie ciche
zero z odwrotności `inf`. Ta realizacja nie deklaruje obsługi dowolnych
ekstremalnych skal SI; stabilnie skalowany kernel wymaga osobnej kwalifikacji.

Jeżeli globalna kontrola nie przechodzi, dzielimy największy dostępny
estymator; ograniczony przez depth liść nadal wnosi H/E/R. `R_t>tau_t` na
pilocie nie jest dowodem nieosiągalności: adaptacja może zmienić H i R.
Przy zerowych estymatorach wszystkich dostępnych liści można odmówić z
`roundoff_indicator_exceeds_tolerance`; to odmowa aktualnego wskaźnika,
nie dowiedziony `roundoff_limited`. Brak refinable leaves albo przekroczony
limit daje failure z targetem oraz bieżącymi E/R/tolerancją/licznikami.
Nie publikujemy częściowego H jako accepted basis i nie podnosimy tolerancji.

| Wersjonowany parametr / wynik prywatny | Typ / default | SI | Walidacja / semantyka | Python→IR i backend |
|---|---|---|---|---|
| `quadrature_operator_version` | string / `fem_oersted_direct_tetra_quadrature.v3` | $1$ | globalny target, Duffy v2 oraz jawne bounded work; literalne archive v1/v2 nie zmieniają znaczenia | canonical operator constant; FEM CPU/double only |
| `direct_field_policy.policy_version` | string / `external_lead_direct_defaults.unqualified.v3` | $1$ | nowy resolved preset zmienia solver/sampling i materialized input pins | `AntennaDirectFieldInputPolicyIR`; bez nowego authored DSL |
| `relative_scale_floor_apm` | fixed double / 0 dla v3 | $\mathrm{A\,m^{-1}}$ | brak floor; archive v1/v2 zachowuje 1 | resolved policy i nested field; nie nowy parametr caller |
| `quadrature_scope`, `estimated_error_policy` | fixed strings / `global_target`, `sum_final_leaf_l2_difference.v1` | $1$ | dokładnie te tokeny dla v3 | retained record, nie alternate physics UI |
| `roundoff_indicator_policy` | fixed string / `weighted_terms_binary64_epsilon.v1` | $1$ | wskaźnik, nie certified bound | retained record |
| `maximum_final_leaves_per_target` | fixed u64 / $10^6$ | $1$ | root oraz wszystkie końcowe liście; preflight netto +7 przed podziałem; maksymalnie 8 dodatkowych tymczasowych dzieci | prywatny resource preset, bez nowego DSL/ABI parametru |
| `maximum_kernel_evaluations` | fixed u64 / $10^8$ | $1$ | attempted samples, także low/high odrzucone, Duffy i singularity; sprawdzenie przed próbką, bez overflow | wspólny budżet jednego publicznego EvaluateField lub całego ProjectField |
| `maximum_ledger_leaf_visits` | fixed u64 / $10^8$ | $1$ | rzeczywiste odczyty liści przy pełnym recompute; jawny limit pracy ledgeru | ten sam lifetime co kernel budget |
| `target_estimated_error_apm`, `target_tolerance_apm`, `target_roundoff_indicator_apm` | ordered finite doubles / wynik | $\mathrm{A\,m^{-1}}$ | nieujemne; E+R≤tau oraz tau od dokładnie publikowanego H | 1 rekord na target, kolejność zgodna xyz/H |
| `target_final_leaf_count` | u64 / wynik | $1$ | od liczby źródeł do $10^6$; suma targetów = root pairs + 7*refinements | retained diagnostics |
| `target_kernel_evaluations`, `target_ledger_leaf_visits` | u64 / wynik | $1$ | sumy zgodne z trailerem; oba ≤ własnego fixed work limit | retained diagnostics |
| `kernel_evaluations`, `ledger_leaf_visits` | u64 / wynik całego wywołania | $1$ | liczniki rzeczywistej pracy, nie liczba root pairs | global trailer i agregacja projekcji |
| `base_quadrature_order`, `maximum_subdivision_depth` | int / 4, 6 | $1$ | bounds 2–16 i 0–6; dziedziczą wybór low/high | obecne resolved fields |
| `absolute_tolerance_apm`, `relative_tolerance` | double / $10^{-9}$, $10^{-5}$ | odpowiednio $\mathrm{A\,m^{-1}}$, $1$ | finite, nieujemne; teraz budżet targetu, nie każdej pary/dziecka | obecne resolved fields; requested policy zachowana |
| `maximum_source_target_pairs` | u64 / $10^6$ | $1$ | dotychczasowy root-pair preflight, nie zastępstwo actual work limits | obecny typed input |

Limit liści ogranicza rozmiar ownera/indeksów O($10^6$), nie całego cold
RT0 source ani peak RAM workflow. Reallocation może chwilowo zachować stare
i nowe storage; nie nazywać liczby liści limitem bytes. Dzieci mają stałą
tablicę 8, nie nieograniczoną kolejkę. ProjectField współdzieli jeden licznik
pracy między wszystkimi punktami i trzema składowymi; osobny publiczny solve
otrzymuje osobny budżet. H1 mass solve i target assembly nie są objęte tym
limitem kernela i wymagają własnej kwalifikacji.

Nested field schema/operator to `accepted_external_lead_field.ordered.v2` /
`fem_accepted_external_lead_field.v2`, z quadrature v3, scope/policies i
resource caps w nagłówku, dodatkowymi sześcioma scalar diagnostics przy
każdym xyz/H oraz dwoma licznikami w trailerze. Outer bundle v1 pozostaje
owned containerem nested bytes. Decoder wymaga **zgodnej pary** framing/
operator: legacy framing v1 → quadrature v1/v2 oraz floor1, nowe framing v2
→ quadrature v3 oraz floor0. Unknown/future combos i niezgodny budget są
odrzucane. Archive read zachowuje rzeczywistą wersję i SHA; request binding
wymaga aktualnego v3. Structural checks nie odtwarzają historii adaptacji
i nie zamieniają estymatora w scientific proof.

Publiczny Python/UI nie otrzymuje nowych obiektów ani nie zmienia quantity
semantics; brak pełnej kwalifikacji support matrix i capability rejection
pozostają mimo ograniczonego dowodu FEM CPU/double poniżej.
FDM CPU/GPU konsumują kwalifikowaną bazę, nie kopiują kernela; FEM GPU
pozostaje unsupported dla tego ownera. Ramkowanie ciężkich danych pozostaje
binary data plane. Implementacja, source/model RED→GREEN, native managed
build, fixed outside-source oracle oraz osobne near/inside/face/edge i
projection gates są kolejnymi oddzielnymi dowodami, nie obietnicą PASS.

(antenna-global-target-v3-fixed-ram-evidence)=
### Siódmy fixed RAM: ograniczony odbiór V/RT0/H operatora v3

Stan 2026-10-06 00:13 UTC. Managed job
`e57249b5b5d1493b9949204336efcbef` zakończył się `succeeded`, exit 0;
wszystkie trzy etapy, 126 artefaktów i pełna kapsuła 7442 plików przeszły
walidację. HEAD `202bbed4fff8c72099ef17489134bb1df911c090`, source digest
`d7ec5343f7d45c6000b9127684e20f86240eb8e1fa3bcf7d1c7fb7c743445cb4`,
native snapshot
`b316947eb6f3012c916b6b52ce96188950ad4a150021820cd28d63ad5160880e`.
Build receipt SHA-256
`f4b2e88b5dbbaa74a8ce4fa875f59caaa68bea17c93f5541ce47558cecdda011`.

Zatwierdzony run `8031eeff9ebf4ce28cca1fe5e8613329` wykonał tylko
`flat_antenna_field_solve`, FEM CPU/double, bez LLG/Relax i z zerem kroków
czasowych. Sesja była w tmpfs, eksporty w canonical storage; isolation
i startup identity PASS, solver exit 0. Nie osłabiono guardów trwałego
SessionStore. Niezależny driver
`scripts/compare_managed_antenna_ram.py::compare` dał PASS dla V,
geometrycznych momentów RT0, exact bundle-observable association i H.
Maksymalny błąd V: $1.1102230246251565\times10^{-16}\,\mathrm{V}$.
RT0: 108 faces, 36 elements, maksymalny błąd momentu
$2.220446049250313\times10^{-16}\,\mathrm{A}$ i suma strumieni elementu 0;
próg RT0 pozostał $10^{-8}\,\mathrm{A}$.

Porównanie H zachowuje wcześniejsze progi: atol
$10^{-8}\,\mathrm{A\,m^{-1}}$ i rtol $10^{-6}$ względem normy wektora
referencyjnego. Nie są to parametry tolerancji natywnego estymatora.

| Pozycja [$\mathrm{m}$] | Błąd wektorowy H [$\mathrm{A\,m^{-1}}$] | Bramka oracle [$\mathrm{A\,m^{-1}}$] | Błąd / bramka [$1$] |
|---|---|---|---|
| (0, 0, 2) | 4.24349421856863e-9 | 6.131203777591822e-8 | 0.0692114367 |
| (1, 0, 2) | 4.298757005679951e-9 | 6.131203777591822e-8 | 0.0701127733 |
| (0, 1, 2) | 6.760249178929324e-9 | 7.12640211724223e-8 | 0.0948620225 |
| (0, 0, 3) | 4.583227340365654e-10 | 2.913599577674578e-8 | 0.0157304640 |

Poniższe wartości są odrębnymi, zachowanymi diagnostykami kernela;
$E_{q,t}$ i $R_t$ nadal nie są rygorystycznymi granicami błędu.

| Pozycja [$\mathrm{m}$] | $E_{q,t}$ [$\mathrm{A\,m^{-1}}$] | $\tau_t$ [$\mathrm{A\,m^{-1}}$] | $R_t$ [$\mathrm{A\,m^{-1}}$] | Finalne liście [$1$] | Kernel samples [$1$] |
|---|---|---|---|---|---|
| (0, 0, 2) | 4.6071117908075775e-7 | 5.141203937218076e-7 | 6.65307699317584e-17 | 148 | 9836 |
| (1, 0, 2) | 5.122387703300172e-7 | 5.14120397236587e-7 | 6.651355907636716e-17 | 148 | 9836 |
| (0, 1, 2) | 5.170789184822991e-7 | 6.136402131242693e-7 | 7.977204225215197e-17 | 232 | 16268 |
| (0, 0, 3) | 1.7005575242800077e-7 | 1.9235995634785712e-7 | 3.447099891223062e-17 | 120 | 7692 |

Łącznie: 43632 kernel evaluations i 648 ledger leaf visits. Porównanie
hostowe sprawdza zachowane budżety i związanie z dokładnym V/xyz/H, lecz
nie odtwarza dokładnie natywnego `hypot/fma` dla tolerancji, historii
adaptacji, materialized input pins ani pełnego canonical decoder.
Wagi DOF RT0 są zachowane z native, nie niezależnie certyfikowane.
Wejścia odtworzono z dokładnego skryptu i publicznego DSL kapsuły;
nie jest to dump faktycznie wykonanego native IR.

Wszystkie cztery punkty leżą poza przewodnikiem, prąd wynosi 1 A.
Wynik zamyka wcześniejszą odmowę H tego samego fixed modelu (sixth RAM
v1 FAIL 3/4), ale nie kwalifikuje Duffy/near/inside/face/edge, całego
zamkniętego obwodu, projekcji, prądu różnego od 1 A, czterech backendów,
trwałości, reuse/LLG/FFT ani UI. Required luki regularnego eksportu,
publikacji/load i finite-wire verifiera pozostają otwarte; oddzielny
inspection-only PASS ich nie zamyka.

Pełny raport:
`storage/tmp/<worktree-id>/current-source-oracle/seventh-ram-global-v3-comparison-20261006.json`,
SHA-256 `0a396dcb6fa9b0b9e64459c21e6c9417522dae0782f869aaf4efbe01dc9a7d8c`.
Checkpoint z per-target liczbami i hashami:
`global-target-v3-runtime-checkpoint-20261006.json`, SHA-256
`cf2f71b391347923eb6cd9805e278cf443a3eeb29cbfe64028b19f0397246b7c`,
w tym samym katalogu canonical storage. Raport i checkpoint mają
`physics_qualified=false`, `durable_session_storage_qualified=false`
i `reuse_LLG_FFT_qualified=false`. Historyczne FAIL i źródłowe checkpointy
pozostają niezmienione. Te adnotacje powstały po capture buildu.

(antenna-global-target-v3-regular-export-contract)=
### Regularny OE-F1: wersjonowany snapshot tego samego solve

Required luka R1 dotyczy utraty dowodu w adapterze, nie równania
Biot–Savart ani nowej realizacji solvera. Zapisany źródłowo nowy symbol
`fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1`
przyjmuje istniejący request/result OE-F1 i dwa osobne wyniki: charge
snapshot oraz `fullmag_fem_direct_oersted_snapshot_result_v1`.
Każdy buffer jest własnością callera przez całe wywołanie. Jego writable
storage musi być rozłączny od pozostałych outputów i borrowed inputs.
Nie zmieniamy layoutu, rozmiaru ani semantyki historycznych struktur ABI v1.

Nowy snapshot ma własne ABI version/reserved/struct_size i literalny
schema `fem_direct_oersted_target_snapshot.v1`; operator jest nadal
`fem_oersted_direct_tetra_quadrature.v3`. Rekord
`fullmag_fem_direct_oersted_target_record_v1` zawiera jednocześnie
dokładny xyz, dokładne raw H oraz trzy skalary E/tau/R i trzy liczniki.
Jeden rekord przypada na jeden target, w kolejności wejściowej,
bez sortowania, deduplikacji ani ponownego solve. Kopiowanie odbywa się
bezpośrednio z tego samego `DirectTetraQuadratureResult`, z którego
powstaje istniejące `h_xyz_apm`. RT0 source digest jest wspólny dla
wyniku transportu i pola. Nie jest to niezależny pomiar ani certified
error bound; $E_{q,t}$, $R_t$ i $\tau_t$ zachowują znaczenie v3.

| Pole / token snapshotu | Typ / default | SI | Walidacja i znaczenie |
|---|---|---|---|
| `abi_version`, `reserved_flags`, `struct_size` | u32/u32/u64 / 1, 0, sizeof | $1$ | literalny header, przed użyciem bufferów |
| `target_records`, `target_records_capacity`, `target_records_len` | pointer/u64/u64 / caller-required, caller-required, 0 | $1$ | capacity liczona w rekordach; 1–1000000 targetów; len publikowany dopiero po pełnym success |
| `target_xyz_m[3]` | binary64 / wynik | $\mathrm m$ | dokładnie request xyz; finite i zachowana kolejność |
| `h_xyz_apm[3]` | binary64 / wynik | $\mathrm{A\,m^{-1}}$ | dokładnie raw H tego samego solve, nie per-ampere field |
| `estimated_error_apm`, `tolerance_apm`, `roundoff_indicator_apm` | binary64 / wynik | $\mathrm{A\,m^{-1}}$ | zachowane E/tau/R, nieujemne finite; istniejąca bramka v3 |
| `final_leaf_count`, `kernel_evaluations`, `ledger_leaf_visits` targetu | u64 / wynik | $1$ | dokładnie target diagnostics, nie root-pair approximation |
| `source_target_pairs`, `refined_pairs`, `unconverged_pair_count`, global work counters | u64 / wynik | $1$ | dokładnie global diagnostics; aggregate nie zastępuje rekordów |
| `maximum_pair_error_apm` | binary64 / wynik | $\mathrm{A\,m^{-1}}$ | zachowana historyczna diagnostyka, nie globalne E |
| `base_quadrature_order`, `maximum_subdivision_depth` | i32 / request | $1$ | przekazane rzeczywiste parametry istniejącego requestu |
| `absolute_tolerance_apm`, `relative_tolerance`, `maximum_source_target_pairs` | binary64/binary64/u64 / request | odpowiednio $\mathrm{A\,m^{-1}}$, $1$, $1$ | zachowane parametry tolerancji i preflight; bez silent preset |
| `relative_scale_floor_apm` | binary64 / 0 | $\mathrm{A\,m^{-1}}$ | literalny brak floor dla operatora v3 |
| `maximum_final_leaves_per_target`, `maximum_kernel_evaluations`, `maximum_ledger_leaf_visits` | u64 / $10^6$, $10^8$, $10^8$ | $1$ | pochodzą z tych samych stałych kernela, nie wartości callera |
| `schema_version`, `operator_version`, `quadrature_scope` | bounded strings / snapshot.v1, quadrature.v3, global_target | $1$ | literalne właściwe wersje i scope |
| `estimated_error_policy`, `roundoff_indicator_policy` | bounded strings / sum_final_leaf_l2_difference.v1, weighted_terms_binary64_epsilon.v1 | $1$ | jawne heurystyczne polityki v3 |
| `source_view_identity_digest`, `error_message` | bounded strings / wynik | $1$ | source binding albo diagnostyka odmowy; nie authentication |

Limit 1000000 rekordów jest osobnym limitem nowego cold eksportu,
nie utożsamieniem targetów z liśćmi, byte-cap solvera lub licznikami
projekcji. Rekord ma 96 bytes w 64-bit ABI; pełny bufor maksymalnie
96000000 bytes, poza innymi strukturami solve. Snapshot nie używa
`diagnostics_json[1024]` jako transportu tablic.

Niepoprawny header/null/capacity/empty/excess target count daje odmowę
przed solve. Każdy błąd resetuje published target len i wszystkie
diagnostic scalars/tokens nowego snapshotu, jeżeli pointer jest non-null
i deklarowany struct_size obejmuje cały layout. Dla takich wyników
output H/RT0 i charge len również nie pozostają accepted. Za krótki
header nie jest zapisywany — to ochrona pamięci, nie pozostawienie
accepted output. Przy statusie error nie wolno konsumować żadnego
wyniku, nawet gdy bytes sprzed wywołania miały dodatnią długość.
Błędy nie zwracają częściowego zbioru
jako accepted basis. Pamięć rekordów może zawierać nieistotne stare
bytes, ale len=0 i usunięte tokens odmawiają publikacji. Brak MFEM
zwraca unavailable tym samym failure path.

FEM CPU/double jest jedyną realizacją tego adaptera. Kernel, SI,
Python DSL i `ProblemIR` nie zmieniają się; planner nadal wybiera
istniejący OE-F1. FDM CPU/GPU i FEM GPU nie uzyskują nowego support
lub qualification. Charge/source/input pins i stage identity muszą
zostać związane przez istniejącego runnera; sam C snapshot nie jest
nowym publicznym zasobem sesji ani dowodem trwałości.

Następne, nadal required R3/R2: runner musi zachować typowany raw
snapshot jako bounded binary artifact z digestem, podczas gdy manifest
zawiera thin reference. Publish i load sprawdzają ten sam raw H/xyz/E/
tau/R, source/policy/count/work binding oraz dokładne mnożenie raw H
przez zapisany binary64 scale `1.0/current` do per-A payload.
Nie odtwarzać raw H przez mnożenie per-A przez current: floating-point
round-trip nie jest tożsamością. E/tau/R pozostają w jednostkach raw H;
nie nazywać ich automatycznie błędem znormalizowanej bazy ani błędem LLG.
Vector-potential wymaga własnych residual/gauge acceptance, nie tego
direct ledgeru. Legacy archive nie uzyskuje brakującego globalnego
certyfikatu. Verifier musi odczytać właściwy artifact i odmawiać
missing/mixed/future evidence, także po ponownym zahashowaniu.

Regresje: zachowanie layoutu starego ABI, zgodność C/Rust nowego layoutu,
co najmniej 12 rekordów (więcej niż 1024 bytes), dokładny porządek xyz/H,
wszystkie skalary/tokens/caps, null/header/capacity/target-cap refusals,
zero published lengths przy każdej odmowie i brak drugiego solve.
Source/model checks nie zastępują kompilacji produkcyjnego pakietu ani
rzeczywistego wykonania nowego symbolu. Siódmy fixed RAM v3 poprzedza
ten eksport i go **nie kwalifikuje**.

(antenna-global-target-v3-regular-adapter)=
#### Odbiór typowanego snapshotu przez runner — stan źródłowy

`crates/fullmag-runner/src/native_fem/steady_transport.rs` +
`solve_native_fem_steady_transport_rt0` używa nowego symbolu dla OE-F1.
`native_fem/steady_transport/direct_oersted_snapshot.rs` + `SnapshotBuffer::finish`
odbiera wyłącznie własny bufor po `FULLMAG_FEM_OK`; nie dereferencjonuje
pointera zwróconego przez native. Sprawdza header, pointer/capacity/len,
zakończenie i padding metadata, literalne wersje/polityki/caps, source digest
oraz dokładną bitową zgodność ordered xyz i raw H. Parametry muszą odpowiadać
rzeczywistemu requestowi, obecnie ustalonym stałym IR dla regularnego OE-F1.
Wynik pozostaje owned po zakończeniu FFI; nie zawiera pożyczonych pointerów.

Runner powtarza wyłącznie walidację retained wyniku, nie całkowanie:
zagnieżdżony hypot i fused multiply-add odtwarzają $\tau_t$ dla raw H;
bitowa zgodność z zachowanym $\tau_t$ i istniejąca bramka FastTwoSum
odmawiają również dodatniego sub-ULP $R_t$ przy $E_{q,t}=\tau_t$.
Wszystkie trzy skalary muszą być finite i nieujemne. To nadal heurystyczne
E/R, nie rygorystyczny bound błędu rzeczywistego. Zgodność operacji binary64
między C++ i Rust wymaga osobnego runtime dowodu na docelowej platformie.

Liczba source cells obejmuje device oraz leads. Runner sprawdza dokładnie
roots = source cells razy targets, dla każdego targetu liczbę liści po
zastąpieniu rodzica ośmioma dziećmi, depth bound i per-target work; globalna
liczba liści musi być roots plus siedem razy liczba refinementów. Sumy
kernel evaluations i ledger visits muszą odpowiadać globalnym licznikom
i capom, bez przepełnienia. Te checks nie odtwarzają historii adaptacji.

Typowany `DirectOerstedSnapshot` jest zachowany w wyniku RT0, a dotychczasowy
JSON diagnostyczny zawiera tylko thin summary, nie tablicę targetów.
W historycznym checkpointcie R1 downstream publisher **jeszcze nie zapisywał** owned snapshotu;
R3 binary artifact/publish/load i R2 verifier pozostają required. Istniejące
`ready` ani SHA artefaktu nie stają się przez ten adapter certyfikatem
globalnego ledgeru lub zgodności raw→per-A. OE-F2 pozostaje odrębnym kontraktem
i zwraca `None` zamiast direct snapshotu. Python/IR i lane support bez zmian.

Regresje interpretowane: 4/4 PASS, obejmują jedno nowe wywołanie, brak
dereferencji returned pointer, source wiring i niezależny model binary64/
liczników. Cztery regresje Rust są zapisane (12 targetów, 15 odmów header/
binding/work, sub-ULP R oraz preflight capacity), lecz niekompilowane zgodnie
z zakazem użytkownika. Review źródłowe nie znalazło Required. Te dowody nie
wykonują adaptera; obecny job `5d2e8e253c58405c9d44237cd9d2bce2` poprzedza
zmiany Rust i ich nie kwalifikuje. Pełny moduł pozostaje nieukończony.

(antenna-r3-package-openapi-acceptance)=
<!-- DOC-ANCHOR:antenna-r3-package-openapi-acceptance -->
#### Odbiór pakietu R3 i eksport jego kontraktu API

Build seq 35, job `feb603f43c5b4dfa98777f87d5422411`, zakończył się
`succeeded`, exit 0. Ponowny pełny odbiór trusted receipt/journal,
126 artefaktów i kapsuły 7448 plików (78 included untracked) przeszedł.
Identyfikatory kapsuły, nie późniejszego dirty checkoutu:

- bazowy commit: `202bbed4fff8c72099ef17489134bb1df911c090`;
- source digest: `d2b97d400b9f60523de9a1f4db973352befa24be393a76bcd917d7ed74c0f97c`;
- native snapshot: `e0f81aa12a17686b2e47354d91d39f920bced75416b7fed5d66f39f3059faaf0`.

Eksport OpenAPI dokładnie tego pakietu przez
`scripts/export_runner_openapi.py` zakończył się `succeeded`, exit 0.
Raw JSON zawiera `AntennaQuadratureEvidenceRefResource` i
`AntennaFieldBasisResource.quadrature_evidence`. Importer
`generate-openapi-v2.mjs` zweryfikował raw bytes, receipt/proof, oba digests,
commit i cleanup; zachował dirty provenance, bez fallbacku Cargo i bez
podstawienia kontraktu starszego R1. Przed importem zachowano kopie
czterech wcześniej zmienionych plików generowanych. Zarządzana regeneracja
klienta, kontrola produkcyjnego TypeScript i API hygiene zakończyły się
PASS/exit 0. Oba source checks zachowały identyczny fingerprint wejścia
przed i po wykonaniu; nie kompilowano testów jednostkowych. Receipty
i hashe plików są zapisane oddzielnie w checkpointcie.

To odbiór kompilacji/pakietu i kontraktu, nie wykonanie operatora ani
kwalifikacja kwadratury, fizyki, trwałości sesji, LLG/Relax, UI/WebGL czy
którejkolwiek z czterech lanes. Kapsuła R3 poprzedza nowy matched-libm reader
i korektę scripted→interactive opisaną w sekcji 7; nie dowodzi ich kompilacji.
Nie zmieniono publicznych parametrów naukowych, jednostek ani Python→IR.

(antenna-r3-fixed-ram-comparison)=
<!-- DOC-ANCHOR:antenna-r3-fixed-ram-comparison -->
#### Wykonany test V/RT0/H R3 wyłącznie w RAM

Na powyższym dokładnym pakiecie R3 wykonano bez zmian przypięty
`examples/fem_antenna_current_source_inspection.py` przez zarządzaną receptę
`run-managed-antenna-ram`. Run `54fea22c769548ec9a971531833cd1ab`:
izolacja PASS, kontener/solver exit 0, właściwy dirty startup stamp i eksport.
SessionStore, historia, cache siatki oraz oryginalny wynik pozostały na tmpfs;
na D: zachowano wyłącznie eksport i dowody. Nie wykonano LLG ani Relax.

Oddzielny `scripts/compare_managed_antenna_ram.py::compare` odczytał inspection
record i porównał dane z niezależnym wzorcem tego jednego modelu:

| Wielkość / parametr kontroli | SI | Wynik lub zadany próg | Zakres |
|---|---|---|---|
| Maksymalny błąd potencjału po usunięciu gauge każdej gałęzi, 16 próbek | $\mathrm V$ | $1.1102230246251565\times10^{-16}$ | próg bezwzględny $10^{-8}\,\mathrm V$ |
| Maksymalny błąd wektora H, 4 próbki | $\mathrm{A\,m^{-1}}$ | $6.760249178929324\times10^{-9}$ | próg $10^{-8}\,\mathrm{A\,m^{-1}}$ plus $10^{-6}$ razy norma wzorcowego wektora H danego celu |
| Maksymalny błąd momentu RT0, 108 ścian / 36 elementów | $\mathrm A$ | $2.220446049250313\times10^{-16}$ | próg bezwzględny $10^{-8}\,\mathrm A$ |
| Maksymalna suma signed flux w elemencie | $\mathrm A$ | $0$ | bilans w obrębie tego fixture |

Porównania V/H, geometrycznych momentów RT0 oraz exact bundle→observable
association zakończyły się PASS. Zachowana deklaracja operatora to
`fem_oersted_direct_tetra_quadrature.v3`; ledger czterech celów zawiera
43632 `kernel_evaluations` i 648 `ledger_leaf_visits`. Przekazany native ledger
nie jest dowodem niezależnego odtworzenia adaptacji lub complete input pins.
Pierwsze wyjście porównania zostało ucięte przez limit odpowiedzi narzędzia;
ponowny read-only odczyt zwrócił pełny kompaktowy wynik, bez powielania
listy plików native identity zachowanej w oryginalnym receipcie runu.

Nie kwalifikuje to physical DOF weights, trzech poziomów zbieżności,
kanonicznego dekodera całego native bundle, reusable drive basis ani
kwadratury dla dowolnego celu. `physics_qualified=false`,
`durable_session_storage_qualified=false` i `reuse_LLG_FFT_qualified=false`
pozostają bez zmian. Nie jest to publikacja artefaktu raw evidence R3,
wykonanie scripted→interactive ani kwalifikacja czterech lanes.

(antenna-global-target-v3-binary-evidence-contract)=
#### Kontrakt osobnego artefaktu raw kwadratury i normalizacji

Źródłowo wdrożony cold codec `fem_direct_oersted_evidence.v1` zapisuje jawnie
little-endian, bez transmute layoutu C. Manifest `antenna_field_solution.v1`
otrzymuje addytywne `bases[].quadrature_evidence`: tylko schema, względny path,
SHA-256, byte_length i target_count. Nie przenosi tablic w JSON. Ta wersja
formatu wymaga operatora v3, global_target oraz obu dokładnych polityk
E/R opisanych powyżej; fixed magic koduje tę wersję, nie dowolne tokens.

Manifest ma także jawne `bases[].oersted_operator_version`: string wymagany
przy nowej publikacji, bez wyprowadzania realizacji z braku reference.
Stored reader zachowuje brak tej wartości jedynie do rozpoznania archiwum;
reuse i pełny validator odmawiają absent/unknown operator. Direct v3 wymaga
evidence; OE-F2 wymaga własnego operatora w diagnostykach i nie może mieć
direct evidence. To nie uwierzytelnia dowolnie przepisanej deklaracji
operatora: certyfikacja nadal wymaga niezależnego provenance/input verifiera.

| Kolejność i pole binarne | Typ / rozmiar | SI | Domena i znaczenie |
|---|---|---|---|
| magic `FM-OEF1-Q3-V1` + trzy NUL | 16 bytes / required | $1$ | dokładna wersja i polityki, unknown/future odmowa |
| `source_view_identity_digest`, `current_balance_certificate_digest` | po 64 ASCII bytes | $1$ | lowercase SHA-256, dokładnie source i RT0 certificate tej bazy; nie uwierzytelnienie |
| target_count, source_target_pairs, refined_pairs, unconverged_pair_count | cztery u64 LE / wynik | $1$ | 1–1000000 targetów; zero unconverged; source count wyznaczalny z roots/targets |
| kernel_evaluations, ledger_leaf_visits, base_quadrature_order, maximum_subdivision_depth | cztery u64 LE / wynik/request | $1$ | counters i bieżące dokładne parametry operatora |
| maximum_source_target_pairs, maximum_final_leaves_per_target, maximum_kernel_evaluations, maximum_ledger_leaf_visits | cztery u64 LE / request/caps | $1$ | dokładne bound/policy, bez podniesienia cap przez plik |
| maximum_pair_error_apm, absolute_tolerance_apm, relative_tolerance, relative_scale_floor_apm | cztery f64 LE / wynik/request | odpowiednio $\mathrm{A\,m^{-1}}$, $\mathrm{A\,m^{-1}}$, $1$, $\mathrm{A\,m^{-1}}$ | finite i nieujemne; floor dokładnie +0; max pair nie zastępuje globalnego ledgeru |
| measured_positive_terminal_current_a, normalization_scale | dwa f64 LE / wynik | $\mathrm A$, $\mathrm{A^{-1}}$ | positive finite, dokładnie ten sam binary64 current i scale=1/current co manifest |
| target records, ordered | po 96 bytes | jak tabela snapshotu | xyz[3], raw H[3], E/tau/R, trzy u64 leaf/kernel/visit; pełny komplet każdego punktu |

Header ma 288 bytes, całkowity plik dokładnie 288 + 96 razy target_count,
maksymalnie 96000288 bytes. Decoder sprawdza bound i dokładną długość przed
alokacją targetów; brak trailing bytes, truncated records, overflow lub
downcast order/depth. Jest to limit pojedynczego artefaktu, nie sumarycznego
RAM wszystkich portów, meshów i jednocześnie wczytanych payloadów.

Wspólny owned validator numeric sprawdza surowe pole i retained E/tau/R,
wersje/policy/options, roots/leaves/depth/refinements i globalne sumy pracy.
Publish wiąże każdy raw rekord bitowo z wejściowym sample xyz/H oraz
summary/certificate. Loader sprawdza dokładne xyz oraz wynik mnożenia
każdego raw H przez zapisany scale z odpowiednim H_per_A payload. Nie
odtwarza raw H przez per-A razy current. Numerics raw i normalizacja to
oddzielne bramki; current i scale nie zmieniają znaczenia E/tau/R.

Centralny asset verifier oraz oba loaders (drive projection i spectrum)
muszą używać tej samej kontroli referencji i numeric binding, także gdy
loaders otrzymają bundle z manifestem i innymi diagnostykami. Tylko pełny
asset verifier wymaga exact payload set; loader nie może ominąć bramki
przez inną ścieżkę wejścia. Duplikaty wskazanych payloadów są odmową.
SHA i ponowny rehash nie zastępują walidacji. Brak/mixed/future evidence
dla direct v3 jest odmową użycia i publikacji. Archiwalne manifesty nadal
mogą być odczytane jako archiwa, bez automatycznej promocji do reusable
globalnej bazy. OE-F2 nie otrzymuje direct evidence i nadal wymaga własnych
residual/gauge checks; wspólny codec nie daje mu kwalifikacji v3.

Python, `ProblemIR`, modele fizyczne, requested/resolved execution oraz
cztery lane nie zmieniają semantyki. R3 pozostaje source-only do czasu
wdrożenia i dowodu kompilacji/runtime, a R2 niezależny verifier i dowody
producenta pozostają osobną wymaganą bramką. Nowy codec nie oznacza
kwalifikacji closed/truncated circuit, Duffy/inside, LLG, FFT lub trwałości.

Stan źródłowy 2026-10-06: native adapter i binary decoder używają wspólnego
owned validatora; rzeczywisty publisher odbiera snapshot z wyniku RT0,
sprawdza raw xyz/H i normalizację, dodaje binary przed manifestem i wykonuje
pełny asset validator przed zwrotem artefaktów. Projekcja oraz spectrum
loader wykonują ten sam referenced-data validator przed wykorzystaniem
pola; enclosing bundle może zawierać manifest i inne diagnostyki, lecz
duplikaty payloadów są odmową. Stored basis nie gubi diagnostics ani
certificate. Summary float fields mają dodatkowe bit checks, w tym +0/-0.

API metadata i binary field endpoint również używają tego samego validatora
na oryginalnych bytes manifestu, nie na ponownie serializowanym DTO. Binary
endpoint oddaje te same accepted bytes bez drugiego odczytu pola. Reader
API ma jawne granice: manifest 16 MiB, suma zakodowanych payloadów jednego
odczytu 512 MiB,
mixed evidence maksymalnie 96000288 bytes. Sprawdza wielkości, przepełnienie,
namespace i aliasy przed alokacją/I/O; oversize oznacza odmowę, nie truncation.
To limity tego readera, nie fizyczny limit solvera ani całego datasetu.
Limit zakodowanych bytes nie ogranicza szczytowego RAM: dekodowane rekordy
evidence i współrzędne wymagają dodatkowych alokacji;
duże/multi-port zasoby wymagają osobnego bounded streaming projektu.

Dowody pozostają rozdzielone: 14 interpretowanych binary64/wire/source checks
PASS nie wykonuje Rust/native. Niezależny source review runner/codec i API
nie pozostawił Required/Blocker w tym zakresie. Regresje Rust codec,
producer/verifier/loaders i API bounds są zapisane, niekompilowane.
Syntax-only parse siedmiu plików nie zastępuje type/borrow check ani buildu.
Synthetic non-direct fixture
w starszych testach plumbing/lifecycle nie jest dowodem wykonania OE-F2.
OpenAPI/TS regeneration, build i runtime aktualnego R3, pełny zewnętrzny
R2 verifier oraz wymagane kwalifikacje nadal pozostają otwarte.

(antenna-global-target-v3-independent-reader-contract)=
<!-- DOC-ANCHOR:antenna-global-target-v3-independent-reader-contract -->
#### Niezależny odczyt evidence do porównania finite-wire

Weryfikator `tests/antenna/verify_field_convergence.py::read_solution` ma
domyślnie wymagać direct v3, pełnego binary evidence v1 i dokładnej zgodności
z ordered sample xyz, H/A, measured current, scale, certificate oraz thin
summary. SHA nie zastępuje numeric acceptance. Niezależny decoder Python
nie importuje implementacji Rust ani modeli z testów źródłowych; sprawdza
format, opcje, bounds, finite, roots/leaves/refinements, sumy pracy oraz
surowe E/tau/R. Dodawanie E i R porównuje jako dokładne liczby wymierne
reprezentujące binary64, aby nie zgubić dodatniego sub-ULP R przy równości.
FMA tolerancji jest odtworzone przez dokładny iloczyn i sumę binary64,
zaokrąglane raz do float; norma zachowuje dwa zagnieżdżone hypot, nie hypot
trzech składowych. Zgodność bitowa hypot Python z libm producenta nie jest
ogólną własnością: diagnostyka poniżej wykazała kontrprzykłady także w tym samym
obrazie runtime. Różnica oznacza odmowę, nie rozszerzenie tolerancji. Obecny
reader nie jest więc zakwalifikowany do dowolnego native v3 wyniku.
[Dokumentacja Python 3.10](https://docs.python.org/3.10/library/math.html#math.hypot)
opisuje poprawiony własny algorytm hypot; [kontrakt GNU libm](https://sourceware.org/glibc/manual/2.36/html_node/Errors-in-Math-Functions.html)
nie obiecuje wspólnego wyniku bitowego z Python. Każdy z tych algorytmów może
być numerycznie poprawny, a jednocześnie dać inny ostatni bit.

Jawny opt-in `allow_legacy_local_estimator` dopuszcza wyłącznie historyczne
v1/v2 bez evidence v3 i bez mixed/future operatorów. Raport oznacza go jako
historyczny lokalny estymator, nigdy globalny certyfikat; domyślny tryb
odmawia legacy. Trzy poziomy nie mogą mieszać kwalifikacji. Pozostają te same
fizyczne punkty, model finite filament, wyłączenie near-wire i progi L2/Linf.
Reader ma limity odczytu przed alokacją, nie zmienia limitów solwera.

| Parametr narzędzia analizy | Typ / default | SI | Walidacja, znaczenie i IR |
|---|---|---|---|
| `--manifests` | trzy ścieżki / required | $1$ | coarse/medium/fine, dokładne canonical manifesty jednej bazy, bez fallbacku; analiza artefaktów, bez zmiany IR |
| `--port-mode-id` | string / required | $1$ | dokładnie jedna baza o tym ID w każdym wyniku, normalized 1 A; bez zmiany IR |
| `--wire-start`, `--wire-end` | każde float[3] / required | $\mathrm m$ | finite różne końce finite filamentu, kierunek określa znak H; model odniesienia, bez zmiany IR |
| `--minimum-distance-m` | float / required | $\mathrm m$ | finite >0, odległość radialna od osi ≥ minimum; poza zakresem near-wire, bez zmiany IR |
| `--max-l2-relative`, `--max-linf-relative` | każde float / required | $1$ | finite >0, obecne progi błędu fine; brak automatycznego podnoszenia progów i brak zmiany IR |
| `--allow-legacy-local-estimator` | bool / false | $1$ | jawna analiza historyczna v1/v2; nie promocja do v3, raport bez globalnego certificate; bez zmiany IR |
| manifest / vectors / evidence read bound | fixed / 16 MiB, 1000000 targetów, 96000288 bytes evidence | $1$ jako liczba bytes/rekordów | limit czytnika przed odczytem i dekodowaniem, nie limit szczytowego RAM ani fizyki |

Aktualne regresje czytnika: 26 testów, 25 PASS i 1 SKIP (Windows nie pozwolił
utworzyć symlinku), exit 0; trzy nowe scenariusze miały RED przed poprawką.
Testy obejmują 3 A, dwa uporządkowane targety i odmowę reorder po rehash,
signed zero, complete rehash uszkodzonych pól/liczników/opcji, dodatnie
sub-ULP R, mixed/future i duplicate JSON. Kontrole funkcji verify, nie tylko
CLI, odmawiają niefinitywnych progów i błędów porównania; nie mogą zwrócić
PASS przez porównania z NaN. CLI direct-script `--help` PASS.

Python DSL, IR, planner, wszystkie cztery lane i runtime sessions bez zmian.
Regresje na syntetycznych plikach mają dowodzić czytnika i odmów, nie native
publikacji, closure, inside/near, LLG/FFT ani naukowego parytetu backendów.
Trzy rzeczywiście opublikowane native wyniki, niezależna tożsamość wejścia/
provenance i science acceptance pozostają wymagane przed odbiorem R2.

(antenna-retained-native-tolerance-bit-evidence)=
#### Ograniczony dowód zgodności bitów tolerancji — 2026-10-06

Bez nowego solve odczytano dokładny stage record i retained bundle poprzedniego
fixed RAM `8031eeff9ebf4ce28cca1fe5e8613329`, build
`e57249b5b5d1493b9949204336efcbef`. `scripts/antenna_inspection_export.py::read_inspection`
sprawdził canonical fixed namespace, descriptor counts/units i hashe payloadów;
`scripts/antenna_rt0_fixture_check.py::fields`, `one`, `group` wydobyły cztery
raw H i zapisane tolerancje v3. To bounded partial extraction, nie pełny
native decoder ani niezależna certyfikacja executed input pins.

`tests/antenna/direct_quadrature_evidence.py::exact_tolerance` odtworzył
z tych samych binary64 H zagnieżdżone hypot i rational one-round FMA z
$a_q=10^{-9}\,\mathrm{A\,m^{-1}}$, $r_q=10^{-5}$, bez dimensional floor.
Nie porównywano do pola analitycznego zamiast raw H i nie zmieniono progów.
Python 3.12.14/MSVC na Windows 11 porównano z zapisanymi wynikami native
FEM CPU/double z kontenera Linux. Każda tolerancja była identyczna bitowo:

| Target, indeks $1$ | Zapisane i odtworzone $\tau_t$ [$\mathrm{A\,m^{-1}}$], float.hex | Różnica reprezentacji [ULP, $1$] |
|---|---|---|
| 0 | `0x1.14042b3b2d9f4p-21` | 0 |
| 1 | `0x1.14042b5ad626cp-21` | 0 |
| 2 | `0x1.4972119654ff6p-21` | 0 |
| 3 | `0x1.9d17011dd56e4p-23` | 0 |

Bundle SHA-256 `78633e7d1d285f911cbc9247c28178ce5661481bd2bd4a1ac6fdbc8cfd501f16`,
stage record `ee023c22d2f219d518fb0b22060209142234563e10fc13dcf70223a95dd16bdf`,
manifest `b7af2be9d63fc32f348143fbf081d8660d2da2146ae0d05b30810d009b1a4db0`.
Dokładna sonda, H/xyz, hex wartości i runtime identity zachowane pod
`storage/tmp/<worktree-id>/current-source-oracle/retained-native-tau-bit-*20261006.*`.
Wejście sondy to `artifact-root` i przypięty record `stage-000`, jednostka $1$,
bez fallbacku na latest ani skanowania innych etapów. Sonda tylko czyta.

PASS dotyczy czterech finalnych tolerancji, nie identyczności pośrednich norm
ani wszystkich argumentów hypot/FMA, innych wersji bibliotek czy backendów.
Dodatkowa diagnostyka uruchomiła dokładne źródło czytnika R2 w obrazie
`sha256:e360637ea8b00e280efdca7648ee022e6dd16150b10130b734425bb8a65b5aa0`
wskazanym przez retained RAM receipt i trusted build context R1.
Python Linux 3.10.12/GCC 11.4/glibc 2.35 odtworzył te same cztery finalne
tolerancje bitowo: 4/4 PASS, bez allowance ULP. SHA źródła i wejścia
sprawdzono także wewnątrz sondy; wykonano źródło przez compile/exec,
bez korzystania z potencjalnego cache bytecode. Nie wywołano żadnego
solvera ani utworzenia sesji. Probe SHA-256
`450b55215ea2f7812c5aecd84de6848a17ff527aae101c409a636a3a2687e459`;
stdout/exit/komenda i runtime w `retained-native-tau-linux-evidence-20261006.json`
w tym samym current-source-oracle. Komenda wymusza readonly root/pliki,
network none i małe limity zasobów; nie wykonano osobnego attestu kontenera
RAM solvera, bo nie był to solve. Pełny runtime libm parity nadal otwarty.
Nie jest to R3 regular publication, trzy poziomy
meshu, source-input provenance, adaptacyjny history certificate, LLG/FFT
ani qualification. Python DSL/IR/planner i lane statuses bez zmian; FEM GPU,
FDM CPU/GPU nie otrzymują tego dowodu. Nie powtórzono RAM ani V/H solve.

(antenna-libm-parity-counterexample)=
<!-- DOC-ANCHOR:antenna-libm-parity-counterexample -->
#### Kontrprzykład zgodności Python hypot / GNU libm — 2026-10-06

Ograniczona sonda w tym samym przypiętym obrazie, Python 3.10.12 i glibc 2.35,
porównała dwa zagnieżdżone `math.hypot` z dwoma wywołaniami `hypot` z
`libm.so.6` przez `ctypes`, a następnie rational one-round FMA readera z
`libm.fma`. To wywołania biblioteki, nie wykonanie skompilowanego operatora
FEM; nie potwierdzają jego faktycznego dynamic symbol resolution ani ISA.
Źródło producenta `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp::norm`
stosuje tę samą kolejność nested hypot, a tolerancja używa `std::fma`.
Nie utworzono sesji, nie obliczono V/RT0/H, nie kompilowano ani nie
uruchamiano LLG/Relax. Progi, format v3 i wszystkie statusy lane bez zmian.

| Parametr diagnostyki | Typ / wartość fixed | Jednostka i zakres |
|---|---|---|
| seed generatora | int / 20261006 | $1$; reprodukowalny corpus, nie parametr Python DSL/IR |
| corpus | 12012 wektorów binary64 | wartości traktowane jako H w $\mathrm{A\,m^{-1}}$; 12 punktów skali i 12000 wektorów losowych |
| skale generatora | wykładniki całkowite | $1$; pierwsze 6000 wektorów: [-30,20], następne 6000: [-1022,1000]; nie zmienia validity modelu fizycznego |
| opcje tolerance | obecne $a_q$, $r_q$ | $10^{-9}\,\mathrm{A\,m^{-1}}$ i $10^{-5}$; bez floor i allowance ULP |
| porównanie | exact float.hex | $1$ jako reprezentacja; diagnostyka normy i finalnej tolerance oddzielnie |

W corpusie wystąpiło 111 różnic normy i 57 różnic finalnej tolerance.
Po podstawieniu **tej samej normy GNU libm** rational FMA i `libm.fma` dały
0 różnic w 12012 przypadkach. To lokalizuje obserwowaną rozbieżność w
algorytmie normy, nie dowodzi wszystkich FMA ani poprawności solvera.
Pierwszy kontrprzykład, indeks 243, ma raw H float.hex:
`[0x1.f9cae5703188cp+2, 0x1.3964d3f687cb0p+2, -0x1.94835fd3da3a0p+0]`.
Norma Python: `0x1.2dc5fe19fb42ep+3`, norma GNU libm:
`0x1.2dc5fe19fb42dp+3`; tolerance readera: `0x1.8b8b6d4969e6ap-14`,
tolerance GNU libm: `0x1.8b8b6d4969e69p-14`, w $\mathrm{A\,m^{-1}}$.
Istnieją także różnice finalnej tolerance o dwa ULP (indeks 266).

Corpus SHA-256 `8639273ce39e0f2a85f6648d635ef4f1d3b540fdeb6303f64411eb30182c41ab`;
sonda SHA-256 `0aa68a8ee3ca9d752581a980546b76f0ec51d07ae2daf10bc000318a23e7fd03`;
przypięty reader SHA-256
`c2feb016b8d2009ae09a2a35078ae43f20080c60c8fe705efd8a78c428c35fd6`.
Komenda, stdout, exit 0 diagnostyki i pięć hex kontrprzykładów:
`storage/tmp/<worktree-id>/current-source-oracle/antenna-libm-parity-evidence-20261006.json`.
Exit 0 oznacza wykonanie sondy; `parity_status=mismatch` oznacza negatywny
wynik hipotezy zgodności. Historyczne 4/4 retained tau PASS pozostaje ważne
wyłącznie dla tych czterech wartości, nie dla całego v3 readera.

**Required przed odbiorem R2:** wybrać i jawnie kwalifikować realizację normy.
Minimalny wariant dla obecnego native v3 to niezależny reader uruchamiany
w jawnie dopasowanym runtime/libm producenta, z pinned provenance, sprawdzeniem
symbolu/realizacji i odmową nieobsługiwanej platformy; sam `ctypes.CDLL` ani
wspólna nazwa biblioteki nie stanowią takiego dowodu. Wariant przenośny to
wspólny, dokładnie określony algorytm normy we wszystkich producentach i
readerach, ale zmienia realizację numeryczną: wymaga jawnej decyzji wersji
operatora, migracji i nowych bramek native/runtime. Nie dodawać ULP slack,
nie zastępować nested hypot wariantem trójargumentowym ani nie zaokrąglać
ponownie zapisanej tolerance. W chwili tego negatywnego pomiaru nie było
wdrożonej realizacji matched libm; późniejszy przyrost czytnika opisano niżej.
Pełna kwalifikacja pozostaje otwarta. FDM CPU/GPU oraz FEM GPU nie otrzymują
nowych dowodów.

(antenna-matched-libm-reader-realization)=
<!-- DOC-ANCHOR:antenna-matched-libm-reader-realization -->
#### Jawna realizacja normy czytnika dla GNU libm v3

Wdrożony przyrost narzędzia R2 nie zmienia operatora, progów, wire ani
publicznego Python DSL/IR. Jego zakres to jawny odczyt dokładnej biblioteki
matematycznej producenta. Pakiet R1 seq 34 po pełnym preflight ma native ELF
`libfullmag_fem.so.0.1.0` SHA-256
`b3146bc27d0361d8d7338acf930951080fba4738efa3b4d38589bc2046d1b92a`,
z undefined dynamic symbols `hypot@GLIBC_2.35` i `fma@GLIBC_2.2.5`.
Odczyt ELF nie uruchomił operatora ani nie kwalifikuje R3. W przypiętym obrazie
runtime symbol `hypot@GLIBC_2.35` wskazuje canonical
`/usr/lib/x86_64-linux-gnu/libm.so.6`, SHA-256
`3dd5511ae94785c9f921429b0f2b2f7aabb461b6f0e6de6dfdbef15f24bdfee6`.

Właściciel implementacji
`tests/antenna/matched_libm.py::MatchedLibmHypot` wiąże symbol przez GNU
`dlvsym`, nie wybiera domyślnego symbolu przez nazwę. Sprawdza absolute path,
caller-supplied expected digest, bounded file bytes przed załadowaniem,
GNU/Linux x86-64 capability, `dladdr` rzeczywiście rozwiązanej funkcji oraz
ponowny hash i zgodność canonical path. Odmawia innych runtime, symbolu,
pliku, hash lub trybu zaokrąglania niż nearest-even. Nie szuka alternatywnej
biblioteki i nie wraca niejawnie do Python hypot po niepowodzeniu. Po wiązaniu
stosuje dwa wywołania tej funkcji w ustalonej kolejności; FMA pozostaje
niezależnym rational one-round obliczeniem readera. Podawany hash musi
pochodzić ze zweryfikowanego, dopasowanego runtime producenta, nie być
automatycznie obliczony z dowolnej wybranej biblioteki i uznany za zaufany.

Wiązanie wymaga niemutowalnego, przypiętego runtime tylko do odczytu.
`dladdr` i dwukrotny hash potwierdzają ścieżkę symbolu i plik na dysku;
nie dowodzą odporności załadowanego ELF na równoległą podmianę pliku
w nieufnym środowisku. Czytnik zachowuje handle biblioteki przez cały czas
używania wskaźnika funkcji. Nie certyfikuje dowolnego procesu ani loadera.

| Parametr analizy | Typ / default | SI | Walidacja, znaczenie i IR |
|---|---|---|---|
| `--libm-path` | absolute path / brak | $1$ | optional paired z SHA; konkretny plik matched GNU/Linux x86-64 runtime, canonical path/symbol checked; bez zmiany IR |
| `--libm-sha256` | string / brak | $1$ | dokładnie 64 lowercase hex, required razem z path, expected identity z trusted runtime; brak automatycznego self-trust i zmiany IR |
| symbol | fixed `hypot@GLIBC_2.35` | $1$ | wersja odczytana z obecnego producenta R1; future/inna wersja wymaga osobnej realizacji i dowodów |
| library read bound | fixed 16 MiB | $1$ jako liczba bytes | przed odczytem/załadowaniem, nie limit pola ani meshu |
| rounding mode | fixed nearest-even | $1$ | read-only `fegetround`; odmowa, bez zmiany środowiska procesu |

Brak obu nowych parametrów pozostawia historyczny tryb Python hypot jako
**diagnostykę niezakwalifikowaną**, nie dopasowaną matematykę producenta.
Raport ujawnia `python_hypot_diagnostic_only`; podanie tylko jednego
parametru jest błędem CLI (exit 2). Jawny archive legacy ma
`not_applied_legacy_local_estimator`, ponieważ nie stosuje tej normy.
Wybranie biblioteki jest przekazane przez CLI, `verify`, cold solution
reader i evidence decoder, a nie użyte tylko w osobnym teście. Metadane
raportu zachowują rzeczywisty digest, wersję symbolu i rounding mode,
ale `producer_math_qualified=False` i brak kwalifikacji producer provenance.

Samo poprawne wiązanie symbolu nie kwalifikuje producer/input provenance,
wykonania skompilowanego operatora, wszystkich ISA, trzech native poziomów,
R3 publication ani fizyki. Wykonany RED→GREEN adaptera rozpoczął się od
4 ERROR (brak modułu); końcowe interpretowane regresje w przypiętym obrazie
`sha256:e360637ea8b00e280efdca7648ee022e6dd16150b10130b734425bb8a65b5aa0`:
**37/37 PASS, 0 SKIP**, exit 0. Fingerprint ośmiu źródeł przed/po jest równy
`52ff4f5ac26b43667cec94366999eca87540bff57395ad8704ac1afc2616da47`.
Kontener diagnostyczny ma read-only root/source, brak sieci i capabilities,
UID/GID 65532, 1 CPU, 256 MiB RAM, 32 procesy i tmpfs 16 MiB wyłącznie dla
syntetycznych plików testowych; nie uruchamia solvera, sesji ani LLG/Relax.

`tests/antenna/test_matched_libm.py::test_pinned_diagnostic_corpus_has_no_tolerance_mismatch`
powtórzył ten sam syntetyczny corpus 12012 wektorów, SHA-256
`8639273ce39e0f2a85f6648d635ef4f1d3b540fdeb6303f64411eb30182c41ab`:
**0 różnic finalnej tolerance** względem GNU FMA na wybranej normie.
To skończony test arytmetyki, nie wszystkie wejścia/ISA ani pola operatora.
`test_realization_reaches_cold_decoder_and_one_ulp_mutation_refused`
potwierdził akceptację kontrprzykładu z matched profile i odmowę po zmianie
tolerance o 1 ULP mimo ponownego hashowania payloadu. CLI i odmowy złych
pinów/platformy/rounding także PASS; progów nie osłabiono.

Windows przez zamknięte `just verify-antenna-field-reader`: 31 testów,
30 PASS, 1 test symlink SKIP oraz dodatkowy SKIP całej klasy matched GNU
runtime (bez jawnych pinów); dwa wpisy SKIP w receipcie. Regresje wrappera
2/2 PASS. Końcowy receipt:
`storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671/antenna-field-reader/be26432e902446a094b876251c6445c4/receipt.json`.
Dowody końcowych źródeł: `antenna-matched-libm-evidence-20261006.json`
w taskowym `current-source-oracle` storage. Niezależny odczyt kodu nie
znalazł Required/Blocker; nie uruchamiał testów ani nie zatwierdzał fizyki.
Pełna kwalifikacja R2 pozostaje odrębna. Wszystkie cztery lane zachowują
wcześniejsze statusy.

Historyczny prywatny wrapper pola zachowywał **niezakwalifikowaną** politykę
lokalnego kernela, zamiast deklarować standardowy relative-error certificate:

```{math}
:label: antenna-external-quadrature-local-policy
\|\mathbf H_{\mathrm{high}}-\mathbf H_{\mathrm{low}}\|
\leq a_q+r_q\max(\|\mathbf H_{\mathrm{high}}\|,h_q),
\qquad h_q=1\,\mathrm{A\,m^{-1}}.
```

$\mathbf H_{\mathrm{high}},\mathbf H_{\mathrm{low}}$ są dwoma lokalnymi
oszacowaniami całki [$\mathrm{A\,m^{-1}}$], $a_q$ tolerancją absolutną
[$\mathrm{A\,m^{-1}}$], $r_q$ tolerancją względną [$1$], a $h_q$ jawnym
progiem skali [$\mathrm{A\,m^{-1}}$]. Dla małych pól default dopuszcza
około $10^{-5}\,\mathrm{A\,m^{-1}}$, nie mały błąd względny tego pola.
Estymator par low/high i tolerancje lokalnych podziałów nie są rygorystycznym
globalnym oszacowaniem błędu sumy. Usunięcie dimensional floor, rozdział
budżetu błędu przy adaptacji i niezależna kwalifikacja małych pól są nadal
wymaganymi bramkami T06; brak niekonwergentnych par nie zamyka tych bramek.

Dowód runtime 2026-10-05: w zachowanym RAM `444b0769d1524dc6b6d4899d8ef2a941`
native record ma order 4, depth 6, $a_q=10^{-9}\,\mathrm{A\,m^{-1}}$,
$r_q=10^{-5}$, $h_q=1\,\mathrm{A\,m^{-1}}$; 144 par, zero refinements i
zero unconverged. Największy low/high estimator to
`3.617581831753044e-6 A/m`. Lokalna polityka dopuszcza co najmniej
`1.0001e-5 A/m`, mimo że oracle wymaga znacznie mniejszego błędu końcowej
sumy. Rzeczywiste błędy normy H w czterech punktach wynoszą kolejno
`4.551868310297808e-7`, `4.7480923849064843e-7`, `8.365609367236374e-8`,
`1.3075838894083228e-9 A/m`; pierwsze trzy przekraczają niezmienioną bramkę
oracle, maksymalnie 7.744 razy. Związanie retained V/xyz/H PASS nie zmienia
tego FAIL. To dowód niedopasowania lokalnej akceptacji do wymaganej
dokładności sumy, nie rygorystyczne oszacowanie błędu kwadratury ani
kwalifikacja truncated circuit. Przed następnym science run wymagane są
wersjonowana polityka bez arbitralnego floor, rozdział budżetu źródeł i
adaptacyjnych dzieci oraz niezależna zbieżność. Nie zwiększać tolerancji
testu, aby zaakceptować te wartości.

| Parametr wrappera pola | Typ / default | SI | Domena i failure | Realizacja / provenance |
|---|---|---|---|---|
| `source` | finalized immutable owner / required | $1$ | tylko powyższy owner; exact owned mesh/GF/P1 | FEM CPU/double, prywatny |
| `target_points` | ordered xyz array / required | $\mathrm m$ | finite; pusta lista dozwolona; znany rozmiar targets/H podlega preflight 128 MiB przed całkowaniem | ten sam porządek w result/hash |
| `base_quadrature_order` | int / 4 | $1$ | 2–16, odmowa przed kernel; brak przepełnienia `order+2*depth+2` | wersjonowany private bound |
| `maximum_subdivision_depth` | int / 6 | $1$ | 0–6; niekonwergencja jest błędem, nie accepted result | adaptacja z diagnostyką |
| `absolute_tolerance_apm` | double / $10^{-9}$ | $\mathrm{A\,m^{-1}}$ | finite, nieujemna; lokalne $a_q$, nie globalny error bound | retained field policy |
| `relative_tolerance` | double / $10^{-5}$ | $1$ | finite, nieujemna; lokalne $r_q$ z jawnym $h_q$ | nie standardowy small-field relative certificate |
| `relative_scale_floor_apm` | fixed 1 | $\mathrm{A\,m^{-1}}$ | polityka legacy kernela, nie opcja caller | jawnie w record; do zastąpienia przed qualification |
| `maximum_source_target_pairs` | u64 / $10^6$ | $1$ | 1–$10^6$; iloczyn NE×Ntargets sprawdzany przez kernel bez overflow | nie dowód wydajności całej adaptacji |

Wynik ma własne `fem_accepted_external_lead_field.v1`, charge SHA,
source-finalization SHA, stały scope oraz exact retained bytes/SHA obejmujące
ordered targets, opcje, H i diagnostykę. Pole legacy
`source_view_identity_digest` pozostaje puste: nowy SHA nie udaje identity
`ConservativeCurrentView`. Wymagany jest osobny dowód meshera braku
nakładających się objętości; face-incidence, role i partition checks tego
nie poświadczają. Ten warunek wejścia i kwalifikacja truncacji pozostają
otwarte, nie są zastępowane bilansem prądu.

Realizacja FDM CPU/GPU i FEM GPU tego finalizatora jest unsupported;
FEM CPU pozostaje prywatnym etapem źródłowym, bez deklaracji kwalifikacji.
Dotychczasowe Python/ProblemIR i ABI nie zmieniają się. Adapter Rust i publiczny
producent muszą później przenieść jawny zakres pola i mapę actuator→observation;
nie wolno połączyć tylko H z nowego ownera z V/J/prądem legacy solve.
Regresje źródłowe obejmą lifetime, identyczność mesh/FE-space/GF/P1, niezmienione
RT0 DOF, znak/zero/mały prąd, odmowę stale pin, niepełnej partycji/roli/mapy
oraz błędnego podziału gałęzi. Natywne testy i kwalifikacja runtime pozostają
`NOT VERIFIED` do czasu dozwolonego wykonania.

(antenna-accepted-external-lead-bundle-abi)=
#### Jedno wywołanie native i jeden pakiet V/RT0/H

Źródłowa implementacja append-only `fullmag_fem_solve_accepted_external_lead_field_v1` wykonuje
jeden autorytatywny workflow current-driven na całej zadanej domenie:
accepted charge → finite-domain finalization → direct field evaluation.
Odpowiedź terminalowa może obejmować unit controls i końcowe rozwiązanie
na tym samym K; „jeden workflow” nie oznacza jednego iteracyjnego solve
macierzy. Nie wykonujemy drugiego, niezależnie sterowanego legacy charge
workflow po wyliczeniu V/J ani capacity-probe solve.

Nowe ABI przekazuje wszystkie wymagane argumenty closure, zamiast wyprowadzać
role, stable IDs lub branch currents z nazw, ordinali, przypadkowych markerów
czy współrzędnych. `required_charge_content_digest` prywatnego finalizatora
powstaje wewnątrz workflow z rzeczywistego retained ownera; caller nie może
znać hasha przyszłego wyniku numerycznego ani zastąpić go etykietą.
Boundary IDs podane przez caller są nadal sprawdzane przez finalizator
z pełną physical exterior incidence. GPU jest unavailable, bez fallbacku.

| Nowe C wejście | Typ / default | SI | Walidacja, znaczenie, lane / Python→IR |
|---|---|---|---|
| `abi_version`, `reserved_flags`, `struct_size` | u32/u32/u64 / 1/0/exact | $1$ | niezależny header nowego request; AMD64 496 bytes, prefix 16 bytes; FEM CPU private ABI |
| `charge` | `fullmag_fem_accepted_terminal_charge_request_v1` / required | jak tabela charge ABI | kompletny nested header, mesh, stable IDs, sigma, wszystkie outer currents, exact interfaces i solver policy; bez zmiany jego layoutu 360 bytes |
| `closure_revision` | C string / required | $1$ | bounded UTF-8 bez NUL, do 4096 bytes; w retained finalizer record |
| `device_vertex_ids`, `device_vertex_count` | u64 pointer/count / required | $1$ | nonnull, niepuste, count≤NV, rzeczywiste stable IDs |
| `lead_vertex_ids`, `lead_vertex_count` | u64 pointer/count / required | $1$ | nonnull, niepuste, total device+lead dokładnie NV; pełny partition gate pozostaje native |
| `boundary_faces`, `boundary_face_count` | typed pointer/count / required | $1$ | exact exterior role coverage; count≤actual facet support przed kopiowaniem |
| `boundary.vertex_ids`, `role`, `reserved`, `circuit_id` | u64[3], u32, u32, C string / required | $1$ | sorted actual face key, role 1=insulating/2=outer/3=device–lead, reserved=0; empty/null ID tylko insulating, inaczej exact owned terminal/pair ID; rekord 40 bytes |
| `branches`, `branch_count` | typed pointer/count / required | $1$ | 1..Ninterfaces; wszystkie retained pary dokładnie raz |
| `branch.id`, `interface_pair_ids`, `interface_pair_count`, `requested_device_outward_current_a` | string/string-pointer-array/u64/double / required | $\mathrm A$ dla prądu, $1$ dla ID/count | bounded strings, nonempty groups, checked total count≤Ninterfaces, finite signed current; rekord 32 bytes |
| `target_xyz_m`, `target_count` | double pointer / count / required | $\mathrm m$ | trzy ordered współrzędne na target, finite; nullptr tylko dla count=0; count i known record size ograniczone przed kosztowną całką |
| `base_quadrature_order`, `maximum_subdivision_depth`, `absolute_tolerance_apm`, `relative_tolerance`, `maximum_source_target_pairs` | int32/int32/double/double/u64 / jak wrapper | $1$, $1$, $\mathrm{A\,m^{-1}}$, $1$, $1$ | ta sama bounded private policy oraz jawny floor 1 A/m; bez silniejszej deklaracji error certificate |

Result ma osobny typ i fingerprint, mimo że zachowuje prosty layout
bounded-record 656 bytes: version/flags/size, caller payload pointer,
capacity/len, schema/operator/fingerprint po 96 chars, content SHA 65 chars
i error 256 chars. Wszystkie nazwy pól, jednostki i failure semantics są
takie jak w record ABI; payload dotyczy **nowego** schema
`accepted_external_lead_bundle.ordered.v1` i operatora
`fem_accepted_external_lead_bundle.v1`, nie otwartego charge ani legacy view.
Pełny result error resetuje len/metadata; truncated result prefix nie otrzymuje
zapisów poza dostępnym headerem. Caller zapewnia prawdziwe capacity i dostępność
minimum 16-byte prefix dla niezerowych struct pointers. Długość jest publikowana
na końcu, po sukcesie wszystkich faz; żaden błąd nie daje partially accepted H.
Fingerprint jest stały:
`fullmag:fem-accepted-external-lead:abi:v1:canonical-owned-bundle`.
Własny workflow `solve_accepted_external_lead_bundle` odrzuca istniejący
owner albo pin w closure request, po czym sam tworzy accepted charge owner,
wiąże finalizer i całkuje jego RT0. Wspólny importer charge waliduje nested
header i zachowuje wcześniejsze ABI; nie wywołuje legacy field workflow.
Serializowane records są dokładnymi retained bytes, nie ponownym kodowaniem
przez C adapter. Source implementation nie oznacza potwierdzenia kompilacji
ani wykonania regresji.

Outer typed BE stream zawiera kolejno `schema`, `operator_version`,
`field_scope`, następnie `charge_content_sha256` i binary `charge_record`,
`source_content_sha256` i binary `source_record`, `field_content_sha256`
i binary `field_record`. Text tag=1, binary tag=3, framing jak istniejący
canonical builder. Każdy nested SHA obejmuje dokładne przeniesione bytes.
Field record wiąże source i charge SHA; finalizer wiąże charge SHA.
**Łączny** preimage bundle, trzy rekordy i overhead muszą zmieścić się
w 128 MiB; bound jest sprawdzany przed złożeniem pakietu, nie jest sumą
trzech niezależnych limitów 128 MiB ani deklaracją peak RAM.

V jest scalar P1 w voltach w accepted charge record. Reprezentacja J to
`rt0_face_flux_moments`, momenty w amperach z jawnie zakodowaną mapą
face/DOF/sign i owned tet geometry; fizyczna funkcja wektorowa RT0 ma
jednostkę $\mathrm{A\,m^{-2}}$. Nie są to nodalne wartości raw P1 gradientu.
H pochodzi z tego samego owned RT0 i ma jednostkę $\mathrm{A\,m^{-1}}$.
Późniejsza wizualizacja J musi nazwać i kwalifikować sposób próbkowania lub
projekcji; bundle nie fabrykuje nodalnego J ani B. Relacja B=mu0 H w airboxie
pozostaje osobnym kontraktem quantity/material, nie zmianą jednostki H w ABI.

(antenna-external-bundle-signed-ledger)=
##### Podpisane powiązanie RT0 z fizycznym ledger

Przed integracją producenta obowiązuje source record schema
`accepted_external_lead_current_source.ordered.v2` oraz operator
`fem_accepted_external_lead_current_source.v2`. Wersja 2 dodaje do każdej
physical face `face_rt0_to_canonical_weight` [$1$]. Native liczy ten
współczynnik przez rzeczywisty Piola `CalcVShape` na owned przestrzeni,
z actual element DOF sign oraz canonical stable-vertex face normal;
nie wyprowadza go z ilorazu flux/prąd (ten byłby nieokreślony dla zera).
Nie tworzy drugiego solve ani nie modyfikuje accepted GF. Obowiązuje

```{math}
:label: antenna-external-bundle-signed-face
\Phi_f=w_f q_{d(f)}.
```

Consumer sprawdza tę **podpisaną** relację z lokalnym SI gate, nie
`abs(Phi)==abs(q)`. Współczynnik zawiera normalizację użytej bazy: nie wolno
zakładać, że każdy surowy współczynnik MFEM jest jednostkowym physical
momentem bez tej mapy. Canonical/outward signs wynikają z zadanej geometrii
tet i sorted stable face key. Physical side rows są ułożone według
lexicographic stable element key; canonical jump nadal dotyczy rzeczywistej
first/second incidence charge record, więc consumer uwzględnia ewentualną
zamianę side rows.

Z tego samego signed face ledger odbiorca sumuje element divergence i
absolute scales, każdą elektrodę oraz każdą stronę interface; sprawdza
insulating face z lokalną skalą sąsiedniego elementu. Nie wystarcza
porównanie dwóch cached terminal certificate rows. Agregaty gałęzi,
komponentów i fizycznego ledger używają stabilnej sumy kompensowanej;
nie wolno poszerzać gate 1e-18 A w celu ukrycia błędu sumowania.
Regresja musi odrzucić zmianę znaku niezerowego RT0 współczynnika przy
niezmienionych physical rows, nawet po przeliczeniu wszystkich SHA.
Synthetic codec fixture nie zastępuje poprawnego native request; osobne
called-main ABI fixtures zachowują actual disjoint terminal/trace support.

Źródłowy fixture dekodera Rust składa się z trzech osobno indeksowanych
kostek (device oraz dwa lead), 24 vertices, 18 tet, 54 faces i 36 exterior
faces. Dla $\sigma=1\,\mathrm{S\,m^{-1}}$ oraz
$V=-(x+1\,\mathrm m)\,\mathrm{V\,m^{-1}}$ analityczny prąd wynosi
$\mathbf J=(1,0,0)\,\mathrm{A\,m^{-2}}$. Terminale i grupy reakcji
gałęzi są rozłączne; reakcja nodalna jest sumą minus jednej trzeciej
outward flux każdego przyległego exterior trójkąta.
H w punkcie na osi symetrii przekroju jest zerowe z symetrii, mimo
niezerowych współczynników RT0. Fixture sprawdza poprawną ścieżkę codec
przed odmową fully-rehashed zmiany znaku q, weight/scale/outward/rank oraz
field target/policy/diagnostics. Certyfikat ma 18 divergence, 4 interface
i 2 terminal rows: łącznie 24, rank 23, pominięte `terminal-current:ground`
z reason 2 i zerowym anchor. Consumer wiąże row count z liczbą rzeczywistych
elementów, interfaces i terminali, ale nie powiela exact-rank solve w Rust.
Codec weight=2 jest syntetyczną kalibracją, nie dowodem MFEM basis weight.
Osobna regresja helpera sumowania zachowuje
resztę $2^{-54}\,\mathrm A$ dla kolejności
$1\,\mathrm A,2^{-54}\,\mathrm A,-1\,\mathrm A$.
To źródła testów, nie wykonany Rust/native test ani kwadraturowy benchmark.

Konsument ma niezależnie dekodować framing, sprawdzić wszystkie schema,
operator/scope, exact bytes/SHA i cross-digests oraz request binding każdego
nested rekordu: charge mesh/material/controls/policy, finalizer canonical
partition/roles/branches/revision oraz field ordered targets/options.
Opaque poprawny hash bez tych kontroli nie wystarcza. Publiczny
Python/ProblemIR nie otrzymuje alternatywnego modelu; jawny resolver
actuator→observation i integracja producenta pozostają osobnymi bramkami.
FDM CPU/GPU i FEM GPU solve tego ABI są unsupported. FEM CPU jest
source-only prerequisite, nie potwierdzony runtime ani pełna baza LLG.
Regresje mają obejmować wspólną analitykę V/RT0/H, reversal/zero,
nested headers/pointers/counts, atomic failure/truncated canary, capacity,
stale/corrupt nested bytes i request mismatch. Native unit build ban pozostaje
obowiązujący; źródła regresji nie są dowodem ich wykonania.

| Wynik nowego ABI | Typ / default | SI | Walidacja i interpretacja |
|---|---|---|---|
| `abi_version`, `reserved_flags`, `struct_size` | u32/u32/u64 / caller 1/0/exact | $1$ | niezmieniony caller header; osobny typ 656 bytes |
| `canonical_payload`, `canonical_payload_capacity` | caller byte pointer/u64 / required | byte / $1$ | nonnull, capacity 1..128 MiB; caller zapewnia rzeczywisty sized buffer, nie capacity-probe solve |
| `canonical_payload_len` | u64 / 0 | byte / $1$ | 0 przy błędzie pełnego result; sukces dopiero po wszystkich fazach, 1..capacity |
| `digest_schema` | char[96] / empty | $1$ | NUL-terminated exact `accepted_external_lead_bundle.ordered.v1` tylko przy sukcesie |
| `operator_version` | char[96] / empty | $1$ | NUL-terminated exact `fem_accepted_external_lead_bundle.v1` tylko przy sukcesie |
| `layout_fingerprint` | char[96] / empty | $1$ | dokładny fingerprint powyżej, oddzielny od charge ABI |
| `content_sha256` | char[65] / empty | $1$ | lower-case SHA-256 dokładnych outer bytes; consumer liczy niezależnie i wiąże trzy nested digests |
| `error_message` | char[256] / empty | $1$ | bounded NUL-terminated opis odmowy; success empty; truncated prefix nie otrzymuje tego pola |

Called-main regresje ABI używają rzeczywistego trójblokowego przewodnika
z 36 tet, 36 autorskimi stable IDs, 60 exterior faces i 4 parowanymi
contact triangles. Niezależnie parsują framing/tag3 i SHA każdego nested
record, analytic P1 V, signed terminal/device H1/RT0 oraz ordered targets.
Test odd linearity i doubling H na tym samym far target ma własny gate
$10^{-8}\,\mathrm{A\,m^{-1}}+10^{-4}\max(|H_{\mathrm{expected}}|,|H_{\mathrm{measured}}|)$,
przy niezerowym sygnale dodatnim. Jest to tolerancja tej regresji, nie
globalny error bound ani nowa policy operatora. Odmowy obejmują outer/nested
headers, reserved fields, roles/IDs/branches, GPU, policy/budget/capacity,
brak partial payload i truncated canaries. Regresje pozostają niekompilowane
i niewykonane; wynik kwalifikacji nie jest wyprowadzany z ich źródeł.

Prywatny odbiorca Rust wykonuje jedno FFI z typowanym request. Wspólny
`with_packed_charge_request` tylko waliduje i utrzymuje lifetime input
buffers; nie wykonuje solve. Dekoder niezależnie liczy outer i nested SHA,
sprawdza framing, operators/scopes, request binding oraz koniec wszystkich
rekordów. P1 component label wskazuje gauge/anchor vertex, natomiast
finalizer component ID jest najmniejszym stable ID rzeczywistej połączonej
objętości. Te identyfikatory nie muszą być równe: odbiorca mapuje label na
minimum, nie zmienia charge labels. Physical element/face ledgers mają
sorted stable keys, a charge vertices/elements zachowują local order.
Empty boundary circuit ID jest dozwolony tylko dla insulating role.
`refined_pairs` może przekroczyć liczbę pierwotnych source-target pairs;
rekursywnych podcałek nie wolno traktować jako dodatkowych physical tet.

| Prywatny Rust request | Typ / default | SI | Walidacja / mapowanie |
|---|---|---|---|
| `charge` | `AcceptedTerminalChargeRequest` / required | zgodnie z charge ABI | te same mesh/stable IDs/material/terminals/interfaces/policy, wspólne pack helper; jeden nested C request |
| `closure_revision` | `&str` / required | $1$ | bounded nonempty UTF-8 bez NUL; dokładne porównanie source record |
| `device_vertex_ids`, `lead_vertex_ids` | borrowed u64 slices / required | $1$ | nonempty, pełna rozłączna partycja charge IDs; source zapisuje sorted sets |
| `boundary_faces` | `ExternalLeadBoundary` slice / required | $1$ | sorted trzy stable IDs, role 1/2/3, circuit ID zgodny z rolą; porównanie pełnej actual boundary map |
| `branches` | `ExternalLeadBranch` slice / required | $\mathrm A$ dla current | unique ID, pełne rozłączne interface pair groups i finite signed requested current; branch order autorski, pair IDs sortowane |
| `targets_m` | borrowed ordered [f64;3] slice / required | $\mathrm m$ | finite, count=liczba punktów, checked NE×count≤pair budget; H powstaje w tej samej kolejności |
| `quadrature` | `ExternalLeadQuadraturePolicy` / required | jak C options | bounded order/depth/atol/rtol/maxpairs; exact porównanie field policy wraz z fixed floor 1 A/m |

Typowany wynik przechowuje outer bytes/SHA, parsed accepted charge z V/RT0,
source/field SHA, ordered `h_xyz_apm` oraz source-target/refinement/error
diagnostics. Nie wykonuje drugiej numeryki w Rust. Retained caller buffer
128 MiB i dodatkowy parsed charge record nie są dowodem kwalifikacji peak
RAM; bounded preimage nie oznacza bounded całkowitej pamięci procesu.
Publiczny producer nie jest jeszcze konsumentem tej ścieżki.

(antenna-current-driven-source-input)=
#### Wersjonowane żądanie current-driven: wejście nie jest zaakceptowanym polem

Nowy kontrakt `CurrentTransport.conservative_current_source` opisuje zamiar
wykonania solve, a nie istniejący `ConservativeCurrentView`. Wariant
`kind=external_lead_current`, `schema_version=conservative_current_source.v1`
nie ma `source_field_digest` ani `required_source_field_digest`: hash
przyszłego V/RT0/H nie istnieje przed obliczeniem. Nie rozszerzamy starego
voltage-driven `ConservativeCurrentExternalLead` o opcjonalne prądy i nie
reinterpretujemy jego pinów. W jednym module charge najwyżej jeden z pól
`conservative_current_source`, `conservative_current_view`,
`structured_current_closure` może być obecny.

Jest to jawny **ekspercki kontrakt po materializacji siatki**. Nie zastępuje
docelowego authoringu anteny z geometrii i nie upoważnia do wymyślenia stable
IDs jako `index+1`. Caller przekazuje rzeczywiste stable IDs w porządku
device mesh i lead mesh; planner sprawdza je względem rzeczywistej siatki.
Geometria przewężenia pozostaje pełną domeną 3D, nie modelem przekroju 2.5D.

`outer_terminals` są actuatorami: current-driven H1 rozwiązuje potencjały
equipotential z zadanych **podpisanych outward prądów**. Natomiast
`terminal_observations` wyłącznie identyfikują grupy interfejsów po stronie
device. Obserwacja nie narzuca napięcia, equipotential ani normal current
density. Nie dodajemy jej do `ChargeBoundaryIR` i nie przekładamy z nazwy
obiektu na warunek brzegowy. Przy nowym źródle `CurrentTransport.boundaries`
jest puste; każdy autorski legacy BC, także insulating, jest błędem, nie
ignorowanym polem. Pozostałe rzeczywiste exterior faces materializator
klasyfikuje jako insulating dopiero po rozwiązaniu interface i electrode
ownership. Puste boundaries nie może uruchomić legacy reguły „cała granica
device jest izolowana”.

Jest to statyczne precompute: `time_envelope` w module z tym źródłem jest
zabronione. Waveform należy do późniejszego `SolvedAntennaDrive`; nie jest
instrukcją ponawiania solve H1 przy każdym kroku czasu.

Lead mesh używa kompletnego współczesnego `MeshIR`: dodatnio zorientowane,
nieosobliwe Tet4, finite xyz, wyłącznie actual exterior Tri3 oraz dokładne
pokrycie granicy. Niepuste relacje periodic i nieznane pola root/cells/
facets/quality są odrzucane; znane metadane oraz puste listy periodic są
zachowywane w round-trip. Markery tego źródła mają zakres `1..INT_MAX`,
wymagany przez natywny importer. Nie zmienia to globalnego kontraktu markeru
0 dla innych siatek, w szczególności airboxu. Lead NE nie przekracza $2^{20}$,
lead NV i liczba facets nie przekraczają czterokrotności NE; pozostałe listy
i sumaryczne liczby terminal faces, observation pair references oraz wpisów
prądowych **wszystkich** drives nie przekraczają $4\cdot2^{20}$. Te same
bramki obowiązują Python i typed IR przed przyszłym native packing.

Dla portu $p$ i gałęzi $q$ wagi $w_{p,q}$ oraz referencja $I_p=1\,\mathrm A$
określają dwa odrębne oczekiwane pomiary:

```{math}
:label: antenna-source-port-observation-current
F_{\mathrm{inlet}}^{\mathrm{requested}}=-w_{p,q}I_p,
\qquad F_{\mathrm{outlet}}^{\mathrm{requested}}=+w_{p,q}I_p,
\qquad I_p=1\,\mathrm A.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $p,q$ | indeksy port mode i gałęzi | $1$ |
| $w_{p,q}$ | podpisana waga gałęzi; suma dodatnich wag 1, suma wszystkich 0 | $1$ |
| $I_p$ | prąd referencyjny portu | $\mathrm A$ |
| $F_{\mathrm{inlet}}^{\mathrm{requested}},F_{\mathrm{outlet}}^{\mathrm{requested}}$ | oczekiwane outward prądy dwóch odrębnych obserwacji gałęzi, nie outer actuation | $\mathrm A$ |

Nie łączymy inlet/outlet w jedną grupę: ich suma znika i nie certyfikuje
przepływu. Publiczne endpoint refs portu rozwiązują się w tym wariancie
wyłącznie przez ID obserwacji. Obie obserwacje gałęzi należą do tego samego
rzeczywistego obiektu; dodatnia ścieżka należy do `source_object_id`.
Planner sprawdza każdy device face i przyległy tet względem rzeczywistego
object segment. Wszystkie interfejsy należą dokładnie do jednej obserwacji;
różne obserwacje nie współdzielą device reaction DOF. Nie wkładamy ID
obserwacji do resolved pól nazwanych `*_terminal_boundary_id`.

`drives` są jawne i przypisane do `port_mode_ref`; aktywne żądanie wybiera
dokładnie jeden pasujący drive. Każdy drive zadaje finite signed current
każdego outer terminal, także zero. Prądów actuatorów nie wyprowadzamy
automatycznie z wag branch. Naturalny podział gałęzi wynika z geometrii,
przewodności i jawnego actuation; finalizator odrzuca niezgodność z wagami.
Dwie zewnętrzne elektrody nie zapewniają dowolnego asymetrycznego podziału
CPW. Takiego błędu nie naprawia niezależne przeskalowanie J lub H gałęzi.
Bilans prądów sprawdzamy osobno na każdym elektrycznym komponencie według
istniejącego signed SI gate, po ustaleniu rzeczywistej łączności trace.

Drive z wszystkimi prądami równymi zero może być zapisany i wiernie odczytany
jako zamiar autora. Nie stanowi jednak znormalizowanej bazy portu 1 A:
porównanie z niezerowymi oczekiwaniami portu musi go odrzucić. Obsługa zero
w authoringu nie jest dowodem gotowości takiego wyniku do LLG.

| Python | Typ | Default | SI | Walidacja | Znaczenie | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CurrentTransport.conservative_current_source` | `ExternalLeadCurrentSource \| None` | None | $1$ | complete one-way ohmic, puste boundaries i terminal_reference; wyklucza view/structured | jawny current-driven input, nie accepted output | authoring ekspercki; public producer/runtime NOT VERIFIED | `current_modules[].definition.conservative_current_source` |
| `ExternalLeadCurrentSource.schema_version` | `str` | conservative_current_source.v1 | $1$ | dokładny obsługiwany schema | wersja kontraktu wejściowego | authoring ekspercki; FEM CPU/double solve niezakwalifikowany | `current_modules[].definition.conservative_current_source.schema_version` |
| `ExternalLeadCurrentSource.revision` | `str` | required | $1$ | niepusty UTF-8 bez NUL, maksymalnie 4096 bytes | rewizja autorska, nie przyszły output SHA | authoring ekspercki; FEM CPU/double solve niezakwalifikowany | `current_modules[].definition.conservative_current_source.revision` |
| `ExternalLeadCurrentSource.device_stable_vertex_ids` | `Sequence[int]` | required | $1$ | positive unique u64 w rzeczywistym porządku device vertices | jawna tożsamość device vertices | authoring ekspercki po materializacji siatki | `current_modules[].definition.conservative_current_source.device_stable_vertex_ids` |
| `ExternalLeadCurrentSource.lead_mesh` | `MeshData \| MeshIR` | required | $\mathrm m$ dla nodes | finite xyz i nieosobliwe poprawne tet4 CSR | rzeczywista pełna geometria 3D przewodów | authoring ekspercki po materializacji siatki | `current_modules[].definition.conservative_current_source.lead_mesh` |
| `ExternalLeadCurrentSource.lead_stable_vertex_ids` | `Sequence[int]` | required | $1$ | positive unique u64; count=lead NV; rozłączne z device IDs | jawna tożsamość lead vertices | authoring ekspercki po materializacji siatki | `current_modules[].definition.conservative_current_source.lead_stable_vertex_ids` |
| `ExternalLeadCurrentSource.lead_conductivity_spm_per_element` | `Sequence[float]` | required | $\mathrm{S\,m^{-1}}$ | finite positive; count=lead NE w porządku komórek | przewodność przewodów | authoring ekspercki | `current_modules[].definition.conservative_current_source.lead_conductivity_spm_per_element` |
| `ExternalLeadCurrentSource.interface_pairs` | `Sequence[CurrentSourceInterfacePair]` | required | $1$ | nonempty; unique IDs i face ownership | jawne contact triangles | authoring ekspercki | `current_modules[].definition.conservative_current_source.interface_pairs[]` |
| `CurrentSourceInterfacePair.id` | `str` | required | $1$ | niepusty UTF-8 bez NUL, maksymalnie 4096 bytes | tożsamość interfejsu | authoring ekspercki | `current_modules[].definition.conservative_current_source.interface_pairs[].id` |
| `CurrentSourceInterfacePair.device_face_vertex_ids` | `Sequence[int]` | required | $1$ | trzy distinct positive u64; sorted key i device membership | ściana po stronie device | authoring ekspercki po materializacji siatki | `current_modules[].definition.conservative_current_source.interface_pairs[].device_face_vertex_ids` |
| `CurrentSourceInterfacePair.lead_face_vertex_ids` | `Sequence[int]` | required | $1$ | trzy distinct positive u64; sorted key i lead membership | ściana po stronie lead | authoring ekspercki po materializacji siatki | `current_modules[].definition.conservative_current_source.interface_pairs[].lead_face_vertex_ids` |
| `CurrentSourceInterfacePair.vertex_pairs` | `Sequence[tuple[int,int]]` | required | $1$ | trzy jawne pary tworzące dokładną bijekcję vertices obu faces | autorska mapa trace, nie wnioskowanie z odległości | authoring ekspercki | `current_modules[].definition.conservative_current_source.interface_pairs[].vertex_pairs` |
| `ExternalLeadCurrentSource.outer_terminals` | `Sequence[CurrentSourceOuterTerminal]` | required | $1$ | co najmniej dwa; rozłączne actual lead exterior support | actuatory prądowe | authoring ekspercki | `current_modules[].definition.conservative_current_source.outer_terminals[]` |
| `CurrentSourceOuterTerminal.id` | `str` | required | $1$ | unique niepusty UTF-8 bez NUL, maksymalnie 4096 bytes | tożsamość actuatora | authoring ekspercki | `current_modules[].definition.conservative_current_source.outer_terminals[].id` |
| `CurrentSourceOuterTerminal.boundary_face_vertex_ids` | `Sequence[Sequence[int]]` | required | $1$ | nonempty actual lead exterior faces bez powtórzeń ról i konfliktu trace DOF | powierzchnia zewnętrznej elektrody | authoring ekspercki po materializacji siatki | `current_modules[].definition.conservative_current_source.outer_terminals[].boundary_face_vertex_ids` |
| `ExternalLeadCurrentSource.terminal_observations` | `Sequence[CurrentSourceTerminalObservation]` | required | $1$ | unique IDs i dokładna partycja interfejsów | pasywne pomiary po stronie device, nie BC | authoring ekspercki | `current_modules[].definition.conservative_current_source.terminal_observations[]` |
| `CurrentSourceTerminalObservation.id` | `str` | required | $1$ | unique niepusty UTF-8 bez NUL, maksymalnie 4096 bytes | tożsamość obserwacji endpointu portu | authoring ekspercki | `current_modules[].definition.conservative_current_source.terminal_observations[].id` |
| `CurrentSourceTerminalObservation.object_id` | `str` | required | $1$ | istniejący immutable object ID; exact face/tet ownership w plannerze | właściciel fizyczny, nie name/type | authoring ekspercki | `current_modules[].definition.conservative_current_source.terminal_observations[].object_id` |
| `CurrentSourceTerminalObservation.interface_pair_ids` | `Sequence[str]` | required | $1$ | nonempty unique istniejące IDs; rozłączne reaction support obserwacji | grupa mierzonych kontaktów device | authoring ekspercki | `current_modules[].definition.conservative_current_source.terminal_observations[].interface_pair_ids` |
| `ExternalLeadCurrentSource.drives` | `Sequence[CurrentSourceDrive]` | required | $1$ | nonempty; unique IDs i port_mode_ref | jawne actuation każdego mode | authoring ekspercki | `current_modules[].definition.conservative_current_source.drives[]` |
| `CurrentSourceDrive.id` | `str` | required | $1$ | niepusty UTF-8 bez NUL, maksymalnie 4096 bytes | tożsamość autorskiego drive | authoring ekspercki | `current_modules[].definition.conservative_current_source.drives[].id` |
| `CurrentSourceDrive.port_mode_ref` | `str` | required | $1$ | unique exact referencja autorskiego port mode | wybór mode bez fallbacku do pierwszego drive | authoring ekspercki | `current_modules[].definition.conservative_current_source.drives[].port_mode_ref` |
| `CurrentSourceDrive.outer_terminal_currents_a` | `Mapping[str,float]` | required | $\mathrm A$ | exact terminal ID coverage; finite signed w tym zero; bilans fizycznych komponentów | zewnętrzne actuation, nie wywnioskowane wagi gałęzi | authoring ekspercki; current solve niezakwalifikowany | `current_modules[].definition.conservative_current_source.drives[].outer_terminal_currents_a` |
| `AntennaFieldSolveStage.solver_policy` | `str` | production_default | $1$ | niepusty token; materializator nowego source obsługuje wyłącznie production_default, inne odrzuca | requested policy zachowana osobno od resolved unqualified preset | FEM CPU/double input; public source execution niedostępne | `antenna_field_solve_stages[].solver_policy` |
| `AntennaFieldSolveStage.conductor_mesh_policy` | `str` | authored_shared_domain | $1$ | nowy source wymaga authored_shared_domain i rzeczywistej pełnej siatki 3D Tet4 | istniejąca polityka autorskiej siatki, nie dowód jakości lub zbieżności | FEM CPU/double input; inne source mesh policies niedostępne | `antenna_field_solve_stages[].conductor_mesh_policy` |

Gauge usuwa wyłącznie nullspace potencjału. Native wybiera w każdej
elektrycznej składowej outer terminal z najmniejszym rzeczywistym stable
vertex ID i zachowuje reference terminal/vertex IDs w output provenance.
`zero_mean` i `dirichlet_reference` pozostają unavailable w tym wariancie;
nie zamieniamy ich po cichu na inną politykę. Terminal reference nie
narzuca dodatkowego fizycznego przepływu ani voltage bias.

Planner wylicza wersjonowane request pins z **całego rzeczywistego wejścia**:
authored source, selected drive/port, geometry, combined mesh/topology,
conductivity i solver/field policy. Caller nie autoruje future output SHA.
Hash-policy określa dokładny porządek i reprezentację; JSON Python z
`sort_keys=True` nie jest domyślnie tym samym preimage co Rust typed JSON.
Retained charge/source/field SHA powstają dopiero z accepted bundle. Publisher
zachowuje combined P1 V i RT0 carrier wraz z jego mapami; nie podstawia
device-only legacy V albo nodalnego J. Budżet direct field dotyczy combined
device+lead NE razy liczba targets, nie tylko device NE.

Migracja jest addytywna: stare dokumenty bez nowego pola mają niezmienioną
interpretację. Import, canonical export i Python→IR muszą zachować całą
mapę bijekcji, obserwacje, wszystkie drives i wartości signed/zero. Nieznany
schema/kind/pole, niepełne mapy, konflikt BC i nieobsługiwany backend mają
failować jawnie; poprawny round-trip nie stanowi dowodu wykonania solvera.

| Lane nowego source solve | Stan i bramka |
|---|---|
| FEM CPU / double | implementacja etapowa; prywatny bundle istnieje źródłowo; public producer i runtime/numerical qualification nadal `NOT VERIFIED` |
| FEM GPU | unsupported source solve; bez CPU fallbacku przy forced GPU |
| FDM CPU | unsupported source solve; późniejszy import qualified sampled basis jest odrębnym kontraktem |
| FDM GPU | unsupported source solve; import/device LLG wymaga osobnej kwalifikacji |

Ten wariant publikuje wyłącznie `external_electrode_truncation`. Nie awansuje
do `closed_loop` ani bazy LLG bez niezależnej kwalifikacji truncacji i błędu
pola. Sinusoidalny waveform później skaluje zakwalifikowaną przestrzenną
bazę w czasie RHS/RK; nie wymaga ponawiania charge/Biot–Savart solve, ale
samo dodanie nowego input nie dowodzi ukończenia tej konsumpcji.

**Bieżący przyrost źródłowy:** Python klasy i oba publiczne wrappers,
import sceny, script export, typed IR oraz authoring validation zachowują
całe żądanie. Płaski `CurrentModuleIR` propaguje błędne **nie-null** źródło;
absent/null zachowują opcjonalną semantykę legacy. Planner i runner mają
jawne bramki odmowy przed legacy charge/prescribed/voltage fallbackiem.
Nowy publiczny single-bundle producer oraz versioned RT0 publisher nie są
jeszcze podłączone. Wykonane Python checks to **76 passed i 91 subtests
passed**; źródłowe regresje Rust nie były kompilowane ani wykonywane.
Te dowody dotyczą authoringu i odmowy nieobsługiwanej ścieżki, nie pola H.

(antenna-current-source-materialization)=
#### Materializacja wejścia nie dopuszcza publicznego wykonania

Osobny `ResolvedAntennaExternalLeadCurrentInputIR` opisuje wyłącznie
zweryfikowane topologicznie **wejście** dedicated stage. Nie jest
`ResolvedChargeTransportPlanIR`, `ConservativeCurrentView`, wynikiem H1 ani
`AntennaFieldSolution`. Nie daje capability ready i nie może zostać przyjęty
przez legacy publisher. Public execution gate pozostaje zamknięty do
jednoczesnego podłączenia jednego native bundle i versioned RT0/P1/H
publishera. Materializator jest zaimplementowany źródłowo; poniższy kontrakt
nie jest dowodem kompilacji ani wykonania solvera.

Materializator otrzymuje rzeczywistą device mesh z object segments,
pełny charge definition, wybrany stage/port oraz field-sampling carrier.
Material przypisuje przez exact immutable `object_id` i checked element
ranges. Nie korzysta z geometry-name fallbacku ani saturating ranges.
Każdy element i każdy vertex muszą mieć dokładnie jednego właściciela;
każdy object-domain material musi mieć jednoznaczne dodatnie scalar sigma.
Subregiony i tensor/bidirectional transport pozostają poza tym wariantem.
Requested `conductor_mesh_policy=authored_shared_domain` zachowuje istniejący
publiczny default. Pełne 3D wynika ze sprawdzonej topologii, nie z wymyślonego
tokenu `full_3d`. Jawny legacy `conservative_current_view_ref` stage jest zachowany
w requested snapshot/pin, ale nie wybiera źródła tego wariantu: jedynym
selektorem jest jawne `current_transport_id` i jego typed source. Nie
tworzymy fikcyjnego accepted view z tej referencji. Przed produkcyjnym
odblokowaniem należy usunąć obowiązkowy legacy selector z nowego authoringu
w addytywnej migracji stage API; obecny krok nie maskuje tej luki.

Device i lead są konkatenowane bez weld, zmiany współrzędnych, markerów,
kolejności komórek lub wygenerowanych stable vertex IDs. Connectivity
lead dostaje wyłącznie checked offset lokalnych indeksów. Combined runtime
ordinals stanowią nowy jawny porządek; source ordinals i quality metadata
oryginalnych siatek są zachowane oddzielnie w tożsamości wejścia, nie
przedstawiane jako zagregowane quality combined mesh. Nie używamy ponownie
legacy `merge_fem_meshes` do device+lead, ponieważ normalizuje markery.

Mapa actual face key → przyległy tetrahedron dowodzi exterior i object
ownership każdej device observation. Każda para zachowuje first=device,
second=lead, jawne vertex bijections, exact binary64 coincidence i przeciwne
strony styku. Każda ściana ma dokładnie jedną rolę: insulating, outer
electrode albo typed interface. Electrical components wynikają z actual
P1 vertex adjacency i authored interface identifications; elektroda nie
może rozciągać się między komponentami. Signed outer-current balance
stosuje istniejący próg SI **osobno dla każdego komponentu**. Nie wystarcza
globalne znoszenie prądów między rozłącznymi obwodami.
Spójność elektryczna P1 musi dodatkowo odpowiadać spójności fizycznych
objętości: drugi graf łączy elementy wyłącznie przez wspólną rzeczywistą
ścianę lub jawny device/lead interface. Wymagana jest bijekcja komponentów
tego grafu i komponentów P1. Sam wspólny vertex lub edge nie może stworzyć
fikcyjnego przewodzącego zwarcia dwóch objętości. Ten warunek odpowiada
istniejącemu native finalizerowi; nie jest globalnym testem intersection
siatek ani dowodem conditioning.
Obsługiwany wariant wymaga w każdym komponencie device, lead i co najmniej
dwóch zewnętrznych elektrod. Floating/lead-only komponenty są jawną odmową
tego przyrostu, nie domyślnym dopisaniem izolacji lub syntetycznego zasilania.

Checked input musi spełniać również ograniczenia istniejącego native
terminal-current adaptera. `max_iterations` należy do `1..=INT_MAX`, nie
całego zakresu `u32`. Liczba niezależnych sterowań to suma liczby terminali
pomniejszonej o jeden w każdym komponencie; musi być co najwyżej 64.
To limit aktualnej realizacji odpowiedzi terminalowej, nie ograniczenie
fizyczne liczby elektrod. Przed wykonaniem obowiązuje także odwrotne
domknięcie P1: każda rzeczywista lead exterior face, której wszystkie trzy
wierzchołki są essential dla tej samej elektrody, musi być jawnie wpisana
do tej elektrody. Fully-essential separator z wierzchołkami różnych
elektrod jest odrzucany. Ściana z choć jednym free P1 vertex pozostaje
dopuszczalna. Nie dopisujemy pominiętych ścian automatycznie i nie
zastępujemy tego testu samym warunkiem rozłączności authored face lists.

Wybrany port musi pokrywać wszystkie source observations dokładnie raz.
Nieprzypisanych grup nie uzupełniamy zerem ani zmierzonym RHS. Inlet/outlet
pozostają dwiema observation requests o znakach z równania
`antenna-source-port-observation-current`; outer currents są kopiowane
wyłącznie z jednego jawnego drive pasującego do wybranego portu.

| Dane materializatora | Typ / default | SI | Walidacja i znaczenie |
|---|---|---|---|
| device mesh, object segments | `MeshIR`, `Vec<FemObjectSegmentIR>`, wymagane | xyz $\mathrm m$, indeksy $1$ | actual Tet4/exterior Tri3, complete exact ownership i checked ranges |
| charge definition, selected source | `ChargeTransportDefinitionIR`, `ConservativeCurrentSourceIR`, wymagane | sigma $\mathrm{S\,m^{-1}}$ | complete static one-way source policy; input, nie wynik |
| stage, port, selected drive | typed stage/port/drive, wymagane | prądy $\mathrm A$, wagi $1$ | exact IDs, pełne observation coverage, bez inferowania actuatorów |
| field sampling | `AntennaFieldSamplingPlanIR`, wymagane | xyz $\mathrm m$ | finite actual target points i carrier identity |
| combined mesh, ordered IDs, partitions | typed mesh i listy, wyliczane | xyz $\mathrm m$, IDs $1$ | bounded checked append, disjoint device/lead, no weld |
| combined conductivity | `Vec<f64>`, wyliczana | $\mathrm{S\,m^{-1}}$ | dodatnie finite sigma w dokładnym combined element ordering |
| interface, terminal, boundary roles | typed listy, wyliczane | IDs $1$, prądy $\mathrm A$ | actual exterior, jawne maps i role, complete coverage |
| observation requests | typed lista, wyliczana | $\mathrm A$ | osobne signed inlet/outlet, actual object face/tet owner |
| solver i direct policy | `ChargeSolverPolicyIR`, bounded field policy | próg pola $\mathrm{A\,m^{-1}}$, pozostałe $1$ | H1/cg, absolute linear tolerance 0, max iterations 1..=INT_MAX; combined NE×targets; explicit vector potential unsupported, bez direct fallbacku |
| input pins | wersjonowane SHA-256, wyliczane | $1$ | deterministyczny canonical input preimage, nie SHA przyszłego pola |

W tym przyroście requested `solver_policy=production_default` mapuje się
jawnie na `external_lead_direct_defaults.unqualified.v1`: base order 4,
depth 6, absolute $10^{-9}\,\mathrm{A\,m^{-1}}$, relative $10^{-5}$ i
max pairs $10^6$, zgodnie z istniejącym `DirectTetraQuadratureOptions`.
Inne tokeny nowego source są odrzucane, nie domyślnie interpretowane.
Nazwa requested policy nie jest qualification; public execution nadal
kończy się odmową. Nie zacieśniamy ani nie luzujemy tolerancji bez jawnej
zmiany tej pinowanej polityki i osobnego dowodu naukowego.

Pins muszą obejmować actual source, selected drive/port/stage, device i lead
ordering/ownership/material oraz solver i targets. Canonical input JSON
sortuje klucze obiektów rekurencyjnie, zachowuje kolejność tablic i odrzuca
nie-finite dane przed serializacją; nie polega na kolejności `HashMap`
quality metadata. Numeryczny record wyjściowy nadal używa własnego ordered
binary schema i SHA, nie JSON preimage. Są to odrębne identyfikatory.
Count gates nie są kwalifikacją peak RAM: owned input snapshots,
`serde_json::Value` i canonical preimage buffer zwiększają pamięć względem
samej siatki. Profilowanie i preflight całej pamięci pozostają oddzielnym
wymaganiem produkcyjnym; nie ukrywa ich limit retained native bundle.

Ta materializacja nie dowodzi braku nielokalnego overlap objętości,
conditioning H1/RT0, błędu kwadratury, truncation convergence ani gotowości
LLG. Brak tych dowodów pozostaje jawnym gate kwalifikacji; w szczególności
poprawny interface i partition nie są certyfikatem całej geometrii.
Jedenaście funkcji regresyjnych zapisano w źródłach Rust, w tym granice
INT_MAX/64 controls, odwrotne domknięcie P1 oraz odmowę zwarcia objętości
przez sam wierzchołek lub krawędź i lokalny optional-selector gate.
Nie były kompilowane ani wykonywane.
Niezależny source review sprawdził cztery naprawione native-fit gates
bez dodatkowego blockera w tym zakresie. Parser/format check nie zastępuje
typechecku ani wykonania.

(antenna-current-source-stage-selector)=
#### Kontrakt opcjonalnego selektora legacy w stage

Nowy dedicated source nie wybiera starego `ConservativeCurrentViewIR`.
`AntennaFieldSolveStage.conservative_current_view_ref` ma więc docelowy typ
`str | None` z default `None`, a IR/resource typ `Option<String>`, zamiast
obowiązkowego tekstu lub sentinela `""`. Canonical serialization pomija
`None`; import absent/null reprezentuje brak selektora. Niepusty jawny
identyfikator legacy pozostaje zachowany, także w historycznym stage nowego
source jako inert requested metadata — nie staje się selektorem źródła.
Rust serde zachowuje dokładny jawny tekst. Python utrzymuje dotychczasową
normalizację `require_non_empty` (strip); round-trip zachowuje tekst
kanoniczny, nie nieznormalizowane zewnętrzne whitespace.

Semantyczna walidacja obu wersji ProblemIR sprawdza konkretny
`current_transport_id`. Brak selektora jest dozwolony wyłącznie wtedy,
gdy dokładnie ten `CurrentTransport.definition` zawiera typed
`conservative_current_source`. Legacy ścieżka wymaga niepustego jawnego
selektora; `Some("")` i whitespace-only są błędne w każdej ścieżce.
Obecność source w innym module, nazwa obiektu, typ prezentacyjny ani
brakująca definicja nie mogą zwolnić z tego wymagania. Canonical Python
export i scene round-trip nie dopisują sztucznego identyfikatora.

| Python | Typ | Default | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| `AntennaFieldSolveStage.conservative_current_view_ref` | `str \| None` | `None` | $1$ | absent/null tylko gdy wskazany CurrentTransport ma typed source; present blank odrzucany; legacy wymaga niepustego identyfikatora; source materializer stosuje także limit 4096 bytes i brak NUL | optional legacy selector, source stage nie wymaga sztucznego view | authoring backend-neutral; dedicated FEM CPU/double execution unavailable; generated OpenAPI pending | `antenna_field_solve_stages[].conservative_current_view_ref: Option<String>; None pomijane` |

OpenAPI musi wyprowadzić optional field z rzeczywistego resource schema;
generated types nie mogą być ręcznie patchowane. UI ma rozróżniać legacy
view i typed source, ale ta korekta nie włącza solve, drive lub spectrum.
Do czasu regeneracji aktualnego OpenAPI, kontroli Rust i kwalifikacji
konsumentów zmiana pozostaje przyrostem źródłowym, nie release-ready API.

Migracja jest zaimplementowana w Python, IR i resource schema. Python
constructor nie zna całego modelu: module-scoped warunek source/legacy
sprawdza `validate_stage_current_view_ref` w obu wejściach walidacji
ProblemIR przed plannerem. Pure source materializer sam odrzuca blank
zanim zapisze pins; historyczny niepusty selector pozostaje inert metadata
i zmienia requested pin. Regresje wire shape obejmują absent/null/Some,
a oba validator entrypoints są wywołane z kontrolą wyłącznie diagnostics
selektora, nie z deklaracją pełnej poprawności bootstrap modelu.

Wykonano 29 testów Python z `test_antenna_composition_contract.py` i
`test_antenna_stage_workflow.py` (exit 0), obejmujących lokalny typed
stage, omission w canonical script export/replay i scene passthrough.
To dowód authoringu/serializacji, nie publicznego wykonania typed source.
Regresje IR/materializatora/OpenAPI pozostają niekompilowane i niewykonane;
source review nie znalazł dodatkowego blockera w migracji.

(antenna-external-lead-inspection-publication)=
#### Osobny artefakt inspekcyjny: implementacja źródłowa, nie podmiana bazy v1

Audyt publishera wskazuje konieczność osobnego schema
`antenna_external_lead_solution.v1` (implementacja **source-only**). Existing
`AntennaFieldBasisInput` wymaga nodal V/J i wspólnego per-ampere rescale;
nie nadaje się do przeniesienia combined P1/RT0/H nowego bundle. Nie można
w nim zachować J z wcześniejszego charge solve ani wpisać raw RT0 moments
pod jednostkę nodal J. Legacy `antenna_field_solution.v1` pozostaje czytelne
bez reinterpretacji i renormalizacji.

Autorytatywnym numerical payload ma być jeden exact retained bounded record
`accepted_external_lead_bundle.ordered.v1`, z jego SHA i trzema nested SHA.
Combined V pozostaje w $\mathrm V$, raw RT0 coefficients w $\mathrm A$
wraz z signed face/DOF/weight map, H w $\mathrm{A\,m^{-1}}$. Ordered device
V selection musi być wyprowadzony z rzeczywistych device stable IDs do
retained combined vertices, nie z geometry-name match lub drugiego solve.
To nie jest jeszcze `_per_ampere` carrier ani wynik gotowy do LLG.

Manifest ma wiązać stage/output/source/module/port/drive IDs, input pins,
requested/resolved execution, sampling carrier i exact bundle identity.
Scope pozostaje `external_electrode_truncation`, stan `inspection_only`,
qualification `NOT VERIFIED`; LLG i source-spectrum readers mają zwracać
jawne `source_not_qualified` przed projekcją lub FFT. Jeżeli data plane
wymaga pochodnego float64 H/xyz payload, reader porównuje jego rzeczywiste
dane z decoded bundle — poprawny hash pochodnej nie dowodzi tej zgodności.
Duży bundle pozostaje binary payload, nie JSON control-plane resource.

Konkretny kontrakt publishera nie dodaje drugiego modelu fizycznego ani
publicznego konstruktora Python. Przyjmuje istniejący
`ResolvedAntennaExternalLeadCurrentInputIR`, jawny `RequestedTransportExecutionIR`,
wskazany output stage oraz exact bytes/SHA bundle. Solver policy nie zawiera
device/precision; nie wolno rekonstruować requested execution z samego wyniku.
Przed publikacją ponownie materializuje wejście z zachowanych
authored danych i porównuje cały wynik, a nie tylko deklarowane pins. Następnie
dekoduje exact bytes i wiąże rekord z rzeczywistym native request. Adapter
`antenna_external_lead_request_adapter.v1` zachowuje native jump tolerances
absolutną $10^{-12}\,\mathrm V$ i względną $10^{-12}$; nie są to tolerancje
LLG. Resolved wykonanie jest wyłącznie FEM CPU/double. Sam odczyt owned codec
nie wymaga flagi włączającej kompilację solvera; native solve i request binding
pozostają warunkowane dostępnością natywnego FEM.

Manifest jest cienki: nie kopiuje xyz, potencjałów, RT0 ani list device IDs do
JSON. Zawiera pięć referencji do binary payload: autorytatywny bundle oraz
pochodne xyz/H/device IDs/device V. Device ID i V mają wspólną, jawnie zapisaną
kolejność; każde V musi być bitowo równe retained potential dla odpowiadającego
stable ID. Zbiór ID musi dokładnie pokrywać device partition. XYZ i H również
porównujemy z retained record bitowo, bez interpolacji i bez rescale. Pochodne
nie otrzymują niezależnego statusu naukowego. Combined V oraz RT0 z pełnymi
mapami nadal odczytuje się z autorytatywnego bundle.

| Pole kontraktu | Typ | Default | SI | Walidacja / failure | Znaczenie | Backend | ProblemIR / pochodzenie |
|---|---|---|---|---|---|---|---|
| input, output ID | checked IR, `str` | wymagane | $1$ | re-materialization exact equality; zgodne ID i authored quantity `H_ant_basis`, jak w plannerze; brak path traversal | rzeczywiste wejście i nazwana publikacja, bez promocji jednostek wyniku | producer FEM CPU/double | istniejący input/stage, bez nowego authoring API |
| stage/source object/current transport/port/drive/closure IDs | siedem `str` z output ID | z rzeczywistych ownerów | $1$ | nonblank UTF-8 bez NUL, do 4096 bytes; output do 128 ASCII safe-component bytes, bez Windows reserved names | jawna tożsamość, nazwa nie aktywuje fizyki | inspection wspólne | `input.stage`, `input.port`, `input.selected_drive`, authored source revision |
| bundle bytes/SHA | binary, lowercase hex | wymagane | $1$ | nonempty, do 128 MiB; nested integrity i real request binding | jeden autorytatywny V/RT0/H solve | producer FEM CPU/double; codec bez solvera | accepted result, nie input pin |
| requested/resolved execution, solver policy | `RequestedTransportExecutionIR`, typed receipt, solver policy | execution wymagane / CPU-double; policy z wejścia | $1$ | strict FEM, CPU lub auto, double; GPU request odrzucony; exact fixed adapter/operator version | intencja zachowana osobno od wykonania | cztery lanes rozróżnione | requested execution właściciela transportu, `input.solver`, adapter |
| input pins | `AntennaCurrentInputPinsIR` | z wejścia | $1$ | schemat i sześć `sha256:` + lowercase hex; nested output SHA pozostają bez prefix; builder sprawdza wyprowadzenie pins | provenance i przyszłe stale checks, nie autentyczność | wspólne | `input.pins` |
| sampling carrier | domain/kind/location/digest/count | z wejścia | count $1$ | domain object/region IDs nonblank, bounded i bez NUL; finite ordered target data w bundle; node carrier i bounded count | opis nośnika, bez ciężkich tablic w JSON | inspection wspólne | `input.field_sampling` |
| binary references | path/SHA/size/layout/unit/count | pięć stałych nazw | xyz $\mathrm m$, H $\mathrm{A\,m^{-1}}$, V $\mathrm V$, ID $1$ | exact size/hash oraz zgodność pochodnych z bundle; brak dowolnych ścieżek | data plane bez nodal J i per-ampere | inspection wspólne | wynik runtime |
| scope/status/qualification | literal strings | `external_electrode_truncation` / `inspection_only` / `NOT VERIFIED` | $1$ | inne wartości odrzucone; brak `ready` | niezakwalifikowany wkład modeled-domain | żadna lane nie otrzymuje LLG/FFT PASS | wynik runtime |
| content digest / reference | SHA-256 / stage-output-digest | wyprowadzane | $1$ | deterministic manifest digest bez własnego digest field; expected reference equality | niezmienna rewizja oddzielnego namespace | inspection wspólne | artifact reference, nie stary field-basis asset |
| publication / cancellation | output root, optional atomic flag | root wymagany, flaga absent | $1$ | create-new files, bounded read, brak symlink descendants; cancel przed rename; collision tylko identyczne verified bytes | jeden atomic directory rename, brak częściowego ready | host filesystem | runtime, nie Python physics parameter |
| execution producer | actual input/execution/output, optional atomic flag | wymagane; flaga absent | $1$ | guard przed jednym native call; cancel przed/po non-preemptive solve; bez FEM jawna odmowa | źródłowe połączenie solve z raw artifact, nie LLG | FEM CPU/double | istniejący dedicated stage |
| inspection stage record | schema/stage/port/output/status/ref/units | schema `antenna_external_lead_stage_output.v1` | record $1$, payload units jak wyżej | bounded 1 MiB, create-new/hard-link bez overwrite; cancelled/failed bez outputs; inspection bez ready | odrębny rekord zakończenia, obecny API catalog nie obsługuje go | wspólny host runtime | requested authored stage, nie nowy parametr fizyczny |
| runtime stage ID zasobu | `str` | wymagane | $1$ | exact registered stage i namespace; brak authored-ID aliasu lub skanu innych etapów | identyfikator wykonania, odrębny od authored `stage_id` wyniku | wspólny host runtime | session stage record, bez nowego ProblemIR parameter |
| inspection payload selector | jedno z pięciu `str` | wymagane w binary GET | zgodne z payload descriptor | nieznana wartość: HTTP 400; brak osobnego RT0 payload | wybór retained bytes, bez przeliczania pola | bezsolverowy reader | wynik runtime, nie Python authoring |
| requested content digest | `str`, `sha256:` + hex | wymagane w binary GET | $1$ | exact `inspection_ref.content_digest`; mismatch: HTTP 409 przed payload I/O | pin wybranej rewizji, nie `record_content_digest` | wspólny host runtime | immutable inspection reference |
| JSON validation scope | literal `manifest_only` | stałe | $1$ | manifest shape/digest/descriptor size/unit/count; nie czyta binary arrays | metadane bez obietnicy payload integrity/freshness | bezsolverowy reader | API read-model, nie kwalifikacja ProblemIR |

Namespace publikacji to `antenna/external_lead_solutions/<output>/<digest>/`.
Manifest zapisujemy po binary files w prywatnym temporary sibling, ponownie
sprawdzamy cały zestaw, a następnie publikujemy rename. Reuse wymaga zgodnych
verified manifest/payload bytes; nie nadpisujemy istniejącej rewizji. Brak
pełnego fsync katalogów na każdym hoście nie jest gwarancją odporności na
utracone zasilanie. SHA, kontrola symlinków i atomic rename nie są mechanizmem
autentyczności ani ochroną przed wrogą współbieżną mutacją filesystem.
Sam publisher nie tworzy kwalifikowanego H-per-A carrier. Dedicated stage
otrzymał osobny routing źródłowy opisany poniżej; public API i runtime
potwierdzające ten nowy przepływ nadal wymagają osobnych dowodów.

Integracja źródłowa zachowuje jeden authored `antenna_field_solve`,
lecz rozdziela jego resolved działania: legacy field basis oraz external-lead
inspection. Wspólny planner waliduje to samo ProblemIR i rzeczywiste meshe;
nie dopuszcza przejścia typed source do legacy charge. Wariant inspection
przenosi owned input, jawne requested execution i wybrany output ID. Przed
wywołaniem native solve producent ponownie materializuje całe wejście i
sprawdza execution/output, a dopiero potem wykonuje jeden bundle solve.
Artifact builder nadal sprawdza exact bytes/request po solve.

Anulowanie ma punkty kontrolne przed solve, po jego powrocie i przed publikacją;
obecne pojedyncze ABI nie zapewnia przerwania wewnątrz MFEM/kwadratury.
Dedicated stage zachowuje magnetyzację bez LLG ani relaksacji. Jego osobny
record `antenna_external_lead_stage_output.v1` zawiera tylko inspection
reference, manifest reference, scope, qualification i jednostki dostępnych
payloads; nie publikuje `H_ant_basis`, `ready` ani legacy field-solution ref.
Nie wpisuje wyniku do mapy qualified solved-drive outputs. Do czasu wdrożenia
odrębnego resource schema/API nie wolno wysyłać tego record jako istniejącego
`stage_output_catalog.v1` — stary endpoint pozostaje fail-closed. To kontrakt
integracji, nie dowód wykonania; runtime i kwalifikacja pozostają otwarte.

Wspólny session shell nadal wymaga planu nośnika magnetyzacji/siatki. Dla
inspection nie może rozwiązywać zwykłego CurrentTransport ani inicjalizować
LLG. Osobny, jawnie opisany read-model clone zachowuje geometrię, nośniki
Ms/A/alpha i initial state, a odłącza wykonawczy transport, drives i graf
fizyki; oryginalne authored ProblemIR i requested execution pozostają
nienaruszone. Wymóg niepustej listy interakcji w obecnym ProblemIR wymusza
wewnętrzny neutralny Zeeman z zerowym polem oraz niewykonywane controls
Heun; nie są to authored physics ani intent integratora. Kopia usuwa
anisotropię/DMI, torques, mechanikę, temperaturę i absorber. Taki carrier
jest wyłącznie wejściem snapshotów sesji, nie
alternatywnym problemem fizycznym ani planem dopuszczonym do solvera.
Zwykły planner nadal odmawia typed source w LLG. Inspection zachowuje
istniejącą magnetyzację oraz certificate/handoff wcześniejszego equilibrium.
Publiczny przyrost dopuszcza jeden oryginalny device object mesh, również
z wieloma rozłącznymi przewodnikami: obecny multi-object merger zmienia
markery/ordinals bez kontraktu stable-ID remapping, więc tę kombinację
odrzucamy przed merge. Authored `H_ant_basis` służy tu tylko do wyboru nazwy
output zgodnej z istniejącym stage schema; nie nadaje wynikowi jednostki
per-ampere. Referencje projekcji/solved-drive i spectrum do inspection stage
muszą zostać odrzucone już w planowaniu jako `source_not_qualified`.
Session metadata i runtime selection rozpoznają explicit carrier provenance
i podają `antenna_external_lead_inspection` jako engine, CPU/double/strict oraz
`NOT VERIFIED`; nie publikują kwalifikacji timestep ani planu nośnika jako
wykonywanego LLG. Snapshot `m` nie jest wynikiem nowego kroku magnetyzacji.
Bridge ma właściciela w dedicated CLI stage; jego kryterium usunięcia to
osobny typed session carrier niewymagający imitacji `ExecutionPlanIR`.

(antenna-current-source-inspection-example)=
Przykład stage-first `examples/fem_antenna_current_source_inspection.py`
(`lead_cubes`; cały authoring sprawdza
`test_stage_first_example_has_no_time_evolution_or_legacy_source`) zapisuje to wejście
przez publiczny Python DSL, bez `ConservativeCurrentView`, spin transport,
Relax, Run, projekcji, solved drive ani widma. Jeden oryginalny importowany
MeshIR zawiera dwa rozłączne przewodniki signal/return: 16 węzłów i 12 tet4.
Każdy ma długość, szerokość i grubość $1\,\mathrm m$; cztery leady tej samej
wielkości dodają 32 węzły i 24 tet4. Jest to mały test wykonania, nie fizyczny
projekt anteny mikrofalowej. Przewodność urządzenia wynosi
$4\,\mathrm{S\,m^{-1}}$, leadów $8\,\mathrm{S\,m^{-1}}$.
Podpisane prądy zewnętrzne signal-in/out wynoszą
$-1/+1\,\mathrm A$, return-in/out $+1/-1\,\mathrm A$; wagi gałęzi są
$+1/-1$, a normalization current $1\,\mathrm A$. Ich znaczenie i mapowanie
pozostają w tabelach publicznych parametrów powyżej, bez nowego modelu źródła.

Niezależny sampling object `probe` ma cztery węzły jednego dodatnio
zorientowanego tet4 poza objętością conductor/lead. Jego jawnie zadane
Ms/Aex/alpha i magnetyzacja są wyłącznie istniejącym nośnikiem sesji; brak
kroku LLG nie oznacza jeszcze obsługi sesji bez żadnego magnetyku.
Pięć interpretowanych regresji w
`packages/fullmag-py/tests/test_antenna_current_source_example.py`
sprawdza pojedynczy etap, requested FEM/CPU/double/strict, podpisane prądy,
dopasowanie interfejsów według współrzędnych i stable IDs, dodatnie objętości,
oddzielenie targetu, rzeczywiste Python lowering dwóch oryginalnych assetów
oraz export/reimport z prawidłowym source root. Wynik: **PASS dla authoringu**.
Nie wykonano natywnego plannera, V/RT0/H solve ani porównania z niezależnym
oraclem. Runtime i fizyka pozostają **NOT VERIFIED**; wynik nadal musi być
`inspection_only`/`external_electrode_truncation`, nie bazą H-per-A. Przykład
powstał po capture bieżącego buildu, więc nie należy do jego kapsuły źródeł.

(antenna-current-source-fixture-oracle)=
### Niezależny wzorzec liczbowy przykładu current-source

Wzorzec jest ograniczony do powyższej geometrii, zerowych skoków potencjału
na interfejsach i prądu stałego $1\,\mathrm A$. Nie zastępuje 3D solve
przewodnika ze zwężeniem. Każda gałąź ma przekrój $A_c=1\,\mathrm{m^2}$,
a jej modelowana objętość jest prostokątnym pryzmatem długości
$3\,\mathrm m$: device i dwa leady. Ciągły normalny prąd ma stałą
gęstość $j=+1\,\mathrm{A\,m^{-2}}$ dla signal i przeciwną dla return.
Na izolowanych ścianach bocznych strumień jest zerowy; terminale końcowe
są equipotential. Potencjał ciągły i odcinkowo afiniczny spełnia dokładnie
równanie H1 w każdej objętości, a stały prąd należy do RT0.

```{math}
:label: antenna-fixture-affine-potential
V(x)=C-\frac{j x}{\sigma_d},\qquad
V(0)-V(1\,\mathrm m)=\frac{j\,(1\,\mathrm m)}{\sigma_d}
=\begin{cases}+0.25\,\mathrm V & \text{signal},\\-0.25\,\mathrm V & \text{return}.
\end{cases}
```

Stała $C$ jest odrębna dla każdej rozłącznej gałęzi. Checker porównuje
różnice względem średniej potencjałów jej czterech wierzchołków przy $x=0$,
nie narzuca gauge solvera. Sprawdza wszystkie 16 stable vertex IDs i brak
poprzecznej zmienności napięcia. Dla leadu spadek ma moduł
$0.125\,\mathrm V$; dla całej gałęzi $0.5\,\mathrm V$ i moc
$0.5\,\mathrm W$. Ostatnie dwie wartości są wzorcem dla późniejszego
odczytu terminali i energii, nie wynikiem wykonanej bramki.

Dla jednolitego prądu równoległego do osi $x$ całkę Biota–Savarta redukujemy
analitycznie tylko po współrzędnej źródłowej $x'$. Pozostałe dwie całki
nadal obejmują rzeczywisty przekrój objętości, nie filament ani model 2.5D:

```{math}
:label: antenna-fixture-prism-kernel
s^2=(Y-y')^2+(Z-z')^2,\qquad
K(u,s^2)=\frac{u}{s^2\sqrt{u^2+s^2}},\qquad
W=K(X-a,s^2)-K(X-b,s^2).
```

```{math}
:label: antenna-fixture-prism-field
\mathbf H_{\mathrm{prism}}(X,Y,Z)=\frac{j}{4\pi}
\int_c^d\int_e^f W
\begin{pmatrix}0\\-(Z-z')\\Y-y'\end{pmatrix}\,dz'\,dy'.
```

| Token | Znaczenie w tym wzorcu | SI |
|---|---|---|
| $j$ | Podpisana stała gęstość prądu gałęzi wzdłuż x | $\mathrm{A\,m^{-2}}$ |
| $A_c$ | Pole przekroju gałęzi wzorcowej | $\mathrm{m^2}$ |
| $\sigma_d$ | Przewodność części device wzorca | $\mathrm{S\,m^{-1}}$ |
| $C$ | Niezależna stała gauge każdej rozłącznej gałęzi | $\mathrm V$ |
| $x,x',y',z',X,Y,Z,u$ | Współrzędne źródła/celu i przesunięcie osiowe | $\mathrm m$ |
| $a,b,c,d,e,f$ | Granice objętości pryzmatu w trzech osiach | $\mathrm m$ |
| $s^2$ | Kwadrat odległości poprzecznej od źródła | $\mathrm{m^2}$ |
| $K,W$ | Pierwotna i całka jądra Biota–Savarta po osi x | $\mathrm{m^{-2}}$ |
| $\mathbf H_{\mathrm{prism}}$ | Wkład jednej modelowanej objętości wzorca | $\mathrm{A\,m^{-1}}$ |

W przykładzie sumujemy pryzmaty
$[a,b]\times[c,d]\times[e,f]=[-1,2]\times[0,1]\times[0,1]\,\mathrm{m^3}$
oraz $[-1,2]\times[2,3]\times[0,1]\,\mathrm{m^3}$ z przeciwnymi $j$.
Nie mnożymy $H$ przez $\mu_0$; to nie $B$ w teslach. Pominięty obwód
zewnętrzny nadal nie ma oszacowanego wkładu. Oracle ogranicza target do
$Z>1\,\mathrm m$ lub $Z<0$, więc jądro jest gładkie i $s^2>0$.

`scripts/antenna_current_source_oracle.py::fixture_field` używa złożonej
kwadratury Simpsona w przekroju, kolejno 8, 16, 32, 64, 128 i 256 podziałów.
Różnica dwóch poziomów jest kryterium zatrzymania, **nie ścisłym certyfikatem
błędu**. Brak zbieżności oznacza odmowę. Niezależne testy obejmują bezpośrednią
3D kwadraturę objętościową, symetrię, zmianę znaku i granicę dalekiego pola.
`compare_fixture` wymaga pełnego zbioru czterech punktów probe, jawnych
tolerancji napięcia i wektorowego pola, i odrzuca puste/brakujące/niefinitywne
dane, zły znak lub konwersję $H\to B$. Przed obliczeniami sprawdza digest
kanonicznego JSON rzeczywistych original device/probe MeshIR, całej definicji
current transport i port mode względem stałego wejścia przykładu. Obejmuje to
material/current/interface/terminal/gauge/solver i zero-jump intent; nie jest
to digest odtworzony z oczekiwanego wyniku. Nie waliduje samodzielnie manifestu,
kanonicznego bundle, RT0 ledger ani tożsamości wejścia; poprzedzają je
dotychczasowe load/request/hash guards. Nie nadaje `H_per_A` ani statusu
kwalifikacji żadnej realizacji FEM/FDM CPU/GPU. Native porównanie nadal
pozostaje **NOT VERIFIED** do wykonania przez zarządzaną trasę.

(antenna-current-source-fixture-observable-association)=
#### Związanie obserwabli eksportu z retained bundle

Korekta źródłowa po niezależnym review 2026-10-05: porównanie
V/RT0/H musi dodatkowo powiązać derived device IDs/V oraz ordered target
xyz/H z wartościami z charge/field rekordu tego samego bundle. To exact
binary64 association bez tolerancji: oba zapisy są kopiami tego samego
wyniku, nie niezależnymi przybliżeniami. Field record musi wskazywać dokładny
charge/source digest, a manifest te same trzy nested content digests.
Regresja zmienia retained V lub H i ponownie wylicza hashe, pozostawiając
poprawny sidecar; taka kombinacja ma zostać odrzucona przed oracle PASS.
Nie jest to pełny canonical decoder, native input-pin reconstruction,
walidacja wszystkich materiałów/solver policy ani nowa fizyka/publiczne API.
Właściciel `scripts/antenna_rt0_fixture_check.py::compare_bundle_observables`
korzysta z bounded typed ekstrakcji; wymaga także wcześniejszych bramek
provenance oraz geometry/RT0. Nowych 12 interpretowanych regresji RED→GREEN
oraz 9 orkiestracji i 18 czytnika: **39 PASS**, exit 0; niezależny source
review PASS. Testy używają jawnie częściowych syntetycznych rekordów,
nie native solve. Pełne `native_canonical_bundle_redecoded` i
`native_input_pins_recomputed` pozostają false; globalna kwalifikacja nie
zmienia się. Ten hostowy checker powstał po capture buildu `76c2851f...`;
nie jest kodem numerycznym ani dowodem zawartości starej kapsuły.
Na zachowanym rzeczywistym RAM `444b0769d1524dc6b6d4899d8ef2a941` kontrola
związania przeszła, ale późniejszy oracle H odmówił. Bramka startup wymagała
wyłącznie korekty kompatybilności z canonical prefiksem `version` w
`scripts/verify_saved_fem_archive_roundtrip.py::check_stamp`: pełne commit,
snapshot i bool dirty niezmienne, duplikaty obu formatów odmawiają.
Nowe interpretowane regresje RED 4/28 → GREEN 28/28; razem z RAM/browser
88 PASS oraz 6 archive identity PASS; niezależny source review PASS.
Ponowny observe dotyczył tego samego wyniku, bez ponownego solvera.

| Parametr związania | Typ / default | SI | Walidacja i zakres | API / IR |
|---|---|---|---|---|
| `inputs` | dict / required | $1$ | cztery dokładnie przypięte dokumenty device/probe/current/port, jak w kontroli RT0 | executed capsule DSL reconstruction; nie native IR dump |
| `values` | dict / required | odpowiednio $\mathrm V$, $\mathrm m$, $\mathrm{A\,m^{-1}}$, $1$ | wymagane `bundle_bytes`, `nested_content_sha256`, `device_ids`, `potential_v`, `positions_m`, `field_apm`; 16 device IDs/V, 4 trójki xyz/H, exact binary64 association, bounded framing i nested SHA | prywatny wynik `read_inspection`; brak publicznego parametru lub zmiany `ProblemIR` |

(antenna-current-source-fixture-rt0-check)=

#### Niezależna kontrola momentów RT0 tego przykładu

`scripts/antenna_rt0_fixture_check.py::compare_rt0_fixture` sprawdza wszystkie
108 momentów ścian i geometryczne sumy outward w 36 tetraedrach, po powtórnym
porównaniu przypiętych wejść oraz wszystkich 48 retained stable IDs,
współrzędnych i kluczy tetraedrów. Dotyczy wyłącznie wskazanego przykładu,
nie taperów ani dowolnego źródła. Dla stałego prądu gałęzi moment trójkąta
jest dokładnym iloczynem gęstości prądu i zorientowanego wektora powierzchni:

```{math}
:label: antenna-fixture-rt0-face-moment
\Phi_f=j\,\mathbf e_x\cdot
\frac{(\mathbf b_f-\mathbf a_f)\times(\mathbf c_f-\mathbf a_f)}{2}.
```

| Token | Znaczenie w kontroli momentów | SI |
|---|---|---|
| $f$ | Indeks ściany w tej kontroli, nie granica pryzmatu | $1$ |
| $\mathbf a_f,\mathbf b_f,\mathbf c_f$ | Wierzchołki ściany w kolejności rosnących stable IDs | $\mathrm m$ |
| $\mathbf e_x$ | Jednostkowy wektor kierunku x | $1$ |
| $j$ | Podpisana stała gęstość prądu gałęzi wzdłuż x | $\mathrm{A\,m^{-2}}$ |
| $\Phi_f$ | Fizyczny canonical moment ściany porównywany z prądem wzorcowym | $\mathrm A$ |

Zmierzony moment pochodzi z zachowanych rzeczywistych współczynników i wag
według równania `antenna-external-bundle-signed-face`, nie ze skopiowanego
requested current. Ujemny owned DOF jest indeksowany jako `-1-index`;
nie mnożymy wyniku dodatkowo przez jego znak, bo zawiera go fizyczne $w_f$.
Wagi muszą pochodzić z zaakceptowanego native ownera. Checker **nie**
certyfikuje samodzielnie normalizacji baz MFEM i nie zastępuje pełnej
walidacji charge/source/field ani input pins. Outward znak do sumy elementu
wynika z położenia jego przeciwległego wierzchołka względem zorientowanej
ściany; nie pochodzi z cached `element_flux_sum_a`. Sumowanie używa `fsum`.
Odmowa następuje również przy niebijektywnej mapie DOF–ściana, niewłaściwej
adjacency, zerowej wadze, skoku interior lub niezgodnej geometrii.

| Parametr kontroli | Typ / default | SI | Walidacja i zakres | API / IR |
|---|---|---|---|---|
| `inputs` | cztery dokumenty / required | $1$ | exact fixture digest device/probe/current/port przed odczytem momentów | hostowa rekonstrukcja z executed capsule DSL, nie dump native IR |
| `bundle` | bytes / required | $1$ | ten sam payload co zweryfikowany manifest; ścisły top-level porządek i nested SHA, częściowa ekstrakcja charge/source | brak nowej publicznej klasy lub `ProblemIR` |
| `flux_tolerance_a` | float / $10^{-8}$ | $\mathrm A$ | finite, dodatnia, nie bool; absolutny próg każdego momentu i sumy elementu, tylko dla przykładu z prądem 1 A | prywatny parametr walidacji, nie próg solve |
| `LIMIT` | int / $2^{21}$ bytes | $1$ | limit bundle i każdego odczytanego rekordu; odmowa większych wejść | stała hostowego checkera |
| `FIELD_LIMIT` | int / 20000 | $1$ | limit liczby typed pól na rekord; odmowa przy przekroczeniu | stała hostowego checkera |

| Realizacja tej kontroli | Stan dowodu |
|---|---|
| FEM CPU/double | 18 interpretowanych regresji częściowych syntetycznych rekordów PASS; rzeczywisty V/RT0/H run nadal NOT VERIFIED |
| FEM GPU | brak wykonania; ten fixture/runtime pozostaje CPU-only |
| FDM CPU | nie dotyczy: checker wymaga tego retained tetrahedral FEM bundle |
| FDM GPU | nie dotyczy: checker wymaga tego retained tetrahedral FEM bundle |

Zmieniony hostowy `scripts/compare_managed_antenna_ram.py::compare` wykonuje
kontrolę RT0 przed zwróceniem PASS; błąd przerywa odbiór. Test RED wykazał
wcześniejsze pominięcie tej odmowy. Po zmianie: 44 interpretowane testy PASS
(18 RT0, 8 orkiestracji, 18 czytnika), niezależny review PASS. Rekordy
syntetyczne są celowo częściowe, nie stanowią poprawnych native bundle i
nie dowodzą wykonania operatora. `native_canonical_bundle_redecoded=false`,
`physics_qualified=false`; trwałość, normalizacja MFEM, closure/error bound
oraz reuse/LLG/FFT pozostają poza tą bramką. Wynik RT0 nie jest normowym
certyfikatem błędu pola wektorowego ani kwalifikacją bazy na amper.

**Rzeczywisty test RAM z 2026-10-05:** run `69e3ae4f52b64b5e951baa2e213e793b`
wykonał dokładny fixture na pełnym buildzie `7c4ef0fe6ed745b682ea2229024552a8`,
ale native odmówił na local interior continuity gate, exit 1, OOM false.
Rekord authored stage `inspect_antenna` ma `status=failed`, `outputs=[]`.
Nie ma pomiarów V/RT0/H do porównania; testy hostowe nie zastępują tego odbioru.
Źródłowa diagnostyka odmowy w
`backends/fem/cpu/mfem/transport/conservative_current_view.cpp::TerminalConstrainedRt0Projection::Ptr project_terminal_constrained_rt0_owned`
podaje stable face IDs, lexicographic outward moments w amperach, signed
canonical jump w kolejności MFEM Elem1−Elem2, scale i tolerance w amperach,
z 17 cyframi, wyłącznie w gałęzi odmowy. Warunek i próg są niezmienione.
Source-only regresje RED→GREEN: 2 PASS, nie native execution.
Pełne wektory J i mechanizm ewentualnego cancellation pozostają nierozstrzygnięte.
Nie podniesiono żadnej flagi kwalifikacji ani nie dodano canonical payload/API/IR.
Kontrakt oceny elementowej sprawdzono w
[źródłach MFEM v4.7](https://docs.mfem.org/4.7/gridfunc_8cpp_source.html);
sam ten przegląd nie dowodzi przyczyny obserwowanej odmowy.

Prywatny `decode_owned_bundle` ma źródłową implementację standalone
bounded decode/self-consistency verifiera. Zachowuje partitions, role,
observations, targets/policy i signed physical ledger, a charge record
zachowuje także references, component residuals, gauges i omitted rows.
`validate_bundle_request` oddzielnie porównuje wynik z rzeczywistym
żądaniem. Nie rekonstruujemy phantom request z wyniku, by następnie uznać
porównanie z samym sobą za request validation. Builder wiąże rekord przez
`with_materialized_external_lead_request` z wejściem odtworzonym przez
materializator. Osobny producent używa tego samego input guard przed native
ABI oraz buildera po powrocie. Dedicated CLI stage jest podłączony źródłowo;
public API, managed runtime i naukowa kwalifikacja tego przepływu są otwarte.

(antenna-external-lead-inspection-api)=
Projekt odczytu publicznego zachowuje oddzielny zasób
`external-lead-inspection` i surowe `inspection_ref`. Identyfikator w URL jest
identyfikatorem rekordu wykonania etapu z sesji, a `stage_id` zapisanego
wyniku pozostaje authored ID. Nie wolno dopasowywać ich przez nazwę obiektu,
skan innych etapów ani fallback do ostatniego katalogu. Jedyny owner rekordu
leży w `antenna/external_lead_stage_outputs/<runtime_stage_id>/` pod jawnym
artifact root, także dla pośredniego etapu z `--output-dir`. Nie korzystamy
z wywnioskowanego katalogu sesji. Presentation `entrypoint_kind` nie określa
rodzaju fizyki; checked record zawiera własny stage kind i resolved action.
Session/run identity,
epoch, revision, root i registered artifact refs pochodzą z jednej migawki.
Zmiana właściciela sesji/run albo listy refs podczas odczytu oznacza konflikt,
nie publikację starego artefaktu pod nową tożsamością.

Odczyty anten korzystają z kanonicznego kontekstu żądania i nagłówka
`x-fullmag-session-scope`: session, naukowy epoch oraz niezależny
`request_scope_epoch` (inkarnacja API/sesji). Nieaktualny nagłówek daje
`409 request_context_stale` przed plikami i przed `304/206/200`.
Root/refs oraz końcowa kontrola wymagają blokady przejścia sesji przed
blokadą migawki; samo porównanie liczników poza tą granicą nie chroni
przerwy między publikacją importowanej migawki a inkrementacją inkarnacji.
Blokady nie obejmują kosztownego I/O. Ponowny import tej samej sesji/run,
nawet z identycznym naukowym epoch, unieważnia kontekst i ETag.
Wszystkie cztery koperty metadanych antenowych zwracają wymaganą inkarnację
jawnie w `request_scope_epoch`; owner recheck
odrzuca zmianę inkarnacji po pracy workerów. To kontrakt izolacji odczytu,
nie zmiana fizyki, jednostek, Python DSL, `ProblemIR` ani kwalifikacji pola.
Naukowy `session_epoch` pochodzi z kanonicznego helpera statusu, który
uwzględnia efektywny lifecycle etapu, w tym tombstone; DTO nie rekonstruuje
tego epoch wyłącznie z `session.status`.

Typowana fasada i siedem resource hooks Control Room zachowują tę samą
tożsamość w cache i w nagłówku loadera. Nieznana tożsamość nie uprawnia
do odczytu w tle. ETag bazy/widma i ich porównanie z katalogiem etapu
obejmują inkarnację, nie tylko naukowy epoch. Osobny hook payloadu inspection
wiąże jedyny `inspection_ref.content_digest` z manifestem i dokładnym
runtime stage ID; klucz cache uwzględnia także rewizję/digest rekordu oraz
Range. Terminalny wynik bez payloadu i metadane z poprzedniej inkarnacji
nie wyzwalają binary GET. Limit 128 MiB jest egzekwowany również w fasadzie
przed dekodowaniem body; wartości V, RT0 i H nie są przeskalowywane.
Resource invalidation po zmianie wykonania etapu/artefaktów obejmuje
scoped keys tej rodziny, bez ubocznego odświeżania topologii.
To implementacja izolacji/odczytu, nie nowa zdolność wzbudzania LLG ani
kwalifikacja czterech realizacji backendowych. Rzeczywisty native HTTP
i prezentacja w przeglądarce pozostają odrębnymi bramkami.

Inspector solve ma odrębną sekcję surowej inspekcji, nie zastępuje panelu
kwalifikowanej bazy. `StageExecutionRecordResource.antenna_solve_stage_id`
wiąże wykonanie z ID definicji z rzeczywistej akcji; ID węzła pipeline
może być inne i nie jest fallbackiem. Koperta wykonania podaje ownera
session/scientific epoch/request incarnation/run. Resolver wymaga jawnego
powiązania i zgodności ownera oraz obu ID etapu w metadanych inspection.
Jedno powiązanie jest jednoznaczne; przy wielu użytkownik wybiera dokładny
runtime ID. Brak lub wiele wykonań nie uprawnia do wyboru „najnowszego”.
Lokalny wybór należy do definicji, runu i inkarnacji sesji, nie jest cache
pola ani modyfikacją modelu fizycznego. Rewizja tego samego kontekstu zachowuje
wybór, jego zmiana usuwa go również przy A→B→A; zniknięcie wybranego ID nie
przełącza na inne wykonanie. Duplikaty/puste runtime ID blokują odczyt.
Interfejs zachowuje `NOT VERIFIED`, `external_electrode_truncation`
i `manifest_only`, pokazuje diagnostykę, provenance i jednostki pięciu
payloadów. Dwa ograniczone odczyty Range pokazują najwyżej osiem pozycji
i surowych wartości $\mathbf H$ w $\mathrm{A\,m^{-1}}$; nie tworzą bazy
$\mathbf H/I$, pola $\mathbf B$, projekcji ani widma. Dekoder sprawdza
układ, jednostki, rozmiary, dokładny Content-Range i skończoność wartości.
Podgląd jest odczytem zapisanego artefaktu, nie certyfikatem aktualności
wobec edytowanej sceny, closed-loop pola ani walidacją numeryczną.
Terminalna porażka/anulowanie nie ma podglądu payloadów. Dowód przeglądarki
z kontrolowanymi odpowiedziami jest wyłącznie fixture proof produkcyjnej
ścieżki UI/hooks, nigdy dowodem native HTTP lub fizyki.

JSON odczytuje tylko ograniczony manifest i jawnie podaje
`validation_scope="manifest_only"`: sprawdza shape, identity/digest,
requested/resolved execution oraz pięć descriptorów, ale nie dowodzi istnienia,
integralności ani zgodności wartości payloadów. Odczyt binarny wymaga digestu
wybranej rewizji i pełnego istniejącego verifiera V/RT0/H; sprawdzenie poprzedza
`304`, `206` lub `200`. Dostępne są bundle, sample positions, H, device IDs i
device V. RT0 pozostaje w bundle z jednostką A, nie jest nowym samodzielnym
payloadem. H pozostaje w A/m, bez dzielenia przez zadany prąd. Żaden endpoint
nie uruchamia solvera, nie aktualizuje input pins do bieżącej sceny i nie
zmienia `inspection_only`/`NOT VERIFIED`. Źródłowe podłączenie API, generacja
klienta, runtime i UI wymagają oddzielnych dowodów; nie są kwalifikacją pola.

Odtwarzalny checker HTTP wykonuje tylko GET i sprawdza JSON identity,
jednostki, SHA/size pięciu payloadów, `200/206/304/416`, digest refusal oraz
niezmienność metadanych; dodatkowo odrzucenie starej inkarnacji we wszystkich
siedmiu odczytach rodziny anten przy conditional GET/Range.
[Instrukcja checkera](../guides/antenna-external-lead-http-smoke.md)
rozdziela 17 wykonanych lekkich testów harnessu od niewykonanego przebiegu
przeciw native API. Nawet pass zachowuje `NOT VERIFIED` i
`physics_qualified=false`: nie kwalifikuje ordered bundle, aktualności
sceny, H, LLG ani żadnej z czterech realizacji backendowych.

Kontrakt prywatnego readera rozdziela dwa działania. Owned decode przyjmuje
exact bundle bytes i oczekiwany SHA-256 z opublikowanego manifestu; niezależnie
sprawdza framing, wersje, limity, nested hashes, actual geometry/maps i
podpisany ledger. Nie wymaga solvera ani borrowed request. Oddzielny request
binding porównuje wynik z rzeczywistym żądaniem bieżącego modelu; właściwe
manifest input pins builder sprawdza przez pełną re-materialization; sam
inspection loader sprawdza ich shape, nie bieżący model. Hash dowodzi
tożsamości bytes, nie ich aktualności wobec zmienionej sceny ani autentyczności.
Zachowanie exact bytes nie oznacza ponownego obliczenia H lub kwalifikacji
globalnego błędu kwadratury.

Standalone reader musi odtworzyć physical graph przez actual interior
faces i jawne typed interfaces oraz sprawdzić bijekcję tego grafu z H1
component labels. Dla każdego typed interface sąsiednie tetraedry muszą
leżeć po przeciwnych stronach tej samej fizycznej płaszczyzny trójkąta.
Test używa znaków scalar triples obu opposite vertices względem jednego
uporządkowania współrzędnych pierwszej ściany i jawnej bijekcji węzłów.
Nie porównuje niezależnych canonical-ID orientacji dwóch ścian; permutacja
stable IDs nie może zmieniać werdyktu. Warunek dotyczy geometrii również
przy zerowych prądach, nie może więc zależeć od current ledger. Nie jest
certyfikatem braku nielokalnego overlap całej domeny.

| Dane readera | Typ / default | SI | Walidacja, znaczenie i zakres |
|---|---|---|---|
| payload, expected SHA-256 | `Vec<u8>`, `&str`, wymagane | $1$ | nonempty exact ordered bundle, do 128 MiB; lowercase hex SHA i pełne nested framing/hash; input, nie wynik solve |
| closure revision, scope | owned `String`, odczytywane | $1$ | bounded UTF-8 bez NUL, exact `external_electrode_truncation`; bez `closed_loop` |
| device/lead partition | owned stable-ID listy, odczytywane | $1$ | unique sorted nonzero IDs, disjoint complete coverage actual charge vertices; każdy tet w jednej części |
| boundary roles | owned face-key/role/circuit listy, odczytywane | $1$ | complete actual exterior, exact electrode/interface maps; insulating circuit pusty |
| branch observations | owned ID/pair listy i requested/H1/RT0 currents, odczytywane | $\mathrm A$ dla currents | exact interface partition, first=device i second=lead, rozłączne P1 reaction support; signed current gates |
| P1 charge, terminals, interfaces | owned decoded record, odczytywany | V $\mathrm V$, sigma $\mathrm{S\,m^{-1}}$, currents $\mathrm A$, xyz $\mathrm m$ | actual maps, gauge/reference i residual checks; bez nodal J reconstruction |
| component/reference/gauge metadata | owned IDs i relative residuals, odczytywane | $1$ | actual component coverage, istniejące reference terminals/gauge vertices; nie discarded parser-only values |
| omitted constraints | owned constraint ID/reason/anchor/residual, odczytywane | residual $\mathrm A$, reszta $1$ | bounded rows, rank+omitted=rows, exact known reason i actual anchor; zachować także treść omission certificate |
| physical element/face ledger | owned geometry keys, face→DOF weight i fluxes, odczytywane | flux $\mathrm A$, weight $1$ | signed physical aggregation względem actual RT0; nie `abs(q)` ani ponowna normalizacja |
| quadrature policy, target xyz, H | owned policy/listy, odczytywane | xyz $\mathrm m$, H i próg $\mathrm{A\,m^{-1}}$, reszta $1$ | exact known operator i bounded order/depth/pair budget; finite ordered xyz/H i brak unconverged pairs |
| diagnostics | owned count/error/residual, odczytywane | error $\mathrm{A\,m^{-1}}$, reszta $1$ | zgodność actual source×target count, finite nonnegative local estimates; nie globalny error certificate |
| expected request | rzeczywisty `AcceptedExternalLeadRequest`, opcjonalny wyłącznie dla osobnego binding | units jak wyżej | brak self-constructed phantom request; stale sigma/ordering/drive/policy/target odrzucane przed użyciem wyniku |

Reader pozostaje backend-neutralnym odczytem prywatnego artefaktu CPU/double;
nie jest nową realizacją solve w FDM CPU/GPU lub FEM GPU. Żadna z czterech
realizacji nie otrzymuje z tego kroku kwalifikacji LLG/FFT ani publicznego
capability ready. Regresje samodzielnego decode i osobnego request binding
muszą zachować dotychczasowe odmowy fully rehashed corruption.

Siedem nowych źródłowych regresji readera obejmuje exact retained nested bytes i ledger,
osobny binding zmienionego intent, ponownie zahashowane uszkodzenia
partitions/roles/RT0/diagnostics, degenerację geometrii oraz rozszczepione
H1 labels w jednym physical component. Dodatkowy zero-current fixture
przechodzi przed odbiciem lead przez płaszczyznę styku; po rehash wszystkich
poziomów reader odrzuca konkretnie same-side geometry. Permutacja dwóch
lead stable IDs w poprawnej geometrii przechodzi mimo odwróconej
canonical-ID orientacji ściany. Niezależny source review sprawdza te
przypadki osobno. Regresje nie były kompilowane ani wykonane.
Limit `refined_pairs` wynika z drzewa o ośmiu dzieciach na poziom:
liczba wewnętrznych węzłów jednego drzewa do depth 6 jest ograniczona przez
sumę potęg ośmiu od poziomu 0 do depth minus 1, nie przez liczbę pierwotnych
source-target pairs. To bound strukturalny, nie pomiar błędu pola.

Siedem dodatkowych regresji źródłowych inspection loadera obejmuje exact
bytes/SI bez rescale, fully rehashed pochodne H/xyz/V, device selection,
stale expected digest, pin shape, schema downgrade/status promotion, GPU,
unknown nested policy i odmowę legacy LLG/FFT przed projekcją. Poprawna
permutacja device IDs z odpowiadającą permutacją V jest spójnym zapisanym
wynikiem, ale nie dowodem aktualności względem authored input; zmieniony
digest odrzuca stary reference. Literal fixture pins dowodzą wyłącznie
shape. Dwie źródłowe regresje rzeczywistego publishera obejmują publish/load,
identical reuse, nową rewizję bez mutacji starej, preset/reuse cancellation
oraz corrupt on-disk H refusal bez overwrite. Trzy regresje filesystem helpers obejmują bounded read, exact
regular file set i cancellation z zachowaniem obcych entries. Wszystkie
te testy pozostają **niekompilowane i niewykonane**. Source-only
publisher/loader nie stanowią runtime albo scientific PASS. Future test
execution wymaga jawnego storage root z resolvera, bez stałej ścieżki hosta.

### 12.2 Rozszerzenia przyszłe

1. Harmonic complex MQS bases and multi-frequency interpolation.
2. Full-wave Maxwell ports, substrate permittivity, impedance, S-parameters,
   radiation, and dBm normalization.
3. Magnetic-material feedback and eddy currents in the ferromagnet.
4. Curved and arbitrary swept antenna centerlines.
5. Automatic circuit-derived split of disconnected ground returns.
6. High-order conductor FEM and $H(\mathrm{curl})$ magnetic-field solve.
7. Fast multipole or hierarchical acceleration for very large source/target
   evaluations.
8. Validated mode-overlap analysis and inductive detector-voltage prediction.

(antenna-implementation-mapping)=
## 13. Implementation mapping

The source index distinguishes executable evidence from planned composition
contracts. A documentation anchor marked `planned_contract` is not runtime
evidence and cannot promote a capability lane.

(antenna-source-code-index)=
### 13.1 Source-code index

| Ścieżka | Symbol / anchor | Odpowiedzialność i dowód |
|---|---|---|
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-consumer-activation-preflight` | source commit i WIP lazy-root/clear-bases; pełne domknięcie i runtime otwarte |
| `crates/fullmag-cli/src/orchestrator.rs` | `prepare_solved_antenna_drive_activation` | wspólna validation i clear nieaktywnych/pustych baz |
| `scripts/test_antenna_activation_preflight_source.py` | `class AntennaActivationPreflightSourceTests` | source parent RED3 → INDEX3/3, bez Rust |
| `scripts/test_antenna_observation_source.py` | `test_consumer_validates_activation_before_resolving_artifact_root` | lazy-root WIP regression, nie wykonanie solvera |
| `scripts/test_antenna_observation_source.py` | `test_activation_preflight_clears_inactive_or_absent_bases_in_both_lanes` | clear obu lane przed false, source-only |
| `scripts/test_antenna_observation_source.py` | `test_attachment_preserves_strong_loading_after_the_shared_activation_gate` | zachowanie silniejszej granicy full WIP |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-build36-terminal-package-acceptance` | terminalny trusted pakiet126artefaktów/kapsuła7453, nie aktualny HEAD/runtime/fizyka |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-observation-readiness-commit` | źródłowo naprawiony energy no-op; runtime/rollback/basis nadal otwarte |
| `scripts/test_interactive_observation_readiness_source.py` | `InteractiveObservationReadinessSourceTests` | source RED parent5tests6failures → INDEX5/5, bez Rust/native |
| `crates/fullmag-cli/src/interactive_runtime_host.rs` | `ensure_base_runtime_ready` | fallible preparation wspólne dla fields/energies/import |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-command-result-correlation-commit` | commit compute/import, source 8/8; Rust/runtime i no-op energy otwarte |
| `scripts/test_command_result_identity_source.py` | `CommandResultIdentitySourceTests` | wykonane niezależne RED parent / GREEN INDEX; nie test solvera |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-command-log-explicit-id-isolation` | kontrakt izolacji jawnego ID, bez promocji legacy completion do kwalifikacji |
| `crates/fullmag-api/src/session.rs` | `command_has_terminal_log` | globalny terminal-log bridge i świeżość; nie fizyka ani durable completion |
| `scripts/test_antenna_observation_source.py` | `test_terminal_log_named_identity_applies_to_all_command_kinds` | wykonany source RED/GREEN: dokładne jawne ID dla wszystkich rodzajów; nie wykonanie Rust |
| `crates/fullmag-api/src/session.rs` | `snapshot_reconciliation_does_not_apply_foreign_identified_logs_to_solver_commands` | 24 zapisane, niewykonane przypadki; obcy wpis nie zmienia legacy idle inference |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-r3-fixed-ram-comparison` | wykonany przypięty R3 V/RT0/H w RAM, metryki i jawny brak full qualification |
| `scripts/compare_managed_antenna_ram.py` | `compare` | odczyt eksportu, independent fixture oracle i association; nie native complete-input verifier |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-r3-package-openapi-acceptance` | terminalny pakiet R3 i jego exact OpenAPI; nie runtime/nauka ani późniejsza korekta handoff |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-scripted-interactive-output-handoff` | źródłowa granica finalnego szablonu i nowego stage; nie transakcyjność całego resume |
| `scripts/test_antenna_observation_source.py` | `test_final_template_resolves_before_ready_but_not_for_paused_pipeline` | ordering i guard pauzy; wykonany source-only regression |
| `scripts/test_antenna_observation_source.py` | `test_each_interactive_stage_resolves_before_new_sequence_plan_and_attachment` | rozwiązanie referencji przed nową sequence/plan/load; nie wykonanie Rust |
| `scripts/test_antenna_observation_source.py` | `test_output_resolution_preserves_atomicity_and_stage_activation` | istniejąca atomowość resolvera i activation; nie gwarancja całego lifecycle |
| `tests/antenna/direct_quadrature_evidence.py` | `verify_direct_evidence` | niezależny wykonany czytnik raw/ledger/binding na synthetic payloads; nie native science proof |
| `tests/antenna/direct_quadrature_evidence.py` | `exact_tolerance` | rational iloczyn+suma, jedno rounding binary64; jawny matched profil sprawdzony na skończonym corpusie, pełne producer-math qualification otwarte |
| `tests/antenna/matched_libm.py` | `class MatchedLibmHypot` | pinned file/symbol/nearest-even, GNU/Linux x86-64, bez fallbacku; arytmetyka czytnika, nie dowód operatora |
| `tests/antenna/test_matched_libm.py` | `test_pinned_diagnostic_corpus_has_no_tolerance_mismatch` | 12012 synthetic wektorów, 0 różnic finalnej tolerance w przypiętym obrazie |
| `tests/antenna/test_matched_libm.py` | `test_realization_reaches_cold_decoder_and_one_ulp_mutation_refused` | propagacja do cold readera i odmowa 1 ULP po rehash, bez slack |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-matched-libm-reader-realization` | wykonane interpreted 37/37, scope parametrów i otwarte producer/native/science gates |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-libm-parity-counterexample` | 12012-vector diagnostic: Python/libm norm 111 i tau 57 mismatches, nie native solver ani R2 qualification |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-retained-native-tolerance-bit-evidence` | wykonany read-only cross-host check czterech retained native tolerancji, 0 ULP; nie pełny libm/runtime ani R3 qualification |
| `tests/antenna/verify_field_convergence.py` | `read_solution_checked` | strict v3 i jawny archive opt-in, bounded reads, jawny brak producer provenance qualification |
| `tests/antenna/test_verify_field_convergence.py` | `test_v3_subulp_roundoff_refused_at_equality` | wykonana regresja E+R po rehash, nie wykonanie native kwadratury |
| `crates/fullmag-runner/src/antenna_field_solution/direct_quadrature.rs` | `decode` | bounded explicit LE raw evidence, numerical gate przed reuse; source-only, bez runtime proof |
| `crates/fullmag-runner/src/antenna_field_solution/direct_quadrature.rs` | `encode` | raw field/counters i measured-current retention, nie rekonstrukcja z H/A; source-only |
| `crates/fullmag-runner/src/antenna_field_solution/direct_quadrature.rs` | `verify_binding` | ordered xyz, raw→per-A i current/scale/cert/summary bit binding; source-only |
| `crates/fullmag-runner/src/antenna_field_solution/direct_quadrature.rs` | `target_error_fits` | wspólna bramka FastTwoSum dla native adaptera i cold readera; source-only |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `verify_antenna_field_solution_referenced_data` | ta sama bramka dla obu loaderów i API, dopuszcza tylko dodatkowe artefakty enclosing bundle; source-only |
| `crates/fullmag-runner/src/antenna_field_solution.rs` | `readers_refuse_missing_mixed_future_and_duplicate_direct_evidence` | zapisane niewykonane odmowy po rehash, pełny verifier i oba loaders |
| `crates/fullmag-api/src/router_v2/handlers/data/antenna.rs` | `validate_field_solution_payloads` | bounded source-only canonical evidence gate, nie niezależne odtwarzanie fizyki |
| `scripts/test_antenna_quadrature_evidence_source.py` | `test_numeric_refusals_are_independent_of_rehash` | interpretowany model formatu/numerics, nie wykonanie Rust |
| `scripts/test_antenna_quadrature_api_source.py` | `test_selected_payload_is_the_same_verified_bytes` | interpretowany source check jednej bramki i braku ponownego odczytu H, nie HTTP runtime |
| `apps/control-room/src/modules/inspector/panels/antenna/AntennaExternalLeadInspectionModel.ts` | `resolveInspectionRuntimeStage` | dokładny runtime ID, jawny wybór przy wielu wykonaniach, owner/run fence i odmowa fallbacku; kontrola źródeł i fixture UI, nie fizyka |
| `apps/control-room/src/modules/inspector/panels/antenna/AntennaExternalLeadInspectionModel.ts` | `inspectionSelectionMatchesContext` | lokalna tożsamość wyboru authored/run/session, reset kontekstu także przy ABA; bez nowego cache pola |
| `apps/control-room/src/modules/inspector/panels/antenna/AntennaExternalLeadInspectionPanel.tsx` | `AntennaExternalLeadInspectionPanel` | raw H i provenance, shared Select, pauseLoad zachowujące metadane podczas refresh; nie qualified field basis |
| `scripts/smoke_antenna_external_lead_inspection.py` | `verify` | read-only HTTP integrity/range/cache gate, native NOT VERIFIED |
| `scripts/test_smoke_antenna_external_lead_inspection.py` | `test_all_payloads_ranges_cache_and_digest_gates_without_qualification` | baseline 14 lekkich regresji harnessu/loopback; nie numerical bundle ani API qualification |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-external-lead-inspection-api` | odrębne metadata/binary validation scopes, bez qualification; planned contract |
| `crates/fullmag-runner/src/antenna_external_lead_solution.rs` | `load_antenna_external_lead_solution_manifest` | bounded metadata shape/digest/descriptor, bez payload integrity; source-only |
| `crates/fullmag-runner/src/antenna_external_lead_solution/publication.rs` | `load_published_antenna_external_lead_solution_manifest` | namespace-bound manifest read bez dużych tablic; source-only |
| `crates/fullmag-api/src/router_v2/handlers/data/antenna_inspection.rs` | `get_antenna_external_lead_inspection` | osobny snapshot resource, raw ref i manifest_only; source-only |
| `crates/fullmag-api/src/router_v2/handlers/data/antenna_inspection.rs` | `get_antenna_external_lead_inspection_payload` | full load i selected hash/size przed conditional/Range; source-only |
| `crates/fullmag-api/src/router_v2/handlers/data/antenna_inspection.rs` | `read_registered_record` | exact registered runtime namespace, bounded regular/no-alias read; source-only |
| `crates/fullmag-cli/src/orchestrator.rs` | `scripted_stage_execution_state` | stabilne runtime IDs scripted records; source-only |
| `crates/fullmag-cli/src/orchestrator.rs` | `run_script_mode` | inspection output root, exact artifact ref i failed BackendError; source-only |
| `crates/fullmag-cli/src/orchestrator.rs` | `relative_artifact_ref` | canonical paths przed containment/strip, Windows prefix; source-only |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `manifest_only_loader_does_not_claim_payload_integrity` | metadata success nie zastępuje odmowy full read dla corrupt/missing arrays; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `manifest_only_loader_refuses_rehashed_descriptor_units_counts_paths_and_sizes` | rehashed descriptor unit/count/path/size/overflow/SHA refusals; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `published_manifest_only_read_survives_missing_payload_without_promoting_it` | actual publication, brak H i różne validation scopes; niekompilowana |
| `crates/fullmag-api/src/router_v2/tests/antenna_inspection.rs` | `inspection_terminal_records_are_separate_revisioned_resources` | terminal HTTP/ETag/revision/session, brak legacy fields/payload; niekompilowana |
| `crates/fullmag-api/src/router_v2/tests/antenna_inspection.rs` | `inspection_record_validation_precedes_conditional_get` | malformed record/units/ref/schema przed 304; niekompilowana |
| `crates/fullmag-api/src/router_v2/tests/antenna_inspection.rs` | `inspection_binary_requires_digest_and_refuses_mismatch_before_io` | required digest/mismatch/no RT0/missing manifest przed 304; niekompilowana |
| `crates/fullmag-api/src/router_v2/tests/antenna_inspection.rs` | `inspection_uses_only_exact_registered_stage_record_without_fallback` | namespace i brak alias/other-stage/unregistered fallback; niekompilowana |
| `crates/fullmag-api/src/router_v2/tests/antenna_inspection.rs` | `inspection_record_is_bounded_before_json_or_etag_evaluation` | oversize guard rzeczywistej trasy; niekompilowana |
| `crates/fullmag-api/src/router_v2/tests/antenna_inspection.rs` | `inspection_openapi_documents_separate_resources_and_digest_query` | source ApiDoc paths/schema/required query; generated pending, niekompilowana |
| `crates/fullmag-cli/src/orchestrator.rs` | `scripted_inspection_stage_has_runtime_identity_and_terminal_artifact_ref` | rzeczywisty helper lifecycle ID/ref/reason; niekompilowana |
| `crates/fullmag-cli/src/orchestrator.rs` | `antenna_manifest_reference_accepts_canonical_path_and_operator_root_alias` | normal/aliased root vs canonical manifest, containment; niekompilowana |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-external-lead-inspection-publication` | osobny binary carrier i source-only producer/publisher/stage; API/runtime/kwalifikacja otwarte |
| `crates/fullmag-plan/src/antenna_field_solve.rs` | `plan_antenna_field_solve_execution` | wspólny authored stage, rozdział basis/inspection i early qualification gates; source-only |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `inspection_execution_preserves_original_disconnected_device_and_requested_intent` | actual disconnected mesh/ownership i requested auto/CPU; niekompilowana |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `inspection_execution_refuses_gpu_single_and_extended_without_fallback` | actual planner policy refusals; niekompilowana |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `inspection_execution_refuses_multi_object_before_loading_or_remapping_meshes` | source ownership gate przed mesh loading; niekompilowana |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `inspection_execution_refuses_referenced_projection_and_source_spectrum` | early projection/FFT qualification refusal; niekompilowana |
| `crates/fullmag-cli/src/step_utils.rs` | `resolve_antenna_field_solve_action` | wspólny explicit/pipeline router, bez nowego Python action; source-only |
| `crates/fullmag-runner/src/antenna_external_lead_solution/execution.rs` | `execute_antenna_external_lead_inspection` | actual input przed single bundle ABI, raw artifact bez drugiego solve; source-only |
| `crates/fullmag-runner/src/antenna_external_lead_solution.rs` | `revalidate_materialized_input` | input/policy/output guard współdzielony przez producenta i retained-byte builder |
| `crates/fullmag-runner/src/antenna_external_lead_solution.rs` | `validate_stage_output` | safe declared ID i authored quantity zgodne z plannerem; nie promotion to basis |
| `crates/fullmag-cli/src/orchestrator/antenna_external_lead_inspection.rs` | `execute` | atomowy wynik inspection bez wpisu do qualified outputs; source-only |
| `crates/fullmag-cli/src/orchestrator/antenna_external_lead_inspection.rs` | `write_record` | bounded no-overwrite stage record i anulowanie; trzy niewykonane regresje |
| `crates/fullmag-cli/src/orchestrator/antenna_external_lead_inspection/carrier.rs` | `plan_carrier` | jawny non-executable carrier bridge, source re-resolution przed sanitizacją; trzy niewykonane regresje |
| `crates/fullmag-cli/src/orchestrator.rs` | `current_live_metadata`, `session_runtime_selection_for_problem` | engine inspection bez fałszywej LLG/timestep kwalifikacji; source-only |
| `crates/fullmag-runner/src/antenna_external_lead_solution.rs` | `AntennaExternalLeadSolutionManifest` | thin raw V/RT0/H inspection schema, requested/resolved execution i pięć binary refs; source-only |
| `crates/fullmag-runner/src/antenna_external_lead_solution.rs` | `build_antenna_external_lead_solution` | alternatywna ścieżka retained bytes: actual input, exact decode i request binding, bez dodatkowego solve |
| `crates/fullmag-runner/src/antenna_external_lead_solution.rs` | `load_antenna_external_lead_solution` | solver-free bounded decode, bitowe H/xyz/device V checks; nie freshness lub authentication |
| `crates/fullmag-runner/src/antenna_external_lead_solution.rs` | `reject_unqualified_external_lead_source` | jawny source_not_qualified w legacy LLG/spectrum boundaries przed projekcją |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/input.rs` | `with_materialized_external_lead_request` | existing CPU-double ABI request z actual input i jawnie pinned native-v1 jump defaults |
| `crates/fullmag-runner/src/antenna_external_lead_solution/publication.rs` | `publish_antenna_external_lead_solution_atomically` | fixed-name immutable revision, verify przed rename, cancel i exact reuse; source-only |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `inspection_loader_retains_exact_raw_bundle_si_units_device_order_v_and_h` | raw bytes/SI/actual selection baseline; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `inspection_loader_refuses_fully_rehashed_h_and_xyz_derivative_corruption` | pochodne bitowo niezgodne z bundle mimo rehash; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `inspection_loader_refuses_device_subset_repetition_foreign_ids_stale_order_and_v` | actual partition/V checks; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `inspection_loader_accepts_self_consistent_device_permutation_not_current_input_proof` | recorded-content consistency odrębna od freshness; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `inspection_loader_refuses_stale_digest_malformed_pins_schema_promotion_and_gpu` | identity/shape/GPU/unit refusals; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `inspection_loader_refuses_unknown_root_and_nested_solver_policy_shape` | nested unknown-field odmowa; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `inspection_manifest_is_refused_by_legacy_llg_and_source_fft_before_projection` | real LLG/FFT boundary source_not_qualified; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/publication.rs` | `bounded_reads_reject_oversized_files_before_loading` | size i cancel przed allocation; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/publication.rs` | `revision_requires_exact_regular_file_set` | fixed six entries, missing/foreign/directory; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/publication.rs` | `interrupted_write_and_cleanup_preserve_foreign_entries` | cleanup wyłącznie own files i cancel; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `atomic_inspection_publication_reuses_exact_revision_and_preserves_old_revision` | actual publish/load/reuse/new revision, old bytes zachowane; niekompilowana |
| `crates/fullmag-runner/src/antenna_external_lead_solution/tests.rs` | `atomic_inspection_publication_cancel_and_corrupt_reuse_fail_without_overwrite` | actual cancel/corrupt load-reuse refusal, brak overwrite; niekompilowana |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-current-source-materialization` | mesh-exact checked input, per-component balance i deterministyczne pins; planned contract, nie execution |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-current-source-stage-selector` | optional legacy selector, omission i module-scoped gates; źródłowa migracja bez capability promotion |
| `crates/fullmag-ir/src/antenna.rs` | `AntennaFieldSolveStageIR` | optional selector w kanonicznym serde, absent/null→omitted None; source-only |
| `crates/fullmag-ir/src/antenna.rs` | `validate_stage_current_view_ref` | None wyłącznie przy source w dokładnie wskazanym module, present blank odmowa; oba entrypoints; source-only |
| `crates/fullmag-ir/src/antenna.rs` | `stage_current_view_ref_wire_shape_preserves_legacy_and_omits_none` | absent/null canonical omission i dokładny legacy Some round-trip; niekompilowana |
| `crates/fullmag-ir/src/antenna.rs` | `stage_current_view_ref_is_optional_only_for_the_exact_typed_source_transport` | source z innego modułu nie omija legacy/blank odmowy; niekompilowana |
| `crates/fullmag-ir/src/antenna.rs` | `both_problem_versions_apply_the_stage_current_view_selector_rule` | oba actual validator entrypoints; tylko selector diagnostics, nie pełna ważność bootstrap modelu; niekompilowana |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `materialization_accepts_absent_or_historical_selector_and_rejects_blank` | source None/historical Some i retained requested pin; blank odmowa przed hashem; niekompilowana |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaFieldSolveStage` | None default i canonical omission; present tekst normalizowany dotychczasowym helperem; authoring |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_antenna_field_solve_definition_expr` | conditional canonical export bez sztucznego selector; authoring |
| `crates/fullmag-api/src/schemas/authoring.rs` | `AntennaFieldSolveStageResource` | źródłowe Option serde/ToSchema; generated kontrakt jeszcze pending |
| `crates/fullmag-api/src/openapi_v2.rs` | `openapi_exposes_typed_antenna_composition_contract` | źródłowa kontrola optional required-list; niekompilowana |
| `packages/fullmag-py/tests/test_antenna_composition_contract.py` | `test_field_solve_projection_and_spectrum_are_typed_thin_references` | wykonana kontrola legacy/None/blank stage wire, nie source runtime |
| `packages/fullmag-py/tests/test_antenna_stage_workflow.py` | `test_current_source_stage_omits_legacy_selector_from_script_export` | wykonany canonical omission/export/replay, nie source solve |
| `packages/fullmag-py/tests/test_antenna_stage_workflow.py` | `test_scene_document_adapters_preserve_all_antenna_collections` | wykonany passthrough optional stage bez dopisywania legacy ref |
| `crates/fullmag-ir/src/antenna_current_source.rs` | `ResolvedAntennaExternalLeadCurrentInputIR` | owned input snapshot z requested stage/drive, actual mesh/ownership i input pins; source-only, nie execution plan |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `materialize_antenna_external_lead_current_input` | checked device+lead append, actual component/observation/terminal gates i bounded deterministic hashing; source-only |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `materialized_input_preserves_real_ids_markers_and_signed_observations` | niekompilowana regresja actual IDs/markerów/sigma/ordering i osobnych signed observations |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `component_balance_does_not_accept_global_cancellation` | niekompilowana regresja bilansu per component zamiast globalnego cancellation |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `input_pins_are_deterministic_and_bind_actual_inputs_not_outputs` | niekompilowana regresja input mutations, unordered metadata i odmowy NaN |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `validate_terminal_face_closure` | actual exterior inverse P1 closure bez dopisywania ścian; source-only |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `validate_independent_terminal_control_budget` | checked limit 64 niezależnych terminal controls; source-only |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `validate_physical_p1_component_bijection` | actual face+interface components ↔ P1 roots, bez point/edge short; source-only |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `physical_components_refuse_point_and_edge_only_p1_connections` | baseline i dodatnio zorientowane actual Tet4 z wyłącznie point/edge contact; niekompilowana |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `terminal_adapter_limits_match_native_iteration_and_control_bounds` | niekompilowana regresja INT_MAX/64 controls, overflow i zero drive |
| `crates/fullmag-plan/src/antenna_current_source.rs` | `terminal_face_closure_checks_actual_exterior_and_keeps_free_vertices` | niekompilowana regresja pominiętej electrode face, mixed separator i dopuszczalnego free vertex |
| `crates/fullmag-plan/src/antenna_field_solve.rs` | `plan_antenna_field_solve_v03` | source-specific materializacja przed legacy resolverem, strict/double i odmowa forced-device fallback; wykonanie pozostaje unavailable |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-current-driven-source-input` | jawne wejście, actuatory/observations, SI i limity; planned runtime contract |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class ExternalLeadCurrentSource` | typowane frozen żądanie, actual lead topology, bijekcje i bounded input; authoring |
| `packages/fullmag-py/src/fullmag/runtime/scene_document.py` | `_decode_conservative_current_source` | strict import wszystkich nested map bez unknown-field loss |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_conservative_current_source_payload` | edytowalny canonical Python export z explicit maps i signed/zero currents |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | `StudyBuilder.current_transport` i global wrapper zachowują source bez pominięcia pola |
| `packages/fullmag-py/tests/test_current_source.py` | `test_exact_typed_source_and_signed_zero_drives_round_trip` | wykonany round-trip; nie dowód native solve lub 1 A basis |
| `crates/fullmag-ir/src/spin_transport.rs` | `ConservativeCurrentSourceIR` | typed schema, unknown-field refusal i bounded source-specific mesh validation; source-only |
| `crates/fullmag-ir/src/study.rs` | `deserialize_current_transport_definition` | strict non-null source w flat IR, optional legacy absent/null; source-only |
| `crates/fullmag-ir/src/spin_transport.rs` | `flat_current_module_retains_source_and_rejects_malformed_source_payloads` | source/null/legacy/scalar/list regression; niekompilowana |
| `crates/fullmag-ir/src/validation.rs` | `validate_charge_transport_definition` | one-way/static/gauge/empty-BC/exclusivity/domain gates; source-only |
| `crates/fullmag-authoring/src/validation.rs` | `validate_current_transport` | strict typed scene source i zgodność charge-domain object IDs; source-only |
| `crates/fullmag-plan/src/current_transport.rs` | `resolve_current_transports` | odmowa niepodłączonego producer przed legacy fallbackiem; source-only |
| `crates/fullmag-runner/src/native_fem/charge_transport.rs` | `validate_resolved_descriptor` | obrona przed przesłaniem nowego source do legacy native request; source-only |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-accepted-external-lead-bundle-abi` | jeden workflow, typowany nested record i kompletny bounded ABI, SI i scope; bez qualification |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp` | `AcceptedExternalLeadBundle solve_accepted_external_lead_bundle` | single-owner charge/finalizer/field, tag3 exact bytes i aggregate budget; source-only |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `ResolvedAcceptedChargeRequest resolve_accepted_charge_request` | wspólny bounded importer dla wcześniejszego charge i nowego bundle; bez solve |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `int solve_accepted_external_lead` | input maps/policy/count gates, wywołanie workflow i atomic bounded export; source-only |
| `native/include/fullmag_fem.h` | `fullmag_fem_solve_accepted_external_lead_field_v1` | append-only request/result/layout deklaracja dla bounded bundle; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_terminal_charge.rs` | `with_packed_charge_request` | współdzielony typed input packing/lifetime bez solve; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead.rs` | `solve_accepted_external_lead_field` | pojedynczy FFI, retained bounded buffer i guarded result header; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs` | `decode_bundle` | wrapper zachowujący odmowy: preflight, owned decode i rzeczywisty request binding; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs` | `decode_owned_bundle` | bounded standalone reader, exact nested bytes/SHA, retained ledger i recursive refinement bound; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs` | `validate_bundle_request` | osobny binding rzeczywistego charge/closure/roles/branches/target/policy bez phantom request; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs` | `validate_source_topology` | actual face-connected graph i typed interfaces, bijekcja H1 labels, complete role/support; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_terminal_charge/record.rs` | `AcceptedTerminalChargeRecord` | retained references/residuals/gauges/omitted rows i exact charge bytes; source-only |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `owned_bundle_retains_exact_nested_bytes_and_physical_ledgers_without_request` | exact retention źródła/pola/charge oraz physical DTO bez request; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `owned_integrity_accepts_changed_intent_but_real_request_binding_refuses_it` | separate integrity/request freshness dla fully rehashed zmiany target/policy/closure; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `owned_rehashed_source_corruption_and_degenerate_geometry_are_rejected` | odmowy rehashed source corruption i degeneracji po valid baseline; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `owned_reader_rejects_rehashed_rt0_sign_and_invalid_field_diagnostics` | signed nonzero q flip i invalid field floor/count/refinement/NaN/unconverged; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `owned_rehashed_physical_graph_refuses_split_h1_component_labels` | odmowa split H1 labels w actual jednym physical component; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `owned_zero_current_rehashed_same_side_interface_geometry_is_rejected` | valid zero-current baseline, reflected lead i pełny rehash; konkretna geometry refusal; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `owned_zero_current_interface_accepts_reversed_stable_id_orientation` | poprawna mapped geometria mimo przeciwnego canonical-ID order; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `exact_bundle_retains_charge_maps_and_request_bound_h` | analityczny three-cube codec, V/RT0 i H=0 na osi symetrii przy niezerowym J; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `rehashed_signed_rt0_flip_is_rejected_against_cached_physical_ledger` | najpierw poprawny bundle, potem nonzero q sign flip i ponowne SHA całego pakietu; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `rehashed_nested_corruption_does_not_bypass_source_or_field_binding` | signed weight/scales/outward/rank, invented row count oraz field policy/targets/diagnostics i framing odmowy; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `compensated_current_sum_preserves_cancellation_residue` | reszta 2^-54 A po silnym znoszeniu bez poszerzania gate; niekompilowana |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/bundle_tests.rs` | `overlapping_electrode_trace_and_branch_dofs_are_rejected` | odmowa shared electrode/trace i repeated branch interfaces/reaction support; niekompilowana |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `void external_lead_bundle_abi_keeps_nested_records_signed_and_owned` | independent framing/SHA, analytic V/signed RT0, H reversal/doubling/zero i request/lifetime/determinism; niekompilowana |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `void external_lead_bundle_abi_failures_are_atomic_and_prefix_safe` | headers/policy/descriptors/GPU/capacity i atomic failure/truncated canaries; niekompilowana |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-accepted-external-electrode-truncation` | równania, parametry, scope i ograniczenia prywatnego wariantu finite-domain; nie qualification |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `TerminalRt0PhysicalMeasurements measure_terminal_current_projection` | ponowny fizyczny pomiar na retained descriptorach niezmienionego owned RT0; source-only |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `double rt0_face_canonical_flux_weight` | actual Piola basis, DOF sign i canonical face area; signed zero-safe map bez solve/GF mutation; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp` | `AcceptedExternalLeadCurrentSource::Ptr AcceptedExternalLeadCurrentSource::Finalize` | actual partitions/roles/components i H1/RT0 branch observations, wspólny owner bez solve; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp` | `AcceptedExternalLeadFieldResult evaluate_accepted_external_lead_field` | typed truncated contribution, bounded policy/preflight i własny field record; source-only |
| `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp` | `evaluate_target` | aktualny globalny ledger v3 bez floor; nadal nie rygorystyczny error certificate |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void accepted_external_lead_finalizer_preserves_owned_series_and_rejects_foreign_descriptors` | called-main source regression znaku/zera/nano, V, ownership/DOF/rank/digest i odmów; niekompilowana |

| Path | Symbol | Responsibility |
|---|---|---|
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-accepted-charge-workspace` | planowane równania affine trace/H1/port-constrained RT0 i bramki rzędu; brak dowodu wykonania |
| `backends/fem/cpu/mfem/transport/affine_trace_relations.hpp` | `reduce_affine_trace_relations` | źródłowy graf affine trace, quotient, lift i kontrola cykli; brak dowodu numerycznego H1/portów |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.cpp` | `solve_charge_trace_workspace` | natywny napięciowy H1, per-component gauge/residual i owned V/reakcje; brak port-current/RT0/runtime qualification |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.cpp` | `ChargeTraceWorkspace::Impl::solve` | values-only solve na raz złożonym owned K bez borrowed mesh/material; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.cpp` | `ChargeTraceWorkspace::Impl::is_component_constant_control` | rozpoznanie pojedynczego authored common-mode z relacji i anchorów przed iteracyjnym solve; source-only |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void charge_trace_workspace_reuses_owned_operator_after_sources_are_destroyed` | źródłowa regresja lifetime, braku ponownego assembly i niezmienności wyników; niekompilowana |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-conjugate-response-controls` | równania i granice energetycznej odpowiedzi controls; kontrakt przed integracją fizycznych terminali |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-authored-control-rank-contract` | dokładna wykonalność i rząd modulo stałe pierwotnych objętości; nie conditioning ani terminal certification |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_control_nullspace_rank.cpp` | `validate_charge_control_rank` | dwa dokładne grafy i bounded integer rank przed unit CG; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.cpp` | `ChargeTraceWorkspace::Impl::original_volume_component_for_full_dof` | owned pierwotne objętości przed trace union; source-only |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void charge_current_controls_require_exact_rank_modulo_original_volumes` | regresja dokładnego rzędu, wykonalności i odmów zasobowych; niekompilowana |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_current_response.cpp` | `solve_charge_current_response` | wrapper jednego workspace, deleguje do prepared core; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_current_response.cpp` | `solve_charge_current_response_prepared` | odpowiedź prądów sprzężonych z controls na przygotowanym K, rank/symmetry i final measurement; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.cpp` | `ChargeTraceWorkspace::Impl::require_control_topology` | ordered topology/stable IDs i solver policy frozen workspace; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.cpp` | `ChargeTraceWorkspace::Impl::vertex_index_for_full_dof` | checked owned map DOF→vertex; source-only |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void prepared_charge_current_response_reuses_owned_operator_and_checks_topology` | regresja frozen K, lifetime i odmowy zmiany metadanych; niekompilowana |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-resolved-terminal-current-adapter` | private physical terminal adapter i jawne granice face closure/trace; nie jest dowodem runtime |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_terminal_current_constraints.cpp` | `resolve_terminal_dofs` | canonical physical faces→P1 DOF, shared/closure/separator/trace rejection; source-only |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/charge_terminal_current_constraints.cpp` | `solve_charge_terminal_current_constraints` | preflight komponentów i signed certificate wszystkich fizycznych terminali na tym samym K; source-only, nie RT0 qualification |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-rt0-terminal-projection-prerequisite` | private terminal-constrained numerical projection, oddzielona od accepted-source i publicznego workflow |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `project_terminal_constrained_rt0` | owned numeric RT0, pełny rank i niezależne lokalne/terminalowe pomiary; source-only |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `project_terminal_constrained_rt0_owned` | transfer jednej owned mesh, bez FE space utrzymywanego przez caller podczas transferu; source-only |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-terminal-rt0-explicit-interfaces` | jawne stable-ID vertex/face maps, zero-jump pair rows i niezależne interface flux measurements; nie closed source |
| `backends/fem/cpu/mfem/transport/terminal_constrained_rt0_projection.hpp` | `TerminalConstrainedRt0Projection::Ptr project_terminal_constrained_rt0_owned` | deklaracja typed input z explicit exterior face pairing i bijekcją vertex IDs; nie automatyczny weld |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `TerminalConstrainedRt0Projection::interface_flux_measurements` | owned niezależne outward currents i mismatch każdego interfejsu |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void terminal_rt0_explicit_interfaces_preserve_signed_series_currents` | source regression rzeczywistych pair/vertex maps, H1→RT0, full rank i signed interface currents oraz specific rejection gates; niekompilowana |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `void validate_terminal_current_mesh` | serial/affine/conforming oraz bezwymiarowy shape preflight przed clone/H1, bez zmiany legacy Build |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `void validate_terminal_current_interfaces` | wspólny preflight actual faces, protected terminals, vertex maps i geometrii przed H1/RT0; bez measured-current placeholders |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-owned-terminal-charge-source` | prywatny kontrakt wspólnej geometrii, frozen materiału, P1/RT0 i lifetime; nie closed antenna qualification |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `solve_accepted_terminal_charge_source` | owned whole-domain terminal H1/material/interfaces/P1/RT0 i requested→RT0 certificate; bez caller traces/closure finalization/public producer |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `derive_interface_trace_relations` | actual stable vertex pairs→GetVertexDofs→P1 zero-jumps; bez wyszukiwania kontaktu lub weld |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `AcceptedTerminalChargeSource::interface_pairs` | owned immutable mapy użyte przez H1 i RT0 |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-owned-terminal-content-digest` | ordered finite content schema, dokładny framing i zakres fizyczny, bez closure/ABI qualification |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `BoundedAcceptedSourceDigest` | finite gate i exact framing budget 128 MiB przed każdym field; nie limit peak RAM |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `compute_accepted_terminal_content_digest` | SHA-256 całego owned ordered mesh/material/P1/RT0/terminal/interface/rank i policy po acceptance gates |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `AcceptedTerminalChargeSource::content_digest` | retained immutable digest wspólnego payloadu, nie caller source label ani closure digest |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `std::string independent_accepted_terminal_content_digest` | niezależny BE codec i testowy SHA-256, nie production builder; niekompilowany |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void accepted_terminal_content_digest_matches_independent_owned_codec` | source regression abc/oracle, repeat/lifetime, current/material/geometry/ID/attribute/policy invalidation; niekompilowana |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-accepted-terminal-charge-record-abi` | append-only bounded ABI jednego rekordu i request-bound decoding, bez promocji public workflow/H |
| `native/include/fullmag_fem.h` | `fullmag_fem_solve_accepted_terminal_charge_v1` | append-only declaration wraz z nowymi request/result/terminal/interface types |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `MeshView validate_accepted_charge_input_mesh` | bounded complete CSR/actual exterior/topology preflight przed MFEM; periodic odmowa |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `int solve_accepted_terminal_charge` | jeden owned solve, dokładne retained bytes i atomowa publikacja długości, bez H/closure |
| `backends/fem/src/frequency_domain/canonical_digest.cpp` | `CanonicalDigestBuilder::release_payload` | move dokładnie hashowanego streamu, bez drugiego encodera |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `AcceptedTerminalChargeSource::canonical_content_bytes` | retained immutable bytes wspólne z SHA-256 |
| `crates/fullmag-fem-sys/src/lib.rs` | `fullmag_fem_accepted_terminal_charge_request_v1` | Rust repr(C), append-only FFI i production layout assertions |
| `crates/fullmag-runner/src/native_fem/accepted_terminal_charge.rs` | `solve_accepted_terminal_charge` | jeden call, bounded input/output, hash z tych samych bytes i request binding; prywatny niepodłączony adapter |
| `crates/fullmag-runner/src/native_fem/accepted_terminal_charge/record.rs` | `decode_accepted_terminal_charge_record` | independent typed decoder, structural map/current gates i pełne consumption; nie numerical qualification |
| `crates/fullmag-runner/src/native_fem/accepted_terminal_charge/record.rs` | `self_consistent_hash_does_not_bypass_structural_or_current_gates` | source codec regression corrupt rehashed counts/maps/scalars/text; niekompilowana |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `void accepted_charge_abi_headers_policies_and_gpu_fail_atomically` | source ABI header/policy/GPU/capacity i atomowość; niekompilowana |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `void accepted_charge_abi_mesh_and_descriptors_fail_closed` | source ABI CSR/boundary/material/IDs/selector/periodic odmowy; niekompilowana |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `void accepted_charge_truncated_result_keeps_prefix_and_canary_untouched` | source ABI truncated prefix i no-write canary; niekompilowana |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `void accepted_charge_layered_record_has_exact_sha_and_signed_payload` | source własny SHA/typed codec, sigma4/8, signed/reversed/zero oraz repeat; niekompilowana |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `void import_accepted_p1` | real ordered IDs/xyz i bijekcja GetVertexDofs przy odtworzeniu owned V |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.cpp` | `AcceptedElementCurrent` | dokładny elementwise raw J z accepted P1 i frozen σ; brak borrowed FE spaces po transferze |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void accepted_terminal_charge_source_freezes_layered_material_and_one_mesh` | source regression layered V/σ/J, one mesh, lifetime i odmów; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void accepted_terminal_charge_source_preserves_nanometre_scale_and_rejects_degeneracy` | source regression 1 nm, analityki SI i odmowy collapsed element przed H1; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void accepted_terminal_charge_source_freezes_explicit_interface_series` | source regression sigma4/8, R=3/8 ohm, frozen whole-domain H1/P1/RT0/maps/lifetime, signed/reversal/zero oraz odmowy przed H1; niekompilowana |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `analyze_physical_constraint_rank` | canonical div/pair/terminal incidence i signed RHS do exact rank owner; source-only |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `solve_weighted_rt0_projection` | wspólny dense/sparse KKT we współrzędnych physical moments i konwersja do generic MFEM coefficients; korekta źródłowa, nowy build/runtime otwarte |
| `backends/fem/cpu/mfem/transport/affine_rt0_element.cpp` | `AffineRt0Element::face_moment` | pełna czterowyrazowa rekonstrukcja i exact geometry integration generic RT0; źródłowa, nie native proof |
| `backends/fem/cpu/mfem/transport/affine_rt0_element.cpp` | `AffineRt0Element::current_at` | frozen signed coefficients, wspólna baza J/H, bounded point arithmetic bez alokacji ani pobrania DOF |
| `scripts/test_affine_rt0_element_source.py` | `test_point_basis_matches_piola_and_unit_flux_mass_load_scaling` | niezależny model Fraction Pioli obu orientacji oraz skalowania mass/load; nie wykonanie C++/MFEM |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-rt0-stable-shared-reconstruction` | kontrakt wspólnej rekonstrukcji i rozdzielenie dowodów źródłowych od native/error budget |
| `scripts/test_antenna_rt0_normalization_source.py` | `test_mass_and_load_use_unit_flux_coordinates_before_both_kkt_lanes`, `test_exact_model_rejects_posthoc_field_doubling_and_partial_conversion` | source/model RED→GREEN; siedem nowych interpretowanych przypadków, nie MFEM projection ani naukowy run |
| `scripts/antenna_rt0_fixture_check.py` | `compare_bundle_observables` | exact derived V/xyz/H i nested digest association, bounded częściowa ekstrakcja; nie full codec/input pins |
| `scripts/test_antenna_bundle_observables.py` | `test_rehashed_mismatch_is_not_observable_association` | interpretowane odmowy rehashed embedded V/H/xyz, links/manifest/count/IDs/negative zero; nie native proof |
| `scripts/verify_saved_fem_archive_roundtrip.py` | `check_stamp` | oba canonical/legacy nagłówki z dokładnymi pełnymi commit/snapshot/dirty; brak promocji science |
| `scripts/test_managed_startup_stamp.py` | `test_rejects_changed_or_ambiguous_identity_in_either_header` | interpretowane odmowy błędnej lub skróconej tożsamości oraz mieszanych duplikatów; nie native proof |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-current-source-fixture-observable-association` | zakres kontroli kopii tych samych obserwabli i ograniczenia naukowego dowodu |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-rt0-native-normalization-audit` | moment generic v4.7 1/2, zmiana współrzędnych KKT i rozdzielenie od nieustalonej przyczyny interior jump; nie dowód poprawionego operatora |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void terminal_constrained_rt0_projection_preserves_measured_h1_currents` | source regression H1→RT0 przy odmiennym raw current, signed/zero/rank/lifetime; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void terminal_rt0_projection_keeps_disconnected_current_scales` | source regression dwóch rozłącznych skal H1→RT0 i pełnego measurement/rank ledgeru; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void physical_charge_terminal_currents_preserve_signed_references_and_scale` | regresja signed reference/current, analitycznego V, skali, kolejności i owned faces; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void physical_charge_terminal_currents_keep_components_and_zero_jump_interfaces` | regresja rozłącznych skal, izolacji, zero-jump series i konkretnych odmów; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void physical_charge_terminal_faces_require_complete_dirichlet_closure` | regresja inverse Dirichlet face closure i essential separator; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void charge_current_response_preserves_sign_and_independent_component_scales` | regresja independent trace controls, lokalnej skali, orientacji i rzędu; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void charge_current_response_uses_terminal_anchors_and_rejects_common_mode` | regresja anchor controls, słabych reakcji terminalowych i common-mode; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void charge_trace_workspace_preserves_component_gauges_and_weak_reactions` | źródłowa regresja dwóch wzbudzonych i jednego izolowanego komponentu oraz owned reakcji; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void charge_trace_workspace_rejects_jumps_lost_after_anchoring` | źródłowa regresja skoku utraconego po dużym anchorze, przy braku wolnych wierszy residualu; niekompilowana |
| `backends/fem/tests/conservative_current_view_contract.cpp` | `void affine_trace_relations_preserve_independent_jumps_and_reject_cycles` | regresja źródłowa wielu skoków i odmowy niespójności; niekompilowana |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `call_with_charge_snapshot` | walidacja pomocniczego ABI i reset V/IDs/xyz po błędzie; implementacja źródłowa, bez kwalifikacji runtime |
| `crates/fullmag-fem-sys/src/lib.rs` | `fullmag_fem_steady_transport_rt0_charge_snapshot_result_v1` | layout Rust nowego wyniku V/IDs/xyz; adapter źródłowy podłączony, bramka ABI/runtime otwarta |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `validate_charge_potential_snapshot` | kontrola pełnego carrieru, V/xyz i wspólnej tożsamości RT0; regresje źródłowe nieuruchomione |
| `backends/fem/tests/steady_transport_rt0_contract.cpp` | `run_closed_geometry_rt0_contract` | źródłowa regresja analitycznego V, zgodności źródła V/RT0/H i błędów ABI; test natywny nieuruchomiony |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-separable-field-basis` | planned separable per-port field-basis contract; not executable evidence |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-terminal-weak-reaction` | planned signed weak-reaction/terminal-response contract; not executable evidence |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-current-terminal-authoring-contract` | value-free terminal and component gauge semantics; source integration does not establish native qualification |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class EquipotentialCurrentTerminal` | public value-free terminal and canonical IR lowering |
| `crates/fullmag-ir/src/spin_transport.rs` | `ChargeBoundaryIR` | typed terminal boundary and terminal-reference gauge variants |
| `crates/fullmag-plan/src/spin_transport.rs` | `resolve_charge_driven_boundaries` | resolve terminal surfaces to conductor boundary attributes after meshing |
| `backends/fem/cpu/mfem/transport/steady_transport.cpp` | `SteadyTransportOracle::solve_charge_terminal_currents` | H1 terminal response and per-terminal signed-current certificate; native numerical qualification is pending |
| `backends/fem/tests/steady_transport_contract.cpp` | `disconnected_terminal_currents_keep_independent_scales` | source regression for two disconnected conductors with independent gauges and current scales; not executed under the native unit-build ban |
| `crates/fullmag-ir/src/spin_transport.rs` | `ResolvedChargeTransportPlanIR` | standalone resolved charge-only contract without synthetic spin transport |
| `crates/fullmag-plan/src/spin_transport.rs` | `resolve_fem_charge_only_transport` | FEM CPU/double charge-only planning and conservative-current-view binding |
| `crates/fullmag-runner/src/native_fem/charge_transport.rs` | `execute_native_fem_charge_transport_plans` | pre-LLG execution, field publication and Oersted delegation |
| `crates/fullmag-plan/src/antenna_field_solve.rs` | `preflight_direct_oersted_pair_budget` | reject empty direct-Oersted source or target and enforce checked, versioned pair limit before planning native work |
| `crates/fullmag-plan/src/antenna_field_solve.rs` | `direct_oersted_known_target_buffer_bytes` | calculate checked bytes for four known concurrent target triplet buffers; exclude solver and allocator overhead |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `preflight_direct_oersted_pair_budget` | repeat the same nonempty and checked pair-boundary at the runtime/FFI boundary |
| `crates/fullmag-runner/src/antenna_fields.rs` | `dynamic_antenna_drive_terms` | FEM CPU reference-stage clock mapping for solved, prescribed and legacy antenna waveforms; regression source exists but is not executed under the worktree test ban |
| `crates/fullmag-runner/src/fem_reference.rs` | `reference_antenna_drive_maps_stage_clock_to_waveform_origin` | source regression for nonzero sinusoidal phase/offset and distinct stage-local/absolute clocks at a nonzero stage start; not executed under the worktree test ban |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaPortMode` | current public names, normalization and branch validation for the thin port contract |
| `packages/fullmag-py/src/fullmag/model/antenna_inventory.py` | `class AntennaAuthoringInventory` | typowany immutable owner deklaracji i rozdzielenie execution base; źródłowe WIP, nie runtime proof |
| `packages/fullmag-py/src/fullmag/world.py` | `declare_antenna_field_solve` | publiczna deklaracja bez action; odpowiadające projection/drive/spectrum używają tego samego oddzielnego ownera |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_antenna_inventory_declarations` | zachowanie niewykorzystanych deklaracji w skrypcie, bez syntetycznego wykonania |
| `packages/fullmag-py/tests/test_antenna_authoring_inventory.py` | `class AntennaAuthoringInventoryTests` | 11 interpretowanych kontroli authoringu, nie naukowa kwalifikacja pola lub LLG |
| `packages/fullmag-py/src/fullmag/model/antenna.py` | `class AntennaSpectrumRequest` | current source-spectrum authoring fields and Python validation, including rejection of `equilibrium_ref` outside `transverse`, and fail-closed `transverse` and `mode_basis_ref` |
| `crates/fullmag-ir/src/antenna.rs` | `validate_transverse_equilibrium_ref` | both IR versions reject ignored equilibrium references and keep `transverse` unsupported until certified projection exists |
| `packages/fullmag-py/tests/test_antenna_stage_workflow.py` | `test_antenna_solve_returns_symbolic_output_and_preserves_authoring_intent` | stage-first symbolic-reference round trip; not a field-solve runtime gate |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `coordinate_tolerance` | lokalna tolerancja próbkowania i odmowa pracy poniżej rozdzielczości współrzędnych; regresje `identity_plane_sampling_distinguishes_micrometre_samples_far_from_origin` i `identity_plane_sampling_rejects_spacing_below_coordinate_resolution` nieuruchomione z powodu zakazu testów w worktree |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `compute_nonuniform_k_antenna_source_spectrum_interruptible` | odrzucenie przepełnionej fazy oraz niefinitywnej amplitudy/mocy; regresja `spectrum_rejects_overflow_from_finite_inputs` pozostaje nieuruchomiona z powodu zakazu testów |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `regular_fft_matches_direct_centered_phase_convention` | regresja zespolonych amplitud FFT/direct dla ujemnych osi $k$, czterech okien i obu normalizacji; nieuruchomiona z powodu zakazu testów |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `verify_antenna_source_spectrum_auxiliary_artifacts` | kontrola digestu manifestu, kształtu/jednostek, metryk okna oraz czterech binarnych payloadów przed publikacją; regresje tamper i ponownie przeliczonego digestu pozostają nieuruchomione |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `validate_antenna_source_spectrum_manifest_semantics` | wspólny kontrakt tożsamości próbkowania/transformacji/fazy, kształtu, jednostek, ścieżek payloadów i metryk okna dla publikacji i odczytu API v2; regresja API nieuruchomiona |
| `crates/fullmag-plan/src/antenna_validity.rs` | `conductor_metrics_for_drive` | diagnostyka ważności rozwiązuje stabilny `source_object_id` przez binding geometrii planera, nie przez nazwę; regresja źródłowa nieuruchomiona |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `compute_antenna_source_spectrum_artifact_interruptible` | odmowa publikacji `transverse` bez certyfikowanego loadera oraz innych zignorowanych referencji analizy; regresja źródłowa nieuruchomiona |
| `crates/fullmag-runner/src/antenna_spectrum.rs` | `reusable_antenna_source_spectrum_output` | lokalny cache hit tylko dla identycznych parametrów i zweryfikowanych payloadów; regresja pozostaje nieuruchomiona |
| `backends/fem/tests/charge_transport_abi_contract.cpp` | `main` | native affine sign, linearity, balance and fail-closed gate |
| `examples/fem_antenna_current_source_inspection.py` | `lead_cubes` | publiczny current-source input z czterema volumetric leads; tylko inspection, runtime i fizyka NOT VERIFIED |
| `packages/fullmag-py/tests/test_antenna_documented_example.py` | `class AntennaDocumentedExampleTests` | pierwszy skrypt 0950: kopia zgodna z aktualnym przykładem, Python→IR/export/reimport bez solvera; nie standalone ani R3/LLG/FFT/trwałość |
| `packages/fullmag-py/tests/test_antenna_current_source_example.py` | `test_actual_lowering_binds_both_original_imported_mesh_assets` | rzeczywiste lowering oryginalnych source/target MeshIR, jedna z pięciu interpretowanych kontroli PASS; bez native solve |
| `scripts/antenna_rt0_fixture_check.py` | `compare_rt0_fixture`, `fields` | częściowa bounded ekstrakcja i niezależna geometria momentów RT0 z zachowanymi wagami; bez pełnego canonical decode i native qualification |
| `scripts/test_antenna_rt0_failure_diagnostics_source.py` | `test_diagnostic_is_failure_only_and_preserves_exact_continuity_predicate`, `test_failure_identifies_face_and_physical_measurements_at_binary64_precision` | source-only RED→GREEN, 2 PASS; sprawdza niezmieniony predykat i failure diagnostics, nie wykonanie C++ ani kwalifikację |
| `scripts/test_antenna_rt0_fixture_check.py` | `test_all_geometric_moments_with_permuted_signed_nonunit_dofs` | syntetyczne partial bytes, permutowane DOF i niejednostkowe wagi, 18 interpretowanych regresji PASS; nie certyfikat MFEM normalization |
| `scripts/compare_managed_antenna_ram.py` | `compare` | dokładny run/capsule/manifest binding, V/H oraz RT0 przed PASS; global qualification pozostaje false |
| `scripts/antenna_current_source_oracle.py` | `prism_field`, `fixture_field`, `compare_fixture` | niezależny wzorzec modeled prisms i gauge-free V; siódmy fixed RAM v3 PASS, pełna kwalifikacja native nadal otwarta |
| `scripts/test_antenna_current_source_oracle.py` | `test_reduced_integral_matches_independent_three_dimensional_cubature` | bezpośrednia kwadratura 3D niezależna od redukcji x; osiem interpretowanych testów oracle PASS, nie solve FEM |
| `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp` | `integrate_duffy_once` | transformacja `antenna-duffy-source-map`, Jacobian i regularne H; korekta v2 wymaga managed runtime, nie dowodzi globalnej kontroli błędu |
| `scripts/test_antenna_duffy_source.py` | `test_source_segment_coordinates_cover_unit_interval`, `test_source_kernel_matches_target_minus_source`, `test_source_weight_has_no_radial_or_domain_rescaling` | interpretowane regresje trzech błędów; nie wykonanie C++/MFEM |
| `scripts/test_antenna_duffy_source.py` | `test_analytic_jacobian_and_volume`, `test_regular_integrand_matches_unsimplified_biot_savart` | niezależny geometryczny model transformacji oraz znaku, bez native qualification |
| `crates/fullmag-ir/src/antenna_current_source.rs` | `ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION` | aktualny resolved preset v3 zmienia pin wejścia; brak nowego authored parametru |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/input.rs` | `with_materialized_external_lead_request` | odmowa historycznej wersji presetu i niezgodnego floor przed request |
| `scripts/test_antenna_duffy_source.py` | `test_materialized_input_pin_and_adapter_require_current_policy` | source-only RED→GREEN pinowania aktualnej polityki |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-global-target-quadrature-design` | projekt sumarycznego estymatora T06; NIE dowód wdrożenia |
| `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp` | `evaluate_target`, `evaluate_leaf`, `recompute_ledger`, `upward_nonnegative`, `target_error_fits` | globalne finalne liście, recompute i bramka bez slack; ograniczony fixed outside-source RAM PASS, nie pełna kwalifikacja |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-global-target-v3-fixed-ram-evidence` | zmierzone V/RT0/H, retained E/tau/R, tożsamość buildu/runu i jawne ograniczenia jednego modelu |
| `backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.cpp` | `WorkBudget`, `inverse_kernel_denominator`, `DirectTetraQuadrature::ProjectField` | attempted samples i visits; wspólny limit całej projekcji, jawna odmowa zakresu kernela |
| `backends/fem/cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.cpp` | `evaluate_accepted_external_lead_field` | framing v2/quadrature v3; zapis diagnostyk targetów oraz sześciu trailer scalars |
| `crates/fullmag-runner/src/native_fem/accepted_external_lead/record.rs` | `decode_owned_bundle`, `target_error_fits` | zgodne literalne wersje, retained target budgets i liczniki; struktura nie dowodzi wartości estymatora |
| `scripts/test_antenna_global_quadrature_source.py` | `global_model`, `test_binary64_target_gate_keeps_sub_ulp_positive_residual`, `test_kernel_range_guard_rejects_false_zero_from_overflow` | niezależny model finalnych liści i rational oracle bramki; nie wykonanie C++/Rust |
| `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md` | `DOC-ANCHOR:antenna-global-target-v3-regular-export-contract` | kontrakt append-only raw snapshot; bounded publish/load/per-A binding nadal required, bez qualification |
| `backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp` | `extern "C" int fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1` | nowy source-only producent raw ledgeru tego samego solve, preflight i failure reset; brak nowego runtime |
| `native/include/fullmag_fem.h` | `fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1` | deklaracja append-only symbolu, odrębny header/bounded buffer i zachowanie starych layoutów ABI |
| `crates/fullmag-fem-sys/src/lib.rs` | `fullmag_fem_direct_oersted_snapshot_result_v1` | odpowiadający repr(C), konsument runnera źródłowo podłączony, bez dowodu jego wykonania |
| `crates/fullmag-runner/src/native_fem/steady_transport/direct_oersted_snapshot.rs` | `finish`, `target_error_fits` | owned pełny odbiór i fail-closed raw xyz/H/E/tau/R, options/source/count/work; source-only, bez binary publication/load |
| `scripts/test_direct_oersted_adapter_source.py` | `test_regular_adapter_uses_one_full_snapshot_call`, `test_positive_sub_ulp_roundoff_is_not_erased_at_gate` | 4 interpretowane source/model checks, nie wykonanie Rust/native |
| `crates/fullmag-runner/src/native_fem/steady_transport/direct_oersted_snapshot.rs` | `owns_twelve_complete_targets_without_json_truncation`, `refuses_mutated_headers_bindings_and_work` | zapisane niekompilowane regresje 12 targetów i 15 odmów; brak runtime dowodu |
| `scripts/test_direct_oersted_snapshot_source.py` | `test_export_copies_same_direct_result_before_publishing_length` | source/layout regresje, 12-record model większy od 1024 bytes, nie native proof |

(antenna-scientific-bibliography)=
## 14. References

1. A. Höfinger et al., “k-Selective Electrical-to-Magnon Transduction with
   Realistic Field-distributed Nanoantennas,” arXiv:2511.10346 (2025),
   https://arxiv.org/abs/2511.10346, journal DOI:
   https://doi.org/10.1002/apxr.202500211.
2. P. Gruszecki et al., “Microwave excitation of spin wave beams in thin
   ferromagnetic films,” Scientific Reports 6, 22367 (2016),
   https://doi.org/10.1038/srep22367.
3. L. Fallarino et al., “Propagation of Spin Waves Excited in a Permalloy Film
   by a Finite-Ground Coplanar Waveguide,” IEEE Transactions on Magnetics 49,
   1033-1036 (2013), https://doi.org/10.1109/TMAG.2012.2229385.
4. X. Zhang et al., “Antenna design for propagating spin wave spectroscopy in
   ferromagnetic thin films,” Journal of Magnetism and Magnetic Materials 450,
   24-28 (2018), https://doi.org/10.1016/j.jmmm.2017.04.048.
5. MFEM, „Boundary Conditions”, dokumentacja projektu,
   https://mfem.org/fem_bc/ (odczyt 2026-10-03). Źródło rozróżnienia
   warunków essential/natural, nie dowód realizacji workflow Fullmag.
6. DefElement, „Raviart–Thomas”, definicja elementu skończonego,
   https://defelement.org/elements/raviart-thomas.html (odczyt 2026-10-03).
   Momenty normalne, contravariant Piola i ciągłość normalna; własne
   wyprowadzenie ograniczeń portowych powyżej nie jest cytatem z tego źródła.
7. MFEM v4.7, primary źródła `RT_FECollection`, generic RT i contravariant
   Piola: https://docs.mfem.org/4.7/fe__coll_8cpp_source.html,
   https://docs.mfem.org/4.7/fe__rt_8cpp_source.html,
   https://docs.mfem.org/4.7/fe__base_8cpp_source.html (odczyt 2026-10-05).
   Normalizacja bibliotecznego elementu, nie kwalifikacja operatora Fullmag.
8. MFEM v4.7, `QuadratureFunctions1D::GaussLegendre`, primary source:
   https://raw.githubusercontent.com/mfem/mfem/v4.7/fem/intrules.cpp
   (odczyt 2026-10-06). Konwencja segmentu jednostkowego, nie dowód Fullmag.
9. QUADPACK, `dqage`, primary source: https://www.netlib.org/quadpack/dqage.f
   (odczyt 2026-10-06). Globalna adaptacja estymatora; wyprowadzenie
   wektorowej addytywnej polityki powyżej jest własnym kontraktem Fullmag.
10. T. Ogita, S. M. Rump, S. Oishi, „Accurate Sum and Dot Product”,
    SIAM Journal on Scientific Computing 26(6), 1955–1988 (2005),
    https://doi.org/10.1137/030601818; kopia autora:
    https://ogilab.w.waseda.jp/ogita/math/doc/2005_OgRuOi.pdf
    (odczyt 2026-10-06). FastTwoSum dotyczy samego sumowania, nie estymatora
    kwadratury ani kwalifikacji fizycznej Fullmag.
