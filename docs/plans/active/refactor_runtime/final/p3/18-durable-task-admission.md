# P3-B — trwałe admission taska

Data: 25.09.2026

## Zakres

`SessionStore::commit_task_admission` przyjmuje tylko gotowy, nieprzypisany
task w stanie `Queued` oraz świeży, aktywny lease z kolejnym ownership epoch.
Nie wybiera zasobu i nie rozstrzyga capability/backendu; caller musi przekazać
jawny lease zgodny z zadaniem.

Przed zmianą run catalogu i publikacją lease'u store zapisuje immutable
`task_admission.v1` pod `runs/<run>/task_admissions/<task>/<attempt>.json`.
Rekord zawiera poprzedni task, projekcję taska `Preparing`, expected catalog
revision oraz dokładne dane lease/tokenu. Pod single-writer lease store
publikuje następnie nowy catalog i lease. Jeżeli proces przerwie pracę między
zapisami, `reconcile_task_admissions` odtwarza brakujące projekcje z tego samego
rekordu; nie tworzy nowego attemptu ani lease tokenu.

Powtórzony admission z identycznym lease'em jest idempotentny. Rekord starszego
ownership epoch jest ignorowany jako `Superseded`; task terminalny nie
reaktywuje zasobu. Istniejący released/conflicting lease nie jest nadpisywany,
a aktywny lease zasobu odrzuca nowy admission przed publikacją intentu.
Walidacja taska ogranicza zmianę do lifecycle, readiness i pól claimu; wejściowy
fingerprint, outputy i inne dane taska pozostają niezmienione.

Reachability/GC oraz pack/preflight `.fms` walidują schemat admission, tożsamość
run/task/attempt w ścieżce i fingerprint wobec katalogu. Archiwum zachowuje
typed admission records zamiast pomijać je jako nieznane pliki.

## Weryfikacja

`just verify-session-persistence` — **64 testy biblioteki, 9 testów archiwum i
13 testów storage PASS**, exit 0, receipt
`5bf26751212a46d091ca2f9300d2ca53`, profil `windows-session-check`,
`source_changed_during_run=false`. Testy sprawdzają replay bez nowego attemptu,
odtworzenie intentu opublikowanego przed projekcjami, naprawę brakującego lease'u
bez zmiany claimu, odmowę zajętego CPU, traversal reachability oraz eksport/import
`.fms` z typed admission, reconciliation i zachowaniem aktywnego lease'u.

`python scripts/check_repo_consistency.py` — PASS; `git diff --check` — PASS.

## Granica odbioru

To jest trwała granica admission w `SessionStore`, nie production call site.
Brakuje schedulera, który rozwiązuje zależności i wprowadza gotowy task do
`Queued`, supervisora procesu, transportu workerów, wykonania solvera oraz
publikacji kompletnego output manifestu przed `Completed`. Nie jest to dowód
runtime ani scientific qualification. P3 pozostaje **50%**, plan całości około
**27%**.

Checkout: `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty; bez stage,
commitu i cleanupu.
