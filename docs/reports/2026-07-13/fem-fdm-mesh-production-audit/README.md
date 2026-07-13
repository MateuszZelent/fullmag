# Produkcyjny audyt tworzenia meshu FEM/FDM, PBC, UI i Inspectorów

**Data:** 2026-07-13
**Rewizja audytowana:** `7b3a4db6cd09be61d5c697ea0916ee13debdcd5e`
**Gałąź:** `master`
**Charakter pracy:** audyt read-only; kod produktu nie był modyfikowany
**Zakres:** Python DSL, ProblemIR, planner, voxelizacja FDM, generator/import/remesh FEM,
runtime CPU/CUDA, artefakty i provenance, API v2, Control Room, Explorer, Inspector,
viewport, regiony obiektowe i materiałowe, ich wpływ na rebuild/remesh,
Inspectory regionów oraz bramki produkcyjne
**Rozszerzenie PBC:** zgodność siatki lustrzanej na okresowych ścianach, pełne klasy
równoważności krawędzi i narożników, transfery okresowe oraz fizyczna walidacja
primitive-cell kontra supercell

## Werdykt

**NO-GO dla deklaracji produkcyjnej.** Audyt potwierdził 60 niezależnych problemów
źródłowych: 23 klasy P0, 35 klasy P1 i 2 klasy P2. Najgroźniejsze ścieżki mogą:

- zmienić geometrię bez błędu podczas importu elementów 3D innych niż liniowy tet4;
- uruchomić różną fizykę PBC na CPU, CUDA `double` i CUDA `single`;
- zaakceptować siatkę jako okresową bez dowodu lustrzanego dopasowania ścian;
- zgubić PBC podczas remeshu, auto-coarseningu lub transferu;
- pokazać w UI status, Inspector lub artefakt nieodpowiadający bieżącej rewizji;
- przejść bramkę meshingu bez managed native FEM runtime i bez browser/WebGL smoke;
- eksportować lub odtwarzać model bez kanonicznego `ProblemIR.pbc`.
- pozostawić stary mesh jako current po zmianie kształtu, realizacji lub polityki
  meshowania regionu;
- po remeshu przypisać współczynniki regionu conformal do nieaktualnego albo
  ponownie użytego numeru markera;
- zaakceptować okresowy seam, na którego lustrzanych stronach regiony lub
  elementowe pola materiałowe nie są zgodne.

Audyt nie stwierdza, że każda siatka jest błędna. Stwierdza, że aktualne kontrakty
nie potrafią fail-closed odróżnić wszystkich siatek i realizacji poprawnych od
niepoprawnych. Zielone testy warstwowe nie zamykają tej luki.

## Kontrakt PBC używany w audycie

Siatka lustrzana PBC nie oznacza jedynie podobnych położeń węzłów. Dla każdej
osi okresowej wymagane są łącznie:

1. dokładny okres domeny `L_i = N_i d_i` w FDM albo jawny wektor translacji w FEM;
2. bijekcja węzłów ścian `minus` i `plus` po translacji, z tolerancją zapisaną
   w provenance;
3. bijekcja elementów ścianowych, zgodna topologia, orientacja, normalne i markery;
4. pełne klasy równoważności węzłów ścian, krawędzi i narożników dla wielu osi;
5. zachowanie certyfikatu przez import, remesh, auto-coarsening i transfer pól;
6. jawna faza Blocha dla problemów spektralnych i faza zerowa dla statycznego PBC;
7. dowód fizyczny: primitive cell musi zgadzać się z odpowiednią supercell w
   granicach opublikowanych tolerancji.

Docelowym słownikiem jest istniejący kontrakt `periodic_mesh_certificate.v6` z
[`04_mesh_periodic_floquet_airbox.md`](../../../plans/active/fd_sovler_masterplan/04_mesh_periodic_floquet_airbox.md),
nie nowa równoległa rodzina certyfikatów.

## Macierz problemów i planów naprawczych

| ID | Priorytet | Warstwa | Wynik audytu | Plan |
|---|---|---|---|---|
| MESH-FDM-001 | P0 | planner/FDM | iloczyny `nx*ny*nz` używają `u32` bez checked arithmetic i limitu pamięci | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fdm-001-grid-budget-and-overflow-implementation-plan.md) |
| MESH-FDM-002 | P1 | DSL/voxelizer | oś walca może zostać zredukowana do założenia osiowego | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fdm-002-cylinder-axis-implementation-plan.md) |
| MESH-FDM-003 | P0 | DSL/voxelizer | `Difference` gubi translacje operandów i odejmuje narzędzie tylko w XY | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fdm-003-boolean-difference-implementation-plan.md) |
| MESH-FDM-004 | P0 | DSL/IR/planner | publiczne `per_magnet` jest niezgodne z wymaganym `cell` i ignorowane w single-grid | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fdm-004-per-magnet-realization-implementation-plan.md) |
| MESH-FDM-005 | P1 | IR/planner/runtime | origin siatki jest tracony lub rekonstruowany poza jednym kontraktem | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fdm-005-origin-propagation-implementation-plan.md) |
| MESH-FDM-006 | P1 | planner/FDM | top-level `Translate` jest usuwane w single-grid | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fdm-006-top-level-translation-implementation-plan.md) |
| MESH-FDM-007 | P1 | IR/planner/artifacts | brak jednego `FdmGridCertificate` dla origin, extent, counts, budget i hash | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fdm-007-grid-certificate-implementation-plan.md) |
| MESH-FEM-001 | P0 | importer FEM | elementy 3D inne niż liniowy tet4 mogą zostać cicho obcięte do czterech węzłów | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fem-001-gmsh-element-import-implementation-plan.md) |
| MESH-FEM-002 | P0 | builder/planner | produkcyjne wejścia wywołują `validate()`, omijając `validate_strict()` | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fem-002-strict-validation-implementation-plan.md) |
| MESH-FEM-003 | P1 | report/artifacts | `MeshBuildReport` jest gubiony przed końcem przepływu | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fem-003-build-report-preservation-implementation-plan.md) |
| MESH-FEM-004 | P1 | airbox/certificate | marker granicy airboxu nie jest częścią certyfikatu produkcyjnego | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fem-004-airbox-marker-certificate-implementation-plan.md) |
| MESH-FEM-005 | P1 | public meshing API | lista `MeshOperation` jest authorowana, ale pipeline jej nie wykonuje | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fem-005-mesh-operation-execution-implementation-plan.md) |
| MESH-FEM-006 | P1 | adaptive workflow | adaptivity jest heurystyczna, relaxation-only i zastępuje eigenfrequency energy proxy | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fem-006-adaptivity-semantics-implementation-plan.md) |
| MESH-FEM-007 | P1 | remesh lifecycle | remesh nie zachowuje atomowo reportów, markerów, map materiałów i transferu | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-fem-007-remesh-lifecycle-implementation-plan.md) |
| MESH-REGION-001 | P0 | API/lifecycle | mutacje regionu nie oznaczają meshu dirty i nie zmieniają mesh signature | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-001-region-mutation-dirty-lifecycle-implementation-plan.md) |
| MESH-REGION-002 | P0 | FEM/remesh | shared remesh nie odtwarza conformal region markers i może użyć starych markerów | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-002-conformal-marker-remesh-implementation-plan.md) |
| MESH-REGION-003 | P0 | FEM/adaptivity | adaptivity i auto-coarsen nie zachowują regionów conformal ani ich PBC identity | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-003-adaptive-region-preservation-implementation-plan.md) |
| MESH-REGION-004 | P0 | FEM/PBC | brak certyfikacji lustrzanej zgodności regionów i elementowych pól materiałowych na seam | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-004-mirrored-pbc-region-certificate-implementation-plan.md) |
| MESH-REGION-005 | P1 | FEM/generator | regionowe `minimum_element_size` staje się globalne, a `order` jest ignorowane | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-005-local-mesh-policy-fidelity-implementation-plan.md) |
| MESH-REGION-006 | P1 | IR/provenance | mapa object-region marker nie jest związana z generacją i topology hash meshu | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-006-marker-generation-provenance-implementation-plan.md) |
| MESH-REGION-007 | P1 | FDM/planner | object-frame region i pola materiałowe gubią transform właściciela | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-007-fdm-owner-transform-implementation-plan.md) |
| MESH-REGION-008 | P0 | FDM/CUDA | 256. aktywny region może indeksować poza 256-elementową exchange LUT | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-008-fdm-region-lut-bounds-implementation-plan.md) |
| MESH-REGION-009 | P1 | planner/CUDA | regionowe pola FDM są odrzucane dopiero podczas startu CUDA | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-009-cuda-region-capability-implementation-plan.md) |
| MESH-REGION-010 | P1 | IR/planner | `conflict_policy` i remisy priority nie mają deterministycznej end-to-end semantyki | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-010-overlap-conflict-semantics-implementation-plan.md) |
| MESH-REGION-011 | P1 | runtime/resources | brak osobnych rewizji grid/topology, membership, coefficients i initial state | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-011-realization-revisions-implementation-plan.md) |
| MESH-REGION-012 | P0 | API/data plane | membership/quality może projektować nowy region na stary mesh FEM bez stale identity | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-012-membership-mesh-identity-implementation-plan.md) |
| MESH-REGION-013 | P1 | realtime/UI cache | mutacje i mesh build nie unieważniają membership ani region quality | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-013-region-resource-invalidation-implementation-plan.md) |
| MESH-REGION-014 | P1 | Inspector/Explorer | Region Mesh nie ma `Apply & Build`, a status opisuje deklarację zamiast realizacji | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-014-region-mesh-inspector-lifecycle-implementation-plan.md) |
| MESH-REGION-015 | P1 | FDM/API/artifacts | brak realized cell membership oraz stabilnej legendy region ID w planie i artefaktach | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-015-fdm-membership-provenance-implementation-plan.md) |
| MESH-REGION-016 | P2 | FDM/cache | metadata-only zmiana regionu niepotrzebnie ponownie voxelizuje grid asset | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-016-fdm-cache-partition-implementation-plan.md) |
| MESH-REGION-017 | P2 | Inspector | panel geometrii regionu pokazuje `Radius` także dla Box | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-region-017-shape-specific-inspector-fields-implementation-plan.md) |
| MESH-PBC-FEM-001 | P0 | physics validation | bramka M5 primitive-cell kontra supercell pozostaje otwarta | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fem-001-m5-physical-validation-implementation-plan.md) |
| MESH-PBC-FEM-002 | P0 | IR/planner certificate | pre-solver checks nie dowodzą bijekcji ścian, domen, normalnych i corner closure | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fem-002-presolver-certificate-implementation-plan.md) |
| MESH-PBC-FEM-003 | P0 | runtime artifacts | writer syntetyzuje `normal_dot=-1` i paruje ściany nearest-centroid | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fem-003-artifact-face-pairs-implementation-plan.md) |
| MESH-PBC-FEM-004 | P1 | constraint assembly | brak dowodu domknięcia edge/corner i komutowania translacji | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fem-004-edge-corner-closure-implementation-plan.md) |
| MESH-PBC-FEM-005 | P1 | Gmsh generator | `setPeriodic` nie jest niezależnie certyfikowane po ekstrakcji | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fem-005-gmsh-post-extraction-certificate-implementation-plan.md) |
| MESH-PBC-FEM-006 | P1 | remesh | nowa topologia nie wymusza nowego PBC certificate powiązanego z topology hash | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fem-006-remesh-recertification-implementation-plan.md) |
| MESH-PBC-FDM-001 | P0 | CPU/CUDA demag | `pbc.demag=open` ma rozbieżne znaczenie między realizacjami | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fdm-001-open-demag-semantics-implementation-plan.md) |
| MESH-PBC-FDM-002 | P0 | CUDA exchange | kernel `single` ignoruje PBC obsługiwane przez `double` | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fdm-002-fp32-exchange-implementation-plan.md) |
| MESH-PBC-FDM-003 | P0 | multilayer CPU/CUDA | multilayer wykonuje otwarte demag/exchange mimo żądania PBC | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fdm-003-multilayer-pbc-implementation-plan.md) |
| MESH-PBC-FDM-004 | P0 | CUDA boundary correction | T0/T1 są wybierane przed periodic-aware kernelem i nie dostają flag PBC | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fdm-004-t0-t1-exchange-implementation-plan.md) |
| MESH-PBC-FDM-005 | P1 | planner/resources | `image_counts` nie mają limitu kosztu, overflow ani resolved kernel provenance | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fdm-005-periodic-image-budget-implementation-plan.md) |
| MESH-PBC-FDM-006 | P1 | artifacts/provenance | plan i artefakty nie zachowują origin i pełnego resolved FFT/PBC contract | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fdm-006-pbc-provenance-implementation-plan.md) |
| MESH-PBC-FDM-007 | P1 | field transfer | interpolation clampuje source indices zamiast zawijać je na osiach okresowych | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-pbc-fdm-007-periodic-field-transfer-implementation-plan.md) |
| MESH-API-001 | P0 | PBC diagnostics | `valid` ignoruje unpaired counts, a mixed magnetic-air pairs są błędnie klasyfikowane | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-api-001-periodic-validation-status-implementation-plan.md) |
| MESH-API-002 | P0 | face diagnostics | API rekonstruuje face pairs nearest-centroid bez residual/topology proof | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-api-002-face-pair-diagnostics-implementation-plan.md) |
| MESH-API-003 | P1 | OpenAPI/data plane | schema traci node pairs, aggregate status, mixed-domain i topology hash | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-api-003-periodic-schema-fidelity-implementation-plan.md) |
| MESH-API-004 | P1 | HTTP cache | ETag nie obejmuje zawartości i fingerprintu certyfikatu | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-api-004-certificate-etag-implementation-plan.md) |
| MESH-UI-001 | P0 | authoring/export | UI nie authoruje i nie round-tripuje kanonicznego PBC/periodic mesh do Pythona | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-001-canonical-pbc-authoring-export-implementation-plan.md) |
| MESH-UI-002 | P0 | Inspector PBC | backend emituje `valid`, a Inspectory uznają tylko `ready` | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-002-inspector-status-contract-implementation-plan.md) |
| MESH-UI-003 | P1 | command lifecycle | UI zwraca `completed` bez oczekiwania na terminalny build resource | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-003-command-lifecycle-implementation-plan.md) |
| MESH-UI-004 | P1 | editor/capabilities | menu meshu jest statyczne i nie oferuje kompletnego FDM/FEM/PBC editor | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-004-mesh-editor-capabilities-implementation-plan.md) |
| MESH-UI-005 | P1 | cache invalidation | accepted command unieważnia zasoby syntetycznym ID zamiast mesh revision | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-005-authoritative-invalidation-implementation-plan.md) |
| MESH-UI-006 | P1 | viewport | brak overlay source/destination faces, links, arrows i unpaired topology | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-006-periodic-viewport-overlay-implementation-plan.md) |
| MESH-UI-007 | P1 | Explorer/Inspector | PBC inspection jest ograniczone do frequency-domain stage panels | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-007-cross-workflow-pbc-inspector-implementation-plan.md) |
| MESH-UI-008 | P1 | spectral authoring | wavevector jest przenoszony jako surowa wartość bez pełnej walidacji Blocha/PBC mesh | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-ui-008-spectral-bc-validation-implementation-plan.md) |
| MESH-GATE-001 | P0 | production gate | gate meshingu nie dowodzi managed native FEM runtime ani viewportu | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-gate-001-managed-runtime-browser-gate-implementation-plan.md) |
| MESH-GATE-002 | P1 | validation matrix | testy nie obejmują corrupt faces, corners, FP32, T0/T1, multilayer, remesh i M5 | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-gate-002-pbc-test-matrix-implementation-plan.md) |
| MESH-GATE-003 | P1 | example reproducibility | periodic-antidot ma dwa znane failures i zależy od environment overrides | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-gate-003-periodic-antidot-reproducibility-implementation-plan.md) |
| MESH-GATE-004 | P1 | repo hygiene | bramki architektury i lint nie były zielone w audytowanym snapshotcie | [plan](../../../plans/active/fem-fdm-mesh-production-remediation-2026-07-13/mesh-gate-004-architecture-lint-closure-implementation-plan.md) |

## Dowody szczegółowe

### FDM: geometria i realizacja siatki

- **MESH-FDM-001:** `crates/fullmag-plan/src/geometry.rs:274-404` mnoży wymiary
  jako `u32`; `crates/fullmag-plan/src/fdm.rs:512` nie wprowadza jednego checked
  cell/memory budget przed alokacją.
- **MESH-FDM-002:** Python eksportuje `Cylinder.axis`
  (`packages/fullmag-py/src/fullmag/model/geometry.py:203-236`), lecz
  `GeometryEntryIR::Cylinder` nie ma osi (`crates/fullmag-ir/src/model.rs:51-55`),
  a voxelizer tworzy cylinder Z.
- **MESH-FDM-003:** `crates/fullmag-plan/src/geometry.rs:384-462` gubi zagnieżdżone
  translacje `Difference` i testuje narzędzie w XY bez ograniczenia wysokością.
- **MESH-FDM-004:** Python dopuszcza `default_cell=None` z `per_magnet`, podczas
  gdy Rust wymaga `cell`; single-grid używa `fdm.cell` zamiast magnet override.
- **MESH-FDM-005:** single-grid wylicza `native_origin`, ale `FdmPlanIR`
  (`crates/fullmag-ir/src/plan.rs:72-104`) go nie przechowuje.
- **MESH-FDM-006:** `ir_to_shape(Translate)` usuwa translację w single-grid
  (`crates/fullmag-plan/src/geometry.rs:116`), mimo że multilayer ma osobną ścieżkę.
- **MESH-FDM-007:** `validate_realized_grid()` poprawnie odrzuca istotny rozjazd
  extent/cell. Brak dotyczy innej własności: nie ma jednego certyfikatu zawierającego
  checked count, requested/realized extent, origin, active count, memory i grid hash.

### FDM: PBC i parytet backendów

- **MESH-PBC-FDM-001:** CPU reference rozróżnia semantykę open/periodic w
  `crates/fullmag-runner/src/fdm/cpu/reference.rs`, natomiast konstrukcja CUDA w
  `crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs` nie materializuje
  równoważnego wyboru. `open` nie może znaczyć czegoś innego per backend.
- **MESH-PBC-FDM-002:** `backends/fdm/gpu/cuda/interactions/exchange_fp32.cu` nie ma
  kompletnej obsługi wrap indices obecnej w `exchange_fp64.cu`.
- **MESH-PBC-FDM-003:** CPU multilayer demag
  (`crates/fullmag-runner/src/fdm/cpu/multilayer_reference/demag.rs`), CUDA
  multilayer (`crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`) i
  `multilayer_exchange.cu` nie konsumują pełnego resolved PBC.
- **MESH-PBC-FDM-004:** warianty `exchange_t0_fp64.cu` i `exchange_t1_fp64.cu`
  są dispatchowane przed standardowym kernelem i nie otrzymują flag PBC.
- **MESH-PBC-FDM-005:** truncated-image demag przyjmuje liczbę obrazów bez globalnego
  limitu pamięci/czasu i bez policzalnego kosztu w plannerze.
- **MESH-PBC-FDM-006:** artefakty FDM w `crates/fullmag-runner/src/artifacts.rs` i
  `crates/fullmag-runner/src/fdm/artifacts.rs` nie zapisują razem żądania, wyniku
  resolution, origin, okresów, obrazów, FFT/kernel/padding i identity siatki.
- **MESH-PBC-FDM-007:** interpolation w
  `crates/fullmag-fdm-demag/src/transfer.rs:180-182,358-360` używa `clamp` dla
  wszystkich osi; transfer na okresowym seam nie zawija source indices.

### FEM: import, build i PBC lustrzane

- **MESH-FEM-001:** importer Gmsh może pobrać pierwsze cztery indeksy z elementu
  3D, zamiast odrzucić nieobsługiwany typ. To cicha korupcja topologii; jedyne
  legalne zachowania to pełna konwersja z dowodem lub fail-closed.
- **MESH-FEM-002:** strict validation jest dostępne, ale nie jest obowiązkowym
  etapem każdej ścieżki build/import/remesh/planner.
- **MESH-FEM-003:** `MeshBuildReport` istnieje w pakiecie Python, lecz nie ma
  gwarancji zachowania do artefaktu, API, Inspector i provenance sesji.
- **MESH-FEM-004:** certyfikat nie wymaga kompletności i rozłączności markerów
  magnetic boundary, airbox interface i outer airbox boundary.
- **MESH-FEM-005:** publiczne `MeshOperation` występuje w authoring/export, lecz
  lista `operations` nie ma konsumenta wykonawczego w pipeline `fullmag/meshing`.
- **MESH-FEM-006:** auto-adaptivity w orchestratorze jest relaxation-only;
  `eigenfrequency_delta` zostaje zastąpione energy proxy bez równoważnego kontraktu.
- **MESH-FEM-007:** remesh rozprasza preservation build report, marker universe,
  material maps, state transfer i invalidation między kilka ścieżek.
- **MESH-PBC-FEM-001:** `docs/physics/0800-fem-static-pbc-demag.md` jawnie pozostawia
  M5 otwarte. Wcześniejszy wąski dowód CPU nie zamyka pełnej primitive/supercell
  walidacji wspieranych backendów i konfiguracji airboxu.
- **MESH-PBC-FEM-002:** MeshIR/planner sprawdzają pary, translację i osie, ale nie
  pełne pokrycie, face bijection, normalne, podział magnetic/air i corner closure.
- **MESH-PBC-FEM-003:** `crates/fullmag-runner/src/artifacts.rs:1834-1901`
  fabrykuje normalną na podstawie osi i paruje nearest-centroid bez dowodu vertex set.
- **MESH-PBC-FEM-004:** union-find w `backends/fem/core/fem_mesh.cpp` nie publikuje
  dowodu domknięcia klas edge/corner ani komutowania translacji wieloosiowych.
- **MESH-PBC-FEM-005:** Gmsh OCC wybiera przeciwległe surfaces i wywołuje
  `setPeriodic`, ale po ekstrakcji brak niezależnej certyfikacji face topology.
- **MESH-PBC-FEM-006:** remesh nie traktuje certyfikatu powiązanego z nowym
  topology hash jako obowiązkowego wyniku każdej zmiany topologii.

### Regiony: wpływ na mesh, materiały i PBC

- **MESH-REGION-001:** create/patch/delete/duplicate/reorder regionów w
  `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs:2794-3021` nie
  wywołuje `mark_object_mesh_dirty`. `scene_mesh_signature()` w
  `crates/fullmag-api/src/main.rs:3472-3489` pomija `object.regions`, chociaż
  pipeline FEM konsumuje ich shape, realization i mesh policy. Test transakcji
  API utrwala obecnie brak `mesh:dirty`.
- **MESH-REGION-002:** request shared remesh w
  `crates/fullmag-cli/src/python_bridge.rs:959-975` i
  `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py:565-593` nie przekazuje
  `object_regions`. Odpowiedź i commit remeshu nie zastępują
  `object_region_markers`; stara mapa może zatem wskazać marker o ponownie użytym
  numerze i przypisać `Ms/Aex` do niewłaściwych elementów.
- **MESH-REGION-003:** adaptive follow-up i auto-coarsen w
  `crates/fullmag-cli/src/orchestrator.rs:3394-3783,5744-5830` używają tego samego
  niepełnego remeshu, a transfer stanu nie certyfikuje region membership ani PBC.
- **MESH-REGION-004:** Gmsh wykonuje periodic linking po OCC fragmentation, lecz
  nie istnieje preflight zgodności lustrzanych regionów. Ogólna ścieżka FEM
  sprawdza pola nodal, ale nie klasy elementów ani DG0 `Ms/A` po obu stronach
  seam. Certyfikat musi wiązać topology hash, region markers, periodic pairs i
  material realization.
- **MESH-REGION-005:** `_size_field_plan.py:1187-1256,1565-1601` publikuje
  regionowe minimum i order, lecz minimum jest redukowane do globalnego `hmin`,
  a `_gmsh_fields.py:133-150` wymusza globalnie P1. Unsupported musi być
  fail-closed zamiast raportowane jako applied.
- **MESH-REGION-006:** Pythonowy build report niesie `object_region_markers`, ale
  `FemSharedDomainBuildReportIR` ich nie zachowuje. Walidacja assetu nie wiąże
  właściciela i markera z topology digest konkretnej generacji.
- **MESH-REGION-007:** single-grid FDM ustawia `position_object = position_world`
  w `crates/fullmag-plan/src/fdm.rs:42-50`, a `Translate` traci offset w
  `crates/fullmag-plan/src/geometry.rs:104-116`. Przesunięty owner może więc mieć
  maskę, texture i pola materiałowe w złym miejscu.
- **MESH-REGION-008:** planner nadaje aktywnym regionom ID `1..N`, natomiast CUDA
  exchange ABI ma 256 wpisów na wymiar i kernel indeksuje LUT bez walidacji
  maksymalnej wartości maski. ID 256 wychodzi poza zakres `0..255`.
- **MESH-REGION-009:** planner materializuje regionowe `Ms/Aex/Alpha` także dla
  żądania CUDA, a `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs:437-444`
  odrzuca je dopiero przy uruchomieniu. Capability resolution powinno blokować
  konfigurację przed utworzeniem planu wykonawczego.
- **MESH-REGION-010:** maska FDM rozstrzyga remis `(priority, region_id)` przez
  późniejsze nadpisanie, natomiast publiczne wartości `conflict_policy` nie
  sterują resolverem konsekwentnie. Wynik overlapu texture/topology nie jest
  jawny ani stabilny semantycznie.
- **MESH-REGION-011:** jedna ogólna scene revision nie rozróżnia zmian metadata,
  membership, coefficient fields, initial state i grid/topology. Skutkiem jest
  jednocześnie brak wymaganej invalidacji i kosztowne invalidacje zbędne.
- **MESH-REGION-012:** membership handler w
  `crates/fullmag-api/src/router_v2/handlers/data/mesh_region_membership.rs:29-191`
  łączy bieżącą scenę z dostępnym `snapshot.fem_mesh` bez porównania source scene
  revision/topology fingerprint. DTO nie publikuje `current|stale` ani identity.
- **MESH-REGION-013:** websocket scene event i lokalna invalidacja panelu nie
  obejmują membership/region-quality; mesh-build completion również nie usuwa
  tych cache keys. Zielony test `regionAuthoringInvalidation.test.ts` utrwala
  obecnie ten brak.
- **MESH-REGION-014:** `ObjectRegionMeshPanel.tsx` zapisuje politykę wspólnym
  `Apply Region`, bez wzorca `Apply & Build` używanego przez object mesh. Explorer
  ustala badge z deklarowanej policy, nie z marker certificate/build generation.
- **MESH-REGION-015:** realized membership endpoint wymaga FEM mesh; FDM viewport
  pokazuje jedynie authored overlay. `FdmPlanIR` i artefakty nie publikują
  stabilnej legendy `region_id <-> u32`, więc maski i zmiany numeracji nie są
  reprodukowalne ani inspekowalne.
- **MESH-REGION-016:** pełne `object_regions` wchodzą do klucza cache assetu FDM,
  chociaż voxelizer gridu ich nie używa. Rename, texture lub material edit może
  ponownie zbudować identyczny grid.
- **MESH-REGION-017:** `ObjectRegionGeometryPanel.tsx:92-99` renderuje pole Radius
  również dla Box, przez co Inspector sugeruje parametr bez znaczenia dla shape.

#### Macierz wymaganej reakcji na mutację regionu

| Mutacja | FDM | FEM | PBC i dane zależne |
|---|---|---|---|
| nazwa/opis | tylko scene revision | tylko scene revision | bez remesh; zachować identity |
| materiał smooth/project | coefficient rematerialization | coefficient rematerialization | results stale; mesh pozostaje current |
| sharp conformal bez zmiany granicy | cell fields | DG0 rematerialization przy aktualnym marker certificate | certyfikat markera musi pasować do topology hash |
| shape/frame/owner/enable regionu | maska, pola, texture i solver context; bez nowego gridu | pełny remesh dla conformal | nowe markery, pairs, certificate, state transfer |
| priority/reorder/conflict policy | maska i fields po jawnej walidacji konfliktów | ownership/material realization; remesh jeśli zmienia conformal partition | dependent results stale |
| `max/min/transition/order` mesh policy | unsupported i fail-closed | remesh; `order` fail-closed do czasu obsługi | ponowna recertyfikacja PBC |
| zmiana owner geometry/cell/universe | pełny grid i wszystkie realizacje regionów | pełny mesh i realizacje | nowe identity/certyfikaty |
| remesh/adaptivity/auto-coarsen | nie dotyczy regionowego local refinement | atomowe odtworzenie markerów i transfer | nowe PBC pairs/certificate przed runem |
| zmiana osi/wektora/tolerancji PBC | solver/boundary rebuild | nowe constraints | region-aware mirror certificate |

### API, UI, Inspectory i bramki

- **MESH-API-001:** handler `periodic_pairs` w
  `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs` może klasyfikować
  resource jako `valid` mimo unpaired counts i zaliczać mixed magnetic-air do magnetic.
- **MESH-API-002:** ten sam handler rekonstruuje face pairs nearest-centroid bez
  limitu residualu i nie publikuje unpaired face counts ani face residual.
- **MESH-API-003:** `crates/fullmag-api/src/schemas/mesh.rs` nie niesie node pairs,
  aggregate validation status, mixed-domain count, unpaired faces ani topology hash.
- **MESH-API-004:** ETag składa się z source ID, mesh revision i liczby par, ale
  nie z certificate/topology fingerprint ani zawartości residuali.
- **MESH-UI-001:** `crates/fullmag-authoring/src/scene.rs`, builder, komendy API i
  Ribbon nie tworzą jednego przepływu `UI -> ProblemIR.pbc -> canonical Python`;
  eksport jest w części interfejsu wyłączony.
- **MESH-UI-002:** backend publikuje `valid`, a dwa Inspectory uznają tylko
  `ready`; fixture testowe utrwalają sztuczny status zamiast wygenerowanego enumu.
- **MESH-UI-003:** command contribution zwraca `completed` po samym `accepted`,
  przed terminalnym statusem build i nową mesh revision.
- **MESH-UI-004:** statyczne menu nie rozwiązuje metod/rozmiarów/PBC z capability
  matrix i nie stanowi pełnego edytora FDM grid/FEM mesh/PBC.
- **MESH-UI-005:** accepted command emituje syntetyczne invalidation oparte o
  command ID/timestamp zamiast authoritative mesh revision.
- **MESH-UI-006:** unified viewport nie pokazuje source/destination faces, links,
  translation arrows, residuali, klas edge/corner ani unpaired topology.
- **MESH-UI-007:** PBC inspection istnieje głównie w panelach eigen/response;
  static/time-domain i authored `ProblemIR.pbc` nie mają równoważnego Inspectora.
- **MESH-UI-008:** authoring przechowuje `eigen_k_vector` jako surowe pole, a
  `StudyStageAuthoringModel` przepisuje wartości bez pełnego dowodu jednostek,
  skończoności, aktywnych osi i zgodności z periodic mesh certificate.
- **MESH-GATE-001:** `just verify-fem-meshing-production` deleguje do skryptu
  głównie warstwy Python/kontraktów; nie dowodzi managed native FEM runtime ani
  widocznego, aktualnego mesh/certificate w browserze.
- **MESH-GATE-002:** macierz nie obejmuje corrupt face topology, corner closure,
  FP32, T0/T1, multilayer PBC, remesh recertification i strict M5.
- **MESH-GATE-003:** periodic-antidot ma dwa znane failures: environment overrides
  zmieniają fixture, a preconditioner/restart rozmija się z kontraktem przykładu.
- **MESH-GATE-004:** w audytowanym przebiegu architecture hygiene nie było zielone,
  a lint zakończył się ostrzeżeniem. Nie są to dowody błędu fizycznego, ale
  uniemożliwiają uczciwe zamknięcie zero-tolerance gate.

## Wykonana weryfikacja

| Bramka | Wynik | Zakres dowodu |
|---|---|---|
| testy Rust meshing | 41 PASS | lokalne kontrakty siatki |
| testy planowania FDM | 24 PASS | istniejące przypadki planner/geometry |
| testy Python meshing | 32 PASS | publiczne generatory i helpery objęte suite |
| testy ProblemIR periodic | 6 PASS | lowering/validation istniejącego PBC |
| testy planner PBC | 5 PASS | aktualne reguły legalności |
| testy engine periodic | 18 PASS | constraints/guardrails/benchmark objęte suite |
| testy API periodic pairs | 2 PASS | bieżąca odpowiedź handlera |
| testy Python periodic meshing | 3 PASS | helpery okresowego meshingu |
| focused Control Room | 428 PASS | resource/UI modele objęte wyborem testów |
| pełny Control Room Vitest | 2871 PASS w 314 plikach | szeroka regresja frontendowa |
| focused planner object regions | 10 PASS | lowering, fail-closed legality i CPU materialization istniejących przypadków |
| focused Python conformal/mesh-policy regions | 3 PASS | OCC conformal i build-report przypadki objęte wyborem |
| focused region UI/Explorer/viewport | 54 PASS w 4 plikach | bieżące modele; część testów utrwala brak invalidacji |
| API region authoring transaction | 1 PASS | potwierdza bieżący CRUD, w tym błędny brak `mesh:dirty` |
| `pnpm --dir apps/control-room typecheck` | PASS | typy frontendu |
| API hygiene | PASS | wygenerowany HTTP OpenAPI i typed access path |
| architecture hygiene | FAIL | bramka repo nie była zielona |
| lint | FAIL przez 1 warning | zero-warning gate niezamknięte |
| periodic-antidot example | 2 FAIL | przykład nie potwierdził deklarowanego PBC |
| managed `verify-fem-meshing-production` | przerwany | brak końcowego dowodu managed/native/browser |
| M5 primitive/supercell | nieuruchomione ponownie; znany stan negatywny | brak podstawy do promocji |

PASS oznacza wyłącznie zakres danej bramki. Nie unieważnia statycznego dowodu,
że bramka nie obejmuje potrzebnej własności.

## Ograniczenia i stan worktree

- Audyt powstał na współdzielonym, brudnym worktree. Istniejące modyfikacje w
  `backends/fem/*`, testach FEM i `justfile` nie należą do audytu i nie zostały
  zmienione ani ukryte.
- Pełny managed gate został przerwany; raport nie przedstawia rozpoczętego lub
  częściowo zielonego przebiegu jako dowodu produkcyjnego.
- M5 wymaga kosztownego runtime i zapisanych artefaktów. Stan pozostaje otwarty,
  dopóki promocyjny gate nie wygeneruje i nie zweryfikuje evidence bundle.
- Audyt obejmuje bieżący snapshot. Każdy plan wymaga ponownego odczytania plików
  przed implementacją, ponieważ aktywny worktree może ewoluować.
- Zielone testy regionów nie stanowią dowodu poprawnego lifecycle. Dwa testy i
  browser smoke jawnie oczekują zachowania meshu jako current po region edit;
  muszą zostać odwrócone w fazie RED planu MESH-REGION-001/013/014.

## Kolejność napraw i warunek wyjścia

1. Najpierw naprawić kontrakty fail-closed: import FEM, dokładny grid FDM,
   region mutation classifier, bezpieczne limity region ID,
   `periodic_mesh_certificate.v6`, capability legality i canonical PBC semantics.
2. Następnie zamknąć backend parity: CPU/CUDA, single/double, single-grid/multilayer,
   transformy i maski regionów, transfery, conformal remesh i pełne equivalence classes.
3. Potem propagować jeden kontrakt przez artifacts, OpenAPI, typed client,
   resource hooks, Explorer, Inspectory, viewport i canonical Python export.
4. Na końcu uruchomić managed native runtime, M5 primitive/supercell oraz realny
   browser/WebGL smoke na tym samym zestawie artefaktów.

Status może zmienić się na produkcyjny dopiero po zamknięciu wszystkich P0/P1,
zielonych bramkach zero-warning i zapisaniu artefaktów pokazujących requested oraz
resolved execution reality. Same testy jednostkowe nie spełniają tego warunku.
