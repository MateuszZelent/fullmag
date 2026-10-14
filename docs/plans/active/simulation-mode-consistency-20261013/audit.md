# Audyt spójności FEM/FDM przed pierwszym uruchomieniem

Data: 2026-10-13. Baza: `e1865ce66c0291be2bfc03a77253b77972b62d4f`.
Worktree: `C:/git/fullmag/worktrees/simulation-mode-consistency-20261013`.
Branch: `codex/simulation-mode-consistency-20261013`. Właściciel: `codex-thread-01a12cc7`.

## Wniosek

Wybór FEM/FDM przechodzi do backendu. Problem występuje później: część API rozpoznaje FEM dopiero przy istniejącej siatce, a część UI wybiera metodę z danych domeny lub gubi `capabilities.active_lane`. Pusta sesja FEM może więc otrzymać domenę oznaczoną FDM mimo prawidłowego rozwiązania lane FEM. To źródłowo potwierdzona niespójność, nie odtworzenie znikającego komunikatu użytkownika w działającym runtime.

`Engine pending` ma osobną przyczynę: status bar buduje opis silnika z current-run resource; bez run pokazuje ten napis, choć metoda sesji jest już znana. Scratch session ma `requested_backend` i `resolved_backend`, lecz `resolved_engine_id=None`. Profil capability nie jest dowodem uruchomienia silnika. Naprawa ma pokazywać metodę FEM/FDM od początku i osobno brak aktywnego przebiegu.

## Przepływ wyboru

1. `apps/control-room/src/kernel/layout/NewProblemDialog.tsx:44–52,130–133`: wybór solvera daje `backend: fem` w `sessions.create`; regresja payloadu znajduje się w `NewProblemDialog.test.tsx:103–120`.
2. `crates/fullmag-api/src/router_v2/handlers/sessions/create.rs:151,163–234`: backend zachowuje requested/resolved backend, deklaruje scratch capabilities i nie udaje uruchomionego engine.
3. `sessions/status.rs:283–301` i `data/domain.rs:73–148`: dodatkowy warunek obecności FEM mesh klasyfikuje pustą FEM jako FDM. Tymczasem active-lane snapshot w `status.rs:515–578` już zna FEM.
4. Konsumenty opisane poniżej mogą użyć błędnej domeny zamiast aktywnego lane.

## Inwentaryzacja źródłowa i zakres naprawy

Wiersze odnoszą się do wersjonowanych źródeł bazowego commita; nie do obcych niezacommitowanych zmian głównego checkoutu.

| Obszar | Źródła i odniesienia | Ustalenie / wymagane zachowanie |
|---|---|---|
| Status API | `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs:283–348` | Oddzielić lane od materializacji mesh; pusta FEM nie reklamuje FDM. |
| Domain API | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs:73–163` | Pusta FEM: bez gridu FDM, bez fikcyjnych counts i bez unwrap na nieistniejącej siatce. |
| Generacja/topologia | `sessions/status.rs:1130–1168` | FEM bez mesh nie korzysta z FDM fingerprint/generation. Udokumentować neutralny stan niematerializowany. |
| Ochrona komend backendu | `simulation/commands.rs:193–205` | FDM grid refresh już odrzuca FEM; zachować tę ochronę i usunąć błędną ekspozycję akcji w UI. |
| Explorer | `modules/explorer/ExplorerModule.tsx:201–255,621,655`; `builders/sceneModelTreeAdapter.ts:95–99`; `builders/meshExplorerNodes.ts:532–541` | Resolver jest poprawny, ale downstream traci jawne null i nadaje FDM domainPresentation pierwszeństwo. |
| Ribbon | `modules/ribbon/ribbonContributions.tsx:752–854,1254–1266`; `ribbonCommands.ts:1116–1145` | Katalogi i akcje muszą czytać resolved lane. Legacy caller bez statusu nie może udawać live unresolved lane. |
| Komendy siatki/dialog | `kernel/authoring/geometryLifecycleCommandContributions.ts:245–285`; `modules/overlay/MeshBuildDialog.tsx:121–168` | Wyboru grid/shared mesh nie uzależniać od obecności starej domeny. |
| Resource adapters | `kernel/resources/studyRuntimeResources.ts:258–294,447–493` | Zachować active_lane w projekcji; helper manifestu ma już właściwe own-property precedence. |
| Przygotowanie run | `kernel/runtime/studyRuntimeCommandContributions.ts:618–622`; `livePreparationMaterialization.ts:140–150` | Wymaganie FEM mesh opierać na lane, nie na błędnym domain summary. |
| Główny viewport | `modules/viewport-3d/hooks/useViewport3DSceneModel.ts:3055–3131,3367–3379`; `manifest.ts:174–200,471–517`; `Viewport3DModule.tsx:2110–2114` | Lane służy gatingowi i etykietom; właściwy artefakt nadal wymagany do renderowania. Pusta FEM nie staje się FDM. |
| Mesh Inspector | `modules/inspector/panels/mesh-details/useMeshDetailsModel.ts:170–200,386–415`; `MeshDetailsPanel.tsx:157–168`; `FdmGridInspectorPanel.tsx:313–318` | Nie usuwać active_lane ani nie wybierać panelu FDM z samej DomainMeta. |
| Polityka i regiony | `ObjectMeshPolicyPanel.tsx:836–862,1063,1169,1278`; `ObjectRegionsPanel.tsx:159–170,276–310,453–489`; `RegionsListPanel.tsx:92–109` | Wspólny resolver lane dla polityki, katalogów i paneli. |
| Interakcje fizyki | `PhysicsInteractionPanel.tsx:182–193,221–249,305–315` | Katalog ma tę samą metodę co istniejące active-lane write gates. Nie zmieniać fizyki ani legalności backendu. |
| Wizualizacja planar | `usePlanarMonitorDefinitionAvailability.ts:18–25`; `PlanarMonitorDefinitionEditor.tsx:69–145`; `PlanarVisualizationSection.tsx:118–126,235` | Metoda sesji i dostępność konkretnego pola/topologii pozostają odrębnymi warunkami. |
| Wizualizacja obiektu/debug | `ObjectVisualizationPanel.tsx:259–274,314`; `ObjectVisualizationHelpers.ts:12–40`; `visualization-debug/VisualizationDebugPanel.tsx:58–68` | Adaptery nie mogą usuwać lane i wracać do domeny. |
| Study Inspector | `StudyInspectorPanel.tsx:1121–1170,1446–1457,1555`; `StudyGlobalAuthoringModel.ts:118–132,255–261,296–330,948–962` | Właściwe resolved lane do dostępności; zachować authored/requested auto i provenance. |
| Airbox | `airbox/airboxInspectorRuntimeStatus.ts:16–39,64–113` | Projekcja i consumer manifestu muszą rozumieć ten sam shape; jawne unknown nie może wybierać FEM domyślnie. |
| Status bar | `modules/status-bar/StatusBarModule.tsx:56–95,131–185`; `statusBarModel.ts:99–152` | Jednoznaczny wskaźnik FEM/FDM w prawym dolnym rogu; requested pending i engine not started jako osobne informacje. |
| Pochodzenie wyniku | `kernel/persistence/runOutcome.ts:74–88,135–149` | Backend wyniku bierze się z active lane obserwowanego dla run; nie z późniejszej domeny. |
| Analiza backendowa | `analysis/extensions.rs:454,625` | Do dalszego przeglądu: odróżnić metodę analizy od braku jej danych. |
| Field storage | `data/resolved_vector_field.rs:96`; `data/fields.rs:1461,6372` | Warunki materializacji mogą być zasadne. Nie przepisać ich mechanicznie na lane i nie oznaczać danych cell jako nodal. |

## Zachowane właściwe wzorce

`useActiveLaneCapabilities.ts:72–117` i operation gates ribbon/runtime już korzystają z kanonicznych capabilities. `resolveExplorerModelDiscretization` zachowuje fail-closed. Pure katalogi `shared/domain/physics/interactions.ts:568–663` są poprawne, gdy caller dostarcza właściwy lane.

`shared/domain/mesh/domainPresentation.ts`, `viewport3dDomainAdapter.ts`, `viewport3DFieldDomainCompatibility.ts`, `viewport3dTopologyStaleness.ts`, `fdmRegionMembershipCodec.ts`, `visualizationVectorCapacity.ts` i modelowe asercje FDM mesh sprawdzają rzeczywistą topologię/artefakt. Takie sprawdzenia pozostają konieczne i nie stanowią źródła wyboru bieżącej metody sesji.

## Kontrakt naprawy

- Jeden typed resolver, bez nowego store, endpointów lub odrębnych drzew aplikacji.
- Obecność active_lane jest autorytatywna; jawne unresolved/null/invalid nie fallbackuje do DomainMeta.
- Fallback domeny wyłącznie dla legacy kształtu, w którym active_lane nie występuje.
- Authored/requested FDM/FEM/auto nie jest dowodem resolved lane; requested pozostaje widoczny, kiedy resolution trwa.
- Metoda i engine są rozdzielone. Wybrana FEM przed pierwszym run nie oznacza ani błędu przekazania wyboru, ani uruchomionego FEM runtime.
- Resolved lane nie wystarcza do renderowania field/topology bez zgodnego materializowanego artefaktu.
- Nie zmieniać fizyki, wyboru CPU/GPU, fallback policy, requested intent ani kwalifikacji.

## Weryfikacja i stan

Audyt źródeł: wykonany dla opisanych przepływów. Implementacja i regresje: w toku.
Lokalne unit/DOM testy, typecheck, kompilacja i build: nieuruchomione zgodnie z ograniczeniem użytkownika.
Wymagane przed integracją: CI kontrakty, celowane regresje pustej FEM/FDM, built/retained mesh, jawne null, legacy brak lane, błędna domena, engine-before-run oraz browser smoke z widocznym canvas i niezagubionym WebGL.
Real backend/runtime, ponowne odtworzenie pierwotnego komunikatu i kwalifikacja naukowa: NOT VERIFIED.


## Doprecyzowanie użytkownika: CPU/GPU w jednej sesji

Użytkownik potwierdził, że urządzenie jest deklarowane przy uruchamianiu solvera i może się zmieniać w jednej sesji. Kontrolka metody wyświetla FEM/FDM bez przywiązywania CPU/GPU. Requested device, resolved device i rzeczywisty engine mają osobne provenance dla przebiegu/etapu.

Źródła już zawierają etap `change_device`: `StudyStageDraftEditor.tsx:184–207` pozwala wybrać CPU/GPU/CUDA/auto, `crates/fullmag-application/src/script_stage_materialization.rs:354–373` propaguje device override do następnych etapów, a `crates/fullmag-cli/src/orchestrator.rs:6620–6638` zachowuje wektory magnetyzacji i zapisuje jawny synthetic stage record. To dowód ścieżki źródłowej zmiany na granicy etapów, nie dowód wykonania FEM CPU→GPU w runtime.

Bound execution profile ma odrębny kontrakt: `crates/fullmag-authoring/src/validation.rs:84–142` odrzuca legacy change_device i wskazuje per-step execution przez kanoniczne StudyPlan layers/references. Nie usuwać tej ochrony tylko po to, żeby pokazać aktywny przycisk.

Pozostają do prześledzenia przed deklaracją pełnej obsługi: scratch `resolved_device=cpu` w active-lane capability preview, `simulation/runtime.rs:324–345` (preparation readback), `StudyInspectorPanelModel.ts:436` (opis resolved device) i `session_persistence.rs` compatibility identity. Żaden z tych odczytów nie może na stałe przypinać całej sesji do CPU ani blokować legalnego kolejnego GPU run. Brak dowodu płynnej migracji już trwającego kroku obliczeniowego; nie deklarujemy jej gotowości.


Dalszy odczyt CPU/GPU: `simulation/runtime.rs:255–295` przygotowuje requested execution z aktualnego `scene.study.requested_device`; `simulation/commands.rs:1161–1174` również materializuje aktualny runtime selection ze sceny. W tych ścieżkach nie ma stałej blokady CPU po create. `session_persistence.rs:2955–3044` sprawdza zgodność urządzenia dla konkretnego coupled M3 checkpoint identity, nie dla wszystkich nowych przebiegów sesji; to ochrona checkpointu/operatorów, której ten etap nie usuwa. Pełne wznowienie tego szczególnego stanu na innym urządzeniu wymaga osobnego dowodu zgodności/handoff.


Dodatkowa poprawka provenance Study Inspectora: current run requested/resolved execution ma pierwszeństwo nad capability preview sesji. Bez metadanych run resolved device jest `not loaded`; scratch CPU nie jest dowodem uruchomionego urządzenia ani blokadą GPU. Regresje sprawdzają CPU preview + rzeczywisty GPU run oraz stan przed pierwszym run.
