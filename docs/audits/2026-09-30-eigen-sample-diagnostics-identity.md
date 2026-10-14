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

## Dalsza kontrola adaptera Kittela — 2026-09-30

Potwierdzono drugi niezależny fallback w adapterze fizycznego porównania
Kittela: przy brakującym sample_index wybierał cały globalny korzeń; duplikat
wybierał pierwszy wpis. Adapter korzysta teraz z tego samego selektora co
artefakty modalne. Brak/duplikat nie otrzymuje danych innej próbki.

Wybrany rekord musi mieć obiekt diagnostics także wtedy, gdy singleton ma
wzbogacony korzeń. Nieobiektowy korzeń jest odrzucany. Dodano źródłowe regresje
null/tablicy/liczby w diagnostics oraz zachowania lokalnego i wzbogaconego
rekordu. Kittel.rs miał wcześniejszy WIP; zmieniono tylko wskazany odczyt.

Parser rustfmt i scoped diff check exit0. Regresje Rust nadal NIE zostały
skompilowane ani uruchomione. Poprawka pozostaje WIP i nie jest w snapshotcie
#179. Nie stanowi dowodu naprawionej kwalifikacji K0 ani dyspersji.

Aktualne hashe całych roboczych plików (w tym wcześniejszego WIP):

- common.rs SHA256: 0063df7318cb5a4942d9e94309f7c375010b2b872baff4192e218b68d66486e0
- kittel.rs SHA256: a80a3718aaabd3eea8cc8d19edf31658845a95510e0560202a488b1d181a732b
- tests.rs SHA256: 0111c48e0718a8ac1b580231f6c0bdd410a7b2810da51b617cfa8581720f77dd
