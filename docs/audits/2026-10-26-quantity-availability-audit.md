# Audyt dostępności wielkości do wizualizacji (FEM/FDM): dlaczego Control Room oferuje tylko `m`

Data: 26.10.2026. Branch: `codex/quantity-parity-20261026`, baza `5edd41530` (origin/master).
Zakres: ścieżka Docker DEV (accepted Study worker + projektor API) i selektor wielkości
w Control Room. Fizyka i katalog wielkości nie są zmieniane.

## Werdykt

Katalog wielkości jest kompletny w duchu mumax3: `fullmag-quantities` definiuje `m`, `torque`,
wszystkie pola `H_*`, gęstości energii `eden_*`, energie globalne `E_*` i mapy materiałowe `mat_*`
(56 wpisów, `crates/fullmag-quantities/src/catalog.rs`). Solvery wszystkich czterech realizacji
liczą te pola i strumieniują je w trakcie biegu. **Problemem nie jest fizyka ani katalog, tylko
płaszczyzna możliwości (capabilities) w snapshocie sesji API.** Bez niej katalog zwraca każdą
wielkość jako `capability_state=unknown`, `requestable=false`, a frontend przepuszcza wyłącznie
`m` z przygotowanego stanu początkowego (`prepared_initial_state`).

## Łańcuch zależności (jak powstaje lista w UI)

1. Runner rozwiązuje plan i buduje `BackendCapabilities` z rejestrem dostawców
   (`ResolvedQuantityProviderRegistry`, źródło `ResolvedPlan`):
   `resolve_planned_runtime_capabilities` → `restrict_capabilities_to_plan_active_quantities`
   (`crates/fullmag-runner/src/lib.rs`), filtr aktywnych członów
   `active_{fdm,fem}_preview_quantities` (`crates/fullmag-runner/src/quantities.rs`).
2. API trzyma kopię w `SessionStateResponse.capabilities`. Endpoint
   `GET /v2/sessions/current/data/quantities`
   (`crates/fullmag-api/src/router_v2/handlers/data/quantities.rs`, `annotate_runtime_quantity_state`)
   wylicza dla każdej wielkości pięć płaszczyzn przez `resolve_quantity_capability`
   (`crates/fullmag-runner/src/capabilities.rs`). Gdy `capabilities == None`, funkcja kończy się
   wcześnie i zostawia wszystko jako `unknown` — wyjątkiem jest tylko przygotowane `m`.
3. Frontend (`apps/control-room/src/kernel/api/quantityIds.ts`,
   `quantityCatalogEntrySupportsSpatialVisualization`) wymaga `provider=available`,
   `request=field_vector`, `render=renderable`, `publication=interactive`. Bez
   `resolved_capability` wymaga `solver_capability=supported`. Ribbon i Inspector
   (`ribbonTabViews.tsx`, `ObjectVisualizationTargetSection.tsx`) budują listę tylko z tego filtra.
4. `compute_fields` w ścieżce Docker (`commands.rs`, `compute_fields_materialization_requirements`)
   także wymaga rejestru `ResolvedPlan`; bez niego komenda jest odrzucana
   (`accepted_materialization_requirements_unavailable`).

## Przyczyny źródłowe

### P1 (krytyczna) — możliwości planu instalowane dopiero po zakończeniu biegu

`crates/fullmag-api/src/live_accepted_projection.rs` instalował `resolved_capabilities` wyłącznie dla
statusów `completed | failed | cancelled` (commit `806bb0139`, 23.10.2026). Ścieżka in-process
(`fullmag-cli` orchestrator, `current_live_metadata`) publikowała capabilities od startu, ale
Docker DEV jej nie używa. Skutek w każdym stanie przed końcem biegu:

| Stan sesji | `capabilities` | Lista w UI |
|---|---|---|
| model przygotowany, czeka na Compute (`awaiting_command`) | `None` | tylko `m` |
| bieg trwa (`running`) | `None` | tylko `m`, choć worker publikuje `H_*`, `torque`, `eden_*` w `latest_fields` |
| bieg zakończony | z planu | pełna lista aktywnych wielkości |

Dowód runtime (tylko odczyt, grupa `viz-parity-verify-20261026`, port 3266, FEM GPU, 1 087 250
elementów, `solver.state=awaiting_command`): wszystkie 56 wpisów katalogu ma
`capability_state=unknown`, `requestable=false`, brak `resolved_capability`.

Status naprawy:
- stan `running`: PR #264 (`codex/viz-parity-20261025`, commit `61ccdd1c5`,
  `running_runtime_capabilities`) instaluje capabilities planu, gdy tor workera zgadza się z
  silnikiem planu. Tego nie powtarzam.
- stan przed Compute: naprawione w tym branchu (sekcja „Zmiana”).

### P2 (wysoka) — brak ewaluacji pól przed pierwszym biegiem

W Docker DEV `compute_fields` jedynie adoptuje gotowy pakiet CAS workera
(`accepted_field_materialization::adopt_current_bundle`), który wymaga zakończonego biegu
(`"accepted quantities require a terminal run and its verified state"`). Nie istnieje krok Study,
który policzyłby `H_eff`, `torque`, `eden_*` dla bieżącego `m` bez całkowania (mumax: `Save(B_eff)`
przed `Run`). Po P1 wielkości są widoczne przed Compute jako „obsługiwane, niezmaterializowane”;
ich wybór kończy się czytelnym błędem materializacji, nie wynikiem. Wymaga osobnego kroku
„evaluate-only” w runtime-control i workerze (propozycja w „Dalsze kroki”).

### P3 (wysoka dla dużych domen) — budżet live: wszystko albo tylko `m`

`AcceptedLiveObservationWriter::field_sampling_interval`
(`crates/fullmag-api/src/accepted_study_worker.rs`) zwraca 1 (pełny zestaw pól na krok) tylko gdy
cała generacja (m + wszystkie aktywne pola) mieści się w `max_magnetization_bytes`
(min(storage/8, memory/8, 128 MiB)). W przeciwnym razie 100 i runner nie wysyła żadnego pola poza
`m` (zapis wszystko-albo-nic w `capture_full_active_*`). Przykład: FEM 1,09 mln węzłów → `m` ≈ 26 MB,
~10 pól wektorowych + skalary ≈ 300 MB > 128 MiB, więc w trakcie biegu dostępne jest tylko `m`
nawet po PR #264. Pełny zestaw pojawia się dopiero w pakiecie końcowym. PR #270 zmienia kadencję
(zegar 250 ms), nie budżet.

### P4 (średnia) — luki pokrycia na torach (mumax parity)

Rejestr dostawców to `filter(all_quantity_ids())`, więc o zakresie decydują funkcje silnika
`can_materialize_preview_quantity` (FDM CPU: `direct_field_values_available` /
`direct_scalar_values_available` w `fdm/cpu/reference.rs`; FDM CUDA: `CudaSnapshotObservable` w
`fdm/gpu/cuda/native.rs`; FEM: `native_fem.rs`) razem z warunkami planu. Listy
`preview_quantities` w profilach są tylko projekcją zgodności. Luki względem mumax3:

| Wielkość | FDM CPU | FDM CUDA | FEM CPU/GPU |
|---|---|---|---|
| `H_dmi` (interfacial) | jest | **brak** (tylko `H_rotated_dmi`) | jest |
| `H_dmi_bulk`, `H_ani_cubic`, `H_mel`, `H_therm`, `H_drive` | brak | brak | zależnie od obserwabli natywnych |
| `eden_drive` | brak | jest | zależnie od planu |
| `eden_rotated_dmi` | jest | jest | nigdy (zawarte w zbiorczym `eden_dmi`) |
| `mat_ms`, `mat_aex`, `mat_alpha` | jest | brak | nigdy aktywne |
| `mat_dind`, `mat_dbulk` | brak | brak | nigdy aktywne |
| `dm_dt`, `torque_sot`, `torque_stt` | `ui_exposed=false` w katalogu | | |
| `regions` (mumax `regions`) | brak w katalogu | | |
| `B_*` w teslach (mumax `B_eff`, `B_demag` …) | tylko alias `B_drive` we frontendzie | | |

Energie globalne: profile wszystkich torów deklarują `scalar_outputs` = `E_ex, E_demag, E_ext,
E_rotated_dmi, E_total`; `E_ani`, `E_dmi`, `E_drive` są w `StepStats`, ale katalog zwraca je jako
`unsupported`. Wykresy skalarów czytają wiersze tabeli bezpośrednio, więc tego nie widać na
wykresach, tylko w katalogu.

### P5 (porządkowa) — równoległe katalogi wbrew ADR 0004

- `crates/fullmag-runner/src/solvers/fdm/interactions/observables.rs`: druga, rozbieżna kopia
  `active_fdm_preview_quantities` (inna lista CUDA, brak `HDrive`, `FrozenSpins`, `mat_*`).
  Plik nie jest zadeklarowany w `interactions/mod.rs`, więc się nie kompiluje — martwy kod,
  który myli przy audycie. Usunięty w tym branchu.
- `apps/control-room/src/kernel/api/quantityIds.ts`: lokalne tablice `QUANTITY_UNITS` i
  `QUANTITY_DISPLAY_NAMES` dublują `unit`/`label` z katalogu API (brak m.in. `torque`, `mat_*`,
  `H_rotated_dmi` w nazwach). Do migracji na katalog (osobny krok).

### P6 (UX) — ukrywanie zamiast wyjaśnienia

Gdy capabilities są nieznane, frontend nie pokazuje nieaktywnych wielkości z powodem
(„dostępne po Compute”, „poza budżetem live”), tylko je ukrywa. Użytkownik widzi samo `m` i nie
wie dlaczego.

## Zmiana w tym branchu

1. `crates/fullmag-api/src/live_accepted_projection.rs`: `accepted_step_capabilities`
   (dawniej `finished_step_capabilities`) instaluje capabilities rozwiązanego planu także przed
   Compute, gdy nie ma aktywnego zadania, o ile plan dostarcza `m` (FDM, FDM multilayer, FEM).
   Plany modalne i częstotliwościowe nie dostarczają `m`, więc przed końcem biegu nie są
   instalowane i przygotowane `m` pozostaje czytelne. Plan jest niezmienny w obrębie biegu,
   dlatego rozwiązywany jest tylko przy zmianie stanu trwałego, nie przy każdej obserwacji live.
   Stan `running` pozostawiony PR #264 (ze ścisłą kontrolą toru workera).
2. `crates/fullmag-api/src/router_v2/handlers/data/quantities.rs`: w runtime Docker wielkość bez
   ładunku i bez zakończonego biegu ma `materializable=false` i
   `materialization_reason_code="accepted_state_required"` (P2 bez fałszywej obietnicy Compute).
   Bez zmiany schematu OpenAPI — pole już istniało.
3. Frontend: `quantityCatalogPickerItem` (`quantityIds.ts`) — ribbon (`ribbonTabViews.tsx`) i
   Inspector (`ObjectVisualizationPanelModel.ts`) pokazują takie wielkości jako pozycje
   wyłączone z dopiskiem „(after Run)”, zamiast je ukrywać. Test: `ribbonTabViews.test.ts`.
4. Usunięty martwy `crates/fullmag-runner/src/solvers/fdm/interactions/observables.rs`.

## Weryfikacja

| Kontrola | Wynik |
|---|---|
| Diagnoza P1 na żywej grupie (port 3266, FEM GPU, `awaiting_command`, tylko odczyt) | 56/56 wpisów `unknown`, `requestable=false` — potwierdzone |
| Emisja pól live per tor (P3) | analiza kodu: przy `field_sampling_interval()==1` wszystkie cztery tory wysyłają pełny aktywny zestaw w trakcie biegu |
| Kompilacja backendu w grupie `fullmag-worktree-quantity-parity-20261026-…` (profil `backend-dev`, przyrostowo z finalnym kodem) | przechodzi, API `Ready` |
| Frontend w kontenerze `frontend` grupy: vitest (`quantityIds`, `ribbonTabViews`, `ObjectVisualizationPanelModel`) | 158/158 |
| ESLint `--max-warnings=0` dla zmienionych plików | exit 0 |
| `scripts/typecheck-control-room.mjs` (next typegen + tsc) | exit 0 |
| Katalog wielkości przed Compute (runtime, grupa `fullmag-worktree-quantity-parity-verify-20261026-…`, commit `c26a792c6`, FDM CPU, `awaiting_command`) | 22 wielkości planu z `provider=available` (`torque`, `H_ex`, `H_demag`, `H_ext`, `H_ani`, `H_dmi`, `H_eff`, `eden_*`, `mat_ms/aex/alpha`, `E_*`); pola przestrzenne mają `materializable=false`, `accepted_state_required`. Przed zmianą: 56/56 `unknown` |
| `m` przed Compute w FDM | `accepted_state_required` — ta baza nie publikuje przygotowanej domeny FDM przed Compute (domena 0 komórek; naprawa w PR #264, `1166e0073`), więc `m` nie było czytelne także przed zmianą |
| `m` przed Compute w FEM | statycznie: przygotowane `m` w `latest_fields` jest rozwiązywane ogólną ścieżką (`resolved_current_field_source`, nośnik `fem:<topology>:full`); runtime **NOT VERIFIED** |
| Pola po biegu (≥1 krok) i przeglądarka | **NOT VERIFIED** — runtime grupy przeszedł w tryb diagnostyczny tuż po starcie (`runtime service owner is not ready`, sonda live; ten sam objaw wystąpił chwilowo w pierwszej grupie), więc solve i odczyt katalogu z UI były zablokowane. Logika adopcji końcowego pakietu nie jest zmieniana tym branchem |
| Testy jednostkowe Rust | nie dodane i nie uruchamiane — zakaz kompilacji testów jednostkowych |
| CI PR #273 (`python-contracts`, `rust-contracts` i in.) | 17 zielonych, 0 czerwonych |

## Dalsze kroki (poza tym branchem)

1. Krok Study „evaluate-only” (P2): worker liczy pakiet pól dla bieżącego `m` bez całkowania;
   `compute_fields` przed pierwszym biegiem kieruje się do niego zamiast do adopcji CAS.
2. Budżet live per wielkość (P3): zamiast wszystko-albo-nic wysyłać `m` + wielkość wybraną w
   widoku (i ewentualnie kolejne do limitu), z jawnym `materialization_reason_code`
   (`live_budget_exceeded`) w katalogu.
3. Uzupełnienie torów (P4): `H_dmi` na CUDA, `H_dmi_bulk`/`H_ani_cubic`, `mat_*` w FEM,
   `regions` w katalogu, warianty `B_*`, `E_ani/E_dmi/E_drive` w `scalar_outputs` — każda zmiana
   z notą w `docs/physics/` tam, gdzie dotyczy fizyki.
4. Frontend (P5, P6): etykiety i jednostki wyłącznie z katalogu; nieaktywne wielkości jako
   pozycje wyłączone z powodem z `materialization_reason_code`.
