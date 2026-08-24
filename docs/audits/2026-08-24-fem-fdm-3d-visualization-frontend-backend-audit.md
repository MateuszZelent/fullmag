# Audyt frontendu wizualizacji 3D FEM/FDM i kontraktów backend–frontend

**Projekt:** Fullmag
**Data audytu:** 2026-08-24
**Audytowana rewizja źródeł:** [`5dd9414da76ae0ce3081204cffea39137db6951d`](https://github.com/MateuszZelent/fullmag/tree/5dd9414da76ae0ce3081204cffea39137db6951d)
**Zakres:** Control Room, API v2, transport pól, targety i carriery FEM/FDM, Airbox, quantities oraz stan interaktywny po zakończeniu etapu solvera
**Rodzaj audytu:** statyczna analiza kodu i kontraktów. Raport nie deklaruje wykonania managed FEM, browser/WebGL fixture ani testów runtime dla wskazanego SHA.

---

## 1. Werdykt

Rdzeń wizualizacji 3D ma poprawną, bliską produkcyjnej architekturę. Fullmag rozdziela quantity, scope, target, carrier, generation, revision oraz renderer adoption. Payload nie jest przyjmowany tylko dlatego, że ma odpowiednią długość: FMVP v3 przenosi scope i identity, a frontend sprawdza zgodność nośnika, topologii oraz sesji.

Nie należy jednak kwalifikować całego zakresu FEM/FDM 3D jako bezwarunkowo gotowego produkcyjnie. Pozostają dwa blokery o znaczeniu release:

1. Capability quantity nie jest jeszcze pojedynczym źródłem prawdy aż do konkretnego carriera. Frontend nadal ma ręczne mapy metadata, a część ścieżek Airboxa używa ogólnego `domain=full_domain`.
2. `master` nie jest chroniony i nie wymaga żadnych status checks, mimo że repozytorium definiuje wymagane bramki 3D.

### Ocena obszarów

| Obszar | Ocena | Wniosek |
|---|---|---|
| Target/carrier architecture | dobra | semantyczny target jest oddzielony od technicznego nośnika |
| FEM Airbox i obiekty | dobra z luką | Airbox jest osobny, ale wiele mesh parts jednego obiektu jest agregowanych |
| FDM single-grid | dobra | magnetic support i outside-support są rozróżnione przez membership |
| FDM multilayer | bardzo dobra | native layers i target-only Airbox są osobnymi nośnikami; common FFT grid nie jest geometrią |
| Quantity contracts | dobra, niepełny parytet | 52 kanoniczne ID, ale wykonanie zależy od backendu, engine i planu |
| Binary field plane | dobra | v3 jest rygorystyczne; legacy v2 osłabia identity po remeshu |
| Post-stage interactive mode | poprawny, z odrębnym cold-path dla shared-air | provider shared-air pozostaje immutable terminal snapshot; jawna komenda `compute_fields` może uruchomić rekonstrukcję bez retained operator cache |
| CI/release governance | niewystarczająca | branch protection i required checks są wyłączone |

### Klasyfikacja

- P0: 0
- P1: 5
- P2: 9
- P3: 2

---

## 2. Przepływ backend–frontend

```mermaid
flowchart LR
    Q[fullmag-quantities: 52 IDs] --> R[runner lane filter]
    R --> QC[quantity catalog + resolved capability]
    R --> FC[field catalog + materialization]
    UI[target settings] --> DP[3D demand planner]
    QC --> DP
    FC --> DP
    DP --> REQ[field-vector: quantity + scope + identity]
    REQ --> API[API v2]
    API --> FMVP[FMVP v3 + FMMI]
    FMVP --> DEC[strict decoder]
    DEC --> BUF[target field buffer]
    BUF --> MAP[target/carrier mapping]
    MAP --> REN[WebGL renderer]
    REN --> ACK[renderer adoption]
    ACK --> INS[Inspector: Ready, Live, Stale, Unavailable]
```

Poprawnym kontraktem nie jest samo `quantity_id`. Dla przestrzennej wizualizacji minimalna identity powinna obejmować:

```text
session_epoch
quantity_id
component lub complex view
scope_kind
scope_id
carrier_id lub carrier fingerprint
domain_generation
topology_revision lub topology hash
indexing
field_revision
```

Obecna ścieżka v3 w dużej mierze to zapewnia. Ważną zaletą jest też to, że backend nie deklaruje renderer adoption. Backend może udowodnić capability, materialization i gotowość payloadu; dopiero viewport może potwierdzić, że konkretny bufor został faktycznie użyty.

---

## 3. FEM: Airbox, obiekty i części siatki

`manifestRenderableCarriers.ts` traktuje rzeczywiste `mesh_parts` jako field-capable carriery. `object_segments` są wyłącznie diagnostycznym fallbackiem, jeżeli nie istnieje potwierdzony nośnik. Jest to poprawne zachowanie fail-closed.

`buildSemanticRenderTargetCatalog()` w `semanticRenderTargetCatalog.ts` buduje targety:

- `airbox`;
- `object:<object_id>`;
- `part:<part_id>`;
- regiony nie należą do tego katalogu; `resolveViewport3DRegionTargetByPartId()` i
  `resolveViewport3DRegionTargetsForMembershipOwnerParts()` w
  `useViewport3DSceneModel.ts` składają osobne targety `region:<...>`.

Część o roli Airboxa trafia do logicznego targetu `airbox`. Część przypisana do obiektu sceny trafia do targetu obiektu. Nieprzypisana część pozostaje targetem `part`. W efekcie Airbox i obiekty mają niezależne visibility, wireframe, points, bounds, vectors i active quantity.

### Luka: wiele części jednego obiektu

Jeżeli kilka carrierów mapuje się na ten sam obiekt, są agregowane pod jednym `object:<id>`. To jest wygodne dla prostego obiektu, lecz nie daje pełnego zarządzania każdym fragmentem siatki. Docelowo katalog powinien umożliwiać hierarchię:

```text
object:<object_id>
├── part:<mesh_part_a>
├── part:<mesh_part_b>
└── region:<region_id>
```

Ustawienia obiektu powinny być bazą grupową, a part/region opcjonalnym override. Nie wymaga to duplikowania danych: ten sam carrier może być używany przez grupę i subtarget z odpowiednią maską indeksów.

**Ocena FEM:** Airbox–obiekt jest rozdzielony prawidłowo. Pełne object–subpart management jest częściowe.

---

## 4. FDM: single-grid i multilayer

### FDM single-grid

FDM single-grid nie ma Airbox mesh w sensie FEM. Istnieje regularny universe grid oraz membership opisujący aktywne komórki magnetyczne, nieaktywne komórki i obszar poza magnetic support. `domainPresentation.ts` poprawnie nie utożsamia outside-support z FEM shared-domain Airboxem.

Przed publikacją membership frontend może pokazać jedynie konserwatywną obwiednię. Nie powinien udawać dokładnego podziału komórek na podstawie bounding boxów autora. Exact cell ownership musi pochodzić z FMRM/membership.

### FDM multilayer

Multilayer ma bardzo dobrą separację:

- każda native layer ma własny `layer_id`, `object_id`, grid fingerprint, maskę aktywności i rewizję;
- common convolution/transform grid jest jawnie wykluczony jako fizyczna geometria;
- Airbox jest osobnym `target_only` carrierem;
- Airbox ma własne origin, spacing, shape, generation, fingerprint i revision;
- aktualnie certyfikowanym observable Airboxa jest tylko `H_demag`;
- `H_eff` jest dla tego carriera niedostępne;
- payload wymaga FMVP v3, `scope_kind=airbox`, `scope_id=airbox`, zgodnej generation, fingerprintu i jawnych indeksów.

Maski warstw są sprawdzane rygorystycznie. Deklarowana maska nie przechodzi na fallback renderujący wszystkie komórki. Sprawdzane są shape, counts, grid fingerprint, mask hash i layout revision.

### Publiczny Airbox a klasa nośnika

UI kanonizuje różne historyczne identyfikatory do targetu `airbox`. Jest to właściwe dla użytkownika, ale diagnostyka powinna dodatkowo publikować klasę carriera:

```ts
type AirboxCarrierKind =
  | 'fem-shared-domain-part'
  | 'fdm-single-grid-outside-support'
  | 'fdm-multilayer-target-only';
```

Identity payloadu chroni przed bezpośrednim przeciekiem między tymi przypadkami. Jawny `carrier_kind` jest jednak potrzebny do wyjaśnienia różnic capabilities i polityki post-stage.

---

## 5. Kontrakty wszystkich 52 quantities

Kontrakt quantity ma cztery poziomy:

1. canonical descriptor: ID, shape, components, unit, location, domain i preview policy;
2. resolved lane capability: backend, engine, aktywne interakcje i plan;
3. materialization: unmaterialized, pending, complete, stale lub error;
4. target adoption: zgodny target, carrier, scope, generation, revision i renderer buffer.

`QuantityId::as_str()` jest zamrożonym wire formatem. `registry.rs` testuje parytet providerów z katalogiem 52 wpisów. Jest to właściwy fundament.

### Legenda macierzy

- `3D` — quantity jest wystawiona, interaktywna i ma preview 3D;
- `hist.` — global scalar, właściwa ścieżka to historia/tabela;
- `deferred` — canonical, lecz nie jest obecnie live 3D;
- `A` — lane zasadniczo dopuszcza quantity, jeżeli engine/provider ją realizuje;
- `C` — dopuszczona warunkowo przez aktywną fizykę;
- `N` — bieżący spatial-preview gate odrzuca;
- `S` — inna ścieżka, np. scalar history lub analysis overlay.

FDM multilayer jest rozdzielony urządzeniowo: szczegółowa kolumna `FDM-ML CPU` poniżej dotyczy
wyłącznie `CpuReference`. Dla `FDM-ML GPU` każda z 52 pozycji ma status `N`, ponieważ
`snapshot_problem_vector_field_batch()` jawnie odrzuca interaktywny snapshot multilayer dla
każdego engine innego niż `CpuReference`.

| Lane | Zakres quantities | Status spatial preview | Właściciel |
|---|---|---|---|
| FDM-ML CPU | wartości per-row w głównej macierzy | zależny od dokładnego providera | `fdm_multilayer_quantity_is_active` i `select_observables` |
| FDM-ML GPU | wszystkie 52 | N | `snapshot_problem_vector_field_batch` — jawne odrzucenie engine CUDA |

| # | Quantity | Katalog | Domena | FDM CPU | FDM GPU | FDM-ML CPU | FEM CPU | FEM GPU | Uwagi |
|---:|---|---|---|---:|---:|---:|---:|---:|---|
| 1 | `m` | 3D vector | magnetic | A | A | A | A | A | podstawowy carrier |
| 2 | `H_ex` | 3D vector | magnetic | C | C | C | C | C | exchange |
| 3 | `H_demag` | 3D vector | full | C | C | C | C | C | główne pole Airboxa |
| 4 | `H_ext` | 3D vector | full | C | C | C | C | C | external field |
| 5 | `H_ant` | 3D vector | full | C | N | N | N | N | tylko FDM CPU ma bieżący materializator; CUDA FDM, multilayer i native FEM odrzucają |
| 6 | `H_drive` | 3D vector | magnetic | N | N | N | C | C | FDM CPU/GPU i multilayer nie materializują; frontend ma alias `B_drive` |
| 7 | `H_eff` | 3D vector | full | A | A | A | A | A | Airbox support musi być carrier-specific |
| 8 | `torque` | 3D vector | magnetic | A | A | A | A | A | katalog: unit `T` |
| 9 | `H_ani` | 3D vector | magnetic | C | C | C | C | C | anisotropy |
| 10 | `H_dmi` | 3D vector | magnetic | C | N | C | C | C | `CudaSnapshotObservable::from_quantity()` nie obsługuje `H_dmi` |
| 11 | `H_mel` | 3D vector | magnetic | N | N | N | C | C | FDM CPU/GPU i multilayer bez materializatora magnetoelastic |
| 12 | `u` | deferred | full | N | N | N | N | N | mechanika bez live 3D |
| 13 | `eps` | deferred, 6 comp. | full | N | N | N | N | N | shape `VectorField` jest nieprecyzyjny |
| 14 | `sigma` | deferred, 6 comp. | full | N | N | N | N | N | powinien być symmetric tensor |
| 15 | `H_ani_cubic` | 3D vector | magnetic | N | N | C | C | C | multilayer CPU materializuje osobny payload po aktywacji cubic anisotropy; zwykły FDM CPU/GPU nie materializuje |
| 16 | `H_dmi_bulk` | 3D vector | magnetic | N | N | N | C | C | publiczny planner multilayer odrzuca bulk DMI do czasu realizacji naturalnego warunku brzegowego exchange+DMI |
| 17 | `H_oe` | 3D vector | full | C | C | N | C | C | multilayer IR bez Oersteda |
| 18 | `H_therm` | 3D vector | magnetic | N | N | N | C | N | `plan_fem` odrzuca ThermalNoise na FEM GPU przez `CAP-THERM-GPU-001`; obecność kernela nie jest publiczną capability |
| 19 | `E_ex` | hist. | magnetic | S | S | S | S | S | global scalar |
| 20 | `E_demag` | hist. | magnetic | S | S | S | S | S | global scalar |
| 21 | `E_ext` | hist. | full | S | S | S | S | S | global scalar |
| 22 | `E_drive` | hist. | magnetic | N | N | N | N | N | `StepStats.e_drive` istnieje, ale cztery kanoniczne ścieżki scalar API pomijają klucz `e_drive` |
| 23 | `E_ani` | hist. | magnetic | S | S | S | S | S | global scalar |
| 24 | `E_dmi` | hist. | magnetic | S | S | S | S | S | global scalar |
| 25 | `E_el` | hist. deferred | full | N | N | N | N | N | descriptor ma `ui_exposed: false`, a scalar API nie materializuje metryki |
| 26 | `E_kin_el` | hist. deferred | full | N | N | N | N | N | descriptor ma `ui_exposed: false`, a scalar API nie materializuje metryki |
| 27 | `elastic_residual_norm` | hist. deferred | full | N | N | N | N | N | descriptor ma `ui_exposed: false`, a scalar API nie materializuje metryki |
| 28 | `E_total` | hist. | full | S | S | S | S | S | global scalar |
| 29 | `mode_amplitude` | deferred analysis | magnetic | N | N | N | N | N | osobna ścieżka eigen |
| 30 | `mode_real` | deferred analysis | magnetic | N | N | N | N | N | osobna ścieżka eigen |
| 31 | `mode_imag` | deferred analysis | magnetic | N | N | N | N | N | osobna ścieżka eigen |
| 32 | `mode_phase` | deferred analysis | magnetic | N | N | N | N | N | osobna ścieżka eigen |
| 33 | `eden_ex` | 3D scalar | magnetic | C | C | C | C | C | FDM: cell field; native FEM: nodal visualization/conservative tetra projection mimo katalogowej lokalizacji cell |
| 34 | `eden_demag` | 3D scalar | magnetic | C | C | C | C | C | FDM: cell field; native FEM: nodal visualization/conservative tetra projection mimo katalogowej lokalizacji cell |
| 35 | `demag_phi` | deferred scalar | full | N | N | N | N | N | native FEM może liczyć skalar wewnętrznie, ale katalog wyłącza materializację i preview 3D |
| 36 | `eden_ext` | 3D scalar | magnetic | C | C | C | C | C | FDM: cell field; native FEM: nodal visualization/conservative tetra projection mimo katalogowej lokalizacji cell |
| 37 | `eden_drive` | 3D scalar | magnetic | N | N | N | N | N | wewnętrzny arm CUDA istnieje, lecz publiczny `plan_fdm` odrzuca regional drive przez `fdm_cuda_regional_field_drive_unsupported` |
| 38 | `eden_ani` | 3D scalar | magnetic | C | C | C | C | C | FDM: cell field; native FEM: nodal visualization/conservative tetra projection mimo katalogowej lokalizacji cell |
| 39 | `eden_dmi` | 3D scalar | magnetic | C | C | C | C | C | FDM: cell field; native FEM: nodal visualization/conservative tetra projection mimo katalogowej lokalizacji cell |
| 40 | `eden_total` | 3D scalar | magnetic | C | A | A | C | C | native FEM publikuje nodal projection zamiast katalogowego cell field; FDM CPU i native FEM pomijają `eden_drive` przy regional drive |
| 41 | `mat_ms` | 3D scalar | magnetic | A | N | A | N | N | brak CUDA FDM i FEM material field provider |
| 42 | `mat_aex` | 3D scalar | magnetic | A | N | A | N | N | brak CUDA FDM i FEM material field provider |
| 43 | `mat_alpha` | 3D scalar | magnetic | A | N | A | N | N | brak CUDA FDM i FEM material field provider |
| 44 | `mat_dind` | 3D scalar | magnetic | N | N | N | N | N | katalog wyprzedza lane providers |
| 45 | `mat_dbulk` | 3D scalar | magnetic | N | N | N | N | N | katalog wyprzedza lane providers |
| 46 | `dm_dt` | deferred vector | magnetic | N | N | N | N | N | preview flag bez UI exposure |
| 47 | `V_electric` | deferred scalar | full | N | N | N | N | N | brak live 3D providera; ui_exposed, ale preview 3D false |
| 48 | `J_charge` | deferred vector | full | N | N | N | N | N | brak live 3D providera; ui_exposed, ale preview 3D false |
| 49 | `spin_potential` | deferred vector | full | N | N | N | N | N | brak native FEM preview providera i standardowego renderera 3D |
| 50 | `spin_current_tensor` | deferred tensor | full | N | N | N | N | N | brak native FEM preview providera; wymaga jawnej projekcji tensora |
| 51 | `torque_stt` | deferred vector | full | N | N | N | N | N | brak native FEM preview providera; UI i interactive false |
| 52 | `torque_sot` | deferred vector | magnetic | N | N | N | N | N | brak bieżącego lane provider |

### Wnioski quantity

- Katalog jest kompletny semantycznie, ale nie oznacza parytetu backendów. UI musi używać `resolved_capability`.
- FEM nie publikuje obecnie pięciu pól materiałowych: `mat_ms`, `mat_aex`, `mat_alpha`, `mat_dind`, `mat_dbulk`.
- FDM multilayer świadomie ma ograniczony IR i zestaw obserwabli.
- FDM multilayer CPU materializuje `H_ani_cubic` i `H_dmi_bulk`, gdy odpowiadająca fizyka jest aktywna; testy wymagają osobnych, niezerowych payloadów.
- FDM multilayer GPU nie ma ścieżki interactive snapshot; wszystkie quantities są tam `N`, niezależnie od CPU multilayer providerów.
- Native FEM materializuje przestrzenne gęstości energii jako tablice `node_count` z metodą `fem_nodal_visualization_projection` albo `fem_nodal_conservative_tetra_projection`. To warunkowa wizualizacja, nie realizacja katalogowego kontraktu cell-located; provenance i UI muszą ujawniać projekcję.
- `eden_total` w FDM CPU i native FEM nie jest pełnym totalem przy aktywnym regional drive, ponieważ bieżące sumatory pomijają `eden_drive`.
- Transport jest canonical, lecz standardowy renderer 3D nie ma jeszcze pełnej semantyki scalar/vector/tensor dla tych pól.
- `eps` i `sigma` powinny otrzymać `SymmetricTensorField` lub równoważny descriptor przed ekspozycją.
- `B_drive` i skalowanie przez `mu0` powinny być descriptor-driven, a nie zaszyte ręcznie w TypeScript.

---

## 6. Podwójne źródło prawdy quantities

`fullmag-quantities` jest deklarowany jako single source of truth, ale `quantityIds.ts` nadal utrzymuje ręczne:

- canonical aliases;
- scalar-spatial ID set;
- unit map;
- `B_drive -> H_drive`;
- skalowanie przez `mu0`.

Mapy nie pokrywają pełnych 52 ID. Dla aktywnego `eden_drive` na CUDA FDM błąd jest już osiągalny: brak ID w `SCALAR_SPATIAL_QUANTITY_IDS` wybiera kontrolki i kolorowanie wektorowe dla jednoskładnikowego payloadu, a brak wpisu w `QUANTITY_UNITS` daje pustą jednostkę colorbara. Kolejne quantity mogą powtórzyć ten sam defekt.

Docelowo descriptor OpenAPI/TypeScript powinien zawierać ID, aliases, shape, components, unit, domain, location, preview policy, renderer kind i opcjonalny display transform. `quantityIds.ts` powinien ograniczyć się do typowanych helperów, bez niezależnej tabeli prawdy.

---

## 7. Capability Airboxa musi być carrier-specific

`domain=full_domain` oznacza, że quantity może mieć sens poza magnesem. Nie oznacza, że każdy carrier Airboxa ją publikuje.

FDM multilayer jest bezpieczny w rendererze, ponieważ `viewport3DFdmMultilayerAirbox.ts` żąda twardo tylko `H_demag`. Równolegle generic helper `fieldCatalogQuantitySupportsAirbox()` sprawdza przede wszystkim ID i full-domain. Jest używany w planowaniu, zasobach viewportu, Inspectorze i Ribbonie.

Istnieje lepszy `resolveTargetFieldAvailability`, który uwzględnia carrier, scope, generation, revision, materialization i adoption. Docelowo wszystkie listy quantities oraz request plans muszą korzystać z jednego `CarrierQuantityCapability`.

Zalecane pola:

```text
target_id
carrier_id
carrier_kind
quantity_id
components
scope_kind
scope_id
materialization_policy
state
reason_code
generation
revision
```

Legacy full-domain helper należy usunąć po migracji.

---

## 8. Binary field contract

### Mocne strony v3

FMVP v3 sprawdza magic, wersję, nagłówek, alignment, reserved fields, rozmiar payloadu, components, point/value count, indexing, explicit indices, scope, generation i topology fingerprint. Target buffer dodatkowo przechowuje session ID/epoch, consumer IDs, target IDs, completeness i source identity.

### Legacy v2

V2 może dla full-domain opierać część identity na response headers i zaakceptować legacy payload z niepełną generacją/topologią. Po remeshu w tej samej sesji osłabia to gwarancję, że stare pole nie zostanie pokazane na nowej siatce.

Plan migracji:

1. telemetria użycia v2;
2. warning w development;
3. v3-required dla FEM, scoped data, Airbox, multilayer i remesh-capable sessions;
4. usunięcie v2 po migracji fixture.

### Typ danych

Wire payload jest `Float64`. Dla single-precision lane i dużych pól oznacza około dwukrotnie większy transfer/cache niż `Float32` oraz dodatkową konwersję do GPU. Format powinien mieć jawny scalar type `f32` lub `f64`, będący częścią cache identity.

---

## 9. Ustawienia targetów

`ObjectVisualizationController` ma wystarczający model per target: visibility, render mode, wireframe, points, bounds, surface, color source, colormap, projection, vectors, budget i active quantity.

### Potwierdzony błąd leaf reset

`removeSerializedOverrideField()` usuwa cały nested object:

```ts
case 'boundsVisible':
  delete display.bounds;
  break;

case 'pointsVisible':
  delete display.points;
  break;
```

Reset `boundsVisible` może usunąć `bounds.opacity`, a reset `pointsVisible` może usunąć `points.opacity`. Należy usuwać wyłącznie leaf i zachowywać rodzeństwo. Wymagany jest parametryczny test, że reset pola X nie modyfikuje żadnego Y.

Część preferences jest celowo viewport-local i nie jest synchronizowana. UI powinien oznaczać, czy opcja jest local, session-shared, persistent lub reset-on-session.

---

## 10. Tryb interaktywny po zakończeniu etapu

```mermaid
stateDiagram-v2
    [*] --> bootstrapping
    bootstrapping --> running
    running --> running: kolejny etap sekwencji
    running --> paused: pause
    paused --> running: resume
    running --> awaiting_command: etap ukończony
    awaiting_command --> awaiting_command: display lub compute
    awaiting_command --> running: run, relax lub solve
    awaiting_command --> completed: explicit close
    completed --> [*]
```

Orchestrator realizuje podstawowy scenariusz poprawnie:

- interaktywna sesja nie jest zamykana po zakończeniu stage;
- ostatni stage update nie oznacza całej sesji jako finished;
- sekwencja przechodzi bezpośrednio do następnego etapu;
- po ostatnim etapie status session/run/live state staje się `awaiting_command`;
- continuation magnetization jest zachowana;
- `mark_closed()` i `completed` następują dopiero po explicit close.

### Polityka per lane

| Lane | Post-stage provider | Wniosek |
|---|---|---|
| FDM regular | retained runtime | dynamic observation |
| FDM multilayer | deterministic reconstruction | poprawne dla wspieranych pól |
| FEM magnetic-only | retained runtime | dynamic observation |
| FEM shared-air | immutable terminal snapshot | standardowy provider nie rekonstruuje; jawna komenda `compute_fields` uruchamia osobny cold path bez retained operator cache |
| FEM eigen/frequency | unavailable in this runtime | osobna analysis path |

### Shared-air gap

Dla `SharedDomainMeshWithAir` kanoniczne `observation_provider_policy()` zwraca
`ImmutableTerminalSnapshot`, dlatego zwykły provider post-stage nie używa deterministic
reconstruction. Nie blokuje to osobnej, jawnej komendy: `InteractiveRuntimeHost::compute_current_fields()`
przekazuje bieżącą lub continuation magnetization do `snapshot_problem_vector_field_batch()`.
Gałąź FEM tworzy wtedy świeży `NativeFemBackend`, oblicza pola efektywne i materializuje
aktywne żądane quantity jako cold reconstruction niezależne od standardowej provider policy.

Pozostają więc problemy wydajności i UX, nie brak capability:

- retained observation runtime zachowujący mesh, mapowanie DOF, Poisson/demag operator, BC, materiały i ostatnie `m` może usunąć koszt cold-path;
- UI powinno jawnie pokazywać rekonstrukcję jako operację w toku z command ID, scope, generation i field revision;
- warm switching i cache operatorów nie mogą zmieniać wyniku istniejącej ścieżki rekonstrukcji.

Nie wolno prezentować cold reconstruction jako nieskończonego `loading`.

Lifecycle API poprawnie rozdziela solver, session resource, connectivity i commandability. Słabością jest `SolverLifecycle = string`; należy wygenerować wspólny zamknięty enum Rust/OpenAPI/TypeScript.

---

## 11. Cache i adoption

Mocne strony:

- cache jest czyszczony przy zmianie `sessionId + sessionEpoch`;
- inflight binary requests są abortowane;
- last-good payload pozostaje oddzielony od bieżącego statusu;
- częściowy błąd Airboxa nie staje się globalnym `ready`;
- stale payload jest zachowywany tylko przy zgodnej request identity;
- backend ready nie jest utożsamiane z renderer Live.

Te zasady powinny pozostać obowiązkowe. Payload nie może być przyjęty tylko po długości tablicy lub liczbie węzłów.

---

## 12. Monolityczność scene modelu i mesh schemas

`useViewport3DSceneModel.ts` łączy session resources, domain adaptation, branching FEM/FDM/multilayer, demand planning, scalar mapping, vector allocation, selection, overlays, clipping i diagnostics. Jest to ryzyko invalidation, rerenderów i trudnego testowania lane-specific.

Zalecany podział:

```text
useViewport3DSessionFrame
useViewport3DDomainFrame
useFemTargetFrame
useFdmSingleGridTargetFrame
useFdmMultilayerTargetFrame
useViewport3DFieldDemandFrame
useViewport3DScalarFrame
useViewport3DVectorFrame
useViewport3DOverlayFrame
useViewport3DDiagnosticsFrame
```

W `schemas/mesh.rs` część visualization-adjacent metadata pozostaje `serde_json::Value` lub generic maps. Wszystko, co steruje rolą części, renderability, capability, bounds, quality coloring, Airbox semantics i carrier identity, powinno mieć zamknięty schema. Otwarty JSON może pozostać wyłącznie diagnostyczny.

---

## 13. Ustalenia

### F3D-AUD-001 — P2 — FEM shared-air używa kosztownej rekonstrukcji po stage

Sesja przechodzi do `awaiting_command`, a `compute_fields` może policzyć nowe aktywne pole przez świeży `NativeFemBackend`. Brakuje warm switchingu i retained operator cache; wymagany jest test poprawności rekonstrukcji oraz pomiar kosztu cold-path.

### F3D-AUD-002 — P1 — wymagane bramki CI nie są egzekwowane

Branch API raportuje `master` jako `protected: false` z pustą listą required checks. Należy włączyć ruleset i wymagać wszystkich contextów z `frontend-3d-required-check-matrix.md`.

### F3D-AUD-003 — P1 — frontend duplikuje quantity metadata dla latentnego `eden_drive`

Ręczne aliases, units, scalar IDs i display transforms są rozjechane z katalogiem Rust: `eden_drive` nie jest klasyfikowane jako scalar-spatial i po przyszłym udostępnieniu otrzymałoby wektorowe kontrolki/kolorowanie oraz pustą jednostkę colorbara. Nie jest to obecnie osiągalne przez wspierany publiczny CUDA plan, ponieważ regional drive kończy się błędem `fdm_cuda_regional_field_drive_unsupported`. Wymagany jest generated descriptor/parity test dla 52 ID oraz test aktywowany razem z przyszłą promocją capability.

### F3D-AUD-004 — P1 — full-domain jest używane jako przybliżenie Airbox capability

Capability musi być per target/carrier. Renderer multilayer ma dodatkowe zabezpieczenie, ale generic UI i request helpers są rozproszone.

### F3D-AUD-005 — P2 — brak pełnej hierarchii object → parts

Wiele carrierów jednego obiektu jest agregowanych. Wymagane opcjonalne child part targets i dziedziczenie ustawień.

### F3D-AUD-006 — P2 — reset visibility usuwa sibling opacity

Potwierdzony leaf-reset bug w `ObjectVisualizationController.ts`.

### F3D-AUD-007 — P2 — solver lifecycle jest free-form stringiem

Brak compile-time exhaustiveness. Wymagany wspólny enum.

### F3D-AUD-008 — P2 — FMVP v2 osłabia identity po remeshu

V3 powinno być obowiązkowe dla FEM, scoped payloads, Airbox i remesh.

### F3D-AUD-009 — P2 — brak wire-level f32

Jawny scalar type ograniczy transfer i cache w single precision.

### F3D-AUD-010 — P2 — `eps` i `sigma` mają nieprecyzyjny shape

Sześcioskładnikowy tensor Voigta nie powinien być zwykłym VectorField.

### F3D-AUD-011 — P2 — centralny scene hook ma zbyt szeroką odpowiedzialność

Wymagane lane-specific immutable frames.

### F3D-AUD-012 — P2 — część mesh metadata jest luźnym JSON-em

Pola wpływające na rendering muszą być silnie typowane.

### F3D-AUD-013 — P3 — publiczny `airbox` ukrywa różne klasy carrierów

Identity payloadu jest bezpieczne, lecz Inspector powinien pokazywać `carrier_kind` i capability summary.

### F3D-AUD-014 — P3 — równoległe definicje Airbox capability

`resolveFdmMultilayerAirboxFieldAvailability()` i request builder definiują pokrywające się reguły. Należy generować UI capability i request plan z jednego descriptora.

### F3D-AUD-015 — P1 — `E_drive` nie ma kanonicznej ścieżki scalar API

CPU FDM i FEM mogą wytworzyć niezerowe `StepStats.e_drive`, ale `scalar_metric_is_active`,
`scalar_row_metric_value`, `live_step_metric_value` oraz `run_manifest_scalar_value` pomijają
klucz `e_drive`. Quantity pozostaje niedostępne zarówno live, jak i w historii, dopóki wszystkie
cztery ścieżki nie zostaną spięte globalnie i objęte jednym testem materializacji.

### F3D-AUD-016 — P1 — required managed gate nie obejmuje FEM magnetic-only

Workflow `frontend-3d-managed-fem.yml` uruchamia `managed-fem-qualification`, a obecny target
`verify-fem-mixed-prism-airbox-runtime` kwalifikuje wyłącznie scenariusz mixed-prism shared-air
`poisson_robin`. Osobna sesja FEM magnetic-only, jej retained runtime oraz dynamic observation nie
mają wykonanego managed proof artifact. Pełna kwalifikacja pozostaje zablokowana do dodania osobnego
managed przypadku magnetic-only i powiązania jego artefaktu z wymaganym checkiem.

---

## 14. Mocne strony do zachowania

1. Zamrożone canonical quantity IDs.
2. Test parytetu registry z pełnym katalogiem 52 wpisów.
3. Fail-closed lane filters zależne od aktywnej fizyki.
4. Backend nie deklaruje renderer adoption.
5. Inspector odróżnia Ready od Live.
6. FEM object segments bez dowodu nie są field-capable.
7. Common FFT grid nie jest fizyczną warstwą FDM.
8. FDM multilayer Airbox ma osobny scope i fingerprint.
9. Native layer masks nie mają dense fallbacku.
10. Cache jest unieważniany przez session epoch.
11. Inflight requests są abortowane przy zmianie sesji.
12. Partial Airbox failure nie jest raportowany jako pełne ready.
13. Orchestrator nie zamyka sesji po samym zakończeniu stage.
14. Sequence continuation nie przechodzi przedwcześnie do idle.
15. Lifecycle rozdziela commandability od solver state.
16. Repozytorium definiuje required proof matrix i managed FEM workflow.

---

## 15. Plan naprawczy

### Etap 0 — release blockers

1. Włączyć branch protection i required checks.
2. Zastąpić przybliżenie `full_domain` capability kontraktem per target/carrier (F3D-AUD-004).

### Etap 1 — pojedynczy kontrakt quantity/target

1. Usunąć ręczne frontend metadata maps.
2. Wprowadzić carrier-specific quantity capability.
3. Wprowadzić typed lifecycle enum.
4. Dodać parity tests dla wszystkich 52 ID, w tym jawny test `eden_drive` jako scalar-spatial `J/m³` z poprawnym colorbarem i bez kontrolek wektorowych.
5. Naprawić leaf reset `boundsVisible` i `pointsVisible` (F3D-AUD-006).

### Etap 2 — pełna interaktywność

1. Zoptymalizować istniejącą rekonstrukcję FEM shared-air przez retained observation context lub cache operatorów.
2. Dynamic `compute_fields` zwracające command ID, scope, generation i field revision.
3. Quantity selector oparty wyłącznie na capability konkretnego carriera.

### Etap 3 — struktura i wydajność

1. Hierarchia object/part/region.
2. FMVP f32/f64.
3. Rozbicie scene modelu.
4. Typowanie mesh metadata.
5. Symmetric tensor contract.

---

## 16. Minimalne kryteria akceptacji

### Quantity

- [ ] 52 IDs mają dokładnie jeden canonical descriptor i provider registry entry.
- [ ] Frontend nie ma niezależnych units/shape/aliases.
- [ ] Każda quantity ma jawny wynik per lane i per carrier.
- [ ] `eden_drive` używa scalar renderer/controller, publikuje jednostkę `J/m³` i nie pokazuje kontrolek wektorowych.
- [ ] `eps`/`sigma` mają tensor contract przed ekspozycją.
- [ ] `spin_current_tensor` nie trafia do vector3 renderer bez projekcji.

### Identity/remesh

- [ ] payload starej generation jest odrzucany;
- [ ] zgodna liczba węzłów przy innym topology hash jest odrzucana;
- [ ] scoped payload bez scope metadata jest odrzucany;
- [ ] FMVP v2 jest odrzucane w produkcyjnym FEM/remesh/Airbox;
- [ ] last-good nie zmienia `stale` na `ready`.

### FEM

- [ ] obiekt i Airbox mają niezależną widoczność i quantity;
- [ ] part bez field-capable carriera nie żąda pola;
- [ ] Airbox aggregate zachowuje per-part failure state;
- [ ] każda native FEM gęstość energii oznacza nodal projection w provenance i nie jest przedstawiana jako katalogowe cell field;
- [ ] opcjonalnie dwa parts jednego obiektu mają niezależne overrides.

### FDM

- [ ] przed membership jest tylko outline, bez fałszywych filled cells;
- [ ] inactive cells nie dziedziczą magnetyzacji;
- [ ] common FFT grid nie jest renderowany;
- [ ] błędny mask hash blokuje warstwę;
- [ ] multilayer Airbox akceptuje wyłącznie `H_demag`;
- [ ] `H_eff` ma jawne unavailable dla target-only Airbox.

### Interactive runtime

- [ ] FDM regular: stage complete → awaiting_command → nowe pole;
- [ ] FDM multilayer: deterministic reconstruction dla wspieranych pól;
- [ ] FEM magnetic-only: retained runtime;
- [ ] osobny managed FEM magnetic-only uruchamia retained runtime i zapisuje proof artifact związany z dokładnym head SHA;
- [ ] FEM shared-air: rekonstrukcja nowego aktywnego pola kończy się bez nieskończonego spinnera i zachowuje generation identity;
- [ ] następny stage sekwencji nie publikuje przejściowego completed;
- [ ] explicit close tombstonuje session resource;
- [ ] reconnect nie adoptuje payloadu ze starego epoch.

### Settings i CI

- [ ] reset `boundsVisible` zachowuje bounds opacity;
- [ ] reset `pointsVisible` zachowuje point opacity;
- [ ] `master` jest chroniony;
- [ ] wszystkie contexts z macierzy są required;
- [ ] proof bundle zawiera dokładny head SHA;
- [ ] brak managed runnera daje BLOCKED, nie PASS.

---

## 17. Status kwalifikacji audytowanego SHA

Na moment audytu:

- źródła audytu przypięto do `5dd9414da76ae0ce3081204cffea39137db6951d`;
- branch API raportował `protected: false`;
- required status checks były puste;
- zapytanie o PR-triggered workflow runs dla SHA nie zwróciło wyników. Nie dowodzi to braku push-triggered runs;
- managed FEM i browser fixture nie zostały wykonane w ramach tego audytu.

> **ARCHITECTURE REVIEW: PASS WITH FINDINGS**
> **FULL PRODUCTION QUALIFICATION FOR SHA: NOT PROVEN / BLOCKED PENDING REQUIRED CI EVIDENCE**

---

(f3d-audit-problem-statement)=
## 18. Aneks kontraktu publikacyjnego

### Problem badawczy

Audyt sprawdza, czy frontend i backend zachowują jeden, fizycznie uczciwy kontrakt prezentacji trójwymiarowych pól FDM i FEM: od kanonicznego identyfikatora quantity, przez dostępność providera i identity payloadu, po semantyczny target renderera. Aneks nie wprowadza nowej fizyki ani nowej funkcji produktu; porządkuje dowody dla audytowanego kodu.

(f3d-audit-governing-equations)=
### Równania rządzące

Zakres nie zmienia równań mikromagnetycznych. Audyt śledzi pola już zdefiniowane przez kanoniczne noty fizyczne oraz sprawdza, czy warstwa obserwacji nie zmienia ich znaczenia, nośnika ani dziedziny.

(f3d-audit-symbols-and-si-units)=
### Symbole i jednostki SI

Nie zdefiniowano nowych symboli matematycznych. Jednostki każdego pola pochodzą z kanonicznego katalogu quantities; frontend nie może ich nadpisywać niezależną mapą.

(f3d-audit-assumptions-and-validity)=
### Założenia i zakres ważności

Wnioski dotyczą wyłącznie audytowanego SHA i ścieżek wymienionych w mapie źródeł. Statyczny dowód architektury nie zastępuje kwalifikacji na rzeczywistym GPU, zarządzanym runnerze ani testu przeglądarkowego.

(f3d-audit-python-api)=
### Publiczne API Python

Audyt nie zmienia publicznego API Python. Poniższy wykonywalny fragment sprawdza obecność dokumentu i jego sąsiedniej mapy źródeł; nie konstruuje alternatywnego modelu problemu.

```python
# %%
from pathlib import Path

# %%
audit = Path("docs/audits/2026-08-24-fem-fdm-3d-visualization-frontend-backend-audit.md")
source_map = audit.with_suffix(".source-map.json")
assert audit.is_file()
assert source_map.is_file()
```

(f3d-audit-problem-ir)=
### ProblemIR

Audyt nie dodaje ani nie zmienia pól `ProblemIR`. Dostępność wizualizacji musi wynikać z już znormalizowanego problemu, resolved lane i capability konkretnego carriera, a nie z nazwy targetu w UI.

(f3d-audit-round-trip-and-failure-semantics)=
### Round-trip i semantyka błędów

`requested intent` musi pozostać widoczny obok `resolved execution`. `validation errors` muszą zatrzymać niezgodny payload lub target przed renderingiem, a `unsupported combinations` muszą dawać jawne unavailable zamiast ukrytego fallbacku. Eksport i ponowne wczytanie nie mogą zmieniać quantity ID, scope, generation ani topology identity.

(f3d-audit-discrete-realization)=
### Realizacja dyskretna

FDM używa regularnych lub maskowanych carrierów siatki, a FEM carrierów nodalnych i powierzchniowych powiązanych z topologią. Wspólna nazwa quantity nie upoważnia renderera do zamiany tych realizacji ani do zgadywania membership.

(f3d-audit-implementation-mapping)=
### Mapowanie implementacji

Sąsiedni plik `2026-08-24-fem-fdm-3d-visualization-frontend-backend-audit.source-map.json` wiąże każde krytyczne twierdzenie z niezmiennym SHA, ścieżką i deklaracją źródłową. Tabela poniżej jest czytelnym indeksem tego samego mapowania.

(f3d-audit-validation)=
### Walidacja

Walidacja obejmuje parser dokumentacji naukowej, rozwiązywanie wszystkich symboli mapy źródeł
względem bieżącego checkoutu oraz bramki wyszczególnione w sekcji 16. Pole
`audited_source_revision` i niezmienne odsyłacze przypinają historyczny zakres twierdzeń, ale obecny
walidator nie odczytuje treści źródeł z tego obiektu Git. Wynik statyczny nie jest przedstawiany jako
dowód wykonania testów sprzętowych.

(f3d-audit-limitations)=
### Ograniczenia

Audyt nie dowodzi wydajności, stabilności sterownika, zachowania po utracie kontekstu WebGL ani kwalifikacji managed FEM bez odpowiadających im artefaktów CI. Otwarte ustalenia z sekcji 13 pozostają ograniczeniami audytowanego SHA.

(f3d-audit-scientific-bibliography)=
### Bibliografia naukowa

Ten audyt nie formułuje nowych twierdzeń naukowych; podstawę fizyczną stanowią kanoniczne noty w `docs/physics/`, a podstawę kontraktu transportowego i runtime — specyfikacje oraz ADR-y wskazane w sekcjach źródłowych dokumentu.

---

(f3d-audit-source-code-index)=
## 19. Indeks źródeł i stabilnych symboli

| Twierdzenie audytu | Lane | Ścieżka | Stabilny symbol / kotwica | Dowód / test | Status dowodu | Niezmienny link |
|---|---|---|---|---|---|---|
| Kanoniczne wire IDs i jawne aliasy | wszystkie | `crates/fullmag-quantities/src/id.rs` | `normalize_quantity_id` | inspekcja źródła | audited | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-quantities/src/id.rs) |
| Katalog quantities | wszystkie | `crates/fullmag-quantities/src/catalog.rs` | `quantity_catalog` | testy katalogu i inspekcja | audited | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-quantities/src/catalog.rs) |
| Parytet providerów | wszystkie | `crates/fullmag-quantities/src/registry.rs` | `standard_providers_register_every_canonical_quantity` | test rejestru | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-quantities/src/registry.rs) |
| Capability quantity FDM | FDM CPU/GPU | `crates/fullmag-runner/src/quantities.rs` | `fdm_quantity_is_active` | testy capability runnera | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-runner/src/quantities.rs) |
| Capability quantity FDM multilayer | FDM ML | `crates/fullmag-runner/src/quantities.rs` | `fdm_multilayer_quantity_is_active` | inspekcja źródła | audited | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-runner/src/quantities.rs) |
| Capability quantity FEM | FEM CPU/GPU | `crates/fullmag-runner/src/quantities.rs` | `fem_quantity_is_active` | testy capability runnera | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-runner/src/quantities.rs) |
| Zamknięta lista CUDA FDM | FDM GPU | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `from_quantity` | inspekcja źródła | audited | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-runner/src/fdm/gpu/cuda/native.rs) |
| Zamknięta lista native FEM | FEM CPU/GPU | `crates/fullmag-runner/src/native_fem.rs` | `from_quantity` | inspekcja źródła | audited | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-runner/src/native_fem.rs) |
| Polityka providerów post-stage | wszystkie | `crates/fullmag-runner/src/observation.rs` | `observation_provider_policy` | testy provider policy | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-runner/src/observation.rs) |
| Komenda post-stage | wszystkie | `crates/fullmag-cli/src/interactive_runtime_host.rs` | `compute_current_fields` | inspekcja źródła | audited | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-cli/src/interactive_runtime_host.rs) |
| Rekonstrukcja bez retained runtime | wszystkie | `crates/fullmag-runner/src/lib.rs` | `snapshot_problem_vector_field_batch` | inspekcja źródła; brak testu wykonania | audited | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-runner/src/lib.rs) |
| Walidacja wartości FMVP | wszystkie | `crates/fullmag-api/src/field_store.rs` | `validate_field_vector_payload` | testy field store | tested; bez identity | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-api/src/field_store.rs) |
| Serializacja identity FMVP v3 | wszystkie | `crates/fullmag-api/src/field_store.rs` | `serialize_field_vector_binary_v3` | testy field store | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-api/src/field_store.rs) |
| Dekodowanie FMVP | frontend | `apps/control-room/src/kernel/api/codecs/fieldVectorCodec.ts` | `decodeFieldVector` | testy kodeka | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/apps/control-room/src/kernel/api/codecs/fieldVectorCodec.ts) |
| Walidacja i adopcja identity w kliencie | frontend | `apps/control-room/src/kernel/api/ControlRoomApi.ts` | `requestFieldVector` | testy API klienta | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/apps/control-room/src/kernel/api/ControlRoomApi.ts) |
| Reset leaf target settings | frontend | `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts` | `removeSerializedOverrideField` | inspekcja; F3D-AUD-006 | gap-confirmed | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts) |
| Semanticzne targety | frontend | `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.ts` | `buildSemanticRenderTargetCatalog` | testy katalogu targetów | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.ts) |
| Airbox capability multilayer | FDM ML/frontend | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `resolveFdmMultilayerAirboxFieldAvailability` | testy adaptera | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts) |
| Publiczny planner FDM | FDM CPU/GPU | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | testy odrzuceń plannera | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-plan/src/fdm.rs) |
| Publiczny planner FDM multilayer | FDM ML | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | testy odrzuceń plannera | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-plan/src/fdm.rs) |
| Publiczny planner FEM | FEM CPU/GPU | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | testy capability plannera | tested | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-plan/src/fem.rs) |
| Aktywacja metryk skalarnych | wszystkie | `crates/fullmag-api/src/quantities.rs` | `scalar_metric_is_active` | inspekcja; F3D-AUD-015 | gap-confirmed | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-api/src/quantities.rs) |
| Wiersz metryki skalarnej | wszystkie | `crates/fullmag-api/src/main.rs` | `scalar_row_metric_value` | inspekcja; F3D-AUD-015 | gap-confirmed | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-api/src/main.rs) |
| Live-step metryki skalarnej | wszystkie | `crates/fullmag-api/src/preview.rs` | `live_step_metric_value` | inspekcja; F3D-AUD-015 | gap-confirmed | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-api/src/preview.rs) |
| Manifest metryki skalarnej | wszystkie | `crates/fullmag-api/src/quantities.rs` | `run_manifest_scalar_value` | inspekcja; F3D-AUD-015 | gap-confirmed | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/crates/fullmag-api/src/quantities.rs) |
| Zarządzany gate mixed-prism shared-air | FEM CPU/GPU | `justfile` | `verify-fem-mixed-prism-airbox-runtime` | zarządzany workflow | partial; brak magnetic-only | [5dd9414](https://github.com/MateuszZelent/fullmag/blob/5dd9414da76ae0ce3081204cffea39137db6951d/justfile) |
