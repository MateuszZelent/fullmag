# Raport Task 2 — wersjonowany performance receipt i baseline faz

## Status

**DONE_WITH_CONCERNS**

Task 2 jest ukończony na poziomie kontraktu źródłowego, C ABI, Rust ABI,
atomowej publikacji accepted-only oraz serializacji artefaktu. Istniejący ABI
v1 pozostał bez zmian. Nie wykonano produkcyjnego managed run, benchmarku,
parity ani walidacji fizycznej; te poziomy pozostają `NOT VERIFIED`.

## Commit implementacyjny

- `86333864451c12b958f317b3ddfb249cb6d4a027` —
  `feat(fem): publish versioned GPU phase counters`

Niniejszy raport jest śledzony osobnym commitem dokumentacyjnym, aby nie
tworzyć niemożliwej self-referencji do własnego hasha.

## Zakres implementacji

- Dodano dokładny, append-only `fullmag_fem_gpu_performance_snapshot_v2`:
  88 bajtów, alignment 8, `abi_version = 2`, `struct_size` i dziesięć pól
  `uint64_t` w kolejności wymaganej przez brief.
- Dodano symbol C
  `fullmag_fem_backend_gpu_performance_snapshot_v2` z dokładnym handshake
  wersji/rozmiaru i publikacją do bufora wyjściowego dopiero po pełnej
  walidacji planu oraz accountingu.
- Dodano wewnętrzny `FemGpuPerformancePhase` i osobne liczniki
  `attempt_performance` / `accepted_performance` pod istniejącym mutexem
  execution receipt.
- `gpu_execution_receipt_commit_attempt` sumuje fazy i czasy wyłącznie po
  ważnym accepted commit. `reject_attempt`, `fail_attempt` oraz invalid commit
  czyszczą licznik próby bez zastępowania zaakceptowanego snapshotu.
- Rust FFI odwzorowuje pola 1:1; `build.rs` generuje compile-time assertions
  rozmiaru, alignmentu i wszystkich offsetów v2 obok niezmienionych assertions
  v1.
- Runner zawiera 12-polowy `FemGpuPerformanceSnapshotV2` oraz jawny payload
  `fullmag.fem_gpu_performance_snapshot.v2` bez domyślania brakujących pól.
- Dodano focused recipe `verify-fem-gpu-execution-receipt-contract`. Korzysta
  z profilu Docker FEM GPU, nie wymaga hostowego `python3` ani checkoutowego
  środowiska `.fullmag`, a CMake/Cargo zapisują wyłącznie pod `/tmp` kontenera.
  Istniejąca szeroka recipe pozostała bez zmian.

## TDD — RED

### Environment seam szerokiej receptury

Polecenie:

```text
just --shell "C:\Program Files\Git\bin\bash.exe" --shell-arg -lc verify-fem-time-domain-native-contract
```

Wynik: `FAIL` przed kompilacją. `ensure-python` zgłosił brak hostowego
`python3` i próbował wejść w checkoutowy model środowiska `.fullmag`. Ten wynik
został sklasyfikowany jako environment seam, a nie jako czerwony dowód ABI.
Nie osłabiono ani nie zmieniono istniejącej receptury.

### Właściwy RED kontraktu v2

Polecenie:

```text
just --shell "C:\Program Files\Git\bin\bash.exe" --shell-arg -lc verify-fem-gpu-execution-receipt-contract
```

Sesja `24229`, wynik terminalny `exit 1`. `libfullmag_fem.so` zlinkowała się,
a kompilacja `fem_gpu_execution_receipt_contract` zatrzymała się na dokładnie
oczekiwanych brakach:

- `fullmag_fem_gpu_performance_snapshot_v2`;
- `FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION`;
- `fullmag_fem_backend_gpu_performance_snapshot_v2`;
- `FemGpuPerformancePhase` i
  `gpu_execution_receipt_note_performance_phase`.

To był właściwy RED typu/symbolu v2 po przejściu repozytoryjnej trasy
kontenerowej i pełnym linku biblioteki FEM.

## TDD — GREEN

### Pierwsza kontrola po implementacji i korekta bramki

Sesja `4906` zakończyła się `exit 0`:

- CTest `fem_gpu_execution_receipt_contract`: `1/1 PASS`, `0.08 s`;
- runner type serialization: `1/1 PASS`;
- runner artifact serialization: `1/1 PASS`.

Krótki filtr testu `fullmag-fem-sys` połączony z `--exact` uruchomił jednak
`0 tests` (`50 filtered out`). Nie został zaliczony jako GREEN. Recipe została
poprawiona do pełnej nazwy
`tests::gpu_performance_snapshot_v2_has_stable_layout_and_symbol` i wykonana
ponownie.

### Końcowa focused recipe

Polecenie:

```text
just --shell "C:\Program Files\Git\bin\bash.exe" --shell-arg -lc verify-fem-gpu-execution-receipt-contract
```

Sesja `93096`, wynik terminalny `exit 0`:

- pełny native target `fullmag_fem` oraz executable zbudowane z CUDA 12.4.131
  i MFEM stack;
- CTest `fem_gpu_execution_receipt_contract`: `1/1 PASS`, `0.08 s`;
- exact Rust ABI/layout/symbol: `1/1 PASS`, `49 filtered out`;
- exact runner type serialization: `1/1 PASS`, `1194 filtered out`;
- exact runner artifact serialization: `1/1 PASS`, `1194 filtered out`.

Kontrakt C++ sprawdza rozmiar, alignment i wszystkie offsety, wartości faz,
czasów i kernel ID, baseline `setup_count <= apply_count + 1`, zerowy compute
fence oraz byte-identyczny accepted snapshot po próbie rejected i failed.
Sprawdza też, że istniejące liczniki rejected/failed rosną niezależnie. Ten sam
executable nadal uruchamia wszystkie wcześniejsze testy lifecycle i ABI v1.

## Dodatkowa weryfikacja

```text
rustfmt +nightly --edition 2021 --check crates/fullmag-fem-sys/build.rs crates/fullmag-fem-sys/src/lib.rs crates/fullmag-runner/src/types.rs crates/fullmag-runner/src/artifacts.rs
```

Wynik: `PASS`, exit `0`.

```text
git diff --check -- . ':(exclude).superpowers/sdd/progress.md'
```

Wynik: `PASS`, exit `0`.

```text
git diff --cached --name-only
```

Przed commitem implementacyjnym wynik zawierał dokładnie dziesięć plików
Task 2: źródła receipt/API, test C++, C/Rust ABI, runner type/artifact i
`justfile`. `.superpowers/sdd/progress.md` nie był staged.

## Self-review

- Diff nagłówków C/Rust nie zmienia stałych, pól, rozmiaru ani symboli v1;
  dodaje wyłącznie osobny typ i symbol v2.
- Bufor publicznego API v2 nie jest nadpisywany przy błędnym handshake,
  nierozwiązanym planie lub nieważnym accountingu; dane są składane lokalnie
  i przypisywane dopiero na ścieżce sukcesu.
- Aktywna próba ma osobny snapshot. Jedyną ścieżką przenoszącą go do
  `accepted_performance` jest ważny `commit_attempt`; reject/failed używają
  wspólnego `clear_attempt`.
- Nie dodano stanu do ogólnego `Context` ani fizyki do `mfem_bridge.cpp`;
  ownership pozostaje w dedykowanym ownerze GPU execution receipt.
- Nie zmieniono capability matrix, planner semantics ani dokumentacji fizyki.
  Wyników kontraktu nie opisuje się jako production performance, parity lub
  walidacji naukowej.
- Repozytoryjna recipe jest samowystarczalna względem hostowego Pythona i nie
  pozostawia build/cache w checkoutcie.

## Concerns

1. Task 2 definiuje i testuje boundary licznika oraz artefaktu, ale nie podłącza
   jeszcze producentów faz w rzeczywistych operatorach ani emisji artefaktu do
   ukończonego runu. Dlatego kompilacja runnera zgłasza nowe ostrzeżenia
   `dead_code` dla typu/helpera v2. Konsumpcja należy do kolejnej fali
   benchmark/runtime, a rzeczywisty snapshot produkcyjny pozostaje
   `NOT VERIFIED`.
2. Nie wykonano managed FEM GPU run z source identity, runtime manifestem,
   requested/resolved device i precision ani trwałym completed receipt.
3. Nie wykonano benchmarku, Nsight, CPU/GPU parity ani walidacji fizycznej.
   Żadna capability ani claim produkcyjny nie została wypromowana.
4. Szeroka `verify-fem-time-domain-native-contract` nadal zależy od hostowego
   `python3`/checkoutowego env i w tym środowisku zatrzymuje się przed buildem.
   Nowa focused recipe omija ten environment seam bez zmiany istniejącej
   receptury.
5. Runner emituje liczne wcześniejsze ostrzeżenia unused/deprecated. Nie zostały
   naprawiane poza zakresem Task 2.

`.superpowers/sdd/progress.md` pozostaje niezależną zmianą koordynatora i nie
został wystage'owany ani zawarty w commitach Task 2.
