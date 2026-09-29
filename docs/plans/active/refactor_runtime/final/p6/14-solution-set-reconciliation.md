# P6-A — reconciliation rewizji SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / SESSIONSTORE/API NOT VERIFIED**

## Zakres przyrostu

`SolutionSetCatalog::reconcile` odzyskuje publikację przerwaną po trwałym
zapisie immutable revision, lecz przed atomową aktualizacją current manifestu.
Operacja działa pod istniejącym single-writer lease i przed jakąkolwiek zmianą
odczytuje cały katalog `revisions/` dla wskazanego logicznego SolutionSet.

Reconciliation akceptuje wyłącznie ciągły łańcuch `1..N`. Nazwa każdego pliku,
pole `revision` i `solution_set_id` muszą wskazywać ten sam rekord. Każde
przejście jest ponownie sprawdzane przez te same reguły co zwykła publikacja:
stałe provenance/run/identity, append-only artifacts i coverage, brak regresji
statusów terminalnych oraz brak rewizji po zamknięciu manifestu.

Jeżeli `manifest.json` istnieje, musi być identyczny z odpowiadającą mu
immutable revision. Dopiero po przejściu całego łańcucha katalog atomowo
promuje najnowszą rewizję. Brak current manifestu z poprawną historią jest
obsługiwany tak samo. Luka, uszkodzony JSON, obca tożsamość, konflikt current,
niepoprawna nazwa pliku lub nielegalny następnik kończą operację fail-closed
bez zmiany publicznego wskaźnika.

Wynik `SolutionSetReconciliation` zachowuje poprzednią rewizję current,
ewentualnie promowaną rewizję i liczbę zweryfikowanych rekordów. Pusta historia
bez current jest poprawnym no-op; current bez historii jest odrzucany.

## Dowody

- `rustfmt` dla modułu katalogu: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery wcześniejsze
  warningi innych plików pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- `git diff --check`: **PASS**.
- Regresja promocji poprawnej orphan revision została zapisana, lecz pozostaje
  **NOT RUN** zgodnie z tymczasowym zakazem testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Reconciliation działa przy otwarciu katalogu i zwykłym startupie `SessionStore`,
lecz nie jest jeszcze podłączone do runner publication barrier i publicznego
API/CLI. Brakuje fault injection dla awarii zasilania,
quarantine/diagnostyki uszkodzonych łańcuchów, GC reachability, `.fms`
pack/unpack, writerów czterech lane'ów oraz ich kwalifikacji. CAE-04/37/61/70
pozostają **NOT VERIFIED**.
