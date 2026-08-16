# Zakres, obecność i aktywacja modułów fizycznych

Status: kontrakt normatywny dla autora sceny, `ProblemIR`, planera i Control
Room. Dokument nie podnosi samodzielnie statusu wykonawczego żadnego backendu.

(problem-statement)=
## 1. Problem fizyczny

Scena opisuje problem fizyczny, a nie listę struktur danych backendu. Moduł
fizyczny istnieje wtedy i tylko wtedy, gdy użytkownik zapisał odpowiadający mu
rekord w Python DSL albo w autorze UI. Wartość napędu równa zero nie usuwa
modułu: jest jawnym stanem `inactive`/`configured` i pozostaje częścią
proweniencji. Brak rekordu prądu nie jest równoważny z rekordem prądu o
`j = 0`.

Reguła ta jest istotna dla sprzężeń: spin transport, STT/SOT i pole Oersteda
mogą zależeć od nazwanego źródła prądu, lecz nie wolno ich awansować do stanu
aktywnego, gdy źródło nie istnieje. Zależność niespełniona jest publikowana
jako `blocked`, nigdy jako cichy domyślny prąd.

(governing-equations)=
## 2. Równania i wielkości fizyczne

Graf nie zmienia równań konstytutywnych rodzin fizycznych. Zamraża jedynie
ich obecność, zakres i zależności. Dla dynamicznego źródła prądu obowiązuje
etapowe sprzężenie:

```{math}
:label: graph-stage-coupling
(m_k,\,j_{c,k},\,t_k) \longrightarrow H_{\mathrm{oe},k}
\longrightarrow \mathrm{RHS}_{\mathrm{LLG},k}.
```

Krawędź zależności jest aktywna wyłącznie wtedy, gdy moduł źródłowy i docelowy
istnieją oraz przechodzą walidację zakresu.

(symbols-and-si-units)=
### 2.1. Wielkości i jednostki

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf j_c$ | konwencjonalna gęstość prądu | $\mathrm{A\,m^{-2}}$ |
| $\mathbf H_\mathrm{oe}$ | pole Oersteda użyte w RHS LLG | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_\mathrm{ext}$ | zadane pole indukcji | $\mathrm T$ |
| $\mu_s$ | potencjał spinowy | $\mathrm V$ |
| $\lambda_\mathrm{sf}$ | długość relaksacji spinowej | $\mathrm m$ |
| $\sigma$ | przewodność elektryczna | $\mathrm{S\,m^{-1}}$ |

`j_c` jest wielkością podpisaną względem konwencjonalnego kierunku prądu.
Wartość `0 A/m²` jest fizycznym stanem wyłączenia napędu, nie brakiem modułu.
Konwersja $\mathbf B=\mu_0\mathbf H$ odbywa się wyłącznie w miejscu, które
wymaga indukcji lub energii Zeemana.

(assumptions-and-validity)=
## 3. Założenia i zakres ważności

Graf jest kontraktem semantycznym, a nie dyskretyzacją. Zakłada stabilne
identyfikatory obiektów/regionów, deterministyczną normalizację i jawne
wersjonowanie rewizji sceny. Nie rozstrzyga geometrii zwrotu prądu, siatki,
kwadratury Biota--Savarta, kroku czasowego ani zbieżności solvera. Te warunki
muszą być dowiedzione osobnymi bramami FEM/FDM.

(discrete-realization)=
### 3.1. Zakres i domena rozwiązania

`applies_to` odpowiada temu, na jakie obiekty/regiony działa moduł fizycznie;
`solve_domain` odpowiada obszarowi, w którym rozwiązywane jest jego równanie.
Te pola są niezależne i nie mogą być wyprowadzone z kolejności wektorów,
właściciela siatki ani etykiety UI.

Dozwolone zakresy:

| Zakres | Semantyka |
|---|---|
| `global` | całe zadanie, np. jednorodne pole zewnętrzne |
| `object` | jeden obiekt o stabilnym `object_id` |
| `region` | jawny region obiektu o stabilnym `region_id` |
| `interface` | dokładnie jedna para stron interfejsu |
| `cross_object` | sprzężenie obejmujące wymienione obiekty |
| `unresolved` | zachowany rekord, którego celu nie można bezpiecznie rozstrzygnąć |

W FEM `solve_domain` mapuje się na markery elementów i jawne atrybuty ścian,
a interfejs na parę stron z orientacją normalnej. W FDM mapuje się na maskę
komórek i maskę ścian. Identyfikatory i proweniencja pozostają wspólne; różna
jest tylko realizacja dyskretna.

Legacy `CurrentTransport.solve_region` nie oznacza zakresu globalnego. Jeżeli
kanoniczne `domain` jest puste, normalizer mapuje `solve_region` dokładnie na
`object { object_id = solve_region }`. Walidacja wymaga istniejącego,
jednoznacznego `object_id`; nazwy regionów, etykiety wyświetlane i zgadywanie
po kolejności są niedozwolone. Gdy `domain` jest jawne, stanowi jedyne źródło
zakresu i legacy pole nie może zmieniać jego znaczenia.

(round-trip-and-failure-semantics)=
## 4. Obecność, aktywacja i błędy

| Stan | Znaczenie |
|---|---|
| `configured` | rekord został zapisany, lecz nie ma jeszcze uruchomienia |
| `active` | rekord i wszystkie nazwane zależności są spełnione, a napęd jest włączony |
| `inactive` | rekord istnieje, lecz jawny napęd/envelope ma wartość wyłączoną lub zero |
| `blocked` | zależność, zakres albo warunek walidacji nie jest spełniony |
| `unsupported` | rekord zachowany bez interpretacji przez bieżący kontrakt |

`capability` opisuje możliwość wybranego lane (np. `reference_executable`,
`development_executable`, `semantic_only`). Nie wolno utożsamiać `active` z
kwalifikacją produkcyjną.

Każdy znany moduł publikuje ponadto cienkie, kanoniczne metadata
`presentation.family` i `presentation.label`. `family` jest stabilnym,
maszynowym wariantem modelu, na przykład `zhang_li`, `slonczewski` albo
`prescribed_sot`; `label` jest domyślną angielską nazwą naukową. Metadata są
wyliczane wyłącznie przez normalizer z typowanego wariantu rodzinnego. Nie
zawierają współczynników, pól materiałowych ani kopii `family_payload`, nie
sterują równaniami i nie są dowodem capability. Nieznany zachowany rekord ma
rodzinę `unsupported` i etykietę `Unsupported physics record`.

(python-api)=
## 5. Publiczny Python API

Python udostępnia niezmienny opis zakresu i aktywacji. Parametry konstytutywne
pozostają w klasach rodzinnych; graf przechowuje tylko tożsamość, zakres,
zależności i stan.

```python
# %%
from fullmag import PhysicsScope

local = PhysicsScope(kind="region", object_id="film", region_id="free")
assert local.to_ir()["kind"] == "region"
```

| Python | Typ | Domyślnie | Jednostka SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| `PhysicsScope.kind` | `Literal['global','object','region','interface','cross_object','unresolved']` | `required` | `$1$` | `one of the tagged scope variants; unknown values are unresolved` | `fizyczny zakres modułu` | `FEM/FDM wspólna semantyka; realizacja lane-specific` | `physics_graph.modules[].applies_to[].kind` |

(problem-ir)=
## 6. ProblemIR i lowering

`ProblemIR.physics_graph` jest opcjonalnym, wersjonowanym członem. Brak członu
pozostaje kompatybilny ze starym IR, natomiast obecny graf jest walidowany
przed wyborem backendu. Normalizacja authoringu jest jedynym miejscem, w którym
rodzinne rekordy są mapowane na moduły i krawędzie.

Jeżeli graph jest obecny, stanowi filtr wykonania rodzinnych payloadów.
Wyłącznie moduły `active` albo `configured` mogą zostać obniżone do operatora;
`inactive`, `blocked`, `unsupported` i `unresolved` pozostają w proweniencji,
ale nie mogą uruchamiać current transport, torque ani Oersteda. Payload bez
odpowiadającego mu stabilnego `kind`/`id` jest błędem planowania, nie ścieżką
legacy. Gdy graphu nie ma, zachowana jest kompatybilność starszego ProblemIR.

Workflow może wykonać wąską, stage-local mutację
`set_spin_torque_enabled(module_id, enabled)`. Materializator wymaga dokładnie
jednego modułu graphu o podanym ID i `kind="spin_torque"`, zgodnego typowanego
payloadu `spin_torque_modules[]`, po czym atomowo ustawia aktywację modułu i
status wszystkich krawędzi wchodzących na odpowiednio `active` albo
`inactive`. Mutacja nie zmienia `authored_state`, `family_payload`, scope'u ani
zależności. Wyłączony torque nie może zalegalizować niezerowego solved-current
transportu do magnetycznego sinku; wyjątek planera dotyczy wyłącznie pełnego
zerowego zestawu terminali i służy relaksacji stanu początkowego.

`physics_graph.modules[].presentation` jest obowiązkowe w graphie
znormalizowanym z `SceneDocument` i zachowuje jedynie `family` oraz `label`.
Czytnik starszego `ProblemIR` bez tych metadanych pozostaje kompatybilny,
ponieważ planner nie używa prezentacji do wyboru operatora; API może jednak
pokazać brak metadanych jako nierozstrzygnięty wariant zamiast zgadywać z
tekstu identyfikatora.

(implementation-mapping)=
## 7. Mapowanie implementacyjne

Planner zachowuje wspólną semantykę i dopiero potem tworzy lane-specific
identities: FEM marker IDs oraz FDM cell-mask IDs. API publikuje cienki zasób
v2, Explorer używa `kind` do rozmieszczenia węzłów oraz `presentation.family`
do wyboru rodzinnego Inspectora, a Inspector pokazuje wariant, scope,
activation, dependency i capability. Publiczny runtime nie relabeluje
semantic identity jako certyfikatu topologii bez osobnego dowodu.
W szczególności `capability=semantic_only` jest prezentowane jako stan
wykonawczo niedostępny, a nie `ready`; moduł pozostaje wybieralny, ponieważ
jego authored intent, scope i zależności nadal wymagają inspekcji.
Znane `kind` graphu są przy wyborze mapowane po stabilnym `module.id` do
istniejących rodzinnych Inspectorów current transport, spin transport,
interfejsu, torque, Oersted albo regional field drive. Nieznany wariant
pozostaje w ogólnym, tylko do odczytu Inspectorze graphu. Interfejs zachowuje
również ID właściciela z pierwszej kanonicznej zależności spin transport.

Authoring nowego current transport dziedziczy jawny zakres bieżącego
zaznaczenia. Zaznaczony obiekt może utworzyć zgodny wstecznie
`prescribed_density` przez dokładne `solve_region=object_id`, przy czym draft
zachowuje także `domain=[{object_id}]` na wypadek wyboru pełnego solve
Poissona. Zaznaczony region nie może zostać obniżony do `solve_region`, bo
rozszerzyłoby to fizyczny nośnik źródła na cały obiekt; taki kontekst zaczyna
od `ohmic_poisson` i dokładnego
`domain=[{object_id, region_id}]`. UI nie oferuje `prescribed_density`, gdy
bieżący domain jest regionalny albo wielodomenowy i nie ma bezstratnej
reprezentacji w historycznym kontrakcie. Edycja istniejącego zasobu zawsze
używa zakresu samego zasobu, nie chwilowego zaznaczenia.

`Physics -> Add Physics` jest również jedyną paletą tworzenia typowanych
zasobów spinowych, których nie wolno syntetyzować jako pustych kolekcji
Explorera. `Spin Transport / SHE` otwiera rodzinny draft
`physics.spin-transport`; dla zaznaczonego obiektu lub regionu jego początkowy
`domain` zachowuje dokładne `object_id` i opcjonalne `region_id`. `Spin
Interface` otwiera draft `physics.spin-interface` bez wymyślonego właściciela.
Mutacja interfejsu pozostaje zablokowana, dopóki użytkownik jawnie nie wybierze
istniejącego `owner_spin_transport_id`. Obie akcje są wspólne dla FEM i FDM,
korzystają z istniejących zasobów API v2 i nie deklarują fikcyjnych
`interaction.*` capability. Dopiero udany zapis i odświeżony
`physics_graph` materializują węzeł w Explorerze.

Ta sama reguła obowiązuje torque: nowy Zhang--Li, Slonczewski albo prescribed
SOT otrzymuje dokładny `target={object_id, region_id?}` z zaznaczenia, natomiast
istniejący rekord zachowuje własny target. Oersted ma inną topologię graphu:
sam moduł pola jest globalny, a lokalność źródła jest zależnością do current
transport. Dlatego jego Inspector zawsze pokazuje scope globalny. Przy
tworzeniu z kontekstu obiektu/regionu UI może wstawić `source` wyłącznie, gdy
zasoby current transport zawierają dokładnie jednego kandydata zgodnego z tym
zakresem. Zero albo wiele dopasowań nie uruchamia heurystyki; pole źródła
pozostaje jawnie do wyboru.

`Global Physics → Field Drive` otwiera lokalny, jawnie oznaczony draft
`RegionalFieldDrive` o `target.kind=global`. Draft nie jest modułem graphu i
nie może pojawić się w Explorerze. Dopiero udana mutacja create zapisuje
zasób, zwiększa `scene_revision`, invaliduje listę field drives i przełącza
selekcję na rzeczywiste stabilne `drive.id`. Tryb create używa `POST`, edycja
istniejącego zasobu `PUT`; UI nie może wysłać draftu przez replace ani po
utworzeniu pozostać w stanie, który ponowiłby `POST`.

(source-code-index)=
### 7.1. Indeks źródeł

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| `crates/fullmag-authoring/src/physics_graph.rs` | `normalize_physics_graph` | normalizacja grafu |
| `crates/fullmag-authoring/src/physics_graph.rs` | `current_solve_domain` | bezstratne mapowanie legacy `solve_region` na zakres obiektu |
| `crates/fullmag-authoring/src/physics_graph.rs` | `torque_presentation` | cienka tożsamość wariantu dla API/UI |
| `crates/fullmag-authoring/src/physics_graph.rs` | `torque_scope_and_source` | zachowanie dokładnego object/region targetu każdej znanej rodziny torque w grafie |
| `crates/fullmag-ir/src/lib.rs` | `ProblemIR` | kanoniczny IR |
| `packages/fullmag-py/src/fullmag/model/physics_scope.py` | `PhysicsScope` | publiczny zakres Python |
| `crates/fullmag-plan/src/lib.rs` | `plan` | planowanie lane |
| `crates/fullmag-plan/src/physics_graph.rs` | `resolve_physics_modules` | markery/maski semantyczne |
| `crates/fullmag-plan/src/physics_graph.rs` | `physics_module_execution_enabled` | fail-closed filtr wykonania rodzinnych payloadów |
| `crates/fullmag-plan/src/physics_graph.rs` | `physics_graph_realization_provenance` | certyfikat realizacji graphu na konkretnej topologii |
| `crates/fullmag-plan/src/physics_graph.rs` | `multilayer_global_mask` | fail-closed materializacja wspólnej maski FDM multilayer |
| `crates/fullmag-api/src/router_v2/mod.rs` | `build_v2_router` | zasób v2 |
| `apps/control-room/src/modules/explorer/builders/physicsGraphTree.ts` | `buildPhysicsGraphTree` | drzewo Explorera |
| `apps/control-room/src/modules/explorer/explorerSelection.ts` | `selectionRefFromNode` | routing graphowego modułu do rodzinnego Inspectora po stabilnym ID |
| `apps/control-room/src/kernel/resources/physicsGraphResources.ts` | `usePhysicsGraphResource` | resource hook |
| `apps/control-room/src/modules/inspector/panels/PhysicsGraphModuleInspectorPanel.tsx` | `PhysicsGraphModuleInspectorPanel` | inspector semantyczny |
| `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` | `PhysicsInteractionPanel` | przekazanie zaznaczonego obiektu/regionu do authoringu current transport |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx` | `CurrentTransportInspectorPanel` | wspólny responsywny Inspector i dokładny widok object/region scope dla authoringu prądu |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts` | `currentTransportDraft` | bezstratna inicjalizacja object/region scope dla nowego źródła prądu |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts` | `currentTransportModelPatch` | zachowanie scope'u i usunięcie niedozwolonych pól legacy przy zmianie modelu |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx` | `SpinTransportInspectorPanel` | rodzinny draft Spin Transport/SHE z dokładnym początkowym zakresem obiektu lub regionu |
| `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.ts` | `spinTransportDraft` | inicjalizacja edytowalnego domain nowego spin transport bez rozszerzania zaznaczonego scope'u |
| `apps/control-room/src/modules/ribbon/ribbonCommands.ts` | `createSpinTransportFromCommand` | otwarcie draftu Spin Transport/SHE bez materializacji pustego węzła graphu |
| `apps/control-room/src/modules/ribbon/ribbonCommands.ts` | `createSpinInterfaceFromCommand` | otwarcie fail-closed draftu interfejsu bez wymyślania owner spin transport |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx` | `SpinTorqueInspectorPanel` | dokładny object/region target dla nowego torque i wspólny Inspector |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx` | `OerstedFieldInspectorPanel` | globalny scope modułu Oersteda niezależny od lokalności źródła |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspector.tsx` | `SpinAuthoringInspector` | fail-closed inicjalizacja targetu torque i pojedynczego źródła Oersteda zgodnego z zaznaczeniem |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.ts` | `currentSourceOptions` | typowane źródła z istniejących modułów transportu i bezstratne zachowanie niedostępnej zależności |
| `apps/control-room/src/modules/inspector/panels/SpinAuthoringInspectorModel.ts` | `torqueCurrentBindingPatch` | wzajemnie wykluczające przejście między prescribed density i current transport |
| `apps/control-room/src/modules/ribbon/ribbonCommands.ts` | `createFieldDriveFromCommand` | otwarcie jawnego globalnego draftu field drive bez materializacji w graphie |
| `apps/control-room/src/modules/inspector/panels/RegionalFieldDrivePanelModel.ts` | `resolveRegionalFieldDrivePanelModel` | rozpoznanie jawnego create draftu i zbudowanie kanonicznego payloadu z unikalnym ID |
| `apps/control-room/src/modules/inspector/panels/RegionalFieldDrivePanelModel.ts` | `commitRegionalFieldDrive` | rozdzielenie POST create od PUT replace |
| `apps/control-room/src/modules/inspector/panels/RegionalFieldDrivePanel.tsx` | `RegionalFieldDrivePanel` | responsywny authoring draftu, invalidacja zasobu i przejście selekcji na zapisany moduł |
| `crates/fullmag-authoring/src/scene.rs` | `default_scene_version` | wersja dokumentu sceny |
| `crates/fullmag-ir/src/lib.rs` | `is_supported_ir_version_for_read` | granica odczytu IR |
| `crates/fullmag-ir/src/validation.rs` | `validate_oersted_energy_terms` | walidacja stabilnego ID Oersteda przy zachowaniu odczytu historycznego rekordu bez ID |
| `packages/fullmag-py/src/fullmag/model/physics_scope.py` | `build_physics_graph` | lowering Python |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `execute_native_fem_steady_transport_plans` | bounded FEM artifact provenance |
| `crates/fullmag-runner/tests/physics_graph_runtime.rs` | `fdm_runtime_artifact_contains_concrete_graph_realization` | hostowy dowód zapisu certyfikatu FDM w artefakcie runnera |
| `crates/fullmag-runner/tests/physics_graph_runtime.rs` | `fem_runtime_artifact_contains_concrete_graph_realization` | managed CPU FEM/MFEM dowód zapisu rzeczywistych markerów elementów w artefakcie runnera |
| `crates/fullmag-runner/src/artifact_pipeline.rs` | `observe_physics_execution` | publikacja dokładnych ID dla zaakceptowanych ewaluacji workflow; bez rozszerzania dowodu minimizatora na torque/transport |
| `crates/fullmag-runner/src/artifact_pipeline.rs` | `observe_energy_evaluation` | publikacja wyłącznie ID modułów energii po zaakceptowanej ewaluacji minimizatora FDM CPU, FDM CUDA lub FEM |
| `crates/fullmag-runner/src/physics_graph_execution.rs` | `observe_steady_transport` | transfer dokładnych ID FEM steady transport wywoływany przy udanym solve, przed opcjonalnym writer artefaktów i niezależnie od niego |
| `crates/fullmag-runner/src/hysteresis.rs` | `merge_hysteresis_execution_provenance` | kumulacyjna unia obserwacji przygotowania, sweep, angular, adaptive i minor-loop przed finalną walidacją |
| `crates/fullmag-runner/src/artifacts.rs` | `observed_physics_graph_module_ids` | deduplikacja już zaobserwowanych dokładnych ID bez rekonstrukcji z planu lub rodzaju modułu |
| `scripts/verify_physics_scope_graph_runtime.py` | `_validate_concrete_realization` | lane-specific walidacja markerów, masek i przejść stanu |
| `backends/fem/cpu/mfem/transport/conservative_current_view.cpp` | `ConservativeCurrentView::Build` | RT0/H(div) current view |
| `apps/control-room/src/modules/inspector/primitives/InspectorOverviewFrame.tsx` | `InspectorOverviewFrame` | wspólna kompozycja inspektora |

### 7.2. Certyfikat realizacji na konkretnej topologii

Semantyczny marker FEM ani identyfikator maski FDM nie jest jeszcze dowodem,
że zakres został wskazany na aktualnej siatce. Planner tworzy więc osobny,
wersjonowany certyfikat `physics_graph.realization.v1`. Certyfikat rozróżnia
trzy stany:

| Stan | Znaczenie | Dowód lane-specific |
|---|---|---|
| `semantic_only` | moduł istnieje w IR, lecz nie ma jednoznacznego odwzorowania na topologię | brak konkretnego markera/maski |
| `resolved` | zakres został rozwiązany na wybranej topologii, ale nie ma dowodu wykonania | FEM: numeryczne `element_markers`; FDM: digest maski komórek |
| `executed` | rozwiązany zakres został zaobserwowany w provenance wykonania | ten sam dowód topologii oraz identyfikator modułu w wykonaniu |

W FEM certyfikat przechowuje fingerprint topologii, zbiór rzeczywistych
`element_markers` i liczbę wybranych elementów. W FDM przechowuje fingerprint
siatki, digest aktywnej maski komórek oraz legendę regionów; sam `mask_id` z IR
pozostaje tylko tożsamością semantyczną. Przejście do `executed` następuje
wyłącznie na podstawie jawnego rekordu wykonania, bez heurystyki wynikającej z
wartości prądu, obecności modułu lub samego wyboru backendu.

Dla FDM multilayer stan `resolved` jest dozwolony tylko wtedy, gdy wszystkie
warstwy są wyrównane z tym samym wspólnym gridem i można z nich jednoznacznie
zbudować unię aktywnych komórek. Warstwa z transferem `push_pull`, przesuniętym
originem albo niezgodnym rozmiarem maski pozostaje `semantic_only`; liczba
komórek z certyfikatu wspólnego gridu nie jest zamiennikiem takiej maski.

W round-trip zachowujemy zarówno `requested intent` autora, jak i `resolved execution`
wybranego lane. `validation errors` są zwracane przed wykonaniem,
a `unsupported combinations` pozostają jawne i nie są zastępowane fallbackiem.

(validation)=
## 8. Zależności STT/SOT/SHE/Oersted

Każdy moduł ma stabilne `id`, ścieżkę źródłową i payload rodziny. Typowe
krawędzie to:

\[
 \text{current} \to \text{spin transport} \to \text{torque},\qquad
 \text{current} \to \text{Oersted},
\]

oraz sprzężenie interfejsowe między dwoma regionami. Krawędź jest `active`
tylko wtedy, gdy oba końce istnieją, mają zgodny zakres i przechodzą walidację
planera. Rekord legacy bez celu pozostaje `unresolved` z przyczyną i wskaźnikiem
JSON Pointer.

Authoring zależności w UI używa listy rzeczywiście istniejących modułów
`CurrentTransport`; identyfikator źródła nie jest swobodnym tekstem. Dla STT
jawny tryb `Prescribed density` emituje wyłącznie wektor `current_density`, a
tryb `Current transport` wyłącznie
`current_source=<CurrentTransport.name>`. UI czyści drugą gałąź przy zmianie
trybu, zgodnie z regułą dokładnie jednego wiązania w `ProblemIR`. Dla
`OerstedField(model=from_current_solution)` wybór źródła jest obowiązkową
zależnością grafu. Jeżeli edytowany dokument wskazuje usunięty albo chwilowo
niedostępny moduł, UI zachowuje jego identyfikator jako jawną opcję
`unavailable`; nie usuwa go i nie podmienia na pierwszy dostępny rekord.

## 9. Lowering Python → ProblemIR → runtime

Python DSL zapisuje obecność, zakres, napęd, zależności i parametry
konstytutywne. Autor sceny normalizuje rekordy do wersjonowanego
`PhysicsGraphIR`; payload rodziny (np. `CurrentTransport`, `SpinTransport`,
`OerstedField`) pozostaje nienaruszony. `ProblemIR` przechowuje graph jako
kanoniczną warstwę semantyczną, a planner dodaje lane-specific markery/maski.
Runtime publikuje tę samą tożsamość modułu, stan aktywacji, rewizję źródła i
status capability w artefaktach.

Każdy publicznie tworzony `OerstedCylinder` i `OerstedField` musi przenosić
stabilne `id` do `EnergyTermIR`. To samo `id` jest używane przez
`PhysicsGraphIR.modules[].id` i przez filtr wykonania planera. Indeks listy ani
`source_path` nie jest tożsamością fizyczną: może służyć wyłącznie jako
ograniczony adapter odczytu historycznego IR bez pola `id`. Nowy Python DSL,
SceneDocument i UI nie mogą już emitować takiego rekordu legacy.

Brak bieżącego modułu w Python IR/UI oznacza pusty zbiór źródeł. `j=0` w
istniejącym module oznacza natomiast jawnie nieaktywny napęd i nie może usuwać
inspektora, proweniencji ani zależnych ostrzeżeń.

## 10. Walidacja

Normalizacja musi być deterministyczna względem kolejności wektorów, odrzucać
duplikaty ID oraz wskazania nieistniejących obiektów/regionów. Nieznane rekordy
są zachowywane jako `unsupported`. Ambiwalentne rekordy legacy są
`unresolved`; planner zgłasza błąd zamiast wybierać obiekt przez przypadek.

Minimalne bramki:

1. sześć fixture'ów kontraktowych (pusta scena, brak prądu, łańcuch lokalny,
   napęd globalny, interfejs cross-object, rekord nierozstrzygnięty),
2. test stabilności ID po zmianie kolejności rodzin,
3. test rozdzielenia `applies_to` i `solve_domain`,
4. test, że zależny moduł nie staje się aktywny bez źródła,
5. osobne testy numeryczne FEM/FDM oraz proweniencji; test graphu nie jest
   dowodem zgodności solverów.

Dokument pozostaje zgodny z notami `0960`, `0970` i `0980`. W szczególności
kontrakt grafu nie promuje semantycznego SHE/Oersteda do wykonania, a dla FEM
Oersted wymaga kanonicznego `ConservativeCurrentView` RT0/H(div), zamknięcia
bilansu i identyfikacji rewizji źródła.

(limitations)=
## 11. Ograniczenia

Graf nie dowodzi równoważności FEM/FDM, poprawności RT0/H(div), domknięcia
obwodu, zbieżności `h/dt`, działania GPU ani produkcyjnej kwalifikacji
STT/SOT/SHE/Oersteda. Brak modułu nie może być zastąpiony zerowym napędem,
a moduł `unresolved` nie może być cicho przypisany do obiektu.

(scientific-bibliography)=
## 12. Bibliografia lokalna

- Fullmag, `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`.
- Fullmag, `docs/physics/0970-spin-hall-drift-diffusion-transport.md`.
- Fullmag, `docs/physics/0980-dynamic-current-and-oersted-coupling.md`.
- J. C. Slonczewski, *Current-driven excitation of magnetic multilayers*,
  J. Magn. Magn. Mater. 159 (1996).
- A. Manchon et al., *Current-induced spin-orbit torques in ferromagnetic and
  antiferromagnetic systems*, Rev. Mod. Phys. 91 (2019).
