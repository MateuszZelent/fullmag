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
| S04 | Bounded Schur, bloki MFEM, nodalne Ms, osobna trasa K0/non-k0, diagnostyka residualu | R01/R02, skalowalny owner, gauge, rekonstrukcja pełnego układu, V2/V3/V9 | Częściowy, błąd algebraiczny |
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

Bieżące odczyty: Git status czysty przed aktualizacją; diff od bazy nie zawiera
apps/control-room ani implementacji GPU zadania. Główny checkout ma cudze
zmiany .gitignore i trzech submodułów. `python scripts/local_runner_cli.py
container-status`: exit 1, „Container profile allow-list mismatch”.
`gh auth status`: exit 1, nieważny token. Nie pobrano nowego wyniku joba,
więc historyczne queued/running nie są aktualnym dowodem żywego procesu.

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
