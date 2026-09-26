# P3-B — fence urządzenia w durable admission

Data: 25.09.2026

## Zmiana

`commit_claimed_task_admission` przed zapisem claimu i lease'u odtwarza
immutable RunSpec oraz accepted study, wiąże task ID z dokładnie jednym
włączonym, zaplanowanym krokiem i porównuje ofertę zasobu z `RunSpec.device`.
Study solver task może dostać wyłącznie lease CPU albo GPU; jawne `cpu` i `gpu`
nie mogą zamienić się miejscami. Dla FEM eigen lease musi dodatkowo zgadzać się
z urządzeniem rozstrzygniętym przez planner. Przy `auto` wybrany rodzaj zasobu
pozostaje zapisany w durable lease.

Kontrola dzieje się przed `SessionStore::commit_task_admission`, więc błędna
oferta nie zapisuje attemptu, epoch ani resource lease. Replay trwałego claimu
przechodzi tę samą kontrolę.

## Weryfikacja

- Regresja przed poprawką ujawniła akceptację GPU lease dla RunSpec `cpu`:
  `just verify-api-project-runs` nie przeszedł na asercji oczekującej odmowy,
  receipt `8fb0b01c42ce45a99d6439e0cd5e13d2`.
- Końcowy managed test po poprawce: `just verify-api-project-runs` —
  **6 passed, 0 failed, 2 ignored**, receipt
  `380986ba0aca453996e7938261e9f899`, `source_changed_during_run=false`.
  Regresja potwierdza brak zmiany catalogu po odrzuceniu GPU, a potem poprawne
  CPU admission i exact replay.
- `just check-api-source` — **PASS**, receipt
  `114003e8c08d4b2f98e79bacb76c4290`, `source_changed_during_run=false`.
- `rustfmt --edition 2024 --check crates/fullmag-runtime-control/src/claim.rs`
  i `python scripts/check_repo_consistency.py` — **PASS**.
- Scoped `git diff --check` dla API — exit 0; Git zgłasza wyłącznie ostrzeżenia
  o normalizacji LF/CRLF. Pełny check nadal zgłasza CRLF w szeroko zmienionym
  `06-status-realizacji.md`; nie konwertowano całego dokumentu.

## Granica odbioru

To jest fence na wejściu trwałego admission, nie dowód wykonania urządzenia.
Nie ma jeszcze produkcyjnego schedulera, puli zasobów, supervisora, transportu
ani procesu solvera, który potwierdza wykonany device i backend. Nie jest to
runtime, physics ani release qualification. P3 pozostaje **50%**, a plan
globalny około **27%**.

Checkout: `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty; bez stage,
commitu i cleanupu.
