# Porównanie implementacji SHE: Fullmag i BORIS

- Data porównania: 2026-08-02
- Zakres: `docs/physics/0970-spin-hall-drift-diffusion-transport.md`,
  `docs/specs/spin-transport-runtime-contract-v1.md`, capability matrix oraz
  lokalny snapshot `external_solvers/BORIS/Boris`
- Status: porównanie źródłowe; **brak twierdzenia o parity ilościowej**
- Tożsamość BORIS: katalog jest lokalnym, ignorowanym snapshotem w checkoutcie
  Fullmag; nie ma osobnego commita BORIS, dlatego wynik nie jest reprodukowalną
  kwalifikacją konkretnego wydania zewnętrznego programu.

## 1. Werdykt

BORIS jest obecnie lepszym **wykonywalnym wzorcem zakresu** dla bezpośredniego i
odwrotnego SHE oraz interfejsowego transferu spinu. Fullmag ma lepszy
**docelowy kontrakt fizyczny**: jawne `M1/M2/M3`, pełne rozszczepienie
`mu_s`, jedna konstytutywna macierz reciprocal, osobny bilans mocy i
proweniencja przez Python → `ProblemIR` → planner → runtime. Nie wolno jednak
zamieniać jakości kontraktu Fullmag w twierdzenie, że ta fizyka jest już
wykonana.

W aktualnej macierzy capability:

| Zakres | BORIS | Fullmag |
|---|---|---|
| charge + spin steady drift-diffusion | wykonywalne CPU/CUDA w module `STransport` | M1 FEM CPU ma wąski `reference_executable`; ogólny FDM/FEM GPU i M2 są `semantic_only` |
| direct SHE | wykonywalny przez `SHA` i spinowy warunek Neumanna | conforming H1/P1 FEM CPU ma zielony signed-profile gate; executable BORIS parity i cross-backend pozostają otwarte |
| inverse SHE | wykonywalny przez niezależny `iSHA` w równaniu dla `V` | w M2 zapisany jako reciprocal z tym samym blokiem; `semantic_only` |
| interfejs N/F/T | ciągły kontakt albo `GInterface`, `Gi`, `Gmix`, osobny torque | transparentny interfejs jest w M1 CPU; mixing/SML i surface functional pozostają fail-closed |
| solver | sekwencyjny SOR: najpierw `V`, potem `S` | M1 triangular; M2 block-GMRES/FGMRES z niezależnymi residualami |
| zmienna spinowa | źródłowe `S`, przeliczane na `V_s` | pełne rozszczepienie `mu_s` w woltach |
| wzajemność | `SHA` i `iSHA` mogą być ustawione niezależnie | iSHE ma wynikać z tej samej wersjonowanej macierzy konstytutywnej |

Najważniejszy wniosek fizyczny: dla prostego direct-SHE w jednorodnym filmie
oba modele mogą mieć ten sam limit, ale tylko po uzgodnieniu zmiennych,
prefaktorów, orientacji Levi-Civity, normalnych i warunków kontaktowych. Samo
podobieństwo profilu `S` albo momentu nie jest dowodem równoważności.

## 2. Co rzeczywiście robi BORIS

### 2.1. Kolejność solve i kryteria

`STransport::solve_spin_transport_sor` wykonuje dwa osobne relaksy:

1. `PrimeSpinSolver_Charge`, następnie iteracje SOR dla potencjału `V` i
   ustawienie kontaktów przez `set_cmbnd_spin_transport_V`;
2. aktualizację pola elektrycznego `CalculateElectricField`;
3. `PrimeSpinSolver_Spin`, następnie iteracje SOR dla akumulacji `S` i
   ustawienie kontaktów przez `set_cmbnd_spin_transport_S`.

Wartości domyślne pochodzą z `STransport`:

| Parametr | Wartość BORIS | Znaczenie |
|---|---:|---|
| `errorMaxLaplace` | `1e-6` | względny błąd relaksacji `V` |
| `maxLaplaceIterations` | `500` | limit iteracji `V` |
| `s_errorMax` | `1e-5` | względny błąd relaksacji `S` |
| `s_maxIterations` | `200` | limit iteracji `S` |
| `SOR_damping.i` | `1.4` | tłumienie solve `V` |
| `SOR_damping.j` | `0.5` | tłumienie solve `S` |

Są to kryteria zmiany iteracyjnej, a nie pełny dowód residualu PDE, bilansu
ładunku, bilansu spinu ani błędu momentu. Fullmag nie powinien kopiować tych
wartości do kontraktu; powinien publikować niezależnie przeskalowane residuale,
bilans elektrod, bilans fluxów i transferu momentu.

### 2.2. Direct SHE i inverse SHE

W BORIS direct SHE jest włączane przez niezerowe `SHA` w przewodzącym,
niemagnetycznym mesh-u. Warunek brzegowy dla równania `S` jest kodowany w
`Transport::NHNeumann_Sdiff` jako:

```text
grad_n S = epsilon(E) * SHA * elC * MUB_E / De.
```

Wewnętrzny człon źródłowy `PrimeSpinSolver_Spin` zawiera także
`SHA * elC * MUB_E / De * div(E)` dla niejednorodnego pola. To jest konkretna
implementacja direct SHE, nie tylko parametr torques.

Inverse SHE jest włączane niezależnie przez `iSHA`. W
`Transport::NHNeumann_Vdiff` i `TransportCUDA::CalculateElectricField` warunek
dla potencjału ma postać:

```text
grad_n V = iSHA * De / (MUB_E * elC) * curl_neu(S).
```

Komentarz w `MeshParamsCUDA.h` mówi wprost, że `iSHA` zwykle powinno być równe
`SHA`, ale może być ustawione na zero, aby wyłączyć inverse SHE. To daje
użyteczny tryb diagnostyczny, lecz przy `iSHA != SHA` nie jest pełnym testem
wzajemności Onsagera.

### 2.3. Interfejsy i torque

`STransport::set_cmbnd_spin_transport_V/S` wybiera między ciągłym kontaktem a
`GInterface` dla N/F/T. Ścieżka `GInterface` używa:

- `Afunc_V`/`Bfunc_V` dla wspólnego prądu ładunkowego;
- `Afunc_N_S`/`Bfunc_N_S` i `Afunc_F_S`/`Bfunc_F_S` dla dwóch stron spinowego
  kontaktu;
- `Gi` dla przewodności interfejsowej;
- `Gmix = (G_r,G_i)` w `CalculateDisplaySAInterfaceTorque` dla części
  absorbowanej przez ferromagnetyk.

BORIS rozróżnia torque objętościowy od interfacial torque i udostępnia osobne
obserwable spin current, charge current i spin torque. To jest istotna lekcja
produktowa, ale nie dowód, że jego konwencja `S` jest identyczna z Fullmagowym
`mu_s`.

### 2.4. CUDA

`TransportCUDA.cu` ma osobny kernel
`CalculateElectricField_Spin_withISHE_Kernel`, który używa tego samego
`iSHA`, `De`, `MUB_E` i `S.curl_neu`. Obecność kernelu nie zastępuje dowodu
CPU/CUDA parity: potrzebne są identyczne pola `V`, `S`, fluxy, residuale,
torque i test transferów dla tego samego mesh-u i tolerancji.

## 3. Różnica zmiennych i jednostek

BORIS przechowuje `V` oraz źródłową akumulację spinową `S`. W interfejsowym
przeliczeniu `TransportBase` używa jawnego adaptera:

```text
V_s = (De / elC) * (e / muB) * S.
```

Fullmag definiuje `mu_s` jako **pełne rozszczepienie spinowe** w woltach:

```text
V_+ = V + mu_s/2,
V_- = V - mu_s/2.
```

Zatem nie wolno utożsamiać `S` z `mu_s`, `mu_s/2` ani z bezwymiarową
polaryzacją. Adapter porównawczy musi najpierw ustalić, czy `V_s` w danym
materiale BORIS oznacza pełne rozszczepienie czy potencjał kanałowy, a następnie
sprawdzić to na analitycznym profilu 1D z identycznym `De`, `elC` i
`lambda_sf`.

W Fullmag tensor `Q_ia` jest charge-equivalent spin-current tensor z jawnym
indeksem kierunku przepływu `i` i polaryzacji `a`. BORIS udostępnia spin current
komponentowo (`GetSpinCurrent(component)`) i jego wewnętrzne `curl`/gradienty;
przed porównaniem trzeba zbudować tę samą kolejność komponentów i tę samą
orientację normalnej.

## 4. Różnica formalizmu fizycznego

Fullmag M1 definiuje one-way blok:

```text
J_c = sigma E,
Q_ia = sigma_s G_ia + P sigma E_i m_a
       + theta_SH sigma epsilon_ika E_k.
```

Fullmag M2 dodaje z tego samego bloku reciprocal iSHE oraz sprzężenie
spinowo-polaryzowane. Antysymetryczny blok SHE/iSHE nie może mieć niezależnie
dopasowanego znaku. Dodatnia część symetryczna musi spełniać warunek
pozytywności, a moc części Hall/SHE/iSHE ma być zerowa.

BORIS rozdziela parametry `SHA` i `iSHA` oraz implementuje direct i inverse w
sekwencyjnym, nieliniowo aktualizowanym solve. To jest użyteczna implementacja
fenomenologiczna, ale nie należy na podstawie samego kodu zakładać, że
`iSHA=SHA` zawsze jest wymuszone ani że jego macierz ma dokładnie tę samą
normalizację co Fullmag M2.

## 5. Co można przejąć, a czego nie kopiować

| Element BORIS | Decyzja Fullmag | Powód |
|---|---|---|
| rozdział solve `V`, `S`, kontaktów i torque | przejąć jako granicę modułów | poprawia obserwowalność i testowanie |
| osobne direct/iSHE BC | przejąć jako realizację M1/M2 | warunek fluxu musi być jawny |
| `SHA` i `iSHA` niezależne | tylko jako tryb diagnostyczny adaptera | publiczny M2 musi zamrażać wzajemność |
| SOR `1.4/0.5` | nie kopiować jako solver produkcyjny | zależność od mesh-u i brak niezależnego residualu; Fullmag M2 jest niesymetryczny |
| `S` i konwersja `V_s` | nie wystawiać w Python API | publiczny kontrakt Fullmag używa `mu_s` i pełnych jednostek |
| `Gi/Gmix` N/F/T | mapować do jawnego `SpinInterface` | trzeba rozdzielić flux podłużny, poprzeczny, reservoir i torque |
| supermesh/module ownership | nie kopiować 1:1 | Fullmag zachowuje ProblemIR, planner i backend-neutralne provenance |
| CUDA kernel | użyć jako zewnętrzny punkt implementacyjny | sama obecność kodu nie jest parity ani qualification |

## 6. Uczciwy benchmark BORIS–Fullmag

Benchmark powinien być osobnym workloadem, nie ręcznym dopasowaniem wykresu:

1. zamrozić snapshot BORIS i zapisać jego identyfikator/źródła;
2. użyć jednorodnej warstwy N oraz opcjonalnie F, bez AMR/PHE/AHE, z tą samą
   geometrią i komórką;
3. ustawić `iSHA = SHA` w BORIS dla testu reciprocal; osobny test
   `iSHA = 0` dokumentuje tylko one-way direct SHE;
4. uzgodnić `De`, `elC`, `l_sf`, `l_ex`, `l_ph`, `P`, znak osi i normalne;
5. przeliczyć BORIS `S` przez jego `V_s` i dopiero wtedy porównać z Fullmag
   `mu_s`;
6. porównać nie tylko średnią torque, ale `V`, spin accumulation, `Q_ia`,
   normal flux, charge balance, spin balance, interface torque i residual;
7. wykonać trzy rozdzielczości oraz osobny sweep tolerancji i iteracji;
8. powtórzyć test na BORIS CPU i CUDA oraz Fullmag FDM CPU, FEM CPU i — po
   kwalifikacji — GPU;
9. zapisać tabelę znaków i jednostek w artefakcie provenance; żadnego
   odwracania znaku po obejrzeniu wykresu.

Minimalne kryterium przejścia dla pierwszego 1D direct-SHE to zgodność profilu
`mu_s`/`V_s` i fluxu w tolerancji wynikającej z obu residuali oraz zbieżność
obserwowanego błędu przy zagęszczaniu. Dopiero potem można porównywać torque
interfejsowy i inverse SHE.

## 7. Stan implementacji i blokady

- BORIS: **source-visible implementation reference**, bez uruchomionego
  `BorisLin`, twierdzenia o wersji release ani o kwalifikacji w tym checkoutcie.
- Fullmag M1 FEM CPU: **wąski reference executable** dla conforming H1/P1,
  transparent interface; signed analytic SHE jest zielony dla tego slice,
  natomiast cross-backend convergence i executable BORIS parity są nadal
  otwarte.
- Fullmag M2 reciprocal direct/inverse SHE: **semantic_only**; nie ma podstaw
  do deklarowania zgodności z BORIS.
- Fullmag FDM/GPU SHE: **semantic_only**; obecne kody SOT nie są solverem SHE.
- Interfejs mixing/SML: kontrakt i częściowe artefakty istnieją, ale produkcyjny
  surface functional i cross-backend gate są zamknięte fail-closed.

Nie zmieniono capability matrix na podstawie samego porównania. Źródłowa
obecność funkcji w BORIS nie jest dowodem implementacji Fullmag ani powodem do
awansu capability.

## 7.1. Wykonany zredukowany gate 1D (2026-08-02)

Ponieważ snapshot nie zawiera binarium `BorisLin`, a lokalne środowisko nie ma
`nvcc`, wykonano jawnie oznaczony **source-derived reduced oracle**, a nie
parity executable. Implementacja znajduje się w
`scripts/verify_boris_fullmag_she_1d.py`; testy w
`scripts/test_verify_boris_fullmag_she_1d.py`.

Workload to jednorodny film N, `E=E_x e_x`, przepływ spinu w osi `z`,
`iSHA=0`, zero normalnego spin fluxu i relaksacja `lambda_sf`. Z kodu BORIS:

```text
d_n S_y = SHA * sigma * MUB_E * E_x / De
V_s = De * S / (sigma * MUB_E)
d_n V_s = SHA * E_x
```

Po stronie Fullmag użyto `sigma_s=sigma`, `theta_SH=SHA` oraz jawnego
przeliczenia `mu_s=2 V_s` (Fullmag przechowuje pełne rozszczepienie kanałów):

```text
Q_zy = -sigma_s * d_z(mu_s)/2 + theta_SH * sigma * E_x
d_n Q_zy = 0
```

Dla `L=8 nm`, `lambda_sf=1.5 nm`, `E_x=2e5 V/m`, `sigma=6.7e6 S/m` i
`SHA=theta_SH=0.19` wynik skryptu jest:

| Obserwabla | Wynik |
|---|---:|
| `V_s` BORIS: top − bottom | `1.1290451634172762e-4 V` |
| `mu_s` Fullmag: top − bottom | `2.2580903268345525e-4 V` |
| maks. względny błąd profilu po mapowaniu `mu_s=2V_s` | `0.0` |
| maks. błąd znormalizowanego fluxu | `0.0` |

`4 passed` obejmuje również negatywny test `theta_SH != SHA` oraz walidację
geometrii. Skrypt zapisuje SHA-256 siedmiu kluczowych plików snapshotu (w tym
`STransport_Spin.cpp`, `Transport_Spin.cpp`, CUDA kernel i `makefile`), dzięki
czemu wynik można powiązać z konkretnym stanem ignorowanego katalogu.

To zamyka tylko **reduced direct-SHE normalization gate**. Nie jest to jeszcze
`SHE-BORIS-001`: nie ma wykonania BORIS CPU/CUDA, testu `iSHA=SHA`, profilu z
niejednorodnym materiałem, interfejsu N/F/T ani porównania FDM/FEM.

## 7.2. Wykonany managed FEM gate direct-SHE i korekta kolejności MFEM (2026-08-02)

Poza redukowanym oraclem BORIS uruchomiono rzeczywisty, natywny gate Fullmag
M1 FEM CPU dla signed direct-SHE. Test
`backends/fem/tests/steady_transport_contract.cpp` używa jednorodnego filmu
H1/P1 na siatce `4 x 4 x 32` heksaedrów, z `E_x`, relaksacją spinową i
zerowym normalnym spin fluxem. Oracle jest dwuwymiarowy w przekroju: tensor
SHE ma równocześnie `Q_zy` i `Q_yz`, dlatego oczekiwane są dwa profile
`sinh/cosh`:

```text
mu_y(z) = 2 theta_SH sigma E_x lambda_sf
          / (sigma_s cosh(L_z/(2 lambda_sf)))
          * sinh((z-L_z/2)/lambda_sf)

mu_z(y) = -2 theta_SH sigma E_x lambda_sf
          / (sigma_s cosh(L_y/(2 lambda_sf)))
          * sinh((y-L_y/2)/lambda_sf)
```

Gate wymaga średniego prądu ładunkowego `J_x = sigma E_x`, zbieżności solve,
błędu wszystkich węzłów poniżej `2e-3` oraz zgodności różnicy góra–dół
`mu_y` z tym samym limitem. Przejście obu komponentów jest istotne: test
wykrywa jednocześnie znak, normalną, skalę i permutację komponentów, a nie
tylko mały residual liniowy.

W trakcie tego testu znaleziono i naprawiono błąd numeryczny w realizacji
MFEM. Pola wektorowe, tensorowe i magnetyzacja były deklarowane jako
`mfem::Ordering::byVDIM` (układ interleaved), podczas gdy assembler, kopiowanie
ABI i publikacja pól indeksowały je jako bloki `[component][node]`. Zmieniono
te przestrzenie na `mfem::Ordering::byNODES`, czyli układ zgodny z kontraktem
ABI. Nie poluzowano tolerancji ani nie skorygowano znaku po wyniku; zmiana
usuwała rzeczywistą zamianę składowych w operatorze.

Świeży managed gate:

```text
just verify-fem-steady-transport-native-contract
```

zakończył się kodem `0`. W ramach sekwencji przeszły kontrakty C++ i ABI,
canonical quantity metadata, planner, preflight runnera, publikacja skalarnego,
wektorowego i tensorowego transportu oraz odczyt v2 data-plane. Naprawione
zostały także wyłącznie testowe fixtures: pełne fasety tetraedru i aktualny
`MeshIR`; nie zmieniają one fizyki runtime.

Ten wynik podnosi status signed direct-SHE tylko dla **conforming FEM CPU
reference slice**. Nie zamyka `SHE-BORIS-001`, ponieważ nadal brakuje
wykonywalnego BORIS CPU/CUDA, testu reciprocal `iSHA=SHA`, heterogenicznych
materiałów, N/F/T mixing/SML oraz wspólnego FDM/FEM/GPU benchmarku. Capability
nie jest awansowana poza jawnie ograniczony zakres.

## 7.3. FDM CPU workflow gate i synchronizacja capability matrix (2026-08-02)

Silnik FDM miał już niezależny test operatora direct-SHE, ale brakowało testu
pełnego `FdmSpinTransportWorkflow`. Dodano taki test w
`crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` dla filmu `3 x 1 x 48`,
`L_x=3 m`, `L_z=4 m`, `sigma=5 S/m`, `sigma_s=4 S/m`, `theta_SH=0.2` i
`lambda_sf=1.1 m`. Test przechodzi przez descriptor, charge solve, rekonstrukcję
`J_c`, spin solve, tensor `Q_ia` i telemetrykę; sprawdza profil `sinh/cosh`,
`J_x`, zerowe pozostałe składowe, residual oraz wersje konstytutywne/operatora.

Wynik:

```text
17 FDM spin-transport runner tests: PASS
analytical_direct_she_film_materializes_signed_profile_and_flux: PASS
```

Na tej podstawie ujednolicono machine-readable JSON i Markdown capability
matrix: `transport.spin.steady_drift_diffusion.fullmag.v1` oraz
`transport.spin.direct_she.fullmag.v1` mają `reference_executable` tylko na
FDM CPU reference i conforming FEM CPU reference lanes. FDM/FEM GPU, reciprocal
iSHE, mixing/SML i ogólne cross-backend workloady pozostają `semantic_only`.
Nie dodano `validated_workloads`: obecne testy są referencyjnymi contract gates,
nie pełną kwalifikacją produkcyjną.

To usuwa rozbieżność między plannerem/runtime (który już emitował
`reference_executable` dla ograniczonego FEM descriptoru) a publiczną macierzą.
Nie zmienia wyniku porównania z BORIS: pełne executable parity nadal wymaga
zamrożonego binarium BORIS, CPU/CUDA, `iSHA=SHA`, inverse SHE i interfejsów.

## 8. Źródła i mapowanie symboli

| Twierdzenie | Źródło |
|---|---|
| kolejność `V → S`, limity i damping | `external_solvers/BORIS/Boris/STransport_Spin.cpp::STransport::solve_spin_transport_sor`; `external_solvers/BORIS/Boris/STransport.h::STransport` |
| direct SHE RHS i spin BC | `external_solvers/BORIS/Boris/Transport_Spin.cpp::Transport::PrimeSpinSolver_Spin`, `Transport::NHNeumann_Sdiff`, `Transport::Evaluate_SpinSolver_delsqS_RHS` |
| inverse SHE RHS i charge BC | `external_solvers/BORIS/Boris/Transport_Spin.cpp::Transport::Evaluate_SpinSolver_delsqV_RHS`, `Transport::NHNeumann_Vdiff` |
| CUDA inverse SHE | `external_solvers/BORIS/Boris/TransportCUDA.cu::CalculateElectricField_Spin_withISHE_Kernel` |
| `S → V_s` adapter | `external_solvers/BORIS/Boris/TransportBase.h::TransportBase::cfunc_sec` and `cfunc_pri` contract |
| N/F/T contacts | `external_solvers/BORIS/Boris/STransport_Spin.cpp::STransport::set_cmbnd_spin_transport_V`, `set_cmbnd_spin_transport_S` |
| `Gi` and `Gmix` | `external_solvers/BORIS/Boris/STransport_Spin_GInterf.cpp::STransport::Afunc_V`, `Afunc_N_S`, `Afunc_F_S`, `Bfunc_N_S`, `Bfunc_F_S`; `Transport_Spin_Display.cpp::Transport::CalculateDisplaySAInterfaceTorque` |
| Fullmag variable convention | `docs/physics/0970-spin-hall-drift-diffusion-transport.md` sections 2.1–2.5 |
| Fullmag M1/M2 solver and capability boundary | `docs/specs/spin-transport-runtime-contract-v1.md` and `docs/specs/capability-matrix-v0.json` entries `transport.spin.*.fullmag.v1` |

## 9. Literatura użyta do interpretacji

Porównanie kodu nie zastępuje literatury konstytutywnej. Punktem odniesienia
są: Valet–Fert, *Phys. Rev. B* 48, 7099 (1993), DOI
`10.1103/PhysRevB.48.7099`; Zhang–Levy–Fert, *Phys. Rev. Lett.* 88, 236601
(2002), DOI `10.1103/PhysRevLett.88.236601`; Hirsch, *Phys. Rev. Lett.* 83,
1834 (1999), DOI `10.1103/PhysRevLett.83.1834`; Chen et al., *Phys. Rev. B*
87, 144411 (2013), DOI `10.1103/PhysRevB.87.144411`; oraz Lepadatu, *Boris
computational spintronics—High performance multi-mesh magnetic and spin
transport modeling software*, *J. Appl. Phys.* 128, 243902 (2020). Pełne wpisy
bibliograficzne i zakres zastosowania znajdują się w sekcji References noty
Fullmag `0970`.
