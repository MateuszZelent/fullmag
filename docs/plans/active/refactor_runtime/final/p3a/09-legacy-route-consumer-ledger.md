# P3a-C — rejestr konsumentów otwartych tras

Data przeglądu: 24.09.2026. Checkout: `master`, HEAD
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty working tree.

## Zakres i siła dowodu

Rejestr obejmuje 15 operacji `OPEN` z
[`06-endpoint-owner-policy.md`](06-endpoint-owner-policy.md). Przejrzano
routery i fasadę Control Room, wyszukano odwołania w kodzie produkcyjnym z
wyłączeniem plików testowych i wygenerowanych oraz sprawdzono rodziny
`apiPaths.ts`, `ControlRoomApi` i resource hooks. „Brak klienta” oznacza tylko,
że nie znaleziono produkcyjnego konsumenta w tym checkoutcie. Nie dowodzi braku
klientów zewnętrznych, skryptów użytkownika, integracji ani klientów wydanych
w poprzednich wersjach.

`OPEN` pozostaje otwarte do czasu decyzji: migracja istniejącego klienta albo
utrzymanie jawnego adaptera zgodności z przypiętym scope; ewentualnie
deprecjacja i usunięcie po rozpoznaniu zewnętrznych zależności oraz przejściu
bramki wydania. Sam brak wywołania w Control Room nie upoważnia do usunięcia
publicznej operacji.

## Rejestr operacji

| Metoda i trasa | Właściciel / handler | Klienci znalezieni w repozytorium | Polityka i warunek zamknięcia |
|---|---|---|---|
| `GET /v2/sessions/current` | Session compatibility; `get_current_session` w `crates/fullmag-api/src/router_v2/mod.rs` | Nie znaleziono produkcyjnego konsumenta Control Room, CLI ani klienta w repozytorium. | Odczyt metadanych aktywnej sesji. Nie utożsamiać automatycznie z `/sessions/current/status`, bo kontrakt odpowiedzi może się różnić. Przed deprecjacją zinwentaryzować klientów i zatwierdzić mapowanie pól oraz wersję przejściową. |
| `PATCH /v2/sessions/current` | Session compatibility; `patch_current_session` w `crates/fullmag-api/src/router_v2/mod.rs` | Nie znaleziono produkcyjnego konsumenta. | Handler obecnie odrzuca operację kodem `400` („not yet supported”) i nie mutuje sesji. Usunąć dopiero po inwentaryzacji klientów zewnętrznych, deprecjacji kontraktu i aktualizacji OpenAPI. |
| `GET /v2/sessions/current/analysis/eigenmodes/modes/{mode_id}` | Analysis; `get_eigenmode_by_id` deleguje do `handlers::analysis::get_mode` | Nie znaleziono produkcyjnego wywołania starej trasy ani jej fasady; `ANALYSIS_EIGENMODE_PATH` jest tylko deklaracją ścieżki. | Odczyt artefaktu bieżącej sesji; `mode_id` jest parsowane jako indeks numeryczny. Przed zamknięciem uzgodnić z klientami docelową trasę i semantykę ID/próbki, a następnie zapewnić okres deprecjacji. |
| `PUT /v2/sessions/current/meshing/policies/interfaces/{interface_id}` | Preparation/meshing; `replace_mesh_interface_config` w `handlers/meshing/mesh.rs` | `MESHING_INTERFACE_POLICY_PATH` istnieje w `apiPaths.ts`, ale nie znaleziono fasady ani produkcyjnego wywołania; Control Room używa polityk obiektu i universe. | Mutacja `SceneDocument` jest context-bound i commit-fenced. Jeśli per-interface policy pozostaje publicznym authoring contractem, dodać scoped facade/callera i test stale-session; jeśli nie, najpierw rozstrzygnąć kontrakt oraz zewnętrznych klientów. |
| `PUT /v2/sessions/current/meshing/policies/shared-domain` | Preparation/meshing; `replace_mesh_shared_domain_config` w `handlers/meshing/mesh.rs` | Fasada `api.meshing.sharedDomain.replacePolicy` istnieje, ale nie ma produkcyjnego wywołania. `useMeshSharedDomainPolicyResource` jest używany do odczytu przez `MeshBuildDialog`. | Zapis aktualizuje `study.shared_domain_mesh` i `study.mesh_defaults`; handler używa context-bound load/commit. Utrzymać PUT tylko z callerem przekazującym scope i regresją stale-write albo zdeprecjonować po decyzji o publicznym ownerze tej polityki. |
| `PUT /v2/sessions/current/visualization/display` | Workspace presentation; `replace_display` w `handlers/visualization/display.rs` | `api.visualization.replaceDisplay` istnieje; znaleziono test fasady, nie produkcyjnego callera. | Pełna zamiana display jest transition-fenced. Zachować odróżnienie od patchowania stanu; decyzja o usunięciu wymaga wykazu klientów używających semantyki replace i wersjonowanej migracji. |
| `PUT /v2/sessions/current/visualization/state` | Workspace presentation; `replace_visualization_state` w `handlers/visualization/display.rs` | `api.visualization.replaceState` istnieje bez produkcyjnego callera. Produkcyjny Control Room odczytuje state i używa `PATCH` dla zmian. | Pełna zamiana jest transition-fenced; `PATCH` nie jest równoważnym zamiennikiem dla każdego klienta. Przed deprecjacją ustalić payload/replace semantics oraz zewnętrzną listę klientów. |
| `GET /v2/sessions/current/workspace/layout` | Workspace presentation; `get_workspace_layout` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera w Control Room. `WorkspaceDockLayout` odtwarza układ z lokalnej preferencji. | Odczyt layoutu bieżącej sesji nie jest obecnie źródłem layoutu Control Room. Przed usunięciem rozstrzygnąć, czy layout ma być preferencją lokalną, czy zasobem współdzielonym, oraz sprawdzić klientów zewnętrznych. |
| `PUT /v2/sessions/current/workspace/layout` | Workspace presentation; `replace_workspace_layout` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera w Control Room. | Zapisuje layout w stanie bieżącej sesji; handler ma capture i transition fence. Usunięcie wymaga decyzji o ownerze i scope layoutu oraz potwierdzenia braku zewnętrznych writerów. |
| `GET /v2/sessions/current/workspace/ribbon` | Workspace presentation; `get_workspace_ribbon` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera Control Room. | Odczyt stanu ribbonu z bieżącej sesji. Przed deprecjacją określić, czy wybór tabów jest lokalną preferencją czy stanem współdzielonym, i zinwentaryzować klientów zewnętrznych. |
| `PUT /v2/sessions/current/workspace/ribbon` | Workspace presentation; `replace_workspace_ribbon` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera Control Room. | Mutuje `workspace_mode`, `active_core_tab` i `active_contextual_tab`; handler ma capture i transition fence. Nie usuwać bez decyzji ownera, okresu deprecjacji i zgodności klientów. |
| `GET /v2/sessions/current/workspace/selection` | Workspace selection; `get_workspace_selection` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera endpointu; Control Room utrzymuje aktywną selekcję w `kernel/selection`. | Odczyt selekcji z bieżącej sesji. Uzgodnić, czy backendowa selekcja ma współdzielić tożsamość z lokalnym selection store; do tego czasu nie deklarować równoważności ani usuwać trasy. |
| `PUT /v2/sessions/current/workspace/selection` | Workspace selection; `replace_workspace_selection` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera endpointu. | Zapisuje `selected_node_id`, `selected_object_id` i `selected_entity_id`; handler ma capture i transition fence. Zamknięcie wymaga decyzji o ownerze selekcji, scope i zewnętrznych klientach. |
| `GET /v2/sessions/current/workspace/tree/active-node` | Workspace selection; `get_workspace_active_node` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera endpointu. | Odczytuje node z tego samego bieżącego stanu selekcji. To potencjalny alias `/workspace/selection`, ale zgodność payloadów nie została dowiedziona; wymagane mapowanie oraz inwentaryzacja klientów. |
| `PUT /v2/sessions/current/workspace/tree/active-node` | Workspace selection; `replace_workspace_active_node` w `handlers/workspace/workspace.rs` | Brak fasady i produkcyjnego callera endpointu. | Zapisuje tylko node i współdzieli rewizję selekcji. Usuwać dopiero po potwierdzeniu, że żaden klient nie zależy od częściowego replace ani jego odpowiedzi/realtime semantics. |

## Granica frontendu v2

W migracji Control Room faza cutover pozostaje w toku, a nie zaakceptowana do
usunięcia legacy. Skrypty root kierują `web:dev`, `web:build` i `web:typecheck`
do `apps/control-room`; `apps/web/dev-server.mjs` jest shimem uruchamiającym
Control Room. Git raportuje 981 niezatwierdzonych usunięć pod
`_to_delete_legacy_web`; są to istniejące dirty zmiany, nie zaakceptowany
release. Dokumentacja nadal zawiera historyczne referencje do `apps/web`.
Żadnego z tych plików nie zmieniono w ramach tego rejestru. Status legacy nie
jest `removal-ready`, dopóki nie zostaną spełnione kryteria z
[`21-cutover-acceptance.md`](../../../../../specs/frontend-v2/21-cutover-acceptance.md).

## Brama odbioru P3a-C

Ten rejestr domyka widoczność in-repo ownerów i konsumentów, ale nie zamyka
migracji 15 operacji. Przed zmianą lub usunięciem każdej trasy trzeba uzyskać
zewnętrzny wykaz klientów lub jawnie ograniczyć wspierany kontrakt, zatwierdzić
deprecjację, odświeżyć OpenAPI/typy/klientów, dodać właściwy stale-context test
i wykonać browser/runtime smoke dla zachowywanej ścieżki. Handlerowy
`CurrentLiveRequestContext` nie zastępuje transportu `sessionScopeKey` od
callera.
