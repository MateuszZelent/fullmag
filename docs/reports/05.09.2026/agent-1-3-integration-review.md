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


## Aktualizacja odbioru i stan domknięcia (2026-09-05, godz. 17:55)

### Status i tożsamość kodu

```yaml
inspection_code_sha: 99a94ad174de5c290bffda54ca9eec26aaf86744
candidate_code_sha: 596dc3f32b3b4ab1ba57a48c68bde9f115e4f85a
verified_code_sha: NOT_VERIFIED
source_branch: codex/fem-gpu-tasks1-5-remediation
source_worktree: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation
source_snapshot_sha256: NOT_RECORDED
code_commit_available_on_remote: LOCAL_ONLY
managed_native_contracts: PARTIALLY_VERIFIED
managed_rust_contracts: NOT_RUN
windows_launcher_contracts: VERIFIED
ncg_cache_miss_hit: VERIFIED
ncg_natural_refinement: NOT_VERIFIED
ncg_refinement_witness: NOT_RECORDED
ncg_post_refinement_fresh_work: NOT_VERIFIED
full_physics_qualification: NOT_VERIFIED
performance_ab: NOT_VERIFIED
agents_4_5_implementation_gate: BLOCKED
```

### Zakres wdrożonych poprawek i regresji

1. **Strict managed gate (commit C1: `0694cd661c76efc42e9cba7852bf460082a7d172`):**
   - Dodano `fem_cuda_periodic_demag_contract` do zestawu aggregate target `fem_gpu_execution_receipt_contract_suite` w `backends/fem/CMakeLists.txt`.
   - Zastąpiono blok receiptu w launcherze `scripts/windows/run_fullmag_fem.ps1` literalnym blokiem wymuszającym `-Device gpu`, `FULLMAG_REQUIRE_CUDA_CONTRACTS=1`, `FULLMAG_NCG_RUNTIME_DEVICE=cuda`, serializację CTest (`--parallel 1 --no-tests=error`) oraz walidację raportów JUnit XML pod kątem `skipped`, `failure`, `error` i obecności `SKIP:` w logach.
   - Wdrożono skrypt `scripts/validate_exact_rust_test_log.py` i jego regresje `scripts/test_validate_exact_rust_test_log.py` (9/9 pytest PASS).
   - Rozszerzono `scripts/test_windows_fullmag_launcher_contract.py` o testy obecności periodic demag, wymogu CUDA, serializacji CTest, walidacji JUnit i odnajdywania 24 dokładnych filtrów Rust runnera (41/41 pytest PASS).

2. **Receipt v1/v2 i domknięcie stanów (commit C2: `7ba57890e0acd83ffbef0dff6078bdf39678c8bc`):**
   - Zachowano niezmienione publiczne ABI v1.
   - Dodano niezależną ochronę `KNOWN_OPERATOR_MASK_V2` ((1 << 16) - 1) w `validate_strict_fem_gpu_execution_receipt_v2_runtime` w `crates/fullmag-runner/src/fem/execution_receipt.rs`.
   - Wdrożono 3 unit testy w Rust: akceptacja stationary NCG bez accepted steps, odrzucenie nieznanych bitów operatorów oraz odrzucenie bitu refinementu dla PG-BB.
   - Dodano regresje maszyny stanów w `backends/fem/tests/gpu_execution_receipt_contract.cpp`: izolacja generacji (brak przenoszenia dowodów operatorów ze starej generacji) oraz ochrona przed rozszerzaniem zatwierdzonej maski przez nieważną próbę.

3. **NCG proof closure i poszukiwanie refinementu (commit C3: `596dc3f32b3b4ab1ba57a48c68bde9f115e4f85a`):**
   - W `backends/fem/tests/gpu_ncg_runtime_contract.cpp` dodano asercje `std::isfinite` na energii snapshotu i torqu.
   - Rozszerzono `check_device_execution` o pełną walidację receiptu: `execution_class == DeviceResident`, `fallback_count == 0`, brak transferów compute/exchange na hosta, zgodność masek `required == resolved == executed & required`.
   - Zaimplementowano funkcję `try_ncg_refinement_trajectory_case` przeszukującą do 128 kolejnych kroków relaksacji NCG pod kątem naturalnego świadka doprecyzowania Armijo z badaniem świeżej pracy (cache miss, świeże pola/energie/demag) na kolejnym kroku.
   - Wprowadzono fail-closed `main()` wymagający realnego urządzenia CUDA w trybie managed.

### Wyniki uruchomienia w kontenerze i stan bramki

W managed runie w kontenerze (`fullmag-fem-runtime-dev`):
- `fem_gpu_execution_receipt_contract`: PASSED
- `fem_demag_poisson_contract`: PASSED (potwierdzone prostokątne wymiary RHS i recovery)
- `fem_gpu_rk_device_controller_contract`: PASSED
- `fem_gpu_relaxation_preconditioner_contract`: PASSED
- `fem_cuda_periodic_demag_contract`: PASSED (obie orientacje siatki demag)
- `fem_gpu_ncg_runtime_contract`:
  - `check_ncg_endpoint_cache_miss_then_hit()`: PASSED (miss na kroku 1, hit na kroku 2, oszczędność ewaluacji energii i brak zbędnego apply pola).
  - `check_ncg_refined_energy_reuse()`: FAILED CLOSED na asercji `no legitimate CUDA demag NCG fixture entered production Armijo refinement`.
    Wszystkie 5 badanych fizycznych trajektorii NCG (129 wykonanych kroków) w każdym kroku natychmiast spełniało warunek akceptacji Armijo (`upper <= rhs`, z krokiem energetycznym `delta ~ -8.3e-31 J` znacznie bardziej ujemnym niż `rhs ~ -8.8e-35 J`). W żadnym kroku kandydat nie znalazł się w wąskim przedziale niepewności numerycznej demag `[delta - bound, delta + bound]` wymaganym do wyzwolenia decyzji `Refine`.

Zgodnie z sekcją 5.6 i 11 planu naprawy:
- Nie wprowadzono sztucznego przełącznika "force refinement" ani nie rozluźniono warunków testu.
- Końcowy błąd został zachowany zgodnie z zasadą fail-closed.
- Status punktu N02 pozostaje **NOT VERIFIED**.
- Faza Rust nie została uruchomiona z powodu fail-closed przerwania CTest; jej status to **NOT RUN**.
- Bramka implementacyjna agentów 4–5 pozostaje **BLOCKED**.
