# ADR 0045 — producent accepted FEM CPU dla finalnego stanu

- Status: accepted for implementation checkpoint
- Data: 2026-10-02
- Zakres: accepted `run-json` → przygotowanie FEM → worker CPU → `m_final.json`
- Powiązane decyzje: [ADR 0035](0035-typed-study-artifact-manifest-and-worker-boundary.md), [ADR 0037](0037-accepted-preparation-resource-admission.md), [ADR 0042](0042-native-final-field-snapshot-receipt.md)

## Kontekst

Accepted preparation ma już osobny lease, producer natywnej siatki i
niezmienny `PreparationReceipt`. Bieżący accepted worker odrzuca jednak każdy
plan poza FDM CPU/GPU. Dolna warstwa runnera potrafi wykonać plan FEM z
`StageFemMeshIdentity` i zapisać natywny finalny snapshot, ale nie było
jednego adaptera, który związałby te artefakty z accepted claimem i publikacją
study output.

Sam sukces preparation nie jest dowodem wykonania solvera. Plan FEM, receipt
przygotowania i worker claim muszą pochodzić z tego samego immutable accepted
runu. Natywna mapa lokalnych węzłów i digest geometrii są dowodem producenta
runnera; nie wolno ich odtwarzać z planu ani z ostatniego `StepStats`.

## Decyzja

1. Dodajemy osobny adapter `accepted_fem_study_worker` jako rodzeństwo
   istniejącego workera. Wspólny worker zachowuje protokół Start/Prepare,
   heartbeat, Stop, completion barrier, recovery i publication. Adapter
   najpierw zwraca immutable prepared execution input, a po durable boundary
   dostarcza wyłącznie wykonanie FEM CPU z tego przygotowanego wejścia.
2. Adapter przyjmuje wyłącznie żądanie `backend=fem`, `device=cpu`,
   `precision=double`, `mode=strict`, claim zasobu `Cpu`, plan resolved
   `BackendTarget::Fem` oraz przygotowanie H1/P1. Aktywny override
   `FULLMAG_FEM_EXECUTION` inny niż `cpu`, wymuszenie GPU albo brak feature
   natywnego kończy się błędem przed uruchomieniem solvera. Seed z immutable
   ProblemIR pozostaje częścią wejścia; nie kopiujemy ograniczenia FDM, które
   odrzuca seedy.
3. Adapter wywołuje overload runnera z `StageFemMeshIdentity` z dokładnego
   accepted `ExecutionPlanIR`. `PreparationReceipt` jest sprawdzany względem
   `ResolvedTaskInput.preparation`; nie porównujemy bezpośrednio fingerprintu
   `mfem_mesh_space.topology.v1` z `fem_mesh_topology_fingerprint_v3`, bo są to
   różne domeny digestu. Związek zapewniają immutable plan, receipt i source
   accepted runu.
4. Po `RunStatus::Completed` adapter czyta wyłącznie jawny `m_final.json`, z
   limitem `claim.lease.budget.storage_bytes`, dekoduje istniejący field JSON
   v1 i wymaga:
   `layout.backend=fem`, H1/P1, `execution_engine=fem_cpu_native`,
   `native_state_snapshot`, `native_node_map`,
   `native_node_map_sha256` oraz `native_indexed_geometry_sha256`. Brak,
   mismatch albo fallback kończy attempt jako failure.
5. `FemCpuAcceptedStateSnapshotV1` jest odrębnym, wersjonowanym kontraktem
   accepted state. Jego primary carriers to digest wartości lokalnego AoS,
   digest mapy i digest indexed geometry. Z tych carrierów powstaje istniejący
   `AcceptedStateRef` związany z `run_id`, `step_id`, epoch claimu,
   preparation fingerprint i fingerprintem planu.
6. Typed `final_state` (`State`) oraz dozwolony `total_energy` (`Scalar`) przechodzą przez istniejące
   `publish_study_outputs`. Adapter nie publikuje FDM observation source i nie
   tworzy drugiego katalogu wyników. `SolutionSet`, tensor, manifest datasetu,
   pin oraz P6-60/P6-61 są kolejnymi etapami i nie stają się gotowe przez sam
   source checkpoint.
7. Pakowanie managed CPU jawnie instaluje wszystkie binaria używane przez
   accepted flow. `Cargo.toml` deklaruje targety, a minimalny hunk instalacyjny
   pięciu brakujących programów został zastosowany w `makefile` i na liście
   `patchelf` (commit `c09496a5d93366ec897d4917d1e3b4ccce727527`). Build192
   pozostaje historycznym artefaktem bez tych pięciu programów.

## Konsekwencje

- Requested i resolved execution pozostają widoczne; GPU nie może spaść do
  CPU, a FDM nie może udawać FEM.
- Worker pozostaje orchestration boundary. Solver i finalny receipt należą do
  natywnego backendu FEM/MFEM; adapter nie tworzy syntetycznej mapy, geometrii
  ani stanu.
- Cały deterministyczny preflight request/lease/preparation/CAS/native runtime
  odbywa się przed rezerwacją katalogu próby i zapisem `started receipt`.
  Po tej granicy solver konsumuje wyłącznie immutable prepared input; recovery
  czyta tylko istniejące receipts i finalny snapshot.
- Static PBC jest obecnie fail-closed. Prywatny typ runnera
  `FemStaticPbcLane` nie daje jeszcze publicznej, immutable atestacji wyboru
  native lane, dlatego adapter odrzuca ten przypadek i nie dopuszcza
  `ReferenceReduction` ani ukrytego fallbacku.
- Source-level contract i source formatting check nie dowodzą natywnego
  runtime. Do zamknięcia P6-60/P6-61 nadal potrzebne są managed build, accepted
  E2E, cold-store publication i osobne dowody naukowe.
- `accepted_fem_study_worker.rs` jest podłączony do istniejącego process
  lifecycle małym hunkiem w `accepted_study_worker.rs`; FDM branch zachowuje
  dotychczasowe guardy i receipt recovery.

## Bramka weryfikacji

Source checkpoint sprawdza tekstową obecność contractu, exact binary list,
preflight-before-receipt ordering i fail-closed guards. Kompilacja testów
jednostkowych, managed build, solver, managed runtime i kwalifikacja naukowa
pozostają **NOT VERIFIED**; managed build należy wykonać przez zatwierdzoną
kolejkę runnera.
