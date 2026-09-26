# P3-B/P5-B — pełne E2E supervisora i accepted workera

Data checkpointu: 26.09.2026. Baza źródeł:
`master@8a95167820594d577cde1a8d5d68a497e0e78d46` z bieżącym przyrostem
przypiętym przez hash treści w receipcie.

## Zrealizowany przepływ

Dodano odrębną zarządzaną trasę `api-accepted-supervisor-e2e`. Trasa najpierw
buduje oba produkcyjne binaria:

- `fullmag-api-accepted-supervisor`;
- `fullmag-api-accepted-worker`.

Następnie test HTTP materializuje immutable accepted run, RunSpec, StudyPlan,
ProblemIR, durable task claim, CPU lease, komendy `Prepare` i `Start` oraz
pozostawia `Start` jako pending przed pierwszym side effectem. Zbudowany
supervisor uruchamia zbudowanego workera w osobnym procesie. Worker wykonuje
krótki FDM CPU/double/strict, zapisuje started/completed receipt, publikuje stan
i energię do CAS, tworzy `study_output_manifest.v1`, przechodzi completion
barrier i zapisuje terminalny sukces. Supervisor obserwuje exit, rekoncyliuje
inbox i journal, a następnie zwalnia dokładny lease.

Wspólne asercje odczytują wynik wyłącznie z trwałego katalogu i CAS. Dzięki
temu ten sam test pokrywa wcześniejszą ścieżkę in-process oraz nową ścieżkę
dwóch binariów bez uzależniania dowodu od obiektu zwróconego w pamięci procesu.

## Zarządzana weryfikacja

`just verify-api-accepted-supervisor-e2e`: **PASS, 1/1**, receipt:

`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-api-source-check\api-accepted-supervisor-e2e\00ebd08b3e1d46b5b5b754a2779261e4\receipt.json`

Receipt ma `source_changed_during_run=false`, bazowy HEAD
`8a95167820594d577cde1a8d5d68a497e0e78d46` i przypięty hash treści
`4db6054727462a0e00c187180588a05c40c5a93a4205a4ed7b7e9bd459965ff1`.
Setup command jawnie buduje oba binaria przed testem. Test potwierdza dwa
typowane wyjścia, requested/resolved CPU, FDM, double, brak fallbacku,
terminalny `Succeeded`, poprawny manifest/CAS, brak timeoutu i stan lease
`Released` po zakończeniu potomka.

Kontrakt zarządzanej trasy ma osobną regresję skryptu: **17/17 PASS**.

## Granica dowodu

To jest pełne E2E produkcyjnych binariów dla obecnego ograniczonego lane
FDM CPU/double/strict i krótkiego fixture. Nie kwalifikuje zbieżności ani fizyki,
FDM GPU, FEM CPU/GPU, długiego runu, crashu supervisora, power loss, heartbeat,
operator cancel, retry policy, orphan reconciliation, puli większej niż jeden
ani zwolnienia VRAM. Heartbeat wymaga najpierw kontraktu odświeżania claimu:
proste zwiększenie `heartbeat_sequence` unieważniłoby obecny claim workera przy
późniejszej publikacji.
