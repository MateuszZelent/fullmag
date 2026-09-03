# Raport implementera — Task 3: źródłowo przypięty benchmark fazy 0

Data: 2026-09-03

Baza: `45eda81251a81d4f641e4eb9588a24a4fc6dea88`

Commity implementacyjne:

- `ea41d1d099992ab75e7e40ac343f496a07e3e448` — główny kontrakt benchmarku v2 i Nsight,
- `79dd0020d8169283e58f6bf2f778801160b3b5c9` — unikalne indeksy powtórzeń i odczyt UUID GPU w managed baseline.

## Zakres wykonany

- Dodano kontrakt `fullmag.fem_gpu.benchmark.v2`: rekord zawiera commit i snapshot źródła, digest manifestu runtime, digest ProblemIR i mesh, UUID GPU, precyzję, p50/p95 czasu oraz liczniki snapshotu v2.
- `collect_case` waliduje wszystkie co najmniej pięć powtórzeń przed obliczeniem statystyk. Odrzuca niespójne identity, niepełny receipt/snapshot, hostowe maski i transfery strict GPU, compute fence oraz niezaliczony CPU oracle.
- Benchmark konsumuje istniejące `fem_gpu_execution_receipt` i `fem_gpu_performance_snapshot_v2`, jeśli runtime je opublikuje. Task 3 nie dodaje producenta runtime.
- Jeden słownik definiuje publiczne nazwy preconditionerów. `exchange_mass` jest zarezerwowany, lecz ma wartość `None` i nie trafia do CLI, ponieważ aktualny C++ resolver akceptuje tylko `none` i `diagonal`; realizacja `exchange_mass` należy do Task 10.
- Nsight ma fail-closed kontrakt faz `setup -> attempt -> accepted_finalization -> snapshot -> export`. Brak którejkolwiek fazy blokuje `VERIFIED`.
- Receptury baseline i Nsight zapisują jawne `NOT VERIFIED`, gdy kanoniczna ścieżka wykonania lub narzędzia są niedostępne. Baseline v2 używa katalogu adresowanego SHA i opcji immutable.

## TDD i weryfikacja

RED:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
Ran 8 tests
FAILED (failures=1, errors=10)
```

Brakowało publicznych helperów benchmarku v2, jednej mapy preconditionerów, kontraktu faz Nsight i wymaganych zapisów receptur.

GREEN po implementacji oraz ponowiony przed commitem:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
........
Ran 8 tests in 0.013s
OK
```

Pozostałe sprawdzenia:

```text
python -m py_compile scripts/analysis/fem_gpu_benchmark.py scripts/analysis/capture_fem_gpu_nsight.py scripts/test_fem_gpu_benchmark_contract.py
exit 0

git diff --check
exit 0

just --dry-run capture-fem-gpu-pre-remediation-performance-baseline
exit 0

just --dry-run capture-fem-gpu-nsight
exit 0
```

`cargo fmt --all -- --check` zakończył się `exit 1` wyłącznie na wcześniejszym driftcie formatowania w plikach Rust spoza Task 3, między innymi `crates/fullmag-api/src/router_v2/handlers/analysis/results.rs`, `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs` i `crates/fullmag-runner/src/eigen/artifacts/*`. Nie wykonano `cargo fmt`, aby nie zmieniać obcego zakresu; Task 3 nie modyfikuje Rust.

Dodatkowa próba uruchomienia istniejącego pliku pytest:

```text
python -m pytest -q scripts/test_capture_fem_gpu_nsight.py scripts/test_fem_gpu_benchmark_contract.py
C:\Users\Mateusz\miniconda3\python.exe: No module named pytest
exit 1
```

Nie instalowano zależności ani cache do checkoutu. Wymagany w briefie runner `unittest` przeszedł.

## Fail-closed baseline i Nsight

Po commicie implementacyjnym uruchomiono dokładnie:

```text
just capture-fem-gpu-pre-remediation-performance-baseline
FEM_GPU_BENCHMARK_V2=NOT VERIFIED
recipe exit code 2 (proces `just` na Windows zwrócił 1)
```

Artefakt:

`C:\git\fullmag\fullmag\.worktrees\fem-gpu-full-potential-20260902\.fullmag\reports\task-3-fem-gpu-baseline\79dd0020d8169283e58f6bf2f778801160b3b5c9\benchmark.v2.json`

- SHA-256: `b6e51771d502ce518f99a94db35fd819185f57725eb564e540ae0507bc1e17e2`
- `qualification_status`: `NOT VERIFIED`
- `correctness_gate`: `not_run`
- `records`: `[]`
- blocker: kanoniczne wykonanie managed FEM benchmarku nie jest dostępne w windowsowej gałęzi tej receptury.

```text
just capture-fem-gpu-nsight
qualification_status=NOT VERIFIED
recipe exit code 2 (proces `just` na Windows zwrócił 1)
```

Artefakt:

`C:\git\fullmag\fullmag\.worktrees\fem-gpu-full-potential-20260902\.fullmag\reports\task-13-nsight\task13-box500-airbox-ncg-sm89-v1\summary.json`

- SHA-256: `af724218bfd902a6118a6765f8db30cce8260f0ccd401087e7837df3559dc0ae`
- `qualification_status`: `NOT VERIFIED`
- `status`: `unavailable`
- zakres faz: `setup -> attempt -> accepted_finalization -> snapshot -> export`
- blocker: Nsight nie jest dostępny na kanonicznej windowsowej ścieżce Task 3.

## Granice dowodu i luki

- Nie wykonano managed FEM CPU/GPU workload, dlatego nie ma source/runtime/ProblemIR/mesh zgodności z realnego runu, rozkładu p50/p95 ani CPU-oracle parity evidence.
- Runtime Task 2 nie publikuje jeszcze snapshotu wydajności v2 do artefaktu ukończonego runu. Benchmark v2 konsumuje taki snapshot, ale przy jego braku pozostaje `NOT VERIFIED`.
- Brak śladu Nsight oznacza brak dowodu pokrycia faz, overlapu, occupancy, bandwidth i top-kernel metrics.
- Nie zweryfikowano wydajności, physics, parity ani production qualification. Artefakty source/contract nie zastępują tych torów dowodowych.
- Istniejąca, niezwiązana zmiana `.superpowers/sdd/progress.md` została zachowana i nie weszła do commita.

## Pliki

- `scripts/analysis/fem_gpu_benchmark.py`
- `scripts/analysis/capture_fem_gpu_nsight.py`
- `scripts/test_fem_gpu_benchmark_contract.py`
- `justfile`
- `.superpowers/sdd/task-3-report.md` (ten raport; osobny commit raportowy)
