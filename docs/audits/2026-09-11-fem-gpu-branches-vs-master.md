# Audyt branchy FEM GPU względem mastera — 2026-09-11

## Wynik

**Nie ma podstaw do uznania prac za ukończone ani brancha za gotowy do merge.**
Znaczna część poprawek jest zintegrowana źródłowo na branchu GPU, lecz nie na
badanym masterze. Prompt 5/A13 ma historyczne dowody wykonania; nie jest zadaniem
całkowicie pominiętym. Prompty 6–7 nie zamykają obecnego dirty worktree.
A11, zaakceptowany refinement Contract B oraz A16 wymagają dalszej pracy i dowodów.

To audyt stanu Git, wybranych właścicieli implementacji i dokumentacji dowodowej.
Nie jest review każdej z 381 różniących się pozycji ani nową kwalifikacją fizyki.
Nie wykonywano fetch, builda, benchmarku, commitów, push ani merge w tym audycie.
`origin/master` oznacza lokalny ref; aktualności serwera GitHub nie sprawdzano.

## 1. Tożsamość i porównanie historii

| Ref | Pełny SHA | Tylko master / tylko branch |
|---|---|---|
| `master`, lokalny `origin/master` | `fe10f8be750474025fb3c677aa6134c505a9d45d` | — |
| `codex/gpu-master-integration-20260906` | `2fec5cb8e2964c5111a5cb0e4ab387bf3a00fb5e` | 45 / 118 |
| `codex/fem-gpu-tasks1-5-remediation` | `425267269264a37585ab5cda18b61d672c161f52` | 52 / 105 |
| `codex/a11-cusparse-implementation` | `2fec5cb8e2964c5111a5cb0e4ab387bf3a00fb5e` | 45 / 118 |
| `codex/contract-b-witness-20260910` | `2fec5cb8e2964c5111a5cb0e4ab387bf3a00fb5e` | 45 / 118 |

Wspólny przodek integracji i mastera:
`e514fc8303462f05bf16a6d6d74ebdb5f559efe0`.
Dwustronny diff drzew `master` → integracja: **381 plików, +48575/-12806**.
To nie rozmiar samej optymalizacji: różnica zawiera także nowsze zmiany mastera.
`git cherry master codex/gpu-master-integration-20260906` zwrócił 111 pozycji `+`
i zero `-` dla ocenianych commitów bez merge. Nie znaleziono w ten sposób
patch-equivalent integracji; nie wyklucza to częściowych równoważnych implementacji.

`codex/fem-gpu-tasks1-5-remediation` jest przodkiem integracji (exit 0).
Nie należy scalać obu branchy niezależnie jako dwóch nowych pakietów.
Branch Contract B jest czysty, bez dodatkowego commita ponad integrację.
Branch A11 ma pięć zmienionych plików exchange/sparse; sam jego HEAD nie
reprezentuje tej pracy. Status Contract B odczytano poza sandboxem po odmowie
Git z powodu właściciela katalogu, bez zmiany globalnego `safe.directory`.

Główny checkout ma HEAD `61121583c0b4578f5f4ae50be745aa9b5fcb418e`, a nie
badany ref `master`; zawiera cudze zmiany. Porównanie wykonywano jawnymi refami.

## 2. Co zostało zrobione

Poniższa mapa łączy aktualne źródła z historycznym raportem integracji
`docs/audits/2026-09-06-gpu-solver-branch-integration.md` w worktree GPU.
Stan „źródłowo” nie oznacza nowego PASS na aktualnym masterze ani dirty snapshotcie.

| ID | Zakres i stan | Pozostałe wymaganie |
|---|---|---|
| A01 | Jawny wybór normy PCG; `hypre_device_solver.cpp` wywołuje `HYPRE_PCGSetTwoNorm`. | Zachować niezależną kontrolę residualu; ponownie związać runtime z końcowym SHA. |
| A02 | Transakcja candidate capture i rollback RK obecna w zintegrowanym pakiecie agenta 2. | Sprawdzić fault injection i wszystkie ścieżki akceptacji/odrzucenia po integracji. |
| A03 | Oddzielny snapshot wejściowego kierunku NCG i obsługa historii opisane w pakiecie agenta 3. | Aktualny managed rollback/history proof. |
| A04 | Propagacja statusów redukcji CUB zintegrowana źródłowo. | Fault injection i fail-closed bez zgubienia błędu. |
| A05 | Persistent exchange/mass/factor i aktualizacja wag zamiast ponownego setupu. | Bezpośredni dowód liczników alokacji/transferów i porównywalny performance. |
| A06 | Odroczone bufory preconditionera, profile i alias-view; default `none`. | Końcowy test pamięci dla `none` i przełączania profili. |
| A07 | Ścieżka standardowa ogranicza kopiowanie; `rk_graph.cpp::RkGraphPlan::launch` nadal ma fallback `rk_candidate_capture_device`. | Pełny audyt kosztu i semantyki fallbacku; nie deklarować globalnego usunięcia round-trip. |
| A08 | Hostowa decyzja adaptive publikowana do urządzenia; kontrakty kontrolera. | Aktualny dowód akceptacji, odrzucenia i ograniczeń kroku. |
| A09 | Wspólne redukcje XYZ exchange-mass w pakiecie preconditionera. | Porównanie wariantów i runtime dla granicznych rozmiarów. |
| A10 | Rozdzielenie physical/cached evaluations i receipt accounting. | Kontrola kompletnego zaakceptowanego kroku i eksportu po zakończeniu. |
| A11 | Plan sparse i cuSPARSE istnieją; produkcyjne podłączenie exchange jest dirty WIP. | Dokładność, pełny koszt operatora, maski, Ms, masa, PBC, energia i provenance; brak zamknięcia. |
| A12 | `demag_fem_bem/fem_bem.cpp` zawiera `initial_guess_valid`, reset obu układów oraz guard unieważniający warm start po błędzie. | Runtime warm/cold, zmiana operatora i failure/retry; obecność guarda sama nie dowodzi poprawności. |
| A13 | `mfem_context.cpp::AdapterBackedElementwiseCoefficient` ma snapshot membership `std::vector<bool> active_elements_`. Historyczny prompt 5 jest SUPERSEDED. | Aktualny managed kontrakt DG0 i pomiar setupu; brak podstaw do przypisania speedupu steady-state LLG. |
| A14 | Reuse energii zaakceptowanego stanu opisane i zintegrowane w pakiecie NCG. | Aktualne liczniki i zgodność energii po accepted/rejected trials. |
| A15 | Ponowne obliczanie metryk po fallbacku kierunku NCG zintegrowane źródłowo. | Wykonanie gałęzi fallback i zgodność opublikowanych metryk. |
| A16 | Narzędzia kwalifikacji, benchmarku i Nsight obecne. | Pełna fizyka, convergence, parity, A/B i immutable release candidate pozostają NOT VERIFIED. |

Dodatkowe commity integracji obejmują izolację CPU i bezpieczny eksport stanu
(`c0f366c02`), zachowanie receiptów podczas snapshotów (`6c4f1d6ae`), rzeczywiste
statystyki początkowe (`1d521d58b`) i forwarding liczby wątków Gmsh (`2fec5cb8e`).
Skróty są identyfikatorami pomocniczymi; pełną tożsamość tipów podano powyżej.

## 3. Prompty 1–7

| Prompt | Ocena audytu |
|---|---|
| 1 — demag | Praca źródłowa scalona do integracji; nie do badanego mastera jako cały pakiet. |
| 2 — RK/receipts | Praca źródłowa scalona; późniejsze poprawki snapshotów wymagają uwzględnienia nowszej tożsamości. |
| 3 — NCG/reductions | Praca źródłowa scalona; pełna kwalifikacja pozostaje zależna od Contract B. |
| 4 — preconditioner | Zintegrowany przez historyczny merge `5a5d9749f`; nie jest automatycznie zakwalifikowanym defaultem. |
| 5 — DG0 | Wykonany historycznie; plik podaje `c368f5ec85795bf21ad45ef269186ba7629dfc31`. A11 było osobnym zadaniem. |
| 6 — integrator | Konsolidacja wykonana częściowo; obecna rozbieżność z masterem i dirty WIP wykluczają końcowy odbiór. |
| 7 — independent verifier | Instrukcja odnosi się do starszego frozen SHA i snapshotu. Nie stanowi ACCEPT dla obecnego drzewa. |

Historyczne 28 native / 30 exact Rust jest przypisane w promptach do snapshotu
`35075dca50a42a7c65fa5e14964973ab529093d1ac32b0c44cd8fb35e19dd2b4`.
Nie należy mechanicznie wymagać tylko historycznej liczby testów: późniejszy
launcher rozszerzył zestaw, więc odbiór musi sprawdzać aktualną listę nazw,
wykonanie każdego testu i terminalną kontrolę source identity.

## 4. Najważniejsze luki i ryzyka

1. **A11 — niewystarczająca równoważność operatorów.** Dirty
   `exchange_upload.cpp::gpu_exchange_upload_legacy_sparse` dopuszcza cuSPARSE;
   `rk_exchange_dispatch.cu::gpu_rk_compute_legacy_sparse_exchange` wywołuje
   `plan.apply_xyz` i oddzielne skalowanie. Custom kernel sumuje różnice
   magnetyzacji, cuSPARSE zwykłe CSR. Równoważność algebraiczna zakłada
   zbilansowany diagonal; dokładność przy niemal jednorodnym stanie wymaga
   testu GPU. Dodane w dirty `gpu_sparse_apply_contract.cpp::main` fixture
   Laplacian i cancellation nie mają tutaj potwierdzonego wykonania.
2. **A11 — pomiar nie obejmuje rzeczywistego kosztu.**
   `sparse_apply_plan.cpp::SparseApplyPlan::Impl::benchmark_variant` mierzy
   generyczny CSR. Produkcyjny cuSPARSE exchange dodaje post-scale, podczas
   gdy custom ma skalowanie scalone. To nie jest kompletny benchmark exchange.
3. **Contract B.** Czysty branch witness nie dostarcza nowego commita ani
   w tym audycie odnalezionego zaakceptowanego refinement receipt. Oczekiwana
   odmowa kwalifikacji bez świadka jest testem negatywnym, nie zaliczeniem B.
4. **Tożsamość WIP.** Integracja ma zmiany viewportu, pięciu plików A11,
   `next-env.d.ts` i nieśledzony raport. Testy starszego binarium nie dowodzą
   poprawności nowego testu. W poprzednim odczycie binarium sparse nie miało
   nowej asercji; aktualny audit nie uruchamiał go ponownie.
5. **Nowszy master.** Nie nadpisywać jego poprawek: mixed native mesh handoff,
   runtime image resolution, propagacja exit code launchera, opublikowany port
   API, bootstrap/build paths, resolver storage i brak fabrykowanych energii
   obiektów. Ich zmiany dotykają tych samych rodzin plików co branch GPU.
6. **Pełna kwalifikacja.** SP4 smoke, canvas/WebGL ani zielony zestaw kontraktów
   nie zamykają A16. Potrzebne są właściwe tolerancje, surowe wyniki, convergence,
   parytet i porównywalny A/B, w tym wymagany benchmark 500×500×10 nm sinc-layer.

## 5. Macierz dowodów

| Warstwa | Dostępny dowód / ograniczenie |
|---|---|
| Git/source | Bieżące SHA, ancestry, cherry, dwustronny diff i dirty status; potwierdzone w audycie. |
| Kontrakty hostowe | Raport runtime z 09-09 podaje 492 passed, 1 skipped, 61 subtests. To zapis historyczny; nie wykonano ponownie całego zestawu. |
| Launcher/log validator | Poprzedni przebieg po migracji storage ma terminalny `build-status.json`, exit 0; nie jest testem GPU. |
| Managed FEM GPU | Historyczne kontrakty obecne w raportach; nowy kompletny receipt dla obecnego dirty WIP NOT VERIFIED. |
| Fizyka / CPU–GPU parity | NOT VERIFIED dla końcowego zakresu optymalizacji. |
| Performance A/B / Nsight | NOT VERIFIED dla całego końcowego operatora i końcowego źródła. |
| Browser/WebGL | Historyczny smoke GUI nie zamyka nowej poprawki badge ani fizyki solvera. |
| Release / merge | NOT READY: źródła rozbieżne, WIP, A11/B/A16 oraz brak końcowego odbioru. |
| FDM CPU / FDM GPU | Poza bezpośrednim zakresem audytu FEM; brak nowej deklaracji kwalifikacji. |

## 6. Zalecana kolejność dalszych prac

1. Uzgodnić właściciela dirty A11 w dwóch worktree i zachować oba diffy.
2. Odtworzyć RED/GREEN dokładności exchange na managed GPU; dopracować
   realizację cuSPARSE tak, aby zachować wymaganą dokładność fizyczną.
3. Mierzyć pełny operator, a następnie energię, PBC, maski i receipt accounting;
   autotuning nie może wybierać na podstawie nieporównywalnych kosztów.
4. Dostarczyć legalny accepted-refinement witness B i review A12 warm-start.
5. Zintegrować zmiany bieżącego mastera z zachowaniem jego kontraktów i testów.
   Przegląd objąć całym diffem, nie tylko końcowym commitem.
6. Zamrozić czysty kandydat, wykonać aktualny zestaw managed native/exact Rust,
   CPU/GPU physics/parity, convergence, A/B i wymagany browser proof.
7. Dopiero po niezależnym odbiorze promptu 7 przejść do PR/merge.

Źródła audytu: wskazane worktree, lokalne refy Git, katalog promptów
`docs/superpowers/plans/2026-09-05-fem-gpu-agent-prompts`, pakiet `naprawy/A01–A16`,
raport integracji i raport runtime. Nie zmieniono oryginalnego pakietu audytowego.

## 7. Końcowa kontrola audytu

Ponowny odczyt refów potwierdził niezmienione SHA mastera, integracji i brancha
tasks1–5 z tabeli 1. Plik raportu istnieje w głównym checkoutcie; nie jest
zacommitowany. Zakres zlecenia audytowego został wykonany; wniosek NOT READY
dotyczy implementacji i nie stanowi blokady oddania audytu.

Pełne identyfikatory nowszych zmian mastera dotyczących launcherów/storage:

| SHA mastera | Znaczenie przy przyszłej integracji |
|---|---|
| `8c147a9698764ca0613b87a321af8b7893c26478` | Obraz Compose zgodny z rozstrzygniętym runtime |
| `b1e88d6cca6cb760f44a2e59e4582342b12623bb` | Zachowanie kodów wyjścia podczas streamowania |
| `ff01d462816e5c6f107df9bded4da335d7e51278` | Opublikowany port Windows FEM w origin API |
| `5f950a6e31641fd51f315e101bb1af5e35a09fe5` | Bootstrap runtime i ścieżki builda kontenera |
| `8b3bbdfd58fb9659317eb5b583166ab8c20aa2d7` | Routing narzędzi przez managed storage |
| `b7f06eac2c280466d5c6c396af8e78819678a63b` | Wspólny resolver storage |

Kontrole użyte do porównania: `git rev-parse`, `git rev-list --left-right --count`,
`git merge-base`, `git cherry`, `git diff --shortstat`, `git diff --name-only`,
`git log master --not <branch>`, `git status --short` oraz ukierunkowane odczyty
źródeł. Żadna z nich nie zastępuje uruchomienia solvera ani pełnego code review.
