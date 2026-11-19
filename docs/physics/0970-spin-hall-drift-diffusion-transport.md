# Spin Hall drift-diffusion transport

- Status: draft — implementation-blocking normative physics
- Owners: Fullmag core
- Last updated: 2026-08-12
- Related ADRs: `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`
- Related specs: `docs/specs/spin-transport-runtime-contract-v1.md`
- Formula versions: `transport_constitutive.one_way.fullmag.v1`,
  `transport_constitutive.reciprocal.fullmag.v1`,
  `magnetoelectronic.fullmag.v2`,
  `sml_reservoir.fullmag.v2`,
  `dos_isotropic_nonmagnetic.fullmag.v1`
- Operator versions: `fv_charge_harmonic_v1`,
  `fv_charge_mixing_series_trace.v1`,
  `fv_spin_upwind_v1`, `structured_cross_gradient_v1`,
  `fdm_exact_face_current_electric_reconstruction.v1`,
  `fdm_transport_torque_cell_surface_balance.v1`,
  `fem_charge_spin_broken_h1_mortar.v1`,
  `fem_charge_spin_conforming_h1_p1.transparent.v1`,
  `fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1`

The normative identifier categories and exact spellings are frozen by section
8.1 of the runtime contract.

(problem-statement)=
## 1. Problem statement

Spin Hall physics in Fullmag is a solved charge-and-spin transport problem, not
an algebraic torque coefficient. This note defines the M1 one-way steady model,
the M2 reciprocal bidirectional quasistatic model, and the M3 transient model
with common signs, units, interfaces, weak forms, solver constraints, and
angular-momentum accounting across FDM and FEM.

The note is a target contract, not an implementation claim. Until the listed
gates pass, capabilities must remain at their evidence-supported status.

(governing-equations)=
## 2. Physical model

### 2.1 Variables, indices, and electrochemical convention

`e>0`; `J_c` is conventional current. Spin voltage `mu_s` is the **full**
spin-channel splitting: local channels are `V+mu_s/2` and `V-mu_s/2`.
The charge-equivalent spin-current tensor `Q_ia` has first index `i` for flow
direction and second index `a` for spin polarization. For an oriented normal
`n`, positive outgoing spin flux is `q_s,a=n_i Q_ia`.

Define

```text
E_i    = -partial_i V,                         [V/m]
G_ia   = -0.5 partial_i mu_s,a.                [V/m]
mathcal J^s_ia = (hbar/2e) Q_ia.              [J/m^2]
```

`Q` is rank two and may never be reduced to an unlabelled 3-vector.

### 2.2 Charge transport and the M1/M2 constitutive blocks

M1 charge transport on conducting domain `Omega_c` is electroquasistatic:

```text
J_c = sigma E,
div J_c = 0.
```

M1 deliberately omits reciprocal spin-to-charge feedback:

```text
J_c,i = sigma E_i,
Q_ia  = sigma_s G_ia
        + P sigma E_i m_a
        + theta_SH sigma epsilon_ika E_k.
```

Thus M1 has direct SHE and polarized charge-to-spin flow, but neither
longitudinal reciprocal feedback nor iSHE in `J_c`.

M2 first defines the 3-D magnetoresistive current

```text
J_mr = sigma_perp E
       +(sigma_parallel-sigma_perp)(m dot E)m
       +sigma_AHE m x E,
```

where PHE is contained in the symmetric anisotropic term and AHE in the
antisymmetric term. Full reciprocal transport is then

```text
J_c,i = J_mr,i
        + P sigma m_a G_ia
        + theta_SH sigma epsilon_ija G_ja,
Q_ia  = sigma_s G_ia
        + P sigma E_i m_a
        + theta_SH sigma epsilon_ika E_k.
```

Here `sigma` is the scalar reciprocal reference conductivity from the complete
base charge material. In a magnetoresistive material it is exactly
`MagnetoresistiveMaterial.base.sigma_Spm`; `sigma_parallel`, `sigma_perp`, and
`sigma_AHE` define `J_mr` but do not silently replace that reciprocal scalar or
add a second isotropic current. The same base material owns relative
permittivity and quasistatic validity bounds.

These terms are one constitutive block; iSHE is not a separately chosen sign.
Contraction with `(E,G)` makes the `P` block symmetric and SHE/iSHE block
antisymmetric. Let `Sigma_mr^sym` be the symmetric AMR/PHE charge-conductivity
tensor. Positivity of the complete coupled dissipative block requires

```text
lambda_min(Sigma_mr^sym) sigma_s - P^2 sigma^2 > 0.
```

For the parameterization above,
`lambda_min(Sigma_mr^sym)=min(sigma_parallel,sigma_perp)`. In the isotropic
case `sigma_parallel=sigma_perp=sigma`, this reduces to

```text
sigma > 0,
sigma_s-P^2 sigma > 0.
```

Eliminating `E` at fixed `J_c` gives longitudinal spin diffusion coefficient
`sigma_s-P^2 sigma`; `sigma_s=sigma` gives `sigma(1-P^2)`. A symbolic Onsager
and power-production oracle freezes index order and signs before M2 backend
work.

### 2.3 Spin balance and reaction channels

```text
C_s partial_t mu_s,a + partial_i Q_ia
  = -R_sf,a-R_J,a-R_phi,a,
R_sf  = sigma_s/(2 lambda_sf^2) mu_s,
R_J   = sigma_s/(2 lambda_J^2) (mu_s x m),
R_phi = sigma_s/(2 lambda_phi^2) m x (mu_s x m).
```

M1/M2 are quasistatic (`partial_t mu_s=0`). M3 requires a physical,
versioned `C_s`; assigning `C_s=1` is dimensionally invalid. For the canonical
isotropic non-magnetic reduction, the public material may provide the
per-spin density of states `N_0 [J^-1 m^-3]` and the planner derives

```text
C_s = e^2 N_0,
e = 1.602176634e-19 C.
```

An explicit scalar `C_s` remains a calibrated susceptibility reduction. If
both `C_s` and `N_0` are authored, they must agree at relative tolerance
`1e-12`; a ferromagnetic material without a named susceptibility tensor or
documented reduction is fail-closed. Outside a
ferromagnet `P=R_J=R_phi=0`. Every active length is strictly positive;
`lambda=infinity` is represented by an explicit disabled reaction, never a
zero coefficient. Only `R_J+R_phi` transfers angular momentum to the magnet:

```text
T_tr,G = -gamma_e/M_s (hbar/2e)(R_J+R_phi).
```

Spin-flip transfers to a separate reservoir. In transient mode accumulation
prevents replacing this expression by the entire flux divergence.

### 2.4 Boundary conditions and charge gauge

Charge BCs are `VoltageElectrode`, `Ground`, `NormalCurrentElectrode`,
`Insulating`, and explicit periodic potential drop. A reference potential or
zero-mean constraint is mandatory. The public `NormalCurrentElectrode`
prescribes a uniform outward-normal current density in `A/m^2` on each selected
surface. The native FDM CPU binding now materializes that public density
boundary as exact selected external structured faces, each with area,
outward-normal sign, adjacent active cell, and density in `A/m^2`. Every face
selected by the authored surface scope must border an active charge conductor;
one inactive adjacent cell rejects the complete source with its source ID, face
index, and adjacent-cell index. The planner never silently intersects or clips
the authored electrode scope to the active domain. It is an
opt-in executable development prototype behind managed contract gates. The
current worktree implements fixes for ABI extent checks, per-face interface
identity, order-independent owner observations, fail-closed artifact mapping,
full-result validation, exact persistent E2E provenance, per-quantity oracle
tolerances, build invalidation, and warning-clean ABI compilation. A fresh
independent review of this exact worktree reached `final5 independent review APPROVE, no Critical/Important`.
The approved review scope does not make the
lane stable, public-qualified, validated, or production-qualified: its
canonical capability remains `semantic_only`, with
`implementation_state=executable` and `validation_state=unvalidated`. The separate
implementation-local total-current electrode in `A`, with one unknown
equipotential per coordinate boundary, remains a distinct API and must not be
used as an implicit density conversion. The FDM GPU ABI and binding remain
deferred to the contract frozen below.
When no charge boundary is authored, the FEM reference slice may insert natural
zero normal charge flux on every external face only with a compatible zero-mean
gauge; that inserted default is mandatory provenance. Once any charge boundary
is authored, every external face must be covered exactly once.

Spin BCs are `SpinInsulating` (`n_iQ_ia=0`), `SpinSink` (`mu_s=0`),
`SpecifiedSpinPotential`, `SpecifiedSpinFlux`, and `PeriodicSpin`. Default
`SpinInsulating` is permitted only when no spin contact is authored and must be
visible in the UI and provenance. Conflicting BCs fail closed.

The FEM v1 ABI applies BCs by MFEM boundary attribute, but authoring selectors
identify external faces. Before lowering, the planner must retain those face
identities and prove that every face carrying one attribute belongs to the same
charge assignment and, independently, to the same spin assignment. Selecting
only part of a shared attribute is not representable and fails closed; multiple
faces of that attribute are legal when one assignment explicitly owns all of
them. Natural all-external defaults satisfy this proof and remain explicit in
provenance.

### 2.5 Transparent and resistive spin interfaces

For a transparent interface with one fixed normal:

```text
[V]=0, [J_c dot n]=0, [mu_s]=0, [n_iQ_ia]=0.
```

For oriented `N -> F`, set `Delta V=V_N-V_F` and
`Delta mu_s=mu_s,N-mu_s,F`. Because `mu_s` is the full splitting,

```text
j_c,n = (G_up+G_down) Delta V
        +0.5(G_up-G_down) m dot Delta mu_s,
q_s,parallel = [(G_up-G_down) Delta V
        +0.5(G_up+G_down) m dot Delta mu_s]m,
q_abs,perp = G_r m x (Delta mu_s x m)
             +G_i(Delta mu_s x m).
```

The one-way M1 reduction keeps the charge law independent of spin while
retaining complete longitudinal spin injection and backflow:

```text
j_c,n^(M1) = (G_up+G_down) Delta V_Gamma,
q_s,parallel^(M1) = [(G_up-G_down) Delta V_Gamma
        +0.5(G_up+G_down) m dot Delta mu_s]m.
```

Here `Delta V_Gamma` is the difference of the two accepted charge-interface
traces, not an arbitrary difference of cell-centred values. M2 alone adds
`0.5(G_up-G_down) m dot Delta mu_s` to `j_c,n`; omitting that reciprocal term
in M1 does not permit omitting the spin-independent charge-interface law.
Every M1 mixing solve therefore consumes one accepted charge snapshot that
binds the oriented interface descriptor, both charge traces, and the single
conservative face `J_c`. Independently supplied arrays of `V` and `J_c` are
not an admissible M1 mixing input.

All interface conductances have `S/m^2`. In `full_absorption`, the old
`q_SML=G_SML Delta mu_s` wire law is rejected: it does not identify a
reservoir or close the spin balance. The canonical reservoir law is:

```text
q_NR = G_N (mu_s,N-mu_R),
q_FR = G_F (mu_s,F-mu_R),
q_RL = G_R mu_R,
q_NR+q_FR=q_RL,
mu_R=(G_N mu_s,N+G_F mu_s,F)/(G_N+G_F+G_R),
n dot Q_N=q_s,parallel+q_abs,perp+q_NR,
n dot Q_F=q_s,parallel-q_FR.
```

Only `q_abs,perp` torques the magnet; `q_RL` is delivered to the lattice. The
surface production is
`0.5*(G_N|mu_s,N-mu_R|^2+G_F|mu_s,F-mu_R|^2+G_R|mu_R|^2)>=0`, with `G_R>0`
required for the name spin-memory loss. Dimensionless literature `delta`
requires an explicit adapter. Incoming, backflow, absorbed, reservoir-arm,
lattice, and torque fluxes are separately observable and balance to solver
tolerance. `sml_reservoir.fullmag.v2` is currently an authoring/IR contract;
the FDM/FEM production weak-form realization remains fail-closed.

### 2.6 Time coupling M1–M3

Strict M1 evaluates, at every required RK stage:

```text
t_stage=t_n+c_i dt,
J_c=J_c(t_stage),
solve steady mu_s for m_i,
form transport torque,
form the complete Gilbert-explicit RHS.
```

Accepted-step-only torque refresh is an explicitly degraded approximation and
does not retain nominal RK order without evidence.

M2 solves the coupled nonlinear quasistatic block at every required stage:

```text
(V^k,mu_s^k) -> (J_c^k,Q^k) -> (V^(k+1),mu_s^(k+1)).
```

Convergence needs independently scaled charge/spin residuals, relative changes
of `J_c` and `mu_s`, electrode balance, angular-momentum balance, and

```text
dt ||delta T_transport|| <= eta_transport LTE_m
```

The norm is a backend-independent volume-normalized `L2` norm on the union
`Omega_T` of magnetic target regions receiving transport torque:

```text
||delta T_transport||_T =
  sqrt[integral_Omega_T |T_transport^(k+1)-T_transport^k|^2 dV
       / integral_Omega_T 1 dV],             [1/s]

LTE_m = sqrt[integral_Omega_T |delta m_embedded|^2 dV
             / integral_Omega_T 1 dV].       [1]
```

Thus `dt ||delta T_transport||_T` and `LTE_m` are both dimensionless and
`eta_transport` is dimensionless, with starting value `0.1`. Empty
`Omega_T` makes the transport-torque criterion vacuous, but does not disable
charge/spin residual and balance criteria. FDM evaluates the same integral as
`sum_K V_K |.|^2/sum_K V_K` over active target cells. FEM evaluates it with
the consistent vector `L2` mass matrix (or quadrature algebraically equivalent
to that matrix), not an unweighted coefficient-vector norm. Masked/nonmagnetic
degrees of freedom carry zero weight. Both norms use the same target scope and
the embedded LLG estimator before magnetization renormalization; this freezes
cross-backend weighting and prevents mesh-dependent solver tolerances.

Failure of any convergence criterion rejects the outer LLG step; it does not
commit the last nonlinear iterate.

M3 is stiff. Production `coupled_imex_ark2` is the Ascher--Ruuth--Spiteri
L-stable `(2,3,2)` pair, frozen as

```text
gamma = (2-sqrt(2))/2,
delta = -2 sqrt(2)/3,

A_implicit = [[gamma,       0],
              [1-gamma, gamma]],       b_implicit = [1-gamma, gamma],

A_explicit = [[0,       0,       0],
              [gamma,   0,       0],
              [delta, 1-delta,   0]],  b_explicit = [0, 1-gamma, gamma].
```

The leading zero row which pads the implicit tableau is part of the additive
stage alignment. Diffusion and all spin reactions are implicit. Transient
drives and the LLG/local-field partition are explicit or semi-implicit, but
all partitions share stage times and one rollback transaction. The scheme has
no invented embedded pair: adaptive error control uses one full step versus
two half steps, scales their difference by `1/(2^2-1)`, and accepts the two
half-step state. Both trials start from the same committed state and may not
publish fields, caches, nonlinear history, or telemetry until acceptance.

The small fully implicit reference is constant-step BDF2,

```text
C_s (3 mu_s^(n+1)-4 mu_s^n+mu_s^(n-1))/(2 dt)
  + div Q(mu_s^(n+1), V^(n+1), m^(n+1))
  = -R(mu_s^(n+1),m^(n+1)),
```

bootstrapped by backward Euler from an authored initial state or an explicitly
requested equilibrium solve. A step-size change invalidates this constant-step
history in v1 and restarts with backward Euler; silently applying the
constant-step formula to unequal steps is prohibited. `explicit_dp45` is
unsupported for transient spin until a compatible partitioned-order proof
exists. Subcycling requires a coupled error/order proof.

The public owner of this coupled time algorithm is the stage dynamics choice:
transient spin requires `LLG(integrator="coupled_imex_ark2")`. The
`SpinSolverPolicy.engine` field continues to select the spatial linear/nonlinear
transport solver and must not be overloaded with time-integration semantics.
The existing adaptive-timestep contract controls ARS step doubling; fixed-step
execution disables error-based rejection but still executes the same versioned
ARS stages. `coupled_bdf2_small_oracle.v1` remains validation-only and is not a
production authoring choice in M3.

(spin-transport-frozen-free-error-support)=
### 2.6.1. Frozen M, free target i zaakceptowany czas — prerejestracja

**Stan: `planned_contract`, runtime `NOT VERIFIED`.** To doprecyzowanie
istniejącego zerowania wag masked/nonmagnetic DOF, nie zmiana równań transportu.
Support błędu zewnętrznego kroku jest przecięciem fizycznych torque targetów
ze swobodnymi aktywnymi magnetycznymi DOF resolved constraintu:

```{math}
:label: spin-transport-free-target-support
\Omega_{T,U}=\Omega_T\cap\Omega_U.
```

Dla niepustego supportu obie normy mają identyczny support i wagę objętościową:

```{math}
:label: spin-transport-free-target-error-budget
\Delta t\sqrt{\frac{\int_{\Omega_{T,U}}
\lVert\Delta\mathbf T_{\mathrm{tr}}\rVert^2\,\mathrm dV}
{\lvert\Omega_{T,U}\rvert}}
\le\eta_{\mathrm{tr}}\sqrt{\frac{\int_{\Omega_{T,U}}
\lVert\delta\mathbf m_{\mathrm{emb}}\rVert^2\,\mathrm dV}
{\lvert\Omega_{T,U}\rvert}}.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\Omega_{T,U}$ | Wspólny free torque-target support | $\mathrm{m^3}$ |
| $\Omega_T$ | Fizyczny obszar targetów torque | $\mathrm{m^3}$ |
| $\Omega_U$ | Obszar swobodnych aktywnych magnetycznych DOF | $\mathrm{m^3}$ |
| $\Delta\mathbf T_{\mathrm{tr}}$ | Różnica transportowych źródeł Gilberta użyta w istniejącym outer-error gate | $\mathrm{s^{-1}}$ |
| $\delta\mathbf m_{\mathrm{emb}}$ | Istniejący embedded estimator przed renormalizacją, projektowany na free support | $1$ |
| $\Delta t$ | Rzeczywisty czas kroku | $\mathrm{s}$ |
| $\eta_{\mathrm{tr}}$ | Istniejący udział błędu transportu w budżecie kroku | $1$ |
| $\lvert\Omega_{T,U}\rvert$ | Objętość wspólnego supportu | $\mathrm{m^3}$ |
| $\mathrm dV$ | Miara objętościowa | $\mathrm{m^3}$ |

Dla pustego supportu obie redukcje mają wartość zero, a wyłącznie powyższe
kryterium wpływu błędu torque na swobodne M jest vacuous. Nie dzieli się przez
zero i nie ustanawia dodatniego floor dla LTE. Nie wolno usuwać zamrożonych
targetów z fizycznego torque, mu/Q, reakcji, obserwabli ani bilansów. Niezależne
charge/spin residuals, physical balances, finite-value oraz nonlinear-update
gates pozostają obowiązkowe. Błąd odrzuca trial bez publikacji accepted.
Nie wystarczy wyłączyć cały M2 gate, gdy wszystkie M są zamrożone.

Historyczny scalar embedded_lte_m był redukowany po wszystkich komórkach n
po projekcji i przekazywany każdemu modułowi M2. Nie zawierał informacji
potrzebnej do redukcji na odmiennym target∩free support.

Implementacja źródłowa przenosi teraz pożyczoną surową różnicę kandydatów
Heuna i Eulera przed normalizacją w istniejącym scratch k[2]
przez synchroniczny corrected callback i TransportStageErrorBudget. Właściciel
normy redukuje błąd oraz zmianę torque po identycznym per-module target∩free
support. Maska nie zmienia fizycznych targetów ani obserwabli. Normy i ich
iloczyny muszą pozostać finite przed oceną ratio; empty support daje (0,0),
bez dodatniego floor. Nie dodano alokacji gridowej dla estimatora ani maski.
Różnica torque pozostaje różnicą źródeł Gilberta.

Ten fragment ma status SOURCE_ONLY: składnia i kontrolowane sprawdzenia
źródeł nie dowodzą typów/lifetimes ani wykonania solvera. Build 78 nie zawiera
tej zmiany. Naprawy shortcutu all-frozen, czasu, completion i polityki Relax+M3
pozostają planned_contract; poniższe runtime gates nadal są wymagane.

All-frozen TimeEvolution wykonuje istniejące coupled Heun (steady M1/M2)
lub ARS (M3), z końcową maską pełnego RHS i restore M w każdym candidate;
nie wykonuje fikcyjnego dt=0. M3 adaptive nadal ocenia transportowe observables
i spinową historię w full/two-half comparison mimo zerowej różnicy M.
Czysto magnetyczny all-frozen pozostaje no-op zgodnie z 0996.

Stage i istniejący time-event scheduler są jednym właścicielem czasu. Każde
źródło jest oceniane w rzeczywistym czasie etapu z zachowaniem authored origin.
Fixed/adaptive krok musi trafić w current-envelope breakpoint, wymagany output
i końcowy endpoint; partial fixed M3 step zachowuje swoje rzeczywiste dt i
historię. Nie wolno nadawać wynikowi innego czasu przez canonicalization po
solve. Zmiana dt podlega istniejącemu kontraktowi historii, bez nowego ownera.
`accepted.evaluated_time_s`, state time, report, counters i checkpoint muszą
opisywać ten sam stan. Pause/cancel nie oznacza completed/converged ani nie
przeskakuje czasu; success wymaga rzeczywistego accepted endpoint transportu.

Publiczny Relax odrzuca aktywne niekonserwatywne torque przez
`crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation`.
Prerejestrowana polityka dodatkowo odrzuca aktywny M3 w Relax również bez torque:
brak kanonicznego kryterium zbieżności transient transportu. To wymaganie
przyszłej walidacji, nie claim istniejącej implementacji. Zachowane steady
zero-current/disabled-torque grafy nie otrzymują nowej odmowy przez tę regułę.
Nie implementuje się nowej zbieżności ani pseudoczasu minimizatora.

Zakres realizacji: FDM CPU/double fixed Heun M1/M2 oraz fixed/adaptive
`coupled_imex_ark2` M3 wymagają odrębnych managed gates. Inne integratory,
FEM/GPU i single nie dziedziczą kwalifikacji. Nie zmienia się publicznych
parametrów, ProblemIR ani source/torque modelu dla dopasowania BORIS.
Bramki: dokładne M w każdym etapie, physical balances, empty/partial free-target,
czasowy pulse/PWL napęd, off-grid events/final endpoint, late-failure rollback,
pause/cancel oraz checkpoint/restart; dowody samego źródła nie kwalifikują runtime.

(fdm-cpu-transport-gilbert-rhs-boundary)=
### 2.6.2 Jedna konwersja transportowego źródła Gilberta — FDM CPU

**Stan z 2026-10-15: historyczny `SOURCE_BUG_CONFIRMED`; prerejestracja
poprzedziła zapis poprawki. Obecnie implementacja `SOURCE_ONLY`, runtime
`NOT VERIFIED`.** Norma 0960, `governing-equations`, odróżnia źródło
Gilberta od jawnego RHS. Dla jednostkowego $m$ i stycznego źródła obowiązuje:

```{math}
:label: fdm-cpu-transport-gilbert-explicit-source
T_{\mathrm{tr,RHS}}=
\frac{T_{\mathrm{tr},G}+\alpha\,m\times T_{\mathrm{tr},G}}{1+\alpha^2}.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $T_{\mathrm{tr},G}$ | źródło transportowe przed konwersją Gilberta | $\mathrm{s^{-1}}$ |
| $T_{\mathrm{tr,RHS}}$ | jawny wkład transportowy do pochodnej magnetyzacji | $\mathrm{s^{-1}}$ |
| $m$ | zredukowana magnetyzacja bieżącej próbki etapu | $1$ |
| $\alpha$ | lokalne tłumienie Gilberta | $1$ |

`crates/fullmag-runner/src/fdm/cpu/spin_transport.rs::FdmSpinTransportWorkflow::evaluate_stage_internal`
sumuje surowe `transport_gilbert_torque_per_s` producentów M1/M2/M3.
Przed poprawką `reference.rs::execute_coupled_ars_trial` i
`execute_coupled_heun_trial` przekazywały tę sumę bez konwersji do
`ExternalStageTerms.direct_torque_per_s`.
Jednak `crates/fullmag-engine/src/fdm/shared/types.rs::ExternalStageTerms`
jawnie definiuje to pole jako **już jawne** $dm/dt$; CPU
`integrators.rs::apply_external_stage_terms` dodaje je po obliczeniu RHS pola.
Poprawna implementacja tego kontraktu nie konwertuje direct drugi raz.
Potwierdzona historyczna luka leżała na granicy przekazania źródła przez oba
callbacki, nie w samym dodawaniu jawnego RHS.

Przerejestrowany pojedynczy owner jest już zapisany jako metoda
`ExchangeLlgProblem::external_stage_terms_from_gilbert_source` w CPU
`fields/direct_torques.rs`. Tworzy istniejące `ExternalStageTerms` z dokładnego
trial $m$ i lokalnego `ExchangeLlgProblem::alpha_at`, konwertując wyłącznie
przekazane źródło Gilberta. Oba callbacki wywołują ten sam helper. To kontrola
źródeł, bez kompilacji lub wykonania helpera; snapshoty transportowe pozostają
surowym źródłem, a Oersted pozostaje polem
w $\mathrm{A/m}$. Nie zmienia się semantyki istniejącego direct pola,
Python, `ProblemIR`, znaków absorpcji ani operatorów transportu.

| Argument Rust / typ | Default i walidacja | SI / znaczenie |
|---|---|---|
| `magnetization: &[Vector3]` | required; dokładnie `grid.cell_count()`; bez nowej normalizacji | $1$; dokładny trial bieżącego callbacku |
| `additional_field_apm: Vec<Vector3>` | required; dokładnie grid count; pole przekazane bez przeliczenia | $\mathrm{A/m}$; dodatkowe pole, nie źródło Gilberta |
| `gilbert_source_per_s: Vec<Vector3>` | required; dokładnie grid count; owned buffer konwertowany in-place; raw obserwacje są zachowane przez caller clone | $\mathrm{s^{-1}}$; źródło przed konwersją, wynik w istniejącym direct polu jest jawny |

Niezgodna liczność daje `InvalidInput`; istniejąca późniejsza kontrola
`apply_external_stage_terms` nadal odrzuca niefinitywne external terms.
Nie dodano nowego parametru Python ani `ProblemIR`.

Obowiązuje dotychczasowa konwencja trialu z
`ProjectionPolicy::project` i `ExchangeLlgProblem::llg_rhs_from_field_at`:
bez nowej normalizacji, korekty mianownika normą $m$ ani zmiany projekcji RK.
Zero źródła w nieaktywnych komórkach pozostaje zerem; zamrożone DOF nadal
podlegają istniejącej końcowej masce. Nowy adapter nie może włączać torque
w domenie niemagnetycznej ani zmieniać maski targetu.
`precession_enabled=false` nie jest globalnie odrzucane przez engine;
dotychczasowy RHS wyłącza nim wyłącznie precesyjną część pola. Adapter nie
zmienia tej flagi i nie pomija z jej powodu konwersji źródła. Kanoniczny
`crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation`
odrzuca aktywne niekonserwatywne torque w Relax; dostępność niskopoziomowego
engine API nie kwalifikuje takiego publicznego workflow.

Zakres luki: stały krok Heuna dla M1/M2 oraz ARS(2,3,2)
`coupled_imex_ark2` dla M3, także jego adaptacyjne pełny/dwa półkroki.
To nie ustalenie o innych integratorach, FEM ani GPU. Bramka poprawki wymaga
odrębnych dowodów źródłowych/algebry i rzeczywistego runtime: lokalne różne
$\alpha$, nieosiowe $m$, wszystkie próbki obu metod, brak podwójnej konwersji,
zero źródła, nieaktywne/zamrożone komórki i rollback. Te bramki nie są tutaj
wykonane. Sam rename artefaktu lub porównanie z BORIS nie naprawia równania.

Zapisane regresje w `crates/fullmag-engine/tests/fdm_cpu_gilbert_stage.rs`:
`gilbert_stage_uses_local_damping_and_preserves_field_and_source_observations`
oraz `gilbert_source_matches_independent_field_rhs_through_heun_and_ars_trials`
obejmują lokalne tłumienie, zachowanie obserwabli oraz niezależną tożsamość
źródło–pole dla Heuna i ARS. Ich stan to **source-only: niekompilowane i
niewykonane**; nie zamykają bramek powyżej.

(spin-transport-composite-resume-v2)=
### 2.6.3. Composite checkpoint v2: accepted ARS i durable outputs

**Publiczna odmowa A: `IMPLEMENTED_SOURCE_ONLY`, `NOT_COMPILED`,
`NOT_EXECUTED`.** Wspólny runner-owned
`validate_fdm_transport_checkpoint_resume_support` odmawia checkpoint continuation
rzeczywistego CPU workflow M1/M2/M3, również z frozen spins. Jego `Ok(())`
oznacza tylko brak tej konkretnej odmowy, nie pozytywny admission formatu lub
tożsamości. API klasyfikuje te checkpointy jako `RestoreClass::Unsupported`
(`unsupported`) i odmawia restore przed odczytem common state oraz mutacją;
CLI odmawia przed pobraniem paused state przez `take()`, a UI dopuszcza restore
wyłącznie dla `exact_resume`. Nie ma automatycznego downgrade do
InitialConditionImport, LogicalResume ani portable importu.

Nie dodano globalnej odmowy pure-magnetic/frozen/ABM3 bez spin workflow;
GPU/FEM zachowują własnych ownerów i bramki. Pozostała klasyfikacja katalogu
API nadal korzysta z dotychczasowego self-compatibility; A nie naprawia jej
zgodności z aktualną identity. Prywatny codec i original-stage gate B nie są
pozytywnym admission. Full v2 carriers/generation, activation/spin history,
immutable original context, committed outputs/CAS prefix i atomowy restore
pozostają OPEN. Dokładna granica publiczna jest w
[specyfikacji API](../specs/resource-first-control-room-api-v2.md#checkpoint-restore-admission).
Nowy wariant wire wymaga oficjalnej generacji OpenAPI/TS z przyszłego managed
pakietu z pinami A; pakiet #80 nie zawiera tej zmiany i jej nie weryfikuje.

**Prywatny codec: IMPLEMENTED_SOURCE_ONLY, NOT_COMPILED, NOT_EXECUTED;
publiczna obsługa codec i integracja ExactResume: planned_contract,
runtime NOT VERIFIED.** Dokładny
schema fullmag.fdm.coupled_m3_checkpoint.v2, required fields i hash są w
[§13 frozen spec](../specs/frozen-spins-v1.md#frozen-v2-composite-checkpoint).
Reuse dotyczy pełnego FdmCoupledCheckpoint V1 i jego complete validatora,
FrozenSpinsCheckpointV1, FrozenSpinsActivationSet oraz AcceptedStateRef.
Nie zmienia równań, parametrów SpinDriftDiffusion/TransportExecution/solver
policy ani Python→ProblemIR mapping. Prywatne `FdmCompositeCheckpointV2`,
`decode_composite_m3_codec_v2` i `FdmCompositeCheckpointV2::validate_self_contained`
mają ownera `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs`.
Nie są konstruktorami publicznymi ani bramką ExactResume; rzeczywiste
plan/source/common/carriers/generation oraz committed output CAS wymagają
kolejnej contextual walidacji.

Prywatny `CodecCheckedCompositeV2::validate_for_original_stage` ma status
`SOURCE_ONLY`, `NOT_COMPILED`, `NOT_EXECUTED`: sprawdza oryginalne
problem/plan/stage/outputs przekazane przez admitted ownera. Sam helper nie
dowodzi pochodzenia tych danych z immutable admission ani integracji callera.
Common state, primary carriers/generation, activation history, store/CAS prefix,
atomic restore i publiczne API pozostają OPEN; ExactResume/runtime NOT VERIFIED.

| Solver | Device | Composite v2 ExactResume |
|---|---|---|
| FDM | CPU | Planned reference FP64 ARS fixed/adaptive; runtime NOT VERIFIED |
| FDM | GPU | Unsupported tutaj: brak zgodnego composite ownera, bez fallbacku |
| FEM | CPU | Unsupported tutaj: inne DOF/runtime i brak codec |
| FEM | GPU | Unsupported tutaj: brak kwalifikacji tej kombinacji |

Outer accepted dt, czas, krok i M muszą bitowo zgadzać się między common,
nested M3 i obecnym frozen child. Adaptive ARS zachowuje zaakceptowane dwa
podkroki. TransientSpinState.previous_dt_s jest faktycznym drugim residual dt, a
previous_spin_potential_v stanem split. Nested previous_magnetization nadal
wskazuje outer start; error_controller.next_dt nie jest last accepted dt.
Report/outer accepted_steps liczą jeden krok; transient revisions/telemetry
zachowują rzeczywistą historię dwóch commitów. Nie wymaga się exact 2*inner=outer
ani równych inner dt. Wcześniej ustalony trial endpoint musi być osiągnięty
przed estimator, bez przepisywania timestampów. To nie jest order proof ARS.

Original authored endpoint/grid/waveform/output origins i istniejące schedule
cursory są required; off-grid pauza nie przesuwa nominalnej siatki ani fazy.
Hash v2 używa istniejącego canonical_json_bytes, a nested M3 zachowuje własny
payload digest. Raw strict completeness odrzuca pominięte defaults/unknown
fields, zamiast dorabiać historię w codec V1. Restore waliduje całość lokalnie
przed publikacją obu subsystemów i controller/cursor state.

Binding outputs wskazuje faktyczny FmsStudyOutputManifest przez immutable
published entry/revision w FmsArtifactCatalog; nie jest nowym receiptem.
ArtifactRecorder enqueue nie dowodzi trwałego scalar/field/default/boundary
prefixu. SessionStore::commit_checkpoint ma writer lease i marker po common
state/reachability. Powiązanie prefixu z immutable attempt allow-list oraz
checkpoint graph pozostaje work itemem istniejącego publication ownera.
Do czasu jego domknięcia composite_outputs_not_committed odmawia ExactResume,
nawet przy poprawnych hash/count/cursorach. Bez nowego per-step fsync i timera.

Aktywacja frozen zachowuje źródłowe mask/reference/epoki bez recapture, także
na inactive→active stage chain; [nota 0996](0996-frozen-spins-constraint.md#frozen-spins-composite-resume-v2)
opisuje tę granicę. Standalone legacy codecs i ich kwalifikacje nie otrzymują
nowego claimu, tymczasowe odmowy transport resume nie są znoszone.
Przyszłe niewykonane gates: composite_v2_ars_history,
composite_v2_outputs_atomicity, composite_v2_cli_api_roundtrip oraz pełna
macierz §13.7. Focused docs check nie jest execution/parity proof.

(symbols-and-si-units)=
### 2.7 Symbols and SI units

| Symbol | Meaning | SI unit / condition |
|---|---|---|
| `V`, `mu_s` | charge potential, full spin splitting | V |
| `E`, `G` | charge/spin driving gradients | V/m |
| `J_c`, `Q_ia`, interface fluxes | charge-equivalent current density | A/m^2 |
| `sigma`, `sigma_s`, `sigma_parallel/perp`, `sigma_AHE` | conductivity | S/m |
| `P`, `theta_SH` | signed dimensionless coefficients | 1, finite |
| `C_s` | spin capacitance/susceptibility | A s V^-1 m^-3, `>0` in M3 |
| `N_0` | per-spin density of states for the canonical DOS adapter | J^-1 m^-3, `>0`; `C_s=e^2N_0` |
| `lambda_sf/J/phi` | reaction lengths | m, `>0` when active |
| `R_sf/J/phi` | volumetric spin sink | A/m^3 |
| `G_up/down/r/i/SML` | interface conductance | S/m^2 |
| `m` | reduced magnetization | 1 |
| `T_tr,G` | Gilbert torque source | s^-1 |
| `delta T_transport` | change of transport Gilbert-source torque between nonlinear iterates | s^-1 |
| `||.||_T` | volume-normalized vector `L2` norm on active magnetic torque targets | unit of its argument |
| `delta m_embedded`, `LTE_m` | embedded LLG state error and its target-domain norm before renormalization | 1 |
| `eta_transport` | allowed transport-to-outer-error fraction | 1; initial contract `0.1` |
| `dt` | current outer LLG step size | s, `>0` |

The machine-readable symbol contract used by the source map is:

| id | latex | meaning | si_unit |
|---|---|---|---|
| V | V | charge electrochemical potential | \mathrm{V} |
| b_K | $b_K$ | assembled finite-volume charge right-hand side for cell $K$ | $\mathrm{A}$ |
| K | $K$ | deterministic finite-volume cell index | $1$ |
| C | $C$ | one numerically connected conducting-cell component | $1$ |
| V_bar_C | $\bar V_C$ | arithmetic mean charge potential on component $C$ | $\mathrm{V}$ |
| mu_s | \mu_s | full spin-channel splitting | \mathrm{V} |
| E | E_i | electric field, negative charge-potential gradient | \mathrm{V\,m^{-1}} |
| G | G_{ia} | spin-voltage gradient | \mathrm{V\,m^{-1}} |
| J_c | J_{c,i} | conventional charge-current density | \mathrm{A\,m^{-2}} |
| Q | Q_{ia} | charge-equivalent spin-current tensor; first index is flow and second is spin polarization | \mathrm{A\,m^{-2}} |
| sigma | \sigma | reciprocal reference charge conductivity | \mathrm{S\,m^{-1}} |
| sigma_s | \sigma_s | spin conductivity | \mathrm{S\,m^{-1}} |
| sigma_parallel | \sigma_{\parallel} | magnetoresistive conductivity parallel to magnetization | \mathrm{S\,m^{-1}} |
| sigma_perpendicular | \sigma_{\perp} | magnetoresistive conductivity transverse to magnetization | \mathrm{S\,m^{-1}} |
| sigma_AHE | \sigma_{\mathrm{AHE}} | anomalous-Hall antisymmetric conductivity coefficient | \mathrm{S\,m^{-1}} |
| P | P | charge-to-spin polarization | $1$ |
| theta_SH | \theta_{\mathrm{SH}} | spin-Hall angle with stored sign convention | $1$ |
| lambda_sf | \lambda_{\mathrm{sf}} | spin-flip diffusion length | \mathrm{m} |
| lambda_J | \lambda_J | transverse exchange length | \mathrm{m} |
| lambda_phi | \lambda_\phi | transverse dephasing length | \mathrm{m} |
| Sigma_mr | \Sigma_{\mathrm{mr}} | symmetric AMR/PHE charge-conductivity tensor | \mathrm{S\,m^{-1}} |
| R_sf | R_{\mathrm{sf}} | spin-flip reaction density | \mathrm{A\,m^{-3}} |
| R_J | R_J | transverse exchange reaction density | \mathrm{A\,m^{-3}} |
| R_phi | R_\phi | transverse dephasing reaction density | \mathrm{A\,m^{-3}} |
| G_up | G_{\uparrow} | majority-spin interface conductance per area | \mathrm{S\,m^{-2}} |
| G_down | G_{\downarrow} | minority-spin interface conductance per area | \mathrm{S\,m^{-2}} |
| G_r | G_r | real spin-mixing conductance per area | \mathrm{S\,m^{-2}} |
| G_i | G_i | imaginary spin-mixing conductance per area | \mathrm{S\,m^{-2}} |
| delta_V_Gamma | \Delta V_{\Gamma} | accepted oriented interface potential-trace jump | \mathrm{V} |
| r_K | r_{K,a} | component-wise local finite-volume spin-balance residual | \mathrm{A\,m^{-3}} |
| S_K | S_K | local finite-volume spin-flux and reaction scale | \mathrm{A\,m^{-3}} |
| S_Gamma | S_{\Gamma,K} | one-sided mixing-interface correction scale | \mathrm{A\,m^{-3}} |
| tau_abs | \tau_{\mathrm{abs}} | absolute local spin-balance tolerance | \mathrm{A\,m^{-3}} |
| tau_rel | \tau_{\mathrm{rel}} | relative local spin-balance tolerance | $1$ |
| gamma_e | \gamma_e | positive electron gyromagnetic ratio magnitude | \mathrm{s^{-1}\,T^{-1}} |
| M_s | M_s | saturation magnetization | \mathrm{A\,m^{-1}} |
| hbar | \hbar | reduced Planck constant | \mathrm{J\,s} |
| e | e | positive elementary charge | \mathrm{C} |
| q_abs | q_{\mathrm{abs},\perp} | transversely absorbed interface spin-current density | \mathrm{A\,m^{-2}} |
| T_tr_G | T_{\mathrm{tr},G} | transport-derived Gilbert-source torque | \mathrm{s^{-1}} |
| m | $m$ | reduced magnetization direction | $1$ |
| alpha | $\alpha$ | Gilbert damping | $1$ |
| B_eff | $B_{\mathrm{eff}}$ | effective magnetic induction | $\mathrm{T}$ |
| T_P | $T_P$ | polarization-driven contribution to transport torque | $\mathrm{s^{-1}}$ |
| T_SHE | $T_{\mathrm{SHE}}$ | direct-SHE contribution to transport torque | $\mathrm{s^{-1}}$ |
| seed_xy | $x,y$ | world-space coordinates in the racetrack plane | $\mathrm{m}$ |
| seed_center | $x_c,y_c$ | frozen world-space skyrmion centre | $\mathrm{m}$ |
| seed_rho | $\rho$ | radial distance from the frozen centre | $\mathrm{m}$ |
| seed_phi | $\phi$ | polar angle about the frozen centre | $\mathrm{rad}$ |
| seed_theta | $\theta$ | skyrmion polar profile angle | $\mathrm{rad}$ |
| seed_phase | $\chi$ | in-plane phase; equals $\phi$ for the frozen outward Néel wall | $\mathrm{rad}$ |
| seed_radius | $R$ | frozen seed radius | $\mathrm{m}$ |
| seed_wall_width | $\Delta$ | frozen seed wall width | $\mathrm{m}$ |
| seed_polarity | $p$ | serialized polarity multiplier in the repository profile | $1$ |
| seed_m_raw | $\mathbf m_{\mathrm{raw}}$ | pre-normalization seed vector | $1$ |

```{math}
:label: m1-constitutive-block
J_{c,i}=\sigma E_i,\qquad
Q_{ia}=\sigma_sG_{ia}+P\sigma E_i m_a
       +\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k.
```

```{math}
:label: m2-reciprocal-constitutive-block
\begin{aligned}
J_{c,i}&=J_{\mathrm{mr},i}+P\sigma m_aG_{ia}
       +\theta_{\mathrm{SH}}\sigma\epsilon_{ija}G_{ja},\\
Q_{ia}&=\sigma_sG_{ia}+P\sigma E_i m_a
       +\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k,
\end{aligned}
```

```{math}
:label: m2-schur-positivity
\lambda_{\min}(\Sigma_{\mathrm{mr}})\sigma_s-P^2\sigma^2>0,
\qquad
\lambda_{\min}(\Sigma_{\mathrm{mr}})=
\min(\sigma_{\parallel},\sigma_{\perp}).
```

```{math}
:label: spin-balance-reaction
\partial_iQ_{ia}=-R_{\mathrm{sf},a}-R_{J,a}-R_{\phi,a},
\quad
R_{\mathrm{sf}}=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\mu_s,
\quad
R_J=\frac{\sigma_s}{2\lambda_J^2}(\mu_s\times m),
\quad
R_\phi=\frac{\sigma_s}{2\lambda_\phi^2}m\times(\mu_s\times m).
```

```{math}
:label: m1-mixing-interface-reduction
\begin{aligned}
j_{c,n}^{(\mathrm{M1})}
  &=\begin{cases}
    (G_{\uparrow}+G_{\downarrow})\Delta V_{\Gamma},
      &G_{\uparrow}+G_{\downarrow}>0,\\
    0,&G_{\uparrow}=G_{\downarrow}=0,
  \end{cases}\\
q_{s,\parallel}^{(\mathrm{M1})}
  &=\left[(G_{\uparrow}-G_{\downarrow})\Delta V_{\Gamma}
    +\frac{G_{\uparrow}+G_{\downarrow}}{2}
      m\cdot\Delta\mu_s\right]m,\\
q_{\mathrm{abs},\perp}
  &=G_r m\times(\Delta\mu_s\times m)
    +G_i(\Delta\mu_s\times m).
\end{aligned}
```

The zero-longitudinal-conductance branch is a charge-insulating interface: it
does not connect charge components, its accepted traces are the two adjacent
cell potentials, and its charge observation is exactly zero. Non-negative
finite `G_up` and `G_down` with zero sum are legal; a negative or non-finite
entry and a non-finite sum fail closed. Nonzero finite `G_r` and `G_i` remain
legal in this branch and contribute only to transverse spin absorption.

```{math}
:label: fdm-exact-face-current-electric-reconstruction
E_{K,x}=\frac{J_{c,x-}+J_{c,x+}}{2\sigma_K},\qquad
E_{K,y}=\frac{J_{c,y-}+J_{c,y+}}{2\sigma_K},\qquad
E_{K,z}=\frac{J_{c,z-}+J_{c,z+}}{2\sigma_K}.
```

```{math}
:label: fdm-local-fv-balance-and-torque
\begin{aligned}
r_{K,a}&=\left[
\frac{1}{|K|}\sum_{f\subset\partial K}|f|Q_f\cdot n_{Kf}
+R_{\mathrm{sf},K}+R_{J,K}+R_{\phi,K}
\right]_a,\\
S_K&=\frac{1}{|K|}\sum_{f\subset\partial K}|f|\lVert Q_f\rVert_2
+\lVert R_{\mathrm{sf},K}\rVert_2+\lVert R_{J,K}\rVert_2
+\lVert R_{\phi,K}\rVert_2+S_{\Gamma,K},\\
\max_a|r_{K,a}|&\le \tau_{\mathrm{abs}}+\tau_{\mathrm{rel}}S_K,
\end{aligned}
\qquad
T_{\mathrm{tr},G,K}=-\frac{\gamma_e}{M_{s,K}}\frac{\hbar}{2e}
\left(R_{J,K}+R_{\phi,K}
+\frac{1}{|K|}\sum_{f\in\Gamma_K}|f|q_{\mathrm{abs},\perp,f}\right).
```

(assumptions-and-validity)=
### 2.8 Assumptions and validity limits

The model is local, diffusive, and electroquasistatic. Its anisotropic
reciprocal material must satisfy
`min(sigma_parallel,sigma_perp) sigma_s-P^2 sigma^2>0`; checking only
`sigma_s-P^2 sigma>0` is valid solely for the isotropic specialization. It excludes ballistic
transport, first-principles tunnelling, full Maxwell displacement current,
unresolved interfacial quantum chemistry, and implicit spin pumping. Planner
warns or rejects when device dimensions approach the mean free path. NaN/Inf,
nonpositive dissipative coefficients, invalid references, missing charge gauge,
nonpositive active lengths, M1+iSHE, or transient without `C_s` are invalid.

(racetrack-m1-v1-contract)=
### 2.9 Frozen solved-current racetrack fixture `racetrack_m1_v1`

`racetrack_m1_v1` jest syntetycznym fixture walidacyjnym. Nie reprezentuje
jednego rzeczywistego materiału ani dopasowanego stosu HM/FM. Wartości
magnetyczne korzystają ze skali klasycznego workloadu ultracienkiego skyrmionu
Sampaio et al.; model dyfuzyjny i interfejsowy opierają się odpowiednio na
Valet--Fert, Abert et al. i Brataas--Nazarov--Bauer. Geometria, kontrast
przewodności, mixing conductance i symetryczny sweep są jawnymi wyborami
benchmarkowymi służącymi pokryciu gałęzi oraz testom znaków. Normatywną wersją
maszynową jest
`tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json`.

#### 2.9.1 Osie, current i komplet równań M1

Układ jest prawoskrętny: $+x$ biegnie wzdłuż toru, $+y$ jest osią poprzeczną,
a $+z$ biegnie od HM do FM. Dodatni $J_x$ oznacza conventional current, $e>0$,
a moment elektronu nie zmienia tej definicji prądu. Normalna interfejsu HM→FM
wynosi $n=+e_z$. Z równania charge continuity otrzymujemy:

```{math}
:label: racetrack-charge-continuity
\nabla\!\cdot\mathbf J_c=0,
\qquad
\mathbf J_c=\sigma\mathbf E=-\sigma\nabla V.
```

Direct SHE jest częścią jednego tensora $Q_{ia}$, a nie nieopisanym wektorem:

```{math}
:label: racetrack-direct-she
Q^{\mathrm{SHE}}_{ia}
=\theta_{\mathrm{SH}}\epsilon_{ika}J_{c,k},
\qquad
J_{c,x}>0,\ \theta_{\mathrm{SH}}>0
\Longrightarrow Q^{\mathrm{SHE}}_{zy}>0.
```

Steady M1 rozwiązuje trzy składowe akumulacji spinowej z kompletem reakcji:

```{math}
:label: racetrack-steady-spin-balance
\begin{aligned}
\partial_iQ_{ia}&=-R_{\mathrm{sf},a}-R_{J,a}-R_{\phi,a},\\
R_{\mathrm{sf}}&=\frac{\sigma_s}{2\lambda_{\mathrm{sf}}^2}\mu_s,\\
R_J&=\frac{\sigma_s}{2\lambda_J^2}(\mu_s\times m),\\
R_\phi&=\frac{\sigma_s}{2\lambda_\phi^2}m\times(\mu_s\times m).
\end{aligned}
```

Dla skoku $\Delta\mu_s=\mu_{s,HM}-\mu_{s,FM}$ i zaakceptowanego skoku
$\Delta V_\Gamma=V_{HM}-V_{FM}$ warunek mixing ma postać:

```{math}
:label: racetrack-mixing-boundary
\begin{aligned}
j_{c,n}&=(G_\uparrow+G_\downarrow)\Delta V_\Gamma,\\
q_{s,\parallel}&=\left[(G_\uparrow-G_\downarrow)\Delta V_\Gamma
+\frac{G_\uparrow+G_\downarrow}{2}m\cdot\Delta\mu_s\right]m,\\
q_{\mathrm{abs},\perp}&=G_r m\times(\Delta\mu_s\times m)
+G_i(\Delta\mu_s\times m).
\end{aligned}
```

Moment pędu przekazany do jednej komórki FM $K$ jest sumą reakcji
objętościowych i zorientowanej absorpcji powierzchniowej. Spin-flip nie należy
do torque magnetycznego:

```{math}
:label: racetrack-torque-balance
T_{\mathrm{tr},G,K}=-\frac{\gamma_e}{M_{s,K}}\frac{\hbar}{2e}
\left[R_{J,K}+R_{\phi,K}
+\frac{1}{|K|}\sum_{f\in\Gamma_K}|f|q_{\mathrm{abs},\perp,f}\right].
```

`T_tr,G` jest źródłem w kanonicznej postaci Gilberta. Dla
$B_{\mathrm{eff}}=\mu_0H_{\mathrm{eff}}$ pełny jawny RHS wynosi:

```{math}
:label: racetrack-gilbert-llg
(1+\alpha^2)\partial_t m=
-\gamma_e\left[m\times B_{\mathrm{eff}}
+\alpha m\times(m\times B_{\mathrm{eff}})\right]
+T_{\mathrm{tr},G}+\alpha m\times T_{\mathrm{tr},G}.
```

#### 2.9.2 Pełna tabela znaków

Tabela opisuje model liniowy M1 przed nieliniową odpowiedzią trajektorii.
`odd` oznacza dokładne odwrócenie znaku przy ustalonym deskryptorze i stanie
$m$. Kąt Halla jest surowo zdefiniowany przez `atan2(v_y,v_x)`; po odwróceniu
obu składowych prędkości zmienia gałąź o $\pi$, a nie po prostu znak.

Produkcyjny fixture ma $P=0.4$, dlatego odwrócenie samego
$\theta_{\mathrm{SH}}$ nie odwraca całej $\mu_s$, całego $Q$ ani całego
torque. Dla ustalonego $m$, zaakceptowanego snapshotu charge i wszystkich
pozostałych parametrów odpowiedź rozdziela się na część polaryzacyjną oraz
SHE. Dla torque zapis jest następujący:

```{math}
:label: racetrack-theta-sh-torque-decomposition
T(+\theta_{\mathrm{SH}})=T_P+T_{\mathrm{SHE}},
\qquad
T(-\theta_{\mathrm{SH}})=T_P-T_{\mathrm{SHE}}.
```

Tak samo rozkładają się $\mu_s$ i $Q$. Ich całkowita odpowiedź przy $P=0.4$
nie jest ogólnie odd. Dokładny oracle odwrócenia czystego SHE używa kopii
fixture z jedyną zmianą $P=0$; zachowuje $G_\uparrow=G_\downarrow$, ten sam
$m$ i ten sam charge snapshot. Wtedy $\mu_s$, $Q$ i $T_{\mathrm{tr},G}$ muszą
być dokładnie odd względem $\theta_{\mathrm{SH}}$ w tolerancji numerycznej
orakla. Dla pełnej nieliniowej dynamiki obowiązuje jawne ograniczenie:
`no exact oddness claim for nonlinear trajectory velocity`.

| Operacja | $J_c$ | $Q^{SHE}$, $\mu_s$, oriented flux | $T_{tr,G}$ | $(v_x,v_y)$ w granicy liniowej | $\Theta_H$ | Warunek legalności |
|---|---:|---:|---:|---:|---:|---|
| `identity` | bez zmiany | bez zmiany | bez zmiany | bez zmiany | bez zmiany | osie jak wyżej |
| `reverse_J` | odd | odd | odd | $(-v_x,-v_y)$ | `wrap(Theta_H +/- pi)` | odwrócić oba zbilansowane terminale; moduł nadal istnieje |
| `reverse_theta_SH` | bez zmiany | część polaryzacyjna bez zmiany, część SHE odd | $T_P+T_{\mathrm{SHE}}\to T_P-T_{\mathrm{SHE}}$ | brak dokładnego prawa dla pełnej trajektorii; w oracle $P=0$ odd jest transport przy ustalonym $m$ | brak ogólnego prawa | nie zmieniać charge snapshotu; dokładny oracle czystego SHE ustawia wyłącznie $P=0$ |
| `reverse_normal` | bez zmiany | oriented flux zmienia znak | fizyczny torque bez zmiany | bez zmiany | bez zmiany | tylko spójna zamiana HM↔FM, $n\to-n$ i $\Delta\to-\Delta$; sam flip normalnej fail-closed |
| `reverse_transverse_axis` | bez zmiany | składowe z indeksem $y$ zmieniają znak prezentacji | fizyczny torque bez zmiany | $(v_x,-v_y)$ | $-\Theta_H$ w gałęzi głównej | jest to zmiana osi raportowania, nie lewoskrętny frame solvera |

#### 2.9.3 Znormalizowany deskryptor geometrii, BC, masek i etapów

Normatywny JSON zamraża jedną reprezentację bez domyślnych pól. Siatka ma
dokładnie `counts=[256,64,4]`, `cell_size_m=[2e-9,2e-9,1e-9]`, początek
`[0,0,0]` i porządek `x_fastest_then_y_then_z`. HM zajmuje półotwarty zakres
komórek $[0,256)\times[0,64)\times[0,3)$, czyli
$0\le z<3\,\mathrm{nm}$. FM zajmuje
$[0,256)\times[0,64)\times[3,4)$, czyli
$3\,\mathrm{nm}\le z<4\,\mathrm{nm}$. Wspólna płaszczyzna interfejsu ma
$z=3\,\mathrm{nm}$.

Charge BC ma gauge `zero_mean` i pokrywa każdą zewnętrzną powierzchnię
dokładnie raz. Terminal `terminal_x_minus` zawiera `hm:x-` i `fm:x-`, obie z
orientacją $(-1,0,0)$, a jego outward density wynosi $-J_x$. Terminal
`terminal_x_plus` zawiera `hm:x+` i `fm:x+`, obie z orientacją $(1,0,0)$, a
jego outward density wynosi $+J_x$. `insulating_outer` obejmuje dokładnie
`hm:y-`, `hm:y+`, `hm:z-`, `fm:y-`, `fm:y+` i `fm:z+` z odpowiadającymi
zewnętrznymi orientacjami. Spin BC `spin_insulating_outer` obejmuje wszystkie
dziesięć zewnętrznych powierzchni HM i FM, łącznie z czterema powierzchniami
terminali charge.

Interfejs `hm_fm` ma `kind=mixing_conductance`, `normal_side=hm`,
`ferromagnet_side=fm`, `normal_to_ferromagnet=[0,0,1]`, stronę HM `hm:z+` o
orientacji $+z$ i stronę FM `fm:z-` o orientacji $-z$. Sam wektor normalny bez
tej pary stron i powierzchni nie jest kompletnym deskryptorem.

Publiczny `MixingConductanceSpinInterface` zapisuje tę parę jako wymagane dla
`native_m1_v1` pola `normal_surface` i `ferromagnet_surface`. Obie wartości są
`SurfaceRef`, muszą występować razem, należeć odpowiednio do obiektów
`normal_side` i `ferromagnet_side`, wskazywać przeciwne strony tej samej osi
oraz mieć orientacje zgodne z `normal_to_ferromagnet` i
`-normal_to_ferromagnet`. Starszy zapis bez powierzchni pozostaje czytelny dla
innych, historycznych modeli, ale planner `native_m1_v1` odrzuca go przed
materializacją deskryptora; nie rekonstruuje powierzchni wyłącznie z masek.

Trzy maski używają tego samego kształtu i porządku komórek:

| Maska | Aktywny zakres $z$ | Liczba aktywnych komórek | Własność |
|---|---:|---:|---|
| `transport_active` | $[0,4)$ | `65536` | HM i FM |
| `magnetic_active` | $[3,4)$ | `16384` | tylko FM |
| `torque_target` | $[3,4)$ | `16384` | tylko FM |

Obowiązuje `torque_target subset magnetic_active subset transport_active`.
Deskryptor `cell_bounds` wraz z `shape` i `cell_order` wyznacza każdy bit maski;
runtime nie może rekonstruować maski z $M_s$, z amplitudy prądu ani z samej
obecności materiału.

Kanoniczny stan początkowy nie jest jednorodnym $m$. Publiczny konstruktor
`fm.texture.neel_skyrmion` zapisuje `preset_texture` w
`magnets[0].initial_magnetization`, z mapowaniem `world`, płaszczyzną `xy`,
centrum `[256e-9,64e-9,3.5e-9]`, `R=30e-9`, `Delta=5e-9`,
`chirality=+1`, Néel `helicity=0` i serializowanym
`core_polarity=+1`. Dla $\rho$ liczonego od tego centrum repozytoryjny profil
jest dokładnie

```{math}
:label: racetrack-neel-seed
\rho=\sqrt{(x-x_c)^2+(y-y_c)^2},\qquad
\phi=\operatorname{atan2}(y-y_c,x-x_c),\qquad
\theta(\rho)=2\operatorname{atan}\!\left[\exp\!\left(\frac{R-\rho}{\Delta}\right)\right],
\qquad
\chi=\phi,
\qquad
\mathbf m_{\mathrm{raw}}=
(\sin\theta\cos\chi,\sin\theta\sin\chi,p\cos\theta),\quad p=+1,
\qquad
\mathbf m=\frac{\mathbf m_{\mathrm{raw}}}{\lVert\mathbf m_{\mathrm{raw}}\rVert_2}.
```

Zatem ściana przy $\rho=R$ jest radialnie skierowana na zewnątrz,
`core m_z<0`, a `background m_z->+1`. Normalizacja jest wykonywana osobno dla
każdej próbki; tylko hipotetyczna zerowa norma używa deterministycznego
fallbacku `[0,0,1]`. Seed jest wejściem do relaksacji, nie dowodem stabilności
ani kwalifikacji skyrmionu.

Etap `relax_zero_current` zachowuje moduł transportu, ustawia $J_x=0$, wyłącza
transportowy torque i publikuje checkpoint `relaxed_zero_current`. Etap
`drive_solved_current` wykonuje sześć niezależnych przebiegów w porządku
$(-1.5,-1.0,-0.5,+0.5,+1.0,+1.5)\times10^{12}\,\mathrm{A\,m^{-2}}$.
Każdy przebieg zaczyna się od tego samego checkpointu, trwa $2\,\mathrm{ns}$,
używa stałego kroku $0.1\,\mathrm{ps}$, zapisuje próbkę co $5\,\mathrm{ps}$ i
aktualizuje transport przy każdej ewaluacji RHS LLG. Dla każdego $J_x$ JSON
zapisuje obie konkretne outward densities, więc znak terminali nie jest
wyprowadzany później z nazwy powierzchni.

Spin solver fixture jest jawnie i dokładnie `native_m1_v1`. Wartości `auto`,
`gmres` i każdy fallback są zabronione. Pełny zamrożony zakres zabroniony to
CPU, FP32, prescribed torque, prescribed current density, Oersted, iSHE, M2,
M3, MTJ, PBC, thermal noise, multi-GPU oraz `adaptive_geometry`. Ostatni zakaz
oznacza, że geometria, siatka, maski i indeksowanie komórek pozostają identyczne
we wszystkich przebiegach.

`normalized_problem_ir_contract.expected_lowering` jest kompletną, typowaną
projekcją bieżącego `ProblemIR`, zbudowaną przez publiczne konstruktory
`Box`, `Translate`, `Material`, `Ferromagnet` i `Problem`. Zawiera rzeczywiste
tablice `geometry.entries` i `materials`, pełny `CurrentTransport`, steady
`SpinDriftDiffusion`, `DriftDiffusionSpinTorque`, energy terms `Exchange`,
`Demag` i `InterfacialDMI(D=3e-3, interface_normal=(0,0,1))`, jeden bazowy
`TimeEvolution`, `BackendPolicyIR` oraz `ValidationProfileIR`. Test Python
porównuje całą projekcję z publicznym loweringiem i dereferencjonuje każdą
ścieżkę parametru. Test Rust deserializuje cały `ProblemIR`, osobno parsuje
`ValidationProfileIR` i sprawdza selection w jego rzeczywistym położeniu
`problem_meta.runtime_metadata.runtime_selection`. Kolejność BC jest
normatywna: terminale mają indeksy `0` i `1`, a zewnętrzny
charge-insulating boundary indeks `2`.

Publiczny `study_pipeline.v1` rozróżnia prescribed-current i solved-current.
Istniejące `set_current(direction,current_density)` dotyczy wyłącznie
`ProblemIR.current_density` i nie może mutować transportu elektrodowego. Akcja
`set_transport_current(module_id, terminal_outward_current_density_Apm2)`
wybiera dokładnie jeden `CurrentTransport`, wymaga niepustej mapy
`boundary_id -> A/m^2`, pozwala zmieniać wyłącznie istniejące
`normal_current_electrode` oraz odrzuca brakujące, nadmiarowe i niefinitywne
wartości. Python i materializator pipeline sprawdzają dokładne pokrycie
identyfikatorów elektrod; planner po rozwiązaniu geometrii sprawdza bilans
powierzchniowy $\sum_k J_{n,k}A_k=0$. Nie wolno zastępować tego warunku sumą
samych gęstości, ponieważ powierzchnie terminali mogą mieć różne pola. Mutacja
jest kontekstowa: dotyczy wszystkich następnych węzłów pipeline i jest
zachowana w provenance dokumentu.

Akcja `load_state(artifact_name=..., dataset="m")` jest jawną granicą
restartu. Dla racetracku występuje przed każdym z sześciu runów i wskazuje
`relaxed_zero_current`; runtime nie może zastąpić jej kontynuacją z poprzedniego
drive. Kolejność `set_transport_current -> load_state -> run` jest normatywna,
a każda materializacja runu musi zawierać konkretne istniejące cele
`current_modules[0].boundaries[0|1].outward_current_density_Apm2`. Nie istnieje
syntetyczny cel `boundaries[current_sweep]`.

Stage-local `set_spin_torque_enabled(module_id, enabled)` zmienia wyłącznie
stan istniejącego modułu `spin_torque` w `physics_graph.v1` oraz status jego
wchodzącej krawędzi. Nie usuwa payloadu torque, spin transportu ani źródła
ładunkowego. `enabled=False` mapuje się na `activation="inactive"`, a
`enabled=True` na `activation="active"`; inne stany graphu nie są publiczną
mutacją workflow. Wyłączenie torque przy zachowaniu magnetycznych sinków jest
dozwolone tylko wtedy, gdy wszystkie terminale `normal_current_electrode`
sprzężonego solve mają dokładnie `0 A/m^2`. Dla niezerowego napędu brak
aktywnego `DriftDiffusionSpinTorque` nadal jest błędem fail-closed. Dzięki temu
`relax_zero_current` zachowuje pełny, audytowalny graf transportu, ale nie
wiąże torque do RHS LLG i nie otwiera ogólnej ścieżki utraty momentu pędu przy
przepływie prądu.

Normatywna sekwencja workloadu to:
`set_transport_current(J_n=0) -> set_spin_torque_enabled(False) -> relax ->
save_state("relaxed_zero_current") -> set_spin_torque_enabled(True)`, a każdy
drive wykonuje następnie
`set_transport_current -> load_state("relaxed_zero_current") -> run`.

Sama obecność tych dwóch akcji nie kwalifikuje jeszcze workloadu. Osobna
stage-local activation musi dowieść, że `relax_zero_current` zachowuje moduł
transportu, ale nie wiąże transportowego torque do RHS; dopóki ta bramka oraz
pełne wykonanie sześciu restartów nie przejdą, `public_lowering_boundary`
pozostaje otwarte i tuple `fdm/gpu/double/strict` pozostaje niezakwalifikowane.

#### 2.9.4 Pełna tabela liczb fixture

Każdy wiersz ma status `numerical_validation_fixture`; pole `ProblemIR` jest
ścieżką semantyczną zweryfikowaną względem obecnych konstruktorów Python,
struktur `ProblemIR` i ich nazw serializowanych. Motywacja `paper-scale` nie
oznacza przypisania zestawu jednemu materiałowi.

| id | symbol | si_unit | value | validity | problem_ir_path | motivation |
|---|---|---|---:|---|---|---|
| `track.length` | $L_x$ | $\mathrm m$ | `512e-9` | 256 cells; FM must equal HM | `geometry.entries[1].base.size[0]` | Sampaio scale + bounded grid |
| `track.width` | $L_y$ | $\mathrm m$ | `128e-9` | 64 cells; FM must equal HM | `geometry.entries[1].base.size[1]` | Sampaio scale + edge margin |
| `hm.thickness` | $t_{HM}$ | $\mathrm m$ | `3e-9` | 3 z cells | `geometry.entries[1].base.size[2]` | diffusive HM benchmark |
| `fm.thickness` | $t_{FM}$ | $\mathrm m$ | `1e-9` | 1 z cell | `geometry.entries[0].base.size[2]` | ultrathin DMI benchmark |
| `cell.x` | $h_x$ | $\mathrm m$ | `2e-9` | exact divisor of $L_x$ | `backend_policy.discretization_hints.fdm.cell[0]` | bounded in-plane resolution |
| `cell.y` | $h_y$ | $\mathrm m$ | `2e-9` | exact divisor of $L_y$ | `backend_policy.discretization_hints.fdm.cell[1]` | bounded in-plane resolution |
| `cell.z` | $h_z$ | $\mathrm m$ | `1e-9` | exact 3+1 layer ownership | `backend_policy.discretization_hints.fdm.cell[2]` | interface ownership |
| `fm.Ms` | $M_s$ | $\mathrm{A\,m^{-1}}$ | `580e3` | finite, $>0$ in FM | `materials[0].saturation_magnetisation` | Sampaio paper-scale |
| `fm.A` | $A$ | $\mathrm{J\,m^{-1}}$ | `15e-12` | finite, $>0$ | `materials[0].exchange_stiffness` | Sampaio paper-scale |
| `fm.alpha` | $\alpha$ | $1$ | `0.3` | finite, $\ge0$ | `materials[0].damping` | deterministic relaxation scale |
| `fm.Ku` | $K_u$ | $\mathrm{J\,m^{-3}}$ | `0.8e6` | finite, axis $+z$ | `materials[0].uniaxial_anisotropy` | Sampaio paper-scale |
| `fm.D` | $D$ | $\mathrm{J\,m^{-2}}$ | `3e-3` | finite, Fullmag DMI sign, interface normal $+z$ | `energy_terms[2].D` | Sampaio paper-scale |
| `hm.sigma_charge` | $\sigma_{HM}$ | $\mathrm{S\,m^{-1}}$ | `5e6` | finite, $>0$ | `current_modules[0].materials[0].material.sigma_Spm` | metallic benchmark |
| `hm.sigma_spin` | $\sigma_{s,HM}$ | $\mathrm{S\,m^{-1}}$ | `5e6` | finite, $>0$ | `spin_transport_modules[0].materials[0].material.sigma_s_Spm` | unpolarized HM benchmark |
| `hm.theta_SH` | $\theta_{SH,HM}$ | $1$ | `0.2` | finite, signed | `spin_transport_modules[0].materials[0].material.theta_sh` | sign-sensitive SHE benchmark |
| `hm.lambda_sf` | $\lambda_{sf,HM}$ | $\mathrm m$ | `1.5e-9` | finite, $>0$ | `spin_transport_modules[0].materials[0].material.lambda_sf_m` | short metallic scale |
| `fm.sigma_charge` | $\sigma_{FM}$ | $\mathrm{S\,m^{-1}}$ | `1e6` | finite, $>0$ | `current_modules[0].materials[1].material.sigma_Spm` | HM/FM contrast benchmark |
| `fm.sigma_spin` | $\sigma_{s,FM}$ | $\mathrm{S\,m^{-1}}$ | `1e6` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.sigma_s_Spm` | FM transport benchmark |
| `fm.P` | $P_{FM}$ | $1$ | `0.4` | finite in $[-1,1]$ | `spin_transport_modules[0].materials[1].material.polarization_p` | moderate polarization |
| `fm.lambda_sf` | $\lambda_{sf,FM}$ | $\mathrm m$ | `5e-9` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.lambda_sf_m` | longitudinal reaction coverage |
| `fm.lambda_J` | $\lambda_{J,FM}$ | $\mathrm m$ | `1e-9` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.lambda_j_m` | transverse exchange coverage |
| `fm.lambda_phi` | $\lambda_{\phi,FM}$ | $\mathrm m$ | `1e-9` | finite, $>0$ | `spin_transport_modules[0].materials[1].material.lambda_phi_m` | dephasing coverage |
| `interface.G_up` | $G_\uparrow$ | $\mathrm{S\,m^{-2}}$ | `2.5e14` | finite, $\ge0$ | `spin_transport_modules[0].interfaces[0].g_up_Spm2` | symmetric longitudinal branch |
| `interface.G_down` | $G_\downarrow$ | $\mathrm{S\,m^{-2}}$ | `2.5e14` | finite, $\ge0$ | `spin_transport_modules[0].interfaces[0].g_down_Spm2` | symmetric longitudinal branch |
| `interface.G_r` | $G_r$ | $\mathrm{S\,m^{-2}}$ | `5e14` | finite, $\ge0$ | `spin_transport_modules[0].interfaces[0].g_r_Spm2` | damping-like branch coverage |
| `interface.G_i` | $G_i$ | $\mathrm{S\,m^{-2}}$ | `5e13` | finite, signed | `spin_transport_modules[0].interfaces[0].g_i_Spm2` | field-like branch coverage |
| `interface.normal_surface` | $\Gamma_N$ | $1$ | `hm:z+`, orientation `+z` | required by `native_m1_v1`; object must match `normal_side`; orientation must equal $\mathbf n$ | `spin_transport_modules[0].interfaces[0].normal_surface` | explicit HM trace ownership |
| `interface.ferromagnet_surface` | $\Gamma_F$ | $1$ | `fm:z-`, orientation `-z` | required by `native_m1_v1`; object must match `ferromagnet_side`; orientation must equal $-\mathbf n$ | `spin_transport_modules[0].interfaces[0].ferromagnet_surface` | explicit FM trace ownership |
| `drive.J_minus_1_5` | $J_x^{(-1.5)}$ | $\mathrm{A\,m^{-2}}$ | `-1.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep; paired x-minus override is explicit in `current_schedule` |
| `drive.J_minus_1_0` | $J_x^{(-1.0)}$ | $\mathrm{A\,m^{-2}}$ | `-1.0e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_minus_0_5` | $J_x^{(-0.5)}$ | $\mathrm{A\,m^{-2}}$ | `-0.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_plus_0_5` | $J_x^{(+0.5)}$ | $\mathrm{A\,m^{-2}}$ | `0.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_plus_1_0` | $J_x^{(+1.0)}$ | $\mathrm{A\,m^{-2}}$ | `1.0e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |
| `drive.J_plus_1_5` | $J_x^{(+1.5)}$ | $\mathrm{A\,m^{-2}}$ | `1.5e12` | balanced signed terminals | `current_modules[0].boundaries[1].outward_current_density_Apm2` | symmetric sweep |

#### 2.9.5 Kryteria kwalifikacji fixture

Task 1 zamraża wyłącznie kontrakt. `she_1d_film_v1` musi później przejść
analityczny profil, residual, zbieżność i odwrócenia znaków. Racetrack wymaga
trzech siatek relaksacji, stabilnego podpisanego $Q$, dodatnich i ujemnych
prądów, co najmniej trzech amplitud, bilansu charge/spin/torque, atomowego
rollback/restart, CPU↔CUDA FP64 parity, zarządzanej tożsamości GPU oraz
algorytmu `skyrmion_hall_angle_v1` z niepewnością i reason codes. Do czasu
świeżego manifestu Task 12 exact tuple pozostaje niezakwalifikowany; obecność
źródła, fixture, testu dokumentacji lub natywnego kernela nie promuje statusu.

(discrete-realization)=
## 3. Numerical interpretation

### 3.1 FDM finite-volume contract

`V`, `mu_s`, `m`, and materials are cell-centred. `J_c` and normal `Q` are
single oriented face fluxes. For cell `K`,

```text
sum_f A_f J_c,f dot n_Kf = 0,
C_s V_K d(mu_s,K)/dt+sum_f A_f Q_f dot n_Kf
  = -V_K(R_sf+R_J+R_phi)_K.
```

For orthogonal M1 faces `K|L`,

```text
sigma_f = 2 sigma_K sigma_L/(sigma_K+sigma_L),
J_c,f dot n_Kf = -sigma_f(V_L-V_K)/d_KL,
Q_diff,f,a dot n_Kf = -0.5 sigma_s,f
  (mu_s,L,a-mu_s,K,a)/d_KL.
```

For an oriented finite-conductance charge interface `N -> F`, the FDM M1
operator `fv_charge_mixing_series_trace.v1` eliminates the two interface
traces through the series resistance

```text
R_f = d_N/(2 sigma_N) + 1/(G_up+G_down) + d_F/(2 sigma_F),
j_c,n = (V_N-V_F)/R_f,
V_N,Gamma = V_N-j_c,n d_N/(2 sigma_N),
V_F,Gamma = V_F+j_c,n d_F/(2 sigma_F).
```

When `G_up=G_down=0`, the series-resistance expression is not evaluated:
`j_c,n=0`, `V_N,Gamma=V_N`, and `V_F,Gamma=V_F`. This charge-insulating face
does not connect the two charge components. It still publishes the oriented
descriptor, two accepted traces, and the zero charge-flux observation required
by the spin owner; nonzero `G_r/G_i` may therefore realize transverse-only
mixing.

The stored globally oriented face current is `j_c,n` or `-j_c,n` according to
whether `N -> F` agrees with the positive coordinate direction. The two cell
balances consume that one value with opposite signs. Gauge, BC, component
balance, and local charge residual checks use the same operator. A successful
charge solve alone constructs the immutable accepted snapshot containing the
grid, immutable charge-active mask, material identity, face-current arrays,
interface descriptors, traces,
and observations; the spin owner validates and consumes that snapshot rather
than accepting forgeable parallel arrays.

Inside one material, `fv_spin_upwind_v1` uses

```text
q_f,a = Q_diff,f,a
 +P_f sigma_f(E_f dot n_f)m_f,a
 +theta_SH,f sigma_f n_i epsilon_ika E_f,k.
```

`m_f` is upwind with the signed polarized flux; central averaging exists only
as `fv_spin_central_reference_v1`. `structured_cross_gradient_v1` obtains the
normal electric field from the two-cell difference and tangential components
from averaged central cell gradients (9-point in 2-D, 27-point in 3-D), with
BC-consistent one-sided reconstruction. Direct SHE and polarized contributions
are summed before one face flux is inserted with opposite cell signs.
Material interfaces use the explicit interface law, never arithmetic averaging.

The bounded native FDM CPU M1 owner instead uses the separately named
`fdm_exact_face_current_electric_reconstruction.v1`. It reconstructs the
electric field exclusively from the accepted conservative face current:

```text
E_K,k^J = (J_c,k,- + J_c,k,+)/(2 sigma_K),
E_f,i^J = J_c,f/sigma_f,
E_f,k!=i^J = 0.5(E_K,k^J+E_L,k^J).
```

At an external face the sole adjacent cell supplies tangential components.
The normal component is the exact oriented `J_c,f/sigma`; direct SHE is then
`theta_SH,f sigma_f n_i epsilon_ika E_f,k^J`. This operator does not read
cell-centred `V` when no mixing interface is present. It is therefore invariant
under changes to otherwise unused `V`, including heterogeneous `sigma`, and
MUST NOT publish `structured_cross_gradient_v1` provenance.

For the CPU-double structured oracle, `SpecifiedSpinFlux` is always the
outward-normal quantity `n_i Q_ia`; storage in the globally positive face
orientation therefore negates it on minimum-coordinate faces. The operator
identifier is explicit: `fv_spin_upwind_v1` selects `m_f` from the upstream
cell using the signed polarized face flux, while
`fv_spin_central_reference_v1` uses the central magnetization only as a
convergence oracle. Cross-region faces fail closed without one oriented
transparent or mixing-conductance descriptor. Mixing records longitudinal
injection/backflow, transverse absorption, and spin-memory loss separately;
only transverse absorption contributes to magnetic torque. Internal contacts
are likewise oriented structured faces with independent outward BCs on their
selected sides.

CPU double engines are matrix-free CG/AMG for symmetric M1 charge and block
GMRES for spin; M2 uses block GMRES because Hall/iSHE make the system
nonsymmetric. Residual and charge/spin balance are independently recomputed.
CUDA engines keep operators and state resident; FP64 parity and transfer audit
precede separate FP32 high-contrast/thin-layer qualification.

The bounded owner implemented by
`fdm_spin_block_gmres_matrix_free_reference_v1` is an unpreconditioned,
restarted, matrix-free FP64 reference engine. It is not the production
`fdm_spin_block_gmres_csr_v1` engine and makes no AMG/ILU or scaling claim.
`fdm_transport_torque_cell_surface_balance.v1` maps independently recomputed
volumetric `R_J+R_phi` and surface transverse absorption to the authored
magnetic target using `-gamma_e hbar/(2eM_s)`.

The accepted local FV residual gate is component-wise and dimensionally
explicit. For cell `K`, let `r_K,a [A/m^3]` be the independently recomputed
flux divergence plus reaction and let

```text
s_K = sum_f A_f ||Q_f||_2/|K|
    + ||R_sf,K||_2 + ||R_J,K||_2 + ||R_phi,K||_2 + S_Gamma,K  [A/m^3],
t_K = local_abs_tol_Apm3 + local_rel_tol s_K.       [A/m^3]
```

Here `S_Gamma,K` is zero except on the positive cell of an oriented mixing
interface, where it is the norm of the difference between its two one-sided
spin fluxes divided by the face-normal cell spacing. This is the same explicit
interface correction used in the recomputed local residual.

Every cell must satisfy `max_a |r_K,a|<=t_K`; global closure and integrated L2
remain additional gates and cannot hide equal-and-opposite local defects.

For the FDM M2 block, GMRES stopping is defined in the block-preconditioned
dimensionless norm. If `b_p = P b`, the relative stopping scale is
`max(abs_tol, rel_tol ||b_p||_2)` for a nonzero right-hand side; a zero
right-hand side uses `abs_tol` directly. There is no arbitrary `max(||b_p||,1)`
floor. Such a floor changes a relative tolerance into an unrelated absolute
residual for thin, highly anisotropic cells (for example, a `100 nm x 100 nm x
1 nm` stack), and can reject a physically converged N/F solve. The independently
recomputed integrated electrode and angular-momentum balance gates remain
mandatory after the linear solve.

`gmres_restart` is the initial Krylov basis length, not a hard promise that a
short basis will remain stable on every mesh. If a completed restart cycle still
has a residual above `100 * max(abs_tol, rel_tol ||b_p||_2)`, the FDM reference
solver doubles the basis up to the remaining iteration budget. This bounded
adaptive restart preserves the low-memory policy for easy cases while avoiding
false non-convergence of long-wavelength modes on refined, thin N/F stacks.
Boundary flux evaluation reuses the cell gradients assembled for the operator;
it must not recompute a full-grid gradient field once per boundary face.

The FDM CPU reference lane uses a multiplicative block-line preconditioner on
grids with at least two nontrivial axes. Each line factors a four-variable
block-tridiagonal approximation (charge plus three spin-potential components)
with diffusion, reaction, interface, and boundary diagonal terms. Consecutive
line sweeps apply a residual correction; they do not replace the physical
operator and deliberately omit tangential SHE skew terms and `G_i` from the
approximation. One-dimensional grids retain the block-Jacobi fallback. A
neutral paired-voltage cold start is used only when the mesh has at least two
nontrivial axes; otherwise the zero state remains the safe fallback. The source
map is `coupled_charge_spin.rs::initial_state_guess`,
`coupled_charge_spin.rs::line_preconditioners`, and
`coupled_block_linear.rs::BlockLinePreconditioner`.

(fdm-gpu-m1-fp64-contract)=
### 3.1.1 FDM GPU/FP64 M1 realization contract (PR-15; partial native implementation)

This section freezes the first native CUDA milestone for one-way M1 charge,
steady spin/direct-SHE, interface mixing, and transport torque. It is a
realization contract for the common equations above, not a second physical
model. CPU and GPU use the same signs, SI units, formula and operator IDs,
face orientation, interface observations, and balance identities. They do not
share mutable solver state or implementation workspaces.

Ogólny agregat pozostaje `semantic_only`, ponieważ poza bounded
`CurrentTransport` charge-only nie ma jeszcze publicznej ścieżki dla tego ABI.
Agregat FDM GPU M1 ma `implementation_state=partial`: oprócz ograniczonego
charge-only FP64 slice istnieje natywny solver steady spin/direct-SHE,
mixing i torque oraz niekwalifikowane etapowe sprzężenie torque z FP64
Heun/RK4. Implementacja Task 6 obejmuje także etapowe oceny RK23 i DP45,
łącznie z końcowym solve dla zaakceptowanego `m` oraz transakcyjnym resetem
trial, sparse cache, czasu etapów i monotonicznej tożsamości przy wewnętrznym
adaptive retry. Task 6 obejmuje ponadto trzy transportowe oceny podczas
warmupu ABM3, dwie oceny pełnego kroku predictor-corrector i zapis pochodnej
dla skorygowanego zaakceptowanego końca zamiast pochodnej predyktora. Te
integratory pozostają poza claimem do zamknięcia restartu FSAL/historii ABM i
checkpointu. Wyłączny claim wiąże jeden
kontekst LLG z jednym accepted charge
snapshotem. Rozwiązania spinowe etapów są stanem trial; dopiero przyjęcie
całego kroku LLG promuje trial policzony dla końcowego zaakceptowanego `m` do
`spin_accepted`; wybór poziomu statystyk nie uruchamia dodatkowego solve i nie
zmienia stanu naukowego. Awaria późnego etapu przywraca bitowo `m`, czas i
liczniki accepted oraz usuwa trial i mutowalny sparse cache. `t_stage` jest
sprawdzany pod kątem skończoności i niemalejącej kolejności, lecz ten ograniczony
slice używa jednego niemutowalnego accepted charge snapshotu przez wszystkie
kroki danego wiązania.
Realizuje więc tylko stałe w czasie $J_c$; wymuszenie $J_c(t)$ z ogólnego
kontraktu sekcji 2.6 pozostaje niewykonywalne i nie może być deklarowane jako
obsługiwane. Stan
walidacji pozostaje `validation_state=unvalidated`, z
`validated_workloads=[]`. Managed lifecycle gate po zmianach
final-state/statistics/rollback i stream-local pin/drain przechodzi testy
Heun/RK4 oraz wstępny kontrakt etapów i późnego rollbacku RK23/DP45, błędy
launch/event-record/event-sync, teardown rejection podczas
in-flight, C11/Rust ABI oraz dwa przebiegi `compute-sanitizer` bez błędów. Jest
to dowód testów kontraktowych, a nie promocja capability ani kwalifikacja
produkcyjna; globalna serializacja registry i pełna ścieżka publicznego
ProblemIR/plannera/runnera pozostają otwarte.

#### Stan ograniczonej implementacji M1 charge z 2026-08-11

Właściciel `backends/fdm/gpu/cuda/transport/charge/**` realizuje rzeczywisty
FP64 charge solve na urządzeniu: konserwatywny operator FV z harmoniczną
przewodnością ścian, device CG, fixed-tree redukcje oraz dwupoziomowy device AMG.
Agregaty AMG są geometrycznymi blokami `2 x 2 x 2` kanonicznej ortogonalnej
siatki FDM, z deterministycznym przypisaniem i jawnym coarse operatorem
$A_c=P^TAP$. Ten wybór wykorzystuje regularną topologię tej realizacji,
zapewnia co najwyżej osiem fine cells na agregat i stabilną tożsamość cache;
nie jest adaptacyjnym strength-graph AMG. Puste agregaty wynikające z legalnej
maski nieaktywnej mają zerową korektę coarse i nie wykonują dzielenia przez
zero. Skuteczność tej dwupoziomowej preconditioner realization musi być
kwalifikowana osobno dla skoków materiałowych, finite-$G$, nieparzystych
wymiarów, masek nieaktywnych i rozłącznych komponentów; sama liczba coarse DOF
nie dowodzi poprawności $P^TAP$ ani skalowalności solve.
Typed cell/material/face/formula payloads są walidowane fail-closed przed
publikacją. Voltage, exact-density i insulating external faces mają jeden
globalnie zorientowany prąd ścianowy, a odrzucony descriptor lub solve nie
publikuje accepted state. Snapshot posiada własne bufory device dla $V$ i
$J_x/J_y/J_z$; artefakty oraz checkpoint wymagają jawnej cadence.

```{math}
:label: fdm-gpu-m1-charge-fv
\begin{aligned}
g_{KL}&=\frac{|f|}{d_K/\sigma_K+d_L/\sigma_L},
&g_{Kf}^{V}&=\frac{2\sigma_K|f|}{h_f},\\
(A V)_K&=\sum_{L\sim K}g_{KL}(V_K-V_L)
 +\sum_{f\subset\Gamma_V\cap\partial K}g_{Kf}^{V}V_K,
&b_K&=\sum_{f\subset\Gamma_V\cap\partial K}g_{Kf}^{V}V_f
 -\sum_{f\subset\Gamma_J\cap\partial K}|f|J_{n,f}.
\end{aligned}
```

Tutaj $J_{n,f}$ jest prądem zadanym dodatnio na zewnątrz komórki. Ściana
insulating nie wnosi składnika do $A$ ani $b$, a komórki nieaktywne nie tworzą
połączeń przewodzących. To równanie opisuje wyłącznie ograniczony slice charge;
nie obejmuje strumienia spinowego $Q$, SHE, mixing ani torque.

#### Zero-mean gauge dla swobodnych komponentów Neumanna

Dla komponentu przewodzącego bez żadnej ściany voltage operator jest
semidefinitny i jego jądrem jest stała na tym komponencie. Solver nie może
wybrać stałej przez przypadkowy pivot ani przez niejawny fallback CPU. Wymagana
jest najpierw zgodność Neumanna

```{math}
:label: fdm-gpu-m1-neumann-compatibility
\sum_{K\in C} b_K = 0,
\qquad
\bar V_C = \frac{1}{|C|}\sum_{K\in C} V_K = 0
\quad\text{dla każdego komponentu bez voltage datum}.
```

W implementacji `label_reference_components_kernel` buduje graf wyłącznie z
dodatnich przewodności ścian wewnętrznych, oznacza komponenty zakotwiczone
przez voltage BC i sprawdza `|sum b| <= 64 eps ||b||_1` dla każdego wolnego
komponentu. Niespełnienie zgodności kończy solve statusem
`FULLMAG_FDM_GPU_TRANSPORT_ERROR_BALANCE_FAILURE`. Dla polityki
`ZERO_MEAN_PER_FREE_COMPONENT` device PCG stosuje ortogonalną projekcję na
podprzestrzeń zerowej średniej po inicjalizacji $V$, prawej stronie, residuale,
preconditionerze, kierunku $p$ i iloczynie $Ap$. Dzięki temu rozwiązywany jest
układ $PAP\,V=Pb$ bez sztucznego usuwania jednego węzła; komponenty z voltage
datum zachowują ich wartość referencyjną. `BOUNDARY_REFERENCE_PER_COMPONENT`
pozostaje osobną polityką i odrzuca wolny komponent.

To jest obecnie bounded, device-side realization: identyfikacja grafu i
projekcja są deterministyczne, lecz celowo serializowane w jednym bloku CUDA.
Nie jest to jeszcze dowód skalowalności dla dużych rozłącznych domen ani
kwalifikacja publicznego runnera. Test uniform zawiera trzy nowe kontrakty:
niezerowy, zbilansowany pure-Neumann solve z odczytem średniej $V$,
niezbilansowany strumień, który musi zakończyć się `BALANCE_FAILURE`, oraz
typed mixed anchored/free fixture z wewnętrznym charge-insulating interfejsem,
który sprawdza niezależną średnią komponentu swobodnego i zachowanie datum
komponentu zakotwiczonego.

Zarządzana bramka
`just verify-fdm-gpu-m1-charge-native-contract` zakończyła się kodem 0 na GPU
o UUID `fcb9fbf1828437c7af5b76bcbf2d2937`, dla build digest
`700e798c56bdde3029759e3460a39762e325d5108401e5907819a7b064a9ca3d`.
`charge_uniform_v1` użył 45 iteracji, osiągnął residual algebraiczny
$4.696365845897086\times10^{-15}$, residual fizyczny i bilans komponentu
$2.911545681350832\times10^{-16}$ oraz bilans elektrod
$1.7294921875001357\times10^{-13}$. Hierarchia miała poziomy $512\to64$,
jeden build, jedno trafienie cache i 90 zastosowań AMG. `charge_layered_v1`
osiągnął residual algebraiczny $5.931538386041357\times10^{-15}$, residual
fizyczny $2.2775813048401056\times10^{-16}$ i względny skok strumienia na
interfejsie $2.08984375\times10^{-14}$. Oba workloady oraz snapshot/mutation
gate raportują `host_fallback_count=0`.

Checkpoint ma dwa rozłączne tory dowodowe. **Tor A** jest syntetycznym,
zamrożonym oraclem kodeka: ma 4352 bajty, sequence 7, payload SHA-256
`ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5`
i embedded file hash
`bc3bcc1b51314fe46e0bbd2f71e94f1517f8e438943853e33b8e79b1495c7b60`.
Validator musi go zaakceptować, lecz jego syntetyczna tożsamość device/build/
static descriptor musi zostać odrzucona przez rzeczywisty exact-identity import
jako `checkpoint_incompatible`. **Tor B** eksportuje 4352-bajtowy sequence-7
checkpoint z aktualnego runtime; jego identity-dependent SHA-256 w powyższym
buildzie wyniosło
`d2b25960eb31376b1b2fe6aa8ba07944ba69a695125a381a398da46f891123f9`.
Świeży kontekst o tej samej tożsamości importuje go bez ponownego solve, a
odczytane $V$ i $J_c$ są bitowo równe stanowi przed eksportem. SHA toru B nie
jest stałym oraclem między buildami i nie może być utożsamiane z SHA toru A.

Powyższe liczby opisują wcześniejszy run bazowy; jego otwarte granice były
blokujące dla szerszego M1: implementacja swobodnego, zgodnego Neumannowskiego
komponentu z narzuconą zerową średnią nie miała wtedy managed device proof.
Zaimportowany iterate jest
odtwarzany jako accepted snapshot, ale następny solve nie konsumuje jeszcze
tego stanu jako persistent Krylov warm start. Nie ma publicznego runnera,
ProblemIR stage ani stabilnych artefaktów/proweniencji tego slice'u. Nie ma też
publicznego dispatchu spin, FP32, periodic, multi-device, konwergencji siatkowej
ani kwalifikacji wydajnościowej. W historycznym runie wiersze
`component_gauge_v1`, `determinism_restart_v1`, `public_path_v1`, spin/SHE/mixing/torque,
`convergence_v1` i `performance_v1` pozostają niezamknięte.

### Aktualizacja managed zero-mean (2026-08-11)

Ponowna bramka
`just verify-fdm-gpu-m1-charge-native-contract` zakończyła się kodem 0 po
przebudowie w tym samym managed container-backed runtime. Urządzenie to NVIDIA
GeForce RTX 4080 SUPER, UUID `fcb9fbf1828437c7af5b76bcbf2d2937`, CC 8.9,
CUDA runtime `12040`, driver `13010`, build digest
`d396670cc86f5b79b208d812b7a1aca52a73ead18ab48b6c00141dd3c558c96a`.

Wraz z dotychczasowymi uniform/layered/snapshot/mutation/strict-residency
workloadami uruchomiono trzy kontrakty gauge w tym samym executable:

- pure Neumann, zbilansowany: `zero_mean_pure_mean =
  -8.131516293641283e-19 V`, `zero_mean_pure_max_abs =
  0.03149999999999938 V`;
- pure Neumann, niezbilansowany: solve kończy się kodem ABI
  `ERROR_BALANCE_FAILURE = 8`;
- typed mixed anchored/free: średnia komponentu zakotwiczonego
  `0.12499999999999592 V`, średnia komponentu swobodnego
  `-2.710505431213761e-20 V`, maksimum bezwzględne komponentu swobodnego
  `0.0015000000000000352 V`, dwa rozłączne komponenty.

Pozostałe obserwable tego runu pozostały zgodne z bazowym kontraktem:
uniform ma 26 iteracji, residual algebraiczny
`4.4700700269648826e-15`, fizyczny `3.6043853964842183e-14`,
`hierarchy_levels=2`, jeden build, jeden cache hit i `host_fallback_count=0`;
layered ma skok strumienia `5.46875e-14`, a strict-residency potwierdza
19 zdarzeń źródłowych, 14 restore i dokładną kolejność. Komunikat o PCG
przerwanym po jednej iteracji pochodzi z celowej fault-injection w transfer-audit
i nie jest błędem bramki.

Ten wynik zamyka managed proof bounded zero-mean realization, ale nie zmienia
granic publicznej kwalifikacji: publiczny zero-mean gauge istnieje wyłącznie
dla opisanego w sekcji 7.3 pełnopowierzchniowego profilu dwóch elektrod
`NormalCurrentElectrode`. Nie ma persistent Krylov warm start w tym przepływie,
publicznego dispatchu spin/SHE/mixing/torque, mesh convergence,
cross-backend parity ani produkcyjnego statusu. Ogólna capability pozostaje
`semantic_only`.

#### Ownership, lifecycle, and immutable charge state

The sole implementation owner is `backends/fdm/gpu/cuda/transport/**`. It owns
an opaque `GpuTransportContext` with device identity, compute stream and
events, allocator/pool, immutable geometry/material/operator revisions,
separate persistent charge and spin Krylov workspaces, snapshot generation,
transfer audit, and convergence telemetry. Transport must not extend the LLG
`Context`, add transport physics to `mfem_bridge.cpp`, or place operator/solver
work in Rust engine or runner code. Rust may materialize descriptors, invoke
the append-only ABI, publish artifacts, and preserve provenance only.

The lifecycle is:

1. create the context for one explicit CUDA device and FP64 precision;
2. upload and validate one immutable static descriptor;
3. solve charge entirely on that device;
4. atomically accept an immutable device snapshot;
5. solve steady spin against that snapshot and device `m_stage`;
6. compute torque device-to-device for the LLG RHS;
7. read back bounded scalar telemetry and configured artifacts only;
8. destroy snapshots, workspaces, and context with explicit ownership checks.

An accepted charge state is an **immutable device snapshot**, not a host object
with borrowed device pointers. It contains at least:

- `V[N]` in FP64;
- exactly one globally positive oriented face-current family:
  `Jx[(nx+1)ny nz]`, `Jy[nx(ny+1)nz]`, and `Jz[nx ny(nz+1)]` in FP64;
- charge-active/conductor masks and the immutable conductivity/operator
  revision used to interpret them;
- every oriented mixing descriptor, its two accepted charge traces, and its
  single conservative charge observation;
- every exact-density external face selected by
  `NormalCurrentElectrode [A/m2]`, including axis, face index, adjacent active
  cell, outward-normal sign, area, and density;
- context, source, operator, snapshot-generation, and convergence identities.

Spin accepts only the snapshot handle plus its generation. It may not accept
parallel host arrays for $V$, $J_c$, traces, or reconstructed $E$. A new charge
acceptance creates a new generation; it never mutates a snapshot already
visible to spin. Context mismatch, source/operator revision mismatch, a stale
generation, pre-acceptance consumption, or use after destroy fails before any
spin kernel launch.

#### Frozen typed static payloads for steady spin

The outer v1 operation records and their 18-record manifest remain byte-for-byte
frozen. In particular, `steady_spin_solve_request_v1` remains 176 bytes and
`steady_spin_solve_result_v1` remains 176 bytes. The following payload records
are append-only records selected by the six buffer views of
`static_descriptor_v1`; they are not additional manifest records. Every record
starts with the common 32-byte v1 prefix, is aligned to 8 bytes, accepts only a
larger optional tail at `struct_version=1`, and rejects an unknown required bit,
short record, nonzero reserved field, invalid stride, or arithmetic overflow
before pointer access.

| C payload type | Bytes | Exact ordered tail (`offset:name:type`) | Known features |
|---|---:|---|---:|
| `fullmag_fdm_gpu_transport_spin_cell_v1` | 72 | `32:active:u32;36:conductor:u32;40:material_index:u32;44:reserved1:u32;48:spin_active:u32;52:torque_target:u32;56:region_id:u32;60:reserved2:u32;64:saturation_magnetization:f64` | `0x0c` |
| `fullmag_fdm_gpu_transport_spin_material_v1` | 112 | existing charge-material prefix `32:material_index:u32;36:reserved1:u32;40:conductivity:f64;48:material_revision:u64`, then `56:spin_conductivity:f64;64:polarization:f64;72:spin_hall_angle:f64;80:spin_flip_length:f64;88:exchange_length:f64;96:dephasing_length:f64;104:spin_revision:u64` | `0x0c` |
| `fullmag_fdm_gpu_transport_spin_boundary_face_v1` | 104 | `32:kind:u32;36:axis:u32;40:side:i32;44:outward_sign:i32;48:adjacent_cell:u64;56:canonical_face_index:u64;64:area:f64;72:potential_xyz:f64[3];96:source_id:u64` | `0x08` |
| `fullmag_fdm_gpu_transport_spin_interface_v1` | 176 | `32:kind:u32;36:axis:u32;40:orientation:i32;44:reserved1:u32;48:negative_cell:u64;56:positive_cell:u64;64:from_cell:u64;72:to_cell:u64;80:canonical_face_index:u64;88:area:f64;96:G_up:f64;104:G_down:f64;112:G_r:f64;120:G_i:f64;128:magnetization_xyz:f64[3];152:source_id:u64;160:topology_id:u64;168:charge_edge_enabled:u32;172:reserved2:u32` | `0x1c` |
| `fullmag_fdm_gpu_transport_formula_ids_v1` | 144 | existing charge formula fields through offset 63, then `64:spin_formula_id:u32;68:spin_operator_id:u32;72:electric_reconstruction_id:u32;76:interface_formula_id:u32;80:torque_operator_id:u32;84:spin_engine_id:u32;88:preconditioner_id:u32;92:spin_residual_id:u32;96:local_residual_id:u32;100:reserved2:u32;104:spin_operator_revision:u64;112:preconditioner_revision:u64;120:gamma_e:f64;128:gmres_restart:u64;136:reserved3:u64` | `0x1c` |
| `fullmag_fdm_gpu_transport_spin_observation_record_v1` | 288 | `32:kind:u32;36:axis:u32;40:orientation:i32;44:reserved1:u32;48:cell_index:u64;56:source_id:u64;64:topology_id:u64;72:canonical_face_index:u64;80:negative_cell:u64;88:positive_cell:u64;96:from_cell:u64;104:to_cell:u64;112:region_id:u32;116:reserved2:u32;120:charge_from_trace_v:f64;128:charge_to_trace_v:f64;136:charge_delta_trace_v:f64;144:lane0_xyz:f64[3];168:lane1_xyz:f64[3];192:lane2_xyz:f64[3];216:lane3_xyz:f64[3];240:lane4_xyz:f64[3];264:lane5_xyz:f64[3]` | exactly `0x48` |

The six views retain their frozen meanings and order: cells, materials,
interfaces, charge faces, spin boundary faces, and formula IDs. Spin-aware cell,
material, and formula records preserve the existing charge record as their
leading byte-compatible subrecord, so a charge-only v1 consumer reads exactly
the same charge fields and ignores the larger stride. A descriptor that requests
steady spin requires the spin-aware forms and complete external spin-face
coverage. The supported bounded boundary registry is `invalid=0`,
`insulating=1`, `sink=2`, `specified_potential=3`; other values, including
specified flux and periodic, fail closed. The interface registry is
`transparent=1`, `mixing_conductance_v2=2`, `sml_reservoir_v2=3`, but the
bounded M1 GPU realization rejects SML. `charge_edge_enabled` must be one for a
transparent or longitudinal mixing edge and exact zero for the legal
transverse-only branch.

Each interface is identified by the tuple `(source_id, topology_id, axis,
canonical_face_index, negative_cell, positive_cell, from_cell, to_cell)`.
Records may arrive in any order; matching by array position is forbidden. The
two endpoint cells must be adjacent, active and spin-active, `from -> to` is the
authored N-to-F direction, and exactly one observation must be published for
each identity. `G_up`, `G_down`, and `G_r` are finite and nonnegative; `G_i` is
finite and signed; the interface magnetization is unit length. A torque target
has finite positive $M_s$, and the formula record carries one finite positive
$\gamma_e$. Disabled reaction lengths are exact zero; enabled lengths are
finite and positive. Polarization is in $[-1,1]$ and the signed spin Hall angle
is finite.

The closed spin ID registries are: formula
`transport_constitutive.one_way.fullmag.v1=1`, operator
`fv_spin_upwind_v1=1`, electric reconstruction
`fdm_exact_face_current_electric_reconstruction.v1=1`, interface
`magnetoelectronic.fullmag.v2=1`, torque
`fdm_transport_torque_cell_surface_balance.v1=1`, engine
`fdm_spin_block_gmres_cuda_v1=1`, preconditioner
`component_amg_block_jacobi_v1=1`, integrated residual
`transport_balance_integrated_l2.v1=1`, and local residual
`transport_balance_local_fv.v1=1`. Zero and unknown values fail closed. The
production policy requires `gmres_restart=50`; policy 2 uses a separately named
prototype engine and cannot publish these production IDs.

For a descriptor with `M1_CHARGE|STEADY_SPIN`, all six views are
`host_read_only`, `element_type=raw_bytes`, `component_order=scalar` and have
8-byte-aligned non-overlapping ranges. The exact contracts are:

| View | Count | Byte stride | Empty rule | Payload `required_features` |
|---|---:|---:|---|---:|
| cells | `nx*ny*nz` | 72 | forbidden | exactly `0x04` |
| materials | number of unique referenced material IDs, at least one | 112 | forbidden | exactly `0x04` |
| interfaces | number of authored internal interfaces | 176 | allowed only with address/length zero | transparent exactly `0x04`; mixing exactly `0x14` |
| charge faces | exactly all external structured faces | 88 | forbidden | exactly `0x04` |
| spin boundary faces | exactly all external structured faces | 104 | forbidden | exactly `0x08` |
| formula IDs | 1 | 144 | forbidden | exactly `0x04` |

`byte_length` is exactly `element_count*byte_stride` under checked arithmetic;
an empty interface view still carries stride 176. The three spin-aware records
with a charge prefix deliberately retain `required_features=0x04`, so an old
charge parser accepts the prefix and larger stride. The descriptor feature graph
(`required_features` contains `0x0c`, or `0x1c` when mixing is authored), the
exact spin stride and each tail field then make the spin extension mandatory;
the payload prefix is not overloaded to advertise its optional tail. All six
nonempty byte ranges are pairwise disjoint, and no device/unified pointer is
legal during static upload.

After a successful solve, the accepted snapshot token also owns immutable
device-resident $\mu_s$, complete oriented $Q_x/Q_y/Q_z$, separate
$R_{sf}/R_J/R_\phi$ channels, order-independent interface observations
(incoming, backflow, absorbed, both one-sided fluxes and reserved zero SML
channels), volume and surface torque terms, final torque in $\mathrm{s^{-1}}$,
all four physical balances, the deterministic compute digest, and the
scientific continuation digest. Artifact record 11 remains frozen with feature
mask `0x44`; legality of `mu_s`, `Q_ia`, torque and observations is determined
from the accepted spin state and `field_id`, not by changing that record mask.

Artifact field 7 is the only transport-observation stream; the closed artifact
field registry remains 0--7. Its destination is a range-bounded array of
`fullmag_fdm_gpu_transport_spin_observation_record_v1` records with
`raw_bytes/scalar`, 288-byte stride, exact record feature mask `0x48`, and the
closed kind registry `0 invalid`, `1 reaction`, `2 torque`, `3 interface`.
Unknown kinds, nonzero reserved fields, a different stride/component order, or
any smaller record are invalid. The stream order is independent of authored
interface order: reaction records for cells in increasing linear-cell order,
then torque records in that order, then interface records sorted
lexicographically by `(source_id, topology_id, axis, canonical_face_index,
negative_cell, positive_cell, from_cell, to_cell)`.

Every lane is an `xyz` vector. Reaction records use lanes 0--2 for
$(R_{sf},R_J,R_\phi)$ in $\mathrm{A\,m^{-3}}$; torque records use lanes 0--2
for `(volume,surface,total)` in $\mathrm{s^{-1}}$; interface records use lanes
0--5 for `(incoming,backflow,absorbed,negative-positive-axis-flux,
positive-positive-axis-flux,SML)` in $\mathrm{A\,m^{-2}}$. Unused metadata and
lanes are exact zero. `cell_index` and `region_id` are populated only for cell
records; the complete source/topology/orientation/face/from/to identity is
populated only for interface records. The bounded M1 lane emits an exact-zero
SML vector because `sml_reservoir_v2` remains unsupported. Artifact field 5
continues to expose the final total torque SoA and is not reinterpreted.
Interface records additionally preserve the accepted oriented charge traces
`charge_from_trace_v`, `charge_to_trace_v`, and their exact difference used by
the M1 mixing law; cell records keep those three fields exact zero.

#### Discrete operator invariants

The GPU charge operator is the same conservative finite-volume map as the CPU
oracle: harmonic bulk conductivity, one globally oriented current per face,
equal-and-opposite cell balance, explicit component gauge, and one-way series
trace elimination. The public density boundary is applied to the exact face
list; total current, a whole-plane mask, or a host-side redistribution is not
an equivalent input. Host and device validation both reject an internal,
inactive, duplicate, nonfinite, wrong-area, or outward-sign-inconsistent face.

The spin operator uses
`fdm_exact_face_current_electric_reconstruction.v1`. Its normal electric
component is the exact accepted $J_{c,f}/\sigma_f$; cell and tangential
components are reconstructed from the same accepted face currents. Reading
cell-centred $V$ to form another electric field is forbidden. Direct SHE must
exercise all six signed Levi-Civita contractions separately:

| Nonzero contraction | Sign |
|---|---:|
| $\epsilon_{xyz}$ | $+1$ |
| $\epsilon_{yzx}$ | $+1$ |
| $\epsilon_{zxy}$ | $+1$ |
| $\epsilon_{xzy}$ | $-1$ |
| $\epsilon_{zyx}$ | $-1$ |
| $\epsilon_{yxz}$ | $-1$ |

For one face globally oriented from its negative-axis cell $K^-$ to its
positive-axis cell $K^+$, define
$q_p=P_fJ_{c,f}$ with $P_f=(P_{K^-}+P_{K^+})/2$. The backend-neutral
`fv_spin_upwind_v1` rule is exact: $q_p>0$ selects $m_{K^-}$, $q_p<0$ selects
$m_{K^+}$, and exact zero selects the negative-axis cell and multiplies it by
exact zero, so the polarized contribution is exactly zero in every component.
No epsilon, signbit, previous-flow direction, thread order, or
central average may break the zero tie. This is the frozen rule implemented by
the CPU oracle, not an implementation-dependent referral to it. Transparent
faces preserve one charge and one spin flux. Full one-way mixing preserves longitudinal injection/backflow and
the transverse absorption
$G_r m\times(\Delta\mu_s\times m)+G_i(\Delta\mu_s\times m)$.
The `transverse-only` case $G_{\uparrow}=G_{\downarrow}=0$ with nonzero
$G_r$ or $G_i$ is legal: charge is insulating and does not join gauge
components, but transverse spin and torque remain active. No kernel may divide
by $G_{\uparrow}+G_{\downarrow}$ in that branch.

Volumetric $R_J+R_\phi$ and absorbed surface flux feed exactly one magnetic
owner through `fdm_transport_torque_cell_surface_balance.v1`. Longitudinal
spin-flip is reported as a nonmagnetic sink and is never counted again as
torque. Cell-local FV residual, global spin balance, interface balance, and
integrated volume-plus-surface torque closure are independent acceptance
checks; the Krylov residual cannot substitute for them.

#### Solver policy and bounded first executable slice

Charge uses `fdm_charge_cg_cuda_v1`: device CG, component-wise gauge handling,
fixed-tree FP64 reductions, and device AMG. Spin uses
`fdm_spin_block_gmres_cuda_v1`: restarted device GMRES with component
AMG/block-Jacobi, a bounded restart/memory budget, and device convergence
reductions. A Jacobi-only charge prototype must publish a distinct prototype
engine identity; it cannot claim the production AMG engine. Likewise, a local
$3\times3$ reaction inverse may be a named prototype preconditioner but cannot
silently replace the frozen component AMG/block-Jacobi policy.

Production GPU memory resolution uses `memory_policy=auto`. After static state
has been materialized on the selected CUDA context, the runtime reads
`cudaMemGetInfo`, freezes a safety reserve, and computes `usable_bytes` from the
actual free memory. Before any solve-owned allocation it must estimate and
publish separate `first_required_bytes` and `warm_required_bytes`; the latter
includes the immutable accepted state, the candidate state and every live
hierarchy/workspace phase. For cold AMG construction, where device-side
coarsening may reduce storage only after inspection of the operator,
`first_required_bytes` is a conservative pre-allocation upper bound rather
than a measured peak; provenance must identify estimate kind and the later
measured high-water value separately. Warm-cache requirements are computed
from the resolved resident hierarchy and must not be labelled as cold bounds.
An insufficient budget fails closed before the
first allocation and never enables CPU fallback. Because cache identity also
depends on the assembled `m_stage` digest, a warm attempt uses the same cold
upper bound for its pre-allocation gate; its exact retained-hierarchy
requirement is published only as a post-cache-hit audit, never misreported as
the earlier preflight. Provenance records the
resolved policy, device total/free memory, static baseline, safety reserve,
usable bytes, estimate kind, first/warm required bytes and measured high-water
bytes. `memory_policy=fixed`
is reserved for reproducible tests and qualification workloads. In particular,
512 MiB is the frozen external envelope of `performance_v1`, and 2 GiB is its
warm transactional high-water envelope; neither value is a global production
cap.

The first executable slice is intentionally bounded to one structured
single-grid domain on one CUDA device, FP64-only, explicit static materials,
axis-aligned external density/voltage/insulating charge faces, component
gauge, insulating/sink/specified-potential spin boundaries, transparent faces
or one oriented N-to-F mixing family, one accepted charge snapshot, and one
steady spin/torque evaluation for a supplied device `m_stage`. It includes the
six direct-SHE signs and the legal transverse-only branch. Periodic transport,
M2/iSHE/AMR/PHE/AHE, M3, SML reservoir, multiple devices, MPI, FP32, dynamic
Oersted, and production-scale performance remain later milestones. FP32
remains fail-closed and `auto` cannot select it.

#### Strict residency, determinism, failure, and provenance

Strict execution permits zero vector transfers per stage outside explicitly
configured output/checkpoint cadence. It permits bounded scalar reductions and
status readback, but every transfer and synchronization has versioned transfer
telemetry and provenance: direction, byte count, reason, count, stage,
iteration scope, stream/event identity, and whether it was allowed by cadence.
There is no CPU fallback, CPU operator/preconditioner, host convergence loop,
or host reconstruction of $E$, $J_c$, $\mu_s$, $Q$, or torque. A violation
returns `strict_gpu_residency_violation` and aborts the run.

Deterministic mode owns each face and interface torque exactly once and uses a
fixed launch geometry and reduction tree. Provenance records GPU name/UUID,
compute capability, driver/runtime, build identity and compiler flags including
FMA/fast-math policy. The promise is bitwise repetition on the same
device/runtime/build; CPU-to-GPU comparisons use the physical tolerances below.

Every solve is provisional until all algebraic and physical gates pass. A
rejected attempt appends its reason but cannot advance accepted revisions,
publish fields, replace warm starts, or mutate immutable accepted snapshots.
The cache key includes normalized descriptor, grid/material/operator/source
revisions, precision, device identity, formula/operator/engine/residual IDs,
and snapshot generation. Restart uses the versioned
`fullmag.fdm_gpu_transport_checkpoint.v1` export/import contract, not an
identity-only record and not a deterministic re-solve. Its committed payload
contains bitwise FP64 $V$, face $J_c$, traces and observations; accepted
$\mu_s$, face $Q$, reactions, interface observations and torque when present;
charge/spin Krylov warm starts; lineage, accepted sequence, revisions,
deterministic policy, work budgets and telemetry cursor. SHA-256 section and
payload digests, little-endian layout, exact device/runtime/build/operator
identity and an atomic provisional restore are mandatory. A successful restore
creates a fresh process-local token while preserving the lineage, accepted
sequence and content digest. Any incompatibility or partial payload restores
nothing; there is no cross-device migration, partial commit or re-solve
fallback.

Restart uses two deliberately separate digest lanes. The
`scientific_continuation_digest` covers accepted arrays and deterministic
solver continuation state; it excludes export/import/readback operations. The
append-only `operation_audit_digest` covers every actual transfer,
synchronization, and explicitly classified rejected attempt, including a
failed import after H2D. Pure handle/state calls without CUDA activity do not
invent zero-byte transfer records. Consequently the
full telemetry stream is not compared between uninterrupted and restarted
runs. Qualification compares the next deterministic compute and scientific
continuation digests exactly, then verifies the expected checkpoint events and
their audit parent chain separately.

Successful telemetry/provenance includes requested and resolved
`fdm/gpu/double/strict`, formula/operator/engine/residual IDs, iteration and
convergence reasons, algebraic plus physical residuals, charge/electrode/spin/
interface/torque balances, snapshot/cache identity, transfer/synchronization
audit, `host_fallback_count=0`, peak device/workspace bytes,
`row_major_Q_ia`, and face/interface orientation.

#### TDD and qualification matrix

Each row requires a non-skipped managed CUDA run on an identified physical
device. Compilation, host emulation, and source inspection are not device
evidence.

| Gate ID | Fixture and frozen parameters | Exact oracle | Metric and tolerance/budget | Required device/artifact proof |
|---|---|---|---|---|
| `layout_abi_v1` | `fdm_gpu_m1_layout_abi_v1`: every v1 prefix, numeric enum/ID/flag registry, `MIN_SIZE_V1`, four-slot token registry, create/destroy/reuse, stale generation, double destroy, generation exhaustion, and codec-only golden | `oracle.generated_c_header_layout_v1`: exact C `sizeof`/`alignof`/`offsetof` and numeric tables plus independent decoder of codec-only golden length=1600 bytes and codec-only golden SHA-256=ad8d00c7c4d3c349ee203946145b9d02f8e34f331ee9687645c9c981bb33b803 | every byte, discriminant, legal mask and status exact; 100% invalid/unknown values and tuple/subrecord mutations reject before pointer access | non-skipped managed lifecycle/decoder run with GPU UUID and `fdm-gpu-m1-layout-abi-v1.json` |
| `charge_uniform_v1` | `fdm_gpu_m1_charge_uniform_v1`: $64\times4\times2$, $\Delta x=1\,\mathrm{nm}$, $\sigma=5\times10^6\,\mathrm{S/m}$, $V(0)=64\,\mathrm{mV}$, $V(64\,\mathrm{nm})=0$ | `oracle.charge_uniform_linear_v1`: $E_x=10^6\,\mathrm{V/m}$ and every positive-x face $J_c=5\times10^{12}\,\mathrm{A/m^2}$ | $V,J_c$ `rtol<=1e-12`, charge balance `<=1e-10` of flux scale | non-skipped managed FP64 run with GPU UUID and `fdm-gpu-m1-charge-uniform-v1.json` containing fields, residuals and snapshot digest |
| `charge_layered_v1` | `fdm_gpu_m1_charge_layered_v1`: two $32\,\mathrm{nm}$ layers, $\sigma_1=2\times10^6$, $\sigma_2=8\times10^6\,\mathrm{S/m}$, $\Delta V=50\,\mathrm{mV}$ | `oracle.charge_layered_series_v1`: $R_A=2.0\times10^{-14}\,\Omega\,\mathrm{m^2}$, every oriented face $J_c=2.5\times10^{12}\,\mathrm{A/m^2}$ and analytic piecewise-linear $V$ | current and $V$ `rtol<=1e-10`; interface flux jump `<=1e-12` of $J_c$ | non-skipped managed CPU/GPU FP64 run with GPU UUID and `fdm-gpu-m1-charge-layered-v1.json` |
| `density_face_bc_v1` | `fdm_gpu_m1_density_face_bc_v1`: $4\times2\times1$ grid with four ordered external faces, areas $[1,1,2,2]\times10^{-18}\,\mathrm{m^2}$ and outward densities $[1,-2,3,-4]\times10^{11}\,\mathrm{A/m^2}$ | `oracle.density_face_descriptor_v1`: accepted values match descriptor order and $I=\sum_f A_f j_f=-3\times10^{-7}\,\mathrm{A}$; internal, duplicate, inactive, wrong-area and wrong-sign mutations are rejected | each face value/sign/identity exact; integrated $I$ `rtol<=1e-12`; 100% invalid mutations reject | non-skipped managed run with GPU UUID and `fdm-gpu-m1-density-face-bc-v1.json` containing the authored and accepted face lists |
| `component_gauge_v1` | `fdm_gpu_m1_component_gauge_v1` bounded fixture in `fdm_gpu_m1_charge_uniform_v1_contract`: two disconnected 512-cell conductors separated by a transverse-only charge-insulating interface; left component has $V=0.125\,\mathrm{V}$ datum, while free component B has no voltage datum and has balanced exact-density Neumann flux | `oracle.component_graph_gauge_v1`: typed graph has two components, no charge edge across the interface, left datum is preserved, and right component has arithmetic mean zero | anchored mean `atol<=1e-10 V`; free mean `atol<=1e-14 V` relative to its nonzero profile; unbalanced pure-Neumann returns `ERROR_BALANCE_FAILURE` | non-skipped managed run with GPU UUID; `fdm-gpu-m1-charge-uniform-v1.json` records `zero_mean_pure_mean`, `zero_mean_unbalanced_status`, mixed anchored/free means, and `host_fallback_count=0` |
| `charge_snapshot_v1` | `fdm_gpu_m1_charge_snapshot_v1`: validate the synthetic frozen IDs 1--9/18/20 sequence-7 payload as codec oracle A and reject its identity in the actual context; separately solve/export an actual-runtime sequence-7 one-cell payload B, then import B in a fresh exact-matching context | `oracle.snapshot_registry_checkpoint_v1`: A has length=4352 bytes, SHA-256=ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5 and embedded hash `bc3bcc1b51314fe46e0bbd2f71e94f1517f8e438943853e33b8e79b1495c7b60`; B has the same canonical length/sections but an identity-dependent SHA | A byte grammar and SHA exact plus cross-identity `checkpoint_incompatible`; B length exactly 4352 bytes, identity exact, committed SHA self-consistent, fresh-context $V/J_c$ bitwise exact without re-solve; failed operations leave accepted state unchanged | non-skipped managed lifecycle run with GPU UUID and `fdm-gpu-m1-charge-snapshot-v1.json` containing both A-oracle and B-runtime results |
| `spin_diffusion_v1` | `fdm_gpu_m1_spin_diffusion_v1`: $L=100\,\mathrm{nm}$, $\lambda_{sf}=10\,\mathrm{nm}$, $\mu_s(0)=(1,0,0)\,\mathrm{mV}$, $\mu_s(L)=0$, grids 64/128/256 | `oracle.spin_diffusion_sinh_v1`: $\mu_x(x)=1\,\mathrm{mV}\,\sinh((L-x)/\lambda_{sf})/\sinh(L/\lambda_{sf})$, other components exact zero | profile `rtol<=1e-9`; local/global balance `<=1e-10`; forbidden components exact zero | non-skipped managed CPU/GPU FP64 run with GPU UUID and `fdm-gpu-m1-spin-diffusion-v1.json` containing three grids |
| `direct_she_six_signs_v1` | `fdm_gpu_m1_direct_she_six_signs_v1`: six one-gradient cases with $E_k=10^5\,\mathrm{V/m}$, $\theta_{SH}=0.1$, $\sigma=5\times10^6\,\mathrm{S/m}$ plus $\theta_{SH}=0$ | `oracle.levi_civita_six_v1`: amplitude $5\times10^{10}\,\mathrm{A/m^2}$ with signs $xyz,yzx,zxy=+1$ and $xzy,zyx,yxz=-1$; all other components zero | active component `rtol<=1e-12`; sign and zero components exact | non-skipped managed kernel run with GPU UUID and `fdm-gpu-m1-direct-she-six-signs-v1.json` containing seven outputs |
| `face_current_e_v1` | `fdm_gpu_m1_face_current_e_v1`: $\sigma_-=2\times10^6$, $\sigma_+=8\times10^6\,\mathrm{S/m}$, harmonic $\sigma_f=3.2\times10^6\,\mathrm{S/m}$, accepted $J_{c,f}=4\times10^{12}\,\mathrm{A/m^2}$, then perturb unused cell $V$ | `oracle.face_current_e_v1`: $E_{n,f}=1.25\times10^6\,\mathrm{V/m}$ and unchanged direct-SHE $Q$ from the accepted face current | $E,Q$ bitwise unchanged by $V$ mutation; CPU/GPU values `rtol<=1e-12` | non-skipped managed mutation run with GPU UUID and `fdm-gpu-m1-face-current-e-v1.json` plus face-current digest |
| `upwind_three_way_v1` | `fdm_gpu_m1_upwind_three_way_v1`: $P_f=0.4$, $m_-=(1,0,0)$, $m_+=(0,1,0)$ and $J_{c,f}=+2\times10^{12},-2\times10^{12},+0.0\,\mathrm{A/m^2}$ | `oracle.upwind_three_way_v1`: polarized terms $(8\times10^{11},0,0)$, $(0,-8\times10^{11},0)$ and exact `(+0.0,+0.0,+0.0)` with the negative-axis endpoint selected for the zero tie | nonzero vectors `rtol<=1e-12`; owner ID and all exact-zero bits exact | non-skipped managed three-case run with GPU UUID and `fdm-gpu-m1-upwind-three-way-v1.json` |
| `mixing_interface_v2` | `fdm_gpu_m1_mixing_interface_v2`: transparent case with two $1\,\mathrm{m}$ cells, $\sigma_s=2\,\mathrm{S/m}$, $\mu_-=(1,0,0)\,\mathrm{V}$, $\mu_+=0$, $P=\theta_{SH}=J_c=0$; plus oriented $N\to F$ cases with $m=(0,0,1)$, $\Delta V=2\,\mathrm{mV}$, $\Delta\mu_s=(3,4,5)\,\mathrm{mV}$, $G_\uparrow=7\times10^{14}$, $G_\downarrow=3\times10^{14}$, $G_r=2\times10^{14}$, $G_i=-10^{14}\,\mathrm{S/m^2}$; repeat reversed storage orientation and with $G_\uparrow=G_\downarrow=0$ | `oracle.mixing_one_way_numeric_v2`: transparent one-sided fluxes $(1,0,0)\,\mathrm{A/m^2}$; full $q_\parallel=(0,0,3.3\times10^{12})$, $q_{abs}=(2\times10^{11},1.1\times10^{12},0)$, N/F fluxes $(2\times10^{11},1.1\times10^{12},3.3\times10^{12})$ and $(0,0,3.3\times10^{12})\,\mathrm{A/m^2}$; reversed positive-axis fluxes are their signed swapped values; transverse-only has $j_c=0$, N flux $q_{abs}$ and F flux zero | every one-sided component `rtol<=1e-12`; charge/interface/absorption closure `<=1e-10`; transverse-only gauge edge count exact zero | non-skipped managed four-case run with GPU UUID and `fdm-gpu-m1-mixing-interface-v2.json` containing all public interface observations |
| `torque_balance_v1` | `fdm_gpu_m1_torque_balance_v1`: one $2\,\mathrm{nm}$ cube, $M_s=8\times10^5\,\mathrm{A/m}$, volume reaction $R_J+R_\phi=(1,-2,0)\times10^{15}\,\mathrm{A/m^3}$ and one $4\,\mathrm{nm^2}$ face with $q_{abs}=(0.8,4.4,0)\times10^6\,\mathrm{A/m^2}$ | `oracle.torque_volume_surface_v1`: bracket $(1.4,0.2,0)\times10^{15}\,\mathrm{A/m^3}$ and $T_{tr,G}=-(\gamma_e\hbar/(2eM_s))(1.4,0.2,0)\times10^{15}\,\mathrm{s^{-1}}$ | cell torque `rtol<=1e-12`; integrated angular-momentum closure `<=1e-10`; spin-flip contribution exact zero | non-skipped managed CPU/GPU FP64 run with GPU UUID and `fdm-gpu-m1-torque-balance-v1.json` containing volume and surface terms separately |
| `strict_residency_v1` | `fdm_gpu_m1_strict_residency_v1`: one public charge-to-spin-to-torque stage without cadence, followed by readback of exactly 64 FP64 `V` values and export of an actual-runtime complete charge checkpoint | `oracle.transfer_reason_accounting_v1`: zero stage-vector events, then one `artifact_readback_d2h` and one `checkpoint_export_d2h`; `artifact D2H=512 bytes`, `checkpoint D2H=4352 bytes`, identity-dependent committed payload SHA, `host_fallback_count=0` | stage H2D/D2H bytes exactly zero; authorized totals/counts and runtime payload SHA self-consistent; every synchronization reason classified | non-skipped managed device timeline with GPU UUID and `fdm-gpu-m1-strict-residency-v1.json` plus exported runtime checkpoint |
| `determinism_restart_v1` | `fdm_gpu_m1_determinism_restart_v1`: two uninterrupted repeats and one actual-runtime export/destroy/new-context/import continuation of a 4352-byte sequence-7 checkpoint; the separate frozen oracle A supplies codec mutations for truncation, corruption, unknown required ID, nonzero or surplus-zero padding, wrong ID-1 tuple, subrecord `record_bytes`, field type, extra inter-section block and missing required section | `oracle.checkpoint_bitwise_continuation_v1`: runtime payload B preserves exact device/build/static identity, lineage/sequence/content, and next field/balance/iteration/`deterministic_compute_digest`/`scientific_continuation_digest`; frozen payload A retains exact SHA-256 `ae8d3c13853297760f2d9b19156067b52a502dfcb3e006e82ac590310200f6d5` solely as codec oracle and must reject across actual identity; `operation_audit_digest` independently proves export/import or failed-import events | scientific/compute digests exact; full telemetry stream is not compared; 100% semantic decoder/import mutation rejection and every actual transfer remains in the audit chain | non-skipped same-GPU UUID managed triplet with `fdm-gpu-m1-determinism-restart-v1.json`, audit records and complete runtime checkpoint payload |
| `public_path_v1` | `fdm_gpu_m1_public_path_v1`: normalized ProblemIR for $8\times4\times2$, double/strict GPU, $\sigma=5\times10^6\,\mathrm{S/m}$, $\theta_{SH}=0.1$, x-min density $10^{11}\,\mathrm{A/m^2}$, x-max $V=0$, insulating spin BC and one torque target | `oracle.public_artifact_manifest_v1`: exact requested/resolved tuple plus required artifacts `V,J_c,mu_s,Q_ia,torque_stt`, charge/spin/interface balances, transfer audit and checkpoint identity with frozen SI units/components | normalized ProblemIR, requested/resolved identity and artifact key set 100% exact; numeric fields meet their gate tolerances | non-skipped managed ProblemIR-planner-runner-ABI-CUDA run with GPU UUID and `fdm-gpu-m1-public-path-v1.json` plus artifact manifest |
| `convergence_v1` | `fdm_gpu_m1_convergence_v1`: uniform/layered charge and 1-D spin on 32/64/128 cells; transverse-only N/F interface with $y\in[0,1]\,\mathrm{m}$, unit depth, $m=(0,0,1)$, $G_\uparrow=G_\downarrow=G_i=0$, $G_r=2\,\mathrm{S/m^2}$, $\Delta\mu_s=(y^2,0,0)\,\mathrm{V}$, and mixing grids 2x16x1, 2x32x1, and 2x64x1 | `oracle.richardson_orders_v1`: analytic charge/spin solutions and mixing $q_{abs}=(2y^2,0,0)\,\mathrm{A/m^2}$ with exact integral $2/3\,\mathrm{A/m}$; composite midpoint error $e_n=1/(6n^2)\,\mathrm{A/m}$ | charge/spin order `>=1.8`, ratio `>=3.5`; mixing order `>=1.99`, successive ratio `[3.99,4.01]`, pointwise `rtol<=1e-13`; all balances `<=1e-10` | non-skipped managed mesh sweep with GPU UUID and `fdm-gpu-m1-convergence-v1.json` containing raw norms, exact errors, ratios and fitted orders |
| `performance_v1` | `fdm_gpu_m1_performance_v1`: $1024\times128\times8=1,048,576$ cell racetrack, fixed solver tolerances, output/checkpoint disabled, `memory_policy=fixed`, one first solve then five warm transactional solves on one recorded GPU UUID/runtime/build | `oracle.absolute_fdm_gpu_m1_budget_v1`: workload-specific fixed qualification envelope, not a global runtime cap | first-solve external envelope `<=536870912` bytes; warm transactional peak `<=2147483648` bytes; setup <=5 s; median total solve <=30 s; p95 total solve <=36 s; forbidden transfer bytes exact zero | five non-skipped managed runs with GPU UUID and `fdm-gpu-m1-performance-v1.json` containing raw setup/apply/solve/reduction times, first/warm required bytes, total/free/baseline/reserve/usable memory, resolved policy and high-water marks |

These gates define qualification. The bounded charge rows named in the status
section have actual-device contract evidence, while every other row remains a
future gate; the table as a whole is not evidence that a public GPU runner,
broader M1 executable workload, parity result or production qualification
exists.

### 3.2 FEM/MFEM weak-form contract

Transparent interfaces may use conforming `H1`. Finite-resistance/mixing/SML
interfaces require subdomain/broken `H1 P1` for `V` and `[H1 P1]^3` for
`mu_s`, with independent traces. A globally conforming space that forces
`Delta V=Delta mu_s=0` is prohibited.

For charge test `w` and spin test `v`:

```text
integral grad(w) dot J_c(V,mu_s,m) dOmega
 = integral_boundary w j_n dGamma,

integral v dot C_s partial_t(mu_s) dOmega
 -integral grad(v):Q dOmega
 +integral v dot(R_sf+R_J+R_phi)dOmega
 +integral_Gamma v dot q_out dGamma = 0.
```

The interface contribution is assembled once on an oriented shared surface
using both traces. Baseline uses subdomain spaces plus mortar coupling;
Nitsche/DG requires a new stability-qualified formula version. M1 is block
triangular and may solve charge before spin. M2 has both off-diagonal blocks,
is nonsymmetric, and may not use CG.

CPU production ownership separates spaces, assembly, BC, solve, projection,
and telemetry under native MFEM modules. GPU realization uses hypre/libCEED
device operators and persistent state. `mfem_bridge.cpp` carries descriptors;
it does not own physics. Strict GPU forbids CPU solves and hidden hot-loop
vector transfers.

### 3.3 Hybrid

No hybrid spin-transport capability is validated here. Any future coupling
must conserve the same oriented face/interface flux, preserve `Q_ia` component
order and units, publish transfer/projection error, and demonstrate convergence
against independent FDM and FEM double oracles.

## 4. API, IR, planner, runtime, and workspace impact

(python-api)=
### 4.1 Python API surface

Canonical public constructs are `CurrentTransport`, `SpinDriftDiffusion`,
`DriftDiffusionSpinTorque`, transport materials, oriented interfaces, spin
boundaries, and solver parameters. Drives use one `TimeEnvelope`. Materials
carry signed `theta_sh/P`, conductivities, lengths, and optional physical
`spin_capacitance`. `DriftDiffusionSpinTorque` consumes a named solve and may
not accept a private current or polarization shortcut.

For the reciprocal M2 authoring contract, `CurrentTransport` accepts
`coupling="bidirectional"` (or the resolved model name
`model="magnetoresistive_poisson"`) only with a complete Ohmic charge solve.
Every charge-material assignment must carry the base `sigma_Spm` plus finite,
positive `sigma_parallel_Spm` and `sigma_perpendicular_Spm`, and finite
`sigma_AHE_Spm`. The charge policy is the block operator
`fdm_coupled_charge_spin_fv_block_gmres.v1`; its physical residual is
`transport_balance_integrated_l2.v1`. `ReciprocalNonlinearSolverPolicy`
provides positive `gmres_restart` and `max_picard_iterations`, positive
`relative_update_tolerance`, and `0 < eta_transport <= 1`.

`Problem` owns the source coupling and lowers the linked spin module to
`transport_constitutive.reciprocal.fullmag.v1`; a spin module cannot override
the source with an independent coupling. Reciprocal authoring is steady-only
until a transient M2 contract is published. Python, SceneDocument, the
resource-first Rust authoring schema, and the Control Room inspector preserve
these fields. The general M2 lane remains semantic_only until the workload
gates below close; the bounded FEM CPU slice is reference_executable only for
the exact scope in section 7.2 and must not be interpreted as a general
FDM/FEM/GPU execution guarantee.

(round-trip-and-failure-semantics)=
### 4.1.1 Requested intent, resolved execution, and failure semantics

The authoring round trip preserves requested intent separately from resolved
execution. The Python fields for coupling, material tensor, solver policy,
requested discretization, device, precision, and execution mode lower into
ProblemIR; planner normalization then records the resolved constitutive model,
operator version, lane, and qualification state. A successful bounded M2 run
must expose both records in its descriptor and provenance. No resolver may
silently substitute M1, FDM, or a different device when the requested
combination is unsupported.

Validation errors are fail-closed and identify the owning field and the
physical reason. Examples are a missing reciprocal conductivity, a nonpositive
Schur complement, a mixed charge tensor outside the bounded FEM scope, an
incompatible nonlinear policy, a missing charge gauge, or a GPU request without
an executable transport operator. Unsupported combinations remain visible as
diagnostics and do not produce a plausible-looking fallback artifact.

The following table is the complete public parameter inventory for the bounded
M2 authoring slice. The ProblemIR column is the canonical normalized path; an
export/import cycle must preserve the value and its units.

| Python parameter | Type | Default | SI unit | Validation | Physical meaning | Executable scope | ProblemIR mapping |
|---|---|---|---|---|---|---|---|
| CurrentTransport.coupling | Literal['one_way','bidirectional'] | one_way | $1$ | bidirectional requires the complete reciprocal material and a steady FEM M2/FDM M2-compatible solver policy | source-owned charge/spin reciprocity | FEM CPU bounded M2; FDM CPU bounded reference; GPU semantic-only | current_modules[].coupling |
| ChargeTransportMaterial.sigma_Spm | float | required | $\mathrm{S\,m^{-1}}$ | finite and positive | reciprocal scalar charge conductivity | FEM/FDM CPU reference lanes | current_modules[].definition.materials[].material.sigma_spm |
| ChargeTransportMaterial.sigma_parallel_Spm | float-or-none | required for bounded FEM M2 | $\mathrm{S\,m^{-1}}$ | finite and positive; uniform across the bounded FEM domain | AMR/PHE conductivity parallel to magnetization | FEM CPU bounded M2; FDM M2 reference | current_modules[].definition.materials[].material.sigma_parallel_spm |
| ChargeTransportMaterial.sigma_perpendicular_Spm | float-or-none | required for bounded FEM M2 | $\mathrm{S\,m^{-1}}$ | finite and positive; uniform across the bounded FEM domain | AMR/PHE conductivity transverse to magnetization | FEM CPU bounded M2; FDM M2 reference | current_modules[].definition.materials[].material.sigma_perpendicular_spm |
| ChargeTransportMaterial.sigma_AHE_Spm | float-or-none | required for bounded FEM M2 | $\mathrm{S\,m^{-1}}$ | finite; uniform across the bounded FEM domain | anomalous-Hall coefficient | FEM CPU bounded M2; FDM M2 reference | current_modules[].definition.materials[].material.sigma_ahe_spm |
| SpinDriftDiffusion.solver | SpinSolverPolicy | required | $1$ | bounded FEM M2 requires block_gmres-compatible charge/spin linear policies and no reciprocal_nonlinear policy | spatial transport solve and residual policy | FEM CPU bounded M2; GPU rejected | spin_transport_modules[].solver |
| StudyStagesBuilder.set_transport_current | module_id plus Mapping[str,float] | required | $\mathrm{A\,m^{-2}}$ | finite values and exact coverage of all named normal-current electrodes | stage-local solved-current terminal drive | planner-neutral workflow mutation; execution remains lane-qualified | current_modules[].definition.boundaries[].outward_current_density_apm2 |
| StudyStagesBuilder.set_spin_torque_enabled | module_id plus bool | required | $1$ | exactly one typed and graph spin_torque module; inactive magnetic sinks require every solved-current terminal to be exactly zero | stage-local torque participation in the LLG RHS | physics_graph-filtered FEM/FDM semantics; racetrack gate targets FDM | physics_graph.modules[].activation and incoming edges[].status |

The table is intentionally narrower than the complete physical contract:
boundaries, interfaces, spin capacitance, transient policies, torque targets,
and nonlinear reciprocal iteration parameters remain represented in ProblemIR,
but are rejected by the bounded native FEM M2 lane when their implementation
contract is not present.

The following executable Python cell is the minimal authoring-to-IR round trip
for this bounded slice. The charge policy is authored with the public block
policy; planner resolution changes the requested FDM operator to the explicit
bounded FEM operator only after all FEM scope checks pass.

```python
# %%
from fullmag.model.current_transport import (
    ChargeInsulating,
    ChargePotentialGauge,
    ChargeSolverPolicy,
    ChargeTransportMaterial,
    ChargeTransportMaterialAssignment,
    CurrentTransport,
    VoltageElectrode,
)
from fullmag.model.spin_torque import RegionRef
from fullmag.model.spin_transport import (
    SpinDriftDiffusion,
    SpinSolverPolicy,
    SpinTransportMaterial,
    SpinTransportMaterialAssignment,
    SurfaceRef,
    TransportExecution,
)

strip = RegionRef("strip")
x_min = SurfaceRef("strip", "x_min", (-1.0, 0.0, 0.0))
x_max = SurfaceRef("strip", "x_max", (1.0, 0.0, 0.0))
side_faces = tuple(
    SurfaceRef("strip", name, normal)
    for name, normal in (
        ("y_min", (0.0, -1.0, 0.0)),
        ("y_max", (0.0, 1.0, 0.0)),
        ("z_min", (0.0, 0.0, -1.0)),
        ("z_max", (0.0, 0.0, 1.0)),
    )
)

charge = CurrentTransport(
    name="charge",
    model="ohmic_poisson",
    coupling="bidirectional",
    domain=(strip,),
    materials=(
        ChargeTransportMaterialAssignment(
            region=strip,
            material=ChargeTransportMaterial(
                sigma_Spm=4.0e6,
                sigma_parallel_Spm=4.4e6,
                sigma_perpendicular_Spm=4.0e6,
                sigma_AHE_Spm=0.2e6,
            ),
        ),
    ),
    boundaries=(
        VoltageElectrode("left", (x_min,), potential_V=0.0),
        VoltageElectrode("right", (x_max,), potential_V=1.0e-3),
        ChargeInsulating("sides", side_faces),
    ),
    gauge=ChargePotentialGauge("dirichlet_reference"),
    solver=ChargeSolverPolicy(
        engine="block_gmres",
        relative_tolerance=1.0e-10,
        absolute_tolerance=0.0,
        max_iterations=500,
        operator_version="fdm_coupled_charge_spin_fv_block_gmres.v1",
        physical_residual_version="transport_balance_integrated_l2.v1",
    ),
)

spin = SpinDriftDiffusion(
    id="spin",
    current_source_id="charge",
    domain=(strip,),
    materials=(
        SpinTransportMaterialAssignment(
            region=strip,
            material=SpinTransportMaterial(
                sigma_s_Spm=5.0e6,
                polarization_p=0.2,
                theta_sh=0.1,
                lambda_sf_m=2.0e-9,
            ),
        ),
    ),
    solver=SpinSolverPolicy(
        engine="gmres",
        relative_tolerance=1.0e-10,
        absolute_tolerance=0.0,
        max_iterations=500,
        operator_version="fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1",
        default_external_boundary="spin_insulating",
    ),
    requested_execution=TransportExecution(
        discretization="fem",
        device="cpu",
        precision="double",
        execution_mode="strict",
    ),
)

charge_ir = charge.to_ir()
spin_ir = spin.to_ir(coupling=charge.coupling)
assert charge_ir["coupling"] == "bidirectional"
assert charge_ir["model"] == "magnetoresistive_poisson"
assert spin_ir["constitutive_version"] == "transport_constitutive.reciprocal.fullmag.v1"
assert spin_ir["requested_execution"]["discretization"] == "fem"
```

(problem-ir)=
### 4.2 ProblemIR representation

Typed IR includes `SpinTransportModuleIR`, charge/spin materials,
`SpinInterfaceIR`, `SpinBoundaryIR`, `DriftDiffusionTorqueIR`, and resolved
transport/integrator plans. It stores formula/interface versions, full units,
oriented region/surface references, BC, tolerances, source identity, derived
resolved coupling, and requested execution. Public coupling is owned only by
the referenced `CurrentTransport`; the spin module has no independent coupling
field. Lowering copies and validates the source value, while normalization
rejects a conflicting legacy spin-side value. A legacy placeholder lacking
domains/materials/BCs cannot migrate automatically and fails with a versioned
diagnostic.

### 4.3 Planner and capability matrix

Capabilities are separately scoped:
`transport.charge.ohmic`, `transport.charge.magnetoresistive`,
`transport.spin.steady_drift_diffusion`,
`transport.spin.transient_drift_diffusion`, `transport.spin.direct_she`,
`transport.spin.inverse_she`, `transport.spin.mixing_conductance`, and
one-way/bidirectional coupling. Planner resolves one engine, enforces solver
symmetry, positivity, validity, stage cadence, strict residency, and records
requested/resolved lane. `ResolvedSpinTransportPlanIR` retains authored intent
in `requested_execution` and publishes the complete typed resolved tuple as
`resolved_discretization`, `resolved_device`, `resolved_precision`, and
`resolved_execution_mode`; the bounded GPU M1 lane resolves exactly to
FDM/GPU/double/strict. `validated` is workload/lane/precision/BC scoped.

(implementation-mapping)=
### 4.4 Runtime, quantities, provenance, OpenAPI, and UI

Transport workflow owns `V`, `mu_s`, `J_c`, and `Q`; torque only consumes
outputs. Quantities include `V_electric [V]`, `J_charge [A/m^2]`,
`spin_potential [V]`, `spin_current_tensor [A/m^2]`, interface normal flux,
and transport torque. `Q` uses nine FMVP components with metadata
`row_major_Q_ia`, flow/spin axes, location, and scope.

(spin-current-tensor-descriptor)=
Kanoniczny katalog quantities opisuje `spin_current_tensor` dodatkowym,
opcjonalnym polem `tensor`: `rank=2`, `shape=[3,3]`, `layout=flow_major`,
`axes=[flow,spin]` i `component_labels=[Q_xx,Q_xy,Q_xz,Q_yx,Q_yy,Q_yz,Q_zx,Q_zy,Q_zz]`.
Właścicielem jest `crates/fullmag-quantities/src/catalog.rs::tensor_descriptor`;
`build_wire_catalog` oraz API `QuantityCatalogEntry` przekazują te same dane.
Opis wynika z kanonicznej tożsamości quantity, nie z liczby komponentów payloadu.
Starszy JSON bez pola pozostaje czytelny, lecz brak metadanych nie upoważnia do
interpretowania dziewięciu komponentów jako wektora XYZ. Jednostka pozostaje
$\mathrm{A\,m^{-2}}$ z katalogu; metadane nie przenoszą ciężkiego tensora.

Ten fragment nie zmienia równań, Python/ProblemIR ani backend support. Istniejący
API wybór `c0`–`c8` zachowuje kolejność flow-major. Preview 2D/3D pozostaje
`export_only` do czasu kwalifikacji selectorów, kontrakcji, próbkowania i browser
regression. Dodanie deskryptora nie jest dowodem działającej wizualizacji.

(spin-current-tensor-projection-contract)=
Projekcja prezentacyjna tensora nie zmienia zaakceptowanego wyniku transportu.
Indeksy numeryczne osi x, y, z to odpowiednio 0, 1, 2. Skalar komponentu i
wektor przepływu dla wybranej polaryzacji mają następujące znaczenie:

```{math}
:label: spin-current-tensor-display-projections
c=3i+a,\qquad
N_Q=\left(\sum_{i=0}^{2}\sum_{a=0}^{2}Q_{ia}^{2}\right)^{1/2},\qquad
\mathbf q_a=(Q_{0a},Q_{1a},Q_{2a}).
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $i$ | indeks osi przepływu x/y/z jako 0/1/2 | $1$ |
| $a$ | indeks polaryzacji spinu x/y/z jako 0/1/2 | $1$ |
| $c$ | indeks komponentu payloadu flow-major | $1$ |
| $N_Q$ | norma Frobeniusa wszystkich dziewięciu składowych | $\mathrm{A\,m^{-2}}$ |
| $\mathbf q_a$ | przestrzenny wektor przepływu dla ustalonej polaryzacji spinu | $\mathrm{A\,m^{-2}}$ |

Jawny wybór `component` zawiera obie osie; `frobenius` wybiera normę $N_Q$;
`spin_flow_vector` wybiera polaryzację i trzy kierunki przestrzennego przepływu.
Surowy rank-2 carrier pozostaje dziewięcioskładowy i nie jest wejściem XYZ glyph
ani orientation renderer. Nie opisuje się normy jako mocy lub momentu.

Planar/FEM sampling najpierw interpoluje lub redukuje wszystkie składowe,
a dopiero potem liczy normę. Norma próbek węzłowych interpolowana jako skalar
nie jest równoważna normie interpolowanego tensora. Wektor kolumny zachowuje
orientację flow/spin i znaki; surface flux wymaga rzeczywistej normalnej i
zgodnego nośnika, nie domyślnego kierunku kamery.

Zapisane ustawienia targetu zawierają jawny rodzaj projekcji oraz jej osie.
Tożsamość cache/ETag/requestu obejmuje canonical projection token wraz z
quantity, scope, session i generation/revision. Zmiana projekcji nie rozwiązuje
transportu i nie tworzy nowej topologii. Brak lub niezgodny descriptor oznacza
odmowę tensor visualization; brak jednostki nie otrzymuje pustej legendy.
Bramki preview pozostają zamknięte do czasu rzeczywistego HTTP oraz browser
proof dziewięciu komponentów, normy, wybranej kolumny i poprawnej interpolacji.
Stan: kontrakt wdrożenia E10, nie kwalifikacja runtime ani nowej lane.

Telemetry includes scaled residuals, iterations, reason, preconditioner,
operator revision, balances, stage refreshes, timings, nonlinear iterations,
and H2D/D2H counts. Provenance records full splitting convention, index order,
interfaces, normalized materials, BC/tolerances, formula versions,
requested/resolved execution, and revisions.

Resource-first API projects current transports, spin transports, interfaces,
and torques from one revisioned SceneDocument; heavy tensors remain on the
binary data plane. Dedicated Explorer/Inspector nodes author and inspect model,
units, orientation, qualification, residual, and freshness. UI/Python export
must satisfy normalized four-path round-trip equality. The current inspector
round-trips M2 conductivity tensors and reciprocal nonlinear solver policy as
typed fields; unknown or incomplete M2 records stay read-only/fail-closed, and
the capability result remains `semantic_only` until the workload gates below
are closed.

The opt-in FDM CPU native M1 path is explicit end to end:
`native_m1_v1` resolves to the C declarations in
`native/include/fullmag_fdm.h`, the dedicated warning-clean adapter translation
unit in `backends/fdm/api/cpu_transport_v1.cpp`, Rust FFI records in
`crates/fullmag-fdm-sys/src/lib.rs`, and the fail-closed runner adapter
`solve_native_m1_snapshot` in
`crates/fullmag-runner/src/fdm/cpu/native_transport.rs`. Its managed public
ProblemIR--planner--runner gate is
`crates/fullmag-runner/tests/native_m1_v1_public_e2e.rs`. It publishes complete
cell and face charge/spin fields, reaction channels, interface observations,
transport torque, and requested/resolved provenance without fallback. These
are executable contract observations only; `validated_workloads` stays empty.

The executable FEM M1 v1 slice is deliberately narrower than the general
model: CPU, double precision, `execution_mode=strict`, conforming H1/P1,
transparent interfaces, and no LLG/Oersted stage coupling. Its C ABI has one
linear tolerance/iteration policy shared by the charge CG and spin GMRES
solves. Planning therefore requires the authored charge and spin linear
policies to be exactly equal; it must never synthesize a hidden policy with
minimum tolerances or maximum iteration counts. The resolved descriptor keeps
the distinct `cg` and `gmres` engine identities, the charge/spin domain masks,
explicit insulating marker sets, transparent interface identities, and any
authored torque target. Capability status is `reference_executable`; the
independent evidence axes are `implementation_state=executable` and
`validation_state=algebra_validated` for the exact bounded validation scope.
Mixing/SML, specified spin flux, periodic spin boundaries, and normal current
electrodes fail before native execution.

Every successful FEM M1 solve publishes revisioned canonical field records for
`V_electric` (`V`, scalar), `J_charge` (`A/m^2`, `xyz`), `spin_potential`
(`V`, `xyz`), `spin_current_tensor` (`A/m^2`, nine components in
`row_major_Q_ia` order), and `torque_stt` (`1/s`, `xyz`). These are node-located
and scoped to the named transport module's full resolved solve domain. The
runner publishes them through the canonical `ExecutedRun.field_snapshots`
carrier with monotonic revisions; the v2 field resource/data plane reads the
persisted field artifacts. The summary transport artifact is supplementary and
is not a substitute for these quantity records.

Artifact persistence is owned by the run's `ArtifactRecorder`: streaming runs
must enqueue these records before the pipeline is closed, while in-memory runs
must serialize the same catalog-owned units and component metadata. M1 accepts
exactly one steady FEM transport module per run because the current v2 field
resource identity is the canonical quantity id; multiple module-scoped records
with the same quantity id fail before native execution rather than overwriting
one another. Requested field schedules for these steady quantities select the
already-solved records and must not query the time-domain FEM preview ABI.

(cd-terminal-transport-publication)=
### 4.CD. Prerejestracja C+D: terminalny accepted transport i historia

Status: **planned_contract; niewdrożone; runtime NOT VERIFIED**. Pełny dokładny wire,
required fields/defaults/units/hash, limity, publisher i consumer contracts:
[specyfikacja §14](../specs/frozen-spins-v1.md#cd-terminal-publication-preregistration).
Rozdział nie zmienia równań M3 ani ARS. coupled.previous_dt_s pozostaje outer accepted dt,
a TransientSpinState.previous_dt_s historią ostatniego inner residual half.

C+D jest atomem terminal publication zakończonego etapu. Snapshot V2 semantic preimages
pochodzą raz z jednego accepted bundle, po normalnym writer drain i przed drop engine/workflow;
nie serializujemy ich w StepStats/per-step hooku. Runner nie zna claimu i nie nadaje
artifact/CAS IDs; istniejący publisher buduje owner-qualified bindings. Nowy manifest V4
completed wymaga prawdziwej coverage wszystkich wyemitowanych próbek. Nie empty fallback.
Historię reprezentuje thin index/page -> actual CPU snapshot JSON/scalar-row bytes,
nie inline Vec wszystkich M. Nowy generic bounded history decoder jest planowany,
nie utożsamiany z final m_final codec. Snapshot metadata <=64KiB, history root/page<=4MiB;
pełny field/grid/output budget obowiązuje dodatkowo.

| Parametr kontraktu | Typ / default | SI | Walidacja / owner |
|---|---|---|---|
| semantic clock | existing ObservationClock / required | $\mathrm{s}$ dla time/dt | ten sam accepted frame; actual CPU reference |
| primary_carriers | exactly4 SemanticCarrierV2 / required | $1$ | existing engine/M3/frozen/activation values; bez manifest cycle |
| accepted_state_ref.generation | existing typed reference / required | $1$ | rzeczywisty claim epoch; publisher |
| history sample time/dt | finite f64 / required | $\mathrm{s}$ | exact writer job clock; scalar CSV15e nie jest bit-exact clock storage |
| history values | existing sample bytes / required | unit existing quantity catalog | scalar/field decode sample-by-sample; bez nowego formatu physics |
| coverage | typed schedule/cause/count / required | $1$, czasy $\mathrm{s}$ | actual outputs; missing/empty mismatch odmawia publication |

| Lane dla nowego C+D | Stan |
|---|---|
| FDM CPU double M3 | planned_contract, unqualified, bez ExactResume admission |
| FDM GPU / single / hybrid | poza zakresem, bez capability promotion |
| FEM CPU | poza tym FDM checkpoint codec; aktualne transport statusy bez zmian |
| FEM GPU | poza tym FDM checkpoint codec; aktualne transport statusy bez zmian |

Python/ProblemIR: brak nowego authored parametru i brak zmiany loweringu; requested intent
pozostaje oryginalne, resolved execution nadal jawne. Validation errors dla missing carriers,
raw/hash/count/clock/lineage mismatch są fail-closed; unsupported combinations pozostają
Unsupported. Wymagane przyszłe dowody: real producer->publisher->completion/cold reader,
bounded multi-frame IO, pruning/archive i fault injection oraz później publiczny resume.
Nie wykonano tych gates przez source/doc validator.

(validation)=
## 5. Validation strategy

### 5.1 Analytical and algebraic checks

| Workload | Oracle |
|---|---|
| `charge_uniform_bar_v1` | linear `V`, constant conserved current |
| `charge_layered_series_v1` | exact series resistance |
| `spin_1d_diffusion_v1` | sinh/cosh profile |
| `spin_relaxation_modes_v1` | reaction eigenvalues |
| `she_1d_film_v1` | SHE profile with zero-flux/mixing BC |
| `mixing_flux_balance_v2` | reservoir interface algebra, entropy and torque sign |
| `theta_sh_zero_v1` | no SHE source |
| `lambda_limits_v1` | disabled-reaction limits |
| M2 affine constitutive oracle | exact affine `V=x`, `mu_s=(u_x,u_y,u_z)x` cube solution and projected `J_c`, `Q_ia` values |
| M2 Onsager oracle | reciprocal signs and nonnegative dissipation |
| M3 decay | exponential and diffusion-eigenmode decay |

### 5.2 Cross-backend and convergence qualification targets

The production qualification still requires each continuum workload at at least
three spatial resolutions and independent FDM/FEM mesh families. Common-limit
FDM/FEM convergence, GPU-double vector/tensor parity, M3 temporal order, and
stiff-limit convergence to steady M1/M2 are not established by the current M1
reference slice. BORIS and published models remain planned comparisons after
explicit unit/sign conversion, not primary proof.

Historyczna macierz referencyjna FDM CPU-double M2 obejmowała trzy
rozdzielczości N/F i dwie tolerancje z niezależnymi residualami charge/spin;
jej zapis w audycie nie jest wykonaniem aktualnego adaptera ani nową
kwalifikacją. Historyczne porównanie BORIS po `Q_ia=Js_ia/MUB_E` pozostaje
diagnostyczne: poprawa potencjału nie zamyka zgodności `mu_s`, strumieni
interfejsowych ani torque.

Aktualny `scripts/run_boris_fullmag_she_nf_matrix.py::run_resolution_matrix`
wykonuje wyłącznie na Windows sześć przypadków **Fullmaga**: trzy istniejące,
odrębne managed BORIS CPU `runtime.v2` coarse/medium/fine są ponownie używane
przy dwóch tolerancjach Fullmaga (domyślnie $10^{-8}$ i $10^{-10}$).
Tolerancja BORIS pozostaje stałym parametrem jego managed scenariusza;
nie jest to sweep tolerancji BORIS ani przywrócenie dawnych siatek 10/20/40.
`_require_reference_pin` sprawdza dokładne bytes summary/runtime/receipt/scenario
wokół normalizacji, wykonania Fullmaga i porównania; binaria Fullmaga mają
osobne piny. Drift przerywa macierz, a `validate_matrix_summary` kontroluje
strukturę/metryki bez ponownego wykonania i bez nadania authority runtime.
Nowej macierzy, benchmarku i zgodności solverów **nie zaliczono**.

`scripts/run_fullmag_m2_nf_reference.py::_problem` przypisuje część urojoną
interfejsu `spin_transport_modules[0].interfaces[0].g_i_Spm2` z
`BORIS_GMIX_SPM2[1]`, tego samego elementu pary co metadata
`transport.Gmix_Spm2[1]` i jawne `ferromagnet.param.Gmix[1]` w generowanym
scenariuszu BORIS. Jednostką jest $\mathrm{S/m^2}$. Scalar `BORIS_GI_SPM2`
opisuje inny parametr kanałów interfejsu; nie jest źródłem imaginary mixing.
Dla obecnego scenariusza zadane $G_i=0$ zastępuje omyłkowe $5\times10^{14}$
w rzeczywistym IR. Publiczne lowering i niezależny odczyt AST renderera
sprawdzają coarse/medium/fine. To kontrola tego przypisania wejścia,
**nie** zgodności całego modelu, native execution ani pełnego complex mixing.
Pozostałe różnice kanałów, reakcji, zakresu magnetycznego, sterowania
terminalami i ewolucji pozostają niezakwalifikowane; dotychczasowych
porównań i momentów `incomparable` nie promuje się do PASS.

The bounded FEM CPU M2 lane also has a nontrivial managed constitutive oracle,
`just verify-fem-steady-transport-m2-affine-contract`. It uses a
six-tetrahedron unit cube with Dirichlet faces at `x=0` and `x=1`, uniform
`m=e_x`, `sigma=3 S/m`, `sigma_parallel=6 S/m`, `sigma_perpendicular=4 S/m`,
`sigma_s=5 S/m`, `P=0.25`, zero SHE/AHE, and disabled spin-reaction lengths.
The exact solution is

```text
V=x,  mu_s,a=u_a x,  u=(0.2,0.3,0.4),  E_x=-1 V/m,  G_xa=-u_a/2 V/m.
```

Consequently the expected nonzero constitutive entries are

```text
J_c,x = -6 - 0.5*0.25*3*u_x A/m^2,
Q_xa = -0.5*5*u_a - 0.25*3*delta_{a,x} A/m^2,
```

with all transverse flow components zero. The managed native ABI contract
checks the nodal fields, the node-major vector/tensor projection, convergence,
and these values to `1e-8` absolute error. It then executes two additional
single-gradient affine drives: a charge-only state with $E_x=-1\,\mathrm{V/m}$
and a spin-only state with $G_{xx}=-1/2\,\mathrm{V/m}$. The measured cross
responses satisfy

```text
Q_xx(E_x)/E_x = J_x(G_xx)/G_xx
```

to `1e-8`, and both diagonal powers $E\mathbin{\cdot}J_c$ and
$G\mathbin{:}Q$ are positive. This is an executable two-drive Onsager and
dissipation oracle for the bounded FEM M2 constitutive block. It does not
close a parameter/mesh sweep, heterogeneous-material balance, FDM/FEM
reciprocal common-limit, or production qualification.

The managed FEM contract also runs the bounded reciprocal problem on three
conforming tetrahedral meshes (`N_x=8,16,32`) with finite
`lambda_sf=0.3 m`, nonzero polarization, and natural transverse boundaries.
The midpoint values were `V=(0.527052,0.526914,0.526879) V` and
`mu_{s,x}=(0.175368,0.177036,0.177449) V`; the coarse-to-fine versus
medium-to-fine errors were respectively `1.72849e-4/3.42662e-5 V` and
`2.08109e-3/4.12567e-4 V`. Both errors decrease under refinement. This is a
bounded one-dimensional-invariant FEM convergence gate, not a full 3-D
parameter sweep, an FDM/FEM common-limit, or a production qualification.

The managed runner now also executes a reciprocal FDM↔FEM common-limit fixture
with the same SI data on both discretizations: `sigma=4 S/m`,
`sigma_s=5 S/m`, `sigma_parallel=6 S/m`, `sigma_perpendicular=3 S/m`,
`P=0.25`, `theta_SH=sigma_AHE=0`, `lambda_sf=0.3 m`, `m=e_z`, and matched
charge/spin Dirichlet data on the `z` electrodes. The cell-centred FDM values
are compared with volume-consistent FEM plane averages on `N_z=8,16,32`
conforming tetrahedral meshes. The maximum potential differences are
`5.60270e-4`, `1.62324e-4`, and `4.35987e-5 V`; the maximum `mu_{s,z}`
differences are `6.72230e-3`, `1.94772e-3`, and `5.23159e-4 V`. Both
discretizations satisfy their independent residual/balance gates and the
cross-backend error decreases under refinement. This closes only the uniform,
finite-spin-flip, no-Hall reciprocal common-limit fixture; heterogeneous
materials, interfaces, GPU parity, and production qualification remain open.
A separate bounded 3-D nonzero-SHE/iSHE/AHE gate is documented below.

An executable managed BORIS N/F smoke now completes at `coarse`, `medium`, and
`fine` resolutions in the pinned CUDA image
`nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f`
with BORIS 2022 version 4 on an RTX 4080 SUPER (compute capability 8.9). The
stage marker, all N/F OVF fields, and an immutable runtime identity are present.
This is execution evidence only: the artifact deliberately remains
`qualification.status=diagnostic`. The coarse and medium meshes have no
interior cells for the residual stencil, so their zero residuals are vacuous;
the fine normal-metal spin residual is `3.7620952779e-2`, above the declared
`1e-5` tolerance (the fine ferromagnet residual is `1.0362313921e-9`). The
interface charge and spin-torque closures are retained as raw diagnostics and
are not accepted as balanced. Consequently the run does not close BORIS
convergence, N/F interface balance, or Fullmag↔BORIS parity.

#### 5.2.1 BORIS residual units and scope

The BORIS display contract is not dimensionally identical to the Fullmag field
catalog. In `Transport_Spin_Display.cpp`, the native spin accumulation is
`S [A/m]` and the displayed tensor `Js_ia` is `A/s`; the latter is an angular
momentum-current representation, not a charge-equivalent current density. The
adapter therefore uses

```text
V_s       = De S/(sigma MUB_E),
mu_s      = 2 V_s,
Q_ia      = Js_ia/MUB_E [A/m^2].
```

An independent residual must use one unit system consistently. In native BORIS
variables, a homogeneous normal-metal interior obeys

```text
R_S,a = partial_i Js_ia + De S_a/lambda_sf^2 = 0,
```

where the direct-SHE contribution is already present in `Js`. The equivalent
Fullmag form is

```text
R_Q,a = partial_i Q_ia + sigma mu_s,a/(2 lambda_sf^2) = 0.
```

Adding `partial_i Js_ia` to the Fullmag reaction term mixes `A/(m s)` and
`A/(m^3)` and introduces a spurious factor `1/MUB_E`. A residual scale must
also have divergence units (for example `max(|Js|/h, |De S|/lambda_sf^2)`),
not the current magnitude `max(|Js|)`. A validator that violates either rule
can report orders-of-magnitude false residuals even when BORIS' discrete
Poisson equation is satisfied.

The ferromagnetic BORIS equation is a separate scope: it adds transverse
exchange/dephasing terms (`l_ex`, `l_ph`) and, when enabled, magnetization-drift,
topological-Hall, or pumping sources. A normal-metal scalar residual must never
be applied to an F mesh; an N/F comparison either evaluates those terms from an
explicit material/magnetization manifest or marks the F residual unsupported.

(boris-flow-major-unit-adapter-v2)=
#### 5.2.2 Adapter BORIS: kolejność indeksów i jednostki v2

Adapter `fullmag.boris_flow_major_units.v2` naprawia mapowanie danych; nie
zmienia równań transportu, publicznego Python DSL, `ProblemIR`, capabilities
ani realizacji żadnej z czterech lane FDM CPU/GPU i FEM CPU/GPU. Nie kwalifikuje
ich przez podobieństwo wyników BORIS. Właścicielem mapowania jest
`scripts/compare_boris_fullmag_she_nf.py::normalize_boris_artifact`.

Dla BORIS `048503d2ca6475e91b073eb1762ecf9d3634c3e1`,
`Transport::GetSpinCurrent(component)` wybiera kierunek przepływu. `Jsx`, `Jsy`,
`Jsz` zawierają odpowiednio wiersze przepływu x, y, z; komponenty XYZ każdego
wiersza oznaczają polaryzację spinu. Fullmag zachowuje indeks przepływu $i$
i polaryzacji $a$ w `row_major_Q_ia`: xx, xy, xz, yx, yy, yz, zx, zy, zz.
Nie należy transponować tych wierszy. Dane OVF są x-fast; adapter zachowuje
kolejność punktów domeny N, następnie F na wspólnej siatce z-normalnej.

| Wielkość | Wejście BORIS | Wyjście/odmowa adaptera |
|---|---|---|
| Potencjał ładunku | $V$ w $\mathrm V$ | $V$ w $\mathrm V$; porównanie dopuszcza tylko stały offset gauge |
| Potencjał spinowy | $\mathbf S$ w $\mathrm{A\,m^{-1}}$ | pełne splitting voltage $\boldsymbol\mu_s$ w $\mathrm V$, zgodnie z mapowaniem 5.2.1 |
| Prąd spinowy | $J^s_{ia}$ w $\mathrm{A\,s^{-1}}$ | $Q_{ia}$ w $\mathrm{A\,m^{-2}}$, przez dokładne historyczne `MUB_E=5.788381608e-05` w $\mathrm{m^2\,s^{-1}}$ |
| Strumień normalny | wszystkie polaryzacje wiersza `Jsz` | znak skoku wynika z zadanej normalnej; pola osi przepływu nie są osiami polaryzacji |
| Torque `Tsi` | $\mathrm{A\,m^{-1}\,s^{-1}}$ | pozostaje `boris_tsi_A_per_m_s`, nieporównywalny z Gilbert source w $\mathrm{s^{-1}}$ bez osobnego modelu `tsi_eff`/gamma |

Bilans interfejsu jest ponownie wyznaczany z tych samych surowych OVF przez
`scripts/verify_boris_nf_interface.py::compute_interface_slice`, a nie
przejmowany z historycznego `summary.json`, które mogło zawierać transpozycję.
Pozostaje diagnostyką; mieszanej jednostkowo różnicy strumień–torque nie
przedstawia się jako bramki parity. Residuals zachowują provenance historycznego
wejścia i nie otrzymują automatycznie nowej kwalifikacji.

`scripts/verify_boris_tensor_adapter.py::main` sprawdza surowe pliki OVF:
osiem punktów N/F, 72 różne podpisane składowe, kolejność punktów, splitting
voltage, normalną ±z, ponowny odczyt z celowo błędnym historycznym bilansem
oraz odmowę porównania torque. Hashe trzech przypiętych plików BORIS, w tym
`Funcs_Math_base.h`, są sprawdzane przed oceną adaptera. Nie dopasowuje się
współczynnika ani globalnego znaku do wyników solvera.

Dowód 11.10.2026: poprzedni adapter RED, exit 1, 48 błędnych składowych
pozadiagonalnych; poprawiony GREEN, exit 0, 72/72 składowych, oba znaki normalnej.
Raporty zachowano pod `storage/runs/antenna-transport-e2e-20261011-5e7f0d529ca256ef/e1/`.
To **kwalifikacja adaptera na fixture**, nie ponowne wykonanie benchmarku
BORIS–Fullmag ani dowód bilansu fizycznego solverów. Historyczne porównania
pozostają historyczne. Nowy benchmark wymaga oddzielnie źródeł, binariów,
parametrów i wyników obu solverów oraz niezależnej walidacji znaków SHE/iSHE.

### 5.3 Regression and quantitative gates

Tests cover local FV residual, electrode balance, anisotropic N/F balance,
material jumps, normal
involution, tensor component order, missing gauge/conflicting BC, positivity,
stage refresh, nonlinear rejection/rollback, checkpoint/restart, strict-GPU
transfer audit, and full authoring/export/data-plane inspection. Starting
double linear residual is `1e-10`; FP32 is `1e-6`. Charge balance targets
`1e-10` double and `1e-6` single; spin flux/torque balance is at most ten times
linear-solver relative tolerance.

## 6. Completeness checklist

- [ ] Python transport API and validation
- [ ] ProblemIR, migration, planner, and capabilities
- [ ] FDM CPU M1 oracle and M2/M3 implementations
- [ ] FEM CPU/MFEM M1 oracle and M2/M3 implementations
- [ ] FDM/FEM GPU FP64 parity and strict residency
- [ ] Physical M3 IMEX integrator and common rollback
- [ ] Quantities, tensor codec, telemetry, and provenance
- [ ] Resource-first API and dedicated workspace inspectors
- [ ] Cross-backend convergence and managed/browser evidence

Unchecked items are not implied by publication of this note.

(limitations)=
## 7. Known limits and deferred work

Ballistic and tunnelling transport, first-principles interfaces, Rashba–Edelstein
physics, spin pumping, eddy/displacement currents, higher-order FEM, and hybrid
domain coupling require separate notes. Spin pumping cannot be hidden in
`alpha`; dimensionless SML parameters need explicit conversion.

### 7.1 FEM CPU M1.3 implementation evidence

The native module `backends/fem/cpu/mfem/transport/steady_transport.*`
implements the CPU-double, conforming `H1 P1` M1 oracle for transparent
interfaces under formula
`transport_constitutive.one_way.fullmag.v1` and operator
`fem_charge_spin_conforming_h1_p1.transparent.v1`. It owns charge/spin spaces,
assembly, essential voltage/spin-potential boundary data, insulating natural
boundaries, charge gauge validation, CG/GMRES solves, consistent `L2` torque
projection, independently reassembled weak residuals, and global conservative
flux/reaction balance outside `Context` and `mfem_bridge.cpp`.

The managed gate `just verify-fem-steady-transport-native-contract` executes a
linear charge bar, an aligned two-material series-resistance interface, missing
gauge rejection, the one-dimensional spin-diffusion `sinh` profile, direct-SHE
sign and balance, torque projection, and fail-closed mixing-interface behavior.
This evidence publishes only the named `reference_executable`, CPU-double,
conforming-`H1 P1`, transparent-interface M1 slice through ProblemIR, planner,
native runtime, canonical quantities, artifacts, and v2 reads. It is not a full
production transport capability. Total-current and periodic electrodes,
specified spin flux, `H(curl)`/broken-H1 mortar mixing or SML,
hypre/libCEED production preconditioners, GPU residency, stage coupling, and
general heterogeneous FDM/FEM common-limit convergence remain unchecked work;
the bounded uniform M1/M2 fixtures are documented below.

### 7.2 FEM CPU M2 bounded reciprocal implementation evidence

The native FEM CPU lane now contains a deliberately bounded M2 realization. It
uses one monolithic conforming `H1 P1` block system for
`(V,mu_sx,mu_sy,mu_sz)` and the reciprocal constitutive tensor from section
2.2. The charge block includes the symmetric AMR/PHE tensor and AHE term;
the `P` and SHE/iSHE off-diagonal blocks are assembled together and solved by
GMRES. The C ABI is a separate symbol,
`fullmag_fem_solve_steady_transport_m2_v1`, and its request appends
`sigma_parallel`, `sigma_perpendicular`, and `sigma_AHE` after a nested,
self-describing `fullmag_fem_steady_transport_request_v1` prefix. This keeps
the M1 ABI layout stable while making the reciprocal material explicit.

The executable scope is intentionally narrower than the physical M2 contract:
CPU, FP64, `execution_mode=strict`, full-domain conforming H1/P1, one uniform
anisotropic charge tensor, one uniform spin material, a Dirichlet charge
reference, no internal spin interfaces, no mixing/SML, no reciprocal nonlinear
Picard policy, and no LLG/Oersted stage coupling. The planner rejects a missing
or non-positive Schur complement
`min(sigma_parallel,sigma_perpendicular)*sigma_s - P^2*sigma^2`, rejects
heterogeneous charge tensors in this lane, and never falls back to FDM or to
the M1 one-way solver. The native wrapper publishes the constitutive/operator
versions and reciprocal residual/balance diagnostics in provenance.

The managed evidence is split into four independent gates: the Rust ABI layout
test, the planner test
`resolves_bounded_fem_m2_to_reciprocal_descriptor_without_fallback`, the exact
runner-to-FFI materialization test, and the native runtime test
`native_m2_solver_publishes_reciprocal_diagnostics`. Together with the managed
`just verify-fem-steady-transport-native-contract` M1 regression gate they prove
an executable bounded FEM M2 slice, not a general FEM M2 qualification. No
`validated_workloads` entry is claimed: Onsager/dissipation sweeps,
heterogeneous materials, N/F/T interfaces, GPU residency, BORIS parity,
transient coupling, and production qualification remain open. A separate
managed runner gate now covers the uniform reciprocal FDM↔FEM common limit;
it is evidence for that exact fixture only and does not promote the general
capability.

The common-limit gate uses the same SI descriptor in both backends and compares
FDM cell-centred values against FEM plane-averaged values on `N_z=8,16,32`.
For `sigma=4`, `sigma_s=5`, `sigma_parallel=6`, `sigma_perpendicular=3`
S/m, `P=0.25`, `lambda_sf=0.3 m`, `m=e_z`, and zero Hall coefficients, the
maximum potential differences are `5.60270e-4`, `1.62324e-4`, and
`4.35987e-5 V`; the corresponding `mu_{s,z}` differences are `6.72230e-3`,
`1.94772e-3`, and `5.23159e-4 V`. Both independent residual/balance checks
pass and the cross-backend error decreases under refinement. This remains a
uniform, no-interface, no-Hall CPU-double reference gate.

The FDM side also has a managed heterogeneous-interface gate:
`just verify-fdm-m2-heterogeneous-interface-contract` executes the anisotropic
N/F balance fixture and the nonzero mixing-conductance fixture with separate
backflow, transverse absorption, SML, and torque accounting. Both tests pass in
the managed CUDA image (CPU-double engine lane). This demonstrates that the
FDM reference can carry explicit region IDs and oriented interface laws; it is
not FEM interface support or FDM↔FEM parity, and it does not qualify a
production N/F/T workload.

The reciprocal common-limit sweep now also has a genuinely three-dimensional
SHE/iSHE/AHE fixture, executed by
`just verify-fem-steady-transport-m2-3d-common-limit-contract`. It uses
`m=(1,0,0)`, `theta_SH=0.1`, `sigma_AHE=0.2 S/m`, the same reciprocal
conductivities and finite `lambda_sf=0.3 m` as the uniform fixture, and
insulating transverse faces. FDM and conforming tetrahedral FEM are refined
together at `(n_x,n_y,n_z)=(2,2,4),(4,4,8),(8,8,16)`. The managed run passed
with independent charge/spin residual gates and produced maximum
FDM↔FEM plane-profile differences of
`(1.14404e-4,1.93287e-2)`, `(1.59387e-4,6.51759e-3)`, and
`(5.65483e-5,1.88431e-3)` for `(V,mu_s)`; the transverse spin potential is
nonzero in every resolution. The charge cross-error is not required to be
monotone at every intermediate mixed refinement because the FVM and P1 mass
weights are different; the gate requires a lower fine-grid charge error than
both coarser runs, strictly decreasing spin error, and a fine envelope below
`1e-3 V`/`5e-2 V`. This is bounded CPU-double 3-D common-limit evidence, not
FEM interface support, GPU transport parity, BORIS parity, or a
`validated_workloads` promotion.

The native ABI contract additionally executes the affine cube oracle described
in section 5.2. It is deliberately a separate `just` target so a zero-gradient
ABI smoke cannot mask a constitutive sign or `G=-\nabla\mu_s/2` factor error.

### 7.3 Bounded public FDM GPU charge-only path

The public `CurrentTransport` path has two deliberately bounded executable
profiles. `resolve_fdm_gpu_charge_transports` lowers the Python/ProblemIR
module to a versioned `ResolvedFdmGpuChargeTransportIR` only when the request
is explicit FDM/CUDA, FP64, strict, one-way OhmicPoisson and a full rectangular
active grid. The first profile uses two opposite voltage faces, four insulating
faces and `boundary_reference_per_component`. The second uses exactly two
opposite, single-surface `NormalCurrentElectrode` faces on one axis, four
insulating faces, `zero_mean_per_free_component`, and the native-equivalent
compatibility condition obtained after assembling every exterior
$-A_fJ_{n,f}$ term into its adjacent-cell RHS. Before either profile reaches
the ABI, the planner and runner reproduce the native scalar internal-face
conductance in finite precision,
$g_a=[2/(1/\sigma_i+1/\sigma_j)]A_a/h_a$, for every adjacent cell pair. The
bounded full-grid profile is admitted only when every such $g_a$ is finite and
strictly positive. Together with the already-required full active rectangle,
this proves exactly one numerically connected component; zero, NaN, or infinite
conductance fails closed with
`charge_domain=not_single_numerically_connected_component`. The component rule
in the CUDA owner is therefore normative: the public single-component slice may
use one global assembled RHS compatibility reduction, but it does not silently
reinterpret a numerically disconnected grid as a multi-component transport
problem. The runner adapter
`execute_public_gpu_charge_only` maps both profiles to the append-only CUDA M1
charge ABI and publishes `V_electric`, `J_charge`, and a transport provenance
artifact. CPU, `auto`, unknown execution values, partial masks, PBC,
spin/SHE/STT/SOT, Oersted coupling and implicit fallback are rejected before
execution.

The managed gate `just verify-fdm-gpu-public-charge-runtime` executes the
fixture `examples/fdm_gpu_charge_public.py` on a 2 x 1 x 1 grid. An independent
oracle script checks the cell-centred affine solution
$V=(0.025,0.075)\,\mathrm{V}$ and
$J_x=-\sigma\,\partial_xV=-2.0\times10^{13}\,\mathrm{A/m^2}$ for
$\sigma=4.0\times10^6\,\mathrm{S/m}$ and a 0.1 V drop over 20 nm; the
transverse current is zero. The run completes on the identified RTX 4080
SUPER with no fallback, algebraic residual
`8.201001214742106e-21`, physical residual
`1.3810679320049756e-16`, and `iterations=2`. This is a bounded executable
reference slice with actual-device evidence, not a `validated_workloads`
entry or general production qualification.

The first managed attempt exposed an ABI indexing error: `canonical_face_index`
is local to each flux axis (`Jx`, `Jy`, `Jz`), not a globally offset index
stream. The Rust adapter now uses axis-local formulas and validates uniqueness
on `(axis, canonical_face_index)`; the regression test
`expanded_boundary_faces_use_axis_local_canonical_indices` freezes this rule.

The pure-Neumann managed gate
`just verify-fdm-gpu-public-charge-zero-mean-runtime` runs
`examples/fdm_gpu_charge_zero_mean_public.py` through the same public path.
For a $20\times10\times10\,\mathrm{nm^3}$ bar with two $10\,\mathrm{nm}$
x-cells, $\sigma=4.0\times10^6\,\mathrm{S/m}$,
$J_n(x_{\min})=+2.0\times10^{13}\,\mathrm{A/m^2}$ and
$J_n(x_{\max})=-2.0\times10^{13}\,\mathrm{A/m^2}$, the stored axis current
is $J_x=-2.0\times10^{13}\,\mathrm{A/m^2}$ because $J_n=\mathbf n\cdot
\mathbf J_c$ and $\mathbf J_c=-\sigma\nabla V$. Hence the zero-mean
cell-centre oracle in increasing x order is
$V=(-0.025,+0.025)\,\mathrm{V}$. Publiczny preflight odtwarza każdy rekord
zewnętrznej ściany pełnej siatki (łącznie
$2(n_y n_z+n_x n_z+n_x n_y)$), wymaga dokładnego pokrycia bez duplikatów oraz
sprawdza zgodność `axis`, `side`, `canonical_face_index`, `adjacent_cell` i
`area_m2=hy*hz`, `hx*hz` albo `hx*hy` z relatywną tolerancją $10^{-12}$.
Następnie planner i runner wykonują tę samą kolejność składania ownera CUDA:
dla każdej komórki i jej zewnętrznych ścian odejmują skończony termin
$A_fJ_{n,f}$ od $rhs_i$, a dopiero potem liczą
$r=\sum_i rhs_i$ i $\|rhs\|_1=\sum_i|rhs_i|$. Warunek kompatybilności brzmi
$|r|\le64\,\epsilon_{\mathrm{f64}}\|rhs\|_1$; przy zerowej skali legalne jest
wyłącznie dokładne zero. Dzięki temu przypadek $1\times1\times1$, w którym
dwie przeciwne elektrody trafiają do tej samej komórki, ma identyczną decyzję
Rust i CUDA. The verifier also requires finite,
non-negative physical, component and electrode balances below $10^{-12}$ and
provenance `gauge_policy=zero_mean_per_free_component`. This is an electrical prerequisite
for later solved-current racetrack/SHE-to-SOT/STT/Hall and current-derived
Oersted work; it does not itself enable any spin torque, Hall observable or
Oersted field.

The managed CUDA run completed with `iterations=1`, algebraic residual
`4.1150157270026995e-17`, physical residual `0.0`, component balance `0.0`,
and electrode balance `0.0`. It returned the prescribed cell-centre values
`[-0.024999999999999994, 0.024999999999999994] V` and
`[-2.0e13, 0, 0, -2.0e13, 0, 0] A/m^2`. The identified device was the RTX
4080 SUPER UUID `fcb9fbf1828437c7af5b76bcbf2d2937`, CUDA runtime `12040`,
driver `13010`, build digest
`d396670cc86f5b79b208d812b7a1aca52a73ead18ab48b6c00141dd3c558c96a`.

The remaining public charge work includes larger and masked domains,
convergence and sanitizer gates, cross-backend parity, and the complete
spin/SHE/M2/M3/FEM paths.

(fem-steady-transport-identity)=
### Tożsamość naukowego artefaktu FEM steady transport

Surowy `fullmag.fem.steady_spin_transport.v2` zawiera obowiązkowy dla kwalifikacji,
addytywny blok `modules[].transport_identity` ze schematem
`fullmag.fem.steady_transport_identity.v1`. Starszy artefakt bez tego bloku pozostaje
odczytywalny diagnostycznie; checker odmawia kwalifikacji. Blok powstaje z
`prepared.request` zaakceptowanego przez preflight, a nie z pliku IR wskazanego przez
odbiorcę. Nie zmienia równań, ABI ani statusu capability. Implementacja źródłowa
nie jest dowodem realnego wykonania; nowy pakiet i rzeczywisty przebieg managed
pozostają wymagane.

| Pole / grupa pól | Typ, obowiązek i walidacja | Jednostka SI | Znaczenie i źródło |
|---|---|---|---|
| `schema`, `digest_codec`, `mesh_topology_codec` | wymagane, dokładne wersje v1/v1/v3 | $1$ | kontrakt metadanych i encoderów |
| `request_sha256`, `descriptor_sha256`, `result_sha256` | wymagane `sha256:` + 64 cyfry hex; ponownie obliczane | $1$ | odpowiednio actual request, opublikowany descriptor, cały opublikowany result |
| `request.module_id`, `current_source_id` | wymagane niepuste identyfikatory | $1$ | właściciel spin i charge source |
| `mesh_name`, `node_carrier` | wymagane; carrier `ordered_mesh_nodes_u32.v1` | $1$ | kolejność węzłów jest kolejnością carrier wyników; nie arbitralną permutacją |
| `mesh_topology_sha256` | wymagany canonical topology v3; finite współrzędne | $1$ | pełna kolejność nodes, cells/facets, global ordinals, mesh parts, markers i PBC |
| `node_count`, `cell_count` | wymagane całkowite dodatnie | $1$ | rozmiar faktycznego carrier; sam count nie potwierdza identity |
| `execution`, `interface`, `gauge`, `constitutive_model` | wymagane jawne identyfikatory actual request | $1$ | rzeczywista lane, przestrzeń/interface, gauge i M1/M2 |
| `constitutive_version`, `operator_version`, `physical_residual_version` | wymagane dokładne identyfikatory; zgodne z result | $1$ | zamrożone znaczenie operatora i bilansów |
| `charge_conductivity_Spm_per_element` | wymagane finite dodatnie, długość cell count | $\mathrm{S\,m^{-1}}$ | actual conductivity każdego elementu |
| `magnetization` | wymagane finite uporządkowane wektory, długość node count | $1$ | actual kierunki użyte do constitutive solve |
| `sigma_s_Spm` | wymagane finite dodatnie | $\mathrm{S\,m^{-1}}$ | actual spin conductivity |
| `sigma_parallel_Spm`, `sigma_perpendicular_Spm`, `sigma_ahe_Spm` | opcjonalne liczby finite, `null` dla M1 | $\mathrm{S\,m^{-1}}$ | actual reciprocal materiał, bez dopisywania M2 do M1 |
| `polarization_p`, `theta_sh` | wymagane finite, domena publicznego materiału | $1$ | actual charge/spin cross coefficients |
| `lambda_sf_m`, `lambda_j_m`, `lambda_phi_m` | dodatnie długości lub jawne disabled/null istniejącego request | $\mathrm{m}$ | actual reaction lengths; publiczny `lambda_sf_m` nadal wymaga finite dodatniej wartości |
| `gamma_e_per_Ts` | wymagane finite dodatnie | $\mathrm{s^{-1}\,T^{-1}}$ | actual gyromagnetic coefficient z planner |
| `saturation_magnetization_Apm` | wymagane finite dodatnie | $\mathrm{A\,m^{-1}}$ | actual magnetic normalization |
| `relative_tolerance`, `absolute_tolerance`, `maximum_iterations` | wymagane istniejące linear solver policy | $1$ | actual solver policy, bez dostrajania do wyniku |
| `charge_dirichlet` | uporządkowane pary MFEM boundary attribute i finite value | $\mathrm{V}$ | actual voltage BC; ID jest markerem, nie nodal index |
| `spin_dirichlet` | uporządkowane pary MFEM boundary attribute i finite xyz | $\mathrm{V}$ | actual spin-potential BC |

`fullmag.transport_tagged_json.v1` koduje `null`, bool, string, array, object
oraz liczbę osobnymi tagami `N/T/F/S/A/O/D`. Długości są `u64` little-endian,
stringi UTF-8, klucze object są sortowane, liczby finite binary64 little-endian,
a signed zero jest normalizowane. Całkowite wartości powyżej $2^{53}$ są odrzucane
przez ten encoder; mesh IDs zachowuje oddzielny canonical topology v3 bez tej
redukcji. SHA-256 ma prefix preimage `fullmag:transport-tagged-json:v1`.
Tożsamość topology jest wspólna z
`crates/fullmag-ir/src/mesh_hints.rs::MeshIR::mixed_topology_fingerprint_v3`
i `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py::MeshData::topology_fingerprint_v3`.

Publiczny checker generuje stage-first Python przez
`scripts/verify_transport_public_oracles.py::source`, obniża go przez
`fullmag.runtime.loader::load_problem_from_script` i porównuje intent
`current_modules`, `spin_transport_modules`, materiały, magnetization, geometry,
backend i study z tym samym publicznym fixture. Dla FEM M1 sinh wymaga $L=1\,\mathrm{m}$,
przekroju $0.1\,\mathrm{m}$ na $0.1\,\mathrm{m}$, $\lambda_{sf}=0.2\,\mathrm{m}$,
$\sigma=\sigma_s=4\,\mathrm{S\,m^{-1}}$, $P=\theta_{SH}=0$, jawnych existing FEM
operator IDs i identycznych charge/spin linear policies: tolerance `1e-12`,
absolute tolerance `0`, max iterations `10000`. Żadna BC ani mesh identity
nie pochodzi z wyniku solve; marker groups wyprowadza z topology i geometrii.
Istniejące bramki: max nodal spin error `<1e-3 V`, residual `<1e-10`, bilans `<5%`
scale flux/reaction, voltage error `<2e-10 V`. Bool/NaN/Inf są odrzucane.

`scripts/run_managed_transport_oracles.py::start` dopuszcza tylko terminalny,
zweryfikowany pakiet CPU z exact kapsułą źródeł i pinned image. Jedyna komenda
izolowanego kontenera tworzy publiczny fixture i pełny IR w tmpfs, wykonuje ten
sam IR oraz emituje jego hash i hash raw artifact do logu Dockera.
`::observe` ponownie atestuje komendę, mounty, lane, source capsule, pakiet,
startup stamp oraz zgodność retained files z tym manifestem. Receipt
`fullmag.managed-transport-oracles.v1` zachowuje source/native/build/image/binary
identity, IR/artifact/script hashes i actual transport identity. Sam plik receipt
nie jest dowodem: checker wywołuje ponownie `observe` przed bramką. Brak receipts,
stary producer lub obca siatka zwracają `not_verified`; przygotowanie zwraca
`prepared_not_run`. Katalog wyjściowy musi być nowy.

| Lane | Zakres dowodu tego kontraktu | Ograniczenie |
|---|---|---|
| FEM CPU | actual metadata + independent M1 finite-lambda sinh checker | real managed execution i nowy pakiet jeszcze niewykonane w tym kroku |
| FEM GPU | jawne odrzucenie dla tego checkera | brak kwalifikowanego operatora M2 GPU |
| FDM CPU | istniejące charge bar/sinh oracles, bez zmiany solvera | osobna ścieżka accepted artifact; ta FEM identity nie jest używana |
| FDM GPU | brak claimu | nie wolno zastąpić rzeczywistego urządzenia CPU fallbackiem |

M2 affine z wyłączonym spin-flip nadal nie przechodzi publicznego authoringu,
ponieważ publiczny `lambda_sf_m` wymaga finite dodatniej długości. Ten checker
nie kwalifikuje M2 ani nie zastępuje disabled reaction dużą długością.

### E1: luka zaufanego dowodu builda BORIS

(boris-managed-build-proof-gate)=

Existing source/runtime v1 nie wiążą trusted operator receipt ze źródłami,
compile flags i actual binary. SHA dowolnego caller JSON ani literal double
nie są takim dowodem. Legacy capture zachowuje observed source/binary/image
hashes, lecz identity_complete=false, precision=null oraz
build_proof_status=unverified. Nowy run i public benchmark verifier odmawiają.
Synthetic OVF mapping nie jest wykonaniem BORIS ani solver qualification.
Regresja `scripts/verify_boris_tensor_adapter.py::main` jawnie sprawdza odmowę
public admission, następnie używa prywatnego obliczeniowego helpera
`scripts/compare_boris_fullmag_she_nf.py::_normalize_boris_fields` dla raw OVF.
Helper nie nadaje runtime proof; public normalize_boris_artifact zawsze przechodzi
przez pełny verifier. Brak public allow-incomplete flag lub synthetic receipt.

| Generated pole / typ | Zakres i walidacja | SI / znaczenie |
|---|---|---|
| source manifest / JSON object | regular nonsymlink file, 1..1 MiB, UTF-8, unique keys; unknown schema bez authority | $1$; obserwacja, nie trusted build receipt |
| identity_complete / bool | false dla obecnego producer v1; caller true nie zastępuje receipt | $1$; completeness, nie science PASS |
| precision / nullable string | null bez verified source/compile proof; nie zgadywać double | $1$; precision pozostaje niezweryfikowana |
| build_proof_status / string | unverified; actual managed verifier jeszcze nie istnieje | $1$; jawna luka |

Proposed fullmag.boris.source.v2/runtime.v2 wymaga actual managed profile,
niezależnego receipt verifiera i exact binding pinned upstream/source-file
hashes, CPU overlay/flags, compiler/Python/link, worker/runtime image oraz
binary SHA. Manifest nie hashuje własnego checksumu. Caller JSON nie nadaje
complete/double. Profil boris-cpu-v1 ma teraz source-only fixed build producer; operator activation,
rzeczywisty build oraz trusted runtime admission pozostają NOT VERIFIED.
Nie zmienia się fizyka, normalizacja, tolerancje ani CPU/GPU qualification.

Źródła: scripts/run_boris_nf_interface.py::capture_runtime_identity,
validate_runtime_identity, run_boris_case oraz
scripts/verify_boris_nf_interface.py::validate_boris_artifact.

(boris-offline-toolchain-provisioning)=
### E1: offline toolchain BORIS i oddzielna bramka solvera

Producent `scripts/local_runner/boris_toolchain.py` oraz
`Dockerfile.boris-toolchain` przygotowują zależności zewnętrznego BORIS CPU.
Nie zmieniają Python DSL, ProblemIR, równań transportu, normalizacji ani
prerejestrowanych tolerancji. Historyczny runtime v1 i wcześniejszy benchmark
nadal nie mają admission. Kwalifikacja FDM CPU/GPU oraz FEM CPU/GPU Fullmaga
pozostaje określona przez ich własne bramki; obraz toolchaina jej nie rozszerza.

`dependency_selection` wybiera pełną bibliotekową domkniętą zależność trzech
korzeni: libfftw3-dev, libx11-dev i libtbb-dev. Dla przypiętego Ubuntu 22.04.5
jammy amd64 jest to 17 pakietów z zamrożonego zbioru 80 pobranych archiwów.
`validate_bundle` wiąże wersje, architekturę, Depends/PreDepends, świadków
pakietów bazowych, podpisane indeksy, URI i SHA256 archiwów. `install_apt`
wymaga identycznego bazowego inventory, sprawdza symulację bez usunięć lub
upgrade i instaluje wyłącznie wybrane lokalne archiwa z jawnym cache,
pustymi źródłami APT i `--no-download --no-upgrade --no-install-recommends`.
Zależności Python z pobranego zbioru APT nie są instalowane.

Bazowy NumPy 2.2.6 pozostaje pod
`/usr/local/lib/python3.10/dist-packages/numpy/__init__.py` z niezmienionym SHA256.
Osobny zamrożony bundle zawiera dziesięć prywatnych wheels: Matplotlib 3.8.4,
contourpy 1.2.1, kiwisolver 1.4.5, Pillow 10.3.0, fonttools 4.51.0,
packaging 24.0, pyparsing 3.1.2, python-dateutil 2.9.0.post0, cycler 0.12.1
oraz six 1.16.0. `validate_wheels` sprawdza release metadata, METADATA,
wersje, hashe i receipt bazowego importu; `install_wheels` rozpakowuje je bez
pip i sieci do `/opt/fullmag-boris-python`. Bundle nie zawiera NumPy.
Wybór wheels Matplotlib 3.8.4 wynika z ich budowania przeciw NumPy 2 przez
upstream [14]; rozszerzenia zbudowane przeciw NumPy 1 mogą być niezgodne z
NumPy 2 [15]. Deklaracja minimalnej wersji zależności nie jest dowodem ABI:
wymagany jest rzeczywisty import i zapis wykresu Agg.

| Parametr operacyjny / typ | Walidacja i pochodzenie | SI / znaczenie |
|---|---|---|
| base_image / string | exact sha256 image ID, amd64; inventory i wersje pakietów zgodne z lock | $1$; niezmienna baza |
| bundle, wheel_bundle / path | prywatny resolver storage; regular files, brak symlinków, zamrożone SHA256 i bounded membership | $1$; offline wejścia |
| context / path | `prepare_context`; lock, source freeze i hashe helpera/Dockerfile; jawny deny-default kontekst | $1$; powtarzalny build input |
| tag / string | `build_image`; ograniczony lokalny `fullmag/boris-toolchain:*` | $1$; etykieta, nie tożsamość |
| image_id / string | rzeczywisty Docker inspect po exit 0; lokalny alias bazy sprawdzony przed i po buildzie, zgodny prefiks RootFS layers | $1$; wynik provisioningu |
| runtime-preflight.json / JSON | `runtime_preflight`; rzeczywiste wersje i module paths, NumPy hash, linker paths FFTW3/X11/TBB, Python embedding flags oraz SHA256 PNG Agg | $1$; dowód toolchaina, nie solvera |

Obserwowany build wiąże bazę
`sha256:e360637ea8b00e280efdca7648ee022e6dd16150b10130b734425bb8a65b5aa0`,
lock SHA256 `8da46421ac443e529b6204493475f159d15329712aadbdd127326c90716095d8`
i wheel manifest SHA256
`93c00e46e23b2efe0c15aafb0e4ef1fe0dcd2620887684bd27476b5326842d2c`.
Osobny preflight zawiera te same bindingi; jego zakres pozostaje toolchainowy.

Kanoniczne wejścia operacyjne to `just runner-boris-toolchain-context` oraz
`just runner-boris-toolchain-image`. Build używa lokalnego frontendu i
`--network none --pull=false`; instalacja w obrazie następuje jako USER 0,
a finalny `USER 65532:65532` nie otrzymuje uprawnień instalacyjnych.
`build_image` zapisuje terminalny receipt pod resolverowym
`storage/builds/<worktree-id>/windows-native/boris-image-<id>/`.
Kontekst i receipt wiążą helper, Dockerfile, bazę, lock oraz wheel manifest.
Samo przygotowanie lub build obrazu nie zmienia konfiguracji koordynatora.

| Bramka / zakres | Stan obserwowany 2026-10-11 | Ograniczenie dowodu |
|---|---|---|
| Bazowy import dziesięciu wheels i Agg | PASS; `reviews/boris-python-wheels` | prywatny import, bez solvera |
| Offline build toolchaina przez `just` | PASS; image `sha256:dd3441d07c3aa19fe1e4a206c2926b42c89899a59bbc517eb890bd99657b079e` | receipt `boris-image-8ea0710662644c49820179099d46fd90/terminal-receipt.json`, status SUCCEEDED_IMAGE_ONLY |
| Finalny preflight UID 65532 | PASS; `reviews/boris-toolchain-final-image-v3/results/runtime-preflight.json` | readonly, network none, 2 CPU, 1 GiB, 128 pids; dziesięć importów z prywatnego katalogu, niezmieniony NumPy, trzy biblioteki linkera, embedding flags i Agg PNG |
| BORIS source-image i niezależny readback | PASS; szczegóły poniżej | dokładne źródła i toolchain, bez kompilacji solvera |
| Kompilacja CPU i ABI witness | NOT VERIFIED | wymagany terminalny build w zarządzanej kolejce |
| Managed runtime, public admission i benchmark | NOT VERIFIED | wymagany kompletny trusted łańcuch source/binary/ABI/runtime i niezależne bramki naukowe |
| Operator activation | nie wykonano | istniejąca kolejka i profile zachowane |

Receipt buildu ma kwalifikator NONROOT_RUNTIME_PREFLIGHT_AND_BORIS_NOT_VERIFIED;
osobny późniejszy preflight zamyka jedynie jego część toolchainową i ma
TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED. Nie nadaje identity_complete dla BORIS.
Następny etap po opisanym niżej source-image to jawna aktywacja operatora przy pustym
aktywnym slocie oraz kompilacja BORIS w tej samej kolejce Fullmag_build_runner.
Dopiero rzeczywisty witness ABI i managed runtime pozwalają sprawdzać nowy
benchmark; provisioning nie zastępuje żadnej z tych bramek.

(boris-offline-source-image-provisioning)=
### E1: przypięty source-image i rzeczywisty readback

`scripts/local_runner/boris_cpu.py::prepare_context` wymaga sześciu jawnych
wejść CLI: repo-root, boris-source, toolchain-image, toolchain-proof,
toolchain-context i toolchain-container. Receptura `just` dostarcza repo-root;
pozostałe pięć argumentów przekazuje operator. `admit_toolchain` odtwarza
bibliotekowy dependency graph i wheel admission, sprawdza frozen context/lock/
manifest binding oraz rzeczywisty terminalny kontener: exact image i container
ID, exit 0, brak OOM/running, UID 65532, readonly rootfs, network none, brak
privileged/GPU i dokładną komendę preflight. Dowód musi pochodzić z jedynego
bind mountu `/proof`; ścieżka i SHA256 wskazanego JSON muszą odpowiadać temu
rzeczywistemu outputowi. Caller JSON lub sam image ID nie zastępują admission.

Checkout BORIS musi być czysty na
`048503d2ca6475e91b073eb1762ecf9d3634c3e1`. `clean_blob_ids` sprawdza Git blob
identities z rzeczywistymi clean filters checkoutu, w tym CRLF; capture
zachowuje oryginalne checkout bytes i przypina ich SHA256, rozmiar i tryb.
Ponowny odczyt hashów i statusu przed zapisem odmawia drift. `validate_context`
wymaga exact bounded membership, producer/Dockerfile hashes, source manifest
oraz toolchain inspect/proof/context/container binding. Nie wykonuje overlay
CPU ani kompilacji podczas provisioningu.

| Parametr / typ | Domyślnie i walidacja | SI / znaczenie |
|---|---|---|
| repo-root / path | required; resolver właściciela worktree | $1$; storage/provenance owner, bez zmiany ProblemIR |
| boris-source / path | required; prywatny storage, clean pinned Git, brak symlink/gitlink, bounded bytes/files | $1$; oryginalne źródła |
| toolchain-image / string | required; installed immutable sha256 ID i zgodny inspect | $1$; dokładny toolchain |
| toolchain-proof / path | required; actual mounted runtime-preflight.json, freeze hashes i qualification TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED | $1$; ograniczony dowód narzędzi |
| toolchain-context / path | required; zamrożony kontekst pod storage/tmp, complete dependency/wheel admission | $1$; inputs provisioningu |
| toolchain-container / string | required; pełny 64-hex ID zachowanego terminalnego kontenera preflight | $1$; rzeczywisty execution binding |
| context, tag / path, string | required dla `build_image`; właściciel zgodny, tag `fullmag/boris-cpu:*`, immutable context hashes | $1$; source-image build, nie solver stage |

`Dockerfile.boris-cpu` kopiuje źródła, manifesty i helper do `/opt/fullmag-boris`
jako USER 65532:65532 i wykonuje tylko `validate-image-source`, czyli
`verify_source`. `build_image` używa lokalnego aliasu bazy sprawdzonego przed
oraz po buildzie, `--network none --pull=false`, sprawdza finalny USER i prefiks
RootFS layers toolchaina. Atomic terminalny receipt ma schema
fullmag.boris.source-image-build.v1, SUCCEEDED_SOURCE_IMAGE_ONLY oraz
BORIS_BUILD_AND_RUNTIME_NOT_VERIFIED. native_compilation_executed i
operator_changed pozostają false. Nie jest to trusted receipt solvera.

Rzeczywisty build przez `just runner-boris-image` zakończył się exit 0 obrazem
`sha256:545279e00703d60dcaf33d455461ba90e0dea7ec5647e96392bbc9246c21b6a6`,
z toolchainem `sha256:dd3441d07c3aa19fe1e4a206c2926b42c89899a59bbc517eb890bd99657b079e`.
Receipt i `root-source-readback.json` są zachowane pod resolverowym
`windows-native/boris-source-image-b5ffb0df863d47f5b76ff5e2d4af4e2c/`.
Context SHA256 wynosi
`5c53c82e963c5c27cca3b706e017652fab5a20c28cc9b02ee00975434a84aced`;
source-tree SHA256 wynosi
`0d0d924321c6b0d664f3e862a7a73d7c31a1c4c14d2a7f973b6238e2a58161a6`.
Readback poza buildem, readonly bez bind mountów i sieci, UID 65532,
1 CPU/512 MiB/32 pids, rzeczywisty exit 0, wywołał `verify_source` dla
1133 plików / 26427761 bajtów i odczytał NumPy 2.2.6 oraz Matplotlib 3.8.4.
Ten dowód ma zakres SOURCE_AND_TOOLCHAIN_ONLY_NOT_SOLVER_QUALIFIED.
Dziewiętnaście interpretowanych regresji producenta, w tym actual Git CRLF
clean-filter capture, przeszło; nie stanowią wykonania BORIS.

Public Python/ProblemIR, wszystkie cztery backendy Fullmaga, historyczne
odmowy v1 i benchmarku oraz tolerancje naukowe pozostają bez zmian.
Operator nie jest aktywowany i kolejka nie została zmieniona. Kompilacja BORIS,
CPU ABI witness, solver runtime i nowe porównanie nadal są NOT VERIFIED;
ciężka kompilacja pozostaje zadaniem tej samej kolejki Fullmag_build_runner.

(boris-cpu-abi-witness-contract)=
### E1: prerejestracja produkcyjnego CPU ABI witness

Kontrakt prerejestrowany przed kodem; implementacja SOURCE ONLY, NOT VERIFIED.
Witness jest artefaktem pochodzenia profilu boris-cpu-v1,
nie testem jednostkowym ani solverem. Nie wykonano kompilacji,
witnessa ani runtime benchmarku. W upstream
048503d2ca6475e91b073eb1762ecf9d3634c3e1 Boris/MeshBase.h deklaruje
VEC_VC<double> V oraz VEC_VC<DBL3> E/S; BorisLib/Types_VAL.h definiuje
DBL3=VAL3<double>. Oryginalne hashe obu plików są przypięte do pełnego
image_source.v1; worker odmawia drift. SINGLEPRECISION opisuje CUDA,
nie jest samodzielnym dowodem precyzji CPU.

Fixed witness obejmuje actual MeshBase.h i static_assert typów skalarów V/E/S
oraz DBL3. Sprawdza CHAR_BIT=8, sizeof(double)=8, radix=2, digits=53,
max_exponent=1024. CPU solver i witness używają tego samego compiler path,
flags -Ofast/-std=c++17/-fopenmp, includes, sanitised image environment oraz
tego samego zestawu flag linkowania. Wyjściowe fakty ABI są obserwowane przez
fixed stage i kopiowane do bounded JSON wraz z job/source/image/flags binding.
Wszystkie trzy etapy compile/link/observe muszą mieć dokładnie jeden sukces;
exact komendy witnessa są sprawdzane wobec komend produkcyjnego solvera.
-Ofast nie oznacza ścisłej arytmetyki IEEE: binary64 ABI nie kwalifikuje
błędów naukowych ani konwergencji. Brak witnessa odmawia nowego build receipt.
Legacy runtime.v1 nadal incomplete; witness nie nadaje identity_complete,
nie otwiera public benchmark admission i nie zmienia żadnej tolerancji fizycznej.

| Generated parametr / typ | Granica i walidacja | Jednostka / znaczenie |
|---|---|---|
| schema_version / string | fullmag.boris.cpu_abi.v1; exact fixed fields | $1$; wersja dowodu ABI |
| job_id, capsule_digest, image_digest / string | exact owning receipt values | $1$; managed provenance |
| compile_flags_sha256, cuda_flags_sha256 / string | SHA256 actual output headers | $1$; compiler input binding |
| type_source_sha256 / map | exact pinned MeshBase.h/Types_VAL.h SHA256 | $1$; rzeczywiste typy V/E/S |
| facts / object | integer CHAR_BIT=8, double_bytes=8, radix=2, digits=53, max_exponent=1024; bool nie zastępuje integer | $1$; ABI, nie science PASS |
| cpu_abi_witness.cpp / bytes | exact generated source, <=8 KiB | $1$; fixed production witness |
| cpu_abi_witness / bytes | regular file, 1..16 MiB; actual SHA256 | $1$; production provenance executable |
| cpu_abi_witness.json / JSON | regular UTF8 unique-key file, 1..4 KiB; same job/source/flags; no self hash | $1$; retained observation |
| boris-cpu-abi-compile/link/observe / stages | unique exit=0; exact compile/link/run commands; bounded stdout <=4 KiB | $1$; managed execution evidence required |

Wspólne Python authoring, ProblemIR, FDM/FEM równania i publiczne jednostki
pozostają niezmienione. Witness dotyczy wyłącznie zewnętrznego BORIS CPU;
nie kwalifikuje FDM CPU/GPU ani FEM CPU/GPU Fullmaga. Toolchain/dependencies
pozostają faktyczną bramką preflight: brak FFTW3/X11/TBB odmawia przed compile.
Actual source implementation: scripts/local_runner/boris_cpu.py::run_build,
validate_abi_outputs, validate_outputs; output membership scripts/local_runner/build_entrypoint.py::required_outputs_for_profile.

(boris-fixed-m-transport-v2-contract)=
### E1: generator fixed-M i dowód l_J v2

**Stan z 2026-10-15: kontrakt prerejestrowany przed kodem, implementacja
`SOURCE_ONLY`; runtime `NOT VERIFIED`, scenariusz `SCENARIO_NOT_QUALIFIED`.**
Przerejestracja poprzedziła zmianę generatora i walidatorów. Zapisane źródła
zastępują `statictransportsolver(1)` oraz `Relax`/`Run`, które nie zamrażają M,
przez `statictransportsolver(0)` i `computefields` z pomiarem przed/po.
W przypiętym BORIS `048503d2ca6475e91b073eb1762ecf9d3634c3e1`
publiczna nazwa parametru to `l_J` (wewnętrzny `l_ex`), a `computefields`
aktualizuje pola/transport bez kroku `odeSolver.Iterate`. To podstawa
wyboru metody, nie dowód zrealizowania stanu przez binarium.

Nowe schematy to dokładnie `fullmag.boris_she_nf.scenario.v2`,
`fullmag.boris_she_nf.native.v2` i `fullmag.boris_she_nf.v2` dla summary.
`fullmag.boris.runtime.v2` oraz `fullmag.boris_flow_major_units.v2` pozostają
bez zmiany. Nowy publiczny admission wymaga poniższego pomiaru i odrzuca
scenario/native/summary v1; historycznych bytes ani receipts nie retaguje się.
Generator zachowuje eksperymentalne N/T/F, lecz publiczny/managed benchmark
nadal dopuszcza tylko N/F; nie przyznaje się kwalifikacji bariery.

| Wersjonowane pole | Dokładny typ, wartość i walidacja | SI / zakres |
|---|---|---|
| `scenario.execution` | exact object: `mode="fixed_m_transport_only"`, `ode="LLGStatic-SA"`, `transport_call="computefields"`, `static_transport=false`, `magnetization_relative_tolerance=1e-6`, `magnetization_absolute_tolerance_apm=1e-6`, `l_J_relative_tolerance=1e-6`; nieznane pola i zamienne typy odrzucone | $1$ poza absolute tolerance w $\mathrm{A\,m^{-1}}$; immutable intent, nie pomiar |
| `NfCaseConfig.magnetization` | dokładnie `(1,0,0)`; inne kierunki odrzucone przed renderowaniem, bo historyczny renderer ustawia literalne +X | $1$; brak udawanej obsługi dowolnego m |
| `ferromagnet.param.l_J` | ustawione jawnie z finite positive `config.l_ex_m` | $\mathrm m$; nie wnioskowanie z defaultu BORIS |
| `native.fixed_m` | exact object: `schema_version="fullmag.boris_fixed_m.v1"`, `M_before="f_M_before.ovf"`, `M_after="f_M_after.ovf"`, `l_J_readback_m` jako finite positive scalar non-bool, `execution_mode="fixed_m_transport_only"` | M w $\mathrm{A\,m^{-1}}$, readback w $\mathrm m$ |
| `ns.setparam("ferromagnet","l_J")` | zapytanie bez wartości; dokładnie skończony dodatni skalar; string, list i bool odrzucone bez heurystycznego parsowania | $\mathrm m$; źródłowo C++ `get_meshparam_value_sci` → unitless `ToString(get0)` → pojedyncze pole float NetSocks; runtime readback jeszcze niewykonany |
| `f_M_before.ovf`, `f_M_after.ovf` | dwa pełne F-grid OVF, `valuedim=3`, exact shape; origin i step zgodne z manifestem i `f_V` przy relative $10^{-12}$ i absolute $10^{-18}\,\mathrm m$ | pozycja $\mathrm m$, M $\mathrm{A\,m^{-1}}$; wszystkie komórki, nie średnia ani pojedynczy probe |
| `l_J_readback_m` względem `config.l_ex_m` | relative tolerance $10^{-6}$, absolute $0\,\mathrm m$; nie niefinitywny, zerowy ani bool | $\mathrm m$; ten proof nie poświadcza wszystkich innych parametrów |
| `summary.fixed_m_proof` | exact recomputed object opisany poniżej; deklaracja caller JSON nie jest dowodem | $1$ jako envelope pomiaru |

#### Kanoniczna ścieżka wyjścia generowanego skryptu

**Dopisek prerejestrowany przed kodem host-path; implementacja `SOURCE_ONLY`,
runtime `NOT VERIFIED`.** Renderowanie `Path("/export").resolve()` na Windows
może dać hostowe `D:\export`, a odtworzenie na Linux `/export`. Wewnętrzne
`render_boris_script(config, *, execution_output_dir=None)` rozdziela teraz
default lokalnego generatora od stałego celu kontenera:

| Parametr wewnętrzny | Typ/default i walidacja | SI / znaczenie |
|---|---|---|
| `execution_output_dir` | `str or None`, default `None`; jedyny dopuszczony override to dokładny literal `/export`, bez `Path.resolve`; inna wartość odrzucona | $1$ jako identyfikator ścieżki; nie zmienia konfiguracji storage |

Przy `None` zachowuje się dotychczasowe `str(config.output_dir.resolve())`.
`run_managed_boris_nf.py::fixed_inputs` przekazuje wyłącznie stałe
`execution_output_dir="/export"`, dzięki czemu host Windows i worker Linux
muszą uzyskać identyczne bytes skryptu. `/export` jest **stałym celem wyjścia
wewnątrz kontenera, nie rootem storage**. Faktyczne hostowe storage i mount
nadal wyznacza istniejący resolver i managed launcher. Factory nie przyjmuje
user-root, environment lub CLI override; nie dodaje mountów. Exact byteguard
`fixed_inputs`/worker pozostaje obowiązkowy i nie jest osłabiany.

Generator zachowuje wybór `LLGStatic-SA` do aktywacji transportu, ale wykonuje
`statictransportsolver(0)` oraz `computefields()`, bez `setstages(Relax)` i
`Run`. Eksporty M następują bezpośrednio przed i po tym wywołaniu. Nie zmienia
się znaków Ts/Tsi, gamma, jednostek ani porównywalności torque.

Dla każdej składowej każdej komórki wymagane są trzy kontrole: before względem
$M_s(1,0,0)$, after względem tej samej wartości oraz after względem before.
Norma poniżej jest maksimum bezwzględnych błędów **składowych po wszystkich
komórkach**, a nie normą wektora ani błędem średniej:

```{math}
:label: boris-fixed-m-all-cell-admission
M_\star=(M_s,0,0),\qquad
\max\left(\lVert M^{\mathrm{before}}-M_\star\rVert_\infty,
\lVert M^{\mathrm{after}}-M_\star\rVert_\infty,
\lVert M^{\mathrm{after}}-M^{\mathrm{before}}\rVert_\infty\right)
\le\epsilon_{\mathrm{abs}}+\epsilon_{\mathrm{rel}}M_s.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $M^{\mathrm{before}}$ | pełne pole magnetyzacji przed transportem | $\mathrm{A\,m^{-1}}$ |
| $M^{\mathrm{after}}$ | pełne pole magnetyzacji po transporcie | $\mathrm{A\,m^{-1}}$ |
| $M_\star$ | oczekiwana magnetyzacja każdej komórki F | $\mathrm{A\,m^{-1}}$ |
| $\lVert\cdot\rVert_\infty$ | maksimum błędu składowych po wszystkich komórkach F | $\mathrm{A\,m^{-1}}$ |
| $\epsilon_{\mathrm{abs}}$ | bezwzględna tolerancja tekstowego eksportu M | $\mathrm{A\,m^{-1}}$ |
| $\epsilon_{\mathrm{rel}}$ | względna tolerancja eksportu M | $1$ |

Zamrożone wartości to $\epsilon_{\mathrm{abs}}=10^{-6}\,\mathrm{A\,m^{-1}}$
i $\epsilon_{\mathrm{rel}}=10^{-6}$. Wspólny istniejący helper
`scripts/verify_boris_nf_interface.py::validate_fixed_m(root,scenario,native)`
ponownie czyta pełne OVF, oblicza trzy maksima i sprawdza l_J oraz geometrię.
Reader oblicza hash z tych samych surowych bytes, z których dekoduje OVF;
`require_fixed_m_members` wiąże oba hashe z retained output closure.
Wynik ma dokładnie: `schema_version="fullmag.boris_fixed_m.proof.v1"`,
`M_before_sha256`, `M_after_sha256` (64 lowerhex), `sample_count` (dodatni int,
liczba komórek), `maximum_before_error_apm`, `maximum_after_error_apm`,
`maximum_change_apm` (finite nonnegative) i `l_J_readback_m` (finite positive).
Nie publikuje tablic M w summary. `summary.fixed_m_proof` musi być dokładnie
równy ponownemu obliczeniu, a `RAW_OUTPUTS` i runtime output closure muszą
wiązać oba nowe OVF; v2 ma 16 OVF zamiast historycznych 14.

Przy managed publikacji i identity re-open `_artifact_summary` otrzymuje
`retained_outputs` z tego samego `verified_outputs`. Jego końcowy pomiar M
musi pasować do tych hashów, a `read_json` sprawdza hash tych samych bounded
surowych bytes `boris_native_samples.json` przed parsowaniem readbacku l_J.
`verify_runtime_identity` zwraca te entries dopiero po ponownym porównaniu
summary, przez `validate_runtime_identity` do publicznego admission.
Publiczny walidator wiąże z nimi również swój ostatni pomiar M i odczyt
native JSON. Porównanie summary zachowuje rozróżnienie JSON bool/liczba.

| Wewnętrzny parametr pomiaru | Typ/default i walidacja | SI / zakres |
|---|---|---|
| `_artifact_summary.retained_outputs` | `Sequence[Mapping[str,object]] or None`, default `None`; managed publikacja/re-open przekazują zweryfikowane entries, z których pobiera się dokładne hashe M i native JSON | $1$ jako manifest; `None` nie przyznaje managed identity |
| `read_json.expected_sha256` | `str or None`, default `None`; przekazany hash musi odpowiadać pojedynczemu bounded odczytowi raw bytes przed decode/parse | $1$ jako SHA256; przy ponownym odczycie native JSON w managed/public v2 pochodzi z tej samej retained closure |

Zmiana A→B między admission a końcowym odczytem ma być odrzucona nawet,
gdy nowe M nadal mieści się w tolerancji fizycznej. Kontrolowane przypadki
publikacji i obu re-open wykonują te gałęzie ze stubami zależności admission;
nie są dowodem rzeczywistej tożsamości runtime.


Mapowanie nie tworzy Python DSL ani `ProblemIR`: zmienia wyłącznie
wersjonowany zewnętrzny generator i jego pomiar. Summary, publiczny walidator,
worker i managed re-open wywołują ten sam helper; źródła kontrolowanego
`check_fixed_m_contract` obejmują odmowy zmienionych M/siatki/l_J/proof/v1
oraz porównanie bytes skryptu przy rozwiązywaniu ścieżek Windows i Linux.
Dowód odbioru nadal wymaga rzeczywistego managed wykonania. Syntetyczne
OVF, kontrolowane przypadki i AST nie dowodzą braku ewolucji M w BORIS. Nawet PASS
tego ograniczonego pomiaru nie nadaje parity, konwergencji ani statusu
„all parameters verified”. Nie dowodzi równoważności modeli ani
obwodów zasilania BORIS i Fullmaga. FDM CPU/GPU i FEM CPU/GPU nie otrzymują nowej
kwalifikacji; nowy benchmark nadal `NOT VERIFIED`.

(boris-managed-runtime-v2-contract)=
### E1: trusted managed runtime admission v2

Kontrakt prerejestrowany przed implementacją. Actual source-only, NOT VERIFIED:
oddzielny BORIS CPU helper
wiąże authenticated terminal operator job z dokładnie czterema trusted plikami,
actual binary/source/flags/CPU ABI witness i pinned installed image. Canonical
build root wynika tylko z returned worktree_id/job_id oraz storage resolvera;
API worktree_id musi zgadzać się z layout.worktree_id, owner z actual actor.
Runtime root to fresh resolver-owned katalog o losowym pełnym runtime_id;
caller JSON nie wybiera arbitrary proof path, komend, środowiska ani mountów.
FEM-only validate_managed_build oraz sześć pozostałych profili nie zmieniają się.

Fixed coarse/medium/fine N/F zachowuje istniejące parametry, tolerance=1e-5,
max_iterations=200, CPU -g -1 i timeout180s. New managed run wymaga strict
actual solver exit=0, stage marker i full native samples; historyczny v1 miał
14 OVF, prerejestrowany fixed-M v2 wymaga 16 OVF; historyczne
exit143 lub post-stage StdoutCatcher flush exit1 są odmową nowej ścieżki,
nie synthetic sukcesem. Fullmag torque conversion refusal pozostaje bez zmian.
Nie instaluje się pakietów ani nie pobiera obrazu podczas run. Brak dependencies
lub niezgodna embedded Python wersja/imports oznacza jawną odmowę.

| Internal generated pole / typ | Walidacja i granica | Jednostka / znaczenie |
|---|---|---|
| build_job_id, runtime_id / string | 32lowerhex; canonical resolver root; authenticated owning operator job | $1$; locator, nie receipt authority |
| fullmag.boris.managed_run.v1 / JSON | <=4 MiB UTF8 unique keys finite; source/binary/image/trusted hashes; actual inspected terminal container | $1$; lokalny managed dowód, nie podpisana portable attestacja |
| fullmag.boris.runtime.v2 / JSON | reopened complete trusted chain poprzez explicit repo_root; caller complete/precision ignored as authority | $1$; provenance only |
| precision / string | double dopiero po verified actual ABI + same compiler/types/flags build i actual CPU run | $1$; binary64 storage, bez strict IEEE claim z -Ofast |
| source_files_sha256 / map | full capsule verified; host imports compare frozen files, brak drift | $1$; helper/adapter bindings |
| scenario.py, scenario.json / bytes | generated exact fixed defaults/resolution; SHA256 before/after run | $1$; scientific input identity |
| outputs / entries | historyczny v1: 14 OVF; prerejestrowany fixed-M v2: exact16 OVF + native samples + runtime probe/logs; unique safe members <=32, aggregate <=256 MiB, each <=64 MiB | $1$; heavy payload files, bez JSON arrays |
| container attestation / JSON | exact image/argv/env/mounts/runc/NVIDIA_VISIBLE_DEVICES=void/noGPU/noNetwork/UID65532/readonly/cap_drop/resource caps | $1$; rzeczywista lane/isolation |
| summary/runtime/receipt digests / string | external digest framing; no receipt self-hash/cycle; summary recomputed from verified outputs | $1$; immutable closure |

Publication ordering correction preregistered przed kodem, actual SOURCE ONLY:
per-runtime storage
lock odmawia parallel/reentrant observe. Final receipt bytes/hash są obliczone
najpierw; runtime.json i independently recomputed summary.json zapisuje się
przed terminalnym receipt, który jest jedynym commit point i powstaje LAST.
Przerwanie przed nim nie zostawia succeeded receipt. Publication I/O failure
pozostawia osobny resumable nonterminal publication_failed_resources_retained;
validation failure jest terminal failed_resources_retained. Po commit żaden
error handler nie nadpisuje sukcesu. Reobserve succeeded bundle jest verify-only,
bez naprawiania dowodów; identity pin odnosi się do exact final receipt bytes,
bez checksum cycle. To zmiana lifecycle/provenance, nie tolerancji ani fizyki.

(boris-managed-matrix-v2-contract)=
Macierz porównawcza używa wyłącznie trzech już zakończonych managed CPU
runtime v2 i nie uruchamia BORIS ponownie przez `observe`. Jej execution
odrzuca Linux, CUDA, legacy build-root i legacy grids. Dwa przypadki tolerancji
Fullmaga korzystają z tych samych dokładnie przypiętych referencji BORIS;
`run_boris_fullmag_she_nf_matrix.py::_managed_reference` ponownie otwiera
zaufany łańcuch i sprawdza zgodność wspólnych parametrów oraz rzeczywistej
siatki. Piny obejmują summary.json, runtime.json, receipt.json i scenario.json;
revalidation i ponowne piny binariów otaczają każdy przypadek. Nie jest to
dowód konwergencji BORIS. Stałe referencje oznaczają niezmienne retained bytes,
nie potwierdzenie zamrożonego $M$ ani wszystkich zrealizowanych parametrów.
Scenariusz pozostaje `SCENARIO_NOT_QUALIFIED`; nowy benchmark i dynamika
transportowego RHS Fullmaga pozostają `NOT VERIFIED`.

Public validate_boris_artifact i normalize_boris_artifact wymagają dla v2
jawnego trusted repo/storage context i ponownego otwarcia źródeł/receipt/output
closure; legacy v1 odmowy pozostają. Brak operatora lub retained evidence
odmawia zamiast offline allow_incomplete. Complete runtime identity nie oznacza
science qualification; status nadal diagnostic/NOT VERIFIED aż preregistered
niezależne residual/interface/convergence kryteria zostaną wykonane.
Python DSL, ProblemIR, wspólne równania i FDM/FEM CPU/GPU qualification Fullmaga
pozostają bez zmian. Actual helper scripts/run_managed_boris_nf.py::resolved_boris_build, start,
observe, verify_runtime_identity wykonuje powyższy source contract. Interpreted
fixtures nie są trusted runtime proof; operator/image/native benchmark nie
zostały wykonane. Strict solver exit=0 obejmuje brak historycznych wyjątków.
Public wrapper scripts/run_boris_nf_interface.py::main udostępnia managed
job/runtime locators, odmawia caller build/image/output/container overrides.
Receipts wymagają retained actual container oraz dostępnego operatora; brak
portable signed admission nie jest zastępowany caller JSON authority.

(fullmag-m2-explicit-magnetic-domain-v2)=
## Prerejestracja M2 CPU: jawna domena magnetyczna N/F w descriptorze v2

Status: **planned contract / storage-only source candidate; NOT COMPILED,
NOT EXECUTED, benchmark NOT QUALIFIED**. Ten dodatek nie zmienia dopisków C+D,
checkpoint refusal ani historycznych dowodów. Wspólny model ma jeden
`Ferromagnet` wyłącznie F i oddzielną auxiliary geometry N z rolą `conductor`;
charge/spin obejmują N+F, torque i FrozenSpins tylko F. Nie stosuje się dummy m,
Ms epsilon ani regionalnego Ms=0 jako zamiennika magnetic active mask.

Istniejące `ProblemIR` przechowuje ten authoring. `transport_common_grid`
próbkuje magnetic mask F niezależnie od transport domain. Pierwotny M2 v1
traci tę maskę i bezwarunkowo wymaga unit m także w N. Prerejestrowany M2 v2
ma wymagane `magnetic_active_mask: Vec<bool>` w resolved descriptorze i
`CoupledChargeSpinMaterialFields`. Nie ma defaultu all-true. Brak pola,
niezgodna długość, maska poza transport domain, niezgodność z FdmPlanIR albo
stary descriptor v1 są odmową; v1 nie jest reinterpretowane.

| Pole / reguła | Typ, domyślność i SI | Walidacja / znaczenie |
|---|---|---|
| `magnetic_active_mask` | required ordered `Vec<bool>`, $1$ | ta sama kolejność i długość grid; magnetic subset transport; źródło magnetic domain autora, nie nazwa/P/Ms heurystyka |
| magnetic m | required $m$, $1$ | finite unit; constructor zachowuje $10^{-8}$, constitutive $10^{-12}$ |
| nonmagnetic m | required $m=0$, $1$ | finite exact zero na transport-active N; nie ma normalizacji do sztucznego kierunku |
| N material | istniejące współczynniki SI | explicit N odrzuca P, AMR, AHE, lambda_J/phi i torque target; sigma, sigma_s, theta i spin-flip pozostają aktywne |
| mixing i target | istniejący kontrakt | F to_cell i torque target należą do magnetic mask; unit m_F oraz Ms>0 pozostają bez zmian |

Dla N pozostają produkcyjne równania reciprocal, a nie charge-only fallback.
Izotropowa przewodność charge wynosi $\sigma_{\perp}=\sigma_{\parallel}$;
współczynnik $\sigma$ w członach SHE jest osobnym istniejącym parametrem
konstytutywnym. Wspólny przypadek N/F deklaruje wszystkie te przewodności równe:

```{math}
:label: m2-explicit-nonmagnetic-constitutive
J_{c,i}=\sigma_{\perp} E_i+\theta_{\mathrm{SH}}\sigma\epsilon_{ija}G_{ja},\qquad
Q_{ia}=\sigma_sG_{ia}+\theta_{\mathrm{SH}}\sigma\epsilon_{ika}E_k,
\qquad G_{ia}=-\partial_i\mu_{s,a}/2.
```

Istniejący człon spin-flip pozostaje określony w {eq}`spin-balance-reaction`;
zerowe człony exchange i dephasing wynikają z jawnej
niesprzecznej konfiguracji N, nie z cichego mnożenia błędnych magnetic
współczynników przez zero. Równania F, znaki, gamma, mixing, normalne,
Gilbert conversion i adapter pozostają niezmienione.

`evaluate` zachowuje strict magnetic=true wrapper. M2 używa
`evaluate_with_magnetic_activity` z rzeczywistym bitem maski osobno dla obu
stron same-material face, boundary i końcowych cell observations. Konstruktor,
reaction/preconditioner i target admission sprawdzają zgodność explicit mask;
interface nadal używa wyłącznie m_F z to_cell. Maska resolved descriptoru jest
porównywana z FdmPlanIR, a nie wyprowadzana z parametrów materiału.

Publiczne nazwy pozostają istniejące: `Problem.auxiliary_geometries`,
`auxiliary_geometry_roles`, `Ferromagnet`, `RegionRef`, `FrozenSpins`,
`fm.init.UniformMagnetization`. Nie dodaje się publicznego materiałowego bool
lub nowego physics module. Required mask jest częścią canonical resolved
execution plan/provenance; obejmuje ją istniejący descriptor digest. Nowy
managed package i oficjalna generacja schematu są wymagane przed public runtime.
Przykład pełnego authoringu/loweringu jest osobnym prerejestrowanym kandydatem
N/F; tutaj nie publikuje się niewykonanego kompletnego programu.

| Realizacja | Stan tego dodatku |
|---|---|
| FDM CPU FP64 M2 | source candidate; parser/policy controls nie dowodzą solve |
| FDM GPU | bez zmian; brak promocji ani nowej ABI |
| FEM CPU | bez zmiany operatora; konieczna jedynie aktualizacja testowego literal FDM descriptoru |
| FEM GPU | bez zmian i bez nowej kwalifikacji |

Wymagane gates: publiczny lowering z N magnetic inactive/m=0/Ms=0 i F active;
mask length/subset/mismatch/v1/missing odmowy; N konflikt P/AMR/AHE/J/phi/torque;
finite state i niezmienione obie tolerancje F; zachowanie SHE/iSHE/sf oraz
mixing N→F; whole-result frozen-M proof; niezmieniony all-magnetic operator;
nowy container-backed managed build i rzeczywisty N/F solve; signed terminal
current i pełny provenance/reopen. Checkpoint resume oraz pełny benchmark są
nadal odrębnymi otwartymi bramkami. Nie zmieniać scope przez fake magnetic N.

| Kontrakt | Ścieżka | Symbol | Stan |
|---|---|---|---|
| M2 magnetic domain v2 | crates/fullmag-ir/src/spin_transport.rs | ResolvedFdmCoupledSpinTransportIR | required resolved mask, source candidate |
| M2 lowering | crates/fullmag-plan/src/spin_transport.rs | materialize_m2_descriptor | transfer base mask i conflict refusal |
| M2 runner | crates/fullmag-runner/src/fdm/cpu/spin_transport.rs | solve_coupled_module | explicit forwarding, no dummy m |
| M2 material | crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs | CoupledChargeSpinProblem::new | explicit activity i state admission |
| M2 constitutive | crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs | ReciprocalConstitutiveMaterial::evaluate_with_magnetic_activity | nonmagnetic equations z SHE/iSHE |

| Symbol | Token LaTeX | Znaczenie | SI |
|---|---|---|---|
| Maska domeny magnetycznej M2 | $\chi_m$ | Jawna aktywność magnetyczna komórki wspólnego gridu M2 | $1$ |
| Tensor permutacji | $\epsilon_{ija}$ | Tensor Levi-Civity, dodatni dla cyklicznej kolejności xyz | $1$ |
| Indeksy kartezjańskie | $i,j,k,a$ | Indeksy z xyz; i/j/k przestrzenne, a polaryzacji spinu; powtórzone indeksy sumowane | $1$ |

| Kontrakt | Ścieżka | Symbol | Dowód |
|---|---|---|---|
| Explicit nonmagnetic constitutive | crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs | evaluate_with_magnetic_activity | source candidate, nie wynik Rust/runtime |
| Nonmagnetic rejection i sf | crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs | explicit_nonmagnetic_domain_admission_preserves_spin_flip_and_rejects_conflicts | źródło regresji, NOT COMPILED/NOT RUN |

| m2-mask-v2-prereg | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:fullmag-m2-explicit-magnetic-domain-v2 | planned contract; source candidate, runtime NOT VERIFIED |


(spin-transport-frozen-state-output-bridge)=
### Planowany most frozen Relax → M3

Status `planned_contract`, runtime NOT VERIFIED. Kanoniczny kontrakt envelope,
jednostek, pełnej historii i jedynego ownera docelowych epoch określa
[spec §14.11](../specs/frozen-spins-v1.md#frozen-v1-output-lifecycle-bridge),
a konsekwencje frozen opisuje [0996](0996-frozen-spins-constraint.md#frozen-spins-state-output-bridge).
Pure-frozen poprzednik nie emituje czterech nośników M3. Dopiero aktywny M3
wymaga atomowego C+D manifest V4 z rzeczywistą coverage i oboma czytnikami.
Brak cold reopen/Relax → M3 evidence; publiczny ExactResume pozostaje Unsupported.

(spin-terminal-homogeneous-gradient-prereg)=
## Prerejestracja: jednorodny normalny gradient potencjału spinowego na terminalu

**CANDIDATE_ONLY, 2026-10-16; NOT COMPILED, NOT EXECUTED, runtime NOT VERIFIED.**
To jawny warunek brzegowy tej samej konstytutywnej fizyki M2, bez nowego bulk
operatora. Nie zmienia znaczenia SpinInsulating (całkowity strumień zero),
SpinSink/SpecifiedSpinPotential (Dirichlet) ani SpecifiedSpinFlux (stały
całkowity outward strumień). W istniejącym publicznym API nie było wariantu
wyrażającego zerowy normalny gradient przy zachowanym niedyfuzyjnym prądzie.

```{math}
:label: spin-terminal-homogeneous-normal-gradient
\partial_{n}\boldsymbol{\mu}_s=\mathbf 0,
\qquad \mathbf n=\mathbf n_{\rm terminal}.
```

Przy $G_{ia}=-\partial_i\mu_{s,a}/2$ normalny wiersz $G$ jest zerowy, a
pozostałe składowe są aktualnym stanem rozwiązania. Pełna odpowiedź
konstytutywna daje

```{math}
:label: spin-terminal-nondiffusive-normal-flux
n_i Q_{ia}=P\sigma(n_i E_i)m_a+
\theta_{\rm SH}\sigma n_i\epsilon_{ika}E_k.
```

$\mathbf n$ jest zewnętrzną jednostkową normalną terminala, $\partial_n\mu_s$
ma SI V/m, a $n_iQ_{ia}$ ma SI A/m². Indeksy i,j,k,a oraz tensor Levi-Civity
mają znaczenie z równania M2 explicit nonmagnetic constitutive. Nie oblicza
się strumienia z oczekiwanego E ani z request checkbox; pochodzi z aktualnego
E, m i materiału. Charge response zachowuje reciprocal P oraz iSHE; nie zeruje
się stycznych gradientów, całego tensora Q ani momentu.

Publiczny wariant kandydata `HomogeneousSpinPotentialGradient(id, surfaces)`
serializuje kind `homogeneous_spin_potential_gradient` w
`spin_transport_modules[].boundaries[]`. Nie ma wartości do fitowania,
expression ani backend-only wrappera. Jawne id i surfaces przechodzą przez
SceneSpinBoundary, ProblemIR, ownership resolver i resolved typed condition.

| Parametr Python | Typ | Default | SI | Walidacja | Znaczenie | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| HomogeneousSpinPotentialGradient.id | str | required | $1$ | non-empty | tożsamość warunku brzegowego | steady M2 FDM CPU double strict, candidate source-only | spin_transport_modules[].boundaries[].id |
| HomogeneousSpinPotentialGradient.surfaces | Sequence[SurfaceRef] | required | $1$ | niepuste; istniejące ownership, coverage i overlap gates | jawne zewnętrzne powierzchnie | steady M2 FDM CPU double strict, candidate source-only | spin_transport_modules[].boundaries[].surfaces |

```python
# %% Jawny warunek; powierzchnie są zdefiniowane w kanonicznym modelu autora
import fullmag as fm
terminal = fm.HomogeneousSpinPotentialGradient(
    "spin_terminal", [fm.SurfaceRef("conductor", "x_min", (-1.0, 0.0, 0.0))],
)
terminal.to_ir()
```

Fragment przedstawia wyłącznie serializację obiektu, nie kompletny wykonalny
problem. Pełny przypadek E1 wymaga tego samego rodzaju na CAŁYCH dwóch
xterminals N+F i jawnego total-spin-insulating coverage czterech sidewalls.
W jednorodnym affine fixed-voltage case N ma P=0 i E_tangent=0, zatem nowa BC
w N daje również total Q.n=0 jak BORIS NHNeumann; F zachowuje drift przez
terminal. To prerejestrowany zakres, nie kwalifikacja dowolnego BVP.

Wspólny structured ABI nadal ma jedną condition na face. Partial, overlapping
oraz mixed N/F conditions na jednej face nadal odmawiają; nie dodajemy per-cell
ABI i nie wybieramy rodzaju BC z nazwy, typu obiektu, P ani Ms. M1, transient
M3, native M1, FEM CPU/GPU, FDM GPU i unsupported precision/mode odmawiają przed
solve bez CPU fallback. Enclosing requested intent i resolved execution
pozostają w planie i provenance.

| Realizacja | Stan tego warunku |
|---|---|
| FDM CPU double strict, steady reciprocal M2 | kandydat źródłowy; compilation/runtime NOT VERIFIED |
| FDM CPU M1 i transient M3 | jawnie unsupported, bez konwersji na NoFlux |
| FDM GPU | unsupported, bez CPU fallback |
| FEM CPU | unsupported; odrębny boundary realization nie jest wdrożony |
| FEM GPU | unsupported |

Runtime wykorzystuje ten sam stage/session workflow. Hash descriptoru wiąże
nowy typed rodzaj; stare pakiety mają prawo odmówić nieznanego kind. Nie
przepisuje się starych receipts ani requested intent. Canonical script builder
musi odtwarzać ten sam publiczny obiekt, a OpenAPI/TS wymagają oficjalnego
nowego eksportu po udanym managed pakiecie, bez ręcznej edycji generated.
Nie podnosi się capability status do qualified.

### Stała domena i jedna rodzina nowego benchmarku E1

Nowy przypadek zachowuje fizyczną domenę referencyjnego medium: długość 1 µm,
szerokość 0,4 µm, grubość N=2 nm i F=2 nm. Wszystkie siatki mają te same
materiały, interfejs, rzeczywiste magnetic F/nonmagnetic N, zamrożone m=(1,0,0)
w F, terminale i dodatnie fixed voltage ΔV=0,0017241379310344827 V. Napięcie
wynika z dotychczasowego control scale 10¹¹ A/m², długości i σ=5,8·10⁷ S/m;
nie jest dopasowaniem rzeczywistego prądu. Rzeczywisty podpisany terminal
current musi być osobno zmierzony. Nowy rodzaj spin BC jest na obu całych
xfaces N+F, razem z charge Voltage BC; cztery sidewalls mają total Q.n=0.
Inna para charge BC jest jawnie unsupported dla tego nowego wariantu:
obecny face owner wyznacza konstytutywny normalny E z Voltage. Nie zastępuje
się go requestowym E dla current/insulating charge BC.

| Nowa siatka | nx | ny | nz N + F | dx | dy | dz | Liczba cells |
|---|---:|---:|---:|---|---|---|---:|
| r0 | 4 | 100 | 2 + 2 | 250 nm | 4 nm | 1 nm | 1600 |
| r1 | 4 | 200 | 4 + 4 | 250 nm | 2 nm | 0,5 nm | 6400 |
| r2 | 4 | 400 | 8 + 8 | 250 nm | 1 nm | 0,25 nm | 25600 |

To jedna zaplanowana rodzina, nie trzy zaliczone runy. Najkrótsze skale są
λ_sf=5 nm i λ_J=2 nm, więc r2 ma dwie próbki na λ_J w y i osiem w z;
nie dowodzi to samo z siebie zbieżności. Parametry interfejsu mogą narzucić
jeszcze krótszą efektywną skalę. Obowiązkowe są ocena błędu przestrzennego i
z góry ustalony budżet przed actual wynikami; żaden discrepancy PASS między
solverami ani zmniejszenie inner residual nie zastępuje mesh convergence.

Stałe nx=4 wymaga źródłowego dowodu zamknięcia całego wspólnego BVP w affine
V(x), spin μ(y,z), μ_x=0: materiały i interfejs są translacyjnie niezmienne
w x; magnetyzacja jest jawnie stała i zamrożona; mixing przy m w osi x nie
miesza podprzestrzeni y/z z x; N SHE generuje tylko spin y/z; F SHE=0; nowe
xBC zachowuje dryf, a stałe potencjały obu xfaces dopuszczają affine V.
iSHE może zmieniać J_x(y,z), lecz jego dywergencja x znika. Na normalnym do z
interfejsie ΔV=0 i μ_x=0 nie generują longitudinal charge/spin źródła. Te
założenia muszą zostać związane z nową faktyczną wersją scenariusza i oba
solvery muszą wykazać w actual raw danych x-invariance oraz affine V przed
uznaniem tej rodziny za kwalifikacyjną. Nie jest to ogólne twierdzenie dla
asymetrycznych położeń, zmiennego m, niejednorodnego zasilania ani dowolnego
interfejsu. Nadal uruchamiany jest istniejący solver 3D, nie model 2D.

Źródłowy M2 ma 4 niewiadome/cell, restarted matrix-free GMRES oraz lokalny
block/line preconditioner, bez znalezionego jawnego globalnego cell cap w
admission tego ownera. Nie gwarantuje to czasu, pamięci ani jakości. Pierwszy
capacity gate dotyczy wyłącznie r0, w istniejącym zarządzanym limicie CPU/RAM.
GMRES restart=40 nie jest stałym memory cap: istniejący `restarted_gmres`
może powiększać effective restart po cyklu. Przy existing max_iterations=2000
konserwatywny bound samej bazy 4N×2001×8 B wynosi około 97,7 MiB / 390,8 MiB /
1,53 GiB dla r0/r1/r2; to nie obejmuje innych wektorów, line blocks, bibliotek
ani tmpfs. Nie jest to pomiar ani gwarancja zmieszczenia r2 w 2 GiB. Nie
zmieniamy algorytmu ani tolerancji w celu uzyskania capacity PASS.

Dopiero terminalny sukces, rzeczywisty koszt i kompletność artefaktów pozwalają
na serialne r1, potem r2. OOM, timeout, brakujące dane albo limit pliku to
odmowa; bez zmniejszania geometrii, podmiany solvera, tolerancji czy budżetu
po obejrzeniu wyników. Runtime capacity i convergence pozostają NOT VERIFIED.

Wcześniejszy niewykonany proposal 10/20/40 zachowuje się historycznie;
nawet jego dy=25 nm jest większe od λ_sf i λ_J. Nie jest drugą wykonywalną
rodziną, nie jest uruchamiany dla dodatkowego zielonego wyniku i nie zostaje
przemianowany na nowy benchmark. Dotychczasowe legacy siatki o rosnących
extents także nie są refinementem. Nowa rodzina, wspólny operator, signed
parameter mapping, fixed voltage i worker/input tools wymagają nowej jawnej
wersji i provenance; starych 42 inputs ani historycznych receipts nie zmienia
się. Torque pozostaje incomparable. Pełne E1 nadal wymaga actual benchmarku.

Bramki przed zamknięciem: konstrukcja/invalid surface i Python→IR→script
round-trip; unsupported-lane oraz mixed-face odmowy; normalne obu znaków,
aktualny niezerowy P/SHE flux i charge iSHE; spójny face trace i pola cellwise;
nowy managed native build; pełny prerejestrowany source-bound E1 case z raw M,
grid/origin, potentials, face currents, residual/interface i host reopen.
Dotychczasowe 42 źródła BORIS i runtime85 nie stanowią nowego scenariusza:
betaD, signed parameter mapping oraz fixed-voltage input/worker provenance
wymagają osobnego kontraktu. Torque nadal incomparable. Framework tests,
native runtime oraz nowy benchmark nie są zaliczone przez tę prerejestrację.

Checklist: fizyczne równania i SI opisane; publiczne parametry/IR i cztery
backend lanes jawne; źródła path+symbol poniżej; planned source controls i
actual managed gates rozdzielone. Deferred: unsupported lanes, per-cell BC,
complex torque equivalence i pełne actual E1. Bibliografia i kanoniczny bulk
model pozostają w nocie0970; źródłowe uzasadnienie pinned BORIS jest w audycie
E1 common-operator z 2026-10-16. Nowa BC nie zmienia równań bulk.


| Symbol | Token LaTeX | Znaczenie | SI |
|---|---|---|---|
| Normalna terminala | $\mathbf n_{\rm terminal}$ | Zewnętrzna jednostkowa normalna terminala | $1$ |
| Gradient normalny | $\partial_n\boldsymbol{\mu}_s$ | Normalny gradient potencjału spinowego | $\mathrm{V\,m^{-1}}$ |
| Strumień niedyfuzyjny | $n_i Q_{ia}$ | Zewnętrzny niedyfuzyjny strumień spinu przy zerowym normalnym gradiencie | $\mathrm{A\,m^{-2}}$ |

| Kontrakt | Ścieżka | Symbol | Dowód |
|---|---|---|---|
| spin-terminal-gradient-contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:spin-terminal-homogeneous-gradient-prereg | Prerejestracja jednorodnego normalnego gradientu i całych terminal faces. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-python | packages/fullmag-py/src/fullmag/model/spin_transport.py | class HomogeneousSpinPotentialGradient | Jeden canonical publiczny boundary object i serializacja. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-roundtrip | packages/fullmag-py/src/fullmag/runtime/script_builder.py | _render_spin_boundary_payload | Canonical script export tego samego kind. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-authoring | crates/fullmag-authoring/src/spin_transport.rs | SceneSpinBoundary | Typed scene contract bez drugiej fizyki. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-ir | crates/fullmag-ir/src/spin_transport.rs | SpinBoundaryIR | Authored i resolved type. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-plan | crates/fullmag-plan/src/spin_transport.rs | resolve_spin_transport_with_active_graph | Jawny steady M2 CPU strict gate oraz brak fallbacku. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-ownership | crates/fullmag-plan/src/spin_transport.rs | resolve_spin_boundaries | Pełne face coverage i zachowane overlap/mixed-face odmowy. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-runner | crates/fullmag-runner/src/fdm/cpu/spin_transport.rs | spin_boundary_conditions | Wierne typed forwarding. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-engine | crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs | boundary_flux | Normalny G=0, pełny actual nondiffusive constitutive response. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-constitutive | crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs | evaluate_with_magnetic_activity | Wspólny P, SHE i iSHE response bez nowego bulk operatora. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-m1-refusal | crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion.rs | validate_boundary_condition | Jawna odmowa poza coupled M2. planned/source-only; runtime NOT VERIFIED |

| spin-terminal-gradient-voltage-pair | crates/fullmag-plan/src/spin_transport.rs | materialize_m2_descriptor | Nowy rodzaj wyłącznie razem z Voltage na tej samej resolved face. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-direct-admission | crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs | validate_boundaries | Direct M2 owner odmawia nowego rodzaju z charge Neumann/insulating. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-ui-recognition | apps/control-room/src/shared/domain/physics/transportRecognition.ts | isSpinBoundary | Canonical UI rozpoznaje dokładnie nowy kind i zachowuje strict key gate. planned/source-only; runtime NOT VERIFIED |
| spin-terminal-gradient-ui-kind | apps/control-room/src/modules/inspector/panels/TransportCollectionFieldsModel.ts | changeTransportBoundaryKind | Istniejący edytor listy typów zachowuje authored surfaces bez nowego panelu. planned/source-only; runtime NOT VERIFIED |

| spin-terminal-gradient-native-fixture | crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs | m2_homogeneous_gradient_retains_constitutive_flux_on_all_face_normals | Źródłowy regression fixture normal obu znaków trzech osi, actual gradient i P/SHE/iSHE; NOT RUN, NOT COMPILED. runtime NOT VERIFIED |
| spin-terminal-gradient-capacity-owner | crates/fullmag-engine/src/fdm/cpu/transport/coupled_block_linear.rs | restarted_gmres | Rzeczywisty matrix-free owner może powiększać Krylov basis; source nie dowodzi capacity. runtime NOT VERIFIED |

Dalsze źródłowe wymagania strict completed receipt V2 i cold coverage opisuje
[aneks §14.12](../specs/frozen-spins-v1.md#cd-terminal-completion-receipt-clock),
status `planned_contract`; nie rozszerza to obsługiwanych lane ani ExactResume.


(nf-common-fixed-m-iterations-diagnostic)=
## Prerejestracja diagnostyki fixed-M: 1/2/4/8 wywołań transportu

**CANDIDATE SOURCE ONLY; NOT EXECUTED; nie jest bramką PASS ani macierzą v3.**
Ownerem fizyki i mapowania SI pozostaje niniejsza nota. Diagnostyka korzysta
z tego samego stałego r0 N/F, materiałów, napięcia, geometrii, fixed M i BC
z [common-case v3](#nf-common-managed-case-v3). Nie rozszerza rodziny
na dowolne 3D problemy ani nie zastępuje jej translacyjną realizacją2.5D.
Historyczny run42db pozostaje odmową; nowe dane mają osobny identity/closure.

### Problem i ścisły zakres

Badamy, czy skończone bloki rozdzielonego rozwiązania BORIS zmieniają $V$, $\mathbf S^{B}$, $\mathbf J_c$
oraz wszystkie dziewięć składowych $Q_{ia}$ przy niezmiennym $\mathbf M$.
Jeden proces żąda ośmiu `computefields`; zapis po żądaniach1,2,4,8. Są to
liczniki żądań skryptu, nie dowiedzione liczby wszystkich wewnętrznych solve,
ponieważ inicjalizacja modułów również może wywołać transport.

| Realizacja | Zakres tej diagnozy | Status |
|---|---|---|
| BORIS FDM CPU double | Pinned upstream, te same N/F i fixed M | planned; NOT EXECUTED |
| Fullmag FDM CPU double strict | Dotychczasowy publiczny common-case pozostaje bez zmian; brak uruchomienia porównania w tym profilu | not run by this diagnostic |
| Fullmag FDM GPU | Brak tego common-case witness | unsupported for this diagnostic |
| Fullmag FEM CPU | Nie jest realizacją tej próby | not applicable |
| Fullmag FEM GPU | Nie jest realizacją tej próby | not applicable |

Elektrody pokrywają całe $x$-faces N+F i zadają $V=-\Delta V/2,+\Delta V/2$.
$\mathbf S^{B}$ nie ma tam Dirichlet0: idealnie dla $\mathbf E\parallel\hat{\mathbf x}$ wiersz flow-$x$
NHNeumann SHE jest zerowy. Pozostałe zewnętrzne faces używają pełnego
normalnego strumienia spinowego0. N iSHE $\nabla V$ jest sprzężony z $\nabla\times\mathbf S^{B}$;
F iSHE jest nieobsługiwane, nie zastępowane numericznym readback0.
G-interface bierze Gi/Gmix z górnego F. Idealny osiowy ansatz jest zgodny
z tymi BC, ale nie stanowi dowodu zbieżności skończonych kroków SOR.

### Rzeczywiste kryterium i czego nie mierzymy

```{math}
:label: nf-diagnostic-iterate-update
D_u^{(k)}=\max_m\max_{K\in\mathcal U_m}
 \lVert u_{mK}^{(k+1)}-u_{mK}^{(k)}\rVert_2,\qquad
A_u^{(k+1)}=\max_m\max_{K\in\mathcal U_m}\lVert u_{mK}^{(k+1)}\rVert_2,
\qquad \eta_u^{(k)}=D_u^{(k)}/A_u^{(k+1)}\quad(A_u^{(k+1)}>0).
```

To iloraz DWÓCH niezależnych globalnych maksimów po meshes, nie maksimum
ilorazów per mesh. Dla $V$ norma jest modułem skalara, dla $\mathbf S^{B}$
normą wektora. Przy $A_u=0$ kod zwraca $D_u$, czyli wymiarową zmianę
absolutną, i porównuje jej liczbową reprezentację z tym samym parametrem;
nie jest to bezwymiarowe względne kryterium $\eta_u$ w tym przypadku.
`VEC_VC::IteratePoisson_SOR` pomija komórki CMBND; ich aktualizacja następuje
po redukcji. Miara nie jest residualem PDE, błędem rozwiązania, kryterium
każdej składowej ani dowodem samouzgodnienia $V\leftrightarrow\mathbf S^{B}$.
Osiągnięcie200 kończy blok także bez spełnienia progu.

```{math}
:label: nf-diagnostic-native-si-map
\mu_{s,a}=\frac{2D_e}{\sigma\kappa}S^{B}_a,\qquad
Q_{ia}=\frac{J^{s,B}_{ia}}{\kappa},\qquad \kappa=\mu_B/e.
```

Indeks $i$ oznacza kierunek przepływu, $a$ polaryzację spinu; kolejność
flow-major $3i+a$ pozostaje dotychczasowa. Native $\mathbf S^{B}$ oraz
$J^{s,B}_{ia}$ nie są Fullmag $\boldsymbol\mu_s$ i $Q_{ia}$. Poniższa mapa
to istniejący adapter, bez fitted signs, nowej skali lub zmiany operatora.

| Symbol / token | Znaczenie | SI |
|---|---|---|
| $u_{mK}$ | V albo native spin accumulation w komórce K mesh m | $\mathrm{V}$ albo $\mathrm{A\,m^{-1}}$ |
| $m,K,\mathcal U_m,k$ | mesh, komórka, zbiór aktualizowanych komórek bez CMBND, sweep | $1$ |
| $D_u,A_u$ | globalne maksima zmiany i wartości iteratu | $\mathrm{V}$ albo $\mathrm{A\,m^{-1}}$ |
| $\eta_u$ | względna zmiana tylko dla dodatniego mianownika | $1$ |
| $S^{B}_a$ | native BORIS spin accumulation | $\mathrm{A\,m^{-1}}$ |
| $J^{s,B}_{ia}$ | native BORIS spin-current tensor | $\mathrm{A\,s^{-1}}$ |
| $\mu_{s,a}$ | pełne rozszczepienie spinowe Fullmaga | $\mathrm{V}$ |
| $Q_{ia}$ | flow-major spin current Fullmaga | $\mathrm{A\,m^{-2}}$ |
| $D_e$ | współczynnik dyfuzji spinu | $\mathrm{m^2\,s^{-1}}$ |
| $\sigma$ | przewodność elektryczna adaptera | $\mathrm{S\,m^{-1}}$ |
| $\kappa$ | stała konwersji magnetonu Bohra i ładunku elementarnego | $\mathrm{m^2\,s^{-1}}$ |
| $i,a$ | kierunek przepływu i polaryzacji spinu | $1$ |

Publiczne source-backed witness: `ns.showdata('conductor','v_iter')`,
`'s_iter'` i `'ts_err'`. Ostatnia wartość pochodzi z energy supermodule,
czyli ostatniej spinowej zmiany iteratu, nie charge/PDE residualu.
Liczniki dotyczą ostatniego block; nie sumujemy ich jako wszystkich
iteracji. `counter == 200` jest cap-hit, nigdy dowodem convergence.
Zewnętrzny coupled residual obejmujący finalny CMBND i V/S pozostaje
**unavailable**: brak zgodnego native interface witness. Na r0 nie wolno
podstawić residualu0 ani dowolnej central-difference miary bez komórek bulk.

### Absolutne zmiany zapisanych pól (R2)

Dla dokładnie trzech par żądań $(p,q)\in\{(1,2),(2,4),(4,8)\}$,
osobno w domenach $m\in\{\mathrm N,\mathrm F\}$, raport zawiera:

```{math}
:label: nf-diagnostic-absolute-field-change
\Delta_{m,c}^{p,q}=\max_{K\in\mathcal C_m}|F_{mK,c}^{(q)}-F_{mK,c}^{(p)}|.
```

| Symbol / token | Znaczenie | SI |
|---|---|---|
| $p,q$ | stała para liczników żądań, nie liczników wewnętrznych solve | $1$ |
| $\mathcal C_m$ | wszystkie zapisane komórki domeny, także boundary; nie zbiór sweep $\mathcal U_m$ | $1$ |
| $F_{mK,c}$ | skalar $V$, składowa $S_a^B$, $J_{c,i}$ albo $Q_{ia}=J^{s,B}_{ia}/\kappa$ | $\mathrm V\;\text{or}\;\mathrm{A\,m^{-1}}\;\text{or}\;\mathrm{A\,m^{-2}}$ |
| $c$ | indeks składowej: 0 dla $V$, 0..2 dla wektorów, $3i+a$ dla $Q_{ia}$ | $1$ |
| $\Delta_{m,c}^{p,q}$ | maksimum absolutnej różnicy danej składowej | $\mathrm V\;\text{or}\;\mathrm{A\,m^{-1}}\;\text{or}\;\mathrm{A\,m^{-2}}$ |
| $K_{m,c}^{p,q}$ | pierwszy rzeczywisty indeks maksimum w porządku x-fast, także trójka indeksów siatki | $1$ |

Przed odejmowaniem owner `absolute_field_changes` wymaga identycznej siatki,
origin, kroków, kolejności x-fast, liczby komórek i składowych. Nie zakłada
identycznej siatki N i F: zgodność dotyczy tej samej domeny między snapshotami.
Każdy wynik zachowuje SHA surowego pliku przed i po zmianie, indeks komórki
oraz zaobserwowane maksima modułu wartości przed i po. Nie używa tych maksimów
jako mianowników, floors ani bramek. Dla dziewięciu składowych $Q_{ia}$ używa
wyłącznie dotychczasowego $J^{s,B}_{ia}/\kappa$, bez fitu znaku lub skali.
Wartości wejściowe i wyniki dzielenia/odejmowania muszą być skończone.
Zgodny carrier nie dowodzi, że zewnętrzny writer nie przestawił samych wartości;
obowiązuje istniejący przypięty exporter i jego porządek OVF.
Zerowa różnica tekstowych próbek pozostaje **unresolved**, nigdy converged.
To metryka zmiany zapisanych iteratów, nie residual ani physics PASS.

### Wejście, zasoby i provenance

| Parametr | Stała wartość | SI / walidacja |
|---|---|---|
| Snapshot command counts | 1,2,4,8; jeden proces, najwyżej8requests | $1$; literal, bez user list |
| Native V/S stopping | 1e-5, maxiter200; bez zmian | $1$; actual readback |
| Solver deadline |180 dla całego procesu i wszystkich eksportów | $\mathrm{s}$; bez resetu po snapshot |
| Worker deadline |240 całości | $\mathrm{s}$ |
| CPU/memory/PID |2CPU,2GiB,128pids | $1$, $\mathrm{byte}$, $1$; istniejąca atestacja |
| Worker tmpfs |256MiB | $\mathrm{byte}$; bez podwyższenia |
| Raw output |16OVF/snapshot, initial-M, metadata/logs/probe | zamknięta membership i SHA; żadnego v3summary |
| Odczyt serializacji |dataprecision17 | $1$; numeric actual, po configure |
| Text OVF payload |niezmieniony domyślny ostream6 | $1$; nie binary64 witness |

Recepta/profil należy do istniejącego `docker-dev-nf-common-qualify` i
`docker_nf_common_volume`, z jawnym zamkniętym literalem profilu.
Defaultcomparison zachowuje dotychczasowe wejście. Diagnostyka nie uruchamia
Fullmaga/compare i nie jest przyjmowana przez commoncase/native/summaryv3.
Nie ma nowego launchera ani solvera. Admission przed/po zachowuje dokładne
source/package/image/prefix/binary/ABI/tool/owner binding; zmienione narzędzia
wymagają zgodnego canonical capture, nie wyjątku `_source_matches`.
Dane techniczne pozostają wcontrolvolume, raw naukowe pod rozwiązanym
Windows runs_root, osobny reportID; brak blindretry albo overwrite.

Python→ProblemIR: publiczny Fullmag DSL i IR nie zmieniają się. Istniejące
materiały/BC/mapy są z common-case; native BORIS ma oddzielny skrypt z
powtórzeniami własnej komendy, bez drugiej definicji fizyki. SI mapping $\mu_{s,a}=2D_e S^B_a/(\sigma\kappa)$ i $Q_{ia}=J^{s,B}_{ia}/\kappa$ pozostaje stały, bez fitted signs.

### Ograniczenie tekstowej kwantyzacji i decyzje

`dataprecision17` poprawia socket/header, ale `OVF2::Write_OVF2_VEC/SCA`
zapisuje textpayload przez osobny ostream bez setprecision. Równość
snapshotów po odczycie tekstu nie dowodzi równości binary64 pól ani
zbieżności poniżej rozdzielczości6 cyfr. Raport ma zachować literalne pliki,
hashe i absolutne zmiany; below-text-resolution pozostaje unresolved.
Różnice N.Jsx obserwowane wcześniej są większe od ostatniej cyfry i nie
znikają wskutek samego tej uwagi o serializacji.

Upstream wspiera bin8, lecz istniejący `read_text_ovf` obsługuje tylko text.
Najmniejszy profil zachowuje go i ogranicza wnioski. Bin8 wymagałby osobnego
bounded readera/sentinela/endianness/count/carrier/finite/closure tests i
nowej prerejestracji; sama zmiana export string jest niezgodna. Nie dodajemy
takiego czytnika w tym etapie ani nie nazywamy textnoise naprawą wszystkichFAIL.

Walidacja po review: source/parser/kontrakty→niezależny review→zgodny pakiet
i producent→jedno osobne execution. Zapisujemy wszystkie4snapshoty,
V/S/Jc/9Q, fixed M, counters/settings i ich hashe; timeout/nonzero/missing/
unknown pozostają odmową i zachowanymi partial, bez dopełniania danych.
Żaden diagnostic complete nie jest physics/mesh/parity PASS. Prerejestracja
nie zmienia progu1e-6 ani normy aktualnego common porównania. Brak native
coupled residual i strata textprecision są deferred, nie ukryte.

(nf-common-managed-case-v3)=
## Prerejestracja wykonania common-case v3 i osobnych narzędzi Fullmag v2

**CANDIDATE_ONLY; runtime, native execution i benchmark NOT VERIFIED.**
To nowe wejście porównawcze, nie przemianowanie 42 historycznych wejść, runtime85
ani wcześniejszej macierzy. Jedna fizyczna domena ma $L_x=1\,\mathrm{\mu m}$,
$L_y=0.4\,\mathrm{\mu m}$ oraz $t_N=t_F=2\,\mathrm{nm}$.
Trzy siatki r0/r1/r2 mają odpowiednio 4×100×(2+2),4×200×(4+4),4×400×(8+8).
Dokładne kroki pochodzą z `boris_nf_common_case_v3.case_descriptor`, bez zaokrąglania
ich reprezentacji JSON. Nx=4 wymaga actual affine/x-invariance gate wcześniej
zdefiniowanego dla tej translacyjnie niezmiennej rodziny; nie oznacza dowolnej domeny.

| Parametr / owner | Wartość | SI | Mapowanie / walidacja |
|---|---|---|---|
| Fullmag N P,theta | 0,−0.1 | $1$ | SpinTransportMaterial → spin_transport_modules.materials; N jest auxiliary conductor i magnetic_active=false |
| Fullmag F P,theta | −0.4,0 | $1$ | ten sam publiczny materiał → canonical IR; F-only mask i rzeczywiste fixed M=(1,0,0) |
| BORIS F P,betaD | 0.4,0.4 | $1$ | jawny material readback; beta Zhang–Li nie zastępuje betaD |
| Fullmag g_up,g_down | 0,5e14 | $\mathrm{S\,m^{-2}}$ | MixingConductanceSpinInterface; signed channel map wyprowadzony wcześniej, bez epsilon/fitu |
| Fullmag g_r,g_i | 1.5e15,0 | $\mathrm{S\,m^{-2}}$ | interfejs N→F,+z; tensor flow-major |
| sigma,sigma_s | 5.8e7,5.8e7 | $\mathrm{S\,m^{-1}}$ | publiczne charge/spin materials i oba native readbacks |
| D_e,lambda_sf | 0.01,5e−9 | $\mathrm{m^2\,s^{-1}}$,$\mathrm{m}$ | dodatni historyczny adapter mu=2DeS/(sigma kappa),Q=Js/kappa zachowany |
| F lambda_J,lambda_phi | 2e−9,4e−9 | $\mathrm{m}$ | publiczne materiały → reaction; N nie ma reakcji magnetycznych |
| DeltaV | 1e11·1e−6/5.8e7 | $\mathrm{V}$ | fixed voltage, nie zadany rzeczywisty current; gauge Fullmag−BORIS=+DeltaV/2 bez fitu |
| terminale x,sidewalls | homogeneous gradient,total spin insulating | $1$ | HomogeneousSpinPotentialGradient na CAŁYCH obu xfaces N+F, Voltage na tych samych faces; pozostałe faces total Q.n=0 |
| Fullmag linear tolerances | 1e−8,1e−10 | $1$ | dwie istniejące tolerancje, maxiter2000/restart40/Picard20 bez zmian; BORIS jest osobnym stałym solverem |
| actual scope gate | relative1e−6; zero scale exact zero | $1$ | actual max vector norm; affine voltage scale DeltaV; nie jest tolerance solvera ani physics PASS |
| zasoby Fullmag | 2 CPU,2GiB,128pids;2100s całości,300s/case | $1$,$\mathrm{byte}$,$1$,$\mathrm{s}$ | existing managed RAM owner/attestation,768MiB tmpfs bez zmiany; przekroczenie odmawia |

M2 native descriptor musi mieć v2 oraz jawny `magnetic_active_mask` identyczny
z F-only actual plan/layout/raw M. Brak descriptoru, stare defaulty, inne urządzenie,
precision, fallback lub niewłaściwe BC odmawiają. Nie zmieniamy operatora, solvera,
profilu ani tolerance na podstawie wyników. FDM GPU,FEM CPU,FEM GPU pozostają
unsupported dla tej macierzy; FDM CPU double strict jest jedynym źródłowym kandydatem.

`run_fullmag_m2_nf_common_case_v3.build_fullmag_nf_problem` jest kanonicznym publicznym
Python→ProblemIR ownerem nowego request.v3. Wybiera istniejące CurrentTransport,
SpinDriftDiffusion, FrozenSpins i jawny nowy BC; nie dodaje parametru publicznego API
ani drugiego IR. Legacy helpery i stare BORIS identity/runtimev1/v2/v3 nie są
interpretowane jako common runtime.v4. Consumer przyjmuje wyłącznie nowy
managed_run.v3/runtime.v4 po rzeczywistym observe i ponownym raw readback.

Przed całkowaniem current wymagane są rzeczywiste nagłówki obu OVF carrierów,
ustalona translacja całej geometrii Fullmag−BORIS oraz affine/x-invariance raw pól.
Całkowity reciprocal Jc jest całkowany niezależnie na wszystkich czterech xplanes:

```{math}
:label: nf-common-cell-current-quadrature
I_i=\Delta y\Delta z\sum_{j,k}J_{c,x}(i,j,k),\qquad
I_{\mathrm{out},x_{min}}=-I_0,\quad I_{\mathrm{out},x_{max}}=I_3.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $I_i,I_{\mathrm{out}}$ | signed cell-quadrature current na xplane lub outward terminal | $\mathrm{A}$ |
| $J_{c,x}$ | rzeczywisty pełny reciprocal charge-current density | $\mathrm{A\,m^{-2}}$ |
| $\Delta y,\Delta z$ | rzeczywiste kroki carrierów | $\mathrm{m}$ |
| $i,j,k$ | indeksy x,y,z; x-fast; i=0,1,2,3 | $1$ |

To cell quadrature, nie electrode face API. Native BORIS GetCurrent mierzy tylko
sigmaE oraz corrected ground/net: zachowujemy te liczby i ich ograniczenie,
nie promujemy ich do niezależnego full-Jc electrode current. Nie zastępujemy
prądu przez volume mean Jc ani total boundary closure. Stały gauge offset jest
z descriptoru, nigdy z dopasowanej średniej potencjałów.

r0 ma zero bulk interior cells w obu domenach: residual musi być `unavailable`
z nullable wartościami, nigdy zero/PASS. Ten etap dostarcza wyłącznie capacity
oraz raw-completion gate. r1/r2 zachowują rzeczywiste bulk diagnostics; residual
BORIS i solver residual Fullmaga mają odrębne definicje, nie kwalifikują się przez
odejmowanie ich wartości. Porównanie Qz przy interfejsie dotyczy tych samych
adjacent cell centers; różne native traces i FV face law pozostają odrębne.
Torque jest `incomparable`. Nawet sześć complete porównań i mesh refinement
nie jest automatycznym physics/mesh-convergence PASS.

Nowe tools mają osobny manifest SHA i `solver_capsule_attribution=False`.
Native package nadal pochodzi wyłącznie z terminalnego managed build binding
job/commit/source/native SHA i immutable capsule. Publiczny DSL workera pochodzi
z tej kapsuły; hostowy niezależny readback wymaga identycznych public DSL bytes.
Zmiany scripts-only mogą użyć faktycznie zgodnego BC+mask native pakietu bez
przypisywania mu nowych tools. Nowy publiczny DSL/native operator wymaga nowego
pakietu. Nie ma source_hash override, zgadywania runtime ani silent fallback.

Przed actual: niezależny source review obu nowych workerów i dispatch, exact pins,
public Python lowering, odmowy malformed/legacy/case-swap oraz nowy zgodny native
build. Następnie serialny r0 capacity/raw success, r1,r2 z kompletem artefaktów,
niezależne host readback i dopiero osobny convergence/science review. Source,
parser i fixture nie są benchmarkiem ani dopuszczeniem uruchomienia.

(source-code-index)=
## 8. Source-code index

The source map binds every executable claim in this note to a path and symbol.
These rows are implementation-specific; they do not promote a source file to
a qualified workload without the validation gates above.

| Claim | Path | Symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Aneks terminal C+D | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:cd-terminal-completion-receipt-clock` | Strict existing completed owner V2, bounded publication i rzeczywisty terminal clock; planned, bez runtime. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki; source/parser; runtime NOT VERIFIED; planned_contract; storage candidate; path + symbol |
| Aneks terminal C+D | `crates/fullmag-api/src/accepted_study_worker.rs` | `WorkerExecutionCompletedReceiptV2` | Nowy oddzielny strict wire, old V1 closed set nietknięty. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki; source/parser; runtime NOT VERIFIED; planned_contract; storage candidate; path + symbol |
| Aneks terminal C+D | `crates/fullmag-runtime-control/src/study_output_history.rs` | `validate_committed_history` | Rzeczywiste thin history leaves, canonical layout/units oraz existing schedule cursors. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki; source/parser; runtime NOT VERIFIED; planned_contract; storage candidate; path + symbol |
| Aneks terminal C+D | `crates/fullmag-application/src/study_artifact.rs` | `encode_frozen_study_state` | Nowy envelope z rzeczywistym terminal child clock; legacy state bytes nietknięte. | FDM CPU FP64; pozostali unsupported dla nowej ścieżki; source/parser; runtime NOT VERIFIED; planned_contract; storage candidate; path + symbol |
| Jawny adapter metadata terminal M | `crates/fullmag-application/src/study_artifact.rs` | `materialize_study_state_at_terminal_clock` | Metadata aktualnego M bez zmiany wartości | planned_contract; runtime NOT VERIFIED |
| Wspólna owner/role/raw identity | `crates/fullmag-session/src/types.rs` | `terminal_publication_artifact_id` | Jedna formuła publishera i cold readera | planned_contract; runtime NOT VERIFIED |
| Wspólny descriptor | `scripts/boris_nf_common_case_v3.py` | `case_descriptor` | Fixed-domain parameters obu solverów | candidate_source_only_not_executed |
| Wspólny scope gate | `scripts/boris_nf_common_case_v3.py` | `check_affine_x_invariance` | Actual affine/x-invariance bez fitu | candidate_source_only_not_executed |
| Common-case v3 prereg | `docs/physics/0970-spin-hall-drift-diffusion-transport.md` | `DOC-ANCHOR:nf-common-managed-case-v3` | Fixed domain, signed mapping i gates | planned_contract; NOT VERIFIED |
| Common Python→IR | `scripts/run_fullmag_m2_nf_common_case_v3.py` | `build_fullmag_nf_problem` | Rzeczywisty publiczny request.v3 | candidate_source_only_not_executed |
| Full Jc cell quadrature | `scripts/run_fullmag_m2_nf_common_case_v3.py` | `validate_common_fields` | Eq nf-common-cell-current-quadrature; actual4planes | candidate_source_only_not_executed |
| Native readback | `scripts/run_managed_fullmag_nf_common_v2.py` | `validate_case` | Descriptorv2/mask/BC i niezależny host | candidate_source_only_not_executed |
| Typed runtimev4 consumer | `scripts/run_boris_fullmag_nf_common_matrix_v3.py` | `normalize_common_boris` | Nullable bulk residual i legacy refusal | candidate_source_only_not_executed |
| Planowany most frozen state-output | `docs/physics/0970-spin-hall-drift-diffusion-transport.md` | `DOC-ANCHOR:spin-transport-frozen-state-output-bridge` | Pełna historia i jawny codec w istniejącym publisherze | planned_contract; bez runtime/ExactResume |
| Publiczna odmowa transport resume A | `crates/fullmag-runner/src/lib.rs` | `validate_fdm_transport_checkpoint_resume_support` | Wspólna odmowa checkpoint continuation dla rzeczywistego CPU M1/M2/M3 workflow; Ok(()) nie dowodzi admission. | FDM CPU M1/M2/M3; SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; runtime i pełne v2 OPEN |
| Publiczna odmowa transport resume A | `crates/fullmag-api/src/session_persistence.rs` | `checkpoint_resume_unsupported_reason` | Typed metadata i schema wyznaczają powód Unsupported; brak wymaganej transport identity daje odmowę. | FDM CPU M1/M2/M3; SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; runtime i pełne v2 OPEN |
| Publiczna odmowa transport resume A | `crates/fullmag-api/src/session_persistence.rs` | `supported_checkpoint_restore_class` | Unsupported przed dotychczasową klasyfikacją; pozostały catalog self-compatibility nie jest naprawiony przez A. | FDM CPU M1/M2/M3; SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; runtime i pełne v2 OPEN |
| Publiczna odmowa transport resume A | `crates/fullmag-api/src/session_persistence.rs` | `restore_checkpoint_with_context` | API odmawia przed odczytem common state i mutacją snapshotu; brak automatycznego downgrade. | FDM CPU M1/M2/M3; SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; source freeze 77afed0bb488f115d3692e27044d5209daa876e33eceafbe34e78566c8267844; runtime i pełne v2 OPEN |
| Prywatny codec composite v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `FdmCompositeCheckpointV2` | Prywatne typy composite v2; IMPLEMENTED_SOURCE_ONLY, NOT_COMPILED, NOT_EXECUTED. | FDM CPU FP64; IMPLEMENTED_SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; parser/source checks; worktree/uncommitted; ExactResume/runtime NOT VERIFIED |
| Prywatny codec composite v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `decode_composite_m3_codec_v2` | Strict raw ingress, required-null, typed roundtrip i outer hash; wyłącznie codec źródłowy. | FDM CPU FP64; IMPLEMENTED_SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; parser/source checks; worktree/uncommitted; ExactResume/runtime NOT VERIFIED |
| Prywatny original-stage gate | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `validate_for_original_stage` | CodecCheckedCompositeV2::validate_for_original_stage sprawdza oryginalne problem/plan/stage/outputs przekazane przez admitted ownera; sam helper nie dowodzi immutable admission. SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED. | FDM CPU FP64; source_only_unqualified; SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; parser/source checks; worktree/uncommitted; pozostałe contextual gates OPEN |
| Prywatny codec composite v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport/composite_checkpoint.rs` | `validate_self_contained` | Reuse nested walidatorów oraz bitowe clocks/history/frozen i output shape; contextual gates i ExactResume nadal planned, NOT VERIFIED. | FDM CPU FP64; IMPLEMENTED_SOURCE_ONLY; NOT_COMPILED; NOT_EXECUTED; parser/source checks; worktree/uncommitted; ExactResume/runtime NOT VERIFIED |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-checkpoint` | Kontrakt wrappera i required pól; prywatny codec IMPLEMENTED_SOURCE_ONLY, publiczna integracja planned. | planned_contract; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-hash` | Strict ingress, kompletność nested codecs i kanoniczny outer hash. | planned_contract; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-accepted-history` | Outer accepted dt i rzeczywiste inner ARS history, bez dopisywania timestampów. | planned_contract; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-output-commit` | Binding istniejącego committed output manifestu i jawna odmowa braku trwałego prefixu. | planned_contract; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v2-composite-atomic-restore` | Atomowy capture/restore w istniejących ownerach; bez recapture i implicit continuation. | planned_contract; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `FdmCoupledCheckpoint` | Istniejący nested M3 V1, accepted/history/controller i własny payload digest. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `validate_complete_coupled_checkpoint` | Istniejąca pełna walidacja nested M3, bez zastępowania jej wrapperem. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/constraints/checkpoint.rs` | `FrozenSpinsCheckpointV1` | Istniejący mask/reference/activation codec i historyczne defaults niedozwolone jako brakujące dane V2. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/constraints/activation.rs` | `FrozenSpinsActivationSet` | Reuse istniejącej historycznej mapy epok i active set. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/interactive/runtime.rs` | `frozen_spins_activation_set` | Rzeczywisty runtime owner historycznej activation set między etapami. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-cli/src/interactive_runtime_host.rs` | `ensure_interactive_preview_runtime` | Przeniesienie historycznego activation set przy przebudowie stage runtime. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_coupled_checkpoint` | Istniejący adaptive full/two-half acceptance oraz outer dt/history writer; nie dowód runtime. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/schedules.rs` | `OutputSchedule` | Istniejący pojedynczy owner next_time i last_sampled_time; brak checkpoint cursorów V2. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-session/src/types.rs` | `canonical_json_bytes` | Istniejąca rekursywna kanonizacja JSON użyta w prywatnym codec outer digest; runtime NOT VERIFIED. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-quantities/src/accepted_state.rs` | `AcceptedStateRef` | Istniejąca tożsamość accepted clocks/state/generation bez nowego modelu. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-session/src/types.rs` | `FmsStudyOutputManifest` | Istniejący CAS-backed manifest z task/attempt/step i accepted-state reference. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-session/src/types.rs` | `FmsArtifactCatalog` | Istniejący katalog revision i immutable published entries, nie nowy receipt. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-runner/src/artifact_pipeline.rs` | `record_scalar` | Enqueue outputu nie potwierdza durable checkpoint prefixu. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-session/src/store.rs` | `commit_checkpoint` | Istniejący writer lease, common state, reachability oraz commit marker. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `crates/fullmag-session/src/capture.rs` | `capture_checkpoint` | Istniejący capture common M/backend payload przed publikacją markeru. | source_only_unqualified; prereg composite_v2_*; runtime NOT VERIFIED |
| Composite checkpoint v2 | `docs/physics/0970-spin-hall-drift-diffusion-transport.md` | `DOC-ANCHOR:spin-transport-composite-resume-v2` | Granica prerejestracji composite bez rozszerzania kwalifikacji legacy. | planned_contract; prereg composite_v2_*; runtime NOT VERIFIED |
| Prerejestracja frozen transport | `docs/physics/0996-frozen-spins-constraint.md` | `DOC-ANCHOR:frozen-spins-auxiliary-transport-time` | Prerejestracja no-op M oraz aktywnego transportu w fizycznym czasie; runtime niezweryfikowany. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `planned_contract`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:frozen-v1-all-frozen` | Executed steps, czas, pause/cancel i odmowa Relax+M3. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `planned_contract`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `docs/physics/0970-spin-hall-drift-diffusion-transport.md` | `DOC-ANCHOR:spin-transport-frozen-free-error-support` | Wspólny free-target support outer-error gate; bez zmiany bilansów. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `planned_contract`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_coupled_checkpoint` | Istniejący owner czasu, counters, outputs i completion; shortcut/gates wymagają naprawy. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_coupled_heun_trial` | Istniejący transaction Heun evaluate/commit/rollback. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_coupled_ars_trial` | Istniejący transaction ARS i historia M3. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/cpu/integrators.rs` | `heun_trial_with_external_stage_terms_and_lte` | Źródłowy raw embedded Heun estimator w borrowed k[2], mask/restore; typy i runtime NOT VERIFIED. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/shared/types.rs` | `TransportStageErrorBudget` | Źródłowy borrowed per-cell estimator i resolved frozen mask; synchroniczny zakres callback/solve bez nowego stanu; runtime NOT VERIFIED. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `CoupledTransportOuterErrorBudget` | Istniejący budżet outer-error z Gilbert-source delta; nie wprowadzać arbitralnego floor. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | `FdmSpinTransportWorkflow` | Istniejący accepted/rejected counters, cache, snapshot i checkpoint. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | `transport_torque_delta_l2` | Źródłowa wspólna redukcja obu norm po target∩free, empty support i finite guards; runtime NOT VERIFIED. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-runner/src/time_events.rs` | `build_resolved_stage_event_schedule_with_origin` | Istniejący owner zdarzeń; envelope current i fixed M3 clipping wymagają dowodów/naprawy. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| Prerejestracja frozen transport | `crates/fullmag-plan/src/validate.rs` | `validate_conservative_relaxation` | Istniejąca odmowa niekonserwatywnych torque; jawna odmowa Relax+M3 jeszcze niezaimplementowana. | FDM CPU FP64; inne lane niekwalifikowane; gates `frozen-spins-auxiliary-transport-time`; `source_only_unqualified`; `worktree/uncommitted`; path + symbol |
| boris-offline-toolchain-dependency-selection | scripts/local_runner/boris_toolchain.py | dependency_selection | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-validate-bundle | scripts/local_runner/boris_toolchain.py | validate_bundle | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-validate-wheels | scripts/local_runner/boris_toolchain.py | validate_wheels | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-prepare-context | scripts/local_runner/boris_toolchain.py | prepare_context | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-install-apt | scripts/local_runner/boris_toolchain.py | install_apt | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-install-wheels | scripts/local_runner/boris_toolchain.py | install_wheels | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-runtime-preflight | scripts/local_runner/boris_toolchain.py | runtime_preflight | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-build-image | scripts/local_runner/boris_toolchain.py | build_image | Offline dependency admission, image provenance or bounded toolchain preflight; does not qualify the BORIS solver. | source_only; toolchain evidence only |
| boris-offline-toolchain-contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:boris-offline-toolchain-provisioning | Separate observed toolchain provisioning from pending BORIS source, ABI, runtime and scientific qualification. | planned_contract; toolchain evidence only |
| boris-source-image-admit-toolchain | scripts/local_runner/boris_cpu.py | admit_toolchain | Bind exact source bytes and qualified toolchain inputs or verify offline source-image provenance; no solver qualification. | source_only; source-image only |
| boris-source-image-clean-blob-ids | scripts/local_runner/boris_cpu.py | clean_blob_ids | Bind exact source bytes and qualified toolchain inputs or verify offline source-image provenance; no solver qualification. | source_only; source-image only |
| boris-source-image-prepare-context | scripts/local_runner/boris_cpu.py | prepare_context | Bind exact source bytes and qualified toolchain inputs or verify offline source-image provenance; no solver qualification. | source_only; source-image only |
| boris-source-image-validate-context | scripts/local_runner/boris_cpu.py | validate_context | Bind exact source bytes and qualified toolchain inputs or verify offline source-image provenance; no solver qualification. | source_only; source-image only |
| boris-source-image-build-image | scripts/local_runner/boris_cpu.py | build_image | Bind exact source bytes and qualified toolchain inputs or verify offline source-image provenance; no solver qualification. | source_only; source-image only |
| boris-source-image-verify-source | scripts/local_runner/boris_cpu.py | verify_source | Bind exact source bytes and qualified toolchain inputs or verify offline source-image provenance; no solver qualification. | source_only; source-image only |
| boris-offline-source-image-contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:boris-offline-source-image-provisioning | Separate observed source-image build and readback from pending native compile, ABI, solver runtime and benchmark. | planned_contract; source-image only |
| boris-managed-runtime-publication | scripts/run_managed_boris_nf.py | observe | Exclusive runtime storage lock, full bundle before exact terminal receipt LAST; precommit resumable I/O failure and immutable postcommit verification. | source_only; interpreted crash/reentrant checks, runtime NOT VERIFIED |
| boris-managed-runtime-admission | scripts/run_managed_boris_nf.py | resolved_boris_build | Authenticated same-actor/worktree terminal job, four trusted hashes, source/ABI/binary/flags/image receipt verification; source only. | source_only; interpreted regressions, native/runtime NOT VERIFIED |
| boris-managed-runtime-reopen | scripts/run_managed_boris_nf.py | verify_runtime_identity | Explicit trusted repo/root i retained closure; końcowe summary recompute wiąże M oraz native JSON z tymi samymi entries, które wracają do public admission; source-only, runtime NOT VERIFIED. | source_only; interpreted regressions, native/runtime NOT VERIFIED |
| boris-managed-runtime-v2-contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:boris-managed-runtime-v2-contract | explicit trusted managed CPU run and public reopen gate | planned_contract; runtime NOT VERIFIED |
| boris-cpu-abi-build-source | scripts/local_runner/boris_cpu.py | run_build | Fixed actual-source CPU ABI production stages share solver compiler flags/link/environment; no execution proof. | source_only; interpreted guards, no native run |
| boris-cpu-abi-verifier-source | scripts/local_runner/boris_cpu.py | validate_abi_outputs | Bounded witness/source/flags/same-job observation and exact stage command binding; no runtime identity admission. | source_only; interpreted guards, no native run |
| boris-cpu-abi-witness-contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:boris-cpu-abi-witness-contract | fixed CPU ABI provenance, separate runtime admission gate | planned_contract; no compilation/runtime proof |
| boris-managed-build-proof-gate | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:boris-managed-build-proof-gate | legacy incomplete, future trusted v2 receipt prerequisite | planned contract, runtime NOT VERIFIED |
| boris-raw-unit-algorithm | scripts/compare_boris_fullmag_she_nf.py | _normalize_boris_fields | pure raw OVF unit mapping after admission; synthetic checker uses algorithm only | 8 points/72 tensor checks, no solver proof |
| boris-build-admission-source | scripts/run_boris_nf_interface.py | _require_verified_build | refusal before output/runtime without trusted build proof | interpreted guards, no native proof |
| Kontrakt projekcji tensora | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:spin-current-tensor-projection-contract | komponent, norma i wektor kolumny po interpolacji | planned contract, runtime/UI jeszcze niezweryfikowane |
| Metadane tensora spinowego | crates/fullmag-quantities/src/catalog.rs | tensor_descriptor | rank, shape, flow/spin axes i 9 etykiet z canonical ID | implementacja; runtime/API jeszcze niezweryfikowane |
| Adapter BORIS v2 | scripts/compare_boris_fullmag_she_nf.py | normalize_boris_artifact; _concat_qia | flow-major rows i raw-OVF provenance | raw OVF fixture, nie parity solverów |
| Strumień interfejsu BORIS | scripts/verify_boris_nf_interface.py | compute_interface_slice | wszystkie polaryzacje wiersza z | oba znaki normalnej na fixture |
| Regresja adaptera BORIS | scripts/verify_boris_tensor_adapter.py | main | 8 punktów N/F, 72 komponenty, jednostki i torque refusal | RED→GREEN, bez solve |
| M1 charge realization | backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_charge | FEM CPU charge assembly and solve | managed native M1 contract |
| M1 spin realization | backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_spin | FEM CPU spin assembly and solve | managed native M1 contract |
| M2 reciprocal realization | backends/fem/cpu/mfem/transport/steady_transport.cpp | SteadyTransportOracle::solve_reciprocal | monolithic reciprocal FEM block solve | focused managed M2 runtime test |
| M2 C ABI | native/include/fullmag_fem.h | fullmag_fem_solve_steady_transport_m2_v1 | stable request and result contract | native ABI contract |
| Planner resolution | crates/fullmag-plan/src/spin_transport.rs | resolve_m1_fem_spin_transport | bounded M1/M2 descriptor and Schur checks | planner M2 test |
| Resolved transport execution tuple | crates/fullmag-plan/src/spin_transport.rs | resolve_spin_transport_with_active_graph | complete typed requested/resolved discretization, device, precision, and execution-mode provenance | bounded FDM GPU M1 planner and serde round-trip test; unvalidated |
| Descriptor materialization | crates/fullmag-runner/src/native_fem/steady_transport/descriptor.rs | materialize_native_fem_steady_transport_request | fail-closed descriptor-to-FFI mapping | runner materialization test |
| Native dispatch | crates/fullmag-runner/src/native_fem/steady_transport.rs | solve_native_fem_steady_transport | explicit M1/M2 ABI selection and provenance | runner runtime test |
| FDM reference | crates/fullmag-runner/src/fdm/cpu/spin_transport.rs | solve_coupled_module | CPU FDM coupled charge/spin realization | FDM reference/common-limit tests |
| Native FDM M1 C ABI | native/include/fullmag_fdm.h | fullmag_fdm_cpu_charge_solve_v1; fullmag_fdm_cpu_steady_spin_solve_v1 | append-only request/result and accepted-snapshot contract | managed ABI layout and canary gate |
| Native FDM M1 ABI adapter | backends/fdm/api/cpu_transport_v1.cpp | fullmag_fdm_cpu_charge_solve_v1; fullmag_fdm_cpu_steady_spin_solve_v1 | checked record extents, owner translation, exact topology mapping, and result publication | fdm_cpu_transport_abi_v1_contract |
| Native FDM M1 Rust FFI | crates/fullmag-fdm-sys/src/lib.rs | fullmag_fdm_cpu_charge_result_v1; fullmag_fdm_cpu_steady_spin_result_v1 | byte-exact Rust records and symbol declarations | layout-manifest and compile-fail ownership tests |
| Native FDM M1 record extent guard | backends/fdm/api/cpu_transport_v1.cpp | input_records | reject overflowing public record byte extents before dereference | excessive-count pointer canaries |
| Native FDM M1 observation mapping | backends/fdm/api/cpu_transport_v1.cpp | unique_interface_observation | match each owner observation exactly once by full topology | unsorted multi-interface ABI contract |
| Native FDM M1 charge Rust symbol | crates/fullmag-fdm-sys/src/lib.rs | fullmag_fdm_cpu_charge_solve_v1 | declare the native charge solve to Rust | layout-manifest and public E2E gate |
| Native FDM M1 spin Rust symbol | crates/fullmag-fdm-sys/src/lib.rs | fullmag_fdm_cpu_steady_spin_solve_v1 | declare the native spin solve to Rust | layout-manifest and public E2E gate |
| Native FDM M1 runner adapter | crates/fullmag-runner/src/fdm/cpu/native_transport.rs | solve_native_m1_snapshot | fail-closed descriptor/result mapping and complete artifact carrier | native_m1_v1 full-result mutation tests |
| Native FDM M1 public E2E | crates/fullmag-runner/tests/native_m1_v1_public_e2e.rs | public_native_m1_v1_transparent_and_mixing_artifacts_match_reference_and_provenance | unchanged public planning/running, persistent fields, and honest provenance | opt-in managed contract; unvalidated, not production qualification |
| Native FDM M1 charge | backends/fdm/cpu/transport/charge_transport_v1.cpp | solve | matrix-free charge solve, mixing trace elimination, and immutable accepted snapshot | `just verify-fdm-cpu-m1-charge-native-contract` |
| Native FDM M1 spin | backends/fdm/cpu/transport/spin_transport_v1.cpp | solve | accepted-snapshot spin solve, mixing observations, reaction channels, and torque | `just verify-fdm-cpu-m1-spin-native-contract` |
| Native FDM M1 validation helpers | backends/fdm/cpu/transport/spin_transport_validation_v1.cpp | evaluate_local_residual_gate | cell-local FV acceptance and independently testable direct-SHE contraction | native spin contract |
| Native FDM M1 charge regression | backends/fdm/tests/cpu_charge_transport_contract.cpp | main | oriented traces, conservative current, reversed orientation, and finite-conductance validation | native charge contract |
| Native FDM M1 spin regression | backends/fdm/tests/cpu_spin_transport_contract.cpp | main | independent mixing/reaction/torque algebra, local residual rejection, and six SHE contractions | native spin contract |
| Native FDM GPU M1 spin solver | backends/fdm/gpu/cuda/transport/spin/device_solver.cu | solve_device | FP64 steady spin/direct-SHE, dynamic mixing and target-masked transport torque on the context-owned stream | managed GPU CPU-parity contract; partial and unvalidated |
| Native FDM GPU M1 LLG binding ABI | native/include/fullmag_fdm.h | fullmag_fdm_context_bind_gpu_transport_v1 | append-only 144-byte binding record and public bind/unbind entry points | C11/C++/Rust layout and actual-device ownership contract |
| Native FDM GPU M1 LLG binding | backends/fdm/gpu/cuda/transport/context.cu | context_bind_gpu_transport_rhs; context_begin_gpu_transport_step; context_commit_gpu_transport_step; context_rollback_gpu_transport_step | exclusive one-owner binding, stage trial state and accepted-step promotion/rollback | `just verify-fdm-gpu-m1-transport-llg-lifecycle-contract`; not production qualification |
| Native FDM GPU M1 torque RHS | backends/fdm/gpu/cuda/integrators/transport_rhs_fp64.cu | launch_add_gpu_transport_torque_fp64 | add Gilbert-form transport torque exactly once and pin transport storage through kernel completion | managed Heun/RK4 stage contract and compute-sanitizer; RK23/DP45 Task 6 integration remains under qualification |
| Native FDM GPU M1 adaptive RK stages | backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu; backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu | compute_rhs_into | evaluate solved transport for every current-attempt RK stage and for the accepted endpoint without cross-attempt FSAL reuse | stage, late-failure rollback and fresh-attempt adaptive-retry contract; restart gate still open |
| Native FDM GPU M1 ABM3 stages | backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu | launch_abm3_step_fp64 | evaluate solved transport in warmup and predictor-corrector stages, publish only the corrected-endpoint derivative into accepted ABM history, and preserve history on pre-commit failure | warmup, full-step and late-failure history contract; checkpoint/restart gate still open |
| Rust M1 parity oracle | crates/fullmag-engine/examples/fdm_spin_oracle_v1.rs | main | nonzero mixing charge/spin fixture and public interface observations | managed Rust/native parity |
| Native M1 parity comparator | backends/fdm/tests/cpu_spin_transport_parity.cpp | main | solved-field, reaction, torque, balance, and public interface-flux comparison | managed Rust/native parity |
| Planner regression | crates/fullmag-plan/src/spin_transport.rs | resolves_bounded_fem_m2_to_reciprocal_descriptor_without_fallback | no-fallback M2 planning invariant | focused managed test |
| Runtime regression | crates/fullmag-runner/src/native_fem/steady_transport.rs | native_m2_solver_publishes_reciprocal_diagnostics | reciprocal provenance identity | focused managed test |
| ABI layout regression | crates/fullmag-fem-sys/src/lib.rs | steady_transport_m2_request_keeps_v1_as_a_nested_prefix | append-only nested M1-prefix guarantee | focused managed test |
| M2 affine constitutive oracle | backends/fem/tests/steady_transport_abi_contract.cpp | cpu_double_reciprocal_m2_affine_constitutive_oracle | nonzero-gradient signs, half-gradient convention, node-major projection, two-drive Onsager cross response, and positive dissipation | `just verify-fem-steady-transport-m2-affine-contract` |
| M2 mesh convergence oracle | backends/fem/tests/steady_transport_contract.cpp | reciprocal_m2_converges_on_three_mesh_resolutions | finite-spin-flip reciprocal FEM midpoint convergence on three conforming tetrahedral mesh resolutions | `just verify-fem-steady-transport-m2-convergence-contract` |
| M2 FDM/FEM common-limit oracle | crates/fullmag-runner/src/native_fem/steady_transport.rs | reciprocal_m2_common_si_limit_matches_fdm_and_fem_reference_profiles | compare matched reciprocal FDM cell centres with FEM plane averages over three z resolutions | `just verify-fem-steady-transport-m2-common-limit-contract` |
| FDM M2 heterogeneous-interface gate | crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin_tests.rs | m2_anisotropic_nf_interface_meets_the_declared_physical_balance_tolerance | exercise an anisotropic N/F region jump and a companion mixing/SML closure with explicit torque accounting | `just verify-fdm-m2-heterogeneous-interface-contract` |
| M2 3-D SHE/iSHE/AHE common-limit gate | crates/fullmag-runner/src/native_fem/steady_transport.rs | reciprocal_m2_3d_she_ishe_common_limit_matches_fdm_and_fem_profiles | compare matched 3-D reciprocal FDM/FEM plane profiles under coupled transverse refinement with nonzero SHE, iSHE, and AHE | `just verify-fem-steady-transport-m2-3d-common-limit-contract` |
| Public CurrentTransport charge planner | crates/fullmag-plan/src/current_transport.rs | resolve_fdm_gpu_charge_transports | lower the bounded Python/ProblemIR charge descriptor with fail-closed FDM/CUDA/FP64/strict constraints | public bounded path; unvalidated |
| Public FDM GPU charge runner | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | execute_public_gpu_charge_only | map the resolved descriptor to the CUDA M1 charge ABI, read back V/J, and publish provenance without fallback | `just verify-fdm-gpu-public-charge-runtime`; bounded actual-device E2E |
| Public charge fixture and analytic oracle | examples/fdm_gpu_charge_public.py; scripts/verify_fdm_gpu_public_charge_output.py | study; main | define the 2 x 1 x 1 affine voltage fixture and independently verify V/J, residuals, and provenance | managed public charge gate |
| Public charge managed recipe | justfile | verify-fdm-gpu-public-charge-runtime | compile the CUDA runtime and CLI through the container-backed managed path, run the fixture, and execute the oracle | actual RTX 4080 SUPER; unvalidated |
| `fdm-gpu-public-charge-planner`: public numerical-domain proof | crates/fullmag-plan/src/current_transport.rs | bounded_fdm_gpu_charge_has_single_numerically_connected_component | reproduce native harmonic internal conductance and reject a full grid unless every adjacent pair has finite strictly positive conductance | planner regression |
| `fdm-gpu-public-charge-runner`: public numerical-domain preflight | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | validate_single_numerically_connected_domain | repeat the native harmonic conductance proof before ABI entry and reject zero, NaN, or infinite internal conductance without a fallback | runner ABI regression |
| `fdm-gpu-public-charge-planner`: public pure-Neumann planner profile | crates/fullmag-plan/src/current_transport.rs | bounded_fdm_gpu_charge_boundary_profile | require two opposite balanced current-density faces, zero-mean gauge, and four insulating faces without relaxing the FDM/CUDA/FP64/strict scope | planner regression |
| `fdm-gpu-public-charge-runner`: public pure-Neumann boundary preflight | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | validate_boundary_faces | reconstruct and exactly cover all external FDM faces; reject noncanonical geometry, nonfinite terminal currents, unbalanced, mixed, or gauge-incompatible profiles before native execution | runner ABI regression |
| `fdm-gpu-public-charge-runner`: public CUDA ABI lifecycle | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | execute_with_abi | map the selected gauge policy to the frozen CUDA ABI and execute the bounded context/snapshot lifecycle | runner ABI regression |
| `fdm-gpu-public-charge-runner`: public fields and provenance | crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs | execute_public_gpu_charge_only | publish accepted V/J fields and the resolved zero-mean provenance without fallback | managed public charge gates |
| `fdm-gpu-public-zero-mean-fixture` and `fdm-gpu-public-zero-mean-verifier`: public pure-Neumann fixture and analytic oracle | examples/fdm_gpu_charge_zero_mean_public.py; scripts/verify_fdm_gpu_public_charge_zero_mean_output.py | build_study; main | define the balanced 2 x 1 x 1 current-density fixture and verify sign, gauge, balances, and provenance | managed pure-Neumann gate |
| Public pure-Neumann managed recipe | justfile | verify-fdm-gpu-public-charge-zero-mean-runtime | compile through the container-backed runtime, execute the public fixture, and run the independent oracle | managed actual-device gate |
| FDM GPU M1 contract and qualification boundary | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:fdm-gpu-m1-fp64-contract | own the bounded charge realization and keep the broader M1 qualification gates explicit | partial implementation; unvalidated |
| Frozen solved-current racetrack contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:racetrack-m1-v1-contract | freeze the synthetic fixture, equations, signs, parameter provenance, and qualification boundary | bounded implementation and executable contract; production qualification remains open |
| Racetrack stage current action | crates/fullmag-application/src/script_stage_materialization.rs | apply_pipeline_set_transport_current | apply the complete named normal-current electrode set at a workflow stage with exact terminal coverage | source contract; fresh production gate remains open |
| Racetrack stage torque action | crates/fullmag-application/src/script_stage_materialization.rs | apply_pipeline_set_spin_torque_enabled | atomically enable or disable the typed spin-torque graph module and incoming edges | source contract; fresh production gate remains open |
| Racetrack zero-drive torque gate | crates/fullmag-plan/src/spin_transport.rs | materialize_fdm_descriptor | allow inactive torque only when all named normal-current terminals are exactly zero and preserve fail-closed nonzero-drive conservation | source contract; fresh production gate remains open |
| Public racetrack Neel seed authoring | packages/fullmag-py/src/fullmag/init/textures.py | neel_skyrmion | serialize the exact public preset parameters, world mapping, and translation into current ProblemIR | public lowering and formula-sample contract test |
| Python racetrack Neel seed evaluator | packages/fullmag-py/src/fullmag/init/preset_eval.py | _skyrmion | evaluate and normalize the repository-owned analytic skyrmion formula | centre, wall, far-field, direction, and norm contract samples |
| Rust racetrack Neel seed evaluator | crates/fullmag-plan/src/magnetization_textures.rs | eval_skyrmion | evaluate the same analytic preset from typed ProblemIR | current typed fixture parser and formula source-map gate |
| FDM GPU M1 append-only ABI | backends/fdm/include/fullmag/fdm/transport/gpu_abi_v1.h | fullmag_fdm_gpu_transport_solve_charge_v1 | declare typed/versioned charge payloads, opaque handles, artifact and checkpoint records | layout/C11/Rust contract gates |
| FDM GPU M1 typed-view validation | backends/fdm/gpu/cuda/transport/context.cu | validate_host_view | reject malformed host records before static ownership transfer or publication | managed actual-device charge gates |
| FDM GPU M1 charge operator | backends/fdm/gpu/cuda/transport/charge/device_solver.cu | solve_device | assemble conservative harmonic-FV charge and execute fixed-tree FP64 CG with linear-cost geometric `2 x 2 x 2` aggregation and exact device RAP | uniform/layered/scalability actual-device gates |
| FDM GPU M1 component gauge | backends/fdm/gpu/cuda/transport/charge/device_solver.cu | label_reference_components_kernel; project_free_component_means; charge_pcg_device_amg_kernel | label conductive components, enforce Neumann compatibility, and project free components to zero mean without CPU fallback | managed actual-device proof in `fdm-gpu-m1-charge-uniform-v1` evidence; public path and scalability remain open |
| FDM GPU M1 checkpoint codec | backends/fdm/gpu/cuda/transport/charge/checkpoint_codec.cpp | build_checkpoint; parse_checkpoint | encode and decode canonical charge-only FMGPUTR1 sections 1--9/18/20 | frozen codec oracle plus runtime identity A/B gate |
| FDM GPU M1 Rust ABI mirror | crates/fullmag-fdm-sys/src/gpu_transport_abi_v1.rs | fullmag_fdm_gpu_transport_solve_charge_v1 | mirror append-only C layouts and symbols without adding a public runner | Rust layout tests |
| FDM GPU M1 uniform regression | backends/fdm/tests/gpu_m1_charge_uniform_v1_contract.cpp | main | check analytic FP64 field/current, AMG/cache audit, transfer bounds and zero fallback on a physical GPU | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 scalability regression | backends/fdm/tests/gpu_m1_charge_scalability_v1_contract.cpp | main | execute the public FP64 charge path for 1,048,576 cells, record upload/solve timings, verify exact geometric coarse size, and reject host fallback | `just verify-fdm-gpu-m1-charge-scalability-contract` |
| FDM GPU M1 layered regression | backends/fdm/tests/gpu_m1_charge_layered_v1_contract.cpp | main | compare harmonic layered conduction with analytic and independent CPU FP64 oracles | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 snapshot regression | backends/fdm/tests/gpu_m1_charge_snapshot_v1_contract.cpp | main | separate the frozen synthetic codec oracle from identity-dependent runtime export/import and prove bitwise no-resolve readback | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 boundary mutation regression | backends/fdm/tests/gpu_m1_charge_boundary_mutation_v1_contract.cpp | main | reject malformed typed records without state publication and exercise voltage/density/insulating faces | `just verify-fdm-gpu-m1-charge-native-contract` |
| FDM GPU M1 runtime ABI contract | docs/specs/spin-transport-runtime-contract-v1.md | DOC-ANCHOR:fdm-gpu-m1-abi-v1 | specify append-only layout, state machine, exact checkpoint grammar and fail-closed errors | normative contract with partial implementation |
| FDM GPU M1 spin-observation ABI | backends/fdm/include/fullmag/fdm/transport/gpu_abi_v1.h | fullmag_fdm_gpu_transport_solve_steady_spin_v1 | declare the steady-spin entry point and append-only typed immutable observation readback | C11 and Rust layout contracts |
| FDM GPU M1 spin operator and compact observations | backends/fdm/gpu/cuda/transport/spin/device_solver.cu | solve_device; materialize_observation_range | solve FP64 steady spin, retain per-cell reaction/torque in compact SoA, retain immutable interface identity, and reconstruct complete 288-byte records only during bounded readback | `just verify-fdm-gpu-m1-spin-native-contract`; actual-device PASS, capability remains semantic-only |
| FDM GPU M1 spin-observation parity | backends/fdm/tests/gpu_m1_spin_operator_parity_v1_contract.cpp | main | compare reconstructed typed observations with the CPU owner, including reversed orientation and exact accepted charge traces | managed actual-device CPU--GPU parity PASS |
| FDM GPU M1 sparse public dispatch | backends/fdm/tests/gpu_m1_spin_sparse_dispatch_v1_contract.cpp | main | prove 1,048,576-cell public dispatch, 512 MiB external envelope, 2 GiB total peak, persistent cache, component-sensitive digest invalidation, NaN rollback and deterministic restore | `just verify-fdm-gpu-m1-spin-native-contract`; actual-device PASS |
| FDM GPU M1 sparse performance | backends/fdm/tests/gpu_m1_spin_sparse_performance_v1_contract.cu | main | enforce the frozen absolute setup, warm-solve, transfer and whole-context memory budgets on one identified GPU | `just verify-fdm-gpu-m1-spin-sparse-performance-contract`; durable actual-device JSON PASS |

| Kontrakt | Ścieżka | Symbol | Odpowiedzialność i dowód |
|---|---|---|---|
| boris-fixed-m-managed-factory-boundary | scripts/run_managed_boris_nf.py | fixed_inputs | Fixed factory przekazuje wyłącznie execution_output_dir=/export, stały cel kontenera bez nowego storage-root/override; exact-script byteguard zachowany, runtime NOT VERIFIED. |
| boris-fixed-m-v2-contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:boris-fixed-m-transport-v2-contract | Przerejestracja przed kodem fixed-M N/F v2; implementacja SOURCE_ONLY, runtime NOT VERIFIED i SCENARIO_NOT_QUALIFIED. |
| boris-fixed-m-generator-boundary | scripts/boris_nf_interface_smoke.py | render_boris_script | Zapisany renderer static0/computefields, jawny l_J, dwa eksporty M i literal-only /export; implementacja źródłowa, runtime NOT VERIFIED. |
| boris-fixed-m-ovf-reader-boundary | scripts/verify_boris_nf_interface.py | read_text_ovf | Jednorazowy odczyt surowych bytes OVF, dekodowanie i hash tych samych bytes; geometria i wszystkie komórki, bez dowodu runtime. |
| boris-fixed-m-summary-boundary | scripts/run_boris_nf_interface.py | _artifact_summary | Summary v2 recompute z retained_outputs wiąże końcowy proof M oraz raw native JSON z tymi samymi verified entries; source-only, bez authority caller JSON. |
| boris-fixed-m-public-admission-boundary | scripts/verify_boris_nf_interface.py | validate_boris_artifact | Publiczny admission v2 wiąże ostatni pomiar M i odczyt native JSON z entries zwróconymi przez identity reopen, dokładnie porównuje proof i odmawia v1; source-only. |
| boris-fixed-m-managed-closure-boundary | scripts/run_managed_boris_nf.py | verified_outputs | Managed re-open ponownie oblicza pomiar M/l_J i wiąże hashe obu nowych OVF z retained closure; source-only, runtime NOT VERIFIED. |
| boris-fixed-m-config-guard | scripts/boris_nf_interface_smoke.py | class NfCaseConfig | NfCaseConfig.__post_init__ odmawia kierunków innych niż dokładne +X przed renderowaniem; source-only. |
| boris-fixed-m-execution-contract | scripts/boris_nf_interface_smoke.py | FIXED_M_EXECUTION | Wspólne dokładne wartości execution v2, tolerancji M/l_J i metody fixed_m_transport_only; source-only. |
| boris-fixed-m-recompute | scripts/verify_boris_nf_interface.py | validate_fixed_m | Jeden owner ponownego pomiaru pełnych pól M, geometrii i l_J oraz dokładnego obiektu proof; source-only, nie wykonanie BORIS. |
| boris-fixed-m-closure-binding | scripts/run_managed_boris_nf.py | require_fixed_m_members | Wiąże hashe sparsowanych M_before/M_after z tymi samymi raw closure members w worker, publikacji, identity i public re-open; source-only. |
| boris-fixed-m-controlled-source-checks | scripts/check_boris_fixed_m_contract.py | check_fixed_m_contract | Kontrolowane syntetyczne OVF, host-path byteguard i A→B odmowy końcowych gałęzi ze stubami admission; bez solvera, builda i nadania runtime identity. |
| boris-fixed-m-native-json-reader | scripts/run_managed_boris_nf.py | read_json | expected_sha256 weryfikuje pojedynczy bounded raw odczyt native JSON przed decode/parse; readback l_J pozostaje przypięty do tych samych retained entries. |
| boris-fixed-m-identity-pin-forwarding | scripts/run_boris_nf_interface.py | validate_runtime_identity | Runtime v2 wrapper przekazuje zwrócone verified entries do ostatniego publicznego pomiaru; nie tworzy odrębnego admission. |
| fdm-cpu-gilbert-stage-helper | crates/fullmag-engine/src/fdm/cpu/fields/direct_torques.rs | external_stage_terms_from_gilbert_source | Jedna konwersja owned Gilbert source z trial m i lokalnym alpha_at do istniejącego explicit ExternalStageTerms; źródła zapisane, runtime NOT VERIFIED. |
| fdm-cpu-gilbert-stage-source-regression | crates/fullmag-engine/tests/fdm_cpu_gilbert_stage.rs | gilbert_stage_uses_local_damping_and_preserves_field_and_source_observations | Zapisana regresja lokalnego alpha, obu flag precesji, zero source, zachowania pól i shape guards; niekompilowana, niewykonana. |
| fdm-cpu-gilbert-stage-field-equivalence | crates/fullmag-engine/tests/fdm_cpu_gilbert_stage.rs | gilbert_source_matches_independent_field_rhs_through_heun_and_ars_trials | Zapisana niezależna tożsamość Gilbert source z polem w czterech krokach Heuna/ARS; niekompilowana, niewykonana. |
| fdm-cpu-gilbert-rhs-contract | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:fdm-cpu-transport-gilbert-rhs-boundary | Prerejestracja przed kodem, historyczny SOURCE_BUG_CONFIRMED i obecna źródłowa poprawka; runtime NOT VERIFIED. |
| fdm-cpu-gilbert-normative | docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md | DOC-ANCHOR:governing-equations | Normatywne rozdzielenie Gilbert source i explicit RHS oraz jedna konwersja; bez nowego dowodu runtime. |
| fdm-cpu-external-stage-type | crates/fullmag-engine/src/fdm/shared/types.rs | ExternalStageTerms | Istniejące direct_torque_per_s to już jawny wkład dm/dt; zmiana jego semantyki jest niedopuszczalna. |
| fdm-cpu-coupled-ars-source | crates/fullmag-runner/src/fdm/cpu/reference.rs | execute_coupled_ars_trial | Historyczny raw-Gilbert/direct mismatch potwierdzony; obecny callback wywołuje jeden CPU engine helper. Source-only, runtime NOT VERIFIED. |
| fdm-cpu-coupled-heun-source | crates/fullmag-runner/src/fdm/cpu/reference.rs | execute_coupled_heun_trial | Historyczny raw-Gilbert/direct mismatch potwierdzony; obecny callback wywołuje jeden CPU engine helper. Source-only, runtime NOT VERIFIED. |
| fdm-cpu-external-rhs-assembly | crates/fullmag-engine/src/fdm/cpu/integrators.rs | apply_external_stage_terms | Dodawanie już jawnych external terms po RHS pola i istniejąca maska; bez zmiany obecnej semantyki. |
| fdm-cpu-local-alpha | crates/fullmag-engine/src/fdm/shared/problem.rs | alpha_at | Istniejący owner lokalnego tłumienia potrzebnego przyszłemu adapterowi; bez korekty normy trial m. |
| fdm-cpu-direct-torque-owner | crates/fullmag-engine/src/fdm/cpu/fields/direct_torques.rs | direct_torques_add_into | Istniejąca granica CPU direct RHS; osobny helper konwertuje wyłącznie zewnętrzne źródło Gilberta, bez drugiej konwersji istniejących torque. |
| boris-fullmag-gmix-imag-authoring | scripts/run_fullmag_m2_nf_reference.py | _problem | G_i z elementu imaginary Gmix do rzeczywistego IR; public lowering/render controls, bez native/parity qualification. |
| boris-managed-matrix-v2-driver | scripts/run_boris_fullmag_she_nf_matrix.py | run_resolution_matrix | Windows-only trzy stałe managed BORIS CPU runtime.v2 razy dwie tolerancje Fullmaga; source-only, benchmark NOT VERIFIED. |
| boris-managed-matrix-v2-pin | scripts/run_boris_fullmag_she_nf_matrix.py | _require_reference_pin | Exact bytes summary/runtime/receipt/scenario przed i po wykorzystaniu; drift odmawia, bez runtime qualification. |
| boris-managed-matrix-v2-validation | scripts/run_boris_fullmag_she_nf_matrix.py | validate_matrix_summary | Walidacja struktury i metryk sześciu rekordów nie zastępuje admission ani nowego wykonania solvera. |
| Mandatory raw FEM identity | crates/fullmag-runner/src/native_fem/steady_transport/artifact_identity.rs | actual_transport_identity; tagged_json_digest | hash actual prepared request, full topology v3, descriptor and result; source-only, runtime unverified |
| Independent public FEM readback | scripts/verify_transport_public_oracles.py | validate_fem_identity; check_fem | exact mesh/intent/operator binding and existing analytical gates; no PASS without managed observation |
| Fixed managed FEM oracle | scripts/run_managed_transport_oracles.py | start; observe; transport_spec | source/package/container/log-output binding; no builds, runtime unverified |



### Indeks C+D prerejestracji i obecnych ownerów

| Claim | Ścieżka | Symbol | Status |
|---|---|---|---|
| Planowany C+D semantic/published wire, thin history i istniejący pojedynczy publisher. | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:cd-terminal-publication-preregistration` | planned_contract |
| Planowany terminal-only callback existing drain przed drop engine/workflow, bez per-step export. | `docs/specs/frozen-spins-v1.md` | `DOC-ANCHOR:cd-terminal-accepted-bundle-hook` | planned_contract |
| Aktualne accepted terminal state i workflow; istniejący punkt przed drop, bez nowego hooka. | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `execute_reference_fdm_with_coupled_checkpoint` | source_only_unqualified |
| Aktualny writer scalar/field i Shutdown flush/drain; nowy complete index planowany. | `crates/fullmag-runner/src/artifact_pipeline.rs` | `writer_loop` | source_only_unqualified |


| Kontrakt diagnostyczny | Ścieżka | Symbol | Dowód |
|---|---|---|---|
| Prerejestracja fixed-M1/2/4/8 | docs/physics/0970-spin-hall-drift-diffusion-transport.md | DOC-ANCHOR:nf-common-fixed-m-iterations-diagnostic | planned_contract; NOT EXECUTED |
| Pinned stopping/counters/BC | scripts/boris_nf_iteration_diagnostic.py | verify_source_contract | exact upstream source pins; source only |
| Oddzielne wejście | scripts/boris_nf_iteration_diagnostic.py | fixed_inputs | jeden r0/8requests/fixed snapshots; NOT EXECUTED |
| Zamknięte raw i liczniki | scripts/boris_nf_iteration_diagnostic.py | validate_outputs | unavailable coupled residual; NOT EXECUTED |
| Absolutne zmiany wszystkich składowych | scripts/boris_nf_iteration_diagnostic.py | absolute_field_changes | fixed pairs; SI/raw SHA/cell index; candidate, NOT EXECUTED |
| Jawny istniejący profil | scripts/docker_nf_common_volume.py | run | wspólne admission/bounds/source; NOT EXECUTED |

| Regresje wejścia i refusal | scripts/test_boris_nf_iteration_diagnostic.py | class IterationDiagnosticContract | pure/mock only; bez native |

(scientific-bibliography)=
## 9. References

1. T. Valet and A. Fert, Phys. Rev. B 48, 7099 (1993), DOI: 10.1103/PhysRevB.48.7099.
2. S. Zhang, P. M. Levy, and A. Fert, Phys. Rev. Lett. 88, 236601 (2002), DOI: 10.1103/PhysRevLett.88.236601.
3. C. Abert et al., Comput. Math. Appl. 68, 639–654 (2014), DOI: 10.1016/j.camwa.2014.07.010.
4. C. Abert et al., Sci. Rep. 5, 14855 (2015), DOI: 10.1038/srep14855.
5. J. L. García-Cervera and X.-P. Wang, J. Comput. Phys. 224 (2007), DOI: 10.1016/j.jcp.2006.10.029.
6. J. E. Hirsch, Phys. Rev. Lett. 83, 1834 (1999), DOI: 10.1103/PhysRevLett.83.1834.
7. S. Zhang, Phys. Rev. Lett. 85, 393 (2000), DOI: 10.1103/PhysRevLett.85.393.
8. Y.-T. Chen et al., Phys. Rev. B 87, 144411 (2013), DOI: 10.1103/PhysRevB.87.144411.
9. A. Brataas, Yu. V. Nazarov, and G. E. W. Bauer, Phys. Rev. Lett. 84, 2481 (2000), DOI: 10.1103/PhysRevLett.84.2481.
10. K. Xia et al., Phys. Rev. B 65, 220401(R) (2002), DOI: 10.1103/PhysRevB.65.220401.
11. Y. Tserkovnyak, A. Brataas, and G. E. W. Bauer, Phys. Rev. Lett. 88, 117601 (2002), DOI: 10.1103/PhysRevLett.88.117601.
12. U. M. Ascher, S. J. Ruuth, and R. J. Spiteri, Appl. Numer. Math. 25,
    151--167 (1997), DOI: 10.1016/S0168-9274(97)00056-1; the published
    `(2,3,2)` tableaus and L-stability contract define `coupled_imex_ark2`.
13. BORIS transport sources under `external_solvers/BORIS/Boris`, used as comparative implementation evidence only.
14. Matplotlib, [release v3.8.4](https://github.com/matplotlib/matplotlib/releases/tag/v3.8.4): wheels built against NumPy 2; dependency provenance only.
15. NumPy, [Troubleshooting ImportError](https://numpy.org/doc/2.0/user/troubleshooting-importerror.html): NumPy 1/2 extension ABI boundary; not solver qualification.
