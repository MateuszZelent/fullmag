# P4-B — bramka procesu accepted FEM preparation

Data: 28.09.2026
Implementacja: `b1066e761`

## Zakres

Commit dodaje stałą trasę
`just verify-api-accepted-fem-preparation-runtime` oraz kanoniczny fixture
immutable RunSpec v2 dla `FEM/CPU/double/strict`. Fixture wiąże ten sam backend
w `RequestedExecution` i typowanym `ProblemIR`; hash katalogu problemów został
wygenerowany przez produkcyjne typy Rust.

Skrypt procesu:

1. zapisuje tożsamość źródeł i buduje `libfullmag_fem` oraz wyłącznie binaria
   produkcyjne z funkcją `fem-native`;
2. uruchamia API i składa run przez `fullmag run-json` oraz publiczne
   HTTP v2;
3. wymaga dokładnie jednego taska
   `Accepted/Blocked(accepted_task_awaiting_preparation)`;
4. publikuje oddzielną generacyjną ofertę `Meshing`, uruchamia produkcyjny
   scheduler, supervisor i native preparer;
5. sprawdza zgodną tożsamość RunId/TaskId/attempt/resource/token w lease,
   launch intencie i exit receipcie;
6. wymaga `task_preparation_receipt.v1` z planem `preparation_plan.v2`, źródłem
   `accepted_run_step`, backendem FEM i pięcioma certyfikatami;
7. wymaga udanego exit bez timeoutu, zwolnionego lease oraz publicznej projekcji
   `accepted_task_awaiting_dependency_resolution`;
8. zapisuje hashe binariów, biblioteki native i wszystkich trwałych dowodów w
   `fullmag_accepted_fem_preparation_runtime_v1`.

Bramka jawnie wyłącza ze swojego zakresu wykonanie solvera, walidację fizyki i
kwalifikację wydania. Jej sukces będzie dowodem procesu przygotowania, a nie
dowodem poprawności wyników naukowych.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| Generacja typowanego fixture przez `fullmag-plan` | **PASS** |
| Import fixture i kontrola `FEM/CPU/double/strict` | **PASS** |
| `python -m py_compile scripts/verify_accepted_fem_preparation_runtime.py` | **PASS** |
| `python scripts/verify_accepted_fem_preparation_runtime.py --help` | **PASS** |
| `just --dry-run verify-api-accepted-fem-preparation-runtime` | **PASS** |
| `cargo check --locked --offline` dla API, publishera puli, preparera, schedulera i CLI | **PASS** |
| `git diff --check` i staged diff | **PASS** |
| Managed native process E2E | **NOT VERIFIED** — `just runner-container-status` nadal zwraca `Docker Desktop coordinator request failed` |
| Solver, fizyka, browser i release | **NOT VERIFIED**, poza zakresem tej bramki |

Przyrost usuwa brak wykonywalnej bramki P4-B, ale nie podnosi wyniku runtime,
dopóki zarządzany przebieg nie zapisze receiptu w stanie `passed`. P4 pozostaje
na **50%**, a cały plan na około **49%**.
