# Plan wdrożenia i kompletna specyfikacja fizyczno-numeryczna STT, SOT, SHE i dynamicznego pola Oersteda

**Status:** zatwierdzony kierunek; audyt fizyczno-numeryczny 2026-07-28 wykonany; implementacja częściowa i niegotowa do integracji  \
**Wariant:** 3 — pełny model docelowy wdrażany przez niezależnie walidowane kamienie milowe M0–M3  \
**Pierwotne repozytorium bazowe:** `master@f6073e6f63ea781dcb36293be28387741a52f8da`  \
**Aktualny baseline audytu:** `master@0c95b9a2711226e32845f00259c4ce0a8abbdcd6`  \
**Dedykowany worktree:** `/tmp/fullmag-spin-transport`, `codex/spin-transport-m0-m3@ab2f686afe0aaa60d269966bd87388c0e59e14c6`  \
**Merge-base:** `0612941f3b99137cbb171c183452368cc0f71029`; gałąź ma `109` własnych commitów i jest `271` commitów za aktualnym `master`  \
**Data pierwotna:** 2026-07-15  \
**Ostatnia aktualizacja:** 2026-07-28  \
**Raport źródłowy:** [README.md](./README.md)

---

## 0. Audyt aktualizacyjny 2026-07-28

### 0.1. Wynik audytu

Podstawowa architektura fizyczna dokumentu pozostaje właściwa: LLG jest zapisane
w konwencji Gilberta, Zhang–Li jest operatorem adwekcyjnym, prescribed SOT jest
oddzielone od transportowego SHE, a dynamiczny Oersted konsumuje to samo pole
`J_c`, co transport i torque. Audyt wykrył jednak błędy oraz luki, które blokują
promocję którejkolwiek pełnej ścieżki M1–M3 do `validated`:

1. prefaktor kanonicznego Slonczewskiego jest zaniżony dwukrotnie przy przyjętej
   funkcji efektywności MuMax3;
2. prosty model `q_SML=G_SML Delta mu_s` nie definiuje poprawnego rezerwuaru
   utraty spinu i nie zapewnia deklarowanej nieujemnej produkcji;
3. transient `C_s` ma jednostkę, lecz nie ma jeszcze zamrożonej relacji z DOS i
   podatnością spinową dla wszystkich materiałów;
4. znak `theta_SH` jest wewnętrznie reciprocal, ale wymaga jawnej konwersji do
   konwencji Chen et al. 2013;
5. FEM Oersted wymaga zależnego łańcucha OE-T0 -> OE-F1 -> OE-F2; aktualny kod
   OE-T0 interpoluje `-sigma grad(V)` przez `ProjectCoefficient`, zamiast
   rozwiązywać wymagany ważony problem RT0/KKT;
6. baseline gauge OE-F2 musi używać `H_0(curl) x H1_0`; wariant z `H1/R` i
   zerową średnią jest odrębną realizacją z naturalnym warunkiem brzegowym;
7. M2 przy zamrożonym `m_stage` i liniowych prawach materiałowych jest liniowym,
   niesymetrycznym problemem blokowym, a nie automatycznie problemem Picarda lub
   Newtona;
8. `coupled_imex_ark2` wymaga pełnego tableau ARS(2,3,2), wspólnego rollbacku,
   przyjęcia wyniku dwóch półkroków oraz wyrównywania kroków do zdarzeń napędu.

Korekty normatywne są wprowadzone bezpośrednio w odpowiednich rozdziałach
poniżej. Obecne artefakty i testy, które kodują wcześniejszy prefaktor
Slonczewskiego albo niezdefiniowane `sml_surface_conductance.v1`, nie są
oraklami fizycznymi i muszą zostać unieważnione lub jawnie zmigrowane.

### 0.2. Stan repozytorium i integracji

| Element | Stan 2026-07-28 | Konsekwencja |
|---|---|---|
| `master` | `0c95b9a2711226e32845f00259c4ce0a8abbdcd6` | nowa podstawa integracji |
| dedykowana gałąź | `ab2f686afe0aaa60d269966bd87388c0e59e14c6` | checkpoint implementacji, nie wynik końcowy |
| rozjazd | `271` commitów tylko na `master`, `109` tylko na gałęzi | przed merge wymagany semantic replay/reconciliation i ponowna kwalifikacja |
| worktree | staged `backends/fem/tests/conservative_current_view_contract.cpp` poza checkpointem | nie wolno utracić; nie jest częścią wypchniętego dowodu |
| dokumenty 0960–0980 | obecne tylko na gałęzi, `draft`; ADR-0019 `proposed` | `source_visible`, nie zatwierdzona fizyka |
| numeracja not | kolizje z aktualnymi `0960`, `0970`, `0980` na `master` | przed integracją nadać wolne identyfikatory i naprawić wszystkie odnośniki |
| ten plan | pierwotnie ignorowany przez `docs/raports/` | od aktualizacji 2026-07-28 jest przeznaczony do wymuszonego śledzenia jako pojedynczy plik |

Proponowane numery dla trzech not to `0990`, `1000`, `1010`, jeżeli pozostaną
wolne w chwili integracji. Numeracja nie jest semantyką ProblemIR, ale ścieżki,
odnośniki, ADR i manifest dokumentacji muszą zostać zmienione atomowo.

### 0.3. Ledger postępu i dowodów

Statusy w tej tabeli są zakresowe. `pass` ograniczonego contract gate nie
oznacza ani pełnego milestone, ani walidacji continuum.

| Zakres | Dowód w dedykowanej gałęzi | Najwyższy uczciwy status | Otwarte bramki |
|---|---|---|---|
| M0 dokumenty i ADR | noty 0960–0980, runtime spec, ADR-0019 | `source_visible`; dokumenty draft/proposed | korekty z tego audytu, formalny review, rozwiązanie kolizji numerów |
| Python/IR/authoring | `56f5467dcb2bec11454297728f504bbb5aebd1e0` i późniejsze commity | `reference_executable` dla części authoring | pełny normalized round-trip po aktualnym masterze |
| Control Room | `423e156b264d872c4e66c4d35d68de6f50e83c90`–`7c302267a08c0f51ebcd5043dd0b61e9d9c5b474` | `source_visible` | świeże typecheck/lint/test i browser author/export/run/inspect |
| M0 torque | FDM/FEM CPU i część GPU istnieją | co najwyżej `reference_executable` | korekta Slonczewskiego, niezależny SI oracle, cross-backend parity |
| M1 FDM CPU steady | `f867cda3913509ebbc455296302e40b1500fc349` | `reference_executable` | pełne interfejsy, Oersted FFT, zbieżność, native production owner |
| M1 FEM CPU steady | `b91df882c7fc049ce82f359a0fa4ab8dfa0b9595`; bounded managed `steady-transport: pass` | `reference_executable` dla conforming H1/P1 subset | broken/subdomain spaces, mortar/mixing/SML, contrast i h-convergence |
| OE-T0 FEM | `ab2f686afe0aaa60d269966bd87388c0e59e14c6`; managed result `fail` | `semantic_only` | RT0/KKT, rank semantics, prawdziwe MPI, certyfikat i czysty gate |
| OE-F1 FEM direct | kontrakt/receptura; managed result `fail` | `semantic_only` | singular/near quadrature, projection, convergence |
| OE-F2 FEM mixed | kontrakt/receptura; managed result `fail` | `semantic_only` | exact-sequence solve, topology, AMS, airbox convergence |
| FDM FFT Oersted | wpis capability bez produkcyjnego wykonania | `semantic_only` | zamknięty obwód, kernel/direct oracle, native CPU/CUDA |
| M2 FDM CPU reciprocal | `bc512ae113c9a016a22e3c1f39125171e2b559bc`–`3e93d77694a7a032602a0e08387d797dfb3ff139` | `reference_executable` | pełna macierz Onsagera, FEM/GPU, SML, zbieżność i product gate |
| M3 FDM CPU | `031a6fdfaacb7a115f0822fdc0bc0bf8e151d0dc` | `reference_executable` dla one-way single-grid CPU/double | fizyczny `C_s`, event alignment, FEM/GPU, stiff-limit i pełny restart gate |
| M1–M3 GPU | brak pełnych produkcyjnych transport/Oersted lanes | `semantic_only` lub `unsupported` per capability | device execution, residency, FP64 parity, potem FP32 envelope |
| external solvers | ręcznie odczytane wzory/kod | `source_visible` | wersjonowane adaptery i automatyczne workload comparisons |

Pliki `.fullmag/reports/fem-cpu-only/{steady-transport,time-domain}/result.json`
mają `status=pass`, lecz ich `scope=managed_cpu_lane_prerequisite`. Wyniki
`oersted-oet0`, `oersted-oet0-tsan`, `oersted-oef1` i `oersted-oef2` mają
`status=fail`. Żaden z tych plików sam nie uprawnia do `validated`.

Snapshot artefaktów odczytany 2026-07-28, bez ponownego uruchamiania gates w
ramach tego audytu dokumentacji:

| Scenario | Status/scope zapisany w JSON | SHA-256 `result.json` |
|---|---|---|
| `steady-transport` | `pass`, `managed_cpu_lane_prerequisite` | `4779ea71b968f21bc563070febf1aa7c8a9ac909a82ba71a1969cd827607eddf` |
| `time-domain` | `pass`, `managed_cpu_lane_prerequisite` | `e66e0fa6be23ad88e0724f4787c617c99711cd6bbff82e29ff04164452401b1e` |
| `oersted-oet0` | `fail`, `managed_cpu_lane_prerequisite` | `a56029cf22654d5d0e6378ee0ef460cdaffeab4cb67b62a822ef83ee8d9c7264` |
| `oersted-oet0-tsan` | `fail`, `managed_cpu_lane_prerequisite` | `82c7961c1ef9f2f44a2f3155d315bd4db25b39e7ea5a44ee61699e62c8adb6b9` |
| `oersted-oef1` | `fail`, `managed_cpu_lane_prerequisite` | `e47ab031e2c0d53c8c2f67492ee13e1ec6ed97c9ce5f577de9d6e872efceeb78` |
| `oersted-oef2` | `fail`, `managed_cpu_lane_prerequisite` | `9b58dffdf76321dd93787eeb6e7a7c1581022734e57889e5ac45d1dc09670cee` |

Schema tych plików zawiera tylko `scenario`, `schema`, `scope`, `status`; nie
zawiera komendy, source commit, image digest ani czasu. Dlatego nawet oba
`pass` są dowodem ograniczonym i nie spełniają minimalnego rekordu z 26.6.

#### 0.3.1. Audyt bieżącego pokrycia Python/IR/UI

Inspekcja źródeł na `ab2f686a...` potwierdza, że authoring jest rozległy, ale
nie obsługuje kompletnego, skorygowanego kontraktu tego planu:

| Zakres | Python/IR na gałęzi | Control Room na gałęzi | Wniosek |
|---|---|---|---|
| Slonczewski | canonical lowering wybiera `slonczewski.fullmag.v1`; testy oczekują v1 | Inspector domyślnie emituje v1 | obecny round-trip utrwala prefaktor 2x za mały; cały slice wymaga migracji do v2 |
| spin material | `sigma_s,P,theta_SH,lambda_*`, opcjonalne `C_s` i dowolny niepusty formula string | materiały są edytowane głównie jako surowy JSON; walidacja wymaga tylko dodatniego `C_s` i niepustej wersji | brak `source_convention`, DOS adaptera, whitelisty formuł i macierzy podatności FM |
| spin interface | `G_up,G_down,G_r,G_i,g_sml` w `magnetoelectronic.fullmag.v1` | dedykowany Inspector jawnie zapisuje `g_sml_Spm2` | UI i Python implementują odrzucony SML v1; brak `mu_R,G_N,G_F,G_R` v2 |
| current transport | `prescribed_density` i semantyczny `ohmic_poisson`, scalar `sigma`, one-way | część list złożonych jest raw JSON; brak wspólnego `TimeEnvelope` i pełnego execution request | nie ma docelowego magnetoresistive/tensor/total-current/circuit-closure authoring |
| spin BC | typowane static potential/flux, sink, insulating, periodic | zbiorczy raw JSON | brak wektorowych envelope/event semantics w obu powierzchniach |
| Oersted | `OerstedField(source,model)` oraz osobny cylinder | from-current ma tylko `source`; cylinder ma geometry/current/time JSON | brak tagged closure, method, refresh, source-cut/leads, quadrature/kernel, airbox i MQS policy |
| execution | `TransportExecution`: `fdm/fem/auto`, `cpu/gpu/auto`, `strict/extended` | select dopuszcza dodatkowo `hybrid` dla discretization i execution mode | jawny drift schematu; wartości UI nie round-tripują do aktualnego Python contract |
| integrator M3 | nazwa `coupled_imex_ark2` i opis step doubling | brak pełnego tableau/event/checkpoint authoring | nazwa istnieje, lecz skorygowany kontrakt numeryczny nie jest kompletny |

Wniosek audytu nie brzmi „UI nie istnieje”: zasoby, Inspectors i mutacje v2 są
`source_visible`. Nie wolno jednak uznać surowego pola JSON ani obsługi starego
schema za kompletne pokrycie parametrów. Przed promocją wymagany jest gate
`spin_transport_authoring_parameter_parity_v1` z rozdziału 15.2.

### 0.4. Kolejność napraw P0 przed kontynuacją

1. Skorygować i ponownie wersjonować Slonczewskiego we wszystkich backendach,
   testach, notach, IR i provenance.
2. Zastąpić OE-T0 `ProjectCoefficient` rzeczywistym ważonym RT0/KKT; naprawić
   klasyfikację komponentów z terminalami oraz globalny tor MPI.
3. Uzgodnić, czy SML v1 jest wyłączone, czy wdrażany jest jawny model
   rezerwuarowy z dodatkową niewiadomą interfejsową.
4. Zdefiniować fizyczny adapter DOS -> `C_s` i ograniczyć M3 do materiałów, dla
   których skalarny model jest ważny.
5. Naprawić drift Python/OpenAPI/UI (`hybrid`, formula versions, SML, closure,
   envelope) i wprowadzić generowany leaf-by-leaf parity gate.
6. Zintegrować gałąź z aktualnym `master`, rozwiązać kolizje not i uruchomić
   wszystkie bramki ponownie na czystym indeksie oraz świeżych artefaktach.

---

## 1. Cel, zakres i definicja ukończenia

### 1.1. Cel

Celem jest doprowadzenie Fullmag do stanu, w którym:

1. Zhang–Li STT, Slonczewski STT i prescribed SOT mają jedną, zamrożoną konwencję znaków, jednostek i transformacji Gilberta;
2. Spin Hall Effect nie jest utożsamiany z algebraicznym SOT, lecz jest rozwiązaniem sprzężonego transportu ładunku i spinu;
3. dynamiczne pole Oersteda jest liczone z dokładnie tego samego podpisanego pola prądu `J_c(x,t)`, które zasila transport spinowy i torque;
4. FDM i FEM realizują ten sam problem fizyczny, mimo odmiennych dyskretyzacji;
5. CPU i GPU mają oddzielnych właścicieli wykonania, lecz wspólny kontrakt fizyczny;
6. Python DSL, ProblemIR, planner, runtime, OpenAPI, Control Room, artefakty i provenance zachowują wszystkie parametry bez utraty round-trip;
7. żadna capability nie jest oznaczona jako `validated`, dopóki nie przejdzie niezależnego orakla, badania zbieżności oraz właściwego managed-runtime gate.

### 1.2. Zakres fizyczny

Dokument obejmuje:

- LLG w konwencji Gilberta;
- objętościowy Zhang–Li STT;
- warstwowy/interfejsowy Slonczewski STT;
- prescribed damping-like i field-like SOT;
- transport ładunku w reżimie elektrokwasistatycznym;
- steady oraz transient spin drift-diffusion;
- bezpośredni SHE i odwrotny SHE;
- spin-flip, exchange rotation i transverse dephasing;
- przezroczyste interfejsy oraz interfejsy z complex spin-mixing conductance;
- spin backflow i spin-memory loss jako jawne opcje;
- jednokierunkowe i dwukierunkowe sprzężenie transport–LLG;
- AMR, PHE i AHE w etapie dwukierunkowym;
- pole Oersteda w przybliżeniu magnetokwasistatycznym;
- FDM CPU/CUDA oraz FEM CPU/MFEM i FEM GPU/hypre/libCEED;
- pełny publiczny kontrakt i obserwowalność produktu.

### 1.3. Poza zakresem wersji M0–M3

Następujące zjawiska nie mogą być cicho przybliżane przez ten solver:

- pełna fala elektromagnetyczna i opóźnienie propagacji;
- displacement current, gdy `omega*epsilon/sigma` nie jest zaniedbywalne;
- skin effect i eddy currents, gdy przekrój przewodnika nie jest mały względem głębokości naskórkowej;
- ballistic spin transport i rozkłady Boltzmannowskie;
- tunelowanie kwantowe MTJ wyprowadzane z pierwszych zasad;
- Rashba–Edelstein utożsamiany automatycznie z bulk SHE;
- spin pumping jako ukryta poprawka do `alpha`.

Planner ma w tych przypadkach zwrócić jasne `unsupported_physics_regime`, a nie wykonać model poza jego zakresem ważności.

### 1.4. Definicja ukończenia

Cały program jest ukończony dopiero, gdy równocześnie spełnione są wszystkie warunki:

- M0, M1, M2 i M3 mają zamknięte kryteria wejścia i wyjścia;
- Python i UI tworzą semantycznie identyczny ProblemIR;
- normalized round-trip jest równy pole po polu;
- każdy wspierany lane ma jawne `requested` i `resolved` execution;
- brak ukrytego CPU fallback przy żądaniu strict GPU;
- FDM CPU double i FEM CPU double przechodzą niezależne badania zbieżności;
- GPU double przechodzi parity z właściwym CPU oracle;
- GPU single ma osobny qualification envelope;
- dynamiczne `J_c`, torque i `H_oe` używają czasu etapu `t_n+c_i*dt`;
- obserwable odpowiadają wartościom faktycznie użytym w RHS;
- końcowy product gate obejmuje realny browser authoring/export/inspection smoke;
- capability matrix wskazuje `validated` tylko dla workloadów z wersjonowanym dowodem.

---

## 2. Źródła i hierarchia zaufania

### 2.1. Źródła lokalne

1. `docs/papers/mic_intro.pdf` — klasyczna mikromagnetyka, energia, magnetostatyka, podstawy FDM/FEM i jawna postać LL równoważna Gilbertowi.
2. `docs/comsol/Manual_for_Micromagnetics_Module.pdf` — wzorzec sprzęgnięcia `ec.J -> Zhang–Li`, weak-form workflow i multiphysics; nie jest kompletną definicją SHE ani dynamicznego Oersteda.
3. `external_solvers/3` oraz `external_solvers/amumax` — MuMax3/amumax: referencja zachowania Slonczewskiego i Zhang–Li na regularnej siatce oraz PBC.
4. `external_solvers/BORIS/Boris` — rozdzielony charge/spin transport, interfejsy, SOT i Oersted na CPU/CUDA.
5. `external_solvers/neuralmag` — cell-integrated FFT Oersted dla FDM oraz testy FDM/FEM Biot–Savarta.
6. Pozostałe `external_solvers` — źródła porównawcze, nie automatycznie orakle.

Kod zewnętrzny służy do porównania równań, konwencji i testów. Nie wolno kopiować implementacji bez sprawdzenia licencji i pochodzenia konkretnego pliku.

### 2.2. Literatura pierwotna

Kontrakt należy oprzeć co najmniej na:

- Slonczewski 1996 i Berger 1996 dla CPP STT;
- Zhang–Li 2004 dla adiabatycznego i nieadiabatycznego STT;
- Stiles–Zangwill 2002 dla absorpcji poprzecznego strumienia spinu;
- Valet–Fert 1993 oraz Zhang–Levy–Fert 2002 dla dyfuzji spinu;
- Abert et al. 2014/2015 i García-Cervera–Wang 2007 dla sprzężonego transportu i FEM;
- Hirsch 1999 i Zhang 2000 dla SHE z dyfuzją;
- Chen et al. 2013 dla SHE/iSHE oraz spin-mixing boundary condition;
- Brataas–Nazarov–Bauer, Xia et al. i Tserkovnyak et al. dla mixing conductance, backflow i spin pumping;
- Manchon et al. 2019 dla klasyfikacji SOT i zakresów ważności modeli;
- Alouges oraz Bartels–Prohl dla stabilnej dyskretyzacji FEM LLG;
- Dormand–Prince dla adaptacyjnego RK i poprawnej semantyki etapów;
- Ascher–Ruuth–Spiteri dla zamrożonego IMEX ARS(2,3,2);
- Raviart–Thomas, Monk, Duffy i dokumentację MFEM dla `H(div)`, `H(curl)`,
  mixed saddle systems i kwadratur osobliwych.

### 2.3. Hierarchia rozstrzygania rozbieżności

1. zamrożona nota `docs/physics` z pełnym rachunkiem SI i testem analitycznym;
2. literatura pierwotna;
3. niezależny symbolic/numerical oracle;
4. porównanie dwóch odmiennych dyskretyzacji Fullmag;
5. porównanie z zewnętrznym solverem;
6. istniejący kod Fullmag.

Zgodność z zewnętrznym solverem nie jest dowodem poprawności, jeżeli oba kody używają tej samej błędnej konwencji.

---

## 3. Zamrożone konwencje SI, orientacji i znaków

### 3.1. Stałe i pola

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| `e>0` | moduł ładunku elektronu | C |
| `hbar` | zredukowana stała Plancka | J s |
| `mu0` | przenikalność próżni | H/m |
| `gamma_e>0` | moduł współczynnika żyromagnetycznego | s^-1 T^-1 |
| `gamma0=mu0*gamma_e` | współczynnik dla pola `H` | m A^-1 s^-1 |
| `M_s` | magnetyzacja nasycenia | A/m |
| `m=M/M_s` | magnetyzacja znormalizowana | 1 |
| `H_eff` | pole efektywne | A/m |
| `J_c` | konwencjonalna gęstość prądu ładunku | A/m^2 |
| `mu_s` | pełne rozszczepienie spinowe napięcia elektrochemicznego: kanały lokalne `V +/- mu_s/2` | V |
| `Q_{ia}` | charge-equivalent spin-current tensor | A/m^2 |
| `mathcal J^s=(hbar/2e)Q` | strumień momentu pędu spinu | J/m^2 |
| `tau` | bezpośredni moment w równaniu dla `m` | s^-1 |
| `H_oe` | pole Oersteda | A/m |

`gamma_e` nigdy nie może oznaczać Hz/T. Jest współczynnikiem kątowym w radianach, przy czym radian jest bezwymiarowy. Częstotliwość w Hz wymaga jawnego dzielenia przez `2*pi`.

### 3.2. Prąd

- `J_c` wskazuje kierunek dodatniego prądu konwencjonalnego.
- Dryf elektronów jest przeciwny do `J_c`.
- Żaden backend nie może zastępować `J_c` przez `abs(J_c)` ani normę wektora przed wyznaczeniem orientowanego strumienia.
- Dla interfejsu z jednostkową normalną `n_{A->B}` podpisany prąd normalny to `J_n=J_c dot n_{A->B}`.
- Odwrócenie normalnej zmienia znak `J_n`; provenance musi przechowywać orientację interfejsu.

### 3.3. Tensor prądu spinowego

`Q_{ia}` oznacza przepływ w kierunku przestrzennym `i` spinu spolaryzowanego w kierunku `a`. Pierwszy indeks jest indeksem strumienia, drugi indeksem spinu. Pole nie może być publikowane jako zwykły wektor 3D.

Dodatni normalny strumień przez powierzchnię o normalnej `n` to:

```text
q_s,a = n_i Q_{ia}.
```

### 3.4. Normalna interfejsu SHE

Dla warstwy heavy-metal `N` i ferromagnetyka `F` normalna `n_NF` zawsze wskazuje `N -> F`. W najprostszym modelu bulk SHE polaryzacja spinu wstrzykiwanego do `F` jest wyprowadzana z pełnego tensora `Q`; nie jest rekonstruowana drugi raz ze skrótu `n x J` w module torque.

### 3.5. Gilbert i bezpośrednie momenty

Kanoniczne równanie ma postać:

```text
dm/dt = -gamma0 m x H_eff + alpha m x dm/dt + T_G,
|m| = 1.
```

`T_G` jest sumą źródeł momentu w postaci Gilberta i ma jednostkę `1/s`. Dla stycznego `W=-gamma0 m x H_eff + T_G` jawny RHS wynosi:

```text
dm/dt = [W + alpha m x W] / (1 + alpha^2).
```

Równoważnie:

```text
dm/dt = -gamma0/(1+alpha^2)
        [m x H_eff + alpha m x (m x H_eff)]
        + [T_G + alpha m x T_G]/(1+alpha^2).
```

Każdy backend musi używać jednego backend-neutralnego operatora tej transformacji. Nie wolno mieszać momentu już przekształconego z momentem w postaci Gilberta.

---

## 4. Pełna definicja rodzin torque

### 4.1. Zhang–Li STT

Definiujemy prędkość spin-drift:

```text
u = (g mu_B P)/(2 e M_s) J_c,                 [m/s]
```

gdzie `P` jest modułem polaryzacji w zakresie `[0,1]`, a `g` jest efektywnym
czynnikiem Landego. Kierunek wynika wyłącznie z podpisanego `J_c`; adaptery
używające electron-flow convention wykonują jawną konwersję. Kanoniczne źródło
Gilberta:

```text
T_ZL,G = -(u dot grad)m + beta m x [(u dot grad)m].
```

Ta definicja zamraża kierunek względem prądu konwencjonalnego. Adapter zgodności z solverem używającym electron-flow convention musi wykonać dokładnie jedną jawną zmianę znaku i zapisać ją w provenance.

Własności wymagane testami:

- `grad(m)=0 => T_ZL,G=0`;
- `J_c -> -J_c => T_ZL,G -> -T_ZL,G`;
- `P=0 => T_ZL,G=0`;
- dla `beta=0` pozostaje tylko transport adiabatyczny;
- moment pozostaje styczny do sfery jednostkowej do błędu dyskretyzacji.

Zabronione są nieudokumentowane czynniki `1/(1+beta^2)`. Jeżeli adapter zewnętrzny je stosuje, parametr publiczny musi zostać przeliczony do powyższej definicji.

### 4.2. Slonczewski CPP STT

Niech:

- `p` będzie jednostkową polaryzacją warstwy stałej;
- `n_stack` wskazuje od warstwy stałej do swobodnej;
- `J_n=J_c dot n_stack`;
- `t_F>0` będzie lokalną grubością warstwy swobodnej;
- `Lambda>=1`, `P in [0,1]`.

Efektywność kątowa w formule zgodnej z rodziną MuMax3:

```text
epsilon(c) = P Lambda^2 /
             [(Lambda^2 + 1) + (Lambda^2 - 1)c],
c = m dot p.
```

Podpisana skala częstości:

```text
Omega_J = gamma_e hbar J_n / (e M_s t_F).     [1/s]
```

Brak czynnika `1/2` w `Omega_J` jest konieczny przy powyższej definicji
`epsilon`. Dla `Lambda=1` otrzymujemy `epsilon=P/2`, więc całkowity
damping-like prefactor redukuje się do standardowego
`gamma_e hbar P J_n/(2 e M_s t_F)`. Jednoczesne użycie `1/(2e)` w `Omega_J`
i licznika `P Lambda^2` w `epsilon` zaniża moment dwukrotnie. Wykonywalny
kernel MuMax3 używa dokładnie pary `hbar/e` oraz powyższego `epsilon`.

Kanoniczne źródło Gilberta:

```text
T_SL,G = Omega_J [epsilon(c) m x (m x p)
                  + epsilon_prime m x p].
```

Znaki obu baz i skorygowany prefaktor są częścią
`formula_version=slonczewski.fullmag.v2`. Wersja
`slonczewski.fullmag.v1` oznacza niezatwierdzony wariant z błędnym dodatkowym
`1/2`; jest zabroniona dla nowych runów i może istnieć wyłącznie jako
read-only provenance dla artefaktów wygenerowanych na dedykowanej gałęzi.
Nie wolno używać `fixed_layer_position` jako zastępstwa znaku prądu. Parametr
kompatybilnościowy może jedynie wyznaczyć `n_stack`, po czym zostaje usunięty
z normalized IR.

Istnieją dwie rozłączne realizacje:

- `slonczewski_thin_layer_homogenized.v1` — powyższy volumetric rate z `1/t_F`;
- `slonczewski_interface_flux.v1` — powierzchniowy funkcjonał wyprowadzony z
  `q_abs` bez sztucznego `1/t_F` w weak form.

Planner zabrania zastosowania obu do tego samego interfejsu/targetu. Artefakt
zawsze zapisuje realization.

Wymagane walidacje:

- `m || p => T_SL,G=0` dla `epsilon_prime=0`;
- `J_n -> -J_n` odwraca cały moment;
- `n_stack -> -n_stack` odwraca moment przy stałym `J_c`;
- skalowanie jest liniowe w `J_n` i odwrotne w `M_s*t_F`;
- `p` zerowe lub niejednostkowe jest odrzucane albo normalizowane dokładnie raz w lowering; rekomendacja: odrzucać zero, normalizować niezerowe z warningiem tylko w trybie migracji;
- mianownik `epsilon` musi pozostać dodatni dla dopuszczonego zakresu parametrów.
- dla `Lambda=1`, `epsilon_prime=0` i ustalonego `m,p` niezależny SI oracle
  musi otrzymać dokładnie prefaktor `gamma_e hbar P J_n/(2 e M_s t_F)`;
- adapter MuMax3 porównuje osobno `Omega_J`, `epsilon`, obie bazy wektorowe i
  konwencję położenia warstwy, aby zgodność nie wynikała z kompensujących się
  błędów znaku lub skali.

### 4.3. Prescribed spin-orbit torque

`PrescribedSpinOrbitTorque` jest modelem lokalnym. Nie rozwiązuje transportu ładunku ani spinu i nie może publikować capability `SHE solver`.

Żeby nie zakodować znaku podwójnie, źródło wektorowe wymaga jednostkowej osi
napędu `t_drive`. Definiujemy:

```text
J_signed = J_c dot t_drive,
sigma_hat = normalize(n_NF x t_drive).
```

Wymagane jest `|n_NF x t_drive|>epsilon_axis`. Odwrócenie `J_c` zmienia tylko
`J_signed`; nie zmienia `t_drive` ani `sigma_hat`. Alternatywny wariant publiczny
przyjmuje bezpośrednio parę `(J_signed, sigma_hat)` i nie może jednocześnie
przyjąć `current_source`. Dla tak zdefiniowanych wielkości:

```text
Omega_DL = gamma_e hbar xi_DL J_signed / (2 e M_s t_F),
Omega_FL = gamma_e hbar xi_FL J_signed / (2 e M_s t_F).
```

Kanoniczne źródło Gilberta:

```text
T_SOT,G = Omega_DL m x (sigma_hat x m)
          + Omega_FL m x sigma_hat.
```

Obie składowe mają `1/s`. Jeżeli implementacja najpierw buduje pole `H_SOT` w `A/m`, musi następnie zastosować `gamma0`; nie wolno dodawać pola bezpośrednio do `dm/dt`.

`sigma_hat` może być:

- podane jawnie;
- wyprowadzone przez zdefiniowaną regułę `sigma_hat=normalize(n_NF x t_drive)`;
- pobrane z rozwiązania `SpinDriftDiffusion`.

Trzeci wariant nie jest prescribed SOT i musi obniżyć się do `DriftDiffusionSpinTorque`.

### 4.4. Torque wyprowadzony z transportu

Moment wyprowadzony z transportu jest bilansem momentu pędu, a nie dopasowanym polem:

```text
mathcal J^s = (hbar / 2e) Q.
```

Dla objętościowego pochłaniania w FM nie wolno utożsamiać całej dywergencji
strumienia z momentem magnetyzacji w problemie transient. Spin-flip przekazuje
moment pędu do niesprecyzowanego rezerwuaru relaksacyjnego, natomiast człony
exchange rotation i transverse dephasing przekazują go magnetyzacji. Definiujemy
charge-equivalent volumetric absorption:

```text
r_m^Q = R_J + R_phi,                           [A/m^3]
mathcal R_m = (hbar/2e) r_m^Q,                 [J/m^3]
T_tr,G = -gamma_e/M_s * mathcal R_m.           [1/s]
```

W stanie steady i przy braku innych poprzecznych rezerwuarów równoważnie
`mathcal R_m=-(div mathcal J^s)_perp`. W stanie transient trzeba uwzględnić
akumulację i nie wolno stosować tego skrótu.

Dla interfejsu i warstwy swobodnej o grubości `t_F`:

```text
T_int,G = -gamma_e hbar/(2 e M_s t_F) q_abs,
q_abs = Q_n,in - Q_n,out.                     [A/m^2]
```

Minus wynika z przeciwnego zwrotu magnetyzacji i elektronowego momentu pędu
przy `gamma_e>0` oraz LLG `-gamma0 m x H`. W FEM powierzchniowy moment może
pozostać funkcjonałem brzegowym zamiast sztucznego dzielenia przez `t_F`.
Artefakt musi wskazać, czy wynik jest torque density, nodal rate czy interface
flux.

---

## 5. Transport ładunku

### 5.1. Reżim M1: izotropowy elektrokwasistatyczny

Na domenie przewodzącej `Omega_c`:

```text
E = -grad(V),
J_c = sigma E,
div(J_c) = 0.
```

Warunki brzegowe:

- `VoltageElectrode`: `V=V_k(t)`;
- `Ground`: `V=0`;
- `TotalCurrentElectrode`: całka `J_c dot n` jest zadana, a potencjał elektrody jest stałą niewiadomą;
- `Insulating`: `J_c dot n=0`;
- periodyczny spadek potencjału: osobny, jawny typ BC.

Każdy problem musi mieć usuniętą swobodę gauge: co najmniej jedna referencja potencjału albo zero-mean constraint.

Zadane pole `CurrentDensityField` nie omija fizyki ciągłości. Przed użyciem w
STT, SHE lub Oersted musi przejść dyskretny test `div(J_c)=0` oraz bilans fluxów
na elektrodach i ścianach izolujących. Pole niespełniające tolerancji jest
odrzucane; automatyczna projekcja do pola bezdywergentnego jest osobnym,
jawnie wybranym modelem i zmienia provenance. Mnożenie przez globalny envelope
zachowuje ten warunek, jeżeli bazowa mapa jest poprawna.

Dla Oersteda lokalny bilans w uciętej domenie z elektrodami nie wystarcza:
Biot–Savart wymaga globalnie zamkniętego obwodu. `OerstedField` musi otrzymać
jedno z:

- geometrię przewodnika zawierającą return path i zerowy całkowity flux przez
  zewnętrzną granicę domeny źródła;
- wersjonowane `ExternalLeadExtension`, które przedłuża elektrody i zamyka
  obwód poza domeną transportu;
- analityczne pole kompletnego obwodu jako prescribed source.

Sama belka z prądem wpływającym jedną elektrodą i wypływającym drugą, bez
określenia przewodów powrotnych, jest dla ogólnego Oersteda odrzucana.

### 5.2. Reżim M2: magnetorezystywny i reciprocal

W ferromagnetyku tensor przewodności ma pełną postać 3D:

```text
J_c = sigma_perp E
      + (sigma_parallel-sigma_perp)(m dot E)m
      + sigma_AHE m x E
      + J_iSHE(mu_s).
```

PHE wynika z części symetrycznej zależnej od `m`; AHE z części antysymetrycznej. Publiczny model nie może przyjmować jednocześnie sprzecznych zestawów `rho_*` i `sigma_*` bez jawnej reguły konwersji.

Reciprocal spin-polarized transport oraz inverse SHE są złożone z direct
transport terms w jednym konstytutywnym bloku. Dla
`G_{ia}=-0.5 partial_i mu_s,a` kanoniczny blok Fullmag v1 w FM ma postać:

```text
J_c,i = J_mr,i
        + P sigma m_a G_{ia}
        + theta_SH sigma epsilon_{ija} G_{ja},
Q_{ia} = sigma_s G_{ia}
         + P sigma E_i m_a
         + theta_SH sigma epsilon_{ika} E_k.
```

`J_mr` jest częścią ohmic/AMR/PHE/AHE z poprzedniego równania. Przy
kontrakcji z siłami `E_i` i `G_{ia}` człony proporcjonalne do `P` tworzą
symetryczny blok dwukanałowy, a człony SHE/iSHE są antysymetryczne. Dla
izotropowego przypadku warunek dodatniości części dyssypacyjnej to
`sigma>0` oraz `sigma_s-P^2 sigma>0`. Po eliminacji `E` przy zadanym `J_c`
efektywny podłużny współczynnik dyfuzji jest właśnie
`sigma_s-P^2 sigma`; dla szczególnego modelu `sigma_s=sigma` daje
`sigma(1-P^2)`.

Dla anizotropowego `Sigma_mr` i skalarnego sprzężenia `P sigma_ref` warunek
izotropowy nie wystarcza. Symetryczna część pełnej macierzy Onsagera musi być
dodatnio określona; równoważny warunek Schura brzmi:

```text
Sigma_mr^sym = 0.5 (Sigma_mr + Sigma_mr^T),
sigma_s > 0,
Sigma_mr^sym - (P^2 sigma_ref^2/sigma_s) I  positive definite.
```

W ogólnym modelu tensorowego `Sigma_s` planner sprawdza dodatnią określoność
pełnego symetrycznego bloku, a nie przybliżenie przez pojedynczą wartość
własną. AHE oraz para SHE/iSHE należą do części antysymetrycznej i muszą dawać
dokładnie zerowy wkład do `E dot J_c + G:Q` w algebraicznym teście mocy. Ich
dyskretyzacja nie może wytwarzać sztucznej dyssypacji.

M1 rozwiązuje świadomie jednokierunkową redukcję:

```text
J_c,i = sigma E_i,
Q_{ia} = sigma_s G_{ia}
         + P sigma E_i m_a
         + theta_SH sigma epsilon_{ika} E_k.
```

Pomija więc zarówno longitudinal reciprocal feedback, jak i iSHE w `J_c`.
M2 przywraca pełny blok. Draft 0970, po przenumerowaniu proponowany jako 1000,
ma powtórzyć rachunek Onsagera i zamrozić test symboliczny; backend nie może
wybierać znaku niezależnie.

### 5.3. Źródła czasowe

Każdy drive ma jedno `TimeEnvelope`:

```text
constant(value)
sinusoidal(amplitude, frequency_hz, phase_rad, offset)
pulse(amplitude, t_on, t_off)       # przedział [t_on,t_off)
piecewise_linear([(t0,y0),...])
sinc(amplitude, center, bandwidth_hz, offset)
tabulated(artifact, interpolation, extrapolation)
```

Każdy envelope publikuje uporządkowaną listę zdarzeń czasowych. Integrator
przycina krok tak, aby zaakceptowany endpoint wypadał dokładnie na `t_on`,
`t_off`, każdym węźle PWL oraz każdym węźle tablicy, w którym funkcja albo jej
pochodna zmienia regularność. Po zdarzeniu rozpoczyna nowy krok z jednoznaczną
semantyką prawostronną; dla pulse aktywny pozostaje przedział `[t_on,t_off)`.
Bez event alignment test formalnego rzędu nie obejmuje kroku przecinającego
nieciągłość lub kink.

Idealny `pulse` jest dopuszczalnym matematycznym wymuszeniem dla modeli bez
pasma tylko z powyższym podziałem kroków. Użycie go w dynamicznym Oerstedzie
wymaga dodatkowo `rise_time_s>0` albo skończonego `bandwidth_hz`; w strict MQS
idealny skok jest odrzucany. `piecewise_linear` i `tabulated` również publikują
`bandwidth_hz`, jeśli mają zasilać walidację MQS. Indeks następnego zdarzenia i
wersja envelope należą do checkpointu oraz klucza cache.

Envelope należy do źródła prądu, nie osobno do torque i Oersteda. Dla separowalnego problemu liniowego:

```text
J_c(x,t)=a(t) J_c0(x),
H_oe(x,t)=a(t) H_oe0(x).
```

Wtedy wolno cache'ować bazową mapę. Dla przewodności zależnej od `m`, iSHE lub nieseparowalnych elektrod solve musi być odświeżany zgodnie z coupling policy.

---

## 6. Spin drift-diffusion i SHE

### 6.1. Zmienne i konstytutywny rdzeń

Solver używa:

- `V` w V;
- `J_c` w A/m^2;
- `mu_s=(mu_x,mu_y,mu_z)` w V;
- `Q_{ia}` w A/m^2;
- `C_s` — spin capacitance/susceptibility w A s V^-1 m^-3 dla trybu transient.

Dla izotropowego niemagnetycznego metalu, pełnego rozszczepienia kanałów
`V +/- mu_s/2` oraz gęstości stanów na jeden spin
`N_0 [J^-1 m^-3]` definiujemy:

```text
rho_s^Q = e^2 N_0 mu_s,                       [C/m^3]
C_s = partial rho_s^Q/partial mu_s = e^2 N_0
    = e^2 D_total/2,                          [A s V^-1 m^-3]
D_spin = sigma_s/(2 C_s),                     [m^2/s]
tau_sf = 2 C_s lambda_sf^2/sigma_s.           [s]
```

`D_total=2N_0` jest całkowitym DOS obu kanałów. Czynniki `1/2` wynikają z
pełnego, a nie połówkowego, splitu `mu_s` i muszą należeć do
`capacitance_formula_version=dos_isotropic_nonmagnetic.fullmag.v1`.
Dotychczasowa nazwa `dos_constant.fullmag.v1` bez tej definicji jest
niewystarczająca i nie może kwalifikować M3.

W ferromagnetyku `N_up != N_down` zmiany `V` i podłużnego `mu_s` są sprzężone,
a odpowiedź poprzeczna może być tensorowa. Ogólny transient FM wymaga dodatnio
określonej macierzy podatności charge-spin albo jawnego tensorowego
`C_s`; skalarny `C_s` jest dozwolony tylko dla udokumentowanej redukcji
materiałowej. W przeciwnym razie planner zwraca
`unsupported_transient_spin_susceptibility`, zamiast ignorować człony
magazynowania charge-spin.

Dla czytelności definiujemy spin-driving gradient:

```text
G_{ia} = -0.5 partial_i mu_s,a.                [V/m]
```

Minimalny izotropowy konstytutywny blok M1, czyli jednokierunkowa redukcja
pełnego bloku z rozdziału 5.2:

```text
Q_{ia} = sigma_s G_{ia}
         + P sigma E_i m_a
         + theta_SH sigma epsilon_{ika} E_k.
```

Pierwszy człon opisuje dyfuzję, drugi spinowo spolaryzowany prąd w FM, trzeci direct SHE. `theta_SH` jest podpisane. Kolejność indeksów Levi-Civity i definicja `Q_{ia}` są częścią formula version.

Ta konwencja daje dla `E=E_x e_x` wartość
`Q_zy=+theta_SH sigma E_x`. Chen et al. 2013, przy własnym porządku indeksów i
znaku prądu spinowego, zapisuje dla tej samej orientacji
`j_s^z=-theta_SH^Chen sigma E_x e_y`. Adapter literaturowy jest zatem jawny:

```text
theta_SH^fullmag = -theta_SH^Chen2013
```

przy identycznych osiach przestrzennych i bez dodatkowego odwrócenia normalnej.
Importer nie może przepisać nominalnej wartości `theta_SH` bez wskazania
`source_convention`. Test adaptera obejmuje wszystkie trzy kierunki pola i
wszystkie sześć niezerowych kontrakcji Levi-Civity; pojedynczy test `x-z-y`
nie wystarcza.

Poza FM `P=0`, `R_J=R_phi=0`. `theta_SH`, `sigma` i `sigma_s` są zawsze
wartościami materiału po stronie, w której ewaluowany jest flux.

W M2 charge current otrzymuje reciprocal iSHE z tej samej macierzy
konstytutywnej. Przed implementacją M2 draft 0970, po przenumerowaniu
proponowany jako 1000, ma podać pełny blok w jednej notacji i zweryfikować go
symbolicznym testem Onsagera; nie wolno dopisywać iSHE jako niezależnego znaku
w backendzie.

### 6.2. Równanie bilansu spinu

W domenie przewodzącej:

```text
C_s partial_t mu_s,a + partial_i Q_{ia}
  = -R_sf,a - R_J,a - R_phi,a.
```

Przyjmujemy:

```text
R_sf  = sigma_s/(2 lambda_sf^2) mu_s,
R_J   = sigma_s/(2 lambda_J^2) (mu_s x m),
R_phi = sigma_s/(2 lambda_phi^2) m x (mu_s x m).
```

- `lambda_sf>0` — długość spin-flip;
- `lambda_J>0` — długość rotacji/precesji wymiennej;
- `lambda_phi>0` — długość zaniku poprzecznej akumulacji;
- poza FM człony `R_J` i `R_phi` są zerowe;
- limit nieskończonej długości oznacza dokładnie wyłączenie danego członu;
- żadna długość nie może być zerowa.

Lokalny audyt termodynamiczny używa pełnego splitu `mu_s`:

```text
P_bulk = E dot J_c + G:Q
         + 0.5 mu_s dot (R_sf+R_J+R_phi),       [W/m^3]
mu_s dot R_J = 0.
```

Po odjęciu antysymetrycznych AHE/SHE/iSHE oraz `R_J` pozostała część musi być
nieujemna. Test obejmuje pełny blok, reakcje i interfejsy; samo `J_c dot E>=0`
nie kwalifikuje coupled transport.

W M1 rozwiązywany jest stan quasistatyczny `partial_t mu_s=0`. W M3 `C_s` jest
wymagane i fizycznie wersjonowane; nie wolno konstruować transient equation
przez arbitralne ustawienie `C_s=1`, przyjmować dowolnego niepustego stringa
`capacitance_formula_version` ani używać skalarnego `C_s` dla ogólnego FM bez
udowodnionej redukcji podatności.

### 6.3. Transparentne interfejsy

Dla idealnie transparentnego interfejsu bez oporu powierzchniowego:

```text
[V] = 0,
[J_c dot n] = 0,
[mu_s] = 0,
[n_i Q_{ia}] = 0.
```

Skok jest liczony zgodnie z jedną orientacją normalnej. Różne współczynniki materiałowe są obsługiwane przez strumień, nie przez arytmetyczne uśrednianie niewiadomych.

### 6.4. Interfejs z mixing conductance

Dla `N|F` z normalną `n_NF` definiujemy `Delta V=V_N-V_F` i różnicę spinowego
potencjału `Delta mu_s=mu_s,N-mu_s,F`. Ponieważ `mu_s` jest pełnym
rozszczepieniem kanałów, podłużny charge/spin flux w kanonicznej parametryzacji
`G_up`, `G_down` wynosi:

```text
j_c,n = (G_up+G_down) Delta V
        + 0.5 (G_up-G_down) m dot Delta mu_s,
q_s,parallel = [(G_up-G_down) Delta V
        + 0.5 (G_up+G_down) m dot Delta mu_s] m.
```

Poprzeczny charge-equivalent flux absorbowany przez F:

```text
q_abs,perp = G_r m x (Delta mu_s x m)
             + G_i (Delta mu_s x m).          [A/m^2]
```

W wersji `full_absorption` bez spin-memory loss oba ślady fluxu, mierzone tą
samą normalną `N->F`, są zamrożone jako:

```text
n dot Q_N = q_s,parallel + q_abs,perp,
n dot Q_F = q_s,parallel,
q_abs,perp = n dot Q_N - n dot Q_F.
```

Moment magnetyzacji otrzymuje wyłącznie `q_abs,perp`.

`G_up`, `G_down`, `G_r` i `G_i` mają S/m^2. Powyższe współczynniki i czynniki
`1/2` należą do `interface_formula_version=magnetoelectronic.fullmag.v1`.
Publikacje używające połówkowej akumulacji spinowej lub bezwymiarowych
konduktancji wymagają jawnej konwersji. Publiczne API przechowuje jedną
parametryzację kanoniczną, a alternatywne wejścia są normalizowane.

#### 6.4.1. Spin-memory loss: korekta modelu rezerwuarowego

Poprzedni draft `sml_surface_conductance.v1` definiował:

```text
q_SML = G_SML Delta mu_s.
```

Taki człon jest zwykłym transferem, jeśli ten sam flux występuje po obu
stronach. Jeżeli występuje tylko po stronie `N`, nie wskazuje potencjału
rezerwuaru, nie zamyka bilansu i nie implikuje deklarowanej produkcji
`G_SML |Delta mu_s|^2`. Wersja ta jest fizycznie odrzucona i nie może
publikować capability `transport.spin.memory_loss`.

Minimalny termodynamicznie domknięty model
`sml_reservoir.fullmag.v2` wprowadza wektorowy powierzchniowy potencjał
rezerwuaru `mu_R` i trzy nieujemne konduktancje w S/m^2:

```text
q_NR = G_N (mu_s,N-mu_R),        # N -> reservoir
q_FR = G_F (mu_s,F-mu_R),        # F -> reservoir
q_RL = G_R mu_R,                 # reservoir -> lattice, mu_lattice=0
q_NR + q_FR = q_RL.              # algebraiczny bilans rezerwuaru
```

Ślady całkowitego fluxu przy wspólnej normalnej `N->F` są wtedy:

```text
n dot Q_N = q_s,parallel + q_abs,perp + q_NR,
n dot Q_F = q_s,parallel - q_FR,
n dot Q_N - n dot Q_F = q_abs,perp + q_RL.
```

`q_abs,perp` trafia do magnetyzacji, natomiast `q_RL` do rezerwuaru
sieci/interfejsu. Dla pełnego splitu spinowego produkcja powierzchniowa części
rezerwuarowej wynosi:

```text
P_SML = 0.5 [G_N |mu_s,N-mu_R|^2
             +G_F |mu_s,F-mu_R|^2
             +G_R |mu_R|^2] >= 0.             [W/m^2]
```

Do użycia nazwy spin-memory loss wymagane jest `G_R>0`; dla `G_R=0` układ jest
wyłącznie dodatkową ścieżką transferu. `mu_R` jest lokalną niewiadomą
algebraiczną eliminowaną statycznie albo składaną jako surface DOF. Wersja
transient z pojemnością rezerwuaru wymaga osobnej publikacji. Bezwymiarowe
parametry `delta` z literatury nie są przyjmowane bez adaptera z jawną formułą
konwersji do `G_N,G_F,G_R` i zakresem ważności.

Pełna moc powierzchniowa dla mixing law jest liczona z
`j_c,n Delta V + 0.5 q_s dot Delta mu_s`. Część `G_r` daje nieujemne
`0.5 G_r |Delta mu_s,perp|^2`, a część `G_i` dokładnie zero. Test nie może
sprawdzać wyłącznie charge work. Model publikuje:

- incoming normal spin flux;
- reflected/backflow flux;
- absorbed transverse flux;
- flux i produkcję każdego ramienia rezerwuaru SML;
- torque przekazany magnetyzacji.

Test bilansu wymaga zgodności tych wielkości do tolerancji solvera oraz
nieujemności pełnej produkcji dla losowych dopuszczalnych śladów.

### 6.5. Zewnętrzne warunki spinowe

Wspierane typy:

- `SpinInsulating`: `n_i Q_{ia}=0`;
- `SpinSink`: `mu_s=0`;
- `SpecifiedSpinPotential`: `mu_s=mu_bc(t)`;
- `SpecifiedSpinFlux`: `n_i Q_{ia}=q_bc(t)`;
- `PeriodicSpin`: periodyczne `mu_s` i flux.

Domyślne `SpinInsulating` jest dozwolone tylko, gdy użytkownik nie zdefiniował kontaktu spinowego. UI ma pokazywać ten wybór jawnie.

### 6.6. Zakres poprawności drift-diffusion

Model jest dyfuzyjny i wymaga lokalnej relacji konstytutywnej. Planner ma ostrzec albo odrzucić problem, gdy rozmiary struktur są porównywalne ze średnią drogą swobodną, transport jest balistyczny albo interfejs wymaga kwantowego modelu tunelowego.

---

## 7. Dynamiczne pole Oersteda

### 7.1. Definicja magnetokwasistatyczna

Pole od chwilowego zachowawczego prądu:

```text
H_oe(x,t) = 1/(4 pi) integral_{Omega_c}
            J_c(x',t) x (x-x') / |x-x'|^3 dV'.
```

To jest pole `H` w A/m; nie zawiera `mu0`. Pole magnetyczne `B_oe=mu0 H_oe` w próżni.

Równoważny kontrakt pola:

```text
curl H_oe = J_c,
div(mu0 H_oe) = 0
```

poza wkładem magnetyzacji, który należy do demag, nie do Oersteda.

### 7.2. Energia i obserwable

Dla zadanego zewnętrznego źródła prądu chwilowy człon Zeemana wynosi:

```text
E_oe(t) = -mu0 integral_{Omega_m} M_s m dot H_oe(t) dV.
```

Nie występuje czynnik `1/2`. Dla wymuszenia czasowego całkowita energia magnetyczna nie jest zachowana, lecz raportowany `oersted_zeeman_energy` musi odpowiadać dokładnie polu użytemu w RHS.

W M2, gdy `J_c=J_c(m)` przez AMR/iSHE, powyższa wielkość nie jest funkcjonałem
wariacyjnym generującym cały coupled field. Jest publikowana jako
`oersted_zeeman_work_snapshot` z
`energy_semantics=coupled_diagnostic_nonvariational` i jest wykluczona z
`E_total` oraz konserwatywnych minimizerów. Nazwa `oersted_zeeman_energy` i
`energy_semantics=external_zeeman` są dozwolone tylko dla prądu niezależnego od
`m`.

### 7.3. Metody realizacji

| Metoda | Rola | Ograniczenia |
|---|---|---|
| `analytic_cylinder` | szybki orakl i model specjalny | tylko jawna geometria; dowolna oś musi być rzeczywiście obsłużona |
| `fdm_fft_cell_integrated` | produkcyjny FDM open-boundary | regularna siatka, zero-padding, brak PBC bez dedykowanego Ewalda |
| `direct_biot_savart` | niezależny mały oracle FDM/FEM | koszt O(N^2), dokładna kwadratura near-field |
| `fem_vector_potential` | produkcyjny FEM | airbox/open-boundary convergence, gauge constraint |

FDM wykorzystuje antysymetryczny, cell-integrated kernel w stylu
Krügera/NeuralMag: near-field z całką po komórce, far-field z kontrolowanym
przybliżeniem. Punktowy dipol w komórce obserwacyjnej jest niedopuszczalny.
Źródło FFT także musi reprezentować globalnie zamknięty obwód; lokalnie
zbilansowana belka z dwiema elektrodami bez return path nie jest poprawnym
źródłem Biota–Savarta.

### 7.3.1. Niezmiennik zamknięcia obwodu

Każda metoda Oersteda konsumuje niemutowalny snapshot jednego fizycznego
prądu, wraz z identyfikatorem geometrii, czasu etapu, envelope, materiałów,
warunków brzegowych i zamknięcia obwodu. Dopuszczalne realizacje closure:

- `closed_geometry` z jawnie zmeshowanym powrotem i source-cut albo
  periodycznym spadkiem potencjału; pojedynczo wartościowany potencjał `H1` na
  zamkniętej pętli nie może podtrzymać niezerowej siły elektromotorycznej;
- `external_lead_extension` rozwiązane razem z urządzeniem w jednym problemie
  minimum-dissipation, ponieważ impedancja przewodów zmienia prąd urządzenia;
- certyfikowany import bezdywergentnego pola `H(div)` z pełnym bilansem;
- `analytic_return_path` wyłącznie jako jawny, addytywny składnik pola dla
  OE-F1/FDM-direct. Nie spełnia on warunku zgodności prawej strony OE-F2 i nie
  może udawać objętościowego prądu RT0.

### 7.3.2. OE-T0 — konserwatywny widok prądu `RT0/H(div)`

OE-T0 jest obowiązkowym prerequisite obu metod FEM. Nodalne
`-sigma grad(V)`, wizualizacyjna interpolacja albo samo
`GridFunction::ProjectCoefficient` nie są konserwatywnym widokiem prądu.
`ProjectCoefficient` może zbudować tylko kandydat `j_raw`; końcowe stopnie RT0
powstają z ważonego problemu więzów.

Po eliminacji zadanych normalnych trace DOF rozwiązujemy:

```text
min_j  0.5 (j-j_raw)^T M_W (j-j_raw)
subject to
    B j = b_div,          # element-wise divergence/charge balance
    C j = b_pair,         # source-cut, periodic i interface face pairs
    T j = b_terminal,     # authored terminal/electrode fluxes

D = [B; C; T],
[M_W  D^T] [j     ] = [M_W j_raw],
[D     0 ] [lambda]   [g        ].
```

`M_W` jest dodatnio określoną macierzą masy RT0; baseline minimum-dissipation
używa w przewodniku wagi `W=sigma^-1`, z wersjonowaną regułą dla tensorowej
przewodności. Wiersze i kolumny są skalowane fizycznie przed solve. Produkcyjny
solve jest stabilnym solverem układu siodłowego; dokładny Bareiss/`cpp_int`
służy tylko do małych certyfikatów rzędu i testów topologii.

Redukcja zależnych wierszy jest deterministyczna i komponentowa:

1. komponent rozszerzony łączy elementy przez twarze wewnętrzne oraz jawne
   pary source-cut/interface;
2. komponent bez zachowanej kolumny terminala/elektrody jest `rank-closed` i
   ma dokładnie jedną lewą zależność bilansu; pomijany jest jeden kanoniczny
   wiersz divergence;
3. komponent posiadający terminal ma wszystkie wiersze divergence typu
   `Generic` i nie otrzymuje sztucznego anchor omission;
4. komponenty zamknięte, terminalowe i mieszane mają osobne exact-rank tests;
5. raport używa nazwy `left_nullity=row_count-rank`, a nie niejednoznacznej
   `nullity`, która zwykle oznacza `column_count-rank`.

Certyfikat niezależny od solvera obejmuje co najmniej: lokalny residual
dywergencji każdego elementu, sklejone normalne fluxy, bilans każdego
terminala, bilans każdego komponentu obwodu, normę korekty
`||j-j_raw||_MW`, scaled KKT residual, rangę, pominięte wiersze, stabilne
rekordy RT0, digest źródła oraz cache identity. Wymagane są także symmetry,
inertia/inf-sup i conditioning checks na małych problemach.

Tor MPI reference nie może być flagą metadata. Rank 0 rekonstruuje globalną
topologię, przewodność i zaakceptowany globalny potential snapshot, wykonuje
globalny OE-T0 build/solve, po czym broadcastuje głęboko posiadany globalny
widok RT0, rekordy, certificate bytes oraz identity. Test MFEM bez METIS używa
jawnego deterministycznego `CartesianPartitioning` i wymaga byte identity dla
`mpirun -n 1` oraz `-n 2`.

Stan audytu: aktualny `ConservativeCurrentView::Build` kończy się
`ProjectCoefficient`; błędnie oznacza terminalowe divergence rows jako
`ClosedComponentDivergence`, a `reference_mpi_gather_broadcast` nie wykonuje
komunikacji. OE-T0 pozostaje `semantic_only` i czerwony.

### 7.3.3. OE-F1 — bezpośrednia całka po tetraedrach

OE-F1 konsumuje dokładnie snapshot OE-T0. Na afinicznym tetraedrze RT0 prąd
jest polem afinicznym; całka Biota–Savarta zachowuje tę zmienność, zamiast
zastępować element wartością w centroidzie. Dla punktu obserwacji:

- far field używa wersjonowanej kwadratury o kontrolowanym błędzie;
- near field używa rekurencyjnego podziału z estymatorem;
- punkt wewnątrz lub na tetraedrze używa transformacji Duffy'ego albo
  Gauss–Jacobi usuwającej osobliwość całkowalną;
- zabronione są `self=0`, sztuczny cutoff i usuwanie całego source elementu;
- pole jest rzutowane do przestrzeni RHS przez spójną macierz masy `L2`, a
  observable publikuje tę samą projekcję.

OE-F1 jest niezależnym małym oraklem i workloadem zbieżności; nie staje się
produkcyjnym `O(N^2)` algorytmem przez sam zielony unit test.

### 7.3.4. OE-F2 — mixed `H_0(curl) x H1_0`

FEM produkcyjny rozwiązuje na domenie conductor+airbox. W standardowym
kontrakcie mikromagnetycznym przenikalność tego solve jest wszędzie `mu0`;
magnetyzacja należy do osobnego operatora demag i nie może zostać policzona
ponownie jako materiałowa przenikalność. Baseline relative-boundary exact
sequence brzmi:

```text
A in H_0(curl),       p in H1_0,

(mu0^-1 curl A, curl v) + (grad p, v) = (J_c, v)
(A, grad q) = 0

for all v in H_0(curl), q in H1_0,
B_oe = curl A,
H_oe = mu0^-1 B_oe.
```

`H_0(curl)` narzuca `n x A=0`, a `H1_0` narzuca `p=0` na zewnętrznej granicy;
baseline nie ma zero-mean constraint. Wariant naturalny
`H(curl) x H1/R` z zerową średnią i właściwymi naturalnymi BC jest osobnym
`operator_version`, osobną analizą jądra i osobną kwalifikacją.

Gradientowy multiplier nie usuwa harmonicznych pól w domenie wielospójnej.
Mesh/topology preprocessing wyznacza dyskretną kohomologię; solver dodaje
kanoniczne harmonic constraints albo kończy się fail-closed. Compatibility
test sprawdza, że źródło OE-T0 leży w zakresie operatora, w tym zerowy flux
przez outer boundary i zgodność z każdym gradientowym testem.

Układ jest symetrycznie nieokreślony przy powyższym baseline. Mały direct solve
jest oraklem; produkcja używa MINRES z poprawnym blokowym preconditionerem i
AMS dla `H(curl)`, a GMRES wyłącznie gdy realizacja utraci symetrię. Raportuje
się osobno setup/apply preconditionera, residual każdego bloku, constraint
residual, liczbę iteracji i conditioning proxy.

Zewnętrzny warunek `n x A=0` nie jest przedstawiany jako dokładny open
boundary: kwalifikacja wymaga co najmniej trzech rosnących airboxów,
ekstrapolacji błędu na domenie magnetycznej oraz porównania z OE-F1.
Materialne `mu_r != 1` wymaga osobnej publikacji, aby nie podwójnie policzyć
odpowiedzi magnetycznej. `mfem_bridge.cpp` pozostaje adapterem; spaces,
assembly, BC, solve, projection i telemetry mają dedykowanych właścicieli.

### 7.4. Granica reżimu quasistatycznego

Dla częstotliwości charakterystycznej `omega` należy raportować:

```text
r_disp = omega epsilon / sigma,
delta = sqrt(2/(mu sigma omega)),
r_skin = d/delta,
kL = omega L sqrt(mu_env epsilon_env).
```

Wartości graniczne są definiowane ciągle dla DC:

```text
omega = 0  =>  r_disp=0, delta=+infinity, r_skin=0, kL=0.
```

`mu` w skin depth jest lokalną przenikalnością przewodnika właściwą dla
modelowanego pasma. `mu_env,epsilon_env` należą do medium propagacji; nie wolno
zastępować ich bezwarunkowo `mu0,epsilon0`, chyba że otoczenie jest próżnią lub
udokumentowanym ośrodkiem niemagnetycznym o tych parametrach.

Model elektro/magnetokwasistatyczny wymaga jednocześnie
`r_disp << 1`, `r_skin << 1` i `kL << 1`. Progi są parametrami wersjonowanego
validity policy, z rozdzielonym ostrzeżeniem i odrzuceniem. Startowy, świadomie
konserwatywny policy to:

```text
warning: r_disp>1e-2 or r_skin>0.03 or kL>0.03,
strict reject: r_disp>0.1 or r_skin>0.1 or kL>0.1.
```

Nie są to uniwersalne stałe fizyczne: przed promocją do `validated` wymagają
kalibracji względem rozwiązania MQS/full-wave dla reprezentatywnych geometrii,
kontrastów i pasm. `omega` oznacza najwyższą istotną częstość kątową źródła,
nie tylko nośną. Pulse, PWL i tabulated drive muszą mieć skończony rise time
albo zadeklarowane `bandwidth_hz`; idealny skok o nieograniczonym paśmie jest
poza ścisłym kontraktem dynamicznego Oersteda.

### 7.5. Czas etapowy i cache

Dla RK każde wywołanie RHS używa:

```text
t_stage = t_n + c_i dt,
m_stage = m_i,
J_stage = J_c(m_i, t_stage),
H_oe_stage = H[J_stage].
```

FSAL jest ważny tylko, gdy klucz cache obejmuje zaakceptowany czas, stan `m`, revision transportu i envelope. Odrzucony krok nie może publikować pola, inkrementować committed revision ani pozostawiać przeliczonego transportu jako accepted state.

---

## 8. Sprzężenie czasowe M1–M3

### 8.1. M1 — quasistatic one-way

M1 wspiera isotropic charge transport niezależny od `m`, ale spin solve może zależeć od etapowego `m` przez `R_J`, `R_phi` i interface mixing.

Tryb strict:

1. wyznacz `J_c(t_stage)`;
2. wyznacz `H_oe(t_stage)` albo przeskaluj bazową mapę;
3. rozwiąż steady spin diffusion dla `m_stage`;
4. zbuduj transport torque;
5. zbuduj pełny jawny RHS Gilberta;
6. po akceptacji kroku odśwież observables w `t_{n+1}`.

`accepted_step` refresh spin torque jest dozwolony tylko jako jawny tryb przybliżony i nie może zachować formalnego rzędu integratora bez osobnego badania zbieżności.

### 8.2. M2 — bidirectional quasistatic

Przy zamrożonych `m_stage`, czasie, źródle, współczynnikach materiałowych i
liniowych prawach interfejsu AMR/PHE/AHE, direct SHE, iSHE, spin diffusion,
mixing conductance oraz algebraiczny SML v2 tworzą **liniowy, afiniczny i
zwykle niesymetryczny** problem blokowy:

```text
[ A_V(m_stage)       B_mu_to_charge(m_stage) ] [V   ] = [b_V],
[ C_charge_to_mu(m_stage) A_mu(m_stage)       ] [mu_s]   [b_s].
```

Baseline używa GMRES/FGMRES z blokowym preconditionerem oraz niezależnym
przeliczeniem residuali charge, spin, interface i electrode balance. Picard,
Newton lub JFNK są dozwolone wyłącznie, gdy aktywne prawo jest naprawdę
nieliniowe, na przykład przewodność zależy od temperatury/pola, interface ma
nieliniową charakterystykę albo transport jest rozwiązywany monolitycznie z
niezamrożonym `m`. Planner zapisuje przyczynę wyboru nieliniowego solve i nie
może wywnioskować jej z samej obecności AMR lub iSHE.

Kryteria każdego solve etapowego:

- normy residual charge i spin;
- bilans prądów elektrod;
- bilans spin angular momentum;
- residuale charge/spin/interface są bezwymiarowo skalowane osobnymi normami
  fizycznymi i mają absolutny floor dla problemów o zerowym źródle;
- dla wariantu nieliniowego dodatkowo raportowane są względne zmiany `J_c`,
  `mu_s` i surface DOF oraz contraction/Newton history;
- błąd inexact transport jest estymowany **dla tego samego**
  `(m_stage,t_stage,source_revision)`, przez ponowny solve z zaostrzoną
  tolerancją, kontrolowany residual-to-torque bound albo udowodnione
  contraction bound:

```text
e_T = ||T_transport^tight-T_transport^accepted||_m
      or certified_residual_to_torque_bound,
dt e_T <= eta_transport max(LTE_m, LTE_floor).
```

Różnica torque między dwoma etapami RK albo między stanem accepted i stage
jest zmianą fizycznego rozwiązania, nie estymatorem błędu solve, i nie może być
używana jako `e_T`.

Brak zbieżności lub brak certyfikatu inexact solve oznacza odrzucenie kroku
LLG, a nie użycie ostatniej iteracji bez ostrzeżenia.

### 8.3. M3 — transient spin accumulation

Tryb transient wprowadza stiff diffusion/reaction system. Nie wolno podłączyć go do istniejącego DP45 jako algebraicznego pola.

Produkcyjny baseline `coupled_imex_ark2` zamraża konkretnie metodę
ARS(2,3,2). Dla addytywnego układu `y'=F(y,t)+G(y,t)`, gdzie `G` zawiera
stiff spin diffusion/reaction, a `F` jawny LLG i jawne lokalne sprzężenia:

```text
gamma = (2-sqrt(2))/2,
delta = -2 sqrt(2)/3,

A_exp = [[0,     0,       0],
         [gamma, 0,       0],
         [delta, 1-delta, 0]],
b_exp = [0, 1-gamma, gamma],

A_imp = [[gamma,   0],
         [1-gamma, gamma]],
b_imp = [1-gamma, gamma],

c_exp = [0, gamma, 1],
c_imp = [gamma, 1].
```

Implicit tableau jest wyrównane z trzema stage jawnej metody przez początkowy
zerowy stage/kolumnę, czyli w kodzie wspólnego indeksowania:

```text
A_imp_padded = [[0, 0,       0],
                [0, gamma,   0],
                [0, 1-gamma, gamma]],
b_imp_padded = [0, 1-gamma, gamma],
c = [0, gamma, 1].
```

Implementacja i artefakt publikują pełne
`A_exp,A_imp_padded,b_exp,b_imp_padded,c`, aby nazwa `ARK2` nie maskowała
innego schematu.
Każdy stage używa wspólnego `t_stage`, `m_stage`, źródła oraz wersji operatora.

Adaptacja baseline używa step doubling: jeden pełny krok i dwa półkroki z tego
samego committed state. Dla rzędu `p=2` estymator to różnica końców podzielona
przez `2^p-1=3`; po akceptacji stanem jest dokładniejszy wynik dwóch półkroków.
Odrzucenie przywraca atomowo `m`, `V`, `mu_s`, surface DOF SML, envelope event
index, cache, solver history, RNG i telemetry. Krok jest wcześniej przycinany
do najbliższego zdarzenia napędu; estymator nie może przekraczać nieciągłości.

Opcjonalne subcycling transportu jest niedozwolone bez kontroli błędu i
interpolacji zachowującej rząd. BDF2/fully implicit pozostaje małym oraklem
tylko dla stałego kroku; używa backward Euler do bootstrapu oraz po każdej
zmianie `dt` lub restarcie, dopóki osobno nie zostanie opublikowane i
zwalidowane variable-step BDF2.

Planner musi odrzucić `transient_spin + explicit_dp45` dopóki nie istnieje dowód kompatybilnego partitioned scheme.

---

## 9. Dyskretyzacja FDM

### 9.1. Rozmieszczenie niewiadomych

- `m`, `M_s`, `V`, `mu_s`, parametry materiałowe: cell-centered;
- `J_c` i normalne składowe `Q`: face-centered fluxes;
- torque i `H_oe`: cell-centered;
- maska magnetyczna i przewodząca są niezależne.

Taki układ pozwala zachować dyskretny bilans prądu przez sumę fluxów ścian.

### 9.2. Charge finite volume

Dla komórki `K`:

```text
sum_{f in boundary K} A_f J_c,f dot n_Kf = 0.
```

Na wewnętrznej twarzy `f=K|L` ortogonalnej siatki podstawowy flux M1 jest:

```text
sigma_f = 2 sigma_K sigma_L/(sigma_K+sigma_L),
J_c,f dot n_Kf = -sigma_f (V_L-V_K)/d_KL.
```

Ta sama wartość ze znakiem przeciwnym trafia do bilansu `L`. Tensorowe Hall
terms wymagają pełnego reconstruction stycznych gradientów i pojedynczego
konserwatywnego fluxu; nie wolno włączyć ich przez harmoniczne uśrednienie
skalarne.

### 9.3. Spin finite volume

Dla każdej składowej spinu:

```text
C_s V_K d(mu_s,K)/dt
 + sum_f A_f Q_f dot n_Kf
 = -V_K (R_sf+R_J+R_phi)_K.
```

Podstawowy dyfuzyjny flux na `K|L`:

```text
Q_diff,f,a dot n_Kf = -0.5 sigma_s,f
                      (mu_s,L,a-mu_s,K,a)/d_KL.
```

`sigma_s,f` jest średnią harmoniczną. Na twarzy wewnątrz jednego materiału
pełny flux M1 v1 jest:

```text
q_f,a = Q_f,ia n_i
      = Q_diff,f,a
        + P_f sigma_f (E_f dot n_f) m_f,a
        + theta_SH,f sigma_f n_i epsilon_ika E_f,k.
```

`m_f` jest upwind względem podpisanego `P_f sigma_f E_f dot n_f` w
`fv_spin_upwind_v1`; `fv_spin_central_reference_v1` używa
`0.5(m_K+m_L)` wyłącznie jako accuracy oracle. `P_f` jest ograniczoną średnią
materiałową, a na skoku materiałowym flux nie jest uśredniany tym wzorem —
zastępuje go jawne interface law.

`E_f` używa `structured_cross_gradient_v1`: składowa normalna pochodzi z
różnicy dwóch komórek, a każda składowa styczna jest średnią dwóch centralnych
gradientów komórkowych. Daje to stencil 9-punktowy w 2D i 27-punktowy w 3D;
na zewnętrznym brzegu stosowana jest jawna one-sided reconstruction zgodna z
BC. Direct SHE i polarized-current contributions są sumowane przed wpisaniem
jednego orientowanego fluxu ze znakami przeciwnymi do obu komórek.

Interfejs materialny używa jednego fluxu ze znakiem przeciwnym dla obu komórek. Mixing conductance jest flux BC na twarzy, nie objętościowym source dodanym niezależnie po obu stronach.

### 9.4. Zhang–Li na FDM

Kanoniczny operator jest advective, nie conservative. Dla komórki `K`:

```text
(D_u m)_K = 1/V_K sum_f A_f (u_f dot n_Kf)(m_f-m_K),
v_perp = D_u m - m_K(m_K dot D_u m).
```

`u_f` wynika z orientowanego face current i face values `P/M_s`. Odejmowanie
`m_K` zapobiega dodaniu sztucznego `m div(u)` przy przestrzennie zmiennym
`P/M_s`. `zl_upwind_first_order_v1` wybiera `m_f` z komórki upwind i jest
produkcyjnym baseline. `zl_central_reference_v1` używa średniej centralnej i
jest oraklem drugiego rzędu na gładkim interiorze. MUSCL/TVD jest odrębnym
przyszłym formula version dopiero po wyborze konkretnego limitera.

Po transformacji Gilberta jawny wkład do RHS jest:

```text
T_ZL,explicit = [-(1+alpha beta)v_perp
                 +(beta-alpha)m x v_perp]/(1+alpha^2).
```

Operator musi jawnie definiować inflow data, zero-gradient outflow, granicę
maski i PBC w każdej osi. Należy odtworzyć test z
`external_solvers/amumax/src/test/zhangliPBC.mx3` bez kopiowania implementacji.
Migracja z obecnego czynnika `1/(1+beta^2)` otrzymuje osobny
`formula_version=zhang_li.legacy_fullmag.v0`; nowy v1 wymaga testu before/after
i tabeli konwersji do MuMax3.

### 9.5. FDM Oersted

- `J_c` powstaje jako flux face-centered. Wersjonowana rekonstrukcja do mapy
  komórkowej używanej przez Oersted jest dla osi `x`:

```text
J_K,x = 0.5 (J_x,K-1/2 + J_x,K+1/2),
```

  analogicznie dla `y,z`, z globalnie dodatnimi orientacjami twarzy. Oersted
  konsumuje wyłącznie opublikowane `J_charge` po tej rekonstrukcji; nie liczy
  ponownie `sigma E`. Dla niekartezjańskiego źródła potrzebna jest osobna
  conservative least-squares reconstruction;
- kernel `K_{alpha beta}` jest antysymetryczny;
- dla `r=x-x'`:

```text
K(r) = [ 0    k_z -k_y
        -k_z  0    k_x
         k_y -k_x  0   ],
k_a = 1/(4 pi) integral_cell r_a/|r|^3 dV',
K(0)=0.
```

- convolution używa zero-padding co najmniej do podwojonego rozmiaru w każdej nieperiodycznej osi;
- źródłem jest `J_c` w komórkach przewodnika, nie tylko komórkach magnetycznych;
- conductor mask jest stosowana przed FFT;
- brak alokacji i budowy planu FFT per RHS;
- aktualizacja amplitudy i czasu jest stage-local;
- PBC bez dedykowanego kernela jest fail-closed;
- singleton `nz=1` jest wspierany i ma osobny oracle;
- formula version zamraża near/far cutoff, `2N` padding/crop, normalizację FFT,
  R2C layout i precision kernela;
- cache key obejmuje `dx`, shape, origin, conductor/magnet union grid, mask
  revision, cutoff i precision.

### 9.6. Solvery FDM

Poniższe nazwy są **docelowymi engine IDs**, a nie opisem obecnego kodu.
Aktualna gałąź ma reference CPU z restarted GMRES i lokalnym block-Jacobi;
nie wykazuje jeszcze AMG/ILU ani produkcyjnego ownership w `backends/fdm`.
Provenance nie może publikować docelowej nazwy engine, dopóki odpowiadający
operator, preconditioner i gate nie istnieją.

Docelowy CPU double oracle/production reference:

- `fdm_charge_cg_matrix_free_v1`: CG/AMG dla symetrycznego M1;
- `fdm_charge_spin_block_gmres_v1`: GMRES dla Hall/iSHE M2;
- `fdm_spin_block_gmres_csr_v1`: block GMRES + multigrid/ILU dla M1 spin;
- `fdm_oersted_fft_open_v1`: CPU FFT oracle/production reference;
- residual fizyczny liczony niezależnie od residual biblioteki;
- deterministyczna kolejność redukcji w testach oracle.

CUDA:

- persistent device buffers;
- matrix-free stencil albo jawny sparse operator zależnie od fazy;
- zero transferów wektorów i operatorów w hot loop strict GPU; ograniczone
  scalar residual reductions/readback są dozwolone, wersjonowane i raportowane;
- FP64 przed FP32;
- osobna kwalifikacja FP32 dla wysokiego kontrastu `sigma`, małych `lambda` i cienkich warstw.

Nazwane engines GPU to co najmniej `fdm_charge_cg_cuda_v1`,
`fdm_spin_block_gmres_cuda_v1` i `fdm_oersted_cufft_open_v1`. Planner zapisuje
wybrany engine; wybór matrix-free/CSR nie pozostaje niewidocznym detalem.

---

## 10. Dyskretyzacja FEM/MFEM

### 10.1. Przestrzenie

| Niewiadoma | Przestrzeń bazowa | Uwagi |
|---|---|---|
| `m` | continuous H1 P1 vector na `Omega_m` | zgodna z istniejącym FEM; więzy w węzłach |
| `V` | subdomain/broken H1 P1 na `Omega_c` | niezależne ślady na oporowym interfejsie; conforming tylko dla transparentnego |
| `mu_s` | subdomain/broken [H1 P1]^3 na `Omega_c` | niezależne ślady dla mixing/SML; conforming tylko dla transparentnego |
| `A` | H(curl) Nedelec na conductor+airbox | Oersted vector potential |
| `p_gauge` | H1_0 w baseline relative-boundary | constraint dla `A`; naturalny H1/R to osobny operator |

Wyższy rząd może być dodany później, lecz capability musi wskazywać faktycznie zwalidowany order.

### 10.2. Słaba postać charge

Dla testu `w`:

```text
integral grad(w) dot J_c(V,mu_s,m) dOmega
 = integral_boundary w j_n dGamma.
```

Dirichlet electrodes są nakładane przez essential true dofs. Total-current
electrode wymaga dodatkowej niewiadomej potencjału elektrody albo constraint
row. Dla transparentnego interfejsu ślady subdomen są związane constraintem lub
mortar. Dla skończonych `G_up/G_down` pozostają niezależne, a interface
bilinear form realizuje prawa z rozdziału 6.4. Globalne conforming H1, które
zerowałoby `Delta V`, jest zabronione dla takiego interfejsu.

### 10.3. Słaba postać spin

Dla testu wektorowego `v`:

```text
integral v dot C_s partial_t(mu_s) dOmega
 - integral grad(v) : Q dOmega
 + integral v dot (R_sf+R_J+R_phi) dOmega
 + integral_Gamma v dot q_out dGamma = 0.
```

Znaki boundary flux muszą wynikać z jednej integracji przez części. Interface
mixing jest składany raz na orientowanej powierzchni wspólnej z dwoma
niezależnymi śladami. Implementacja bazowa używa subdomain spaces i mortar
coupling; Nitsche/DG wymaga osobnej formula version i badania stabilności.
Materiały mogą być piecewise constant per element lub polem o jawnej
przestrzeni.

Po linearyzacji steady M1 ma blokowo-trójkątny układ:

```text
[ A_V              0 ] [V   ] = [b_V],
[ C_charge_to_spin A_mu] [mu_s]   [b_s],
```

więc charge można rozwiązać przed spin. Pełny M2 ma oba sprzężenia:

```text
[ A_V       B_spin_to_charge(m) ] [V   ] = [b_V],
[ C_charge_to_spin(m) A_mu(m)     ] [mu_s]   [b_s],
```

i jest niesymetryczny. Planner nie może użyć CG dla pełnego bloku M2.

### 10.4. Zhang–Li FEM

Obecna P1 gradient + mass-lumped projection pozostaje punktem startowym, ale wymagane są:

- jawny wybór advective vs conservative weak form;
- inflow boundary condition;
- consistent mass oracle i lumped production comparison;
- badanie względem orientacji tetraedrów;
- SUPG/CIP tylko po wykazaniu oscylacji i z wersjonowanym parametrem stabilizacji;
- ściana domenowa 1D/3D jako workload zbieżności.

### 10.5. Torque lokalne FEM

Prescribed SOT i Slonczewski są składane jako `L2` projection do nodal RHS z lokalnym `M_s`, `alpha` i maską. Transformacja Gilberta używa tego samego backend-neutralnego wzoru co FDM. `mfem_bridge.cpp` tylko przekazuje descriptor; fizyka należy do `cpu/mfem/interactions/*`.

### 10.6. Oersted vector-potential FEM

Ta sekcja jest skrótem kontraktu OE-T0/OE-F1/OE-F2 z rozdziału 7.3, nie
alternatywną definicją. OE-F2 nie może konsumować nodalnego `-sigma grad(V)`;
prawą stroną jest wyłącznie certyfikowany widok OE-T0 w `RT0/H(div)`. OE-F1
używa tego samego snapshotu jako niezależny oracle.

Baseline OE-F2 ma postać:

```text
A in H_0(curl), p in H1_0,

(mu0^-1 curl A, curl v) + (grad p,v) = (J_RT0,v),
(A,grad q) = 0.
```

Po dyskretyzacji jest to symetryczny układ siodłowy. Wymagane:

- wcześniejszy zielony gate OE-T0 wraz z rank/component/MPI certificate;
- airbox extent study;
- boundary-condition study;
- Hypre AMS + blokowo preconditioned MINRES; GMRES tylko dla jawnie
  niesymetrycznego operator version;
- OE-F1 z singular/near/far tetra quadrature jako niezależny oracle;
- projekcja `H_oe` do przestrzeni obserwowalnej bez zmiany pola użytego w RHS;
- cache macierzy tylko, gdy geometria i `mu0` są niezmienne.

Baseline narzuca `n x A=0` oraz `p=0` na zewnętrznej granicy i **nie** ma
zero-mean constraint. Wariant `H(curl) x H1/R` z naturalnymi BC i zerową
średnią jest osobną formułą, jądrem i kwalifikacją. W domenie wielospójnej
gradientowy multiplier nie usuwa dyskretnych pól harmonicznych: preprocessing
wyznacza kohomologię, dodaje kanoniczne harmonic constraints albo kończy się
fail-closed. Jednostki:
`A [T m]`, `p_gauge [A/m]`. Pole `mu0^-1 curl(A)` jest projekowane spójną
macierzą masy `L2` do tej samej nodalnej przestrzeni pola, która trafia do RHS;
observable publikuje dokładnie tę projekcję, a nie oddzielny reconstruction.

Aktualny kod gałęzi nie spełnia prerequisite OE-T0, dlatego obecność klas
OE-F2 lub zielony build nie stanowi jeszcze wykonywalnego dowodu tej sekcji.

### 10.7. LLG integrator FEM

Istniejący explicit RK pozostaje dla M0–M2 pod warunkiem stage-consistent transport. Równolegle należy utrzymać tangent-plane/implicit reference dla badania stabilności. Każdy integrator publikuje:

- liczbę zaakceptowanych i odrzuconych kroków;
- czasy etapów;
- liczbę solve transportowych;
- residual każdego solve;
- norm error estimator;
- maksymalny błąd `||m|-1|` przed i po projekcji.

---

## 11. Wzorce z external_solvers i sposób ich wykorzystania

### 11.1. MuMax3/amumax

Relevantne pliki:

- `external_solvers/3/cuda/slonczewski2.cu`;
- `external_solvers/3/cuda/zhangli2.cu`;
- odpowiedniki w `external_solvers/amumax`;
- `external_solvers/amumax/src/test/zhangliPBC.mx3`.

Do wykorzystania:

- efektywność kątowa Slonczewskiego;
- jawne zachowanie `fixedLayerPosition` jako konwencji stosu;
- PBC-aware stencil Zhang–Li;
- porównanie transformacji Gilberta.

Tabela adaptera Zhang–Li do zachowania kernela MuMax3 jest obowiązkowa. Dla
`xi=beta` i oznaczeń `M` — MuMax3, `F` — canonical Fullmag, warunek zgodności
prefaktora jest:

```text
P_M J_M/(1+beta^2) = -(g/2) P_F J_F,
MuMax field-like STTorque [T] * gamma_e -> rate [1/s].
```

Minus jest konwersją konwencji przepływu, nie dopasowaniem testu. Oracle
zachowania stanowi `external_solvers/3/cuda/zhangli2.cu`; rozbieżny stary TeX
nie może nadpisać kodu wykonywalnego. Tabela zostaje potwierdzona symbolicznym
macrospin/linear-texture testem w PR-01 przed migracją publicznego v1.

Do odrzucenia jako publiczny kontrakt:

- redukowanie fizyki do layoutu CUDA;
- niejawne konwencje znaku;
- parametry przeliczone do wewnętrznych prefaktorów bez provenance.

### 11.2. BORIS

Relevantne pliki:

- `STransport_Charge.cpp`;
- `STransport_Spin.cpp`;
- `STransport_Spin_GInterf.cpp`;
- `STransportCUDA*`;
- `SOTField.cpp` i CUDA;
- `Oersted.cpp`/`OerstedCUDA.cpp`.

Do wykorzystania:

- rozdział charge solve, spin solve i interface coupling;
- osobne flux laws dla N/F;
- przeliczanie Oersteda dopiero po zmianie transportu;
- obserwowalność potencjału, prądu, iteracji i interfacial torque;
- parity CPU/CUDA jako wymaganie architektoniczne.

Nie należy kopiować szerokiego supermesh/module ownership. Trzeba też zachować
negatywne lekcje: BORIS Oersted może użyć `sigma E` zamiast całkowitego `J_c`,
a jego ścieżka cienka `nz=1` nie jest właściwym oraklem. Fullmag zachowuje
ProblemIR, planner i backend-neutralne kontrakty.

### 11.3. NeuralMag

Relevantne pliki:

- `external_solvers/neuralmag/neuralmag/field_terms/oersted_field.py`;
- `external_solvers/neuralmag/neuralmag/common/convolution_setup.py`;
- `external_solvers/neuralmag/tests/unit/oersted_field_test.py`.

Do wykorzystania:

- cell-integrated antisymmetric Oersted kernel;
- open-boundary FFT;
- regular-grid node/cell projection dla FDM i porównawczego FIC;
- testy near/far field, linearity, symmetry, circulation, region mask, energy i PBC rejection.

### 11.4. COMSOL manual

Do wykorzystania:

- jawny one-way `Electric Currents -> STT` jako pierwszy milestone;
- funkcje przestrzenno-czasowe parametrów;
- staged multiphysics workflow;
- potrzeba jawnej wersji weak form w provenance.

Nie używać jako orakla SHE, Slonczewskiego ani dynamicznego Oersteda. Manual pozostawia SOT jako dowolny torque i nie definiuje spin diffusion.

`external_solvers/plus/src/physics/stt.cu` jest negatywnym przykładem wyboru
Zhang–Li XOR Slonczewski. Fullmag sumuje wszystkie aktywne, niezależne torque
modules; planner nie może cicho wybrać jednego.

---

## 12. Docelowy publiczny model Python

### 12.1. Klasy

```python
CurrentTransport(
    name,
    domain,
    model="prescribed_density" | "ohmic_quasistatic" | "magnetoresistive",
    drive=VoltageDrive(...) | TotalCurrentDrive(...) | CurrentDensityField(...),
    envelope=TimeEnvelope(...),
    materials={region: ChargeTransportMaterial(...)},
    electrodes=[Electrode(...)],
    coupling="one_way" | "bidirectional",
)

SpinDriftDiffusion(
    name,
    current_source="charge",
    domain=[...],
    mode="steady" | "transient",
    materials={region: SpinTransportMaterial(...)},
    interfaces=[SpinInterface(
        ...,
        spin_memory_loss=SpinMemoryLossReservoir(
            g_n=..., g_f=..., g_lattice=...,
            formula_version="sml_reservoir.fullmag.v2",
        ),
    )],
    boundaries=[SpinBoundary(...)],
    solver=SpinTransportSolver(...),
)

DriftDiffusionSpinTorque(
    name,
    transport_source="spin",
    targets=[...],
    projection="volumetric" | "interface_flux",
)

PrescribedSpinOrbitTorque(
    name,
    target,
    drive=SignedScalarDrive(J_signed=..., sigma_hat=...)
          | VectorCurrentDrive(
                current_source="charge",
                drive_direction=(...),
                interface_normal=(...),
            ),
    xi_dl=...,
    xi_fl=...,
    free_layer_thickness_m=...,
    formula_version="prescribed_sot.fullmag.v1",
)

OerstedField(
    name,
    current_source="charge",
    circuit_closure=ClosedGeometry(source_cut=..., return_region=...)
        | ExternalLeadExtension(leads=[...], terminal_pairing=[...])
        | AnalyticReturnPath(field_model=..., parameters={...}),
    method="auto" | "analytic_cylinder" | "fdm_fft_cell_integrated"
           | "direct_biot_savart" | "fem_vector_potential",
    refresh="stage_consistent" | "separable_scale" | "accepted_step_approx",
)
```

Warianty `drive` są wzajemnie wykluczającym tagged union. `SpinOrbitTorque`
staje się deprecated aliasem `PrescribedSpinOrbitTorque`. Eksport kanoniczny
zawsze używa nowej nazwy. `DriftDiffusionSpinTorque` przestaje przyjmować
własny `current_density` i `spin_polarization`; konsumuje nazwany solve.

`ClosedGeometry` wymaga jawnego source-cut, periodycznego EMF albo innej
wersjonowanej reprezentacji napędu zamkniętej pętli. `ExternalLeadExtension`
jest częścią tego samego solve minimum-dissipation, nie polem domalowanym po
solve urządzenia. `AnalyticReturnPath` może dodać jawne pole do
`direct_biot_savart`/odpowiedniego FDM oracle, lecz nie spełnia compatibility
OE-F2 i jest odrzucane z `fem_vector_potential`, dopóki nie dostarczy
certyfikowanego objętościowego `J_RT0`.

### 12.2. Minimalne parametry materiałowe

| Klasa | Parametr | Jednostka/walidacja |
|---|---|---|
| charge | `sigma` | S/m, finite; skalar `>0`, tensorowa część symetryczna dodatnio określona |
| charge | `sigma_parallel`, `sigma_perp` | S/m, >0 |
| charge | `sigma_ahe` lub `hall_angle` | jawna parametryzacja, finite |
| spin | `sigma_s` | S/m, `sigma_s-P^2 sigma>0` w FM |
| spin | `theta_sh` | podpisane, finite; typowo ograniczenie warning, nie sztuczny clamp |
| spin | `polarization_p` | [-1,1] |
| spin | `lambda_sf_m` | >0 |
| spin/FM | `lambda_j_m`, `lambda_phi_m` | >0 albo jawne disabled |
| transient spin | `spin_capacitance` | A s V^-1 m^-3, >0; tylko z rozpoznanym modelem podatności |
| transient spin | `density_of_states_per_spin` | J^-1 m^-3, >0; adapter `C_s=e^2 N_0` dla NM |
| transient spin | `capacitance_formula_version` | dokładnie wspierany enum, nie dowolny string |
| interface | `g_up`, `g_down`, `g_r`, `g_i` | S/m^2, finite; dyssypacyjne części nieujemne |
| interface SML v2 | `g_n`, `g_f`, `g_lattice` | S/m^2, `>=0`, przy czym `g_lattice>0`; lokalny `mu_R` |

### 12.3. Walidacja Python

- odrzuca NaN/Inf we wszystkich współczynnikach;
- odrzuca zerowe osie, normalne i polaryzacje;
- sprawdza referencje regionów, powierzchni i źródeł;
- sprawdza brak konfliktu BC;
- wymaga gauge dla charge solve;
- wymaga `C_s` lub jednoznacznego DOS adaptera dla transient i odrzuca ogólny
  FM bez macierzy/redukcji podatności;
- zabrania iSHE przy `coupling=one_way`;
- zabrania Oersted source bez pola `J_c`;
- zabrania źródła Oersteda bez globalnego circuit closure i source-cut/lead
  semantics właściwej dla wybranej metody;
- zabrania `AnalyticReturnPath` dla OE-F2 bez objętościowego `J_RT0`;
- odrzuca idealny pulse dla strict dynamic Oersted bez skończonego rise time
  albo bandwidth;
- przyjmuje tylko zatwierdzone `formula_version`; odrzuca
  `slonczewski.fullmag.v1` i `sml_surface_conductance.v1` dla nowych runów;
- wymaga `g_lattice>0` dla modelu nazwanego spin-memory loss i sprawdza
  nieujemność pełnej powierzchniowej części dyssypacyjnej;
- nie zgaduje grubości `t_F`, jeżeli nie wynika jednoznacznie z regionu;
- nie redukuje wektorów prądu do normy.

### 12.4. Round-trip invariant

`SceneDocument` jest kanonicznym dokumentem authoring, a `ProblemIR`
kanonicznym loweringiem wykonawczym. Nie tworzymy fałszywego ownership
`ProblemIR -> SceneDocument`. Wymagane są cztery sprawdzane ścieżki:

```text
Python -------------------------------> ProblemIR_A
Python sync -> SceneDocument ----------> ProblemIR_B
UI/OpenAPI -> SceneDocument -----------> ProblemIR_C
SceneDocument -> canonical Python -----> ProblemIR_D
```

Porównanie wymaga
`normalize(A)=normalize(B)=normalize(C)=normalize(D)` i obejmuje wszystkie
wartości, jednostki, formula versions, region refs, interface orientation, BC,
tolerancje, refresh policy i requested execution. Adaptery authoring są
dwukierunkowe tam, gdzie wspiera to publiczny kontrakt, a unsupported legacy
pole kończy się błędem, nie utratą.

---

## 13. ProblemIR, planner i runtime

### 13.1. ProblemIR

Nowe typy:

```text
SpinTransportModuleIR
ChargeTransportMaterialIR
SpinTransportMaterialIR
SpinInterfaceIR
SpinBoundaryIR
PrescribedSotIR
DriftDiffusionTorqueIR
OerstedSourceIR
```

Plan IR:

```text
Vec<ResolvedSpinTorquePlanIR>
SpinTransportPlanIR
ResolvedCurrentTransportPlanIR
ResolvedOerstedPlanIR
CoupledIntegratorPlanIR
```

Płaskie `stt_*`/`sot_*` mogą istnieć tylko w adapterze starego ABI. Nie wolno dodawać kolejnych szerokich pól do `Context`.

### 13.1.1. Wersjonowanie i migracja

PR-00 podbija wersję serializera ProblemIR i plan ABI. Migrator obsługuje
ostatnią opublikowaną wersję oraz nową v1 spin-transport:

| Stare pole | Nowa semantyka | Reguła |
|---|---|---|
| `spin_orbit_torque` | `prescribed_sot` | serde alias, canonical export nową nazwą |
| `fixed_layer_position` | `n_stack` | deterministyczna normalna z warningiem migracyjnym |
| legacy `P/(1+beta^2)` Zhang–Li | `formula_version=legacy_fullmag.v0` | bez cichej zmiany wyniku; explicit upgrade tool do v1 |
| `slonczewski.fullmag.v1` | `slonczewski.fullmag.v2` | brak cichej migracji: v1 ma prefaktor 2x za mały; stare artefakty tylko read-only, nowy run wymaga jawnego upgrade i ponownego solve |
| `sml_surface_conductance.v1` | `sml_reservoir.fullmag.v2` | brak automatycznej migracji bez `G_N,G_F,G_R` i surface reservoir semantics; fail-closed |
| płaskie `stt_*`/`sot_*` | `Vec<ResolvedSpinTorquePlanIR>` | adapter ABI tylko na wejściu starego runtime |
| placeholder drift diffusion | nowy `SpinTransportModuleIR` | brak automatycznej migracji bez domen, BC i materiałów; fail-closed |

Fixtures obejmują deserialize starego dokumentu, canonical export, ponowny
lowering i porównanie zachowanej semantyki. Usunięcie legacy readera wymaga
osobnego ADR i telemetry użycia.

### 13.2. Planner

Planner musi:

1. rozstrzygnąć regiony i orientowane interfejsy;
2. zachować podpisany `J_c`;
3. sprawdzić zgodność modelu z FDM/FEM, device i precision;
4. wybrać dokładnie jeden charge/spin transport engine;
5. rozstrzygnąć metodę Oersteda;
6. dobrać coupling cadence i integrator;
7. sprawdzić validity regime;
8. zapisać requested i resolved physics/execution;
9. odrzucić ukryte fallbacki;
10. wygenerować cache identity obejmujące envelope, BC, materiały, formula versions i mesh revision.

### 13.3. Capability vocabulary

Osobne capability IDs:

```text
spin_torque.zhang_li
spin_torque.slonczewski
spin_torque.prescribed_sot
transport.charge.ohmic
transport.charge.magnetoresistive
transport.spin.steady_drift_diffusion
transport.spin.transient_drift_diffusion
transport.spin.direct_she
transport.spin.inverse_she
transport.spin.mixing_conductance
transport.spin.memory_loss
transport.current.conservative_hdiv_view
field.oersted.dynamic
field.oersted.fdm_fft
field.oersted.fem_direct
field.oersted.fem_vector_potential
coupling.transport_llg.one_way
coupling.transport_llg.bidirectional
```

Każdy wpis używa istniejącego kanonicznego statusu:

```text
unsupported | source_visible | semantic_only | reference_executable
| production_executable | validated
```

oraz osobnych `implementation_state`, `validation_state`,
`validated_scope/workloads`, supported discretization/device/precision i
explicit limitations. `validated` jest workload- i lane-scoped; jeden właściciel
macierzy generuje projekcję do `status.capabilities`.

### 13.4. Runtime ownership

- current transport state należy do transport workflow;
- spin transport state należy do transport workflow;
- torque konsumuje transport output, nie posiada solvera;
- Oersted konsumuje `J_c`;
- integrator koordynuje stage evaluation, ale nie implementuje fizyki;
- backend context przechowuje uchwyty/descriptors, nie kolejne niezależne kopie parametrów;
- strict GPU wymaga device-resident state i device solve.

---

## 14. Observables, artefakty i provenance

### 14.1. Quantity catalog

| ID | Kształt | Jednostka |
|---|---|---|
| `V_electric` | scalar | V |
| `J_charge` | vector | A/m^2 |
| `spin_potential` | vector | V |
| `spin_current_tensor` | rank-2 3x3 | A/m^2 |
| `spin_flux_normal` | vector on interface | A/m^2 |
| `spin_memory_loss_flux` | vector on interface | A/m^2 |
| `spin_memory_loss_power_density` | scalar on interface | W/m^2 |
| `spin_memory_loss_power` | scalar integral | W |
| `torque_stt` | vector | 1/s |
| `torque_sot` | vector | 1/s |
| `torque_zhang_li` | vector | 1/s |
| `torque_slonczewski` | vector | 1/s |
| `torque_transport` | vector | 1/s |
| `torque_spin_total` | vector | 1/s |
| `H_oe` | vector | A/m |
| `oersted_zeeman_energy` | scalar integral | J |
| `oersted_zeeman_work_snapshot` | scalar diagnostic, nonvariational | J |
| `joule_power_density` | scalar | W/m^3 |
| `transport_dissipation_density` | scalar | W/m^3 |
| `current_conservation_residual_density` | scalar per cell | A/m^3 |
| `current_balance` | scalar per electrode/component | A |
| `oersted_source_certificate` | structured artifact | bez jednostki + wielkości SI per field |

`V_electric`, `J_charge`, `H_oe`, `torque_stt` i `torque_sot` zachowują
istniejące kanoniczne IDs. Nowe szczegółowe torque są składnikami; aggregate
IDs nie znikają. Tensor `spin_current_tensor` korzysta z istniejącego FMVP
`n_comp=9`, rozszerzonego o wersjonowane metadata:

```text
component_order=row_major_Q_ia
flow_axes=[x,y,z]
spin_axes=[x,y,z]
location=cell|node|interface
scope=...
```

Nie potrzeba równoległego kodeka. Wymagane są decoder, worker/hook i test
9-component payload dla FMVP v2/v3.

### 14.2. Solver telemetry

- residual initial/final;
- absolute/relative tolerance;
- iterations i nonlinear iterations;
- convergence reason;
- preconditioner;
- matrix/operator revision;
- transport refresh count per LLG step;
- solve time per phase;
- H2D/D2H bytes i transfer count;
- accepted/rejected outer steps;
- charge and spin balance errors;
- OE-T0 KKT/rank/component/MPI certificate oraz OE-F1/OE-F2 residuale bloków;
- estimator inexact transport przy tym samym stage state i event index.

### 14.3. Provenance

`metadata.json` i transport manifest przechowują:

- authored class/alias i canonical class;
- formula version;
- current convention;
- interface normal orientation;
- units of `mu_s` and `Q`;
- material parameters po normalizacji;
- requested/resolved discretization, device, precision i solver;
- BC, tolerancje, coupling mode i refresh policy;
- Oersted realization i airbox/kernel metadata;
- circuit closure, source-cut/lead identity, OE-T0/OE-F1/OE-F2 operator
  versions i certyfikat źródła;
- transient susceptibility/DOS adapter, pełne ARS tableau, event index i
  rollback schema;
- fallback reason — tylko w extended, nigdy ukryty w strict;
- workload/capability version;
- code commit, container image i external oracle version.

---

## 15. OpenAPI v2 i Control Room

### 15.1. Resource-first API

Typed projections nad jednym `SceneDocument` i `scene_revision`:

```text
/v2/sessions/current/model/current-transports
/v2/sessions/current/model/spin-transports
/v2/sessions/current/model/spin-interfaces
/v2/sessions/current/model/spin-torques
/v2/sessions/current/model/oersted-fields
```

Każdy collection route obsługuje `GET` list oraz `POST`; item route `/{id}`
obsługuje `GET`, `PATCH`, `DELETE`. Mutacje przyjmują `base_revision`, pełny
typed draft i zwracają `committed_scene`, nowy `scene_revision` oraz resource
identity. Stary revision daje `409 revision_conflict`. ETag/query identity
obejmuje session, scene revision, resource id i projection version. Mutacja
emituje resource invalidation event dla modelu, capabilities, plan preview i
zależnych field revisions.

Ciężkie pola pozostają na `/data/fields`; status zawiera tylko revisions,
capability summary i pointers do istniejących simulation/diagnostics resources,
nie kopię solver telemetry.

### 15.2. UI authoring

Explorer ma osobne węzły:

- Current Transport;
- Spin Transport;
- Spin Interfaces;
- Spin Torques;
- Oersted Fields.

Każdy semantic node ma własny Inspector. Formularze pokazują:

- prescribed vs solved;
- source, target i orientację interfejsu;
- podpisany prąd;
- jednostki SI przy każdym polu;
- formula version;
- requested/resolved lane;
- capability status i `validated_scope`;
- residual, freshness i ostatni refresh;
- unsupported/degraded reason.

Pełna macierz authoring parity jest bramką, nie checklistą ręczną. Każdy
kanoniczny leaf Python/SceneDocument ma odpowiadające pole OpenAPI, kontrolkę
UI, canonical export i normalized round-trip:

| Grupa | Parametry wymagane w Python i UI |
|---|---|
| current | `domain`, `model`, tagged `drive`, pełny `TimeEnvelope`, materiały i tensor przewodności, electrodes/BC, `coupling`, solver/tolerances |
| spin material | `sigma_s`, `theta_sh`, `source_convention`, `P`, `lambda_sf`, `lambda_J`, `lambda_phi`, steady/transient, `C_s` albo DOS/susceptibility formula |
| spin interface | orientacja/strony, `G_up`, `G_down`, `G_r`, `G_i`, model absorpcji, SML `G_N,G_F,G_R`, formula version |
| spin boundary | insulating/sink/specified potential/specified flux/periodic, vector envelope i orientacja normalnej |
| torque | source/target, `p`, `n_stack`, signed-current binding, `P`, `Lambda`, `epsilon_prime`, `t_F`, `xi_DL`, `xi_FL`, realization i formula version |
| Oersted | `current_source`, closure tagged union, source-cut/lead/return parameters, method, refresh, airbox/kernel/quadrature policy, MQS thresholds/bandwidth |
| coupling/integrator | stage cadence, linear/nonlinear engine, tolerances/error policy, ARS tableau version, adaptivity, event policy, checkpoint/restart |
| execution | requested discretization/device/precision/solver oraz widoczne resolved values/limitations |

Gate `spin_transport_authoring_parameter_parity_v1` generuje listę ścieżek
leaf z canonical schema, wykonuje wartości boundary/non-default, przechodzi
Python -> SceneDocument -> OpenAPI/UI -> canonical Python -> ProblemIR i
odrzuca brak, zmianę jednostki, utratę znaku, domyślne nadpisanie albo
nieznane pole. Pole tylko wyświetlane, lecz niemożliwe do authoringu/exportu,
nie spełnia parity.

UI nie może udostępnić `Apply`, dopóki draft nie przechodzi tej samej walidacji co Python/ProblemIR. Export zawsze generuje kanoniczny Python.

Wdrożenie rozszerza istniejące manifesty Explorer/Inspector/Ribbon i command
registry; nie tworzy osobnego screen-shaped modułu. Wymagane są selection
mapping, typed resource hooks, capability gating, SSR-safe server snapshot oraz
browser smoke. Dedykowane panele: CurrentTransport, SpinTransport,
SpinInterface, SpinTorque i OerstedField.

### 15.3. Results

Results korzysta z quantity catalog. Dla `Q` użytkownik może wybrać:

- kierunek przepływu `i`;
- polaryzację `a`;
- normalny flux na wybranym interfejsie;
- normę Frobeniusa tylko jako wielkość pochodną, nie zamiennik tensora.

---

## 16. Plan wdrożenia M0–M3

### 16.1. M0 — naprawa istniejącej semantyki i fundament kontraktu

#### M0.1. Dokumenty przed kodem

Na dedykowanej gałęzi istnieją drafty:

- `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`;
- `docs/physics/0970-spin-hall-drift-diffusion-transport.md`;
- `docs/physics/0980-dynamic-current-and-oersted-coupling.md`;
- `docs/specs/spin-transport-runtime-contract-v1.md`;
- `docs/adr/0019-spin-transport-and-prescribed-sot-semantics.md`.

Nie są jeszcze zatwierdzonym wejściem do implementacji. Przed integracją
trzeba nanieść korekty z rozdziału 0, przeprowadzić formalny review i nadać
fizykom wolne numery — proponowane `0990`, `1000`, `1010`, jeśli wciąż są
wolne. Wszystkie ścieżki w ADR, spec, indeksach i testach zmieniają się w tym
samym commicie; stary numer nie pozostaje aliasem dwóch różnych not.

Zaktualizować:

- `docs/physics/0800-fdm-sot.md`;
- `docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md`;
- `docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md`;
- `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`;
- `docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md`;
- `docs/physics/0860-fdm-generalized-oersted-from-prescribed-current.md`;
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`;
- capability matrix, native FEM architecture, resource-first API i quantity
  semantics note zawierającą istniejące IDs.

ADR rozstrzyga aliasy, sign convention, `Q` indices, units, coupling cadence,
ABI migration i deprecation.

#### M0.2. P0 fizyki i runtime

- zmienić Slonczewskiego na `slonczewski.fullmag.v2`, usunąć dodatkowe `1/2`
  z `Omega_J` i unieważnić orakle kodujące v1;
- naprawić `gamma0` i Gilbert conversion prescribed SOT;
- dodać maskę CUDA;
- zachować signed current dla SOT i Slonczewskiego;
- naprawić FDM CPU envelope Oersteda;
- przekazać czasy etapów w FDM CUDA;
- naprawić FSAL i final refresh;
- obsłużyć dowolną oś cylindra albo fail-closed;
- wyeliminować FEM GPU->CPU fallback z GPU provenance;
- materializować `H_oe` zgodnie z RHS;
- jednoznacznie włączyć `E_oe` albo zmienić nazwę energii;
- zamrozić adapter `theta_SH` Fullmag <-> Chen dla trzech osi;
- wyłączyć `sml_surface_conductance.v1` do czasu wdrożenia modelu
  rezerwuarowego v2.

#### M0.3. Authoring i round-trip

- `PrescribedSpinOrbitTorque` + alias;
- pełny Oersted render w `script_builder.py`;
- pełne `PiecewiseLinear(points=...)`;
- torque/current/Oersted w SceneDocument i overrides;
- typowane API projections;
- fail-closed przy utracie danych.

#### M0 exit gate

- wszystkie P0 z raportu zamknięte;
- macrospin vector oracle FP64 `<1e-12` względnie/absolutnie wg skali;
- niezależny limit `Lambda=1` potwierdza
  `gamma_e hbar P J/(2 e M_s t_F)` bez kompensujących błędów;
- FP32 tolerance udokumentowana z error budget;
- każdy integrator przechodzi stage-time Oersted test;
- normalized round-trip dla wszystkich istniejących parametrów;
- managed FEM verification i strict GPU provenance test;
- capability może osiągnąć `validated` wyłącznie jako
  `spin_torque.prescribed_sot` w jawnie wymienionym scope; nigdy jako SHE.

### 16.2. M1 — produkcyjny quasistatic one-way SHE

#### M1.1. Publiczny model i IR

- dodać `spin_transport.py`;
- dodać `SpinTransportModuleIR` i typowane plan IR;
- source binding charge->spin->torque/Oersted;
- steady spin mode;
- transparent i mixing interfaces;
- solver parameters i complete provenance.

#### M1.2. FDM CPU double oracle

- cell-centered FV charge;
- face-conservative `J_c`;
- vector spin diffusion i reaction;
- direct SHE source;
- transparent/mixing flux;
- transport torque z bilansu;
- FFT cell-integrated Oersted;
- independent residual/balance checks.

#### M1.3. FEM CPU/MFEM oracle

- conforming H1 charge/spin jako ograniczony pierwszy slice; broken/subdomain
  H1 + mortar przed capability dla oporowych/mixing interfejsów;
- weak forms i interface integrators;
- block linear solver;
- torque projection;
- **OE-T0:** ważony RT0/KKT, source-cut/terminal constraints, exact-rank
  semantics, niezależny certyfikat i rzeczywisty MPI gather/solve/broadcast;
- **OE-F1:** bezpośredni Biot–Savart afinicznego RT0 z singular/near/far
  tetra quadrature i spójną projekcją `L2`;
- **OE-F2:** `H_0(curl) x H1_0`, topology/cohomology constraints, AMS + MINRES;
- airbox convergence OE-F2 i porównanie do OE-F1.

#### M1.4. GPU double

- FDM CUDA persistent operators i buffers;
- FEM hypre-device solve;
- zero hot-loop transfers;
- CPU/GPU vector/tensor parity;
- bounded memory study.

#### M1 exit gate

- analytic 1D sinh/cosh spin accumulation;
- `theta_SH=0` limit;
- charge conservation;
- interface spin flux/torque balance;
- Oersted wire/cylinder/direct quadrature;
- osobne zielone managed gates OE-T0, OE-F1 i OE-F2, uruchomione w tej
  kolejności i na tym samym source snapshot;
- FDM/FEM convergence to common continuum result;
- UI authoring, run i inspection;
- capability `steady_drift_diffusion` otrzymuje `validated` wyłącznie dla
  jawnie wymienionych workloadów, lane, BC i zakresu parametrów.

### 16.3. M2 — bidirectional quasistatic

#### M2.1. Physics

- full 3D AMR/PHE/AHE conductivity;
- reciprocal iSHE;
- spin backflow;
- rezerwuarowy spin-memory loss `sml_reservoir.fullmag.v2`; v1 pozostaje
  unsupported;
- optional spin pumping tylko jako osobny, jawny model;
- stage-consistent charge-spin solve; liniowy przy zamrożonym `m` i liniowych
  prawach, nieliniowy tylko dla jawnie nazwanych constitutive extensions.

#### M2.2. Numerics

- GMRES/FGMRES baseline dla liniowego niesymetrycznego bloku;
- Picard/Newton/JFNK dopiero dla nazwanych nieliniowych praw i z osobną mapą
  zbieżności;
- block preconditioner;
- certyfikowany same-state transport error i sprzężenie tolerancji do outer LTE;
- failure propagates to step rejection;
- warm-start only with correct state revision;
- no committed update on rejected step.

#### M2 exit gate

- Onsager/sign oracle;
- nonnegative dissipative production;
- AMR/PHE/AHE manufactured solutions;
- SHE/iSHE reciprocity benchmark;
- linear block convergence/conditioning map oraz, jeśli dotyczy, osobna
  nonlinear convergence map;
- FDM/FEM and CPU/GPU parity;
- provenance complete for every feedback term.

### 16.4. M3 — transient spin transport

#### M3.1. Model

- fizyczny adapter `C_s=e^2 N_0=e^2 D_total/2` dla NM oraz fail-closed dla
  ogólnego FM bez macierzy/redukcji podatności;
- transient boundary drives;
- common state rollback;
- optional initial equilibrium solve;
- explicit distinction between spin relaxation time and LLG step.

#### M3.2. Integrator

- dokładne tableau ARS(2,3,2) z rozdziału 8.3 jako production baseline;
- step doubling, dzielenie przez 3 i przyjęcie stanu dwóch półkroków;
- BDF2/implicit constant-step small oracle z backward Euler bootstrap/restart;
- adaptive coupled error control oraz event-aligned steps;
- transport subcycling only after order proof;
- deterministic rejected-step behavior;
- checkpoint/restart of `V`, `mu_s`, surface DOF, solver history, envelope event
  index i cache keys.

#### M3 exit gate

- exponential relaxation analytic oracle;
- diffusion eigenmode decay;
- temporal convergence order;
- stiff-limit convergence to M1/M2 steady solution;
- dynamic SHE pulse phase and amplitude;
- full restart reproducibility;
- managed CPU/GPU production workload.

---

## 17. Dokładna mapa implementacyjna

### 17.1. Python

Modyfikować:

- `packages/fullmag-py/src/fullmag/model/spin_torque.py`;
- `current_transport.py`, `energy.py`, `problem.py`;
- `_validation.py`, model/root `__init__.py`;
- `runtime/script_builder.py`, `runtime/scene_document.py`.

Utworzyć:

- `packages/fullmag-py/src/fullmag/model/spin_transport.py`;
- testy `test_spin_transport.py`, `test_spin_transport_roundtrip.py`.

### 17.2. IR/authoring/planner

Modyfikować:

- `crates/fullmag-ir/src/study.rs`, `model.rs`, `validation.rs`, `plan.rs`, `lib.rs`;
- `crates/fullmag-authoring/src/scene.rs`, `builder.rs`, `adapters.rs`, `validation.rs`;
- `crates/fullmag-plan/src/spin_torque.rs`, `current_transport.rs`, `oersted.rs`, `fdm.rs`, `fem.rs`, `validate.rs`.

Utworzyć właścicieli:

- `crates/fullmag-ir/src/spin_transport.rs`;
- `crates/fullmag-authoring/src/spin_transport.rs`;
- typowane transport/torque/field-source modules zamiast rozbudowy płaskich planów.

### 17.3. FDM CPU

`crates/fullmag-engine/src/fdm/cpu` oraz
`crates/fullmag-runner/src/fdm/cpu/reference` są wyłącznie małym Rustowym
oraklem/reference lane. Nie są właścicielem produkcyjnych numerics i nie mogą
otrzymać statusu `production_executable` tylko dlatego, że reference test
przechodzi. Runner wyłącznie orkiestruje.

W reference lane wyodrębnić:

- `crates/fullmag-engine/src/fdm/cpu/interactions/spin_torque.rs`;
- `crates/fullmag-engine/src/fdm/cpu/interactions/prescribed_sot.rs`;
- `crates/fullmag-engine/src/fdm/cpu/interactions/dynamic_oersted.rs`;
- `crates/fullmag-engine/src/fdm/cpu/transport/charge.rs`;
- `crates/fullmag-engine/src/fdm/cpu/transport/spin_drift_diffusion.rs`;
- `crates/fullmag-engine/src/fdm/cpu/transport/interface_flux.rs`.

Produkcyjne CPU double należy zaimplementować pod `backends/fdm/cpu/` z
osobnymi owner modules `transport/{charge,spin_drift_diffusion,interface_flux}`
oraz `interactions/{spin_torque,dynamic_oersted}` i wystawić przez istniejące
native ABI/C API. Backend-neutralne descriptors, formula versions i
observables są wspólne z GPU, ale assembly, solve i pamięć należą do CPU
backendu. Gate porównuje native CPU z Rustowym oraklem i continuum workloadem;
nie promuje orakla do produkcji.

### 17.4. FDM CUDA

Modyfikować API/C ABI, construction, runtime context i obecne kernels. Utworzyć stabilne katalogi:

- `backends/fdm/gpu/cuda/interactions/sot/`;
- `backends/fdm/gpu/cuda/interactions/oersted/`;
- `backends/fdm/gpu/cuda/transport/charge/`;
- `backends/fdm/gpu/cuda/transport/spin_drift_diffusion/`.

Wersjonowane descriptors zastępują dokładanie pól do `context.hpp`.
Jawnie modyfikować również `backends/fdm/include/context.hpp`,
`backends/fdm/api/c_api.cpp`, `backends/fdm/CMakeLists.txt`,
`crates/fullmag-fdm-sys/src/lib.rs` oraz runner native construction/fields.

### 17.5. FEM CPU/MFEM

Reuse istniejących `backends/fem/cpu/mfem/interactions/stt*` i
`interactions/oersted*`. Audytowany branch ma już
`cpu/mfem/transport/conservative_current_view.*` oraz
`conservative_constraint_rank.*`; naprawiać je jako OE-T0, nie tworzyć
równoległego właściciela. Pod `backends/fem` uzupełnić:

- `cpu/mfem/interactions/sot_prescribed.*`;
- `cpu/mfem/transport/charge/`;
- `cpu/mfem/transport/spin_drift_diffusion/`;
- `cpu/mfem/transport/interface_flux/`;
- `cpu/mfem/interactions/oersted_direct/` (OE-F1);
- `cpu/mfem/interactions/oersted_vector_potential/`.

Każdy operator ma osobne: spaces, assembly, BC, solve, projection i telemetry.
OE-F1 i OE-F2 konsumują ten sam immutable `ConservativeCurrentView` OE-T0.
Żadnej nowej fizyki w `Context` ani `mfem_bridge.cpp`.

ABI/schema ownership obejmuje `backends/fem/include/fullmag_fem.h`,
`backends/fem/include/context.hpp`, `backends/fem/core/fem_plan_fields.*`,
`backends/fem/CMakeLists.txt`, `crates/fullmag-fem-sys/src/lib.rs` oraz
`crates/fullmag-runner/src/native_fem.rs`.

### 17.6. FEM GPU

Utworzyć osobne owner modules dla:

- prescribed SOT kernels;
- charge/spin operator assembly;
- hypre device solve;
- interface kernels;
- Oersted H(curl) device path;
- persistent state i transfer audit.

Strict GPU: brak CPU solve i brak H2D/D2H w hot loop.

### 17.7. Runner/API/UI

Modyfikować `crates/fullmag-quantities/src/catalog.rs`, runner `artifacts.rs`,
`quantities.rs`, `capabilities.rs`, native materialization, API
`schemas/authoring.rs`, `schemas/quantities.rs`, `schemas/fields.rs`,
`field_store.rs`, `quantity_data_plane.rs`, v2 model/data handlers i OpenAPI
generator. Generated frontend files są regenerowane, nie edytowane ręcznie.

W Control Room modyfikować shared physics domain, `apiPaths.ts`,
`ControlRoomApi.ts`, resource hooks, scene tree builders, inspector registry i
ribbon contributions. Utworzyć Inspektory Current Transport, Spin Transport,
Spin Interface, Spin Torque i Oersted Field. M3 dodatkowo wersjonuje checkpoint
schema i przypisuje restart ownership runnerowi, a coupled integrator natywnemu
backendowi.

---

## 18. Program walidacji

### 18.1. Algebra i jednostki

| Workload | Oracle | Wymaganie |
|---|---|---|
| `zl_uniform_zero_v1` | `grad m=0` | dokładne zero |
| `zl_linear_texture_v1` | symbolic derivative | pełny wektor |
| `slon_macrospin_v2` | bezpośredni wzór SI niezależny od backendu | znak, skala, baza DL/FL |
| `slon_lambda_one_prefactor_v2` | `Lambda=1 => epsilon=P/2` | dokładnie `gamma_e hbar P J/(2eM_s t_F)`; wykrywa błąd x1/2 |
| `sot_macrospin_v1` | bezpośredni wzór SI | `gamma_e`, `1/(Ms tF)`, Gilbert |
| `signed_current_involution_v1` | `J -> -J` | wszystkie current-induced terms odwracają właściwy znak |
| `theta_sh_convention_xyz_v1` | symboliczny Levi-Civita + Chen adapter | wszystkie trzy osie i sześć niezerowych kontrakcji |
| `onsager_power_block_v1` | losowe dopuszczalne stany + symboliczna kontrakcja | dodatnia część symetryczna, dokładnie zerowa moc Hall/SHE/iSHE |

### 18.2. Charge/spin PDE

| Workload | Oracle |
|---|---|
| `charge_uniform_bar_v1` | liniowy potencjał i stały prąd |
| `charge_layered_series_v1` | analityczny opór szeregowy |
| `spin_1d_diffusion_v1` | sinh/cosh |
| `spin_relaxation_modes_v1` | eigenvalues reakcji |
| `she_1d_film_v1` | analityczny profil SHE z zero-flux/mixing BC |
| `mixing_flux_balance_v1` | algebra interface law |
| `sml_reservoir_balance_v2` | eliminacja `mu_R`, bilans obu śladów i lattice flux |
| `sml_reservoir_entropy_v2` | suma trzech nieujemnych kwadratów, `G_R>0` |
| `theta_sh_zero_v1` | brak SHE source |
| `lambda_limits_v1` | poprawne granice `lambda -> infinity` |

Dodatkowe dyskretne gates FDM:

- lokalny FV residual w każdej komórce i bilans każdej elektrody;
- skok `sigma` i dokładny opór szeregowy;
- odwrócenie normalnej interfejsu przy identycznym wspólnym fluxie;
- Zhang–Li PBC osobno x/y/z, inflow/outflow, granica maski, zmienne `P/M_s`
  i tangency residual;
- observed order 2 dla central reference i 1 dla first-order upwind;
- osobne testy flux reconstruction dla SHE/iSHE i Hall.

### 18.3. Oersted

- OE-T0 weighted RT0/KKT kontra mały direct constrained solve;
- OE-T0 exact-rank dla komponentów zamkniętych, terminalowych i mieszanych;
- OE-T0 niezależne lokalne divergence/face/terminal/component certificates;
- OE-T0 prawdziwe MPI `-n 1` kontra `-n 2`: identyczne rekordy i certificate
  bytes przy deterministycznym partycjonowaniu bez METIS;
- OE-F1 affine-RT0 tetra: far/near/interior/on-face quadrature convergence,
  bez `self=0`, cutoff ani usuwania source elementu;
- OE-F2 compatibility prawej strony, block residual, gauge i harmonic
  constraints dla domeny wielospójnej;
- nieskończony drut i pełny cylinder inside/outside;
- ciągłość w `r=R`;
- `I -> -I` chirality;
- rotational covariance dla osi `z`, `x`, `(1,1,1)`;
- near-cell quadrature;
- FFT vs direct Biot–Savart;
- FEM vector potential vs direct quadrature;
- airbox convergence;
- sine/pulse/PWL/sinc phase i temporal order;
- observable-energy consistency.

Dodatkowe dyskretne gates FDM Oersted:

- `nz=1`, self-cell zero i osie singleton;
- przesunięty conductor względem magnetu oraz conductor mask;
- losowe podpisane `J`: FFT kontra bezpośrednia całka komórkowa komponent po
  komponencie;
- dyskretne `curl(H)-J` i `div(H)` z wyłączeniem kontrolowanej strefy brzegowej;
- CPU/GPU parity osobno dla kernela, FFT layout, crop i final field.

Nieskończony drut jest oraklem tylko po kontrolowanym badaniu długości i w
środkowym przekroju. Dla skończonego open-boundary FFT podstawowym oraklem jest
bezpośredni Biot–Savart tego samego zamkniętego obwodu.

### 18.4. Coupled dynamics

- 1D domain-wall velocity Zhang–Li;
- macrospin switching Slonczewski;
- ST-FMR-like symmetry separation SOT/Oersted;
- spin torque equals absorbed angular momentum;
- quasistatic stage consistency;
- liniowy M2 inexact-solve rejection z same-state tightened oracle;
- nieliniowy M2 step rejection tylko dla named nonlinear material/interface law;
- transient spin relaxation;
- ARS(2,3,2) tableau identity, step-doubling order i event-aligned pulse/PWL;
- BDF2 backward-Euler bootstrap oraz restart po zmianie `dt`;
- restart equivalence bitwise tam, gdzie możliwe, lub w jawnej tolerancji.

### 18.5. Convergence matrix

Każdy continuum workload wykonuje co najmniej:

- trzy rozdzielczości przestrzenne;
- trzy lub więcej kroków czasu;
- FDM CPU double;
- FEM CPU double z niezależną rodziną siatek;
- GPU double parity dla każdej dyskretyzacji;
- FP32 dopiero po double;
- raport observed order, a nie tylko pairwise difference.

### 18.6. External solver comparisons

- MuMax3/amumax: Zhang–Li PBC i Slonczewski macrospin po jawnej konwersji parametrów;
- BORIS: charge/spin multilayer i interface torque;
- NeuralMag: Oersted FDM oraz regular-grid FIC projection; nie jest oraklem
  unstructured MFEM H(curl);
- COMSOL: one-way `ec.J -> Zhang–Li` tylko jako workflow comparison.

Każdy adapter porównawczy zapisuje tabelę konwersji znaków i jednostek. Brak zgodności najpierw rozstrzyga się przez bezpośredni wzór, nie przez dopasowanie znaku „aż wykres wygląda podobnie”.

---

## 19. Testy i receptury wykonawcze

Reuse istniejących managed recipes:

- `just verify-fem-time-domain-native-contract`;
- `just verify-fem-oersted-observable-contract`;
- `just verify-fem-oersted-oet0-cpu-contract`;
- `just verify-fem-oersted-oet0-tsan-cpu-contract`;
- `just verify-fem-oersted-oef1-cpu-contract`;
- `just verify-fem-oersted-oef2-cpu-contract`;
- `just verify-fem-zhang-li-skew-tetra-runtime`;
- `just verify-fem-oersted-rk-time-convergence`;
- `just verify-fem-oersted-observable-runtime`;
- `just rebuild-fem-runtime`;
- `just ensure-managed-fem-runtime`.

Dodać:

```text
just verify-spin-torque-contract
just verify-prescribed-sot-cross-backend
just verify-spin-drift-diffusion-cross-backend
just verify-dynamic-oersted-cross-backend
just verify-fdm-spin-transport-runtime
just verify-fem-spin-transport-runtime
just verify-spin-transport-product-contract
```

Końcowy gate:

1. Python unit + round-trip;
2. IR/planner Rust tests;
3. FDM CPU unit/convergence;
4. native FDM CTest i CUDA parity;
5. container-backed FEM CPU/GPU build/runtime;
6. capability/provenance assertions;
7. OpenAPI regeneration i `check:api-hygiene`;
8. `pnpm --dir apps/control-room typecheck`, lint z zerem warningów i test;
9. real browser smoke authoring/export/run/inspect;
10. raport workloadów z hashami artefaktów.

Każda nowa receptura wskazuje skrypt właściciela, zależny managed image,
freshness check, katalog artefaktów sukcesu i nonzero exit na brak dowodu.
Obowiązkowe negative gates:

- strict GPU nie wykonuje CPU fallback;
- Oersted PBC bez wspieranego kernela jest odrzucony;
- konflikt BC i brak gauge są odrzucone;
- terminal/source-cut bez globalnego closure oraz fałszywy MPI metadata-only są
  odrzucone;
- signed-source inversion przechodzi dla każdego torque;
- Slonczewski v1 i SML v1 są odrzucone dla nowych runów;
- rejected step nie zmienia committed revision;
- legacy IR migruje albo kończy się wersjonowanym błędem bez utraty pól.

Host-only FEM build nie jest końcowym dowodem.

---

## 20. Budżety błędów i kryteria ilościowe

Wartości końcowe muszą zostać skalibrowane na workloadach, lecz minimalny kontrakt startowy jest następujący:

- algebraiczne FP64 torque oracle: `rtol<=1e-12`, `atol` zależne od skali;
- FP32 torque parity: `rtol<=5e-5` jako punkt startowy, bez ukrywania błędów systematycznych;
- charge balance:
  `epsilon_I=|sum_e I_e|/max(sum_e |I_e|, I_ref)` ma być `<=1e-10` CPU
  double i `<=1e-6` FP32; `I_ref` jest wersjonowaną skalą absolutną dla
  open-circuit;
- spin flux/torque balance: `<=10*linear_solver_rtol`;
- linear residual: domyślnie `1e-10` double, `1e-6` single;
- linear/nonlinear residual M2: każdy blok ma normę
  `||r_b||/(atol_b+rtol_b||b_b||)` oraz jawny zero-source branch; żadna
  względna norma nie dzieli przez zero ani szum maszynowy;
- induced torque uncertainty jest same-state estimator/bound z rozdziału 8.2 i
  spełnia `dt e_T <= 0.1 max(LTE_m,LTE_floor)` jako punkt startowy; różnica
  fizycznych torque między etapami nie jest błędem solvera;
- błąd normy `m`: przed projekcją raportowany, po projekcji `<=1e-12` double;
- temporal-order gate: observed order nie mniejszy niż nominalny minus `0.25` w asymptotic range;
- spatial convergence: raportowana empirycznie; brak deklaracji order bez regularności rozwiązania;
- GPU transfer audit: zero transferów per stage w strict device-resident lane poza jawnie publikowanym output cadence.

Każda tolerancja saddle/block solve jest związana ze skalowaniem wierszy i
bloków, a raport przechowuje zarówno residual scaled, jak i w jednostkach SI.
Kwalifikacja FP32 nie ogranicza się do jednej normy parity: macierz workloadów
obejmuje kontrast `sigma`, `lambda/h`, aspect ratio cienkich warstw,
`theta_SH`, `P`, kondycję interfejsów, precision akumulacji/redukcji/FFT oraz
ewentualne iterative refinement. Każdy mieszany format jest jawny w provenance.

Tolerancje nie mogą być łagodzone tylko po to, by test przeszedł; każda zmiana wymaga error budget note.

---

## 21. Ryzyka i zabezpieczenia

| Ryzyko | Skutek | Zabezpieczenie |
|---|---|---|
| niejednoznaczny znak `J`, `theta_SH`, normalnej | odwrócony torque | orientowane interfejsy, signed tests, formula version |
| dodatkowe `1/2` w skali Slonczewskiego | moment dokładnie 2x za mały | v2, limit `Lambda=1`, rozdzielony oracle `Omega*epsilon` |
| pomieszanie pola `A/m` z rate `1/s` | błąd wymiarowy | wspólny SI prefactor i unit oracle |
| lagged transport w high-order RK | utrata rzędu | stage-consistent strict, przybliżenie jawnie degraded |
| szeroki `Context` i fizyka w integratorze | niemożliwa własność/utrzymanie | descriptors i owner modules |
| tensor `Q` udawany jako vector | utrata informacji | rank-2 codec i UI tensor view |
| GPU fallback | fałszywe provenance | strict fail-closed i residency audit |
| cienkie warstwy poniżej rozdzielczości | błędny SHE/interface torque | mesh adequacy checks i convergence |
| Hall terms psują SPD | zły solver | planner wybiera GMRES/block solver |
| pozorne SML bez rezerwuaru | niezachowany spin i fałszywa entropia | tylko reservoir v2, surface balance/power gate |
| `ProjectCoefficient` nazwane RT0 oraz metadata-only MPI | fałszywy certyfikat Oersteda | weighted KKT, exact rank, real gather/broadcast i byte-identity gate |
| airbox Oersted | boundary truncation | extent study i direct oracle |
| transient stiffness | niestabilność | IMEX/implicit, nie DP45 bez dowodu |
| krok przecina pulse/PWL event | utrata rzędu i niejednoznaczny drive | event alignment, right-continuous semantics, checkpoint event index |
| skopiowanie zewnętrznego kodu | ryzyko licencyjne | reimplementacja z publikacji i testów |
| scope creep do full Maxwell | nieskończony projekt | validity gate i osobny przyszły physics note |

---

## 22. Kolejność pull requestów

Każdy PR musi być reviewowalny i kończyć zielonym gate własnego zakresu.

1. **PR-00 docs/ADR:** skorygowane i bezkolizyjnie przenumerowane noty
   (proponowane 0990–1010), runtime spec, ADR i capability vocabulary.
2. **PR-01 canonical torque math:** backend-neutral signs/units/Gilbert,
   `slonczewski.fullmag.v2`, migracja/fail-closed v1 i niezależne unit oracles.
3. **PR-02 M0 FDM fixes:** SOT, mask, signed current, Oersted stage time/axis/FSAL.
4. **PR-03 M0 FEM/provenance:** strict GPU, thickness/polarization, observables/energy.
5. **PR-04 authoring round-trip:** Python, IR, SceneDocument, OpenAPI projections.
6. **PR-05 Control Room M0:** dedicated nodes/inspectors, complete export.
7. **PR-06 M1 backend-neutral charge/spin operators:** scalar/vector algebra i manufactured oracles.
8. **PR-07 M1 FDM CPU charge:** conservative FV i electrode gates.
9. **PR-08 M1 FEM CPU charge:** weak form, broken spaces i interface traces.
10. **PR-09 M1 FDM CPU steady spin:** PDE, SHE, interfaces i torque balance.
11. **PR-10 M1 FEM CPU steady spin:** independent weak form i torque balance.
12. **PR-11 M1 FDM Oersted:** face-to-cell, direct oracle i FFT.
13. **PR-12 M1 FEM OE-T0:** weighted RT0/KKT, rank/component semantics,
    source-cut/terminal constraints, real MPI i independent certificate.
14. **PR-13 M1 FEM OE-F1:** affine-RT0 direct tetra quadrature i consistent
    projection; zależy od zielonego PR-12.
15. **PR-14 M1 FEM OE-F2:** `H_0(curl) x H1_0`, topology, AMS/MINRES, airbox i
    porównanie OE-F1; zależy od zielonych PR-12/13.
16. **PR-15 M1 FDM CUDA double:** transport i Oersted residency/parity.
17. **PR-16 M1 FEM GPU double:** hypre device i transfer audit.
18. **PR-17 M1 product closure:** quantities, artifacts, API/UI, workloads.
19. **PR-18 M2 constitutive/Onsager:** AMR/PHE/AHE/iSHE docs, pełna macierz
    mocy i algebra oracle.
20. **PR-19 M2 SML v2:** reservoir DOF, bilans śladów i surface entropy gate.
21. **PR-20 M2 FDM CPU:** liniowy block solve baseline; nieliniowe rozszerzenia
    tylko jeśli nazwane i osobno kwalifikowane.
22. **PR-21 M2 FEM CPU:** taki sam kontrakt fizyczny, niezależna assembly i
    mesh/convergence gate.
23. **PR-22 M2 FDM GPU qualification.**
24. **PR-23 M2 FEM GPU i product closure.**
25. **PR-24 M3 transient docs/ARS(2,3,2)/BDF2 reference.**
26. **PR-25 M3 FDM CPU coupled implementation.**
27. **PR-26 M3 FEM CPU coupled implementation.**
28. **PR-27 M3 FDM GPU.**
29. **PR-28 M3 FEM GPU, restart i product closure.**

Nie wolno łączyć PR-00 z masową implementacją. Physics publication i ADR muszą zostać zatwierdzone przed publicznym API oraz kodem solvera.

---

## 23. Checklist kompletności

### Fizyka

- [ ] Jedna konwencja `gamma_e/gamma0`.
- [ ] Jedna konwencja prądu konwencjonalnego.
- [ ] Zamrożone orientacje interfejsów i indeksy `Q`.
- [ ] Zhang–Li, Slonczewski i prescribed SOT są oddzielne.
- [ ] Slonczewski v2 przechodzi niezależny limit `Lambda=1`; v1 jest
  fail-closed dla nowych runów.
- [ ] SHE jest transportem, nie aliasem SOT.
- [ ] iSHE jest reciprocal z direct SHE.
- [ ] Adapter `theta_SH` Fullmag/Chen przechodzi pełną tabelę trzech osi.
- [ ] `C_s` ma fizyczny DOS/susceptibility model i jednostki; ogólny FM bez
  macierzy podatności jest odrzucony.
- [ ] SML używa rezerwuaru v2, zamyka bilans i ma nieujemną pełną produkcję.
- [ ] Torque jest bilansem spin angular momentum.
- [ ] Oersted pochodzi z tego samego `J_c`.
- [ ] Validity regime jest egzekwowany.

### Numerics

- [ ] FDM conservative FV.
- [ ] FEM weak forms i interface flux.
- [ ] Stage-consistent coupling.
- [ ] Rejected-step rollback.
- [ ] Independent Oersted oracle.
- [ ] OE-T0 jest ważonym RT0/KKT z exact-rank/component i real-MPI certificate.
- [ ] OE-F1 ma zbieżną singular/near/far tetra quadrature bez self deletion.
- [ ] OE-F2 ma właściwe `H_0(curl) x H1_0`, compatibility i harmonic constraints.
- [ ] FDM/FEM convergence.
- [ ] CPU/GPU double parity.
- [ ] FP32 qualification.
- [ ] Strict GPU residency.
- [ ] ARS(2,3,2) tableau, step doubling, event alignment i rollback są
  odtwarzalne z checkpointu.

### Produkt

- [ ] Python complete.
- [ ] ProblemIR complete.
- [ ] Planner/capability complete.
- [ ] SceneDocument/OpenAPI round-trip complete.
- [ ] UI authoring/inspection/export complete.
- [ ] Tensor data plane complete.
- [ ] Observables equal runtime RHS.
- [ ] Provenance requested/resolved complete.
- [ ] Managed runtime and browser proof complete.

---

## 24. Bibliografia

1. T. Schrefl, `mic_intro.pdf`, lokalny materiał w `docs/papers`, 2016.
2. *Manual for Micromagnetics Module*, lokalny PDF w `docs/comsol`, wersja widoczna w provenance dokumentu.
3. J. C. Slonczewski, *Current-driven excitation of magnetic multilayers*, JMMM 159, L1–L7 (1996), DOI: 10.1016/0304-8853(96)00062-5.
4. L. Berger, *Emission of spin waves by a magnetic multilayer traversed by a current*, PRB 54, 9353 (1996), DOI: 10.1103/PhysRevB.54.9353.
5. S. Zhang, Z. Li, *Roles of Nonequilibrium Conduction Electrons on the Magnetization Dynamics of Ferromagnets*, PRL 93, 127204 (2004), DOI: 10.1103/PhysRevLett.93.127204.
6. M. D. Stiles, A. Zangwill, *Anatomy of spin-transfer torque*, PRB 66, 014407 (2002), DOI: 10.1103/PhysRevB.66.014407.
7. T. Valet, A. Fert, *Theory of the perpendicular magnetoresistance in magnetic multilayers*, PRB 48, 7099 (1993), DOI: 10.1103/PhysRevB.48.7099.
8. S. Zhang, P. M. Levy, A. Fert, *Mechanisms of Spin-Polarized Current-Driven Magnetization Switching*, PRL 88, 236601 (2002), DOI: 10.1103/PhysRevLett.88.236601.
9. C. Abert et al., *Spin-polarized transport in ferromagnetic multilayers: An unconditionally convergent FEM integrator*, CAMWA 68, 639–654 (2014), DOI: 10.1016/j.camwa.2014.07.010.
10. C. Abert et al., *A three-dimensional spin-diffusion model for micromagnetics*, Scientific Reports 5, 14855 (2015), DOI: 10.1038/srep14855.
11. J. L. García-Cervera, X.-P. Wang, *Spin-polarized currents in ferromagnetic multilayers*, JCP 224 (2007), DOI: 10.1016/j.jcp.2006.10.029.
12. J. E. Hirsch, *Spin Hall Effect*, PRL 83, 1834 (1999), DOI: 10.1103/PhysRevLett.83.1834.
13. S. Zhang, *Spin Hall Effect in the Presence of Spin Diffusion*, PRL 85, 393 (2000), DOI: 10.1103/PhysRevLett.85.393.
14. Y.-T. Chen et al., *Theory of spin Hall magnetoresistance*, PRB 87, 144411 (2013), DOI: 10.1103/PhysRevB.87.144411.
15. A. Manchon et al., *Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic systems*, RMP 91, 035004 (2019), DOI: 10.1103/RevModPhys.91.035004.
16. A. Brataas, Yu. V. Nazarov, G. E. W. Bauer, *Finite-Element Theory of Transport in Ferromagnet–Normal Metal Systems*, PRL 84, 2481 (2000), DOI: 10.1103/PhysRevLett.84.2481.
17. K. Xia et al., *Spin torques in ferromagnetic/normal-metal structures*, PRB 65, 220401(R) (2002), DOI: 10.1103/PhysRevB.65.220401.
18. Y. Tserkovnyak, A. Brataas, G. E. W. Bauer, *Enhanced Gilbert Damping in Thin Ferromagnetic Films*, PRL 88, 117601 (2002), DOI: 10.1103/PhysRevLett.88.117601.
19. F. Alouges, *A new finite element scheme for Landau-Lifchitz equations*, DCDS-S 1, 187–196 (2008), DOI: 10.3934/dcdss.2008.1.187.
20. S. Bartels, A. Prohl, *Convergence of an Implicit Finite Element Method for the LLG Equation*, SIAM J. Numer. Anal. 44, 1405–1419 (2006), DOI: 10.1137/050631070.
21. J. R. Dormand, P. J. Prince, *A family of embedded Runge–Kutta formulae*, JCAM 6 (1980), DOI: 10.1016/0771-050X(80)90013-3.
22. U. M. Ascher, S. J. Ruuth, R. J. Spiteri, *Implicit-explicit Runge–Kutta methods for time-dependent partial differential equations*, Applied Numerical Mathematics 25, 151–167 (1997), DOI: 10.1016/S0168-9274(97)00056-1.
23. P.-A. Raviart, J.-M. Thomas, *A mixed finite element method for second order elliptic problems*, Mathematical Aspects of Finite Element Methods, Lecture Notes in Mathematics 606, 292–315 (1977), DOI: 10.1007/BFb0064470.
24. P. Monk, *Finite Element Methods for Maxwell's Equations*, Oxford University Press, 2003, ISBN 978-0-19-850888-5.
25. M. G. Duffy, *Quadrature over a pyramid or cube of integrands with a singularity at a vertex*, SIAM Journal on Numerical Analysis 19, 1260–1262 (1982), DOI: 10.1137/0719090.
26. R. Anderson et al., *MFEM: A modular finite element methods library*, Computers & Mathematics with Applications 81, 42–74 (2021), DOI: 10.1016/j.camwa.2020.06.009.

---

## 25. Decyzja wykonawcza

Wybrany wariant 3 oznacza:

1. stan docelowy obejmuje pełne bidirectional charge–spin–LLG z direct/inverse SHE;
2. pierwszym produkcyjnym solverem jest walidowalny steady/quasistatic M1;
3. prescribed SOT pozostaje osobnym, uczciwie nazwanym modelem;
4. M2 dodaje sprzężenie zwrotne, a M3 dynamikę akumulacji spinu;
5. żaden etap nie może używać nazwy ani capability szerszej niż faktycznie zaimplementowana fizyka;
6. każdy etap kończy się pełnym dowodem cross-layer i cross-backend, nie samym buildem.

Ten dokument jest planem wykonawczym. Drafty publikacyjnych not i ADR już
istnieją na dedykowanej gałęzi, lecz nie są zatwierdzone. Przed rozpoczęciem
PR-01 trzeba wprowadzić do nich rozdziały 3–10 w wersji skorygowanej niniejszym
audytem, nadać wolne numery, zaktualizować wszystkie odnośniki, przeprowadzić
formalny review znaków/jednostek/termodynamiki i zatwierdzić ADR-0019.

---

## 26. Plan korekt i integracji dedykowanego worktree

### 26.1. Strategia integracji

Pełny rebase 109 commitów na baseline oddalony o 271 commitów zachowałby
chronologię, ale próbowałby również przenieść znane błędy fizyczne
Slonczewskiego/SML/OE-T0 i utrudniał odróżnienie konfliktu tekstowego od zmiany
semantyki. Wybrana strategia to **semantic replay na nowej gałęzi integracyjnej
od aktualnego `master`**, przy zachowaniu oryginalnej gałęzi jako immutable
checkpointu. Rebase całej gałęzi jest dopuszczalny tylko jako diagnostyka
konfliktów, nie jako skrót do merge.

Nie integrować bezpośrednio na `master`. Każdy slice poniżej ma osobny commit,
własny gate i evidence record. Commit może zostać scalony dopiero, gdy nie
zawiera capability szerszej niż jego dowód.

### 26.2. Faza I — zamrożenie i ochrona istniejącej pracy

1. Zapisać w ledgerze pełne SHA `master`, gałęzi, merge-base, `git status
   --short`, `git diff --cached --name-only` i `git diff --cached --binary`.
   Kryterium: można odtworzyć dokładnie stan przed integracją.
2. Staged
   `backends/fem/tests/conservative_current_view_contract.cpp` poddać osobnemu
   review. Jeśli jest spójnym testem przyszłego OE-T0, zapisać go jako osobny
   checkpoint/WIP commit na oryginalnej gałęzi; jeśli nie, zachować exact patch
   poza indeksem integracyjnym. Nie wrzucać go automatycznie do commitu kodu i
   nie używać szerokiego stash/reset.
3. Utworzyć chroniony tag/branch checkpointu oraz nowy worktree z gałęzi
   `codex/spin-transport-m0-m3-integration` od zweryfikowanego aktualnego
   `master`. Kryterium: oryginalny worktree, staged diff i report artifacts są
   nietknięte.
4. Policzyć SHA-256 wszystkich używanych `result.json`, fixtures i external
   adapter outputs. Wynik bez commitu, komendy, image digest i artifact hash
   otrzymuje status `stale_or_unattributed`.

### 26.3. Faza II — normatywna fizyka i kontrakty

1. Przenieść trzy drafty physics, runtime spec i ADR; rozwiązać kolizje numerów
   przez atomowe 0990/1000/1010 lub następne wolne IDs.
2. Wprowadzić poprawki normatywne: Slonczewski v2, pełną tabelę znaków SHE,
   podatność/DOS dla `C_s`, reservoir SML v2, pełną produkcję Onsagera,
   circuit closure, OE-T0/1/2, MQS i dokładne ARS(2,3,2).
3. Zatwierdzić physics note review przed kodem. Gate obejmuje symboliczne
   SI/sign tests, źródła pierwotne i checklistę `docs/physics`; ADR przechodzi
   z `proposed` dopiero po review.
4. Zaktualizować formula versions, migration table, ProblemIR schema i
   capability vocabulary. `slonczewski.fullmag.v1` oraz
   `sml_surface_conductance.v1` są fail-closed dla nowych runów.

Kryterium fazy: Python, UI, planner i backend nie mają jeszcze prawa publikować
nowego capability, ale jedna zatwierdzona semantyka jest gotowa do implementacji.

### 26.4. Faza III — replay i naprawa implementacji w kolejności zależności

1. **M0 torque:** replay backend-neutral algebra i naprawić wszystkie FDM/FEM
   CPU/GPU realizacje oraz fixtures do Slonczewskiego v2. Uruchomić limit
   `Lambda=1`, signed-current i cross-backend FP64 przed kolejnym slice.
2. **M1 steady reference:** replay Python/IR/reference FDM i ograniczony FEM
   conforming H1/P1. Nazwać zakres dokładnie; nie deklarować broken/mortar,
   native FDM production ani GPU bez osobnego dowodu.
3. **OE-T0:** zastąpić końcowe `ProjectCoefficient` ważonym RT0/KKT, naprawić
   rank semantics komponentów terminalowych, zrealizować rzeczywisty globalny
   MPI path i niezależny certificate. Najpierw unit/exact-rank, następnie
   managed OE-T0 i TSAN; brak zieleni blokuje OE-F1/OE-F2.
4. **OE-F1:** wdrożyć affine-RT0 tetra quadrature i consistent projection.
   Uruchomić singular/near/far convergence oraz managed OE-F1.
5. **OE-F2:** wdrożyć relative-boundary exact sequence, topology/cohomology,
   AMS/MINRES i airbox study. Uruchomić compatibility, block residual,
   OE-F1 comparison i managed OE-F2.
6. **FDM production:** przenieść produkcyjne charge/spin/Oersted numerics do
   `backends/fdm/cpu`, zachowując Rust jako mały oracle; następnie kwalifikować
   CUDA FP64 i dopiero na końcu macierz FP32.
7. **M2:** złożyć liniowy reciprocal block przy fixed `m`, potem reservoir SML
   v2; nieliniowe rozszerzenia wdrażać w osobnych slice'ach.
8. **M3:** wdrożyć fizyczne storage, dokładne ARS tableau, step doubling,
   event alignment, rollback/restart i constant-step BDF2 oracle.

Każdy punkt kończy się porównaniem staged diff z zakresem, świeżym testem i
aktualizacją ledgeru. Nie wolno przejść dalej, jeśli prerequisite ma status
`fail`, `stale`, `semantic_only` albo dowód z innego commitu.

### 26.5. Faza IV — zamknięcie cross-layer i produkcyjne

1. Dla każdego modelu wykonać czterodrożny normalized round-trip Python,
   SceneDocument, OpenAPI/UI i canonical export.
2. Zregenerować OpenAPI/types, uruchomić API hygiene i sprawdzić requested vs
   resolved provenance, formula versions, circuit closure i solver identity.
3. Uruchomić natywne FDM gates, a FEM wyłącznie przez container-backed recipes
   z rozdziału 19. Host-only wynik pozostaje diagnostyczny.
4. Dla GPU zebrać bezpośredni device/runtime identity, brak fallbacku,
   residency/transfer telemetry i FP64 parity; sama dostępność CUDA lub build
   nie jest dowodem wykonania na urządzeniu.
5. Uruchomić Control Room typecheck, lint, test oraz browser smoke obejmujący
   authoring, export, run i inspection wszystkich tensorów/parametrów.
6. Wykonać continuum convergence i external-solver adapters z jawnymi tabelami
   konwersji; następnie utworzyć końcowy product report.

Status `production_executable` wymaga rzeczywistego native/managed wykonania;
`validated` wymaga dodatkowo przypisanego workload scope, zbieżności,
niezależnego orakla, lane/device/precision i kompletnych artefaktów.

### 26.6. Minimalny rekord dowodowy

Każdy gate zapisuje co najmniej:

```text
gate_id, scope, command, cwd,
source_commit, dirty_diff_sha256,
container_image_digest, runtime_identity, device_identity,
requested_execution, resolved_execution,
formula_versions, operator_versions,
mesh/grid/material/envelope revisions,
started_at, finished_at, exit_code,
result_status, limitations,
stdout_sha256, stderr_sha256, artifact_paths_and_sha256,
validated_workloads, reviewer_decision.
```

Brak któregokolwiek pola nie musi unieważniać testu jednostkowego, ale blokuje
użycie go jako produkcyjnego dowodu. Ledger rozróżnia `source_visible`,
`semantic_only`, `reference_executable`, `production_executable` i `validated`.

### 26.7. Stop rules

- nie integrować physics code przed zatwierdzeniem skorygowanych not;
- nie integrować OE-F1/OE-F2 przed zielonym OE-T0 z prawdziwym MPI;
- nie promować conforming FEM subset do capability broken/mortar/interface;
- nie promować Rustowego FDM oracle do native production;
- nie akceptować testu kodującego znany błędny prefaktor jako orakla;
- nie oznaczać GPU jako wykonane bez identity i telemetry urządzenia;
- nie podnosić capability po merge bez świeżego post-merge gate na dokładnym
  commicie przeznaczonym do publikacji.

## 27. Addendum — stan po implementacji OE-T0/OE-F1/OE-F2 i migracji Slonczewski v2 (2026-08-02)

Ten rozdział jest nowszym źródłem stanu niż historyczne snapshoty w rozdziałach
0 i 26. Wpisy z wcześniejszą gałęzią, SHA lub statusem muszą być czytane jako
archiwalne. Nie oznacza to zakończenia celu ani zgody na merge bez replayu
semantycznego.

### 27.1. Identyfikacja stanu

| Pole | Wartość |
|---|---|
| worktree | `/home/kkingstoun/git/fullmag/fullmag/.worktrees/spin-transport-final` |
| branch | `codex/spin-transport-final` |
| HEAD przed bieżącym slice'em v2 | `918db0209056fb036d73381c67977434907a334a` |
| v2 slice commit | `bb0031df5ca05766b379e27f569f8945f515674c` |
| aktualny `master` | `f57c34d1ce9cbcf50f651bdc7a28f4e43bba716d` |
| rozjazd | `116` commitów tylko na gałęzi, `567` tylko na `master` |
| integracja | nie wykonana; wymagany nowy worktree od aktualnego `master` i replay konfliktów semantycznych |
| ciężkie artefakty | kanoniczny root `/zfn2/mateuszz/git/fullmag`; kompilacje FEM wykonywane przez repozytoryjne receptury `just` w zarządzanych kontenerach; brak twierdzenia o zapisie bezpośrednim do root-owned CIFS/WSL |

### 27.2. Zrealizowane korekty Slonczewskiego

Wprowadzono nowy, jednoznaczny identyfikator `slonczewski.fullmag.v2` we
wszystkich warstwach nowego runu:

- formuła używa `Omega_J = gamma_e hbar J_n/(e M_s t_F)` oraz
  `epsilon=P Lambda^2/[(Lambda^2+1)+(Lambda^2-1)c]`; dla `Lambda=1` niezależny
  oracle daje standardowy `gamma_e hbar P J_n/(2 e M_s t_F)`;
- FDM CPU, FEM CPU, native ABI, planner, IR validation, Python DSL, script
  export, SceneDocument, OpenAPI schema/types, Control Room recognition,
  runner diagnostics, capability matrix i provenance emitują v2;
- `slonczewski.fullmag.v1` zachowuje historyczny evaluator wyłącznie jako
  read-only provenance i jest odrzucany przez authoring, IR/planner oraz native
  FEM import dla nowych uruchomień; nie ma cichej konwersji v1 -> v2;
- dodano niezależny test SI prefaktora FDM oraz test native FEM odrzucający v1;
  testy zachowują również bitową zgodność osobnej gałęzi legacy v0.

### 27.3. Świeże dowody wykonania

| Gate | Wynik | Zakres i ograniczenia |
|---|---|---|
| `cargo test -p fullmag-engine canonical_slonczewski_matches_independent_signed_si_gilbert_oracle` | `pass` | v2 FDM CPU algebraic oracle; nie jest to trajectory/convergence proof |
| `cargo test -p fullmag-ir --test ir_tests` | `132 pass` | IR round-trip/validation; nie jest to native runtime proof |
| `cargo test -p fullmag-authoring` | `46 pass` | Rust authoring validation; browser/UI nie zostały tym zastąpione |
| `PYTHONPATH=packages/fullmag-py/src TMPDIR=/tmp/fullmag-pytest python3 -m pytest -q packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py` | `21 pass, 45 subtests pass` | Python canonical v2 export/decode round-trip |
| `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/spin-transport-final cargo check -p fullmag-runner` | `pass` | Rust runner compiles; no execution/device proof |
| `just verify-fem-stt-native-contract` | `pass` | managed CUDA/MFEM build, native FEM STT contract and append-only ABI test; GPU STT remains fail-closed |
| `just verify-fem-oersted-oet0-cpu-contract` | `pass` (earlier evidence) | managed CPU/MPI weighted RT0/KKT contract; TSAN runtime remains WSL-blocked |
| `just verify-fem-oersted-oef1-cpu-contract` | `pass` (bounded) | direct tetra far/reference workload only; singular/on-face convergence is open |
| `just verify-fem-oersted-oef2-cpu-contract` | `pass` (bounded prerequisite) | dense mixed exact-sequence reference; no scalable AMS/BoomerAMG/airbox qualification |

The full `fullmag-plan` suite still reports two failures unrelated to this
slice (`fem_eigen_floquet_dynamic_demag_is_rejected` and
`relaxation_rejects_zhang_li_slonczewski_sot_and_thermal`); they are recorded as
pre-existing branch/master drift and must be resolved or explicitly waived
before final integration. The dedicated OE-T0 TSAN recipe compiles and
instruments the target but cannot start under the current WSL2 mapping
(`ThreadSanitizer: unexpected memory mapping`); this is an environment blocker,
not a passing race proof.

### 27.4. Re-estimated completion

The weighted implementation estimate is **66%**. It counts the completed
backend-neutral v2 contract, Python/IR/planner/runtime propagation, managed
OE-T0, and bounded OE-F1/OE-F2 references, but does not count source stubs or
semantic-only capability rows as production work. The production-readiness
estimate is **38%** because the following independent gates remain open:

1. SML reservoir v2, DOS/susceptibility-bounded `C_s`, and thermodynamic
   production proof;
2. singular/near-field OE-F1 quadrature, target projection, and FEM/FDM
   convergence;
3. scalable OE-F2 `H_0(curl) x H1_0` solve with topology certificate,
   AMS/BoomerAMG, airbox study, and supported-source policy;
4. native FDM production owner, FDM/CUDA FP64 parity, and any FP32 envelope;
5. complete FEM/GPU cross-backend parity and device-residency proof;
6. Control Room typecheck/lint/tests plus browser author/export/run/inspect
   proof for all v2 parameters;
7. semantic replay onto current `master`, post-merge managed gates and final
   scientific report.

These percentages are progress indicators, not capability labels. No row may
be promoted to `production_executable` or `validated` solely because the
percentage increased or a bounded contract test passed.
