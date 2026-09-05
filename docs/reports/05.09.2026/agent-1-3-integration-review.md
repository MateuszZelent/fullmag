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


## Aktualizacja odbioru i stan domknięcia (2026-09-05, rewizja numeryczna Armijo refinement)

### Status i tożsamość kodu

```yaml
inspection_code_sha: 2a1671a085a66583d759cfd962380b6e4eef28f0 # HEAD przed audytem skalowania Armijo
flawed_scaling_commit_sha: 95a1876ed496c757849707f599c418613b7db603 # commit zawierający nieuzasadnione skalowanie rtol
source_branch: codex/fem-gpu-tasks1-5-remediation
source_worktree: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation
code_commit_available_on_remote: LOCAL_ONLY # commity wyłącznie lokalne, brak push do origin
managed_native_contracts: PARTIALLY_VERIFIED # 5/6 PASS; fem_gpu_ncg_runtime_contract zatrzymany na asercji akceptacji świadka
managed_rust_contracts: VERIFIED # 28/28 exact testów PASS w zestawie ABI/runner
windows_launcher_contracts: VERIFIED # 50/50 pytest PASS
ncg_cache_miss_hit: VERIFIED # krok 1 miss, krok 2 hit na urządzeniu CUDA
ncg_armijo_refinement_execution: VERIFIED # wejście w refinement, 6 fizycznych rozwiązań Poissona na CUDA, kanoniczne odrzucenie nierozstrzygniętego kandydata
ncg_accepted_refinement_witness: NOT_VERIFIED # asercja rejected=0 nieosiągalna na 1 czworościanie bez sztucznego tłumienia granicy błędu
full_physics_qualification: NOT_VERIFIED # pozostaje do pełnej kwalifikacji fizycznej (np. SP4)
performance_ab: NOT_VERIFIED # pozostaje do benchmarków po pracach optymalizacyjnych
agent_4_gate: READY # zwolniona dla prac implementacyjnych loadera i preconditionera (A05/A06/A09)
agent_5_gate: BLOCKED # A11 zablokowany do integracji sparse przez agenta 4; wyłącznie DG0/A13 dozwolone równolegle
agent_7_gate: PROPOSED # rola niezależnego weryfikatora/audytora pozostaje propozycją do zatwierdzenia
```

### Diagnoza błędu numerycznego i rewizja Armijo refinement

1. **Przyczyna problemu w commicie `95a1876ed`:**
   - Granica błędu zaokrągleń `demag_roundoff_bound_j` jest obliczana jako $B = \gamma_N \sum |x_i|$, gdzie $\gamma_N = \frac{N \varepsilon_{\mathrm{mach}}}{1 - N \varepsilon_{\mathrm{mach}}}$. Jest to ścisła granica błędu sumowania zmiennoprzecinkowego IEEE 754 dla redukcji $N$ składników na GPU.
   - Granica ta **nie jest** oszacowaniem błędu algebraicznego iteracyjnego solvera Poissona. Zależy wyłącznie od liczby składników redukcji i precyzji maszynowej.
   - W commicie `95a1876ed` wprowadzono skalowanie:
     `refined_demag_bound = ordinary_demag_bound * (refined_rtol / ordinary_rtol);`
     oraz odjęcie różnicy od `difference.roundoff_bound_joules`. Redukowało to certyfikat błędu o 90% (dla `refined_rtol = 0.1 * ordinary_rtol`), sztucznie wymuszając akceptację kroku refinementu. Operacja ta nie miała żadnego uzasadnienia numerycznego i maskowała nierozstrzygnięte przedziały.

2. **Minimalna poprawka numeryczna:**
   - W [`backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp) usunięto sztuczne skalowanie `ordinary_demag_bound * (refined_rtol / ordinary_rtol)` i odejmowanie od `roundoff_bound_joules`.
   - Zabezpieczono kolejność odczytów snapshotów: `ordinary_difference`, `ordinary_trial` oraz `ordinary_demag_bound` są utrwalane **przed** wywołaniem doprecyzowanego `direct_difference`.
   - W przypadku odrzucenia doprecyzowanego kandydata stan `result.difference`, `result.trial_snapshot` oraz `result.demag_roundoff_bound_j` jest w pełni przywracany do wartości zwykłych, zapobiegając kontaminacji stanu.
   - Zaktualizowano notę naukową [`docs/physics/0580-canonical-relaxation-equilibrium-contract.md`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/docs/physics/0580-canonical-relaxation-equilibrium-contract.md) (sekcje 2.3.2 i 3.2), formalizując niezmienniczość certyfikatu błędu redukcji względem tolerancji solvera oraz zasadę, że nierozstrzygnięty przedział jest odrzucany.

3. **Regresja numeryczna niezmienniczości certyfikatu błędu:**
   - W [`backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp`](file:///C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation/backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp) dodano funkcję `check_direct_armijo_refinement_roundoff_invariance_and_unresolved_rejection()`:
     - wykazuje, że zaostrzenie tolerancji solvera nie zmniejsza certyfikatu zaokrągleń dla niezmienionych operandów;
     - sprawdza, że zwykły przedział nakładający się na próg Armijo generuje decyzję `Refine`;
     - dowodzi, że gdy doprecyzowany przedział nadal nakłada się na próg Armijo, `strict_armijo_difference_refinement_accepts` ściśle zwraca `false` (odrzucenie);
     - potwierdza, że sztuczne skalowanie tolerancją prowadziłoby do nielegalnej, fałszywej akceptacji;
     - weryfikuje asercjami źródłowymi brak skalowania rtol i poprawność przywracania stanu w `direct_energy_increment.cpp`.
   - Test CTest #31 (`fem_gpu_relaxation_preconditioner_contract`) przeszedł pomyślnie w kontenerze (**PASS**, 0.64s).

4. **Diagnoza re-testu NCG Armijo refinement:**
   - Ponowiono test `try_ncg_refinement_case` z poprawnym certyfikatem błędu.
   - Odczyt telemetrii z wykonania na karcie RTX 4080 SUPER:
     - `ord_delta = -2.585623627344309e-24 J`
     - `ref_delta = -2.585623627344309e-24 J`
     - `diff_delta = 0.0 J`
     - `ord_bound = 1.4551576162941577e-33 J`
     - `ref_bound = 1.4551576162941577e-33 J`
     - `rhs = -2.5856236265648023e-24 J`
     - Liczniki NCG: `ref_count = 1`, `misses = 1`, `cand = 2`, `rej = 1`, `demag_solves = 6`.
   - **Faktyczny przebieg:** Kandydat 1 wszedł w procedurę refinementu (`ref_count = 1`). GPU wykonało świeże obliczenia pól i energii z zaostrzoną tolerancją (`demag_solves = 6`). Na pojedynczym czworościanie (układ $4 \times 4$) solver CG zbiega do precyzji maszynowej w $\le 4$ iteracjach, więc $\Delta E_{\mathrm{refined}} \equiv \Delta E_{\mathrm{ordinary}}$ co do bitu.
   - Przedział po doprecyzowaniu nadal nakłada się na próg Armijo ($\Delta E_{\mathrm{refined}} + B > \mathrm{rhs}$). Zgodnie z kanonicznym kontraktem nierozstrzygnięty kandydat został bezpiecznie i prawidłowo odrzucony (`rej = 1`).
   - NCG wykonał backtracking do kandydata 2 (`cand = 2`), który spełnił warunek Armijo i krok zakończył się sukcesem (`stats.step = 1`).
   - Asercja w teście wymagała jednak `accepted_armijo_candidates == 1u && rejected_candidate_count == 0u` (wymóg, aby to kandydat 1 został zaakceptowany przez refinement bez odrzucenia).
   - Wymóg ten na jednoelementowej siatce bez sztucznego tłumienia błędu jest matematycznie nieosiągalny. Zgodnie z AGENTS.md status zaakceptowanego świadka refinementu został rzetelnie oznaczony jako **NOT VERIFIED**.

5. **Ograniczenia powtarzalności świadka między środowiskami:**
   - Świadek `kRefinedWitnessMagnetization` celuje w przedział numeryczny o szerokości $B \approx 10^{-33}\text{ J}$, co stanowi ułamek $10^{-9}$ energii kroku.
   - Wartości sum redukcji i energii na poziomie pojedynczych ULP zależą od architektury GPU, optymalizacji FMA kompilatora nvcc i porządku redukcji w blokach.
   - Świadek w postaci zahardkodowanych wartości hex-float nie jest powtarzalny między różnymi środowiskami i kompilatorami i nie może stanowić uniwersalnego testu produkcyjnego.

6. **Status handoffu i podział ról agentów:**
   - **Agent 4:** BRAMKA ZWOLNIONA (**READY**) dla implementacji jawnego loadera profilu, optymalizacji pamięci i redukcji preconditionera (zadania A05/A06/A09). Agent 4 pracuje w osobnym worktree i nie zakłada produkcyjnej kwalifikacji fizyki.
   - **Agent 5:** BRAMKA **BLOCKED** dla zadania A11 (integracja rzadkich operatorów demag/exchange) do czasu ukończenia, przetestowania i zintegrowania prac Agenta 4. Wybiórczo dozwolone równolegle są wyłącznie niezależne zadania DG0/A13 na osobnym worktree.
   - **Agent 7:** Proponowana rola niezależnego audytora/weryfikatora pozostaje do zatwierdzenia przez użytkownika.
