# P6-A — GC reachability SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

Store reachability walker rozpoznaje teraz `solutions/` jako typowany root.
Dla każdego portable katalogu sprawdza SHA-256 logicznego `solution_set_id`,
odczytuje current manifest i wszystkie immutable revisions, wymaga nazw
`<20 cyfr>.json`, dodatnich oraz ciągłych rewizji `1..N` i ponownie stosuje
reguły monotonicznego następstwa katalogu. Current musi być identyczny z
odpowiadającą mu immutable revision; poprawna orphan history bez current
pozostaje pełnoprawnym rootem recovery.

Traversal dodaje do mark setu każdy artifact i coverage segment ze wszystkich
rewizji. Dla każdej referencji sprawdza obecność, pełny SHA-256 i exact
`byte_length`. Wspólny helper CAS wykonuje tę kontrolę strumieniowo buforem
64 KiB, więc GC nie materializuje dużego payloadu. Brak lub korupcja obiektu,
nieciągła historia, obca tożsamość albo nieznany plik blokują GC fail-closed.

Immutable historia jest zachowywana w całości. Dzięki temu GC nie usuwa
obiektu potrzebnego do audytu starszej rewizji ani do domknięcia przerwanej
publikacji, nawet gdy current wskazuje wcześniejszą wersję.

## Dowody

- `rustfmt` trzech zmienianych modułów i scoped `git diff --check`: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery wcześniejsze
  warningi innych plików pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- Regresja publikuje obiekt CAS i SolutionSet, uruchamia walker w trybie GC i
  sprawdza object/file roots. Została zapisana, lecz pozostaje **NOT RUN**
  zgodnie z tymczasowym zakazem testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Portable `.fms` pakuje i odtwarza typowany namespace `solutions/`, a trwały
root graph zwalnia dokładne piny SolutionSet. Brakuje mappera outputów
runnera, publicznego API, migracji legacy resource keys, process/power-loss
fault injection oraz kwalifikacji czterech lane'ów i CAE-04/37/61/70.
