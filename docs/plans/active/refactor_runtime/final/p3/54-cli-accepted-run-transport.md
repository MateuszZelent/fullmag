# P3/P5 — transport CLI accepted-run przez publiczne API

Data checkpointu: 27.09.2026.

## Zakres

`fullmag run-json <request.json> --api-url <origin>` jest produkcyjnym
wejściem CLI dla kompletnego immutable Submit payloadu. Komenda:

- ogranicza rozmiar i parsuje wejście JSON;
- typuje i waliduje `ProjectId` oraz `RunId` przed transportem;
- wymaga originu HTTP(S) bez ścieżki, query i fragmentu;
- koduje segmenty URL zamiast konkatenować niezaufane identyfikatory;
- wysyła payload do publicznego `POST /v2/persistence/projects/{project_id}/runs`;
- domyślnie materializuje katalog i wykonuje publiczny readback runu;
- sprawdza tożsamość RunId/ProjectId odpowiedzi i zwraca jeden JSON z kodami
  HTTP oraz body każdego etapu;
- ma jawny `--submit-only`, gdy caller chce zatrzymać się po durable acceptance.

Transport nie ma dostępu do prywatnych struktur `SessionStore` i nie wykonuje
solvera bezpośrednio. Typowanie całego RunIntent, StudyPlan, katalogu i archiwum
pozostaje po stronie wspólnego publicznego API v2.

Managed verifier buduje pięć rzeczywistych binariów: CLI, API, publisher puli,
scheduler i worker. CLI wykonuje Submit/materialization/readback, a dalsza część
tej samej próby publikuje lokalnie wykrytą pulę, uruchamia dokładny RunId i
potwierdza terminalny sukces oraz release lease.

## Dowody

| Bramka | Wynik | Dowód |
|---|---:|---|
| Build CLI + cztery binaria API | PASS | `build_exit_code=0`; każde binarium zachowane z SHA-256. |
| CLI publiczny Submit | PASS | `operation=submit_accepted_run`, `transport=public_http_v2`, HTTP 201, `disposition=accepted`. |
| CLI materialization + readback | PASS | HTTP 200/200, `catalog_state=materialized`, task `accepted/blocked`. |
| Scheduler + worker | PASS | `run_source=explicit`, `scheduled_count=1`, worker `completed`. |
| Publiczny wynik + lease | PASS | task `succeeded`, lease `released`. |
| Tożsamość źródeł | PASS | `source_changed_during_run=false`. |

Receipt:
`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-api-runtime\resource-discovery-runtime\3bc1a29aa19c42f396f2cb77ddb710ee\receipt.json`.

## Granica checkpointu

Pierwotnie transport był dostępny jako `submit-run-json`, a `run-json`
pozostawało bezpośrednim wywołaniem runnera. Cutover z 28.09.2026 przeniósł
publiczną nazwę na transport accepted-run, ukrył direct runner pod nazwą
`run-problem-json-direct` i zachował `submit-run-json` wyłącznie jako ukryty
alias zgodności. Szczegóły opisuje
[`59-cli-run-json-cutover.md`](59-cli-run-json-cutover.md). Checkpoint nie dowodzi
zdalnego heartbeat/Stop ACK, uwierzytelnienia transportu, retry HTTP ani
pozostałych lane'ów wykonawczych.

Po tym przyroście: **P3 88%, P5 74%, całość około 45%**.
