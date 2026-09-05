# Domknięcie odbioru agentów 1–3

Cel: usunąć potwierdzone blokady integracji i przekazać agentom 4+ jednoznaczny, sprawdzony punkt startowy. Nie jest to kwalifikacja produkcyjnej fizyki ani dowód przyspieszenia.

Punkt wejścia: `617031df0ad45b25ece6b0015836c71631c4f2d1`, branch `codex/fem-gpu-tasks1-5-remediation`, istniejący worktree `C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation`.

## Ograniczenia

- Zachować WIP `672bf44188052fe1a0ad1f42cd7188a196162906`, `.freebuff/` oraz niezwiązane zmiany. Bez push, master merge i usuwania worktrees/cache.
- Receipt v1 pozostaje niezmieniony. V2 rozróżnia obserwację stationary od zaakceptowanego kroku; obserwacja nie kwalifikuje wydajności. Nie dopisywać niewykonanych operatorów.
- Opcjonalne refinement nie może dopuścić brakujących wymaganych operatorów, nieznanych bitów, fallbacku ani niedozwolonych transferów.
- Istniejący kontrakt fizyki 0580 odrzuca STT/SOT podczas relaksacji. Nie rozszerzać legalności ani dodawać fikcyjnego dowodu wykonania momentów.
- Testy natywne i Rust przez kanoniczny kontenerowy `just`; GPU/buildy szeregowo. Test produkcyjnego NCG nie zastępuje benchmarku A/B.

## Kroki i weryfikacja

1. Receipt native/Rust: regresje stationary, refinement i negatywnych masek; następnie minimalna poprawka zgodna z zatwierdzonym projektem receipt v2/snapshot v3. Weryfikacja: RED/GREEN, istniejące ABI i finalizacja.
2. NCG A10/A14: test rzeczywistego kroku, cache miss→hit i ponownego użycia zaakceptowanej energii, z dowodem refinement jeżeli scenariusz je wykonuje. Weryfikacja: managed test, rzeczywiste liczniki i stan; brak dowodu jawnie niezaliczony.
   Regresja integracyjna ujawniła dodatkowo błędne wymiary prostokątnych operatorów demag przy P1 magnetyzacji/P2 potencjału. Naprawić metadane wymiarów RHS/recovery z istniejących przestrzeni, zachowując walidację CSR i stopień FE; ponowić ten sam test ABI.
3. PG-BB/STT/SOT: prześledzić istniejące odrzucenie planera i rozszerzyć regresję na wszystkie algorytmy relaksacji. Nie naprawiać zgodnego z kontraktem odrzucenia przez promocję GPU.
4. Zintegrować testy z receptą, przejrzeć diff i uruchomić pełne `just verify-fem-gpu-execution-receipt-contract` oraz testy launchera. Zero dopasowanych testów nie jest sukcesem.
5. Zapisać lokalne commity, końcowy wynik i SHA. Zaktualizować prompty 4–6 i harmonogram: 4/loader równolegle z 5/DG0 na osobnych worktrees, sparse A11 dopiero po agent4/preconditioner. Nie uruchamiać agentów kolejnej fali automatycznie.

## Stan

- Kroki 1–3: zaimplementowane w C1, C2, C3; receipt, periodic demag i cache miss->hit zweryfikowane na GPU; naturalny refinement NCG pozostaje NOT VERIFIED.
- Krok 4: bramka managed uruchamia pełny rygorystyczny zestaw, zatrzymana fail-closed na braku naturalnego refinementu NCG.
- Krok 5: prompty i raporty zaktualizowane ze statusem bramki BLOCKED.

## Dowody w trakcie wykonania

- Launcher: 37/37 PASS po dodaniu do recepty regresji planera i nowych testów Rust.
- Receipt RED: `just verify-fem-gpu-execution-receipt-contract`, native 3/4 PASS; receipt FAIL: `stationary current-state evaluation must accept its non-trial operator subset`. Końcowy kod just 1, kontener 8. Produkcja receipt w tym przebiegu odpowiadała punktowi wejścia; dodano testy regresyjne.
- Kontrakt STT/SOT już odrzucał relaksację w `crates/fullmag-plan/src/validate.rs::validate_conservative_relaxation`. Rozszerzono istniejący test na wszystkie cztery algorytmy; nie zmieniono legalności ani publicznego modelu.
- Recepta Rust: dodano `--lib` do dokładnych filtrów testów jednostkowych runnera, bez zmiany wyboru testów. RED regresji launchera: 1 FAIL/37 PASS; po korekcie 38/38 PASS. Pełny managed run nadal jest osobną bramką.
- Review wymaga obsługi rzeczywistego finalizera: `finalize.rs` wybiera CompletedAccepted także po końcowej obserwacji stationary, gdy wcześniejsze kroki zostały zaakceptowane. Nie wolno uznać za wystarczający wyłącznie test CompletedObservation od stanu początkowego.
- Następny managed run (sesja 58819): native 4/5 PASS; receipt GREEN. Produkcyjny test NCG potwierdził zwykły cache miss→hit, następnie odrzucił konstrukcję fixture demag przed refinement (`strict CUDA NCG fixture creation must succeed`). Just 1 / kontener 8; Rust jeszcze niewykonany. Nie kwalifikuje refinement.
- Niezależny review poprawki receipt nie znalazł blokerów. Review testu NCG wymaga poprawnego sprawdzenia kanonicznego proof Armijo (bez utożsamiania z odejmowaniem endpointowych energii), legalnych tolerancji demag oraz fizycznych liczników po invalidation; poprawki w toku.
- Run 24482 zatrzymał się na błędzie kompilacji nowej asercji (przecinek zamiast `&&`); poprawiono. Nie jest zaliczonym buildem ani testem runtime.
- Run 1672 po korekcie asercji: native 4/5 PASS, zwykły NCG miss→hit PASS; create demag odrzucone z `failed to setup demag recovery sparse apply plan: sparse apply CSR column index exceeds the operator dimensions`. Odczyt `operators.cpp::upload_demag_poisson_operators` potwierdził użycie rows także jako cols dla RHS i recovery. Poprawka metadanych w toku; nie usuwamy kontroli bounds. Zmiana solvera CG na GMRES nie usuwała błędu; fixture ponownie używa CG/NONE.

## Aktualny odbiór (2026-09-05)

### Tożsamość i manifest statusu

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

### Stan realizacji i macierz weryfikacji

Poprawki z planu naprawy zostały zaimplementowane i podzielone na trzy lokalne commity:
- C1: `0694cd661c76efc42e9cba7852bf460082a7d172`: strict managed gate (`CMakeLists.txt`, `run_fullmag_fem.ps1`, `validate_exact_rust_test_log.py`, testy launchera i walidatora logów).
- C2: `7ba57890e0acd83ffbef0dff6078bdf39678c8bc`: receipt closure regressions (`execution_receipt.rs`, `gpu_execution_receipt_contract.cpp`).
- C3: `596dc3f32b3b4ab1ba57a48c68bde9f115e4f85a`: NCG proof closure (`gpu_ncg_runtime_contract.cpp`).

| ID | Wymaganie / kontrakt | Wynik | Szczegóły dowodu |
|---|---|---|---|
| R01 | Stationary omija operatory próby | VERIFIED | Regresje maszyn stanów w `gpu_execution_receipt_contract` PASS |
| R02 | CompletedAccepted po stationary zachowuje maskę | VERIFIED | Native aggregation test PASS |
| R03 | Stationary bez accepted jako CUDA w mapperze | VERIFIED | Unit test `strict_v2_runtime_accepts_stationary_ncg_without_accepted_steps` PASS |
| R04 | Ochrona KNOWN_MASK w samodzielnym walidatorze Rust | VERIFIED | `validate_strict_fem_gpu_execution_receipt_v2_runtime` odrzuca bity > 15; testy PASS |
| D01 | Prostokątne wymiary RHS/recovery demag | VERIFIED | Upload operatorów i wymiary P1/P2 poprawne; `fem_demag_poisson_contract` PASS |
| D02 | Regresja periodic demag w aggregate target i launcherze | VERIFIED | `fem_cuda_periodic_demag_contract` w suite, PASS w kontenerze |
| N01 | NCG cache miss → hit | VERIFIED | `check_ncg_endpoint_cache_miss_then_hit` PASS na urządzeniu CUDA (miss na kroku 1, hit na kroku 2) |
| N02 | Naturalny Armijo refinement | NOT_VERIFIED | Żadna z 5 trajektorii nie weszła w doprecyzowanie (kandydaci akceptowani natychmiast, `upper <= rhs`); test zakończony `FAIL: no legitimate CUDA demag NCG fixture entered production Armijo refinement` |
| N03 | Invalidation i świeża praca po refinement | NOT_VERIFIED | Zablokowane brakiem świadka N02 |
| N04 | Sprawdzenie skończoności energii (`std::isfinite`) | VERIFIED | Asercje dodane w `check_snapshot_energy_matches_observation` |
| P01 | STT/SOT/thermal odrzucone w konserwatywnej relaksacji | VERIFIED | Test planera dla 4 algorytmów PASS |
| V01 | Fail-closed SKIP CUDA | VERIFIED | Launcher JUnit odrzuca `SKIP:`, CTest z serializacją i `--no-tests=error` |
| V02 | Exact Rust log validation | VERIFIED | `validate_exact_rust_test_log.py` z testami jednostkowymi (9/9 pytest PASS) |
| V03 | Sprawdzony SHA kodu | PARTIALLY_VERIFIED | C1, C2, C3 zapisane lokalnie; bramka BLOCKED z powodu N02 |
| H01 | Zależności promptów 4–6 | BLOCKED | Prompty zaktualizowane do wskazania zablokowanej bramki |

Wyniki testów:
- Host launcher pytest: `scripts/test_validate_exact_rust_test_log.py` 9/9 PASS, `scripts/test_windows_fullmag_launcher_contract.py` 41/41 PASS.
- Managed container native CTest (5/6 PASS):
  - `fem_gpu_execution_receipt_contract`: PASSED
  - `fem_demag_poisson_contract`: PASSED
  - `fem_gpu_rk_device_controller_contract`: PASSED
  - `fem_gpu_relaxation_preconditioner_contract`: PASSED
  - `fem_cuda_periodic_demag_contract`: PASSED
  - `fem_gpu_ncg_runtime_contract`: FAILED (krok miss->hit przeszedł; brak naturalnego refinementu w 129 krokach trajektorii).
