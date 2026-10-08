# API katalogu wyników stage anteny — walidacja 2026-09-21

## Zakres

Dodano read-only zasób v2 dla atomowo publikowanego
`stage_output_catalog.v1.json`:

```text
GET /v2/sessions/current/data/antenna/stages/{stage_id}/output-catalog
```

Endpoint wiąże żądany `stage_id` z bieżącym stage execution, rozwiązuje tylko
`artifact_ref` należący do aktywnego workspace i nie skanuje katalogu po nazwie.
Dla ostatniego stage zachowano ograniczony fallback do bieżącego katalogu
artefaktów, aby odczytać starszy snapshot bez jawnego `artifact_ref`.

## Walidacja kontraktu

Handler sprawdza kolejno:

- `schema_version == stage_output_catalog.v1`;
- zgodność `catalog.stage_id` z rekordem stage (konflikt zwraca HTTP 409);
- `stage_kind == antenna_field_solve` oraz niepusty `port_mode_id`;
- dozwolony stan `ready`, `cancelled` albo `failed`;
- `ready` ma co najmniej jeden output, a stan terminalny nie ma outputów;
- każdy output jest `antenna_field_solution`, a `output_id` zgadza się z
  `solution_ref.output_id` i `solution_ref.stage_id`;
- `manifest_ref` jest ścieżką względną bez `..` i wskazuje istniejący plik w
  aktywnym katalogu artefaktów.

Duże tablice pozostają poza control plane. Zasób zwraca wyłącznie status,
tożsamość sesji/stage, port, referencje assetu, quantities, reuse i diagnostykę.
`content_digest` jest SHA-256 bajtów katalogu, a ETag obejmuje epoch sesji,
stage i digest; ponowne żądanie identycznego katalogu korzysta z HTTP 304.

## Integracja klienta

`ControlRoomApi.data.antenna.stageOutputCatalog` oraz
`useAntennaStageOutputCatalogResource` korzystają z wygenerowanego OpenAPI v2.
Hook ma klucz z konkretnym `stage_id` i rewizję
`stage_revision:content_digest`; brak zasobu 404 jest reprezentowany jako
`null`, natomiast błędy integralności nie są maskowane jako brak wyniku.

Websocket/resource invalidation unieważnia tylko prefiks katalogów anteny przy
zmianie katalogu artefaktów. Zmiana `simulation/stages/execution` unieważnia
zasoby katalogów z konkretnym stage, razem z istniejącymi zasobami analiz
stage-scoped.

## Weryfikacja wykonana

- `pnpm --dir apps/control-room generate:api`: **OK**; OpenAPI JSON,
  `openapi-v2-types.ts` i `openapi-v2-paths.ts` wygenerowane z binarnego
  `fullmag-api`;
- `pnpm --dir apps/control-room exec vitest run
  src/kernel/api/ControlRoomApi.test.ts`: **135/135**;
- `pnpm --dir apps/control-room exec vitest run
  src/kernel/realtime/RealtimeInvalidationBridge.test.ts`: **61/61**;
- ESLint zmienionych plików API, resource i bridge: **OK**;
- parser Rust (`rustfmt --edition 2021 --config skip_children=true
  --emit stdout`) oraz `git diff --check`: **OK**;
- nie uruchamiano kompilacji testów Rust ani browser smoke; endpoint nie jest
  jeszcze dowodem pełnego runtime solvera.

## Pozostaje otwarte

Endpoint udostępnia katalog obecnego antenowego synthetic stage, ale nie
zamyka jeszcze wspólnego resolvera symbolicznego `stage/output` dla wszystkich
rodzajów stage ani pełnego browser smoke `create → solve → inspect → stale`.
