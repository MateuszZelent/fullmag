# Odbiór agentów 1–3 i porządek integracji FEM GPU

Data: 2026-09-05. Raport wewnętrzny; nie jest kwalifikacją wydajności ani publikacją fizyki.

## Git i granice operacji

Kanoniczny worktree: `C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation`.
Branch: `codex/fem-gpu-tasks1-5-remediation`.

Commit poprawek review: `4ddd9bb6209042c99b75bde35b1d6d92c12df22b`. To lokalny punkt dalszego przeglądu, nie release-qualified baseline.

| Zbiór | Pełny SHA | Wynik |
|---|---|---|
| Agent 1 | `bfcad041f2d1162baee37db45751adc2b4f65f9e` | Lokalnie scalony |
| Agent 2, końcowy wariant | `0a925b87949f1c553ad4f7eb686ecaced53864b2` | Lokalnie scalony |
| Agent 3 | `17e701f8a22f2def9c69ef8db27635b72453a872` | Lokalnie scalony |
| Merge finalnego agenta 2 z agentem 3 | `27f7feede57d3669f5d93d03b92443bf24ac5483` | Zachowano kontrolny readback i accepted-energy snapshot |
| Merge agenta 1 | `307ef39994df4c6ca14dbe564afc33154af1942a` | Wspólny punkt integracji, jeszcze nie kwalifikacja |
| WIP przed integracją | `672bf44188052fe1a0ad1f42cd7188a196162906` | 15 zmienionych plików zabezpieczone, nie scalone |

WIP znajduje się na `codex/fem-gpu-pre-integration-wip-20260905`. Użytkownik potwierdził zatrzymanie innych edytujących agentów przed zabezpieczeniem. Nie usunięto `.freebuff/`, starych worktrees ani niezwiązanych zmian na masterze. Nie wykonano push ani merge do master.

Agent 3 zawierał wcześniejszy wariant agenta 2 (`409544f91a9b06445418c40e348ef98be216e8a2`), a nie jego końcowy HEAD. Proste uznanie agenta 2 za już zintegrowanego zgubiłoby poprawki. Konflikt `rk_step_stats.cu` rozstrzygnięto na rzecz kontrolnego readbacku (`true`) razem z argumentem `accepted_energy`. Zachowano także finalne asercje receiptu w `frozen_spins_contract.cpp`.

## Ustalenia review

| Obszar i źródło | Ustalenie / decyzja |
|---|---|
| `core/demag_linear_solve_validation.hpp` → `DemagLinearSolveResult`; CPU `demag_poisson_hypre.cpp` → `solve_demag_poisson_hypre` | Domyślne L2/recursive maskowały brak metadanych. CPU Hypre PCG także musi jawnie wybrać L2. Dodano jawne metadane callerów i fail-closed defaults. |
| `gpu/cuda/integrators/rk/rk_output_control.cu` → `commit_candidate` | Absolutna tolerancja czasu 1e-11 s była nieadekwatna do kroków femtosekundowych. Token wymaga dokładnego endpointu obliczonego jako current_time + dt. |
| `gpu/cuda/integrators/rk/rk_attempt_loop.cu` → `gpu_rk_run_accepted_attempt_loop` | Ignorowano wynik publikacji decyzji przez cudaMemcpyAsync. Wprowadzono sprawdzenie statusu i ścieżkę błędu przed publikacją slotu. |
| `gpu/cuda/runtime/execution_receipt.cpp` → `gpu_execution_receipt_resolve_plan` | RK ma hostową kontrolę ograniczonych skalarów; DEVICE_CONTROL nie opisuje rzeczywistego wykonania. |
| `cpu/mfem/runtime/backend_step.cpp` → wywołanie PG-BB | Post-hoc maski z konfiguracji i bezwarunkowe accepted candidate nie są dowodem uruchomienia operatorów. Instrumentacja musi pochodzić z rzeczywistych punktów PG-BB. |
| `gpu/cuda/relaxation/nonlinear_cg.cpp` → historia previous_preconditioned_gradient | Nie potwierdzono zgłaszanego dodatkowego błędu rollbacku: zapis bieżącego z poprzedza następny istotny odczyt. Nie dodano zbędnego backupu. |
| `gpu/cuda/integrators/rk/rk_step.cu` → wybór graph fallback | Nie potwierdzono aktywnego produkcyjnego capture/launch workflow; nie naprawiano hipotetycznej ścieżki przez wymyślone dt/API. |
| `tests/gpu_relaxation_preconditioner_contract.cpp` → testy A10/A14 | Ręcznie skonstruowane liczniki i source assertions nie uruchamiają produkcyjnego cache miss→hit ani refined-Armijo reuse. Potrzebny test właściwego kroku NCG. |
| `scripts/windows/run_fullmag_fem.ps1` → gpu-execution-receipt | Nieistniejący filtr Rust receipt_v2_and_snapshot_v3_serialize_every_native_field kończył się sukcesem z 0 testami. Zastąpiono go dwoma rzeczywistymi testami i dodano regresję nazw. |

Ścieżki backendowe w tabeli są względne do `backends/fem/`.

## Granice dowodu

- Testy launchera: `python -B -m pytest scripts/test_windows_fullmag_launcher_contract.py -q -p no:cacheprovider` — 37 PASS, exit 0.
- Na niezmienionym branchu agenta 3 uruchomiono `just verify-fem-gpu-execution-receipt-contract`: natywna biblioteka CUDA i `fem_gpu_execution_receipt_contract` zbudowane, kontrakt natywny PASS. Historyczny błędny filtr ujawniony podczas tego uruchomienia nie jest zaliczony jako test.
- Starszy run agenta 3 został celowo zatrzymany po przejściu części kontraktów, po uruchomieniu weryfikacji scalonego kodu. Końcowy status: Docker 137 / just 1 wskutek zatrzymania, nie pełny PASS i nie ustalenie OOM. Nie zaliczać nieukończonej części Rust.
- Obraz tego uruchomienia: `fullmag/fem-gpu:windows-local-fem-gpu-agent3-ncg-reductions-774c1f6ae41d3df9`, manifest SHA256 `7a109b08d2b6210877b5983df793d834e43014698baf6789b80ef8b734a3e6f8`.
- Build kontraktu agenta 3: `C:/fullmag-build/fem-gpu-agent3-ncg-reductions-774c1f6ae41d3df9/contracts/fem-gpu-execution-receipt`; wynik natywny w `backends/fem/Testing/Temporary/LastTest.log` pod tym katalogiem.
- Wynik agenta 3 nie kwalifikuje późniejszych merge ani poprawek. Aktualny launcher rozszerza tę samą managed bramkę o `fem_demag_poisson_contract`, `fem_gpu_rk_device_controller_contract` i `fem_gpu_relaxation_preconditioner_contract`.
- Produkcyjna fizyka, CPU/GPU parity i przyspieszenie end-to-end: **NOT VERIFIED**. Nie wykonano porównywalnego A/B ani pełnej macierzy kwalifikacji.

Pierwszy zintegrowany run zakończył się 3/4 PASS: błąd asercji źródłowej demag (brak prefiksu `result.` w oczekiwanym tekście) skorygowano. Następny ponownie dał 3/4 PASS i ujawnił status 1 przy ustawianiu normy PCG po wcześniejszych próbach. Setter hypre zwraca globalny sticky error flag, nie wyłącznie wynik bieżącego przypisania; zob. [źródło hypre: hypre_PCGSetTwoNorm](https://github.com/hypre-space/hypre/blob/master/src/krylov/pcg.c). Dodano czyszczenie wyłącznie na początku nowej transakcji setup CPU, przed jej operacjami, tak aby zachować błędy bieżącego setupu. Nie usunięto kontroli statusu samego settera.

Stationary-only observation wymaga osobnej bramki receiptu: w opisanym SHA native i Rust wymagają pełnej maski operatorów. Korekta dalszego odczytu: runtime validator v2 wymaga zaakceptowanego kroku tylko dla CompletedAccepted, natomiast mapper v2 ukrywa executed przy accepted_step_count=0. Nie wolno obchodzić tych luk przez dopisywanie nieuruchomionego line-search lub fikcyjnego kroku. Bez spójnego kontraktu native/Rust taki wynik ma pozostać niezakwalifikowany.

Dodatkowe blokady odbioru: NCG publikuje opcjonalny bit `FEM_GPU_OPERATOR_DIRECT_ENERGY_REFINEMENT` w `nonlinear_cg.cpp`, podczas gdy plan nie zawiera go w required mask, a walidator wymaga dokładnej równości. Ścieżka refinement wymaga naprawy/testu kontraktu przed kwalifikacją. Nowa instrumentacja PG-BB raportuje refinement odrębnym istniejącym licznikiem, bez dokładania tego bitu do sztywnej maski. PG-BB nie wykonuje LLG direct-torque RHS; przy żądaniu STT/SOT nie wolno dopisywać tego operatora do executed mask, aby zadowolić plan. Korekta po prześledzeniu publicznego callera: decyzja legality już istnieje — `crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation` odrzuca takie żądanie dla relaksacji zgodnie z `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`, sekcja 2.4. Nie jest to brakująca funkcja GPU do dodania.

## Dalsza praca

Końcowy wynik tej sesji: natywne kontrakty RK controller, preconditioner, execution receipt i demag Poisson **4/4 PASS** (4.77 s); testy ABI performance v2, receipt v2, performance v3 **3/3 PASS**; launcher **37 PASS**. Po tej części celowo zatrzymano kontener podczas kompilacji Rust runnera; pełna recepta zakończyła się Docker 137 / just 1 i **nie jest zaliczona jako całość**. Wszystkie uruchomione w tej sesji kontenery testowe zakończono; nie pozostawiono kwalifikacji w tle.

Log ostatnich 4 testów: `C:/fullmag-build/fem-gpu-tasks1-5-remediation-51bf95127d1e4473/contracts/fem-gpu-execution-receipt/backends/fem/Testing/Temporary/LastTest.log`.
Biblioteka z tego builda: `C:/fullmag-build/fem-gpu-tasks1-5-remediation-51bf95127d1e4473/contracts/fem-gpu-execution-receipt/backends/fem/libfullmag_fem.so`, SHA256 `ec7f9cc0a3abf03840d3a9b36a7b67b964eaded24cc9b7824e1bb742d9fa331c`.
Testowano zmiany robocze następnie zapisane w commicie powyżej, nie czysty source-pinned run po commicie. Agent 6 ma powtórzyć pełną bramkę na zamrożonym SHA.

Obowiązuje [README promptów](../../superpowers/plans/2026-09-05-fem-gpu-agent-prompts/README.md), szczególnie:

1. Odbiór poprawek review i zamrożenie pełnego SHA z wynikiem managed testów.
2. Agent 4: jawny loader profilu bez automatycznej kwalifikacji tokenem; równolegle agent 5: tylko DG0/A13.
3. Po integracji i bramce poprawności agent 4: A05/A06/A09. Dopiero po przekazaniu sparse agent 5: A11.
4. Pozostają A07/A08, A12, produkcyjne testy A10/A14 i A16. Nie utożsamiać ukończenia agentów 1–3 z ukończeniem wszystkich punktów A01–A16.

Z WIP można odzyskiwać wyłącznie wybrane, ponownie przejrzane i przetestowane zmiany. Rozpoznanie none/diagonal/cg4/cg8 nie jest dowodem kwalifikacji operatora.
