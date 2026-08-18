# Airbox i mesh counts — plan naprawy kontraktu

> **Dla agentów:** implementuj zadania inline w tej sesji; każdy etap ma własny cykl RED → GREEN → weryfikacja.

**Cel:** ujednolicić liczenie węzłów/elementów Airboxa i wielu obiektów między backendem FEM, API v2, Inspectorami oraz budżetem wektorów.

**Architektura:** logiczny target `airbox` agreguje wszystkie fizyczne części FEM z `role="air"`; jawny `scope_id` części pozostaje zakresem tej jednej części. Manifest shared-domain publikuje typowane globalne counts. Frontend deduplikuje węzły i traktuje prawidłowe zakresy `node_start/node_count` jako dokładne.

**Technologie:** Rust/Axum/OpenAPI v2, TypeScript/React, Vitest, Cargo test, pnpm.

## Ograniczenia globalne

- HTTP v2 pozostaje źródłem prawdy; nie dodawać bezpośredniego transportu w komponentach.
- Nie zmieniać ani nie nadpisywać istniejących cudzych zmian w checkoutcie.
- FDM pozostaje kontraktem komórek, FEM kontraktem węzłów/elementów.
- Węzły współdzielone raportować osobno; `node_count` Airboxa oznacza unikalne węzły logicznego targetu, nie wyłączną pamięć Airboxa.
- Nie commitować zmian bez osobnego żądania użytkownika.

---

### Zadanie 1: Backendowy agregat FEM Airbox scope

**Pliki:**
- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:3190-3245, 3650-3710`
- Test: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs:8390+`
- Dokumentacja: `docs/specs/resource-first-control-room-api-v2.md:794-810`
- Regenerowane: `apps/control-room/src/kernel/api/generated/openapi-v2.json`, `openapi-v2-types.ts`, `openapi-v2-client.ts` tylko jeśli zmieni się opis OpenAPI.

**Kontrakt:**
- `scope_kind=airbox` bez `scope_id` albo z `scope_id=airbox` wybiera wszystkie `mesh_parts` z rolą `air`.
- `scope_kind=airbox&scope_id=<part-id>` wybiera dokładnie jedną część.
- Agregat scala `node_indices`, sortuje i deduplikuje; filtruje węzły magnetyczne tak jak dotychczas.
- Agregat ma stabilne `ResolvedFieldScope.id = "airbox"`; jawna część zachowuje własne id.
- `selection` dla `universe-airbox` korzysta z tego samego agregatu.

- [ ] RED: dodać test z `airbox-a` i `airbox-b`, żądaniem `scope_id=airbox`, oczekiwanymi połączonymi indeksami oraz test zachowania jawnego `airbox-b`.
- [ ] Uruchomić test i potwierdzić porażkę, bo obecna implementacja wybiera pierwszy carrier.
- [ ] GREEN: wyodrębnić helper `resolve_airbox_scope(mesh, geometry_scope, requested_scope_id)` i podłączyć go do `resolve_field_scope` oraz `resolve_selection_scope`.
- [ ] Uruchomić testy helpera i routera.

### Zadanie 2: Typowane globalne counts manifestu

**Pliki:**
- Modyfikuj: `crates/fullmag-api/src/schemas/mesh.rs:1035-1088`
- Modyfikuj: `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs:1925-1990`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/mesh-details/useMeshDetailsModel.ts`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/mesh-details/MeshOverviewSection.tsx`
- Testy: `apps/control-room/src/modules/inspector/panels/mesh-details/useMeshDetailsModel.test.ts`, `MeshDetailsPanel.lane.test.tsx`, `crates/fullmag-api/src/router_v2/tests.rs`

**Interfejs:** dodać opcjonalny, kompatybilny wstecznie obiekt manifestu:

```rust
pub struct MeshTopologyCountsResource {
    pub node_count: u32,
    pub element_count: u32,
    pub boundary_face_count: u32,
}
```

`MeshSharedDomainManifestResource.topology_counts` backend wylicza z materializowanego payloadu (`nodes.len()`, `cell_count()`, `facet_count()`), a UI używa go jako jedynego źródła dla `Counts And Extents`. Przejściowe `mesh_summary` pozostaje tylko fallbackiem „unavailable”, nie autorytetem dla scoped counts.

- [ ] RED: dodać test API, który sprawdza `topology_counts` w manifeście, oraz test UI, który preferuje manifest nad `mesh_summary` z kluczami `nodes/elements`.
- [ ] Uruchomić testy i potwierdzić porażkę.
- [ ] GREEN: dodać typ Rust, pole manifestu, populację i typy UI; zregenerować OpenAPI v2.
- [ ] Dodać etykietę źródła `shared-domain manifest` i zachować `not available`, gdy manifest counts nie istnieją.

### Zadanie 3: Dokładne zakresy FEM dla wielu obiektów

**Pliki:**
- Modyfikuj: `apps/control-room/src/kernel/visualization/visualizationVectorCapacity.ts:529-564`
- Test: `apps/control-room/src/modules/viewport-3d/model/visualizationVectorCapacity.test.ts:375-420`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts:3230-3340`

**Kontrakt:**

```ts
const fullExact = parts.every(
  (part) => Boolean(part.node_indices?.length) || hasValidNodeRange(part),
);
```

Prawidłowy `node_start/node_count` opisuje pełny ciągły zakres i jest dokładny; wiele zakresów łączy się przez istniejące deduplikowanie indeksów. Surface nadal wymaga jawnych `surface_node_indices` lub `surface_faces`.

- [ ] RED: zmienić test na dwa nachodzące, range-only parts i oczekiwać `fullExact=true`, dokładnej unii oraz budżetu zamiast unknown.
- [ ] Uruchomić test i potwierdzić porażkę.
- [ ] GREEN: dodać mały walidator bez alokacji dodatkowej tablicy i ustawić `fullExact` według zakresów.
- [ ] Dodać przypadek nieprawidłowego zakresu, który pozostaje fail-closed.

### Zadanie 4: Spójność Inspectorów Airboxa

**Pliki:**
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshInspectorModel.ts`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/airbox/AirboxOverviewPanel.tsx`
- Modyfikuj: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshTopologyPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/airbox/airboxMeshInspectorModel.test.ts`, `apps/control-room/src/modules/inspector/panels/ScopedMeshQualityPanels.test.tsx`

`buildAirboxMeshInspectorModel` ma agregować wszystkie air parts: unia węzłów, suma elementów i boundary faces z jawnie oznaczonym zakresem. Panel ma pokazywać `Unique Airbox nodes`, `Airbox carriers` oraz istniejące `Shared interface nodes`; topology panel ma sygnalizować agregat, gdy jest więcej niż jeden carrier.

- [ ] RED: dodać fixture dwóch air parts z nakładającymi się indeksami i oczekiwać unii oraz sumy elementów.
- [ ] Uruchomić test i potwierdzić porażkę.
- [ ] GREEN: dodać helper agregujący i użyć go we wszystkich trzech panelach.
- [ ] Uruchomić testy DOM i modelu.

### Zadanie 5: Regeneracja, bramki i kwalifikacja

- [ ] Uruchomić `pnpm --dir apps/control-room generate:api` po zmianie schematu.
- [ ] Uruchomić celowane Vitesty backend/frontend dla wszystkich czterech zadań.
- [ ] Uruchomić `pnpm --dir apps/control-room typecheck` i targeted ESLint dla zmienionych plików.
- [ ] Uruchomić `npx react-doctor@latest --verbose --scope changed` i sprawdzić brak regresji score.
- [ ] Uruchomić odpowiednią receptę `just` dla testów API/meshingu po inspekcji `justfile`; hostowy Cargo nie jest dowodem runtime FEM.
- [ ] Wykonać browser smoke dla aktywnego workspace: jeden Airbox, wiele części Airboxa, dwa obiekty FEM oraz FDM z powtarzającym się `region_id` i różnymi ownerami.
- [ ] Sprawdzić `git diff` i potwierdzić, że zmiany dotyczą wyłącznie tego celu.

## Kryteria akceptacji

1. Domyślny FEM Airbox scope nigdy nie wybiera cicho pierwszej części, gdy istnieje wiele `role="air"`.
2. Jawny scope pojedynczej części działa bez zmiany semantyki.
3. Licznik Airboxa jest unią węzłów, a nie pierwszym `node_count`.
4. Licznik obiektu FEM jest dokładny dla explicit indices i prawidłowych zakresów, a niepoprawne dane pozostają fail-closed.
5. Globalne counts Mesh Details pochodzą z typowanego manifestu.
6. OpenAPI, generated types/client, frontend resources i backend testy są zgodne.
7. Wszystkie bramki weryfikacyjne mają świeże, odczytane wyniki.
