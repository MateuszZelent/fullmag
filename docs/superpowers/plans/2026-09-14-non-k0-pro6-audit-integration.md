# Nonzero-k — włączenie audytu GPT PRO 6 do planu napraw

Data: 2026-09-14. Status: **plan zaktualizowany; implementacja i kwalifikacja nadal w toku**.

## Baza i sposób interpretacji

Audyt użytkownika dotyczy mastera `33aa26fe8b48b6df1bab77e96eb31afa6c6b90a8`. Pierwszy przegląd aktualności wykonano względem worktree `eigensolve-dispersion-plan-20260912`, branch `codex/eigensolve-dispersion-plan-20260912`, HEAD `3833c93eb2d52f575e2b8c67d7723225bc3cd61c`; w chwili tego przeglądu zmiany bramki naukowej były niezacommitowane. Jest to historyczna baza przeglądu; dalsze checkpointy poniżej opisują kolejne etapy. Te dwie wersje nie są równoważne.

Źródła: [audyt NK-01–20](../../raports/fullmag_nonzero_k_audit_33aa26f/AUDYT_NONZERO_K_EIGENSOLVE.md), [szczegółowe karty napraw i testów](../../raports/fullmag_nonzero_k_audit_33aa26f/PLAN_NAPRAW_NONZERO_K_EIGENSOLVE.md), [rejestr kontroli autora](../../raports/fullmag_nonzero_k_audit_33aa26f/verification_log.json). Wszystkie sześć sum SHA256 z pakietu sprawdzono: zgodne. Oryginałów nie zmieniono.

Przyjmujemy wszystkie 20 kart jako pozycje śledzone, ale nie jako 20 nowych awarii każdej obecnej ścieżki. Kod starego Rust Full2x2, nowy native sparse Floquet shared-domain CPU oraz GPU Γ mają osobne zakresy. Odtworzenia W01–W13 autora są świadkami algebraicznymi, nie wykonaniem Fullmag. Ten przegląd aktualności nie obejmował kompilacji ani nowego native run. Brak dowodu wykonania oznacza **NOT VERIFIED**.

## Rejestr aktualności i pracy do zamknięcia

„Częściowo” oznacza obejście problemu w konkretnej ścieżce albo osłonę przez reject; nie pełną naprawę fizyki. Status źródłowy nie zalicza bramki naukowej.

| ID / priorytet | Aktualność w worktree | Następny krok i warunek zamknięcia |
|---|---|---|
| NK-01 P0 | Stare dodatkowe osadzenie nadal obecne; nowy sparse CPU używa osobnej konstrukcji | Odciąć wadliwy adapter od produkcji; jeden fizyczny pencil 2N, realifikacja najwyżej raz; W01, polaryzacja i Γ w obu reprezentacjach |
| NK-02 P0 | Stary decoder nadal certyfikuje układ osadzony | Niezerowy odzyskany q, stabilna normalizacja, niezależne residuum oryginalnego pencil; W02/W13 i uszkodzenia q/map |
| NK-03 P0 | Proxy pola zamiast Hessianu pozostaje w Rust Full2x2 | Pochodna tego samego dyskretnego LLG co relaksacja; test energii/pola/JVP dla każdej interakcji. Sam h_parallel w ograniczonym native modelu nie dowodzi tego samego błędu |
| NK-04 P1 | Problem starej bazy pozostaje; nowy native ma elementowy montaż ograniczeń | Zweryfikować pełne bloki baz i masę; lokalne SO(2), szwy i niekolinearne m0, leakage w kwadraturze |
| NK-05 P1 | Early return K1/Kc1 pozostaje; native odrzuca anizotropię | Niezależne K2/Kc2 i zgodność konwencji energii; reject nie oznacza obsługi |
| NK-06 P1 | Obcinanie signed H0 pozostaje w starym operatorze | Zachować znak; oddzielić stacjonarność od stabilności, minimum/maksimum/siodło i tłumienie |
| NK-07 P0 | Heurystyczne DMI pozostaje; nowy native odrzuca DMI | Szczelny reject, następnie weak form/JVP z energii; znaki D/k/m0, orientacja, jednostki i trzy siatki |
| NK-08 P1 | Tekstowe rozpoznawanie interakcji nadal w starym ABI | Wersjonowane, typowane inventory; brak/nieznane dane odrzucane; test producer–backend i wariantów serializacji |
| NK-09 P1 | Częściowo nieaktualny zarzut braku kodu: istnieje sparse dynamic-demag CPU | Certyfikować q/φ, energię i sprzężenia, zakres geometrii i materiałów; managed runtime i zbieżność nadal otwarte |
| NK-10 P1 | GPU nonzero-k nadal niedostępne | Zachować guard; osobna implementacja tego samego operatora i sprzętowa kwalifikacja bez fallbacku CPU |
| NK-11 P1 | Potwierdzony skrót GPU Γ: wybór po normie pola i syntetyczny wektor | Egzekwować validation-only macrospin albo rzeczywiste eigenvectory; count/target, niejednorodność i residuum przed publikacją |
| NK-12 P1 | Gęsta stara ścieżka pozostaje; nowa sparse nie stanowi jej naprawy | Wycofać dense z produkcyjnego zakresu; oszacowanie przed alokacją i pomiary nnz/RSS/Krylov/LU |
| NK-13 P1 | Stary λ-pencil nadal ma błędny realny target; nowy obrócony operator ma poprawny target częstotliwościowy w źródłach | Test wysokiego wąskiego okna przy małym subspace; target zgodny ze zmienną spektralną. Realny target obróconego operatora nie jest sam w sobie błędem |
| NK-14 P2 | Sekwencyjna realizacja nadal ogranicza skalowanie; polityka opisana w źródłach | Najpierw rzeczywista telemetria, potem niezależne procesy k i osobno distributed solve; pomiar zamiast obietnicy MPI |
| NK-15 P2 | Stare twierdzenie o None nieaktualne w wrapperze: callbacki Some | Zweryfikować native cancel/progress w kosztownych fazach, częściowe artefakty i resume; sama obecność callbacku nie wystarcza |
| NK-16 P1 | Naprawiony w źródłach zakres audytu: metryka masowa, missing/zero, Hungarian, raw IDs i podprzestrzenie degeneracji | Wykonać niewykonane testy Rust oraz native tracking; W08, ortogonalność vs brak danych, luki, raw IDs [2,7] |
| NK-17 P1 | Obejście analytic usunięte w źródłach; porównanie po solve | Natywny test mutacyjny i pochodzenie wyniku; analityka nie może zaliczyć bramki FEM |
| NK-18 P1 | Stabilne P00 Python/Rust w źródłach; testy wysokiej precyzji Python istnieją | Zachować poprawkę; potwierdzić Rust i native ciągłość Γ, nie powtarzać wadliwej formuły jako oracle |
| NK-19 P1 | scale.max(1) i drop 1e-15 pozostają w helperach reference | Zachować nanoskopową masę, skalować obie strony równoważnie, jawny reject osobliwości; certyfikat na oryginalnym operatorze |
| NK-20 P2 | Istnieje nowszy shared-domain operator obok prototypu | Osobne przestrzenie q/φ, lokalne Ms, źródło tylko w magnetyku, jedna reprezentacja Blocha; parity operator-action i pomiary pamięci |

Źródła bieżącego kodu: `crates/fullmag-runner/src/fem/eigen_operator.rs`, `eigen_anisotropy.rs`, `eigen_solve.rs`, `eigen_native_window.rs`, `eigen_native_result.rs`, `eigen_execution.rs`, `eigen_capability.rs`, `eigen_policy.rs`; `crates/fullmag-runner/src/eigen/tracking.rs`; `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`, `slepc_modal_eigen.cpp`, `modal/floquet_modal_solver.cpp`, `floquet_airbox_operator.cpp`, `operators/poisson_airbox_shared_domain.cpp`. Konkretne karty oryginału wskazują stare linie; nie traktować ich numerów jako numeracji nowego HEAD.

## Kolejność wdrożenia po korekcie

1. **Osłony i zakres (PR-A): NK-01/03/07/08/11.** Prześledzić Python → ProblemIR → planner → runner → ABI dla każdego adaptera; wadliwy lub niewspierany model nie może być produkcyjnym wynikiem. Zabezpieczenia GPU/DMI zachować. Nie wyłączać poprawnej ograniczonej ścieżki tylko na podstawie nazwy sąsiedniego helpera.
2. **Niezależne orakle i operator (PR-B/C): NK-03/04/05/06/07.** Przenieść świadków do trwałych testów regresyjnych z poprawnymi oczekiwaniami; uzupełnić notę naukową przed zmianą semantyki. Wymagać JVP/energii, anizotropii pojedynczych współczynników i niezmienniczości bazy. Zakaz kompilacji unit testów nadal obowiązuje; przygotowany test nie jest testem wykonanym.
3. **Pencil i certyfikat (PR-D): NK-01/02/13/19.** Jedna fizyczna przestrzeń, jednoznaczne konwencje λ↔f, projekcja niezerowa, norma bez absolutnego floor, residua oryginalnych bloków i kompletność okna. Weryfikować także nowy obrócony sparse operator, zamiast mechanicznie zmieniać target na urojony.
4. **Sparse CPU i demag (PR-E/G): NK-09/12/14/20.** Wykorzystać istniejącą implementację shared-domain; mały pełny descriptor porównać ze Schurem. Kontrola źródła, adjoint, energii, Γ/gauge, ograniczeń materiału oraz zasobów. Nie odbudowywać od zera funkcji już obecnych.
5. **Gałęzie, referencje i bramka (PR-F): NK-16/17/18 oraz dotychczasowe C0/C1/A1.** Dokończyć fizyczny overlap/podprzestrzenie, kontrolę fazy wyeksportowanego pola i identyfikację profilu n=0. Zgodność samych częstotliwości nie identyfikuje modu.
6. **GPU i odporność (PR-H/I): NK-10/11/15.** Osobne dowody GPU operator-action i eigensolve, wykonane urządzenie, cancel/resume oraz partial/completed; potem pomiary HPC.
7. **Kwalifikacja (PR-J).** Dokładny SHA, obraz, biblioteki, receipt, pola i kompletne pomiary. Każdy zakres CPU/GPU kwalifikować oddzielnie. Brak wyniku nie jest pass; nie scalać kwalifikacji całego nonzero-k na podstawie jednego pilota CPU.

Nazwy PR-A–J oznaczają granice logiczne z planu audytora, nie utworzone PR ani obowiązek dziesięciu osobnych branchy. Spójne, sprawdzone fragmenty zapisujemy etapami w istniejącym worktree.

## Rozszerzone kryteria naukowe

- W01/W02/W13: nierówne sztywności, sprzężenie poprzeczne, znak precesji, zerowa projekcja, skale wektora 1e-100…1e100, uszkodzenie operatora/mapy/pola.
- Dyskretna dyspersja wymienna P1 według orakla z sekcji 4.2 planu audytora: Γ, małe k, środek i brzeg strefy; zgodność masy, jednostek i redukcji. To model 1D, nie uniwersalny wzór siatki 3D.
- Ciągłość Γ bez zmiany modelu fizycznego; dwa sformułowania Blocha porównywać jako tę samą przekształconą przestrzeń albo przez zbieżność. Nie wymagać identyczności dwóch niezależnych przestrzeni P1.
- Pole demag dla zadanego q przed eigensolve, energia, pełny descriptor vs Schur, residua q i φ; gauge wyłącznie przy rzeczywistym nullspace.
- C0/C1/A1: 61 próbek i wymagane 8 gałęzi, skończone zgodne artefakty, Kittel/KS w zakresie ważności oraz fizyczne pola. Rozszerzyć kampanię do **co najmniej trzech poziomów siatki i trzech odległości airboxu**, z osobną zbieżnością liczby modów. Dotychczasowe dwa poziomy są wstępnym porównaniem, nie pełną nową bramką.
- Początkowy proponowany próg fizycznego residualu 1e-8 po skalowaniu oraz tolerancje orakli wymagają uzasadnienia w benchmarku; nie utożsamiać błędu algebraicznego z błędem modelu KS. Nie rozluźniać tolerancji w celu ukrycia błędnego operatora.
- Tracking: Hungarian vs greedy, fizyczna metryka, zerowy overlap vs brak pola, degeneracje/podprzestrzenie, narodziny i zaniki oraz jawna niejednoznaczność.

Dodatkowe ryzyka audytu pozostają osobnymi zadaniami, nie potwierdzonymi awariami: **R1** kompletność wszystkich żądanych par i naroży; **R2** zmienne materiały i topologie inne niż tet4 (poprawna realizacja albo reject); **R3** brak podwójnej fazy i poprawne warunki naturalne; **R4** kompletność okien, niezależność modów i czułość niehermitowska.

## Powiązanie z dotychczasowym planem

Sześć wcześniejszych zadań nie znika: routing → NK-17; P00 → NK-18; usunięcie uniwersalnych limitów k/f → zakres modelu w C0/C1/A1; bramka naukowa → NK-02/09/13/16/20 i R1–R4; dokumentacja/provenance → wszystkie etapy; jawna polityka PETSc i rzeczywista telemetria → NK-14/15. Usunięcie limitu nie rozszerza automatycznie fizycznej ważności modelu.

**B4–B6 pozostają otwarte.** Dodatkowym warunkiem ich zamknięcia jest weryfikacja właściwego operatora i pola, nie tylko wykonanie benchmarku. Robocza bramka nadal wymaga podłączenia kontroli fazy i profilu n=0. Przygotowany profil `fem-cpu-slepc-runtime-v1` nie dowodzi przebudowania solvera ani wykonania kampanii. Stan runnera trzeba sprawdzić przed kolejnym run; historyczny numer joba nie jest aktualnym dowodem.

Po zmianie operatora/version/konwencji aktualizować klucz cache i ponownie obliczyć wyniki kwalifikacyjne. Historycznych artefaktów nie przepisywać na nowy status. Raport postępu ma oddzielać implementację, testy źródeł, managed runtime, naukę oraz release; nie podajemy pozornego procentu przez zliczenie kart.

## Checkpoint kontroli KS i przygotowania profilu n=0

Po commicie `475a502451ec5b07cbf3f58fa28b6cda8da9f86d` zapis JSON bramki
jest objęty testem rzeczywistego CLI. Kontrola KS ma dodatkowo odrzucać
logiczne wartości JSON w identyfikatorach oraz zwracać `fail`, gdy jej
kontrole wejść, geometrii lub pochodzenia zgłosiły błąd, nawet przy zgodnych
częstotliwościach. Nie zmienia to tolerancji modelu ani statusu kampanii FEM.

Następny etap identyfikacji n=0 wymaga rekonstrukcji magnetycznej metryki
Tet4 w pełnym porządku węzłów `vector.bin`. Źródła:
`MeshTopology` i `magnetic_element_mask_from_markers` w
`crates/fullmag-engine/src/fem.rs`, `SharedDomainSparseMass::from_topology`
w `crates/fullmag-runner/src/fem/eigen_mass_metric.rs`. Obecna implementacja
interpretuje marker 0 jako powietrze tylko przy jednoczesnej obecności markerów
niezerowych; walidator benchmarku musi sprawdzić domeny i geometrię, zamiast
bezwarunkowo przyjąć tę konwencję dla niejednoznacznego artefaktu.

Wymagania dla nowej kontroli:

- Sprawdzić rzeczywiste pole, jego hash, surowy indeks modu, wektor k i fazę.
- Wyłączyć powietrze; nie przypisywać wag aktywnych węzłów do pełnego pola bez mapy indeksów.
- Po usunięciu fazy Blocha wyznaczyć projekcję na stały profil poprzeczny,
  używając masy zgodnej Tet4. Masa skupiona jest inną aproksymacją normy,
  nie zamiennikiem gwarantującym identyczny wynik.
- Osobno raportować składową podłużną. Projekcja globalna sprawdza także
  harmoniczną w płaszczyźnie, a nie wyłącznie profil przez grubość.
- Ustalić jawny zakres i kryterium benchmarku przed kwalifikacją: nie ma
  obecnie zatwierdzonego progu błędu profilu. Tolerancja częstotliwości KS
  nie wyznacza tego progu. Lokalizacja powierzchniowa DE nie jest sama w sobie
  błędem solvera; może wykluczać zastosowanie jednorodnego przybliżenia n=0.
- Testować nierówne objętości, zmianę globalnej fazy i skali, pole n=1,
  wyższe harmoniczne w płaszczyźnie oraz niezerowe wartości w airboxie.

To przygotowanie kontroli, nie dowód jej implementacji ani wykonania FEM.
Kontrola fazy wyeksportowanego pola została już podłączona w `ecf945a`;
wcześniejszy opis jej braku w tym dokumencie jest historycznym checkpointem.


## Checkpoint: n=0 podłączone do kontroli KS

Helper `a10e13139` i jawne wsparcie magnetyczne `e6f25b6da` są teraz
wykorzystywane przez `_validate_ks`. Każda kontrola BV/DE odczytuje pole
surowego modu wskazanego w tabeli gałęzi, sprawdza fazę, k oraz powiązanie
metadanych z numerycznym zestawem. Canonical `parameters.json` zawiera jawne
kryterium 99% kwadratu normy w stałej podprzestrzeni i osobny limit udziału
podłużnego. Uzasadnienie i zakres opisano w nocie 0828; nie jest to dowód
błędu częstotliwości poniżej 1% ani uniwersalna granica fizyki DE.

Dowody źródłowe: zestaw bramki/runnera 50 testów i 28 podtestów przeszedł;
trzy później dodane regresje odrzucenia także przeszły. Brak pola,
niejednorodny profil mimo zgodnej częstotliwości oraz brak polityki progów
nie kwalifikują C1. Syntetyczne pola testowe nie stanowią kampanii FEM.

Pozostają otwarte: transfer równowagi między różnymi siatkami A1,
niezależne certyfikaty operatora q/phi oraz wykonanie i ocena kampanii
C0/C1/A1. B4–B6 nie są zamknięte. Odczyt runnera z tej sesji nadal wskazuje
aktywny job 44 `635451d7648a446a83e8d88e21c0279b` dla starszego
`28f552b959455957bbf6dada8a522a241425552c`; nie jest on dowodem aktualnej
wersji i nie został zatrzymany przez tę pracę.


## Korekta kolejności: źródło m0 przed transferem siatkowym

Przegląd źródeł po `c44c53b62` wykazał, że porównanie tablicy
`backend_plan.equilibrium_magnetization` nie jest wystarczającym dowodem
porównania stanów użytych w solverze. `eigen_execution.rs` w
`execute_fem_eigen_inner` przyjmuje `initial_magnetization_override`, a
`materialize_equilibrium` zwraca osobne `equilibrium`. Benchmark
`tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py`
żąda `equilibrium_source="relax"`.

Rzeczywisty eksport znajduje się w `eigen_shared_domain.rs`: artefakt
`equilibrium_artifact.v7` zawiera `m0: equilibrium`, certyfikat akceptacji,
sygnatury siatki/fizyki/materiału/granic i moment siły. `LinearizationState.v6`
zawiera `m0: operator_m0`; funkcja `extend_equilibrium_m0_to_air_nodes`
rozszerza je w powietrzu według `fixed_unit_z_on_nonmagnetic_nodes_v1`.
Porównywanie wszystkich węzłów do osi x byłoby zatem błędne nawet dla
jednorodnego magnetyka C1. `eigen_native_artifacts.rs` publikuje oba pliki,
a `eigen_path_manifest.rs` publikuje listy `equilibrium_artifact_v7_paths`
i `linearization_state_v6_paths` dla ścieżki k.

Wymagana kolejność dalszej pracy:

1. Odczytać rzeczywiste artefakty równowagi/linearyzacji wskazane dla próbek;
   powiązać ich digesty, siatkę i użyty stan z wynikami modalnymi. Brak takiego
   dowodu nie może być zastępowany początkową tablicą planu.
2. Kontrolować m0 i kryterium jednorodności C1 wyłącznie na magnetycznym
   wsparciu; wartości rozszerzenia w airboxie nie są magnetyzacją próbki.
3. Dopiero następnie porównać przestrzennie rzeczywiste m0 między siatkami A1
   i umożliwić ich różną liczbę węzłów. Samo usunięcie tablic z sygnatury
   osłabiłoby kontrolę fizyki zamiast naprawić transfer.

To nowo zidentyfikowana luka dowodu w walidatorze. Eksport źródłowy nie jest
jeszcze potwierdzeniem dostępności kompletnych artefaktów w kampanii runtime.


### Implementacja kontroli powiązania stanu

`scripts/comsol_linearization_binding.py` + `validate_linearization_binding`
porównuje digesty równowagi i linearyzacji z modem, identyfikatory źródłowe,
sygnatury domeny/fizyki oraz faktyczne m0 na jawnym wsparciu magnetycznym.
Wymaga pełnego porządku węzłów i normalizacji magnetycznego m0 z tolerancją
1e-8 zgodną z istniejącym kontraktem reprezentacji. Rozszerzenie airboxu nie
wchodzi do porównania m0. Sześć testów syntetycznych przeszło, w tym ponowne
hashowanie zmienionego stanu i niezgodna siatka.

Helper uzupełnia walidację certyfikatu akceptacji równowagi, nie zastępuje jej.
Wywołujący musi niezależnie ustalić sygnaturę siatki i wsparcie magnetyczne.
Ładowanie i wiązanie plików próbek oraz integracja tej kontroli z bramką
pozostają do wykonania; sam helper nie kwalifikuje kampanii.


### Odczyt certyfikatu konkretnej próbki

`scripts/comsol_equilibrium_artifacts.py` + `read_sample_equilibrium` odczytuje
parę v7/v6 wskazaną przez manifest dla konkretnej próbki. Singularne ścieżki
są dopuszczone tylko dla próbki 0; listy per-sample muszą jednoznacznie
zawierać oba pliki. Brak artefaktu nie powoduje szukania zastępczej próbki.
Wykorzystywany jest wydzielony `validate_equilibrium_artifact_v7_payload`
z dotychczasowego walidatora: akceptacja relaksacji, zgodność digestu oraz
nieujemne metryki pozostają wymagane. Stary wrapper pojedynczego pliku
zachowuje zgodność ścieżek.

Test całego odczytu obejmuje zapisane pliki próbki 7 i odmowę dla certyfikatu
bez zbieżności, nawet po aktualizacji hashy. Nie zastępuje sprawdzenia
natywnej sygnatury siatki. Wywołujący nadal musi niezależnie wyznaczyć tę
sygnaturę i powiązać modalną próbkę; integracja z główną bramką oraz transfer
siatkowy pozostają otwarte. Żaden z tych testów nie wykonuje FEM.


Uściślenie przepływu Relax → Eigen: orchestrator kopiuje
`stage_result.final_magnetization` do następnego ProblemIR i replanuje
(`crates/fullmag-cli/src/orchestrator.rs`, `step_utils.rs`).
`AcceptedFemRelaxStageHandoff::validate_target_plan` w
`eigen_equilibrium_contract.rs` wymaga zgodności wektora i jego SHA256.
Zatem przy poprawnym handoffie tablica planu jest zrelaksowanym m0.
Poprzednie ustalenie dotyczy braku niezależnego dowodu w samej tablicy,
a nie potwierdzonego używania niezrelaksowanego stanu w produkcji.
Autorytatywne certyfikaty pozostają wymagane.

Wyodrębniony walidator payloadu przeszedł 9 testów; istniejący pełny moduł
walidatora przeszedł 203 testy. Odczyt próbki sprawdzono oddzielnie.
Są to dowody interpretowanego kodu i kontraktów, nie wykonania FEM.


### Niezależna tożsamość siatki i kontrola wcześniejszej obawy

`read_sample_equilibrium` wyznacza teraz sygnaturę z canonical MeshIR przez
`comsol_mesh_identity.mesh_topology_fingerprint_v2`. To odpowiada wywołaniu
Rust `MeshIR::topology_fingerprint_v6`, które deleguje do topology-v2;
wersje certyfikatu i formatu hashowania nie mają tej samej numeracji.
Zachowana jest kolejność pól typowanych struktur Rust. Zamrożony wzorzec
Rust/Python przechodzi, podobnie jak odmowa po zmianie geometrii. Szerszy
przegląd serializacji pozostaje przed ostatecznym zatwierdzeniem helpera.

Przegląd osiągalności pierwszej próbki k-path nie potwierdził obawy o
pominięcie relaksacji w produkcji: `execute_fem_eigen_inner` najpierw wywołuje
`validate_eigen_equilibrium_certificate`. W `eigen_shared_domain.rs` brak
zaakceptowanego handoffu dla `RelaxedInitialState` kończy wykonanie komunikatem
`accepted relaxation handoff is required before FEM eigensolve`; analogiczny
guard odrzuca niecertyfikowane `Provided`. Jest to przed materializacją
równowagi i wyborem solvera. Wyjątek syntetycznego K0-3 nie jest kwalifikacją
produkcyjnego sparse CPU. Nie należy traktować tej wcześniejszej obawy jako
potwierdzonego błędu fizyki.


### Uzupełnienie przeglądu: parytet sygnatur siatki — OTWARTE

Niezależny przegląd wskazuje dodatkowe zadanie w ramach R2 i certyfikacji
pochodzenia wyników: topology-v2 używa w Rust typowanego serde_json, a
publiczny Python MeshData używa json.dumps. Dla nanoskalowych współrzędnych
zapis wykładnika (np. 1e-7 wobec 1e-07) oraz kolejność i pomijanie pól par
okresowych mogą dawać różne hashe. Prosty zamrożony tetraedr nie dowodzi
zgodności dla okresowej siatki benchmarku.

Do wykonania:
- Zamrozić międzyjęzykowe przypadki v2 dla współrzędnych nanoskalowych,
  dodatnich wykładników, -0.0 i pełnych par okresowych.
- Rozstrzygnąć alias tolerance_m, opcjonalne None oraz normalizację pustych
  global_ordinals względem rzeczywistej deserializacji MeshIR; wejście
  niekanoniczne odrzucać albo jawnie normalizować przed hashowaniem.
- Sprawdzić zachowanie Rust dla NaN/Infinity i błędów serializacji.
  Obecność unwrap_or_default jest ryzykiem maskowania błędu, lecz nie
  dowodzi, że serde_json zgłasza błąd właśnie dla NaN/Infinity; wymaga to
  osobnego potwierdzenia. Nie traktujemy tej hipotezy jako odtworzonej awarii.
- Dopiero po zgodności wzorców podłączyć obliczaną tożsamość do głównej
  bramki kampanii. Aktualny helper i 25 zielonych testów odczytu/wiązania
  są etapem roboczym, nie dowodem pełnego parytetu ani kwalifikacji FEM.

Wyniki tego przeglądu rozszerzają plan napraw, nie zastępują 20 kart NK
ani czterech ryzyk R1–R4. B4–B6 pozostają otwarte.


Checkpoint kontroli wejść sygnatury: helper odrzuca teraz tolerance_m
zamiast po cichu pomijać ten alias, niepełne/nietypowane global_ordinals
oraz niefinitywną tolerancję pary. Test kolejności pól i opcjonalnego None
potwierdza deterministyczność typowanego payloadu. Zestaw
scripts/test_comsol_mesh_identity.py + test_comsol_equilibrium_artifacts.py
+ test_comsol_linearization_binding.py: **35 passed** (exit 0).
Nie jest to jeszcze pełny międzyjęzykowy dowód serializacji ani wykonanie
FEM; helper pozostaje roboczy do rozstrzygnięcia tej otwartej kontroli.


Sprostowanie po odczycie przypiętych zależności: Cargo.lock wskazuje
serde_json 1.0.150 oraz zmij 1.0.21 (nie Ryu). Kod write_f64 deleguje do
zmij; dla f64 zapis stałopozycyjny obejmuje wykładniki -5..=15, poza nimi
używa wykładnika z jawnym znakiem dodatnim. Helper jest zgodny z tą polityką;
dodano testy granic, 1e20 i -0.0. Jest to dowód analizy źródła biblioteki,
nie nowy wykonany międzyjęzykowy fixture. Nadal trzeba potwierdzić pełny
payload okresowej siatki.

serialize_f64 tej wersji serde_json jawnie zapisuje NaN/Infinity jako null.
Nie potwierdzono zatem zgłaszanego mechanizmu pustego payloadu dla takich
liczb; tę konkretną hipotezę wycofujemy. Niefinitywna geometria nadal musi
być odrzucona przed hashowaniem i Pythonowy helper ją odrzuca.


### Obowiązkowa równowaga w głównej kontroli KS

_measure_ks_profile przekazuje teraz manifest numerycznego runu do
measure_n0_field. Pomiar wymaga pary zaakceptowanej równowagi v7 i stanu
linearyzacji v6 konkretnej próbki, sprawdza ich digesty względem metadanych
modu i tożsamość siatki. Sprawdza kierunek +x faktycznego magnetycznego m0
przed użyciem projektora yz. Brak certyfikatu nie przechodzi w diagnostykę
bez certyfikatu. Samodzielny helper bez manifestu nadal daje tylko pomiar,
nie kwalifikację.

Pełny moduł bramki: 28 testów + 28 subtestów passed. Po dodaniu osobnej
regresji usunięcia certyfikatu KS: 1 passed (28 deselected). Fixture zawiera
syntetyczne pola i certyfikaty; nie jest dowodem wykonania FEM. Kontrola
równowagi wszystkich próbek głównej kampanii i przebiegów zbieżności,
transfer A1 oraz pełny międzyjęzykowy fixture siatki pozostają otwarte.


### Powiązanie pola zewnętrznego równowagi

read_sample_equilibrium wymaga teraz skończonych trójwektorów
plan.external_field oraz equilibrium.external_field_a_per_m i ich dokładnej
zgodności, zgodnie z natywnym zapisem pola z planu. Regresja zmienia pole
certyfikatu przed ponownym obliczeniem digestów: poprawne hashe nie maskują
niezgodności warunków fizycznych. 22 testy loadera/pomiaru przeszły, podobnie
jak pozytywny test pełnej bramki C1 (1 passed, 29 deselected). Pełne
powiązanie sygnatur materiału i pozostałych warunków z planem nadal otwarte.


Kontrola physics_signature jest teraz przeliczana z planu zgodnie z
preimage w eigen_shared_domain.rs: enable_exchange, enable_demag, pole,
gamma, damping, operator i nazwa resolved demag. Brak realization przy
aktywnym demag odpowiada natywnemu PoissonRobin; nieznana wartość jest
odrzucana. 13 testów loadera passed, w tym zmiana gamma, a pozytywna
pełna bramka C1 przeszła. Sygnatura materiału i granic pozostaje otwarta.

Niezależny review etapu wskazał dalsze pozycje do sprawdzenia/poprawy:
1. Powiązanie ścieżki vector.bin i metadanych z sample/raw_mode oraz spectrum.
2. Tożsamość siatki primary case, nie tylko sidecarów KS.
3. Pełne kontrakty manifest/branches i kompletność comparison bundles.
4. Odrzucanie brakującego/niefinitywnego k_rad_per_m kontroli KS.
5. Unikalność branch_id przed liczeniem wymaganych gałęzi.
6. Odrzucanie jawnego pair_ids=[] zamiast wyboru wszystkich par.
7. Ochrona primary artefaktów przed linkami/reparse w _artifact_map.
Pełny fixture międzyjęzykowy oraz uzasadnienie tolerancji fazy 1e-6 wobec
1e-8 pozostają otwarte. Są to zadania bramki, nie nowe dowody wadliwego FEM.


Review pozycje 4 i 5: kontrola KS wymaga teraz jawnego, skończonego,
nieujemnego k_rad_per_m. Branch IDs muszą być nieujemne i unikalne;
duplikaty nie liczą się do wymaganych ośmiu gałęzi. Status podkontroli
branches jest fail również przy zgłoszonych błędach jej zawartości, nie
tylko zbyt małej liczbie gałęzi. Regresje plus poprawny C1: 3 passed,
7 subtests passed. Pełny zestaw bramki uruchomiony oddzielnie.


Review pozycja 6: jawne pair_ids=[]/null/błędnego typu nie uruchamia już
fallbacku do wszystkich par ani boundary_pair_id. Brak pola zachowuje
dotychczasową obsługę starszego kontraktu. Regresje sprawdzają status fail
i pusty requested_pair_ids nawet przy poprawnym boundary_pair_id.
Zestaw certyfikatu fazy oraz n0: 24 passed. Poprzedni pełny zestaw głównej
bramki po poprawkach pozycji 4–5: 31 passed, 32 subtests passed.


Review pozycja 1, etap ścieżek: certyfikat wymaga zgodności kanonicznych
ścieżek metadata oraz vector.bin z sample_index/raw_mode_index. Odrzuca
wskazanie pliku innego modu lub próbki nawet przy identycznych bajtach,
poprawnym hashu i fazie. 26 testów certyfikatu i n0 passed. Nie dowodzi to
niezależności skopiowanych pól pod różnymi poprawnymi nazwami: powiązanie
częstotliwości/metadanych ze spectrum oraz fizyczna niezależność modów
pozostają otwarte. Numer pozycji 1 nie jest jeszcze zamknięty w całości.


Review pozycja 1, etap częstotliwości: certyfikat pola przekazuje wartości
frequency_real_hz i frequency_imag_hz z zahashowanych metadanych modu.
Główna bramka i KS porównują je z jednoznacznym raw_mode_index w spectrum
konkretnej próbki; brak/niefinitywność/rozbieżność odrzucane. Tolerancja
porównania artefaktów to 1e-9 * max(1 Hz, abs(f)), nie tolerancja fizyczna
modelu KS. Dwie regresje (primary real, KS imag) oraz pozytywny pełny C1:
3 passed. Niezależność pól, pozostała tożsamość i pełna kampania otwarte.


Review pozycja 7: _artifact_map używa teraz wspólnej _safe_relative_path;
sprawdzany jest plik i każdy katalog do case_dir włącznie. Symlink/junction
powoduje odmowę przed hashowaniem, również gdy docelowa ścieżka mieści się
w case_dir. Dwa testy wstrzykują rozpoznanie linku na poziomie pliku oraz
katalogu; pierwszy dodatkowo zabrania wywołania hashowania. Wraz z poprawnym
pełnym C1: 3 passed. To testy logiki, nie natywnego tworzenia junctionów.
Nie stanowią gwarancji atomowego odczytu przy równoległej podmianie plików.

Weryfikacja laczna ostatniego etapu: 99 passed, 32 subtests passed (exit 0), obejmujaca glowna bramke, certyfikat fazy, rownowage, n0, runner benchmarku i agregacje. Kontrola diff bez bledow. To dowod kontraktow Python; bez kompilacji i wykonania FEM.
