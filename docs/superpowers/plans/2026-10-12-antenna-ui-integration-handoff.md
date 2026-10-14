# Anteny — zamrożone zależności UI do wspólnej integracji

Data: 12.10.2026. Dokument przekazania, nie dowód integracji lub kwalifikacji solvera.

## Tożsamość i własność

Źródło: `03cddb5c7b40c48a35f78ee62abb34b0aec04c8c`, branch `codex/microwave-antenna-latest-20260909`.
Czytnik pipeline'u, komenda, composer i Inspector zostały wprowadzone w
`426d1974bf4801f87e34024a81c21b0789605817`. Commit `03cddb5…` dodaje wspólny singleton capability guard i poprawkę komunikatu o nieaktywnym kroku/przodku.
Docelowy zaobserwowany HEAD: `147d8b1f723135229cfff0a90e8b2a8bb18cfd9d`,
worktree `antenna-transport-e2e-20261011`, wątek `01a12a56-002e-7660-8424-c7e07fb0907a`.
Docelowy checkout ma aktywny, zmienny WIP: przed integracją właściciel zamraża własny snapshot.
Nie edytowano tego checkoutu, nie uruchamiano jego buildów ani procesów.

Odpowiedzialność: ten wątek przekazuje UI/reader/registration; równoległy wątek prowadzi native transport,
accepted-result, StudyPlan, binder i completion dependencies. Zmiany API i viewportu będące tam WIP
nie należą do poniższego transferu. Nie cherry-pickować całego checkpointu `426d…`.

## Kolejność przeniesienia i wymagane hunki

Poniższe 21 plików to zakres źródłowego przeglądu dla pełnej ścieżki
definition → command → Study Explorer → dedykowany Inspector oraz bezpiecznej obserwacji pipeline'u.
Nie jest to nakaz zastąpienia 21 plików ani dowód kompilacji docelowego WIP.

1. **Pięć nowych plików produkcyjnych**: `studyStageSource.ts`, `antennaFieldSolveCapability.ts`,
   `antennaFieldSolveStudyCommand.ts`, `AntennaStudyStageComposer.tsx`,
   `AntennaFieldSolveStageInspector.tsx`. Reader nie ma importów; helper nie ma importów.
   Reader rozdziela queue ID i definition ID, uwzględnia wyłączonych przodków, odmawia malformed
   pipeline bez fallbacku do uśpionego flat list. Guard wymaga dokładnie jednego niepustego portu
   w definicji; jawny wybór jednego z wielu portów nie usuwa tej odmowy.
2. **Rejestracja komendy**: `studyRuntimeCommandContributions.ts` —
   import `addAntennaFieldSolveStudyCommand` i wpis w `STUDY_RUNTIME_COMMANDS`.
   Osobno konieczne dla scen z pipeline: `flatStageEditingReason` i guards
   add/remove zarówno w availability, jak i po odczycie sceny w handlerze.
   Nie kopiować całego istniejącego pliku.
3. **Caller composera**: `AntennaCompositionPanels.tsx` — wyłącznie import
   `AntennaStudyStageComposer` i render dla `kind === "solution"` z objectId/resourceId,
   scene/status. Zmiany AntennaPortEditor, usuwanie AntennaResourceEditor i walidacja portów
   z tego samego diffu nie są prerekwizytem tej komendy.
4. **Model draftu**: `StudyStageAuthoringModel.ts` — wariant `antenna_field_solve`,
   preserved raw payload w create/serialize, zakaz tworzenia niezwiązanej definicji,
   `antennaFieldSolvePortReferences`, walidacja referencji, rozpoznawanie kind,
   pipelineNodeId/effective enabled/group IDs oraz flat-write guard
   `buildStudyStagesMergePatch`. Caller przekazuje bieżącą scenę.
5. **Controller i wspólny panel**: `StudyInspectorPanel.tsx` czyta reader,
   tworzy readonly pipeline drafts z queue ID, pozostawia definition ID w raw payload,
   blokuje duplicate antenowego reference stage, przekazuje scenę do merge-patch guarda;
   `StudyPipelineSection.tsx` obsługuje readOnlyReason i ukrywa flat mutation toolbar.
   `StudyStageDraftEditor.tsx` ma readonly kind/ID dla reference stage.
   `StageInspectorFrame.tsx` pokazuje skuteczne enablement/group IDs i blokuje flat commit pipeline.
   To guards zachowania, nie jedynie kosmetyczne zależności typów.
6. **Snapshot/runtime identity**: `StudyInspectorPanelModel.ts` i
   `sceneModelTreeAdapter.ts` używają readera. Pipeline runtime łączy się po queue ID,
   nigdy przez indeks authored list ani dormant flat fallback. Pierwszy zachowuje disabled
   state, drugi przekazuje pipeline label/enabled do Explorer.
7. **Selection → Explorer → Inspector**:
   dodać `study.stage.antenna_field_solve` w `selectionTypes.ts`, `explorerTypes.ts`,
   `explorerSelection.ts`; w explorerTypes dodać trzy pipeline snapshot pola.
   `studyExplorerNodes.ts` obsługuje kind przez `buildStudyStageBaseNode`;
   `studyStageCommon.ts` używa pipeline label i disabled badge.
   `inspectorRouteCatalog.tsx` importuje router i rejestruje dedykowany selection kind.
   `StudyStageInspectorRouter.tsx` importuje Inspector, rozpoznaje selection kind,
   renderuje `AntennaFieldSolveStageInspector` oraz nie routuje nieobsługiwanych pipeline
   makr jako magnetic stage.
   **Nie przenosić usuwania terminals** z tych diffów: to niezależna zmiana.

Porównanie committed HEAD-ów wykazało brak różnic wymagających transferu w używanych
apiTypes/apiPaths, authoringHistoryMutation, commandSessionScope/commandTypes,
KernelContext, sessionResourceIdentity/useSessionStatus, Inspector primitives i Button.
Nie oznacza to zgodności późniejszego docelowego API WIP; jego właściciel musi sprawdzić
typy i consumerów po zamrożeniu snapshotu. Nie potrzeba nowych endpointów, Cargo zmian,
native ABI ani zmiany zablokowanych LLG/FFT capabilities do powyższej komendy.

## Manifest źródłowy

Ścieżki względem `apps/control-room/src/`. Hash w tabeli to dokładny **Git blob SHA-1**
z `git ls-tree` dla wskazanego źródłowego commita; nie SHA-256 bajtów worktree.
W existing files hash przypina pełny plik do review, a integracja nadal dotyczy wybranych hunków.

| Plik | Git blob |
|---|---|
| `kernel/runtime/antennaFieldSolveStudyCommand.ts` | `f329dcb60f5c65e3c9fa5521ba3dd5b047cce1b2` |
| `kernel/runtime/studyRuntimeCommandContributions.ts` | `14fcdd8d85cc57e0dac72dd6de897c243a8894f0` |
| `kernel/selection/selectionTypes.ts` | `cb78e3f4809b7f4aacc29a28ece8b4f11a14c513` |
| `modules/explorer/builders/sceneModelTreeAdapter.ts` | `501b482b6b51bd80423e6cb114b28f5a8ca03260` |
| `modules/explorer/builders/study/studyExplorerNodes.ts` | `afb0df48a6e5443f440e989e34fcaffad28f602f` |
| `modules/explorer/builders/study/studyStageCommon.ts` | `3b3b90251bc6eeeddaa38b6cc8af3bf2c07ca509` |
| `modules/explorer/explorerSelection.ts` | `944e6e9db14262fcc5ff12a4cf07bbc8cf4550d9` |
| `modules/explorer/explorerTypes.ts` | `f4b8ac48e5dcc325177264e7e98e5e9cd8ad9a7b` |
| `modules/inspector/inspectorRouteCatalog.tsx` | `bc59a3e558a8a2816e90b4db9c1918f0a7d09223` |
| `modules/inspector/panels/StudyInspectorPanel.tsx` | `feaa128394917011d3fec8a175f78e7671a30133` |
| `modules/inspector/panels/StudyInspectorPanelModel.ts` | `4d1bc2d850d440448389defbdb554648324a7554` |
| `modules/inspector/panels/StudyPipelineSection.tsx` | `133a364b3d810535542690dd001c096943e2a5d4` |
| `modules/inspector/panels/StudyStageAuthoringModel.ts` | `0da7334865922432849dde41569e1d4972a42e10` |
| `modules/inspector/panels/StudyStageDraftEditor.tsx` | `f779c73c60e490b34e3ed7e6fc52aae8f6e48749` |
| `modules/inspector/panels/StudyStageInspectorRouter.tsx` | `c4060a2f68f8e74d78413862cc24a934d5019668` |
| `modules/inspector/panels/antenna/AntennaCompositionPanels.tsx` | `e5f8c586d9d9b22eb425986de682af49e826e860` |
| `modules/inspector/panels/antenna/AntennaStudyStageComposer.tsx` | `dc89b72c679749f95b53a2ce0cb8e78e09e8b03e` |
| `modules/inspector/panels/stages/AntennaFieldSolveStageInspector.tsx` | `0f3e4c5001455542f92b63566e8845252f858af0` |
| `modules/inspector/panels/stages/StageInspectorFrame.tsx` | `f475ee272ea3b19ebe6f79911850fd22b10e1a6b` |
| `shared/domain/study/antennaFieldSolveCapability.ts` | `f22fe7c7d948efb3a74dd3f360aa6972abd671b9` |
| `shared/domain/study/studyStageSource.ts` | `dd1b46021981aeb9bee772beb9922c415c1c4234` |

## Weryfikacja i bramki

Źródłowe ESLint sześciu plików oraz TypeScript noEmit przeszły przed commitem `03cddb5…`.
Przeniesienie do docelowego WIP wymaga odrębnego typecheck i source review.
Zapisane regresje komendy/composera, readera, draftu, pipeline modelu, Explorer oraz route
należy przekazać wraz z kodem; obowiązujący zakaz kompilacji unit tests pozostaje w mocy.
Nie usuwać testów ani nie raportować ich jako wykonanych.

Dodatkowy odczyt działającego izolowanego UI 3105: dedykowany Study Inspector pokazuje
definition ID, selected port, disabled parent i odmowę multiport. Visualization używa
wspólnej rodziny kontrolek, pokazuje unavailable i nie oferuje magnetyzacji dla anteny
bez wyniku. To obserwacja authoringu na starym API, nie dowód wyświetlenia realnych V/J/H.
Nie wykonano nowych obliczeń ani zmian modelu w tej dodatkowej obserwacji.
Trwały screenshot i pełna Object/Airbox pending/ACK/WebGL bramka nadal niepotwierdzone.

Istniejąca recepta `just verify-antenna-visualization-browser` uruchamia izolowany
synthetic fixture smoke na 3262: komponenty/hooks/renderer, V/I,J/I,H/I i raw V/J/H,
ownership, binary bounds i WebGL. **Nie została uruchomiona w tym przekazaniu.**
Nie zastępuje realnych HTTP endpointów/current closure/B-01/B-02, reusable basis,
projection, waveform, LLG ani source FFT. Raw H inspection pozostaje NOT VERIFIED
i nie może zostać promowane do bazy.

Po transferze potrzebny browser regression na docelowym frontendzie i właściwym API
z zachowaniem istniejących guards. Ten pakiet nie zamyka żadnego pełnego etapu T00–T18.
