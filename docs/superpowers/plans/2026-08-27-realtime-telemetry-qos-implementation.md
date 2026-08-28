# Plan implementacji QoS telemetryki realtime

> **Dla agentów wykonawczych:** wymagany sub-skill `executing-plans` przy realizacji inline. Nie używać subagentów bez jawnej zgody użytkownika.

**Cel:** Usunąć kolejki zaległych próbek telemetryki, egzekwować `scalar_telemetry_publish_ms` po stronie API oraz odświeżać CPU/GPU telemetry przez ograniczone invalidacje resource-first.

**Architektura:** CLI redukuje oczekujące próbki do first/latest/terminal. API posiada jeden, sesyjny właściciel QoS lekkich `scalar.sample`, który odczytuje efektywną politykę przy każdym flushu. CPU/GPU pozostają zasobami HTTP, a WebSocket publikuje wyłącznie dokładne invalidacje w osobnym kanale `DiagnosticsSummary`.

**Stos:** Rust, Tokio, Axum, React 19, TypeScript, Vitest, resource hooks v2, WebSocket invalidation.

## Ograniczenia globalne

- HTTP v2 pozostaje autorytatywnym źródłem ciężkich zasobów.
- Zero `setInterval` i zero pollingu zasobów w komponentach.
- Pierwsza i terminalna próbka każdej sekwencji są dostarczane dokładnie raz.
- Historia table autosave nie zmienia częstotliwości ani semantyki.
- `solver-profile` pozostaje w lifecycle QoS; tylko CPU/GPU używa `DiagnosticsSummary`.
- Zachować wszystkie niezwiązane zmiany w brudnym worktree.
- Nie wykonywać commita, merge ani push bez osobnej zgody użytkownika.
- Każda zmiana produkcyjna musi nastąpić po zaobserwowanym RED odpowiedniego testu.

---

### Zadanie 1: Ograniczona kolejka first/latest/terminal w CLI

**Pliki:**

- Modyfikacja: `crates/fullmag-cli/src/live_workspace.rs`
- Test: moduł `live_workspace::tests` w tym samym pliku

**Interfejs:**

- Konsumuje: `PendingScalarRows::enqueue_if_new(ScalarSequenceKey, CurrentLiveScalarRow, bool, &mut LiveTelemetryPublishGate)`.
- Produkuje: ograniczoną kolejkę zachowującą first/latest/terminal oraz niezmienny kontrakt `publish_pending_scalar_rows()`.

- [x] **Krok 1: Dodać test RED dla koalescencji próbek pośrednich**

Test ma wprowadzić kroki `2..=10_000` tej samej sekwencji przy bramce dopuszczającej każdą próbkę i sprawdzić, że kolejka ma jeden element z krokiem `10_000`:

```rust
#[test]
fn pending_scalar_rows_keep_only_latest_intermediate_sample_per_sequence() {
    let mut pending = PendingScalarRows::default();
    let mut gate = LiveTelemetryPublishGate::default();
    let sequence = scalar_sequence("run-1", Some(0), Some("stage-0"));

    for step in 2..=10_000 {
        pending.enqueue_if_new(sequence.clone(), scalar_row(step), false, &mut gate);
        gate.last_scalar_publish_at = None;
    }

    assert_eq!(pending.rows.len(), 1);
    assert_eq!(pending.rows.front().map(|row| row.row.step), Some(10_000));
}
```

- [x] **Krok 2: Uruchomić RED**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-cli pending_scalar_rows_keep_only_latest_intermediate_sample_per_sequence
```

Oczekiwany wynik: FAIL, ponieważ obecna kolejka zawiera wiele próbek.

- [x] **Krok 3: Dodać testy RED dla first, terminal i retry**

Testy muszą potwierdzić:

```rust
#[test]
fn pending_scalar_rows_preserve_first_sample_before_latest() { /* step 1 + 2 + 3 -> [1, 3] */ }

#[test]
fn pending_scalar_rows_terminal_replaces_same_step_intermediate_once() { /* step 8 false + step 8 true -> one step 8 */ }

#[test]
fn pending_scalar_rows_failed_sink_retains_first_and_latest_for_retry() { /* first call errors; second publishes retained order */ }
```

- [x] **Krok 4: Wdrożyć minimalną koalescencję**

W `enqueue_if_new()`:

1. Rozpoznać próbkę początkową przez `step <= 1`.
2. Dla terminalnej próbki zastąpić oczekującą próbkę tej samej sekwencji i kroku.
3. Dla próbki pośredniej zastąpić ostatnią nieterminalną, niepoczątkową próbkę tej samej sekwencji.
4. Nie usuwać oczekującej próbki początkowej.
5. Zachować nadawanie nowego `id` przy zastąpieniu, aby potwierdzenie starego requestu nie usunęło nowej wartości.

- [x] **Krok 5: Uruchomić GREEN i istniejące testy kolejki**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-cli pending_scalar_rows
```

Oczekiwany wynik: wszystkie testy `pending_scalar_rows*` PASS.

---

### Zadanie 2: Serwerowy właściciel QoS `scalar.sample`

**Pliki:**

- Modyfikacja: `crates/fullmag-api/src/types.rs`
- Modyfikacja: `crates/fullmag-api/src/main.rs`
- Modyfikacja: inicjalizatory `AppState` w `crates/fullmag-api/src/router_v2/tests.rs`
- Test: moduł testowy realtime w `crates/fullmag-api/src/main.rs`

**Interfejs:**

- Produkuje typ `CurrentLiveRealtimeScalarSampleQosState` przechowywany jako `Arc<Mutex<_>>` w `AppState`.
- Produkuje funkcję async:

```rust
async fn queue_current_live_realtime_scalar_sample(
    state: &AppState,
    sample: PendingRealtimeScalarSample,
) -> Result<(), ApiError>;
```

- [x] **Krok 1: Dodać czysty model decyzji i testy RED**

Model przyjmuje `now`, `interval`, tożsamość próbki i terminalność. Testy:

```rust
#[test]
fn scalar_qos_publishes_first_sample_immediately() { /* Action::Publish */ }

#[test]
fn scalar_qos_keeps_only_latest_sample_inside_window() { /* pending revision 3 replaces 2 */ }

#[test]
fn scalar_qos_terminal_bypasses_window_and_clears_pending() { /* terminal Action::Publish */ }

#[test]
fn scalar_qos_new_run_discards_previous_pending_sample() { /* run-2 owns pending */ }
```

- [x] **Krok 2: Uruchomić RED**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-api scalar_qos --bin fullmag-api
```

Oczekiwany wynik: FAIL przed implementacją modelu.

- [x] **Krok 3: Dodać stan do `AppState`**

Stan musi zawierać co najmniej:

```rust
pub(crate) struct CurrentLiveRealtimeScalarSampleQosState {
    pub identity: Option<(String, Option<String>)>,
    pub last_published_at: Option<tokio::time::Instant>,
    pub pending: Option<PendingRealtimeScalarSample>,
    pub flush_generation: u64,
}
```

Każdy konstruktor testowy i produkcyjny `AppState` inicjalizuje `Arc<Mutex<CurrentLiveRealtimeScalarSampleQosState::default()>>`.

- [x] **Krok 4: Wdrożyć queue/flush z ponownym odczytem polityki**

Wrapper async:

1. Odczytuje `scalar_sample_enabled` i `scalar_telemetry_publish_ms`.
2. Publikuje first/terminal natychmiast przez istniejące `publish_current_live_realtime_event()`.
3. W oknie zapisuje wyłącznie najnowszą próbkę i uruchamia najwyżej jeden `tokio::spawn`.
4. Flush blokuje `current_live_session_transition`, ponownie odczytuje politykę i tożsamość.
5. Jeżeli nowe, dłuższe okno jeszcze nie minęło, planuje następny flush bez publikacji.
6. Wyłączona polityka lub zmieniona sesja usuwa pending.
7. Terminal usuwa pending tej samej sekwencji przed natychmiastową publikacją.

- [x] **Krok 5: Przekazać terminalność z zaakceptowanego snapshotu**

W `sync_current_live_frame_update()` rozszerzyć tuple `scalar_sample` o flagę wynikającą z zaakceptowanego `next`:

```rust
let terminal = next
    .live_state
    .as_ref()
    .is_some_and(|state| state.latest_step.finished || state.status == "completed")
    || matches!(next.session.status.as_str(), "completed" | "failed" | "cancelled");
```

Następnie zastąpić bezpośrednie wywołanie publikacji wywołaniem właściciela QoS.

- [x] **Krok 6: Dodać test async patchowania interwału**

Test z kontrolowanym zegarem/schedulerem ma:

1. Przyjąć próbkę oczekującą przy `200 ms`.
2. Zmienić efektywną politykę na `1000 ms` przed flush-em.
3. Potwierdzić brak publikacji po `200 ms` i publikację najnowszej próbki dopiero po nowym deadline.

- [x] **Krok 7: Uruchomić GREEN**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-api scalar_qos --bin fullmag-api
```

---

### Zadanie 3: Kanał QoS i invalidacje CPU/GPU

**Pliki:**

- Modyfikacja: `crates/fullmag-api/src/main.rs`
- Modyfikacja, jeśli potrzebne pole stanu: `crates/fullmag-api/src/schemas/realtime.rs`
- Test: testy QoS w `crates/fullmag-api/src/main.rs`
- Test: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`

**Interfejs:**

- Rozszerza prywatny enum `RealtimeQosLane` o `DiagnosticsSummary`.
- Publikuje dwa `RealtimeResourceChange` z `resource=Diagnostics`, `resource_id=cpu|gpu` i dokładnymi `recommended_fetch`.

- [x] **Krok 1: Dodać testy RED klasyfikacji QoS**

```rust
#[test]
fn cpu_and_gpu_diagnostics_use_summary_qos_without_slowing_solver_profile() {
    // cpu/gpu -> diagnostics_summary_ms
    // solver-profile -> lifecycle_coalesce_ms
}

#[test]
fn inactive_runtime_emits_no_cpu_or_gpu_diagnostic_changes() { /* empty */ }
```

- [x] **Krok 2: Uruchomić RED**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-api diagnostics_summary_qos --bin fullmag-api
```

- [x] **Krok 3: Wdrożyć `DiagnosticsSummary`**

Zmiany:

1. `realtime_qos_lane()` klasyfikuje wyłącznie `Diagnostics` z `resource_id=cpu|gpu` jako `DiagnosticsSummary`.
2. `realtime_qos_window_ms()` zwraca `policy.diagnostics_summary_ms`.
3. `split_realtime_changes_for_qos()` ma osobny wektor i batch.
4. `realtime_coalesced_batch_key()` zwraca `"diagnostics_summary"`.
5. `realtime_change_allowed_by_policy()` respektuje `diagnostics_enabled`.

- [x] **Krok 4: Publikować zmiany tylko dla aktywnego runtime**

`CurrentLiveRealtimeState` otrzymuje wewnętrzne `runtime_active: bool`. Aktywne stany to `running`, `relaxing`, `solving`, `meshing`, `initializing` oraz inne jawnie istniejące stany pracy wskazane przez `effective_runtime_status_code()`; stany terminalne, `idle`, `ready`, `waiting_for_compute` i `paused` nie publikują CPU/GPU ticków.

Rewizją diagnostyki jest monotoniczna rewizja zaakceptowanego runtime/scalar frame, nie zegar ścienny. Obie zmiany mają dokładne ścieżki:

```rust
"/v2/sessions/current/diagnostics/cpu"
"/v2/sessions/current/diagnostics/gpu"
```

- [x] **Krok 5: Dodać frontendowy test RED exact invalidation**

Test podaje batch z CPU/GPU i sprawdza:

```ts
expect(resources.invalidate).toHaveBeenCalledWith(DIAGNOSTICS_CPU_PATH, revision);
expect(resources.invalidate).toHaveBeenCalledWith(DIAGNOSTICS_GPU_PATH, revision);
expect(resources.invalidatePrefix).not.toHaveBeenCalledWith(DIAGNOSTICS_CPU_PATH, revision);
```

- [x] **Krok 6: Wdrożyć minimalną obsługę frontendu, jeśli generic path nie wystarcza**

Preferowane jest użycie istniejącej gałęzi `recommended_fetch`. Dodać specjalny kod tylko wtedy, gdy test wykaże invalidację prefix zamiast exact. Nie dodawać timera ani nowego store.

- [x] **Krok 7: Uruchomić GREEN backendu i frontendu**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-api realtime_qos --bin fullmag-api

env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/kernel/realtime/RealtimeInvalidationBridge.test.ts \
  src/kernel/resources/ResourceRuntimeStore.test.ts
```

---

### Zadanie 4: Precyzyjne etykiety polityki i regresje UI

**Pliki:**

- Modyfikacja: `apps/control-room/src/kernel/layout/CommunicationPolicyDialog.tsx`
- Test: właściwy test dialogu albo test źródłowy polityki w `apps/control-room/src/kernel/realtime/communicationPolicy.test.ts`

- [x] **Krok 1: Dodać test RED etykiet**

Test wymaga tekstów:

```text
Scalar delivery ms
Diagnostics refresh ms
```

i odrzuca stare nieprecyzyjne `Scalar sample ms` / `Diagnostics ms`.

- [x] **Krok 2: Uruchomić RED**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/kernel/realtime/communicationPolicy.test.ts
```

- [x] **Krok 3: Zmienić wyłącznie etykiety**

Nie zmieniać kluczy OpenAPI, zakresów min/max ani magazynu polityki.

- [x] **Krok 4: Uruchomić GREEN**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/kernel/realtime/communicationPolicy.test.ts
```

---

### Zadanie 5: Dokumentacja i pełna weryfikacja

**Pliki:**

- Modyfikacja: `docs/audits/2026-08-27-control-room-field-data-instability-diagnostic.md`
- Modyfikacja statusu: `docs/superpowers/specs/2026-08-27-realtime-telemetry-qos-design.md`

- [x] **Krok 1: Zaktualizować FDI-016–018 po dowodach GREEN**

Każde ustalenie otrzymuje status `CONFIRMED / FIXED` dopiero po przejściu właściwych testów. Pomiar przeglądarkowy pozostaje `NOT VERIFIED`, jeśli serwer runtime nadal nie jest osiągalny.

- [x] **Krok 2: Uruchomić wszystkie skupione testy**

```bash
env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-cli pending_scalar_rows

env CARGO_TARGET_DIR=/tmp/fullmag-telemetry-qos-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-api realtime_qos --bin fullmag-api

env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run \
  src/kernel/realtime/communicationPolicy.test.ts \
  src/kernel/realtime/RealtimeInvalidationBridge.test.ts \
  src/kernel/resources/useSessionStatus.performance.test.ts \
  src/kernel/resources/ResourceRuntimeStore.test.ts \
  src/modules/footer/FooterTelemetry.test.tsx
```

- [x] **Krok 3: Uruchomić bramki frontendowe**

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room typecheck
```

- [x] **Krok 4: Uruchomić React Doctor zgodnie z repozytoryjnym skillem**

Użyć przypiętego workflow z `.agents/skills/react-doctor/SKILL.md`; oddzielić nowe diagnostyki od istniejącego baseline'u.

- [x] **Krok 5: Wykonać runtime smoke, jeśli serwer jest dostępny**

Serwer nie był dostępny: brak nasłuchujących procesów i brak połączenia z portami 3100/8000/8080/3000. Pomiar 60 s oraz WebGL pozostają `NOT VERIFIED`.

Przez 60 s zebrać surowe wpisy Request Diagnostics i potwierdzić:

```text
scalar.sample cadence <= configured interval + one scheduling window
CPU/GPU GET count = 0 when Diagnostics closed
CPU/GPU GET cadence >= diagnostics_summary_ms when Diagnostics open
/data/fields and /data/quantities GET count = 0 without catalog revision change
idle API polling = 0
```

Viewport gate dodatkowo sprawdza `gl.isContextLost() === false` i niezerowy drawing buffer.

- [x] **Krok 6: Sprawdzić diff i zakres**

```bash
git diff --check
git diff --stat
git status --short
```

Nie usuwać, nie stage'ować i nie commitować niezwiązanych zmian.
