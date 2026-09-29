# P6-A — portable `.fms` dla SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNNER/API NOT VERIFIED**

## Zakres przyrostu

Format `.fms` zachowuje teraz typowany namespace
`solutions/<sha256(logical-id)>/` z current manifestem i wszystkimi immutable
rewizjami. Profile z `ArtifactPolicy::Selected` lub `All` (`Solved`, `Resume`,
`Archive`) pakują katalog SolutionSet; profile z polityką `None` (`Compact`,
`Recovery`) świadomie go pomijają zamiast tworzyć niekompletny solved result.

Plan eksportu odczytuje namespace z zachowaniem ochrony przed symlinkami,
reparse points, wyjściem poza store i case-fold collisions. Archive walker
ponownie sprawdza portable ścieżki, hash logicznego ID, dokładne nazwy rewizji,
ciągłość `1..N`, reguły następstwa i zgodność current z immutable history.
Każdy artifact i coverage segment dołącza do archiwum wyłącznie dokładny CAS
object wskazany przez manifest; preflight sprawdza jego pełny hash oraz byte
length.

Import wykonuje pełny preflight przed pierwszym zapisem. Następnie publikuje
CAS, dokumenty i checkpoint markers w dotychczasowej kolejności, zapisuje
namespace `solutions/` przez wewnętrzny adapter importu i uruchamia
`reconcile_all` przed commit SessionManifest. Odtworzony current i immutable
revisions zachowują oryginalne bajty i content identities; poprawna orphan
history jest domykana tym samym mechanizmem recovery co lokalny restart.

## Dowody

- `rustfmt` zmienianych modułów i scoped `git diff --check`: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery wcześniejsze
  warningi innych plików pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- Regresja roundtripu `Solved` publikuje SolutionSet z realnym obiektem CAS,
  pakuje archiwum, sprawdza preflight paths/object bytes, odtwarza nowy store i
  porównuje manifest oraz payload. Została zapisana, lecz pozostaje **NOT RUN**
  zgodnie z tymczasowym zakazem testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Brakuje migracji legacy resource keys copy-on-write i raportu CAE-04/70,
mappera terminalnych outputów runnera, publicznego API, process/power-loss
fault injection oraz
kwalifikacji reopen bez solvera i czterech lane'ów (CAE-37/61).
