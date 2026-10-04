# P6-A — integracja SolutionSet z SessionStore

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / API/RUNTIME NOT VERIFIED**

## Zakres przyrostu

`SessionStore` posiada teraz jeden `SolutionSetCatalog` związany z tym samym
kanonicznym rootem i tym samym `Arc<Writer>` co manifesty, CAS, runy i lease'y.
Publiczny accessor `solution_sets()` udostępnia odczyt i reconciliation;
publikacja przechodzi przez `SessionStore::publish_solution_set`, który
egzekwuje integralność referencji CAS.

Zwykły `SessionStore::open` tworzy katalog współdzielonym writerem i wykonuje
pełne startup recovery przed zwróceniem store klientowi. W rezultacie restart
API lub procesu session store domyka poprawną publikację przerwaną między
immutable revision i current manifestem. Błąd integralności zatrzymuje otwarcie
całej sesji fail-closed.

`SessionStore::open_existing` zachowuje dotychczasową semantykę inspekcji i GC
preview: wiąże istniejący katalog oraz writer, lecz nie uruchamia reconciliation
i nie zapisuje danych podczas otwarcia. Późniejsza jawna mutacja nadal wymaga
tego samego native writer lease.

## Dowody

- `rustfmt` modułu katalogu i scoped `git diff --check`: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery wcześniejsze
  warningi innych plików pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- Regresja zapisuje orphan revision przez accessor `SessionStore`, ponownie
  otwiera store i sprawdza automatyczną promocję. Została zapisana, lecz
  pozostaje **NOT RUN** zgodnie z tymczasowym zakazem testów jednostkowych w
  `AGENTS.md`.

## Otwarte elementy

SolutionSet uczestniczy w store reachability/GC i typowanym `.fms` pack/unpack,
lecz nie w publicznym API. CAS publication barrier jest wdrożony, lecz brakuje mappera
terminalnego run/task catalogu do rewizji,
writerów artefaktów FDM CPU/GPU i FEM CPU/GPU, migracji legacy resource keys,
fault injection procesu/zasilania oraz kwalifikacji CAE-04/37/61/70.
