# P6-A — automatyczne recovery katalogu SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / API/RUNTIME NOT VERIFIED**

## Zakres przyrostu

`SolutionSetCatalog::open` uruchamia teraz recovery całego istniejącego
katalogu przed zwróceniem uchwytu klientowi. Operacja odbywa się pod jednym
native writer lease, więc discovery, walidacja i promocja current manifestów
nie konkurują z publikacją innego procesu.

`reconcile_all` skanuje wyłącznie portable katalogi o nazwie będącej
kanonicznym małym SHA-256. Logiczne `solution_set_id` jest odczytywane z
current manifestu albo, dla osieroconej publikacji, z najwcześniejszej
immutable revision. Hash logicznego ID musi dokładnie odpowiadać nazwie
katalogu. Następnie istniejące reconciliation ponownie waliduje cały ciąg
`1..N` i atomowo promuje najnowszą poprawną rewizję.

Pliki o niepoprawnej nazwie, niebędące plikami wpisy rewizji, obca tożsamość,
nieciągła historia, uszkodzony manifest oraz niedozwolone przejście powodują
fail-closed otwarcia katalogu. Pusty katalog powstały przed pierwszym trwałym
zapisem nie zawiera stanu do odzyskania i jest pomijany. Wyniki recovery są
zwracane także przez publiczne `reconcile_all`, co pozwoli przyszłemu
startupowi SessionStore/API emitować diagnostykę bez ponownego skanowania.

## Dowody

- `rustfmt` dla modułu katalogu: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery wcześniejsze
  warningi innych plików pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- scoped `git diff --check`: **PASS**.
- Regresja tworzy orphan revision, ponownie otwiera katalog i sprawdza
  automatyczną promocję oraz idempotentne kolejne reconciliation. Została
  zapisana, lecz pozostaje **NOT RUN** zgodnie z tymczasowym zakazem testów
  jednostkowych w `AGENTS.md`.

## Otwarte elementy

Katalog jest osadzony w `SessionStore`, ale brakuje raportowania recovery przez
startup API, writerów runnera, fault injection procesu/zasilania, quarantine i
kontrolowanej naprawy uszkodzonego katalogu, GC reachability, `.fms` pack/unpack
oraz kwalifikacji czterech lane'ów. CAE-04/37/61/70 pozostają **NOT VERIFIED**.
