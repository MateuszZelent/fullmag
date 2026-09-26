# P3-B — odtworzenie wejścia po komendzie Start

Data: 25.09.2026

## Zakres

`WorkerCommand::Start` nie przenosi payloadu `ResolvedTaskInput`. Nowy
`fullmag-runtime-control::load_accepted_worker_step_for_start` odtwarza zatem
kontekst solvera z dokładnego, wcześniejszego `Prepare` w durable coordinator
journalu, zamiast polegać na stanie pamięci procesu worker.

Resolver wymaga komendy `Start`, aktualnego claimu i kompletnego odzyskiwalnego
journalu. Sprawdza, że dokładny envelope `Start` jest zapisany oraz że przed
nim występuje dokładnie jeden zapisany `Prepare` tego claimu. Następnie
deleguje do `load_accepted_worker_step`, który weryfikuje zaakceptowany study,
plan, horyzont, receipt, zależności, lease i payload `Prepare`.

## Weryfikacja

`just verify-api-project-runs` — **4 passed, 0 failed, 2 ignored**, exit 0,
receipt `f859f5a023c3420faa60b220837626df`, profil
`windows-api-source-check`, branch `master`,
`source_changed_during_run=false`. Regresja zapisuje `Start`, odzyskuje z niego
ten sam `AcceptedWorkerStep` co z `Prepare` i odrzuca `Start` o nieznanym
message ID. `python scripts/check_repo_consistency.py` — PASS;
`git diff --check` — PASS z ostrzeżeniami LF/CRLF już występujących w brudnym
checkoutcie.

## Granica odbioru

Ten helper umożliwia procesowemu workerowi odzyskanie wejścia w chwili
wykonania, ale sam nie wykonuje ani nie potwierdza komendy `Start`. Nie tworzy
process admission, nie ogranicza współbieżności, nie materializuje stanu
`StepOutput` w przestrzeni docelowej, nie wywołuje runnera i nie publikuje
wyników. Te bramki pozostają wymagane przed zaliczeniem P3-B. Procenty bez
zmian: P3 **50%**, całość około **27%**.

Checkout: `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty; bez stage,
commitu i cleanupu.
