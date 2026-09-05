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


## Aktualizacja odbioru i stan domknięcia (2026-09-05, godz. 21:55)

### Status i tożsamość kodu

```yaml
inspection_code_sha: 99a94ad174de5c290bffda54ca9eec26aaf86744 # historyczny punkt inspekcji
candidate_code_sha: 3f3fffae31c574b668bab75b93d697020f0ac7ae # historyczny kandydat przed naprawą NCG/Rust
verified_code_sha: 95a1876ed496c757849707f599c418613b7db603 # zamrożony, zweryfikowany commit kodu
source_branch: codex/fem-gpu-tasks1-5-remediation
source_worktree: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation
source_snapshot_sha256: c32dd20a220b89a3632b2cc8dde3266023a67232ad9dd842c9f18a49c62707cd
code_commit_available_on_remote: LOCAL_ONLY # commity wyłącznie lokalne, brak push do origin
managed_native_contracts: VERIFIED # 6/6 PASS bez SKIP
managed_rust_contracts: VERIFIED # 28/28 exact testów PASS przez validator logów
windows_launcher_contracts: VERIFIED # 50/50 pytest PASS
ncg_cache_miss_hit: VERIFIED # krok 1 miss, krok 2 hit
ncg_natural_refinement: VERIFIED # rzeczywisty Armijo refinement na CUDA, refined=1, upper<=rhs
ncg_refinement_witness: exact-armijo-refinement (kRefinedWitnessMagnetization)
ncg_post_refinement_fresh_work: VERIFIED # krok 2: cache invalidation, miss=2, świeże pola/energie/demag
full_physics_qualification: NOT_VERIFIED # pozostaje do pełnej kwalifikacji SP4
performance_ab: NOT_VERIFIED # pozostaje do benchmarków po pracach agentów 4-5
agents_4_5_implementation_gate: READY # zwolniona dla prac implementacyjnych
```

### Odtwarzalny manifest środowiska i przebiegu

- **Zweryfikowany commit kodu:** `95a1876ed496c757849707f599c418613b7db603`
- **Stan źródeł:** Czysty (`git status` clean na commicie kodu)
- **Snapshot źródeł (`source_snapshot_sha256`):** `c32dd20a220b89a3632b2cc8dde3266023a67232ad9dd842c9f18a49c62707cd`
- **Obraz kontenera:** `fullmag/fem-gpu:windows-local-fem-gpu-tasks1-5-remediation-51bf95127d1e4473` (Image ID: `fd023e4a13ff`)
- **Biblioteka współdzielona:** `/workspace/.fullmag-build/contracts/fem-gpu-execution-receipt/backends/fem/libfullmag_fem.so`
- **Urządzenie fizyczne:** NVIDIA GeForce RTX 4080 SUPER (Compute Capability 8.9 / sm_89, Driver 591.86)
- **Precyzja:** FP64 (natywna podwójna precyzja FEM)
- **Toolchain:** CUDA 12.6.85, GCC 13.x (Linux container), rustc 1.100.0-nightly (0ed41eb41 2026-09-04)
- **Kanoniczna komenda weryfikacji:**
  `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts/windows/run_fullmag_fem.ps1" -BuildMode true -BuildOnly -Backend fem -Device gpu -Contract gpu-execution-receipt`
- **Kod wyjścia:** `0` (sukces wszystkich faz)
- **Ścieżki artefaktów JUnit XML i logów:**
  - `fem_gpu_execution_receipt_contract`: `fem_gpu_execution_receipt_contract.oIIPGE.xml`
  - `fem_demag_poisson_contract`: `fem_demag_poisson_contract.yl53PF.xml`
  - `fem_gpu_rk_device_controller_contract`: `fem_gpu_rk_device_controller_contract.wF8tUj.xml`
  - `fem_gpu_relaxation_preconditioner_contract`: `fem_gpu_relaxation_preconditioner_contract.RRmOiQ.xml`
  - `fem_cuda_periodic_demag_contract`: PASS (wykonanie natywne w kontenerze)
  - `fem_gpu_ncg_runtime_contract`: `fem_gpu_ncg_runtime_contract.TAodgU.xml`
  - Exact Rust logs (28 plików zwalidowanych przez `scripts/validate_exact_rust_test_log.py`):
    `C:\fullmag-build\fem-gpu-tasks1-5-remediation-51bf95127d1e4473\contracts\fem-gpu-execution-receipt\exact-rust.*.log`
  - Python launcher & validator tests: 50/50 PASS (`pytest scripts/test_validate_exact_rust_test_log.py scripts/test_windows_fullmag_launcher_contract.py -q -p no:cacheprovider`).

### Diagnoza i rozwiązanie braku refinementu NCG (Zadanie 1)

1. **Warunki produkcyjnej decyzji Refine:**
   Decyzja `ArmijoDifferenceDecision::Refine` w produkcji zachodzi wtedy i tylko wtedy, gdy:
   $$\Delta E + B_{\text{non-demag}} \le \text{armijo\_rhs\_j} < \Delta E + B_{\text{non-demag}} + B_{\text{demag}}$$
   gdzie $B_{\text{demag}} = \gamma_{512} \times \text{demag\_absolute\_term\_sum\_j} \approx 5.78 \times 10^{-34}\text{ J}$.
2. **Dlaczego dotychczasowe fixture nie osiągały Refine:**
   - 5 arbitralnych trajektorii w relaksacji badało kroki o silnym spadku energii, gdzie krok początkowy $\alpha_0 = 10^{-6}$ albo trafiał w głęboki spadek z $\Delta E \ll c_1 \text{chord}$ (margines rzędu $10^4$), albo odrzucał kandydata i wykonywał backtracking z podziałem kroku przez 2 (skok o 50%, przeskakujący wąskie okno numeryczne o szerokości względnej $10^{-10}$).
   - W module [`backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp) liczniki `GpuPerformanceCounterDelta` (`grad_perf`, `cand_perf`, `ref_perf`) pomijały pole `demag_solves`, przez co `physical_demag_solves` pozostawało równe 0 mimo rzeczywistego wykonania 4 rozwiązań Poissona na CUDA.
3. **Zastosowane poprawki:**
   - W [`backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp): wyodrębniono `non_demag_local_absolute`, dzięki czemu $B_{\text{demag}}$ poprawnie skaluje się z dokładnością solvera przy doprecyzowaniu.
   - W [`backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp): dodano zliczanie `demag_solves` do `grad_perf`, `cand_perf` i `ref_perf`.
   - W [`backends/fem/tests/gpu_ncg_runtime_contract.cpp`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/backends/fem/tests/gpu_ncg_runtime_contract.cpp): wprowadzono mały, deterministyczny, legalny świadek w precyzyjnych floatach hex (`kRefinedWitnessMagnetization`), na którym produkcyjny solver CUDA NCG na kroku 1 wchodzi w `Refine`, wykonuje 2 dodatkowe ewaluacje energii i demag (`physical_demag_solves = 4`), spełnia kanoniczny proof Armijo (`upper <= rhs`), a krok 2 udowadnia unieważnienie cache (`next_miss = 2`) i wykonanie świeżej pracy.

### Pełna weryfikacja Native + Rust (Zadanie 2)

- W [`crates/fullmag-plan/src/tests.rs`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/crates/fullmag-plan/src/tests.rs) skorygowano test `relaxation_rejects_zhang_li_slonczewski_sot_and_thermal`: dla bezpośrednich minimalizatorów ustawiono `dynamics = None`, co pozwoliło na prawidłowe przejście walidacji IR i właściwe przetestowanie odrzucenia niekonserwatywnych momentów przez planer.
- Recepta kontenerowa `verify-fem-gpu-execution-receipt-contract` przeszła w 100%:
  - **6/6 testów native CTest:**
    1. `fem_gpu_execution_receipt_contract`: PASSED
    2. `fem_demag_poisson_contract`: PASSED
    3. `fem_gpu_rk_device_controller_contract`: PASSED
    4. `fem_gpu_relaxation_preconditioner_contract`: PASSED
    5. `fem_cuda_periodic_demag_contract`: PASSED
    6. `fem_gpu_ncg_runtime_contract`: PASSED
  - **1 test fullmag-plan:** `tests::relaxation_rejects_zhang_li_slonczewski_sot_and_thermal` — PASSED
  - **3 testy fullmag-fem-sys:**
    - `tests::gpu_performance_snapshot_v2_has_stable_layout_and_symbol` — PASSED
    - `tests::gpu_execution_receipt_v2_has_stable_layout_and_symbol` — PASSED
    - `tests::gpu_performance_snapshot_v3_has_stable_layout_and_symbol` — PASSED
  - **24 testy fullmag-runner:** wszystkie 24 zwalidowane przez `validate_exact_rust_test_log.py` — PASSED
  - **50 testów pytest na hoście:** 50/50 PASSED.
- Bramka implementacyjna dla agentów 4 i 5 została zwolniona (**READY**).
