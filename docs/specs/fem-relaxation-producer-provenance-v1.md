# Kontrakt `fem_relaxation_producer_provenance.v1`

- Status: `source-visible partial / NOT VERIFIED`
- Właściciel: FEM relaxation-to-eigen artifact boundary
- Data: 2026-10-01
- Powiązany dokument naukowy: `docs/physics/r4-producer-provenance.md`

Ten dokument definiuje addytywny sidecar, który wiąże exact payloady relaksacji
z rzeczywistym runem producenta, source snapshotem i planem użytym do
materializacji. Nie zmienia historycznych schematów `equilibrium_artifact.v7`,
`LinearizationState.v6`, V1 fields ani ich digestów. Dla canonical Ku zachowuje
odrębną rodzinę V2.

## 1. Cel i granice

Sidecar zapobiega sytuacji, w której konsument bierze payload skopiowany z
innego runu i wpisuje do niego `build_identity` bieżącego procesu. Obejmuje:

- `accepted_fem_equilibrium_fields`;
- `certified_fem_equilibrium_fields`;
- `recomputed_fem_linearization_certificate`;
- dokładny plan producenta;
- build/source identity producenta;
- source run/stage, mesh i fizyczne sygnatury równowagi;
- raw byte hashes i payload content digests.

Sidecar nie dowodzi zbieżności ani poprawności fizycznej. Brak sidecara jest
brakiem dowodu, a nie zgodnością domyślną.

## 2. Canonical schema

```json
{
  "schema_version": "fem_relaxation_producer_provenance.v1",
  "source_run_id": "string",
  "source_stage_id": "string",
  "source_stage_kind": "relaxation",
  "producer_build_identity": {
    "built_at_utc": "string",
    "git_commit": "string",
    "worktree_state": "string",
    "source_snapshot_sha256": "<64 lowercase hex>"
  },
  "producer_plan_snapshot": {
    "namespace": "fem_relaxation.producer_plan.v1",
    "encoding": "utf-8-json-bytes",
    "preimage_json": "exact UTF-8 JSON string",
    "raw_sha256": "sha256:<64 lowercase hex>",
    "framed_sha256": "sha256:<64 lowercase hex>"
  },
  "source_mesh_topology_sha256": "sha256:<64 lowercase hex>",
  "equilibrium_content_sha256": "sha256:<64 lowercase hex>",
  "equilibrium_material_signature": "sha256:<64 lowercase hex>",
  "equilibrium_static_physics_signature": "sha256:<64 lowercase hex>",
  "equilibrium_boundary_signature": "sha256:<64 lowercase hex>",
  "payloads": {
    "accepted_fields": {"path": "relative", "schema_version": "string", "raw_bytes_sha256": "sha256:<64 lowercase hex>", "content_sha256": "sha256:<64 lowercase hex>"},
    "certified_fields": {"path": "relative", "schema_version": "string", "raw_bytes_sha256": "sha256:<64 lowercase hex>", "content_sha256": "sha256:<64 lowercase hex>"},
    "recomputed_certificate": {"path": "relative", "schema_version": "string", "raw_bytes_sha256": "sha256:<64 lowercase hex>", "content_sha256": "sha256:<64 lowercase hex>"}
  },
  "cross_build_policy": "same_source_snapshot_required"
}
```

Wymagane są wszystkie pola pokazane powyżej. Nieznane pola, nieznany
`cross_build_policy`, `null`, uppercase hex, digest o złej długości i ścieżki
absolutne są odrzucane. Pola `preimage_json` i payloady odnoszą się do
rzeczywistych bajtów; klient nie może ich zrekonstruować z typed object.

`producer_build_identity.source_snapshot_sha256` zachowuje dokładnie format
`fullmag-build-info`: 64 małe znaki hex bez prefiksu. Identyfikatory source
snapshotu producenta i konsumenta w `LinearizationIdentity.v2` używają tego
samego formatu. Digesty payloadów, planów i sygnatur fizycznych nadal mają
prefiks `sha256:`. Są to odrębne pola; konsument nie normalizuje ani nie
podmienia tożsamości źródeł.

## 3. Ścieżki i manifest

Standalone public runner, także wywoływany przez Python `_core.run_problem_json`,
nadaje tożsamość rzeczywiście nowej execution przed dispatch. Dla relaksacji FEM
jest to nowy UUID runu i `stage-001`; komplet jawnych metadanych orkiestratora
pozostaje bez zmian. Częściowe, puste lub nietypowane metadane są błędem.
Ta reguła nie nadaje nowej tożsamości importowanym artefaktom równowagi.
Bias sweep tworzy własne etapy relaksacji w obrębie nowej execution.
Implementacja: `bind_fem_execution_stage_identity` w runnerze oraz binding
na wejściu `InteractiveRuntime::execute_planned_streaming`.
Jest to dowód źródłowy; przygotowanych regresji Rust nie kompilowano.

Producent zapisuje sidecar obok źródłowych payloadów:

```text
equilibrium/producer_provenance.v1.json
```

Modalny sample zachowuje dokładne bajty pod:

```text
eigen/metadata/sample_NNNN/producer_provenance.v1.json
```

Manifest może reklamować dopiero zwalidowaną ścieżkę:

```json
{
  "artifacts": {
    "producer_provenance_v1_path": "eigen/metadata/sample_0000/producer_provenance.v1.json",
    "producer_provenance_v1_paths": [
      "eigen/metadata/sample_0000/producer_provenance.v1.json"
    ]
  }
}
```

W multi-k kolejność tablic musi odpowiadać `sample_index`. Konflikt różnych
bajtów pod jedną ścieżką jest błędem; deduplikacja identycznych bajtów nie może
wybrać pierwszego rekordu po cichu.

Główny verifier sprawdza zbiór tych ścieżek względem faktycznie policzonych
próbek spectrum, ich kanoniczne nazwy i kolejność oraz zgodność singular/plural.
Brak historyczny lub pusty zbiór oznacza brak dowodu producenta. Poprawne
discovery ma status `producer_paths_bound`, lecz `payload_replay_status`
pozostaje `NOT_VERIFIED`, dopóki dokładne payloady i źródło nie zostaną odtworzone.

## 4. Transport i odpowiedzialność warstw

1. `fem/relax/finalize.rs` przechwytuje build identity i exact plan w granicy
   produkcji, zapisuje trzy payloady i sidecar atomowo.
2. `artifacts.rs::RunMetadata` pozostaje źródłem danych runu, ale sidecar musi
   jawnie wskazywać konkretne payloady i ich raw hashes.
3. CLI odczytuje sidecar z tego samego katalogu co payloady i przekazuje typed
   `ProducerProvenance` do nowego verified API.
4. `AcceptedFemRelaxExactArtifacts` transportuje exact payload bytes, a
   `FemRelaxationProducerProvenance` jest przekazywane jako osobny, wymagany
   argument; konstruktor verified nie może wywoływać `build_identity_json()`
   jako źródła producer identity.
5. `build_linearization_identity_v2` kopiuje zwalidowaną producer identity i
   plan snapshot; consumer identity jest dodawane osobno.
6. Loader cross-run przyjmuje wyłącznie kompletny bundle. Brak sidecara,
   mismatch source snapshotu albo mismatch raw hash kończy się `NOT VERIFIED`.

## 5. Same-run, cross-run i vector-only state

### Same-run

Same-run może przejść, jeżeli producer sidecar pochodzi z tej samej finalizacji,
a run/stage, plan, mesh, m0, material/static/boundary i payload hashes są
zgodne. „Ten sam proces” nie jest samodzielnym dowodem.

### Cross-run

Cross-run wymaga jawnego importu FEM bundle. Samo skopiowanie trzech JSON-ów,
same `m0` albo zgodny `node_count` nie tworzy verified handoffu.

### `LoadState`

Zwykły `LoadState` pozostaje vector-only. Odczytuje magnetyzację, ale nie
przywraca accepted/certified/recomputed payloadów ani producer provenance.
Po jego użyciu handoff relaksacji jest czyszczony. Przywrócenie pełnego FEM
handoffu wymaga osobnego, jawnego loadera bundle.

## 6. V1/V2 i damping

`ProducerProvenance` zachowuje wersję payloadów i nie pozwala mieszać rodzin:

| Rodzina | `equilibrium` | `linearization` | material role |
|---|---|---|---|
| Ku-free V1 | `equilibrium_artifact.v7` | `LinearizationState.v6` | historyczny raw signature |
| Ku V2, także $K_u=0$ | `equilibrium_artifact.v8` | `LinearizationState.v7` | canonical signature + raw provenance |

Różne damping relaksacji i eigen są dozwolone, jeżeli fizyczne sygnatury
statycznego materiału, statyki i boundary są zgodne. Raw plan provenance obu
planów pozostaje osobne.

## 7. Non-shared Floquet

Non-shared Bloch/Floquet nie może zgubić producer handoffu na granicy funkcji.
Docelowo wejście operatora przekazuje verified provenance do publikatora
modalnego. `operator_input_signature_sha256` musi wiązać rzeczywiste macierze,
mapę par periodycznych, fazę, $\mathbf k$, boundary/gauge i damping.

Jeżeli pełne wiązanie nie jest dostępne, wynik może być wykonany i zapisany jako
`identity_unavailable`, ale nie może reklamować pełnego `linearization_identity`
ani kwalifikacji. To jest fail-closed granica dowodu, nie trwałe wyłączenie
non-shared ścieżki.

## 8. Testy i bramki

Wymagane regresje:

- valid same-run sidecar roundtrip;
- missing/unknown/null fields;
- uppercase lub zła długość SHA;
- foreign build/source snapshot;
- mutation dowolnego raw payloadu i plan preimage;
- sample path mismatch i duplicate path conflict;
- V1/V2 mixed family;
- cross-run loader bez sidecara;
- vector-only `LoadState` nie przywraca handoffu;
- non-shared provenance i non-null operator signature.

Managed runtime, native compilation, residual, mesh/airbox convergence i
porównanie z COMSOL/TetraX są osobnymi bramkami. Ten kontrakt nie daje im
automatycznego PASS.

## 9. Status implementacji

Source-visible fragment jest wdrożony w:

- `artifacts.rs::write_artifacts`, który dla zakończonej relaksacji FEM i
  obecnych `producer_run_id`, `producer_stage_id`, `producer_stage_kind`
  buduje sidecar z rzeczywistego build identity oraz exact bajtów trzech
  payloadów;
- `eigen_equilibrium_contract.rs`, który definiuje typed schema, waliduje
  digesty, ścieżki, rodzinę V1/V2 i source identity oraz udostępnia verified
  constructor wymagający sidecara;
- `orchestrator.rs`, który odczytuje sidecar z tego samego katalogu i przekazuje
  go do verified handoffu.

Starszy exact constructor bez producer provenance kończy się błędem
`relax_stage_handoff_exact_producer_provenance_required`; nie ma ścieżki
uzupełniającej bieżącym buildem. Brak wymaganych runtime metadata powoduje
brak sidecara i pozostawia wynik `NOT VERIFIED`.

Nadal otwarte są: path/manifest remap dla sidecara w modalnych sample, migracja
pozostałych native call sites i ścieżek interaktywnych/cross-run, non-shared
Floquet operator identity, managed runtime oraz native regression execution.
Do czasu tych bramek pełny R4 pozostaje `NOT VERIFIED`.
