# P3-B — materializacja stanu Study w planie runnera

Data: 25.09.2026

## Zakres

Worker otrzymuje stan jako typowany artefakt CAS. Nowe funkcje runnera
`study_magnetization_layout_for_plan` i
`materialize_study_magnetization_input` tworzą dokładną granicę do jego
podania: layout źródłowy musi być identyczny z layoutem kanonicznie
wygenerowanym z accepted `ExecutionPlanIR`; zgodne muszą być również sample
count i segmenty per warstwa. Funkcja tworzy kopię planu i podmienia wyłącznie
wektor magnetyzacji początkowej.

Obsługiwane są FDM, FDM multilayer oraz FEM H1 P1. Inne plan variants,
niedopasowane przestrzenie i niezgodne próbki kończą się błędem. Nie ma
interpolacji, automatycznego resize'u ani zmiany backendu. Layout jest
udostępniony przez istniejący generator artefaktów runnera, aby adapter nie
duplikował schematu przestrzeni.

## Weryfikacja

`just verify-api-project-runs` — **4 passed, 0 failed, 2 ignored**, exit 0,
receipt `3eb4cc2deba64adfa6a2cedb713c510b`, profil
`windows-api-source-check`, `source_changed_during_run=false`. Regresja
sprawdza zmianę wyłącznie magnetyzacji w kopii planu oraz odmowę dla innego
layoutu, błędnej liczby próbek i wartości niefinitywnych.
`python scripts/check_repo_consistency.py` — PASS; `git diff --check` — PASS,
z ostrzeżeniami LF/CRLF w istniejących plikach checkoutu.

## Granica odbioru

To jest gotowy input adapter runnera, ale żaden production supervisor nie
wywołuje go jeszcze. Nie pobiera sam bajtów z CAS, nie tworzy attempt
directory, nie uruchamia solvera i nie publikuje output manifestu. Następne
P3-B wymaga podłączenia go do trwałego worker `Start`, fenced process
admission i zarządzanego execution. Nie dowodzi to transferu cross-space ani
runtime solvera; P3 pozostaje **50%**, plan globalny około **27%**.

Checkout: `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty; bez stage,
commitu i cleanupu.
