# P4-B — jednorazowy launch intent procesu preparacji

Data: 27.09.2026
Implementacja: bieżący commit

## Kontrakt uruchomienia

`preparation_process_launch.v1` jest trwałą granicą przed uruchomieniem
procesu przygotowania FEM. Rekord wiąże RunId, TaskId, preparation attempt,
resource_id, lease token, bieżącą sekwencję heartbeat oraz tożsamość procesu
supervisora. Store zapisuje go immutable pod writer lockiem i ponownie
sprawdza, że task pozostaje `Accepted` bez solver claimu, a dokładny
preparation lease jest aktywny.

Tylko wynik `Accepted` pierwszego zapisu uprawnia supervisora do wykonania
spawn. Identyczny zapis zwraca `Replayed`, co oznacza niejednoznaczny stan po
restarcie: poprzedni supervisor mógł już uruchomić proces. Replay nie uprawnia
więc do ponownego spawn i zachowuje lease do jawnej rekoncyliacji. Inny launch
dla tej samej tożsamości attemptu i lease jest konfliktem.

`preparation_process_exit_receipt.v1` wymaga teraz dokładnie jednego
odpowiadającego launch intentu. Sekwencja heartbeat z launchu nie może być
nowsza niż sekwencja exit receiptu. Dzięki temu trwałego dowodu zakończenia nie
można opublikować dla procesu uruchomionego poza kontrolowaną granicą.

Launch intent jest eksportowany do FMS i walidowany przez store/archive
reachability także wtedy, gdy accepted run nie ma jeszcze solverowego
`run_manifest.json`.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| `cargo check --locked -p fullmag-session -p fullmag-runtime-control -p fullmag-api --bin fullmag-api-preparation-resource-pool --bin fullmag-api-accepted-fem-preparer` | **PASS** |
| `git diff --check` | **PASS** |
| Globalny `cargo fmt --all -- --check` | **BASELINE FAIL** — wcześniejsze odchylenia także w wielu niezmienionych plikach |
| Targety testów jednostkowych | **NOT RUN** — aktywny zakaz ich kompilowania |
| Supervisor/process E2E/native FEM | **NOT VERIFIED** |

Następny krok to proces supervisora. Ma najpierw odzyskać istniejący exit albo
launch intent, uruchomić preparer wyłącznie po nowym `Accepted`, odnawiać lease,
potwierdzić zakończenie potomka, zapisać exit receipt i wywołać atomową
finalizację. P4 pozostaje na **50%**, cały plan na około **49%**.
