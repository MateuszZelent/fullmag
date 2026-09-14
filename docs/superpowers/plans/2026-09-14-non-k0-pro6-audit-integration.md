# Nonzero-k — włączenie audytu GPT PRO 6 do planu napraw

Data: 2026-09-14. Status: **plan zaktualizowany; implementacja i kwalifikacja nadal w toku**.

## Baza i sposób interpretacji

Audyt użytkownika dotyczy mastera `33aa26fe8b48b6df1bab77e96eb31afa6c6b90a8`. Przegląd aktualności wykonano względem worktree `eigensolve-dispersion-plan-20260912`, branch `codex/eigensolve-dispersion-plan-20260912`, HEAD `3833c93eb2d52f575e2b8c67d7723225bc3cd61c`; robocze zmiany bramki naukowej pozostają niezacommitowane. Te dwie wersje nie są równoważne.

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
