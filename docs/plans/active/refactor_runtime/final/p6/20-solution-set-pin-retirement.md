# P6-A — zwalnianie pinów CAS po publikacji SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

`SessionStore::publish_solution_set` zachowuje jedną transakcję writera dla
pełnej kontroli SHA-256 i długości, publikacji immutable rewizji oraz usunięcia
pinów dokładnie tych obiektów, które stały się trwałymi korzeniami SolutionSet.
Niepowiązane piny innego ingestu pozostają nietknięte.

`SessionStore::open` uruchamia scoped recovery pinów SolutionSet bez wiązania
zwykłego otwarcia z mutowalnymi runami. Ponownie sprawdza ciągłość rewizji,
monotoniczne następstwo, identity current manifestu, wszystkie
artifact/coverage refs oraz pełne SHA-256 i długości CAS. Ogólne
`release_published_pins` obejmuje immutable checkpointy i tę samą pełną
historię SolutionSet. Brak, korupcja lub luka zatrzymuje operację fail-closed.
Dzięki temu restart może bezpiecznie dokończyć przerwanie między trwałym
zapisem manifestu a usunięciem pliku pinu.

## Dowody

- `cargo check -p fullmag-session --lib`: **PASS**; cztery istniejące warningi
  poza zakresem pozostają bez zmian.
- Scoped Clippy `--no-deps -D warnings` z jawną allow-listą wcześniejszych
  lintów crate'u: **PASS**.
- `rustfmt` zmienianych modułów i `git diff --check`: **PASS**.
- Regresje sprawdzają selektywne zwolnienie pinu po publikacji oraz recovery
  po symulowanym przerwaniu po immutable manifest commit. Zostały zapisane,
  lecz pozostają **NOT RUN** zgodnie z tymczasowym zakazem budowania testów
  jednostkowych w `AGENTS.md`.

## Otwarte elementy

Brakuje migracji legacy resource keys copy-on-write i raportu CAE-04/70,
mappera terminalnych outputów runnera, publicznego API, process/power-loss
fault injection oraz kwalifikacji reopen bez solvera i czterech lane'ów
(CAE-37/61).
