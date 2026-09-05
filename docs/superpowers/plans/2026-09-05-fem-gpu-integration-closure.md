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

## Aktualny odbiór (2026-09-05, godz. 21:55)

### Tożsamość i manifest statusu

```yaml
inspection_code_sha: 99a94ad174de5c290bffda54ca9eec26aaf86744 # historyczny punkt inspekcji
candidate_code_sha: 3f3fffae31c574b668bab75b93d697020f0ac7ae # historyczny kandydat przed naprawą NCG/Rust
verified_code_sha: 95a1876ed496c757849707f599c418613b7db603 # zamrożony, zweryfikowany commit kodu
source_branch: codex/fem-gpu-tasks1-5-remediation
source_worktree: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation
source_snapshot_sha256: c32dd20a220b89a3632b2cc8dde3266023a67232ad9dd842c9f18a49c62707cd
code_commit_available_on_remote: LOCAL_ONLY
managed_native_contracts: VERIFIED
managed_rust_contracts: VERIFIED
windows_launcher_contracts: VERIFIED
ncg_cache_miss_hit: VERIFIED
ncg_natural_refinement: VERIFIED
ncg_refinement_witness: exact-armijo-refinement (kRefinedWitnessMagnetization)
ncg_post_refinement_fresh_work: VERIFIED
full_physics_qualification: NOT_VERIFIED
performance_ab: NOT_VERIFIED
agents_4_5_implementation_gate: READY
```

### Stan realizacji i macierz weryfikacji

Poprawki z planu naprawy zostały zaimplementowane i zwalidowane w kontenerze:
- C1 (`0694cd661c76efc42e9cba7852bf460082a7d172`) oraz `3f3fffae31c574b668bab75b93d697020f0ac7ae`: strict managed gate.
- C2 (`7ba57890e0acd83ffbef0dff6078bdf39678c8bc`): receipt closure regressions.
- C3 (`596dc3f32b3b4ab1ba57a48c68bde9f115e4f85a`): NCG proof closure.
- C4 (`95a1876ed496c757849707f599c418613b7db603`): NCG Armijo refinement closure, demag solves accounting i korekta dynamiki planera.

| ID | Wymaganie / kontrakt | Wynik | Szczegóły dowodu |
|---|---|---|---|
| R01 | Stationary omija operatory próby | VERIFIED | Regresje maszyn stanów w `gpu_execution_receipt_contract` PASS |
| R02 | CompletedAccepted po stationary zachowuje maskę | VERIFIED | Native aggregation test PASS |
| R03 | Stationary bez accepted jako CUDA w mapperze | VERIFIED | Unit test `native_fem::runtime_info::tests::execution_receipt_v2_maps_stationary_device_evidence_as_cuda_execution` PASS |
| R04 | Ochrona KNOWN_MASK w samodzielnym walidatorze Rust | VERIFIED | `validate_strict_fem_gpu_execution_receipt_v2_runtime` odrzuca bity > 15; testy jednostkowe PASS |
| D01 | Prostokątne wymiary RHS/recovery demag | VERIFIED | Upload operatorów i wymiary P1/P2 poprawne; `fem_demag_poisson_contract` PASS |
| D02 | Regresja periodic demag w aggregate target i launcherze | VERIFIED | `fem_cuda_periodic_demag_contract` w suite, PASS w kontenerze |
| N01 | NCG cache miss → hit | VERIFIED | `check_ncg_endpoint_cache_miss_then_hit` PASS na urządzeniu CUDA (miss na kroku 1, hit na kroku 2) |
| N02 | Rzeczywisty Armijo refinement na CUDA | VERIFIED | Deterministyczny świadek `kRefinedWitnessMagnetization` wszedł w produkcyjny refinement na CUDA, `refinement_evaluation_count = 1`, `candidates = 1`, `rejected = 0`, `physical_demag_solves = 4`, Armijo proof `upper <= rhs` |
| N03 | Invalidation i świeża praca po refinement | VERIFIED | Krok 2 zaakceptowany, unieważnienie cache (`next_miss = 2`), świeże ewaluacje pól i energii |
| N04 | Sprawdzenie skończoności energii (`std::isfinite`) | VERIFIED | Asercje dodane w `check_snapshot_energy_matches_observation` |
| P01 | STT/SOT/thermal odrzucone w konserwatywnej relaksacji | VERIFIED | Test planera `tests::relaxation_rejects_zhang_li_slonczewski_sot_and_thermal` dla 4 algorytmów PASS po ustawieniu `dynamics=None` dla direct minimizers |
| V01 | Fail-closed SKIP CUDA | VERIFIED | Launcher JUnit odrzuca `SKIP:`, CTest z serializacją i `--no-tests=error` |
| V02 | Exact Rust log validation | VERIFIED | `validate_exact_rust_test_log.py` z testami jednostkowymi (9/9 pytest PASS); 28 testów Rust zwalidowanych logami |
| V03 | Sprawdzony SHA kodu | VERIFIED | Zamrożony commit `95a1876ed496c757849707f599c418613b7db603` |
| H01 | Zależności promptów 4–7 | READY | Prompty zaktualizowane do sprawdzonego SHA, propozycja promptu 7 przygotowana |

Wyniki testów:
- Host launcher pytest: `scripts/test_validate_exact_rust_test_log.py` + `scripts/test_windows_fullmag_launcher_contract.py`: 50/50 PASS.
- Managed container native CTest (6/6 PASS bez SKIP):
  - `fem_gpu_execution_receipt_contract`: PASSED
  - `fem_demag_poisson_contract`: PASSED
  - `fem_gpu_rk_device_controller_contract`: PASSED
  - `fem_gpu_relaxation_preconditioner_contract`: PASSED
  - `fem_cuda_periodic_demag_contract`: PASSED
  - `fem_gpu_ncg_runtime_contract`: PASSED (potwierdzony cache miss->hit, rzeczywisty Armijo refinement, Armijo proof oraz krok 2 z unieważnieniem cache).
- Managed exact Rust tests (28/28 PASS):
  - 1 test planera (`fullmag-plan`)
  - 3 testy ABI sys (`fullmag-fem-sys`)
  - 24 testy runnera (`fullmag-runner`), w tym mapper stationary evidence, serializacja snapshotów v2/v3 i walidator receiptu.
