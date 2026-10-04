# P6-66 — accepted FEM CPU producer

**Status:** source checkpoint / OPEN / NOT VERIFIED
**Data:** 2026-10-02
**Cel:** dostarczyć jeden fail-closed producer finalnego `m` dla
accepted `backend=fem`, `device=cpu`, `precision=double`, `mode=strict`.

## Dlaczego ten increment jest potrzebny

P6-64b wykazał, że preparation siatki i przestrzeni nie jest wykonaniem
solvera. `accepted_fem_preparer.rs` publikuje `PreparationReceipt`, lecz nie
wykonuje kroku czasowego i nie tworzy `m_final.json`. Konsumenci P6-60/P6-61
mają już readera i kontrakt źródła, a ten increment dodaje accepted FEM
dispatch oraz producer, lecz pełny łańcuch `run → attempt → output →
SolutionSet → pin` nadal wymaga kolejnych bramek runtime.

Ten przyrost zapisuje kontrakt i izolowany adapter. Nie oznacza przejścia
runtime ani kwalifikacji fizycznej.

## Kontrakt wejściowy

Adapter może wystartować dopiero, gdy nadrzędny lifecycle potwierdzi:

| Tożsamość | Warunek |
|---|---|
| RunSpec | immutable accepted snapshot, requested `fem/cpu/double/strict` |
| claim | aktywny `ResourceKind::Cpu`, `gpu_memory_bytes=0`, aktualna epoch i lease token |
| plan | `requested_backend=fem`, `resolved_backend=fem`, strict, `BackendPlanIR::Fem` |
| preparation | exact `PreparationReceipt` z accepted runu, `PreparationBinding` równy `ResolvedTaskInput.preparation` |
| FEM space | producer `fullmag.mfem.mesh_space`, `fe_family=H1`, `fe_order=1`, local/true DOF evidence |
| inputs | rozwiązane wyłącznie z accepted CAS i tego samego planu; seed pozostaje w ProblemIR |
| override | `FULLMAG_FEM_EXECUTION`, jeśli ustawione, musi być `cpu`; `FULLMAG_FEM_ALL_IN_GPU` i wymuszenie GPU są odrzucane |

Receipt preparation jest dowodem wejścia, nie dowodem solvera. Adapter nie
uruchamia ponownie preparation i nie zastępuje receipt planem z live session.
`StageFemMeshAsset::build_from_backend_plan` otrzymuje exact accepted plan;
jego identity wiąże runner z planem, podczas gdy native preparation fingerprints
pozostają w osobnej domenie.

## Przebieg wykonania

```text
durable Prepare + Start
  → accepted claim/heartbeat/Stop lifecycle
  → deterministic preflight: request/lease/PreparationReceipt/CAS/native lane
  → immutable prepared execution input
  → private attempt output directory
  → started receipt
  → runner FEM CPU with StageFemMeshIdentity
  → explicit m_final.json, bounded read
  → native receipt + local node map + indexed geometry digest
  → FemCpuAcceptedStateSnapshotV1 + AcceptedStateRef
  → typed final_state/total_energy output payloads
  → existing publish_study_outputs
```

Adapter nie wybiera taska, nie claimuje zasobu, nie potwierdza Startu,
nie zwalnia lease i nie interpretuje timeoutu jako sukcesu. Te operacje należą
do istniejącego supervisor/scheduler/worker lifecycle. Process-level hunk w
`accepted_study_worker.rs` wybiera adapter po exact request, zachowuje ten sam
completion barrier/recovery co FDM i przekazuje mu prepared input po zapisaniu
started receipt.

## Kontrakt finalnego stanu

Nowy `fullmag.fem.cpu.accepted-state-snapshot.v1` nie reutilizuje
`FdmCpuAcceptedStateSnapshotV1`. Primary carriers są jawne i uporządkowane:

1. `fem.cpu.native-local-node-values-f64le.v1` — `values_sha256` z native receipt;
2. `fem.cpu.native-local-node-map.v1` — `native_node_map_sha256` z mapy;
3. `fem.cpu.native-indexed-geometry.v1` — `native_indexed_geometry_sha256` z receipt.

`clock` bierze exact `step/time/dt` z native snapshot receipt. `clock_digest`
i `state_digest` są wyliczane przez wspólny `accepted_state_digests`, a
`AcceptedStateRef` dodatkowo wiąże run, step, ownership epoch, preparation
domain i execution-plan digest. Digest geometrii nie jest deklaracją
kwalifikacji naukowej ani zgodności z inną domeną markerów.

Wartości są akceptowane wyłącznie po walidacji istniejącego application
codec. Odrzucamy `fem_cpu_baseline_internal`, `fem_native_gpu`,
`resolved_fallback`, brak mapy, brak geometry digestu, niezgodne F64LE i
niezgodne node count. Odczyt `m_final.json` sprawdza rozmiar pliku przed
alokacją i respektuje budżet storage claimu.

## Ograniczenie native lane

Static PBC pozostaje jawnie poza tym bounded producerem. Runner posiada
`FemStaticPbcLane`, ale jego wybór nie jest jeszcze eksportowany jako
niemutowalna atestacja publicznego kontraktu. Adapter odrzuca zatem każdy
accepted FEM plan z `periodic_node_pairs` przed rezerwacją katalogu próby;
`ReferenceReduction` i ukryty fallback nie mogą wejść do solvera. Odblokowanie
tej gałęzi wymaga osobnego, wersjonowanego receipt native lane w runnerze oraz
osobnej bramki managed/scientific.

## Wykonany hunk integracyjny

Własny increment obejmuje:

1. deklarację `accepted_fem_state` i `accepted_fem_study_worker` w
   `accepted_worker_main.rs`;
2. exact FEM dispatch w `accepted_study_worker.rs`, przy zachowaniu
   Start/heartbeat/Stop/recovery/completion i istniejącego FDM branch;
3. pełny preflight przed rezerwacją katalogu oraz started receipt;
4. wspólny worker completed receipt z FEM `AcceptedStateRef` i output identity;
5. source regressions dla lifecycle, request/lease/preparation/provenance/map/
   geometry mismatch, bez kompilacji testów jednostkowych w bieżącej bramce.

## Brakujące binaria build192 i minimalne pakowanie

Build192 (`fa7378e72018e8d98157ff37a27861c48f670626`, build
`5d750ed66e584869ab6e88e48c457c86`) zakończył się receipt exit 0 i 113/113
zarejestrowanych artefaktów, ale nie jest pełnym pakietem accepted route.
Źródłowy `crates/fullmag-api/Cargo.toml` deklaruje targety; problem leżał w
instalacji `makefile`, która kopiowała tylko worker i supervisor. Hunk został
zastosowany w commit `c09496a5d93366ec897d4917d1e3b4ccce727527`; poniższa lista
pozostaje dokumentacją exact pakietu:

```make
@cp "$${cargo_target_dir}/release/fullmag-api-accepted-supervisor" ...
```

następujące programy:

```text
fullmag-api-accepted-scheduler
fullmag-api-resource-pool
fullmag-api-accepted-fem-preparer
fullmag-api-accepted-fem-preparation-scheduler
fullmag-api-preparation-resource-pool
```

Te same pięć nazw znajduje się również na liście `patchelf` w tym recipe.
Existing portable package scripts już oczekują tych plików; nie należy
zmniejszać ich allow-listy. Nowy managed `fem-cpu-release` musi zarejestrować
pełny artifact list przed uruchomieniem verifiera preparation/accepted.

## Dowody i granice

| Bramka | Stan |
|---|---|
| kontrakt source i ADR | PASS po odczycie plików; checkpoint zapisany |
| binary packaging hunk | ZASTOSOWANY w `c09496a5d93366ec897d4917d1e3b4ccce727527` |
| accepted FEM producer source | dodany i podłączony do process lifecycle |
| preflight przed started receipt | źródłowo wymuszony; runtime NOT VERIFIED |
| production worker source check | PASS — receipt `13e0e5a9c720480b89e155573680afaf`, exit 0, niezmienione źródła |
| production API source check | PASS — receipt `a88e5eefcb584bdca4db9e2b67ed45aa`, exit 0, niezmienione źródła |
| independent source review | PASS — po poprawkach preflight, recovery-first, output allow-list i wiring brak P0/P1 |
| unit compilation/run | NOT RUN — bieżąca bramka zakazuje kompilacji testów jednostkowych |
| managed build | BLOCKED — runner miał `storage_free_bytes=6775119872`, poniżej bramki 8 GiB; nie składano joba |
| native FEM CPU execution | NOT VERIFIED |
| SolutionSet/materialized dataset/pin | NOT VERIFIED |
| P6-60/P6-61 | OPEN / NOT VERIFIED |
| scientific qualification | NOT VERIFIED; microcase lifecycle nie jest testem fizyki |

## Źródła

- [ADR 0045 — accepted FEM CPU state producer](../../../../../adr/0045-accepted-fem-cpu-state-producer.md)

- `crates/fullmag-api/src/accepted_fem_preparer.rs`
- `crates/fullmag-api/src/accepted_study_worker.rs`
- `crates/fullmag-runtime-control/src/study.rs`
- `crates/fullmag-application/src/study_artifact.rs`
- `crates/fullmag-runner/src/artifacts.rs`
- `crates/fullmag-runner/src/observation.rs`
- `crates/fullmag-quantities/src/fem_state_snapshot_receipt.rs`
- `crates/fullmag-quantities/src/fem_local_node_map.rs`
- `makefile`
- `crates/fullmag-api/Cargo.toml`
- `docs/plans/active/refactor_runtime/final/p6/64b-accepted-fem-execution-gap.md`
