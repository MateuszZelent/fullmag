# FEM Field/Topology Visualization Contract Remediation - plan implementacji

Data: 2026-06-26  
Status: READY FOR IMPLEMENTATION  
Zrodlo: `docs/diagnostics/fem-exchange-tetrax-tetmag-fullmag-visualization-audit-2026-06-26.md`  
Zakres: FEM mesh identity, v2 data-plane field payloads, Control Room 3D viewport, FEM exchange validation proof

> Dla agentow implementujacych: przed dotykaniem kodu uzyj `superpowers:subagent-driven-development` albo `superpowers:executing-plans`. Ten plan jest task-by-task i uzywa checkboxow. W czesciach dotykajacych viewportu dodatkowo uzyj `.agents/skills/frontend-v2-viewport-lifecycle/SKILL.md`; w czesciach dotykajacych API uzyj `.agents/skills/resource-first-api-check/SKILL.md`; w czesciach dotykajacych native FEM runtime uzyj repo `justfile`, nie host-first buildow.

**Goal:** Usunac wszystkie klasy bledow opisane w audycie, w ktorych pole FEM moze zostac narysowane na niezgodnej topologii, niejawnej kolejnosci wezlow lub stale-compatible color bufferze. Exchange operator nie jest zmieniany bez runtime proof.

**Architecture:** Topologia i pole pozostaja osobnymi resource-first zasobami, ale ich kompatybilnosc staje sie jawna. FEM mesh dostaje stabilny fingerprint tresci, FMVP dostaje wersje v3 z metadanymi domeny i opcjonalna sekcja indeksow wezlow, a viewport renderuje powierzchnie tylko po zgodnym topology fingerprint/revision i zgodnej mapie value-to-node.

**Tech Stack:** Rust `fullmag-api`/`fullmag-runner`, binary codecs FMVP/FMMT, OpenAPI v2, Next.js 16 Control Room, TypeScript/Vitest, Three.js/R3F demand-driven viewport, managed FEM runtime przez `just ensure-managed-fem-runtime` i `just rebuild-fem-runtime`.

---

## 1. Kryteria sukcesu

Po wdrozeniu:

1. Zmiana pozycji wezlow, lacznosci tetra, boundary faces, markerow, `object_segments`, `mesh_parts`, `node_indices` albo `surface_faces` zmienia FEM topology fingerprint i bumpuje mesh/topology revision.
2. Pelne pole powierzchniowe deklaruje, dla jakiego `domain_generation_id`, topology revision i topology hash zostalo policzone.
3. Kazdy payload nie-pelnej domeny, czyli `object`, `part`, `selection`, `airbox`, `magnetic_only` albo sampled, niesie jawna liste globalnych node indices albo jest odrzucony dla surface shader/vector placement.
4. Viewport nie uzywa sortowanej rekonstrukcji wezlow magnetycznych jako kontraktu danych.
5. Retencja kolorow dopuszcza stale-compatible buffer tylko dla tej samej tozsamosci topologii.
6. Istnieja regresje API/frontend dla sciezek A, B, C z audytu i diagnostyka dla sciezki D.
7. Exchange sign/scaling pozostaje bez zmiany, a brak bledu operatora jest potwierdzony przez managed runtime proof.
8. Finalne bramki przechodza:
   - `cargo test -p fullmag-api`
   - `pnpm --dir apps/control-room generate:api`
   - `pnpm --dir apps/control-room test`
   - `pnpm --dir apps/control-room typecheck`
   - `pnpm --dir apps/control-room lint`
   - `pnpm --dir apps/control-room audit:idle-performance`
   - `CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SCREENSHOT_SCENES=fdm CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room screenshot:viewport-3d`
   - `CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d`
   - `just verify-fem-exchange-runtime`

---

## 2. Pokrycie problemow z audytu

| Audyt | Problem | Planowana odpowiedz |
|---|---|---|
| F1 | Exchange sign/scaling wyglada poprawnie | Nie zmieniac operatora. Dodac/utrzymac runtime proof i testy kontraktowe jako guard przed przypadkowym odwroceniem znaku. |
| F2 | `fem_mesh_identity` jest za slabe | Wspolny stabilny SHA-256 fingerprint topologii i uzycie go w `session.rs`, ETagach topologii i metadanych pola. |
| F3 | FMVP nie niesie metadanych topologii i indeksowania | FMVP v3 z `domain_generation_id`, `mesh_topology_revision`, `mesh_topology_hash`, `scope_kind`, `scope_id`, `indexing`, opcjonalnym `node_indices`. |
| F4 | `magnetic_only` opiera sie na nieudokumentowanym sorted-node order | Usunac implicit sorted fallback. Dopuszczac compressed magnetic payload tylko z jawna mapa wezlow albo odrzucac dla renderowania. |
| F5 | Scoped/sampled payloady sa rekonstruowane po stronie frontend | Backend zwraca dokladna liste indeksow po scope/sampling. Frontend porownuje liste z targetem i renderuje albo degraduje. |
| F6 | Retencja kolorow moze przejsc przez same-count topology change | Retention key i predicate obejmuja topology revision/hash; ref czyszczony na zmianie topologii. |
| F7 | Runtime validation exchange jest niepelna | Dodac `just verify-fem-exchange-runtime`, zachowac juz istniejace directional derivative tests, dodac brakujace mask/periodic/runtime gates. |
| Path A | Topologia zmienia sie przy tych samych licznikach | Regression w `session.rs` i viewport cache: same counts, inna lacznosc, revision/hash musi sie zmienic. |
| Path B | Compressed magnetic-only ma inna kolejnosc niz renderer | Test z permutowanymi indeksami; bez `node_indices` surface pass ma degradation. |
| Path C | Scoped/sampled field nie ma mapy wezlow | Test object/part/sampled z jawna mapa i test rejection przy braku mapy. |
| Path D | Auto range moze wzmacniac szum/outliery `H_ex` | Dopiero po F2-F6: dodac statystyki/diagnostyke range i test outlierow bez maskowania bledow indeksowania. |

---

## 3. Granice wdrozenia

Robimy:

- stabilna tozsamosc FEM topology w API/runtime;
- nowy kontrakt FMVP v3 dla vector field payloadow;
- kompatybilny dekoder v2 tylko dla legacy pelnej domeny;
- jawne odrzucenie renderowania przy braku mapy lub mismatch topologii;
- testy backend/API/frontend/browser;
- managed FEM runtime validation recipe.

Nie robimy w tym wdrozeniu:

- zmiany znaku, skalowania albo masowej projekcji exchange;
- osobnego viewportu FEM/FDM;
- przenoszenia physics semantics do React;
- ukrywania artefaktow przez smoothing, filtrowanie koloru albo stale retention;
- usuwania FMVP v2 z dekodera, dopoki wszystkie lokalne zasoby nie emituja v3.

---

## 4. Decyzje techniczne

### 4.1 Wspolny topology fingerprint

`fullmag-runner` juz ma prywatny stabilny SHA-256 generation id dla payloadu FEM mesh. Wdrozenie ma wyniesc wspolny helper zamiast duplikowac definicje w API:

```rust
pub fn fem_mesh_topology_fingerprint(mesh: &FemMeshPayload) -> String;
```

Fingerprint obejmuje:

- schema marker, np. `fullmag:fem-mesh-topology-fingerprint:v1`;
- `mesh_name`, `mesh_id`, `generation_id`;
- `nodes` jako `f64::to_le_bytes`;
- `elements`, `boundary_faces`;
- `element_markers`, `boundary_markers`;
- `periodic_boundary_pairs`, `periodic_node_pairs`;
- `object_segments`;
- `mesh_parts`, lacznie z `boundary_face_indices`, `node_indices`, `surface_faces`, `bounds_min`, `bounds_max`;
- `domain_mesh_mode`, `domain_frame`;
- `per_domain_quality` tylko wtedy, gdy jakikolwiek renderer lub field selection uzywa tej informacji do mapowania. Jesli nie, nie wlaczac quality do topology fingerprint, bo zmiana statystyk quality nie moze udawac zmiany lacznosci.

### 4.2 FMVP v3

FMVP v2 zostaje dekodowalny. Nowe FEM vector resources emituja FMVP v3.

Header v3 zachowuje 48-bajtowy poczatek:

```text
0..4    magic "FMVP"
4       version = 3
5       value_kind = 1  // f64
6       n_comp
7       flags
8..12   metadata_len u32
12..16  value_count u32
16..28  grid_x, grid_y, grid_z u32
28..44  quantity_id, zero padded utf-8
44..48  reserved u32 = 0
48..48+metadata_len metadata block
...     f64 values
```

Metadata block v1:

```text
0..4    magic "FMMI"
4..6    metadata_version u16 = 1
6..8    metadata_flags u16
8..16   domain_generation_id u64
16..24  mesh_topology_revision u64
24..56  mesh_topology_hash_sha256 bytes
56..60  indexing u32
60..64  node_index_count u32
64..66  scope_kind_len u16
66..68  scope_id_len u16
68..N   scope_kind bytes, scope_id bytes, node_indices u32[]
```

`indexing` enum:

- `0 = full_domain`: `pointCount == topology.nodeCount`, `node_indices` absent.
- `1 = explicit_node_indices`: `node_indices.len() == pointCount`, unsampled scoped or magnetic subset.
- `2 = sampled_node_indices`: `node_indices.len() == pointCount`, vector-glyph eligible only, not surface shader unless target explicitly expects that sampled subset.
- `3 = legacy_count_only`: decoder may expose diagnostics, renderer must not use it for surface or vector placement.

### 4.3 Fail-closed viewport compatibility

Renderer rule:

```text
surface shader requires:
  field.topologyHash == topology.hash
  and field.domainGenerationId == resource domain generation
  and either:
    full_domain pointCount == topology.nodeCount
    or explicit_node_indices exactly cover the target node selection
```

Vector glyph rule:

```text
vector glyphs may use sampled_node_indices,
but every glyph position must resolve through field.nodeIndices.
```

Legacy v2 rule:

```text
FMVP v2 may render only as full_domain when pointCount == topology.nodeCount
and the resource cache key proves the same topology revision. It must not satisfy
compressed magnetic-only, scoped, sampled, object, part, airbox, or selection passes.
```

---

## 5. Etap 0 - uzgodnienie aktualnego HEAD i test-first repro

- [ ] Przejrzec aktualne testy `backends/fem/tests/exchange_contract.cpp`; zachowac istniejace directional derivative cases jako czesc F7, zamiast dopisywac duplikaty.
- [ ] Dodac minimalny RED test dla F2 w `crates/fullmag-api/src/session.rs`: dwa `FemMeshPayload` z tym samym `generation_id`, `mesh_id`, liczba wezlow, liczba elementow i liczba boundary faces, ale z inna lacznoscia elementu, musza bumpowac mesh revision.
- [ ] Dodac RED test dla F6 w `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.test.ts`: poprzedni `ScalarColorBuffer` z `topologyRevision="mesh-a"` nie moze zostac zwrocony dla requestu `topologyRevision="mesh-b"` nawet przy tym samym `vertexCount`.
- [ ] Dodac RED test dla F4/F5 w `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`: compressed/scoped field bez `nodeIndices` nie buduje `scalarColors` ani vector resolvera.

Weryfikacja po samych RED testach:

```bash
cargo test -p fullmag-api session::tests::fem_mesh_identity_changes_for_same_count_connectivity_change -- --exact
pnpm --dir apps/control-room test -- --run MeshPartLayer
pnpm --dir apps/control-room test -- --run viewport3dRenderModel
```

Oczekiwany stan na koncu etapu: testy pokazuja aktualna klase bledu albo obecny brak kontraktu. Jesli ktorys test przechodzi juz przed fixem, zapisac w komentarzu testu, ktora istniejaca ochrona go pokrywa, i dodac ostrzejszy przypadek z audytu.

---

## 6. Etap 1 - stabilna tozsamosc FEM mesh/topology

Pliki:

- `crates/fullmag-runner/src/types.rs`
- `crates/fullmag-api/src/session.rs`
- `crates/fullmag-api/src/router_v2/handlers/data/domain.rs`
- `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`
- `crates/fullmag-api/src/schemas/mesh.rs`

Zadania:

- [ ] Wyciagnac wspolny helper `fem_mesh_topology_fingerprint(&FemMeshPayload) -> String` w `fullmag-runner`, uzywajacy `Sha256` i jawnego porzadku bajtow.
- [ ] Uzyc tego helpera w `fem_mesh_identity` albo zastapic `fem_mesh_identity` przez `fem_mesh_topology_fingerprint`.
- [ ] Zmienic `apply_fem_mesh_update` tak, aby `changed` bylo liczone po fingerprint, nie po `generation_id:mesh_id:counts`.
- [ ] Dodac `topology_fingerprint` do JSON mesh resources, gdzie frontend ma juz topology revision, bez przenoszenia ciezkiej topologii do statusu.
- [ ] Dodac header `x-fullmag-mesh-topology-hash` do binary topology responses FMMT.
- [ ] Uzyc fingerprintu w ETagach topology resources, aby cache nie mogl przetrwac same-count remesh.
- [ ] Nie wlaczac `per_domain_quality` do geometry fingerprint, chyba ze planowany field mapping lub renderer zacznie zalezec od quality payloadu.

Testy:

- [ ] `fullmag_runner::types::tests::fem_mesh_topology_fingerprint_changes_for_node_reorder`
- [ ] `fullmag_runner::types::tests::fem_mesh_topology_fingerprint_changes_for_element_connectivity`
- [ ] `fullmag_runner::types::tests::fem_mesh_topology_fingerprint_changes_for_mesh_part_node_indices`
- [ ] `fullmag_api::session::tests::same_count_fem_mesh_connectivity_change_bumps_mesh_revision`
- [ ] `fullmag_api::session::tests::same_count_fem_mesh_part_order_change_bumps_mesh_revision`

Weryfikacja:

```bash
cargo test -p fullmag-runner fem_mesh_topology_fingerprint -- --nocapture
cargo test -p fullmag-api same_count_fem_mesh -- --nocapture
cargo test -p fullmag-api router_v2::handlers::data::domain -- --nocapture
```

---

## 7. Etap 2 - FMVP v3 serializer i dekoder

Pliki backend:

- `crates/fullmag-api/src/field_store.rs`
- `crates/fullmag-api/src/quantity_data_plane.rs`

Pliki frontend:

- `apps/control-room/src/kernel/api/codecs/types.ts`
- `apps/control-room/src/kernel/api/codecs/fieldVectorCodec.ts`
- `apps/control-room/src/kernel/api/codecs/fieldVectorCodec.test.ts`
- `apps/control-room/src/kernel/api/binaryDecodePayload.ts`

Zadania backend:

- [ ] Dodac `FieldVectorBinaryMetadata` w `field_store.rs` z polami: `domain_generation_id`, `mesh_topology_revision`, `mesh_topology_hash`, `scope_kind`, `scope_id`, `indexing`, `node_indices`.
- [ ] Dodac `serialize_field_vector_binary_v3(quantity_id, n_comp, grid, values, metadata)`.
- [ ] Zachowac `serialize_field_vector_binary_v2` tylko dla payloadow, ktore rzeczywiscie nie maja topology/index semantics.
- [ ] Walidowac `node_indices.len() == point_count` dla `explicit_node_indices` i `sampled_node_indices`.
- [ ] Walidowac, ze `node_indices` sa finite/in-range dopiero w warstwie endpointu, gdzie znany jest mesh.
- [ ] Zmienic komentarze i opisy `quantity_data_plane` z "FMVP v2" na wersjonowany "FMVP v2/v3".

Zadania frontend:

- [ ] Rozszerzyc `DecodedFieldVector` o:

```ts
formatVersion: 2 | 3;
domainGenerationId: number | null;
meshTopologyRevision: string | null;
meshTopologyHash: string | null;
scopeKind: "full" | "object" | "part" | "airbox" | "selection" | "magnetic_only" | null;
scopeId: string | null;
indexing: "full_domain" | "explicit_node_indices" | "sampled_node_indices" | "legacy_count_only";
nodeIndices: Uint32Array | null;
```

- [ ] `decodeFieldVector` musi dekodowac v2 jako `formatVersion=2`, `indexing="legacy_count_only"` tylko gdy brak dowodu pelnej domeny w payloadzie.
- [ ] `decodeFieldVector` musi dekodowac v3 metadata block, weryfikowac `metadata_len`, dlugosci stringow, `node_index_count`, alignment i calkowity rozmiar bufora.
- [ ] `asDecodedComplexFieldVector` musi przenosic metadane, nie tylko wartosci.
- [ ] `transferablesForDecodedPayload` musi transferowac `nodeIndices.buffer`.

Testy:

- [ ] `field_vector_serializer_v3_encodes_full_domain_metadata`
- [ ] `field_vector_serializer_v3_encodes_explicit_node_indices`
- [ ] `decodeFieldVector decodes FMVP v3 full-domain metadata`
- [ ] `decodeFieldVector decodes scoped node indices`
- [ ] `decodeFieldVector rejects malformed v3 metadata lengths`
- [ ] `decodeFieldVector keeps FMVP v2 compatibility`

Weryfikacja:

```bash
cargo test -p fullmag-api field_store::tests::field_vector_serializer_v3 -- --nocapture
pnpm --dir apps/control-room test -- --run fieldVectorCodec
```

---

## 8. Etap 3 - endpoint pola: jawne scope, sampling i magnetic-only

Pliki:

- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs`
- `crates/fullmag-api/src/schemas/fields.rs`
- `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`

Zadania:

- [ ] W `ResolvedFieldScope` dodac semantyke `indexing`: full, explicit, sampled.
- [ ] `sample_field_scope` ma zostawiac finalne sampled `node_indices`, a nie tylko zmniejszac point count.
- [ ] Dla pelnej domeny endpoint emituje FMVP v3 z `indexing=full_domain`, `mesh_topology_hash` i bez `node_indices`.
- [ ] Dla `scope_kind=object|part|airbox|selection` endpoint emituje FMVP v3 z `indexing=explicit_node_indices` i dokladna lista `scope.node_indices`.
- [ ] Dla `max_samples` endpoint emituje FMVP v3 z `indexing=sampled_node_indices` i finalna lista sampled node indices.
- [ ] Dla `magnetic_only` z `point_count == mesh.nodes.len()` traktowac payload jako full-domain i maskowac/zerowac nonmagnetic wartosci zgodnie z istniejacym producentem.
- [ ] Dla `magnetic_only` z `point_count == magnetic_node_count` nie dopisywac sortowanej listy z API jako rzekomej prawdy, jezeli producent nie dostarczyl jawnych indeksow. Endpoint ma zwrocic blad 422 `field_indexing_missing` albo FMVP v3 `legacy_count_only`, ktory frontend odrzuci dla renderingu. Preferowane zachowanie produkcyjne: blad 422 dla surface-capable resource requestu.
- [ ] Cache key `projection_cache_key` musi zawierac `mesh_topology_hash` i hash `node_indices`, nie tylko `field_revision`, `gen_id`, scope token i sample token.
- [ ] `insert_field_headers` ma emitowac `x-fullmag-field-encoding: FMVP;version=3`, `x-fullmag-mesh-topology-hash`, `x-fullmag-field-indexing`, `x-fullmag-node-index-count`.
- [ ] `FieldVectorQuery` docs maja wyjasniac, ze `max_samples` jest tylko dla vector-only passes i ze surface shader wymaga complete mapping.
- [ ] `field_point_count_matches_current_domain` nie moze samodzielnie udawac pelnej kompatybilnosci przez magnetic node count. Ma zwracac status typu `FullDomain | MagneticCountOnly | Incompatible`, zeby endpoint mogl fail-closed.

Testy:

- [ ] `field_vector_endpoint_full_domain_includes_topology_metadata`
- [ ] `field_vector_endpoint_scoped_object_includes_node_indices_in_scope_order`
- [ ] `field_vector_endpoint_sampled_includes_sampled_node_indices`
- [ ] `field_vector_endpoint_rejects_magnetic_only_count_without_source_indices`
- [ ] `field_vector_endpoint_cache_key_changes_when_topology_hash_changes`
- [ ] `field_resolution_distinguishes_magnetic_count_only_from_full_domain`

Weryfikacja:

```bash
cargo test -p fullmag-api field_vector_endpoint_full_domain_includes_topology_metadata -- --exact
cargo test -p fullmag-api field_vector_endpoint_scoped_object_includes_node_indices_in_scope_order -- --exact
cargo test -p fullmag-api field_vector_endpoint_rejects_magnetic_only_count_without_source_indices -- --exact
pnpm --dir apps/control-room generate:api
```

Po `generate:api` sprawdzic, ze `apps/control-room/src/kernel/api/generated/openapi-v2.json` nie ma rozmiaru 0 bajtow i opis endpointu mowi o FMVP v3.

---

## 9. Etap 4 - frontend API facade i resource cache

Pliki:

- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- `apps/control-room/src/kernel/api/binaryDecodePayload.ts`
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.ts`

Zadania:

- [ ] Upewnic sie, ze field-vector binary decode idzie przez centralny API/facade i nie ma component-level `fetch()`.
- [ ] Dopisac `fieldVector.domainGenerationId`, `meshTopologyHash`, `indexing`, `nodeIndices` do resource state, ktory trafia do viewport render modelu.
- [ ] `viewport3DTargetFieldBufferCanServeSurface` ma wymagac `indexing=full_domain` albo `explicit_node_indices` z coverage targetu; `sampled_node_indices` jest zawsze rejected dla shader surface.
- [ ] `viewport3DTargetFieldBufferCanServeVectors` moze przyjac `sampled_node_indices`, ale tylko jesli `nodeIndices` istnieje.
- [ ] Target field buffer id ma zawierac `meshTopologyHash` i `indexing`, nie tylko field/topology revision.
- [ ] Realtime eventy pozostaja invalidation-only. WebSocket nie przenosi field/topology binary payloadow.

Testy:

- [ ] `viewport3DTargetFieldBuffer rejects sampled payload for surface shader`
- [ ] `viewport3DTargetFieldBuffer accepts sampled payload for vector glyphs with node indices`
- [ ] `viewport3DTargetFieldBuffer rejects node-index payload without topology hash`
- [ ] `viewport3dResources passes FMVP v3 metadata into render model`

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- --run viewport3DTargetFieldBuffer
pnpm --dir apps/control-room test -- --run viewport3dResources
pnpm --dir apps/control-room run check:api-hygiene
```

---

## 10. Etap 5 - render model: usuniecie implicit index reconstruction

Pliki:

- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- `apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts`
- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`
- `apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.test.ts`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargetDiagnostics.ts`

Zadania:

- [ ] Zastapic `buildMagneticFieldNodeIndices(topology, pointCount)` helperem `resolveFieldVectorNodeIndexMap(fieldVector, topology)`.
- [ ] `resolveFieldVectorNodeIndexMap` ma zwracac:
  - full-domain identity resolver tylko przy `pointCount == topology.nodeCount` i zgodnym `meshTopologyHash`;
  - explicit resolver tylko przy `fieldVector.nodeIndices.length == fieldVector.pointCount` i indeksach w zakresie topologii;
  - degradation dla `legacy_count_only`, braku hash, mismatch hash, out-of-range node index, duplicate node index w surface pass.
- [ ] Usunac sorted-node reconstruction jako produkcyjny fallback. Jesli helper zostaje dla diagnostyki, musi byc nazwany `buildDiagnosticSortedMagneticNodeGuess` i nie moze karmic surface/vector renderingu.
- [ ] `buildCachedPartVertexScalarColors` ma uzywac `fieldVector.nodeIndices`, a nie `buildNodeSelectionIndices(partModel.part, topology)` jako prawdy payloadu.
- [ ] `buildScopedPartFieldValueResolver` ma przyjmowac `nodeIndices` z payloadu; stride reconstruction ma zostac usuniety z production path.
- [ ] `buildVertexScalarColors` ma odrzucac `fieldVector.pointCount < vertexCount` dla unmapped surface path. Mapped path idzie przez `buildMappedVertexScalarColors`.
- [ ] `ScalarColorBuffer` ma zawsze dostawac `topologyRevision` i najlepiej `topologyHash` w build result.
- [ ] Diagnostyki targetu maja odroznic: `missing-node-index-map`, `topology-hash-mismatch`, `sampled-payload-for-surface`, `legacy-count-only-field`, `node-index-out-of-range`.

Testy:

- [ ] `buildViewport3DFieldRenderModel rejects magnetic-only legacy count-only field for surface`
- [ ] `buildViewport3DFieldRenderModel maps magnetic-only field by explicit node indices`
- [ ] `buildViewport3DFieldRenderModel rejects topology hash mismatch`
- [ ] `buildViewport3DFieldRenderModel maps scoped object field using payload node order`
- [ ] `buildViewport3DFieldRenderModel maps sampled vector glyphs using payload indices`
- [ ] `buildVertexScalarColors rejects shorter unmapped field vectors`
- [ ] `buildMappedVertexScalarColors still supports explicit node map`

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- --run viewport3dRenderModel
pnpm --dir apps/control-room test -- --run viewport3dFieldMapping
pnpm --dir apps/control-room test -- --run viewport3DTargetDiagnostics
```

---

## 11. Etap 6 - scalar color retention i GPU upload safety

Pliki:

- `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.test.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.ts`
- `apps/control-room/src/modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts`

Zadania:

- [ ] Rozszerzyc `resolveRetainedMeshPartScalarColors` o `topologyRevision` i `topologyHash`.
- [ ] `scalarColorBufferMatchesRetainedSettings` musi wymagac zgodnosci `buffer.topologyRevision` i, gdy jest dostepny, `buffer.topologyHash`.
- [ ] `scalarColorRetentionKey` musi zawierac `topology=${topologyRevision}` i `hash=${topologyHash}` dla field colors i mesh-quality colors.
- [ ] `useEffect` w `MeshPartLayer` musi czyscic `retainedScalarColorsRef.current` na zmianie topology revision/hash, nawet gdy `nodeCount` zostaje taki sam.
- [ ] GPU upload `targetRevision` ma zawierac field plus topology identity dla scalar field color buffers, aby stary texture upload nie zostal uznany za trafienie.
- [ ] Zachowac anti-flicker tylko dla field updates na tej samej topologii.

Testy:

- [ ] `resolveRetainedMeshPartScalarColors does not retain across topology revision change`
- [ ] `resolveRetainedMeshPartScalarColors retains across field replacement on same topology`
- [ ] `MeshPartLayer retention key includes topology revision and hash`
- [ ] `useViewport3DScalarColorUpload drops previous texture after topology targetRevision change`

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- --run MeshPartLayer
pnpm --dir apps/control-room test -- --run useViewport3DScalarColorUpload
pnpm --dir apps/control-room test -- --run useViewport3DChunkedScalarColors
```

---

## 12. Etap 7 - OpenAPI/spec/docs synchronizacja

Pliki:

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/adr/0011-resource-first-api.md`
- `docs/specs/frontend-v2/25-viewport-3d-field-data-architecture.md`
- `docs/specs/frontend-v2/05-viewport-architecture.md`
- `docs/specs/frontend-v2/14-viewport-3d-module.md`
- `crates/fullmag-api/src/schemas/fields.rs`
- `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`

Zadania:

- [ ] Zaktualizowac API spec: field vector endpoint opisuje FMVP v3, topology hash headers, node-index section i zasady surface/vector eligibility.
- [ ] Zaktualizowac ADR 0011: "Binary protocols FMVP v2" zastapic opisem wersjonowanego FMVP v2/v3 i kompatybilnoscia.
- [ ] Zaktualizowac viewport field-data architecture: payload complete/sampled ma jawne `indexing` i `nodeIndices`; sampled surface jest rejected.
- [ ] Wygenerowac OpenAPI/types/client.
- [ ] Sprawdzic, ze frontend nie recznie sklada nowych endpoint stringow poza `ControlRoomApi`.

Weryfikacja:

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room run check:api-hygiene
pnpm --dir apps/control-room typecheck
```

---

## 13. Etap 8 - regresje end-to-end dla sciezek A, B, C

Zadania:

- [ ] Dodac backend fixture: same-count topology replacement, w ktorym element connectivity lub node ordering sie zmienia, a field revision zostaje ten sam. Oczekiwany efekt: topology revision/hash zmienia sie, stale field nie jest compatible.
- [ ] Dodac frontend fixture: FMVP v3 explicit node indices w permutowanej kolejnosc, renderer przypisuje kolory zgodnie z payload order, nie global sorted order.
- [ ] Dodac frontend fixture: scoped object payload ma `nodeIndices=[4,2,7]`; surface color i vector resolver uzywaja tej kolejnosc.
- [ ] Dodac frontend fixture: sampled payload z `nodeIndices` jest legalny dla vector glyphs i rejected dla surface shader.
- [ ] Dodac mixed-target smoke scenario, ktory weryfikuje visible surface color po zmianie topology hash bez node count change.

Pliki testowe:

- `crates/fullmag-api/src/router_v2/tests.rs`
- `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts`
- `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`
- `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts`
- `apps/control-room/scripts/smoke-viewport-3d-mixed-targets.mjs`

Weryfikacja:

```bash
cargo test -p fullmag-api same_count_topology -- --nocapture
pnpm --dir apps/control-room test -- --run viewport3dResources
pnpm --dir apps/control-room test -- --run viewport3dRenderModel
pnpm --dir apps/control-room test -- --run viewport3DFieldDataPlan
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d-mixed-targets
```

---

## 14. Etap 9 - Path D: range diagnostics dla `H_ex` i outlierow

Ten etap zaczyna sie dopiero po przejsciu etapow 1-8. Nie wolno uzyc range smoothing jako obejscia bledow indeksowania.

Zadania:

- [ ] Dodac do `ScalarColorBuffer` diagnostyczne statystyki range: `min`, `max`, `mean`, `p01`, `p99`, `finiteCount`, `nonFiniteCount`, `zeroCount`.
- [ ] Dla `H_ex` i `H_eff` zapisac w diagnostics, czy range jest zdominowany przez outlier: np. `abs(max) > 50 * max(abs(p99), epsilon)`.
- [ ] Dodac target diagnostic `range-outlier-dominated` bez zmiany domyslnej palety.
- [ ] Jezeli produktowo potrzebny jest robust auto range, dodac jawny tryb `auto_robust` w visualization state, nie zmieniac cicho istniejacego `auto`.
- [ ] Dodac test z gladkim polem plus jednym outlierem: renderer ma pokazac diagnostyke range, ale nie moze zmienic node mapping.

Weryfikacja:

```bash
pnpm --dir apps/control-room test -- --run viewport3dFieldMapping
pnpm --dir apps/control-room test -- --run viewport3DTargetDiagnostics
```

---

## 15. Etap 10 - FEM exchange runtime proof

Pliki:

- `justfile`
- `tests/fem_exchange_validation/sinusoidal_mode.py`
- `tests/fem_exchange_validation/helpers.py`
- `tests/fem_exchange_validation/test_acceptance.py`
- `docs/physics/fem_exchange.md`
- `backends/fem/tests/exchange_contract.cpp`

Zadania:

- [ ] Dodac recepture `verify-fem-exchange-runtime` w `justfile`.
- [ ] Receptura musi wykonac `just ensure-managed-fem-runtime` przed walidacja.
- [ ] Receptura musi uruchamiac Python entrypoint `tests/fem_exchange_validation/sinusoidal_mode.py` w srodowisku, w ktorym `fullmag._core._native_core` jest dostepny. Jesli obecny managed runtime nie eksportuje importowalnego PyO3 bridge dla repo Python, dodac wrapper w `scripts/verify_fem_exchange_runtime.sh`, ktory ustawia wymagane `PYTHONPATH`, `LD_LIBRARY_PATH`/runtime paths z `.fullmag/runtimes/fem-gpu-host/manifest.json`.
- [ ] Receptura zapisuje `tests/fem_exchange_validation/results/sinusoidal_mode.csv` i failuje na nie-finite metrics, brak konwergencji energii, `h_ex_rel_error >= 25%`, `exchange_energy_rel_error >= 8%`.
- [ ] Dodac runtime case dla nonmagnetic-node mask: nonmagnetic nodes w `H_ex` i payloadzie wizualizacyjnym maja byc zero/masked i jawnie indeksowane.
- [ ] Dodac periodic-node projection case z gladkim mode, jezeli aktualna infrastruktura runtime pozwala zbudowac periodic FEM mesh przez publiczny DSL. Jesli nie pozwala, dopisac najpierw test kontraktowy w `backends/fem/tests/exchange_contract.cpp`, a runtime periodic proof zapisac jako osobna faze zależna od DSL periodic mesh support.
- [ ] Zaktualizowac `docs/physics/fem_exchange.md`, aby finalne komendy walidacyjne dla native FEM wskazywaly `just verify-fem-exchange-runtime`, a host `cmake` zostal opisany jako diagnostyka, nie final proof.

Weryfikacja:

```bash
just verify-fem-exchange-runtime
just ensure-managed-fem-runtime
```

Oczekiwane dowody:

- CSV istnieje: `tests/fem_exchange_validation/results/sinusoidal_mode.csv`.
- Console output zawiera `PASS: finest energy relative error below`.
- `docs/physics/fem_exchange.md` cytuje managed `just` route.
- Brak zmian w znaku lub prefaktorze `H_ex = -2 M^-1 K_A m / (mu0 Ms)` bez nowego failing proof.

---

## 16. Etap 11 - browser smoke i lifecycle gates

Wymagania lifecycle:

- topology rebuild i field-buffer update pozostaja rozdzielone;
- field value update nie przebudowuje Three.js geometry;
- topology revision/hash change zwalnia geometrie i derived buffers;
- render loop pozostaje demand-driven;
- brak nowych WebGL zasobow w React state;
- module unmount zwalnia worker/texture/buffer resources.

Uruchomienie lokalne:

```bash
pnpm --dir apps/control-room exec next dev --webpack -p 3100
```

Jesli port albo lock sa stale, uzyc app launcher:

```bash
pnpm --dir apps/control-room dev:binary -- --port 3100
```

Smoke bez backend session:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SCREENSHOT_SCENES=fdm CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room screenshot:viewport-3d
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Smoke po uruchomieniu FEM session:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace pnpm --dir apps/control-room smoke:viewport-3d
CONTROL_ROOM_URL=http://localhost:3100/workspace pnpm --dir apps/control-room smoke:viewport-3d-mixed-targets
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
pnpm --dir apps/control-room audit:idle-performance
```

Akceptacja:

- canvas jest widoczny;
- WebGL context nie jest lost;
- drawing buffer ma niezerowy rozmiar;
- screenshot nie jest blank;
- mieszane targety nie tworza dodatkowego canvas;
- zmiana pola nie powoduje rebuild topology geometry;
- zmiana topology hash usuwa stare scalar colors.

---

## 17. Kolejnosc wdrozenia

1. Etap 0: RED tests i reconciliation.
2. Etap 1: topology fingerprint.
3. Etap 2: FMVP v3 serializer/dekoder.
4. Etap 3: backend field endpoint i OpenAPI.
5. Etap 4: API facade/resource propagation.
6. Etap 5: render model fail-closed mapping.
7. Etap 6: retention/upload safety.
8. Etap 7: specs/docs generation.
9. Etap 8: end-to-end regressions A/B/C.
10. Etap 10: managed FEM exchange proof.
11. Etap 9: Path D range diagnostics.
12. Etap 11: final browser/lifecycle gates.

Etap 9 jest po etapie 10 tylko dlatego, ze range diagnostics nie moze maskowac bledow indeksowania ani nieudowodnionych watpliwosci exchange.

---

## 18. Finalny zestaw komend przed zamknieciem

```bash
cargo test -p fullmag-runner fem_mesh_topology_fingerprint -- --nocapture
cargo test -p fullmag-api
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room audit:idle-performance
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SCREENSHOT_SCENES=fdm CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room screenshot:viewport-3d
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
just verify-fem-exchange-runtime
```

Nie raportowac "done", jezeli dowodem jest tylko diff albo czesc testow. Jezeli managed FEM runtime proof nie moze zostac uruchomiony z powodu brakujacego importowalnego PyO3 bridge, zamknac implementacje jako zablokowana na tym konkretnym warunku i dolaczyc output z `require_native_runtime_core()`.

