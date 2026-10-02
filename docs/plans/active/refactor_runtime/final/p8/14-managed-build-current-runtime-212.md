# P8-C — build aktualnego kodu runtime, zadanie 212

Data: 02.10.2026. Stan przy zgłoszeniu: QUEUED, nie PASS.

Po terminalnym odbiorze buildu 210 zlecono tej samej kolejce produkcyjny
fem-cpu-release dla kodu zawierającego późniejsze driver i poprawki state.
Build 210 nie obejmował tych zmian. Nie zgłoszono ponownie jego źródeł ani
nie uruchomiono równoległego ciężkiego hostowego builda.

| Tożsamość | Wartość |
|---|---|
| Commit | `75ab6fe297d116657bcf67f1f321f4fd47e66fd0` |
| Job / sequence | `2d488f2a1de547d4be78e105db346d33` / 212 |
| Source mode | commit; source_snapshot_dirty=false |
| Capsule capture | `84a781335ee745e59137011f2c839aef` |
| Source digest | `fafb7c82fe2bc63d2a5bfb05613b3656b10195f321033adb6959f6bc8a066c67` |
| Native source snapshot | `87a21e18224ca67e3472297578b36b56e84312d5ec090d51e9817db9356610ae` |
| Stan | queued; brak terminalnego dowodu |

Przed zgłoszeniem health: worker_alive=true, accepting_jobs=true,
worker_error=null, 9 666 572 288 B wolnego storage. Aktywny job 211
fem-cpu-slepc-runtime-v2 innej pracy zachowano. Nie zmieniano obrazu,
allow-listy, profili, kolejności ani lease innych zadań. Admission przy
braku miejsca pozostaje obowiązkiem runnera; nie kasowano cache.

Użyto istniejącego zatwierdzonego klienta z zarejestrowanego worktree
eigensolve-dispersion-plan-20260912, HEAD
ccd6402f63945eea6db5b40ba8e9c97281075916. Rejestr potwierdził ownera
codex:01a0941c-eb15-7261-a7ee-7cf099385525 i state=active; pliki
local_runner_cli.py/container_client.py były czyste. Katalog źródeł podano
osobno przez --worktree głównego checkoutu. Nie zmieniono safe.directory.

Odbiór wymaga terminalnego stanu, exit 0, trusted documents, przypiętej
kapsuły i pełnej walidacji artefaktów. Ten build kompiluje kod produkcyjny,
nie unit tests. Dowód pozostanie przypięty do powyższego SHA, także po
dopisaniu tego raportu. Nie zastępuje natywnego Windows/MSI ani solvera,
archive, nauki i browser/WebGL. Sesja 3104 pozostaje zachowana.
