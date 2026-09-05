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

- Kroki 1–3: zaimplementowane w C1, C2, C3; receipt, periodic demag, cache miss->hit oraz wykonanie Armijo refinement (z kanonicznym odrzuceniem nierozstrzygniętego kandydata) zweryfikowane na GPU.
- Krok 4: bramka managed uruchamia pełny zestaw testów natywnych i Rust; asercja izolowanego zaakceptowanego świadka refinementu bez odrzucenia (rejected=0) pozostaje NOT VERIFIED (nieosiągalna na 1 czworościanie bez sztucznego tłumienia błędu).
- Krok 5: prompty i raporty zaktualizowane; Agent 4 READY dla swojego zakresu, Agent 5 BLOCKED dla A11 do ukończenia prac Agenta 4, Agent 7 pozostaje propozycją.

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

## Aktualny odbiór (2026-09-05, rewizja numeryczna Armijo refinement)

### Tożsamość i manifest statusu

```yaml
inspection_code_sha: 2a1671a085a66583d759cfd962380b6e4eef28f0 # HEAD przed audytem skalowania Armijo
flawed_scaling_commit_sha: 95a1876ed496c757849707f599c418613b7db603 # commit ze sztucznym skalowaniem rtol
source_branch: codex/fem-gpu-tasks1-5-remediation
source_worktree: C:/git/fullmag/fullmag/.worktrees/fem-gpu-tasks1-5-remediation
code_commit_available_on_remote: LOCAL_ONLY
managed_native_contracts: PARTIALLY_VERIFIED # 5/6 PASS; fem_gpu_ncg_runtime_contract zatrzymany na asercji akceptacji świadka
managed_rust_contracts: VERIFIED # 28/28 exact testów PASS
windows_launcher_contracts: VERIFIED # 50/50 pytest PASS
ncg_cache_miss_hit: VERIFIED # krok 1 miss, krok 2 hit
ncg_armijo_refinement_execution: VERIFIED # wejście w refinement, 6 fizycznych demag solves na CUDA, kanoniczne odrzucenie
ncg_accepted_refinement_witness: NOT_VERIFIED # rejected=0 nieosiągalne na 1 tet bez sztucznego tłumienia błędu
full_physics_qualification: NOT_VERIFIED # brak pełnej kwalifikacji SP4
performance_ab: NOT_VERIFIED # brak porównania A/B
agent_4_gate: READY # zwolniona dla implementacji loadera/preconditionera
agent_5_gate: BLOCKED # A11 sparse zablokowane do integracji agenta 4; DG0/A13 dozwolone równolegle
agent_7_gate: PROPOSED # propozycja niezależnego audytora do zatwierdzenia
```

### Stan realizacji i macierz weryfikacji

Poprawki z planu naprawy zostały zaimplementowane i zwalidowane w kontenerze:
- C1 (`0694cd661c76efc42e9cba7852bf460082a7d172`) oraz `3f3fffae31c574b668bab75b93d697020f0ac7ae`: strict managed gate.
- C2 (`7ba57890e0acd83ffbef0dff6078bdf39678c8bc`): receipt closure regressions.
- C3 (`596dc3f32b3b4ab1ba57a48c68bde9f115e4f85a`): NCG proof closure.
- Remediated numerics: usunięto nieuzasadnione skalowanie granicy zaokrągleń `demag_roundoff_bound_j * (refined_rtol / ordinary_rtol)` z `direct_energy_increment.cpp`; dodano regresję numeryczną w `gpu_relaxation_preconditioner_contract.cpp`.

| ID | Wymaganie / kontrakt | Wynik | Szczegóły dowodu |
|---|---|---|---|
| R01 | Stationary omija operatory próby | VERIFIED | Regresje maszyn stanów w `gpu_execution_receipt_contract` PASS |
| R02 | CompletedAccepted po stationary zachowuje maskę | VERIFIED | Native aggregation test PASS |
| R03 | Stationary bez accepted jako CUDA w mapperze | VERIFIED | Unit test `native_fem::runtime_info::tests::execution_receipt_v2_maps_stationary_device_evidence_as_cuda_execution` PASS |
| R04 | Ochrona KNOWN_MASK w samodzielnym walidatorze Rust | VERIFIED | `validate_strict_fem_gpu_execution_receipt_v2_runtime` odrzuca bity > 15; testy jednostkowe PASS |
| D01 | Prostokątne wymiary RHS/recovery demag | VERIFIED | Upload operatorów i wymiary P1/P2 poprawne; `fem_demag_poisson_contract` PASS |
| D02 | Regresja periodic demag w aggregate target i launcherze | VERIFIED | `fem_cuda_periodic_demag_contract` w suite, PASS w kontenerze |
| N01 | NCG cache miss → hit | VERIFIED | `check_ncg_endpoint_cache_miss_then_hit` PASS na urządzeniu CUDA (miss na kroku 1, hit na kroku 2) |
| N02 | Wykonanie procedury Armijo refinement na CUDA | VERIFIED | Świadek wszedł w produkcyjny refinement na CUDA, `refinement_evaluation_count = 1`, `physical_demag_solves = 6`, świeże ewaluacje na GPU; nierozstrzygnięty kandydat został kanonicznie odrzucony (`rejected = 1`), a linia podziału przeszła do zaakceptowanego kroku |
| N02b | Zaakceptowany świadek refinementu bez odrzucenia | NOT VERIFIED | Wymóg `rejected = 0` na 1 czworościanie jest matematycznie nieosiągalny z poprawną granicą IEEE 754 ($\Delta E_{\mathrm{ref}} - \Delta E_{\mathrm{ord}} = 0$ przy CG do precyzji maszynowej) |
| N03 | Invalidation i świeża praca po refinement | NOT VERIFIED | Zależne od zaakceptowanego punktu po refinement; niezaliczane bez legalnego świadka |
| N04 | Sprawdzenie skończoności energii (`std::isfinite`) | VERIFIED | Asercje dodane w `check_snapshot_energy_matches_observation` |
