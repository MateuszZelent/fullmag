# P3-B — kolejka ready sterowana zależnościami

Data: 25.09.2026

## Zmiana

`fullmag_runtime_control::queue_accepted_study_task` wprowadza pojedynczy,
durable krok schedulera dla zaakceptowanego study. Funkcja ponownie ładuje
immutable accepted snapshot i wymaga włączonego, zaplanowanego kroku,
zgodnego task ID oraz fingerprintu. Przed zmianą catalogu odczytuje i wiąże
trwały preparation receipt, rozwiązuje wymagane wejścia oraz sprawdza
deklarację portów, udaną próbę źródłowego kroku, manifest, codec i bajty CAS
dla `StepOutput`.

Tylko stan utworzony przez materializację — `Accepted` z dokładnym
scheduler-owned blocked reason i bez śladów claimu — może przejść do
`Queued/Ready`. Zmiana jest publikowana jako kolejna rewizja run catalogu.
Idempotentny replay dopuszcza tylko nieprzypisany `Queued/Ready` i ponownie
sprawdza receipt oraz wejścia. Błędne wejście jest odrzucane przed zapisem.
Konflikt równoległego writera pozostaje konfliktem rewizji; caller musi
odczytać świeży stan przed retry.

Test accepted-run zastępuje ręczną edycję catalogu tą granicą. Pokazuje
odrzucenie niezadeklarowanego portu bez zmiany rewizji/readiness, przejście
do kolejki, replay i późniejsze durable admission oraz publikację `Prepare`.

## Weryfikacja

- `just verify-api-project-runs`: **6 passed, 0 failed, 2 ignored**, receipt
  `e4cd6869dfdb40b8851d27b981e5640c`, `source_changed_during_run=false`.
- `just check-api-source`: **PASS**, receipt
  `57688c144f8344a3a79647ac82a39ce4`, `source_changed_during_run=false`.
- `python scripts/check_repo_consistency.py`: **PASS**.
- `git diff --check` dla zmienionych plików API: **exit 0** (jedynie ostrzeżenie o normalizacji LF/CRLF).
- Skan nowych/edytowanych dokumentów planu nie znalazł końcowych spacji.
- Pełny `git diff --check` nie jest czysty: istniejące zakończenia CR w szeroko
  zmienionym `06-status-realizacji.md` są raportowane jako whitespace. Nie
  konwertowano całego dokumentu, by nie wprowadzać niezwiązanego churnu.
- Pełny plikowy `rustfmt --check` pozostaje nieczysty z powodu wcześniejszych
  nieformatowanych fragmentów w szerszym dirty checkoutcie; nowo dodane bloki
  zostały dopasowane do formatowania bez automatycznego formatowania całych
  współdzielonych plików.

## Granica odbioru

Jest to sprawdzony adapter gotowości jednego taska, nie działający scheduler.
Nie wybiera zasobu, nie ogranicza współbieżności, nie zapisuje resolved-device
provenance, nie tworzy supervisora ani transportu i nie uruchamia procesu
runnera/solvera. Pełna walidacja źródeł zewnętrznych oraz podłączenie kolejki
do produkcyjnego call site nadal należą do dalszej integracji P3/P5-B.
Nie wykonano runtime ani walidacji fizycznej; P3 pozostaje **50%**, a plan
globalny około **27%**.

Checkout: `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty; bez stage,
commitu i cleanupu.
