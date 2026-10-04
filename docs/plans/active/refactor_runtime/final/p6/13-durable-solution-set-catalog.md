# P6-A — trwały katalog SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / API/RUNTIME NOT VERIFIED**

## Zakres przyrostu

`fullmag_session::solution_set_catalog::SolutionSetCatalog` publikuje
wersjonowane wyniki pod `solutions/<sha256(logical-id)>`. Hashowana nazwa
katalogu zachowuje logiczne ID zawierające np. `:`, a jednocześnie spełnia
portable path contract Windows/Linux. Każdy manifest jest ponownie walidowany
po odczycie i musi zawierać ID zgodne z katalogiem.

Publikacja używa istniejącego native single-writer lease i durability barrier:

1. zapisuje immutable `revisions/<20-digit-revision>.json`,
2. następnie atomowo aktualizuje `manifest.json`,
3. po przerwaniu między krokami pozostawia bezpieczną orphan revision,
4. ponowienie tej samej rewizji z identyczną treścią domyka current manifest,
5. konflikt tej samej rewizji z inną treścią jest odrzucany.

Pierwsza rewizja musi wynosić 1, kolejne rosną dokładnie o jeden. Provenance,
run i logical identity nie mogą się zmienić. Członek task/attempt/epoch nie może
zniknąć ani zmienić execution identity; terminalny status nie wraca do running.
Artefakty są append-only i immutable. Coverage może rosnąć
`unknown → partial → complete`; istniejące segmenty pozostają dokładnym
prefiksem, liczba committed samples nie maleje, a znane expected samples nie
mogą się zmienić. Zamknięty manifest jest immutable.

Katalog udostępnia odczyt latest, odczyt konkretnej rewizji i deterministyczną
listę. Katalogi z orphan revision bez current manifest są pomijane przez listę,
lecz pozostają dostępne dla kontrolowanego ponowienia publikacji.

## Dowody

- `rustfmt` dla nowego modułu: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery istniejące warningi
  innych plików pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- `git diff --check`: **PASS**.
- Regresja monotonicznych rewizji i immutable close została zapisana, lecz
  pozostaje **NOT RUN** zgodnie z tymczasowym zakazem testów jednostkowych w
  `AGENTS.md`.

## Otwarte elementy

Katalog jest osadzony w `SessionStore`, lecz nie jest jeszcze wywoływany przez
runner publication barrier ani udostępniony w publicznym API. Brakuje writerów
artefaktów czterech lane'ów, fault injection durability, GC reachability,
`.fms` pack/unpack oraz migracji legacy resource keys. CAE-04/37/61/70
pozostają **NOT VERIFIED**.
