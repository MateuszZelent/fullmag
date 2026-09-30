# S07 — tożsamość diagnostyki próbki

## Problem potwierdzony w źródłach

sample_native_solver_diagnostics wybierał pierwszy rekord, gdy próbka nie
została znaleziona. W przypadku jednego rekordu pomijał kontrolę sample_index,
również przy preferowaniu wzbogaconego korzenia. Konsumenci: mode_bundle,
modal_manifest, field_sweep i Kittel. Mogło to przypisać innemu punktowi k
hash handoffu, siatki, operatora albo dane wykonania.

## Przygotowana poprawka — WIP

Wspólny helper wymaga dokładnie jednego rekordu z właściwym sample_index.
Brak tożsamości, brak dopasowania, duplikat, niepoprawna lista lub nieobiektowa
diagnoza nie otrzymują fallbacku pierwszej próbki. Wzbogacony singleton jest
zachowany dopiero po sprawdzeniu tożsamości. Korzeń bez kolekcji diagnostyk
zachowuje istniejącą semantykę lokalnych danych SingleKSolveResult.

Dodano regresje: obca próbka/singleton, kolekcja bez dopasowania, brak indeksu,
duplikat, niepoprawna lista, null diagnostics, poprawne unikalne dopasowanie.
Uzupełniono brakujące sample_index w starej fixture GPU; zachowano istniejący
test wzbogaconego singletona i pozostałe wcześniejsze zmiany tests.rs.

## Dowody i brakujące bramki

rustfmt --emit stdout (bez zapisu plików) i git diff --check: exit0.
To wyłącznie kontrola składni/higieny, nie wykonanie regresji.
Testów Rust NIE skompilowano i NIE uruchomiono zgodnie z obowiązującym zakazem
AGENTS.md. Kod i testy pozostają robocze; nie oznaczono naprawy jako ukończonej.
Przed uznaniem wymagana właściwa bramka wykonawcza tożsamości artefaktów.
Snapshot joba #179 nie zawiera tej późniejszej poprawki.

## Tożsamość przygotowanych źródeł

- common.rs SHA256: 2329f115f9135539663f5891d074a1cb327e3ff514c9349c6c2ac163a420c115
- tests.rs SHA256 całego roboczego pliku (z wcześniejszym WIP): f368972111bbf903bad6d6b8ee751b807b8bf89fded040e0b011fcf70b66e5ce
