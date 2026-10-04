<!-- nearest-floquet-telemetry-producer-20261004 -->
(nearest-floquet-telemetry-producer)=
## Diagnostyka rzeczywistego residualu pojedynczego solve'a Floqueta

Ta nota poprzedza zmianę producenta diagnostyki FEM CPU w S05. Solver shared-domain już mierzy rzeczywisty residual shifted KSP oraz jego kryterium względem normy RHS. Dotychczas pełny zapis tej obserwacji jest dostępny w podoknach `frequency_window`, ale nie w samodzielnym `nearest`. Bez niego nie można przeprowadzić kontrolowanego porównania nearest GMRES/FGMRES. Uzupełnienie publikacji nie zmienia równania Schura, normy, tolerancji, liczby modów ani kryterium akceptacji.

Prywatny formatter `floquet_shifted_ksp_diagnostics_json_fields` w `production_cpu_modal_eigen.cpp` serializuje wyłącznie istniejące pola `SLEPcTinyGyrotropicModalEigenResult`. Użycie wymaga rzeczywistego `solver_adapter=floquet_airbox_cpu_schur_slepc`. `production_window_diagnostics_json` i `solve_sparse_production_modal_payload` współdzielą ten formatter; single-k publikuje go zarówno po sukcesie, jak po błędzie. Nie wykonuje dodatkowych zapytań PETSc, zwłaszcza po twardym błędzie EPSSolve, gdy zasoby solvera mogą być nieważne. Brak obserwacji pozostaje jawny poprzez availability oraz `null`; nie odtwarzamy metryk z tolerancji żądania ani residualu rekurencyjnego.

| Obserwacja | Semantyka | SI / dostępność |
| --- | --- | --- |
| `shifted_ksp_configuration_before_eps` | rzeczywiste odczytane PC side i norm type przed EPSSolve, oddzielne od ostatniego solve'a | enumy $1$; obiekt albo `null` |
| `ksp_true_residual_criterion` | istniejące liczniki solve/measured/violation/unavailable i maksimum stosunku normy rzeczywistego residualu do wymaganej tolerancji | liczniki i ratio $1$; niefinitywne maksimum jako `null` |
| `ksp_last_true_residual_*`, `ksp_last_rhs_norm` | ostatnia rzeczywiście zmierzona norma residualu/RHS oraz względny residual z tego solve'a | normy mają jednostkę znormalizowanego algebraicznego RHS; względny residual $1$; availability zachowana |
| `ksp_final_residual` | norma skonfigurowana przez PETSc, nie zamiennik ponownie obliczonej normy rzeczywistej | jednostka zależy od skonfigurowanej normy; semantics zachowana |
| `ksp_*reason`, `eps_converged_reason` | odczytane kody zakończenia, nie domniemanie na podstawie statusu całego żądania | $1$; niedostępny kod jako `null` |
| `eps_dimensions_available`, `eps_nev/ncv/mpd` | odczytane wymiary EPS, nie wartości odtworzone z żądania | $1$; niedostępne jako `null` |

Normy i istniejące kryterium true-residual opisuje kanoniczny rozdział solvera poniżej; ta nota dodaje wyłącznie realizację publikacji. Publiczny stage-first Python DSL, ProblemIR, planner, ABI i domyślne ustawienia nie zmieniają się. Zapis `nearest` nadal oznacza `selected_only`, a `window_complete=false`: nie tworzymy podokna, certyfikatu pokrycia ani dowodu kompletności widma. Generic/K0 nearest nie otrzymuje telemetry Floqueta. FEM GPU pozostaje NOT VERIFIED dla tego rozszerzenia CPU; FDM CPU/GPU nie dotyczy tego producenta.

Kontrola wyrażeń źródłowych potwierdza zachowanie pomiarów wcześniejszego window, guard rzeczywistego adaptera i brak nowych zapytań PETSc. Przygotowana regresja ćwiczy poprawną production ścieżkę shared-domain oraz brak telemetry Floqueta w generic/K0. Nie przygotowano deterministycznej regresji EPSSolve failure: bezpieczny trigger wymaga osobnej pracy, nie testowego hooka w solverze. Publikacja failure/null została oceniona źródłowo; jej wykonanie pozostaje NOT VERIFIED. Kompilacja i wykonanie testów natywnych pozostają NOT RUN zgodnie z zakazem użytkownika. Managed runtime nowego producenta, osobny consumer nearest i jego admission FGMRES pozostają NOT VERIFIED/OPEN. Dotychczasowa blokada trialu nearest FGMRES w Pythonie pozostaje aktywna do wspólnej weryfikacji producenta i konsumenta. Nie wolno zakwalifikować solvera na podstawie samej publikacji diagnostyki.


<!-- de-air-refinement-levels-20261004 -->
(de-air-refinement-levels)=
## Dalsze poziomy kontrolowanego zagęszczania powietrza DE

Nota poprzedza rozszerzenie wejścia diagnostycznego. Dwie zakończone próby air growth1,15 przy +10/+25 potwierdziły wkład siatki powietrza, ale nie jej zbieżność: [raport obu prób](../raports/2026-10-04-de-air-grading-two-points.md). Następny krok wymaga co najmniej dalszego poziomu przy niezmienionym filmie. Dla tej kontrolowanej sekwencji dopuszczamy cztery dokładne wartości stringów, bez swobodnego parametru i bez zmian domyślnego growth1,3:

```{math}
:label: eq-de-air-refinement-levels
r_n=1+0.3\,2^{-n},\qquad n\in\{0,1,2,3\}.
```

| Symbol | Znaczenie | SI |
| --- | --- | --- |
| $r_n$ | zadany współczynnik wzrostu warstw powietrza na poziomie kontrolnej sekwencji | $1$ |
| $n$ | indeks poziomu diagnostycznego, nie stopień wielomianu FEM | $1$ |

| Poziom | Dokładny string CLI/environment | Float w istniejącym DSL | Stan dowodu |
| ---: | --- | ---: | --- |
| 0 | `"1.3"` | 1.3 | historyczny baseline15; zbieżność OPEN |
| 1 | `"1.15"` | 1.15 | +10/+25 zaakceptowane, rzeczywista izolacja filmu/stanów PASS |
| 2 | `"1.075"` | 1.075 | źródła przygotowywane; wykonanie i izolacja NOT VERIFIED |
| 3 | `"1.0375"` | 1.0375 | źródła przygotowywane; wykonanie i izolacja NOT VERIFIED |

Równanie definiuje dyskretną sekwencję wyborów, nie produkcyjną regułę automatycznego refinementu ani ocenę błędu. Planer zachowuje poprzednią rekurencję {eq}`eq-de-air-grading-controlled-sequence`, seed5nm i cap100nm w L2/3. Mniejszy wzrost może zwiększyć liczbę warstw, pamięć i czas; nie gwarantuje gniazdowania siatek ani zbieżności częstotliwości. Nie wolno ekstrapolować rzędu dokładności z samego indeksu poziomu.

`FULLMAG_DE_SMOKE_AIR_GROWTH_RATE` i opcjonalny `--air-growth-rate` są bezwymiarowymi stringami z powyższej listy; domyślnie environment1,3, CLI brak override. Wartości niefinitywne, bool, liczby zamiast stringów i niezatwierdzone zapisy (np.1.0750) są odrzucane. Ograniczenia pozostają: single-k Damon–Eshbach, standalone input z pełnego `--model-ref`, bez grouped/parallel/BV. Przed przyjęciem wyniku cztery ścieżki requested/declaration/effective mesh growth muszą zgadzać się; nie zamieniamy tego na odczyt legacy grading.

Publiczny Python/IR, requested device i równania fizyczne nie zmieniają się: `StudyUniverseHandle.mesh` → `StudyUniverseConfig.to_dict` → `meta.runtime_metadata.study_universe.airbox_growth_rate` → `_study_universe_airbox_options` → `AirboxOptions.grading_ratio`. Istniejący przykład stage-first `examples/fem_de_smoke_numeric.py` zachowuje film, materiał, demag, Floquet, padding i tolerancje. Sterowanie diagnostyczne mapuje `AIR_GROWTH_RATE`, `_validate_air_growth_rate_request` i `validate_air_growth_rate_metadata` w source-map; dalsze poziomy wymagają nowego wersjonowanego inputu, nie nadpisania historycznej kapsuły.

FEM CPU: poziomy2/3 source przygotowywane i runtime NOT VERIFIED; przejdą niezależne postsolve i actual body/equilibrium/profile isolation. FEM GPU: brak dowodu tych prób, NOT VERIFIED. FDM CPU/GPU: nie dotyczy layered FEM airboxu; ich demag ma odrębną realizację. Nie wprowadzamy fallbacku, capability ani publicznej migracji.

Kryterium dalszej oceny: na +10/+25 porównać kolejne rzeczywiste częstotliwości, pełny residual i zmianę względem poprzedniego poziomu; skontrolować geometrię filmu, stan, air z-schedule i profile, zachowując raw artefakty oraz tożsamości runtime/model. Lepsza zgodność z open-air1D nie wystarcza do uznania zbieżności. Padding, body/thickness, mode-count, Γ full window, native serial/adaptive parity/zasoby, GUI, A1/COMSOL i integracja pozostają osobnymi otwartymi bramkami. Żadne obliczenie nie może omijać admission storage.

Poniższa starsza nota opisuje pierwszy etap1,3→1,15; aktualny zakres kontrolki rozszerza wyłącznie powyższa dyskretna lista.

<!-- de-air-grading-controlled-input-20261004 -->
(de-air-grading-controlled-input)=
## Kontrolowany eksperyment siatki powietrza DE — 4 października 2026

Ta nota poprzedza dodanie jawnego przełącznika **wejścia diagnostycznego**, bez zmiany równań LLG/Poissona, operatorów, publicznego DSL, schematu ProblemIR ani domyślnego buildu. Przykład `examples/fem_de_smoke_numeric.py` zachowuje domyślny wzrost 1,3. Nowa próba ma zmienić go na 1,15 przy +10 rad/µm. Model fizyczny i interpretacja Schura pozostają opisane w rozdziałach poniżej; odwołujemy się do ich równań zamiast tworzyć drugi właścicielski opis demagu.

### Parametr i realizacja

Istniejące publiczne `study.universe.mesh(maximum_element_growth_rate=...)` wyraża bezwymiarowy współczynnik wzrostu; `StudyUniverseHandle.mesh` i `_validate_mesh_control_values` odrzucają wartości niefinitywne i ≤1. Kontrola diagnostycznego fixture'u ogranicza wybór do stringów `"1.3"` i `"1.15"`, domyślnie `"1.3"`. CLI `--air-growth-rate` ma domyślnie brak override; jawne użycie wymaga nieparalelnego DE-SMOKE oraz wersjonowanego `--model-ref`. Nie jest to nowy parametr produkcyjnego solvera ani planner capability.

| Parametr | Typ / domyślnie | SI | Walidacja i znaczenie | Python → IR → realizacja |
| --- | --- | --- | --- | --- |
| `FULLMAG_DE_SMOKE_AIR_GROWTH_RATE` | string, `"1.3"` | $1$ | tylko `"1.3"`/`"1.15"`; błędne wejście odrzucane przed obliczeniem | fixture → istniejące `study.universe.mesh(maximum_element_growth_rate=...)` |
| `--air-growth-rate` | opcjonalny string, brak | $1$ | ten sam zakres; bez niejawnego override dla historycznego buildu/inputu lub grouped sweep | Compose environment → fixture; requested w run-request, resolved z bound mesh metadata |
| `study.universe.mesh(maximum_element_growth_rate=...)` | opcjonalny float, `None` | $1$ | finite >1; istniejący publiczny DSL, bez zmiany domeny | `StudyUniverseHandle.mesh` → `StudyUniverseConfig.to_dict()` → `meta.runtime_metadata.study_universe.airbox_growth_rate` → `_study_universe_airbox_options` → `AirboxOptions.grading_ratio` |

W trasie layered Box rzeczywisty planer `_box_airbox_layer_levels` zachowuje płaszczyzny filmu i buduje na zewnątrz sekwencję:

```{math}
:label: eq-de-air-grading-controlled-sequence
h_0=h_{\mathrm{inner}},\qquad
h_{j+1}=\min(r h_j,h_{\mathrm{outer}}).
```

| Symbol | Znaczenie | SI |
| --- | --- | --- |
| $h_0$ | pierwszy krok od interfejsu | $\mathrm{m}$ |
| $h_j$ | planowany krok warstwy powietrza o indeksie $j$ | $\mathrm{m}$ |
| $h_{\mathrm{inner}}$ | zadany rozmiar początkowy, tu 5 nm | $\mathrm{m}$ |
| $h_{\mathrm{outer}}$ | ograniczenie kroku, tu 100 nm | $\mathrm{m}$ |
| $r$ | współczynnik wzrostu, 1,3 lub 1,15 | $1$ |
| $j$ | indeks zewnętrznej warstwy, nie indeks materiału | $1$ |

Ostatni segment jest przycinany do fizycznej granicy airboxu. Równanie opisuje sekwencję z planera, a nie gwarancję rozmiaru każdej krawędzi tetra ani błędu modalnego. Publiczny punkt wejścia DSL pozostaje `fm.study(...)`; kompletny stage-first model znajduje się w istniejącym przykładzie DE-SMOKE. To zmiana istniejącego parametru wejścia, bez nowego konstruktora, eksportu ani migracji IR.

### Weryfikacja i granice

FEM CPU: eksperyment źródłowy jest przygotowywany; wykonanie i izolacja **NOT VERIFIED** do odczytu końcowych artefaktów. FEM GPU: ta kontrola CPU nie kwalifikuje GPU. FDM CPU/GPU: nie dotyczy layered FEM Poisson airboxu; ich demag ma odrębny właścicielski opis. Nie dodajemy fallbacku ani capability. Runtime/Python pochodzą z attested build228, natomiast samodzielny skrypt z pełnego SHA wejścia; obie tożsamości mają oddzielne hashe i pozostają w receiptach.

Warunki porównania: +10 rad/µm, film 40×40×10 nm, Ms800000 A/m, Aex1,3e−11 J/m, B0,1 T, M₀=x, k=y, PBC x/y, finite Dirichlet air padding2µm, L2/3; EPS/KSP1e−9, FGMRES restart8 i pełny residual1e−8. Zmieniamy wyłącznie $r$. Przed akceptacją sprawdzamy bound metadata dla rzeczywistego growth oraz zgodność źródeł, siatki, stanu, pełnego projected weak-form residualu, periodic seams i true KSP residual.

Po solve trzeba porównać rzeczywistą magnetyczną geometrię/connectivity (nie whole-mesh hash), 4 płaszczyzny filmu, magnetic equilibrium i profile, oraz zmierzyć zmianę air schedule. Jeżeli film lub stan również zmieni się, wynik nie izoluje powietrza. Nawet zaakceptowany residual nie oznacza zbieżności przestrzennej; zmniejszenie różnicy częstotliwości wspiera jedynie hipotezę zależności od air mesh dla tej próby. Pełna zbieżność airboxu, siatki, liczby modów, Γ pełnego okna, adaptive parity, GUI i A1 pozostają odroczone.

Mapa źródeł: `world.py:StudyUniverseHandle.mesh`, `world.py:StudyUniverseConfig.to_dict`, `asset_pipeline.py:_study_universe_airbox_options`, `_gmsh_swept.py:_box_airbox_layer_levels`; diagnostyczne wejście i driver są mapowane osobno w source-map. Raport źródłowy i hipotezy: [kontrola rozbieżności DE](../raports/2026-10-04-de-nonzero-discrepancy-source-scan.md). Te źródła dowodzą realizacji kontrolki; nie zastępują bramek fizycznych opisanych poniżej.

# FEM Poisson-Airbox Modal Eigenproblem

- Status: FEM CPU and FEM GPU `source_visible / unvalidated`; public physical
  bias-field sweep, native MFEM assembly and two-pass window certificates are
  implemented at source level, but no current-snapshot managed CPU/GPU
  qualification is available
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-08-14
- Related physics notes:
  - `0700-frequency-domain-linearized-llg.md`
  - `0800-fem-static-pbc-demag.md`
  - `0828-fem-frequency-domain-floquet-demag.md`
  - `0831-fem-dynamic-pencil-modal-response-and-krylov.md`
  - `0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Related implementation plan:
  - `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`
- Related equilibrium-acceptance design:
  - `docs/superpowers/specs/2026-08-12-user-owned-relaxation-acceptance-for-eigensolve-design.md`

(problem-statement)=
## 1. Physical domain and problem statement

This note defines the first physically valid FEM modal eigensolve with dynamic
Poisson-airbox demagnetization. It is a `k=0`, alpha-zero, shared-domain
candidate around an accepted static equilibrium. The magnetic perturbation is
complex and tangent to the equilibrium; the scalar-potential perturbation lives
on the full magnetic-plus-airbox domain.

The topology-shaped PA-E1/PA-E4b payload is an algebraic test oracle only. It
is not a FEM Poisson-airbox model and must not be labeled production physics.

### Backend and device qualification boundary

| Solver | Device | Current state | Boundary |
|---|---|---|---|
| FEM | CPU | `source_visible / unvalidated` | The public sweep, request/shared-payload ABI v19, frozen legacy result ABI v18, native P1 assembly, Schur solver and two-pass window certificate exist in source. A managed antidot run reached native shared-domain assembly after one accepted relaxation, but did not produce a spectrum; physical K0-3 convergence and production evidence remain absent. |
| FEM | GPU | `source_visible / unvalidated` | The PETSc/SLEPc CUDA adapter and two-pass window certificate exist in source. Executed device residency, matrix-free convergence, parity, sanitizer, scaling and production evidence are open. |
| FDM | CPU | not applicable | FDM demagnetization has a separate canonical physics owner. |
| FDM | GPU | not applicable | FDM demagnetization has a separate canonical physics owner. |

## 2. Physical model

(governing-equations)=
### 2.1 Governing equations

Fullmag uses the $+\mathrm{i}\omega t$ convention and a tangent perturbation
$\delta\mathbf m=Tq$:

```{math}
:label: eq-poisson-airbox-modal-ansatz
\mathbf m(\mathbf r,t)=\mathbf m_0(\mathbf r)
 + \operatorname{Re}\!\left[\delta\mathbf m(\mathbf r)
   \exp(\mathrm{i}\omega t)\right],
\qquad
\delta\mathbf m=Tq,
\qquad
\mathbf m_0\cdot\delta\mathbf m=0,
\qquad
\delta\mathbf H_{\mathrm{demag}}=-\nabla\delta\phi .
```

With $\delta\mathbf M=M_s\delta\mathbf m$ in the magnetic region and zero in
the airbox, the scalar-potential problem on the shared domain
$D=\Omega_m\cup\Omega_{\mathrm{air}}$ is

In canonical ASCII notation, `D = Omega_m union Omega_air.` and
`delta_H_demag = -grad(delta_phi).`

```{math}
:label: eq-poisson-airbox-strong-form
\nabla\cdot\nabla\delta\phi
 = \nabla\cdot\delta\mathbf M
\quad\text{in }D,
\qquad
\delta\mathbf M=
\begin{cases}
M_s\delta\mathbf m,&\mathbf r\in\Omega_m,\\
0,&\mathbf r\in\Omega_{\mathrm{air}}.
\end{cases}
```

For a Robin approximation on the open exterior boundary
$\Gamma_{\mathrm{open}}$, the implemented weak form is

```{math}
:label: eq-poisson-airbox-weak-form
\int_{D}\nabla\psi\cdot\nabla\delta\phi\,\mathrm{d}V
 + \beta\int_{\Gamma_{\mathrm{open}}}\psi\,\delta\phi\,\mathrm{d}S
 = \int_{\Omega_m} M_s\,\delta\mathbf m\cdot\nabla\psi\,\mathrm{d}V .
```

The Robin term is excluded from periodic cuts. Dirichlet eliminates the
corresponding potential DOFs. Pure Neumann has a constant nullspace and alone
uses a mean-zero gauge. Fully periodic three-dimensional k=0 demagnetization
is unsupported until a macroscopic-field convention is defined.

```{math}
:label: eq-poisson-airbox-modal-block
\begin{aligned}
A_{qq}q+A_{q\phi}\phi &= \lambda B_{qq}q,\\
A_{\phi q}q+P\phi &= 0,\\
L_{\mathrm{eff}}q &= \lambda B_{qq}q,\qquad
L_{\mathrm{eff}}=A_{qq}-A_{q\phi}P^{-1}A_{\phi q},\\
\lambda&=\mathrm{i}\omega .
\end{aligned}
```

```{math}
:label: eq-poisson-airbox-coupling-signs
C_{\phi q}q
=\int_{\Omega_m}M_s(Tq)\cdot\nabla\psi\,\mathrm{d}V,
\qquad
A_{\phi q}=-C_{\phi q},
\qquad
A_{q\phi}=-\mu_0A_{\phi q}^{\mathsf T}
=\mu_0C_{\phi q}^{\mathsf T}.
```

For a pure-Neumann scalar block, the second row is augmented by $c\eta$ and
$c^{\mathsf T}\phi=0$. Robin and Dirichlet have no `eta` row.

The acceptance residuals are computed from the original, unscaled descriptor:

```{math}
:label: eq-poisson-airbox-full-residuals
\begin{aligned}
r_q&=A_{qq}q+A_{q\phi}\phi-\lambda B_{qq}q,\\
r_\phi&=A_{\phi q}q+P\phi+c\eta,\\
r_g&=c^{\mathsf T}\phi,\\
\epsilon_q&=\frac{\lVert r_q\rVert_2}
 {\lVert A_{qq}q\rVert_2+\lVert A_{q\phi}\phi\rVert_2
 +|\lambda|\lVert B_{qq}q\rVert_2+\delta_q},\\
\epsilon_\phi&=\frac{\lVert r_\phi\rVert_2}
 {\lVert A_{\phi q}q\rVert_2+\lVert P\phi\rVert_2
 +\lVert c\eta\rVert_2+\delta_\phi},\\
\epsilon_g&=\frac{|c^{\mathsf T}\phi|}
 {\lVert c\rVert_2\lVert\phi\rVert_2+\delta_g}.
\end{aligned}
```

The positive floors are block-specific representation constants:
$\delta_q$, $\delta_\phi$ and $\delta_g$ have the same units as their
respective denominators. They are not one dimensionless physical constant.

The managed real-scalar PETSc/SLEPc contract targets the imaginary-axis
eigenvalue through the named real-frequency rotation:

```{math}
:label: eq-poisson-airbox-rotated-pencil
\mathcal R(L)y=\omega\,\mathcal R(\mathrm{i}B_\alpha)y,
\qquad
\tau=\omega_{\mathrm{target}},
\qquad
\lambda=\mathrm{i}\omega .
```

The thin-film Kittel relation is an independent postsolve oracle, never an
assembly, equilibrium, target or acceptance input:

```{math}
:label: eq-poisson-airbox-kittel-oracle
\omega_{\mathrm{Kittel}}^2
=\gamma_0^2H_b\!\left(H_b+M_{\mathrm{eff}}\right),
\qquad
f_{\mathrm{Kittel}}=\frac{\omega_{\mathrm{Kittel}}}{2\pi}.
```

The relaxation stage, not eigensolve, owns physical equilibrium acceptance.
Its user-enabled torque-or-energy predicate, tie-breaker, and non-convergence
terminal reasons are defined only by {ref}`relaxation-stop-semantics`; this
note consumes the immutable completed-stage certificate and does not redefine
relaxation:

```{math}
:label: eq-poisson-airbox-relative-torque-diagnostic
\rho_\tau=
\frac{\max_{\Omega_m}|\mathbf m_0\times\mathbf H_{\mathrm{eff},0}|}
{\max\!\left(\max_{\Omega_m}|\mathbf H_{\mathrm{eff},0}|,
1\,\mathrm{A\,m^{-1}}\right)}.
```

The recorded criterion may therefore be torque or energy. The relative torque
$\rho_\tau$ is retained for diagnosis only; it has no default acceptance
threshold and cannot reverse a completed relaxation stage. An imported state
must carry an equivalent immutable acceptance certificate.

For a torque-certified handoff, the native magnetic-block consistency check
uses the same user-authored absolute threshold as the completed relaxation:

```{math}
:label: eq-poisson-airbox-accepted-torque-threshold
\tau_{\max}
=\max_{\Omega_m}|\mathbf m_0\times\mathbf H_{\mathrm{eff},0}|
\le \tau_{\mathrm{user}} .
```

There is no second hidden relative threshold. The native importer verifies the
certificate kind, SI unit, measured value and threshold before using
$\tau_{\mathrm{user}}$. An energy-certified handoff has no authored torque
threshold, so the native magnetic-block representation check retains its
strict numerical parallel-field guard instead of inventing one.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf r$ | spatial position | $\mathrm{m}$ |
| $t$ | time | $\mathrm{s}$ |
| $\mathbf m$, $\mathbf m_0$, $\delta\mathbf m$ | normalized magnetization, accepted equilibrium and tangent perturbation | $1$ |
| $T$ | tangent-frame map from modal coefficients to $\delta\mathbf m$ | $1$ |
| $q$ | tangent-plane modal coefficients | $1$ |
| $\delta\mathbf M$ | dynamic magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\delta\mathbf H_{\mathrm{demag}}$ | dynamic demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\delta\phi$, $\phi$ | dynamic scalar magnetic potential and its coefficient vector | $\mathrm{A}$ |
| $\psi$ | scalar-potential test function | $1$ |
| $D$, $\Omega_m$, $\Omega_{\mathrm{air}}$ | shared, magnetic and airbox domains | $\mathrm{m^3}$ |
| $\Gamma_{\mathrm{open}}$ | open exterior boundary | $\mathrm{m^2}$ |
| $\mathrm{d}V$, $\mathrm{d}S$ | volume and surface measures | $\mathrm{m^3}$, $\mathrm{m^2}$ |
| $\nabla$ | spatial gradient | $\mathrm{m^{-1}}$ |
| $\operatorname{Re}$, $\exp$, $\mathrm{i}$, $(\cdot)^\ast$ | real-part map, exponential, imaginary unit and complex conjugation; the operators/constants are dimensionless and preserve or combine operand units as written | $1$ |
| $\lVert\cdot\rVert_2$, $|\cdot|$ | Euclidean norm and absolute value; each result inherits the operand unit | $1$ |
| $(\cdot)^{\mathsf T}$, $\cdot$ | transpose and Euclidean contraction; the operators are dimensionless | $1$ |
| $\int$, $\cup$, $\nabla\cdot$ | integration, set union and divergence operators; dimensional changes come from the measure or derivative shown in the equation | $1$ |
| $\pi$ | circle constant | $1$ |
| $\min$, $\max$, $\lfloor\cdot\rfloor$, $\lceil\cdot\rceil$ | selection and integer-rounding operators used by the deterministic window schedule | $1$ |
| $\beta$ | Robin coefficient | $\mathrm{m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{T\,m\,A^{-1}}$ |
| $P$ | scalar Poisson stiffness block | $\mathrm{m}$ |
| $C_{\phi q}$, $A_{\phi q}$ | magnetic-to-potential coupling blocks | $\mathrm{A\,m}$ |
| $A_{q\phi}$ | potential-to-magnetic coupling block | $\mathrm{m^3\,A^{-1}\,s^{-1}}$ |
| $A_{qq}$ | magnetic restoring block | $\mathrm{m^3\,s^{-1}}$ |
| $B_{qq}$, $B_\alpha$ | tangent mass and damped gyrotropic mass blocks | $\mathrm{m^3}$ |
| $L_{\mathrm{eff}}$, $L$ | Schur-reduced and full magnetic operators | $\mathrm{m^3\,s^{-1}}$ |
| $\lambda$ | modal eigenvalue | $\mathrm{s^{-1}}$ |
| $\omega$, $\omega_{\mathrm{target}}$, $\tau$ | angular frequency, requested angular target and rotated-pencil target | $\mathrm{rad\,s^{-1}}$ |
| $\mathcal R(\cdot)$, $y$ | real-split operator and real-split state | $1$ |
| $c$, $\eta$ | mean-zero gauge vector and Lagrange multiplier | $\mathrm{m^3}$, $\mathrm{A\,m^{-2}}$ |
| $r_q$, $r_\phi$, $r_g$ | magnetic, scalar and gauge residuals | $\mathrm{m^3\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{A\,m^3}$ |
| $\epsilon_q$, $\epsilon_\phi$, $\epsilon_g$ | normalized magnetic, scalar and gauge residuals | $1$ |
| $\delta_q$, $\delta_\phi$, $\delta_g$ | positive magnetic, scalar and gauge denominator floors | $\mathrm{m^3\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{A\,m^3}$ |
| $H_b$, $M_{\mathrm{eff}}$ | physical bias-field magnitude and effective magnetization used only by the Kittel oracle | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | $\mu_0|\gamma|$ gyromagnetic factor in the A/m convention | $\mathrm{rad\,s^{-1}\,(A\,m^{-1})^{-1}}$ |
| $f_{\mathrm{Kittel}}$ | Kittel oracle frequency | $\mathrm{Hz}$ |
| $\Delta f$, $f_{\min}$, $f_{\max}$, $f_a$, $f_b$ | window width, bounds and candidate frequencies | $\mathrm{Hz}$ |
| $U$, $V$, $u_i$, $v_j$ | orthonormal cluster bases and vectors | $1$ |
| $i$, $j$, $r$ | cluster-basis indices and paired cluster rank | $1$ |
| $u_i^\ast v_j$, $s(U,V)$ | Hermitian overlap and normalized invariant-subspace overlap | $1$ |
| $\mathbf H_{\mathrm{eff},0}$ | effective field evaluated at the accepted equilibrium | $\mathrm{A\,m^{-1}}$ |
| $\rho_\tau$ | relative torque diagnostic, never an eigensolve acceptance threshold | $1$ |
| $\tau_{\max}$ | maximum accepted absolute equilibrium torque-field residual | $\mathrm{A\,m^{-1}}$ |
| $\tau_{\mathrm{user}}$ | user-authored relaxation torque threshold carried by the immutable acceptance certificate | $\mathrm{A\,m^{-1}}$ |
| $\mathcal O$, $o$ | complete set of covered magnetic objects and one object identity | $1$ |
| $c$ | global Cartesian modal component in $\{x,y,z\}$ | $1$ |
| $N_i$, $V_e$ | P1 basis function and tet4 element volume | $1$, $\mathrm{m^3}$ |
| $\mathbf d^o_c$ | complex P1 coefficient vector of $\delta m_c$ restricted to object $o$ | $1$ |
| $M_o$, $M_e$ | object consistent mass matrix and local P1/tet4 consistent mass matrix | $\mathrm{m^3}$ |
| $E[o,c]$, $E_{\mathrm{total}}$ | component quadratic mass measure and summed modal measure | $\mathrm{m^3}$ |
| $p[o,c]$, $p_{\mathrm{object}}[o]$, $p_{\mathrm{global}}[c]$ | object-component, object-total and global-component participation fractions | $1$ |
| $\varepsilon_{\mathrm{sum}}$, $\varepsilon_{\mathrm{mach}}$ | participation-sum tolerance and float64 machine epsilon | $1$ |

(assumptions-and-validity)=
### 2.3 Assumptions and validity limits

- $\mathbf m_0$ must originate in an accepted relaxation handoff or certified
  equilibrium artifact with matching mesh, material, static physics and static
  boundary signatures. Acceptance is owned by the user's completed relaxation
  stop contract; eigensolve does not impose an additional relative-torque
  limit. The source-level v3 handoff now binds certified fields and the three
  source-equilibrium signatures; fresh managed execution is still required
  before this becomes a production qualification claim.
- A completed relaxation is accepted only according to the canonical contract
  in {ref}`relaxation-stop-semantics`. `max_steps`, time limits, cancellation,
  numerical stagnation, and backend failure do not establish equilibrium.
- Relative torque remains a diagnostic observable and cannot override a
  completed, converged relaxation stage.
- The source-level native magnetic producer supports P1 `tet4` and `prism6`
  magnetic elements, one homogeneous scalar $A_{\mathrm{ex}}$, accepted
  tangent frames, positive $M_s$, a static restoring field whose nodal
  transverse residual satisfies the carried torque certificate (or the strict
  numerical guard for a non-torque certificate), and dynamic-demag provenance
  bound to the operator-input digest. Anisotropy and DMI return `unavailable`.
- The requested modal scope is exact $k=0$, $\alpha=0$, double precision,
  x/y-periodic and open-z, with `spin_wave_bc="periodic"` and
  `magnetostatic_bc="periodic_airbox_k0"`.
- Nonzero-k dynamic demag requires complex Bloch `grad_k/div_k` assembly and is
  not approximated by the k=0 operator.
- The exact shifted-preconditioner/materialized baseline is bounded to a
  real-split descriptor dimension of at most 1024 and is an oracle for
  validation, not the production-size definition.
- Canonical scope vocabulary is literal: **materialized descriptor dimension
  <= 1024 is validation_only**; the production operator kind is
  `matrix_free_schur_selected_spectrum`; **production qualification requires a
  measured operator_dimension > 1024**.

### 2.4 Exact qualification scopes

These IDs freeze the intended qualification envelopes; they are not
`validated_scope` values until the corresponding managed gates pass.

| Scope ID | Exact envelope | Current evidence |
|---|---|---|
| `modal_cpu_k0_periodic_airbox_real_shared_domain.production` | FEM CPU; P1 `tet4|prism6` shared magnetic/airbox mesh; one homogeneous scalar $A_{\mathrm{ex}}$; exchange, certificate-consistent static restoring field and dynamic Poisson-airbox demag; x/y periodic, open z; Robin outer boundary with no gauge or pure Neumann with mean-zero gauge; exact Gamma; $\alpha=0$; double; `full_2x2`; real-frequency rotated target; three-to-five-sample physical `BiasFieldSweep`; production `matrix_free_schur_selected_spectrum` with a measured operator dimension greater than 1024 | Future catalog binding only; `source_visible / unvalidated`; `validated_scope=null`, `executable_scope=null` |
| `modal_gpu_k0_periodic_airbox_scalable.production` | Same physics, geometry, BC/gauge, precision, target and sweep as CPU; PETSc/SLEPc CUDA `matrix_free_schur_selected_spectrum`, persistent device solver state, no permitted CPU fallback, and a measured operator dimension greater than 1024 | Future catalog binding only; `source_visible / unvalidated`; `validated_scope=null`, `executable_scope=null` |

The materialized CPU and GPU descriptors at dimensions up to and including
1024 remain validation-only evidence. They may exercise algebra, signs,
window certification and parity, but they cannot satisfy either production
binding and cannot promote readiness or capability state.

## 3. Solver family and numerical interpretation

(discrete-realization)=

### 3.1 FEM

`P`, `C_{\phi q}`, potential feedback, `B_{qq}` and `A_{qq}` are assembled
against one accepted MFEM mesh/space and tangent-frame source. The selected
spectrum solve is Schur reduced, with the original descriptor reconstructed
for certification.

Request and shared-payload ABI v19 deliberately do not carry a preassembled
`A_qq`; the legacy by-value frequency-domain result remains frozen at ABI v18.
`assemble_native_magnetic_a_qq` owns the magnetic block on the native MFEM
mesh. It assembles the P1 exchange weak form for `tet4|prism6` and the
certificate-consistent restoring-field block. For torque acceptance, the
maximum permitted nodal transverse residual is exactly the carried
`max_torque_apm` threshold; it is not a fixed eigensolve tolerance. Anisotropy
and DMI fail closed as
`unavailable`. A DEMAG presence bit is accepted only with a provider signature
equal to the operator-input digest; the dynamic response remains in
`A_{q\phi}P^{-1}A_{\phi q}` rather than becoming a duplicate local `A_qq`
term. `assemble_poisson_airbox_shared_domain_payload` imports this descriptor
and `assemble_poisson_airbox_shared_domain` owns the complete shared-domain
block assembly.

Geometry part markers remain authoritative in `MeshIR` and the periodic mesh
certificate. At the native operator boundary, the runner derives a separate
role map with `1=magnetic` and `0=airbox`. This allows one physical magnetic
object to contain multiple conformal geometry parts (for example body marker 1
and hole-transition marker 2) without collapsing their identities in the
certificate or asking the native operator to interpret geometry-specific IDs.

Consequently, the demagnetizing contribution to the energy Hessian is
positive semidefinite. For an in-plane, x/y-periodic thin film, the uniform
out-of-plane tangent component receives the `+Ms` restoring stiffness while
the uniform in-plane component does not. Reversing the `A_qphi` sign produces
`H0-Ms`, a real unstable eigenvalue, and must fail the reciprocal-coupling and
K0-3 Kittel gates.

The accepted full residual is
`max(epsilon_q, epsilon_phi, epsilon_g)` from
{eq}`eq-poisson-airbox-full-residuals` and is not
replaced by a smaller backend-reported residual.

#### Udział komponentów pola modalnego

Identyfikator definicji obserwable to
`volume_weighted_complex_l2_fraction.v1`. Definicja dotyczy wyłącznie
opublikowanego, znormalizowanego pola $\delta\mathbf m$ w globalnej bazie
kartezjańskiej. Nie jest to energia magnetyczna: $E[o,c]$ jest dodatnią
kwadratową miarą masową pola modalnego, której jednostką jest $\mathrm{m^3}$.

Niech $\mathcal O$ będzie zbiorem obiektów magnetycznych z pełnym,
kanonicznym membership w source mesh, $c\in\{x,y,z\}$, a
$\mathbf d^o_c$ wektorem zespolonych współczynników składowej
$\delta m_c$ na ograniczeniu do obiektu $o$. Dla P1/tet4 macierz
$M_o$ jest złożeniem **consistent element mass**, a nie średnią węzłową:

```{math}
:label: eq-poisson-airbox-component-consistent-mass
(M_o)_{ij}=\int_{\Omega_o}N_i(\mathbf r)N_j(\mathbf r)\,\mathrm{d}V,
\qquad
M_e=\frac{V_e}{20}
\begin{bmatrix}
2&1&1&1\\
1&2&1&1\\
1&1&2&1\\
1&1&1&2
\end{bmatrix}.
```

```{math}
:label: eq-poisson-airbox-component-participation
\begin{aligned}
E[o,c]&=(\mathbf d^o_c)^{\mathrm H}M_o\mathbf d^o_c,\\
E_{\mathrm{total}}&=\sum_{o\in\mathcal O}\sum_{c\in\{x,y,z\}}E[o,c],\\
p[o,c]&=\frac{E[o,c]}{E_{\mathrm{total}}},\\
p_{\mathrm{object}}[o]&=\sum_c p[o,c],\qquad
p_{\mathrm{global}}[c]=\sum_o p[o,c].
\end{aligned}
```

W kanonicznej notacji ASCII:
`E[o,c] = (d_c^o)^H M_o d_c^o`,
`E_total = sum_{o in O} sum_{c in {x,y,z}} E[o,c]` oraz
`p[o,c] = E[o,c] / E_total`.

Hermitowska forma oznacza, że część rzeczywista i urojona są liczone razem,
$E[o,c]\ge0$, a mnożenie całego moda przez niezerowy skalar zespolony nie
zmienia $p$. Obiektowy `totalFraction` jest
$p_{\mathrm{object}}[o]$; w globalnym scope `total=1` i kolumny
`x/y/z` są $p_{\mathrm{global}}[c]$, wyłącznie gdy membership pokrywa
całą domenę magnetyczną. W object scope `total` oznacza
$p_{\mathrm{object}}[o]$, a `x/y/z` oznaczają $p[o,x]$,
$p[o,y]$, $p[o,z]$. Zatem suma `x/y/z` musi równać się `total`,
a suma `totalFraction` wszystkich obiektów musi równać się globalnemu
`total`. Dla float64 artefakt odrzuca wynik, gdy odpowiednia różnica
przekracza
$\varepsilon_{\mathrm{sum}}=128\,\varepsilon_{\mathrm{mach}}
\max(1,3|\mathcal O|)$.

$\delta\mathbf M=M_s\delta\mathbf m$ ma jednostkę
$\mathrm{A\,m^{-1}}$ i nie jest tym samym obserwable. UI wyświetla symbol i
jednostkę z metadata pola: dla tej definicji są to $\delta m_c$ oraz $1$.
Nie wolno podmieniać go na $\delta M_c$ ani mnożyć przez $M_s$ po stronie UI.
Miara oparta na $\delta\mathbf M$ wymaga osobnego definition ID, osobnej formy
kwadratowej i osobnej kwalifikacji.

Obserwable jest fail-closed. Aktualny artefakt go jeszcze nie publikuje, więc
każdy brak zwraca `component_participation_unavailable` wraz z jednym z
następujących szczegółów: `mode_field_missing`,
`consistent_mass_basis_unsupported`, `object_membership_missing`,
`object_coverage_incomplete`, `component_basis_unsupported`,
`component_total_nonfinite` albo `component_total_zero`. Baza inna niż
P1/tet4, niepełne membership lub zerowa/nieskończona norma nie są
normalizowane do syntetycznego zera.

FDM nie publikuje obecnie artefaktu eigensolve z tym obserwable. Gdy taki
backend rzeczywiście go opublikuje, jego odrębna realizacja musi użyć
$E[o,c]=\sum_{k\in o}V_k|\delta m_{k,c}|^2$ z objętościami komórek $V_k$;
nie może deklarować parytetu FEM ani używać nieważonej średniej węzłowej.

Postprocessing może wykonać CPU po eksporcie zespolonego pola z solvera GPU.
Nie jest to fallback solve: provenance rozdziela `solver_device=gpu` od
`observable_lane=postprocess_cpu`, a także zapisuje field ID/revision,
source-mesh identity, quantity, basis, metodę `consistent_mass_p1_tet4` i
definition ID. Bez tych wejść wynik pozostaje unavailable.

The managed runtime is the real-scalar `libpetsc-real-dev` plus
`libslepc-real-dev` lane. It represents the complex target
`sigma=i omega_target` only with the ADR-017 real-split
`real_frequency_rotated` pencil in {eq}`eq-poisson-airbox-rotated-pencil`.

`EPSSetTarget(tau)` is legal only on that named rotated pencil. A real scalar
target `omega_target` on the original `lambda=i omega` pencil is invalid and
must reject rather than approximate the imaginary-axis target.

For `target="frequency_window"`, the CPU Schur realization uses the
deterministic certificate `shift_nev_refinement_subspace_v1`. The base pass
retains the 16 midpoint shifts. The refinement pass uses 32 half-step-shifted
partitions plus one guard shift on each side of the requested interval:

```{math}
:label: eq-poisson-airbox-window-refinement-schedule
\Delta f=\frac{f_{\max}-f_{\min}}{32}, \qquad
\left[f_{\min}-\frac{\Delta f}{2},\,
      f_{\max}+\frac{\Delta f}{2}\right].
```

Both reported edge-coverage margins therefore equal $\Delta f/2$ and must be
strictly positive. The refinement
nearest-frequency requests twice the requested mode count, subject to the same
descriptor-dimension guard; its resolved `nev` must be greater than the base
`nev`.

Every nearest-frequency subsolve must return `ok`, and every accepted candidate
must already pass the full original, unscaled descriptor residual described
above. Accepted frequencies are clustered with tolerance
$\max(1\,\mathrm{Hz},10^{-8}\max(|f_a|,|f_b|))$. Within each cluster,
the magnetic $q$ components are reorthogonalized to determine rank. Given
orthonormal bases $U=\{u_i\}_{i=1}^{r}$ and
$V=\{v_j\}_{j=1}^{r}$ for equal-rank base and refinement clusters, the
reported invariant-subspace overlap uses the Hermitian inner product
$u_i^{\ast}v_j$:

```{math}
:label: eq-poisson-airbox-window-subspace-overlap
s(U,V)=\left(\frac{1}{r}\sum_{i=1}^{r}\sum_{j=1}^{r}
\left|u_i^{\ast}v_j\right|^2\right)^{1/2}.
```

The window is certified only when both schedules complete without failure or
cancellation, the requested mode count is covered without splitting a
degenerate cluster, paired clusters have stable frequencies and ranks,
$\min s(U,V)\ge 1-10^{-6}$, both edge margins are positive, and neither schedule
nor cluster JSON is truncated. A disagreement returns `solve_error`, keeps
`window_complete=false`, publishes
`frequency_window_refinement_disagreement`, and records a non-certified
certificate. When the requested count would split a residual-certified
cluster, that offending cluster frequency and rank remain visible in the
certificate even though `accepted_mode_count` is zero. Cancellation remains
`interrupted` with `cancel_requested`.

Każde podokno publikuje również diagnostykę etapów odrzucania kandydatów.
`candidate_mode_count` ma jawnie określony typ
`raw_ritz_in_window`: jest to liczba skończonych, dodatnich wartości Ritz
wewnątrz żądanego przedziału przed sprawdzeniem residualu. Osobne liczniki
`action_residual_evaluated_count`, `reconstructed_mode_count` i
`full_residual_accepted_count` pokazują, na którym etapie kandydat odpadł.
Runtime publikuje również liczniki przyczyn odrzucenia:
`action_residual_evaluation_failed_count`,
`q_vector_extraction_failed_count`,
`full_vector_reconstruction_failed_count`,
`full_vector_nonfinite_count`,
`full_residual_evaluation_failed_count` oraz
`full_residual_rejected_count`. Są to liczniki diagnostyczne, agregowane także
przez całe okno; nie zmieniają bramki akceptacji, którą pozostaje pełny
oryginalny, nieprzeskalowany residual deskryptora względem tolerancji podanej
przez użytkownika.
`accepted_mode_count` oznacza wyłącznie mody zachowane po wszystkich filtrach i
deduplikacji. Stary artefakt bez `candidate_mode_count_kind` pozostaje
czytelny, lecz nowy runtime musi publikować oba pola zgodnie z tym kontraktem.

Podsumowanie walidacji K0 Kittela czerpie `execution_lane` i identyfikator
solvera z diagnostyki native, gdy ścieżka orkiestratora zachowała historyczny
model referencyjny, ale faktycznie wykonała produkcyjny adapter CPU/GPU. Dzięki
temu raport nie może oznaczyć produkcyjnego GPU jako `reference` ani rozjechać
`solver_algorithm` względem `frequency_domain/manifest.v1.json`.

<!-- common-modal-krylov-tuning -->
### 3.1.1 Strojenie EPS i shift-invert na ścieżce zawierającej Γ

Punkt Γ zachowuje okresowy operator K0 z pełnym dynamicznym demagiem; nie
wolno sztucznie zastępować go małym niezerowym k. Strojenie kryłowowskie
kontroluje koszt i zbieżność podproblemów, ale nie zmienia operatora,
certyfikatu równowagi, normalizacji, doboru 16+34 shiftów ani końcowej bramki
oryginalnego residualu. Wewnętrzna tolerancja EPS/KSP nie jest tą bramką.

FEM CPU udostępnia następujące jawne, diagnostyczne parametry runtime dla
obu adapterów: okresowego Schura K0 i niezerowego Floqueta. Nie dodają pól
Python ani ProblemIR; pochodzą z kontrolowanej konfiguracji uruchomienia.

| Zmienna runtime | Typ / SI | Domyślna wartość przy braku override | Walidacja i znaczenie |
| --- | --- | --- | --- |
| `FULLMAG_MODAL_EPS_PREFILTER_ABS` | dodatni float / $1$ | dotychczasowy wzór właściwego adaptera; K0: budżet 1e-3 residual tolerance z clamp 1e-12–1e-8 | dokładny token od `1e-6` do `1e-13`; wewnętrzne kryterium EPS |
| `FULLMAG_MODAL_SHIFTED_KSP_RTOL` | dodatni float / $1$ | dotychczasowy wzór właściwego adaptera; K0: clamp 1e-13–1e-10 z 1e-3 tolerancji EPS | dokładny token od `1e-6` do `1e-13`; relative stopping kryterium ST KSP |
| `FULLMAG_MODAL_SHIFTED_KSP_TYPE` | enum / $1$ | `gmres` | wyłącznie `gmres` lub `fgmres`; algorytm ST shift-invert |
| `FULLMAG_MODAL_GMRES_RESTART` | dodatni int / $1$ | dotychczasowy restart adaptera; K0: min(split DOF,256) | 8,10,12,16,30; liczba kierunków, dodatkowo ograniczona wymiarem operatora K0 |

Niepoprawne, puste lub sprzeczne wartości kończą się validation error.
Historyczne `FULLMAG_FLOQUET_*` pozostają aliasami tylko w adapterze Floqueta;
gdy alias i wspólny parametr są zadane jednocześnie, wymagają tych samych
tokenów. Sam historyczny alias nie zmienia zachowania samodzielnego K0.
Managed pilot zapisuje wspólne parametry i zgodne aliasy, aby zachować
odtwarzalność dla starych kapsuł; stary build nie otrzymuje przez to
nieistniejącej obsługi strojenia Γ. Receipt wiąże wersję binarium i requested
tuning, a diagnostyka native opisuje rzeczywiście skonfigurowane EPS/KSP.

Jawny dodatni `max_linear_iterations` jest górnym limitem KSP, nie dolnym
progiem 1000; pominięty limit zachowuje dotychczasowy default. Oba jawne limity iteracji
muszą mieścić się w używanym typie `PetscInt`, przed konfiguracją native. Dotyczy ST i
pomocniczego KSP korekcji Ritz w K0. Wspólne override typu/restartu/rtol
dotyczą ST; korekcja Ritz zachowuje swój dotychczasowy algorytm i wzór
tolerancji. Pełny, nieprzeskalowany residual deskryptora nadal musi spełnić
`residual_tolerance` z ProblemIR, także przy luźniejszym prefilterze.

Zakres: FEM CPU. FEM GPU oraz FDM CPU/GPU mają oddzielne realizacje i nie
uzyskują obsługi tych opcji ani kwalifikacji na podstawie tej poprawki.
Publiczny Python→ProblemIR, wybór backendu i requested/resolved intent
pozostają takie same. Dane strojenia są diagnostyką wykonania, nie częścią
podpisu operatora fizycznego ani zamiennikiem source/build identity.

Mapowanie źródeł: `backends/fem/cpu/frequency_domain/modal_krylov_tuning.hpp`
+ `resolve_modal_krylov_tuning`, Schur K0 w
`poisson_airbox_schur_matshell.cpp` + `solve_poisson_airbox_modal_eigen_cpu_schur`,
Floquet w `modal/floquet_modal_solver.cpp` + `solve_floquet_modal_sparse_spectrum`,
oraz `scripts/run_de_100nm_pilot.py` + `compose_command`. Testy przygotowane
w `backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp`;
interpretowane regresje managed drivera sprawdzają requested konfigurację.
Kompilacja testów native jest zabroniona. Source checks i fixture nie
dowodzą jeszcze query rzeczywistych opcji PETSc, czasu, zbieżności Γ,
serial/adaptive parity ani kwalifikacji naukowej: wymagany nowy managed
runtime-v2 oraz ten sam model, siatka, airbox i progi akceptacji.

Podstawy implementacji: [PETSc KSPSetTolerances](https://petsc.org/release/manualpages/KSP/KSPSetTolerances/)
określa `maxits` jako maksimum iteracji;
[PETSc KSPFGMRES](https://petsc.org/release/manualpages/KSP/KSPFGMRES/)
opisuje elastyczny GMRES i jego restart. Nie wyprowadzamy z dokumentacji
biblioteki dowodu poprawności fizycznej modelu Fullmag.

<!-- k0-inner-residual-progress -->
### 3.1.2 Telemetria KSP i postęp podokien K0

Norma `rnorm` dostarczana przez PETSc do testu zbieżności KSP jest normą
wewnętrznego problemu liniowego, zależną od jego skalowania i ustawionej
normy/preconditioningu. Nie jest pełnym, względnym residualem deskryptora
LLG. Nie należy porównywać jej w UI z `residual_tolerance` modu ani używać
jako dowodu akceptacji częstotliwości.

Callback JSON `fem_frequency_domain_progress.v1` zachowuje historyczne pola,
ale dla jawnego źródła `residual_source=ksp_norm` publikuje
`current_residual_relative_l2=null` i `outer_iteration=null`. Osobno podaje
`linear_iteration`, `linear_residual_norm`, rolę `linear_solver_role`
(`poisson` albo `shift_invert`) oraz odczytany `linear_ksp_type`, gdy query
jest dostępne. Wartości niefinity i nieznane są null lub pomijane; nie stają
się zerowym residualem. Brak pola w historycznej telemetrii nie stanowi
certyfikatu nowej semantyki ani pełnego residualu.

Indeks podokna (`current_subwindow/total_subwindows`) jest osobnym wymiarem
postępu. Konsument nie zapisuje go jako liczby iteracji EPS; wyświetla go
jako podokno. Iteracje KSP i ich normę podpisuje osobno, wraz z rolą solvera.
Operatory, stop KSP, cancellation, harmonogram shiftów i pełna bramka
residualu modu pozostają bez zmiany. Są to dane diagnostyczne FEM CPU K0;
FDM i GPU nie uzyskują przez tę poprawkę kwalifikacji.

Mapowanie wykonania: `poisson_airbox_schur_matshell.cpp` +
`production_modal_ksp_convergence_test`, `poisson_airbox_modal_eigen.hpp` +
`poisson_airbox_modal_emit_progress`, `eigen_progress.rs` +
`native_modal_progress_event`, runner `lib.rs` + `fem_eigen_progress_update`
oraz CLI `orchestrator.rs` + `append_fem_eigen_step_progress`.
Źródłowe regresje producer/consumer są przygotowywane bez kompilacji
C++/Rust zgodnie z zakazem. Managed query, publikacja API/UI i rzeczywisty
log wymagają nowego runtime-v2: NOT VERIFIED.

<!-- gamma-hard-error-contract -->
### 3.1.3 Twardy błąd EPS: kwarantanna grafu K0

Niezerowy PetscErrorCode z EPSSolve jest odrębny od ujemnego
EPSConvergedReason zwróconego po poprawnym powrocie funkcji. W drugim
przypadku można odczytać wykonane iteracje i konwergentne Ritz vectors jako
diagnostykę, lecz nie zaakceptować niekompletnego okna. W pierwszym
przypadku nie wolno zakładać, że wewnętrzne borrowed views SLEPc zostały
oddane: przykładowa ścieżka Krylov–Schur odczytuje DSGetMat, wykonuje
Arnoldi przez PetscCall i dopiero potem DSRestoreMat. DSReset niszczy
przechowywane macierze. To uzasadnienie konserwatywnej polityki Fullmag,
nie obietnica biblioteki, że każdy błąd uszkadza graf.

FEM CPU K0 zachowuje po twardym błędzie heap-owned kontekst Schura i cały
zależny EPS/ST/KSP/Mat/Vec graph do odzyskania przez system operacyjny.
Właściciel kontekstu musi pozostać pod stabilnym adresem; samo pominięcie
EPSDestroy nie wystarcza przy stack-local callback context. Powrót nie
wywołuje getterów ani PETSc teardown tego grafu, rozbraja hostowe callbacks,
oznacza go invalidated i przerywa lokalne próby/growth oraz pozostałe
podokna. Trwała kwarantanna procesu nie dopuszcza kolejnego produkcyjnego
K0 solve w tym procesie; operator otrzymuje błąd wymagający nowego procesu.
Nie zabija to UI ani nie udaje sukcesu. Retencja jest wyjątkiem po błędzie,
nie cache ani polityką normalnego cleanup. Normalna ścieżka i ujemny
convergence reason bez PetscErrorCode zachowują dotychczasowy teardown.

Diagnostyka zachowuje pierwotny liczbowy kod EPSSolve, etap i brak
after-query; cancellation nadal ma status interrupted. Zachowane liczniki
hosta nie są wymyśloną liczbą iteracji EPS. Nie publikuje się accepted modes,
complete window ani certificate w tej gałęzi. Operatory, strojenie,
normalizacja, demag i końcowy residual acceptance pozostają takie same.
Publiczny Python→IR, SI i requested/resolved intent nie zmieniają się.
Zakres FEM CPU K0; pozostałe lane nie są przez to kwalifikowane.
Osobny izolowany failure regression i późniejszy managed runtime-v2 muszą
potwierdzić brak getterów/teardown/reuse oraz kontrolowane zakończenie.
Failure fixture nie został jeszcze wykonany; kompilacja testów C++ jest
obecnie zabroniona. Przegląd źródeł nie zamyka tej bramki. NOT VERIFIED runtime.

Podstawy źródłowe: [Krylov–Schur SLEPc](https://slepc.upv.es/release/src/eps/impls/krylov/krylovschur/krylovschur.c.html)
oraz [DSReset/DSDestroy](https://slepc.upv.es/release/src/sys/classes/ds/interface/dsbasic.c.html).
Źródła upstream są uzasadnieniem mechanizmu; dowód zachowania konkretnego
builda Fullmag wymaga jego własnego source/runtime identity.

<!-- gamma-common-query-trial -->
### 3.1.4 Kontrolowany trial samodzielnego Γ

Managed driver dopuszcza jawny typ gmres/fgmres w native frequency_window
DE-SMOKE również dla samodzielnego Γ. Zachowuje pierwotny model i pełny
operator K0. Konsument konfiguracji Γ wymaga rzeczywistego native adaptera
K0 Schur CPU, wektora zerowego, przypisania sample_index oraz query EPS/ST
w każdym wykonanym podoknie. Phase musi być queried_after_eps; snapshot
configured_before_eps, missing/null lub historyczny build bez obsługi nie
dowodzą wykonania requested konfiguracji.

Typ ST, requested rtol oraz jawne EPS prefilter/restart są porównywane z
query; restart uwzględnia ograniczenie liczbą split DOF. Budżety są
dodatnie, z dopuszczalnym null jedynie dla nierozwiązanego EPS max.
Niefinity/bool/ujemne dane, duplicate/missing pary (pass,subwindow_index) i niezerowy wektor
w recordzie Γ kończą się błędem. Liczby planowanych podokien pochodzą z
base_schedule i refinement_schedule natywnego window_certificate; konsument
nie narzuca własnej liczby okien. Tożsamość native adaptera odczytuje się z
solver_adapter, a nie z prezentacyjnego solver_model całej ścieżki. Global
fallback jest dopuszczony wyłącznie dla samodzielnego punktu Γ. W mieszanym
sweepie globalny adapter i query mogą należeć do pierwszego niezerowego
Floquet; Γ jest wtedy sprawdzane wyłącznie na indexed sample i jego oknach.
Brak after-query po hard EPS error nie staje się konfiguracją domyślną.

Wrapper K0 publikuje jawny wektor z operator_request albo zadeklarowanego
floquet_k_vector takze w swoim bezposrednim return; nie dopisuje zer dla
niezadeklarowanego wektora. Zapis dotyczy diagnostics i result, bez zmiany
rownan, ABI ani publicznej semantyki k.

Existing nonzero-k Floquet true-residual criterion pozostaje osobną,
nieosłabioną bramką. Mieszany sweep musi przejść oba konsumenty, standalone
Γ tylko własną kontrolę query. Receipt konfiguracji nie mierzy końcowego
true residual i nie kwalifikuje fizyki: istniejący row/spectrum/window/
demag preflight, certified equilibrium i naukowa zbieżność pozostają
obowiązkowe. Status naukowy NOT VERIFIED do managed wykonania.

### 3.2 GPU

A GPU result can become production-capable only when the assembled blocks,
vectors, Krylov basis and preconditioner remain resident on the device through
the full selected-spectrum iteration. Source contains a PETSc/SLEPc CUDA
adapter with `seqaijcusparse` matrices, `seqcuda` vectors, a device Schur
operator and fail-closed no-CPU-fallback policy. This snapshot has no completed
matching request-v19/result-v18 managed GPU execution, so these are source
claims only.
For `target="frequency_window"`, the source-level GPU adapter uses the same
16-midpoint base schedule and 32-half-step plus two-guard refinement schedule
as the CPU lane. It compares q-space cluster ranks and invariant-subspace
overlap, requires positive edge-coverage margins, and fails closed on a failed
subwindow, cancellation, truncation, or refinement disagreement. This
source-level certificate does not by itself prove runtime execution or GPU
residency.
The source-level materialized path is bounded through 1024 descriptor
dimensions and is validation-only. Larger problems select the explicit
matrix-free shell, but
convergence, persistent EPS/ST/KSP/BV ownership, allocation/transfer telemetry,
scaling and sanitizer evidence remain open. One-shot `A*x` or dense
inverse-iteration contracts are not a device-resident modal solver.

### 3.3 FDM CPU and GPU

FDM CPU/GPU are not realizations of this FEM Poisson-airbox note. Their
demagnetization kernels and FFT/Newell boundary semantics are documented by the
FDM interaction owner; no FDM capability is inferred from the FEM results.

### 3.4 FDM and hybrid

This note does not alter FDM demagnetization or introduce hybrid semantics.

(python-api)=
## 4. Python API

The public API is stage-first and physics-first. This authoring example
declares the shared domain, x/y periodicity with open z, an explicit relax
stage, the physical three-sample bias sweep, `full_2x2`, exact Gamma and an
independent postsolve Kittel oracle. Single-field `relax -> eigenmodes` has a
typed certified handoff. The multi-field execution lifecycle remains
fail-closed until the public sweep contract explicitly owns or references the
user-authored relaxation control for every sample; the runner must not restore
a hidden default tolerance. It requests CPU; changing the requested device to
`"cuda"` preserves the same physical intent but does not turn the unvalidated
GPU lane into a qualified one.

```python
# %%
import math

import fullmag as fm

mu0 = 4.0e-7 * math.pi
bias_samples_a_per_m = [
    (20.0e-3 / mu0, 0.0, 0.0),
    (50.0e-3 / mu0, 0.0, 0.0),
    (100.0e-3 / mu0, 0.0, 0.0),
]

# %%
study = fm.study("k0_periodic_airbox_bias_sweep")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %%
study.universe(mode="manual", size=(1200e-9, 600e-9, 550e-9))
film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.0
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.save("spectrum")

# %%
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="projected_gradient_bb",
    tolT=1.0e-6,
    max_steps=50_000,
)

# %%
study.stages.add_eigenmodes(
    count=4,
    target="frequency_window",
    frequency_min=1.0e6,
    frequency_max=5.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="periodic",
    magnetostatic_bc="periodic_airbox_k0",
    bias_field_sweep=fm.BiasFieldSweep(
        samples_a_per_m=bias_samples_a_per_m,
        equilibrium_policy="continuation",
        continuation_seed="previous_accepted_equilibrium",
    ),
)

# %%
result = study.run()
```

The code block parses with the current public constructors. The canonical
`Eigenmodes.to_ir()` lowering and CPU/CUDA script round-trip are covered by
`test_eigenmodes_bias_field_sweep_serializes_declared_si_samples` and
`test_study_stage_builder_bias_field_sweep_roundtrips_cpu_and_gpu_intent`.
The executable example deliberately does not install
`K0KittelFieldSweepValidation`: the current runner rejects that metadata when
`BiasFieldSweep` is present with
`bias_field_sweep_kittel_postsolve_oracle_unavailable`. A future per-sample
postsolve adapter may compare the completed spectra with
{eq}`eq-poisson-airbox-kittel-oracle`, but it may not feed the physical request.
The final `study.run()` then still requires a matching managed runtime and is
not claimed GREEN by this documentation update.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `study.device(spec, precision=...)` | `str`, `str` | required, optional | $1$ | this scope requires explicit `cpu` or `cuda` and `double` | requested execution intent | FEM CPU/GPU source contract; no hidden fallback | `backend_policy` and runtime metadata |
| `study.mode("strict")` | `str` | required by this scope | $1$ | sweep rejects non-strict execution | fail-closed capability policy | FEM CPU/GPU source contract | `validation_profile.execution_mode` |
| `study.pbc(x, y, z, demag)` | `bool, bool, bool, str` | `False, False, False, "open"` | $1$ | sweep requires x/y `True`, z `False` and `periodic_airbox_k0` | problem periodicity and static demag policy | FEM CPU/GPU source contract | `pbc.axes`, `pbc.demag` |
| `relax.tolA` | `float or None` | public relaxation default when omitted | $\mathrm{A\,m^{-1}}$ | finite and positive; mutually exclusive with tolT | authored torque stop threshold | FEM CPU/GPU relaxation contract | `StudyIR::Relaxation.stop.torque_tolerance_apm` |
| `relax.tolT` | `float or None` | public relaxation default when omitted | $\mathrm{T}$ | finite and positive; mutually exclusive with tolA | authored torque stop threshold normalized through mu0 | FEM CPU/GPU relaxation contract | `StudyIR::Relaxation.stop.torque_tolerance_apm` |
| `relax.energy_tolerance` | `float or None` | `None` | $\mathrm{J}$ | finite and non-negative | authored energy stop threshold that can independently certify relaxation | FEM CPU/GPU relaxation contract | `StudyIR::Relaxation.stop.energy_tolerance_j` |
| relaxation completion | stage result | generated | metric-dependent | `completed`, `converged`, finite metric and `metric_value <= threshold`; max steps/time/cancel/error reject | sole physical acceptance input for following eigensolve | FEM CPU/GPU shared runtime contract | `StageCompletionIR`, immutable handoff provenance |
| `eigenmodes.count` | `int` | `10` | $1$ | `count > 0` | selected mode count | FEM CPU/GPU source contract | `study.count` |
| `eigenmodes.target` | `str` | `"lowest"` | $1$ | `lowest`, `nearest`, or `frequency_window` | spectral selection strategy | FEM CPU/GPU source contract | `study.target` |
| `eigenmodes.target_frequency` | `float or None` | `None` | $\mathrm{Hz}$ | finite and positive for `nearest` | nearest target frequency | FEM CPU/GPU source contract | `study.target.frequency_hz` |
| `eigenmodes.frequency_min` / `eigenmodes.frequency_max` | `float or None` | `None` | $\mathrm{Hz}$ | finite, positive and strictly ordered for `frequency_window` | requested interval | FEM CPU/GPU source contract | `study.target.frequency_min_hz` / `study.target.frequency_max_hz` |
| `eigenmodes.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2`; C1 scope requires `full_2x2` | linearized dynamics operator | FEM CPU/GPU source contract | `study.operator.kind` |
| `eigenmodes.include_demag` | `bool` | `True` | $1$ | sweep requires `True` and a demag energy term | dynamic demagnetizing feedback | FEM CPU/GPU source contract | `study.operator.include_demag` |
| `eigenmodes.equilibrium_source` | `str` | `"relax"` | $1$ | `relax`, `provided` or `artifact` | source of accepted equilibrium | FEM CPU/GPU source contract | `study.equilibrium` |
| `eigenmodes.equilibrium_artifact` | `str or None` | `None` | $1$ | required for `artifact` | accepted equilibrium path | FEM CPU/GPU source contract | `study.equilibrium.path` |
| `eigenmodes.normalization` | `str` | `"unit_l2"` | $1$ | `unit_l2` or `unit_max_amplitude` | mode normalization | FEM CPU/GPU source contract | `study.normalization` |
| `eigenmodes.damping_policy` | `str` | `"ignore"` | $1$ | C1 sweep requires `ignore` and material $\alpha=0$ | damping treatment | FEM CPU/GPU source contract | `study.damping_policy` |
| `eigenmodes.k_vector` / `eigenmodes.k_sampling` | 3-vector / object | `None` | $\mathrm{m^{-1}}$ | use one representation only; sweep requires one exact Gamma sample | wave-vector request | FEM CPU/GPU source contract at K0 | `study.k_sampling` |
| `eigenmodes.bc` | `str or dict` | `"free"` | $1$ | `periodic_airbox_k0` requires periodic spin-wave BC | exchange/spin-wave boundary policy | FEM CPU/GPU source contract | `study.spin_wave_bc` |
| `eigenmodes.magnetostatic_bc` | `str` | `"open"` | $1$ | sweep requires `periodic_airbox_k0` | scalar-potential boundary policy | FEM CPU/GPU source contract | `study.magnetostatic_bc` |
| `BiasFieldSweep.samples_a_per_m` | sequence of 3-vectors | required | $\mathrm{A\,m^{-1}}$ | non-empty; every component finite | authored physical bias field per sample | FEM CPU/GPU source contract | `study.bias_field_sweep.samples_a_per_m` |
| `BiasFieldSweep.equilibrium_policy` | `str` | `"relax_each"` | $1$ | `relax_each` or `continuation` | equilibrium policy per physical sample | FEM CPU/GPU source contract | `study.bias_field_sweep.equilibrium_policy` |
| `BiasFieldSweep.continuation_seed` | `str` | `"initial_state"` | $1$ | `previous_accepted_equilibrium` or `initial_state`; `relax_each` rejects previous seed | continuation seed provenance | FEM CPU/GPU source contract | `study.bias_field_sweep.continuation_seed` |
| generated sweep ordering | `str` | `"declared"` | $1$ | any other value rejects in `ProblemIR` | preserves authored sample order | FEM CPU/GPU source contract | `study.bias_field_sweep.ordering` |

(problem-ir)=
## 5. ProblemIR, planning, and provenance

The Python fields lower to one canonical `StudyIR::Eigenmodes` object. The
following JSON is the exact current `fm.Eigenmodes(...).to_ir()` result for the
modal stage in the example:

```json
{
  "kind": "eigenmodes",
  "dynamics": {
    "kind": "llg",
    "gyromagnetic_ratio": 221100.0,
    "integrator": "auto",
    "fixed_timestep": null
  },
  "operator": {"kind": "full_2x2", "include_demag": true},
  "count": 4,
  "target": {
    "kind": "frequency_window",
    "frequency_min_hz": 1000000.0,
    "frequency_max_hz": 5000000000.0
  },
  "equilibrium": {"kind": "relaxed_initial_state"},
  "k_sampling": {
    "kind": "single",
    "k_vector": [0.0, 0.0, 0.0]
  },
  "normalization": "unit_l2",
  "damping_policy": "ignore",
  "spin_wave_bc": "periodic",
  "magnetostatic_bc": "periodic_airbox_k0",
  "sampling": {
    "outputs": [{
      "kind": "eigen_spectrum",
      "quantity": "eigenfrequency",
      "scope": "per_sample"
    }]
  },
  "bias_field_sweep": {
    "samples_a_per_m": [
      [15915.494309189535, 0.0, 0.0],
      [39788.735772973836, 0.0, 0.0],
      [79577.47154594767, 0.0, 0.0]
    ],
    "equilibrium_policy": "continuation",
    "ordering": "declared",
    "continuation_seed": "previous_accepted_equilibrium"
  }
}
```

The enclosing `ProblemIR` additionally carries x/y periodic and open-z
`pbc.axes`, `pbc.demag="periodic_airbox_k0"`, strict execution, double
precision, material $\alpha=0$, and the exchange/demag energy terms. Canonical
validation rejects any sweep that loses those fields.

### 5.1 Python-to-IR and planner mapping

Normalization retains exact Gamma, `include_demag=true`, all physical
`samples_a_per_m`, equilibrium policy, continuation seed and declared ordering.
Planning adds resolved execution and provenance without rewriting that physical
request:

```text
requested: engine=fem, device=cpu|cuda, precision=double, mode=strict,
           operator=full_2x2, k=(0,0,0), include_demag=true,
           bias_field_sweep.samples_a_per_m=[...]
resolved:  solver_adapter=k0_poisson_airbox_cpu_schur_slepc
           or k0_poisson_airbox_gpu_petsc_slepc,
           algebraic_form=schur_reduced_descriptor,
           spectral_transform=shift_invert,
           spectral_scalar_mode=real_split,
           assembly_kind=mfem_weak_form_shared_domain
```

`BiasFieldSweepIR` is the physics-owned request. The planner creates one
sample plan per declared field and preserves requested and resolved execution
for each sample. The former runner-local `execute_bias_field_sweep` lifecycle
is not a valid production executor after removal of hidden relaxation: it has
no user-owned stop contract from which to create a per-sample accepted handoff.
Production execution therefore remains fail-closed pending an approved
stage-materialization contract that expands every sample to an explicit
`relax -> AcceptedFemRelaxStageHandoff.v3 -> eigenmodes` sequence (with an
optional certificate-preserving device change).
`validate_bias_field_sweep_oracle_contract` prevents analytical Kittel metadata
from becoming a field, equilibrium, target or solve-acceptance input.

### 5.2 Native and artifact provenance

The schema migration is append-only and fail-closed. The legacy
`AcceptedFemRelaxStageHandoff.v2`, `LinearizationState.v6` and
`equilibrium_artifact.v7` contracts are frozen. The production handoff uses:

```text
CertifiedFemEquilibriumFields.v1
AcceptedFemRelaxStageHandoff.v3
LinearizationState.v7
equilibrium_artifact.v8
```

Handoff v3 binds the full v2 completion/equilibrium identity, the exact
certified field-bundle digest, `equilibrium_material_signature`,
`equilibrium_static_physics_signature` and
`equilibrium_boundary_signature`. `modal_operator_signature` and
`modal_dynamic_boundary_signature` are target-eigensolve identities and remain
separate. This split prevents modal-only fields such as `operator.kind` and
`spin_wave_bc` from being misused as proof of the preceding relaxation.

`CertifiedFemEquilibriumFields.v1` carries final `H_ex`, `H_demag`, `H_ext`,
`H_eff` and `phi`. Its content digest proves exact transport, but shape,
finiteness and hash checks alone do not prove source material/physics/BC
identity or the component relation for `H_eff`; v3 validation must establish
those facts before native assembly. Because v8 publicly adds the source-field
digest and split source/modal signatures, this is a real payload change and
cannot be written under `equilibrium_artifact.v7`.

The native modal payload carries:

```text
frequency_domain_request_payload_abi_version = 19
frequency_domain_legacy_result_abi_version = 18
assembly_kind = mfem_weak_form_shared_domain | synthetic_algebraic_oracle
outer_boundary_kind = poisson_robin | poisson_dirichlet | pure_neumann
gauge_policy = none | mean_zero_augmented
gauge_reason = coercive_outer_boundary | pure_neumann_nullspace
spectral_scalar_mode = complex | real_split
sigma_real_per_s, sigma_imag_rad_per_s
```

The boundary, gauge, and reason form one validated tuple. `poisson_robin` and
`poisson_dirichlet` require `gauge_policy=none` and
`gauge_reason=coercive_outer_boundary`; `pure_neumann` requires
`gauge_policy=mean_zero_augmented`, normalized quadrature-assembled mean
weights, and `gauge_reason=pure_neumann_nullspace`. Synthetic PA-E1/PA-E4b
payloads remain algebra-only and cannot establish a production claim.

`eigen/field_sweep.v1.json` uses the writer-owned axis name
`scan_axis.coordinate="bias_field_a_per_m"` and sample value
`bias_field_a_per_m`, both in `A/m`. The display conversion is named `mu0_H`
and uses tesla. `external_field_a_per_m` is a spectrum/runtime diagnostic from
which the writer reads the physical sample; it is not the field-sweep axis
name.

`k0_kittel_validation` remains postsolve metadata only. It may compare the
solved physical samples with {eq}`eq-poisson-airbox-kittel-oracle`, but must not
change the authored field, assembled blocks, equilibrium, target, lane, status
or signatures.

### 5.2.1 Klasyfikacja produktu dla skanu pola przy `k=0`

Wielopunktowy `BiasFieldSweep` przy stałym wektorze Blocha
`k=(0,0,0)` pozostaje modalnym skanem pola, a nie skanem dyspersji. Każda
próbka musi mieć własny zaakceptowany stan równowagi i własny wynik modalny,
natomiast `path_s` opisuje wyłącznie kolejność/współrzędną skanu pola. Nie
wolno używać liczby próbek ani obecności `path_s` jako sygnału dyspersji.

Klasyfikacja źródłowa jest fail-closed względem fizycznego wektora:

| Warunek próbek | `calculation_mode` | `k_sampling` | Publikowane podprodukty |
|---|---|---|---|
| wszystkie `k_vector == (0,0,0)` | `free_modes` | `single` | `spectrum`, `mode_fields` oraz zadeklarowany `field_sweep` |
| co najmniej jedna niezerowa składowa `k_vector` | `dispersion_modal` | `path` | `spectrum`, `branches`, `dispersion`, `mode_fields` zgodnie z manifestem |

Reguła jest zaimplementowana wspólnie w
`crates/fullmag-runner/src/eigen/artifacts/common.rs`
(`modal_manifest_execution`, `eigen_calculation_mode`) i
`crates/fullmag-runner/src/fem/eigen_path_manifest.rs`
(`build_eigen_path_frequency_domain_manifest`, `eigen_path_calculation_mode`).
Dzięki temu pozostałe po poprzednim runie
`branches.v2.json` lub `dispersion.csv` nie są publikowane w manifeście
bieżącego skanu `k=0` i nie mogą zasilić drzewa `Results`.

Analityczne reference solvery (`kalinikos_slab_n0` oraz
`synthetic_demag_factor`) mogą dostarczyć widmo i metadane walidacji, ale nie
mają prawa tworzyć mode fields bez topology-bound payloadu. Runner publikuje
ich mode bundle tylko po jawnym `EigenMode` i poprawnej `mesh_id`/fingerprint;
przy samym `EigenSpectrum` lub `DispersionCurve` nie wykonuje ukrytej próby
zapisu mode fields. Jawne żądanie bez tożsamości siatki jest odrzucane
fail-closed. Ta reguła chroni przed wizualizacją placeholdera jako pola
fizycznego i pozostawia produkcyjne mode fields wyłącznie ścieżce FEM z
certyfikowanym źródłem siatki.

### 5.3 Current ABI and managed-runtime status

The current recovery worktree is based on HEAD
`2e7ce7579ca5879901a297f23d8bffbe475d9b8d` plus dirty source changes. The
request and shared payload use append-only ABI v19 while the legacy by-value
result stays frozen at ABI v18. A managed bundle matched source snapshot
`0ff044a0cb15314d18bc481b76064abcb20b32476ec4f48bd909d2a567650c07` and
executed the periodic-antidot CPU workflow through accepted relaxation and
native shared-domain assembly. Subsequent source changes that bind the native
field consistency check to the acceptance certificate have not yet been
exported: the durable ext4 runtime store lacked staging headroom. No spectrum
or mode-field artifact was produced. This is partial debugging evidence, not
CPU or GPU execution qualification, so both lanes remain
`source_visible / unvalidated`.

The recovery source emits `AcceptedFemRelaxStageHandoff.v3` while retaining the
frozen v2 record and hash for backward compatibility. It binds
`CertifiedFemEquilibriumFields.v1`, completion and acceptance-certificate
digests, and source material/static-physics/static-boundary signatures; the
negative source-to-target signature tests are present. The managed validator
now accepts both the frozen v2 fixture contract and the current v3 handoff,
including the certified-field digest and split source signatures. It still
checks the published `equilibrium_artifact.v7` and `LinearizationState.v6`
names emitted by the current runner; fresh managed runtime evidence is still
missing, so an accepted handoff can reach assembly but cannot by itself qualify
a production spectrum or mode set.

The full-GPU execution attestation is only partially implemented. The accepted
version split reserves request/shared payload v19, keeps the legacy by-value
result at v18 and assigns the caller-sized attestation envelope v20. Source now
contains the v20 symbol, complete-prefix sidecar, idempotent ownership boundary,
append-only layout query v5 and a fail-closed Rust consumer. It intentionally
publishes `MEASUREMENT_UNAVAILABLE`: HYPRE device policy, measured object graph,
transfer counters and production attestation population remain absent. GPU
diagnostics therefore must not synthesize a device-resident or
production-qualified claim.

Control Room already has typed spectrum/mode metadata resources, a binary FMVP
mode-field path, five complex display views and a topology-bound viewport
overlay at source level. The Results resolver now projects only a ready
`result_manifest` product and explicitly published subproducts; responsive
Explorer rows and a stale-`Dispersion` regression smoke are also covered.
Execution/residency qualification remains unknown, and no real CPU/GPU
browser/WebGL smoke has selected and animated published modes. These are K0-G9
blockers, not presentation-only follow-up.

(round-trip-and-failure-semantics)=
## 6. Round-trip and failure semantics

Script export reproduces the stage-first Python fields and their canonical
`ProblemIR` destinations. The exported request must preserve requested intent;
the runtime report separately records resolved execution, solver adapter,
device ownership, transfer audit, and artifact provenance. This separation is
required for reproducibility and for comparing CPU and GPU runs.

Validation errors are fail-closed. The planner rejects missing accepted
equilibrium fields, a missing shared-airbox periodic certificate, an invalid
boundary/gauge tuple, a nonzero k-vector in the K0 lane, a real target applied
to the unrotated imaginary-axis pencil, or a request for an unavailable
device-resident realization. Unsupported combinations are reported with the
requested fields and the resolved capability reason; they do not silently
select CPU, synthetic algebra, or a different demagnetization boundary.

Any artifact with `assembly_kind=synthetic_algebraic_oracle` must carry
`production_periodic_airbox_claim=false`. Production-labelled periodic-airbox
verification requires `assembly_kind=mfem_weak_form_shared_domain` and matching
managed assembly and physics evidence.

(implementation-mapping)=
## 7. Implementation and evidence mapping

| Contract | Stable source owner | Test/evidence boundary |
|---|---|---|
| Public physical sweep | `packages/fullmag-py/src/fullmag/model/eigen.py` + `BiasFieldSweep` | Python constructor and round-trip tests; no solve qualification |
| Canonical sweep IR and legality | `crates/fullmag-ir/src/study.rs` + `BiasFieldSweepIR`; `crates/fullmag-ir/src/lib.rs` + `ProblemIR::validate` | IR rejection tests for exact Gamma, double, strict, demag and x/y-periodic/open-z |
| Per-sample execution and Kittel separation | `crates/fullmag-runner/src/fem/eigen_execution.rs` + `execute_bias_field_sweep`; `crates/fullmag-runner/src/fem/eigen_sweep.rs` + `validate_bias_field_sweep_oracle_contract` | Oracle isolation is source tested; current runner-local lifecycle is explicitly non-production because it cannot create certified per-sample equilibria |
| Request-v19/result-v18 native magnetic block | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `assemble_native_magnetic_a_qq` | Native MFEM source tests for P1 `tet4|prism6` exchange, certificate-bound field tolerance, unsupported anisotropy/DMI and demag identity |
| Shared-domain import and assembly | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp` + `assemble_poisson_airbox_shared_domain` (implementation in the matching `.cpp`) | Native shared-domain source tests; no current-snapshot runtime promotion |
| CPU Schur and two-pass window | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Focused synthetic certificate tests; source evidence only |
| GPU PETSc/SLEPc, persistent state and Schur application | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`, `create_gpu_solver_state` and `apply_schur` | Focused synthetic GPU adapter tests; no fresh device execution or production scaling proof |
| Caller-sized GPU attestation result v20 | `native/include/fullmag_fem.h`, `backends/fem/src/api.cpp`, `crates/fullmag-fem-sys/src/lib.rs` and `crates/fullmag-runner/src/native_fem/frequency_domain.rs` | Symbols, V1 sidecar, layout v5, destroy and fail-closed consumer are source-visible; managed ABI parity and measured attestation remain unvalidated |
| Native diagnostics and eigen-v2 artifact writer | `crates/fullmag-runner/src/fem/eigen_native_window.rs` + `native_solver_diagnostics_json`; `crates/fullmag-runner/src/fem/eigen_output.rs` + `write_eigen_v2_bundle` | Source serialization contracts; no managed-runtime or scientific qualification implied |
| Diagnostics and mode-field API resources | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` + `get_frequency_domain_eigen_diagnostics_v2` and `get_frequency_domain_eigen_mode_field_meta` | API source contracts; native browser evidence remains open |
| Results Inspector mode-field resource | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx` + `EigenModeFieldResourceInspectorPanel` | React source/tests only; no native browser qualification |
| Unified viewport mode-field overlay | `apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts` + `class ModeFieldOverlayIntentController` | Controller source/tests only; no WebGL/runtime qualification |
| Field-sweep plot and Inspector | `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisFrequencyData.ts` and `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainFieldSweepPanel.tsx` | Currently hardcoded unsupported; requires typed series/availability implementation and real browser proof |
| Results mode availability and execution qualification | `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts` (`activeFrequencyDomainProduct`, `publishedFrequencyDomainArtifact`) and `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainPublishedState.ts` | Results children are now gated by the ready published manifest; backend/device/residency qualification and real browser evidence remain open |
| Results product classification for field sweeps | `crates/fullmag-runner/src/eigen/artifacts/common.rs` (`eigen_calculation_mode`) + `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` (`eigen_path_calculation_mode`, `build_eigen_path_frequency_domain_manifest`) | Multi-sample `k=0` sweep is `free_modes`/`single`; nonzero `k_vector` is required for `dispersion_modal`/`path`; Rust regression tests pass, managed runtime unvalidated |
| Reference mode-field publication gate | `crates/fullmag-runner/src/fem/eigen_path.rs` (`mode_fields_requested`) + `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` (`eigen_path_mode_artifacts_from_result`); `crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs` (`write_mode_bundle`) and `crates/fullmag-runner/src/eigen/artifacts/common.rs` (`mode_source_mesh_identity`) | No hidden mode bundle for spectrum-only requests; explicit analytic mode request fails closed without mesh identity; dispatch and artifact tests pass |
| Field-sweep artifact axis | `crates/fullmag-runner/src/eigen/artifacts/field_sweep.rs` + `field_sweep_axis` | Writer emits `bias_field_a_per_m` and `mu0_H`; verifier consistency is a separate gate |

## 8. Discrete realization and validation strategy

The CPU and GPU lanes share the FEM weak-form physics and descriptor signs,
but use separate PETSc runtime realizations. CPU source uses host vectors, a
persistent Schur MatShell and an exact materialized shifted preconditioner only
through dimension 1024. GPU source uses PETSc/SLEPc CUDA types and materializes
the shifted operator only through dimension 1024. Both materialized paths are
validation-only. The future production bindings require
`matrix_free_schur_selected_spectrum`, including a measured
`operator_dimension > 1024`; HYPRE and scalable matrix-free convergence remain
unvalidated until executed evidence exists. No transfer, allocation, residency
or readiness claim is promoted from source inspection.

Validation proceeds in this order:

1. Manufactured Robin and Dirichlet potential tests establish weak-form signs
   and gauge policy.
2. Sphere/ellipsoid tests establish demag field sign and energy positivity.
3. Primitive/supercell x/y PBC tests establish airbox periodic reduction.
4. Physical `BiasFieldSweep` samples establish K0-1, K0-2 and K0-3 Larmor,
   local-stiffness and thin-film Kittel behavior; analytical Kittel metadata
   participates only after each solve.
5. Multi-mode selected-spectrum tests establish the target transformation.
6. CPU `frequency_window` tests perturb both shift schedule and `nev`, preserve
   degenerate clusters by rank, compare invariant subspaces, and fail closed on
   disagreement, cancellation, or diagnostic truncation.
7. GPU `frequency_window` source tests exercise the same two-pass certificate,
   rank-two degeneracy, split-cluster disagreement, failed refinement,
   between-pass cancellation, and schedule truncation; runtime execution is a
   separate gate.
8. CPU/GPU parity applies only after both operate on the same real assembled
   blocks and both certify the original descriptor residual.
9. Component-participation oracle uses a complex two-object P1/tet4 fixture,
   checks global/object/component sums, scale invariance, consistent-mass
   weighting against a hand-evaluated element result, unavailable reasons and
   solver-device versus `observable_lane` provenance. It is not complete
   until Task 2 adds the runner implementation and its focused oracle.

(validation)=
## 9. Validation evidence and completion gates

The current snapshot has source contracts and focused synthetic tests for the
claims introduced here. A managed CPU antidot run reached shared-domain
assembly but stopped before spectrum production, and it predates the latest
certificate-bound field-tolerance source change; it is therefore not current
completion evidence. Older
Kittel-driven fixtures also cannot qualify the physical field-sweep contract
when analytical samples supplied the field.

Promotion of either exact scope requires a fresh managed runtime tied to the
exact source snapshot, request/shared-payload ABI v19 and result ABI v18, then:

1. three-to-five physical bias samples with accepted equilibrium provenance;
2. P1 mesh and airbox-padding convergence plus original-block residuals;
3. CPU/GPU block, action, frequency, residual and accepted/rejected parity;
4. GPU device identity, no-fallback, persistent-state, allocation and transfer
   evidence;
5. three-size scaling including at least one measured
   `operator_dimension > 1024` on `matrix_free_schur_selected_spectrum`,
   Compute Sanitizer and immutable release evidence;
6. artifact, OpenAPI/Control Room and browser-native provenance checks.

Until all applicable gates pass, `validated_scope` and `executable_scope` stay
null for the production CPU/GPU readiness cells.

### 9.1 K0-G0–K0-G9 qualification gates

These gates are cumulative. A source symbol, a declared zero counter or a
materialized oracle cannot replace measured managed-runtime evidence.

| Gate | Required evidence and threshold |
|---|---|
| K0-G0 identity/preflight | Host and managed container agree on GPU UUID/name/compute capability; PETSc CUDA initialization succeeds; source snapshot equals the runtime manifest; unavailable GPU fails closed. |
| K0-G1 negative contracts | Missing CUDA, CPU-backed Vec, wrong HYPRE policy, stale digest, illegal scope, NaN/zero count and fallback attempts reject before solve with stable reasons. |
| K0-G2 runtime substrate | A real modal mini-problem executes the complete `MatShell + STSINVERT + KSP + PCHYPRE + BV` object graph. |
| K0-G3 measured residency/scaling | `measurement_state=measured`; hot-loop computational H2D bytes, D2H bytes, full-vector crossings and host synchronizations are each zero; each scalar telemetry payload is at most 256 bytes and count is monitor-callback-bounded; native and external trace agree; three measured matrix-free dimensions are distinct and increasing, with at least one `operator_dimension > 1024`. |
| K0-G4 CPU oracle | CPU has a complete window, finite positive modes, original block residuals and independent postsolve Kittel certificate. |
| K0-G5 GPU physics | GPU passes manufactured/action parity, full residuals, physical Kittel sweep, mesh convergence and airbox-padding convergence without reference data in solver input. |
| K0-G6 CPU/GPU parity | Relative cluster-frequency delta $\le 10^{-8}$; sine of largest invariant-subspace angle $\le 10^{-8}$; aligned complex mode-field relative delta $\le 10^{-7}$; accepted/rejected mismatch count is zero; each lane has original $\epsilon_{\mathrm{full}}\le 10^{-8}$. |
| K0-G7 Kittel/antidot | Uniform overlap $\ge 0.95$; branch/subspace continuity $\ge 0.85$; residual, tangent leakage and seam mismatch $\le 10^{-8}$; Kittel maximum/median relative error $\le 2\times10^{-2}/10^{-2}$; finest-two mesh/airbox deltas $\le 10^{-2}/5\times10^{-3}$; fitted $M_{\mathrm{eff}}$ mesh/truncation/error deltas $\le 10^{-2}/5\times10^{-3}/5\times10^{-3}$; fitted relative standard uncertainty $\le 2.5\times10^{-3}$; scaled-Jacobian condition $\le 10^6$; Poisson original constraint residual $\le 10^{-8}$; the periodic antidot preserves mesh/equilibrium identity and emits nonempty spectrum and mode fields. |
| K0-G8 robustness/performance | Repetition, reuse/invalidation, cancellation, OOM admission and device loss preserve lifecycle without leaks; equal-physics CPU/GPU performance is reported without an invented minimum speedup; `memcheck`, `racecheck` and `synccheck` have separate sidecars. |
| K0-G9 UI/release | Typed API/resources, Results attestation, binary fields, native browser/WebGL/source-mesh proof and an immutable, hash-bound, two-identity release/promotion chain all pass. |

## 10. Completeness checklist

- [x] Public `BiasFieldSweep` Python/IR/planner/runner source contract
- [x] Request-v19/result-v18 native MFEM `A_qq` source owner for bounded P1 `tet4|prism6` exchange and certificate-consistent field terms
- [x] Shared-domain BC/gauge, rotated-pencil and original-block residual source contracts
- [x] Source-level two-pass CPU window refinement certificate with cluster-rank
  and invariant-subspace comparison
- [x] Source-level two-pass GPU window refinement certificate with cluster-rank
  and invariant-subspace comparison
- [x] `AcceptedFemRelaxStageHandoff.v3` with certified fields and source material/static-physics/static-BC identity checks at source/test level
- [x] Publication contract for `volume_weighted_complex_l2_fraction.v1`, including consistent P1/tet4 mass form, scopes, units and unavailable semantics
- [x] Runner source implementation, managed transport, append-only `spectrum.v3`
  publication and complex two-object oracle for
  `volume_weighted_complex_l2_fraction.v1`; managed-runtime qualification remains open
- [ ] `LinearizationState.v7` and `equilibrium_artifact.v8` migration with old-schema rejection tests
- [ ] Fresh authoritative managed-runtime execution of the CPU window certificate
- [ ] Fresh authoritative managed-runtime execution of the GPU window certificate
- [ ] Independent K0-3 physical sweep convergence and managed CPU/GPU parity
- [ ] Full persistent GPU EPS/ST/KSP/BV state and explicit invalidation proof
- [ ] GPU matrix-free convergence and scaling beyond the materialized bound
- [ ] Nonzero-k Floquet dynamic demag

(limitations)=
## 11. Known limits and deferred work

Nonzero-k dynamic demag, damping qualification, nonuniform-texture
qualification, arbitrary mesh-size coverage, GPU matrix-free convergence,
large-problem scaling, anisotropy/DMI in native `A_qq` and broad
periodic-airbox release gates remain open.
They must fail explicitly rather than reuse this bounded k=0 path.

The component-participation contract is documentation-complete but artifact
unavailable until its P1/tet4 consistent-mass implementation, membership
oracle and provenance writer land. It must not be presented as FEM/FDM parity
or GPU postprocessing qualification before the corresponding runtime evidence.

The two-pass window certificate establishes stability of the requested modal
prefix under one deterministic shift-grid and `nev` perturbation. It is not a
contour-integral eigenvalue count and must not be interpreted as a mathematical
proof that every eigenvalue in an arbitrary interval was found.

(scientific-bibliography)=
## 12. Scientific bibliography

- W. F. Brown Jr., “Micromagnetics,” *Interscience Tracts on Physics and
  Astronomy*, no. 18, Wiley, 1963. Stable catalogue:
  [WorldCat 459671](https://search.worldcat.org/title/459671).
- D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing
  fields,” *IEEE Transactions on Magnetics* 26(2), 415–417 (1990),
  [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
- C. Kittel, “On the Theory of Ferromagnetic Resonance Absorption,”
  *Physical Review* 73, 155–161 (1948),
  [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
- V. Hernandez, J. E. Roman and V. Vidal, “SLEPc: A Scalable and Flexible
  Toolkit for the Solution of Eigenvalue Problems,” *ACM Transactions on
  Mathematical Software* 31(3), 351–362 (2005),
  [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).

(source-code-index)=
## 13. Source-code index

Stable `path + symbol` is the primary current-source identity. The immutable
links below preserve the last committed documentation baseline
`fe73ad661c55cc490faf076eb88f9ba387a9ac01`; they do not include dirty recovery
changes based on `2e7ce7579ca5879901a297f23d8bffbe475d9b8d`. Runtime or
qualification claims therefore require a fresh committed source and matching
managed manifest, not these links alone.

| Equation/claim | Lane | Repository path + stable symbol | Responsibility | Tests | Evidence status | Immutable link |
|---|---|---|---|---|---|---|
| source-nearest-floquet-ksp-telemetry | FEM CPU | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` + `floquet_shifted_ksp_diagnostics_json_fields` | Shared cached telemetry for actual Floquet nearest success/error and window; unavailable measurements preserved. | prepared native production-path regression | source expression preservation PASS; native compilation/runtime NOT VERIFIED | new task checkpoint required; runtime228 predates producer |
| source-nearest-floquet-ksp-regression | FEM CPU | `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp` + `main` | Invokes actual shared-domain nearest producer and generic/K0 absence checks; algebraic fixture, no physical qualification. | modal_nonzero_k_floquet_shared_domain_nearest_reports_shifted_ksp_diagnostics; modal_shift_invert_sparse_payload_can_be_assembled_from_mfem_operator | prepared only; native compilation/execution NOT RUN; failure fixture OPEN | new task checkpoint required |
| source-de-air-layer-planner / eq-de-air-grading-controlled-sequence | FEM CPU | `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` + `_box_airbox_layer_levels` | Exact film planes and capped exterior growth recurrence; no convergence claim. | controlled input and actual-mesh comparison | source inspected; controlled runtime pending | immutable runtime source 57182911c6e8e721b8ee9705aa7f70491c70fe94 |
| source-de-air-request-admission | FEM CPU diagnostic input | `scripts/run_de_100nm_pilot.py` + `_validate_air_growth_rate_request` | Reject ambiguous/builtin/parallel requests; require standalone single-k DE and explicit versioned input. | focused interpreted input/metadata regressions | source under review; runtime pending | task source commit will bind input; native capsule remains57182911c6e8e721b8ee9705aa7f70491c70fe94 |
| source-de-air-resolved-metadata | FEM CPU diagnostic input | `scripts/run_de_100nm_pilot.py` + `validate_air_growth_rate_metadata` | Require matched requested, declared and effective mesh growth; reject ignored controls and nonfinite/bool/missing metadata. | focused interpreted input/metadata regressions | source under review; runtime pending | task source commit will bind input; native capsule remains57182911c6e8e721b8ee9705aa7f70491c70fe94 |
| source-de-air-input-growth | FEM CPU diagnostic input | `examples/fem_de_smoke_numeric.py` + `AIR_GROWTH_RATE` | Read validated diagnostic growth setting with historical default1.3; author existing universe mesh intent and declare runtime provenance. | focused interpreted input/metadata regressions | source under review; runtime pending | task source commit will bind input; native capsule remains57182911c6e8e721b8ee9705aa7f70491c70fe94 |
| source-k0-request-vector | FEM CPU | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` + `modal_request_k_vector_json_field` | Publish declared request-derived wavevector provenance on the direct K0 result and diagnostics path without inventing an undeclared zero vector. | prepared native actual-entry regression; strict consumer cases | source WIP; managed runtime NOT VERIFIED | current source; checkpoint pending |
| source-k0-eps-hard-error | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Quarantine the heap-owned borrowed solver graph after a hard EPS error, preserve the original code and stop further K0 reuse. | source lifetime review; isolated failure-path gate pending | source WIP; managed runtime NOT VERIFIED | current source; checkpoint pending |
| source-gamma-query-trial | FEM CPU | `scripts/de_gamma_krylov_trial.py` + `validate_gamma_krylov_trial` | Verify actual per-Gamma and per-pass EPS/ST configuration against requested tuning, independently of physical residual qualification. | scoped source regression; interpreted query cases | source WIP; managed runtime NOT VERIFIED | current source; checkpoint pending |
| source-k0-linear-progress | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` + `production_modal_ksp_convergence_test` | Emit actual KSP norm and explicit Poisson/ST role, independently of physical modal residual. | prepared native/consumer regression | source WIP; managed runtime NOT VERIFIED | current source; immutable checkpoint pending |
| source-modal-progress-json | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp` + `poisson_airbox_modal_emit_progress` | Publish nullable physical residual and distinct tagged linear-solver diagnostics without invalid nonfinite JSON. | prepared native/consumer regression | source WIP; managed runtime NOT VERIFIED | current source; immutable checkpoint pending |
| source-modal-progress-decoder | FEM CPU | `crates/fullmag-runner/src/fem/eigen_progress.rs` + `native_modal_progress_event` | Keep outer iteration, subwindow index and tagged linear norm distinct. | prepared native/consumer regression | source WIP; managed runtime NOT VERIFIED | current source; immutable checkpoint pending |
| source-modal-progress-runtime | FEM CPU | `crates/fullmag-runner/src/lib.rs` + `fem_eigen_progress_update` | Preserve typed solver diagnostics in the existing progress scalar envelope. | prepared native/consumer regression | source WIP; managed runtime NOT VERIFIED | current source; immutable checkpoint pending |
| source-modal-progress-cli | FEM CPU | `crates/fullmag-cli/src/orchestrator.rs` + `append_fem_eigen_step_progress` | Label KSP norm/iteration independently of modal relative residual and window progress. | prepared native/consumer regression | source WIP; managed runtime NOT VERIFIED | current source; immutable checkpoint pending |
| Common modal Krylov tuning | FEM CPU | `backends/fem/cpu/frequency_domain/modal_krylov_tuning.hpp` + `resolve_modal_krylov_tuning` | Validate common runtime controls and adapter-specific legacy aliases | prepared native parser cases; interpreted pilot tests | source reviewed; managed native runtime NOT VERIFIED | new source; immutable commit link pending |
| Physical sweep API | common | `packages/fullmag-py/src/fullmag/model/eigen.py` + `class BiasFieldSweep` | Validate SI samples and lower declared ordering/policies | `test_eigenmodes_bias_field_sweep_serializes_declared_si_samples` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/packages/fullmag-py/src/fullmag/model/eigen.py) |
| Stage-first modal authoring | common | `packages/fullmag-py/src/fullmag/world.py` + `eigenmodes_stage` | Lower the stage builder to public `Eigenmodes` | `test_study_stage_builder_bias_field_sweep_roundtrips_cpu_and_gpu_intent` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/packages/fullmag-py/src/fullmag/world.py) |
| User-authored relaxation stop | common | `packages/fullmag-py/src/fullmag/world.py` + `_resolve_flat_relax_stop` | Normalize authored `tolA`, `tolT` and energy tolerance into the canonical relaxation stop contract | focused Python relaxation serialization tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/packages/fullmag-py/src/fullmag/world.py) |
| Accepted relaxation handoff | common | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `from_completed_relax` | Validate and bind a completed user-authored relaxation criterion to the immutable stage handoff | runner handoff acceptance tests | source tested; managed CPU reached native assembly | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs) |
| Certified final FEM fields | common | `crates/fullmag-runner/src/types.rs` + `CertifiedFemEquilibriumFields::from_fields`; `crates/fullmag-runner/src/fem/relax/finalize.rs` + `finalize_native_fem_relaxation` | Freeze and write accepted `H_ex/H_demag/H_ext/H_eff/phi` with an exact digest | focused runner tests | source implemented; managed runtime unvalidated | [types](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/types.rs) |
| Handoff v3 and split equilibrium signatures | common | `crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs` + `AcceptedFemRelaxStageHandoff`; `crates/fullmag-runner/src/fem/eigen_equilibrium.rs` + `materialize_equilibrium`; `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` + `build_shared_domain_linearization_state` | Bind certified fields plus source material/static-physics/static-BC identities separately from modal identities | runner v3 negative tests and offline validator v2/v3 tests | source/test implemented; managed runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_shared_domain.rs) |
| Equilibrium materialization | common | `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` + `build_shared_domain_linearization_state` | Materialize the accepted equilibrium, retain relative torque as diagnostics and extend operator-only air nodes deterministically | runner equilibrium materialization tests | source tested; managed CPU reached native assembly | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_shared_domain.rs) |
| Sweep `ProblemIR` | common | `crates/fullmag-ir/src/study.rs` + `BiasFieldSweepIR` | Canonical physical request | `eigenmodes_bias_field_sweep_deserializes_and_rejects_invalid_physical_samples` | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-ir/src/study.rs) |
| Sweep lifecycle and oracle isolation | common | `crates/fullmag-runner/src/fem/eigen_execution.rs` + `execute_bias_field_sweep`; `crates/fullmag-runner/src/fem/eigen_sweep.rs` + `validate_bias_field_sweep_oracle_contract` | Keep Kittel postsolve-only and reject execution that lacks a certified per-sample relaxation contract | runner oracle and fail-closed tests; stage-expansion design pending approval | source-visible / incomplete | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_sweep.rs) |
| {eq}`eq-poisson-airbox-weak-form` and native `A_qq` | FEM CPU/common assembly | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp` + `assemble_native_magnetic_a_qq`, `assemble_poisson_airbox_shared_domain_payload`, `assemble_poisson_airbox_shared_domain` | MFEM P1 magnetic, scalar and mixed assembly | `poisson_airbox_shared_domain_test.cpp` | source tested; runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp) |
| Native magnetic `A_qq` declaration | FEM CPU/common assembly | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp` + `assemble_native_magnetic_a_qq` | Stable declaration for the implementation in `poisson_airbox_shared_domain.cpp` | `poisson_airbox_shared_domain_test.cpp` | source tested; runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp) |
| {eq}`eq-poisson-airbox-modal-block`, residuals and CPU window | FEM CPU | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp` + `solve_poisson_airbox_modal_eigen_cpu_schur` | Stable declaration for the Schur solve, original residuals and two-pass certificate | focused CPU synthetic window tests | source tested; managed runtime missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp) |
| GPU selected-spectrum adapter | FEM GPU | `backends/fem/include/frequency_domain/modal_gpu_krylov.hpp` + `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` | Declare the PETSc/SLEPc CUDA adapter implemented in `modal_petsc_slepc.cpp` | `run_n3_w1_focused_tests` | source tested; device runtime unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/include/frequency_domain/modal_gpu_krylov.hpp) |
| GPU persistent solver state | FEM GPU | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` + `create_gpu_solver_state` | Construct the source-visible GPU solver state whose reuse and residency still require runtime proof | focused GPU adapter tests | source tested; persistence unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp) |
| GPU matrix-free Schur action | FEM GPU | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` + `split_schur_matmult` (entrypoint `apply_schur`) | Apply the Schur operator used by the scalable selected-spectrum lane | focused GPU adapter tests | source tested; greater-than-1024 convergence unvalidated | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp) |
| Native solver diagnostics projection | common | `crates/fullmag-runner/src/fem/eigen_native_window.rs` + `native_solver_diagnostics_json` | Project native convergence, solver-state and residency diagnostics into artifact JSON | runner tests | source tested; managed evidence missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_native_window.rs) |
| Eigen-v2 bundle writer | common | `crates/fullmag-runner/src/fem/eigen_output.rs` + `write_eigen_v2_bundle` | Write spectrum, diagnostics and mode-field resources with source provenance | runner artifact tests | source tested; qualification bundle missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_output.rs) |
| Component participation observable | common CPU postprocess after CPU/GPU solve | `crates/fullmag-runner/src/eigen/types.rs` + `ModalParticipationMeshContext::compute`; `crates/fullmag-runner/src/fem/eigen_certificate.rs` + `modal_participation_mesh_context`; `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` + `eigen_path_component_participation_from_json` | Evaluate `volume_weighted_complex_l2_fraction.v1` with the full consistent P1/tet4 mass form, aggregate canonical mesh parts by object ID, carry typed unavailable states through managed execution, and publish the result append-only in `eigen/spectrum.v3.json` while leaving v2 unchanged | focused two-object scale-invariance, incomplete-membership, same-object multipart, managed round-trip and dual-writer tests | source tested; managed runtime and real-artifact qualification missing | — |
| Component participation publication guard | documentation | `scripts/test_frequency_domain_math_contract_docs.py` + `test_component_participation_publication_contract_is_mass_consistent_and_mapped` | Require definition ID, mass-consistent equations, unit, scope semantics, unavailable behavior and source-map identities | focused pytest | source tested | — |
| Eigen diagnostics API | common | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` + `frequency_domain_artifact_content_digest` (handler `get_frequency_domain_eigen_diagnostics_v2`) | Serve the typed session-scoped diagnostics resource | API tests | source visible; native browser proof missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs) |
| Mode-field metadata API | common | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` + `eigen_mode_field_metadata` (handler `get_frequency_domain_eigen_mode_field_meta`) | Serve typed metadata for the binary mode-field data plane | API tests | source visible; native browser proof missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs) |
| Results mode-field Inspector | UI | `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx` + `EigenModeFieldResourceInspectorPanel` | Inspect selected mode-field identity, availability and provenance | focused React tests | source visible; browser qualification missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx) |
| Unified viewport overlay intent | UI | `apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts` + `activate` on `class ModeFieldOverlayIntentController` | Bind the selected eigen mode and phase to the unified viewport overlay | focused controller tests | source visible; WebGL qualification missing | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts) |
| Artifact axis `bias_field_a_per_m` | common | `crates/fullmag-runner/src/eigen/artifacts/field_sweep.rs` + `field_sweep_axis` | Freeze writer axis, unit and display conversion | field-sweep artifact writer tests | source tested | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/eigen/artifacts/field_sweep.rs) |
| K0 field-sweep product classification | common | `crates/fullmag-runner/src/eigen/artifacts/common.rs` + `eigen_calculation_mode`; `crates/fullmag-runner/src/fem/eigen_path_manifest.rs` + `eigen_path_calculation_mode` | Distinguish a multi-sample Gamma-field sweep from nonzero-k dispersion and condition manifest paths/resources | `eigen_manifest_does_not_publish_dispersion_for_multi_sample_k0_field_sweep`, `k0_multi_sample_path_is_not_classified_as_dispersion` | source tested; managed runtime unvalidated | [runner](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_path_manifest.rs) |
| Reference mode-field publication gate | common/UI | `crates/fullmag-runner/src/fem/eigen_path.rs` + `mode_fields_requested`; `crates/fullmag-runner/src/fem/eigen_path_artifacts.rs` + `eigen_path_mode_artifacts_from_result`; `crates/fullmag-runner/src/eigen/artifacts/mode_bundle.rs` + `write_mode_bundle`, `crates/fullmag-runner/src/eigen/artifacts/common.rs` + `mode_source_mesh_identity` | Prevent placeholder analytic vectors from entering the mesh-bound mode-field data plane | `de_bv_low_k_dispersion_validation_uses_analytic_reference_solver`, `mode_bundle_rejects_invalid_source_mesh_identity_before_publication` | source tested; native browser qualification missing | [runner](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/fem/eigen_path_artifacts.rs) |
| Request v19 and legacy result v18 | common | `native/include/fullmag_fem.h` + `FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION`, `FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION`, `FullmagFemModalLinearizationDescriptor` | Version the append-only request/acceptance handoff while preserving the frozen by-value result layout | FFI ABI tests | source tested; latest source snapshot not exported | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/native/include/fullmag_fem.h) |
| Caller-sized GPU attestation boundary | common/GPU | `backends/fem/src/api.cpp` + `fullmag_fem_modal_eigen_solve_v20` | Return the frozen v18 scientific result plus a caller-sized v20 attestation envelope without promoting unavailable measurements | ABI layout and ownership tests | source visible; measurement unavailable | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/backends/fem/src/api.cpp) |
| Runner GPU attestation validation | GPU | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` + `validate_modal_gpu_attestation_v1` | Fail closed on invalid, incomplete or unavailable device execution evidence | focused Rust FFI/validation tests | source visible; managed GPU proof absent | [blob](https://github.com/MateuszZelent/fullmag/blob/fe73ad661c55cc490faf076eb88f9ba387a9ac01/crates/fullmag-runner/src/native_fem/frequency_domain.rs) |


## Jawne okno diagnostyczne benchmarku DE-SMOKE

Model `examples/fem_de_smoke_numeric.py` może otrzymać parę `FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ` i `FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ`. Oba parametry są wymagane razem, muszą być skończone, dodatnie i uporządkowane. Wartości wejściowe GHz są mnożone przez 10^9 i trafiają w Hz do istniejącego `EigenTargetIR::FrequencyWindow`; metadane publikują faktycznie użyte granice. Przy `nearest` takie nadpisanie jest odrzucane. Brak obu parametrów zachowuje dotychczasowe okna.

To parametr wyboru częstotliwości, bez zmiany LLG, geometrii, materiałów, demagu, fazy Floqueta, siatki, liczby modów ani progu `eps_full <= 1e-8`. Dotyczy istniejącego benchmarku FEM CPU double; nie rozszerza FDM ani FEM GPU. Publiczny DSL, ProblemIR, OpenAPI i zasoby GUI zachowują swoje kontrakty.

Dla diagnostyki ±10 rad/µm używamy jawnego okna 10.9–11.5 GHz wokół referencji n=0 11.2354 GHz. To odrębne wejście obliczeń, zapisane w provenance, a nie dowód pełnego spektrum 8.5–12 GHz. Szerokie przeszukiwanie pozostaje otwarte: aktualny runtime przerwał je na pustym pierwszym podoknie [8.5,10.25] GHz mimo kandydata 11.2053 GHz, którego niezależnego residualu jeszcze nie oceniono. Nie wolno wnioskować o akceptacji z samej częstotliwości ani z zera w niezmierzonym residualu.

Źródła: `_configured_frequency_window_hz` i `study.stages.add_eigenmodes` w przykładzie oraz regresje wejścia `scripts/test_de_smoke_model.py`. Weryfikacja Python sprawdza lowering do Hz, parowanie parametrów, odrzucenie nieprawidłowych wartości i zachowanie modelu. Dowód managed solvera, walidacja artefaktów i zgodność z analityką pozostają wymagane osobno.


(de-physical-potential-roundoff)=
## Niezależna rekonstrukcja pola potencjału i błąd zaokrągleń

<!-- DOC-ANCHOR:de-physical-potential-roundoff -->

Artefakt `fem_modal_physical_potential.v1` publikuje węzłowy potencjał P1
oraz stałe elementowo składowe
$H_{e,a}=-\sum_{i=0}^{3}\phi_i g_{i,a}$, gdzie
$g_{i,a}=\partial_aN_i$. Walidator odtwarza ten wzór z zapisanej łączności i
współrzędnych. Producent oraz walidator wykonują rekonstrukcję niezależnie,
więc przy składowej bliskiej zeru nie wolno używać stałego absolutnego progu
oderwanego od skali składników.

Dla arytmetyki IEEE-754 binary64 przyjmujemy $u=2^{-53}=\epsilon/2$ oraz
standardowy bound $\gamma_n=nu/(1-nu)$. Lokalny bound dla porównywanej
składowej ma postać:

```{math}
:label: eq-poisson-airbox-p1-gradient-roundoff
B_{e,a}=\gamma_{104}
 \left(\sum_{i=0}^{3}|\phi_i|\right)
 \left(\sum_{i=0}^{3}|g_{i,a}|\right),
\qquad
|H^{\mathrm{stored}}_{e,a}-H^{\mathrm{reconstructed}}_{e,a}|
\le r\,\max\left(|H^{\mathrm{stored}}_{e,a}|,
 |H^{\mathrm{reconstructed}}_{e,a}|,s_0\right)+B_{e,a}.
```

| $u=2^{-53}$ | IEEE-754 binary64 unit roundoff | $1$ |
| $\gamma_n=nu/(1-nu)$ | standard finite-operation forward-error factor | $1$ |
| $B_{e,a}$ | local P1 gradient reconstruction roundoff bound | $\mathrm{A\,m^{-1}}$ |

Liczba $104$ nie jest dopasowana do wyniku. Obejmuje dwa niezależne
obliczenia (producent i walidator), z których każde ma konserwatywnie
20 operacji dla jednej składowej gradientu Tet4 (9 operacji iloczynów
wektorowych, 5 dla wyznacznika, 3 dzielenia i 3 sumowania węzła zerowego)
oraz 32 operacje dla czterech zespolonych iloczynów i akumulacji pola:
$2(20+32)=104$. Implementacja oblicza $\gamma_{104}$ jawnie; nie zmienia
`rtol=1e-10` ani skali $s_0=1\,\mathrm{A\,m^{-1}}$, lecz dodaje wyłącznie
lokalny bound propagacji roundoff. Pole z błędem większym od tej sumy nadal
jest odrzucane.

Zakres tego boundu jest ograniczony do skończonej arytmetyki rekonstrukcji na
tej samej, nieosobliwej geometrii Tet4. Kontrola orientacji, degeneracji,
hasha topologii i zgodności metadanych pozostaje wymagana; bound nie jest
certyfikatem jakości siatki, demagnetyzacji ani fizyki T4. Przy zmianie
geometrii lub źródłowej łączności wynik wymaga ponownej walidacji, a nie
zwiększenia $\gamma_n$.

Niezależne obliczenie w 80-cyfrowej arytmetyce dziesiętnej dla zachowanego
artefaktu DE przy $k_y=+10\,\mathrm{rad/\mu m}$ potwierdziło przyczynę.
W najgorszym elemencie 29924 składowa $H_x$ ma wartość wysokiej precyzji
około $10^{-71}\,\mathrm{A\,m^{-1}}$, rekonstrukcja binary64 daje zero,
a zapisany producentem field ma
$(-1.8940503\cdot10^{-7}-9.8003304\cdot10^{-8}i)\,\mathrm{A\,m^{-1}}$.
Różnica $2.13258\cdot10^{-7}\,\mathrm{A\,m^{-1}}$ wynika z kasowania
składników gradientu, nie z innego wzoru fizycznego. Dla $k_y=-10$ ten sam
element ma wysokoprecyzyjną składową $H_x$ około $10^{-70}$, a różnica
binary64–artefakt wynosi $4.75595\cdot10^{-7}\,\mathrm{A\,m^{-1}}$.
Oba zachowane artefakty mają zgodny fingerprint siatki i przechodzą walidację
po zastosowaniu lokalnego boundu. Test syntetyczny używa znanego potencjału
afinicznego, którego dokładny field jest znany analitycznie; akceptuje błąd
roundoff i odrzuca perturbację $10^{-2}\,\mathrm{A\,m^{-1}}$.

Źródła: `scripts/validate_de_physical_potential.py` (`_gamma`,
`_reconstruct_field_with_bounds`, `validate_physical_potential`) oraz
`scripts/test_de_physical_potential.py`
(`test_near_zero_p1_component_uses_forward_roundoff_bound`). Jest to
niezależna kontrola spójności zapisu pola; jej status `consistent` nie
kwalifikuje solvera, demagnetyzacji ani zgodności dyspersji z analityką.

| Źródło | Symbol |
|---|---|
| `examples/fem_de_smoke_numeric.py` | `_configured_frequency_window_hz` |
| `scripts/validate_de_physical_potential.py` | `_gamma` |
| `scripts/validate_de_physical_potential.py` | `_reconstruct_field_with_bounds` |
| `scripts/validate_de_physical_potential.py` | `validate_physical_potential` |
| `scripts/test_de_physical_potential.py` | `test_near_zero_p1_component_uses_forward_roundoff_bound` |

## Konfiguracja shifted KSP przed EPSSolve — diagnostyka addytywna

Pole `shifted_ksp_configuration_before_eps` w diagnostyce podokna Floqueta
zapisuje wartości odczytane przez KSPGetPCSide/KSPGetNormType bezpośrednio
przed EPSSolve. Przy poprawnym odczycie obiekt ma `phase=before_eps_solve`,
`pc_side` i `norm_type` jako liczby enum PETSc. Przy braku obserwacji ma null;
wartości nie są zastępowane stałą oczekiwaną z konfiguracji.

To konfiguracja przed lazy setup EPS/ST, nie dowód końcowego rozstrzygnięcia
ani zbieżności. Dotychczasowe `ksp_pc_side`/`ksp_norm_type` i dostępność true
residual pozostają osobnym pomiarem z wykonanego shifted solve. Po twardym
EPSSolve failure nie odpytujemy obiektów EPS/ST/KSP z możliwym borrowed view;
zachowana wcześniejsza kopia nie wymaga dotykania ich podczas unwind.

Zapis nie zmienia operatora Schura, faktoryzacji, fazy Floqueta, tolerancji
KSP/EPS ani fizycznej bramki residualu 1e-8. Właściciele:
`floquet_modal_solver.cpp` (bezpieczny moment obserwacji),
`slepc_modal_eigen.hpp` (wartości i jawna dostępność),
`production_cpu_modal_eigen.cpp` (diagnostyka podokien). Bramki: regresja
kontraktu natywnego, produkcyjny managed build i rzeczywisty pilot z kontrolą
raportu także przy błędzie. Przed ich wykonaniem runtime pozostaje NOT VERIFIED.

## Opt-in action-only probe Schura przed EPSSolve

Dodano odrębną, domyślnie wyłączoną sondę diagnostyczną. Włącza ją wyłącznie
zmienna środowiskowa:

```text
FULLMAG_FLOQUET_SCHUR_ACTION_DIAGNOSTIC=1
```

Wynik jest publikowany pod kluczem `floquet_schur_action_diagnostic` ze schematem
`floquet_schur_action_diagnostic.v1`. Sonda wykonuje dziewięć ograniczonych
zastosowań produkcyjnego działania Schura na własnych wektorach roboczych:
trzy powtórzenia tego samego wejścia, skale $0.5$, $2$ i $10^{-12}$ oraz dwa
niezależne wejścia potrzebne do kontroli addytywności. `action_count` ma więc
górne ograniczenie $9\le 10$ dla wywołań działania Schura; osiem pomiarów
blokowych korzysta z własnych wektorów, a dziewiąty dodatkowo wywołuje ten sam
callback `native_floquet_matmult` przez klon `MatShell`. Sonda nie wykonuje
`MatComputeOperator` i nie materializuje gęstego operatora.

Działanie obserwowane przez sondę jest tym samym blokowym działaniem, które
wywołuje produkcyjny `MatShell`:

```{math}
:label: eq-floquet-schur-action-diagnostic
\widehat{\mathcal S}_{\sigma} q
 = \kappa_{\mathrm{op}}\,
   \mathcal R_{\sigma}\left(
     A_{qq}q + A_{q\phi}\left[-P^{-1}(A_{\phi q}q)\right]
   \right).
```

gdzie $\mathcal R_{\sigma}$ jest normozachowującą rotacją real-split zależną od znaku fazy $\sigma=\texttt{context\_phase\_sign}\in\{-1,+1\}$. W tym równaniu $A_{qq}$ i $A_{q\phi}$ oznaczają złożone bloki przed normalizacją; kontekst mnoży oba przez rzeczywisty, akumulowany czynnik $\kappa_{\mathrm{op}}$ (`operator_normalization_scale`), natomiast $P$ i $A_{\phi q}$ pozostają w skali używanej do rekonstrukcji potencjału. Wobec tego sonda mierzy dokładnie znormalizowane działanie produkcyjnego MatShella, nie drugi model operatora. Czynnik skali jest stosowany spójnie do obu stron uogólnionego problemu własnego; nie jest tolerancją fizyczną.
Raport zawiera rzeczywisty `q_complex_dof_count`, `real_split_dimension`, znak
fazy, obie skale normalizacji (`operator_normalization_scale` oraz
`preconditioner_normalization_scale`) i fazę pomiaru
`measurement_phase=before_eps_solve`. Oddzielnie zapisywane są normy części
magnetycznej $A_{qq}q$, sprzężenia zwrotnego $A_{q\phi}\phi$ oraz ich sumy,
minimalny współczynnik kasowania pośród zmierzonych wejść

```{math}
:label: eq-floquet-cancellation-ratio
\rho_{\mathrm{cancel}}
 = \frac{\lVert\mathbf y_{\mathrm{mag}}
                  +\mathbf y_{\mathrm{feedback}}\rVert_2}
        {\max\!\left(
          \lVert\mathbf y_{\mathrm{mag}}\rVert_2
          +\lVert\mathbf y_{\mathrm{feedback}}\rVert_2,
          \delta_{\mathrm{fp}}
        \right)}.
```

Sonda zapisuje także maksymalny względny residual równania potencjału,
oba indywidualne defekty powtarzalności (`repeatability_first_relative_defect`
i `repeatability_second_relative_defect`), osobne defekty jednorodności
(`homogeneity_half_relative_defect`, `homogeneity_double_relative_defect`,
`homogeneity_tiny_relative_defect`) dla skal $0.5$, $2$ i $10^{-12}$ oraz ich
maksimum, a także addytywność. W mianowniku residualu Poissona używane jest `max(norm_rhs, std::numeric_limits<double>::min())`; jest to arytmetyczna ochrona przed zerowym mianownikiem w tej reprezentacji, a nie epsilon ani fizyczny próg residualu. Współczynnik z równania {eq}`eq-floquet-cancellation-ratio` jest liczony dla każdego pomiaru; raport publikuje jego minimum. Wektory $\mathbf y_{\mathrm{mag}}$ i $\mathbf y_{\mathrm{feedback}}$ są składowymi po wspólnej normalizacji operatora, przed rotacją; są bezwymiarowe, podobnie jak mianownikowy floor $\delta_{\mathrm{fp}}$.

`status=measured` oznacza wyłącznie, że ograniczony pomiar został wykonany,
`failed` — że sonda nie ukończyła pomiaru, a `unavailable` — że nie mogła
zostać uruchomiona. Ten obiekt nie ma pola `passed` i nie jest dołączany do
`dynamic_demag_operator_probe`; powtarzalność lub addytywność działania nie
certyfikują fazy Floqueta, znaku operatora, demagnetyzacji ani fizyki modelu.
Nawet błędny, lecz liniowy operator może przejść te metryki, dlatego wynik
pozostaje obserwacją do diagnostyki błędu ±2.

Sonda działa przed `EPSSolve`, korzysta z własnych ograniczonych wektorów i
izolowanego klonu kontekstu callbacku (`workspace_scope=
isolated_clone_of_production_context`). Klon współdzieli wyłącznie niezmienne
macierze blokowe i scalar KSP; jego `phi_rhs`, `phi_solution`, `feedback` oraz
`error_message` są prywatne. Sonda nie zapisuje oryginalnego
`context.error_message`, produkcyjnych buforów ani tolerancji KSP/EPS.
Współdzielony scalar KSP pozostaje obserwowalnym stanem solvera: sondowane
`KSPSolve` może zmienić jego ostatni `reason` i liczbę iteracji. Następne
produkcyjne działanie wykonuje własne rozwiązanie i nadpisuje te wartości;
sonda nie zmienia opcji, tolerancji ani faktoryzacji i nie jest przedstawiana
jako pełna izolacja stanu KSP.
Po twardym błędzie `EPSSolve` kod nie odpytuje EPS/ST/KSP ani obiektów z
pożyczonym widokiem. Brak ustawienia zmiennej środowiskowej publikuje
`floquet_schur_action_diagnostic:null`. Gdy zmienna jest ustawiona, lecz
solver zakończy się przed przygotowaniem sondy, publikowany jest obiekt
`status=unavailable`, `available=false` i powód
`diagnostic_not_reached_before_solver_setup_failure`; liczniki pozostają zerowe,
a nieznane skale i metryki są serializowane jako JSON `null`. Dzięki temu
`unavailable` nie jest mylone z wyłączonym `null`. Awaria sondy nie zmienia
wyniku produkcyjnego solvera. Wykonanie managed runtime, porównanie z analityką oraz
bramka certyfikacji pozostają osobnymi wymaganiami i przed ich wykonaniem mają
status NOT VERIFIED.

Źródła implementacji i regresji przygotowanej do uruchomienia:
`backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp`,
`backends/fem/cpu/frequency_domain/slepc_modal_eigen.hpp` oraz
`backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`;
`backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp` sprawdza
optymalizowany przypadek powyżej limitu gęstego oracle, rekonstrukcję callbacku
oraz ścieżkę twardego błędu. Kompilacja i wykonanie regresji native pozostają
do potwierdzenia przez managed build.


Symbole użyte w równaniach sondy:

| Token | Znaczenie | Jednostka SI |
|---|---|---|
| $\sigma$ | znak fazy Floqueta używany przez transformację real-split; należy do $\{-1,+1\}$ | $1$ |
| $\kappa_{\mathrm{op}}$ | akumulowany czynnik `operator_normalization_scale` wspólny dla bloków operatora Schura | $\mathrm{s\,m^{-3}}$ |
| $\widehat{\mathcal S}_{\sigma}$ | znormalizowane, obrócone działanie operatora Schura obserwowane przez MatShell | $1$ |
| $\mathcal R_{\sigma}$ | normozachowująca rotacja real-split zależna od znaku fazy | $1$ |
| $\mathbf y_{\mathrm{mag}}$, $\mathbf y_{\mathrm{feedback}}$ | znormalizowane składowe magnetyczna i sprzężenia zwrotnego przed rotacją | $1$ |
| $\rho_{\mathrm{cancel}}$ | współczynnik kasowania dla jednego wejścia diagnostycznego; nie jest testem akceptacji | $1$ |
| $\delta_{\mathrm{fp}}$ | `std::numeric_limits<double>::min()` po normalizacji; wyłącznie numeryczny floor mianownika | $1$ |

`DBL_MIN` nie jest progiem błędu ani skalą fizyczną. Użycie flooru chroni wyłącznie sam iloraz przed dzieleniem przez dokładne zero. `status=measured` oznacza wykonany pomiar, a nie przejście testu ani certyfikat liniowości/fizyki.

Mapowanie diagnostyki w source index (ścieżka + stabilny symbol):

| Source ID | Path + symbol | Odpowiedzialność | Dowód / ograniczenie |
|---|---|---|---|
| source-floquet-operator-normalization | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `normalize_native_floquet_pencil` | Skaluje wspólnie bloki magnetyczne Schura i gyrotropiczną prawą stronę; zapisuje akumulowany czynnik operatora. | review źródłowy; kompilacja/runtime NOT VERIFIED |
| source-floquet-schur-components | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `apply_native_floquet_schur_components` | Oblicza znormalizowaną składową magnetyczną i sprzężenie zwrotne przez scalar Poisson KSP. | review źródłowy; kompilacja/runtime NOT VERIFIED |
| source-floquet-action-probe | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `run_floquet_schur_action_diagnostic` | Wykonuje ograniczoną sondę przed EPSSolve na prywatnych wektorach; wynik w typie FloquetSchurActionDiagnostic zadeklarowanym w backends/fem/cpu/frequency_domain/slepc_modal_eigen.hpp. | review źródłowy; kompilacja/runtime NOT VERIFIED |
| source-floquet-diagnostic-initialization | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` | Przed setupem wywołuje initialize_floquet_schur_action_diagnostic i zachowuje requested/unavailable także przy wcześniejszych return. | review źródłowy; kompilacja/runtime NOT VERIFIED |
| source-floquet-diagnostic-serialization | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` + `solve_sparse_production_modal_payload` | Wynik diagnostyczny jest serializowany przez floquet_schur_action_diagnostic_json_field i dołączany do success/error JSON. | review źródłowy; kompilacja/runtime NOT VERIFIED |
| source-floquet-pre-eps-query | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` + `solve_floquet_shared_domain_sparse_modal_spectrum` | Odczytuje rzeczywiste PC side i KSP norm type tuż przed EPSSolve, osobno od telemetry ostatniego solve. | review źródłowy; kompilacja/runtime NOT VERIFIED |
| source-floquet-pre-eps-query-json | `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp` + `floquet_shifted_ksp_configuration_json_field` | Publikuje oba skopiowane enumy tylko przy udanym odczycie; null zachowuje brak obserwacji. | review źródłowy; kompilacja/runtime NOT VERIFIED |
| source-floquet-native-regressions | `backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp` + `main` | Native test harness invokes reports_opt_in_action_diagnostic_unavailable_before_setup, executes_native_sparse_matshell_above_dense_bound, and normalizes_si_scale_floquet_pencil. Tests remain prepared only. | test source prepared; not compiled or run |

(modal-normalization-common-scale)=
## Wspólna skala normalizacji sprzężonego modu — korekta 2026-10-03

Pełny descriptor opisuje jeden zespolony mod: współczynniki magnetyczne $q$, potencjał $\delta\phi$ i ewentualny mnożnik gauge muszą otrzymać ten sam dodatni, skończony dzielnik. `unit_l2` korzysta z bieżącej geometrycznej metryki objętościowej; `unit_max_amplitude` zachowuje dotychczasowe maksimum modułu skalarnego współczynnika. Ta korekta nie wprowadza powierzchniowej normy falowodu z 0833 ani nie zmienia publicznych tokenów Python/IR.

Historyczny dense consumer obliczał skalę certyfikatu jako pierwiastek z nieujemnej normy, ograniczony od dołu przez 1e-30, lecz dla $q$ ograniczał od dołu normę kwadratową przez 1e-30 przed pierwiastkiem. Dawało to różne skale dla dodatniej normy kwadratowej mniejszej niż 1e-30. Nowy consumer ma obliczyć skalę raz i użyć jej zarówno do wektora magnetycznego, jak i rekonstruowanego potencjału/certyfikatu. Zero, ujemna norma kwadratowa, niefinitywne współczynniki, niezgodny rozmiar metryki oraz overflow normalizowanych współczynników są błędem przed publikacją wyniku; nie zastępować ich sztucznym floor. Underflow obliczonej normy do zera wymaga jawnego błędu, nie publikacji pozornie znormalizowanego modu.

Właściciele źródłowi: `crates/fullmag-runner/src/fem/eigen_solve.rs` + `normalize_complex_mode_and_scale` oraz `crates/fullmag-runner/src/fem/eigen_native_result.rs` + `normalize_complex_block_mode`. Obie realizacje postprocess korzystają ze wspólnego checked scale i nie zmieniają operatora MFEM, eigenvalue, tolerancji residualu ani jednostek artefaktów. Regresje obejmują normę poniżej historycznego floor, równą skalę magnetyzacji/potencjału, normę zerową/ujemną/niefinitywną i niedopasowaną metrykę. Kompilacja i managed runtime tej korekty pozostają NOT VERIFIED.

| Source ID | Path + symbol | Odpowiedzialność | Lane | Dowód |
|---|---|---|---|---|
| source-modal-common-normalization | crates/fullmag-runner/src/fem/eigen_solve.rs + normalize_complex_mode_and_scale | Jedna sprawdzona skala q/potencjału, bez floor | FEM postprocess CPU/GPU | source-only; runtime NOT VERIFIED |
| source-modal-block-normalization | crates/fullmag-runner/src/fem/eigen_native_result.rs + normalize_complex_block_mode | Atomowe zastosowanie skali i zwrócenie jej dla certyfikatu | FEM postprocess CPU/GPU | source-only; runtime NOT VERIFIED |

(modal-mass-norm-outward-interval)=
## Kontrola rzeczywistej normy modalnej przez przedziały — 2026-10-03

Dla bieżącej geometrycznej metryki masy pełnego 3D (nie gyroscopic B) sprawdzamy rzeczywistą normę kwadratową konkretnego modu:

```{math}
:label: eq-modal-mass-norm-interval
\begin{aligned}
Q &= q^\dagger M_g q
   =\sum_{i,j}\overline{q_i}(M_g)_{ij}q_j,
&[Q]&=\mathrm{m^3},\\
\operatorname{Re}Q&\in I_R=[r_-,r_+],
&\operatorname{Im}Q&\in I_I=[s_-,s_+],\\
r_-&>0,\qquad 0\in I_I,
&s_{L2}&=\sqrt{\operatorname{Re}Q_{\mathrm{fl}}}>0.
\end{aligned}
```

$Q_{\mathrm{fl}}$ jest wartością bezpośredniej sumy wkładów w binary64, liczoną w tych samych jawnych operacjach skalarnych co enclosure. Historyczna obserwacja `complex_mass_norm`, która grupuje sumy wierszami, nie wyznacza tej skali i pozostaje osobną ścieżką obserwacji. Stored finite coefficients traktowane są jako dokładne wejścia analizy roundoff; błąd samego assembly i poprawność macierzy operatora mają osobne bramki. Zgodność pojedynczego Q z rzeczywistą dodatnią normą NIE dowodzi globalnej Hermitowskości ani dodatniej określoności M_g. Nie zastępować tym kontroli operatora ani convergence.

Przedziały obu części Q powstają podczas przejścia przez rzeczywiste wkłady, włącznie z powtórzonymi wpisami sparse. Każdy wynik podstawowego dodawania, odejmowania lub mnożenia rozszerza się na zewnątrz do sąsiednich binary64, bez arbitralnego relative epsilon:

```{math}
:label: eq-modal-outward-interval-operations
\begin{aligned}
[a,b]\oplus[c,d]
 &= [\operatorname{nextDown}(a+c),\operatorname{nextUp}(b+d)],\\
[a,b]\ominus[c,d]
 &= [\operatorname{nextDown}(a-d),\operatorname{nextUp}(b-c)],\\
[a,b]\otimes[c,d]
 &= [\operatorname{nextDown}(\min\{ac,ad,bc,bd\}),
     \operatorname{nextUp}(\max\{ac,ad,bc,bd\})].
\end{aligned}
```

Dokładne strukturalne zero jest zachowane: iloczyn z dokładnym zerowym przedziałem i dodawanie dokładnego zera nie wymagają rozszerzenia. Działania zespolone są rozwinięte na powyższe działania rzeczywiste. Granice finite wymagają braku overflow; niefinitywne wejścia/granice są błędem. Gradual underflow binary64 musi działać: przed ewaluacją wykonuje się kontrolę runtime z black-box wejściami, która odrzuca FTZ/DAZ. Nie stosujemy fast-math ani zmiany trybu FPU. Real interval zawierający zero oznacza niepewną dodatniość, nie poprawną normę. Imaginary interval nieobejmujący zera oznacza istotnie zespoloną normę i błąd przed normalizacją. Pozostają wcześniejsze guardy dodatniej skali oraz overflow q/potencjału.

| Token | Znaczenie | Jednostka SI |
|---|---|---|
| $M_g$ | geometryczna metryka masy pełnego 3D | $\mathrm{m^3}$ |
| $Q$, $Q_{\mathrm{fl}}$ | dokładna i obliczona norma kwadratowa raw shape | $\mathrm{m^3}$ |
| $s_{L2}$ | wspólna skala raw shape full3D | $\mathrm{m^{3/2}}$ |
| $a$, $b$, $c$, $d$ | końce lokalnych przedziałów; wymiar zależy od operandu | $1\ \text{lub}\ \mathrm{m^3}$ |
| $\oplus$, $\ominus$, $\otimes$ | outward-rounded operacje przedziałowe | $1$ |
| $i$, $j$ | indeksy współczynników | $1$ |
| $I_R$, $I_I$ | przedziały części rzeczywistej i urojonej Q | $\mathrm{m^3}$ |
| $r_-$, $r_+$, $s_-$, $s_+$ | granice przedziałów normy | $\mathrm{m^3}$ |
| $\operatorname{nextDown}$, $\operatorname{nextUp}$ | sąsiednie binary64; jednostka wyniku zgodna z argumentem | $1$ |

API Python, ProblemIR i wire artefaktów nie otrzymują nowych pól ani norm. Implementacja jest postprocessem normy, nie nowym właścicielem FEM. Dense koszt pozostaje O(n²); sparse koszt wynosi O(liczby rzeczywistych wpisów), a dodatkowa pamięć O(1). Nie materializować macierzy dense z liczby DOF. Kontrola zwiększa koszt normalizacji; pomiar runtime i wydajności pozostaje otwarty. Nie wykonuje się w hot loop Krylova ani przez dotychczasowe quadratic_form używane do innych obserwacji.

Źródła: `eigen_normalization_metric.rs` + `checked_mass_quadratic`, `eigen_mass_metric.rs` + `ModalMassMetric::normalization_quadratic_form`, `eigen_solve.rs` + `checked_complex_normalization_scale`. Kontrole metody porównują enclosure z dokładną arytmetyką Fraction; native regressions i cały JSON consumer wymagają osobnego managed runtime. Podstawa sąsiednich liczb: [Rust f64 next_up/next_down](https://doc.rust-lang.org/std/primitive.f64.html#method.next_up). Jest to wyprowadzenie przedziałowe Fullmaga, nie twierdzenie o algorytmie COMSOL.

| Source ID | Path + symbol | Odpowiedzialność | Lane | Dowód |
|---|---|---|---|---|
| source-modal-interval-norm | crates/fullmag-runner/src/fem/eigen_normalization_metric.rs + checked_mass_quadratic | Outward enclosure rzeczywistych wpisów Q | FEM postprocess | source-only; runtime NOT VERIFIED |
| source-modal-interval-metric | crates/fullmag-runner/src/fem/eigen_mass_metric.rs + ModalMassMetric | Osobne dense/sparse iteratory bez materializacji | FEM postprocess | source-only; runtime NOT VERIFIED |
| source-modal-interval-oracle | scripts/test_modal_norm_interval_source.py + class ModalNormIntervalOracleTests | Dokładne rational counterexamples i enclosure | algebraic verification | 9 interpretowanych kontroli PASS; nie jest runtime Rust |

(modal-equilibrium-field-replay-domain)=
## Replay pola równowagi: dziedzina magnetyczna i airbox

Zmiana dotyczy porównania pola efektywnego zaimportowanego certyfikatu z ponownie obliczonym polem przed złożeniem operatora. Równania LLG/Floquet i ich normalizacja pozostają w tej nocie oraz [0828](0828-fem-frequency-domain-floquet-demag.md). Dyskretne stopnie swobody magnetyzacji istnieją tylko na nośniku materiału magnetycznego. Wartości w pełnowęzłowej tablicy $\mathbf H_{\mathrm{eff},0}$ poza tym nośnikiem są konwencją ekstensji danych: natywny producent może zachować tam pole przyłożone, a referencyjny `FemLlgProblem` zapisuje zera. Tych wartości nie używa się do porównania równań magnetycznych. Nie dotyczy to potencjału magnetostatycznego $\phi_0$, którego równanie i kontrola nadal obejmują cały airbox.

```{math}
:label: eq-modal-magnetic-field-replay
\mathcal I_m=\{i:w_i^{(m)}>0\},\qquad
\epsilon_H=\max_{i\in\mathcal I_m}\max_{\alpha\in\{x,y,z\}}
\left|H^{\mathrm{stored}}_{\mathrm{eff},0,i\alpha}
-H^{\mathrm{recomputed}}_{\mathrm{eff},0,i\alpha}\right|
\le 10^{-8}\ \mathrm{A\,m^{-1}}.
```

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $w_i^{(m)}$ | lumped volume magnetycznych tetraedrów przypisany węzłowi i | $\mathrm{m^3}$ |
| $\mathcal I_m$ | niepusty zbiór węzłów nośnika magnetycznego | $1$ |
| $i,\alpha$ | indeks węzła i składowa kartezjańska x, y albo z | $1$ |
| $H^{\mathrm{stored}}_{\mathrm{eff},0,i\alpha}$ | składowa pola efektywnego w certyfikacie | $\mathrm{A\,m^{-1}}$ |
| $H^{\mathrm{recomputed}}_{\mathrm{eff},0,i\alpha}$ | odpowiadająca składowa odtworzona z tego samego modelu | $\mathrm{A\,m^{-1}}$ |
| $\epsilon_H$ | największa różnica na nośniku magnetycznym | $\mathrm{A\,m^{-1}}$ |
| $\phi_0$ | statyczny potencjał całej domeny | $\mathrm{A}$ |

Przed redukcją zakresu wymagane są zgodne pełne długości obu tablic i wag, skończone składowe wszystkich węzłów, skończone nieujemne wagi i co najmniej jeden węzeł magnetyczny. Niefinity w airboxie również oznacza błędne dane. Tolerancja pola 1e-8A/m nie jest zwiększana; zakłócenie na węźle magnetycznym nadal odrzuca replay. Kontrole m0, h_demag0, phi0, certyfikatu, materiału, fizyki, boundary i signature pozostają bez zmian. Nadal wymagamy zgodnego dyskretnego problemu demag: ta korekta nie usprawiedliwia zamiany periodic Poisson na open/Robin ani interpolacji stanu.

Python `equilibrium_source="artifact"` i `equilibrium_artifact`, ich mapowanie do `study.equilibrium.kind/path`, publiczne API, ProblemIR, urządzenie i requested/resolved provenance nie zmieniają się. Nie wprowadzamy nowego schematu ani akceptacji niecertyfikowanych pól. Zmiana jest kontrolą reprezentacji zaimportowanych tablic w istniejącym shared-domain adapterze, nie nowym operatorem FEM. Koszt O(liczby węzłów), bez nowej macierzy dense; kontrola poprzedza Krylov i nie dodaje transferów hot-loop.

| Realizacja | Zakres i dowód |
|---|---|
| FEM CPU | shared-domain import certyfikatu; kod i regresje przygotowane, nowy managed runtime wymagany |
| FEM GPU | wspólny kontrakt importu; urządzenie/GPU replay NOT VERIFIED |
| FDM CPU | nie dotyczy tego importera i siatki airboxu; własny owner FDM |
| FDM GPU | nie dotyczy tego importera; brak cichej zmiany urządzenia |

Przypadek diagnostyczny z #222: certyfikat po poprawnym seed -25rad/µm ma6138 węzłów,396 magnetycznych i5742 airbox-only; H_eff=79577.47154594767A/m w kierunku x we wszystkich węzłach, natomiast m0=0 w airbox-only. Worker -20 odrzucono wcześniej różnicą7.958e4A/m. Jest to dowód rozbieżnej ekstensji tablic; nie dowód sukcesu nowego runtime. Regresje wymagają akceptacji różnej skończonej ekstensji w airboxie, odrzucenia perturbacji magnetic node i nieprawidłowej długości/wagi/niefinity oraz zachowania kontroli pełnego phi0. Kompilacja unit tests jest tymczasowo zabroniona; testy Rust pozostają NOT VERIFIED do odwołania zakazu. Nowy managed runtime-v2 ma sprawdzić rzeczywisty seed/replay i artefakty15 punktów. Parytet, identyfikacja modów, Γ i zbieżności pozostają osobnymi bramkami.

| Source ID | Path + symbol | Odpowiedzialność i ograniczenie |
|---|---|---|
| source-modal-field-replay-scope | crates/fullmag-runner/src/fem/eigen_equilibrium.rs + max_vector_field_difference_on_magnetic_nodes | zakres nośnika i fail-closed tablic |
| source-equilibrium-materialization | crates/fullmag-runner/src/fem/eigen_shared_domain.rs + build_shared_domain_linearization_state | próg epsilon_H i niezmienione phi0/signatures |
| source-reference-external-field-scope | crates/fullmag-engine/src/fem.rs + external_field_vectors | istniejąca ekstensja referencji przez zero poza nośnikiem |
| source-modal-field-replay-regression | crates/fullmag-runner/src/fem/eigen_equilibrium.rs + finite_air_extension_does_not_change_magnetic_comparison | sześć przygotowanych regresji; kompilacja testów NOT VERIFIED |

Podstawa: ten sam dyskretny nośnik masy magnetycznej i weak form opisany w rozdziale governing-equations oraz [0828](0828-fem-frequency-domain-floquet-demag.md); źródłem stanu implementacji są powyższe symbole i receipty, nie manual COMSOL. Ta sekcja nie promuje realizacji do validated.


(modal-static-demag-replay-preimage)=
## Replay podpisu statycznego demag: integralność i porównanie numeryczne

`static_demag_signature` wiąże dokładną serializację `realization`, `h_demag0_a_per_m` i `phi0_a` opublikowanych w equilibrium artifact. Dla importowanego artefaktu weryfikujemy ten preimage z jego zapisanych pól oraz realizacji demag żądanej przez bieżący plan. Osobno porównujemy zapisane pola z przeliczeniem: H_demag na całej domenie z progiem 1e-8 A/m, phi0 na całej domenie z progiem 1e-10 A; kontrola H_eff na nośniku magnetycznym i m0 pozostaje wyżej opisana. Zgodność numeryczna nie wymaga identycznej serializacji dwóch wyników solvera.

Nie zastępujemy SHA tolerancją, zaokrągleniem ani skopiowanym deklarowanym podpisem. SHA nadal musi dokładnie zgadzać się z przeliczonym preimage przechowywanych pól. Content digest całego artefaktu, mesh/material/physics/boundary signatures i ich porównanie z bieżącym planem pozostają obowiązkowe. W szczególności zmiana realization jest nadal odrzucana. Dla nowego artefaktu z accepted relax handoff używamy świeżych pól; import zachowuje dokładne pola źródła w LinearizationState, więc oba podpisy wiążą ten sam persisted field payload. Nie zmieniamy v7/v8 lub LinearizationState v6/v7 ani ich kluczy.

Dowód #223: bootstrap ukończył pierwszy solve, worker sample1 dla ky=-20e6 rad/m odrzucono `equilibrium_static_demag_hash_mismatch`. Podpis zapisany 4baa61f6… został niezależnie odtworzony z dokładnych lexemes JSON oraz `fem_poisson_dirichlet`; wyniki przeliczenia tworzyły 3db7210e…. Wszystkie wcześniejsze kontrole pól i konfiguracji przeszły. Zapisany H_demag ma maksimum 4.745828944e-11 A/m, phi0 1.318713396e-18 A; bitowa równość wyników arytmetyki nie jest fizycznym kryterium replay. Nie jest to dowód poprawnego nowego runtime: nowy build i ponowienie sweepa nadal wymagane.

Python `equilibrium_source="artifact"` / `equilibrium_artifact` oraz ProblemIR `study.equilibrium.kind/path` bez zmiany. Poprawka jest kontrolą integralności metadata, nie zmianą operatora, normalizacji, jednostek, boundary ani dynamicznego demag. FEM CPU: kod/regresje źródłowe, managed replay OPEN; FEM GPU: wspólny importer, GPU replay NOT VERIFIED; FDM CPU/GPU: importer nie dotyczy ich realizacji. Koszt pozostaje liniowy w liczbie węzłów, bez nowej macierzy i transferów hot-loop.

Źródła: `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` + `shared_domain_static_demag_signature` oraz `build_shared_domain_linearization_state`; `eigen_equilibrium.rs` + `load_equilibrium_artifact`; `eigen_digest.rs` + `shared_domain_content_digest`. Przygotowane regresje sprawdzają roundoff-compatible replay bez zmiany źródłowego digestu, nowy producent z fresh fields, zmianę realization i odrzucenie niefinity/niepełnych pól. Zakaz kompilacji unit tests zachowany; nauka, 15 punktów, Γ, parity i zbieżność pozostają OPEN.


| Source ID | Path + symbol | Zakres |
|---|---|---|
| source-static-demag-replay-preimage | crates/fullmag-runner/src/fem/eigen_shared_domain.rs + shared_domain_static_demag_signature | dokładny persisted preimage; odrębna kontrola numeryczna w build_shared_domain_linearization_state |

Dodatkowa kontrola fail-closed: `max_vector_field_difference` i `max_scalar_field_difference` odrzucają również puste, różnej długości oraz nieskończone/NaN tablice po obu stronach porównania, na całej domenie. Zapobiega to pominięciu NaN przez `f64::max` podczas replay demag/phi0. Piąta przygotowana regresja obejmuje NaN na drugim węźle, obie strony, puste/krótsze tablice i nieskończoność; niekompilowana zgodnie z zakazem.

## Spójna stała przenikalności w shared-domain FEM CPU

Status: poprawka źródeł; świeży build i powtórny managed runtime **NOT VERIFIED**.
Ta sekcja określa spójność istniejącego modelu, a nie migrację wartości stałych SI.

W aktualnej konwencji projektu $\mu_0$ ma jednostkę
$\mathrm{T\,m\,A^{-1}}$ i wspólną wartość `fullmag::fem::kMu0`:

```{math}
:label: eq-shared-domain-mu0-convention

\mu_0 = 1.2566370614359172\times 10^{-6}
\;\mathrm{T\,m\,A^{-1}}.
```

Jest to używane w Fullmag przybliżenie odpowiadające tradycyjnej wartości
`4.0e-7 * pi`. Po redefinicji SI w 2019 roku przenikalność próżni jest
wyznaczana doświadczalnie; powyższa konwencja projektu nie oznacza, że współczesna
wartość SI jest dokładnie ustalona na `4*pi*1e-7`.
Źródło metrologiczne: [BIPM, Resolution 1 (2018)](https://www.bipm.org/en/committees/cg/cgpm/26-2018/resolution-1).

Producent `assemble_poisson_airbox_shared_domain_payload` przekazuje tę samą
wartość do sprzężenia `A_qphi`, macierzy gyrotropowej `B_qq` oraz probe demag.
`assemble_native_magnetic_a_qq` korzysta z niej przy składaniu magnetycznej
części operatora. Dotychczas dwa przypisania w tym producencie używały
`1.25663706212e-6`, podczas gdy Python, IR i zamrożony model używały wspólnej
konwencji. Zmiana wyłącznie pola diagnostyki ukryłaby różnicę rzeczywistego operatora.

Nie zmieniamy publicznego Python DSL, parametrów materiału, serializacji IR,
planera, wyboru CPU/GPU, jednostek, pola zewnętrznego, demag ani warunków brzegowych.
Niższa warstwa assemblera nadal obsługuje jawny request stałej; poprawka dotyczy
producenta wartości dla publicznego shared-domain modelu. FEM CPU wymaga świeżej
kompilacji i pomiaru. FEM GPU może używać wspólnych złożonych bloków, lecz jego
wykonanie i zgodność po poprawce pozostają NOT VERIFIED. FDM CPU/GPU nie są
modyfikowane tym przyrostem.

Dowód starego runtime #226: nearest Γ zakończył solver kodem 0, zapisał
9,299249697068216 GHz i względny pełny residual 6,3964287916e-11 przy progu 1e-8.
Driver prawidłowo odrzucił wynik: różnica stałej względem modelu wynosiła
około 5,44e-10 względnie, przy bramce spójności 1e-12. Nie zmieniamy tej bramki,
nie podmieniamy starego artefaktu i nie deklarujemy zamknięcia pełnego okna widma.

Walidacja: przygotowana regresja rzeczywistego importera ma sprawdzać wartość
probe względem `kMu0`; fixture wzajemności Floqueta również używa wspólnej stałej.
Testów C++ nie kompilujemy ani nie uruchamiamy do odwołania zakazu użytkownika.
Po nowym managed buildzie trzeba powtórzyć nearest Γ, odczytać query i pełny
residual, sprawdzić demag, zgodność stałej z niezmienionymi metadata oraz
binding równowagi i siatki. Pełne okno, signed15, porównania DE/BV/COMSOL,
zbieżność i GPU pozostają osobnymi otwartymi bramkami.

| Source ID | Path + symbol | Odpowiedzialność i dowód |
| --- | --- | --- |
| source-shared-domain-canonical-mu0 | crates/fullmag-engine/src/lib.rs + MU0 | Wspólna konwencja, równoważna kMu0 w fem_common.hpp |
| source-shared-domain-mu0-magnetic | backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp + assemble_native_magnetic_a_qq | Deklaracja; implementacja w sąsiednim .cpp używa kMu0; runtime NOT VERIFIED |
| source-shared-domain-mu0-payload | backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp + assemble_poisson_airbox_shared_domain_payload | Sprzężenie, masa i probe; source review, runtime NOT VERIFIED |
| source-shared-domain-mu0-regression | backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp + main | Przygotowany test prawdziwego importera; niekompilowany |
| source-shared-domain-mu0-gate | scripts/validate_de_smoke_rows.py + validate_gamma_demag_probe | Niezmieniona bramka zgodności z zamrożonym modelem |

## Zakończenie EPS osobno dla każdego podokna

Status: przygotowany przyrost diagnostyki źródłowej; wykonanie poprawionego runtime
**NOT VERIFIED**. Nie zmienia operatora, kryterium certyfikacji, tolerancji,
budżetów iteracji, wymiaru bazy ani limitu dokładnego preconditionera.

Run Γ #226 zakończył poprawnie 43 z 50 podokien. Siedem otrzymało
`slepc_diverged`, lecz obecny zapis podokna pomija odczytany kod zakończenia
EPS i liczbę wykonanych iteracji. Globalny kod i suma iteracji nie opisują
przyczyny zakończenia konkretnego przesunięcia. Nie dowodzi to wyczerpania
budżetu KSP ani konieczności zwiększenia limitu preconditionera.

Każde podokno ma zachować `eps_reason_available`, signed
`slepc_converged_reason_code` i `outer_iterations` z tej samej próby EPS.
Dostępność ustawiamy dopiero po udanym odczycie wyników EPS; znane zero jest
liczbą, a nie brakiem. Brak konfiguracji/odczytu albo hard error EPSSolve
pozostawia brak danych (`null`) i fałszywą dostępność. Nie wolno dodawać
getterów, teardown ani retry po hard error tylko w celu uzupełnienia metryk.
Przygotowana regresja ma badać rzeczywisty formatter i rozróżnić known zero,
ujemny reason, nieznane dane oraz stan hard error. Jest source-only, bez
kompilacji testów C++ do odwołania zakazu użytkownika.

To diagnostyka obserwowanego wykonania, nie osobna bramka fizyczna. Zapis
ujemnego kodu nie może promować częściowej zbieżności do certyfikacji okna.
Po świeżym managed buildzie trzeba powtórzyć identyczny eksperyment i dopiero
na podstawie kodów, liczników oraz effective Krylov configuration wybrać
następne strojenie. FEM GPU/FDM nie otrzymują przez ten przyrost kwalifikacji.

| Source ID | Path + symbol | Odpowiedzialność i dowód |
| --- | --- | --- |
| source-cpu-schur | backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp + solve_poisson_airbox_modal_eigen_cpu_schur | K0 EPS i agregacja podokien w sąsiednim .cpp; przygotowana poprawka źródeł, runtime NOT VERIFIED |
| source-k0-subwindow-termination-format | backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp + format_poisson_airbox_subwindow_termination_json | Rzeczywisty formatter nullable EPS termination, bez getterów; runtime NOT VERIFIED |
| source-k0-subwindow-termination-test | backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp + main | Przygotowana regresja formattera; niekompilowana |

## Odczyt wymiarów EPS osobno od żądania

Status: kontrakt przygotowanego przyrostu diagnostyki FEM CPU/K0; poprawiony
native/runtime **NOT VERIFIED**. Wymiar żądany w `requested_nev`/`requested_ncv`
nie jest automatycznie wymiarem odczytanym z biblioteki. Konfiguracja podokna
ma dodatkowo zachować wynik `EPSGetDimensions` w istniejącym snapshotcie
`modal_krylov_tuning`: `eps_dimensions.query_succeeded`, `nev`, `ncv`, `mpd`.

NEV oznacza liczbę żądanych par, NCV maksymalny wymiar podprzestrzeni, MPD
maksymalny wymiar problemu rzutowanego. Są to całkowite liczby w jednostce
$1$. Wartości getterów zapisujemy jako signed integers, także zero i sentinel
ujemny. Nie podstawiamy ustawień żądanych w miejsce brakującego pomiaru.
Faza `configured_before_eps` opisuje odczyt przed setup/solve; nierozwiązany
jeszcze MPD nie jest wtedy dowodem rzeczywistego rozmiaru problemu po solve.
Faza `queried_after_eps` oznacza odczyt z tej samej, poprawnie dostępnej próby.
Błąd getterów wymiaru daje `query_succeeded=false` i trzy `null`, nie nową
bramkę akceptacji fizycznej ani zmianę parametrów EPS.

Żaden nowy getter nie może wykonać się po hard error EPSSolve lub na
nieważnym kontekście. Istniejąca wcześniejsza bezpieczna migawka nie staje
się migawką postsolve przez sam wpis do JSON. Dodanie obserwacji nie zmienia
operatora, NEV/NCV/MPD, tolerancji, limitów, preconditionera, warunków brzegu
ani certyfikacji pełnego residualu. Snapshot pozostaje małym fragmentem
diagnostyki; nie tworzy osobnego endpointu lub alternatywnego planera.

Konsument `validate_gamma_krylov_trial` zachowuje ten mały obiekt osobno
dla globalnej migawki, próbki i każdego podokna: opcjonalne
`eps_dimensions` na poziomie root raportu, `by_sample[i].eps_dimensions`
oraz `by_sample[i].subwindows[j].eps_dimensions`. W mixed sweep root
nie otrzymuje wymiarów nieistniejącego globalnego snapshotu Γ. W historycznych artefaktach
brak obiektu pozostaje brakiem dodatkowego pomiaru; jawne null zamiast
obiektu, nieboolowski status, brak klucza lub wartość poza signed int64 są
błędem kontraktu danych. Przy `query_succeeded=false` wszystkie trzy wartości
muszą być null. Nie porównujemy wymiarów między podoknami, bo base/refinement
mogą legalnie żądać innych baz. Walidacja kształtu telemetry nie zastępuje
fizycznego residualu ani nie ustala polityki strojenia.

Regresja ma wywołać rzeczywisty formatter dla poprawnych wymiarów, znanego
zera, ujemnego sentinela, braku odczytu i zbyt małego bufora. Test C++ jest
przygotowany i niekompilowany zgodnie z zakazem użytkownika. Źródłowe review
i walidacja noty nie dowodzą wykonania getterów ani bramki naukowej. Źródło
znaczenia NEV/NCV/MPD: [dokumentacja SLEPc EPSGetDimensions](https://slepc.upv.es/release/manualpages/EPS/EPSGetDimensions.html).

| Source ID | Path + symbol | Odpowiedzialność i dowód |
| --- | --- | --- |
| source-cpu-schur | backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp + solve_poisson_airbox_modal_eigen_cpu_schur | Odczyt EPS w istniejących fazach; runtime NOT VERIFIED |
| source-k0-eps-dimensions-format | backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp + format_poisson_airbox_eps_dimensions_json | Signed nullable wymiary odczytane, bez setterów/getterów w formatterze |
| source-k0-subwindow-termination-test | backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp + main | Regresja actual formattera wymiarów; niekompilowana |
| source-gamma-query-trial | scripts/de_gamma_krylov_trial.py + validate_gamma_krylov_trial | Zachowanie opcjonalnych rzeczywistych wymiarów osobno dla każdego podokna |
