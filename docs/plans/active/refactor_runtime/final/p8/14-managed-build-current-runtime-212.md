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

## Odbiór 03.10.2026 — historyczny zakres

Koordynator opublikował terminalny succeeded/exit 0. Kontener zakończył się
03:02:19 UTC, OOMKilled=false. Zweryfikowano trusted hashes, zgodność
coordinator/context/build receipt, przypięty commit/snapshot oraz wszystkie
122 artefakty (291 673 111 B). Wymagania artefaktów porównano z kontraktem
źródeł dokładnego commita 75ab6fe, bez modyfikowania bieżącego walidatora.
verify_source potwierdził także niezmienny digest kapsuły oraz dokładny commit.

Build receipt SHA-256:
`ed3836536cae4e0184f3bebc58e081075c01e309998e709a683a5288edd371c4`.
Coordinator receipt SHA-256:
`a665816693141beb1217e9a7fd87c70e2381a0782a508c7b4720dd18d4bdd0f3`.
Pinned image:
`sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`.

Aktualny validate_build_receipt odrzuca ten starszy pakiet z powodu braku
`bin/fullmag-runtime-service`, dodanego po przypiętym commicie. Jest to
historyczny build PASS, ale aktualny kontrakt produktu NOT VERIFIED.
Nie osłabiono wymagań nowego produktu i nie podłączono starego pakietu jako
odbioru P8-33 API statusu. Nowy kod API jest przypięty w buildzie 214.
Nie jest to runtime/solver/Windows/browser ani kwalifikacja naukowa.
