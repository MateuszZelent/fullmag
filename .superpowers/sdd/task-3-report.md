# Raport implementera — Task 3: źródłowo przypięty benchmark fazy 0

Data: 2026-09-03

Baza: `45eda81251a81d4f641e4eb9588a24a4fc6dea88`

Commity implementacyjne:

- `ea41d1d099992ab75e7e40ac343f496a07e3e448` — główny kontrakt benchmarku v2 i Nsight,
- `79dd0020d8169283e58f6bf2f778801160b3b5c9` — unikalne indeksy powtórzeń i odczyt UUID GPU w managed baseline,
- `173bb27160f7069eff766b1f8d1869184f6eae12` — remediacja review: bieżący clean source snapshot, integralność binariów i uporządkowane fazy jednego capture,
- `1f860804c905ff068c0bfc5af38274ffde4da106` — powiązanie faktycznie wykonywanego launchera ze zweryfikowaną ścieżką i SHA-256 z manifestu,
- `bac04dadca5e8b118d7ec2718e5a8b334dd251ce` — formalna remediacja: kanoniczna tożsamość workloadu, wymagany `fullmag_fem`, wykonywalne recipes Windows i atomowe artefakty per-attempt,
- `8f41c468406c8bc7e024068060e1b36c7fe8f039` — canonical owner Windows FEM w `run_fullmag_fem.ps1`, dwa cienkie aliasy zgodności i bezpieczny GUID attemptu,
- `4269024d5c2b03cb3a230e0dd0b4f4888ba0c4f3` — hardening re-review: ścisły UUID v4/RFC variant bez końcowego newline oraz jawny zakaz wywołania WSL w aliasach.

## Zakres wykonany

- Dodano kontrakt `fullmag.fem_gpu.benchmark.v2`: rekord zawiera commit i snapshot źródła, digest manifestu runtime, digest ProblemIR i mesh, UUID GPU, precyzję, p50/p95 czasu oraz liczniki snapshotu v2.
- `collect_case` waliduje wszystkie co najmniej pięć powtórzeń przed obliczeniem statystyk. Odrzuca niespójne identity, niepełny receipt/snapshot, hostowe maski i transfery strict GPU, compute fence oraz niezaliczony CPU oracle.
- Przed `VERIFIED` źródłowy commit i snapshot wszystkich powtórzeń muszą zgadzać się z bieżącym race-checked, czystym checkoutem. Ścieżka wykonawcza sprawdza też manifestowane SHA-256 launchera, workera, API oraz bibliotek natywnych; podmieniony plik blokuje kwalifikację.
- `collect_case` wymaga ponadto, aby `binary` każdego powtórzenia wskazywał dokładnie manifestowany launcher i aby ponownie obliczony SHA-256 tego pliku zgadzał się z digestem zweryfikowanym z manifestu. Alternatywny `FULLMAG_BENCH_GPU_BIN` nie może odziedziczyć cudzej tożsamości runtime.
- Przed statystyką każde wykonane `ProblemIR` i solver mesh są porównywane z trzema jawnie przekazanymi wartościami: `fixture.problem_ir_sha256`, `fixture.solver_mesh_sha256` i `qualification_fixture_problem_ir_sha256`. Pięć spójnych, lecz błędnych powtórzeń kończy się `NOT VERIFIED` oraz `records=[]`; digests nie są aliasowane ani domyślane.
- Strict runtime integrity wymaga wpisu `native_libraries.fullmag_fem` z istniejącą ścieżką i zgodnym SHA-256. Pusty mapping lub manifest bez głównej biblioteki jest odrzucany.
- Benchmark konsumuje istniejące `fem_gpu_execution_receipt` i `fem_gpu_performance_snapshot_v2`, jeśli runtime je opublikuje. Task 3 nie dodaje producenta runtime.
- Jeden słownik definiuje publiczne nazwy preconditionerów. `exchange_mass` jest zarezerwowany, lecz ma wartość `None` i nie trafia do CLI, ponieważ aktualny C++ resolver akceptuje tylko `none` i `diagonal`; realizacja `exchange_mass` należy do Task 10.
- Nsight ma fail-closed kontrakt faz `setup -> attempt -> accepted_finalization -> snapshot -> export`. Cała uporządkowana sekwencja musi wystąpić w jednym capture compute albo host; unia dwóch niezależnych przebiegów nie kwalifikuje wyniku.
- Receptury baseline i Nsight na Windows wywołują kanoniczny `scripts/windows/run_fullmag_fem.ps1`, który używa `compose.windows.yaml`, zewnętrznych rootów, jawnego GPU i zakazu CPU fallbacku. `NOT VERIFIED` powstaje dopiero po rzeczywistym preflight.
- Katalog próby zawiera pełny source commit i UUID attemptu. Writer kończy pełny CSV przed utworzeniem i atomowym opublikowaniem JSON jako finalnego markera; wcześniejsza próba `NOT VERIFIED` nie blokuje następnej próby tej samej rewizji.

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

Remediacja review miała osobny cykl RED/GREEN. RED wymuszał zgodność bieżącego checkoutu, wykrycie podmienionego binarium, rebuild runtime i uporządkowany pojedynczy capture:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
Ran 10 tests in 0.023s
FAILED (failures=1, errors=16)
```

Po minimalnej implementacji:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
..........
Ran 10 tests in 0.025s
OK
```

Końcowy re-review ujawnił możliwość wskazania alternatywnego `FULLMAG_BENCH_GPU_BIN`. Cykl TDD dla tej luki:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
Ran 11 tests in 0.052s
FAILED (failures=1)

python -m unittest scripts.test_fem_gpu_benchmark_contract
...........
Ran 11 tests in 0.130s
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

Wcześniejszy niezależny re-review zatwierdził source/runtime/manifest/binary identity oraz uporządkowaną sekwencję faz Nsight. Późniejszy formalny review zgłosił cztery dodatkowe findings; wszystkie są objęte commitem `bac04dadc`, lecz nie są w tym raporcie przedstawiane jako zatwierdzone przed ponownym formalnym review.

Formalna remediacja miała osobny cykl RED/GREEN. RED obejmował pięć spójnych błędnych digestów, pusty/brakujący `native_libraries.fullmag_fem`, bypass Windows oraz retry/partial/collision writer:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
Ran 13 tests
FAILED (failures=2, errors=19)
```

Po minimalnej implementacji i rozdzieleniu kanonicznego ProblemIR od qualification digest:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
.............
Ran 13 tests in 0.174s
OK

python -c "import inspect, scripts.test_windows_fullmag_launcher_contract as t; tests=[(n,f) for n,f in vars(t).items() if n.startswith('test_') and callable(f)]; zero=[(n,f) for n,f in tests if len(inspect.signature(f).parameters)==0]; [(print(n), f()) for n,f in zero]; print('all zero-argument Windows launcher contracts: OK')"
all 33 zero-argument Windows launcher contracts: OK
```

Końcowe sprawdzenia formalnej remediacji:

```text
python -m py_compile scripts/analysis/fem_gpu_benchmark.py scripts/analysis/capture_fem_gpu_nsight.py scripts/test_fem_gpu_benchmark_contract.py scripts/test_windows_fullmag_launcher_contract.py
exit 0

PowerShell Parser.ParseFile scripts/windows/run_fullmag_wsl.ps1
PowerShell parser: OK

git diff --check
exit 0 (wyłącznie ostrzeżenia Git o przyszłej normalizacji LF/CRLF)

just --dry-run capture-fem-gpu-pre-remediation-performance-baseline
exit 0

just --dry-run capture-fem-gpu-nsight
exit 0
```

Dodatkowa próba uruchomienia istniejącego pliku pytest:

```text
python -m pytest -q scripts/test_capture_fem_gpu_nsight.py scripts/test_fem_gpu_benchmark_contract.py
C:\Users\Mateusz\miniconda3\python.exe: No module named pytest
exit 1
```

Nie instalowano zależności ani cache do checkoutu. Wymagany w briefie runner `unittest` przeszedł.

## Remediacja formalnego re-review: własność launchera i GUID

RED po zmianie kontraktów statycznych wymuszających canonical owner i bezpieczny GUID:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
Ran 13 tests in 0.172s
FAILED (failures=1)

python -c "... wszystkie zeroargumentowe testy scripts.test_windows_fullmag_launcher_contract ..."
AssertionError: compose.windows.yaml missing from run_fullmag_fem.ps1
exit 1
```

Minimalna implementacja przeniosła całą logikę Docker Desktop do `scripts/windows/run_fullmag_fem.ps1`. `run_fullmag_wsl.ps1` i `run_fullmag_docker.ps1` zawierają tylko bezpośrednie przekazanie `@args` do canonical launchera. Produkcyjne gałęzie `gpu-benchmark-baseline` i `gpu-nsight` występują wyłącznie w canonical owner. `ContractAttemptId` przyjmuje wyłącznie UUID v4 w formacie `8-4-4-4-12`, z wariantem RFC (`8`, `9`, `a` lub `b`) i ścisłym końcem `\z`.

GREEN:

```text
python -m unittest scripts.test_fem_gpu_benchmark_contract
.............
Ran 13 tests in 0.169s
OK

python -c "... wszystkie zeroargumentowe testy scripts.test_windows_fullmag_launcher_contract ..."
launcher contracts: 35/35 passed
```

Rzeczywisty parameter binding, wykonany dla canonical launchera i obu aliasów z `ContractAttemptId='..'`, zatrzymał każde wywołanie przed Dockerem:

```text
scripts/windows/run_fullmag_fem.ps1 unsafe UUID binding: rejected (exit=1)
scripts/windows/run_fullmag_wsl.ps1 unsafe UUID binding: rejected (exit=1)
scripts/windows/run_fullmag_docker.ps1 unsafe UUID binding: rejected (exit=1)
```

Pozostałe sprawdzenia:

```text
python -m py_compile scripts/analysis/fem_gpu_benchmark.py scripts/analysis/capture_fem_gpu_nsight.py scripts/test_fem_gpu_benchmark_contract.py scripts/test_windows_fullmag_launcher_contract.py
exit 0

scripts/windows/run_fullmag_fem.ps1 parser: OK
scripts/windows/run_fullmag_wsl.ps1 parser: OK
scripts/windows/run_fullmag_docker.ps1 parser: OK

git diff --check
exit 0 (wyłącznie ostrzeżenia Git o przyszłej normalizacji LF/CRLF)

just --dry-run capture-fem-gpu-pre-remediation-performance-baseline
baseline dry-run: OK

just --dry-run capture-fem-gpu-nsight
Nsight dry-run: OK
```

Pierwszy read-only re-review znalazł brak wymuszenia wersji v4/wariantu RFC i brak testowej blokady `wsl.exe` w aliasach. Cykl RED/GREEN hardeningu:

```text
python -c "... test_windows_fem_contract_attempt_id_is_a_safe_guid() ..."
AssertionError: strict UUID v4 ValidatePattern missing
exit 1

python -m unittest scripts.test_fem_gpu_benchmark_contract
.............
Ran 13 tests in 0.164s
OK

python -c "... wszystkie zeroargumentowe testy scripts.test_windows_fullmag_launcher_contract ..."
launcher contracts: 35/35 passed
```

Rzeczywisty binding po hardeningu odrzucił path traversal, UUID innej wersji i UUID z końcowym newline. Oba aliasy przekazały odrzucenie z canonical launchera:

```text
canonical UUID binding rejected path, non-v4, and trailing newline
scripts/windows/run_fullmag_wsl.ps1 forwards canonical UUID rejection
scripts/windows/run_fullmag_docker.ps1 forwards canonical UUID rejection
```

Ponowiony read-only re-review po `4269024d5c2b03cb3a230e0dd0b4f4888ba0c4f3`: `APPROVED` dla canonical owner, cienkich aliasów bez WSL/contract branches, ścisłego UUID v4/RFC i testów statycznych.

## Fail-closed baseline i Nsight

Po commicie `bac04dadca5e8b118d7ec2718e5a8b334dd251ce` uruchomiono dokładnie kanoniczną recipe. Pierwsza próba w sandboxie nie uzyskała dostępu do Docker API; powtórzenie poza sandboxem dotarło do `compose.windows.yaml`, wykryło rzeczywiste GPU i uruchomiło kontener:

```text
just capture-fem-gpu-pre-remediation-performance-baseline
GPU 0: NVIDIA GeForce RTX 4080 SUPER
Reusing FEM image fullmag/fem-gpu:windows-local-fem-gpu-full-potential-20260902-d9bc7c003c8f4f58
FEM_GPU_BENCHMARK_V2=NOT VERIFIED
docker compose failed with exit code 2
recipe exit code 1
```

Artefakt:

`C:\fullmag-cache\fem-gpu-full-potential-20260902-d9bc7c003c8f4f58\state\fem-gpu\reports\task-3-fem-gpu-baseline\bac04dadca5e8b118d7ec2718e5a8b334dd251ce\46578ff1-efff-4bf4-8ce4-22ccda091dc3\benchmark.v2.json`

- JSON SHA-256: `7996f5185d87761c6dde0e4919b024817c7fcdc6b45d1a14c2b847f573f89b7c`
- CSV SHA-256: `20aea25238cf6c21035d41e31baafc43e32534d2b4b9baa8a7bc4ad30a0f7eaf`
- `qualification_status`: `NOT VERIFIED`
- `correctness_gate`: `not_run`
- `records`: `[]`
- blocker: `managed FEM benchmark runtime producer is unavailable after canonical Windows launcher preflight; NOT VERIFIED`.
- artefakt jest w zewnętrznym Windows state root i ma osobny UUID próby; wcześniejszy `NOT VERIFIED` nie blokuje ponowienia dla tego samego commita.

```text
just capture-fem-gpu-nsight
GPU 0: NVIDIA GeForce RTX 4080 SUPER
status=unavailable: nsys unavailable in managed fixture image
docker compose failed with exit code 2
recipe exit code 1
```

Artefakt:

`C:\fullmag-cache\fem-gpu-full-potential-20260902-d9bc7c003c8f4f58\state\fem-gpu\reports\task-13-nsight\task13-box500-airbox-ncg-sm89-v1-bac04dadca5e8b118d7ec2718e5a8b334dd251ce-aea81d3c-8275-4d68-8c92-78c15ea9ca74\summary.json`

- summary JSON SHA-256: `bd6d4d646715ef820a5cc100440ec13f00f79f81c90de6bcd6c243a92f78f052`
- report Markdown SHA-256: `5ef4f236e9877e092681ca9071ab1fee148d4db9d03d0f35abb9fcf7843022c5`
- `qualification_status`: `NOT VERIFIED`
- `status`: `unavailable`
- zakres faz: `setup -> attempt -> accepted_finalization -> snapshot -> export`
- rzeczywisty preflight: CUDA GPU dostępne (`driver=591.86`, `gpu_count=1`), `ncu` dostępne (`2024.3.2.0`), `nsys` brak (`missing_binary`).
- blocker: `nsys unavailable in managed fixture image`.

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
- `scripts/test_windows_fullmag_launcher_contract.py`
- `scripts/windows/run_fullmag_fem.ps1` (canonical owner pełnej implementacji Docker Desktop)
- `scripts/windows/run_fullmag_wsl.ps1` (historyczny cienki alias zgodności)
- `scripts/windows/run_fullmag_docker.ps1` (cienki alias zgodności dla nazwy Docker)
- `justfile`
- `.superpowers/sdd/task-3-report.md` (ten raport; osobny commit raportowy)
