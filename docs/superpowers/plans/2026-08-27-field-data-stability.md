# Stabilność danych pól i transportu — plan implementacji

> **Dla agentów wykonawczych:** wymagane umiejętności: `test-driven-development`, `resource-first-api-check`, `frontend-v2-performance-gates`, `frontend-v2-viewport-lifecycle` oraz `verification-before-completion`.

**Cel:** usunąć rotację pól, lawinę invalidacji i refetchy, utratę last-good po przejściowym `204` oraz zaniżanie liczników diagnostycznych bez zmiany publicznego kontraktu HTTP v2.

**Architektura:** kompletność terminalnej generacji będzie jawna w wewnętrznym kontrakcie runnera, a przyrostowe wyniki materializera będą zawsze scalane. Realtime opublikuje quantity-scoped zmiany pól w 2-sekundowym kanale QoS. Frontend zachowa ostatni poprawny bufor pola przy przejściowym braku aktualnej materializacji, ograniczy fanout katalogu i będzie liczył jawne krotności agregatów.

**Technologie:** Rust, Axum/session state, TypeScript, Zustand/resource runtime, Vitest, Playwright.

## Ograniczenia globalne

- HTTP v2 pozostaje źródłem prawdy; WebSocket przenosi wyłącznie zdarzenia i invalidacje.
- Prawdziwy terminalny snapshot nadal atomowo zastępuje całą generację i publikuje natychmiastową spójną invalidację.
- Nie obniżać jakości wizualizacji, gęstości glyphów ani topologii.
- Nie zmieniać OpenAPI ani wygenerowanego transportu, jeśli publiczny kształt zasobów pozostaje bez zmian.
- Nie dotykać niezależnych zmian w `justfile`, skryptach managed runtime ani `apps/control-room/next-env.d.ts`.

---

### Zadanie 1: jawna kompletność terminalnej generacji pól

**Pliki:**
- modyfikacja: `crates/fullmag-runner/src/types.rs`
- modyfikacja: `crates/fullmag-runner/src/fem/relax/finalize.rs`
- modyfikacja: `crates/fullmag-cli/src/live_workspace.rs`
- test: `crates/fullmag-cli/src/orchestrator.rs`

**Interfejs:** wewnętrzny `StepUpdate` otrzyma domyślnie fałszywy znacznik pełnego terminalnego snapshotu. `terminal_authoritative_field_update()` użyje wyłącznie `update.finished || update.<explicit flag>`; `materialized_at_unix_ms` pozostanie metadanym świeżości pojedynczego pola.

- [ ] Dodać test: nieukończona jednopolowa paczka z dodatnim `materialized_at_unix_ms` nie ustawia `replace_latest_fields`, nie czyści wcześniejszego pola i po następnym wyniku zawiera obie quantity.
- [ ] Uruchomić dokładnie ten test i potwierdzić RED na obecnej heurystyce timestampu.
- [ ] Dodać jawny znacznik do kontraktu runnera i ustawiać go wyłącznie po zbudowaniu kompletnej terminalnej generacji FEM.
- [ ] Usunąć heurystykę `fields.iter().all(|field| field.materialized_at_unix_ms > 0)` z klasyfikacji CLI.
- [ ] Uruchomić nowy test oraz istniejące testy prawdziwej terminalnej zamiany; potwierdzić GREEN.

Polecenia:

```bash
cargo test -p fullmag-cli --bin fullmag orchestrator::tests::async_materialized_field_batches_merge_without_terminal_replacement -- --exact
cargo test -p fullmag-cli --bin fullmag orchestrator::tests::interactive_terminal_field_snapshot_keeps_generation_while_run_awaits_command -- --exact
cargo test -p fullmag-cli --bin fullmag orchestrator::tests::terminal_fdm_fields_replace_the_previous_generation_and_preserve_grid_m -- --exact
```

### Zadanie 2: katalog pól i quantity-scoped QoS realtime

**Pliki:**
- modyfikacja: `crates/fullmag-api/src/main.rs`
- test: `crates/fullmag-api/src/main.rs`
- test: `crates/fullmag-api/src/session.rs`

**Interfejs:** `Fields/samples` i `PlanarFields/field` używają tego samego zbioru faktycznie zmienionych quantity oraz kanału `FieldSamples`. Zmiana wartości istniejącego źródła podbija tylko sample revision; członkostwo katalogu pozostaje stałe.

- [ ] Dodać test RED, że aktualizacja istniejącej quantity nie podbija `field_catalog_revision`.
- [ ] Dodać test RED, że `PlanarFields/field` zawiera wyłącznie zmienione `quantity_ids`, ma `broad=false` i trafia do 2000 ms QoS.
- [ ] Rozszerzyć zawężanie w `current_live_realtime_changes_since()` na `PlanarFields/field`.
- [ ] Sklasyfikować `PlanarFields/field` jako `RealtimeQosLane::FieldSamples`.
- [ ] Zachować natychmiastową niesplitowaną publikację prawdziwego terminalnego snapshotu.
- [ ] Uruchomić testy sesji, realtime i terminal route.

```bash
cargo test -p fullmag-api session::tests::ordinary_live_field_frame_keeps_incremental_merge_semantics -- --exact
cargo test -p fullmag-api session::tests::terminal_authoritative_field_frame_replaces_stale_fields_without_replay_churn -- --exact
cargo test -p fullmag-api realtime_change_tests --no-fail-fast
cargo test -p fullmag-api terminal_snapshot_route_tests --no-fail-fast
```

### Zadanie 3: last-good cache i ograniczenie fanoutu katalogu

**Pliki:**
- modyfikacja: `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
- test: `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts`
- test: `apps/control-room/src/modules/viewport-3d/viewport3dFieldRevisionRefetch.test.tsx`
- modyfikacja: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
- test: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`

**Interfejs:** `loadCachedBinaryResource()` otrzyma opt-in zachowania cache po `not-applicable`; użyją go wyłącznie live field-vector call sites. Zdarzenie `fields/catalog` unieważni dokładne zasoby katalogowe, a nie wszystkie aktywne dzieci `/data/fields/*`; ogólny prefix fanout pozostanie dla innych rodzin.

- [ ] Dodać test RED: `ready -> not-applicable` z opcją pola zwraca last-good i zachowuje ETag; bez opcji topologia nadal usuwa cache.
- [ ] Dodać test hooka: `ready -> 204 invalidation -> ready` nie ukrywa wektora, nie uruchamia zbędnego `compute_fields`, a późniejszy `200` zastępuje bufor.
- [ ] Dodać test RED katalogu z subskrypcjami catalog, quantities, availability i vector; tylko dwa katalogi zmieniają rewizję.
- [ ] Zaimplementować wąskie opcje cache i exact-only catalog invalidation.
- [ ] Uruchomić focused Vitest.

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/viewport3dResources.test.ts
env TMPDIR=/tmp pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/viewport3dFieldRevisionRefetch.test.tsx
env TMPDIR=/tmp pnpm --dir apps/control-room test -- --run src/kernel/realtime/RealtimeInvalidationBridge.test.ts
```

### Zadanie 4: prawdziwe krotności diagnostyki transportu

**Pliki:**
- modyfikacja: `apps/control-room/src/kernel/api/RequestDiagnosticsController.ts`
- test: `apps/control-room/src/kernel/api/RequestDiagnosticsController.test.ts`
- modyfikacja: `apps/control-room/src/modules/footer/footerModel.ts`
- test: `apps/control-room/src/modules/footer/footerModel.test.ts`
- modyfikacja: `apps/control-room/src/modules/footer/FooterModule.tsx`
- utworzenie testu: `apps/control-room/src/modules/footer/FooterModule.transportDiagnostics.test.tsx`

**Interfejs:** każdy `RequestDiagnosticEntry` ma `occurrenceCount` i `firstTimestampMs`. Byte length i duration pozostają już zsumowane, natomiast liczniki/rate/top endpoints sumują `occurrenceCount`. Hook stopki subskrybuje wersję kontrolera, dzięki czemu mutacja agregatu z tym samym ID odświeża UI.

- [ ] Dodać test RED kontrolera dla dwóch identycznych wpisów: `occurrenceCount=2`, niezmienny pierwszy timestamp i zsumowane bajty.
- [ ] Dodać test RED summary dla jednego agregatu `occurrenceCount=5`.
- [ ] Dodać test RED stopki, że drugi wpis o tej samej sygnaturze aktualizuje wyświetlany count/detail.
- [ ] Dodać jawne pola i usunąć parsowanie krotności z tekstu jako źródła obliczeń.
- [ ] Zastąpić sygnaturę samych ID snapshotem opartym na `diagnostics.getVersion()`.
- [ ] Uruchomić focused Vitest i typecheck.

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room test -- --run src/kernel/api/RequestDiagnosticsController.test.ts src/modules/footer/footerModel.test.ts
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room check:api-hygiene
```

### Zadanie 5: kwalifikacja transportu i WebGL

**Pliki:**
- aktualizacja dowodów: `docs/audits/2026-08-27-control-room-field-data-instability-diagnostic.md`
- testy skryptów: istniejące pliki smoke/audit bez zmiany limitów

- [ ] Uruchomić testy jednostkowe skryptu budżetowego i lifecycle viewportu.
- [ ] Uruchomić 60-sekundowy budżet na `http://localhost:3100`, z wymaganym Fullmag WS i realnymi quantity ACK expectations.
- [ ] Potwierdzić brak `204` po przyjętym `200`, stabilny last-good i brak powtarzalnych `resource:load-failed` dla oczekiwanego `202`.
- [ ] Uruchomić camera-only WebGL smoke oraz 100 przełączeń 3D/2D; wymagać widocznego canvasu, `isContextLost()=false` i dodatniego drawing buffer.
- [ ] Uruchomić memory-churn i idle audit.
- [ ] Uruchomić React Doctor dla zmienionego zakresu i zapisać wynik bez maskowania istniejącego długu.

```bash
node --test apps/control-room/scripts/smoke-realtime-communication-budget.node-test.mjs
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/performance/realtimeCommunicationBudgetSmokeScript.test.ts src/modules/viewport-3d/Viewport3DCanvas.test.ts src/modules/viewport-3d/Viewport3DCanvas.lifecycle.test.tsx src/modules/viewport-3d/viewport3dDiagnostics.test.ts src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
npx react-doctor@latest --verbose --scope changed apps/control-room
```
