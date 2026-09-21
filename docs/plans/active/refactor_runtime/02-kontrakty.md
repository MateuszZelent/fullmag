# Fullmag CAE — kontrakty danych i zachowania

**Status:** PROPOSED, 20.09.2026. Nazwy i fragmenty poniżej są specyfikacją nowych kontraktów, nie istniejącym SDK.  
**Powiązanie:** [architektura całego systemu](01-architektura-cae.md). Istniejące elementy i zakres odczytu opisuje [rejestr dowodów](05-dowody-i-adr.md).

## K01. Właściciele i granice transakcji

| Zasób | Autorytatywny właściciel | Mutacja | Cykl życia |
|---|---|---|---|
| Definicja projektu/modelu | Authoring application kernel + ProjectRepository | Komenda z expected revision | Wersje zatwierdzone i draft. |
| Definicja study/solver/plot | Ten sam repository definicji | Komenda edycyjna | Niezależne identyfikatory w projekcie. |
| Run specification | Execution coordinator | Utworzenie; wejście potem niezmienne | Zachowane z historią wykonania. |
| Plan tasków | Study compiler/coordinator | Przypięta wersja planu; rozwinięcia według jawnej reguły | Nie jest mutacją modelu. |
| Własność próby | Coordinator | Lease/fencing epoch | Attempt-scoped. |
| Aktywny stan numeryczny | Worker/engine | Tylko przez solver i zatwierdzone steering | Do zwolnienia runtime’u. |
| Zapisany stan/solution | Artifact store + katalog | Niezmienny blob/manifest; oddzielne referencje | Zgodnie z retencją i pinningiem. |
| Scene/render model | Projektor definicji lub datasetu | Odtwarzalna projekcja | Cache, nie kanoniczny dokument. |
| Camera/selection/form draft | Workspace controller | Lokalne zdarzenia | Per project/view/property; recovery osobno. |

Komenda może atomowo zmienić kilka definicji w jednym projekcie, np. dodać obiekt, parametr i przypisanie materiału. Nie może „atomowo” obejmować długiego solve. Solve powstaje po zatwierdzeniu definicji jako osobna operacja.

W pierwszym wdrożeniu jeden projekt ma jednego writera. Równoległa edycja przez kilka klientów używa kontroli rewizji, nie last-write-wins. Zapis osobnego projektu nie jest blokowany przez oczekiwanie na compute.

## K02. Minimalne tożsamości

```text
ProjectId / ModelId / ComponentId / FeatureId / SelectionId
StudyId / StudyStepId / SolverConfigId / DiscretizationDefinitionId
DefinitionRevision / DefinitionSnapshotId / ParameterContextId
RunId / CaseId / TaskId / AttemptId / OwnershipEpoch
ArtifactId / SolutionId / DatasetId / ViewId
GeometryFingerprint / TopologyFingerprint / FunctionSpaceId / StateId
```

`id` identyfikuje encję, revision jej wersję, fingerprint konkretne zależności/treść. Timestamp nie zastępuje żadnego z tych pól. Nazwa nie jest identyfikatorem.

Tożsamość cache nie może składać się tylko z URL `/current`. Dane wynikowe wiążemy co najmniej z project/run/solution/resource revision oraz tożsamością carrier/space, jeśli dotyczą pola. Dekoder binarny również sprawdza context token przy przyjęciu wyniku.

ID artefaktu jest stabilne i wskazuje niezmienny manifest; content hash wskazuje konkretny blob. To pozwala osobno przechowywać metadane i deduplikować payload. Wspólny payload nie uprawnia do połączenia różnych opisów provenance bez zachowania ich referencji.

## K03. Szkic definicji projektu

Poniższy pseudotyp pomija szczegóły payloadów rodzin, lecz rozstrzyga kardynalności i odpowiedzialność:

```ts
interface ProjectDefinition {
  schemaVersion: string;
  projectId: ProjectId;
  revision: DefinitionRevision;
  metadata: ProjectMetadata;
  definitions: SharedDefinitions; // parameters, functions, pinned libraries
  models: readonly ModelDefinition[];
  studies: readonly StudyDefinition[];
  solverConfigurations: readonly SolverConfiguration[];
  executionProfiles: readonly ExecutionProfile[];
  resultRecipes: readonly ResultRecipe[];
  sourceAssets: readonly SourceAssetReference[];
}

interface ModelDefinition {
  modelId: ModelId;
  name: string;
  components: readonly ComponentDefinition[];
  physicsConfigurations: readonly PhysicsConfiguration[];
  couplings: readonly CouplingDefinition[];
  discretizations: readonly DiscretizationDefinition[];
}
```

To schema logiczne; fizyczny zapis może używać osobnych plików i content-addressed referencji. `ProjectDefinition` nie zawiera pełnej historii wszystkich pól ani zmieniającej się co sekundę listy statusów tasków. Katalog runów/solutions jest osobnym agregatem odwołującym się do project ID.

`ComponentDefinition` przechowuje cechy geometrii i przypisania fizyczne, nie kopię aktualnego meshu. Kilka komponentów może należeć do wspólnej domeny obliczeniowej. Nie wolno planować niezależnego solvera per component, jeśli fizyka sprzęga je wzajemnie.

## K04. Komenda edycji i Undo

Żądanie zawiera:

```json
{
  "project_id": "project-waveguide",
  "expected_revision": 41,
  "client_intent_id": "edit-width-001",
  "command": {
    "type": "parameter.set_expression",
    "parameter_id": "width",
    "expression": "140[nm]"
  }
}
```

Odpowiedź potwierdza rewizję, normalized change set, diagnostics i affected-resource references. `client_intent_id` jest unikalne dla operacji, a backend zapisuje digest payloadu. Ten sam klucz z inną treścią daje konflikt.

Commit wymaga poprawności strukturalnej i spójności referencji na poziomie dopuszczonym przez dany draft. Brak materiału lub kroku study może pozostać jako diagnostyka niewykonywalności. Nie należy uruchamiać pełnego meshingu w transakcji zapisu parametru.

Dziennik zachowuje semantyczną komendę i dane potrzebne do odwrócenia. Undo jest kolejną transakcją na aktualnej wersji, uwzględniającą konflikty. Nie polega na ślepym wstawieniu starego całego obiektu, który mógł być zmieniony przez inne komendy.

Wstawienie grupy obiektów, przesunięcie i wszystkie zależne referencje stanowią jedną operację użytkownika. Ruchy podglądu gizma nie są osobnymi krokami Undo.

## K05. ParameterContext i ocena wyrażeń

Kontekst zawiera parametry rozstrzygnięte według wersjonowanej reguły scope: definicje projektu → model/komponent → jawne override study → wartości case. Nie dopuszczamy dwóch równorzędnych, sprzecznych override bez określonego priorytetu.

Dla każdego symbolu przechowujemy expression AST, dimension, original expression, resolved value, dependency IDs oraz provenance źródła. Funkcja przestrzenna ma dodatkowo frame i domain. Parametr projektowy nie może niejawnie odczytywać aktualnego pola solvera.

Hash numeryczny używa zamknięcia zależności dla danego artefaktu, a nie zawsze wszystkich parametrów projektu. Wartości są serializowane deterministycznie; równoważność jednostek ma wspólną regułę normalizacji. Zmiana tolerancji serializacji jest wersją producenta fingerprintu.

## K06. Study i typowane porty

Przykładowy logiczny graf badania:

```text
relax.mag_state + relax.equilibrium_evidence
       ├──→ eigen.linearization_state
       └──→ response.linearization_state
source.rf_field ───→ response.excitation
```

Każdy `StudyStep` deklaruje model/physics configuration, discretization reference, solver config, input ports, output ports i acceptance policy. Port zawiera typ danych oraz wymagania zgodności. `StateArtifact` i `EquilibriumArtifact` nie są zamienne, nawet jeśli zawierają tę samą tablicę magnetyzacji.

Referencja wejścia jest jednym z jawnych wariantów:

```text
AuthoredInitialState(definition_ref)
PinnedArtifact(artifact_id)
StepOutput(step_id, output_port, case_mapping)
Continuation(previous_point, output_port)
```

`latest state` z UI nie jest wariantem. Wybór „use currently observed state” musi podczas Submit rozstrzygnąć się do konkretnego `PinnedArtifact` lub snapshotu zaakceptowanego stanu.

Case mapping określa, czy konsument bierze wynik o tych samych parametrach, wspólną równowagę czy wynik jawnie wskazanego punktu. Przykład: każdy wariant grubości musi korzystać z równowagi tej samej grubości, chyba że użytkownik świadomie wybrał transfer i ponowną kwalifikację.

### Zależna kontynuacja i niezależne próby

`IndependentSweep` deklaruje brak zależności stanu między punktami i politykę seeda. `ContinuationSweep` deklaruje kolejność i przekazanie stanu. Scheduler nie może samodzielnie zmienić jednego typu na drugi dla zwiększenia równoległości.

Histereza z rozgałęzieniami ma jawne punkty źródłowe. Dwie gałęzie można liczyć niezależnie dopiero po zmaterializowaniu i przypięciu ich stanu startowego. Wewnętrzne iteracje nonlinear/coupled solvera nie są dowolnymi węzłami organizowanymi przez frontend.

## K07. RunSpecification i późne rozstrzyganie wejść

```ts
interface RunSpecification {
  runId: RunId;
  projectId: ProjectId;
  definitionSnapshotId: DefinitionSnapshotId;
  studyId: StudyId;
  studyPlanVersion: string;
  parameterContexts: readonly ParameterContext[];
  sourceAssets: readonly ImmutableAssetReference[];
  executionIntent: ExecutionIntent;
  randomPolicy: RandomPolicy;
  acquisitionPolicy: AcquisitionPolicy;
  inputBindings: readonly BoundInputOrDependency[];
}
```

Submit nie musi zawierać gotowego meshu. Musi zawierać niezmienną recepturę i przypięte źródła wystarczające do jego odtworzenia oraz jawną zależność od producenta meshu. `ResolvedTaskInput` tworzony przed startem kroku wiąże już konkretne artefakty i finalny plan.

Wstępny preflight może mieć status `conditionally_supported`: część kryteriów wymaga topologii lub dostępnego urządzenia. Nie wolno przedstawiać tego jako zakończonej kwalifikacji.

Po przyjęciu runu edycja draftu nie zmienia RunSpecification. Zmiana intencji wymaga nowego runu albo jawnego SteeringEvent do dozwolonego kroku interaktywnego.

## K08. Stany i przejścia

Nie stosujemy jednego enum `ready` dla całego systemu.

| Oś | Warianty docelowe | Znaczenie terminalności |
|---|---|---|
| Dokument | new, available, loading, read_only, load_failed | Nie ma terminalnego „computed”. |
| Walidacja modelu | incomplete, invalid, valid_for_requested_action | Dotyczy określonej akcji i rewizji. |
| Artefakt | absent, building, available, corrupt | Dostępność danych; stale to relacja do innych zależności. |
| Task | accepted, queued, preparing, running, stopping, succeeded, failed, cancelled, interrupted | Succeeded opisuje wykonanie, nie naukę. |
| Obserwacja | live, stale, disconnected, reconciling | Nie zmienia statusu procesu na failed. |
| Ocena rozwiązania | converged, tolerance_not_met, limit_reached, invalid, unassessed | Według wersjonowanej acceptance policy. |
| Odtworzenie | exact_resume, logical_resume, initial_condition_import, config_only | Wynik walidacji kompatybilności. |

`blocked` jest stanem gotowości tasku do uruchomienia, z listą zależności i powodów. Nie jest sukcesem poprzednika ani awarią aplikacji. Dla workera, którego stan jest nieznany po utracie łączności, nie emitujemy natychmiast Failed — najpierw reconciliation i lease policy.

Przejście `cancel_requested → succeeded` jest możliwe, jeśli obliczenie zakończyło się przed zastosowaniem anulowania. Historia musi to wyjaśnić; nie zmieniamy już zatwierdzonego solution na cancelled tylko dlatego, że żądanie dotarło później.

## K09. Protokół workerów i fencing

Przydział zawiera task_id, attempt_id, ownership_epoch, input manifest, target requirements i limity. Worker potwierdza przyjęcie oraz rzeczywiste capabilities. Heartbeat nie jest raportem zbieżności.

Każde zdarzenie output/complete ma te same identyfikatory i monotoniczny sequence w ramach próby. Coordinator odrzuca zdarzenie z nieaktualnej epoki. Retry ma nowy attempt ID. Nie używamy timestampów do rozstrzygnięcia, który worker „wygrał”.

Kolejne zadania mogą być wykonane w tym samym procesie z zachowaniem kompatybilnych zasobów. Kontrakt zawiera fingerprint runtime state i affinity, ale nie pozwala na reuse niezgodnego operatora. Koordynator może grupować krótkie kroki w jeden batch bez utraty identyfikacji logicznych wyników.

Po restarcie usługi najpierw uzgadniamy zadania przyjęte i uruchomione. Nie uruchamiamy ich ponownie tylko dlatego, że UI nie ma jeszcze cache. Domyślna polityka nie zakłada bezpiecznego replay skryptu z efektami ubocznymi.

## K10. Manifest artefaktu i dwuetapowa publikacja

Minimalny manifest zawiera:

```text
artifact_id, schema_version, producer_id, producer_version
project_id, run_id, task_id, attempt_id, ownership_epoch
input_fingerprints, content_hashes, output_port
completeness, covered_axes, scientific_assessment_ref
geometry_ref, discretization_ref, function_space_ref (jeśli dotyczą)
created_with, compatibility_receipts
```

Procedura:

1. Zapis chunka/plików w staging i zakończenie operacji I/O.
2. Sprawdzenie checksum i manifestu pokrycia; częściowe dane pozostają jawnie częściowe.
3. Walidacja aktualnej własności, typów portów i certyfikatów przez coordinator.
4. Atomowy commit referencji do katalogu solutions/artifacts.
5. Emisja resource-change; klienci samodzielnie decydują, czy potrzebują danych.

Nie ma operacji „publish to current viewport” w kontrakcie workera. Render ACK potwierdza przyjęcie danych przez konkretny widok, nie zatwierdza wyniku naukowego i nie kończy tasku.

## K11. Pole i przestrzeń funkcji

`FieldDescriptor` zawiera semantyczny quantity ID, jednostkę, tensor rank, frame, lokalizację próbek/DOF, przestrzeń/bazę, topology/carrier identity, active support, axes, complex encoding i normalization. Payload pozostaje binarny/chunkowany.

Zgodność długości bufora nie wystarcza. Przykład: dwa meshe mają tyle samo węzłów, lecz inną kolejność lub inny zbiór regionów. Dataset consumer musi odrzucić parę bez zgodności identity/layout.

Dla danych zespolonych obsługujemy jawne kodowanie real/imag oraz konwencję harmoniczną. Obecny `TensorDtype` nie ma samodzielnego wariantu complex; rozszerzenie metadanych/osi może opisywać pary komponentów bez dublowania całego storage. Ostateczny format jest wersjonowany i ma test roundtrip, a nie odgadywanie z nazwy pola. [E08](05-dowody-i-adr.md)

`PreviewOnly` nie może zasilać wynikowego evaluator'a udającego dokładną całkę. Zmiana quantity nie przebudowuje niezależnej topologii i nie rozszerza zakresu żądania do całej domeny jako fallback.

## K12. Dataset, derived value i plot

```text
DatasetDefinition
  source: PinnedSolution | ExplicitResolvedLiveSource
  domain_selection: SelectionReference
  axes: time/frequency/k/mode/parameter coordinates
  transforms: typed projection/cut/composition/difference
  evaluation_policy: precision, approximation and unavailable-data policy

DerivedValueDefinition
  dataset_ref + expression/operator + integration/support measure
  required_quantities + required_resolution + producer_version

PlotDefinition
  dataset_ref / derived_value_ref + plot type + visual settings
```

Postprocessing zwraca również metadata jakości i źródła. Interpolacja między czasami albo siatkami ma jawną metodę. Przełączenie komponentu z `mx` na `mz` jest zmianą zapytania/widoku, nie mutacją stanu solvera.

Operacja wymagająca niezapisanej wielkości zwraca `not_recorded` i listę możliwych dalszych działań: wybór dostępnej wielkości, jawne przeliczenie z wystarczającego zapisanego stanu lub nowe wykonanie. Nie uruchamia nowego solve w ukryciu.

## K13. SteeringEvent i checkpoint

Steering jest przypisany do runu, stanu accepted i bezpiecznego punktu synchronizacji. Request określa zmianę oraz oczekiwaną tożsamość. ACK zapisuje faktyczny krok/czas zastosowania, nowy segment oraz wymagane cache invalidations.

Checkpoint obejmuje dokładnie te dane, których potrzebuje restart ABI danego integratora i backendu: primary state, historię metody, RNG/counters, constraints/activation state oraz wymagane stany pomocnicze. Worker nie może deklarować exact resume przy niepełnym payloadzie.

Zachowujemy istniejące klasy odtwarzania i compatibility fields, rozszerzając je o identyfikację definicji/runu/segmentu. Zapis samego pola jest dopuszczalny jako initial-condition artifact, ale nie otrzymuje etykiety pełnego checkpointu.

## K14. Format `.fms` następnej generacji

Proponowana nowa struktura logiczna archiwum wykorzystuje dotychczasowy kontener i CAS:

```text
manifest/project.json             # marker schematu projektu vNext
manifest/workspace.json           # opcjonalny stan widoków
manifest/export_profile.json
project/definition.json           # lub refs do niezmiennych fragmentów
project/sources/...
project/libraries/...
runs/<run_id>/run_manifest.json
runs/<run_id>/tasks/...
solutions/<solution_id>/manifest.json
datasets/definitions.json
assets/index.json
objects/<content_hash>/...
```

To docelowy layout, nie opis dzisiejszego `.fms`. Adapter czyta obecny `manifest/session.json` formatu `fullmag.session.v1` i tworzy projekt. Czytelnik nowego formatu musi jednoznacznie rozpoznać root; sprzeczne równoległe korzenie są odrzucane. Nie modyfikujemy starego writera, żeby po cichu wypuszczał niezgodne payloady pod dawną wersją.

Wewnętrzny working store i przenośne archiwum nie muszą być identyczną strukturą. Zapis archiwum może być kosztowny; incremental autosave używa working store, nie przepakowuje wszystkich danych przy każdym Apply. Export manifest wskazuje dokładną rewizję projektu i wybrane runy.

## K15. Zgodność UI/CLI/Python

Golden fixtures określają definicję wejściową oraz oczekiwaną semantykę po przejściu każdą drogą. Porównujemy znormalizowany model/IR i provenance, nie tekst wygenerowanego Pythona. Model builder graph, scena i skrypt nie mogą być niezależnie zapisywanymi, wzajemnie sprzecznymi „prawdami”.

Nowy projekt ma jedną kanoniczną definicję; pozostałe formy są projekcjami albo jawnie przypiętymi źródłami generowania. Migracja legacy rozstrzyga, który zapis jest wiarygodny; konflikt wymaga raportu i nie może być ukryty automatycznym wyborem ostatniego pliku.

## K16. Cztery krytyczne przebiegi sekwencyjne

### A. New → geometry → Save bez solvera

UI tworzy projekt → repository potwierdza ID/revision → komenda dodaje parametr i cechę → lekki preview osobnym tokenem → Save zapisuje definicję. Brak geometry realization nie blokuje zachowania receptury. Nie powstaje RuntimeSession ani run.

### B. Compute równocześnie z edycją

Submit przypina revision 41 → coordinator tworzy R1 → editor zapisuje revision 42 → R1 dostaje wyniki własnych zależności → solution S1 wskazuje revision 41 → UI pokazuje S1 jako wynik wcześniejszej definicji. Dla revision 42 potrzebne jest jawne R2. Nie ma zabijania R1 przez zmianę draftu.

### C. Błąd meshu i naprawa

Task mesh R1/A1 fails → task solve jest blocked → Problems wskazuje feature/recipe → autor poprawia definicję → Submit R2 tworzy nowy plan → zgodne upstream artefakty są reuse → R1 zostaje z diagnostyką. Retry tej samej próby nie może niejawnie użyć poprawionego draftu.

### D. Otwieranie wyników bez runtime’u

Open archive → preflight formatu/bezpieczeństwa → odtworzenie definicji i katalogu → wybór S1/D1 → lazy fetch manifestu/pól → render. Żaden solver nie jest uruchamiany. Resume jest osobną komendą z kontrolą compatibility i zasobów.

## K17. Save, Compute i niezastosowane pola formularzy

Wszystkie edytory właściwości rejestrują swoje pending changes w zakresie projektu, bez przekazywania pełnej fizyki do globalnego store. Przy Compute application layer najpierw żąda uzgodnienia właściwych draftów. Poprawne zmiany są commitowane transakcyjnie; niepoprawny zapis zatrzymuje komendę z przejściem do pola. Dopiero ACK commitów wyznacza revision przypinane do runu.

Alternatywa „Compute last committed version” musi być świadomą komendą z wyraźnym opisem pomijanych zmian. Nie wolno uruchomić obliczenia na innej wartości niż widoczna w formularzu bez poinformowania użytkownika.

Save zapisuje zatwierdzoną definicję oraz, gdy są obecne, oddzielny stan niewysłanych draftów edytora. Interfejs odróżnia „projekt zapisany jako draft” od „model zwalidowany do Compute”. Przy Open można odtworzyć np. niedokończone `sin(` jako draft pola, lecz nie jako poprawne AST w IR. Close sprawdza niezapisane zmiany, a zamknięcie samego dokumentu nie oznacza Cancel runu.

## K18. Mapowanie wyników modalnych na wielkości fizyczne

Artefakt modalny musi określać, czy payload reprezentuje składowe fizyczne, współczynniki przestrzeni FEM, czy współrzędne lokalnej bazy stycznej do stanu równowagi. Wynik wskazuje bazę, m0/LinearizationState i regułę rekonstrukcji. Renderer nie interpretuje arbitralnych współczynników własnych jako wektorów magnetyzacji.

Normalizacja własna, faza, harmonic convention i skala animacji są rozdzielone. Animacja perturbacji nie nadpisuje stanu równowagi ani amplitude of driven response. Wskaźnik gałęzi dyspersji przechowuje metodę dopasowania i sygnalizuje niejednoznaczność w pobliżu degeneracji; sam indeks posortowanej częstotliwości nie jest uniwersalną tożsamością modu.
