# Trwały receipt przygotowania per task

Data: 25.09.2026

Zakres: P3-B / P5-A — trwała publikacja przygotowania accepted-run FDM.

## Wynik

`fullmag-session` dodaje `task_preparation_receipt.v1` pod ścieżką
`runs/<run_id>/task_preparation_receipts/<task_id>.json`. Jeden wspólny helper
wyprowadza `task_id` z `(run_id, step_id)`, a envelope wiąże się z fingerprintem
wejścia z katalogu tasków. Walidacja sprawdza digest payloadu, zgodność
`run_id`/`step_id` w envelope, planie v2 i `accepted_run_source`, zgodność
RunSpec z trwałym RunIntent oraz obecność taska i fingerprintu wejścia w
`run_catalog`.

Każdy pojedynczy zapis jest atomowy pod writer lease, niezmienny po pierwszej
publikacji i idempotentny dla tego samego payloadu. Publikacja katalogu oraz
wielu receiptów nie stanowi jednej transakcji: awaria może pozostawić częściowy
zestaw. Replay naprawia brakujące wpisy, a każdy task bez własnego receiptu
pozostaje zablokowany. Admission ma sprawdzać receipt i zależności konkretnego
taska, bez globalnej bariery dla niezależnych kroków. `preparation_id` jest
deterministyczny (`prep-<task_id>`). Istniejący top-level
`preparation_receipt.json` pozostaje bez zmian dla Live.

API materializuje task catalog przed receiptami. Przy każdym replay odczytuje
ponownie immutable accepted snapshot i naprawia brakujący receipt; wcześniejszy
powrót dla istniejącego katalogu nie pomija już publikacji. Receipt powstaje
wyłącznie dla zaplanowanych kroków FDM. FEM nie ma tu producenta native mesh/
space i pozostaje bez receiptu. Żaden task nie jest odblokowywany: wszystkie
zachowują `Accepted/Blocked` do czasu rozwiązania zależności i osobnego
admission.

Eksport `.fms`, preflight/import i reachability rozpoznają katalog receiptów.
Każdy dokument jest sprawdzany względem task catalog i accepted RunIntent, więc
replay, archiwizacja i GC używają tej samej tożsamości.

## Regresje i weryfikacja

- API: materializacja ProjectRun sprawdza trwały v2 receipt per task, jego
  accepted-run `step_id` oraz niezmienione `Accepted/Blocked`.
- SessionStore: zapis/replay po nowym envelope, odczyt, odmowa podmiany, zły
  source identity i deterministyczny task ID.
- `.fms`: round-trip zachowuje receipt i zablokowany task; preflight wykazuje
  receipt jako osiągalny dokument runu.
- `rustfmt --edition 2021 --config skip_children=true --check` dla zmienionych
  modułów Rust: **PASS**.
- `git diff --check` dla zmienionych plików: **PASS**; pozostały wyłącznie
  ostrzeżenia Git o konwersji LF/CRLF.
- Testy API/session/archive i kompilacja: **NOT RUN / NOT VERIFIED**. Managed
  runner nadal zgłasza `Container profile allow-list mismatch`, a
  `runner-doctor` nie może poświadczyć kontekstu Docker Desktop. Hostowego Cargo
  nie uruchamiałem.

Regresje źródłowe nie dowodzą trwałości po restarcie procesu ani użycia przez
worker. Kolejny przyrost dodaje typowany odczyt i application binding na
`AcceptedStudySnapshot`; pozostaje podłączenie go do worker/admission, rozwiązanie
zależności i dopiero późniejsza zmiana readiness. Oddzielne pozostają producer
FEM, transport CLI, supervisor, wykonanie solvera i walidacja naukowa.

Warstwa session/archive waliduje envelope, digest i tożsamość powiązanych
dokumentów. Typowany czytnik runtime-control dekoduje pełny application receipt,
sprawdza fingerprint planu i certyfikaty oraz wiąże go z immutable
`AcceptedStudySnapshot`; szczegóły są w
[`08-typed-task-preparation-reader.md`](08-typed-task-preparation-reader.md).
Żaden produkcyjny worker nie wywołuje jeszcze tej ścieżki, a cały zestaw
receiptów nadal nie jest publikowany jako jedna transakcja.

Zmiana decyzji persystencji jest dopisana do
[`ADR-0009`](../../../../../adr/0009-geometry-invalidates-mesh.md). Procenty
P3 i planu całości pozostają bez zmian do przejścia wymaganej bramki testowej.
