# Porównanie implementacji SHE: Fullmag i BORIS

- Data porównania: 2026-08-02
- Zakres: `docs/physics/0970-spin-hall-drift-diffusion-transport.md`,
  `docs/specs/spin-transport-runtime-contract-v1.md`, capability matrix oraz
  lokalny snapshot `external_solvers/BORIS/Boris`
- Status: porównanie źródłowe + ograniczony executable smoke; **brak twierdzenia
  o parity ilościowej**
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

- BORIS: **source-visible implementation reference** plus ograniczony
  executable direct-SHE smoke z patched build copy; nadal bez uruchomionego
  binarium wydania BORIS, twierdzenia o wersji release ani kwalifikacji w tym
  checkoutcie.
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

Przed późniejszym buildem runtime snapshot nie zawierał binarium `BorisLin`,
dlatego wykonano jawnie oznaczony **source-derived reduced oracle**, niezależny
od executable smoke. Implementacja znajduje się w
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

## 7.4. Wykonany smoke executable BORIS direct-SHE (2026-08-02)

Po audycie źródłowym zbudowano lokalny `BorisLin` ze snapshotu
`external_solvers/BORIS`. Jest to dowód uruchomienia zewnętrznego kodu, ale nie
reprodukowalny binarny release BORIS: snapshot nie ma commita, a kompilacja
wymagała dwóch neutralnych adapterów zgodności CUDA w **kopii buildowej** poza
checkoutem Fullmag:

- `BorisCUDALib/Reduction.cuh`: jawny cast 64-bitowego `size_t` do
  `unsigned long long` dla jedynego dostępnego overloadu `atomicAdd`;
- `BorisCUDALib/atomics.cuh`: istniejący adapter `unsigned long` aktywowany do
  `__CUDA_ARCH__ <= 900`, aby objąć Ada `sm_89`.

Oryginalny snapshot pozostał niezmieniony. Tożsamość źródeł i artefaktu:

```text
source_manifest_sha256=8daa0a9b2ef414b95090f838ab72414fb6808909ea9bde50c4aabd2a11a717a2
build_root=/zfn2/mateuszz/git/fullmag/boris-build/source
image=nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f
configure=make configure arch=89 sprec=0 python=3.10 cuda=11.8
compile=make compile -j8 && make install
binary_sha256=5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997
device=NVIDIA GeForce RTX 4080 SUPER, compute capability 8.9
```

Pierwsza próba na CUDA 12.4 i powtórzona próba na CUDA 11.8 zatrzymały się na
tym samym błędzie kompilacji `atomicAdd(size_t*, size_t)`; po adapterze build i
link zakończyły się powodzeniem. `./BorisLin -version` i `./BorisLin -help`
zwróciły kod 0, a runtime przyjął skrypt `-s` z `-g -1`.

W ograniczonym jednorodnym przewodniku (`10 x 2 x 2` komórek,
`J_c=(10^{11},0,0) A/m^2`, `elC=5.8e7 S/m`, `De=0.01`,
`lambda_sf=5 nm`, `SHA=0.10`) wykonano dwa skrypty NetSocks. Dla
`iSHA=0` (direct-only) BORIS zakończył skrypt i zwrócił:

```text
DIRECT_Jc  = [100000000000.0, 0.0, 0.0]
DIRECT_S   = [0.0, 0.0, 0.0]
DIRECT_Jsy = [0.0, 0.0, 289419.0]
DIRECT_Jsz = [0.0, -289419.0, 0.0]
```

Przy `SHA=0` i `iSHA=0` te same obserwable spin-current były dokładnie zerowe:

```text
SHA0_Jsy = [0.0, 0.0, 0.0]
SHA0_Jsz = [0.0, 0.0, 0.0]
```

Jest to minimalny dowód, że w zbudowanym BORIS parametr `SHA` zmienia
wykonywalny kanał direct-SHE; nie jest to jeszcze porównanie profilu z
Fullmag. `S`, `Jsy` i `Jsz` pozostawiono w natywnej konwencji quantity BORIS —
nie przypisano im jednostek Fullmag bez adaptera `S -> V_s -> mu_s`.
Skrypt `SHA=0.10, iSHA=0.10` zapisał dodatkowo `she_smoke_S.ovf` i
`she_smoke_Jsy.ovf`, ale ustawienie obu współczynników nie jest testem
Onsagera.

Podczas smoke'u wykryto również pułapkę API BORIS: `Gi` i `Gmix` są
parametrami `DBL2`, więc poprawne wyzerowanie wymaga `[0.0, 0.0]`; skalar
`0.0` prowadzi w tej wersji do pustej listy komponentów w
`MeshParamsBase::set_meshparam_value` i segfaultu. Nie jest to poprawka Fullmag
ani dowód błędu równań SHE.

`SHE-BORIS-001` pozostaje **otwarte**. Brakuje nadal: oryginalnego, niepatchowanego
binarium albo opublikowanego wydania BORIS; testu reciprocal `iSHA=SHA` z
niezerowym `S`; niezależnego inverse-SHE; BORIS CPU kontra CUDA; trzech
rozdzielczości i sweepu tolerancji; heterogenicznego N/F/T z `Gi/Gmix`; oraz
ilościowego porównania `V`, `S -> V_s`, `mu_s`, `Q_ia`, fluxów i bilansów z
FDM/FEM. Capability Fullmag i `validated_workloads` pozostają bez zmian.

## 7.2. Wykonywalny, zarządzany przypadek N/F (2026-08-03)

Zamknięto pierwszy stabilny krok harnessu N/F, ale wyłącznie jako artefakt
diagnostyczny. Implementacja znajduje się w
`scripts/boris_nf_interface_smoke.py`, `scripts/verify_boris_nf_interface.py`
i `scripts/run_boris_nf_interface.py`; receptura to
`just verify-boris-nf-interface`. Ciężkie dane pozostają na szybkim dysku
`/zfn2/mateuszz/git/fullmag`.

### 7.2.1. Korekty konieczne dla poprawnej fizyki przypadku

Pierwszy renderer używał `setcurrentdensity(n, ...)`. BORIS dokumentuje, że ta
komenda ustawia stałe `J_c` i **wyłącza iterację solvera transportu**. Taki
przebieg generował direct-SHE w N, ale zerowe pola F i nie był testem sprzężenia
N/F. Renderer został zmieniony na:

- `setdefaultelectrodes("x")` i `setcurrent(I)` z
  `I=J_target W_y(t_N+t_F)`;
- jawne `ferromagnet.ecellsize(cell)`, bo domyślna siatka elektryczna F jest
  inna niż siatka N;
- `SHA=iSHA=0.10` na N, natomiast F ustawia tylko `SHA` (BORIS F nie ma
  parametru `iSHA`);
- `Gi=[5e14,0]` i `Gmix=[1.5e15,0]` na F;
- próbki pobierane z zapisanych tekstowych OVF, a nie z `getvalue` na
  magnetycznej siatce F.

To rozróżnienie jest fizycznie istotne: obecność kodu `setcurrentdensity` nie
oznacza rozwiązania warunków kontaktowych ani transferu momentu przez `Gi/Gmix`.

### 7.2.2. Tożsamość i wynik

```text
artifact=/zfn2/mateuszz/git/fullmag/boris-build/reports/runner-coarse-3
schema=fullmag.boris_she_nf.v1
source_manifest_file_sha256=ed1ca167fae571b8106b79ed86347de4a6509647db87716c8f6f1559c890cde6
binary_sha256=5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997
image=nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f
python=3.10.12
device=cpu, BorisLin -g -1
resolution=4 x 2 x 2 cells in N and F
exit=143, accepted only with BORIS_NF_STAGE_COMPLETE and all OVFs
qualification=diagnostic
```

Artefakt zawiera `V`, `S`, `Jc`, `Jsx`, `Jsy`, `Jsz` dla obu meshów oraz `Ts` i
`Tsi` dla F. Przykładowy bilans płaszczyzny `+z` N→F (A/m² po stronie fluxu)
wynosi:

```text
Jc_N,z =  2.2184125e1       Jc_F,z =  9.2936051e1
J_s,N,z = (-5.96e-4, -2.88983e5, -2.50e-3)
J_s,F,z = ( 4.14985e1,  1.00e-3,  6.3953e-2)
J_s,N,z - J_s,F,z = (-4.14991e1, -2.88983e5, -6.6453e-2)
Tsi_plane * dz_F = (-2.54e-4, 1.75365e4, -2.50e-3)
```

Wartości `charge_closure=-70.75` i `spin_torque_closure=3.065e5` są zapisane
jako obserwable, nie jako pass/fail. `Tsi` BORIS ma jednostkę `A/(m s)` i jest
liczone przez ścieżkę interfacial effective-field (`tsi_eff`, `gamma`); proste
pomnożenie przez `dz` nie jest jeszcze uzgodnioną konwencją arealnego fluxu
Fullmag. Nie wolno zatem na tym etapie oznaczyć braku zamknięcia jako błędu
fizyki ani dopasować prefaktora po wykresie.

Reszty w artefakcie mają `interior_cell_count=0` dla siatki `4 x 2 x 2`
(BORIS eksportuje dwie komórki transportowe w osi z). Zapis `0.0` nie jest
dowodem zbieżności PDE; jest jawnie oznaczony jako ograniczenie diagnostyczne.

### 7.2.3. Granica bramy

Ten krok zamyka: deterministyczny renderer, parser OVF, mapowanie
`mu_s=2 De S/(elC MUB_E)`, kontrolę tożsamości managed runtime, artefakt
`fullmag.boris_she_nf.v1` oraz odtwarzalny N/F smoke z niezerowym polem w F.
Nie zamyka: porównania z wykonywalnym Fullmag FDM M2, trzech siatek i sweepu
tolerancji, CPU↔CUDA, N/T/F, zgodności `Tsi` z torque Fullmag ani
`SHE-BORIS-001`. Capability matrix i `validated_workloads` pozostają bez
zmian.

## 7.3. Adapter porównawczy Fullmag FDM M2 — korekta skalowania i ponowienie bramy (2026-08-03)

Dodano niezależny adapter `scripts/compare_boris_fullmag_she_nf.py` oraz
runner `scripts/run_fullmag_m2_nf_reference.py`. Builder przechodzi przez
publiczny Python DSL i ProblemIR, jawnie deklaruje dwie strefy N/F, ten sam
mesh `4×2×2 + 2`, `Gi/Gmix`, `SHA=iSHA`, `row_major_Q_ia` i wykonanie
`FDM/CPU/double/strict`. Korekta zgodności z rendererem BORIS obejmuje także
`P_F=0.4`, `SHA_F=0.10` i brak nieudokumentowanych reakcji bulk `lambda_J`/
`lambda_phi` po stronie F.

Porównywarka liczy osobno `V`, mapowane `mu_s`, `J_c`, dziewięć składowych
`Q_ia`, absorbowany spin flux i oba residuale. Nie porównuje torque, gdy
konwencje są różne: BORIS `Tsi` ma `A/(m s)` i pochodzi ze ścieżki
`tsi_eff/gamma`, Fullmag publikuje Gilbert source `1/s`; te observables są
oznaczane `incomparable`, a pozostałe metryki pozostają diagnostyczne.

Świeży launcher Fullmag zbudowano repozytoryjną recepturą `just` w trybie
`cuda-fem-gpu`; binarium `.fullmag/local/bin/fullmag` uruchomiono z explicit
output directory na `/zfn2/mateuszz/git/fullmag`. Próba
`fullmag-m2-nf-coarse-run19` nie opublikowała artefaktu, ponieważ runtime
odrzucił stan przed commit:

```text
Step 0: coupled charge-spin solve: M2 physical balance gate rejected
without committing state: charge=7.139977e-6, spin=5.450726e-8
```

Runner zachował `problem_ir.json`, `request.json` oraz pełne stdout/stderr i
zwrócił `not_run`; nie utworzono sztucznego pola Fullmag. Analiza kodu i test
RED/GREEN wykazały, że przyczyną był sztuczny `max(||P b||_2,1)` w skali
tolerancji GMRES. Dla cienkiej komórki `1e-7×1e-7×1e-9 m` floor zmieniał
tolerancję względną w zbyt luźny próg absolutny. Usunięto floor, pozostawiając
bez zmian physical-balance gate; rzeczywisty test N/F z `SHA=iSHA=0.1`,
`P_F=0.4`, `Gi/Gmix` przechodzi, a wszystkie 22 testy M2 CPU są zielone. To
nie jest jeszcze porównanie wyników ani dowód parity z BORIS. Pełne dane i
status bram znajdują się w `boris-nf-she-v1/README.md`.

Dodano także fail-closed orchestration `scripts/run_boris_fullmag_she_nf_matrix.py`
i recepturę `just verify-boris-fullmag-she-nf`. Kontrakt wymaga trzech siatek,
dwóch tolerancji, unikalnych identyfikatorów, skończonych metryk i monotonicznej
redukcji błędu; przy `not_run` macierz zapisuje dokładny `failure.json`, ale
walidator odmawia statusu `diagnostic_match`. Test kontraktu macierzy daje
`4 passed`; macierz wymaga ponowienia po przebudowie launchera z poprawką.

Do wykonania pozostają: przebudowa managed launchera z poprawką, wspólne trzy
siatki i sweep tolerancji, zgodność `Tsi` z torque, CPU↔CUDA oraz N/T/F.
`SHE-BORIS-001`, capability matrix i `validated_workloads` pozostają bez zmian
do czasu pozytywnego runtime matrix.

## 7.4. Świeży artefakt Fullmag i wynik macierzy (2026-08-03)

Po poprawce GMRES wykonano świeży coarse run na tym samym workloadzie. Tożsamość
launchera jest częścią artefaktu:

```text
commit=813332079e01838f976acee521326b643dce7aaa (dirty)
native_sha256=284c14c86212cc918c1ad1770d70049e1918b3271fb0d8545d08f865f65e627b
launcher_sha256=27d7c5ebb3bd1aa47391fc9bc6313d052a6e2b42f05e8cf5f183a84b12ea1843
artifact=/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-nf-coarse-run22/
transport/fullmag_m2_nf_reference.json
```

Run zaakceptował stan M2 i zapisał residuale przeskalowane przez preconditioner
`6.423463949700895e-15` (charge) i `3.691253818811614e-15` (spin) oraz fizyczne
bilansy `3.5205103056502695e-11` i `2.371483382809825e-12`. Ponieważ runtime
zwraca osiem komórek płaszczyzny N/F, adapter publikuje średnią obserwacji i
liczbę próbek, zamiast wybierać jedną komórkę.

Jednoprzypadkowe porównanie z artefaktem BORIS `runner-coarse-4` jest zapisane
w `/zfn2/mateuszz/git/fullmag/boris-build/reports/` i ma status
**`incomparable`**. Porównywarka usuwa tylko stały gauge potencjału
(`-3.4482757355128163e-4 V`) i dopuszcza globalne przesunięcie początku siatki
`(0,0,-2e-9) m`; nie remapuje tablic ani nie odwraca znaków. Po tym zabiegu
potencjał ma `max_relative_error=3.098487032667977e-4`, natomiast `mu_s`,
`Q_ia`, absorbowany flux i prąd poprzeczny nie spełniają kryterium match (błędy
rzędu jedności). Torque jest nadal oznaczony `incomparable` z powodu
`Tsi [A/(m s)]` BORIS kontra Gilbert source `[1/s]` Fullmag. Wynik jest więc
negatywnym, użytecznym testem zgodności kontraktów, a nie awansem któregokolwiek
solvera.

Pełna macierz `run24` znajduje się w:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-boris-she-nf-matrix-run24/matrix.json
```

Została wykonana w zarządzanym kontenerze `boris-nf-runtime`, ale walidator
odmówił `diagnostic_match`: wszystkie cztery tuple z siatkami `10×4×2+2` i
`20×8×4+4` kończą się `M2 block GMRES did not converge in 500 iterations`, a
dwie tuple `40×16×8+8` przekraczają 300 s. To nie jest porażka BORIS ani
dowód różnicy fizycznej; to niekompletna macierz po stronie Fullmag. Osobny
test średniej siatki z limitem 2000 iteracji został zaakceptowany, dlatego
następny krok musi ustalić uzasadniony limit/strategię preconditionera i
powtórzyć wszystkie sześć przypadków. Do tego czasu `SHE-BORIS-001`, parity,
torque normalization i `validated_workloads` pozostają otwarte.

Kontrolna próba drobnej siatki z limitem 2000 również zakończyła się
`M2 block GMRES did not converge in 2000 iterations` w
`/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-fine-max2000-run1`.
Zwiększenie limitu z 500 do 2000 nie jest więc wystarczającą naprawą; trzeba
zweryfikować strategię preconditionera/restartu albo jawnie ograniczyć
kwalifikowany zakres rozdzielczości.

## 7.5. Korekta kosztu operatora i adaptacyjnego restartu GMRES (2026-08-03)

*Adnotacja:* poniższy zapis jest historycznym snapshotem sprzed korekty osi
`z`; aktualny, zweryfikowany status znajduje się w sekcji 7.6.

Ponowna diagnoza wykazała dwa odrębne problemy po stronie Fullmag, których nie
wolno mieszać z różnicą fizyczną względem BORIS. `boundary_flux` przeliczał
pełne pole gradientów dla każdej granicznej ściany; na siatce N/F koszt jednej
aplikacji operatora rósł więc jak liczba ścian razy objętość. Operator otrzymuje
teraz gradienty obliczone raz na aplikację. Dodatkowo `gmres_restart` jest
traktowany jako początkowa długość bazy: gdy residuum po cyklu pozostaje powyżej
`100 * tol`, baza jest podwajana do pozostałego budżetu. Zmieniono też komunikat
awarii tak, aby publikował końcowe residuum i tolerancję.

Dowody regresji kodu:

```text
cargo test -p fullmag-engine --lib fdm::cpu::transport
70 passed

pytest scripts/test_run_fullmag_m2_nf_reference.py \
       scripts/test_compare_boris_fullmag_she_nf.py
14 passed
```

Po korekcie referencyjny limit liniowy M2 wynosi `2000` iteracji. Bieżący
Fullmag-only sweep (`fullmag.m2.fdm.reference_matrix.v1`) jest zapisany w
`/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-fullmag-matrix-20260803/fullmag_only_matrix.json`:
coarse i medium przechodzą dla `1e-8` oraz `1e-10`; fine
(`40x16x8+8`, 40960 niewiadomych) nadal kończy się fail-closed z residuum
GMRES około `5.02e-8` przy tolerancji rzędu `2.13e-12`–`2.13e-14`.
Zwiększenie budżetu do `4000` oraz ręczne `gmres_restart=800` nie daje w tym
środowisku akceptowalnego czasu zakończenia. Oznacza to, że brakuje jeszcze
preconditionera wielopoziomowego/line-relaxation dla drobnej siatki; nie wolno
promować fine do `validated` ani nazywać tego parity z BORIS.

Wynik jest jednak istotną korektą wcześniejszego run24: coarse/medium nie są
już blokowane przez sztuczne przeliczenie gradientów ani przez zbyt krótki
restart, lecz nadal nie ma wspólnej macierzy BORIS–Fullmag, ponieważ poprzedni
BORIS artefakt pozostaje snapshotem bez wersjonowanego binarium release. `SHE-
BORIS-001`, inverse parity, torque normalization, CPU↔CUDA, FEM/GPU i
`validated_workloads` pozostają otwarte.

## 7.6. Pełny operator 3D, line-relaxation i sześciopunktowa macierz (2026-08-03)

Kontrola regresyjna po dodaniu preconditionera wykazała, że pominięcie osi `z`
w `residual_flat` mogłoby dać pozornie zbieżny, lecz fizycznie niepełny solver.
Finalny operator utrzymuje wszystkie trzy osie, a blokowe line sweeps obejmują
każdą niebanalną oś, także linię przez kontakt N/F. Są to wyłącznie przybliżone
bloki tridiagonalne dla GMRES: operator fizyczny nadal zawiera SHE/iSHE,
reakcje, interfejs i warunki brzegowe; tangencjalne SHE i `G_i` są pomijane
tylko w preconditionerze.

Aktualny CPU/double Fullmag ma binarium SHA-256
`38a2db19d3bf49535f1555c17f06ea6e9641aa3aeeebf8adfc61b580bb42ead0`. Test
`cargo test -p fullmag-engine --lib fdm::cpu::transport` przechodzi w całości:
`73 passed; 0 failed`, w tym refined anisotropic N/F bar z pełnym wkładem osi
`z` i budżetem 200 iteracji. Niezależny sweep Fullmag-only (3 siatki × 2
tolerancje) przechodzi w:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/
fullmag-m2-current-zfix-fullmatrix-20260803/fullmag_only_matrix.json
```

Najdrobniejsza siatka `40×16×8+8` ma residuale charge/spin
`6.337917271934871e-13`/`1.3243111363198238e-12` dla `1e-8` oraz
`1.054259089651925e-14`/`2.652500450302329e-14` dla `1e-10`.

Wspólna macierz BORIS–Fullmag również wykonała wszystkie sześć przypadków w
`boris-nf-runtime`:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/
fullmag-boris-she-nf-matrix-zfix-20260803/matrix.json
```

Każdy wpis ma `status=incomparable`, nie `not_run`: walidator odrzuca parity,
bo `Tsi` BORIS jest w `A/(m s)`, a Fullmag torque w `[1/s]`. Adapter skaluje
BORIS `Js` i interfejsowe fluxy przez jawne `Q_ia=Js_ia/MUB_E`, zgodnie z
`Transport_Spin_Display.cpp` i `MUB_E` w `Funcs_Math_base.h`. Jest to korekta
jednostek, nie dowód zgodności prawa interfejsu. Po normalizacji błąd potencjału
spada od `1.431e-4` na coarse do `2.110e-5` na fine, ale `mu_s`, `Q_ia`,
absorbowany flux i prąd ładunkowy pozostają różne o rząd jedności. Wymagane są
jeszcze formalne mapowanie `G_i/Gmix`, torque oraz wspólna dyskretyzacja; nie
wolno nazywać tej macierzy `diagnostic_match` ani `validated`.

Provenance: BORIS binary `5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997`,
source snapshot `8daa0a9b2ef414b95090f838ab72414fb6808909ea9bde50c4aabd2a11a717a2`,
managed image `nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f`.
Jednorazowy kontener bez `libnvidia-ml.so.1` dawał `exit=127`; macierz końcową
wykonano w trwałym zarządzanym runtime, a błąd środowiskowy zachowano w logach.

## 7.7. Korekta niezależnego residualu BORIS (2026-08-03)

Ponowny przebieg średniej siatki N/F (`20×8×4 + 4`, `tol=1e-8`, `5000`
iteracji) zakończył się poprawnie w zarządzanym kontenerze, ale stary
walidator nadal zgłaszał `spin_scaled_l2=2.472593934595472e11`. Zwiększenie
limitu z `200` do `5000` nie zmieniło rzędu błędu, więc nie był to problem
samego limitu SOR.

Źródłem jest błąd jednostek w walidatorze, nie potwierdzona wada solvera:

1. BORIS publikuje `S [A/m]` i `Js [A/s]`; Fullmag porównuje
   `Q_ia=Js_ia/MUB_E [A/m²]`.
2. Stary kod dodawał `div(Js)` do reakcji zapisanej już w jednostkach `Q`;
   brakowało czynnika `MUB_E` (albo równoważnego podzielenia całego residualu
   przez `MUB_E`).
3. Dzielnik `max(|Js|,1)` miał jednostki prądu, podczas gdy residual jest
   dywergencją prądu. Brakowało skali długości `h`, przez co wynik nie był
   bezwymiarowym residualem PDE.
4. Ten sam normal-metalowy wzór był stosowany do F, mimo że BORIS dodaje tam
   `l_ex`, `l_ph` oraz opcjonalne źródła dryfu/pompowania/topologicznego Hall.

Kontrakt korekty został zapisany w `docs/physics/0970-spin-hall-drift-diffusion-transport.md`
§5.2.1 i wdrożony w `scripts/verify_boris_nf_interface.py`. Stare wartości
residuali z wcześniejszych `summary.json` są **nieważne jako dowód zbieżności**
i nie mogą służyć do promocji `SHE-BORIS-001`. Nadal pozostaje otwarte
ilościowe porównanie `mu_s`, `Q_ia`, interfejsu i torque; ta korekta usuwa
tylko fałszywy test jednostek/residualu.

## 7.8. Powtórzony managed run po korekcie residualu (2026-08-03)

Wykonano ponownie BORIS CPU/double w trwałym `boris-nf-runtime`, z tym samym
workloadem `N/F`, `SHA=iSHA=0.1`, `Gi=5e14 S/m²`, `Gmix=1.5e15 S/m²`,
`tol=1e-8` i `5000` iteracji:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/
runner-fine-5000-native/summary.json
```

Siatka `20×8×4 + 4` ma po `216` komórek wewnętrznych na materiał. Nowy,
jednostkowo spójny walidator daje:

| pole | normal | ferromagnet |
|---|---:|---:|
| `charge_scaled_l2` | `5.147004968391239e-13` | `3.978584955133736e-12` |
| `spin_scaled_l2` | `3.806146941508527e-3` | `9.615227124935865e-10` |

Normalny residual jest teraz skończony i ma skalę oczekiwaną dla niezależnej
centralnej różnicy na czterech warstwach `z`; nie ma już sztucznego czynnika
`1/MUB_E` ani mieszania jednostek. F residual używa jawnie
`l_sf=5 nm`, domyślnego BORIS `l_ex=2 nm`, ustawionego przez API `l_phi=4 nm`,
stałego `m=(1,0,0)` oraz wyłączenia źródeł topologicznych/pompowania. Nie jest
to jeszcze ogólny walidator F dla niejednorodnego `m`.

Porównanie z Fullmag fine (`fullmag-m2-current-fine-final-20260803`) zapisano w
`runner-fine-5000-native/comparison.json`. Status pozostaje
`incomparable` z powodu torque, a po korekcie nadal obserwujemy:

| observable | max. względny błąd |
|---|---:|
| `potential_v` | `5.393051572602266e-5` |
| `mu_s` | `1.8919613718899064` |
| `spin_current_qia` | `1.9999958674595317` |
| `interface_absorbed_spin_flux` | `1.000123101888642` |
| `charge_current` | `1.2906273307379117` |

To rozdziela dwa fakty: niezależny BORIS residual jest już liczony poprawnie,
ale nie ma jeszcze zgodności solverów. `SHE-BORIS-001`, mapowanie `G_i/Gmix`,
normalizacja torque, CPU↔CUDA, N/T/F oraz cross-backend qualification pozostają
otwarte.

## 8. Źródła i mapowanie symboli

| Twierdzenie | Źródło |
|---|---|
| kolejność `V → S`, limity i damping | `external_solvers/BORIS/Boris/STransport_Spin.cpp::STransport::solve_spin_transport_sor`; `external_solvers/BORIS/Boris/STransport.h::STransport` |
| direct SHE RHS i spin BC | `external_solvers/BORIS/Boris/Transport_Spin.cpp::Transport::PrimeSpinSolver_Spin`, `Transport::NHNeumann_Sdiff`, `Transport::Evaluate_SpinSolver_delsqS_RHS` |
| inverse SHE RHS i charge BC | `external_solvers/BORIS/Boris/Transport_Spin.cpp::Transport::Evaluate_SpinSolver_delsqV_RHS`, `Transport::NHNeumann_Vdiff` |
| CUDA inverse SHE | `external_solvers/BORIS/Boris/TransportCUDA.cu::CalculateElectricField_Spin_withISHE_Kernel` |
| `S → V_s` adapter | `external_solvers/BORIS/Boris/TransportBase.h::TransportBase::cfunc_sec` and `cfunc_pri` contract |
| native BORIS residual and `A/s` units | `scripts/verify_boris_nf_interface.py::compute_field_residuals`; `external_solvers/BORIS/Boris/Transport_Spin_Display.cpp::Transport::GetSpinCurrent`; `Simulation.cpp` descriptors |
| F exchange/dephasing residual | `external_solvers/BORIS/Boris/Transport_Spin.cpp::Transport::Evaluate_SpinSolver_delsqS_RHS`; Python parameter name `l_phi` in `external_solvers/BORIS/Boris/NetSocks.py` |
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
