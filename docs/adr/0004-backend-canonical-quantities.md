# ADR 0004: Backend-Canonical Quantities

| Field     | Value                                                |
| --------- | ---------------------------------------------------- |
| Status    | Accepted                                             |
| Date      | 2026-04-12                                           |
| Deciders  | Fullmag core team                                    |
| Relates   | fullmag_quantities_backend_first_masterplan_2026-04-12.mdx |

## Context

Fullmag currently scatters quantity identity, metadata, and validation across
four independent locations:

1. `crates/fullmag-runner/src/quantities.rs` — `QuantityId`, `QuantitySpec`, `QUANTITY_SPECS`.
2. `packages/fullmag-py/src/fullmag/model/outputs.py` — `_KNOWN_FIELDS`, `_KNOWN_SCALARS`.
3. `crates/fullmag-api/src/types.rs` — `QuantityDescriptor` (API view model).
4. `apps/web/` — hardcoded column labels, preview aliases, chart presets.

This causes:

- **Silent data loss**: `e_ani` and `e_dmi` were present in `StepStats` but missing
  from `global_scalar_value` and Python `_KNOWN_SCALARS`.
- **Magnetization special-casing**: `m` has a dedicated transport path (`StepUpdate.magnetization`)
  while all other quantities share a different path (`preview_field`, `cached_preview_fields`).
- **Parallel catalogs**: adding a new quantity requires coordinated edits in 4+ files.
- **Mixed concerns**: `StepStats` blends physical observables (energies, averages) with solver
  diagnostics (wall_time, rhs_evals, error_estimate).

## Decision

**The Rust backend is the single source of truth for all quantity metadata.**

Specifically:

1. A new shared crate `fullmag-quantities` defines the canonical `QuantityId`,
   `QuantityDescriptor`, `QuantityShape`, `QuantityDomain`, `QuantityLocation`,
   `QuantityReduction`, `QuantityComponent`, and `NormalizationHint` types plus
   the static `CATALOG` table.

2. `fullmag-runner`, `fullmag-ir`, `fullmag-plan`, `fullmag-api`, and
   `fullmag-py-core` all import from `fullmag-quantities`.  No parallel catalogs.

3. `StepStats` is split into `StepDiagnostics` (solver telemetry) and
   `GlobalQuantityRow` (physical scalar samples).

4. `m` is a regular quantity — no special top-level fields in transport structs.

5. Python `SaveField` / `SaveScalar` become thin wrappers around a new
   `SaveQuantity` class that validates against the backend catalog.

6. The API exposes `GET /api/quantities/catalog` so the frontend fetches the
   catalog at runtime instead of maintaining a local copy.

## Naming Freeze

The following canonical quantity IDs are frozen and **must not be renamed**:

| ID               | Shape          | Unit          | Domain         |
| ---------------- | -------------- | ------------- | -------------- |
| `m`              | vector_field   | dimensionless | magnetic_only  |
| `H_ex`           | vector_field   | A/m           | magnetic_only  |
| `H_demag`        | vector_field   | A/m           | full_domain    |
| `H_ext`          | vector_field   | A/m           | full_domain    |
| `H_ant`          | vector_field   | A/m           | full_domain    |
| `H_eff`          | vector_field   | A/m           | full_domain    |
| `H_ani`          | vector_field   | A/m           | magnetic_only  |
| `H_dmi`          | vector_field   | A/m           | magnetic_only  |
| `H_mel`          | vector_field   | A/m           | magnetic_only  |
| `H_ani_cubic`    | vector_field   | A/m           | magnetic_only  |
| `H_dmi_bulk`     | vector_field   | A/m           | magnetic_only  |
| `H_oe`           | vector_field   | A/m           | full_domain    |
| `H_therm`        | vector_field   | A/m           | magnetic_only  |
| `E_ex`           | global_scalar  | J             | magnetic_only  |
| `E_demag`        | global_scalar  | J             | magnetic_only  |
| `E_ext`          | global_scalar  | J             | full_domain    |
| `E_ani`          | global_scalar  | J             | magnetic_only  |
| `E_dmi`          | global_scalar  | J             | magnetic_only  |
| `E_total`        | global_scalar  | J             | full_domain    |
| `mode_amplitude` | spatial_scalar | dimensionless | magnetic_only  |
| `mode_real`      | vector_field   | dimensionless | magnetic_only  |
| `mode_imag`      | vector_field   | dimensionless | magnetic_only  |
| `mode_phase`     | spatial_scalar | rad           | magnetic_only  |

New quantities may be added but existing IDs must not change.

## Key Terminology

| Term                | Meaning                                                  |
| ------------------- | -------------------------------------------------------- |
| **Quantity**         | A named physical observable with shape, unit, and domain |
| **QuantityId**       | Canonical string identifier (e.g. `"H_ex"`)              |
| **QuantityShape**    | `vector_field`, `spatial_scalar`, `global_scalar`        |
| **QuantityDomain**   | `magnetic_only`, `full_domain`                           |
| **QuantityLocation** | `node`, `cell`, `global`                                 |
| **QuantityReduction**| `none`, `average`, `sum`, `min`, `max`, `magnitude`      |
| **StepDiagnostics**  | Solver telemetry: step, dt, wall_time, error_estimate    |
| **GlobalQuantityRow**| Per-step physical scalar samples (energies, averages)    |
| **QuantityProvider** | trait: evaluates a quantity from runtime state           |
| **QuantitySink**     | Where output goes: live_preview, snapshot, table, API    |

## Consequences

- Adding a new quantity requires **one** Rust change (catalog entry) + auto-propagation.
- Frontend becomes a thin catalog consumer, not a catalog maintainer.
- Solver diagnostics have a clean separation from physical observables.
- Transport unification enables generic quantity preview without magnetization special-casing.
- Legacy `SaveField`/`SaveScalar` remain working during transition via compat wrappers.

## Rozdzielenie rodzaju rekordu i progress — doprecyzowanie 2026-10-10

Status rozszerzenia: kontrakt przyjęty w zakresie naprawy4204792253; implementacja
w toku, wykonanie i zgodność end-to-end **NOT VERIFIED**.

### Problem i decyzja

Legalny identyfikator obiektu `fem_eigen_progress` nie może klasyfikować rekordu
jako callback solvera. Jedynym właścicielem rodzaju rekordu jest współdzielony
`StepDataKind` w `fullmag-quantities`: `physical_observation`, `solver_progress`
i `legacy_unclassified`. Nowi producenci nadają jawny rodzaj. Tworzenie nowych
struktur Rust może domyślnie oznaczać physical, lecz brak pola podczas
odczytu historycznego JSON zawsze oznacza legacy_unclassified, nigdy domyślną
obserwację fizyczną. Nieznana wartość enum jest błędem.

Postęp solvera ma oddzielny typowany kanał `solver_progress`, z wariantem
`fem_eigen` i istniejącymi metrykami. `per_object_scalars` zawiera dane
rzeczywistych obiektów. Nie używamy nazw obiektów, wartości zerowych ani braku
observation_frame jako heurystyki klasyfikacji. Katalog ilości, jednostki SI,
Python DSL i ProblemIR pozostają bez zmian.

### Spójność i migracja

Physical record nie może mieć payload solver_progress. Solver-progress record
musi mieć zgodny typowany payload i nie może publikować fizycznych quantity
frames, per-object scalar samples ani placeholderów liczbowych jako obserwacji.
`StepStats`, `StepDiagnostics`, `GlobalQuantityRow`, V2 transport, CLI live
writers i API ingestion/projekcje przenoszą ten sam rodzaj oraz kanał.
Walidacja sprzecznego kind/payload jest wykonywana na granicach transportu.

Historyczne dane bez discriminatora pozostają nieklasyfikowane: zachowujemy
oryginalne bajty i wartości w zapisanych runach/archiwach, nie dokonujemy
heurystycznej migracji i nie traktujemy ich jako potwierdzonej fizyki.
Nieklasyfikowany rekord nie jest źródłem kwalifikowanych quantity/status/table
projekcji. Dane surowe pozostają dostępne przez istniejące artefakty; jawna
rekoncyliacja wymaga oddzielnego dowodu producenta. To ograniczenie dotyczy
interpretacji danych, nie ich usunięcia. Nowa obserwacja legalnego obiektu
`fem_eigen_progress` jest physical i zachowuje wszystkie wartości.

Publiczne V2 scalar-window/stage-progress zachowują dotychczasowy kształt;
wewnętrzne raw DTO otrzymują additive discriminator i kanał. Jeżeli wdrożenie
wymaga zmiany publicznego V2 wire, musi przejść normalny OpenAPI/codegen;
nie wolno ręcznie nadpisywać chronionych wygenerowanych plików.

### Obowiązki i dowody

Właściciele: quantities step_data/transport; runner types/lib; CLI types,
step_utils, orchestrator, live_workspace, interactive_runtime_host; API types,
session, main, quantities i handlers data/scalars,tables, sessions/status,
simulation/runtime. Odczyty metryk stage progress przechodzą na typowany kanał.

Regresje GHA: rzeczywisty modal producer→CLI→API bez physical row; legalny
object_id zachowuje quantity/table/status; serde i persistence round-trip
zachowują kind/channel; brak kind pozostaje legacy; unknown enum i sprzeczny
payload są odrzucane; metryki i scope stage progress pozostają widoczne.
Sukces testów źródeł nie jest dowodem runtime ani fizycznej kwalifikacji.

Rollback nie może przywrócić klasyfikacji po object_id. Archiwa pozostają
nietknięte; przejściowe numeric placeholders są legalne tylko jako dane
shim z jawnym nie-fizycznym rodzajem i bez admission do quantity projections.
