# Audyt postępu eigensolve non-k0 — 2026-09-13

Status: **implementacja częściowa; kwalifikacja NOT VERIFIED**.
Źródło: czysty worktree `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`,
branch `codex/eigensolve-dispersion-plan-20260912`, HEAD kodu
`3dda82b4e7310f16bb816b6dcc69f59502bc10de`; baza lokalnego mastera
`5084a94ed14b151fc865e8def5a5c28401e98b44`.
Audyt obejmuje statusy S00–S12, diff od bazy, wybrane krytyczne implementacje,
testy i trasy weryfikacji. Nie jest pełnym review każdej linii brancha.
Pierwotna aktualizacja dotyczyła dokumentacji. Następnie wykonano naprawę kodu R01; patrz aktualizacja poniżej.

[Plan wdrożenia](2026-09-12-eigensolve-dispersion-nonzero-k-plan.md) ·
[Historia implementacji i testów](2026-09-12-eigensolve-dispersion-implementation-status.md)

## Ocena postępu

Żaden z 13 etapów nie ma jeszcze wszystkich dowodów zamknięcia.
Wcześniejsze wartości 75–95% dla części etapów oraz „około 50% całości”
nie miały jawnego mianownika ani wag; wycofujemy je jako miarę ukończenia.
Poniższe statusy zastępują te szacunki. Obecny kod bazowy UI/GPU nie jest
wykonaniem rozszerzenia non-k0. Zakończone podzadanie źródłowe nie oznacza
zamkniętej bramki naukowej.

| Etap | Wykonane / dostępny dowód | Otwarte kryterium końcowe | Status |
|---|---|---|---|
| S00 | Dedykowany worktree, baza, rejestr, rozpoznanie ABI i handoffu | Świeży managed K0/Kittel i zaakceptowana równowaga; rozliczenie jobów | Częściowy, wykonanie blokowane |
| S01 | ADR 0031, rozdział 3D/2.5D, faza, mapowanie lokalnego manuala COMSOL, noty i source-map | Review całej semantyki, spójność capability, zamrożone kryteria naukowe | Częściowy |
| S02 | Walidacja k/ID, zachowanie branches/sample_selector/include_branch_table w Python→IR, wąski routing CPU, Γ, forced-GPU reject | Kompletny round-trip publicznego scenariusza, realizacja 2.5D, testy wszystkich konsumentów | Częściowy |
| S03 | FloquetTangentProlongation, operator C†AC, walidacja payloadów | Pełny natywny opis problemu i skalowalne assembly magnetyczne; MFEM V0/V1 | Częściowy |
| S04 | Bounded Schur, bloki MFEM, nodalne Ms, osobna trasa K0/non-k0, diagnostyka residualu | R01/R02, skalowalny owner, gauge, rekonstrukcja pełnego układu, V2/V3/V9 | Częściowy; R01 naprawione źródłowo |
| S05 | Właściciel dense/sparse Floquet, handoff fazy/okna, progress/cancel i partial | Managed SLEPc, kompletność okna, cache/resume, pełny residual | Częściowy |
| S06 | Hungarian, luki, overlap ważony masą FE; zapisane regresje | Obwiednie w wspólnej bazie, degeneracje/SVD, restart i crossing na fizycznych modach | Częściowy |
| S07 | Selekcja pól/gałęzi, sample/raw-mode ID, rozdział osi k i pola, manifesty | API/OpenAPI i binary consumers, partial/resume end-to-end, wyniki realnego solve | Częściowy |
| S08 | W bazie istnieją wykresy i workspace; brak zmian apps/control-room w diff zadania | Authoring→solve→wykres→mod→FMS, poprawna faza i browser/WebGL | Rozszerzenie do wykonania |
| S09 | Bounded provider modified Helmholtz i assembler P1 przekroju; izolowany test zapisany | Typed realization/routing, pełny solver, otwarty brzeg, V5 TetraX/3D | Częściowy prototyp |
| S10 | Opis fizyki i ograniczeń; brak kwalifikowanej implementacji rozszerzenia | Anizotropia/EASA, DMI seams, Gilbert, V6/V7 | Do wykonania |
| S11 | Odrzucenie wymuszonego GPU chroni brak obsługi | Rzeczywisty non-k0 GPU/double, rezydencja, >1024 DOF, V8 | Do wykonania |
| S12 | Commity lokalne, plan i recepty kontraktowe | V0–V10, niezależne review, push/PR/merge, FF master i cleanup | Częściowy, integracja otwarta |

## Zamknięte przyrosty źródłowe

- [x] Zapisano izolację i bazę mastera; przy rozpoczęciu tego audytu worktree był czysty.
- [x] Zachowano selektory Python→IR oraz rozdział sample k/bias-field w writerach.
- [x] Zaimplementowano Hungarian, obsługę luk i dodatnie wagi FE z jawnym fallbackiem.
- [x] Dodano bounded algebraiczne providery 3D/2.5D oraz assembler przekroju.
- [x] Podłączono ograniczony wariant CPU Floquet-airbox i oddzielono assembly K0.
- [x] Dodano walidację dense/CSR, zgodności dwóch wektorów k i okna oraz propagację fazy.
- [x] Commit 3dda82b4e7310f16bb816b6dcc69f59502bc10de dodaje diagnostykę residualu potencjału.
- [ ] Nie zamknięto produkcyjnego eigensolve non-k0 ani pierwszego kamienia CPU S00–S08.

## Ustalenia i zadania naprawcze

### R01 — P1: błędna kolejność pivotów w bounded Schur

Aktualizacja: **NAPRAWIONE ŹRÓDŁOWO, managed verification otwarte**.
`solve_factored` stosuje teraz wszystkie permutacje RHS przed podstawianiem
w przód. Regresja `multiple_pivots_preserve_complex_multiple_rhs` sprawdza
realny i zespolony P, dwa zespolone RHS, cztery bloki realifikacji Schura
i residual oryginalnego P. Oracle powstaje przez B=P X oraz D=-A X.
Natywny test MSVC: przed poprawką exit 1 (`FAIL: pivoted Schur real-real`),
po poprawce cały plik testowy exit 0. Managed recipe ponowiono: exit 1
przed kompilacją, `Container runner owns heavy builds on this host`.
Opis błędu poniżej dokumentuje stan sprzed naprawy.

Źródło: `backends/fem/cpu/frequency_domain/floquet_dynamic_demag_k.cpp`,
`factorize` i `solve_factored`. Faktoryzacja zamienia całe wiersze, także
zapisane wcześniej mnożniki L. Solve przeplata kolejne permutacje RHS
z eliminacją przy użyciu końcowego L. Te dwie konwencje są niespójne.

Kontrprzykład algebraiczny odtworzony niezależnym skryptem Python w audycie:
P=[[1,2,3],[4,5,6],[7,8,10]], b=[6,15,25], prawidłowe x=[1,1,1].
Pivoty [2,2,2]. Dosłowne odtworzenie algorytmu daje
x≈[-6.142857,47.428571,-31.142857], residual infinity≈10.714286.
To dowód błędu algorytmu; nie uruchomiono w audycie binarnego MFEM.
Obecny test `floquet_dynamic_demag_k_test.cpp` nie obejmuje takiego
wielokrotnego pivotowania.

- [x] S04.R01: dodać natywną regresję 3×3 z wymuszonym drugim pivotem,
  zespolonymi/multiple RHS i porównaniem Schura do niezależnego oracle.
- [x] Poprawić stosowanie permutacji przed forward substitution lub użyć
  zgodnego rozwiązania bibliotecznego; zachować istniejące testy znaku/gauge.
- [ ] Kryterium: regresja czerwona na HEAD audytu, zielona po naprawie;
  uruchomiony `fem_floquet_dynamic_demag_k_contract` w zarządzanej trasie.

### R02 — P1: residual nie certyfikuje i nie dociera do wyniku modalnego

Aktualizacja: **częściowa naprawa**. Provider wymusza próg 1e-8 dla normy
oryginalnego RHS, sprawdza również pominięte równanie przy pinowaniu,
certyfikuje wszystkie RHS i nie publikuje macierzy po błędzie. Regresja
niezgodnego źródła sprawdza duży niezerowy residual, odrzucenie i nienaruszony
bufor; zgodny nullspace/gauge ma osobny przypadek sukcesu.
Izolowany natywny MSVC test providera: exit 0. Źródła importera przekazują
floquet_potential_certificate do JSON diagnostyki/wyniku i jawnie zachowują
full_modal_residual_certified=false. Ta gałąź MFEM nie została skompilowana
ani wykonana: managed recipe zatrzymuje się przed kompilacją na preflight
kolejki. Source-map validator noty 0828: exit 0.
S05.R02 — pełna rekonstrukcja modu i V9 — pozostaje do implementacji.
Historyczna diagnoza poniżej opisuje stan sprzed tej częściowej poprawki.


Źródła: `build_floquet_dynamic_demag_k_real_split` i
`backends/fem/src/frequency_domain/modal_eigen_solver.cpp` →
`solve_modal_eigen_contract`. Provider odrzuca niefinite residual, ale
nie odrzuca dużego skończonego residualu. Importer przenosi macierz
`provider_result.real_split_row_major`, pomijając `provider_result.diagnostics`.
Przy pin_first_dof sprawdzany jest wyłącznie blok bez przypiętego wiersza.
Test „residual < 1e-12” przejdzie również przy stale wyzerowanej diagnostyce.

- [ ] S04.R02: określić i udokumentować próg oraz normę bloku; zachować
  residual i status certyfikacji w wyniku/provenance.
- [ ] Dodać test wykrywający stale zero, duży skończony residual i błąd RHS;
  kontrolować gauge/nullspace oraz zgodność pominiętego równania.
- [ ] S05.R02: rekonstruować potencjał dla modu i certyfikować oryginalny
  descriptor z osobnymi normami magnetyczną/potencjału/BC (V9).
- [ ] Kryterium: błędny solve nie jest publikowany jako certyfikowany,
  pełny residual double ≤1e-8 zgodnie z zamrożonym planem V9.

### R03 — P1: niepełne pokrycie managed recipes

Źródła: `justfile` → `verify-fem-modal-floquet-airbox-cpu` oraz
`backends/fem/CMakeLists.txt` → `add_fem_source_facade_contract`.
Recepta airbox uruchamia trzy targety, pomija istniejące
`fem_floquet_modal_solver_contract` i
`fem_floquet_waveguide_cross_section_contract`. Korzysta z profilu fem-gpu
i CUDA ON mimo nazwy CPU; sam profil nie dowodzi urządzenia solve.
Nie zawiera jeszcze pełnego scenariusza f(k) i weryfikatora jego artefaktów.

- [ ] S12.R03: włączyć oba targety do właściwych bramek (2.5D może mieć osobną),
  zagwarantować MFEM/SLEPc ON i dowód requested/resolved CPU.
- [ ] Rozwiązać allow-list runnera przez jego konfigurację/procedurę;
  nie omijać kolejki hostowym buildem.
- [ ] Kryterium: terminalny receipt dokładnego źródła, wszystkie nazwane
  testy wykonane bez skipu, oddzielny scenariusz i weryfikator artefaktów.

### R04 — P1: prototyp dense nie realizuje docelowego operatora

`include/frequency_domain/floquet_modal_problem.hpp` zawiera obecnie
`FloquetTangentConstraintRequest`, a nie pełny opis geometrii, materiałów,
równowagi, obu zbiorów par i BC/gauge przewidziany w S03.
Bounded bridge materializuje macierze; sparse modal owner nie przyjmuje demag-k.

- [ ] S03.R04: domknąć natywny opis problemu i assembly niezależne od macierzy z Rust.
- [ ] S04.R04: implementować skalowalny Schur/descriptor oraz cache/workspace.
- [ ] Kryterium: realny problem >1024 DOF, residual, pomiar pamięci;
  dense zachowany jako oracle, bez deklaracji produkcyjnego skalowania.

### R05 — P2: nieaktualne statusy i rejestr

Plan deklarował wszystkie S00–S12 jako przyszłe oraz nieistnienie recept,
które są już w justfile. Checkpoint nie obejmował 3dda82b4e.
Rejestr storage wskazuje `a208d784b96a2420f5c8406a28a29ae21b8de1f2`,
natomiast rzeczywisty commit a208d784b ma SHA
`a208d784b7d0a8bb4bb0053e704d7dcf64bd1229`.
W audycie usunięto aktualne twierdzenia sprzeczne z kodem; historyczne wpisy
checkpointu pozostają jawnie historyczne.

- [x] S12.R05a: zaktualizować audyt, plan i checkpoint, wskazać rzeczywisty HEAD.
- [ ] S12.R05b: uzgodnić rejestr przez zatwierdzony lifecycle z pełnym SHA
  wynikowego commita dokumentacji; nie traktować starego JSON jako dowodu stanu Git.

## Dowody i ograniczenia

Bieżące odczyty po podmianie obrazu: diff od bazy nie zawiera zmian
`apps/control-room` ani implementacji GPU zadania. Główny checkout zachowuje
cudze zmiany. `just runner-container-status` z obrazu
`sha256:fe2931c6e4fe5e43eb4a4da1fc18a24696cb50c3e36df84fd1db21897ba69175`
zwraca exit 0, `worker_alive=true`, `accepting_jobs=true`, pustą kolejkę i
wolne około 50.9 GB. `gh auth status` nadal zwraca exit 1 z powodu nieważnego
tokenu; nie blokuje to lokalnego obrazu ani endpointów UI.

Historyczne wyniki w checkpointcie: planner 461 passed, IR 102 passed
(najnowszy zapis), runner fem::eigen_tests 142 passed, tracking 15 passed,
Python fokus 35 passed, problem_ir 26 passed, dokumentacja matematyczna 9 passed.
Izolowany MSVC no-MFEM Schur/modal/cross-section: exit 0 w zapisanych przebiegach.
Nie powtarzano niezmienionych suites na potrzeby aktualizacji dokumentów.
Istnieją też niezielone szersze przebiegi: runner eigen 226/1 oraz Python API
277/19; wymagają rozliczenia przy integracji, nie wolno raportować „wszystkie testy zielone”.

V0 ma częściowe dowody kontraktowe. V1–V10 dla pełnego nowego produktu nie mają
kompletnej kwalifikacji; V4/V5 nie mają eksportów porównawczych COMSOL/TetraX,
V8 nie ma non-k0 GPU parity, V10 nie ma end-to-end/browser. Manual COMSOL
jest odniesieniem metodycznym, nie wynikiem numerycznym referencyjnego solvera.

Kolejność realizacji: R01 → R02 i R03 → S03/S04 skalowanie → S05/S06 →
S07/S08 i CPU science → S09 → S10 → S11 → pełne S12.
Naprawa autoryzacji GitHub jest warunkiem integracji, lecz nie blokuje lokalnych prac.


### Aktualizacja S05.R02 — integracja dense SLEPc

Podłączono rekonstrukcję do nearest/window i każdego zwróconego modu.
Kontrola używa oryginalnego stiffness, sprzężeń i masy, a nie wyłącznie
macierzy Schura. Natywny JSON przenosi podwojony zespolony potencjał oraz
osobne residuale magnetyczny/potencjału. Błędny descriptor odrzuca solve.
Contour z kontekstem rekonstrukcji jest fail-closed. Izolowane testy providera
przechodzą (exit 0), adapter production_cpu_modal_eigen.cpp kompiluje się
MSVC bez MFEM (exit 0). To nie jest wykonanie SLEPc ani końcowa kwalifikacja.
Nadal do wykonania: geometryczne BC/pełna siatka, binary publikacja potencjału
przez runner, contour i managed/physics V9. R02 pozostaje częściowe.

### Aktualizacja R03/R05 — komplet recepty i rejestr

Recepta `verify-fem-modal-floquet-airbox-cpu` obejmuje teraz wszystkie siedem
zarejestrowanych kontraktów Floquet, w tym modal solver, scalar Bloch i przekrój.
CTest odrzuca brak testów; biblioteki współdzielone są dostępne dla całej serii.
Konfiguracja ma MFEM/SLEPc ON, Fullmag FEM GPU OFF i oddzielny katalog CMake
w resolverowym build root. Obraz fem-gpu służy jako kompletny toolchain
(z CUDA-linked MFEM), a nie jako dowód urządzenia solve.
Sprawdzenie parsera just, składni Bash i kompletności siedmiu targetów: PASS.
To naprawa źródeł recepty, nie receipt wykonania ani scenariusz f(k).

R05b: oficjalny `fullmag_storage.py register` zakończył się exit 0 i odtworzył
HEAD `71a98514c410ebac82a610ccc2a17ff172533a23`, branch, właściciela oraz stan
active istniejącego worktree. Wrapper just błędnie kierował operację metadanych
przez blokadę heavy build; bezpośredni resolver zachował własny build_lock.
Rejestr należy ponownie zamknąć tym samym API po ostatnim commicie zadania.

### R06 — utrata kontekstu punktu dyspersji w UI

Parser CSV pomijał kx/ky/kz, a selekcja dyspersji pomijała dostarczone
identyfikatory i część provenance. Osobna ścieżka kliknięcia Analysis Plots
korzystała z identyfikatorów wyłącznie widma, nie dyspersji. Naprawiono obie
ścieżki: zachowują k klikniętego wiersza, współrzędną ścieżki, opcjonalne ID
i kontekst rewizji. Nie wymyślają brakującego k ani identyfikatorów.
Dwa testy transformacji oraz test kliknięcia były RED przed naprawą.
Po naprawie trzy pliki Vitest: 115 passed. To testy źródeł, bez live WebGL.
S08 pozostaje otwarte do authoring/runtime/FMS i weryfikacji w przeglądarce.

### R07 — niespójna tolerancja pivotowania rekonstrukcji

Schur przyjmował `problem.pivot_tolerance`, natomiast rekonstrukcja ponownie
faktoryzowała P ze stałym 1e-14. Poprawna mała macierz P=1e-15 z progiem
1e-16 była zatem odrzucana dopiero podczas odtwarzania potencjału.
Rekonstrukcja zachowuje teraz oryginalny próg, waliduje go i otrzymuje go
z bridge. Natywna regresja małej skali: RED exit 1, GREEN exit 0; sprawdza
też odrzucenie przy ostrzejszym progu i wyzerowanie poprzedniego wyniku.
Dodano test przekazania progu przez MFEM bridge, jeszcze niewykonany managed.
Validator source-map 0828: exit 0. Nie zmieniono residual tolerance 1e-8.

### R06b — brak danych CSV nie oznacza zera

Dodatkowa regresja wykryła konwersję pustych komórek CSV do zera oraz
obcinanie niecałkowitego indeksu modu. Parser dyspersji odróżnia teraz brak
k/residualu/linewidth od liczby zero i odrzuca wiersze z brakującymi lub
niepoprawnymi indeksami/częstotliwością/ścieżką. RED: cztery wiersze zamiast
jednego; GREEN: 116 testów w trzech plikach Vitest. Nie zmieniono
fizycznych tolerancji ani nie uzupełniano danych arbitralnymi wartościami.


### Referencja COMSOL — przepis dla operatora, 2026-09-13

Użytkownik nie ma dotychczas wyników COMSOL/TetraX i zadeklarował wykonanie
nowej symulacji. Zapisano kompletny przepis
[comsol-nonzero-k-dispersion-benchmark](../../guides/comsol-nonzero-k-dispersion-benchmark.md),
parametry SI oraz 61 punktów Γ–X–M–Γ. Model A1: film Permalloy
200×200×10 nm, otwór kołowy r=50 nm, μ0H=0.1 T w +x,
alpha eigen=0, skończony airbox z Dirichlet w z i periodycznością x/y.
Dynamiczny demag opisano przez periodyczną obwiednię potencjału; fazor
magnetyzacji zachowuje Floquet exp(-ik·r). Dwa testy kontrolne filmu
i eksport zespolonych pól poprzedzają pełny benchmark.
Sprawdzono stałe, jednostki, 61 punktów i znaki transformacji;
wykonanie COMSOL i wyniki porównania pozostają NOT VERIFIED.
Brak danych jest teraz zadaniem oczekującym na pomiar operatora,
a nie podstawą do deklarowania ukończonej walidacji naukowej.


## Zlecenie wykonania dokładnego benchmarku COMSOL

Kryteria B0–B6 są zapisane w aktualnym nagłówku implementation-status.
Nie wystarczy sam wykres/import CSV, podniesienie limitu dense ani zmiana
Dirichleta na Robin. Wymagany jest rzeczywisty model A1 z dynamicznym demagiem,
zaakceptowaną równowagą, pełną ścieżką k i eksportem porównywalnych pól.


### B0: rzeczywista materializacja A1 na hoście Windows — 2026-09-13

Próba publicznego skryptu C0/C1/A1 dla A1 z
`load_problem_from_script(lightweight_assets=False)` i
`to_ir(include_geometry_assets=True)` doszła do ekstrakcji Gmsh, orientacji
ścian periodycznych i `MeshData.validate_strict`. Nie powstał końcowy ProblemIR.
Diagnostyka `faulthandler` ujawniła Windows access violation w
`numpy.linalg.det`, wywołanym z `_gmsh_types.py::validate_strict`.
Log: `comsol-a1-real-mesh-stack.log` w resolverowym build root `windows-native`.
Pierwszą próbę bez diagnostyki przerwano; druga zakończyła się kodem 1.

Wniosek: testy lekkiego authoringu nie dowodzą materializacji siatki.
Należy zweryfikować rzeczywistą siatkę w kontrolowanej trasie Linux/CPU
z tym samym skryptem, a błąd hostowego stosu NumPy zbadać osobno. Nie wolno
wyłączać `validate_strict` ani uznać modelu za gotowy na podstawie mock assets.


### B2/B5: review przed natywnym wykonaniem

- **OTWARTE**: sparse Floquet musi targetować częstotliwość zgodnie z
  lambda=i omega; rzeczywisty shift omega w nierotowanym pencil jest błędny.
- **W TRAKCIE**: formatter i parser rozdzielają fizyczne zespolone phi od
  doubled-real coefficients. Wariant fizyczny wymaga własnego wymiaru
  `potential_dof_count` i nie może trafić do starego eksportera współczynników.
- **OTWARTE**: residual zredukowanych bloków CSR jest poprawną kontrolą
  problemu Galerkina, lecz nie dowodzi rekonstrukcji pełnego deskryptora ani
  phase/frame seams i Dirichleta. Nazwy i certyfikacja muszą odpowiadać dowodowi.
- **DO WERYFIKACJI TRASY**: ogólny sparse production window nadal posiada
  konwersję mass CSR do dense; nowa ścieżka A1 nie może jej wywoływać.
- **NAPRAWIONE źródłowo**: plotter łączy osobne `branch_id`, pozostawia przerwy
  przy brakujących próbkach i nie łączy nieśledzonych modów. Commit
  `8e460ea3dfd8a8714c01cc912bbb3939a1caa13a`, 7 testów passed i oględziny PNG
  fixture. Nie jest to wykres policzonego A1.

Po rozdzieleniu parsera fizycznego potencjału: **259 testów eigen passed**,
log `physical-native-parser-tests.log` w resolverowym build root windows-native.
Natywny MFEM/SLEPc nie jest objęty tym testem.


### B0: Linux materializacja zakończona, L1 nadal niezaakceptowane

Próba `a1-linux-real-mesh-20260913-144626` utworzyła rzeczywisty ProblemIR:
108377 węzłów, 612437 tet4, w magnetyku 4327 węzłów i 14923 tetraedry.
Objętość analityczna wynosi 3.214601836602551e-22 m³, a suma objętości
magnetycznych tetraedrów 3.2155705887666717e-22 m³. Są to różne wielkości.
Receipt `passed` dotyczy wyłącznie materializacji; `solver_executed=false`.

Review raportu wykrył **otwartą niezgodność L1**: żądane `thin_film_tetrahedral`
z trzema warstwami ma `status=skipped`, actual `free_tetrahedral`, ponieważ
swept meshing nie obsługuje jeszcze `Difference`. Konieczna jest realizacja
warstw dla tej geometrii oraz ponowna rzeczywista kontrola. Nie można uznać
samego receipt materializacji za spełnienie wymagań siatki benchmarku.


### Aktualizacja audytu — 2026-09-13, obraz UI i retry managed builda

#### Wykonane od poprzedniego audytu

- **Runner/UI — wykonane źródłowo i operacyjnie:** zintegrowano statyczny panel
  runnera, endpointy UI/observability i allow-listę profili z profilem
  `fem-cpu-slepc-modal-v1`. Obraz `sha256:fe2931c6e4fe5e43eb4a4da1fc18a24696cb50c3e36df84fd1db21897ba69175`
  zastąpił stary obraz; kontener `20601ed2d46245996ba5768f5aa408af50e25266c6562fc447bebc311becf90b`
  jest `running`.
- **Auth/health — wykonane:** `/ui/` HTTP 200, publiczny probe
  `/api/v1/auth/session` HTTP 200 z `authenticated=false`, chroniony
  `/health` bez tokenu HTTP 401, z tokenem HTTP 200 oraz
  `worker_alive=true`, `accepting_jobs=true`; autoryzowany overview HTTP 200.
  Ochrona API pozostała włączona.
- **Błąd linkowania — poprawiony źródłowo:** commit `377230523` rozszerza
  dołączanie biblioteki CUDA compatibility na wszystkie targety
  `add_fem_source_facade_contract`, aby `libceed.so` nie pozostawiał symboli
  `cu*` nierozwiązanych po pierwszym targetzie.

#### Wynik i korekta planu

Job `cdc83e275b9948628fd968b8e9b783cf` z profilem
`fem-cpu-slepc-modal-v1` zakończył się `exit_code=2`. CMake i pierwszy target
modalny przeszły, lecz `fem_floquet_magnetic_operator_contract` zatrzymał się
na linkowaniu `libceed.so`; `ctest_completed=false`, więc nie ma jeszcze
managed dowodu wykonania kontraktów, solvera ani fizycznego `f(k)`. Następny
krok to jeden retry z commitem `377230523`, po uzyskaniu wymaganej zgody na
budowanie testów przez managed runner.

#### Estymata postępu (stan implementacji, nie kwalifikacja)

| Zakres | Wykonane | Pozostało | Postęp |
|---|---|---|---:|
| Model COMSOL C0/C1/A1 i kontrakty Python/IR | publiczny przepis, walidatory, materializacja Linux; L1 siatki nadal otwarte | trzy warstwy swept dla Difference i końcowy ProblemIR | 70% |
| Natywny Floquet/demag-k/SLEPc CPU | sparse owner, rekonstrukcja phi, tracking i testy źródłowe | managed kompilacja, CTest, runtime residuale | 65% |
| Runner i UI | najnowszy obraz, UI 200, auth/health/API, profil allow-list | browser smoke w żywym panelu i receipt kontraktu | 90% |
| Rzeczywiste C0/C1/A1 oraz 61 punktów f(k) | brak zaakceptowanego solve | równowaga, pełne Γ–X–M–Γ, 8 gałęzi, eksport | 10% |
| Porównanie COMSOL/TetraX i kwalifikacja wydania | przepis i format wyników | dane referencyjne, tolerancje, review/PR/merge | 0% |

#### Otwarte podpunkty wymagające naprawy

1. Uzyskać zgodę na retry managed builda i potwierdzić, że wszystkie osiem
   targetów kontraktowych linkuje oraz wykonuje się w CPU/double/SLEPc.
2. Jeśli retry przejdzie, uruchomić materializację L1 na tej samej trasie,
   następnie C0/C1 i pierwszy mały nonzero-k przed pełnym A1.
3. Nie oznaczać `qualification` jako `passed` na podstawie działającego UI,
   obrazu ani samego CMake; potrzebne są receipt, residuale, artefakty pól i
   zgodność 61 punktów.
4. Po dowodach runtime wykonać browser/WebGL smoke, porównanie COMSOL/TetraX,
   niezależny review i pełny cykl PR → merge → weryfikacja mastera → cleanup.
