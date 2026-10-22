# Audyt Objects → Antenna: typy węzłów i inspektory

Data: 20.10.2026. **Audyt kodu przed dalszą implementacją**, zgodnie z poleceniem użytkownika. „Dostępna kontrolka” oznacza obecność w źródłach, nie zaliczony przebieg runtime.

## 1. Werdykt

**Pomieszanie antenna/ferromagnet jest rzeczywiste, ale nie obejmuje jednakowo całego drzewa.** Dedykowane formularze przewodnika, źródła, portów, solve, projekcji, prądu i widma nie zawierają edytorów Ms, Aex, alpha ani magnetyzacji. Problemy są przede wszystkim we wspólnych domyślnych ustawieniach wizualizacji, propagacji kontekstu, nawigacji, rozszerzeniach i opisach siatki.

Bezpośrednią przyczyną „Quantity Source = m” jest wspólny default activeQuantityId=m i orientation, rozstrzygany bez jawnego kontekstu przypisanej fizyki. Antena ma już własny widok oraz ścieżkę wyników V/J/H, ale wejście do tego widoku nie usuwa starego/domyślnego m. **Widoczne m nie dowodzi istnienia magnetyzacji ani dopuszczenia tego pola przez API.** [S08–S12]

| Pytanie | Odpowiedź |
|---|---|
| Czy analizowany obiekt naprawdę jest anteną? | W odczytanym FMS: id=antenna, role=antenna, MicrostripAntennaLayout, brak magnetization_ref i physics_stack. |
| Czy wszystkie węzły mają dosłownie typ antenna? | Nie: 14 podstawowych rodzajów obejmuje też wspólne object.root, object.mesh i object.visualization.debug. To samo w sobie jest poprawne. |
| Czy każde dziecko jawnie przenosi rolę? | Nie: Geometry, grupa Antenna i Debug nie wpisują objectRole; zwykła konwersja scene-object też go nie kopiuje. |
| Czy antena dostaje zwykłe poddrzewo ferromagnetyka? | Nie: brak Magnetic Parameters, Magnetic Texture, Frozen Spins i zwykłego Regions w tej gałęzi. Jawny physics graph jest zachowany. |
| Czy wspólne inspektory są neutralne fizycznie? | Nie: m/orientation, Topological Charge, Edit Geometry i nazewnictwo/presety Mesh wymagają poprawy. |
| Czy złota geometria pokazuje przepływ prądu? | Nie: primitive jest podglądem authoringu, nie mapą J ani schematem GS/GSG. |

## 2. Rewizja, zakres i metoda

| Element | Stan |
|---|---|
| Worktree | D:/git/fullmag/worktrees/antenna-transport-e2e-20261011 |
| Branch | codex/antenna-transport-e2e-20261011 |
| Pobrany origin/master i HEAD po fast-forward | a63b50ca0c0c4b457f440b0ac276b483d282c555 |
| Poprzednia baza | 377f3ced6d314ecfc46bc63211563dca4483765f |
| Audytowana treść | Nowy master **plus zachowane lokalne zmiany**. HEAD sam nie odtwarza WIP; SHA256 kodu przypina sąsiedni plik sources.json. |
| Kopia przed integracją | Zachowany stash b13566d968fcbf06d20103a3cc26bf32c75c7497. |
| Integracja | Rozwiązano 11 konfliktów i kolizję scripts/test_docker_volume_checks.py, bez commita. Stash apply zmienił rozdzielenie staged/unstaged; kopia pierwotnego indeksu pozostaje w stash. |
| Otwarta karta | Istniejący pakiet Docker zbudowano przed integracją. Ten audyt nie dowodzi, że karta wykonuje bieżące bajty worktree. |

Prześledzono builder → SelectionRef → route → panel → formularze/modele → API/resources i katalog quantity. Inwentarz obejmuje wszystkie 14 rodzajów antenowych, także warunkowe zasoby i współdzielone panele. Dodatkowo opisano physics graph i transport/closure/source-cut obecnego przykładu. Odczytano zapisany FMS, bez podmiany aktualnej sesji.

Oznaczenia: **odczyt** bez edycji; **draft** lokalny szkic; **authoring** zapis sceny; **display** prezentacja; **nawigacja** wybór panelu; **wykonanie** osobny solver. Pola liczbowe są często tekstowymi draftami SI parsowanymi przez model. Jednostka 1 oznacza bezwymiarowość.

Zastosowano scientific-documentation-contract w trybie wewnętrznego audytu. Właścicielem fizyki pozostaje nota 0950; nie definiujemy ponownie równań, Python API ani ProblemIR. Dokument nie jest terminalną stroną publikacyjną i nie kwalifikuje solverów.

## 3. Co oznacza „typ anteny”

| Warstwa | Kontrakt i ustalenie |
|---|---|
| SceneObject | id, name, role, geometria, magnetization_ref, physics_stack i regiony są oddzielne. Legacy default role=magnet nie jest dowodem przypisanej fizyki. [S01] |
| Adapter drzewa | Jawne role=antenna → objectRole=antenna; inne jawne role poza magnet → auxiliary. Legacy visualization_hint/tag też może rozpoznać antenę; inaczej fallback magnet. [S02] |
| ExplorerNode | kind identyfikuje semantyczny węzeł, np. port; objectId właściciela i opcjonalne objectRole są odrębne. [S03] |
| SelectionRef | type=scene-object, kind i objectId; antennaResourceId/Kind dla zasobów. Ref type nie nazywa się antenna; objectRole nie jest kopiowany w tej gałęzi. [S04] |
| Inspector route | selectionKinds wybiera komponent; dzieci mają antenowe trasy, root/mesh/debug wspólne. [S05] |
| Fizyka | Jawnie zadane moduły, scope, capability i rozwiązany plan. Rola, nazwa, geometria i kolor nie aktywują LLG. |
| Dane | Quantity catalog i exact stage/run/session/carrier/revision/digest. Requestability, materialization i istniejący wynik to różne stany. [S12] |

Wspólny szablon powinien otrzymywać rozstrzygnięty kontekst obiektu i przypisanej fizyki oraz dostępność z kanonicznego katalogu. Zmiana wszystkich kind na antenna nie naprawi problemu. Obiekt prezentowany jako antena może mieć świadomie przypisaną magnetykę; nie wolno usuwać jej tylko na podstawie etykiety.

## 4. Pełny inwentarz drzewa

O oznacza model:object:`<objectId>`. ID zasobów jest encodeURIComponent. Kolumna roli dotyczy **ExplorerNode**, nie SelectionRef. [S03–S05]

| Nr | Etykieta / ID po O | kind | Jawne objectRole | Inspector / ocena |
|---|---|---|---|---|
| N01 | Nazwa obiektu / O | object.root | antenna | ObjectGeneralPanel; wspólny, częściowo rozpoznaje brak magnetyki. |
| N02 | Geometry / :geometry | object.antenna.geometry | brak pola | AntennaGeometryPanel; dedykowany przewodnik i placement. |
| N03 | Antenna / :antenna | object.antenna | brak pola | AntennaCompositionSummaryPanel; kompozycja/nawigacja. |
| N04 | Regional field drive / :antenna:regional | object.antenna.regional | antenna | AntennaObjectPanel; prescribed regional field. |
| N05 | Terminals and source / :antenna:terminals | object.antenna.terminals | antenna | AntennaTerminalsPanel; source/obserwacje. |
| N06 | Conductor / :antenna:conductor | object.antenna.conductor | antenna | AntennaConductorPanel; conductivity i tworzenie portu. |
| N07 | Port N / :antenna:port:`<id>` | object.antenna.port | antenna | AntennaPortPanel; terminale/wagi. |
| N08 | Field solve N / :antenna:solution:`<id>` | object.antenna.solution | antenna | AntennaSolutionPanel; definicja/Study/results. |
| N09 | Projection N → target / :antenna:projection:`<id>` | object.antenna.projection | antenna | AntennaProjectionPanel; binding do odbiorcy. |
| N10 | Nazwa prądu / :antenna:drive:`<id>` | object.antenna.drive | antenna | SolvedAntennaDrivePanel; I(t). |
| N11 | Source spectrum N / :antenna:spectrum:`<id>` | object.antenna.spectrum | antenna | AntennaSpectrumPanel; FFT źródła. |
| N12 | Mesh / :mesh | object.mesh | antenna | ObjectMeshPolicyPanel; wspólny FEM/FDM. |
| N13 | Visualization / :visualization | object.antenna.visualization | antenna | AntennaVisualizationPanel; raw i per-A. |
| N14 | Debug / :visualization:debug | object.visualization.debug | brak pola | ObjectVisualizationDebugOwner → VisualizationDebugPanel. |

Porty i solve należą przez source_object_id. Projekcje pochodzą od solve tej anteny, drives od jej projekcji, spectra od jej solve. Brak zasobu oznacza brak węzła. Regional/Terminals/Conductor są stałe. Brak objectRole w Geometry/Composition/Debug nie oznacza automatycznego zaklasyfikowania jako ferromagnet.

Root menu: planar-monitor.create (tylko runtime capability), geometry.focus-primitive, geometry.delete-object, workspace.focus-selection, expand/collapse. Mesh: mesh.build-selected, mesh.open-object-report. Solve: study.add-antenna-field-solve-stage z objectId/stageId oraz focus. Pozostałe mają focus selection. Status configured/ready referencji nie certyfikuje wykonania.

### 4.1. Dodatkowe węzły Physics

physicsGraphObjectChildren → buildPhysicsGraphObjectNode dodaje jawne object-scoped moduły, również antenie. [S06]

| Węzeł | Route / owner / zawartość |
|---|---|
| Physics · nazwa | object.physics.scope; builder selectable=false. Dostępna trasa ObjectPhysicsScopeInspectorPanel pokazuje Scope node i Object. Brak objectRole. |
| Moduł grafu | Explorer physics.module. Selection dispatch: current_transport → physics.current-transport; spin_transport/interface/torque, oersted_field i regional_field_drive → dedykowane trasy. Inne → PhysicsGraphModuleInspectorPanel. |
| Closure | physics.structured-current-closure; StructuredCurrentClosureInspectorPanel; currentTransportId + closureId. |
| Source cut | physics.structured-current-source-cut; StructuredCurrentSourceCutInspectorPanel; dodatkowy sourceCutId. |

Ogólny moduł: family, source ID/kind/path, scope object/region/interface/global, wymagane źródła/activation, requested/resolved lane, capability, graph/scene revision. Bez edytora Ms. Jawnie przypisane moduły spinowe mogą legalnie zawierać parametry magnetyczne, ale nie aktywują się z role=antenna. Obecny FMS ma charge transport, nie spin transport/interface/torque.

## 5. N01 — Object General

Źródła: ObjectGeneralPanel, resolveObjectGeneralPanelModel, hasEmptyObjectMagneticModel oraz OBJECT_EXTENSION_REGISTRY. [S07,S13]

| Sekcja / wszystkie opcje | Rodzaj i warunki |
|---|---|
| Name, Notes | Tekst/textarea identity draftu committed object. |
| Object ID, Shape | Odczyt. Brak jawnego odczytu role/physics context. Shape to geometria. |
| Material, Region | Tekstowe metadane/ref authoringu; nie conductivity ani Ms. Brak=unassigned. |
| Primitive color | Tekstowy kod koloru, viewport-local. Role helper daje antenna token zamiast legacy magnetic; literal override zachowany. |
| Preview color, Preview color source | Odczyt efektywnego koloru/źródła; gold nie jest wynikiem. |
| Frame color | Preferencja wireframe. |
| Energies | Fetch state, Sample, Source, Average m, Exchange, Demag, Zeeman, Anisotropy, DMI, Total. **Ukryte**, gdy scene role=antenna i hasEmptyObjectMagneticModel; wtedy brak requestu metrics. Jawna magnetyka może je przywrócić. |
| Resource State | Source, Mode, Mesh, Scene revision, Fetch state. |
| Apply / Apply Identity, Revert | Zapis/wycofanie identity/geometry/transform draftów; blokady pending/dirty/scene mutation/placement gesture. |
| Edit Geometry | **Hardcoded object.geometry**, mimo dedykowanego object.antenna.geometry w drzewie — F03. |
| Delete | Canonical history mutation; blocked przy dirty/pending/lock. Nie wykonano podczas audytu. |
| Validation | Fetch state i komunikaty albo no object issues. |
| Extensions | Topological Charge checkbox default=false i Active modules. Registry sprawdza tylko committed root/type/id, bez magnetyzacji — F04. |

Ważne: gałąź anteny nie dodaje objectExtensionNodes, choć General oferuje Topological Charge. Lokalna aktywacja rozszerzenia nie dowodzi wyniku ani LLG, ale propozycja jest niewłaściwa dla tej anteny bez magnetyki.

## 6. N02 — Geometry

Źródła: AntennaGeometryPanel, MicrostripGeometryEditor/Model, AntennaPlacementEditor/Model. [S14]

Odczyty Authored dimensions: **Length, Thickness, Signal width range, Return width, Return offset, Width stations, Circuit geometry, Parts**. Return/circuit tylko Microstrip. Parts rozróżnia CPW signal/left/right return lub microstrip signal/return/inlet/outlet. Format długości m/mm/µm/nm. Wyjaśnienie szerokiej return plate nie oznacza mapy J.

| Edytor | Wszystkie pola, opcje, warunki |
|---|---|
| Wymiary | Conductor length/thickness (m, >0); Microstrip Return width (>0), Return offset (m, ≥0; closed circuit wymaga >0). Początek z geometry_params. |
| Każda stacja | Position s (1, 0..1; endpoint disabled), signal width (m); CPW dodatkowo left/right gap i left/right ground width (m). |
| Stacje actions | Add station, Remove station tylko interior. |
| Circuit | Full 3D conducting circuit tylko Microstrip. Enabled committed loop nie można tym checkboxem otworzyć; wymagana jawna migracja źródła. |
| Source | Inlet source-cut potential jump (V, finite nonzero); local z offset (m, w clearance, nowy midpoint); normal Positive/Negative local z, default positive_axis. |
| Każdy inlet/outlet bridge | Length, width, center v (m), part ID (tekst), conductivity (S/m). Wartości z authoringu, bez domyślnej „typowej anteny”. |
| Save lifecycle | Revert draft, Rebase draft, Refetch Scene przy konflikcie/revision; Save conductor authoring. Geometry transaction lub jeden geometry+transport+source/port merge patch; current scope/revision, ready scene, dirty, valid, bez konfliktu/pending. |

Zmiana unieważnia mesh/basis i nie wykonuje transportu. Brak konkretnego rodzaju geometry daje odczyt deskryptora zamiast zgadywania shape po nazwie.

Placement: **Placement target** select, default pusty, inne obiekty z magnetization_ref; **Placement side** above (+world Z, default)/below; **Antenna clearance** m, default 5e-8, >0; odczyty **Proposed Δz, Committed translation**. Akcje **Refresh placement bounds, Revert placement, Rebase placement, Apply antenna placement**. To pionowy AABB gap całego assembly, nie minimalna odległość powierzchni. Current bounds/revision/unlocked source wymagane. Outer rotation/scale niewspierane przez ten round-trip nie są resetowane: placement odmawia. Ograniczenie targetu do magnetization_ref nie czyni anteny ferromagnetem.

## 7. N03 — Antenna composition

AntennaCompositionSummaryPanel i antennaNavigationLinks/antennaNavigationScene. [S15]

Odczyty **Name, Object ID**, liczby **Conductor, Ports, Field solves, Projections, Current drives, Source spectra**. Przyciski **Open …**, **Open Geometry, Terminals, Regional field drive**. Każde Open ponownie sprawdza aktualny owner/scenę; missing/ambiguous daje disabled z powodem. Puste sekcje mają komunikaty, nie ukryte tworzenie. Bez API mutation/solvera.

Brak: tekst pustej sekcji może kierować do konfiguracji solve, ale Conductor authoring zawiera material+port, nie pełny formularz utworzenia nowej definicji solve. Dodanie istniejącej definicji do Study jest osobne.

## 8. N04 — Regional field drive

AntennaObjectPanel i antennaWaveformDefaults. [S16]

To **zadane regionalne pole**, nie źródło napięcia, current solve ani obliczony Oersted. Antena jest geometrią/maską źródła. Odczyty: Object, Source, Amplitude, Direction, Spatial profile, Waveform; canonical/legacy/missing.

| Kontrolka | Opcje / jednostka / default |
|---|---|
| Amplitude | T; source lub fallback 0.001. |
| Direction | Tekstowy vector draft, 1. |
| Waveform | constant / sinc_pulse / sinusoidal. |
| Sinc | Waveform amplitude (1), Cutoff (Hz), t0 (s); change defaults 1, 2e10, 5e-11. |
| Sinus | Frequency (Hz), Phase (rad), Offset (1); defaults 1e10, 0, 0. |
| Create regional field drive | Przy missing: nawigacja do canonical physics-field-drive draft. |
| Lifecycle | Reset/Save; Server/Draft per pole, Rebase Draft; revision conflict Refetch Scene/Rebase/Retry/Discard. |

Canonical save=api.model.replaceFieldDrive (PUT field-drives/{id}, base_revision). Legacy prescribed_zeeman_mask jest jawnie migration required i migruje przez transakcję field_drives/current_modules. Położenie tej sekcji obok circuit workflow jest mylące, ale pole B w T nie oznacza magnetyzacji anteny.

## 9. N05 — Terminals and source

AntennaTerminalsPanel, AntennaTerminalSourceModel/Details, AntennaTerminalPreparationModel. [S17]

**Closed-circuit source — odczyt:** authored structured_current_closure.v2/closed_geometry albo prepared conservative_current_source.v2/closed_geometry_potential_jump. Pola: **Current transport, Source schema, Closure ID, Source cut ID, Circuit ID, Conductor part, Drive ID, Impressed potential jump (V), Coordinate frame, Cut plane axis/offset (m), Oriented cut normal**. Prepared dodaje revision, mesh digest, authored input digest, potential drop (V), paired mesh faces. Per port: ID/source-cut ref/normalization orientation. Per branch: ID/inlet-outlet observations/signed weight (1). Akcje **Open Geometry, Open port …, Refresh scene**. Konfliktów/nieznanych kontraktów nie zamienia się w straight-stub. Edycja źródła jest w Geometry lub physics source-cut Inspectorze.

**Straight-stub preparation** występuje wyłącznie w sourceModel.mode=preparation:

| Kontrolka | Typ / jednostka / wartość początkowa |
|---|---|
| Terminal preparation port | Select własnych portów, brak auto load; load blocked dirty/pending. |
| Drive ID | Existing lub `<portId>`:external-drive. |
| Preparation revision | Existing lub pusta. |
| Port observation; Authored end-cap selector | Odczyt. |
| External actuator ID | Existing lub `<observationId>`:outer. |
| Lead length; Lead conductivity | m / S/m, existing lub puste. |
| Extrusion layers | Całkowite, existing lub 2; zakres 2..1048576. |
| World outward direction x/y/z | Trzy liczby, 1, jednostkowy vector; existing lub puste. |
| Signed outward actuator current | A, existing lub puste; nie wynika z branch weight. |
| Inspection readiness · stage | Walidacja, odczyt. |
| Actions | Refresh scene, Reset terminal draft, Apply inspection preparation. |

Warunki: canonical Microstrip/CPW, unlocked cały obiekt, static one-way Ohmic, istniejący FEM H1 CG policy, jawne końce, dodatnie długości/przewodności i jawne finite currents. Expert source/closure/time envelope nie są automatycznie zastępowane. Zapis preparation zastępuje legacy boundaries/view. UI mówi **external-electrode truncation / inspection-only**; to nie kwalifikacja pełnego obwodu/basis/FFT/LLG. W analizowanym FMS jest closed loop, więc formularz preparation nie powinien zastępować jego readoutu.

## 10. N06 — Conductor

AntennaConductorPanel → AntennaCompositionPanel, AntennaConductorAuthoring, MaterialEditor/Model i PortComposer/Model. [S18]

Odczyty: **Object, Name, Layout, Part IDs, Layout conductivity (S/m), Object material ref, Authored mesh policy**, model transportu i charge conductivity każdego assignment. Material ref jest ID, nie włącznikiem magnetyki.

| Formularz | Wszystkie opcje |
|---|---|
| Conductivity | Layout conductor conductivity; przy enabled loop Inlet bridge conductivity i Outlet bridge conductivity, S/m; Source object i Conductor parts read-only. Defaults z geometrii. |
| Conductivity actions | Refresh conductivity, Revert conductivity, Apply conductivity. Dodatnie finite; jeden static one-way ohmic_poisson całego object. Prepared/nieobsługiwane read-only. |
| Add antenna port | New port ID (pusty), New port transport select (pusty, static one-way Ohmic źródła). Początkowo dwa puste branches: ID, inlet/outlet terminal select, signed weight (1). |
| Port actions | Add/Remove new port branch, Refresh port sources, Discard new port draft, Rebase new port draft explicitly, Create port. |
| Nawigacja | Open Geometry, Open Mesh Policy. |

Conductivity zapisuje **razem geometry i sigma_Spm w charge-material assignments**, zachowując inne parametry. Whole-object assignment nie reprezentuje różnych bridge conductivity. Port composer tworzy v2 z normalization 1 A bez edytora normalization. **Odmawia closed-loop source wymagającego v3/source-cut normalization**; disabled Create jest granicą authoringu, nie klasyfikacją ferromagnetyczną.

AntennaConductorAuthoring agreguje osobne material/port sesje. Przy wielu dirty formularzach wspólne Apply wymaga lokalnego zapisu i jawnego rebase pozostałego szkicu. Zapis conductivity/policy nie jest mesh buildem ani solve.

## 11. N07 — Port

AntennaPortPanel, AntennaPortEditor/Model::committedAntennaPortScene oraz AntennaResourceEditor. [S19]

Odczyty: **Validation, Qualification=authoring-only, ID, Schema, Source object, Current transport, Normalization (A)**, każda para terminali i signed weight. Początkowy draft z zasobu; ID/normalization bez edytora.

Edycja: **Current transport** tekst ID; per branch **ID**, **inlet terminal**, **outlet terminal** (select rzeczywistych choices, unavailable zachowane), **signed weight (1)**. **Add branch, Remove branch, Refresh port, Revert port, Rebase, Apply port**. Nowy branch ma jawne puste wartości. ACK sprawdza scene/revision/schema/owner/normalization i faktyczne branches przed cache/history.

**Remove port (no cascade)** jest osobne, blokowane przez dirty i zależne field solves/drives/spectra/preparation. Wagi opisują orientację/obserwację, nie automatyczne ampery aktuatora. Brak schematu GS/GSG na geometrii.

## 12. N08 — Field solve

AntennaSolutionPanel/AntennaCompositionPanel, AntennaSolveTargetsEditor, AntennaStudyStageComposer, AntennaFieldSolveAuthoring. [S20]

Odczyty definicji: **Validation, ID, Current transport, Port modes, Model, Oersted realization, Conductor mesh, Sampling domain, Targets, Solver policy, Outputs, Publication**. Configured/liczba outputs nie oznacza wyniku.

| Sekcja | Wszystkie kontrolki i warunki |
|---|---|
| Sampling | Field-sampling domain: Global lub istniejący Object; Region wykluczony jako sampling carrier. Declared mesh policy/solver policy/physical model read-only. |
| Realization | direct_tetra_quadrature; vector_potential_solver tylko dla dopuszczonego source. Current-driven/prepared/structured closure bez automatycznego fallbacku na vector potential. |
| Targets | Target N + Remove target; Add field-solve target select + Add target. Global/Object/enabled Region z poprawnym ownerem; bez duplikatów. |
| Save | Refresh, Revert, Rebase, Apply field-solve settings, transakcja definicji. |
| Study | Stage port mode select (auto tylko jeden); Study stage ID read-only, Open Study stage lub Add Field Solve to Study. Add wymaga current scene/valid port/capability i missing reference; Open Study stage dotyczy istniejącej referencji. |
| Dalsza kompozycja | Create projection lub projection+drive; Create source FFT request. Rozdziały 13 i 15. |
| Wyniki | Published basis, catalog i raw inspection, rozdział 16. |

Dodanie do Study **nie uruchamia solve ani LLG**. Brak bezpośredniego Solve now i Remove solve definition. Nie ma w Conductor pełnego Create field-solve definition. Targets/projection/spectrum są osobnymi draft sessions; przy ich jednoczesnym dirty wymagany jawny local save/rebase.

## 13. N09 — Projection

AntennaProjectionDriveComposer, AntennaProjectionPanel, AntennaResourceEditor/Model::buildAntennaResourceTransaction. [S21]

| Operacja | Pola, opcje, defaults |
|---|---|
| Create z Field solve | Projection composition: Projection only (default) / Projection and sinusoidal drive. Projection target: pusty select Global/Object/Region. |
| Combined drive | Run stage: pusty select enabled unique Run; Peak current (A, pusty, signed finite); Frequency (Hz, pusta, >0). |
| Create actions | Refresh, Discard, Rebase explicitly; Create projection lub Create projection and drive. Jeden merge patch. |
| Istniejąca: odczyt | Validation, ID, Output, Solve stage, Reference stage-output/published-asset, Asset, Content digest, Target, Publication. |
| Edit | Immutable resource ID read-only; Target select; Source binding: Keep exact current reference and asset pins / Rebind explicitly to stage output. |
| Edit actions | Refresh resource, Discard draft, Rebase draft explicitly, Apply projection, Remove projection (no cascade), blokada zależnych drives. |

Combined drive wymaga Object innego niż conductor, jednego matching port i H_ant_basis output. Generuje unikalne ID, sinus phase=0/offset=0, stage_local i activation wybranego Run. Rebind usuwa stare asset pins dopiero przy jawnym wyborze stage output, nie oblicza pola. Odbiorca Object/Region nie czyni źródła ferromagnetem.

## 14. N10 — Solved current drive

SolvedAntennaDrivePanel, SolvedAntennaDriveEditor/Model::waveformDefaults, AntennaPiecewisePointsEditor, AntennaDrivePreview. [S22]

| Kontrolka | Opcje / jednostki / warunki |
|---|---|
| Drive name | Tekstowa nazwa; ID oddzielne. |
| Field projection and port | Select jawnych binding options. |
| Peak current | A, signed, nie RMS. |
| Waveform | constant / sinusoidal / sinc_pulse / pulse / piecewise_linear. |
| Frequency / Phase / Offset | Sinus: Hz / rad / 1. |
| Cutoff / Center time / Amplitude | Sinc: Hz / s / 1. |
| Pulse on / Pulse off | Pulse, s. |
| Piecewise points | Time (s), Multiplier (1); Add waveform point = pusty time i multiplier 0; Remove tylko gdy >2 punkty, minimum pozostające 2; Previous/Next po 12. Wymagane rosnące finite czasy. |
| Declared bandwidth | Opcjonalne Hz dla pulse/piecewise, nie wyprowadzane z duration/knot spacing. |
| Time origin | stage_local / absolute. |
| Activation | all_time_evolution / stage_ids; checkboxy enabled unique Run; unavailable checkbox pozwala usunąć stare stage ID. |
| Lifecycle | Reset drive, Save drive; Server/Draft per field i Rebase Draft; revision conflict Refetch Scene/Rebase/Retry Save/Discard. Bez przycisku usunięcia drive. |

Defaults z istniejącego resource. Przy zmianie waveform: sinus 1 GHz/phase 0/offset 0; sinc cutoff 20 GHz/t0=5e-11 s/amplitude 1; pulse 0..1e-9 s; piecewise [0,0] i [1e-9,1]; bandwidth czyszczone. To defaults edytora, nie pomiar.

Odczyty **Validation, ID, Port mode, Projection, Peak current, Waveform/parametry, Declared bandwidth, Time origin, Activation, Publication**. **Current preview I(t)**: Preview from/to (s), wykres z wyborem i Preview sample slider; Sample time/current (A), liczba próbek max 1025. Default range: constant 0..1 ns; sinus dwa okresy; sinc t0±2/fc; pulse margines ¼ duration; piecewise pierwszy..ostatni knot. Wszystko lokalne, bez API/solver i bez rozstrzygnięcia activation/runtime clock.

## 15. N11 — Source spectrum

AntennaSpectrumComposer, AntennaSamplingPlaneFields, AntennaResourceEditor/Model, AntennaSourceSpectrumPayloadView, AntennaSpectrumExport. [S23]

| Kontrolka authoringu | Opcje / jednostki / default |
|---|---|
| FFT target object | Select objects, pusty. |
| Plane orientation | XY/+Z, XZ/−Y, YZ/+X; Custom rozpoznawany z osi. |
| Plane origin XYZ | m, puste. |
| Axis u XYZ / Axis v XYZ | 1, puste; brak cichej normalizacji. |
| Extent u/v | m, puste, >0. |
| Samples u/v | Całkowite, puste. |
| Window | rectangular (default), hann, hamming, blackman. |
| Normalization | integral_si (default), unitary_discrete. |
| Component | x (default), y, z, u, v, normal, vector_power. |
| Outside domain | error (default), zero. |
| Create actions | Refresh, Discard, Rebase explicitly, Create source FFT request. |

Axes orthonormal z tolerancją 1e-12; minimum samples 2 rectangular/3 pozostałe; product ≤10 000 000; jedno H_ant_basis output i matching port. Nowy request=spatial_fft/fem_element, generowane request/output ID. **To FFT źródła, nie m(k,ω) i nie dowód wzbudzonego modu.**

Sampling helper pokazuje budget, spacing u/v (m), FFT Δk i k-bounds (rad/m), nie coverage/convergence. Nierozkładalny legacy vector pozostaje Stored vector text; **Replace … with XYZ fields** wymaga jawnej decyzji.

Istniejący Inspector odczytuje **Validation, ID, Output, Solve stage, Asset, Content digest, Port mode, Transform, Component, Equilibrium, Modal basis, Target, Plane counts/interpolation, Outside policy, Window, Normalization, k-grid, Publication**. Edytuje Target, Source binding keep/rebind, frame/XYZ/extents/counts/window/normalization/component/outside-policy. Akcje **Refresh, Discard, Rebase, Apply spectrum, Remove spectrum (no cascade)**. Immutable request/output ID i interpolation zachowane.

**Granica:** odmowa edycji nonuniform/equilibrium/modal requests. Transverse w select tylko dla istniejącego transverse resource; nie oznacza wspieranego authoringu takiego requestu.

Published payload: **Linear/Log squared-field scale** (default linear; Log wymaga dodatnich wartości), wybór heatmap sample myszą/klawiaturą (strzałki, Home/End, Ctrl+Home/End), **Zoom out/in, Reset zoom, Inspect peak**, zoom 1..8. Odczyty k_u/k_v (rad/m), squared field z jednostką manifestu, peak, amplitudes Re/Im i u/v sections. Display budget 64 MiB, heatmap ≤64×64 display cells, przekroje ≤512. **Export full spectrum (JSON)** zapisuje lokalnie pełny manifest/k/amplitudes/power, nie tylko pooling display; bez zmiany sceny/solve.

## 16. Wspólne odczyty wyników N08–N11

AntennaCompositionPanel, antennaFieldSolutionIdentityStatus, AntennaFieldBasisPreview, AntennaExternalLeadInspectionPanel. [S24]

| Dane | Wszystkie grupy informacji |
|---|---|
| Published basis | Runtime result/error, Published solution, Asset/digest, Quantity/component, Requested/Resolved execution, Gauge policy, Field signature, port basis count, sampling carrier/topology, payload descriptor. Per port measured current (A), normalization (A), scale, current certificate digest, magnetic-basis unit/value count. |
| Stage output catalog | Status/revision, outputs, quantity IDs, assets, reuse/published, manifests, digest, diagnostic. |
| Spectrum runtime | Published k-grid, amplitude count/unit, power count, sampling realization/outside count, payload format/path. |
| Bounded basis preview | Antenna port basis select tylko przy wielu bases; do 8 positions (m) i samples. V/I (V/A), J/I (1/m²), H/I (1/m); default solution preview H/I. Bounded range i manifest ETag. |
| Raw inspection | **Inspection execution** select z run/session/runtime stage; status/qualification/field scope/run/port/output/stage revision/digests, requested/resolved execution, carrier/domain/topology, descriptors, closed-loop source/current/scale/certificates i bounded positions/raw H. |

Identity checks wiążą stage/asset/digest/catalog/session; spectrum również sampling/frame/window/normalization/component/equilibrium. To identyfikacja danych, nie certyfikat równoważności bieżących wejść.

Raw readout oznacza **inspection only / NOT VERIFIED**. H ma A/m, nie H/I. Closed-loop display może udostępnić signed per-cut-normalized quantities, nadal bez automatycznej kwalifikacji reusable basis. Sampling domain w inspection panelu renderuje JSON.stringify(manifest.sampling_carrier.domain): rzeczywisty technical JSON widoczny w UI.

Dane przez typowany klient/antennaResources: field-solutions/{solution_id}/payloads; stages/{stage_id}/output-catalog i external-lead-inspection/display/payloads; source-spectra/{output_id}/payloads. Odczyt nie uruchamia solve.

## 17. N12 — Mesh

ObjectMeshPolicyPanel, draftFromObjectMeshPolicyResource, buildObjectMeshPolicyReplaceRequest, resolveMeshInspectorLane. [S25]

Lane FEM/FDM z rozstrzygniętej dyskretyzacji, nie nazwy anteny. Unknown blokuje write. Defaults z object override lub inherited/effective policy; puste pole to dziedziczenie zgodnie z modelem. Structured controls zwykle wymagają **Use object policy**, invalid Policy JSON je blokuje. Capability ogranicza prism/sweep.

### 17.1. FEM / Policy — wszystkie grupy

| Grupa | Pola i opcje |
|---|---|
| Override | Use object policy; Enable Object Override, gdy policy dziedziczona. |
| Transactions | Apply Policy; Build Object Mesh / Apply & Build Object Mesh; Build Shared Domain; Revert. Build najpierw zapisuje dirty policy; session/pending/validation gates. |
| Summary/Effective | Object ID, Revision, Policy override/inherited, Report state, Quality state; effective target z raportu. |
| Mesh Size Presets | Calibrate for: Inherited, general_physics, micromagnetics_static, micromagnetics_relaxation, micromagnetics_frequency_domain, magnetostatics_dominated, imported_surface_cleanup. Size preset: Inherited, extremely_fine, extra_fine, finer, fine, normal, coarse, coarser, extra_coarse, extremely_coarse. Size factor. |
| Element Size Parameters | Maximum/minimum element size (m); Maximum growth rate, Curvature factor, Size from curvature, Narrow regions, Narrow region resolution; FEM order (disabled swept_prism), Mesh source tekst. |
| Thin-Film Sweep Strategy | Mesh strategy Inherited/free_tetrahedral/swept_prism (capability)/swept_hex (disabled); Element layers. Thickness distribution Inherited/fixed/linear/exponential; Thickness element ratio; Symmetric thickness Inherited/enabled/disabled; Sweep face meshing Inherited/triangular/quadrilateral. Ostatnie advanced fields disabled w bieżącym UI. |
| Interface/Transition | Interface max. element size i thickness (m), Transition distance (m lub airbox_boundary), Transition growth. Help mówi magnetic object/air interface. |
| Backend Mesh | Gmsh 2D/3D algorithm, Smoothing steps; Optimizer Inherited/Netgen/HighOrder/Relocate3D i iterations; Compute quality i Per-element quality Inherited/enabled/disabled. Boundary-layer count, thickness (m), stretching, surface/curve tags, surface/curve selectors JSON. |
| Object Core Relaxation | Use object core relaxation, Geometry name, Core/Surface/Edge maximum element size (m), Surface/Edge distance (m), Surface/Edge sampling. To relaxacja rozmiaru siatki, **nie magnetyzacji**. |
| Manual Size Field | Use Box size field, Box VIn/VOut (rozmiary w m), Box X/Y/Z min/max (m). |
| Edge/Corner Refinement | Edge max. element size, Edge thickness, Corner max. element size, Corner extent (m); Edge/Corner transition distance (m lub airbox_boundary). |
| Advanced JSON | Policy JSON textarea edytuje ten sam draft. |

Zapis=api.meshing.replaceObjectPolicy, owner/revision ACK, invalidacja report/quality/build. Build commands nie dowodzą transportu/pola anteny.

### 17.2. FEM / Quality i History

Quality: **Topology And Quality**, statystyki/rozkłady quality i size; hover histogramu przekazuje bin. Brak publikacji odróżniony od available. History filtruje po object target/snapshot: **View Mesh Pipeline**, **Restore** konkretnej policy do draftu (nie automatyczny zapis). **Diagnostics & Raw JSON Resources**: Object Mesh Report JSON, Object Mesh Quality JSON, Object Size Field JSON.

### 17.3. FDM

Odczyt: **Mesh policy=execution-plan owned, Mesh scope=selected object / magnetic support, Mesh realization=structured-grid cells, Mesh status, Origin/Spacing (m), Grid shape, Total cells, Cell participation, Region metadata, Grid fingerprint**. Akcja refresh/rebuild FDM grid=grid.build-fdm. FEM policy patches niedopuszczone. Napis magnetic support jest mylący dla anteny i nie dowodzi obecności m.

## 18. N13 — Visualization: dwie drogi danych

AntennaVisualizationView, AntennaArtifactVisualization, AntennaPublishedVisualization, VisualizationTargetInspectorPanel. [S08,S09,S26]

**Result representation**: Raw SI results (H / J / V) / Published per-ampere basis. Default basis przy aktywnym antennaFieldIntent, inaczej inspection; później lokalny wybór. Wybranie raw czyści antennaFieldIntent. To nie jest przełącznik magnet/antenna.

### 18.1. Raw SI / wspólny template

AntennaArtifactVisualization przekazuje owner object.antenna.visualization, artifactInspection=true i jawnie wybrane retained execution. **Antenna inspection execution** select pokazuje authored solve/runtime stage/status tego source. Brak retained execution daje komunikat, nie fikcyjne pole. Odczyty **Source object, Result state, Run ID, Authored solve, Runtime stage, Carrier scope**.

| Grupa | Wszystkie kontrolki/opcje i warunki |
|---|---|
| Overview | Data state, Mesh/Carrier readiness, Quantity source, Enabled pass count, owner context. Nadal może pokazywać aktywne m ze wspólnych settings. |
| Display | Visible; Bounds przy capability i Bounds opacity 0..100%; Primitive i color/opacity tylko gdy preview dopuszczony (artifactInspection nie włącza go jak zwykły obiekt); Vectors przy capability. |
| Render mode | surface / surface+edges / wireframe / points / off, filtrowane capabilities. Unsupported saved mode ma warning. |
| Quantity Source | Z field/quantity catalogs i target availability; visibility/loading/pending blokują. Bez catalog może zachować m; z catalog unsupported current choice jako disabled Unavailable / m. Nie istnieje jedna statyczna lista dla wszystkich execution. |
| Tensor projection | Tylko flow-major tensor descriptor; opcje z jego kontraktu. Zmiana tensor quantity ustawia c0 i wyłącza vectors; nie jest automatycznym spin-current polem anteny. |
| Surface Coloring | Color source: Solid, HSL orientation, Component X/Y/Z, **Magnitude \|m\| w etykiecie źródłowej**, Colormap. Scalar ogranicza do Colormap. Projection: Raw nodal/Surface faces/Thickness average Z; Solid color przy solid; Surface opacity 0..100%; Field status. |
| Scalar colorbar | Color map Viridis/Inferno/Magma/Coolwarm/Jet; Display unit tylko gdy obsługiwane; Data range/Rendered range read-only; Add colorbar to viewport. Historical surface wymaga rendered range. |
| Vectors | Vector coloring Orientation/Monochrome/Magnitude oraz X/Y/Z; field palette/range i Add vector colorbar; Vector color przy monochrome; opacity 0..100%; Thickness 0.1..8; Arrow length 0.1..5×; Arrow budget wg carrier capacity/scene cap i accounting read-only. |
| Vector placement | Centered arrows; Lift above surface przy surface/support; Extra surface gap 0..1 przy enabled; historical carrier ma opis display-only offset. Object surfaces toggles tylko wiele części. |
| Points | Gdy enabled/capability: Point color, Point opacity 0..100%. |
| Wireframe | Gdy enabled: Wireframe color, Wireframe opacity 0..100%. |
| Geometry Scope | Surface/Full przy capability; budżet i zakres z carrieru. |
| Diagnostics & overrides | Reset target; Clear child region overrides, jeśli są; Retry display update przy rejected; feedback/errors. |
| Target | Name, Target ID, Kind — kind object/region/carrier, nie klasyfikacja ferromagnet/antenna. |

**Dodatkowe potwierdzone mieszanie etykiet:** SURFACE_COLOR_SOURCE_ITEMS ma dosłownie „Magnitude |m|” dla dowolnego nieskalarnego active quantity. Nawet po wyborze J/H etykieta nadal sugeruje magnetyzację. To osobna część F01, poza samym defaultem.

Artifact inspection wymaga **3D**. 2D branch jawnie odmawia podstawienia magnetic grid/planar field. Generic zwykły panel ma PlanarVisualizationSection (quantity z catalogs/planar state); nie dowodzi to obsługi retained V/J/H w 2D. W raw shared template kamera/clipping są obecnie tekstowe: camera follows active viewport / no configured clipping plane. Per-A branch ma aktywne kontrolki niżej. To niespójność UX.

### 18.2. Published per-ampere / legacy inspection display

| Grupa | Wszystkie opcje i warunki |
|---|---|
| Source | Source object read-only; Antenna visualization solve select własnych definicji; komunikat przy braku. |
| Execution | Antenna visualization execution select, current execution + matching run/session/stage. |
| Display | Surface/Wireframe/Points/Vectors i mode off/surface/surface+edges/wireframe/points/vectors wg topology/scalar. |
| Antenna quantity | Basis: V/I (V/A), J/I (1/m²), H/I (1/m). Raw: device_potential (V), current_density (A/m²), magnetic_field (A/m). Closed-loop inspection dodatkowo V/Ic, J/Ic, H/Ic signed source-cut normalization. J tylko przy capability. |
| Snapshot | Published per-ampere basis / Inspection only · raw current · NOT VERIFIED; osobne gates. |
| Port mode | Select published ports. |
| Carrier | Disabled select konkretnego retained carrieru, bez resamplingu na primitive. |
| Component | Magnitude/x/y/z; scalar disabled Scalar. Projekcja koloru, glyph pełny XYZ. |
| Odczyty | Quantity, Field display/reason, Rendered samples, Automatic color range i carrier reason. |
| Surface Coloring | Color source fixed quantity; Color minimum/maximum w jej SI; Apply color range; Reset color range to Auto. Palette Viridis/Coolwarm; jedna skala all passes. |
| Vectors | Show vectors; Glyph length Standard/2×/4×; Vector width Standard/2×/4×; Vector occlusion Surface depth/Through surfaces; Vector component disabled Cartesian vector lub scalar Not applicable. |
| Clipping | Section enabled; Section axis x/y/z (YZ/XZ/XY); Section position 0..100% krok 0.5%; Flip section side. Wspólny workspace display state, nie geometry/solver. |
| Camera | Fit scene, Reset camera, Camera parameters, wspólny command registry. |
| Advanced/context | Resource/execution/availability; source/unit/scaling; digest/asset/geometry/material/mesh pins i diagnostyka. |

Default quantity magnetic_field_per_ampere, component magnitude, palette viridis, glyph length/width=1, vectorsOnTop=false. Nowy intent ma passes off; available/port gates. V scalar nie dostaje strzałek. Zmiana quantity/component/port czyści stary manual range. Ta gałąź rozróżnia H i m.

Published identity nie certyfikuje równoważności obecnych wejść; geometry/material edit wymaga nowego solve/runtime-validated reuse. Inspection normalized przez Ic nadal NOT VERIFIED i nie staje się FFT/LLG basis. Visualization nie uruchamia solve i nie skaluje published basis waveformem.

## 19. N14 — Debug

ObjectVisualizationDebugOwner, VisualizationDebugPanel/ModelAdapter, buildVisualizationDebugExport. [S27]

Owner wrapper: **Owner, Target, Capabilities, Actions**. Canonical registry/exact request; explicit discretization wymagane. Brak formularza fizyki.

| Grupa | Odczyty |
|---|---|
| Health | Disposition, age, stale/scanning/no-field/request-failure. Stary snapshot nie jest ready. |
| Active target | Selection kind, Target kind/ID/label, Carrier IDs, Registry source. |
| Viewport/carriers | Committed frame, Context, Drawing buffer, Client acknowledgements; carrier role, Field resource, Observations. |
| Request/transport | Planner request ID, Canonical resource key, Requested component, Geometry scope, Maximum samples, Complex view/phase; do 8 request/path/status/duration/wire bytes/ETag/timestamp rows. |
| Backend metadata | Quantity, Kind/location, Components, Field revision, Domain generation, Backend min/max/mean i jednostki. |
| Decoded payload | Dtype/FMVP, Grid, nComp, Decoded component, Points/values, Indexing/node indices, Scope. |
| Statistics/Sample values | Source/Min/Max/Mean/p01/p99/unit/finite-nonfinite-zero oraz bounded samples. Braku nie zastępuje zerami. |
| Memory | Grupy źródeł/buforów, bytes i totals. |
| Render passes | Requested/surface/vector source, adopted buffers, projection/degradation, vector build/segments. |
| Revisions/provenance | Visualization/field/topology/domain revisions, topology hash, cache ETag, rendered acknowledgement. |
| Inconsistencies/export | Detected inconsistencies, Evidence export, Raw bounded JSON. |

Akcje **Copy log, Copy snapshot, Copy resource key, Export JSON**, lokalnie, bez materializacji/solve. Carrier role=magnetic może wynikać z legacy diagnostic mapping: manifestRenderableCarriers oznacza fallback non-air jako magnetic, lecz diagnosticOnly=true i fieldCapable=false. Nie wolno uznać tego za aktywację m. [S28]

## 20. Dodatkowe Physics → Charge transport / Closure / Source cut

TransportAuthoringInspector, CurrentFields, StructuredCurrentClosureFields, TransportCollectionFields/Model. [S29]

Bieżący FMS: antenna_charge, static one-way Ohmic/zero_mean, closure antenna_loop, cut inlet_cut. Closure/Cut Inspectors przekazują ten sam transport i focus, nie konkurencyjny model źródła.

| Grupa | Wszystkie pola charge i warunki |
|---|---|
| Resource | Select existing/New resource, przy fixed resource ograniczony; unknown schema Opaque payload read-only. |
| Identity/model | Name (existing read-only); Model prescribed_density/ohmic_poisson/magnetoresistive_poisson M2; Coupling one_way/bidirectional. Model/coupling disabled przy closure. M2 jest jawną opcją, nie automatyczną magnetyką. |
| Closure | Closed-geometry current closure switch, Closure id; per cut source-cut id/circuit id/object id/region id, plane axis x/y/z, offset m, normal positive/negative, drive id, potential jump V; Add/Remove source cut wg focus. |
| Bez closure | Conservative RT0 current view JSON; prescribed Current density vector A/m². |
| Ohmic domain/materials | Domain scope object/region; Material scope; Conductivity, Parallel conductivity, Perpendicular conductivity, Anomalous Hall conductivity, S/m. |
| Boundaries | Boundary ID; equipotential_current_terminal/voltage_electrode/normal_current_electrode/insulating. Potential V lub Outward current density A/m² wg kind; Surface object/ID/outward orientation; Add/Remove explicit surface. |
| Gauge | dirichlet_reference / zero_mean / terminal_reference. |
| Solver | Engine, Relative/Absolute tolerance, Maximum iterations, Physical residual version, Operator version, Reciprocal nonlinear policy M2 JSON, jeśli draft ją zawiera. |
| Pozostałe | Current-source time envelope JSON (1), Legacy solve region, Legacy conductivity S/m. |
| Actions | Add/remove domain/material/boundary row; Create/Replace i Delete znanego resource; validation z clone-only capability/readout, conflict Server/Draft i Rebase Draft. API create/replace/deleteCurrentTransport z revision/scope. |

Podczas authoringu wyświetlane są Qualification, Requested lane, Resolved lane, reason i semantic issues. Closure/Cut wrappers pokazują global scope i semantic_only text mimo konkretnych object/region refs: właściciel jest zachowany, ale nagłówek źle tłumaczy przestrzenny zakres.

Spin transport jest **inną rodziną**: id/schema/current source/mode, spin materials/boundaries/interfaces, requested discretization/device/precision/mode, constitutive version. Nie występuje w obecnym FMS i nie aktywuje się z role=antenna. Inwentarz nie traktuje dowolnego świadomie dodanego modułu spinowego jako konfiguracji tej nieferromagnetycznej anteny. Jego audyt wymaga konkretnego authored resource.

## 21. Quantity — rozdzielenie odpowiedzialności

| Etap | Ustalenie |
|---|---|
| Frontend default | DEFAULT_OBJECT_VISUALIZATION: m/orientation/magnetic color; resolveTargetVisualization nie przyjmuje authored physics context. [S08] |
| Backend default | default_planar_visualization_state i default_slice_visualization_for_presentation też wybierają m. [S11] |
| Lista UI | visualizationQuantityItems: targetKind/catalogs/availability bez SceneObject/modules. Zachowuje unsupported current selection. Etykieta Magnitude m jest hardcoded. [S10] |
| Snapshot quantities | Czysty master build_quantities chroni external-lead inspection, nie FieldOnly. **Przywrócony WIP ma już guard obu** — nie przypisujemy braku tej poprawki WIP. [S30] |
| Publiczny v2 catalog | get_quantities_catalog/annotate_runtime_quantity_state to inny readmodel: brak resolved capabilities → unknown/requestable=false, nie available. [S12] |
| Retained V/J/H | inspection_field_provider ma V_electric/J_charge/H_ant, exact stage/carrier/revision. Catalog lane artifact_inspection_read_only, materializable=false. [S12] |
| compute_fields | Resolved registry i supported quantities; nie zastępuje historycznych antenna carriers. [S31] |

Naprawa musi objąć obiekt/fizykę, kanoniczny catalog, field-store/API facade i właściwą materializację. Nie wystarczy poprawić label ani wpisać V/J/H jako zawsze available. Przed wykonaniem może istnieć sama geometria bez numerical quantity.

## 22. Co przedstawia obecna geometria i czego brakuje dla GS/GSG

Właściciele: authoring layout oraz buildAuthoredMicrostripGeometry/buildAuthoredCpwGeometry, PrimitiveObjectLayer. [S32]

Odczytany projekt ma **zamknięty microstrip**, signal ponad szerokim return, inlet/outlet bridges, source-cut w inlet. Port loop_port: signal(+1), return(−1), source_cut_rt0/minus_outward. To deklaracje orientacji/normalizacji, nie zmierzony prąd.

Źródło kopii projektu: D:/git/storage/runtimes/antenna-transport-e2e-20261011-5e7f0d529ca256ef/docker-volume-dev/a6439f47d1334aca899a0498da10f89e/runs/projects/fem-antenna-closed-loop-ui-before-proxy-fix-20261020.fms; SHA256 e22a535f78c4388a2087d1988ef87782f4f06d6439dbc10cdc3d4cbe7c958302. Nie zakładamy identyczności z aktualnym API.

W kopii: 1 port loop_port, 1 solve inspect_loop/output loop_inspection, sampling object sampling; brak projections/drives/spectra/regional/spin. sampling ma role=geometry, również bez magnetyki. Source potential jump 0.25 V; to zadane wejście, nie current certificate. Węzły warunkowe w dokumencie opisują dopuszczony kodem model, nie udają obecności ich instancji w tym projekcie.

Braki UX:

- Brak stałej legendy S/G/G lub Signal/Return/Source na przewodniku.
- Złoty kolor nie identyfikuje portu, obserwacji ani cut.
- Szeroka płyta i mostki nie tłumaczą same zamknięcia obwodu.
- ID i normal w terminalach nie odpowiadają przestrzennie „tu plus/minus, tędy powrót”.
- V i H nie zastępują podglądu J. Strzałki prądu powinny być rzeczywistym J albo wyraźnie nazwanym schematem authoringu.

To nie jest typowy coplanar GSG. Audyt nie zmienia geometrii. Dalszy projekt powinien osobno pokazać obwód authoringu z legendą/source-cut i wynikowe J na własnym carrierze.

## 23. Problemy do naprawy po dokumentacji

| ID | Priorytet | Źródło i problem | Kryterium domknięcia |
|---|---|---|---|
| F01 | P1 | m/orientation defaults i etykieta Magnitude m bez physics context [S08–S12] | Wspólny kontrakt kontekstu/catalogu; brak m requests dla nieferromagnetycznego source; V/J/H tylko na własnym execution/carrierze. |
| F02 | P2 | Niepełny objectRole w nodes/ref [S03,S04] | Jeden rozstrzygnięty kontekst sceny/fizyki, bez zmiany wszystkich kinds na antenna. |
| F03 | P1 | Edit Geometry kieruje do object.geometry [S07] | Przycisk i tree otwierają ten sam dedykowany Inspector. |
| F04 | P1 | Topological Charge dostępne bez magnetyzacji [S13] | Dostępność według jawnej fizyki/danych i zgodność General/tree. Default off nie usprawiedliwia opcji. |
| F05 | P2 | Magnetic opisy/presety Mesh [S25] | Shared panel zachowuje właściwe parametry i zna zakres/fizykę. |
| F06 | P2 | Raw i per-A mają różne controls/availability [S09,S26] | Jeden spójny template i jawne representation/source/execution/carrier/unit/qualification. |
| F07 | P2 | Regional field drive obok circuit workflow [S16] | B w T odróżnione od I w A i solved H, bez automatycznego źródła. |
| F08 | P2 | Brak GS/GSG/source/return legendy [S17,S32] | Czytelny authoring oddzielony od wyniku J z ownerem. |
| F09 | P2 | Brak jawnego type/physics w General; technical ID/JSON [S07,S24] | Oddzielne presentation type i authored physics; czytelne odczyty. |
| F10 | P2 | Create port v2 nie obejmuje loop v3; brak pełnego Create solve [S18,S20] | Kompletne wspierane authoring z powodem blokad, bez usuwania walidacji naukowej. |

P1 jest blokadą poprawnego przekazu UI przed uznaniem tego przepływu za gotowy, nie dowodem awarii solvera. F06/F08/F10 są także problemami kompletności/ergonomii. Nie wszystkie niejasności oznaczają pomieszanie równań.

## 24. Pokrycie i weryfikacja

| Obszar | Wynik |
|---|---|
| Węzły | 14/14 podstawowych rodzajów, każdy z route/rolą/Inspectorem. |
| Warunkowe zasoby | Port/Solve/Projection/Drive/Spectrum, filtry właściciela i brak fikcyjnych instancji. |
| Physics | Scope/module dispatch, charge/closure/cut obecnego modelu. Brak aktywacji fizyki przez role. |
| Kontrolki | Sekcje 5–20: edycja/odczyty/opcje/jednostki/defaulty/gates/actions. Shared template włączony do zakresu. |
| Przykład | Odczytany saved FMS; brak magnetyki źródła i sampling. Nie jest snapshotem bieżącego API. |
| Runtime | Dla tego audytu nie wykonano buildu, symulacji ani GUI mutation. |
| Walidacja dokumentu | Kontrola ścieżek/symboli źródeł, SHA256, linków i obecności N01–N14; brak nierozwiązanych Git conflicts. |

| Realizacja | Co kwalifikuje ten audyt |
|---|---|
| FDM CPU | Kod/UI contracts; wykonanie/numerics NOT VERIFIED. |
| FDM GPU | Kod/UI contracts; wykonanie/numerics NOT VERIFIED. |
| FEM CPU | Kod/UI contracts; wykonanie/numerics NOT VERIFIED. |
| FEM GPU | Kod/UI contracts; wykonanie/numerics NOT VERIFIED. |

**F01–F10 nie naprawiono w ramach dokumentu.** Wcześniejsze poprawki wyglądu i WIP pozostają zachowane. Dalsza implementacja wymaga builda tych bajtów w grupie Docker worktree, browser regression wszystkich ścieżek/contextu, stabilności Object/Airbox i WebGL, osobno retained V/J/H z owner/revision. Nie należy ponawiać nieznanego terminalnie Mesh submission tylko dla zrzutu.

## 25. Indeks źródeł

Każdy wpis podaje repozytoryjny path i stabilny symbol, nie sam numer linii. Sąsiedni manifest sources.json przypina SHA256 odczytanych plików i różnicę do HEAD. Numery linii służą tylko nawigacji.

| Źródło | Plik i symbole |
|---|---|
| S01 | [crates/fullmag-authoring/src/scene.rs](../../crates/fullmag-authoring/src/scene.rs) — `SceneObject` |
| S02 | [apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts](../../apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts) — `sceneObjectRole` |
| S03 | [apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts](../../apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts) — `buildObjectExplorerNode, antennaCompositionNodes`<br>[apps/control-room/src/modules/explorer/builders/explorerNodeContract.ts](../../apps/control-room/src/modules/explorer/builders/explorerNodeContract.ts) — `visualizationDebugNode` |
| S04 | [apps/control-room/src/modules/explorer/explorerSelection.ts](../../apps/control-room/src/modules/explorer/explorerSelection.ts) — `selectionRefFromNode`<br>[apps/control-room/src/kernel/selection/selectionTypes.ts](../../apps/control-room/src/kernel/selection/selectionTypes.ts) — `SelectionRef` |
| S05 | [apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx](../../apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx) — `INSPECTOR_ROUTE_CONTRIBUTIONS` |
| S06 | [apps/control-room/src/modules/explorer/builders/physicsGraphTree.ts](../../apps/control-room/src/modules/explorer/builders/physicsGraphTree.ts) — `buildPhysicsGraphObjectNode, buildModuleNode`<br>[apps/control-room/src/modules/inspector/panels/PhysicsGraphModuleInspectorPanel.tsx](../../apps/control-room/src/modules/inspector/panels/PhysicsGraphModuleInspectorPanel.tsx) — `PhysicsGraphModuleInspectorPanel`<br>[apps/control-room/src/modules/inspector/panels/ModelTreeOverviewInspectorPanels.tsx](../../apps/control-room/src/modules/inspector/panels/ModelTreeOverviewInspectorPanels.tsx) — `ObjectPhysicsScopeInspectorPanel`<br>[apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverview.tsx](../../apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverview.tsx) — `PhysicsInspectorOverview` |
| S07 | [apps/control-room/src/modules/inspector/panels/ObjectGeneralPanel.tsx](../../apps/control-room/src/modules/inspector/panels/ObjectGeneralPanel.tsx) — `ObjectGeneralPanel`<br>[apps/control-room/src/modules/inspector/panels/objectGeneralPanelModel.ts](../../apps/control-room/src/modules/inspector/panels/objectGeneralPanelModel.ts) — `resolveObjectGeneralPanelModel`<br>[apps/control-room/src/shared/domain/physics/objectMagneticModel.ts](../../apps/control-room/src/shared/domain/physics/objectMagneticModel.ts) — `hasEmptyObjectMagneticModel`<br>[apps/control-room/src/kernel/visualization/primitiveSurfaceColor.ts](../../apps/control-room/src/kernel/visualization/primitiveSurfaceColor.ts) — `primitiveMonoColorForRole, resolvePrimitiveSurfaceColor` |
| S08 | [apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts](../../apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts) — `DEFAULT_OBJECT_VISUALIZATION, resolveTargetVisualization` |
| S09 | [apps/control-room/src/modules/inspector/panels/ObjectVisualizationEntryPanel.tsx](../../apps/control-room/src/modules/inspector/panels/ObjectVisualizationEntryPanel.tsx) — `ObjectVisualizationPanel`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationObjectModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationObjectModel.ts) — `isAntennaVisualizationObject`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaArtifactVisualization.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaArtifactVisualization.tsx) — `AntennaArtifactVisualization, useAntennaInspectionSource`<br>[apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx](../../apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx) — `VisualizationTargetInspectorPanel, useObjectVisualizationPanelState` |
| S10 | [apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts](../../apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts) — `visualizationQuantityItems, SURFACE_COLOR_SOURCE_ITEMS, SCALAR_COLOR_PALETTE_ITEMS`<br>[apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx](../../apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx) — `VisualizationQuantitySection, VisualizationSurfaceColoringSection, VisualizationVectorsSection`<br>[apps/control-room/src/modules/inspector/visualization/presentationSemantics.ts](../../apps/control-room/src/modules/inspector/visualization/presentationSemantics.ts) — `SHARED_VECTOR_COLOR_MODE_ITEMS`<br>[apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx](../../apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx) — `PlanarVisualizationSection` |
| S11 | [crates/fullmag-api/src/schemas/visualization_state.rs](../../crates/fullmag-api/src/schemas/visualization_state.rs) — `default_planar_visualization_state`<br>[crates/fullmag-api/src/router_v2/handlers/visualization/display.rs](../../crates/fullmag-api/src/router_v2/handlers/visualization/display.rs) — `default_slice_visualization_for_presentation` |
| S12 | [crates/fullmag-api/src/router_v2/handlers/data/quantities.rs](../../crates/fullmag-api/src/router_v2/handlers/data/quantities.rs) — `get_quantities_catalog, annotate_runtime_quantity_state`<br>[crates/fullmag-api/src/router_v2/handlers/data/inspection_field_provider.rs](../../crates/fullmag-api/src/router_v2/handlers/data/inspection_field_provider.rs) — `resolve, require_binary_pins`<br>[apps/control-room/src/kernel/api/quantityIds.ts](../../apps/control-room/src/kernel/api/quantityIds.ts) — `isScalarSpatialQuantityId`<br>[apps/control-room/src/kernel/resources/antennaResources.ts](../../apps/control-room/src/kernel/resources/antennaResources.ts) — `useAntennaFieldSolutionResource`<br>[apps/control-room/src/kernel/api/apiPaths.ts](../../apps/control-room/src/kernel/api/apiPaths.ts) — `antenna`<br>[apps/control-room/src/kernel/api/ControlRoomApi.ts](../../apps/control-room/src/kernel/api/ControlRoomApi.ts) — `commitTransaction` |
| S13 | [apps/control-room/src/kernel/object-extensions/objectExtensionRegistry.ts](../../apps/control-room/src/kernel/object-extensions/objectExtensionRegistry.ts) — `OBJECT_EXTENSION_REGISTRY, isCommittedObjectRoot`<br>[apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.ts](../../apps/control-room/src/kernel/object-extensions/ObjectExtensionsSectionModel.ts) — `resolveObjectExtensionsSectionModel`<br>[apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.tsx](../../apps/control-room/src/modules/inspector/extensions/ObjectExtensionsSection.tsx) — `ObjectExtensionsSection` |
| S14 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaGeometryPanel.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaGeometryPanel.tsx) — `AntennaGeometryPanel`<br>[apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditor.tsx) — `MicrostripGeometryEditor`<br>[apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts) — `antennaLayoutDimensionFields, MICROSTRIP_LOOP_FIELDS, microstripCircuitDraft, buildMicrostripCircuitPatch`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaPlacementEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaPlacementEditor.tsx) — `AntennaPlacementEditor`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaPlacementModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaPlacementModel.ts) — `antennaPlacementTargets, resolveAntennaPlacement` |
| S15 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionSummaryPanel.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionSummaryPanel.tsx) — `AntennaCompositionSummaryPanel`<br>[apps/control-room/src/modules/explorer/antennaNavigation.ts](../../apps/control-room/src/modules/explorer/antennaNavigation.ts) — `antennaNavigationLinks` |
| S16 | [apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx](../../apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx) — `AntennaObjectPanel`<br>[apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts](../../apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts) — `antennaWaveformDefaults` |
| S17 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalsPanel.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalsPanel.tsx) — `AntennaTerminalsPanel`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalSourceModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalSourceModel.ts) — `antennaTerminalSourceState`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalSourceDetails.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalSourceDetails.tsx) — `AntennaTerminalSourceDetails`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalPreparationModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaTerminalPreparationModel.ts) — `buildAntennaTerminalPreparationTransaction` |
| S18 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx) — `AntennaConductorPanel, AntennaCompositionPanel`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaConductorAuthoring.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaConductorAuthoring.tsx) — `AntennaConductorAuthoring`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaConductorMaterialEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaConductorMaterialEditor.tsx) — `AntennaConductorMaterialEditor`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaConductorMaterialModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaConductorMaterialModel.ts) — `buildConductorMaterialTransaction`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaPortComposer.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaPortComposer.tsx) — `AntennaPortComposer`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaPortComposerModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaPortComposerModel.ts) — `buildAntennaPortCreationTransaction` |
| S19 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaPortEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaPortEditor.tsx) — `AntennaPortEditor`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaPortEditorModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaPortEditorModel.ts) — `committedAntennaPortScene`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaResourceEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaResourceEditor.tsx) — `AntennaResourceEditor` |
| S20 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx) — `AntennaSolutionPanel`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaSolveTargetsEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaSolveTargetsEditor.tsx) — `AntennaSolveTargetsEditor`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaStudyStageComposer.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaStudyStageComposer.tsx) — `AntennaStudyStageComposer`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldSolveAuthoring.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldSolveAuthoring.tsx) — `AntennaFieldSolveAuthoring` |
| S21 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaProjectionDriveComposer.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaProjectionDriveComposer.tsx) — `AntennaProjectionDriveComposer`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaResourceEditorModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaResourceEditorModel.ts) — `buildAntennaResourceTransaction` |
| S22 | [apps/control-room/src/modules/inspector/panels/antenna/SolvedAntennaDriveEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/SolvedAntennaDriveEditor.tsx) — `SolvedAntennaDriveEditor`<br>[apps/control-room/src/modules/inspector/panels/antenna/SolvedAntennaDriveEditorModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/SolvedAntennaDriveEditorModel.ts) — `waveformDefaults`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaPiecewisePointsEditor.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaPiecewisePointsEditor.tsx) — `AntennaPiecewisePointsEditor`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaDrivePreview.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaDrivePreview.tsx) — `AntennaDrivePreview` |
| S23 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaSpectrumComposer.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaSpectrumComposer.tsx) — `AntennaSpectrumComposer`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaSamplingPlaneFields.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaSamplingPlaneFields.tsx) — `AntennaSamplingPlaneFields`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaSourceSpectrumPayloadView.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaSourceSpectrumPayloadView.tsx) — `AntennaSourceSpectrumPayloadView`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaSpectrumExport.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaSpectrumExport.tsx) — `AntennaSpectrumExport` |
| S24 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx) — `AntennaCompositionPanel`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionRuntime.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionRuntime.ts) — `antennaFieldSolutionIdentityStatus`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreview.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreview.tsx) — `AntennaFieldBasisPreview`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaExternalLeadInspectionPanel.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaExternalLeadInspectionPanel.tsx) — `AntennaExternalLeadInspectionPanel` |
| S25 | [apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx](../../apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx) — `ObjectMeshPolicyPanel, MESH_SIZE_CALIBRATIONS`<br>[apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts](../../apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts) — `draftFromObjectMeshPolicyResource, buildObjectMeshPolicyReplaceRequest`<br>[apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts](../../apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts) — `resolveMeshInspectorLane`<br>[apps/control-room/src/modules/inspector/panels/mesh-details/MeshBuildHistorySection.tsx](../../apps/control-room/src/modules/inspector/panels/mesh-details/MeshBuildHistorySection.tsx) — `MeshBuildHistorySection` |
| S26 | [apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationPanel.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationPanel.tsx) — `AntennaVisualizationView, AntennaPublishedVisualization`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationQuantity.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationQuantity.ts) — `ANTENNA_RAW_QUANTITIES, ANTENNA_CLOSED_LOOP_QUANTITIES`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaColorRangeControl.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaColorRangeControl.tsx) — `AntennaColorRangeControl`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaClippingControls.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaClippingControls.tsx) — `AntennaClippingControls`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaCameraControls.tsx](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaCameraControls.tsx) — `AntennaCameraControls`<br>[apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreviewModel.ts](../../apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreviewModel.ts) — `ANTENNA_BASIS_QUANTITIES` |
| S27 | [apps/control-room/src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.tsx](../../apps/control-room/src/modules/inspector/panels/visualization-debug/VisualizationDebugPanel.tsx) — `VisualizationDebugPanel`<br>[apps/control-room/src/modules/inspector/panels/visualization-debug/useVisualizationDebugPanelModel.ts](../../apps/control-room/src/modules/inspector/panels/visualization-debug/useVisualizationDebugPanelModel.ts) — `VisualizationDebugPanelModelAdapter`<br>[apps/control-room/src/modules/inspector/panels/visualization-debug/visualizationDebugExport.ts](../../apps/control-room/src/modules/inspector/panels/visualization-debug/visualizationDebugExport.ts) — `buildVisualizationDebugExport` |
| S28 | [apps/control-room/src/kernel/selection/manifestRenderableCarriers.ts](../../apps/control-room/src/kernel/selection/manifestRenderableCarriers.ts) — `diagnosticOnly` |
| S29 | [apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx](../../apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx) — `CurrentFields, StructuredCurrentClosureFields, CurrentTransportInspectorPanel`<br>[apps/control-room/src/modules/inspector/panels/TransportCollectionFields.tsx](../../apps/control-room/src/modules/inspector/panels/TransportCollectionFields.tsx) — `TransportCollectionFields`<br>[apps/control-room/src/modules/inspector/panels/TransportCollectionFieldsModel.ts](../../apps/control-room/src/modules/inspector/panels/TransportCollectionFieldsModel.ts) — `chargeMaterialFields, chargeBoundaryKinds` |
| S30 | [crates/fullmag-api/src/quantities.rs](../../crates/fullmag-api/src/quantities.rs) — `build_quantities` |
| S31 | [crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs](../../crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs) — `compute_fields_materialization_requirements` |
| S32 | [apps/control-room/src/shared/domain/geometry/authoredMicrostripGeometry.ts](../../apps/control-room/src/shared/domain/geometry/authoredMicrostripGeometry.ts) — `buildAuthoredMicrostripGeometry, buildAuthoredCpwGeometry`<br>[apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx](../../apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx) — `PrimitiveObjectLayer`<br>[apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayerModel.ts](../../apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayerModel.ts) — `createPrimitiveObjectGeometry` |

Materiały kanoniczne i historyczne:

- [Nota fizyczna 0950](../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md) — właściciel semantyki conductor/basis/target/FFT; ta nota nie jest dowodem wykonania obecnej sceny.
- [Resource-first Control Room API v2](../specs/resource-first-control-room-api-v2.md) — kontrakt zasobów i revision.
- [Kontrakt Inspectorów anteny z 08.10](../superpowers/plans/2026-10-08-antenna-inspectors-ui-contract.md) — wcześniejszy zamiar produktu; aktualny kod rozstrzyga obecność kontrolek.
- [Piny źródeł tego audytu](2026-10-20-antenna-explorer-inspectors-audit.sources.json) — hash treści, symbole i różnica wobec przypiętego HEAD.
