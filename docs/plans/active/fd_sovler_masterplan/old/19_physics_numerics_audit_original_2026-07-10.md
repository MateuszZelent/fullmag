> Historical snapshot captured on 2026-07-10. This file is excluded from the
> canonical read order and must not define current physics, algorithms or
> implementation status.

---
title: Audyt fizyczno-numeryczny eigensolve i frequency-driven FEM
date: 2026-07-09
status: audit_failed_blockers_found
scope:
  - docs/plans/active/fd_sovler_masterplan
  - docs/physics
  - FEM modal k=0 Poisson-airbox CPU/GPU
  - FEM frequency-driven k=0 i non-k0
  - Kittel validation and artifact verifiers
authoring_rule: Findings are based on current source and local artifacts, not on claimed green gates alone.
---

# Audyt fizyczno-numeryczny: FEM eigensolve i frequency-driven

## 1. Werdykt

Stan na 2026-07-09 nie pozwala uznać modalnego `periodic_airbox_k0` za
produkcyjnie zwalidowany solver FEM Poisson-airbox. Istnieje wartościowy zestaw
kontraktów, ABI, testów algebraicznych i wąskich adapterów SLEPc/GPU, lecz
aktualny K0-3 "real managed" test składa macierze syntetyczne z danych o parach
periodicznych i z deklarowanej wartości `M_eff`. Nie składa macierzy słabej
formy z elementów FEM wspólnej siatki magnet + airbox.

To ma bezpośrednią konsekwencję: raportowane niemal zerowe błędy Kittela i zerowy
residual Poissona nie są niezależnym dowodem poprawności demagnetyzacji,
warunku Robin, znaku pola, transmisji z relaksacji ani zbieżności FEM. Wynik
może być dokładny dlatego, że odpowiedź analityczna jest wstrzykiwana do
generatora operatora.

### Status według produktu

| Produkt / ścieżka | Rzeczywisty status | Co można uczciwie twierdzić | Czego nie wolno twierdzić |
|---|---|---|---|
| K0-1, no-demag, CPU | wąsko zweryfikowany | Larmor/Kittel bez demag jest dobrym gate'em znaków, `gamma0`, `2*pi` i wyboru gałęzi | że dowodzi dynamicznej demagnetyzacji |
| K0-3, CPU `periodic_airbox_k0` | syntetyczny payload + adapter SLEPc | ABI, układ blokowy, ścieżka artifactowa i algebraiczne testy są częściowo pokryte | że wykonano pełny FEM Poisson-airbox eigensolve albo że Kittel został niezależnie odtworzony |
| CPU Schur/provider driven response | częściowo wykonywalny, wymaga kwalifikacji | istnieje matrix-free fizyka operatora dla legalnych k=0 slice'ów | że jest to pełny złożony układ `[delta_m, delta_phi]` albo dowód modalny |
| CPU non-k0 no-demag | ograniczony Floquet/tangent payload | można testować lokalne/exchange no-demag z właściwą fazą i osobną walidacją | że istnieje Floquet dynamic demag-k |
| GPU K0 no-demag | wąski kontrakt/fixture | istnieje niezależna ścieżka macrospin/Kittel bez demag | że GPU rozwiązuje Poisson-airbox modal |
| GPU Poisson-airbox modal | kontraktowe apply i bardzo mały dense proof | istnieją urządzeniowe akcje `A*x` oraz `(A-sigma B)*x` bez CPU fallbacku | że istnieje skalowalny device-resident Krylov-Schur/Arnoldi lub produkcyjny eigensolve |
| GPU non-k0 Floquet | no-demag phase projection | można testować wskazany no-demag slice | że operator Blocha/demag-k jest kompletny |

### Blokery promocji

1. PA-E4b używa zbudowanej pod odpowiedź Kittela makrocelowej algebry, a nie
   FEM weak-form Poissona.
2. Plan narzuca mean-zero gauge mimo zadeklarowanego `poisson_robin`; Robin lub
   Dirichlet usuwa stały nullspace i nie może dostać dodatkowego ograniczenia.
3. Adapter SLEPc na realnym PETSc używa realnego shiftu `target_omega`, chociaż
   konwencja modalna szuka `lambda = i omega`.
4. Certyfikat full residual może raportować mniejszy z residualu SLEPc i
   residualu rekonstrukcji, czyli maskować błędną rekonstrukcję układu.
5. Przykład Kittel K0-3 ma PBC jedynie w osi `x`, więc nie spełnia geometrii
   idealnego filmu z `N_x=N_y=0, N_z=1`.
6. Aktualne "convergence" gates nie mierzą zbieżności dyskretyzacji ani
   obcięcia airboxa.

Do usunięcia tych blokad nazwa lane'a `production_cpu` dla K0-3 jest błędna.
W artifactach musi być `validation_synthetic_payload` albo równoważny status
degradacji, a `production_periodic_airbox_claim` musi być `false`.

## 2. Zakres, metoda i źródła

Audyt obejmuje wszystkie kanoniczne pliki katalogu
`docs/plans/active/fd_sovler_masterplan`, ze szczególnym uwzględnieniem planu
18, oraz aktualny kod modalny CPU/GPU, przykłady i weryfikatory artifactów.
Równolegle sprawdzono lokalny tekst 71-stronicowego manuala Micromagnetics
Module V2.13, kanoniczne noty fizyczne i konfigurację zainstalowanego PETSc.

Manual potwierdza bazową konwencję `exp(+i omega t)`, zespolone
`delta_m=(dmX,dmY,dmZ)`, warunek `m0 dot delta_m=0`, konieczność użycia
równowagi statycznej oraz wspólne rozwiązywanie dynamicznego pola demag dla
studium Frequency Domain. Nie zastępuje on jednak walidacji implementacji
Fullmag.

W analizie rozróżniono:

| Rodzaj dowodu | Znaczenie |
|---|---|
| kontrakt/API | struktura danych lub test ABI istnieje |
| algebraiczny oracle | dowód znaków i eliminacji dla sztucznej małej macierzy |
| wykonanie runtime | kod wywołał backend na realnych danych wejściowych |
| walidacja fizyczna | wynik jest niezależnie porównany z rozwiązaniem referencyjnym przy zbieżności siatki i domeny |
| produkcyjna kwalifikacja | fizyka, numeryka, provenance, skalowanie i regresje są jednocześnie pokryte |

Zielony test kontraktu nie jest automatycznie dowodem następnego poziomu.

## 3. Model referencyjny, który implementacja musi zachować

### 3.1. Konwencja fazorowa i liniowe LLG

Obowiązuje

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(+i omega t)]
H_eff(r,t) = h_eff0(r) + Re[delta_h_eff[delta_m](r) exp(+i omega t)]
```

oraz

```text
|m0| = 1
m0 dot delta_m = 0.
```

Przy `gamma0 = mu0 |gamma|`, polach w `A/m` i `alpha=0`:

```text
i omega delta_m =
    - gamma0 [m0 x delta_h_eff[delta_m] + delta_m x h_eff0].
```

Wybór wewnętrznego `q` w bazie stycznej jest właściwy wyłącznie wtedy, gdy
`delta_m=Tq`, a projekcja/lift oraz wszystkie operatory, również dynamiczny
demag, są zgodne z pełnym polem wektorowym. Publiczny artifact nadal musi
zwracać `dmX/dmY/dmZ` i normy `m0 dot delta_m`.

W modalnym zapisie przyjęto `lambda=i omega`. To oznacza, że każda implementacja
powinna precyzyjnie opisać, czy jej macierz jest `L q = lambda B q`,
`K q = -i omega G q`, czy równoważnym real-split. Różne symbole `A`, `B`, `K`,
`M`, `G` bez słownika znaków są niedopuszczalne.

### 3.2. Dynamiczny Poisson-airbox: poprawna domena i słaba forma

Niech `D = Omega_m union Omega_air` będzie pełną domeną skalara, a nie samym
powietrzem. Magnetyzacja jest przedłużona zerem poza `Omega_m`:

```text
delta_M = Ms delta_m in Omega_m,
delta_M = 0          in D \ Omega_m,
delta_H_demag = -grad(delta_phi),
div(grad(delta_phi)) = div(delta_M) in D.
```

Słaba forma dla Robin na otwartej części granicy `Gamma_open` jest:

```text
find delta_phi in V_h:

  integral_D grad(psi) dot grad(delta_phi) dV
+ beta integral_Gamma_open psi delta_phi dS
= integral_Omega_m Ms delta_m dot grad(psi) dV

for every psi in V_h subject to the lateral periodic constraints.
```

Zapis w planie 18, który całkuje lewą stronę po `Omega_air`
([plan 18, linie 305-325](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L305)),
jest nieprecyzyjny i podatny na implementację pomijającą elementy magnetyczne z
macierzy Laplace'a. Poprawnym symbolem po lewej jest `D`.

Warianty BC muszą mieć oddzielną politykę nullspace:

| Granica zewnętrzna | Macierz `P` | Czy jest nullspace stały? | Poprawna polityka |
|---|---|---:|---|
| Robin z `beta>0` na `Gamma_open` | `K + beta M_Gamma_open` | nie | bez gauge i bez `eta` |
| Dirichlet | redukcja/eliminacja DOF Dirichlet | nie | bez gauge i bez `eta` |
| czysty Neumann | `K` | tak | mean-zero lub prawdziwy `MatNullSpace`, po kontroli kompatybilności RHS |
| pełna periodyczność 3D, k=0 | ma stały nullspace oraz niejednoznaczny makroskopowy składnik demag | tak | obecnie odrzucić albo jawnie zdefiniować fizyczną konwencję |

Lateral PBC oznacza wykluczenie Robin/Dirichlet na szwach i zachowanie Robin
wyłącznie na otwartych powierzchniach, typowo górnej/dolnej granicy `z` dla
filmu periodycznego w `x/y`.

### 3.3. PBC i Floquet

Przy `phase=exp(-i k dot delta_r)`:

```text
delta_phi_dst = phase delta_phi_src,
T_dst q_dst   = phase T_src q_src,
q_dst          = phase (T_dst^T T_src) q_src.
```

Faza skalara jest tylko fazą Blocha. Tangentowy warunek musi działać na
odtworzonym wektorze, nie na surowych współrzędnych `u/v`. Dla tekstury
niejednorodnej nie wystarcza naprawa tylko par na szwie: różniczkowanie i
całkowanie elementów musi zachować pełnowektorową geometrię ramek w całym
domenie.

Non-k0 dynamic demag wymaga operatora `grad_k/div_k` oraz zespolonej redukcji
Blocha po stronie pola magnetycznego i potencjału. Nie wolno zastępować go
statycznym Poissonem k=0 ani projekcją fazy po wykonaniu operatora.

### 3.4. Kittel jako niezależny oracle

Dla równowagi w kierunku `e0` i stycznych kierunków `e1,e2`, ogólny wzór
makrospinowy ma postać

```text
omega_K^2 = gamma0^2 H1 H2,
Hj = H0 + (Nj - N0) Ms + Hk,j,  j in {1,2}.
```

Szczególny wzór

```text
f = gamma0/(2 pi) sqrt(H0 (H0 + Ms))
```

jest legalny tylko dla idealnego filmu o `m0 || x`, PBC `x/y`, otwartym
`z`, `Nx=Ny=0`, `Nz=1`, bez dodatkowej anizotropii prostopadłej. Dla skończonego
paska, antidotu lub komórki okresowej z jedną osią wolną należy stosować
liczone lub niezależnie określone `N0,N1,N2`, a nie pojedyncze `M_eff` wpisane
do wejścia solvera.

Przy idealnym filmie i `H0=0` istnieje fizyczny miękki mod o częstotliwości
zero. Użycie bardzo małego dodatniego pola jest dopuszczalne jako zabieg
numeryczny do rozdzielenia gałęzi, ale nie może ukrywać warunku stabilności ani
być przedstawiane jako korekta wzoru Kittela.

## 4. Ustalenia krytyczne

### F-01. PA-E4b jest syntetycznym generatorem algebraicznym, nie realnym FEM Poisson-airbox

**Waga: BLOCKER. Dotyczy: K0-3 CPU, raportów `production_periodic_airbox_claim`, konwergencji, dalszej promocji GPU.**

#### Dowód

Plan deklaruje, że wąska ścieżka jest "real managed FEM example" i publikuje
`production_periodic_airbox_claim=true`, `poisson_constraint_relative_residual=0`
i zerowy błąd Kittela
([plan 18, linie 2649-2680](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L2649)).

Generator używany przez runner robi jednak następujące rzeczy:

- pobiera deklarowane `effective_magnetisation`,
- oblicza bezpośrednio `gamma0 sqrt(H0 (H0 + M_eff))`,
- wpisuje tę samą wartość jako `target_frequency_hz` i
  `expected_reference_frequency_hz`,
- buduje `A_qq`, `A_qphi`, `A_phiq`, `A_phiphi`, `B_qq` z liczby/długości par
  okresowych, mas par oraz pierścieniowej macierzy conductance.

Widać to w
[fem_eigen.rs:1026](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem_eigen.rs:1026),
w szczególności w obliczeniu analitycznej odpowiedzi
[fem_eigen.rs:1063](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem_eigen.rs:1063),
wstrzyknięciu `demag_delta=gamma0*M_eff`
[fem_eigen.rs:1064](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem_eigen.rs:1064),
oraz konstrukcji pierścieniowego `A_phiphi`
[fem_eigen.rs:1119](/home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem_eigen.rs:1119).

Plan wprost przyznaje później, że realne shared-domain macierze z mesh/material
nie są składane ([plan 18, linie 2814-2817](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L2814)).
To przeczy wcześniejszemu twierdzeniu o zamkniętym PA-E4b.

#### Skutek fizyczny

Ten test nie może wykryć błędów w:

- elementowej macierzy Laplace'a i Robin mass,
- źródle `div(Ms delta_m)`,
- znaku `H_demag=-grad(phi)`,
- normalnej ciągłości pola na granicy magnet/air,
- ograniczeniu PBC całego airboxa,
- statycznym `H_demag0` i liniaryzacji wokół `m0`,
- grubości warstwy, zagęszczeniu w `z`, ani obcięciu airboxa.

Zerowy błąd względem Kittela jest przez konstrukcję oczekiwany, nie jest
pomiarową walidacją.

#### Wymagana korekta

1. Natychmiast zmienić etykietę ścieżki na
   `synthetic_topology_shaped_kittel_payload` albo równoważną.
2. Ustawić `production_periodic_airbox_claim=false` i usunąć `production_cpu`
   z artefaktów tej ścieżki.
3. Zachować ten payload wyłącznie jako test ABI/znaków/algebry descriptorowej.
4. Zbudować osobny realny builder z `MeshIR`/MFEM:
   - `K_phi` na wszystkich elementach `D`,
   - `M_Gamma_open` wyłącznie na otwartej części granicy,
   - `C` z `integral_Omega_m Ms Tq dot grad(psi)`,
   - sprzężenie magnetyczne z `-grad(phi)` i projekcją styczną,
   - magnetic mass/gyrotropic block z faktycznej siatki i materiału,
   - okresową redukcję dla magnetu i całego airboxa.
5. Referencyjna częstotliwość Kittela ma być wyłącznie w verifierze. Builder
   operatora nie może otrzymywać oczekiwanej odpowiedzi.

#### Gate akceptacji

Test perturbacji źródła: zmiana `A_phiphi`, Robin `beta`, `Ms`, grubości albo
airboxa musi zmienić wynik realnego FEM w fizycznie przewidywalny sposób.
Jeżeli `expected_reference_frequency_hz` jest usunięte z wejścia buildera,
wynik nadal musi przejść niezależny verifier Kittela.

### F-02. Gauge mean-zero jest sprzeczny z `poisson_robin` i `poisson_dirichlet`

**Waga: BLOCKER. Dotyczy: poprawności pola, Schura, kondycjonowania i interpretacji `eta`.**

#### Dowód

Plan narzuca globalnie `gauge_policy=mean_zero_augmented`
([plan 18, linie 356-379](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L356))
i zawsze dołącza blok `c, cT`. Jednocześnie przykład wywołuje
`study.demag(realization="poisson_robin")`
([example:81](/home/kkingstoun/git/fullmag/fullmag/examples/fem_eigen_k0_kittel_periodic_airbox.py:81)).

W słabej formie Robin dodatni człon `beta M_Gamma_open` usuwa stały nullspace;
Dirichlet również go usuwa. Kanoniczna nota demag wyraźnie definiuje
`K + beta M_boundary` dla Robin
([0520:95](/home/kkingstoun/git/fullmag/fullmag/docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md:95)).
Nota Floquet ostrzega, że gauge stosuje się tylko, gdy złożony operator
rzeczywiście ma nullspace, a otwarte top/bottom nie dostają mean-zero wyłącznie
z powodu okresowości lateralnej
([0828:131](/home/kkingstoun/git/fullmag/fullmag/docs/physics/0828-fem-frequency-domain-floquet-demag.md:131)).

#### Skutek fizyczno-numeryczny

Dodatkowe `cT phi=0` przy Robin/Dirichlet zmienia problem brzegowy i może
wprowadzić sztuczny mnożnik `eta`. Nie jest to neutralny wybór solvera. Może
zmienić `phi`, a przez to dynamiczny demag i częstotliwość własną.

#### Wymagana korekta

Wprowadzić `PoissonBoundaryPolicy` jako część realnego payloadu:

```text
assembly_kind = synthetic_algebraic_oracle | mfem_weak_form_shared_domain
outer_boundary_kind = robin | dirichlet | pure_neumann
open_boundary_marker_set
robin_beta_per_m
gauge_policy = none | mean_zero_augmented | petsc_nullspace
gauge_reason = no_nullspace | pure_neumann_nullspace | fully_periodic_policy
```

Następnie wymuszać macierz decyzji z sekcji 3.2. Dla obecnego thin-film K0-3
z `x/y` PBC i otwartym `z`: Robin/Dirichlet, więc `gauge_policy=none`.

### F-03. Shift-invert SLEPc celuje w zły punkt płaszczyzny spektralnej

**Waga: BLOCKER. Dotyczy: wyboru modów w oknie częstotliwości, szczególnie dla dużych problemów.**

#### Dowód

Dokumentacja deklaruje `lambda=i omega` dla modów. W idealnym przypadku shift
musi więc być `sigma=i omega_target`. Szkic planu 18 jest poprawny dla PETSc
zespolonego ([plan 18, linie 1599-1626](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L1599)).

Zainstalowany runtime jest jednak realny (`PETSC_USE_REAL_DOUBLE`)
([petscconf.h:202](/home/kkingstoun/git/fullmag/fullmag/.fullmag/runtimes/fem-gpu-host/include/slepc/petscconf.h:202)).
Aktualny adapter tworzy

```text
target_omega = 2 pi f_target
EPS_TARGET_MAGNITUDE
EPSSetTarget(target_omega)
```

w [poisson_airbox_modal_eigen.cpp:1046](/home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp:1046).
To jest realny shift `sigma=omega_target`, a nie punkt `i omega_target`.
Późniejsze filtrowanie po `abs(Im(lambda)-target_omega)`
([poisson_airbox_modal_eigen.cpp:1126](/home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp:1126))
nie naprawia tego, że Krylov-Schur z shift-invert najpierw znalazł wartości
wokół błędnego shiftu.

#### Skutek

W małym problemie, gdy pobierane są praktycznie wszystkie wartości, błąd może
się ukryć. W realnej macierzy z wąskim oknem wybrany mod może być nie tym
modem, a właściwy może nie zostać zwrócony.

#### Wymagana korekta

Należy wybrać jedną i tylko jedną jasno wyprowadzoną realizację:

1. PETSc/SLEPc complex i `sigma=i omega_target`.
2. Jawny blok realny 2x2 reprezentujący zespolony operator i shift
   `[[A_R-sigma_R B, A_I+sigma_I B],[-A_I-sigma_I B,A_R-sigma_R B]]`.
3. Rygorystycznie wyprowadzony realny Hamiltonian/gyrotropic pencil z mapą
   `omega` do realnej wartości własnej.

W każdym wariancie artifact ma publikować `sigma_real`, `sigma_imag`, rodzaj
skalara PETSc i regułę selekcji. Zakaz: "użyj istniejącej konwencji" bez
zdefiniowania jej w kodzie i testach.

### F-04. Certyfikat residualu może ukryć złą rekonstrukcję

**Waga: BLOCKER. Dotyczy: zaufania do każdego zwróconego modu.**

#### Dowód

Plan miesza jednostkowo odmienne residuale `q`, `phi`, `eta` w jednym L2,
a mianownik `phi` zawiera sam residual
([plan 18, linie 1017-1088](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L1017)).

Implementacja robi dodatkowo:

```cpp
full_residual_reconstruction_relative_error =
    min(residual_metrics.full_relative, best_residual);
```

[poisson_airbox_modal_eigen.cpp:1175](/home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp:1175).

`best_residual` jest residualem zwróconym przez SLEPc, a nie residualem
rekonstrukcji pełnego descriptorowego układu. Mała liczba SLEPc może więc
przykryć błędne `phi`, `eta`, coupling lub mapowanie wektora.

W realnym branchu kod testuje jeszcze sprzężony wektor z tym samym dodatnim
`lambda` i wybiera mniejszy residual
([poisson_airbox_modal_eigen.cpp:1162](/home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp:1162)).
To może maskować błąd chirality/fazy, bo sprzężenie wektora wymaga również
spójnej semantyki sprzężonej wartości własnej i gałęzi.

#### Wymagana korekta

Publikować trzy niezależne wielkości:

```text
slepc_reported_backward_error
reconstructed_full_descriptor_backward_error
reconstruction_vs_slepc_ratio
```

Certyfikat ma korzystać wyłącznie z drugiej. Użyć blockwise backward error po
jawnej nondimensionalizacji:

```text
eps_q = ||r_q|| / (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + eps)
eps_phi = ||r_phi|| / (||A_phiq q|| + ||P phi|| + ||c eta|| + eps)
eps_gauge = |cT phi| / (||c|| ||phi|| + eps)
```

Warunek pełny to maksymalna z trzech liczb, nie suma o niezgodnych jednostkach.
Candidate conjugate można badać tylko jako parę `(conj(lambda), conj(x))` i
tylko po jawnym przypisaniu dodatniej gałęzi.

### F-05. Przykład K0-3 nie ma geometrii idealnego cienkiego filmu

**Waga: BLOCKER dla walidacji Kittela. Dotyczy: `examples/fem_eigen_k0_kittel_periodic_airbox.py`.**

Przykład ma ciało `40 x 20 x 10 nm`, przypisuje tylko `study.pbc(x=True)` i
`PeriodicBC(["x_faces"])`
([example:24](/home/kkingstoun/git/fullmag/fullmag/examples/fem_eigen_k0_kittel_periodic_airbox.py:24),
[example:78](/home/kkingstoun/git/fullmag/fullmag/examples/fem_eigen_k0_kittel_periodic_airbox.py:78),
[example:125](/home/kkingstoun/git/fullmag/fullmag/examples/fem_eigen_k0_kittel_periodic_airbox.py:125)).

Kanon K0-3 wymaga PBC w `x,y` i otwartego airboxa w `z`
([Kittel plan:295](/home/kkingstoun/git/fullmag/fullmag/docs/plans/active/fd_sovler_masterplan/15_self_weryfication_Kittel.md:295)).
Przy wolnym `y` obiekt jest skończonym paskiem, a nie idealną nieskończoną
warstwą. Boki w `y` wprowadzają `N_y != 0`; wzór `sqrt(H0(H0+Ms))` nie jest
już właściwym oraclem.

#### Wymagana korekta

Wariant ideal-film musi mieć:

```python
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.objects.mesh.defaults(periodic_pair_ids=["x_faces", "y_faces"], ...)
study.stages.add_eigenmodes(..., bc=fm.PeriodicBC(["x_faces", "y_faces"]))
```

oraz pełne pary dla magnetu i airboxa. Alternatywnie obecny fixture trzeba
przemianować na skończony pasek i porównywać z ogólnym wzorem z niezależnymi
demag factors, nie z `M_eff=Ms`.

### F-06. "Convergence" gate nie bada zbieżności

**Waga: HIGH. Dotyczy: deklarowanych tolerancji produkcyjnych.**

Obecny gate uruchamia dwa przypadki `hmax=24 nm` i `20 nm`
([plan 18, linie 2682-2707](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L2682)).
Skrypt wymaga jedynie dwóch różnych `mesh_resolution_m`, dodatniego `phi_dof_count`
i limitu błędu; nie wymaga poprawy po rafinacji, trzech poziomów, osobnego
wariowania airboxa, mode tracking ani rzędu zbieżności
([verify_fem_eigen_k0_periodic_airbox_convergence.py:46](/home/kkingstoun/git/fullmag/fullmag/scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py:46)).

Dodatkowo `hmax=20/24 nm` jest większy niż grubość filmu `10 nm` w przykładzie.
Przy jednej warstwie nie jest to kontrolowany test zbieżności przez grubość.

#### Wymagana korekta

Minimalna kwalifikacja K0-3:

1. Co najmniej trzy poziomy magnetycznej siatki, z jawną liczbą warstw przez
   grubość i `h_z` malejącym na każdym poziomie.
2. Co najmniej trzy niezależne wartości paddingu `z` lub dwie plus uzasadniona
   ekstrapolacja asymptotyczna; zmiana `h` nie może być jedyną zmianą.
3. Osobne tabele dla `Robin beta` i typu outer BC, z widocznym plateau.
4. Na każdym punkcie: częstotliwość, `eps_q`, `eps_phi`, `eps_gauge`, energia
   demag, `H_demag` na próbnikach, liczba elementów/DOF, overlap gałęzi.
5. Gate wymaga stabilnej tożsamości modu oraz monotonicznego trendu lub
   dopasowania rzędu zbieżności wyjaśniającego niemonotoniczność.

### F-07. Verifier obecnie tylko sprawdza obecność metryk jakości modu

**Waga: HIGH. Dotyczy: fałszywie zielonych artifactów.**

Weryfikator wymaga kolumn `mode_residual_relative`, `uniformity_score`,
`branch_overlap_previous`, tangent leakage i seam mismatch
([verify_fem_frequency_domain_eigen_artifacts.py:2650](/home/kkingstoun/git/fullmag/fullmag/scripts/verify_fem_frequency_domain_eigen_artifacts.py:2650)).
Następnie akceptuje residual dowolnie duży, uniformity od 0 do 1, overlap od 0
do 1 oraz dowolnie duże leakage/seam mismatch, bo sprawdza wyłącznie znak lub
zakres ([verify_fem_frequency_domain_eigen_artifacts.py:2717](/home/kkingstoun/git/fullmag/fullmag/scripts/verify_fem_frequency_domain_eigen_artifacts.py:2717)).

#### Wymagana korekta

K0-3 verifier musi wymuszać wartości deklarowane w metadanych testu, np.:

```text
eps_mode <= 10 * eigensolver_tolerance
uniformity_score >= 0.995
branch_overlap_previous >= 0.95  (poza pierwszym punktem)
max |m0 dot delta_m| <= tangent_tolerance
max periodic seam mismatch <= seam_tolerance
max equilibrium torque <= equilibrium_tolerance
```

Wartości liczbowe finalnie należy ustalić na podstawie realnej zbieżności, ale
nie mogą pozostawać nieegzekwowane.

### F-08. Handoff równowagi nie jest zamknięty dla sweepu Kittela

**Waga: HIGH. Dotyczy: każdy modal i driven run wokół zrelaksowanego stanu.**

Plan wymagający `EquilibriumArtifact` zawiera `m0`, `h_eff0`, `h_demag0`,
`phi0`, hashe oraz torque diagnostics
([relaxed texture:17](/home/kkingstoun/git/fullmag/fullmag/docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md:17)).
Przykład uruchamia jedynie 8 kroków relaksacji
([example:102](/home/kkingstoun/git/fullmag/fullmag/examples/fem_eigen_k0_kittel_periodic_airbox.py:102)),
podczas gdy verification akceptuje `stage_continuation` nawet gdy liczba kroków
nie dowodzi konwergencji
([verify_fem_frequency_domain_eigen_artifacts.py:2528](/home/kkingstoun/git/fullmag/fullmag/scripts/verify_fem_frequency_domain_eigen_artifacts.py:2528)).

Sweep zmienia `H0` w 15 punktach, ale artifact nie dowodzi, że dla każdego z
nich przeliczono/potwierdzono `h_eff0` i static demag. W obecnej geometrii z
wolnym `y` początkowy `m0=+x` może nie być równowagą.

#### Wymagana korekta

- Przyjmować per-field `LinearizationState` z accepted artifactu lub udowodnić
  analitycznie, że ta sama równowaga i `h_eff0` pozostają ważne.
- Zapisać w artifactach: torque, norm error, static demag seam/flux, hashe
  mesh/material/BC oraz identyfikator pola bias.
- Odrzucać eigen solve, gdy `m0 x h_eff0` przekracza deklarowany limit.
- Nie używać liczby kroków relaksacji jako substytutu residualu równowagi.

### F-09. Brak dyskretnego kontraktu reciprocity i energii dla bloków demag

**Waga: HIGH. Dotyczy: znak i skala `A_qphi/A_phiq`, Schur i Kittel.**

Plan wymaga głównie niezerowych bloków i testu sign-flip. To nie wystarcza.
W realnym FEM `C` i feedback do magnetu muszą powstać z tej samej słabej formy,
tych samych kwadratur, przestrzeni oraz konwencji masy. W k=0 wynikowy operator
demag ma mieć odpowiednią symetrię/Hermitowskość energii i dodatnią energię
demag, niezależnie od implementacyjnego znaku row/column.

#### Wymagana korekta

Wprowadzić trzy testy niezależne od Kittela:

```text
1. directional derivative:
   d/d epsilon E_demag[m0 + epsilon delta_m] at epsilon=0
   zgadza się z polem z operatora.

2. Hessian reciprocity:
   <p, K_demag q>_M == <q, K_demag p>_M w zdefiniowanym inner product.

3. energy sign:
   E_demag[delta_m] >= -tolerance i H_demag=-grad(phi) ma znak zgodny
   z niezależnym oraclem ellipsoidy/sfery.
```

### F-10. Singularny descriptor `B` nie ma pełnej polityki finite modes

**Waga: HIGH. Dotyczy: stabilność SLEPc i odrzucanie modów algebraicznych.**

`B_full` jest zerowe dla `phi` i gauge, co plan sam oznacza jako descriptorowy
układ z singularnym `B`
([plan 18, linie 381-409](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L381)).
Plan nie definiuje regularności pary `(A,B)`, filtrowania nieskończonych
wartości własnych, warunku `q^H B q`, deflacji constraint modes ani diagnostyki
algebraicznych modów.

#### Wymagana korekta

Domyślny produkcyjny solver powinien rozwiązywać Schur-reduced magnetic pencil,
a monolityczny descriptor zachować jako oracle. Jeśli monolith pozostaje:

- wykazać regularność pencil,
- jawnie odrzucać infinite/algebraic eigenvalues,
- wymagać dodatniej, skończonej normy w fizycznym inner product,
- certyfikować `phi` i constraint residual osobno,
- dokumentować metodę SLEPc zgodną z descriptorami.

### F-11. `M_eff` w planie K0-3 jest zbyt uproszczone i przecieka do solvera

**Waga: HIGH. Dotyczy: fizyczna interpretacja Kittela.**

Plan dopuszcza `M_eff=Ms*N_eff`
([plan 18, linie 1713-1733](18_poisson_airbox_eigensolve_cpu_gpu_implementation.md#L1713)).
Jeden skalar nie opisuje ogólnego obiektu: konieczne są dwa transverse
stiffnesses, a dla skończonego obiektu także `N0`. Wstrzykiwanie `M_eff` do
buildera jest dodatkowo circular testem opisanym w F-01.

#### Wymagana korekta

Artifact testu przechowuje `H1`, `H2`, `N0,N1,N2` albo precyzyjnie zdefiniowane
numeryczne stiffnesses i ich pochodzenie. Reference formula ma żyć w verifierze
i nie może być wejściem modalnego operatora.

### F-12. W nomenklaturze i dokumentacji są sprzeczne statusy modalności

**Waga: HIGH dla governance, MEDIUM dla samego wyniku.**

README nazywa cały katalog kanonicznym i mówi, że pełny pack jest częścią
pakietu ([README:15](/home/kkingstoun/git/fullmag/fullmag/docs/plans/active/fd_sovler_masterplan/00_README_CANONICAL_FULL_READ.md:15)).
`fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md` kończy się jednak na pliku 14,
nie zawiera 15-18 i wskazuje nieistniejącą/starszą ścieżkę
`docs/frequency_domain_solver_v5`. Manifest wymienia 15-18 jako kanoniczne
([documentation_manifest.json:114](/home/kkingstoun/git/fullmag/fullmag/docs/plans/active/fd_sovler_masterplan/documentation_manifest.json:114)).

Capability matrix nadal mówi `semantic_only` dla modal interior-window i
expressis verbis zostawia "true periodic_airbox_k0 eigenfrequency/modal solving"
gated ([capability matrix:109](/home/kkingstoun/git/fullmag/fullmag/docs/specs/capability-matrix-v0.md:109)).
To jest zgodne z kodem z F-01, ale nie z etykietą `production_cpu` w planie 18.

#### Wymagana korekta

Rozdzielić:

```text
normative physics contract
implementation evidence
runtime capability
validated production status
historical progress log
```

Wygenerować full pack ponownie z 00-19 albo przestać wskazywać go jako
kanoniczny. Jedna maszynowo generowana status matrix ma być źródłem prawdy dla
planu, capability matrix i artifact labels.

## 5. Ustalenia high/medium: frequency-driven

### F-13. Znak absorbed power pozostaje otwarty

**Waga: HIGH dla wyników FMR/susceptibility.**

Nota fizyczna pozostawia symbol `sgn` w formule mocy
([0700:399](/home/kkingstoun/git/fullmag/fullmag/docs/physics/0700-frequency-domain-linearized-llg.md:399)).
To nie jest detal prezentacyjny. Przy `exp(+i omega t)`, energii oddziaływania
`-mu0 M dot H_drive` i definicji mocy dostarczonej do układu:

```text
p_abs = - mu0 <M dot dH_drive/dt>
      = - 0.5 mu0 Ms omega Im[conj(h_drive) dot delta_m].
```

Ta konwencja daje dodatnią absorpcję dla pozytywnego Gilberta wtedy, gdy
odpowiedź ma właściwy lag fazowy w konwencji `+i omega t`. Jeżeli produkt
definiuje moc źródła zamiast mocy pochłoniętej przez magnetyzację, znak jest
odwrotny, ale nazwa observable i test muszą to rozróżnić.

#### Wymagana korekta

Zastąpić `sgn` jawną konwencją `absorbed_by_magnetization` oraz dodać analityczny
damped-macrospin test dla kilku `alpha>0`: peak near resonance, dodatnie
`P_abs`, odpowiedni znak imaginalnej susceptibility i poprawna linewidth.

### F-14. Brakuje jednego słownika znaków modal/driven/real-split

**Waga: HIGH.**

W dokumentach występują równolegle:

```text
A q = lambda B q, lambda=i omega
(i omega B - A)q=b
A(omega)=K-i omega M
K phi=-i omega G phi.
```

Każdy z nich może być poprawny, ale wyłącznie po zdefiniowaniu symboli i
przeniesieniu członów. Obecne dokumenty nie zawierają jednej tabeli mapującej
wszystkie implementacyjne macierze i RHS na liniowe LLG.

#### Wymagana korekta

Wprowadzić jedną stronę "operator sign dictionary" z 2x2 macrospin example:

| Obiekt | Definicja | Jednostka | Modal | Driven |
|---|---|---|---|---|
| `L` | projected restoring torque | 1/s lub po przeskalowaniu | `Lq=lambda Bq` | `(... )q=b` |
| `B` | gyrotropic/mass form | jawnie | `lambda=i omega` | `i omega B-L` |
| `b` | `T^T[-gamma0 m0 x delta_h]` | zgodnie z `L` | nie dotyczy | fizyczny drive |

Tabela ma być testowana na tym samym macrospinie przez modal i driven peak.

### F-15. Static i dynamic demag nie są wymuszone jako spójny operator

**Waga: HIGH.**

Static demag jest częścią `h_eff0` i występuje w `-gamma0 delta_m x h_eff0`.
Dynamic demag jest pochodną funkcjonału i dostarcza `delta_h_demag[delta_m]`.
Plan handoffu słusznie rozdziela te role
([relaxed texture:103](/home/kkingstoun/git/fullmag/fullmag/docs/plans/active/fd_sovler_masterplan/03_relaxed_texture_linearization.md:103)),
ale PA-E4 builder faktycznie używa jedynie `H0` i wstrzykniętego `M_eff`.

#### Wymagana korekta

Realny runtime ma certyfikować wspólny klucz dla `m0`, `h_eff0`, `h_demag0`,
`phi0`, mesh/material/BC i wersji operatora. Zmiana dowolnego z nich unieważnia
Schur certificate i eigen artifact.

### F-16. Non-k0 dynamic demag musi pozostać twardo zablokowany

**Waga: HIGH, jeśli użytkownik otrzymałby wynik zamiast rejection.**

Nota Floquet poprawnie wymaga wspólnego phase dla `delta_m` i `delta_phi` oraz
`grad_k/div_k` ([0828:45](/home/kkingstoun/git/fullmag/fullmag/docs/physics/0828-fem-frequency-domain-floquet-demag.md:45)).
Current no-demag phase-projection jest użytecznym smoke testem, ale nie jest
takim operatorem. Każda próba użycia `periodic_airbox_k0` dla `k!=0` daje
fizycznie niepoprawny dipolar tensor.

#### Wymagana korekta

W plannerze: `k!=0 && include_demag -> magnetostatic_bc=floquet_airbox`, a
przy braku realnego operatora jawny failure. Bez fallbacku do CPU k=0,
isolated airbox, dense validation ani projekcji post hoc.

### F-17. Driven residual i preconditioner wymagają block scaling

**Waga: MEDIUM/HIGH dla dużych periodic-airbox.**

Prawdziwy residual driven solve ma być liczony na niepreconditionowanym
operatorze z tym samym block scaling jak modal. Tracked residual GMRES lub
residual preconditionowany nie jest certyfikatem. Stagnation guard jest dobry
jako safety stop, ale musi używać okresowo rekalkulowanego true residual.

Wymagane artifact fields:

```text
tracked_krylov_relative_residual
true_unpreconditioned_block_residual
q_block_residual
phi_block_residual
preconditioner_apply_quality
stagnation_window_true_residuals
```

### F-18. Skalarowa polityka gauge weights jest zbyt sztywna

**Waga: MEDIUM.**

W planie wymagane są zawsze ściśle dodatnie, unormowane weights. Dla realnego
ograniczonego FE space po eliminacji Dirichleta niektóre bazowe DOF mogą nie
uczestniczyć. Ważniejsza od "strictly positive everywhere" jest zgodność
functional `c` z rzeczywistym space i BC. W Robin/Dirichlet `c` w ogóle nie
powinno istnieć.

### F-19. Periodic tangent transport wymaga testu gauge-invariance na teksturze

**Waga: MEDIUM/HIGH dla domain-wall, vortex, skyrmion.**

W planie jest właściwy transfer ramki na parach. Brakuje jednak testu, że
lokalny obrót każdej bazy `(u_i,v_i)` przez dowolny kąt nie zmienia wartości
własnych i odtworzonego pola fizycznego. Należy dodać:

```text
gauge rotation of tangent frames -> invariant spectrum and Cartesian mode
nonuniform texture derivative/projection test
periodic seam transfer test with non-identical frames
```

## 6. Ustalenia GPU

### F-20. GPU G5a nie jest skalowalnym eigensolverem

**Waga: MEDIUM dla roadmapy, BLOCKER dla claimu production GPU.**

Kernel dense eigensolver działa jednym blokiem i jednym wątkiem
([driven_response_gpu.cu:375](/home/kkingstoun/git/fullmag/fullmag/backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu:375)).
Wykonuje stałą liczbę inverse iterations bez kryterium stopu w pętli
([driven_response_gpu.cu:421](/home/kkingstoun/git/fullmag/fullmag/backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu:421)),
po czym oblicza standardowy prawy Rayleigh quotient
([driven_response_gpu.cu:502](/home/kkingstoun/git/fullmag/fullmag/backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu:502)).

Dla niehermitowskiego, singularnego descriptor pencil to nie jest produkcyjna
metoda selekcji własnej. Nie ma orthogonalizacji, Ritz extraction, testu
zbieżności, left eigenvectors, deflacji ani obsługi wielu modów.

### F-21. GPU descriptor apply nie jest persistent device context

**Waga: MEDIUM.**

W `fullmag_fem_frequency_domain_apply_modal_poisson_airbox_gpu_descriptor`
każde wywołanie alokuje i kopiuje wszystkie CSR bloki na urządzenie
([driven_response_gpu.cu:1530](/home/kkingstoun/git/fullmag/fullmag/backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu:1530)),
potem zwraca wynik na host i zwalnia wszystkie bufory
([driven_response_gpu.cu:1589](/home/kkingstoun/git/fullmag/fullmag/backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu:1589)).

Pole diagnostyczne `gpu_device_resident_operator_apply=true` jest prawdziwe
wyłącznie dla pojedynczej akcji kernela. Nie dowodzi rezydencji w pętli
Kryłowa. Gdyby apply zostało wywołane w Arnoldim/FGMRES, transfery i alokacje
byłyby w krytycznej pętli.

### F-22. GPU callback/proof miesza poziomy gotowości

**Waga: MEDIUM.**

`G5b` i `G5c` są użytecznymi testami `A*x` oraz `(A-sigma B)*x`. G5a
eksponuje natomiast `gpu_device_resident_modal_eigensolver=true`
([driven_response_gpu.cu:2253](/home/kkingstoun/git/fullmag/fullmag/backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu:2253)),
mimo że implementacja jest małym dense, jedno-wątkowym proofem. Ta etykieta
powinna być `gpu_dense_contract_eigensolver`, a nie sygnałem modalnego runtime.

### Wymagana ścieżka GPU

1. Przenieść modalne pliki poza `driven_response_gpu.cu` do własnego ownera.
2. Utworzyć persistent modal context: CSR, vectors, basis, preconditioner i
   scalar reductions pozostają na GPU przez cały solve.
3. Użyć skalowalnego solvera: Krylov-Schur/Arnoldi lub SLEPc-like backend
   GPU, z Ritz extraction, restartem, tolerancją i multi-mode support.
4. Zaimplementować shifted solve/preconditioner dla real-split albo complex
   descriptor, a nie ręczny dense Gaussian elimination w jednym wątku.
5. Zmierzyć transfer audit na dużym mesh: zero per-iteration H2D/D2H dla
   vectors i matrices, dozwolone tylko redukcje scalar/progress w kontrolowanym
   rytmie.
6. Wymagać CPU/GPU parity dla realnie złożonych bloków z mesh, nie dla F-01.

## 7. Poprawiona kolejność realizacji planu 18

### P0. Natychmiastowa korekta statusu i kontraktu

```text
1. Oznaczyć aktualne PA-E4b jako synthetic/topology-shaped payload.
2. Wyłączyć production claim i przejść przez capability matrix.
3. Rozdzielić BC policy i gauge policy.
4. Usunąć expected Kittel answer z buildera operatora.
5. Naprawić full residual certification.
6. Zdefiniować jedną real-PETSc strategię spectral transform.
```

### P1. Niezależny Poisson oracle przed eigensolve

```text
1. Manufactured solution na D z Robin i Dirichlet.
2. Test sfery/ellipsoidy: znak pola, energia, convergence.
3. PBC x/y + open z: seam phi after gauge offset, H normal flux, side charge.
4. Primitve-cell vs supercell z identycznym z-padding.
```

### P2. Realny full-coupled K0 FEM

```text
1. Accepted LinearizationState per H0.
2. MFEM assembly realnych K_phi, C, G, L/B.
3. Schur-reduced solver jako primary; monolithic descriptor jako oracle.
4. Blockwise residual reconstruction i finite-mode filtering.
5. K0-3 x/y PBC, open z, real mesh/airbox convergence.
```

### P3. Weryfikacja Kittela i modal/driven cross-check

```text
1. K0-1 Larmor, K0-2 anisotropy, K0-3 thin-film.
2. Driven damped macrospin: peak, linewidth, absorbed-power sign.
3. Modal frequency equals driven resonance as alpha -> 0, with documented
   finite damping/window tolerance.
4. K0 periodic equals Floquet(k=0).
```

### P4. Non-k0

```text
1. no-demag exchange-only Floquet, f(k)=f(-k), analytic H_ex(k).
2. local-frame gauge-invariance and seam transfer.
3. implement grad_k/div_k shared-domain dynamic demag.
4. only then Floquet-airbox DE/BV dispersion and nonzero-k Kittel-like gates.
```

### P5. GPU

```text
1. real assembled K0 mesh blocks CPU/GPU apply parity,
2. persistent GPU descriptor and shifted apply,
3. device-resident Krylov-Schur/Arnoldi,
4. multi-mode residual/branch parity,
5. performance evidence on a workload larger than dense-contract limits.
```

## 8. Obowiązkowa macierz walidacyjna przed produkcyjną promocją

| ID | Przypadek | Niezależny oracle | Co wykrywa | Minimalna akceptacja |
|---|---|---|---|---|
| V1 | Poisson manufactured Robin | znane `phi`, source i beta | weak form, BC, gradient | normy L2/H1 maleją z h |
| V2 | Poisson Dirichlet | znane `phi` | eliminacja BC, brak gauge | bez `eta`, poprawna zbieżność |
| V3 | pure Neumann | zgodny RHS | gauge/nullspace | mean-zero, kompatybilność RHS |
| V4 | sphere/ellipsoid | analityczne H demag | znak, skala, energia | poprawny znak i zbieżność |
| V5 | PBC x/y + open z | primitive/supercell | pary airbox, Robin exclusion | phi/H/energy agreement |
| V6 | K0-1 no demag | Larmor | gamma, 2pi, gyro sign | near algebraic precision |
| V7 | K0-2 anisotropy | `H0+Hk` | static field term | near algebraic precision |
| V8 | K0-3 ideal film | full Kittel | dynamic demag | mesh + z-padding convergence |
| V9 | SLEPc interior window | multi-mode synthetic pencil | shift selection | chosen eigenpair near requested imaginary shift |
| V10 | descriptor vs Schur | same assembled problem | elimination/signs | block residuals agree |
| V11 | driven macrospin | analytic damped susceptibility | drive sign/power/linewidth | `P_abs>0` under declared convention |
| V12 | Floquet no demag | exchange dispersion | phase/transport | reciprocal `f(k)=f(-k)` |
| V13 | Floquet dynamic demag | independent reference | `grad_k/div_k` | must remain rejected until implemented |
| V14 | GPU assembled blocks | CPU reference | GPU parity/residency | residual/frequency parity, transfer audit |

## 9. Required artifact/provenance fields

Każdy realny modal `periodic_airbox_k0` musi mieć co najmniej:

```json
{
  "physics_kind": "fem_dynamic_poisson_airbox_modal",
  "assembly_kind": "mfem_weak_form_shared_domain",
  "synthetic_payload": false,
  "domain": "magnetic_plus_airbox",
  "periodic_axes": ["x", "y"],
  "outer_boundary": {
    "kind": "robin",
    "open_markers": ["z_min", "z_max"],
    "beta_per_m": 0.0
  },
  "gauge": {
    "policy": "none",
    "reason": "robin_removes_constant_nullspace"
  },
  "spectral_transform": {
    "scalar_mode": "real_split",
    "sigma_real": 0.0,
    "sigma_imag_rad_per_s": 0.0,
    "target_policy": "imaginary_frequency"
  },
  "linearization_state": {
    "equilibrium_id": "sha256:...",
    "max_relative_torque_residual": 0.0,
    "static_demag_present": true
  },
  "residuals": {
    "eps_q": 0.0,
    "eps_phi": 0.0,
    "eps_gauge": 0.0,
    "slepc_reported_backward_error": 0.0
  }
}
```

Pole `production_periodic_airbox_claim` może mieć wartość `true` dopiero po
tym, gdy `synthetic_payload=false`, wszystkie V1-V10 są zielone dla realnego
assembly, a capability matrix jest zgodna z artifactem.

Dla aktualnego payloadu syntetycznego wymagany jest kontrakt:

```text
assembly_kind = synthetic_algebraic_oracle
production_periodic_airbox_claim = false
```

## 10. Ostateczna ocena planu 18

Plan 18 ma dobry kierunek architektoniczny: full coupled system jako definicja,
Schur jako optymalizacja, jawne PBC/Floquet, dokumentowanie GPU residency i
Kittel jako fizyczny gate. Najistotniejsze błędy nie dotyczą celu, lecz tego,
że implementacyjny evidence został przedwcześnie opisany językiem produkcyjnej
fizyki.

Po korekcie F-01 do F-07 plan może ponownie stać się produkcyjnym kontraktem.
Bez tej korekty dalsze optymalizacje SLEPc/GPU będą przyspieszać operator, który
nie został jeszcze zweryfikowany jako realny Poisson-airbox FEM.

## 11. Evidence index

| Obszar | Główne źródło |
|---|---|
| Canonical LLG, modal/driven, residual policy | `docs/physics/0700-frequency-domain-linearized-llg.md` |
| Dynamic Floquet demag i BC/gauge | `docs/physics/0828-fem-frequency-domain-floquet-demag.md` |
| Static PBC demag, open-z Robin | `docs/physics/0800-fem-static-pbc-demag.md` |
| Weak form Robin | `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md` |
| Equilibrium handoff | `03_relaxed_texture_linearization.md` |
| Kittel geometry/formula | `15_self_weryfication_Kittel.md` |
| Plan/claims | `18_poisson_airbox_eigensolve_cpu_gpu_implementation.md` |
| Synthetic PA-E4b builder | `crates/fullmag-runner/src/fem_eigen.rs` |
| CPU SLEPc and residual code | `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` |
| GPU modal contracts | `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu` |
| Artifact gates | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` and `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py` |
