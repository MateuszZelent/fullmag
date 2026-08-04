# Plan wdrożenia i kompletna specyfikacja fizyczno-numeryczna STT, SOT, SHE i dynamicznego pola Oersteda

**Status:** zatwierdzony kierunek; audyt fizyczno-numeryczny 2026-07-28 wykonany; implementacja częściowa i niegotowa do integracji  \
**Wariant:** 3 — pełny model docelowy wdrażany przez niezależnie walidowane kamienie milowe M0–M3  \
**Pierwotne repozytorium bazowe:** `master@f6073e6f63ea781dcb36293be28387741a52f8da`  \
**Aktualny baseline audytu:** `master@0c95b9a2711226e32845f00259c4ce0a8abbdcd6`  \
**Dedykowany worktree:** `/tmp/fullmag-spin-transport`, `codex/spin-transport-m0-m3@ab2f686afe0aaa60d269966bd87388c0e59e14c6`  \
**Merge-base:** `0612941f3b99137cbb171c183452368cc0f71029`; gałąź ma `109` własnych commitów i jest `271` commitów za aktualnym `master`  \
**Data pierwotna:** 2026-07-15  \
**Ostatnia aktualizacja:** 2026-08-04  \
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

### 0.5. Reconciliacja wykonawcza po porównaniu z BORIS (2026-08-03)

Ta sekcja jest nowsza niż snapshoty w tabeli 0.3 i opisuje stan bieżącego
`master`; historycznych wyników nie nadpisujemy. Najważniejsza korekta
interpretacyjna pozostaje bez zmian: BORIS jest obecnie szerszym wykonywalnym
wzorcem SHE/iSHE, natomiast Fullmag M2 jest docelowym, jawnie reciprocal
kontraktem fizycznym. Żaden z tych faktów nie oznacza ilościowej zgodności.

| Zakres | Świeży dowód | Uczciwy status po tej iteracji |
|---|---|---|
| Dokumentacja SHE ↔ BORIS | `BORIS_FULLMAG_SHE_COMPARISON.md`, odczyt `STransport.h`, `Transport_Spin.cpp`, `TransportCUDA.cu`, managed `BorisLin` smoke i adapter `S -> V_s -> mu_s` | `source_visible` + ograniczony `diagnostic`; **brak parity** |
| Python/IR/OpenAPI/UI execution request | usunięto nieobsługiwane `hybrid` z UI, modelu authoringu, Rust API i wygenerowanego OpenAPI; 25 testów Inspector oraz 68 testów `fullmag-authoring` przechodzi | drift `hybrid` zamknięty; pełny leaf-by-leaf parity nadal otwarty |
| FDM prescribed SOT | `just verify-fdm-prescribed-sot-native-contract`: algebra, CUDA FP64/FP32 i `cargo +nightly check --features cuda` przechodzą | natywny contract gate `pass`; brak pełnej kwalifikacji produktu |
| FDM dynamiczny Oersted | `just verify-fdm-oersted-native-contract`: stage-time, rollback, adaptive, FSAL, ABM3 i axis oracle przechodzą | natywny contract gate `pass`; nie jest to jeszcze ogólny current-solve/airbox gate |
| FEM OE-T0/OE-F1/OE-F2 CPU | zarządzane `just verify-fem-oersted-oet0-cpu-contract`, `...oef1...`, `...oef2...` przechodzą; wszystkie zawierają current-view MPI n1/n2 i tetra/direct/vector-potential contracts | `reference_executable` dla operator-contract slice; airbox, RT0/KKT, MPI race/skalowanie i zbieżność nadal otwarte |
| FEM OE TSan | instrumentation audit przechodzi, runtime kończy się `ThreadSanitizer: unexpected memory mapping` | blokada środowiskowa; **nie** dowód błędu fizyki |
| M3 FDM CPU/double/strict | `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/m3-reference CARGO_INCREMENTAL=0 just verify-fdm-transient-spin-m3-reference`: `RC:0`; public subprocess resume, 15 komend Rust (26 przypadków testowych) i `11 passed` Python | `reference_executable` gate zamknięty dla jawnego seed/noise workloadu |
| FEM STT | Po przebudowie zarządzanego obrazu (`just build target=fem-gpu-runtime`) katalog PETSc/SLEPc jest obecny; świeże `just verify-fem-stt-native-contract` buduje `fem_stt_contract` i przechodzi test ABI `versioned_stt_extension_is_append_only_after_legacy_plan_prefix` | `reference_executable` dla natywnego kontraktu/ABI; brak awansu GPU trajectory, pełnej integracji runtime i `validated` |
| Cały pakiet Python | bieżący rerun: `1407 passed, 46 failed, 2 skipped, 69 warnings, 550 subtests`; porażki dotyczą istniejących benchmark/mesh/SP4 fixtures, nie nowego `hybrid` slice | repozytorium nie ma zielonego full-suite; nie wolno twierdzić o pełnej integracji |

Naprawiono również receptę M3, która ignorowała `CARGO_TARGET_DIR` i szukała
`target/debug/fullmag` w checkoutcie. Recepta używa teraz binarium i katalogu
tymczasowego na `/tmp/fullmag-zfn2-build`, zgodnie z trwałym magazynem
`/zfn2/mateuszz/git/fullmag`; jest to warunek odtwarzalności, a nie obejście
solvera. Publiczny M3 workload ma jawny `ThermalNoise(seed=77)`: pozostawienie
samego `Problem.temperature` słusznie wybiera system entropy i uniemożliwia
byte-exact porównanie niezależnych procesów.

Capability matrix, `validated_workloads` i status ogólnego Fullmag M2
`semantic_only` pozostają rozdzielone od nowego bounded FEM CPU slice.
W szczególności coarse M2 nadal przechodzi do runtime, ale pełna macierz
BORIS–Fullmag nie zbiega się na drobnych siatkach, a `mu_s`, `Q_ia`, flux i
torque nie są jeszcze porównywalne ilościowo. Bounded reciprocal M2 FEM CPU ma
`reference_executable` wyłącznie w zakresie opisanym w sekcji 32.55; nie
otrzymuje `validated_workloads`.
Ocena celu pozostaje konserwatywnie **86% implementacji / 60% gotowości
produkcyjnej**: bounded M2 zamyka wykonywalny wycinek, ale nie kompensuje
otwartych bram reciprocal parity, FEM STT, GPU/FEM cross-backend, pełnej
macierzy i zielonego full-suite.

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

- `external_solvers/BORIS/Boris/STransport.h` i `STransport_Spin.cpp`;
- `external_solvers/BORIS/Boris/Transport_Spin.cpp`;
- `external_solvers/BORIS/Boris/STransport_Spin_GInterf.cpp`;
- `external_solvers/BORIS/Boris/TransportBase.h`;
- `external_solvers/BORIS/Boris/TransportCUDA.cu`;
- `external_solvers/BORIS/Boris/Transport_Spin_Display.cpp`.

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

#### 11.2.1. Weryfikacja źródłowa 2026-08-02

Porównanie wykonane na lokalnym snapshotcie `external_solvers/BORIS/Boris` jest
zapisane szczegółowo w
`docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/BORIS_FULLMAG_SHE_COMPARISON.md`.
Nie jest to porównanie konkretnego wydania BORIS, ponieważ katalog nie ma
niezależnej tożsamości commita w checkoutcie.

Ustalenia, które muszą pozostać częścią planu:

1. `STransport::solve_spin_transport_sor` wykonuje jawne `V -> E -> S`;
   domyślne wartości to `errorMaxLaplace=1e-6`, `maxLaplaceIterations=500`,
   `s_errorMax=1e-5`, `s_maxIterations=200` oraz damping `(1.4,0.5)`.
2. Direct SHE w BORIS jest realizowane przez `SHA` w
   `Transport::NHNeumann_Sdiff` i w źródle `PrimeSpinSolver_Spin`; inverse SHE
   przez niezależny `iSHA` w `Transport::NHNeumann_Vdiff` oraz
   `CalculateElectricField_Spin_withISHE_Kernel`.
3. `SHA` i `iSHA` mogą się różnić. Ustawienie `iSHA=SHA` jest konieczne do
   benchmarku wzajemności; `iSHA=0` jest wyłącznie testem one-way.
4. BORIS przechowuje `S` i używa adaptera
   `V_s=(De/elC)(e/muB)S`; Fullmag przechowuje pełne `mu_s` w woltach. Bez
   kalibracji tego mapowania porównanie torque jest nieważne.
5. `Gi/Gmix` i N/F/T są wykonywalnym wzorcem interfejsów, ale nie oznacza to,
   że Fullmag może awansować mixing/SML bez własnego bilansu fluxu, reservoiru
   i torque.

Wniosek planistyczny: BORIS jest zewnętrznym executable reference dla zakresu
 i implementacji, a Fullmag M2 pozostaje docelowym, bardziej jawnym
 kontraktem fizycznym. Nie wolno twierdzić o zgodności ani awansować
 capability na podstawie samej obecności kodu BORIS. Benchmark 1D/2D musi
 najpierw uzgodnić `S <-> mu_s`, znaki, normalne, `SHA=iSHA`, BC, residuale i
 bilanse, a następnie wykonać sweep siatki, tolerancji oraz CPU/CUDA.

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

## 27. Addendum — stan po implementacji OE-T0/OE-F1/OE-F2, Slonczewski v2, C_s i SML v2 (2026-08-02)

Ten rozdział jest nowszym źródłem stanu niż historyczne snapshoty w rozdziałach
0 i 26. Wpisy z wcześniejszą gałęzią, SHA lub statusem muszą być czytane jako
archiwalne. Nie oznacza to zakończenia celu ani zgody na merge bez replayu
semantycznego.

### 27.1. Identyfikacja stanu

| Pole | Wartość |
|---|---|
| worktree | `/home/kkingstoun/git/fullmag/fullmag/.worktrees/spin-transport-final` |
| branch | `codex/spin-transport-final` |
| HEAD po bieżącym OE-F1 singular/near slice | `7f9b2ade4cfb086bc9c264805ae335dd329ace9f` |
| v2 slice commit | `bb0031df5ca05766b379e27f569f8945f515674c` |
| bieżący slice DOS/SML FDM reference | `f6e9060fac5b0bad36c7e3cf91a716544469be36` |
| bieżący test-gate fix | `6c865437e073a9841fe03c0de3e9b38603ad1ff0` |
| aktualny `master` | `c262fa9d1ba660d70ed3d0849e6fe3469c9e5f32` |
| poprzedni plan checkpoint | `126e4cb736d6ec48cd7228d6166193d29d5aa98f` |
| ostatni zapisany plan commit | `226236a0` |
| rozjazd po bieżącym slice | `125` commitów tylko na gałęzi, `574` tylko na `master` |
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
| `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/spin-transport-final cargo check -p fullmag-ir -p fullmag-authoring -p fullmag-plan -p fullmag-runner -p fullmag-engine -p fullmag-api` | `pass` | C_s whitelist, SML v2 schema and bounded engine algebra compile; no native weak-form proof |
| `cargo test -p fullmag-plan sml_reservoir_v2_lowers_to_the_fdm_m2_reference_descriptor` | `pass` | nested SML v2 lowers only to the bounded FDM CPU M2 reference lane; native production lanes remain fail-closed |
| `cargo test -p fullmag-engine mixing_flux_balance` | `pass` | v2 interface balance algebra; reference lane only |
| `cargo test -p fullmag-engine sml_reservoir_closes_surface_balance_and_has_nonnegative_entropy` | `pass` | local reservoir elimination, trace balance and nonnegative surface power; not a discretized weak form |
| `cargo test -p fullmag-engine m2_mixing_interface` | `pass` | reciprocal reference observations retain backflow/absorption/SML channels |
| `cargo test -p fullmag-ir --test ir_tests` | `132 pass` (fresh) | exact DOS formula whitelist and nested SML v2 validation; not runtime/device proof |
| `cargo test -p fullmag-authoring` | `46 pass` (fresh) | authoring C_s/SML v2 validation; browser/UI remains unverified |
| `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/spin-transport-final cargo check -p fullmag-ir -p fullmag-authoring -p fullmag-plan -p fullmag-runner -p fullmag-engine -p fullmag-api` | `pass` (fresh) | DOS adapter, SML v2 lowering, reciprocal checkpoint identity and runner artifact path compile; no native weak-form/device proof |
| `PYTHONPATH=packages/fullmag-py/src TMPDIR=/tmp/fullmag-pytest python3 -m pytest -q packages/fullmag-py/tests/test_spin_drift_diffusion.py packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py` | `30 pass, 45 subtests pass` | Python C_s/DOS validation and canonical v2 round-trip; browser/UI remains unverified |
| `cargo test -p fullmag-runner reference_runner_executes_reciprocal_m2_through_corrected_stage_lte_gate` | `pass` | reciprocal descriptor checkpoint identity and stage LTE gate; reference runner only |
| `cargo test -p fullmag-runner reference_runner_publishes_sml_reservoir_balance_and_power` | `pass` | runner publishes reservoir potential, trace/lattice flux and non-negative surface power artifact; bounded FDM CPU only |
| `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/spin-transport-final cargo test -p fullmag-plan` | `241 pass, 0 fail` (fresh) | planner suite is green after aligning the certified Gamma_out/periodic-marker fixture and canonical prescribed-SOT relaxation rejection; this closes a verification gate, not a production backend gate |
| `just verify-fem-stt-native-contract` | `pass` | managed CUDA/MFEM build, native FEM STT contract and append-only ABI test; GPU STT remains fail-closed |
| `just verify-fem-oersted-oet0-cpu-contract` | `pass` (earlier evidence) | managed CPU/MPI weighted RT0/KKT contract; TSAN runtime remains WSL-blocked |
| `just verify-fem-oersted-oef1-cpu-contract` | `pass` (fresh, managed, `7f9b2ade`) | direct tetra CPU/FP64 now covers representative interior/face/edge targets with cutoff-free Duffy integration, deterministic h+p near refinement, default-profile convergence, and fail-closed depth exhaustion; target-space projection, independent high-depth convergence and production scaling remain open |
| `just verify-fem-oersted-oef2-cpu-contract` | `pass` (bounded prerequisite) | dense mixed exact-sequence reference; no scalable AMS/BoomerAMG/airbox qualification |

The full `fullmag-plan` suite now passes 241/241. The two earlier failures were
fixture/schema drift: the airbox test used one marker for both a periodic seam
and `Gamma_out`, while the relaxation test instantiated the IR-only legacy
`spin_orbit_torque` variant instead of canonical `prescribed_sot.fullmag.v1`.
Both are now fail-closed and covered by the passing suite. The dedicated OE-T0
TSAN recipe compiles and instruments the target but cannot start under the
current WSL2 mapping
(`ThreadSanitizer: unexpected memory mapping`); this is an environment blocker,
not a passing race proof.

### 27.4. Re-estimated completion

The previous ledger value was **69% implementation / 41% production readiness**.
After the DOS-backed `C_s` adapter, executable bounded FDM M2 SML lowering,
reciprocal checkpoint identity repair, runner balance/power artifact proof, and
the managed cutoff-free OE-F1 singular/near quadrature gate, the current
estimate is **73% implementation / 45% production readiness**.
The increase is deliberately bounded: SML is executable only in the reference
FDM CPU lane, `C_s=e^2N_0` is still a scalar nonmagnetic reduction, and no
native weak-form, FEM/GPU, device-residency, or browser proof is implied. The
planner-suite closure adds verification confidence but no new executable
backend lane. These percentages do not count source stubs or semantic-only
capability rows as
production work. The following independent gates remain open:

1. production SML reservoir weak form, spatially coupled DOS/susceptibility
   `C_s`, and thermodynamic production proof beyond the bounded local FDM
   reference algebra;
2. OE-F1 target-space projection, independent high-depth/reference convergence,
   and FEM/FDM convergence (the direct singular/near quadrature sub-gate is now
   green only within the bounded CPU/FP64 oracle envelope);
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

## 28. Addendum — bounded OE-F1 target-space projection (2026-08-02)

This addendum records the next OE-F1 implementation slice after the
cutoff-free singular/near quadrature gate. It is deliberately narrower than a
production field publication: the code now demonstrates a consistent target
space projection contract, but it does not promote FEM Oersted to a runtime
capability.

### 28.1. Reproducible identity

| Pole | Wartość |
|---|---|
| worktree | `/home/kkingstoun/git/fullmag/fullmag/.worktrees/spin-transport-final` |
| branch | `codex/spin-transport-final` |
| implementation HEAD | `e3f178192eafb2e638ca231c343263d3881778e6` |
| prior singular/near implementation checkpoint | `7f9b2ade4cfb086bc9c264805ae335dd329ace9f` |
| prior plan checkpoint | `acece2bb0f675c3d3a85b7cad97994cf134dc781` |
| current local `master` | `c262fa9d1ba660d70ed3d0849e6fe3469c9e5f32` |
| merge-base (`HEAD`, `master`) | `0612941f3b99137cbb171c183452368cc0f71029` |
| divergence at this checkpoint | `128` commitów tylko na gałęzi, `574` tylko na `master` |
| integration | nie wykonana; wymagany semantic replay na nowym worktree od aktualnego `master` |
| build storage | `/zfn2/mateuszz/git/fullmag`; native FEM proof wyłącznie przez repozytoryjne receptury `just` i zarządzany kontener |

### 28.2. Zrealizowany slice OE-F1

`DirectTetraQuadrature::ProjectField` dodaje bounded CPU/FP64 consistent
`L2` projection do docelowego pola H1. Kontrakt waliduje trójwymiarową siatkę
tetraedryczną, `vdim=3`, `Ordering::byVDIM` i kolekcję `H1_3D_*`; odrzuca
inne przestrzenie zamiast wykonywać niejawny fallback. Dla każdego komponentu
montowany jest scalar consistent mass system na tej samej kolekcji H1, RHS
próbkuje cutoff-free direct Biot--Savart na targetowych punktach całkowania,
a rozwiązanie przechodzi jawny residual check układu masowego. Diagnostyka
sumuje source-target pairs, near refinement, błędy i fail-closed
unconverged-pair count dla wszystkich trzech komponentów.

Ważna granica: to jest reference-only API. Nie ma jeszcze materializacji
`H_oe` w runtime/session/ProblemIR, nie ma publicznej capability, nie ma
target-quadrature error estimatora ani dowodu zachowania dla nakładających się
siatek źródła i celu przy produkcyjnym limicie kosztu. Dla bliskich par
wyczerpanie budżetu głębokości nadal kończy się błędem, a nie przybliżeniem.

### 28.3. Świeży dowód managed

| Gate | Wynik | Zakres i ograniczenia |
|---|---|---|
| `just verify-fem-oersted-oef1-cpu-contract` | `pass` (fresh, managed, `e3f17819`) | CPU-only CMake (`FULLMAG_ENABLE_CUDA=OFF`, `FULLMAG_ENABLE_FEM_GPU=OFF`, `FULLMAG_USE_MFEM_STACK=ON`); cztery testy conservative-current CTest przeszły; direct contract obejmuje signed far, interior/face/edge singular/near, default h+p convergence, depth fail-closed oraz bounded H1 projection na rozdzielonych siatkach; brak device/GPU/production-scaling proof |
| `python3 scripts/check_physics_docs_gate.py --base HEAD~1 --head HEAD` | `pass` | zmiana fizyki i implementacji ma odpowiadającą aktualizację `docs/physics/0980...`; nie jest to runtime qualification |

### 28.4. Aktualizacja oceny

Ocena pozostaje **73% implementacji / 45% gotowości produkcyjnej**. Projekcja
H1 zamyka następny bounded reference sub-gate, ale nie dostarcza jeszcze
niezależnego target-space convergence, porównania FEM/FDM ani integracji z
runtime. Podniesienie procentu byłoby mylące bez tych dowodów.

Następne wymagane bramki OE-F1 są rozłączne:

1. target-rule refinement/error estimator oraz test projekcji na nakładających
   się siatkach z certyfikowaną tolerancją near-pair;
2. niezależny high-depth/reference oracle i tabela zbieżności FEM/FDM;
3. cross-layer materializacja `H_oe` (ProblemIR/planner/runtime/API/UI) z
   requested/resolved provenance;
4. dopiero potem kwalifikacja OE-F2 na airboxie i porównanie obu realizacji.

## 29. Addendum — stan replayu STT/SOT/SHE/Oersted po integracji kontraktów (2026-08-02)

Ten wpis zastępuje procentowy snapshot z rozdziału 28 dla bieżącego replayu.
Nie jest jeszcze post-merge release reportem: replay znajduje się w osobnym
worktree, a `master` pozostaje nienaruszony.

### 29.1. Tożsamość i stan integracji

| Pole | Wartość |
|---|---|
| worktree | `/home/kkingstoun/git/fullmag/fullmag/.worktrees/spin-transport-replay-20260802` |
| branch | `codex/spin-transport-replay-20260802` |
| base HEAD | `c262fa9d1ba660d70ed3d0849e6fe3469c9e5f32` |
| merge source | `f2c5bb9bcdc9c0e18b3d0fb1ea98e2a3de8a66f6` (`codex/spin-transport-final`) |
| stan Git | merge rozstrzygnięty tekstowo i staged; `MERGE_HEAD` nadal aktywny, bez merge commit |
| ciężkie artefakty | `/zfn2/mateuszz/git/fullmag`; native FEM/FDM przez repozytoryjne receptury `just` w zarządzanych kontenerach |

### 29.2. Co jest obecnie potwierdzone

| Obszar | Dowód | Granica dowodu |
|---|---|---|
| Rust engine/API/IR/planner/runner | zapisane zielone suite: engine `293`, API `740`, IR `78 + 178` integracyjnych, plan `290`, runner `725` | testy host/container nie są dowodem urządzenia GPU ani pełnej trajektorii fizycznej |
| Python DSL i round-trip | focused round-trip dla field drives, monitorów planarnych i thermal metadata zielony; pełna suita `1354 passed, 83 failed, 3 skipped, 69 warnings, 549 subtests` | pozostałe awarie dotyczą m.in. benchmarków, meshingu, managed runtime i historycznych kontraktów relaxation; pełna suita nie jest zielona |
| FEM CPU Oersted/transport | managed OE-T0, OE-F1, OE-F2 oraz steady-transport ABI/contract przeszły | OE-F1 nadal bounded CPU/FP64; brak niezależnej zbieżności target-space i skalowania produkcyjnego |
| FDM SOT | `just verify-fdm-prescribed-sot-native-contract` — algebra, CUDA fp64/fp32 contract i runner CUDA check przeszły | brak świeżego device-residency/parity proof na docelowej karcie |
| FDM dynamiczne Oersted | `just verify-fdm-oersted-native-contract` — stage-time, rollback, adaptive, FSAL, ABM3 i axis oracle przeszły | nie zastępuje end-to-end produkcyjnej symulacji racetrack/skyrmion |
| FEM STT | `just verify-fem-stt-native-contract` po dodaniu `libboost-dev` do obrazu GPU; native contract i append-only FFI test przeszły | kontrakt kompilacyjny/ABI, nie kwalifikacja wykonania na urządzeniu |
| Python–API–UI | wygenerowany OpenAPI v2, route/client parity; `pnpm ... typecheck` przechodzi; focused Control Room `8 files, 103 tests` przechodzi | browser/CDP smoke dla authoring/export/run/inspect nie został jeszcze wykonany |
| UI field drives/planar monitors | dodano brakujące ścieżki, metody `ControlRoomApi`, selekcję `physics-field-drive`, manifest mesh i dedykowane inspectory | visual proof i testy interakcji w realnej przeglądarce nadal otwarte |

### 29.3. Zaktualizowana ocena celu

Na podstawie powyższych, rozdzielonych bram:

- **implementacja: 82%** — semantyka STT/SOT/SHE/Oersted jest przeprowadzona
  przez IR, planner, runner, FDM/FEM, Python i API/UI, a główne kontrakty
  algebraiczne/ABI są wykonywalne;
- **gotowość produkcyjna: 58%** — istnieją zarządzane CPU/native gates, ale
  nadal brakuje dowodu urządzenia GPU, pełnej zbieżności FEM/FDM, produkcyjnego
  weak-form SML/transportu, cross-backend parity, browser smoke i post-merge
  replayu na docelowym `master`.

Procenty są wskaźnikiem postępu, nie capability label. Nie podnoszą żadnego
wiersza do `production_executable` ani `validated`.

### 29.4. Pozostałe bramki do zamknięcia celu

1. Zakończyć merge commit w replay worktree i wykonać post-merge managed gates
   na dokładnym SHA, a dopiero potem lokalnie zmergować do `master`.
2. Uruchomić rzeczywisty browser/CDP smoke dla authoring, eksportu, run,
   selekcji monitorów i inspekcji wszystkich parametrów; osobno zachować
   wynik niezweryfikowany, gdy środowisko przeglądarki nie wystartuje.
3. Wykonać pełną kwalifikację GPU z identity urządzenia, brakiem fallbacku,
   telemetry transfer/residency oraz FP64 parity.
4. Dokończyć OE-F1 target-space error estimator, niezależny high-depth oracle,
   tabelę zbieżności FEM/FDM i skalowalny OE-F2 z certyfikatem topologii.
5. Zastąpić bounded SML/FDM reference lane produkcyjnym weak-form transportem,
   przestrzennym `C_s`/DOS i thermodynamic proof.
6. Zamknąć 83 awarie pełnej suity Pythona albo udokumentować każdą jako
   niepowiązaną z celem i uzyskać odrębne, zielone gates dla całego łańcucha.
7. Dopiero po tych punktach przygotować końcowy raport porównawczy z external
   solvers i oznaczyć zakresy jako `validated`.

## 30. Addendum — lokalny merge do `master` i świeże bramy (2026-08-02)

Replay został włączony do lokalnego `master` bez naruszenia istniejącej zmiany
użytkownika w `external_solvers/3`.

| Pole | Wartość |
|---|---|
| merge commit do `master` | `211b56dad960ef8ee7ebf774d230b6dfa7ff684a` |
| merge parent 1 | `ada50ce635c114b838a97b885a738f002805fd4d` |
| merge parent 2 | `e740cf90df91c4933186dcfeb9cf1c56de3b8d4d` |
| aktualny `master` po ledgerze | `bbd6ea74` (zawiera również istniejący commit `1066306c`) |
| stan roboczy | `external_solvers/3` pozostaje zmieniony i niestaged; istniejący untracked audit nie był dotykany |
| relacja do `origin/master` | lokalny `master` jest `133` commitów do przodu; nie wykonywano pushu z tej sesji |

Świeże bramy na dokładnym drzewie `master`:

- `just verify-fdm-prescribed-sot-native-contract` — **PASS**: algebra,
  CUDA fp64/fp32 runtime i runner CUDA check;
- `just verify-fdm-oersted-native-contract` — **PASS**: stage-time, rollback,
  adaptive, FSAL, ABM3 i axis oracle;
- `just verify-fem-stt-native-contract` — **PASS**: pełna biblioteka FEM,
  `fem_stt_contract` oraz append-only FFI test; zarządzany obraz zawiera
  `libboost-dev`;
- Control Room `pnpm ... typecheck` — **PASS**;
- focused Control Room — **8 plików, 103 testy PASS**.

Nie wykonano jeszcze pushu do `origin/master`, browser/CDP smoke, pełnej suity
Pythona ani device-residency/parity qualification GPU. Dlatego ocena celu
pozostaje **82% implementacji / 58% gotowości produkcyjnej**; merge do lokalnego
`master` nie zmienia granic kwalifikacji fizycznej.

## 31. Addendum — post-merge browser smoke i pełna suita Python (2026-08-02)

Ten wpis aktualizuje bramy z rozdziału 30 po świeżej weryfikacji na lokalnym
`master`. Nie zmienia kwalifikacji backendów ani nie zastępuje niezależnego
dowodu urządzenia GPU, zbieżności FEM/FDM lub produkcyjnego transportu SML.

### 31.1. Tożsamość i zachowanie stanu

| Pole | Wartość |
|---|---|
| `master` przed aktualizacją planu | `5e17012328648aef14498237baf95f6dea998958` |
| zmiana | `5e170123` — stabilizacja CDP smoke transport authoring |
| zachowana zmiana użytkownika | `external_solvers/3` pozostaje zmieniony i niestaged |
| zachowany artefakt zewnętrzny | `docs/audits/2026-08-02-mumax3-fullmag-sp4-fdm-comparison.md` pozostaje untracked i nie został zmodyfikowany |
| build storage | `/zfn2/mateuszz/git/fullmag`; ciężkie buildy nadal wyłącznie przez zarządzane receptury `just` |

### 31.2. Zamknięte bramy UI

| Gate | Wynik | Zakres i ograniczenie |
|---|---|---|
| `pnpm --dir apps/control-room exec vitest run scripts/smoke-transport-authoring-ui-runtime.test.mjs` | **PASS — 9/9** | kontrakt runtime smoke |
| `node apps/control-room/scripts/smoke-transport-authoring-ui-cdp.mjs` | **PASS** | świeży Next.js na `localhost:3100`; authoring, CRUD, eksport stanu, `solve`, nawigacja Results i inspekcja pola `m` dla bieżącego transportu |
| obserwacje przeglądarki | **bez błędów** | fixture przygotowania symulacji ma komplet etapów v2; poprawka zapisuje diagnostykę selektora, zasobów i błędów JS |

Smoke nie pokrywa wszystkich parametrów v2 ani wszystkich wariantów FEM/FDM,
GPU, field-drive i monitorów planarnych. Jest dowodem integracji wybranego
łańcucha transportowego, nie pełnym browser qualification.

### 31.3. Świeża pełna suita Python

Polecenie:

```text
PYTHONPATH=packages/fullmag-py/src TMPDIR=/tmp/fullmag-pytest pytest -q packages/fullmag-py/tests
```

Wynik: **1385 passed, 59 failed, 3 skipped, 69 warnings, 549 subtests** w
`670.09 s`. Wśród awarii są kontrakty wpływające na pozostałą kwalifikację
łańcucha (eksport etapów SP4, round-trip zaawansowanego/adaptacyjnego relaksu,
accepted-step autosave SP4, mesh persistence i część dokumentacji API), a także
niezależne benchmarki FEM/GPU i historyczne testy meshingu. Dlatego nie wolno
raportować pełnej suity jako zielonej ani traktować wszystkich 59 awarii jako
awarii STT/SOT/SHE.

Focused transport/round-trip i native gates z rozdziału 30 pozostają ważne,
ale mają węższy zakres niż pełna suita.

### 31.4. Ocena po świeżych dowodach

Ocena pozostaje **82% implementacji / 58% gotowości produkcyjnej**. Smoke
przeglądarki zamyka jedną wcześniej otwartą bramę integracyjną, lecz nie
materializuje brakujących parametrów w browser qualification; pełna suita
Pythona nadal ma 59 awarii. Brak nowego dowodu produkcyjnego oznacza, że
podnoszenie drugiego procentu byłoby nieuzasadnione.

Pozostają co najmniej następujące niezależne bramy:

1. rozdzielić i naprawić lub formalnie sklasyfikować 59 awarii Python, w tym
   kontrakty relaksacji/etapów i SP4 accepted-step table;
2. rozszerzyć browser smoke na wszystkie parametry v2, field-drive, monitory
   planarne oraz warianty execution/backend, z wizualnym dowodem UI;
3. uzyskać świeży device identity/residency i FP64 parity dla GPU;
4. dokończyć OE-F1 estimator/high-depth oracle i tabelę zbieżności FEM/FDM oraz
   skalowalny OE-F2;
5. zastąpić bounded SML/FDM reference lane produkcyjnym weak-form transportem,
   przestrzennym `C_s`/DOS i dowodem termodynamicznym;
6. zbudować aktualny launcher porównawczy i zamknąć raport z external solvers
   bez mieszania starych artefaktów z dowodem bieżącego `master`.

## 32. Addendum — odtworzenie MuMax3 Standard Problem 5 (2026-08-02)

Na podstawie `external_solvers/3/test/standardproblem5.mx3` dodano zwykły
stage-first workflow FDM:

### 32.0. Tożsamość dowodu

Authoring, nota fizyczna, test i raport zostały zapisane w commitcie
`5d4ec204` na lokalnym `master`. Ciężkie artefakty wykonania pozostają pod
`/zfn2/mateuszz/git/fullmag/runs/`; istniejące, niezwiązane zmiany robocze nie
zostały do tego commitu dołączone.

- `examples/mumax_standard_problem_5_fdm.py` — literalne `32 x 32 x 4`,
  `100 x 100 x 10 nm`, `Ms=800 kA/m`, `Aex=13 pJ/m`, vortex `(1,1)`,
  Zhang–Li `J=(1e12,0,0) A/m²`, `degree=1`, `beta=xi=0.05`, `run=1 ns`;
- `packages/fullmag-py/tests/test_standard_problem_5_fdm.py` — focused
  source-to-IR test, **1 passed**;
- `docs/physics/0990-mumax-standard-problem-5-fdm-validation.md` wraz z
  source map — kompletna definicja fizyki, jednostek, mappingu API/IR,
  ograniczeń backendów i bram kwalifikacji;
- `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/SP5_FULLMAG_MUMAX_COMPARISON.md`
  — raport z reprodukcji i wykonanych artefaktów.

### 32.1. Korekta geometrii

Źródłowe `setcellsize(...,10e-9/4)` oznacza całkowitą grubość `10 nm`.
Wariant `40 nm` byłby błędną interpretacją i został wykluczony testem. Fullmag
loweruje `cell=(3.125,3.125,2.5) nm` oraz `universe.size=(100,100,10) nm`.

### 32.2. Wyniki runtime — historyczny baseline v0

| Gate | Wynik | Granica |
|---|---|---|
| FDM Python/IR | **PASS** | kontrakt authoringu; nie jest to dowód trajektorii |
| FDM CUDA adaptive RK45 | **EXECUTABLE, UNVALIDATED** | single-grid v2 identity is now explicit; clean trajectory/trace qualification remains open; no CPU fallback |
| FDM CUDA fixed Heun, `dt=1e-13 s`, relax `1e-4 T` | wykonany, `not_evaluated` | `m_final` mean `(-0.23433556,-0.09937264,0.02290284)`; max błąd `4.84e-3` |
| FDM CUDA fixed Heun, `dt=1e-14 s`, relax `1e-4 T` | wykonany, `not_evaluated` | `m_final` mean `(-0.23433558,-0.09937265,0.02290284)`; max błąd `4.84e-3` |
| FDM CUDA fixed Heun, `dt=1e-14 s`, relax `1e-6 T` | wykonany, `not_evaluated` | `m_final` mean `(-0.23433558,-0.09937255,0.02290284)`; max błąd `4.84e-3` |

Referencja z pliku MuMax3 to
`(-0.23479773,-0.09453578,0.02296375)` z tolerancją `1e-4` na komponent.
Wszystkie trzy ukończone przebiegi diagnostyczne przekraczają tę tolerancję, głównie w
`m_y`; nie są kwalifikacją. `qualification.json` ma `status=not_evaluated`.

W tym historycznym artefakcie, utworzonym przed poprawką publikacji skalarów,
`scalars.csv` zawierał `mx=my=mz=0`, mimo że `m_final.json` miał 4096
niezerowych wektorów. Do porównania użyto więc średniej z `m_final.json`.
Aktualny stan tej bramy opisuje addendum 32.6.3.

### 32.3. Wpływ na procent realizacji — stan przed świeżym v1

Odtworzenie SP5 zwiększa pokrycie aplikacyjnego workloadu i daje konkretny
source-to-IR oraz executed-device diagnostic, ale nie zamyka żadnej z
niezależnych bram produkcyjnych. Na tym historycznym etapie ocena wynosiła
**82% implementacji / 58% gotowości produkcyjnej**. Do zamknięcia pozostają: CPU adaptive RK45 z
kwalifikowaną relaksacją, rozdzielenie błędu stanu
od konwencji Zhang–Li/demag, device-resident GPU adaptive parity, pełna suita
Python, cross-backend FEM/FDM oraz końcowy browser/provenance gate.

### 32.4. Zidentyfikowana różnica dyskretyzacji Zhang–Li

Porównanie kodu źródłowego wykazało rozdzielną, konkretną różnicę numeryczną:

- MuMax3 `external_solvers/3/cuda/zhangli2.cu` liczy centralną różnicę
  `deltax=(m[i+1]-m[i-1])` i skaluje ją przez `1/(2*cell_size)`; ten sam kernel
  ma prefaktor `MUB/(2*QE*GAMMA0)` i zwraca torque w teslach;
- Fullmag `crates/fullmag-engine/src/fdm/cpu/fields.rs` w legacy evaluatorze
  wybiera sąsiada upwind na podstawie znaku `J` i liczy `(m_i-m_{i-1})/dx`
  (analogicznie dla pozostałych osi), a wynik dodaje bezpośrednio do RHS w
  `1/s`.

Mapowanie parametrów (`J`, `Pol`, `xi`) było poprawne semantycznie, ale
historyczny operator przestrzenny nie był MuMax3-compatible. Plateau błędu
`4.84e-3` przy `dt=1e-13` i `1e-14 s` pozostaje baseline'em starego v0, a nie
dowodem błędnego znaku ani prefaktora. Wersjonowana realizacja centralna i
oracle zostały dodane w addendum 32.5; legacy v0 nie został zmieniony.

## 32.5. Implementacja wersjonowanego operatora MuMax3 (2026-08-02)

Wprowadzono następny krok bez naruszania `zhang_li.legacy_fullmag.v0`:

- `ZhangLiSTT` przyjmuje jawne `operator_version="zl_mumax3_central_v1"`;
  canonical identity (`id`, `target`, `lande_g`) przechodzi przez Python,
  loader, script builder, SceneDocument, IR i `FdmPlanIR`;
- planner dopuszcza MuMax3 wyłącznie na FDM i odrzuca FEM, a canonical FEM
  `zhang_li.fullmag.v1` odrzuca na FDM zamiast uruchamiać zły legacy stencil;
- FDM CPU realizuje dokładne stałe z `zhangli2.cu`, centralny stencil z clamp/PBC,
  Gilbert projection i bezalokacyjną ścieżkę SoA; oracle testuje brzeg oraz
  zgodność AoS/SoA;
- ABI `fullmag_fdm_plan_desc` oraz `SttParams` przenoszą discriminator do
  natywnych FP64/FP32 kernelów CUDA. Obie precyzje mają osobną gałąź centralną,
  a dotychczasowa gałąź legacy pozostaje niezmieniona;
- źródłowy native contract `stt_pbc_contract` sprawdza obecność ABI, kontekstu,
  centralnego stencilu i wszystkich osi okresowych.

Dowody wykonane lokalnie:

| Gate | Wynik | Granica |
|---|---|---|
| Python SP5 + STT focused | **19 passed** | authoring/IR, bez trajektorii |
| `cargo check -p fullmag-plan` | **PASS** | planowanie, bez runtime device |
| `cargo check -p fullmag-runner` | **PASS** | CPU/native wrapper compile, bez managed CUDA build |
| `fullmag-engine` MuMax3 one-step oracle | **1 passed** | algebra i clamp, bez cross-backend trajectory |
| CUDA managed rebuild + SP5 rerun | **DONE — diagnostyczny** | świeży runtime i device-resident run wykonane; trajektoria nie przechodzi tolerancji |

Do zamknięcia bramy SP5 pozostaje: pełny CPU adaptive RK45, sweep kroku i
niezależne rozdzielenie stanu relaksacji, operatora, demagnetyzacji i kolejności
aktualizacji. GPU fixed-step pozostaje `diagnostic-unqualified`.

## 32.6. Świeże wykonanie SP5 i rozdzielenie defektu artefaktu od fizyki (2026-08-02)

### 32.6.1. Tożsamość i wykonanie referencji

MuMax3 uruchomiono bezpośrednio z `external_solvers/3/test/standardproblem5.mx3`.
Wersja binarna to `v3.11.2`, commit `13ac56f1`, CUDA 12.4, NVIDIA GeForce RTX
4080 SUPER, compute capability 8.9. Proces zakończył się kodem 0, a źródłowe
`expect()` potwierdziły tolerancję `1e-4`. Zmierzone wartości:

```text
(-0.23488366603851318, -0.09453280270099640, 0.022961989045143127)
```

Artefakt referencji: `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-mumax3-reference-20260802-01`.
Różnica względem literalnego golden w pliku źródłowym ma maksimum `8.59e-5`,
więc wynik referencyjny mieści się w deklarowanej tolerancji.

### 32.6.2. Fullmag managed CUDA

Recepta `FULLMAG_ALLOW_DIRTY_RUNTIME_EXPORT=1 FULLMAG_FEM_RUNTIME_REUSE_BUILD=1
FULLMAG_RUNTIME_PRUNE=0 just rebuild-fem-runtime` zakończyła się poprawnie.
Weryfikacja manifestu wykazała schema-v3, compute capability 8.9, ładowany
HYPRE oraz commit źródłowy użyty przy eksporcie. Współdzielone drzewo robocze
zmieniło commit podczas eksportu przez równoległy proces, dlatego ten runtime
nie jest dowodem czystej/reproducible gałęzi; sam przebieg ma jawny device
provenance i brak fallbacku.

Fullmag uruchomiono z:

```text
FULLMAG_FDM_EXECUTION=gpu
FULLMAG_SP5_DEVICE=gpu
FULLMAG_SP5_FIXED_DT=1e-13
FULLMAG_SP5_RELAX_TOL_T=1e-6
FULLMAG_SP5_RELAX_MAX_STEPS=10000
```

Artefakt: `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-20260802-gpu2`.
`metadata.json` potwierdza `execution_engine=cuda_fdm`, RTX 4080 SUPER, FP64,
cuFFT i `lossy_fallback_used=false`. Średnia końcowa:

| komponent | MuMax3 | Fullmag `zhang_li.mumax3.v1` | różnica |
|---|---:|---:|---:|
| $\bar m_x$ | `-0.2348836660385` | `-0.1168850822571` | `+1.1799858378145e-1` |
| $\bar m_y$ | `-0.0945328027010` | `-0.0482401146804` | `+4.6292688020580e-2` |
| $\bar m_z$ | `+0.0229619890451` | `+0.0257941117845` | `+2.8321227393710e-3` |

Maksimum błędu komponentowego wynosi `1.1799858378e-1`, około 1180 razy ponad
`1e-4`; `qualification.json` pozostaje `not_evaluated`. To jest wykonany wynik
diagnostyczny, nie kwalifikacja produkcyjna. Pełny CPU przebieg został
uruchomiony, ale przerwany w relaksacji przy kroku 550 z powodu kosztu
otwarto-granicznej demagnetyzacji; CPU one-step oracle pozostaje zielony, lecz
nie zastępuje full-trajectory gate.

### 32.6.3. Scalar publication

Aktywna ścieżka CUDA w `crates/fullmag-runner/src/dispatch.rs` pobiera jeden
snapshot `final_magnetization`, używany zarówno do `m_final.json`, jak i do
końcowego `scalars.csv`. Focused test
`dispatch::tests::native_cuda_scalar_output_boundary_reduces_m_before_recording`
przeszedł. W świeżym artefakcie różnice scalar–średnia pola wynoszą
`(2.8e-17, 0.0, -3.5e-18)`, więc dawny zerowy fallback artefaktu został usunięty.

### 32.6.4. Ocena i następne bramy

Wynik centralnego v1 jest gorszy od historycznego legacy upwind baseline'u i
nie mieści się w tolerancji MuMax3. Nie wolno z tego wnioskować o błędnym
prefaktorze, znaku lub demagnetyzacji bez osobnych testów kontrolnych. Następne
bramy muszą rozdzielić: (1) stan po relaksacji, (2) sam operator z analitycznym
gradientem, (3) sweep `dt`, (4) demagnetyzację i kolejność aktualizacji oraz
(5) pełny CPU adaptive RK45.

Po tym dowodzie ocena celu wynosi konserwatywnie **84% implementacji / 58%
gotowości produkcyjnej**. Implementacja rośnie dzięki zamknięciu wersjonowanego
operatora, ABI CUDA i publikacji skalarów; gotowość produkcyjna pozostaje bez
zmiany, ponieważ świeża trajektoria nie przechodzi tolerancji, CUDA adaptive
nie ma capability identity, a cross-backend/FEM i pełna suita Python nadal nie
są zamknięte.

## 32.7. Porównanie SHE z BORIS — wynik audytu 2026-08-02

Porównano normatywną stronę Fullmag
`docs/physics/0970-spin-hall-drift-diffusion-transport.md`, kontrakt runtime,
capability matrix oraz lokalne źródła
`external_solvers/BORIS/Boris`. Szczegółowy raport znajduje się w
`BORIS_FULLMAG_SHE_COMPARISON.md` w tym katalogu.

### 32.7.1. Rozstrzygnięcie fizyczne

BORIS jest obecnie silniejszym **wykonywalnym wzorcem**: ma sekwencyjny solve
charge/spin, direct SHE (`SHA`), inverse SHE (`iSHA`), N/F/T contacts,
`Gi/Gmix`, bulk/interface torque oraz CPU/CUDA realizację. Fullmag ma
czytelniejszą **docelową formulację**: pełne `mu_s`, rozdział M1/M2/M3, jedna
macierz reciprocal, jawne jednostki i bilanse. To drugie nie jest jeszcze
dowodem produkcyjnej implementacji.

W szczególności nie wolno utożsamiać BORIS `S` z Fullmag `mu_s`. BORIS jawnie
używa adaptera `V_s=(De/elC)(e/muB)S`, natomiast Fullmag definiuje `mu_s` jako
pełne rozszczepienie kanałów `V +/- mu_s/2`. Każdy benchmark musi ustalić tę
konwersję na profilu analitycznym, a nie dopasowywać znak lub skalę torque po
wykresie.

### 32.7.2. Nowa bramka porównawcza

Dodano niezależny gate `SHE-BORIS-001`:

- [ ] zamrożona tożsamość snapshotu BORIS;
- [ ] 1D direct-SHE z `iSHA=0` i wspólnymi `De`, `elC`, `lambda_sf`;
- [ ] 1D reciprocal z `iSHA=SHA`;
- [ ] konwersja `S <-> mu_s` oraz tabela znaków/normalnych;
- [ ] porównanie `V`, akumulacji, pełnego `Q_ia`, fluxu normalnego, residualu,
      charge/spin balance i torque interfejsowego;
- [ ] trzy siatki, sweep tolerancji i limitów iteracji;
- [ ] BORIS CPU/CUDA oraz Fullmag FDM CPU, FEM CPU i kwalifikowane GPU;
- [ ] zapis artefaktów i provenance bez awansu capability przed przejściem.

Do czasu zamknięcia `SHE-BORIS-001` direct/inverse SHE Fullmag pozostaje
`semantic_only` poza jasno ograniczonym FEM CPU M1 reference slice, a ocena
gotowości produkcyjnej pozostaje **58%**. Ocena pokrycia implementacyjnego
pozostaje **84%**; porównanie nie dodaje punktów za samą obecność zewnętrznego
solvera.

## 32.8. Korekta kontrolera adaptacyjnego CUDA po merge (2026-08-02)

Końcowa weryfikacja ujawniła regresję w scalonej ścieżce integratorów RK23/DP45:
merge pozostawił starsze warianty czterech kernelów, bez typowanego
`dt_min_exhausted`, snapshotu FSAL i normalizacji błędu przez `atol`/`rtol`.
Dodatkowo legacy kernel polityki adaptacyjnej dostawał `adaptive_atol` jako
próg, mimo że nowy kernel błędu zwraca już bezwymiarowy błąd znormalizowany.
Skutkiem było efektywne zastosowanie `atol` po raz drugi i fałszywe wyczerpanie
minimalnego kroku w teście z dynamicznym polem Oersteda.

Korekta obejmuje wyłącznie istniejący kontrakt numeryczny: wszystkie cztery
integratory CUDA liczą błąd z tą samą skalą `atol + rtol |m|`, zachowują
`current_dt`, FSAL i stan magnetyzacji przy odrzuceniu/terminalnym
`dt_min_exhausted`, a ścieżka fixed-step odświeża obserwable na końcu kroku.
Legacy kontroler otrzymuje próg `1.0`, zgodny z bezwymiarowym wynikiem kernela.

Świeże bramy managed/container po zmianie:

| Gate | Wynik | Granica |
|---|---|---|
| `just verify-fdm-time-domain-native-contract` | **PASS** | ABI/source contract CPU+CUDA dla polityki czasu, Oersteda i partial-cell |
| `just verify-fdm-oersted-native-contract` | **PASS** | wykonany CUDA runtime: stage-time, rollback, adaptive, FSAL, ABM3 i oracle osi |
| `just verify-fdm-zhang-li-native-contract` | **PASS** | PBC/central-stencil contract oraz `cargo +nightly check --features cuda` |
| `just verify-fdm-prescribed-sot-native-contract` | **PASS** | algebra SOT, CUDA FP64/FP32 runtime oraz `cargo +nightly check --features cuda` |

Naprawa przywraca zamierzony kontrakt kontrolera i usuwa konkretną regresję
merge, ale nie jest nową kwalifikacją fizyki. Nadal nie zamyka pełnej trajektorii
SP5 (świeży fixed-step GPU wynik ma `qualification.json=not_evaluated` i
maksymalny błąd około `1.18e-1`), bramy `SHE-BORIS-001`, cross-backend FEM/FDM
ani produkcyjnej kwalifikacji adaptive GPU. Ocena pozostaje **84%
implementacji / 58% gotowości produkcyjnej**.

## 32.9. Granica parametru `lande_g` w realizacji MuMax3 (2026-08-02)

Audyt ścieżki Python → IR → FDM wykazał, że canonical `lande_g` był wcześniej
przenoszony jako metadana, lecz nie był używany przez kernel
`zhang_li.mumax3.v1`. Był to błąd kontraktu: wartość `1.9` mogła przejść
authoring, a wykonanie nadal używało stałych z zewnętrznego
`zhangli2.cu`. Nie wolno naprawiać tego przez ciche przemnożenie prefaktora,
bo zmieniłoby to źródłowo zgodną realizację SP5.

Ustalona granica jest teraz jawna i testowana:

- MuMax3-compatible `zl_mumax3_central_v1` wymaga `lande_g == 2.0`, zgodnie z
  ustalonym przez źródło `GAMMA0=1.7595e11`; Python i walidator IR odrzucają
  inną wartość komunikatem wskazującym `lande_g=2.0`;
- `zhang_li.fullmag.v1` zachowuje pełny parametr `g` dla realizacji FEM/reference;
- konfigurowalny `g` w FDM wymaga nowej wersji formuły, osobnego ABI/kernela i
  niezależnego oracle'a — nie jest udawany przez obecny v1.

Dowody:

| Gate | Wynik |
|---|---|
| Python `TestZhangLiSTT` | **19 passed** |
| IR `canonical_mumax3_zhang_li_requires_source_g_factor` | **PASS** |
| JSON source map 0990 | **parseable; updated validation and symbol meaning** |

Ta korekta poprawia zgodność interfejsu i eliminuje ciche ignorowanie parametru,
ale nie zmienia statusu SP5: świeża trajektoria CUDA nadal jest
`not_evaluated`, a pełna kwalifikacja CPU/GPU i cross-backend pozostają otwarte.

## 32.10. Jawna tożsamość adaptive FDM CUDA (2026-08-02)

Po przejściu bram kontraktowych dla kontrolera CUDA usunięto nieaktualną blokadę
planera, która odrzucała każdą adaptację FDM CUDA tylko dlatego, że nie istniał
wiersz tożsamości. Dodano `explicit_adaptive_fdm_cuda_double` do enumu
kwalifikacji, registry oraz mapowania runtime. Wpis ma stan `unvalidated`:
tożsamość wykonawcza jest teraz jawna, lecz registry nie awansuje jej bez
niezależnego artefaktu, czystego źródła i śladu decyzji akceptacja/odrzucenie.

Zakres pozostaje zamknięty:

- dotyczy tylko single-grid FDM CUDA FP64 z RK23/DP45;
- guardy `max_spin_rotation` i `norm_tolerance` nadal są odrzucane, bo native
  enforcement nie jest kwalifikowany;
- publiczny multilayer FDM nadal odrzuca adaptive;
- brak wpisu kwalifikacyjnego nie wywołuje CPU fallbacku.

Dowody po zmianie:

| Gate | Wynik |
|---|---|
| planner `adaptive_fdm_requires_explicit_cpu_and_rejects_auto_or_cuda_routes` | **PASS** — CPU i jawne CUDA/GPU planują; auto nadal odrzucone |
| runner registry lane coverage | **PASS** — 9 spójnych tożsamości, w tym adaptive FDM CUDA double |
| managed runtime przed zmianą planera | **PASS**, ale binarium wymaga ponownego eksportu przed wykonaniem adaptive SP5 |

Świeży managed runtime z tym mappingiem i wykonany adaptive RK45 są opisane w
addendum 32.11. Nie dostarczyły jeszcze accepted-step trace ani kwalifikacji;
ocena pozostaje **84% implementacji / 58% gotowości produkcyjnej**.

## 32.11. Świeży adaptive SP5 na urządzeniu CUDA — wykonanie bez kwalifikacji (2026-08-02)

Po eksporcie runtime z aktualnego dirty tree wykonano SP5 z jawnym
`FDM/CUDA/FP64/RK45/adaptive`. Artefakt
`/zfn2/mateuszz/git/runs/mumax-sp5-fdm-mumax3-v1-20260802-gpu-adaptive1`
potwierdza `execution_engine=cuda_fdm`, RTX 4080 SUPER (CC 8.9), cuFFT,
FP64, `lossy_fallback_used=false` oraz
`qualification_id=explicit_adaptive_fdm_cuda_double` z
`validation_state=unvalidated`. Etap dynamiczny `1 ns` zakończył się kodem 0;
średnia końcowa wyniosła
`(-0.15208459449494185, -0.033110165787384384, 0.025342838207889982)`.
Względem świeżej referencji MuMax3 maksimum błędu komponentowego wynosi
`8.2799071544e-2`, a `qualification.json` pozostaje
`status=not_evaluated`. `solver_attempts.csv` nie daje jeszcze accepted-step
trace, więc dowód jest wykonaniem i identyfikacją lane'u, nie zbieżnością ani
parity.

Próba z `FULLMAG_SP5_RELAX_MAX_STEPS=100000` zakończyła się po około 22 850
krokach relaksacji błędem `cudaMemcpyAsync(reduce_adaptive_error_policy):
unspecified launch failure (719)` i nie wytworzyła finalnego artefaktu.
Ponieważ podczas testu na karcie działały dwa niezależne przebiegi SP4, błąd
pozostaje niesklasyfikowany: przed zmianą kernelu trzeba powtórzyć go na
izolowanym urządzeniu z `CUDA_LAUNCH_BLOCKING=1` oraz zebrać pierwszy failing
kernel. Nie jest to dowód błędnej fizyki ani dowód poprawności.

Ten addendum zamyka wcześniejszy brak samej tożsamości adaptive CUDA, ale nie
zamyka kwalifikacji SP5. Pozostają: accepted-step telemetry, pełna relaksacja
bez błędu, CPU↔CUDA parity, sweep `dt`/siatki, rozdzielenie stanu relaksacji
od operatora Zhang–Li, zgodność demagnetyzacji i kolejności aktualizacji oraz
niezależny artefakt kwalifikacyjny. Ocena pozostaje **84% implementacji / 58%
gotowości produkcyjnej**; nie podnoszę jej za sam fakt wykonania jednego
przebiegu.

## 32.12. Rozdzielenie accepted-step telemetry od output cadence (2026-08-02)

Świeży audyt artefaktu SP5 wykazał defekt obserwowalności, a nie brak samego
kontrolera: `RunResult.steps` przechowuje wiersze wynikające z harmonogramu
scalarów. Skrypt `examples/mumax_standard_problem_5_fdm.py` nie deklaruje
takiego harmonogramu, dlatego `solver_steps.csv` i `solver_attempts.csv`
mogły zawierać tylko końcowy snapshot i nie były dowodem przebiegu
adaptive RK.

### 32.12.1. Korekta implementacyjna

Wprowadzono osobny ślad accepted-step w `ArtifactRecorder`:

- każdy zaakceptowany krok natywnego FDM CUDA jest rejestrowany niezależnie od
  próbkowania `scalars.csv`;
- każdy zaakceptowany krok FDM CPU reference jest rejestrowany tą samą ścieżką;
- ślad jest przenoszony przez wersjonowany artefakt
  `solver/accepted_steps.v1.json` (`LLG-TD-ACCEPTED-TRACE-V1`);
- generator `solver_steps.csv`, `solver_attempts.csv` i `qualification.json`
  wybiera ten pełny ślad, a nie tylko publiczne output rows;
- `scalars.csv`, harmonogramy pól, UI i semantyka `RunResult.steps` nie zostały
  rozszerzone o ukryte wiersze diagnostyczne;
- `metadata.json` publikuje `accepted_solver_steps`, a `m_final` używa czasu,
  kroku i `dt` z ostatniego accepted-step, gdy pełny ślad jest dostępny.

To jest korekta kontraktu obserwowalności. Nie jest jeszcze dowodem fizycznej
zgodności SP5: accepted-step trace zawiera decyzje i residuale, ale nie nadaje
automatycznie statusu `validated`.

### 32.12.2. Dowody

| Gate | Wynik | Granica dowodu |
|---|---|---|
| `cargo test -p fullmag-runner --lib accepted_solver_trace_roundtrips_independently_of_output_rows` | **PASS** | wersjonowany ślad serializuje/deserializuje accepted step i retry; test nie uruchamia GPU |
| wcześniejszy `solver_diagnostics` runner subset | **PASS, 11 tests** | zachowany rozdział attempts/accepted rows; nie zastępuje runtime |
| `just verify-fdm-zhang-li-native-contract` | **PASS** | managed CUDA/CMake FDM build, `stt_pbc_contract`, `cargo +nightly check -p fullmag-runner --features cuda`; brak pełnego SP5 |
| CPU launcher rebuild `just build fullmag 1` | **PASS** | build artefaktów przez `/tmp/fullmag-zfn2-build/cargo-targets/fullmag-cli`, bez CUDA/FEM; nie jest device proof |
| krótki CPU SP5 probe z nowym launcherem | **INTERRUPTED** | probe zatrzymał się na relaksacji przy kroku 20; nie wytworzył finalnego artefaktu i nie kwalifikuje trajektorii |

### 32.12.3. Następna bramka

Po tej zmianie należy powtórzyć SP5 na izolowanym GPU z pełnym accepted trace,
`CUDA_LAUNCH_BLOCKING=1` dla reprodukcji 719 oraz osobny CPU run z kontrolowanym
limitem. Dopiero wtedy można policzyć: liczbę accepted/rejected attempts,
`dt`/grid sweep, CPU↔CUDA parity, rozdzielenie wpływu operatora
Zhang–Li/demag/stanu relaksacji i ewentualnie wypełnić `qualification.json`.
Ocena celu pozostaje **84% implementacji / 58% gotowości produkcyjnej** —
telemetryka zamyka defekt artefaktu, lecz nie zwiększa kwalifikacji fizycznej.

## 32.13. Zredukowana brama BORIS–Fullmag dla direct SHE (2026-08-02)

Źródłowy audyt BORIS wykazał, że `external_solvers/BORIS` jest lokalnym
snapshotem kodu (w `makefile` występuje `BVERSION := 380`). W chwili zamykania
tego historycznego reduced gate checkout nie zawierał zbudowanego `BorisLin`,
więc wynik nie mógł być przedstawiony jako porównanie binarne; późniejszy
patched-build smoke jest zapisany osobno w sekcji 32.20. Nie zmieniono
capability na podstawie samej obecności kodu CUDA.

### 32.13.1. Oracle źródłowy

Dodano `scripts/verify_boris_fullmag_she_1d.py` oraz
`scripts/test_verify_boris_fullmag_she_1d.py`. Workload jest celowo
ograniczony do jednorodnego filmu N, `E=E_x e_x`, przepływu spinu w osi `z`,
`iSHA=0`, stałego `lambda_sf` i zerowego normalnego spin fluxu. Z BORIS
wyprowadzono:

```text
d_n S_y = SHA * sigma * MUB_E * E_x / De
V_s = De*S/(sigma*MUB_E)
d_n V_s = SHA*E_x
```

Po stronie Fullmag zastosowano M1 z `sigma_s=sigma`, `theta_SH=SHA` i
`mu_s=2 V_s`, ponieważ publiczne `mu_s` oznacza pełne `V_+ - V_-`. Wtedy
`Q_zy=-sigma_s*d_z(mu_s)/2+theta_SH*sigma*E_x` ma ten sam profil i ten sam
znormalizowany flux co BORIS.

### 32.13.2. Dowód

| Gate | Wynik | Granica |
|---|---|---|
| `PYTHONPATH=scripts python3 -m pytest -q scripts/test_verify_boris_fullmag_she_1d.py` | **PASS, 4 tests** | reduced oracle; bez uruchomienia BORIS |
| `python3 scripts/verify_boris_fullmag_she_1d.py --json` | **PASS** | profil i flux po konwersji mają błąd `0.0` dla parametrów referencyjnych |
| negatywny test `theta_SH != SHA` | **PASS** | wykrywa zmianę normalizacji zamiast ją maskować |
| SHA-256 źródeł BORIS | **zapisane w wyniku skryptu** | identyfikuje lokalny snapshot, nie release zewnętrzny |

Brama zamknięta przez ten slice to wyłącznie
`SHE-BORIS-REDUCED-1D-DIRECT`. Sekcja 32.20 dodaje ograniczony smoke
wykonywalnego `BorisLin` z patched build copy, ale nie zastępuje reprodukowalnego
wydania. Brama `SHE-BORIS-001` pozostaje otwarta: trzeba wykonać CPU/CUDA,
ustawić osobno `iSHA=SHA`, porównać inverse SHE, profile materiałowe,
interfejsy N/F/T oraz Fullmag FDM/FEM.

Ocena pozostaje **84% implementacji / 58% gotowości produkcyjnej**. Test
analityczny potwierdza konwersję zmiennych i znaku w prostym limicie, ale nie
jest dowodem wykonawczej zgodności solverów.

## 32.14. Managed FEM M1 direct-SHE profile gate i korekta layoutu MFEM (2026-08-02)

Po redukowanym oraclu źródłowym BORIS wykonano rzeczywisty native gate Fullmag
M1 FEM CPU. Dodano do `backends/fem/tests/steady_transport_contract.cpp`
jednorodny workload H1/P1 na siatce `4 x 4 x 32` heksaedrów. Dla stałego
`E_x`, `lambda_sf`, `sigma`, `sigma_s` i `theta_SH` test wymaga:

- `J_x = sigma E_x` z błędem poniżej `1e-10`;
- zbieżności solve spinowego;
- pełnego wektorowego profilu analitycznego poniżej `2e-3` w każdym węźle;
- zgodności `mu_y` góra–dół z profilem `sinh/cosh` w tym samym limicie.

W skończonej szerokości poprzecznej nie wystarcza sprawdzenie jednego kanału.
Konstytutywny tensor SHE ma tu oba niezerowe wpisy `Q_zy` i `Q_yz`, więc
oracle sprawdza jednocześnie:

```text
mu_y(z) = 2 theta_SH sigma E_x lambda_sf
          / (sigma_s cosh(L_z/(2 lambda_sf)))
          * sinh((z-L_z/2)/lambda_sf)

mu_z(y) = -2 theta_SH sigma E_x lambda_sf
          / (sigma_s cosh(L_y/(2 lambda_sf)))
          * sinh((y-L_y/2)/lambda_sf)
```

Test ujawnił rzeczywisty błąd layoutu, wcześniej maskowany przez mały residual
układu liniowego. `steady_transport.cpp` deklarował przestrzenie wektorową i
tensorową jako `mfem::Ordering::byVDIM` (interleaved), podczas gdy indeksowanie
operatora, `copy_by_vdim` i ABI zakładały układ blokowy
`[component][node]`. C API używał tej samej niespójności dla magnetyzacji.
Wszystkie te przestrzenie przełączono na `mfem::Ordering::byNODES`, zgodne z
kontraktem publikacji pól. To korekta fizyczno-numeryczna (usuwa permutację
składowych), a nie zmiana tolerancji, znaku ani prefaktora SHE.

Świeża sekwencja:

```text
just verify-fem-steady-transport-native-contract
```

przeszła kodem `0`. Oprócz native C++/ABI obejmuje ona canonical quantity
metadata, planner, preflight runnera, publikację transportowych pól scalar/vector/tensor,
dispatch oraz v2 data-plane. Uzupełniono również wyłącznie testowe fixtures:
aktualny konstruktor `MeshIR` i komplet czterech faset tetraedru; nie jest to
zmiana modelu fizycznego.

### Granica dowodu

Zamknięty jest teraz signed direct-SHE dla **conforming FEM CPU reference
slice**. Nie zamyka to milestone'u M1 ani bramy `SHE-BORIS-001`: nadal brak
wykonywalnego BORIS CPU/CUDA, reciprocal `iSHA=SHA`, heterogenicznych
materiałów, N/F/T mixing/SML, h-convergence i wspólnego FDM/FEM/GPU
benchmarku. Capability pozostaje ograniczona do jawnego reference scope;
nie wolno awansować ogólnego direct/inverse SHE do `validated`.

Ocena celu pozostaje konserwatywnie **84% implementacji / 58% gotowości
produkcyjnej**. Gate usuwa konkretny defekt komponentowego layoutu i zamyka
jedną bramę referencyjną, ale nie dostarcza jeszcze cross-backend parity,
GPU/device-residency ani produkcyjnego interfejsu SHE. Następne kroki to
niezależny cross-check FDM, test trzech rozdzielczości z residualami i bilansami,
a dopiero potem executable BORIS CPU/CUDA oraz reciprocal/interface workload.

## 32.15. FDM CPU workflow gate i korekta publicznej macierzy capability (2026-08-02)

Silnik FDM posiadał już niezależny test operatora direct-SHE, lecz brakowało
testu pełnego łańcucha `FdmSpinTransportWorkflow`. Dodano do
`crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` workload filmu
`3 x 1 x 48` z jawnym `E_x`, `theta_SH`, `lambda_sf`, `sigma` i `sigma_s`.
Test materializuje canonical descriptor, rozwiązuje charge i spin, rekonstruuje
`J_c` oraz `Q_ia`, publikuje telemetrykę i sprawdza:

- profil `sinh/cosh` dla `mu_y(z)`;
- `J_x = sigma E_x`;
- zerowe niezamierzone składowe spin potential;
- spin scaled residual poniżej `1e-10`;
- wersje `transport_constitutive.one_way.fullmag.v1` i `fv_spin_upwind_v1`;
- rozmiar kompletnego tensorowego artefaktu `Q_ia`.

Weryfikacja referencyjna:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/shelane-runner \
cargo test -p fullmag-runner --lib fdm::cpu::spin_transport::tests
```

zakończyła się wynikiem **17 passed, 0 failed**. To jest dowód pełnego FDM
CPU reference workflow, nie dowód native CUDA ani produkcyjnej kwalifikacji.

### Synchronizacja capability

Po tym dowodzie zaktualizowano `docs/specs/capability-matrix-v0.json` oraz
`docs/specs/capability-matrix-v0.md`. Wpisy
`transport.spin.steady_drift_diffusion.fullmag.v1` i
`transport.spin.direct_she.fullmag.v1` mają teraz `reference_executable` dla
FDM CPU reference i ograniczonego conforming H1/P1 FEM CPU reference slice.
GPU, M2/inverse SHE, mixing/SML, broken/mortar FEM oraz cross-backend pozostają
`semantic_only`; `validated_workloads` pozostaje puste, ponieważ nie wykonano
jeszcze pełnej kwalifikacji produkcyjnej.

Ta korekta usuwa rozjazd między plannerem/runtime, raportem i macierzą, ale nie
zamyka milestone'u M1 ani `SHE-BORIS-001`. Nadal wymagane są wspólny FDM/FEM
continuum benchmark, trzy poziomy siatki z residualami/bilansami, executable
BORIS CPU/CUDA, `iSHA=SHA`, inverse SHE i interfejsy N/F/T.

## 32.16. Bramy Python/API/UI dla transportu (2026-08-02)

Po zmianie statusu referencyjnego FDM CPU sprawdzono pełny łańcuch produktu, aby
`reference_executable` nie oznaczał wyłącznie testu silnika:

```text
TMPDIR=/tmp/fullmag-py-tmp PYTHONPATH=packages/fullmag-py/src \
python -m pytest -q \
  packages/fullmag-py/tests/test_spin_drift_diffusion.py \
  packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py
30 passed, 45 subtests passed

pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts \
  src/modules/inspector/panels/TransportAuthoringInspector.test.ts \
  src/modules/footer/TransportLogTable.test.ts
3 files, 26 tests passed

CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/api-transport \
cargo test -p fullmag-api spin_authoring_
3 tests passed

CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/plan-spin \
cargo test -p fullmag-plan spin_transport
14 tests passed
```

Testy obejmują typed Python DSL, canonical `ProblemIR`/runtime round-trip,
resource-first OpenAPI CRUD z revision safety, opaque read-only semantics,
Control Room inspector validation/mutation oraz plannerowe rozdzielenie
requested intent od resolved FDM/FEM capability. Nie wykonano browserowego
smoke na żywym managed runtime w tej bramie; dlatego nie awansuje ona statusu
GPU, nie dowodzi cross-backend convergence i nie zmienia pustego
`validated_workloads`.

Walidator `scripts/validate_mixed_p1_capability_contract.py` oraz 20 testów
`scientific-documentation-contract` również zakończyły się powodzeniem.
Brakujące bramy pozostają jawne: pełny FDM/FEM continuum benchmark, executable
BORIS CPU/CUDA z `iSHA=SHA`, M2 inverse SHE/Onsager, interfejsy N/F/T mixing/SML,
GPU FP64/device residency oraz browser/managed end-to-end proof.

## 32.17. Trzyrozdzielczościowa zbieżność direct-SHE FDM/FEM (2026-08-02)

Dodano i wykonano niezależną bramę h-refinement dla tego samego ograniczonego
workloadu M1 direct-SHE. Test nie porównuje jeszcze FDM z FEM w sensie
continuum ani z BORIS; sprawdza, czy każda referencyjna realizacja z osobna
zbliża się do tego samego analitycznego profilu `sinh/cosh`, zachowując
konserwację i residual solve'u.

### 32.17.1. FDM CPU

`analytical_direct_she_evaluation(nz)` współdzieli dokładnie ten sam workflow
charge/spin dla `nz = 24, 48, 96`, z `nx = 3`, jawnym sześcioma ścianami BC,
stałym `E_x`, `sigma`, `sigma_s`, `theta_SH` i `lambda_sf`. Dla każdej siatki
test mierzy względny błąd L2 `mu_y(z)` wobec profilu analitycznego, sprawdza
`J_x = sigma E_x`, residual spinowy oraz względny bilans spinowy. Wymagane są
ściśle malejące błędy i co najmniej 25% redukcji między siatką najgrubszą a
najdrobniejszą.

Dowód:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/shelane-runner \
cargo test -p fullmag-runner --lib fdm::cpu::spin_transport::tests
18 passed, 0 failed
```

### 32.17.2. FEM CPU/native

`direct_she_converges_on_three_mesh_resolutions()` w
`backends/fem/tests/steady_transport_contract.cpp` wykonuje pełny H1/P1
conforming solve dla `z = 16, 32, 64` elementów (z odpowiednią poprzeczną
refinacją), kontroluje `J_x`, residual i jednocześnie oba niezerowe kanały
wektora SHE (`Q_zy` oraz `Q_yz`). Węzłowy błąd wektorowego profilu
analitycznego musi maleć na kolejnych siatkach, a najdrobniejsza siatka musi
zmniejszyć błąd co najmniej o 20% względem najgrubszej.

Weryfikacja została wykonana wyłącznie przez zarządzane recepty `just`:

```text
just verify-fem-steady-transport-cpu-only-contract
repository contract: pass
runtime/configuration audit: pass
fem steady transport contract: PASS
fem steady transport ABI contract: PASS

just build target=fem-gpu-runtime
just verify-fem-steady-transport-native-contract
fem steady transport contract: PASS
fem steady transport ABI contract: PASS
critical remediation, planner, runner, API, quantity metadata and cargo check: PASS
```

Pierwsza próba pełnej recepty zatrzymała się na brakującym
`boost/multiprecision/cpp_int.hpp` w nieaktualnym obrazie `fem-gpu`; obraz
odświeżono przez `just build target=fem-gpu-runtime`, po czym cała brama
zakończyła się kodem 0. Nie jest to zmiana tolerancji ani obejście solvera.

### 32.17.3. Granica dowodu i aktualizacja oceny

Zamknięto lokalną bramę zbieżności direct-SHE dla FDM CPU reference i FEM CPU
conforming H1/P1 reference slice. Wspólny punkt continuum FDM↔FEM nie jest
jeszcze policzony na jednej tabeli błędów, więc capability pozostaje
`reference_executable`, a `validated_workloads` pozostaje puste. Nadal otwarte
są executable BORIS CPU/CUDA z `iSHA=SHA`, inverse SHE/Onsager, heterogeniczne
materiały, interfejsy N/F/T mixing/SML, GPU FP64/device residency oraz
browser/managed end-to-end proof. Ocena pozostaje konserwatywnie **84%
implementacji / 58% gotowości produkcyjnej**; sama zbieżność referencyjna nie
awansuje kodu do produkcji.

## 32.18. Domknięcie własności dokumentacji Python dla transportu (2026-08-02)

Audyt po bramie FEM wykazał trzy rzeczywiste niespójności w publicznym
kontrakcie dokumentacji, niezależne od solvera numerycznego:

- `Problem.spin_transports` istniał w sygnaturze i loweringu, ale brakowało go
  w tabeli `Problem` i w sąsiednim source-map;
- workflow dokumentacji nie uruchamiał
  `test_public_python_api_documentation.py`;
- trzy strony objęte walidacją (`Problem`, `Problem IR` i spatial material
  fields) nie miały kopiowalnych przykładów w komórkach `# %%`.

Dodano wpis parametru z jednostką, walidacją, zakresem backendów i miejscem w
`ProblemIR`, włączono test do `.github/workflows/documentation.yml` oraz
uzupełniono przykłady stage-first/field-authoring. Wszystkie przykłady pozostają
zgodne z zasadą, że publiczny użytkownik zaczyna od `fm.study(...)`, a nie od
bezpośredniego konstruowania wewnętrznego `Problem`.

Dowody:

```text
TMPDIR=/tmp/fullmag-py-tmp PYTHONPATH=packages/fullmag-py/src \
python3 -m pytest -q \
  packages/fullmag-py/tests/test_public_python_api_documentation.py \
  scripts/test_validate_mixed_p1_capability_contract.py
13 passed

TMPDIR=/tmp/fullmag-py-tmp python3 -m pytest -q \
  scripts/test_public_docs_information_architecture.py \
  scripts/test_check_public_doc_examples.py \
  scripts/test_workflow_node24_contract.py
29 passed
```

Ta brama zamyka rozjazd dokumentacja/source-map/workflow dla publicznego
parametru transportu. Nie dowodzi ona kompletności pełnej suity Python ani
wykonalności wszystkich kombinacji backendu; nadal obowiązują otwarte bramy
SP5, GPU/device proof, BORIS CPU/CUDA, inverse SHE, SML production i browser
qualification wszystkich parametrów.

## 32.19. Wykonawcza brama dynamicznego pola Oersteda i wszystkich RK FEM (2026-08-02)

Po pierwszym uruchomieniu bramy wykryto błąd harnessu, a nie solvera: wszystkie
24 przypadki zapisywały domyślne `fem_oersted_rk_time_convergence.zarr`, więc
ostatni przebieg nadpisywał `metadata.json` używany przez walidator. Recepta
`verify-fem-oersted-rk-time-convergence` została poprawiona tak, aby każdy
przypadek dostawał własny katalog `cpu|gpu_<integrator>_dt<level>` i własny
`--output-dir`. Nie zmieniono równań, tolerancji ani ścieżki wykonawczej.

### 32.19.1. Dowód zarządzanego runtime i źródła

Pełna recepta została wykonana przez zarządzany `just`/container FEM, z
przypiętym obrazem zawierającym Boost/MFEM/CUDA. Eksport zakończył się poprawnym
bundle'em schema-3 i dokładnym dopasowaniem archiwum:

```text
git_commit=6c52dd533b4a772c8541457a580e3c25b337f585
source_snapshot_sha256=02312a29e9c6356f810e886adac46a49e8749a08189d991a2a4ef1e98c17fdd6
worktree_state=dirty
compute_capability=8.9
HYPRE=3.1.0
bundle=valid; bundle=exact-match; entry_count=3996
```

`dirty` wynika z obecnych, niepowiązanych z tym zadaniem plików MuMax3 w
worktree; przebieg jest zatem dowodem wykonania kontrolowanego testu, lecz nie
czystego artefaktu release. W logach GPU runtime jawnie podał
`resolved_engine_id=fem_native_gpu`, RTX 4080 SUPER i `mfem_device=cuda`, ale
również `demag_residency=none` oraz `host_source_of_truth` z zerowym rozmiarem
buforów urządzenia. To potwierdza wejście na CUDA, nie zamyka bramy produkcyjnej
device-residency/FP64.

### 32.19.2. Wynik 24 przebiegów i zbieżności czasowej

Wykonano wszystkie kombinacje:

- CPU i GPU;
- Heun, RK4, RK23 i RK45;
- `dt`/liczba kroków: `(2.842170943040401e-14, 8)`,
  `(1.4210854715202004e-14, 16)` oraz
  `(7.105427357601002e-15, 32)` przy wspólnym czasie końcowym;
- czasowo zmienne źródło `OerstedCylinder` z sinusoidalną zależnością od czasu,
  przy zachowaniu tego samego problemu FEM H1/P1.

Walidator `scripts/validate_fem_oersted_rk_time_convergence.py` zwrócił
`status: pass` dla wszystkich ośmiu relacji urządzenie–integrator:

```text
CPU Heun  observed_order=2.012837999762397
CPU RK4   observed_order=4.0232986137119084
CPU RK23  observed_order=2.919542106247722
CPU RK45  observed_order=6.641226145201781
GPU Heun  observed_order=2.0128379997624646
GPU RK4   observed_order=4.023298613736691
GPU RK23  observed_order=2.9195421062591116
GPU RK45  observed_order=6.641221661238818
```

Weryfikacja obejmuje 24 niezależne `metadata.json`; każdy zapis zachowuje
żądany integrator (`heun`, `rk4`, `rk23`, `rk45`) i odpowiedni
`fem_cpu_native`/`fem_native_gpu`. Dodatkowo wcześniejsza brama
`just verify-fdm-oersted-native-contract` zakończyła się:

```text
PASS: CUDA Oersted stage-time, rollback, adaptive, FSAL, ABM3, and axis oracle contract
```

### 32.19.3. Wniosek i granice promocji

Zamknięto bramę `FEM-TD-NUM-RK-001`: implementacja czasowo zmiennego pola
Oersteda przechodzi wykonawczą weryfikację rzędu dla wszystkich wspieranych
jawnych tablic RK na obu natywnych torach, a harness nie miesza już artefaktów
między przypadkami. Jest to istotny dowód dynamicznego pola i integratorów,
lecz nie dowód pełnej fizyki STT/SOT/SHE. Capability matrix pozostaje bez
zmian: GPU i inverse/M2 nadal `semantic_only`, `validated_workloads` pozostaje
puste, a status nie promuje się do produkcji z powodu dirty provenance,
`host_source_of_truth`, braku executable BORIS parity, braku Onsager/inverse
SHE, interfejsów N/F/T mixing/SML, wspólnego continuum FDM↔FEM i browserowego
end-to-end dla wszystkich parametrów. Ocena pozostaje konserwatywnie
**84% implementacji / 58% gotowości produkcyjnej**.

## 32.20. Wykonawcza brama BORIS — build i reduced direct-SHE smoke (2026-08-02)

W ramach `SHE-BORIS-001` wykonano pierwszy krok runtime, którego wcześniej
brakowało: lokalny snapshot `external_solvers/BORIS` został zbudowany w
zarządzanym obrazie CUDA, uruchomiono `BorisLin` przez NetSocks i odczytano
obserwable transportu. Ciężki build pozostał na szybkim dysku
`/zfn2/mateuszz/git/fullmag/boris-build`; nie zanieczyszczono checkoutu ani nie
zmieniono ignorowanego snapshotu BORIS.

### 32.20.1. Tożsamość i korekta buildowa

```text
source_manifest_sha256=8daa0a9b2ef414b95090f838ab72414fb6808909ea9bde50c4aabd2a11a717a2
image=nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f
configure=make configure arch=89 sprec=0 python=3.10 cuda=11.8
compile=make compile -j8 && make install
binary_sha256=5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997
device=NVIDIA GeForce RTX 4080 SUPER, compute capability 8.9
```

CUDA 12.4 i CUDA 11.8 ujawniły ten sam brak overloadu
`atomicAdd(size_t*, size_t)`. W kopii buildowej zastosowano wyłącznie
kompatybilnościowy cast do 64-bitowego `unsigned long long` oraz rozszerzono
istniejący adapter `unsigned long` do `sm_89`; źródło w
`external_solvers/BORIS` pozostało bez zmian. Z tego powodu binarium jest
artefaktem **patched build copy**, a nie kwalifikowanym binarium wydania BORIS.

### 32.20.2. Wynik uruchomienia

W jednorodnym przewodniku `10 x 2 x 2` dla `J_c=(10^{11},0,0) A/m^2`,
`elC=5.8e7 S/m`, `De=0.01`, `lambda_sf=5 nm`, `SHA=0.10` wykonano tryb
direct-only (`iSHA=0`):

```text
DIRECT_Jc  = [100000000000.0, 0.0, 0.0]
DIRECT_S   = [0.0, 0.0, 0.0]
DIRECT_Jsy = [0.0, 0.0, 289419.0]
DIRECT_Jsz = [0.0, -289419.0, 0.0]
```

Kontrolny przebieg z `SHA=0` i `iSHA=0` zwrócił dokładnie zerowe `Jsy` i
`Jsz`. Oba skrypty zakończyły kod użytkownika przed kontrolowanym timeoutem
serwera (`Finished Python script`; kod procesu 143 pochodzi od zabicia
pozostającego listenera). Smoke dowodzi wykonywalnej zależności direct-SHE od
`SHA`, lecz nie dowodzi zgodności z Fullmag ani poprawnej skali quantity bez
adaptera `S -> V_s -> mu_s`.

### 32.20.3. Ujawniona pułapka API i granica bramy

`Gi` i `Gmix` w BORIS są parametrami `DBL2`; ustawienie skalarnego `0.0`
prowadzi w tej wersji do pustej listy komponentów i segfaultu w
`MeshParamsBase::set_meshparam_value`. Poprawny zapis to `[0.0, 0.0]`. Jest to
ustalenie interoperacyjności harnessu, nie poprawka równań Fullmag.

`SHE-BORIS-001` pozostaje otwarte. Do zamknięcia pozostają: niepatchowane
binarium albo wersjonowany release BORIS, reciprocal `iSHA=SHA` z niezerową
akumulacją, inverse SHE, CPU↔CUDA parity, trzy siatki i sweep tolerancji,
heterogeniczne N/F/T z `Gi/Gmix`, oraz ilościowe `V`/`S -> V_s`/`mu_s`/`Q_ia`
z bilansami i residualami po stronie FDM/FEM. Capability matrix i
`validated_workloads` nie zostały zmienione. Ocena celu pozostaje
konserwatywnie **84% implementacji / 58% gotowości produkcyjnej**.

## 32.21. FDM CPU M2 — wykonywalny manufactured benchmark iSHE/direct-SHE (2026-08-02)

Zamknięto ograniczoną bramę wykonawczą dla wzajemnej konstytutywnej pary
iSHE/direct-SHE na ścieżce FDM CPU double. Nie zmieniano równań ani kodu
produkcyjnego: istniejący operator `fdm_charge_spin_block_gmres_v1` już
realizował obie składowe, a nowe testy sprawdzają ich materializację od silnika
do snapshotu runnera. Jest to dowód referencyjnego wycinka M2, a nie promocja
całego inverse SHE do `validated`.

### 32.21.1. Zamrożony przypadek fizyczno-numeryczny

Przypadek ma cztery komórki wzdłuż `x`, `dx=dy=dz=1`, jednorodne
`m=(0,0,1)`, bez reakcji spinowych i bez AHE/polaryzacji:

```text
sigma       = 2 S/m
sigma_spin  = 4 S/m
sigma_parallel = sigma_perpendicular = 2 S/m
theta_SH    = 0.2
V(x_min)=0 V, V(x_max)=1 V
mu_s(x_min)=(0,0,0) V, mu_s(x_max)=(0,0,1) V
```

W konwencji pełnego `mu_s` używanej przez operator gradient manufactured state
ma `E_x=-0.25 V/m` oraz `g_xz=-0.125 V/m`. Z tej samej macierzy
konstytutywnej wynika w każdej komórce:

```text
J_c = (-0.5, 0.05, 0) A/m^2
Q_xz = -0.5 A/m^2
Q_yz =  0.1 A/m^2
```

Pozostałe składowe `Q_ia` są zerowe. Niezerowe `J_c,y` jest kanałem iSHE,
a niezerowe `Q_yz` kanałem direct-SHE; znaki są sprawdzane względem
`levi_civita` z `ReciprocalConstitutiveMaterial`, a nie względem niezależnych
parametrów `SHA/iSHA`.

### 32.21.2. Dowody i komendy

Silnik sprawdza profil potencjałów w środkach komórek, pełne `J_c` i `Q_ia`,
niezerowe kanały Hall oraz niezależne bilanse:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/m2-ishe-red \
  cargo test -p fullmag-engine --lib \
  m2_manufactured_linear_state_materializes_reciprocal_ishe_and_direct_she
test result: ok. 1 passed; 294 filtered out
```

Runner powtarza ten sam przypadek po przejściu przez
`ResolvedFdmCoupledSpinTransportIR` i `FdmSpinTransportWorkflow::from_plan`, i sprawdza publikowane
`potential_volts`, `current_density_apm2`, spłaszczony tensor `Q_ia`, wersje
operatora oraz telemetryczne residual/balance gates:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/m2-ishe-runner \
  cargo test -p fullmag-runner --lib \
  reciprocal_m2_runner_materializes_ishe_and_direct_she_channels
test result: ok. 1 passed; 732 filtered out
```

Weryfikacja szersza zakończyła się `295 passed; 0 failed` dla całej biblioteki
`fullmag-engine`. Cała biblioteka `fullmag-runner` dała `732 passed; 1 failed`;
jedyna porażka to istniejący, niezwiązany z M2 test
`initial_timestep_tests::adaptive_fdm_cuda_identity_fails_closed_until_controller_abi_is_complete`,
który na tym checkoutcie obserwuje niekwalifikowaną tożsamość CUDA zamiast
odrzucenia. Wszystkie cztery testy `reciprocal*` runnera, w tym nowy gate,
przeszły.

Oba targety są tymczasowymi widokami szybkiego magazynu
`/zfn2/mateuszz/git/fullmag`; nie zapisano ciężkich artefaktów w checkoutcie.
Weryfikowane symbole i właściciele to odpowiednio:

| Warstwa | Właściciel | Zakres dowodu |
|---|---|---|
| konstytutywna | `crates/fullmag-engine/src/fdm/cpu/transport/reciprocal_constitutive.rs` | jedna macierz M2, antysymetryczne SHE/iSHE, nieujemna część symetryczna |
| operator FDM CPU | `crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` | blokowy GMRES/Picard, pola i bilanse |
| runner/IR | `crates/fullmag-runner/src/fdm/cpu/spin_transport.rs` | lowering deskryptora, stage evaluation i publikowany snapshot |
| testy | `coupled_charge_spin_tests.rs` oraz moduł testowy runnera | oracle wartości i granica referencyjnego runtime |

### 32.21.3. Zmiana capability matrix i granice

`transport.spin.inverse_she.fullmag.v1` ma teraz:

- `fdm_cpu_reference=reference_executable` wyłącznie dla powyższego,
  jednorodnego, czterokomórkowego, liniowego benchmarku M2;
- `fdm_gpu_production`, `fem_cpu_public` i `fem_gpu_public` nadal
  `semantic_only`;
- `validated_workloads=[]`, ponieważ nie wykonano jeszcze sweepu Onsagera,
  nieliniowej zbieżności, heterogenicznych materiałów, interfejsów N/F/T,
  porównania z BORIS inverse (`iSHA=SHA`), FEM/GPU ani testu produkcyjnego.

Wiersz direct-SHE M1 pozostaje bez rozszerzenia; nowy przypadek jest osobnym
wierszem inverse-SHE, aby nie mieszać one-way i reciprocal scope. Python/UI nie
wymagały zmiany — wszystkie parametry potrzebne do tego przypadku były już w
`ProblemIR`; zamknięto wyłącznie brak testu wykonawczego na granicy runnera.

Ta brama nie zamyka `SHE-BORIS-001`, M2 nonlinear/interface product gate,
FDM GPU device proof, FEM reciprocal assembly ani browserowego round-trip dla
pełnego zestawu parametrów. Zbiorcza ocena pozostaje zatem konserwatywnie
**84% implementacji / 58% gotowości produkcyjnej**.

## 32.22. Naprawa driftu testu adaptive FDM CUDA identity (2026-08-02)

Pełny test biblioteki runnera ujawnił niespójność kontraktu, nie błąd solvera.
Commit `1a2abaf5` dodał kwalifikacyjny wiersz
`explicit_adaptive_fdm_cuda_double` do rejestru i odpowiadającą gałąź w
`resolve_timestep_execution_identity`. Stary test nadal oczekiwał błędu
„no executable LLG timestep capability row”, więc nie odpowiadał już aktualnej
polityce jawnego, lecz niezakwalifikowanego lane'u.

Test został zmieniony tak, aby sprawdzał właściwą granicę fail-closed:

- identity ma `qualification_id=explicit_adaptive_fdm_cuda_double`;
- `validation_state=unvalidated`;
- brak `qualification_artifact_sha256`, `runtime_source_inputs_sha256`,
  `validated_scope`, daty i schematu walidatora;
- nie ma żadnej promocji do `production_executable` ani `validated`.

Dowód:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/runner-adaptive-identity \\
  cargo test -p fullmag-runner --lib
test result: ok. 733 passed; 0 failed
```

Zmiana obejmuje tylko test w
`crates/fullmag-runner/src/lib.rs`; nie zmienia rejestru ani wykonania CUDA.
Weryfikacja zamyka drift test–registry, ale nie kwalifikuje adaptive CUDA:
brakuje nadal czystego artefaktu trajectory/trace, device residency, FP64
parity i niezależnej naukowej tolerancji. Ogólna ocena pozostaje **84%
implementacji / 58% gotowości produkcyjnej**.

## 32.23. Pełna suita Python i naprawa smoke meshingu (2026-08-02)

Pełna suita `packages/fullmag-py/tests` została uruchomiona z izolowanym
`TMPDIR` i `PYTHONPATH=packages/fullmag-py/src`. Wynik bazowy:

```text
1403 passed, 47 failed, 2 skipped, 550 subtests passed
```

Nie traktuję tych 47 porażek jako jednego błędu fizyki. Klasyfikacja wskazuje
kilka niezależnych rodzin driftu kontraktów: benchmark FEM oczekuje starszych
statusów/legacy mesh i starego pola początkowego; testy GPU sprawdzają stare
ścieżki własności modułów; persistence używa starej reprezentacji mesh; przykład
periodic-antidot ma już jawnie zredukowany stage pipeline; dwa testy SP4 nie
mają pakietu `tests.standard_problems` na tej ścieżce importu. Są to odrębne
bramy i nie wolno ich zamazywać jedną zmianą testów.

W tej iteracji naprawiono jeden rzeczywisty błąd właściciela źródłowego w
`scripts/analysis/mesh_statistics_smoke.py`: smoke nadal wywoływał usunięty
interfejs `MeshData(elements=..., boundary_faces=...)` i odczytywał usunięte
klucze artefaktu `elements`. Konstrukcja korzysta teraz z jawnego adaptera
`MeshData.from_legacy_tet4`, a artefakt schema-2 jest liczony przez
`cell_types`. Dowód:

```text
TMPDIR=/tmp/fullmag-py-suite-20260802 \
PYTHONPATH=packages/fullmag-py/src \
python3 -m pytest -q packages/fullmag-py/tests/test_mesh_statistics_smoke.py
4 passed
```

Naprawa nie promuje żadnego backendu ani nie zmienia fizyki transportu. Pełna
suita Python pozostaje otwarta do osobnych, kontraktowo uzasadnionych poprawek;
nie zmieniam przez to oceny SHE/BORIS ani capability matrix. Otwarte pozostają
również wszystkie bramy wymienione w sekcji 32.22: GPU/device proof, OE-F1/OE-F2,
SML produkcyjne, browser round-trip, `SHE-BORIS-001`, SP5 i cross-backend parity.

## 32.24. Audyt źródła BORIS i powtórzenie reciprocal smoke (2026-08-02)

Wykonano ponowne, linia-po-linii porównanie dokumentacji Fullmag SHE z
implementacją `external_solvers/BORIS/Boris`. Porównanie obejmuje kolejność
rozwiązywania, warunki brzegowe, interfejsy N/F/T, zmienne `S`/`V_s`, tensor
`Q_ia`, rozdzielenie `SHA`/`iSHA`, kryteria SOR oraz ścieżkę CUDA. Wynik jest
zgodny z raportem
`docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/BORIS_FULLMAG_SHE_COMPARISON.md`:
BORIS jest wykonywalnym wzorcem zakresu, Fullmag M2 pozostaje docelowym
kontraktem reciprocal, ale nie ma podstaw do twierdzenia o parity.

### 32.24.1. Dowód wykonywalny

Na tym samym lokalnym, spatchowanym buildzie BORIS wykonano
`scripts/boris_reciprocal_she_smoke.py` w obrazie
`nvidia/cuda:11.8.0-devel-ubuntu22.04` z apt-owym Pythonem 3.10 i bibliotekami
runtime. Snapshot builda zachowuje wcześniejszy manifest źródeł, digest obrazu
i hash binarium opisane w sekcji 32.20. Skrypt ustawia jawnie
`SHA=iSHA=0.10`, `De=0.01`, `l_sf=5 nm`, `elC=5.8e7 S/m` i
`J_c=(1e11,0,0) A/m^2`, a następnie zapisuje `V`, `S`, `J_c`, `J_sy` i
`J_sz` jako OVF.

Powtórzenie dla filmu `1 um x 0.4 um x 1 nm` (10 x 4 x 2 komórek) dało:

```text
RECIPROCAL_SHA 0.1
bottom_S  [0.0, 0.0, 0.0]
center_S  [0.0, 0.0, 0.0]
top_S     [0.0, 0.0, 0.0]
bottom_Jsy  [0.0, 0.0, 289419.0]
center_Jsy  [0.0, 0.0, 578838.0]
top_Jsy     [0.0, 0.0, 289419.0]
bottom_Jsz  [0.0, -289419.0, 0.0]
center_Jsz  [0.0, -289419.0, 0.0]
top_Jsz     [0.0, -289419.0, 0.0]
```

Jest to dowód, że patched executable uruchamia kanały direct-SHE i przy
`iSHA=SHA` materializuje również obserwable inverse-SHE, lecz w jednorodnym,
stałoprądowym workloadzie akumulacja `S` jest zerowa. Nie jest to benchmark
reciprocal ilościowy: nie ma niezerowego `S`, profilu `V_s`, interfejsu `Gi/Gmix`
ani bilansu N/F/T. Kod procesu kończy się kodem 143, ponieważ BORIS zostawia
listener skryptowy po ukończeniu skryptu; log zawiera `Finished Python script`
i wszystkie wartości przed kontrolowanym timeoutem listenera.

### 32.24.2. Ustalenia fizyczne i granica

Audyt kodu potwierdza, że BORIS:

- najpierw relaksuje `V`, potem `S` przez osobne SOR (`STransport_Spin.cpp`);
- używa direct-SHE w niejednorodnym warunku Neumanna
  `grad_n S = epsilon(E) SHA elC MUB_E / De`;
- używa inverse-SHE w warunku `V` proporcjonalnym do
  `iSHA De curl(S)/(MUB_E elC)`;
- ma osobne warunki kontaktowe `Gi/Gmix` i osobny torque interfejsowy;
- ma CUDA kernel dla inverse-SHE, ale sama obecność kernela nie jest dowodem
  CPU↔CUDA parity.

Nie należy mapować `S` bezpośrednio na Fullmag `mu_s`: wymagany jest adapter
`V_s=(De/elC)(e/muB)S`, a następnie ustalenie, czy porównywane `mu_s` jest
pełnym rozszczepieniem kanałów. Próba uzyskania niezerowego `S` przez prosty,
ręcznie utworzony N/F stack nie została zaliczona: inicjalizacja materiału i
ścieżka GPU nie dały stabilnego, skończonego pola, więc wynik odrzucono jako
diagnostykę harnessu, nie jako wynik fizyczny.

`SHE-BORIS-001` pozostaje otwarte. Nadal wymagane są: stabilny N/F/T workload z
niezerowym `S`, `Gi/Gmix`, inverse-SHE, niezależny residual i bilanse, trzy
siatki oraz sweep tolerancji, BORIS CPU↔CUDA, Fullmag FDM/FEM/GPU i artefakt
provenance z adapterem jednostek. Capability matrix pozostaje bez zmian, a
ocena celu nadal wynosi konserwatywnie **84% implementacji / 58% gotowości
produkcyjnej**.

## 32.25. Domknięcie authoringu reciprocal M2 w Python/IR/SceneDocument/Control Room (2026-08-03)

Ta iteracja zamyka brakujący kontrakt authoringu M2, ale nie promuje żadnego
nowego lane'u wykonawczego do `production_executable` ani `validated`. Zmiana
została wykonana przez pełny łańcuch źródła, a nie przez testowy wyjątek:

| Warstwa | Zrealizowany kontrakt | Dowód / właściciel |
|---|---|---|
| Python DSL | `CurrentTransport` rozpoznaje `magnetoresistive_poisson` albo `coupling="bidirectional"`; wymagane są `sigma_parallel_Spm`, `sigma_perpendicular_Spm`, `sigma_AHE_Spm`, `block_gmres`, operator blokowy i residual transportowy | `packages/fullmag-py/src/fullmag/model/current_transport.py`, `world.py` |
| Python spin | `ReciprocalNonlinearSolverPolicy` z walidacją restartu GMRES, limitu Picarda, tolerancji i `eta_transport`; sprzężenie źródłowe decyduje o wersji konstytutywnej | `packages/fullmag-py/src/fullmag/model/spin_transport.py`, `problem.py` |
| Round-trip | pełny graf M2 przechodzi Python → ProblemIR → canonical script → SceneDocument → builder bez utraty tensora przewodności, coupling, BC, gauge, solvera ani polityki nonlinear | `runtime/script_builder.py`, `runtime/scene_document.py`, `test_current_transport.py`, `test_spin_drift_diffusion.py` |
| Rust authoring | typy SceneDocument i walidacja odrzucają niepełny tensor, zły operator/residual, M2 poza steady oraz brak polityki nonlinear; one-way odrzuca pola reciprocal | `crates/fullmag-authoring/src/spin_transport.rs`, `validation.rs` |
| API/OpenAPI | M2 jest jawnie `semantic_only`, ale `authoring_allowed=true`; wygenerowane schematy zawierają MRP, tensor conductance i `SceneReciprocalNonlinearSolverPolicy` | `crates/fullmag-api/src/router_v2/handlers/{model/authoring.rs,sessions/status.rs}`, `apps/control-room/src/kernel/api/generated/openapi-v2.*` |
| Control Room | inspector zachowuje M2 tensor, reciprocal coupling i JSON polityki nonlinear; rozpoznanie niepełnego/nieznanego grafu jest fail-closed | `TransportAuthoringInspectorModel.ts`, `TransportAuthoringInspector.tsx`, `transportRecognition.ts` |

Pierwsza regresja, która ujawniła lukę, była konkretna i została usunięta:

```text
TypeError: ChargeTransportMaterial.__init__() got unexpected keyword argument
  'sigma_parallel_Spm'
AttributeError: module 'fullmag' has no attribute
  'ReciprocalNonlinearSolverPolicy'
```

### 32.25.1. Weryfikacja

Wyniki wykonane po zmianie:

```text
PYTHONPATH=packages/fullmag-py/src TMPDIR=/tmp/fullmag-py-m2-regression \
pytest -q \
  packages/fullmag-py/tests/test_current_transport.py \
  packages/fullmag-py/tests/test_spin_drift_diffusion.py \
  packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py \
  packages/fullmag-py/tests/test_public_python_api_documentation.py
51 passed, 45 subtests passed

CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/authoring-m2 \
cargo test -p fullmag-authoring
68 passed, 0 failed; doc tests 0 passed

CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/api-openapi-m2 \
cargo test -p fullmag-api spin_authoring_
3 passed, 0 failed; 737 filtered out

pnpm --dir apps/control-room exec tsc --noEmit
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts \
  src/modules/inspector/panels/TransportAuthoringInspector.test.ts
24 passed, 0 failed

PYTHONPATH=packages/fullmag-py/src \
TMPDIR=/tmp/fullmag-zfn2-build/python-targets/m2-suite-2 \
pytest -q packages/fullmag-py/tests
1406 passed, 46 failed, 3 skipped, 550 subtests passed
```

Pełna suita jest wynikiem diagnostycznym całego checkoutu, nie bramą M2:
46 porażek grupuje istniejący drift benchmarków FEM, schematu mesh/persistence,
GPU-RK, przykładu periodic-antidot i importu SP4. Żadna porażka nie wskazuje na
nowy kod M2; zielone testy M2 są uruchamiane osobno z izolowanym `TMPDIR`.
Ciężkie targety Cargo i tymczasowe artefakty testów kierowano do szybkiego
magazynu `/zfn2/mateuszz/git/fullmag`; checkout nie został zapełniony buildami.

### 32.25.2. Granica kwalifikacji po iteracji

Capability matrix i status API pozostają konserwatywne:

- M2 reciprocal authoring: `semantic_only`, `authoring_allowed=true`;
- FDM CPU/GPU, FEM CPU/GPU i pełny runtime nonlinear: bez promocji;
- `validated_workloads` pozostaje puste dla reciprocal SHE;
- `SHE-BORIS-001` nadal wymaga stabilnego N/F/T przypadku z niezerowym `S`,
  `Gi/Gmix`, adaptera `S ↔ V_s ↔ mu_s`, niezależnych residuali/bilansów,
  trzech siatek, sweepu tolerancji i CPU↔CUDA;
- nadal otwarte są interfejsy SML/mixing, FEM reciprocal assembly, GPU device
  proof, cross-backend parity, pełny browserowy round-trip oraz produkcyjny
  dynamiczny Oersted.

Authoring M2 jest więc spójny w publicznym modelu i UI, lecz nie jest jeszcze
wykonywalnym, ilościowo zwalidowanym solverem. Uczciwa ocena celu pozostaje
**84% implementacji / 58% gotowości produkcyjnej**: wzrosła kompletność
kontraktu authoringowego, ale nie zamknięto żadnej z dominujących bram fizyki,
numeryki ani runtime'u.

## 32.26. Zarządzany harness BORIS N/F i korekta specyfikacji (2026-08-03)

Wykonano pierwszą rzeczywistą ścieżkę N/F na patched build copy BORIS. Jest to
postęp harnessu i audytu, nie awans Fullmag do `validated`.

### 32.26.1. Korekta modelu wymuszenia i siatki

Pierwszy wariant scenariusza używał `setcurrentdensity` w N. Zgodnie z kodem
BORIS (`Commands.cpp::CMD_SETCURRENTDENSITY`) ta komenda ustawia stałe `J_c` i
ustawia globalne `disabled_transport_solver=true`. Wynik z zerowym `J_c`, `S`
i torque w F nie był testem N/F i został odrzucony.

Normatywny renderer `scripts/boris_nf_interface_smoke.py` używa teraz:

- elektrod x i `setcurrent(I)`, gdzie
  `I=J_target W_y(t_N+t_T+t_F)`;
- jawnego `ferromagnet.ecellsize(cell)`, aby transportowe siatki N/F miały
  ten sam layout i kroki OVF;
- `SHA=iSHA` tylko na N; F ma `SHA`, `Gi` i `Gmix`, ponieważ BORIS nie
  udostępnia F parametru `iSHA`;
- próbek z najbliższej komórki tekstowego OVF, a nie z `getvalue` na
  magnetycznej siatce F.

Wniosek fizyczny: obecność direct-SHE w N po `setcurrentdensity` nie dowodzi
sprzężenia kontaktowego, absorpcji spinowej ani interfacial torque.

### 32.26.2. Wykonany artefakt i dowód runtime

```text
artifact=/zfn2/mateuszz/git/fullmag/boris-build/reports/runner-coarse-3
schema=fullmag.boris_she_nf.v1
source_manifest_file_sha256=ed1ca167fae571b8106b79ed86347de4a6509647db87716c8f6f1559c890cde6
binary_sha256=5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997
image=nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f
python=3.10.12, device=cpu, launch=BorisLin -g -1
workload=N/F, grid=4x2x2 per mesh, SHA=iSHA=0.10 on N
exit=143 accepted only after BORIS_NF_STAGE_COMPLETE and field-completeness checks
qualification=diagnostic
```

Artefakt zawiera `V`, `S`, `Jc`, `Jsx`, `Jsy`, `Jsz` w N i F oraz `Ts`/`Tsi`
w F. Zarejestrowane wartości interfejsu `+z` N→F to:

```text
Jc_N,z=22.184125 A/m2, Jc_F,z=92.93605125 A/m2
J_s,N,z=(-5.96e-4,-2.88983e5,-2.50e-3) A/m2
J_s,F,z=(4.14985e1,1.00e-3,6.3953e-2) A/m2
Tsi_plane*dz=(-2.54e-4,1.75365e4,-2.50e-3) A/m2 (diagnostic conversion)
```

`charge_closure=-70.75` i `spin_torque_closure=3.065e5` pozostają surowymi
obserwablami. BORIS `Tsi` jest torque z efektywnego pola o jednostce `A/(m s)`;
`Tsi*dz` nie jest jeszcze uzgodnionym z Fullmag arealnym fluxem bez jawnego
mapowania `tsi_eff`/`gamma`. Nie wolno interpretować tego closure jako
automatycznej porażki fizyki ani dopasowywać prefaktora po wyniku.

`interior_cell_count=0` w coarse artefakcie (dwie komórki transportowe w osi z),
więc zapisane `charge_scaled_l2=0` i `spin_scaled_l2=0` nie jest dowodem
zbieżności PDE. Następna iteracja musi dodać grubszy profil w osi normalnej
albo niezależny test residualu objętościowego.

### 32.26.3. Status bram

Zrealizowane są: renderer, parser OVF, adapter
`mu_s=2 De S/(elC MUB_E)`, immutable runtime identity, artefakt v1 i managed
N/F smoke. Otwarte pozostają: adapter Fullmag FDM M2 i porównanie ilościowe,
trzy siatki/sweep tolerancji, CUDA parity, N/T/F, torque normalization,
FEM reciprocal assembly oraz `SHE-BORIS-001`. Capability matrix i
`validated_workloads` pozostają bez zmian. Ocena celu nie rośnie od samego
smoke: **84% implementacji / 58% gotowości produkcyjnej**.

## 32.27. Adapter Fullmag FDM M2 i blokada physical-balance (2026-08-03)

Ta iteracja implementuje brakujący element planu porównawczego BORIS–Fullmag:
canonical builder Python → ProblemIR, runner FDM CPU `double/strict`, jawny
artefakt `fullmag.fdm.spin_transport.accepted.v1` oraz porównanie per observable
z kontrolą `Q_ia`, jednostek i orientacji. Nie jest to promocja capability.

### 32.27.1. Kontrakt wejścia i korekta fizyki

Builder `scripts/run_fullmag_m2_nf_reference.py` ma wspólny z BORIS:

- N pod F w osi `+z`, `4×2×2 + 2` komórek, `cell=(1e-7,1e-7,1e-9) m`;
- `sigma=5.8e7 S/m`, `De=0.01 m²/s`, `lambda_sf=5 nm`, `J_c=1e11 A/m²`;
- reciprocal `SHA=iSHA=0.10`, `Gi=5e14 S/m²`, `Gmix=(1.5e15,0) S/m²`;
- po korekcie zgodności z rendererem BORIS: `P_F=0.4`, `SHA_F=0.10`, bez
  nieudokumentowanych bulk `lambda_J/lambda_phi`;
- operator `fdm_coupled_charge_spin_fv_block_gmres.v1`, residual i solver
  telemetry zapisane w request/provenance.

Adapter `scripts/compare_boris_fullmag_she_nf.py` normalizuje BORIS
`S→V_s→mu_s`, zachowuje kolejność `row_major_Q_ia` i liczy osobno `V`, `mu_s`,
`J_c`, wszystkie dziewięć `Q_ia`, absorbowany flux oraz residuale. Torque nie
jest porównywany przy różnicy jednostek: BORIS `Tsi` (`A/(m s)`) i Fullmag
Gilbert source (`1/s`) są oznaczane jako `incomparable` do czasu jawnej
reconciliacji `tsi_eff/gamma`.

### 32.27.2. Wykonanie i dowód blokady

Launcher `.fullmag/local/bin/fullmag` został zbudowany przez repozytoryjne
`just` w trybie `cuda-fem-gpu`; kompilacja i dane pozostały pod
`/zfn2/mateuszz/git/fullmag`. Runner przeprowadził rzeczywisty start i zapisał
pełne logi w:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-nf-coarse-run19
```

Wynik jest `not_run`, bez częściowego artefaktu:

```text
Step 0: coupled charge-spin solve: M2 physical balance gate rejected
without committing state: charge=7.139977e-6, spin=5.450726e-8
```

To jest prawidłowe zachowanie fail-closed. Błąd występuje po wejściu do
wykonywalnego M2 i przed commit, więc nie wolno traktować go jako zerowych pól
ani jako parity failure. Jednocześnie ujawnia lukę numeryczną: obecny solver
wiąże physical-balance gate z tolerancją liniową, a cienka komórka ma silnie
anizotropowe skale. Należy albo uzasadnić niezależny próg bilansu, albo poprawić
skalowanie/assembly; nie wolno po prostu zwiększać tolerancji i publikować
wyniku.

### 32.27.3. Status planu

Zamknięte: Task 4 (normalizacja/metryki), Task 5.1–5.5 (builder, fail-closed
runner i testy) oraz Task 6.1–6.5 (macierz trzech siatek, dwóch tolerancji,
walidacja monotoniczności i receptura `just verify-boris-fullmag-she-nf`).
Task 5/6 nie miały jeszcze pozytywnego runtime evidence; pozostawała
brama otwarta do czasu przejścia physical balance. Testy focused harnessu:

```text
31 passed (N/F, adapter, Fullmag reference and matrix contracts)
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile ...  # pass
git diff --check                                             # pass
```

Nie zmieniono capability matrix ani `validated_workloads`. Zidentyfikowana
przyczyna została naprawiona w solverze i pokryta testem regresyjnym; przed
ponownym uruchomieniem managed runnera status nadal jest `not_run`, więc ocena
pozostaje konserwatywnie **84% implementacji / 58% gotowości produkcyjnej**.

## 32.28. Korekta skalowania GMRES dla cienkiej siatki M2 (2026-08-03)

Blokada z sekcji 32.27 była błędem kryterium numerycznego, a nie powodem do
poluzowania physical-balance gate. `CoupledChargeSpinSolver` wyznacza normę
prawej strony po block-Jacobi preconditionerze, czyli w normie bezwymiarowej.
Kod stosował jednak `max(||P b||_2, 1)`. Dla stosu `100 nm × 100 nm × 1 nm`
zamieniało to żądaną tolerancję względną w zbyt luźną tolerancję absolutną i
pozostawiało bilans elektrod/spinu na poziomie `10^-7`–`10^-6`.

Poprawka w
`crates/fullmag-engine/src/fdm/cpu/transport/coupled_charge_spin.rs` używa
rzeczywistej normy `||P b||_2`; dla dokładnie zerowego RHS stosuje wyłącznie
`absolute_tolerance`. Nie zmieniono progu physical balance, równań, znaków,
jednostek ani publicznego ProblemIR. Nota `docs/physics/0970-...` zamraża tę
definicję skalowania jako część kontraktu M2.

Dowód regresyjny:

```text
RED: m2_anisotropic_nf_interface_meets_the_declared_physical_balance_tolerance
     charge=1.608465e-7, spin=2.345993e-7 (stary floor, rel_tol=1e-9)
GREEN: ten sam test po korekcie
22/22 coupled_charge_spin tests passed
```

Test obejmuje rzeczywisty układ N/F z `SHA=iSHA=0.1`, `P_F=0.4`, `Gi/Gmix`,
reakcją spin-flip, orientacją `+z`, komórką `1e-7,1e-7,1e-9 m` i torque
targets po stronie F. To jest naprawa lokalnego kryterium zbieżności; nie jest
jeszcze dowodem parity z BORIS ani kwalifikacji GPU/FEM.

Następna brama: przebudować launcher przez `just`, wykonać sześć tuplek
macierzy BORIS–Fullmag, zapisać artefakty z nową tożsamością binarium i
sprawdzić monotoniczną zbieżność. Dopiero wtedy wolno zaktualizować status
`not_run`/`diagnostic_match`; capability matrix pozostaje bez zmian.

## 32.29. Świeży coarse run i wynik pierwszej macierzy (2026-08-03)

Po korekcie z sekcji 32.28 przebudowano launcher przez repozytoryjny `just`
z zachowaniem artefaktów poza checkoutem. Tożsamość uruchomienia Fullmag jest
zamrożona w `runtime_identity`:

```text
commit=813332079e01838f976acee521326b643dce7aaa (dirty working tree)
native_sha256=284c14c86212cc918c1ad1770d70049e1918b3271fb0d8545d08f865f65e627b
launcher_sha256=27d7c5ebb3bd1aa47391fc9bc6313d052a6e2b42f05e8cf5f183a84b12ea1843
```

Świeży workload N/F `4×2×2+2`, `FDM/CPU/double/strict`, został zaakceptowany
przez runtime i zapisał pełny artefakt:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-nf-coarse-run22/
transport/fullmag_m2_nf_reference.json
```

W telemetry zapisano `scaled_charge_residual=6.423463949700895e-15`,
`scaled_spin_residual=3.691253818811614e-15`, bilans ładunku
`3.5205103056502695e-11` i bilans spinu `2.371483382809825e-12`. Runtime
zwrócił osiem obserwacji interfejsu (po jednej na komórkę płaszczyzny); adapter
nie wybiera jednej komórki, tylko publikuje średnią jawną wraz z
`interface_observation_count=8` i zachowuje sumę torque komórkowego osobno.

Porównanie z managed BORIS (`boris-nf-runtime`, binary SHA-256
`5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997`, obraz
`nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f`)
ma status **`incomparable`**, a nie `diagnostic_match`. Usunięto wyłącznie
dozwoloną różnicę stałej cechy potencjału (`Fullmag + -3.4482757355128163e-4 V`)
i zapisano translację początku siatki `Fullmag-BORIS=(0,0,-2e-9) m`. Po tej
normalizacji potencjał ma maksymalny błąd względny `3.098487032667977e-4`,
ale `mu_s`, `Q_ia`, absorbowany flux i prąd poprzeczny różnią się na poziomie
rzędu jedności. Torque pozostaje jawnie nieporównywalny: BORIS publikuje
`Tsi [A/(m s)]`, a Fullmag źródło Gilberta `[1/s]`; nie wolno przemnożyć go
przez arbitralne `gamma` po obejrzeniu wykresu.

Pierwsza pełna macierz sześciu przypadków
(`10×4×2+2`, `20×8×4+4`, `40×16×8+8` × `1e-8`, `1e-10`) została uruchomiona
w kontenerze `boris-nf-runtime` i zapisana w:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-boris-she-nf-matrix-run24/matrix.json
```

Macierz prawidłowo zakończyła się fail-closed, ale nie jest jeszcze wspólną
macierzą solverów: cztery pierwsze Fullmag przypadki odrzucił komunikat
`M2 block GMRES did not converge in 500 iterations`, a dwa najdrobniejsze
przypadki przekroczyły limit 300 s. BORIS artefakty są zachowane, lecz bez
drugiego solvera nie wolno liczyć metryk ani twierdzić o zbieżności między
solverami. Diagnostyczny test tej samej średniej siatki z limitem 2000
iteracji zakończył się poprawnie, co wskazuje na osobną granicę limitu
iteracji w harnessie, nie na zgodność fizyczną; limit referencyjny musi zostać
zweryfikowany na całej macierzy przed zmianą statusu.

Kontrolna próba drobnej siatki z limitem 2000 nie zbiegała również po tym
zwiększeniu i zakończyła się `M2 block GMRES did not converge in 2000
iterations` w artefakcie
`/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-fine-max2000-run1`.
Wynik wyklucza interpretację, że sama zmiana limitu 500→2000 zamyka bramę;
potrzebna jest poprawa/kwalifikacja strategii preconditionera lub rozdzielczości
referencyjnej, z zachowaniem fail-closed physical-balance gate.

Wniosek bramy: lokalna korekta skalowania i coarse execution są potwierdzone,
lecz `SHE-BORIS-001`, reciprocal parity, torque normalization, CPU↔CUDA,
FEM/FDM oraz `validated_workloads` pozostają otwarte. Capability matrix nie
zmienia się, a ocena pozostaje konserwatywnie **84% implementacji / 58%
gotowości produkcyjnej**.

## 32.30. Aktualizacja bram UI, M3 i Oersted/SOT (2026-08-03)

### 32.30.1. Zgodność publicznego execution request

Audyt porównawczy wykazał, że Control Room dopuszczał wartości
`requested_execution.discretization=hybrid` i `execution_mode=hybrid`, mimo że
Python DSL, `ProblemIR` i planner nie miały takiej realizacji. Był to błąd
kontraktu, nie brak capability solvera. Wartość usunięto z modelu authoringu,
Rust API, UI selectów i wygenerowanego OpenAPI; ścieżka dynamiczna kończy się
jawnie błędem „Transport hybrid execution is not supported...”, zamiast
wyemitować obiekt, którego runtime nie potrafi wykonać.

Dowód: `TransportAuthoringInspectorModel` + komponent Inspector — `25 passed`,
`openapiV2GeneratedContract`/`generationIdContract` — `6 passed`,
`fullmag-authoring` — `68 passed`. To zamyka konkretny drift, ale nie zastępuje
planowanego leaf-by-leaf round-trip wszystkich parametrów SHE/STT/SOT.

### 32.30.2. M3: seed termiczny i artefakty na szybkim dysku

Pierwszy uruchomiony M3 po naprawie ścieżki binarium ujawnił rzeczywistą
niedeterministyczność: `Problem.temperature=300 K` bez `ThermalNoise.seed`
wybiera system entropy, więc dwa niezależne procesy generowały różne
`spin_current_tensor_apm2`. Nie zmieniono RNG ani nie poluzowano porównania;
workload publiczny deklaruje teraz `fm.ThermalNoise(temperature=300.0,
seed=77)`. Recepta rozwiązuje binarium jako
`${CARGO_TARGET_DIR:-target}/debug/fullmag` i ustawia `TMPDIR` na
`/tmp/fullmag-zfn2-build/m3-pytest`.

Świeży wynik:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/m3-reference \
CARGO_INCREMENTAL=0 just verify-fdm-transient-spin-m3-reference
RC:0
M3 public canonical authoring, planner/runner, and subprocess resume: PASS
12 transient_spin + 14 one-case runner/API/plan/CLI identity tests: PASS
test_spin_drift_diffusion.py: 11 passed
```

To jest referencyjny CPU/double/strict gate dla jawnie stochastycznego
workloadu. Nie jest to dowód jakości GPU, FEM, długiego czasu ani zgodności z
BORIS.

### 32.30.3. Natywne SOT i Oersted oraz blokady FEM

`just verify-fdm-prescribed-sot-native-contract` przechodzi: algebra SOT,
CUDA FP64/FP32 i managed `cargo +nightly check --features cuda` są zielone.
`just verify-fdm-oersted-native-contract` przechodzi dla stage-time,
rollbacku, adaptive, FSAL, ABM3 i osiowego oracle. Są to contract gates
realizacji operatora; nie awansują ogólnego current-solve/airbox ani pełnej
kwalifikacji GPU.

Normalne zarządzane bramy FEM OE-T0/OE-F1/OE-F2 przechodzą aktualne kontrakty
current-view, tetra/direct i vector-potential. TSan zatrzymuje się wyłącznie na
`ThreadSanitizer: unexpected memory mapping` (blokada środowiskowa). Wcześniejszy
brak PETSc/SLEPc w lokalnym obrazie FEM został usunięty przez zarządzaną
przebudowę `just build target=fem-gpu-runtime`; ponowione
`just verify-fem-stt-native-contract` zakończyło się powodzeniem: natywny
`fem_stt_contract` został zbudowany, a test append-only ABI przeszedł. Ten wynik
zamyka tylko kontrakt referencyjny STT, nie pełną ścieżkę GPU, trajektorię STT,
cross-backend ani kwalifikację produkcyjną.

### 32.30.4. Granica porównania z BORIS

Porównanie z `external_solvers/BORIS/Boris` jest wykonane na poziomie źródeł,
kontraktu i ograniczonego executable smoke. BORIS rozwiązuje sekwencyjnie `V`
i `S`, ma jawne `SHA`/`iSHA`, `Gi/Gmix` oraz CUDA kernel; Fullmag M2 używa
`mu_s`, jednego reciprocal bloku i block-GMRES. Adapter `S -> V_s -> mu_s`
oraz korekta `mu_s` jako pełnego rozszczepienia są zapisane w
`BORIS_FULLMAG_SHE_COMPARISON.md`.

Aktualny managed N/F coarse run ma poprawne residuale Fullmag, ale porównanie
jest `incomparable`: po dopuszczalnym gauge shift potencjału profil `V` ma
`3.098487032667977e-4` błędu względnego, natomiast `mu_s`, `Q_ia`, flux i
torque różnią się na poziomie rzędu jedności lub mają różne jednostki.
Macierz sześciu siatek nie zamknęła GMRES dla drobnych przypadków. Wniosek
fizyczny pozostaje więc rozdzielony: BORIS jest obecnie lepszym wykonywalnym
wzorcem zakresu, Fullmag M2 lepszym docelowym kontraktem, ale żaden wynik nie
uprawnia do deklaracji parity ani do awansu `validated_workloads`.

## 32.31. Korekta kosztu operatora i adaptacyjnego GMRES M2 (2026-08-03)

*Adnotacja:* poniższy zapis jest historycznym snapshotem sprzed korekty osi
`z`; aktualny, zweryfikowany status znajduje się w sekcji 32.32.

Ponowna diagnoza bieżącego solvera rozdzieliła blokadę wydajności od blokady
zbieżności. `boundary_flux` przeliczał wcześniej pełne `cell_gradients` dla
każdej ściany brzegowej, co dawało koszt zależny od liczby ścian razy całej
objętości przy każdej aplikacji operatora. Przekazanie gradientów obliczonych
raz przez `residual_flat` nie zmienia dyskretyzacji ani znaków fluxu, ale usuwa
ten sztuczny czynnik kosztu. Dodano też fail-closed diagnostykę końcowego
residuum GMRES oraz adaptacyjny restart: `gmres_restart` pozostaje początkową
małą bazą, a po cyklu z residuum większym niż `100 * tol` baza jest podwajana do
pozostałego limitu.

Zamrożone dowody:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/m2-final-verify \
CARGO_INCREMENTAL=0 cargo test -p fullmag-engine --lib fdm::cpu::transport
70 passed

PYTHONPATH=packages/fullmag-py/src \
TMPDIR=/tmp/fullmag-zfn2-build/m2-python-tests \
python3 -m pytest -q scripts/test_run_fullmag_m2_nf_reference.py \
  scripts/test_compare_boris_fullmag_she_nf.py
14 passed
```

Referencyjny harness FDM ustawia teraz `REFERENCE_MAX_LINEAR_ITERATIONS=2000`.
Pełny sweep samego Fullmag zapisano w:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-m2-fullmag-matrix-20260803/fullmag_only_matrix.json
```

Coarse (`10x4x2+2`) i medium (`20x8x4+4`) przechodzą dla tolerancji `1e-8` i
`1e-10`, z niezależnie zapisanymi residualami charge/spin. Fine (`40x16x8+8`)
pozostaje fail-closed: przy 2000 iteracjach kończy się residuum około
`5.02e-8`, a tolerancja liniowa wynosi `2.13e-12` lub mniej. Próba budżetu
4000 oraz ręcznego `gmres_restart=800` nie daje akceptowalnego czasu; potrzebny
jest dalszy preconditioner wielopoziomowy/line-relaxation. To nie jest dowód
błędu fizyki ani parity z BORIS.

Aktualizuję więc granicę statusu, nie capability matrix: M2 FDM CPU ma
`reference_executable` dla zamkniętego zakresu coarse/medium tego harnessu,
natomiast fine, BORIS executable parity, FEM/GPU, CPU↔CUDA i
`validated_workloads` pozostają otwarte. Ocena celu pozostaje konserwatywnie
**84% implementacji / 58% gotowości produkcyjnej**.

## 32.32. Domknięcie pełnego operatora 3D, line-relaxation i macierzy BORIS (2026-08-03)

### 32.32.1. Korekta regresji osiowej i preconditionera

Kontrola po poprzedniej iteracji wykazała, że świeżo dodana pętla operatora
mogła ominąć oś `z`. Taki wynik byłby numerycznie pozornie zbieżny, lecz
fizycznie usuwałby dyfuzję, SHE/iSHE i warunki brzegowe w trzecim kierunku.
Finalny operator utrzymuje pętlę `coupled_charge_spin.rs::residual_flat` dla osi
`0..3`, a `line_preconditioners` obejmuje każdą niebanalną oś, w tym
linię przechodzącą przez interfejs N/F. Preconditioner pozostaje wyłącznie
przybliżeniem: pełny operator nadal zawiera wszystkie składniki konstytutywne,
a pominięcie tangencjalnego SHE i `G_i` dotyczy tylko faktoryzacji linii.

Dowód regresji po poprawce:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/m2-z-axis-fix \
CARGO_INCREMENTAL=0 cargo test -p fullmag-engine --lib fdm::cpu::transport -- --nocapture
73 passed; 0 failed
```

W szczególności test `m2_refined_anisotropic_bar_converges_with_declared_linear_budget`
przechodzi dla siatki `20×8×8`, `gmres_restart=8` i budżetu 200 iteracji;
wcześniejsza wersja z pominiętą osią `z` nie jest dowodem i została odrzucona.

### 32.32.2. Pełna macierz Fullmag CPU/double

Świeże binarium referencyjne ma SHA-256
`38a2db19d3bf49535f1555c17f06ea6e9641aa3aeeebf8adfc61b580bb42ead0`.
Sześć uruchomień (trzy rozdzielczości `10×4×2+2`, `20×8×4+4`,
`40×16×8+8`; tolerancje `1e-8` i `1e-10`) zakończyło się `pass` w:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/
fullmag-m2-current-zfix-fullmatrix-20260803/fullmag_only_matrix.json
```

Największa siatka ma residuale `charge=6.337917271934871e-13` i
`spin=1.3243111363198238e-12` dla `1e-8`, oraz odpowiednio
`1.054259089651925e-14` i `2.652500450302329e-14` dla `1e-10`.
To zamyka referencyjny CPU/double zakres M2 tego harnessu, nie awansuje GPU,
FEM ani `validated_workloads`.

### 32.32.3. Wykonywalne porównanie z BORIS

Pełna macierz BORIS–Fullmag uruchomiła wszystkie sześć tuple w zarządzanym
`boris-nf-runtime` i jest zapisana w:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/
fullmag-boris-she-nf-matrix-zfix-20260803/matrix.json
```

To jest kompletna macierz wykonawcza, lecz walidator prawidłowo pozostawił ją
`diagnostic`/`incomparable`. Torque nie jest porównywany: BORIS `Tsi` ma
`A/(m s)`, a Fullmag publikuje źródło Gilberta `[1/s]`, bez arbitralnego
przelicznika `gamma`. Adapter normalizuje jawny czynnik BORIS
`MUB_E=mu_B/e` przez `Q_ia=Js_ia/MUB_E`; po tej konwersji maksymalny błąd
potencjału maleje z około `1.431e-4` (coarse) do `2.110e-5` (fine), lecz
`mu_s`, `Q_ia`, absorbowany flux i charge-current nadal mają błędy rzędu
jedności. To jest negatywny, reprodukowalny test zgodności kontraktów, nie
parity ani kwalifikacja Fullmag względem BORIS.

BORIS provenance pozostaje jawne: binary SHA-256
`5bbb6ff240860b34a425eab33cde7a4fe1ecb598cb394d32397e6272e6185997`, source
snapshot `8daa0a9b2ef414b95090f838ab72414fb6808909ea9bde50c4aabd2a11a717a2`,
managed image `nvidia/cuda@sha256:94fd755736cb58979173d491504f0b573247b1745250249415b07fefc738e41f`.
Jednorazowy launcher bez zamontowanego `libnvidia-ml.so.1` kończył się
`exit=127`; użycie trwałego, zarządzanego kontenera rozwiązało problem
środowiskowy bez zmiany solvera. Ta różnica jest zachowana w logach i nie jest
ukrywana jako wynik fizyczny.

### 32.32.4. Zaktualizowana granica celu

Po tej iteracji M2 FDM CPU ma zamknięty, wykonywalny i testowany zakres
coarse/medium/fine dla referencyjnego workloadu Fullmag. Nadal otwarte są:
BORIS parity (w tym mapping `G_i/Gmix`), torque normalization, FEM/GPU,
CPU↔CUDA, pełny leaf-by-leaf Python/UI round-trip, skin-effect/MQS zakres,
FEM Oersted RT0/KKT, M3 fizyczny `C_s` oraz zielony full-suite. Capability
matrix pozostaje bez zmian (`direct/inverse SHE` nie otrzymują
`validated_workloads`). Konserwatywna ocena celu rośnie do **86% implementacji /
60% gotowości produkcyjnej**; wzrost dotyczy dowodu referencyjnego CPU, nie
deklaracji produkcyjnej całego programu.

## 32.33. Izolowana brama CPU↔CUDA dla MuMax3 Zhang–Li (2026-08-03)

### 32.33.1. Zakres korekty

Po synchronizacji `FdmPlanIR` nowe pola provenance Zhang–Li nie były obecne w
trzech istniejących fixture'ach inline testów CUDA. Dodanie `..Default::default()`
uzupełnia wyłącznie pola nieistotne dla tych fixture'ów i usuwa błąd kompilacji;
nie zmienia operatora ani jego znaków. Osobny test parzystości został umieszczony
w aktywnym inline `#[cfg(test)] mod tests` w
`crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`. Wcześniejszy osierocony
`native/tests.rs` nie jest modułem kompilowanym i nie stanowi dowodu wykonania.

### 32.33.2. Zarządzany dowód wykonawczy

Recepta:

```text
just verify-fdm-zhang-li-native-contract
```

wykonała w kontenerze `fem-gpu` konfigurację i budowę natywnego CUDA
`fullmag_fdm`, zbudowała i uruchomiła `stt_pbc_contract`, a następnie uruchomiła
aktywny test:

```text
fdm::gpu::cuda::native::tests::native_fdm_mumax3_zhang_li_matches_cpu_reference_for_one_masked_step_when_cuda_is_available
test result: 1 passed; 0 failed
```

Test jest świadomie izolowany: FP64 Heun, stały krok `2.5e-13 s`, maskowany plan
FDM `3×3×1`, `J=(1.4e11,-2.0e10,3.0e10) A/m²`, `P=0.62`, `beta=0.07`,
`g=2.0`, `formula_version=zhang_li.mumax3.v1` i
`operator_version=zl_mumax3_central_v1`. Wymiana, demagnetyzacja i pole
zewnętrzne są wyłączone, aby porównanie obejmowało wyłącznie wspólny operator
Zhang–Li oraz aktualizację jednego kroku. Akceptacja wymaga tolerancji
względnej `5e-8` i bezwzględnej `1e-10` dla całego pola wektorowego.

### 32.33.3. Granica kwalifikacji

Brama zamyka niskopoziomowy kontrakt CPU↔CUDA dla operatora MuMax3 Zhang–Li.
Nie jest to kwalifikacja pełnego SP5: nadal brakuje pełnej trajektorii CPU/GPU,
adaptive accepted-step parity, sweepu `dt`/siatki, niezależnej zbieżności stanu
relaksacji i demagnetyzacji, kontroli kolejności aktualizacji, porównania z
BORIS, FEM/GPU, pełnego round-trip Python/UI, skin-effect/MQS, FEM Oersted
RT0/KKT, fizycznego M3 `C_s` oraz zielonego full-suite. Ocena pozostaje
**86% implementacji / 60% gotowości produkcyjnej**; ten wynik nie zmienia
capability matrix ani statusu `validated_workloads`.

## 32.34. Korekta prefaktora MuMax3 Zhang–Li w CPU/CUDA (2026-08-03)

### 32.34.1. Zidentyfikowany błąd fizyczno-numeryczny

Porównanie z rzeczywistym źródłem `external_solvers/3/cuda/zhangli2.cu`
wykazało, że wcześniejsza realizacja MuMax3 stosowała czynnik `1/2` dwa razy.
Źródłowy kernel definiuje

```text
PREFACTOR = MUB/(2*QE*GAMMA0)
deltax(m) = m[hclampx(i+1)] - m[lclampx(i-1)]
```

czyli różnica sąsiadów jest dzielona tylko przez `cell_size`; współczynnik
`1/2` należy już do `PREFACTOR`. Fullmag używał `0.5/cell_size` przy tym samym
prefaktorze `P*mu_B/(2*e*M_s*(1+beta^2))`, przez co źródło Zhang–Li było
dwukrotnie za małe. W historycznym przebiegu SP5 objawiało się to składowymi
`x/y` nowego operatora bliskimi połowie referencji MuMax3. Test CPU↔CUDA nie
wykrywał błędu, ponieważ obie ścieżki współdzieliły tę samą błędną skalę.

### 32.34.2. Implementacja i test-first evidence

Korekta została wykonana w:

- `crates/fullmag-engine/src/fdm/cpu/fields.rs`,
- `backends/fdm/gpu/cuda/integrators/llg_fp64.cu`,
- `backends/fdm/gpu/cuda/integrators/llg_fp32.cu`.

Wariant `zhang_li.legacy_fullmag.v0` pozostał bez zmian. Równanie w
`docs/physics/0990-mumax-standard-problem-5-fdm-validation.md` i opis baseline'u
w `SP5_FULLMAG_MUMAX_COMPARISON.md` zostały ujednolicone ze źródłem MuMax3.

Najpierw uruchomiono czerwony test po zmianie oczekiwanego prefaktora:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/zhangli-factor-red \
CARGO_INCREMENTAL=0 cargo test -p fullmag-engine --lib \
  mumax3_zhang_li -- --nocapture
0 passed; 1 failed
```

Po zmianie operatora ten sam test przeszedł:

```text
running 1 test
test fdm::cpu::fields::stt_tests::mumax3_zhang_li_uses_central_clamped_stencil_and_source_prefactor ... ok
test result: ok. 1 passed; 0 failed; 300 filtered out
```

To jest dowód korekty wzoru i CPU oracle, nie jeszcze dowód pełnej trajektorii.

### 32.34.3. Bramy wymagane przed wykonaniem (stan wejściowy)

Plan tej iteracji obejmował ponowne wykonanie zarządzanej recepty
`just verify-fdm-zhang-li-native-contract`, ponieważ wcześniejsza brama
CPU↔CUDA była zielona dla błędnego, wspólnego prefaktora. Wymagał także
przebudowy zarządzanego runtime, świeżego stałokrokowego SP5 GPU oraz pełnego
artefaktu `metadata.json`, `m_final.json`, `scalars.csv`, trace solvera i
różnicy względem referencji MuMax3
`(-0.23488366603851318, -0.09453280270099640, 0.022961989045143127)`.
Dopiero po sprawdzeniu zbieżności relaksacji, demagnetyzacji, kolejności
aktualizacji i sweepu `dt`/siatki można rozważyć awans z `reference_executable`;
ta korekta sama nie zmienia `capability-matrix-v0.json` ani statusu
`validated_workloads`.

### 32.34.4. Świeża brama CUDA i przebieg SP5 po korekcie

Po aktualizacji kontraktu źródłowego wykonano ponownie zarządzaną receptę:

```text
just verify-fdm-zhang-li-native-contract
FDM Zhang-Li periodic-stencil contract: PASS
native_fdm_mumax3_zhang_li_matches_cpu_reference_for_one_masked_step_when_cuda_is_available
test result: 1 passed; 0 failed; 0 ignored; 0 measured; 769 filtered out
```

Następnie `just ensure-managed-fem-runtime` wyeksportowało i zweryfikowało
schema-3 runtime z `execution_engine=cuda_fdm`, FP64/cuFFT i compute capability
8.9. Stałokrokowy przebieg SP5 (`dt=1e-13 s`, `tolT=1e-6 T`, 10000 accepted
steps) jest zapisany w:

```text
/zfn2/mateuszz/git/fullmag/runs/
mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed
```

Końcowa średnia pola z `m_final.json` wynosi
`(-0.23465571179208225, -0.09450957174904828, 0.02294296086440478)`. Względem
referencji MuMax3
`(-0.23488366603851318, -0.09453280270099640, 0.022961989045143127)` daje to
różnice `(2.2795424643e-4, 2.3230951948e-5, -1.9028180738e-5)`,
`max|Δ|=2.2795424643e-4` i RMS `1.3274648427e-4`. Składowe `x/y` nie są już
dwukrotnie za małe; pozostaje rozbieżność większa niż docelowa tolerancja
`1e-4`, dlatego `qualification.json` zachowuje `status=not_evaluated`.
Artefakt potwierdza `lossy_fallback_used=false`, `device_name=NVIDIA GeForce
RTX 4080 SUPER`, `precision=double`, `integrator=heun` i stałą politykę czasu.
Identyczny przebieg CPU zakończył się osobno; wynik parytetu zapisano poniżej i
nie włącza on automatycznie statusu kwalifikacji.

### 32.34.5. Magazyn build/runtime

Pierwszy eksport po kompilacji zakończył się przed publikacją przez
`No space left on device` przy kopiowaniu `libcublas` na
`/mnt/fullmag-zfn2-native`. Audyt wykazał 28 nieużywanych snapshotów źródeł
(`source-cache.*`, około 5,3 GB) pozostawionych przez wcześniejsze eksporty w
tym samym task-specific runtime. Usunięto wyłącznie te stare snapshoty,
pozostawiając aktualny `source-cache.6900d651…`, Cargo target, raporty oraz
warianty runtime. Wolne miejsce wzrosło z 1,2 GB do 7,6 GB, a powtórzony
`ensure-managed-fem-runtime` zakończył się poprawną walidacją schema-3. Ten
przypadek potwierdza, że ciężkie buildy pozostają na szybkim dysku
`/zfn2/mateuszz/git/fullmag`/jego ext4 mount view; zwykły workspace nie jest
magazynem artefaktów.

### 32.34.6. Zamknięcie stałokrokowej bramy CPU↔CUDA

CPU wykonano z tym samym planem, `dt=1e-13 s`, progiem relaksacji `tolT=1e-6 T`
i horyzontem `1 ns` etapu `flat_run`. Artefakt:

```text
/zfn2/mateuszz/git/fullmag/runs/
mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu
```

Metadane mają `execution_engine=cpu_reference`, `precision=double`,
`fft_backend=rustfft`, `demag_operator_kind=tensor_fft_newell` oraz
`lossy_fallback_used=false`. Łącznie wykonano `12458` accepted steps (relaksacja
plus `10000` kroków dynamicznych); `solver/accepted_steps.v1.json` zawiera
`10000` rekordów etapu dynamicznego. CPU i CUDA mają identyczne `step`, `time`
i `dt` w każdym rekordzie. Końcowe pola 4096-komórkowe różnią się maksymalnie
`6.9388939039e-16`, RMS `1.1431120734e-16`; średnie są identyczne do
zaokrąglenia maszynowego. W fizycznych obserwablach trace maksymalna różnica
wynosi `1.2874603271e-3` dla `max_dm_dt` przy skali około `1e10 s^-1`, a
różnice energii są poniżej `1.6e-33`.

Ta brama zamyka fixed-step CPU↔CUDA trajectory parity dla operatora
`zhang_li.mumax3.v1` i tego samego operatora demagnetyzacji. Nie zamyka
zgodności z MuMax3: oba backendy mają wspólny wynik
`(-0.2346557117920822,-0.0945095717490483,0.0229429608644048)`, lecz względem
referencji MuMax3 pozostaje `max|Δ|=2.2795424643e-4`, więc oba artefakty mają
`qualification.json.status=not_evaluated`. Pozostają nadal: zbieżność kroku i
siatki, niezależna relaksacja, adaptive CPU/GPU, BORIS/SHE, FEM/GPU, pełny
round-trip Python/UI, skin-effect/MQS, FEM Oersted RT0/KKT, fizyczne M3
`C_s` oraz `validated_workloads`.

## 32.35. Korekta walidacji residualu BORIS N/F (2026-08-03)

### 32.35.1. Root cause

Powtórzenie BORIS N/F na średniej siatce z limitem `5000` iteracji nadal dawało
`spin_scaled_l2≈2.47e11`. Ponieważ zwiększenie limitu nie zmieniło rzędu
wyniku, wykonano audyt jednostek i źródeł zamiast kolejnego strojenia SOR.
`Transport_Spin_Display.cpp` publikuje `S [A/m]` oraz `Js [A/s]`, podczas gdy
Fullmag `Q_ia=Js_ia/MUB_E` ma `A/m²`. Stary walidator dodawał dywergencję
`Js` do reakcji zapisanej w jednostkach `Q`, a dzielił przez `max(|Js|,1)`
zamiast przez skalę dywergencji. Dodatkowo stosował normal-metalowy człon
`lambda_sf` do F, pomijając `l_ex`, `l_ph` i ograniczenia stałego workloadu.

Normatywny zapis korekty trafił do
`docs/physics/0970-spin-hall-drift-diffusion-transport.md` §5.2.1 oraz do
porównania BORIS/Fullmag §7.7. W native BORIS variables sprawdzane jest:

```text
R_S = div(Js) + De*S/lambda_sf^2                    (N),
R_S = div(Js) + De*(S/lambda_sf^2 + (S×m)/l_ex^2
                    + m×(S×m)/l_ph^2)              (F, constant m),
scale = max(|J|/h, |De*S|/reaction_length^2, 1).
```

Źródła topological-Hall, charge/spin pumping oraz `E·grad(m)` nie są ukryte:
F branch jest jawnie ograniczony do manifestu z jednorodnym materiałem i
stałym `m`; dla ogólnego F potrzebny jest osobny manifest źródeł.

### 32.35.2. Test-first i implementacja

Dodano testy `scripts/test_verify_boris_nf_interface.py` dla native `S` residualu
oraz dla exchange/dephasing F. Zaktualizowano `NfCaseConfig`/manifest o
`l_ex_m`, `l_ph_m`, `P` i mapowanie Python BORIS `l_phi`; CLI runner przyjmuje
`--transport-tolerance` i `--transport-max-iterations`. Testy:

```text
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=scripts \
python3 -m pytest -s -q \
  scripts/test_boris_nf_interface_smoke.py \
  scripts/test_run_boris_nf_interface.py \
  scripts/test_verify_boris_nf_interface.py
19 passed; 0 failed

PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=packages/fullmag-py/src:scripts \
python3 -m pytest -s -q \
  scripts/test_compare_boris_fullmag_she_nf.py \
  scripts/test_boris_fullmag_she_nf_matrix.py
12 passed; 0 failed
```

### 32.35.3. Managed evidence after correction

Nowy artefakt CPU/double z trwałego `boris-nf-runtime`:

```text
/zfn2/mateuszz/git/fullmag/boris-build/reports/
runner-fine-5000-native/summary.json
```

Konfiguracja: `20×8×4 + 4`, `tol=1e-8`, `5000` iteracji, `SHA=iSHA=0.1`,
`Gi=5e14 S/m²`, `Gmix=(1.5e15,0)`, `l_sf=5 nm`, `l_ex=2 nm`, `l_phi=4 nm`,
`m=(1,0,0)`. Residuale z `216` komórek wewnętrznych na materiał:

```text
normal:       charge=5.147004968391239e-13  spin=3.806146941508527e-3
ferromagnet:  charge=3.978584955133736e-12  spin=9.615227124935865e-10
```

Porównanie do Fullmag fine jest w
`runner-fine-5000-native/comparison.json`; nadal ma `status=incomparable` i
max-relative-error: potential `5.393051572602266e-5`, `mu_s`
`1.8919613718899064`, `Q_ia` `1.9999958674595317`, absorbed flux
`1.000123101888642`, charge `1.2906273307379117`. Torque pozostaje jawnie
nieporównywalny (`BORIS Tsi A/(m s)` vs Fullmag `[1/s]`). Korekta zamyka tylko
niezależny test jednostek/residualu; nie daje parity ani awansu capability.

### 32.35.4. Status bramy i ocena celu

`SHE-BORIS-001`, mapowanie `G_i/Gmix`, N/T/F, BORIS CPU↔CUDA, Fullmag
CPU↔CUDA, FEM/GPU, cross-backend common-limit, torque normalization,
`validated_workloads`, skin-effect/MQS, FEM Oersted RT0/KKT, fizyczny M3 `C_s`
i pełny Python/UI round-trip pozostają otwarte. Zapisany zakres poprawia
wiarygodność diagnostyki BORIS, ale nie zwiększa oceny produkcyjnej: nadal
**86% implementacji / 60% gotowości produkcyjnej**.

## 32.45. Stałokrokowa trajektoria i skalowanie kanonicznego SOT v1 FDM CUDA (2026-08-04)

### 32.45.1. Zakres fizyczny i kontrakt wejściowy

Po zamknięciu bram Slonczewskiego dodano analogiczną, ale odrębną bramę dla
`prescribed_sot.fullmag.v1`. Test nie używa legacy `|J|`: przekazuje signed
`J_signed=-4e11 A/m^2`, `xi_DL=0.12`, `xi_FL=-0.03`,
`sigma_hat=(0,1,0)`, `t_F=1.5e-9 m`, jawny `sot_target`,
`PrescribedSotV1DriveIR::SignedScalar` oraz maskę celu, która wybiera tylko
aktywne komórki. Wymiana, demag i pole zewnętrzne są wyłączone, a `dt=1e-15 s`
utrzymuje pomiar w małym, stabilnym envelope Heuna. CPU reference korzysta z
niezależnego `prescribed_sot_scales` i tej samej jednej konwersji Gilberta co
opis fizyczny:

```text
Omega = gamma_e hbar J_signed/(2 e M_s t_F)
T_G = Omega [xi_DL m x (sigma x m) + xi_FL m x sigma]
T_explicit = [T_G + alpha m x T_G]/(1+alpha^2)
```

### 32.45.2. Implementacja i dowód RED → GREEN

Dodano testy w rzeczywistym module `fdm::gpu::cuda::native::tests`:

```text
native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available
native_fdm_prescribed_sot_has_bounded_current_scaling_when_cuda_is_available
```

Pierwszy test wykonuje osiem kolejnych kroków CUDA FP64 i po każdym kroku
porównuje pełny wektor `m` z CPU-reference uruchomionym do tego samego
prefiksu czasu. Drugi uruchamia `0.5x`, `1x` i `2x` signed current względem
tego samego stanu bazowego; aktywne i wskazane komórki muszą mieć odpowiedź
`1:2:4`, a komórki nieaktywne lub niewskazane nie mogą reagować.

Receptura `just verify-fdm-prescribed-sot-native-contract` została rozszerzona
o pełny managed `fullmag_fdm`, kontrakt algebraiczny, runtime CUDA FP64/FP32 i
oba testy Rust. Wynik:

```text
prescribed SOT algebra contract: PASS
prescribed SOT CUDA fp64/fp32 runtime: PASS
running 2 tests
...native_fdm_prescribed_sot_has_bounded_current_scaling... ok
...native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 784 filtered out
```

Sprawdzono również publiczny round-trip Python/SceneDocument/script export:
`TMPDIR=/tmp/fullmag-zfn2-build/python-sot-tests PYTHONPATH=packages/fullmag-py/src
python3 -m pytest -q packages/fullmag-py/tests/test_prescribed_sot.py
packages/fullmag-py/tests/test_spin_transport_runtime_roundtrip.py` dał
`44 passed, 2 warnings, 88 subtests passed`. Pierwsza próba bez ustawionego
`TMPDIR` była wyłącznie błędem hostowego pytest capture (`FileNotFoundError`,
zero testów); nie zmienia to dowodu po powtórzeniu w prawidłowym katalogu.

Pierwsze czerwone uruchomienia zatrzymały się na brakującym `sot_target` /
`sot_drive`, a następnie na masce wskazującej nieaktywną komórkę. Oba błędy
pochodziły z zamierzonego fail-closed walidatora planu; fixture uzupełniono do
pełnego kontraktu zamiast osłabiać walidację.

### 32.45.3. Granica kwalifikacji

Zamknięto wyłącznie bounded FP64 FDM CUDA descriptor/trajectory/mask/current
scaling evidence dla małego fixed-step workloadu. Nie zamyka to FEM SOT,
FP32 error envelope, nieliniowego sweepu prądu, stage-time envelope,
zbieżności `dt`/siatki, cross-backend parity, bezpośredniego lub odwrotnego
SHE, ani produkcyjnej kwalifikacji. Canonical SOT pozostaje
`semantic_only` we wszystkich czterech publicznych lane'ach; capability matrix
opisuje nowy dowód, ale `validated_workloads` pozostaje puste. Szeroka ocena
celu pozostaje **86% implementacji / 60% gotowości produkcyjnej**.

## 32.46. Pull `origin/master` i ponowna brama demaga (2026-08-04)

Wykonano:

```text
git pull --ff-only origin master
Already up to date.
```

Branch jest `master`, lokalny HEAD `427aa79fe`, a `origin/master` wskazuje
`b3c839b9c`; lokalne cztery commity implementacyjne pozostają jeszcze
niepushowane. W historii są wcześniejsze poprawki/proweniencja demaga:
`34cf6a9da` (degradacja pageable scalar staging), `02f7bf813` i `b3c839b9c`
(udokumentowana synchronizacja pull). Niezależne lokalne usunięcia debugów
`apps/legacy_web` oraz modyfikacja `external_solvers/3` pozostały poza zmianą.

Po pullu uruchomiono managed:

```text
just verify-fem-demag-poisson-contract-focused
```

Receptura skonfigurowała CUDA/MFEM/Hypre i zbudowała oraz uruchomiła wszystkie
sześć kontraktów: `fem_demag_poisson_contract`,
`fem_demag_delta_potential_contract`, `fem_demag_fem_bem_contract`,
`fem_cuda_demag_timing_contract`, `fem_cuda_periodic_demag_contract` i
`fem_cuda_periodic_exchange_contract`; zakończyła się kodem `0`. Komunikaty
`PCG: Number of iterations: 1 / No convergence!` pochodzą z fixture testującej
odrzucenie niezbiegniętego kandydata i nie są dowodem zbieżności produkcyjnego
przebiegu. Brama potwierdza poprawność kontraktów i fail-closed demaga po
pullu, ale nie zamyka jeszcze pełnej kwalifikacji fizycznej: pozostają
medium/fine convergence, airbox/RT0/KKT, MPI scaling, długi runtime i
cross-backend demag parity. Szeroka ocena celu pozostaje **86% / 60%**.

## 32.36. Ujednolicenie walidacji objętości OCC z kontraktem Rust (2026-08-03)

### 32.36.1. Synchronizacja z `master`

Wykonano `git fetch origin master` oraz `git pull --ff-only origin master`.
Pull zakończył się `Already up to date`: lokalny `master` i
`origin/master` wskazują `762aeffbfd7dce60791fc93533bee4ba1d117265`
(`git rev-list --left-right --count HEAD...origin/master = 0 0`). Niezależne
zmiany robocze w `apps/legacy_web` i `external_solvers/3` pozostały nietknięte.

### 32.36.2. Zidentyfikowana rozbieżność walidatorów

Współdzielona siatka SP4 (`700 nm × 250 nm × 250 nm`, Delaunay, pole rozmiaru
`3 nm` w filmie i `20 nm` w airboxie) mogła zawierać tetrahedr o objętości
`10^-38–10^-37 m^3`. Python `MeshData.validate_strict()` oceniał komórkę
względem jej lokalnej długości charakterystycznej, natomiast Rust
`MeshIR::validate_strict()` używa progu wykonawczego
`max_span^3 × 10^-18`; dla SP4 jest to `3.43×10^-37 m^3`. Taki sliver był
lokalnie akceptowany, lecz odrzucany dopiero przy materializacji ProblemIR,
przed wejściem do solvera. Rozluźnianie progu Rust byłoby numerycznie i
fizycznie błędne, ponieważ dopuszczałoby źle uwarunkowane elementy FEM.

### 32.36.3. Korekta i test-first evidence

W `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` dodano
`_execution_mesh_volume_epsilon()`, wiernie odtwarzające skalowanie Rust, i
użyto go w conformal OCC przed zaakceptowaniem próby. Niespełnienie progu
uruchamia istniejący, niedestrukcyjny retry algorytmu Delaunay → HXT → Frontal;
nie usuwa komórek z gotowej topologii. Dodano regresję
`packages/fullmag-py/tests/test_conformal_occ_degenerate_retry_regression.py`,
która konstruuje tetrahedr przechodzący lokalną walidację, lecz odrzucany przez
próg wykonawczy, i wymaga retry.

Lokalne bramy:

```text
test_conformal_occ_degenerate_retry_regression.py: 2 passed
test_meshing.py (OCC/degenerated-cell subset): 12 passed, 258 deselected
```

Dokładny generator SP4 po korekcie wykonał Delaunay → HXT → Frontal i zwrócił
`371527` tetrahedrów; `min_volume=1.937676308381346e-33 m^3`, próg
`3.43e-37 m^3`, `n_below=0`. Ponowna walidacja z tym samym progiem wykonawczym
przeszła.

### 32.36.4. Granica dowodu zarządzanego runtime

Pierwsze uruchomienie `just verify-fem-standard-problem-4-smoke` zatrzymało się
przed testem demaga, ponieważ współdzielony `native/build/CMakeCache.txt`
wskazywał nieistniejące już artefakty PETSc/SLEPc 3.24 w `/opt/fullmag-deps`,
podczas gdy bieżący obraz `fem-gpu` zawiera systemowe pakiety Debian:
PETSc `3.15.5` w `/usr/lib/petscdir/petsc3.15` i SLEPc `3.15.2` w
`/usr/lib/slepcdir/slepc3.15`. Przyczyną bezpośrednią był więc nieaktualny
cache CMake, a nie fizyka demaga. Dodano `PKG_CONFIG_PATH` do obu etapów
`docker/fem-gpu/Dockerfile` oraz do `compose.yaml`, aby ścieżki do opcjonalnych
pakietów z `/opt/fullmag-deps` były jawne; nie oznacza to, że ten obraz
udostępnia PETSc/SLEPc 3.24. Przeniesiono stary, ignorowany `native/build` do
archiwum i wykonano świeżą konfigurację; CMake poprawnie znalazł PETSc 3.15.5
i SLEPc 3.15.2. Blokada była środowiskowa i została usunięta bez rozluźniania
progu geometrii ani kontraktu solvera.

Ta korekta nie awansuje żadnego workloadu do `validated` i nie zmienia oceny
celu: **86% implementacji / 60% gotowości produkcyjnej**. Do zamknięcia nadal
pozostają pełny runtime SP4 po świeżym buildzie, parity CPU/GPU i demag,
`validated_workloads`, SHE/BORIS, FEM/GPU, skin-effect/MQS, FEM Oersted RT0/KKT,
fizyczny M3 `C_s` oraz pełny round-trip Python/UI.

## 32.37. Świeży dowód demaga SP4 i granica GPU readback (2026-08-03)

### 32.37.1. Bramy kompilacji i runtime

Po przeniesieniu starego, ignorowanego `native/build` wykonano oficjalną ścieżkę
`just verify-fem-standard-problem-4-smoke`. Świeży CMake zbudował
`fullmag_fem`, kontrakty C++/CUDA oraz `fem_mesh_contract`, `fem_oersted_contract`,
`fem_stt_contract` i pozostałe kontrakty natywne; suita ABI Rust zakończyła się
wynikiem `35 passed; 0 failed`. Zarządzany bundle pozostaje ważny:

```text
git_commit=762aeffbfd7dce60791fc93533bee4ba1d117265
source_snapshot_sha256=965a5412c4fb2b8aa6d1a95a025165240424657605701e986e9e446462ece3ac
variant=hypre-baseline
runtime_variant_id=2a8ffa520dfbb43caf8910366058d2a4ec92673d62f8f750a181645b10fef303
compute_capability=8.9
hypre_version=3.1.0
```

### 32.37.2. Wykonane przypadki SP4

Dla `FULLMAG_SP4_QUALIFYING=0`, `coarse`, `baseline`, `llg_overdamped`,
`duration=1e-14 s` wykonano relaksację CPU/GPU oraz dynamikę przypadków A/B.
Relaksacja CPU i GPU zakończyła się bez fallbacku; obie ścieżki użyły tego
samego `fem_poisson_robin`, `CG/AMG`, `rtol=1e-12`. Energia całkowita relaksacji
wyniosła `7.09617873316957e-19 J` (różnica CPU–GPU około `2e-33 J`).

Dynamiczny przypadek A zakończył się na czterech krokach po `1e-14 s`:
`E_demag` CPU `7.096161633027042e-19 J`, GPU
`7.096161633026972e-19 J`, a `E_total` różni się o około `2.1e-32 J`.
CPU przypadek B również zakończył się poprawnie (cztery kroki,
`E_demag=7.096159932911980e-19 J`). W tamtym przebiegu GPU przypadek B nie
uzyskał jeszcze wyniku wykonawczego; wynik po korekcie readback jest zapisany
w §32.38.

GPU A raportował jawnie `engine=fem_native_gpu`,
`demag_mode=device_hypre_poisson`, `hypre_gpu_policy=device`,
`demag_residency=device`, `fallback_policy=forbidden`, urządzenie RTX 4080
SUPER, CC 8.9. To jest dowód wykonania ścieżki GPU demaga, ale nie pełna
kwalifikacja macierzy SP4.

### 32.37.3. Otwarta brama zasobowa

GPU dynamiczny przypadek B zatrzymał się przed pierwszym krokiem z dokładnym
błędem. Jest to zapis historyczny sprzed korekty opisanej w §32.38:

```text
RunError: cudaHostAlloc FemGpuState scalar readback staging failed: out of memory
```

W chwili błędu VRAM nie był wyczerpany (około `3.4 GiB / 16 GiB`), a żądany
scalar staging ma tylko 32 wartości `double` (256 B). Jest to więc osobna
brama zasobowa sterownika/host-pinned memory, nie błąd równania Poissona,
warunku Robin, HYPRE ani walidacji tetrahedrów. Obecnie nie ma wystarczającego
dowodu, aby przypisać przyczynę konkretnie wyciekowi lub konkurencyjnemu
procesowi; trzeba powtórzyć ten sam przypadek w izolowanym procesie CUDA i
sprawdzić limit pamięci zablokowanej. Do czasu tego dowodu GPU SP4 pozostaje
`production_executable`/`semantic_only` zgodnie z macierzą, a nie `validated`.

### 32.37.4. Status celu

Korekta OCC, świeży build z PETSc 3.15.5/SLEPc 3.15.2, CPU demag oraz GPU
demag dla relaksacji i przypadku A są potwierdzone. W chwili zapisu tego
historycznego wpisu brama GPU B readback pozostawała otwarta; aktualny stan
po jej naprawie podano w §32.38. Ocena szerokiego celu pozostawała
**86% implementacji / 60% gotowości produkcyjnej**.

## 32.38. Pull z mastera i zamknięcie obserwowanej bramy GPU B (2026-08-03)

### 32.38.1. Synchronizacja i zakres zmiany

W chwili wykonania pulla `HEAD` oraz `origin/master` były równe
`762aeffbfd7dce60791fc93533bee4ba1d117265`, więc nie było czego
fast-forwardować. Następnie lokalny proces integracyjny dopisał na `master`
merge `a983a61fa` oraz niniejszą zmianę `34cf6a9da`; dlatego bieżący stan ma
`HEAD=34cf6a9da0769e55225217e2737d1d52a5cb39fa`,
`origin/master=762aeffbfd7dce60791fc93533bee4ba1d117265` i
`git rev-list --left-right --count HEAD...origin/master = 54 0`.
Nie wykonano push. Zmiana robocza dotyczy wyłącznie błędu alokacji 256-bajtowego
bufora scalar readback w CUDA; nie zmienia równania Poissona, warunku Robin,
HYPRE, energii ani kryteriów zbieżności.

W `reduction_workspace_memory.cpp` pinned host staging pozostaje ścieżką
podstawową. Tylko `cudaErrorMemoryAllocation` przełącza 32-slotowy bufor
pageable; `cudaMemcpyAsync` i istniejąca synchronizacja strumienia pozostają
bez zmian, więc wynik numeryczny i kolejność decyzji solvera są zachowane,
a tracone jest wyłącznie nakładanie transferu z pracą hosta. Emitowane jest
jawne ostrzeżenie, a każdy inny błąd CUDA pozostaje fatalny. Flaga
`scalar_result_pinned` zapobiega błędnemu `cudaFreeHost` dla bufora pageable.
Kontrakt źródłowy i nota fizyczna są zaktualizowane odpowiednio w
`backends/fem/tests/source_facade_gpu_state_contract.cpp` oraz
`docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`.

### 32.38.2. Dowód kompilacji i managed runtime

Oficjalna receptura `just verify-fem-time-domain-native-contract` przeszła:
kontrolę dokumentacji, świeży build CUDA/MFEM/SLEPc, kontrakty czasu
rzeczywistego oraz `fullmag-fem-sys` ABI (`35 passed; 0 failed`).
`FULLMAG_RUNTIME_PRUNE=0 just ensure-managed-fem-runtime` zakończyło się
poprawną walidacją bundle. Manifest aktywnego wariantu podaje:

```text
git_commit=762aeffbfd7dce60791fc93533bee4ba1d117265
source_snapshot_sha256=965a5412c4fb2b8aa6d1a95a025165240424657605701e986e9e446462ece3ac
variant=hypre-baseline
compute_capability=8.9
hypre_version=3.1.0
```

Szersza receptura `verify-fem-mixed-p1-native-contract` nadal ma osobną,
niestabilną bramę dynamicznego dowodu Armijo; jej nonzero nie jest przypisywane
tej zmianie readback.

### 32.38.3. Reprodukcja SP4 GPU B

W managed runtime wykonano `coarse/baseline`, `duration=1e-14 s`,
`FULLMAG_SP4_QUALIFYING=0`, z `fallback_policy=forbidden`. Generator siatki
odrzucił degenerate tetrahedra w Delaunay i HXT, po czym poprawnie przeszedł
na Frontal; końcowa siatka miała `371527` tetrahedrów i `n_below=0` względem
progu Rust.

Relaksacja GPU zakończyła się jednym zaakceptowanym krokiem,
`E_total=7.096178733169550e-19 J`, `CG/AMG`, `actual_iterations=1` i
`final_residual_norm=6.269382070830224e-13`. Dynamiczny GPU `case-b`
zakończył się czterema krokami do `1e-14 s`:

```text
E_demag=7.096159932911974e-19 J
E_total=6.102220917941828e-18 J
actual_iterations=1
final_residual_norm=6.06259661355375e-13
execution_engine=fem_native_gpu
fem_demag_operator_mode=device_hypre_poisson
hypre_execution_policy=device
lossy_fallback_used=false
```

Scalone artefakty CPU/GPU coarse A/B poddano walidatorowi
`tests.standard_problems.mumag.sp4.fem.verify --smoke`; wynik to `status=passed`,
cztery przebiegi, po cztery próbki i zero failures. Dodany `tests/__init__.py`
usuwa kolizję z obcym pakietem `tests` podczas uruchamiania oficjalnego
walidatora.

### 32.38.4. Granica kwalifikacji i aktualny status

Obserwowany przebieg GPU B nie wymusił `cudaErrorMemoryAllocation`: przeszedł
ścieżką pinned. Fallback pageable ma kontrakt statyczny i został zbudowany,
lecz wymaga osobnego testu z kontrolowanym odrzuceniem `cudaHostAlloc`, zanim
można uznać go za runtime-qualified. Naprawa zamyka więc bramę wykonawczą
GPU B dla bieżącego procesu, ale nie awansuje SP4 do `validated`: czas
`1e-14 s`, `--smoke`, brak pełnego medium/fine, parity i map przestrzennych.
SHE/BORIS, cross-backend parity, skin-effect/MQS, FEM Oersted RT0/KKT,
fizyczny M3 `C_s` oraz pełny Python/UI round-trip nadal pozostają otwarte.
Szeroka ocena celu pozostaje **86% implementacji / 60% gotowości produkcyjnej**;
zmienił się wyłącznie status obserwowanej bramy GPU B oraz jakość artefaktów
demaga.

## 32.39. Ponowny pull z mastera i weryfikacja demaga (2026-08-03)

Wykonano ponownie `git fetch origin master` oraz `git pull --ff-only origin
master`. Pull zwrócił `Already up to date`; bieżący lokalny `master` i
`origin/master` wskazują ten sam commit:

```text
HEAD=02f7bf813c97193ff4f39df719da2afe4376e29e
origin/master=02f7bf813c97193ff4f39df719da2afe4376e29e
git rev-list --left-right --count HEAD...origin/master = 0 0
```

Istniejące, niepowiązane zmiany robocze w `apps/legacy_web` oraz
`external_solvers/3` pozostały nietknięte. Nie wykonano push.

Po pullu wykonano dwa aktualne poziomy dowodu:

```text
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 PYTHONPATH=packages/fullmag-py/src:. \
  pytest -q --capture=sys \
  packages/fullmag-py/tests/test_conformal_occ_degenerate_retry_regression.py
2 passed

just verify-fem-time-domain-native-contract
LLG time-domain documentation contract: passed
managed CUDA/MFEM/SLEPc native build and contracts: passed
fullmag-fem-sys ABI: 35 passed; 0 failed
```

Wynik potwierdza, że poprawka progu objętości OCC oraz zarządzany runtime
demaga są obecne na zsynchronizowanym `master` i nie wykazują regresji w
kontraktach natywnych. Nie jest to jeszcze pełna kwalifikacja naukowa SP4:
fallback pageable nadal nie został wymuszony w runtime, a pełne medium/fine,
mapy przestrzenne i cross-backend parity pozostają otwarte. Pełna suita Python
pozostaje niezielona (`1406 passed, 49 failed, 3 skipped` w bieżącym rerunie),
więc nie zmieniam szerokiej oceny **86% implementacji / 60% gotowości
produkcyjnej**.

## 32.40. Kontrolowana kwalifikacja pageable scalar readback GPU (2026-08-03)

Zamknięto wcześniej otwartą bramę testowalności fallbacku stagingu scalarów
GPU. Sam obserwowany SP4 nadal używa pinned path, dlatego nie wolno było
udawać, że przypadkowe obciążenie hosta jest deterministycznym testem. Dodano
wyłącznie kwalifikacyjny hook środowiskowy
`FULLMAG_FEM_FORCE_PAGEABLE_SCALAR_READBACK=1`; domyślna produkcyjna ścieżka
nadal próbuje `cudaHostAlloc`, a każdy błąd inny niż
`cudaErrorMemoryAllocation` pozostaje fatalny.

Zakres zmiany:

- `backends/fem/gpu/cuda/reductions/reduction_workspace_memory.cpp` wybiera
  fixed 32-slot pageable array tylko dla kontrolowanego hooka albo rzeczywistego
  `cudaErrorMemoryAllocation`; nie zmienia żadnego równania, redukcji ani
  kryterium solvera;
- `backends/fem/gpu/cuda/integrators/rk/rk_scalar_readback.cu` opisuje teraz
  scalar host staging, ponieważ zarówno pinned, jak i pageable destination
  korzysta z tego samego `cudaMemcpyAsync` i stream fence;
- `backends/fem/tests/gpu_pageable_scalar_readback_contract.cpp` jest
  wykonywalnym testem CUDA, nie testem tekstowym: alokuje workspace, sprawdza
  `scalar_result_pinned=false`, wykonuje D2H na urządzeniu, synchronizuje,
  sprawdza wartość `3.25` i weryfikuje bezpieczny cleanup;
- `just verify-fem-time-domain-native-contract` buduje i uruchamia ten target
  w zarządzanym kontenerze, bez hooka w normalnym runtime.

Świeży managed wynik:

```text
just verify-fem-time-domain-native-contract: PASS
pageable scalar readback: forced qualification branch, warning emitted,
  async D2H + synchronization + numeric preservation + cleanup: PASS
fullmag-fem-sys ABI: 35 passed; 0 failed
```

To zamyka bramę **kontrolowanego runtime fallbacku**, ale nie awansuje SP4 do
`validated`: pełne medium/fine, mapy przestrzenne, CPU/GPU parity i fizyczna
kwalifikacja cross-backend nadal są wymagane. Nie zmieniam szerokiej oceny
**86% implementacji / 60% gotowości produkcyjnej**.

## 32.41. Kanoniczny Slonczewski v2 FEM GPU: descriptor, maska i kontrakt FP64 (2026-08-04)

### 32.41.1. Zakres i decyzja fizyczna

Po zamknięciu obserwowanej bramy demaga wybrano następną bramę P0: usunięcie
nieuzasadnionego blokowania `slonczewski.fullmag.v2` na FEM GPU, ale tylko po
przeniesieniu pełnego deskryptora fizycznego. Implementacja nie wraca do
legacy `|J|` ani do `current_sign` jako substytutu orientacji. Kernel v2
otrzymuje wektor `J_c`, znormalizowaną normalną `n_stack`, dokładną wartość
`e=1.602176634e-19 C`, niezależne `epsilon_prime`, `t_F`, `M_s`, `alpha`,
polaryzację i opcjonalną maskę aktywnego celu. Wzór pozostaje:

```text
J_n = J_c · n_stack
Omega_J = gamma_e hbar J_n / (e M_s t_F)
T_explicit = Omega_J [ (epsilon + alpha epsilon_prime) D
                      + (epsilon_prime - alpha epsilon) C ]/(1+alpha^2)
```

gdzie `D=m×(m×p)` i `C=m×p`. Maska jest opcjonalnym stanem urządzenia w
`FemGpuMeshRegionDeviceState`; jej brak oznacza wszystkie węzły magnetyczne,
a jej obecność wymaga długości równej liczbie węzłów. Nie dodano nowej fizyki
do `Context` ani do `mfem_bridge.cpp`.

### 32.41.2. Zmiany wykonawcze

- `stt_kernels.cu/.hpp` rozdziela gałąź legacy od canonical v2 i zachowuje
  zgodność legacy, ale v2 korzysta z `J_c·n_stack`, bez czynnika `2` i bez
  faktoryzowania `epsilon_prime` przez `epsilon(c)`;
- `rk_slonczewski_torque.cu` przekazuje pełny deskryptor z `Context`,
  `rk_plan.cpp` usuwa blokadę wersji v2 i pozostawia fail-closed dla brakującej
  rezydencji urządzenia lub niezaładowanej maski;
- `gpu_state_upload_stt_target_mask` odpowiada za alokację, upload,
  zwolnienie, księgowanie bajtów i transfer audit; bootstrap wywołuje go po
  uploadzie współczynników materiałowych;
- `engine.rs` i testy wyboru silnika nie oznaczają już v2 jako CPU-only;
  Zhang–Li v1 pozostaje zablokowany na FEM GPU;
- dodano `fem_cuda_slonczewski_contract`, a receptury managed STT i
  time-domain budują oraz uruchamiają ten target.

### 32.41.3. Dowód RED → GREEN

Najpierw uruchomiono istniejącą recepturę po dodaniu testu kompletności
deskryptora. Otrzymano oczekiwany RED:

```text
FAIL: FEM GPU Slonczewski descriptor must carry formula version, vector current, stack normal, and target mask
```

Po implementacji wykonano w kontenerze zarządzanym:

```text
just verify-fem-stt-native-contract
```

Wynik GREEN:

```text
FEM CUDA Slonczewski v2 numeric contract PASS
fullmag-fem-sys: 1 passed; 0 failed
```

Test numeryczny sprawdza niezależnie: `J=(3e12,-4e12,0) A/m^2`,
`n_stack=(0,1,0)`, `t_F=1e-9 m`, `P=0.5`, `Lambda=1`, `epsilon_prime=0.35`,
`alpha=0.2`, `M_s=800 kA/m`, maskę `{1,0}`, zgodność z CPU oraz zmianę znaku
po odwróceniu prądu. Węzeł poza celem pozostaje dokładnie zerowy.

Następnie wykonano pełną recepturę:

```text
just verify-fem-time-domain-native-contract
```

Wynik: dokumentacja czasu LLG, managed CUDA/MFEM/SLEPc build, wszystkie
kontrakty natywne, nowy `fem_cuda_slonczewski_contract`, kontrolowany pageable
demag readback oraz `fullmag-fem-sys` (`35 passed; 0 failed`) przeszły.

Source map `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.source-map.json`
przechodzi walidator `validate_scientific_docs.py`; nota fizyczna opisuje teraz
descriptor GPU, zakres dowodu i granice kwalifikacji.

### 32.41.4. Granica kwalifikacji i ocena

Macierz capability zmieniono wyłącznie dla krotki
`FEM/GPU/double/strict/slonczewski.fullmag.v2/thin_layer`: z `unsupported` na
`reference_executable`. Nie jest to `production_executable` ani `validated`.
Dowód obejmuje jeden krok FP64 i operatorową inwolucję znaku, ale nie obejmuje
pełnej trajektorii RK, trzech siatek, zbieżności przestrzennej, długiego
przebiegu demaga, cross-backend parity z FDM/MuMax3, FP32 ani pełnego
Python/UI round-trip. Interfejsowy `slonczewski_interface_flux.v1` nadal
pozostaje fail-closed/semantic-only.

Otwarte P0 pozostają: pełna trajektoria i cross-backend parity STT, SHE/SOT
z BORIS i wzajemnością, RT0/KKT Oersteda, fizyczny adapter DOS→`C_s`, SML v2,
skin/MQS, pełny Python/OpenAPI/UI round-trip oraz produkcyjna kwalifikacja
FEM GPU. Szeroka ocena celu pozostaje konserwatywnie **86% implementacji /
60% gotowości produkcyjnej**; zmiana podnosi jedynie wykonawczą granicę FEM
GPU z fail-closed do ograniczonego `reference_executable`.

## 32.42. Stałokrokowa trajektoria Slonczewskiego v2 FDM CUDA (2026-08-04)

### 32.42.1. Zakres bramy

Po synchronizacji z `origin/master` wybrano następną małą bramę P0 dla już
istniejącego, wykonywalnego deskryptora FDM CUDA. Nie zmieniano równania
Slonczewskiego, demaga, schematu Heun ani ABI. Test wykonuje ten sam plan
`slonczewski.fullmag.v2` w `double`, ze stałym `dt=2.5e-13 s`, z wektorem
prądu `J_c=(1.4e11,0,0) A/m^2`, normalną `n_stack=(2,0,0)` oraz rozdzielną
maską celu. Po każdym z ośmiu zaakceptowanych kroków pobiera pełną
magnetyzację CUDA i porównuje ją z niezależnym CPU-reference uruchomionym do
tego samego prefiksu czasowego. Dzięki temu test nie ogranicza się do
zgodności pojedynczego RHS-a ani końcowego stanu.

### 32.42.2. RED → GREEN

Dodano test:

```text
native_fdm_canonical_slonczewski_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available
```

oraz rozszerzono recepturę `just verify-fdm-slonczewski-native-contract`, aby
uruchamiała zarówno istniejący test one-step, jak i nowy test trajectory.
Pierwsze uruchomienie po zmianie receptury zbudowało pełny `fullmag_fdm` w
zarządzanym kontenerze CUDA; wynik końcowy:

```text
just verify-fdm-slonczewski-native-contract
running 2 tests
...with_target_mask_when_cuda_is_available ... ok
...for_fixed_trajectory_when_cuda_is_available ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 781 filtered out
```

Brama obejmuje osiem prefiksów czasowych, nie osiem niezależnych przebiegów z
ponownie ustawionym stanem CUDA. Porównanie zachowuje tolerancję
`rtol=1e-6`, `atol=1e-10` dla każdej składowej `m` i każdego kroku.

### 32.42.3. Granica kwalifikacji

To jest bounded FP64 FDM CPU↔CUDA temporal-parity evidence dla jednego
małego, stałokrokowego workloadu. Nie zamyka obecnie: sweepu skali prądu,
zbieżności `dt` i siatki, FP32, adaptacyjnego RK, FEM/GPU, zgodności z
MuMax3/BORIS ani fizycznego workloadu skyrmionu/racetrack/Hall angle.
Capability matrix zachowuje `production_executable` dla FDM GPU oraz
`reference_executable` dla FEM GPU; zmieniono wyłącznie opis dowodu FDM.
Szeroka ocena celu pozostaje konserwatywnie **86% implementacji / 60%
gotowości produkcyjnej**. Następne P0 pozostają: SHE/BORIS i wzajemność,
pełna trajektoria FEM/GPU, current-scaling i cross-backend, skin/MQS,
fizyczny adapter DOS→`C_s`, SML v2 oraz pełny Python/OpenAPI/UI round-trip.

## 32.43. Izolowana brama skalowania prądu Slonczewskiego v2 FDM CUDA (2026-08-04)

### 32.43.1. Zakres fizyczny

Po ośmiokrokowej bramie temporalnej dodano osobny test, który nie używa
CPU-reference jako jedynego kryterium. Plan FDM CUDA jest kanonicznym
`slonczewski.fullmag.v2` z tym samym wektorem `J_c=(1.4e11,0,0) A/m^2`,
`n_stack=(2,0,0)`, `P=0.62`, `Lambda=1.8`, `epsilon_prime=0.03` i maską celu.
Wyłączono wymianę, demag i pole zewnętrzne, aby izolować źródło STT. Dla
`dt=1e-15 s` wykonuje się po jednym kroku przy `0.5x`, `1x` i `2x` prądu,
a norma przyrostu magnetyzacji względem stanu bazowego musi skalować się
odpowiednio `1:2:4` w aktywnych komórkach. Tak mały krok utrzymuje pomiar w
liniowym envelope Heuna; nie jest to twierdzenie o liniowości dużego prądu,
długiej trajektorii ani o stabilności po zmianie siatki.

### 32.43.2. Implementacja i dowód RED → GREEN

Dodano test wykonywalny:

```text
native_fdm_canonical_slonczewski_has_bounded_current_scaling_when_cuda_is_available
```

Receptura `just verify-fdm-slonczewski-native-contract` została rozszerzona,
aby uruchamiać trzy kanoniczne testy FDM CUDA. Managed build i runtime dały:

```text
just verify-fdm-slonczewski-native-contract
running 3 tests
...matches_cpu_reference_with_target_mask_when_cuda_is_available ... ok
...has_bounded_current_scaling_when_cuda_is_available ... ok
...matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available ... ok
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 781 filtered out
```

Zmiana nie dotyka równania, prefaktora `hbar/e`, maski ani deskryptora ABI;
sprawdza wyłącznie obserwowalną odpowiedź istniejącego kernela na skalowanie
podpisanego `J_c dot n_stack`.

### 32.43.3. Granica kwalifikacji

Zamknięto tylko bounded isolated FP64 FDM CUDA current-increment scaling.
Nie zamyka to nonlinearnego sweepu prądu, zbieżności `dt`/siatki, FP32,
pełnej trajektorii FEM/GPU, cross-backend parity, MuMax3/BORIS ani workloadu
skyrmionu/racetrack/Hall angle. Capability pozostaje
`production_executable` dla FDM GPU i `reference_executable` dla FEM GPU;
`validated_workloads` pozostaje puste. Szeroka ocena celu nie zmienia się:
**86% implementacji / 60% gotowości produkcyjnej**. Następne P0 to pełna
trajektoria FEM/GPU i cross-backend/current sweep, SHE/BORIS z wzajemnością,
skin/MQS, DOS→`C_s`, SML v2 oraz pełny Python/OpenAPI/UI round-trip.

## 32.44. Stałokrokowa trajektoria Slonczewskiego v2 FEM CPU↔GPU (2026-08-04)

### 32.44.1. Zakres bramy

Podłączono bramę temporalnej parytetu do rzeczywistego modułu testowego
`native_fem::tests` (wcześniejszy filtr wskazywał pomocniczy, nieużywany plik i
raportował zero dopasowanych testów). Workload jest kanonicznym
`slonczewski.fullmag.v2` / `slonczewski_thin_layer_homogenized.v1` w FP64, z
`J_c=(1.4e11,0,0) A/m^2`, `n_stack=(2,0,0)`, `P=0.62`, `Lambda=1.8`,
`epsilon_prime=0.03`, `t_F=1e-9 m` i maską węzłów
`[true,true,false,true,true]`. Wymiana pozostaje włączona, ponieważ jest
warunkiem device-resident GPU RK; demag i pole zewnętrzne są wyłączone.
CPU i GPU wykonują osiem kolejnych kroków Heuna przy `dt=1e-15 s`, a pełna
magnetyzacja po każdym kroku jest porównywana z tolerancją `rtol=5e-7`,
`atol=1e-10`. Maska jest sprawdzana przez parytet całego wektora; nie narzuca
się bitowej niezmienności węzła nieaktywnego, bo wymiana może zmienić go
pośrednio.

### 32.44.2. Dowód RED → GREEN

Dodano test:

```text
native_fem::tests::native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available
```

Receptura `just verify-fem-stt-native-contract` uruchamia teraz właściwy
inline test `native_fem::tests`, a pierwsze dwa testy planera korzystają z
`FULLMAG_FEM_LIB_DIR=/workspace/native/build/backends/fem`, dzięki czemu nie
odtwarzają niepotrzebnie całego natywnego MFEM/CUDA artefaktu w Cargo.
Managed wynik końcowy:

```text
FEM CUDA Slonczewski v2 numeric contract PASS
versioned_stt_extension_is_append_only_after_legacy_plan_prefix ... ok
auto_fem_canonical_slonczewski_v2_remains_gpu_eligible ... ok
strict_fem_canonical_slonczewski_v2_reaches_native_runtime_validation ... ok
native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available ... ok
test result: ok; 1 passed for each filtered Rust contract
```

### 32.44.3. Granica kwalifikacji

Zamknięto bounded FP64 CPU↔GPU temporal parity dla jednej ośmiokrokowej
trajektorii Heuna i jednego małego mesh/parameter envelope, wraz z
przekazaniem kanonicznego `J dot n_stack`, wersji formuły, grubości i maski.
Nie zamyka to pełnej rodziny integratorów, adaptacji kroku, zbieżności
`h`/`p`/multi-grid, długiego przebiegu demaga, FP32, cross-backend parity z
FDM/MuMax3/BORIS, nonlinearnego sweepu prądu ani produkcyjnej kwalifikacji
FEM GPU. Capability pozostaje `reference_executable`, a
`validated_workloads` pozostaje puste. Szeroka ocena celu pozostaje
**86% implementacji / 60% gotowości produkcyjnej**.

## 32.47. Izolowana brama skalowania prądu Slonczewskiego v2 FEM CPU↔GPU (2026-08-04)

### 32.47.1. Zakres fizyczny i korekta RED

Po zamknięciu ośmiokrokowej trajektorii FEM dodano osobną bramę odpowiedzi na
skalowanie prądu. Test
`native_fem::tests::native_fem_canonical_slonczewski_has_bounded_current_scaling_when_mfem_stack_is_available`
wykonuje niezależnie CPU i CUDA dla `0x`, `0.5x`, `1x` i `2x` prądu bazowego
`J_c=(2.4e13,0,0) A/m^2`, przy `dt=1e-15 s`,
`n_stack=(2,0,0)`, `P=0.62`, `Lambda=1.8`, `epsilon_prime=0.03`,
`t_F=1e-9 m`, tej samej masce węzłów oraz włączonej wymianie. Demag i pole
zewnętrzne są wyłączone, aby izolować kanoniczny lokalny tor
Slonczewskiego.

Pierwsza wersja testu była RED, ponieważ porównywała surowy przyrost
znormalizowanego `m`. Jego składowa radialna jest korektą normalizacji i ma
rzędowość kwadratową względem pierwszorzędowego momentu obrotowego. Kryterium
zostało więc sformułowane na przyroście względem stanu `0x`, po projekcji na
płaszczyznę styczną do początkowego `m`. To jest właściwy obserwabl fizyczny
dla małokrokowej liniowej odpowiedzi źródła; nie jest to rozluźnienie tolerancji
ani zmiana równania solvera.

### 32.47.2. Dowód RED → GREEN

Receptura zarządzana `just verify-fem-stt-native-contract` uruchamia tę bramę
po budowie `fullmag_fem`, natywnym kontrakcie CUDA, teście ABI oraz testach
planera i trajektorii. Wynik końcowy:

```text
FEM CUDA Slonczewski v2 numeric contract PASS
auto_fem_canonical_slonczewski_v2_remains_gpu_eligible ... ok
strict_fem_canonical_slonczewski_v2_reaches_native_runtime_validation ... ok
native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available ... ok
native_fem_canonical_slonczewski_has_bounded_current_scaling_when_mfem_stack_is_available ... ok
test result: ok; 1 passed for each filtered Rust contract
```

Kryteria to `1x=2*0.5x` z błędem względnym `<=0.5%` i
`2x=4*0.5x` z błędem `<=1%`, dla stycznej składowej odpowiedzi w każdym
węźle i obu realizacjach. Brama jest wykonywalna w zarządzanym kontenerze
CUDA, ale nie zmienia capability: FEM GPU pozostaje
`reference_executable`, a `validated_workloads` pozostaje puste.

### 32.47.3. Granica kwalifikacji i następne P0

Dowód zamyka wyłącznie bounded FP64 one-step tangential current scaling dla
małego workloadu FEM CPU/GPU. Nie zamyka nieliniowego sweepu prądu,
zbieżności `dt`/siatki, FP32, pełnej rodziny integratorów, długiej trajektorii,
demaga, cross-backend parity z FDM/MuMax3/BORIS ani produkcyjnej kwalifikacji.
Szeroka ocena pozostaje konserwatywnie **86% implementacji / 60% gotowości
produkcyjnej**. Kolejne P0 to cross-backend STT/current sweep, SHE/BORIS i
wzajemność, RT0/KKT Oersteda, DOS→`C_s`, SML v2, skin/MQS oraz pełny
Python/OpenAPI/UI round-trip i browser evidence.

## 32.48. Wykonywalny BORIS N/F CUDA: naprawa identity i granica diagnostyczna (2026-08-04)

### 32.48.1. Root cause i regresja provenance

Pierwszy jawny `FULLMAG_BORIS_DEVICE=cpu just verify-boris-nf-interface`
zatrzymał się przed uruchomieniem solvera, ponieważ obraz CUDA nie udostępniał
`libnvidia-ml.so.1` dla CPU-owego procesu BORIS (exit `127`). Jawny tryb CUDA
uruchomił jednak cały skrypt N/F i zapisał pola, po czym ujawnił błąd w
warstwie identity: `capture_runtime_identity` gubiło `nvidia_smi_query`, mimo
że parser je zebrał. Po dodaniu testu regresyjnego zachowanie jest jawne:
GPU identity musi zachować dokładny wiersz `name, compute_capability`.

Drugi test RED wykazał, że parser brał pierwszą linię z przecinkiem z nagłówka
licencji kontenera (`Container image Copyright ...`) zamiast z zapytania
`nvidia-smi`. Parser został ograniczony do linii o postaci
`<nazwa GPU>, <liczbowa compute capability>`, a pełna suita
`scripts/test_run_boris_nf_interface.py` przechodzi `8 passed`.

### 32.48.2. Świeży managed gate

Receptura:

```text
FULLMAG_BORIS_DEVICE=cuda \
FULLMAG_BORIS_SHE_REPORT_ROOT=/zfn2/mateuszz/git/fullmag/boris-build/reports/boris-nf-interface-cuda-20260804-rerun2 \
just verify-boris-nf-interface
```

zakończyła się `exit 0` dla `coarse`, `medium` i `fine`. Każdy artefakt ma
`BORIS_NF_STAGE_COMPLETE`, komplet pól N/F OVF, `runtime.json` z
`BORIS Computational Spintronics 2022, version 4`,
`NVIDIA GeForce RTX 4080 SUPER`, `8.9` i przypiętym digestem obrazu.

### 32.48.3. Granica fizyczna

To zamyka tylko wykonywalność i kompletność artefaktu BORIS N/F CUDA. Nie jest
to `SHE-BORIS-001`, parity ani kwalifikacja produkcyjna. Coarse/medium mają
zero komórek wewnętrznych dla niezależnego residualu, więc ich zera są
niereprezentatywne; na fine normal-metal spin residual wynosi
`3.7620952779e-2` przy tolerancji `1e-5`, a surowe zamknięcia interfejsu nie są
zbilansowane. Nadal wymagane są: poprawny trzyrozdzielczościowy residual i
bilans N/F, wspólne jednostki `S→V_s→mu_s`, Fullmag FDM/FEM common-limit,
`iSHA=SHA` reciprocal, profile materiałowe oraz N/F/T mixing/SML.
Capability direct/inverse SHE pozostaje `semantic_only`, a szeroka ocena celu
pozostaje **86% implementacji / 60% gotowości produkcyjnej**.

## 32.49. Ponowna weryfikacja bramy demaga po aktualnym pullu (2026-08-04)

Po wcześniejszym pullu oraz lokalnych, już zapisanych poprawkach sprawdzono
stan repozytorium i wykonano bramę jeszcze raz z obowiązującej receptury
kontenerowej. `master` jest lokalnie jedenaście commitów przed
`origin/master` (`HEAD=0560bd6de2fcc83fec967463be415a1d98509bbf`,
`origin/master=b3c839b9c0d6a7cab99b8ad5c7b88007f7456a01`); nie wykonywano push.
Niepowiązane usunięcia debugów w `apps/legacy_web` oraz modyfikacja
`external_solvers/3` pozostały nietknięte.

Uruchomiono:

```text
just verify-fem-demag-poisson-contract-focused
```

Receptura ponownie skonfigurowała i zbudowała natywny `fullmag_fem` w
kontenerze CUDA/MFEM/Hypre, a następnie uruchomiła wszystkie sześć kontraktów:
`fem_demag_poisson_contract`, `fem_demag_delta_potential_contract`,
`fem_demag_fem_bem_contract`, `fem_cuda_demag_timing_contract`,
`fem_cuda_periodic_demag_contract` oraz `fem_cuda_periodic_exchange_contract`.
Proces zakończył się `exit 0`. Pojedynczy komunikat
`PCG: Number of iterations: 1 / No convergence!` jest emitowany przez fixture
sprawdzający odrzucenie niezbiegniętego kandydata; nie oznacza nieudanego całego
testu ani dowodu zbieżności produkcyjnego przebiegu.

Wniosek jest ograniczony do aktualnego kontraktu wykonawczego: po synchronizacji
z masterem i ponownej budowie po zmianach reference STT nie ma regresji w ścieżce Poisson/FEM-BEM, delta-potential,
timingu CUDA ani okresowym demagu/wymianie, a fail-closed dla nieudanego PCG
działa. Nie awansuje to jeszcze demaga do pełnej kwalifikacji fizycznej.
Nadal wymagają osobnych dowodów: medium/fine mesh convergence, airbox i RT0/KKT,
MPI scaling, długi runtime, mapy przestrzenne oraz cross-backend parity z FDM,
MuMax3 i zewnętrznymi solverami. Szeroka ocena celu pozostaje konserwatywnie
**86% implementacji / 60% gotowości produkcyjnej**.

## 32.50. Niezależny SI oracle dla jednego kroku Slonczewskiego v2 FEM (2026-08-04)

### 32.50.1. Wykryta luka w fixture i granica reference lane

Dotychczasowy test
`native_fem_slonczewski_step_matches_cpu_reference_when_mfem_stack_is_available`
nie był objęty recepturą `just verify-fem-stt-native-contract`. Po włączeniu
go do bramy test RED ujawnił, że fixture nie ustawiał
`spin_torque_contract`, mimo że nazwa sugerowała kanoniczny Slonczewski v2.
Po dodaniu kontraktu v2 i ponownym uruchomieniu test nadal był RED: helper
`cpu_reference_single_step` korzysta z `FemLlgProblem`, którego obecny FEM
reference lane nie dodaje bezpośredniego Slonczewski STT do RHS. Nie zmieniono
tego przez rozluźnienie tolerancji ani przez ukryty fallback.

Fixture został zatem przepisany na jawny, niezależny oracle SI/Heun w teście.
Oracle implementuje bezpośrednio:

```text
Omega_J = (J_c dot n_stack) hbar gamma0 /
          (e mu0 M_s t_F)
g(m)    = P Lambda^2 /
          (Lambda^2 + 1 + (Lambda^2 - 1)(m dot p))
tau     = [Omega_J (g + alpha epsilon')/(1+alpha^2)] m x (m x p)
        + [Omega_J (epsilon' - alpha g)/(1+alpha^2)] m x p
```

Dla pola efektywnego `H_eff=0` wykonuje dokładnie dwa etapy Heuna z
normalizacją kandydatów i porównuje magnetyzację po kroku oraz końcowe
`max_dm_dt`. To jest common-limit: `m` jest jednorodne, demag i pole
zewnętrzne są wyłączone, a włączona wymiana daje analitycznie zerowy wkład.

### 32.50.2. Zakres i parametry dowodu

Test nosi teraz nazwę
`native_fem::tests::native_fem_slonczewski_step_matches_independent_si_reference_when_mfem_stack_is_available`.
Używa FP64, Heuna, `dt=2.5e-13 s`, `J_c=(0,0,1.4e11) A/m^2`,
`n_stack=(0,0,1)`, `P=0.62`, `Lambda=1.8`, `epsilon_prime=0.03`,
`t_F=1e-9 m`, `M_s=8e5 A/m`, `alpha=0.1`, `gamma0=2.211e5 m/(A s)` oraz
jednorodnego `m=(1,0,0)` na małym mesh two-tets. Kontrakt zawiera
`slonczewski.fullmag.v2` i
`slonczewski_thin_layer_homogenized.v1`; wszystkie węzły są aktywne.
Pole zewnętrzne i demag są wyłączone, a `enable_exchange=true` pozostaje
wyłącznie wymaganiem device-resident GPU RK.

### 32.50.3. Managed GREEN i granica kwalifikacji

Po poprawce uruchomiono ponownie zaktualizowaną recepturę:

```text
just verify-fem-stt-native-contract
```

Wynik zarządzanego kontenera CUDA/MFEM/Hypre: C++
`FEM CUDA Slonczewski v2 numeric contract PASS`, test ABI, oba testy planera,
niezależny SI one-step, ośmiokrokowa trajektoria CPU↔GPU oraz current-scaling
przeszły (`1 passed; 0 failed` dla każdego filtrowanego kontraktu). Ostrzeżenia
Rust o nieużywanych symbolach są istniejące wcześniej i nie zmieniają wyniku.
Zmieniono także komendy w `justfile`, przewodniku host parity i skrypcie
sprawdzającym środowisko, aby wskazywały nową nazwę testu.

Dowód zamyka bounded FP64 one-step FEM native v2 względem niezależnego oracle
SI oraz nie zmienia capability: FEM GPU pozostaje
`reference_executable`, `validated_workloads` pozostaje puste. Nie jest to
jeszcze implementacja STT w `FemLlgProblem` reference lane ani cross-backend
FDM↔FEM equivalence. Nadal otwarte są nonlinear current sweep, `dt`/mesh
convergence, pełna rodzina integratorów, długie trajektorie, demag, FP32,
MuMax3/BORIS, SHE/BORIS reciprocal, SML, skin/MQS i Python/OpenAPI/UI
round-trip. Szeroka ocena celu pozostaje **86% implementacji / 60% gotowości
produkcyjnej**.

## 32.51. FEM↔FDM common-limit dla Slonczewskiego v2 (2026-08-04)

### 32.51.1. Kontrakt porównania i naprawa fixture

Dodano test
`native_fem::tests::native_fem_slonczewski_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available`.
Porównuje on jeden krok natywnego FEM GPU z referencyjnym FDM CPU w tym samym
common-limit: FP64, Heun, `dt` pobrane z tego samego planu FEM, jednorodne
`m=(1,0,0)`, `J_c=(0,0,1.4e11) A/m^2`, `n_stack=(0,0,1)`, `P=0.62`,
`Lambda=1.8`, `epsilon_prime=0.03`, `t_F=1e-9 m`, `M_s=8e5 A/m`,
`alpha=0.1`, `gamma0=2.211e5 m/(A s)`. FDM ma dokładnie jedną aktywną
komórkę `1x1x1` o rozmiarze `1 nm`, a FEM używa tego samego małego mesh
two-tets. Demag i pole zewnętrzne są wyłączone; FEM zachowuje
`enable_exchange=true` tylko jako warunek uruchomienia device-resident RK,
lecz dla jednorodnego stanu wkład wymiany jest zerowy; FDM wymianę wyłącza
jawnie.

Pierwsze uruchomienie nie przeszło przez certyfikację wejścia FDM, ponieważ
numeryczna `region_mask=[1]` nie miała legendy. Naprawa nie polegała na
obejściu walidacji: fixture tworzy teraz pełny
`FdmGridCertificateIR::new_with_masks(...)` z aktywną komórką, właściwym
budżetem pamięci oraz legendą `common-limit:core`. To zachowuje fail-closed
kontrakt planera i provenance także w teście cross-backend.

### 32.51.2. Managed GREEN i metryka

Nowy test jest osobnym krokiem receptury `just verify-fem-stt-native-contract`,
wykonywanym w tym samym zarządzanym kontenerze `fem-gpu` po budowie
`fullmag_fem`. Dla każdego z pięciu węzłów FEM porównywane są trzy składowe
końcowej magnetyzacji z wynikiem jednej komórki FDM; obowiązuje tolerancja
`5e-8` względnie `1e-10` absolutnie. Po dołączeniu certyfikatu wynik bramy jest
GREEN:

```text
native_fem_slonczewski_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available ... ok
test result: 1 passed; 0 failed
```

### 32.51.3. Granica interpretacji

Jest to pierwszy wykonywalny cross-backend common-limit dla bezpośredniego
Slonczewskiego v2: native FEM GPU kontra FDM CPU reference. Nie dowodzi jeszcze
zgodności FDM CUDA, zbieżności przestrzennej/czasowej, ciągłego limitu FEM przy
zagęszczaniu siatki, integracji z demagiem, FP32, długiej trajektorii ani
zgodności z MuMax3/BORIS. Nie zmienia capability: `validated_workloads`
pozostaje puste, a kwalifikacja produkcyjna wymaga sweepu `J`, zbieżności
`dt`/mesh i niezależnego bilansu momentu (tangential/projected/integrated)
na większej rodzinie geometrii. Szeroka ocena celu pozostaje **86%
implementacji / 60% gotowości produkcyjnej**.

## 32.52. FEM Rust reference lane: bezpośredni Slonczewski v2 w RHS (2026-08-04)

### 32.52.1. Root cause i korekta wspólnej algebry

Audyt ujawnił, że `FemLlgProblem` przechowywał
`EffectiveFieldTerms.slonczewski_stt`, ale `llg_rhs_into`,
`llg_rhs_from_vectors` oraz podsumowania `max_rhs` używały wyłącznie
`H_eff`. Oznaczało to, że native FEM i FDM miały bezpośredni torque, lecz
Rust FEM reference lane cicho go pomijał. To było niepoprawne fizycznie i
uniemożliwiało traktowanie reference lane jako niezależnego orakla.

Wprowadzono jedną współdzieloną funkcję
`crates/fullmag-engine/src/fdm/cpu/fields.rs::slonczewski_torque_from_config`.
Zachowuje ona dokładne `e`, signed `current_sign`, `1/(M_s t_F)`, efektywność
`g(m)`, transformację Gilberta v2 oraz niezależny `epsilon_prime`. FDM AoS/SoA
wywołuje tę samą funkcję co FEM; maska aktywnych komórek/węzłów nadal należy
do realizacji dyskretnej. `FemLlgProblem::slonczewski_rhs_at` dodaje torque
do RHS `dm/dt`, nie do `H_eff`, a `observe_vectors`,
`evaluate_rhs_summary_from_vectors` i `llg_rhs_from_vectors` raportują także
jego wkład w `max_rhs`.

### 32.52.2. Test-first i managed GREEN

Dodano test jednostkowy
`crates/fullmag-engine/src/fem.rs::tests::reference_fem_applies_slonczewski_v2_direct_rhs`.
Dla jednorodnego tetra i Heuna niezależnie oblicza oba etapy z tego samego
SI evaluatora, porównuje każdy komponent magnetyzacji po kroku i wymaga
niezerowego `max_rhs`. Osiem testów silnika związanych ze Slonczewskim (FDM
AoS/SoA, legacy, v2, oba integratory oraz FEM reference) przechodzi w
`CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/fem-stt-reference`.

Do istniejącego managed testu native FEM dodano również porównanie
`cpu_reference_single_step` z niezależnym SI/Heun oracle. Pełna receptura:

```text
just verify-fem-stt-native-contract
```

zakończyła się `exit 0`: C++ numeric contract, ABI, planner, Rust FEM
reference-vs-oracle, native FEM CPU↔GPU trajectory, current scaling oraz
FEM↔FDM common-limit są GREEN. Ostrzeżenia Rust są wcześniejszymi warningami
nieużywanych symboli.

### 32.52.3. Granica kwalifikacji

Korekta domyka brak w reference lane dla lokalnego Slonczewskiego v2 i
utrzymuje rozdział torque–`H_eff`; nie jest dowodem produkcyjnej zgodności
Zhang-Li, SOT, SHE, SML, demaga ani pełnej trajektorii na wielkich siatkach.
Nie zmienia capability: native FEM GPU pozostaje
`reference_executable`, `validated_workloads` pozostaje puste. Nadal wymagane
są `J`/`dt`/mesh convergence, długie przebiegi, FP32, maski na niejednorodnych
obszarach oraz wspólna kwalifikacja z FDM CUDA, MuMax3 i BORIS. Szeroka ocena
celu pozostaje **86% implementacji / 60% gotowości produkcyjnej**.

## 32.53. Receptura macierzy BORIS–Fullmag: jawny Python i urządzenie (2026-08-04)

### 32.53.1. RED z rzeczywistej receptury

Pierwsze uruchomienie:

```text
FULLMAG_BORIS_FULLMAG_SHE_REPORT_ROOT=/zfn2/mateuszz/git/fullmag/boris-build/reports/fullmag-boris-she-nf-v1-rerun-20260804 \
FULLMAG_BORIS_BUILD_ROOT=/zfn2/mateuszz/git/fullmag/boris-build/source \
FULLMAG_FULLMAG_BINARY=/home/kkingstoun/git/fullmag/fullmag/.fullmag/local/bin/fullmag \
just verify-boris-fullmag-she-nf
```

zatrzymało się przed wygenerowaniem artefaktu Fullmag, ponieważ receptura
nadpisywała `PYTHONPATH` wartością `scripts`. `run_boris_fullmag_she_nf_matrix.py`
importuje publiczny pakiet `fullmag`, więc otrzymano:

```text
ModuleNotFoundError: No module named 'fullmag'
```

Po poprawce receptura zachowuje `packages/fullmag-py/src` oraz `scripts` w
`PYTHONPATH`; nie zmienia to modelu fizycznego ani wyników solvera.

### 32.53.2. Jawna ścieżka CUDA BORIS

Drugi RED ujawnił, że macierz hardcodowała `device="cpu"`, podczas gdy
przypięty `BorisLin` jest binarium CUDA wymagającym `libnvidia-ml.so.1`.
Zamiast ukrywać fallback, dodano parametr `--device {cpu,cuda}` oraz pole
`device` w każdym wpisie i raporcie macierzy. Receptura przekazuje
`FULLMAG_BORIS_DEVICE`, domyślnie `cuda`; ścieżka CPU nadal pozostaje dostępna
wyłącznie dla binarium, które rzeczywiście ma CPU-owe zależności.

Testy parsera, walidatora i porównania po zmianie:

```text
17 passed
```

Jawne uruchomienie CUDA wygenerowało pierwszy pełny artefakt BORIS N/F oraz
artefakt Fullmag dla `10x4x2+2`, ale porównanie zakończyło się statusem
`incomparable`: pola transportowe i interfejsowe różnią się, a `Tsi` BORIS ma
jednostkę `A/(m s)`, natomiast Fullmag publikuje Gilbert source `1/s`.
Przykładowe metryki z tego przypadku to `mu_s` max-relative
`1.987e+0`, `spin_current_qia` `1.999998e+0` i charge-current `1.331e+0`.
To jest dowód diagnostyczny i wskazuje na dalszą pracę nad wspólnym
workloadem/konwencją, nie na zgodność solverów. `SHE-BORIS-001` pozostaje
otwarta; nie zmieniono capability ani `validated_workloads`.

### 32.53.3. Granica i następny krok

Naprawa zamyka tylko dwa błędy integracyjne: import publicznego DSL oraz
niejawny wybór urządzenia. Nie zamyka reciprocal `iSHA=SHA`, mapowania
`S→V_s→mu_s`, zgodności interfejsu N/F/T, torque-unit mapping, trzech
rozdzielczości ani produkcyjnej kwalifikacji SHE. Następny krok P0 to
wydzielenie wspólnego, jednoznacznego M1 direct-SHE common-limit z identycznym
`E`, `lambda_sf`, normalną i znakiem, a dopiero potem rozszerzenie go na
reciprocal M2/BORIS.

## 32.54. Wspólny M1 direct-SHE common-limit FDM↔FEM (2026-08-04)

### 32.54.1. Cel i identyczny fixture SI

Dodano wykonywalną bramę
`native_fem::steady_transport::tests::direct_she_common_si_limit_matches_fdm_and_fem_reference_profiles`.
Jest to pierwszy wspólny test direct-SHE, w którym FDM CPU i natywny FEM CPU
otrzymują ten sam opis fizyczny, a nie tylko podobne wartości wejściowe.
Fixture ma długość `L=1 m` w osi `z`, przekrój `1 m × 0.1 m`, a sweep ma
`N_z∈{8,16,32}`,
`σ=3 S/m`, `σ_s=2 S/m`, `θ_SH=0.1`, `λ_sf=0.2 m` oraz `E_x=1 V/m` przez
potencjały elektrod `V(x=0)=+0.5 V` i `V(x=L_x)=-0.5 V`. Wszystkie pozostałe
ściany są izolujące dla ładunku i spinu, `m=(0,0,1)`, sprzężenie jest
jednokierunkowe, a oba solvery działają w FP64 na CPU w trybie strict.

FDM używa siatek `1×1×N_z` z `Δz=1/N_z m`. FEM używa dokładnie tego samego
prostopadłościanu, rozciętego na `N_z` warstw po sześć tetraedrów (dla
`N_z=16`: `96` tetów i `68` węzłów), z markerami `1=x_min`, `2=x_max`,
`3=pozostałe ściany`.
Wspólna referencja analityczna dla składowej `y` potencjału spinowego jest
rozwiązaniem jednowymiarowym z izolującymi końcami:

```text
μ_y(z) = [2 θ_SH σ E_x λ_sf /
          (σ_s cosh(L/(2 λ_sf)))] sinh((z-L/2)/λ_sf) .
```

`μ_y` i `V` są w woltach, `J_x` w `A/m²`, a `σ`, `σ_s` w `S/m`. Fixture
sprawdza więc również jednostki i znak, a nie tylko podobieństwo bezwymiarowej
krzywej.

### 32.54.2. RED fixture i poprawka topologii

Pierwsze uruchomienie po kompilacji zakończyło się abortem MFEM:

```text
MFEM abort: (r,c,f) = (0,1,2)
... in function: mfem::STable3D::operator()
```

Śledzenie danych wykazało, że objętości wszystkich sześciu tetów były dodatnie,
ale dostarczone trójkąty brzegowe nie były ścianami tych tetów (na przykład
użyto `[a,b,d]` zamiast rzeczywistej ściany `[a,b,c]`). `FinalizeTopology`
odrzucał zatem niespójną topologię, zanim rozpoczęło się rozwiązywanie
transportu. Poprawiono wyłącznie definicję wszystkich trójkątów boundary
(dwanaście wpisów generatora), tak aby każdy marker wskazywał rzeczywistą
ścianę podziału `a-g`; nie zmieniono równań, parametrów, geometrii ani
tolerancji.

### 32.54.3. Kryteria i managed GREEN

Test wymaga jednocześnie:

- `J_x=σE_x=3 A/m²` z natywnego FEM,
- reszty spinowej FDM i FEM poniżej `1e-10`,
- maksymalnego błędu bezwzględnego obu profili względem `sinh` poniżej
  `2e-3 V`,
- wzajemnej różnicy profili poniżej `5e-2` względnie,
- dodatniego znaku `μ_y` przy górnej ścianie `z=L`,
- ścisłego spadku błędu oracle FDM i FEM przy każdym przejściu
  `N_z=8→16→32`.

Obowiązująca receptura zarządzana:

```text
just verify-fem-steady-transport-native-contract
```

zakończyła się `exit 0` w kontenerze `fem-gpu` po przebudowie
`fullmag_fem`. W tej samej bramie przeszły kontrakty C++/ABI, planner,
publikacja artefaktów/API, `cargo check` oraz nowy test:

```text
direct_she_common_si_limit_matches_fdm_and_fem_reference_profiles ... ok
test result: 1 passed; 0 failed
```

W tym samym przebiegu sweep zbieżności wypisał:

```text
N_z=8:  FDM 2.6448876e-4 V, FEM 1.5315748e-3 V, cross 3.1032049e-2
N_z=16: FDM 6.7313028e-5 V, FEM 4.5650007e-4 V, cross 8.6442426e-3
N_z=32: FDM 1.7190895e-5 V, FEM 1.2418603e-4 V, cross 2.2596799e-3
```

Każdy błąd maleje przy rafinacji (w przybliżeniu rząd drugi), więc test
rozróżnia zgodność fizycznego common-limit od przypadkowego dopasowania jednej
siatki. Jest to nadal ograniczona brama regularnego `h`-refinement; nie jest
jeszcze pełnym 3D refinementem ani certyfikatem GPU.

To jest wykonywalny dowód zgodności w ograniczonym, liniowym common-limit,
a nie ogólna deklaracja zgodności backendów. Nie zmieniono capability matrix:
`validated_workloads` pozostaje puste, a direct/inverse SHE nie awansuje przez
ten test do kwalifikacji produkcyjnej.

### 32.54.4. Granica kwalifikacji i następne bramy

Dowód obejmuje wyłącznie jednorodny, one-way M1, FP64, CPU reference lanes,
stałe materiały, regularny tetra mesh i analityczny profil 1D oraz ograniczony
sweep `N_z`. Nie obejmuje FDM CUDA ani FEM GPU transportu, pełnego 3D
`h`-refinement, nieliniowego M2,
reciprocal `iSHE`, interfejsów N/F/T, SML/mixing, Oersteda, skin/MQS,
transient transport, niejednorodnych `m`/materiałów, BORIS parity ani
Python/OpenAPI/UI round-trip. `SHE-BORIS-001` pozostaje otwarta; następną
bramą jest wspólna konwencja `μ_s`/`S` i reciprocal M2, a potem pełny 3D
refinement oraz niezależny bilans prądu/spinu.

Szeroka ocena pozostaje konserwatywnie **86% implementacji / 60% gotowości
produkcyjnej**: wzrósł zakres wykonywalnego dowodu direct-SHE, lecz nie
zmieniły się warunki awansu do `validated_workloads` ani do produkcyjnej
kwalifikacji cross-backend.

## 32.55. Bounded reciprocal M2 FEM CPU — implementacja i brama runtime (2026-08-04)

### 32.55.1. Zakres fizyczny i granica realizacji

Dodano bounded reciprocal M2 dla natywnego FEM CPU. Jest to jedna, monolityczna
formulacja H1/P1 dla niewiadomych `(V, μ_sx, μ_sy, μ_sz)`, z konstytutywnym
blokiem:

```text
J_c = J_mr(E,m) + P σ m_a G_ia + θ_SH σ ε_ija G_ja,
Q_ia = σ_s G_ia + P σ E_i m_a + θ_SH σ ε_ika E_k,
E_i = -∂_i V,   G_ia = -1/2 ∂_i μ_s,a.
```

Symetryczny AMR/PHE (`σ_parallel`, `σ_perpendicular`) i antysymetryczny AHE
(`σ_AHE`) są przekazywane jako jawne parametry materiału. Planner wymaga
  dodatniego Schur complementu
`min(σ_parallel,σ_perpendicular)σ_s-P²σ²`, a nie tylko dodatnich diagonalnych
przewodności. W tym wydaniu świadomie ograniczono solver do: FP64, CPU,
`execution_mode=strict`, pełnego wspólnego domenowego H1/P1, jednego
jednorodnego tensora ładunkowego, jednego materiału spinowego, referencji
Dirichleta dla potencjału ładunku, bez interfejsów wewnętrznych, bez
mixing/SML, bez polityki `reciprocal_nonlinear` i bez sprzężenia etapu z LLG
lub Oerstedem. Żaden niedozwolony przypadek nie przechodzi ukrytą ścieżką M1
ani FDM.

### 32.55.2. Implementacja cross-layer

- `backends/fem/cpu/mfem/transport/steady_transport.*` ma osobny model
  konstytutywny `Reciprocal`, blokowy GMRES i diagnostykę reszt/bilansów;
- `fullmag_fem_solve_steady_transport_m2_v1` korzysta z osobnego symbolu C ABI;
  request M2 zawiera zagnieżdżony, samookreślający się prefiks requestu M1 i
  trzy nowe przewodności;
- `fullmag-ir` zachowuje opcjonalny `ResolvedReciprocalMaterialIR`, a
  walidacja odróżnia legalny operator FEM M2 od FDM nonlinear M2;
- planner i runner materializują `fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1`,
  model `MagnetoresistivePoisson`, źródłowe `Bidirectional`, politykę
  `block_gmres` oraz provenance `reciprocal_m2`; preflight sprawdza zgodność
  źródła, masek, granic i Schur complementu;
- capability matrix ma osobne bounded rows dla charge MR, steady drift,
  direct SHE i inverse SHE. Status to `reference_executable` wyłącznie dla
  FEM CPU i tego zakresu; FEM GPU pozostaje `semantic_only`.

### 32.55.3. RED/GREEN i managed evidence

Weryfikacja wykonywana była w kontenerze `fem-gpu` po przebudowie native
`fullmag_fem`. Najpierw pełna brama ujawniła regresję M1: walidator porównywał
operator bloku transportowego z odrębnym operatorem równania ładunku.
Poprawka rozdzieliła oczekiwane wersje `charge_operator` i `spin_operator`;
publiczny test FEM M1 ponownie przeszedł.

Obowiązujący GREEN:

```text
just verify-fem-steady-transport-native-contract                 exit 0
fem steady transport contract: PASS
fem steady transport ABI contract: PASS
direct_she_common_si_limit_matches_fdm_and_fem_reference_profiles ... ok
```

oraz focused managed M2:

```text
tests::steady_transport_m2_request_keeps_v1_as_a_nested_prefix ... ok
resolves_bounded_fem_m2_to_reciprocal_descriptor_without_fallback ... ok
canonical_m2_descriptor_materializes_reciprocal_ffi_request ... ok
native_m2_solver_publishes_reciprocal_diagnostics ... ok
```

Dowód potwierdza wykonanie bounded M2 i identyfikację `constitutive_model=
reciprocal_m2`; nie jest jeszcze dowodem `validated_workloads`. Nadal otwarte
są: niezależna analityczna/numeryczna M2 mesh convergence, sweep Onsagera i
dissipation, heterogeniczne materiały, N/F/T, mixing/SML, GPU, FDM↔FEM
reciprocal common-limit, BORIS parity, dynamiczny Oersted/skin/MQS, transient
M3 i sprzężenie z LLG.

### 32.55.4. Status planu i Standard Problem 5

Standard Problem 5 z
`external_solvers/3/test/standardproblem5.mx3` ma już wcześniejszy, wykonany
artefakt Fullmag CPU:
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu`.
Zawiera on relaksację i 10 000 kroków dynamicznych, lecz `qualification.json`
pozostaje `not_evaluated`: maksymalna różnica względem źródłowego wyniku
MuMax3 przekroczyła `1e-4`. W tej sesji uruchomiłem także świeży fixture
MuMax3 na RTX 4080 SUPER; hostowy proces po około pięciu minutach pozostawał
w synchronizacji CUDA bez logu i został przerwany. To jest blokada środowiskowa
replayu, nie wynik fizyczny. Aktualna brama M2 nie udaje zaliczenia SP5:
trzeba zachować rozdzielność kwalifikacji transportu i demagnetyzacji oraz
wykonać identyczny fixture MuMax3/Fullmag z kontrolowanym refinementem.
Capability/SP5 pozostaje otwarte; istniejący artefakt diagnostyczny nie jest
awansowany do `validated_workloads`.

Szeroka ocena celu pozostaje konserwatywnie **86% implementacji / 60%
gotowości produkcyjnej**. Bounded M2 zwiększa zakres wykonywalnego kodu i
provenance, ale nie zmienia progu produkcyjnego: potrzebne są niezależne
common-limit/convergence, runtime/device evidence, pełna ścieżka Python/UI i
kwalifikacja fizyczna demagażu oraz SP5.

## 32.56. Niebłahy oracle konstytutywny bounded M2 FEM CPU (2026-08-04)

### 32.56.1. Luka w dotychczasowym teście

Dotychczasowy test ABI M2 wykonywał jedynie stałe wartości Dirichleta na
pojedynczym tetraedrze. Jego pola miały zerowe gradienty, więc nie wykrywał
błędu znaku, czynnika `1/2` w `G_{ia}=-\partial_i\mu_{s,a}/2` ani złej kolejności
komponentów w projekcji tensorowej.

### 32.56.2. Fixture i oracle

Dodano `cpu_double_reciprocal_m2_affine_constitutive_oracle` w
`backends/fem/tests/steady_transport_abi_contract.cpp`. Fixture to sześć
pozytywnie zorientowanych tetraedrów dzielących sześcian jednostkowy; twarze
`x=0`/`x=1` mają osobne atrybuty Dirichleta, pozostałe są naturalne. Dla
`m=e_x`, `theta_SH=sigma_AHE=0`, wyłączonych reakcji spinowych i
`V=x`, `mu_s=(0.2,0.3,0.4)x` rozwiązanie afiniczne jest dokładne. Test sprawdza
wszystkie węzły, prąd ładunkowy, tensor `Q_{ia}` w układzie node-major,
zbieżność obu bloków oraz wartości konstytutywne do `1e-8`. Następnie wykonuje
dwa dodatkowe stany afiniczne: charge-only (`E_x=-1`, `G_{xx}=0`) i spin-only
(`E_x=0`, `G_{xx}=-1/2`), sprawdzając równość wzajemnych odpowiedzi
`Q_{xx}(E_x)/E_x=J_x(G_{xx})/G_{xx}` oraz dodatnią moc diagonalną.

### 32.56.3. Managed GREEN

Nowa recepta:

```text
just verify-fem-steady-transport-m2-affine-contract
```

wykonuje konfigurację i budowę `fem_steady_transport_abi_contract` w
zarządzanym obrazie `fem-gpu`; wynik bieżącego uruchomienia:

```text
[100%] Built target fem_steady_transport_abi_contract
fem steady transport ABI contract: PASS
```

Jest to niezależny dowód wykonania niezerowego gradientu, dwóch odpowiedzi
wzajemnych i dodatniej mocy dla bounded M2 FEM CPU. Nie zamyka jeszcze
parametrycznego/meshowego Onsager-dissipation sweep, FDM↔FEM reciprocal
common-limit, GPU, interfejsów, BORIS parity ani `validated_workloads`; szeroka
ocena pozostaje **86% implementacji / 60% gotowości produkcyjnej**.

## 32.57. Trzy siatki dla bounded reciprocal M2 FEM CPU (2026-08-04)

### 32.57.1. Zakres testu

Do `backends/fem/tests/steady_transport_contract.cpp` dodano
`reciprocal_m2_converges_on_three_mesh_resolutions`. Test rozwiązuje ten sam
jednorodny problem M2 na conforming tetra meshes `N_x=8,16,32`, z
`sigma_s=5`, `sigma_parallel=6`, `sigma_perpendicular=3`, `P=0.25` i finite
`lambda_sf=0.3 m`; charge i spin mają elektrody tylko na `x=0`/`x=1`, a
pozostałe ściany są naturalne. Finite spin-flip wymusza nieafiniczny profil i
eliminuje fałszywy pass wynikający z samego dokładnego odwzorowania P1.

### 32.57.2. Managed GREEN i wartości

Brama:

```text
just verify-fem-steady-transport-m2-convergence-contract
```

przeszła w zarządzanym obrazie `fem-gpu`:

```text
reciprocal M2 mesh midpoint: nx=8 V=0.527052 mu_x=0.175368,
nx=16 V=0.526914 mu_x=0.177036, nx=32 V=0.526879 mu_x=0.177449;
errors coarse/medium=0.000172849/3.42662e-05 V, 0.00208109/0.000412567 V
fem steady transport contract: PASS
```

Oba obserwowane błędy midpoint maleją przy rafinacji. Jest to ograniczona
brama przestrzennej zbieżności FEM CPU z profilem jednorodnym poprzecznie; nie
zamyka pełnego 3-D `h`/`p` sweep, heterogenicznych materiałów, interfejsów,
generalnego FDM↔FEM reciprocal common-limit, GPU, ani `validated_workloads`;
ograniczony uniform common-limit jest opisany w sekcji 32.58. Szeroka ocena
pozostaje **86% implementacji / 60% gotowości produkcyjnej**.

## 32.58. Wspólny limit reciprocal M2 FDM↔FEM (2026-08-04)

### 32.58.1. Cel i fixture

Dodano do runnera test
`reciprocal_m2_common_si_limit_matches_fdm_and_fem_reference_profiles` oraz
osobną receptę `just verify-fem-steady-transport-m2-common-limit-contract`.
Test uruchamia ten sam problem SI w FDM CPU i FEM CPU: jednorodny prostopadłościan
o długości `1 m`, przekrój `1 m x 0.1 m`, `m=e_z`,
`sigma=4 S/m`, `sigma_s=5 S/m`, `sigma_parallel=6 S/m`,
`sigma_perpendicular=3 S/m`, `P=0.25`, `theta_SH=sigma_AHE=0`,
`lambda_sf=0.3 m`, bez exchange/dephasing. Potencjał ładunkowy ma elektrody
`V(z=0)=1 V`, `V(z=1)=0 V`; `mu_{s,z}` ma zgodne warunki
`0.2 V` i `0 V`; pozostałe składowe są izolowane/zerowe. FDM używa komórek
`[1,1,N_z]`, a FEM conforming tetrahedral mesh ma te same płaszczyzny `z`.
Porównanie jest wykonywane między wartościami FDM w środku komórek i średnią
FEM po czterech węzłach płaszczyzny, następnie między dwiema sąsiednimi
płaszczyznami.

### 32.58.2. Managed GREEN i pomiary

W zarządzanym obrazie `fem-gpu` przeszła brama:

```text
just verify-fem-steady-transport-m2-common-limit-contract
```

Wynik:

```text
M2 reciprocal common SI Nz=8: potential=5.602702602479637e-4, spin=6.7222990578735264e-3
M2 reciprocal common SI Nz=16: potential=1.6232446439556902e-4, spin=1.9477183162976974e-3
M2 reciprocal common SI Nz=32: potential=4.359865754688386e-5, spin=5.231586951655598e-4
test ...reciprocal_m2_common_si_limit_matches_fdm_and_fem_reference_profiles ... ok
```

Oba backendy przechodzą niezależne residual/balance gates, a błąd cross-backend
maleje przy `N_z=8 -> 16 -> 32`. Jest to pierwszy wykonywalny common-limit dla
reciprocal M2, ale tylko dla jednorodnego CPU-double, bez Hall, bez interfejsów
i bez zmiennej przestrzennie magnetyzacji. Nie zamyka heterogenicznego/3-D
sweep, interfejsów N/F/T, niezerowego SHE/AHE, GPU parity, pełnej ścieżki
Python/UI ani `validated_workloads`. Ocena szeroka pozostaje
**86% implementacji / 60% gotowości produkcyjnej**.

## 32.59. Managed FDM M2 heterogeniczny interfejs N/F (2026-08-04)

### 32.59.1. Zakres dowodu

Dodano receptę `just verify-fdm-m2-heterogeneous-interface-contract`, która
uruchamia dwa istniejące testy silnika FDM CPU-double w zarządzanym kontenerze:
`m2_anisotropic_nf_interface_meets_the_declared_physical_balance_tolerance`
oraz `m2_mixing_interface_closes_nonzero_absorption_and_sml_with_torque_target`.
Pierwszy test ma dwa regiony N/F z jawnym `region_id`, anizotropią,
spin-Hall i orientowanym prawem `G_up/G_down/G_mix`; drugi wymusza niezerowy
backflow, absorpcję poprzeczną, SML i torque celu ferromagnetycznego. Oba testy
sprawdzają niezależne zamknięcie bilansu ładunku i spinu, a drugi dodatkowo
rozdziela obserwacje interface flux od torque.

### 32.59.2. Managed GREEN

Uruchomienie recepty po poprawieniu filtra testowego (pierwszy przebieg z
`--exact` miał `0 tests` i nie został uznany za dowód) wykonało faktycznie po
jednym teście w każdej komendzie:

```text
test ...::m2_anisotropic_nf_interface_meets_the_declared_physical_balance_tolerance ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 301 filtered out
test ...::m2_mixing_interface_closes_nonzero_absorption_and_sml_with_torque_target ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 301 filtered out
```

Ten wynik dowodzi wykonywalnego, zbilansowanego FDM N/F interfejsu z mixing/SML
w referencyjnym CPU-double. Nie dowodzi jeszcze FEM broken-H1/mortar, wspólnego
FDM↔FEM interfejsu, niezerowego Hall w geometrii 3-D, GPU parity ani
`validated_workloads`; bounded FEM M2 nadal fail-closed odrzuca interfejsy
wewnętrzne. Szeroka ocena celu pozostaje **86% implementacji / 60% gotowości
produkcyjnej**.

## 32.60. Bounded 3-D reciprocal M2 SHE/iSHE/AHE FDM↔FEM (2026-08-04)

### 32.60.1. Zakres i korekta metryki

Dodano test runnera
`reciprocal_m2_3d_she_ishe_common_limit_matches_fdm_and_fem_profiles` oraz
receptę `just verify-fem-steady-transport-m2-3d-common-limit-contract`. Fixture
ma `m=(1,0,0)`, `theta_SH=0.1`, `sigma_AHE=0.2 S/m`,
`sigma=4 S/m`, `sigma_s=5 S/m`, `sigma_parallel=6 S/m`,
`sigma_perpendicular=3 S/m`, `P=0.25`, `lambda_sf=0.3 m`, elektrody ładunkowe
i spinowe na `z_min/z_max` oraz izolację na wszystkich ścianach poprzecznych.
W ten sposób w jednym problemie występują niezerowe direct SHE, reciprocal
iSHE, AHE i poprzeczna zmiana `mu_s`.

Początkowy test uśredniał dziewięć węzłów FEM równymi wagami. To nie jest
całka powierzchniowa dla siatki P1 i powodowało niemonotoniczny błąd metryki,
nie błąd solvera. Zastąpiono je złożonymi wagami trapezowymi `1-2-1` w obu
kierunkach, a następnie rozszerzono sweep tak, aby zagęszczać jednocześnie
przekrój i długość: `(n_x,n_y,n_z)=(2,2,4),(4,4,8),(8,8,16)`.

### 32.60.2. Managed GREEN

Uruchomienie w zarządzanym obrazie `fem-gpu` po przebudowie `fullmag_fem`
zakończyło się `exit 0`; Cargo używał trwałego celu
`/tmp/fullmag-zfn2-build/cargo-targets/fem-m2-3d` (backed by `/zfn2`):

```text
M2 reciprocal 3-D SHE/iSHE nxy=2, Nz=4: potential=1.1440446880428556e-4, spin=1.9328657009760858e-2
M2 reciprocal 3-D SHE/iSHE nxy=4, Nz=8: potential=1.5938720605285228e-4, spin=6.517590917801991e-3
M2 reciprocal 3-D SHE/iSHE nxy=8, Nz=16: potential=5.6548283983631764e-5, spin=1.884314775342455e-3
test ...reciprocal_m2_3d_she_ishe_common_limit_matches_fdm_and_fem_profiles ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 958 filtered out
```

Gate wymaga niezależnych residual/balance FDM i FEM poniżej `1e-9`,
niezerowego poprzecznego potencjału spinowego na każdej siatce, monotonicznego
spadku błędu profilu spinowego oraz niższego błędu potencjału na siatce fine
niż na obu wcześniejszych siatkach. Fine cross-backend envelope wynosi
`5.65483e-5 V` dla potencjału i `1.88431e-3 V` dla maksymalnej składowej
spinowej. Charge error nie jest wymagany jako monotoniczny na każdym
pośrednim poziomie, ponieważ FVM cell-centre i P1 FEM mają różne masy
poprzeczne; warunek końcowy wykrywa pogorszenie fine-grid.

### 32.60.3. Granica dowodu

Jest to pierwszy wykonywalny, niezerowy 3-D reciprocal SHE/iSHE/AHE
common-limit dla CPU-double obu backendów. Nie dowodzi jeszcze wspólnego
FDM↔FEM interfejsu N/F/T, broken-H1/mortar FEM, heterogenicznych materiałów,
FDM/FEM GPU parity, BORIS parity, dynamicznego Oersteda/skin/MQS, pełnej
ścieżki Python/UI ani `validated_workloads`. Capability matrix pozostaje bez
awansu, a szeroka ocena celu pozostaje **86% implementacji / 60% gotowości
produkcyjnej**.

## 32.61. Ponowna managed brama dynamicznego Oersteda FDM CUDA (2026-08-04)

### 32.61.1. Zakres i wykonanie

Ponownie uruchomiono receptę `just verify-fdm-oersted-native-contract` na
bieżącym `master` (`650c76c01`). Receptura używa zarządzanego obrazu
`fem-gpu`, kompiluje natywny backend FDM z CUDA i uruchamia wyłącznie kontrakt
`oersted_cuda_runtime`; nie jest to hostowy build ani dowód pełnej symulacji
magnetycznej.

### 32.61.2. Wynik

Przebudowa i uruchomienie zakończyły się `exit 0`:

```text
PASS: CUDA Oersted stage-time, rollback, adaptive, FSAL, ABM3, and axis oracle contract
```

Ten przebieg ponownie potwierdza poprawne przekazywanie czasu etapowego,
transakcyjny rollback, adaptację kroku, FSAL, ABM3 i niezależny oracle osi dla
natychmiastowego pola Oersteda. Nie awansuje jednak capability: dynamiczny
current-solve, wspólny `J_c` z transportem SHE, FEM OE-T0/KKT, skin/MQS,
airbox, GPU residency end-to-end oraz produkcyjny racetrack pozostają poza
zakresem tej receptury. Zapisany wcześniej stan `semantic_only`/`reference`
pozostaje bez zmian, a szeroka ocena celu nadal wynosi **86% implementacji /
60% gotowości produkcyjnej**.

### 32.61.3. Ograniczenie magazynu buildów

Próba przeniesienia receptur kontenerowych bezpośrednio na
`/mnt/fullmag-zfn2-native` została wycofana: bieżący Docker daemon nie
propaguje lokalnego obrazu ext4 pod `/zfn2` i widzi w tym miejscu pełny
`/dev/sdg` checkoutu. Nie wolno traktować takiego bind-mountu jako trwałego
magazynu. Zasada pozostaje: przed ciężkim buildem trzeba potwierdzić w samym
kontenerze urządzenie i wolne miejsce widoku `/mnt/fullmag-zfn2-native`; do
czasu poprawnej konfiguracji demona nie zmienia się istniejących receptur w
sposób, który mógłby ukryć zapis na pełnym dysku roboczym.

## 32.62. Naprawa dekodowania i fail-closed FDM region-membership w Control Room (2026-08-04)

### 32.62.1. Root cause i zakres

Audyt `docs/audits/2026-08-04-fdm-ui-audit.md` wykazał rozjazd między aktualnym
artefaktem runnera a frontendowym dekoderem. Runner publikuje `FMRM` v2 z
`version=2`, `kind=2`; `u32::MAX` oznacza komórkę nieaktywną, a `0` aktywną
komórkę bez przypisanego regionu. Dekoder Control Room akceptował wyłącznie
`version=1/kind=1`, a model viewportu filtrował `regionId > 0`. W rezultacie
poprawny v2 payload był odrzucany, a błąd przechodził do próbkowania całego
authored gridu, wizualnie włączając komórki poza domeną.

### 32.62.2. Implementacja

Frontendowy codec
`apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts` teraz:

- traktuje v2/kind=2 jako kontrakt pierwszorzędny;
- zachowuje ograniczoną kompatybilność v1/kind=1, normalizując historyczne
  zero-inactive do wspólnego sentinela `FMRM_INACTIVE_REGION_ID`;
- zwraca wersję i rodzaj payloadu oraz nie zmienia v2 `0` active/unassigned;
- posiada fixture testowy z dokładnym aktualnym nagłówkiem backendu.

`fdmCuboidBuildModel.ts` interpretuje wyłącznie `u32::MAX` jako inactive, więc
region `0` pozostaje widoczną aktywną komórką. `useViewport3DSceneModel.ts`
rozróżnia brak artefaktu (`204`, jawny pre-run authored fallback) od błędu,
braku binarnego payloadu lub niezgodnego shape/count (fail-closed: model nie
jest renderowany). Błąd nie jest już maskowany pełnym pudełkiem FDM.

Zmiana jest frontend-only; nie zmienia tras, OpenAPI v2, generated types,
realtime ani właściciela zasobu. HTTP v2 descriptor/binary pozostaje źródłem
stanu, a codec/resource hook jest jedyną ścieżką do unified viewport.

### 32.62.3. Dowód i granica kwalifikacji

Focused Control Room tests zakończyły się:

```text
5 test files passed; 143 tests passed
```

Obejmują codec v1/v2, sentinele active-unassigned/inactive, fail-closed model,
resource path i FDM layer. `pnpm --dir apps/control-room typecheck` oraz
targeted ESLint dla zmienionych plików zakończyły się `exit 0`.
Globalny `check:api-hygiene` nadal zatrzymuje się na istniejącym false-positive
`legacy live/bootstrap/poll/preview path` dla słowa `poll` w komentarzu
`src/kernel/diagnostics/solverTrace.ts`; nie jest to błąd tej zmiany.

Nie wykonano jeszcze browser/WebGL smoke z rzeczywistym artefaktem FDM, pełnej
kwalifikacji target/field/render path ani FDM universe/air/void semantics.
Dlatego capability i `validated_workloads` pozostają bez awansu, a szeroka
ocena celu pozostaje konserwatywnie **86% implementacji / 60% gotowości
produkcyjnej**.

## 32.63. Managed FEM STT evidence po pytaniu o brak porównania SP5 (2026-08-04)

### 32.63.1. Co zostało faktycznie porównane

Dotychczasowy replay `external_solvers/3/test/standardproblem5.mx3` był
wykonany wyłącznie dla FDM: jednorodny grid MuMax3 `32x32x4`, vortex,
relaksacja, a następnie stałoprądowy Zhang--Li przez `1 ns`. Dla FEM nie
istniał jeszcze odpowiednik tej geometrii i tej sekwencji etapów. Nie wolno
więc opisywać wcześniejszego wyniku SP5 jako porównania FDM--FEM.

### 32.63.2. Wykonana brama FEM

Uruchomiono na bieżącym drzewie receptę zarządzaną:

```text
just verify-fem-stt-native-contract
```

Przebieg zbudował w obrazie `fem-gpu` natywny `fullmag_fem` z MFEM/CUDA,
`fem_stt_contract` i `fem_cuda_slonczewski_contract`. Wszystkie filtrowane
testy zakończyły się `exit 0`:

```text
FEM CUDA Slonczewski v2 numeric contract PASS
versioned_stt_extension_is_append_only_after_legacy_plan_prefix ... ok
auto_fem_canonical_slonczewski_v2_remains_gpu_eligible ... ok
strict_fem_canonical_slonczewski_v2_reaches_native_runtime_validation ... ok
native_fem_slonczewski_step_matches_independent_si_reference_when_mfem_stack_is_available ... ok
native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available ... ok
native_fem_canonical_slonczewski_has_bounded_current_scaling_when_mfem_stack_is_available ... ok
native_fem_slonczewski_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available ... ok
```

Dowód obejmuje: niezależny SI oracle jednego kroku, osiem kolejnych kroków
Heuna CPU--CUDA w FP64, bounded current scaling `0x/0.5x/1x/2x` po projekcji
stycznej oraz jeden wspólny limit FEM--FDM dla lokalnego Slonczewskiego v2.
W przebiegu common-limit wyłączono wymianę i demag, a siatka była minimalna;
nie jest to vortex ani pole demagnetyzujące Standard Problem 5.

### 32.63.3. Granica dowodu i następny gate

Wynik awansuje dowód wykonawczy FEM STT z poziomu samego kontraktu do
bounded CPU--CUDA/common-limit evidence, ale nie awansuje `SP5` ani
`validated_workloads`. Brakuje nadal dedykowanego FEM SP5: tej samej objętości
`100 nm x 100 nm x 10 nm`, siatki przestrzennej z kontrolowanym
refinementem, inicjalizacji vortex, relaksacji z demagiem FEM, Zhang--Li przez
`1 ns`, zgodności obserwabli `avg(m)` i trajektorii z MuMax3 oraz raportu
zbieżności `h`/`dt`. Dopiero taki przebieg może być porównaniem FEM do
wcześniejszego FDM SP5; status po bramie opisanej w §32.65 jest **FDM SP5:
diagnostyczny, FEM SP5: bounded smoke probe, bez kwalifikacji**.

## 32.64. DomainPresentation i odcięcie FDM field-demand od FEM topology (2026-08-04)

### 32.64.1. Granica domeny UI

Dodano revision-aware adapter
`apps/control-room/src/shared/domain/mesh/domainPresentation.ts` oraz jego
reeksport w `viewport3dDomainAdapter.ts`. Jest to dyskryminowana granica
`fdm | fem`, a nie drugi workspace. Dla FDM adapter niesie `shape`, `origin`,
`spacing`, `cell_count`, fingerprint, rewizje maski, jawny stan
`authoring-grid/realized/loading/stale/incompatible/error` oraz rozróżnienie
`active-unassigned`, regionu i sentinela `u32::MAX`. FDM „airbox” pozostaje
rolą `universe-outside-magnetic-support`, nie FEM-ową topologią elementową.
Dla FEM adapter zachowuje shared-domain manifest, topology fingerprint i
airbox parts. Rewizje są zakotwiczone w generacji domeny oraz w aktualnym
FDM membership/FEM manifest resource.

### 32.64.2. FDM membership i field path

Legacy FMRM v1 pozostaje dekodowalny wyłącznie diagnostycznie jako
`legacy-ambiguous`; ponieważ v1 nie przenosi active mask, nie może zasilać
realized render mask. Tylko canonical v2 (`version=2`, `kind=2`) przechodzi do
renderingu. To zamyka możliwość cichego pomylenia inactive `0` z active
unassigned `0`.

Usunięto też gate, który wymagał `fieldCompatibleTopologyRenderModel` dla
każdego FDM pola. FDM ma teraz własną ścieżkę żądania primary field oraz
target-quantity request `fdm-domain`, nawet gdy FEM manifest/topology nie
istnieje. FEM stale-topology safety pozostaje bez zmian; dla domeny FEM
`fdmSettings` nie jest wysyłany do planera żądań.

### 32.64.3. Dowód i granica kwalifikacji

Focused verification:

```text
7 test files passed; 173 tests passed
pnpm --dir apps/control-room typecheck: exit 0
targeted ESLint: exit 0
```

Testy obejmują adapter FDM/FEM, rewizje resource, v1/v2 codec, sentinele,
fail-closed model, target-quantity FDM bez FEM topology, field-demand hook i
FDM layer. Nie wykonano jeszcze browser/WebGL smoke na rzeczywistym payloadzie,
pełnego Explorer/Inspector round-trip, aktualizacji capability matrix ani
kwalifikacji `validated_workloads`. Ocena pozostaje **86% implementacji /
60% gotowości produkcyjnej**.

## 32.65. Pierwszy wykonywalny FEM SP5 probe po korekcie planowania CPU (2026-08-04)

### 32.65.1. Zakres i reprodukowalność

Po wcześniejszej próbie wykryto błąd w dispatchu: jawne `device=cpu` było
traktowane jako wymuszenie GPU i blokowało CPU-only canonical
`zhang_li.fullmag.v1`. Korekta `394c046d8` ogranicza wymuszenie GPU do wartości
`gpu`/`all_in_gpu` i ma regresję jednostkową dla CPU STT. Managed runtime FEM
został ponownie zbudowany przez `just ensure-managed-fem-runtime`; manifest
schema 3 wskazuje commit `394c046d8`, ale także `worktree_state=dirty`, więc
ten przebieg jest dowodem diagnostycznym, nie reprodukowalnym release'em.

Fixture `examples/mumax_standard_problem_5_fem.py` zachowuje fizyczne
parametry źródła `external_solvers/3/test/standardproblem5.mx3`: body
`100 nm x 100 nm x 10 nm`, `M_s=800 kA/m`, `A_ex=13 pJ/m`, `alpha=0.1`, vortex
o cyrkulacji i polaryzacji `+1`, `J_c=(10^12,0,0) A/m^2`, `xi=0.05`. FEM używa
własnego, jawnie oznaczonego `zhang_li.fullmag.v1`/`zl_central_reference_v1`;
operator `zhang_li.mumax3.v1` nie jest po cichu podstawiany.

Probe wykonano na shared-domain mesh z airboxem: `160 x 160 x 70 nm`,
`1968` tetraedrów, `383` węzły, `699` elementów aktywnej płytki, FE order 1,
`hmax=12 nm`, `hmin=6 nm`, airbox `hmax=40 nm`. Demagnetyzacja była liczona
przez FEM Poisson--Robin, CG+AMG, `rtol=1e-10`, limit `500` iteracji, CPU
double. Etap relaksacji zachowano jako osobny etap, lecz celowo ograniczono
do `1` kroku; etap STT wykonano do `1 ps` (`15` zaakceptowanych kroków,
adaptive RK45). To jest bounded smoke probe, nie pełny odpowiednik `relax();
run(1 ns)`.

### 32.65.2. Wynik wykonawczy

Oba etapy zakończyły się `status=completed`, bez fallbacku. Artifact
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fem-probe-20260804-cpu-fixed-v2`
zawiera m.in. `physics/spin_torque_provenance.v1.json`, w którym zapisano
`resolved_execution_engine=fem_cpu_native`, aktywną maskę `699` elementów /
`256` węzłów, `formula_version=zhang_li.fullmag.v1` oraz
`operator_version=zl_central_reference_v1`. Końcowy solver/Poisson stanowi:

| obserwabla | FEM probe, `t=1 ps` |
|---|---:|
| `avg(m_x)` | `1.076279519078731e-4` |
| `avg(m_y)` | `-1.162322864486359e-3` |
| `avg(m_z)` | `1.134078912052475e-3` |
| `E_ex` | `2.849608399734903e-18 J` |
| `E_demag` | `7.229261107288929e-19 J` |
| `max torque` | `2.185113915310145e-1 T` |

`avg(m)` jest redukcją objętościową FEM z tego samego końcowego snapshotu,
nie średnią arytmetyczną po węzłach. Residual Poissona wyniósł
`6.35e-11`, a solver wykonał jedną iterację dla tego małego testu.

### 32.65.3. Porównanie FDM--FEM i granica twierdzenia

To potwierdza, że ścieżka Python → ProblemIR → planner → managed FEM CPU →
demag → canonical Zhang--Li → artefakt działa dla geometrii SP5. Nie jest
to jeszcze ilościowe porównanie z wcześniejszym FDM SP5: FDM ma wynik `t=1 ns`,
natomiast FEM probe ma `t=1 ps`, a oba backendy używają różnych operatorów
Zhang--Li (`zhang_li.mumax3.v1` kontra `zhang_li.fullmag.v1`) oraz różnych
reprezentacji przestrzennych. Nie wolno z tych liczb wyprowadzać błędu
solvera ani awansować `validated_workloads`.

Brakuje nadal: (1) wspólnego stanu po rzeczywistej relaksacji FEM i FDM,
(2) pełnej trajektorii do `1 ns`, (3) co najmniej trzech poziomów `h` dla FEM
i kontrolowanego `dt`, (4) porównania pól i `avg(m)` w tych samych czasach,
(5) niezależnego audytu znaku/skalowania obu operatorów oraz (6) kwalifikacji
FEM GPU. Do czasu wykonania tych bram status pozostaje **FEM SP5:
reference-executable/bounded diagnostic; FDM SP5: diagnostic-unqualified;
FDM↔FEM equivalence: not established**.

## 32.66. Pełny FEM SP5 i kontrolowany refinement po pytaniu o porównanie z FDM (2026-08-04)

### 32.66.1. Zakres, źródło i granica reprodukowalności

Po wykonaniu bramy z §32.65 FEM nie jest już reprezentowany wyłącznie przez
probe. Wykonano pełny etap `relax` oraz dynamiczny etap Zhang--Li dla
`examples/mumax_standard_problem_5_fem.py`, przy zachowaniu geometrii i
parametrów fizycznych `external_solvers/3/test/standardproblem5.mx3`:
`100 nm x 100 nm x 10 nm`, `M_s=800 kA/m`, `A_ex=13 pJ/m`, `alpha=0.1`, vortex
`(circulation=+1, core_polarity=+1)`, `J_c=(10^12,0,0) A/m^2`, `xi=0.05`.
FEM używa jawnie `zhang_li.fullmag.v1` / `zl_central_reference_v1`; FDM
pozostaje przy `zhang_li.mumax3.v1` / `zl_mumax3_central_v1`. Nie ma ukrytego
fallbacku z FEM na FDM ani odwrotnie.

Uruchomienie korzystało z zarządzanego runtime FEM z manifestem schema 3,
zbudowanym z commit `394c046d8`, lecz z `worktree_state=dirty`. Wszystkie
wyniki poniżej są więc dowodem wykonywalności i diagnostyki bieżącego drzewa,
nie artefaktem release-clean ani awansem `validated_workloads`.

### 32.66.2. Pełny przebieg FEM CPU, hmax=12 nm

Artefakt:
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fem-full-20260804-cpu-h12-bb-r12`.

| wielkość | wynik |
|---|---:|
| body `hmax / hmin` | `12 / 6 nm` |
| airbox `hmax` | `40 nm` |
| siatka | `1961` tetraedrów, `382` węzły |
| demag | Poisson--Robin, CG+AMG, `rtol=1e-12` |
| relaksacja | projected-gradient-BB, `39` iteracji |
| końcowy torque relaksacji | `9.030367599247804e-7 T` |
| dynamika | adaptive RK45, `1028` zaakceptowanych kroków |
| horyzont | `t=1 ns` |
| `avg(m)` | `(0.06571195970862106, -0.07068185866088325, -0.001918570717269359)` |
| `E_ex` | `2.457573497099033e-18 J` |
| `E_demag` | `5.962245456383275e-19 J` |
| `E_total` | `3.053798042737360e-18 J` |
| końcowy `max_torque_T` | `3.283768393400342e-2 T` |

Jest to pierwszy pełny FEM SP5 do tego samego czasu fizycznego co FDM. Nie
oznacza jeszcze zgodności, ponieważ stan po relaksacji i dyskretyzacje nie są
wspólne.

### 32.66.3. Refinement FEM i blocker relaksacji

Pierwszy refinement wykonano w
`/zfn2/mateuszz/git/fullmag/runs/sp5-fem-h8-pgbb-20260804` (`hmax=8 nm`,
`hmin=3 nm`, airbox `hmax=30 nm`): `10595` tetraedrów, `1822` węzły, `78`
iteracji PG-BB do `4.904881453193072e-7 T`. Przy diagnostycznym horyzoncie
`1 ps` końcowy `avg(m)` wyniósł
`(0.04073733843953036, -0.009595994833123806, 0.01187191608956891)`.

Poziom nominalny `hmax=6 nm`, `hmin=2.5 nm`, airbox `hmax=25 nm` nie domknął
bramy stopu. PG-BB oscylował w okolicy `1.3e-1 T` po `169` iteracjach w
`/zfn2/mateuszz/git/fullmag/runs/sp5-fem-h6-pgbb-20260804` i został przerwany.
Alternatywny nonlinear-CG w
`/zfn2/mateuszz/git/fullmag/runs/sp5-fem-h6-ncg-20260804` był stabilniejszy,
ale po budżecie `300` iteracji kończył z `1.194160313517469e-5 T`, a więc
również nie osiągnął wymaganego `1e-6 T`. Ten wynik jest bounded
non-convergence, nie negatywną oceną fizyki FEM.

Wniosek numeryczny: h12 i h8 są wykonywalne, lecz nie stanowią jeszcze
trzypoziomowej zbieżności. Do kwalifikacji trzeba rozdzielić wpływ siatki,
airboxu, tolerancji Poissona i algorytmu minimizacji oraz powtórzyć dynamikę
na wspólnej osi czasu po uzyskaniu stanu spełniającego ten sam torque gate.

### 32.66.4. Jawne porównanie z FDM przy t=1 ns

FDM CPU artefakt referencyjny:
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu`.
Skrypt `scripts/compare_sp5_scalar_runs.py` porównał ostatnie wiersze
`scalars.csv` przy identycznym `t=1 ns`. FDM kończył z
`(-0.2346557117920822, -0.09450957174904828, 0.02294296086440476)`, a FEM z
`(0.06571195970862106, -0.07068185866088325, -0.001918570717269359)`. Różnica
FEM minus FDM to
`(0.30036767150070326, 0.02382771308816503, -0.02486153158167412)`,
`||Delta avg(m)||_2 = 0.30233523404716306`. Pełny JSON jest zapisany jako
`/zfn2/mateuszz/git/fullmag/runs/sp5-fem-fdm-scalar-comparison-1ns-h12.json`.

Status tego porównania jest **diagnostic / equivalence_established=false**.
Zgodny czas końcowy usuwa wcześniejszy błąd porównania `1 ps` z `1 ns`, ale nie
usuwa różnic: FEM ma P1 i Poisson--Robin, FDM ma siatkę kartezjańską i swój
otwartobrzegowy operator demaga, a operatory Zhang--Li są jawnie różnymi
wersjami. Sam skalar `avg(m)` nie zastępuje porównania pola, wspólnego stanu
relaksacji i testu zbieżności `h/dt`.

### 32.66.5. Bramy po tym przebiegu

- FEM SP5 ma obecnie status **reference-executable / bounded diagnostic**:
  pełny CPU do `1 ns` działa, lecz h6 nie spełnia stopu, a runtime jest dirty.
- FDM SP5 pozostaje **diagnostic-unqualified** względem zewnętrznego golden
  tolerance; jego CPU i CUDA fixed-step mają wewnętrzną parytetową bramę, ale
  maksymalna różnica względem świeżego MuMax3 przekracza `1e-4`.
- FEM GPU, wspólny matched-field comparison, trzy poziomy h, kontrola dt,
  niezależny audyt znaku/skali operatorów i release-clean rerun pozostają
  otwarte.
- Ocena szerokiego celu pozostaje konserwatywnie **86% implementacji / 60%
  gotowości produkcyjnej**. Wykonanie FEM podniosło kompletność dowodu
  wykonawczego, ale nie jest podstawą do awansu produkcyjnego ani do twierdzenia
  o równoważności z FDM.

## 32.67. Porównanie pola FEM–FDM dla SP5 (2026-08-04)

### 32.67.1. Operator i zakres

Żeby odpowiedzieć na pytanie, czy rozbieżność FEM–FDM występuje tylko w
redukcji `avg(m)`, wykonano dodatkową kontrolę pola dla pełnych snapshotów z
§32.66. FEM zapisuje wartości węzłowe P1 na siatce tet4, a FDM zapisuje
wartości komórkowe na siatce `32 x 32 x 4`. Skrypt
`scripts/compare_sp5_field_states.py` odtwarza mesh FEM z
`metadata.json`, a następnie próbuje każdy środek komórki FDM w wybranych
tetraedrach. Wartość jest liczona z barycentrycznych funkcji kształtu P1;
centra poza domeną magnetyczną są maskowane, a centra leżące na wspólnej ścianie
są uśredniane. Operator ma identyfikator
`tet4_cartesian_center_barycentric_v1` i jawnie nie jest utożsamiany z
objętościowym ograniczeniem `prism6` używanym w kwalifikacji SP4.

### 32.67.2. Wynik przy wspólnym czasie

Porównano artefakty:

- FEM: `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fem-full-20260804-cpu-h12-bb-r12/m_final.json`, `t=1 ns`;
- FDM: `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu/m_final.json`, `t=1 ns`;
- raport: `/zfn2/mateuszz/git/fullmag/runs/sp5-fem-fdm-field-comparison-1ns-h12.json`.

Pokrycie próbkowania wyniosło `4096/4096` komórek (`valid_fraction=1.0`),
więc brak pokrycia nie zaniża metryk. Dla różnicy wektorowej FEM minus FDM
otrzymano:

| metryka | wynik |
|---|---:|
| RMS | `0.49796257925222454` |
| p99 | `1.679783779553503` |
| maksimum | `1.9122155987326996` |
| cosine similarity | `0.8741985937637287` |
| MAE komponentu `x/y/z` | `0.3003844047055704 / 0.1546600505115151 / 0.05170302467898508` |

Średnia z próbkowanego pola FEM wyniosła
`(0.06568520395227473, -0.07064260442076248, -0.0019159783748134006)`;
średnia FDM wyniosła `(-0.23465571179208225, -0.09450957174904828,
0.02294296086440476)`. Zatem wcześniejsza różnica skalarna nie jest artefaktem
samej redukcji — występuje także w polu przestrzennym.

### 32.67.3. Granica kwalifikacji

Wynik pozostaje **diagnostic / equivalence_established=false**. Obecny
operator jest próbkowaniem punktowym, nie zachowującym całki objętościowej;
FEM i FDM mają różne stany po relaksacji, operator Zhang–Li, operator demaga i
reprezentację przestrzenną. Do zamknięcia porównania potrzebne są: (a)
objętościowo zachowawcze ograniczenie tet4/prism6, (b) wspólny stan
równowagowy lub niezależna kontrola tego wpływu, (c) co najmniej trzy poziomy
`h` i kontrola `dt`, (d) audyt znaku i skali operatora oraz (e) rerun z
release-clean managed runtime. Samo pole FEM nie może awansować
`validated_workloads`.

## 32.68. Aktualny rerun FEM STT po synchronizacji `master` (2026-08-04)

### 32.68.1. Wykonana brama FEM

Powyższe porównanie SP5 nie było jedynym testem FEM. Po synchronizacji
`master` wykonano ponownie zarządzaną receptę:

```text
just verify-fem-stt-native-contract
```

Przebieg został wykonany w obrazie `fem-gpu`, z MFEM/CUDA/SLEPc i z trwałym
targetem Cargo pod `/zfn2/mateuszz/git/fullmag`. Źródło w chwili wykonania:

```text
HEAD=950855de075e469fd1e57f1a10451c9d1ad082c1
worktree_state=dirty
```

Brama zakończyła się `exit 0`. Zbudowany natywny FEM potwierdził:

```text
FEM CUDA Slonczewski v2 numeric contract PASS
versioned_stt_extension_is_append_only_after_legacy_plan_prefix ... ok
auto_fem_canonical_slonczewski_v2_remains_gpu_eligible ... ok
strict_fem_canonical_slonczewski_v2_reaches_native_runtime_validation ... ok
native_fem_slonczewski_step_matches_independent_si_reference_when_mfem_stack_is_available ... ok
native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available ... ok
native_fem_canonical_slonczewski_has_bounded_current_scaling_when_mfem_stack_is_available ... ok
native_fem_slonczewski_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available ... ok
```

Wynik obejmuje osobny SI oracle jednego kroku, wielokrokową parytetową
trajektorię CPU--CUDA w FP64, ograniczenie skali prądu, kwalifikację wyboru
urządzenia oraz wspólny limit z FDM. Ostatni test działał na minimalnej,
jednorodnej siatce i bez demagnetyzacji/wymiany; nie jest to test vortexu,
airboxu ani pełnego Standard Problem 5.

### 32.68.2. Co zostało porównane między FEM i FDM

Zakres FEM jest więc szerszy niż sam FDM:

| poziom | FEM | FDM | status |
|---|---|---|---|
| operator STT | natywny FEM CPU/CUDA, Slonczewski v2 | natywny FDM CPU/CUDA, Slonczewski v2 | wspólny limit i testy bounded PASS |
| transport SHE/iSHE | FEM M1 oraz bounded M2 CPU, testy ABI, zbieżności i wspólnego limitu | FDM M1/M2, testy wspólnego limitu | kontrakt/reference evidence; bez awansu `validated_workloads` |
| dynamika SP5 | pełny FEM CPU do `1 ns`, demag Poisson--Robin, P1/tet4 | FDM CPU do `1 ns`, operator kartezjański | pole porównane diagnostycznie; equivalence `false` |
| FEM GPU SP5 | brak pełnego przebiegu z kwalifikowanym artefaktem | FDM GPU ma wewnętrzne testy kontraktowe | otwarte |

W szczególności nie twierdzimy już, że analiza była „tylko FDM”: FEM ma
wykonane bramy operatora, transportu i pełny diagnostyczny SP5. Twierdzenie,
którego nadal nie wolno używać, brzmi natomiast „FEM i FDM są równoważne dla
SP5”. Aktualne pole FEM--FDM ma RMS `0.49796257925222454`, cosine
`0.8741985937637287` i `valid_fraction=1.0`; rozbieżność jest przestrzenna,
a nie wyłącznie skutkiem redukcji `avg(m)`.

### 32.68.3. Granica produkcyjna FEM

FEM osiągnął poziom **reference-executable / bounded diagnostic** dla STT i
transportu, ale nie poziom produkcyjnej kwalifikacji. Do zamknięcia celu
pozostają wspólne: objętościowo zachowawcze ograniczenie tet4/prism6,
identyczny stan po relaksacji, ten sam operator Zhang--Li lub udowodniony
adapter, co najmniej trzy poziomy `h`, kontrola `dt`, trzy rodziny Oersteda
FEM (OE-T0/OE-F1/OE-F2), kwalifikacja FEM GPU, pełna ścieżka
Python--ProblemIR--planner--UI oraz release-clean rerun. Do tego czasu
macierz capability i `validated_workloads` pozostają bez awansu, a ocena celu
pozostaje **86% implementacji / 60% gotowości produkcyjnej**.

## 32.69. Objętościowo zachowawcze ograniczenie tet4 w porównaniu FEM–FDM (2026-08-04)

### 32.69.1. Korekta operatora porównania

Dotychczasowy `scripts/compare_sp5_field_states.py` próbkował pole P1 w
środkach komórek FDM. Był to poprawny operator diagnostyczny, ale nie
zachowywał całki objętościowej. Zaimplementowano
`build_tet4_cartesian_restriction` w
`packages/fullmag-py/src/fullmag/analysis/fem_cartesian_restriction.py`.
Dla każdego przecięcia tet4 z prostopadłościanem FDM klipowanie wypukłego
wielościanu wyznacza objętość i pierwszy moment, a następnie całkuje affine P1
barycentric basis. `CartesianRestriction.apply` zwraca średnią po pokrytej
objętości, natomiast `conservation()` porównuje całkę FEM z całką po siatce
kartezjańskiej.

Kontrakt odrzuca nieproste lub niewspierane przypadki: elementy inne niż
straight-sided `tet4`, elementy zdegenerowane, nakładające się komórki oraz
siatkę FDM, która nie pokrywa całego wybranego wolumenu magnetycznego. Metoda
ma identyfikator `exact_tet4_p1_volume_restriction_v1`; jest postprocessingiem
i nie zmienia żadnego operatora demaga, Zhang--Li ani stanu solvera.

### 32.69.2. Test-first i wynik na SP5

Najpierw dodano test, który kończył się błędem importu brakującego symbolu
`build_tet4_cartesian_restriction`. Po implementacji:

```text
packages/fullmag-py/tests/test_magnetization_comparison.py
11 passed in 2.91s
```

Powtórzono porównanie na tych samych artefaktach FEM/FDM i czasie `t=1 ns`:

```text
PYTHONPATH=packages/fullmag-py/src python3 scripts/compare_sp5_field_states.py \
  --fdm-run /zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu \
  --fem-run /zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fem-full-20260804-cpu-h12-bb-r12 \
  --output /zfn2/mateuszz/git/fullmag/runs/sp5-fem-fdm-volume-field-comparison-1ns-h12.json
```

Pokrycie wyniosło `4096/4096`, `valid_fraction=1.0`,
`coverage_min=0.9999999999999808` i `coverage_max=1.0000000000000167`. Wynik
volume-restricted to:

| metryka | wynik |
|---|---:|
| vector RMS | `0.49731737652723923` |
| p99 | `1.6738097210831444` |
| maksimum | `1.8966968128889123` |
| cosine similarity | `0.874437658356207` |
| MAE komponentu `x/y/z` | `0.3004111604550328 / 0.15430837218750412 / 0.0516730453321669` |

Średnia FEM po ograniczeniu jest zgodna z objętościowym artefaktem FEM do
precyzji raportu. Rozbieżność FEM–FDM pozostaje więc rzeczywista i nadal ma
status **diagnostic / equivalence_established=false**; poprawa operatora
porównania nie może być interpretowana jako poprawa solvera.

### 32.69.3. Granica i następny gate

Zamknięto jeden z wymaganych warunków planu: mapowanie pola FEM tet4 na siatkę
FDM jest teraz objętościowo zachowawcze dla kwalifikowanej geometrii. Nie
zamknięto jeszcze wspólnego stanu równowagowego, trzech poziomów `h`, sweepu
`dt`, zgodności operatora Zhang--Li, porównania demagnetyzacji ani FEM GPU.
Funkcja jest celowo offline (SP5 przebieg na bieżącym mesh trwa około minuty)
i nie jest częścią hot pathu solvera. Capability matrix oraz
`validated_workloads` pozostają bez zmian; ocena celu pozostaje **86%
implementacji / 60% gotowości produkcyjnej**.

## 32.70. Naprawa kompilacji FEM CPU dla walidacji OE-F1/OE-F2 (2026-08-04)

### 32.70.1. Reprodukcja i przyczyna źródłowa

Świeży managed gate `just verify-fem-oersted-oef1-cpu-contract` zatrzymał się
przed uruchomieniem kontraktu, podczas budowy `fullmag_fem` z
`FULLMAG_ENABLE_CUDA=OFF`, `FULLMAG_USE_MFEM_STACK=ON` i MPI. Błąd był
deterministyczny:

```text
hypre_device_solver.cpp:360: error: GpuDemagPoissonWorkspace has no member stream_interop
hypre_device_solver.cpp:359: error: mfem_default_stream_wait_for_hypre_validation was not declared
```

`HypreStreamInterop`, pole `GpuDemagPoissonWorkspace::stream_interop` oraz
`mfem_default_stream_wait_for_hypre_validation` są deklarowane wyłącznie pod
`FULLMAG_HAS_CUDA_RUNTIME`. Ciało
`validate_demag_poisson_hypre_device_solve` miało jednak blok `#if
FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)` bez dodatkowej osłony CUDA.
W efekcie ścieżka CPU kompilowała referencję do GPU-only stanu, mimo że sama
operacja `A_par->Mult` i norma residualu są poprawne również w CPU Hypre/MFEM.

### 32.70.2. Test-first i korekta

Dodano regresję źródłową
`gpu_demag_hypre_validation_is_cuda_guarded_for_cpu_builds` w
`backends/fem/tests/source_facade_gpu_rk_contract.cpp`. Test RED potwierdził
brak oczekiwanej osłony. Minimalna korekta ogranicza wyłącznie wywołanie
`mfem_default_stream_wait_for_hypre_validation(...)` do
`#if FULLMAG_HAS_CUDA_RUNTIME`; CPU nadal liczy i certyfikuje residual przez
MFEM/Hypre, a GPU zachowuje synchronizację strumienia przed odczytem residualu.
Nie zmieniono równań, znaków, operatora Oersteda ani kryteriów zbieżności.

### 32.70.3. Managed GREEN

Po korekcie oba niezależne zarządzane przebiegi CPU zakończyły się `exit 0`:

```text
just verify-fem-oersted-oef1-cpu-contract
just verify-fem-oersted-oef2-cpu-contract
```

W obu przypadkach obraz `fullmag/fem-cpu:local` zbudował `fullmag_fem` w
trybie CUDA-off, a testy current-view MPI (`n1`, `n2`, byte identity) przeszły.
OE-F1 uruchomił `fem_oersted_direct_tetra_contract: PASS`, a OE-F2 dodatkowo
`fem_oersted_vector_potential_contract: PASS`. To jest dowód kompilacji i
kontraktu CPU, nie dowód skalowalnego operatora GPU ani zbieżności fizycznej
pełnego airboxu.

### 32.70.4. Granica kwalifikacji FEM

Naprawa usuwa blocker kompilacyjny dla OE-F1/OE-F2 i wzmacnia twierdzenie, że
FEM CPU ma wykonywalne kontrakty bez ukrytej zależności od CUDA. Nie promuje
żadnej capability do `validated`: OE-T0 nadal wymaga pełnej kwalifikacji
RT0/KKT, OE-F1/OE-F2 wymagają zbieżności mesh/airbox i testów runtime, a FEM
GPU wymaga osobnej bramy device-resident. Porównanie SP5 pozostaje wykonane
dla obu backendów (FEM CPU i FDM), lecz ma status diagnostyczny, nie
`equivalence_established`.

Szeroka ocena celu pozostaje bez zmian: **86% implementacji / 60% gotowości
produkcyjnej**.
