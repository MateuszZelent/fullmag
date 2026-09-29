# P6-A — CAS publication barrier SolutionSet

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNNER/API NOT VERIFIED**

## Zakres przyrostu

`SessionStore::publish_solution_set` jest mutacyjną granicą publikacji
SolutionSet. Najpierw waliduje kontrakt manifestu, następnie pod wspólnym
native writer lease zbiera wszystkie `object_ref` z artifactów członków i
segmentów coverage. Powtórzona referencja musi deklarować ten sam byte length.

Każdy unikalny obiekt przechodzi `CasStore::verified_length`: pełna zawartość
jest odczytywana buforem 64 KiB, hashowana SHA-256 i porównywana z identity
ścieżki. Metoda nie materializuje payloadu, obsługuje również obiekt pusty i
sprawdza, że długość nie zmieniła się podczas odczytu. Brak obiektu, naruszony
hash albo różnica między rzeczywistym i zadeklarowanym `byte_length` zatrzymuje
publikację przed zapisem immutable revision.

Dopiero po przejściu wszystkich referencji ten sam writer lease wykonuje
`publish_locked`. Dzięki temu równoległy zweryfikowany GC nie może usunąć
obiektu między kontrolą a publikacją manifestu. Bezpośrednia metoda publikacji
katalogu pozostaje dostępna wyłącznie dla regresji modułu; produkcyjny caller
korzysta z `SessionStore`.

## Dowody

- `rustfmt` dla CAS i katalogu oraz scoped `git diff --check`: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery wcześniejsze
  warningi innych plików pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- Regresja sprawdza brakujący obiekt, niezgodną długość, brak opublikowanego
  manifestu po obu odmowach oraz sukces dla zweryfikowanego CAS. Została
  zapisana, lecz pozostaje **NOT RUN** zgodnie z tymczasowym zakazem testów
  jednostkowych w `AGENTS.md`.

## Otwarte elementy

Brakuje automatycznego mapowania terminalnych outputów runnera do SolutionSet,
publicznego API,
migracji legacy resource keys, process/power-loss fault injection oraz
kwalifikacji czterech lane'ów i CAE-04/37/61/70.
