# ADR-0036: Horyzont czasu w typowanym kroku Study

- Status: accepted for implementation
- Data: 2026-09-25
- Decydenci: Fullmag core
- Powiązany plan: `docs/plans/active/refactor_runtime/final/03-plan-refaktoryzacji.md` (P3-B)
- Powiązana decyzja: [ADR-0035](0035-typed-study-artifact-manifest-and-worker-boundary.md)

## Kontekst

`ProblemIR::StudyIR::TimeEvolution` opisuje dynamikę i próbkowanie, ale nie
zawiera czasu, przy którym solver ma zakończyć bieg. Publiczny runner przyjmuje
`until_seconds` osobno. Dotychczasowy `StudyPlan` zachowywał ustawienia starego
pipeline wyłącznie w nieinterpretowanym `legacy_payload`, a
`study_execution_plan.v1` nie przenosił wartości do granicy wykonania.

Przyszły supervisor nie mógłby odtworzyć dokładnego zaakceptowanego zadania:
musiałby zgadnąć czas, odczytać mutable UI albo uruchomić nieograniczoną
TimeEvolution. Sampling i interwały autosave określają wyjścia, nie czas
zakończenia solvera.

## Decyzja

1. `StudyPlan v2` dodaje opcjonalne per-step `until_seconds` w jednostkach SI.
   Dla uruchamianego kroku, którego immutable `ProblemIR` ma
   `StudyIR::TimeEvolution`, lowering wymaga wartości skończonej i większej od
   zera. Wartość jest częścią canonical bytes i digestu zaakceptowanego planu.
2. Jawny adapter dotychczasowego pipeline mapuje tylko
   `PrimitiveStageKind::Run.payload.until_seconds` do typed field. Akceptuje
   liczbę lub tekst liczbowy, waliduje dodatnią skończoną wartość i równocześnie
   zachowuje pełny oryginalny `legacy_payload` do audytu. Pozostałe payloady
   nie stają się kontrolą solvera.
3. `study_execution_plan.v2` przenosi `until_seconds` bez modyfikacji. Worker
   odtwarza wartość z zaakceptowanego execution planu i przekazuje ją runnerowi;
   nie wyprowadza czasu z próbkowania, autosave, UI, zegara ściennego ani
   wartości domyślnej.
4. `StudyPlan v1` oraz `study_execution_plan.v1` pozostają czytelne dla
   historycznych rekordów bez nowego pola. v1 nie może deklarować
   `until_seconds`. Legacy v1 TimeEvolution bez jawnego horyzontu jest
   nieuruchamialny i kończy się błędem przed efektem solvera; archiwum ani
   zaakceptowany rekord nie są przepisywane.
5. Pozostałe typy badań zachowują swoje istniejące stop controls. Ta decyzja
   nie przenosi kryteriów zbieżności, limitów iteracji ani harmonogramów
   pętli do `until_seconds`.

## Konsekwencje

- Czas solvera jest częścią niezmiennego wejścia wykonania, a nie właściwością
  autosave ani późniejszym parametrem supervisora.
- `RunSpecification.study.plan_version` i `plan_sha256` przypinają nową
  wersję oraz jej wartość per krok.
- Przyjęcie zadania z TimeEvolution bez horyzontu jest blokowane przez
  canonical lowering; brak danych nie jest naprawiany przez fallback.
- Implementacja supervisora musi pobrać dokładny `StudyStepExecutionPlan` z
  zaakceptowanego runu i przekazać `until_seconds` do istniejącego runnera.
  Zmiana samej wartości nie zmienia wybranego backendu, urządzenia ani
  fizyki `ProblemIR`.

## Weryfikacja

- Adapter migracyjny zachowuje legacy payload i wyprowadza dodatni horyzont.
- Zero, wartości ujemne, niefinity i nie-numeryczne wartości są odrzucane.
- Historyczny plan v1 bez pola nadal się parsuje; dodanie pola bez bumpu wersji
  jest odrzucane.
- Lowering TimeEvolution bez horyzontu fail-closed, a z horyzontem przenosi
  dokładną wartość do execution planu.
- Testy source/contract nie zastępują uruchomienia przez managed worker,
  sprawdzenia rzeczywistej długości symulacji ani kwalifikacji naukowej.

## Rozszerzenie decyzji — jawne ukończenie poprzedników (12.10.2026)

Status tego rozszerzenia: **zaakceptowany kierunek, kontrakt doc-first;
implementacja i runtime proof pozostają otwarte**. Obecne źródła obsługują
`study_plan.v1/v2` i `study_execution_plan.v1/v2`. Poniższe v3 określa kolejny
spójny przyrost, a nie opis już działającego dispatchu. Dotychczasowy kontrakt
`until_seconds` oraz granica manifestu z [ADR-0035](0035-typed-study-artifact-manifest-and-worker-boundary.md)
pozostają obowiązujące.

### Pole i graf zależności

`study_plan.v3` dodaje do każdego `StudyStep` pole
`completion_dependencies: Vec<String>`: identyfikatory kroków tego samego
zaakceptowanego planu, które muszą trwale zakończyć się sukcesem przed
wykonaniem tego kroku. Jednostka: nie dotyczy (identyfikatory, nie wielkość
fizyczna). Pole jest wymagane w serializowanym v3; `[]` oznacza świadomy brak
jawnych poprzedników ukończenia. Nie oznacza zakończenia wszystkich innych
kroków ani pozwolenia na ominięcie wymaganych wejść danych.

Przykład jest **fragmentem przyszłego schematu**, nie kompletnym StudyPlan ani
uruchamialnym przykładem Python:

```json
{
  "schema_version": "study_plan.v3",
  "step_id": "execution-b",
  "completion_dependencies": ["execution-a"]
}
```

Walidacja identyfikatorów obejmuje wszystkie kroki, także wyłączone. Odrzuca
puste lub niepoprawne ID, powtórzenie ID w liście, self-edge, nieznany cel i
cykl. Wykonywalny włączony krok nie może zależeć od wyłączonego poprzednika.
Nie zastępuje się takiej zależności poprzednim włączonym krokiem. Kolejność
listy jest zachowana w canonical bytes; walidacja grafu używa zbioru krawędzi.

Graf do walidacji i `topological_order` jest **sumą** istniejących krawędzi
`Group.child_step_ids`, wszystkich `StepOutput` oraz nowych completion edges.
Każda krawędź zachowuje swoją semantykę: `StepOutput` nadal wymaga zgodnego
portu, `data_kind`, case i dokładnych bajtów; completion edge nie tworzy portu,
artefaktu, skalaru zastępczego ani wejścia danych. Cykl występujący dopiero w
sumie trzech grafów również jest błędem. Stabilny porządek topologiczny służy
loweringowi; sam porządek tablicy nie jest bramką współbieżnego wykonania.

`study_execution_plan.v3` przenosi pole bez modyfikacji do
`StudyStepExecutionPlan`. Walidator sprawdza referencje i union DAG, zgodność
porządku oraz dokładną zgodność z zaakceptowanym StudyPlan. Nowe canonical
bytes zmieniają digest planu i pochodny fingerprint zadania. Nie wolno
pominąć pola przy porównaniu authoring/lowered ani odtworzyć go z mutable UI.

### Tożsamość authoringu i wykonania

Authoring zachowuje osobny inwentarz węzłów, ich ID, typ, enabled, ancestry i
provenance rozwinięcia makra. Completion edges odnoszą się do rzeczywistych
`StudyStep.step_id` wykonania, nigdy do etykiety, pozycji w tablicy ani
niejednoznacznego ID makra. Jeden authored węzeł może mieć wiele execution
records z różnym indeksem rozwinięcia. Grupa, wyłączony węzeł lub mutator
sampling może pozostać wyłącznie wpisem authoringu; ta decyzja nie tworzy dla
niego sztucznego tasku.

Jawny adapter sekwencyjnego pipeline dodaje każdemu kolejnemu rzeczywistemu
wykonaniu zależność od poprzedniego rzeczywistego wykonania, również pomiędzy
rozwinięciami makra. Nie wyprowadza tego porządku dla historycznych planów.
Materiałowanie nadal ma jednego właściciela; zmiana zależności nie może
ponownie zastosować activation, mutatorów ani wiązania profilu.

### Trwała gotowość i cztery granice wykonania

Dla każdej completion dependency jedna wspólna bramka runtime sprawdza:

1. Dokładny immutable accepted StudyPlan, lowered plan, RunSpec i ich digesty;
   źródłowy oraz docelowy task wynikają z tego samego runu i kanonicznego
   mapowania step ID, bez aliasów `current`.
2. Aktualny trwały rekord źródłowego tasku ma `Succeeded`, konkretny udany
   `attempt_id` i `ownership_epoch`. Projekcja katalogu sama nie wystarcza:
   journal/checkpoint musi potwierdzać zakończony ten sam attempt i epoch.
   Rekord nieudanego, anulowanego, wcześniejszego lub rozpoczętego ponownie
   attemptu nie spełnia zależności.
3. Completion barrier została spełniona dla tego udanego attemptu: istnieje
   dokładnie jeden opublikowany typowany manifest z właściwym run/task/step/
   attempt/epoch, sprawdzonym CAS digestem i deklarowanymi outputami.
   Rewalidacja korzysta z istniejącego kontraktu completion i codec, także dla
   pustego manifestu kroku bez portów. Nie akceptuje częściowego outputu ani
   samego pliku wynikowego. `Completing` i samo pojawienie się manifestu nie
   oznaczają jeszcze sukcesu.

Istniejący `validate_study_task_completion` sprawdza accepted step, attempt,
epoch i manifest bez wymagania aktywnego lease, lecz działa także **przed**
journal commit `Completed`. Samo wywołanie tego validatora nie dowodzi więc
ukończenia zależności. Nowa bramka dodatkowo wymaga exact recovered durable
`Completed` dla tego samego aktualnego attemptu/epoch. Wykorzystuje istniejący
validator outputów; nie duplikuje pełnego dekodera manifestu i nie fabrykuje
claimu z nowym lease. Ewentualne wydzielenie immutable output validation jest
uzasadnione tylko wtedy, gdy bez niego nie da się ponownie użyć tej kontroli.

Wspólna bramka odróżnia zwykłe not-ready od błędu integralności. Scheduler
zwraca not-ready dla Running/Completing i nie przyznaje claimu; corrupted
success daje błąd fail-closed. Manual queue, Prepare i Start odmawiają skutku
przez Err/blocked przy tej samej niespełnionej zależności. Resolver wejść
pozostaje oddzielną dodatkową kontrolą, bez tworzenia danych z completion.

Warunek jest sprawdzany w scheduler readiness **przed claimem**, w publicznym
`queue_accepted_study_task` przed przejściem do ready, w
`load_accepted_worker_step` przed Prepare i ponownie w
`load_accepted_worker_step_for_start` przed Start. Bezpośrednie wywołanie queue
lub odtworzenie komendy nie może ominąć scheduler gate. Start ponownie czyta
trwały stan i waliduje zapisany Prepare oraz aktualny claim konsumenta.
Porównania rewizji i istniejące serializowane przejścia/CAS muszą zamknąć
wyścig między odczytem a skutkiem; stary snapshot nie jest dowodem gotowości.

Zależność oczekująca na ukończenie pozostawia konsumenta w istniejącym stanie
oczekiwania, bez claimu, Prepare i skutku solvera. Niespójny journal, brak CAS,
nieznany codec, zły fingerprint lub niejednoznaczny manifest blokują
wykonanie jawnie; nie zamieniają błędu na gotowość. Wymagane `StepOutput`
przechodzą dodatkowo własne rozwiązanie wejść danych. Poprawny completion
edge nie zastępuje tego rozwiązania.

**Ukończony producent nie potrzebuje nadal aktywnego resource lease.** Jego
historyczny sukces jest związany z ukończonym attemptem, epoch, journalem i
manifestem. Aktywny lease był wymagany przy publikacji i completion; może być
potem prawidłowo zwolniony. Konsument wymaga własnego aktualnego claimu i lease
na dotychczasowych granicach. Rewalidacja historycznego sukcesu nie może
wywołać admission check wymagającego żywego lease producenta ani wskrzesić go.

### Migracja i kompatybilność completion-only

| Dokument | Odczyt historyczny | Nowe zachowanie |
|---|---|---|
| `study_plan.v1/v2` | Bez completion edges; zachowana dotychczasowa semantyka i canonical bytes | Pole completion jest zabronione pod starszą wersją, także jawne `[]` |
| `study_plan.v3` | Jawna lista per krok, także `[]` | Nowa walidacja, digest i union DAG |
| `study_execution_plan.v1/v2` | Bez nowej semantyki; stare referencje zachowane | Zakaz completion field bez bumpu |
| `study_execution_plan.v3` | Dokładne przeniesienie zależności z accepted v3 | Nowe fingerprinty i bramki readiness |

Czytnik potrzebuje obecności pola przy rozróżnieniu wersji: samo serde default
`[]` nie wystarczy do odrzucenia pola pod v1/v2. Decyzja wire: version-aware
deserialize planu przez prywatny, presence-aware wire representation, z
rozróżnieniem missing/null/present i zachowaniem `deny_unknown_fields`. Dopiero
po sprawdzeniu wersji wire przechodzi do typu domenowego z `Vec<String>`.
Pod v1/v2 każda obecność pola jest błędem; pod v3 missing/null są błędem.
Serialize jest również version-aware: historyczne v1/v2 pomijają nowe pole,
v3 emituje je zawsze. Zwykłe `skip_serializing_if = Vec::is_empty` zgubiłoby
różnicę i jest niewystarczające. Migracja istniejącego planu jest jawna, copy-on-write, z nową wersją,
rewizją i digestem; nie przepisuje zaakceptowanego runu, archiwum ani journalu.
Nie inferuje sekwencyjności z tablicy v1/v2 lub legacy payload.

`RunSpecification::StudyReference` już przypina `plan_version` i digest;
completion-only nie wymaga nowego publicznego pola RunSpec. Istniejący katalog
ProblemIR nadal obejmuje te same solver steps i wiąże digest nowego planu;
nie potrzebuje unionu operations ani katalogu action payloadów. Obsługę wersji
i fingerprintów trzeba sprawdzić w każdym readerze accepted snapshot oraz
resolved input. Jeżeli reader nie odtwarza dokładnego accepted v3, odrzuca go.
Nie wolno dopuścić starego workera do nowego planu tylko dlatego, że zgadza się
worker protocol: admission/Prepare/Start wymagają spójnego pakietu czytników.
Rollback odmawia nowych v3 admission i zachowuje istniejące runy/CAS; nie
obniża wersji ani nie uruchamia zależnego zadania przez starszą ścieżkę.

Ten przyrost da się wdrożyć oddzielnie dla już wspieranych solver steps.
Nie zmienia `StudyStepKind`, `StudyIR`, worker operation ani dispatchu. Nie
zamyka pełnego B02: inspekcja anteny, qualified basis, analiza widma i inne
synthetic actions nadal wymagają osobnego typed accepted-producer kontraktu,
codec oraz wykonawcy. Późniejsza migracja operations otrzyma osobną decyzję i
wersjonowanie; nie jest implicytną częścią v3 opisanego tutaj. Completion nie
kwalifikuje bazy anteny, solvera, urządzenia ani wyniku naukowego.

### Następny spójny fragment źródeł i kontrole

| Miejsce + istniejący symbol | Niezbędna zmiana completion-only |
|---|---|
| `crates/fullmag-authoring/src/study_contract.rs` — `StudyStep`, `StudyPlan::validate`, `StudyPlan::topological_order` | v3, presence-aware migracja pola, referencje i jeden union DAG |
| `crates/fullmag-plan/src/study_lowering.rs` — `StudyStepExecutionPlan`, `lower_study_plan`, `StudyExecutionPlan::validate` | v3, dokładne kopiowanie pola, disabled-source refusal i zgodność grafu |
| `crates/fullmag-application/src/script_pipeline_compilation.rs` — `ScriptPipelineCompilation`, `CompiledScriptExecution` | Konsument kompilacji budujący StudyPlan przypina edges do execution IDs; zachowuje authored inventory i indeks makra |
| `crates/fullmag-plan/src/study_catalog.rs` — `StudyProblemCatalog::validate_for` | Regresja wiązania v3 digestu; bez nowego rodzaju entry |
| `crates/fullmag-application/src/run_spec.rs` — `StudyReference` | Regresja exact version/digest, bez nowego pola |
| `crates/fullmag-runtime-control/src/study.rs` — `queue_accepted_study_task`, `load_accepted_worker_step`, `load_accepted_worker_step_for_start`, `validate_study_task_completion` | Wspólny validator trwałego ukończenia i rewalidacja na queue/Prepare/Start; oddzielić historyczny proof od aktywnego lease |
| `crates/fullmag-runtime-control/src/scheduler.rs` — `inputs_are_automatically_resolvable`, `schedule_next_ready_accepted_task` | Użyć tej samej completion gate, zachowując resolver danych i resource admission |
| `crates/fullmag-runtime-control/src/lib.rs` — `commit_transition_with_catalog_revision`, `reconcile_coordinator_catalog` | Zachować journal-before-success i istniejący completion barrier; kontrola rewizji/readiness bez rozluźnienia lease przy publikacji |

W ramach kodu trzeba zinwentaryzować wszystkie konstruktory `StudyStep` i
`StudyStepExecutionPlan`, serialization fixtures, czytniki accepted snapshots
oraz adapter tworzący plan. Zmiana constructorów ma przenosić jawne edges;
mechaniczne `[]` nie może zgubić sekwencji nowych planów. Stare fixtures
pozostają v1/v2 i potwierdzają dotychczasowe canonical bytes.

Bieżący inventory constructorów i readerów (przed zmianą kodu):

- `crates/fullmag-authoring/src/study_contract.rs` — `StudyPlan::from_pipeline`
  oraz `migrate_node` tworzą kroki adaptera; konstruktor nie może
  samym bumpem stałej ogłosić, że stary strukturalny adapter już używa nowego
  kompilatora wykonania.
- `crates/fullmag-authoring/src/scene_study_plan.rs` —
  `scene_document_to_study_plan` ma drugi literal `StudyStep` oraz deleguje
  pipeline do `from_pipeline`. Ten caller musi jawnie wybrać semantykę nowego
  planu albo zachować ścieżkę legacy; nie może gubić edges.
- `crates/fullmag-plan/src/study_lowering.rs` — `lower_study_plan` ma jedyny
  produkcyjny literal `StudyStepExecutionPlan` w przeszukanych Rust sources.
- `crates/fullmag-application/src/execution.rs` —
  `study_task_input_fingerprint` musi uwzględniać nowe canonical lowered bytes.
- `crates/fullmag-runtime-control/src/study.rs` —
  `load_accepted_study_snapshot` odtwarza study i katalog oraz ponownie loweruje;
  sprawdza zgodność wersji i nowych edges zanim queue/worker użyje wyniku.
- `crates/fullmag-api/src/run_intent_persistence.rs` — wywołania
  `lower_study_plan_with_catalog`, `load_accepted_study_snapshot` i
  `study_task_input_fingerprint` są admission/replay callers;
  `crates/fullmag-api/src/router_v2/handlers/platform/compute_preview.rs` —
  wywołanie `lower_study_plan_with_catalog` jest preview caller.
- Fixtures wymagające kontroli wersji, nie mechanicznego bumpu:
  `scene_study_plan_tests.rs`, `study_contract.rs`, `study_lowering.rs`,
  `study_catalog.rs`, `study_execution_materialization_tests.rs`,
  runtime-control `study_tests.rs`, API `run_intent_persistence.rs`,
  `router_v2/tests/project_documents.rs` i
  `router_v2/handlers/platform/compute_preview_tests.rs`. Komentarz wire w
  `crates/fullmag-api/src/schemas/projects.rs` wymaga aktualizacji po wdrożeniu.

Kontrole wymagane przed uznaniem implementacji za spójną:

- Parse/round-trip v1/v2/v3; obecność nowego pola pod v1/v2 odrzucona, v3 bez
  pola odrzucone, `[]` poprawne; historyczne digesty niezmienione.
- Unknown/duplicate/self/disabled dependency oraz cykl wyłącznie w union DAG;
  deterministyczne lowering i fingerprint zmieniający się wraz z edge.
- Sekwencja rzeczywistych wykonów przez grupę i makro; brak tasków zastępczych
  dla authoring-only węzłów, brak ponownego zastosowania mutatorów/profilu.
- Producent Running/Completing/Failed/Cancelled, sam manifest lub same
  `Succeeded` bez zgodnego journalu nie uwalniają konsumenta; dokładny udany
  attempt z kompletnym manifestem i zwolnionym lease uwalnia go.
- Stary attempt/epoch, zmieniony CAS lub brak manifestu blokują scheduler,
  bezpośrednie queue, Prepare oraz Start; Start wykrywa zmianę po Prepare.
- Crash po durable completion przed projekcją sukcesu: istniejący recovery
  naprawia projekcję bez drugiego wykonania; crash po queue nie omija gate.
- Dwa niezależne kroki nadal mogą być gotowe równolegle; required StepOutput
  nadal wymaga własnego portu/codec/bajtów. Completion nie tworzy danych.
- Unsupported synthetic action oraz niekwalifikowana baza nadal są odrzucone;
  żadna kontrola completion-only nie jest dowodem naukowym lub pełnym B02.

Indeks powyższych symboli opisuje obecne granice implementacji, **nie obecność
pola v3 w źródle**. ADR jest kontraktem aplikacji, bez nowych równań, parametrów
Python lub semantyki `ProblemIR`; nie zastępuje terminalnej dokumentacji
naukowej ani jej mapy źródeł i walidacji publikacyjnej.

## Rozszerzenie decyzji — accepted inspekcja zamkniętego obwodu v4 (12.10.2026)

Status: **zaakceptowany pion implementacyjny, doc-first; source patch w review,
build i runtime NOT VERIFIED**. Completion-only v3 pozostaje oddzielnym
kontraktem. To rozszerzenie nie uznaje inspekcji za kwalifikowaną bazę pola,
źródło LLG ani widmo. Nauka, jednostki i zakres są określone w
[notatce 0950](../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md),
`DOC-ANCHOR:antenna-prepared-accepted-loop-contract` oraz
`DOC-ANCHOR:antenna-closed-loop-qualification-receipt-gap`.

### Producer rzeczywistych wykonań

Publiczny accepted caller korzysta z istniejącego bounded
`script_pipeline_compilation::materialize_script_pipeline_with_output_policy_bounded`.
Przechwytuje authored tree, inventory definicji anteny i źródła przed
kompilacją; jedna materializacja stosuje mutatory, activation i ekspansję
makra. Kolejna warstwa nie powtarza tych skutków. Task `step_id` równa się
`CompiledScriptExecution.execution_id`; authored ID, ancestors i expansion
index pozostają odrębnym inwentarzem. Grupa, disabled node i mutator bez
execution nie dostają sztucznego tasku. Completion edge łączy każde następne
rzeczywiste execution z poprzednim, również przez granicę grupy/makra.

Pierwszy pion akceptuje wyłącznie rzeczywiste executions typu
`ResolvedScriptStageAction::AntennaClosedLoopInspection`. Unsupported enabled
action odrzuca całe zgłoszenie przed Submit; nie jest pomijana. Dołączenie Run,
Relax, checkpointów, ExternalLead, FieldBasis lub Spectrum wymaga kolejnej
jawnej operacji. Historyczny strukturalny scene/pipeline adapter pozostaje
legacy i nie deklaruje expanded execution inventory.

Pierwszy capture obsluguje zaufany DSL, ktory tylko odczytuje dane:
`trusted_readonly_dsl_observed_io.v1`. Przechwytuje entry script, faktycznie
zaobserwowane lokalne importy/odczyty oraz pinned runtime closure CPython,
Fullmag i NumPy. Zaobserwowany odczyt poza inwentarzem, symlink/junction,
zmiana bajtow i przekroczenie limitow blokuja Submit. CPython audit nie
potwierdza kompletnosci arbitralnego natywnego IO:
`native_io_completeness=NOT_VERIFIED`. To nie jest sandboxing.
Fullmag ma identity `source_tree_only`, bez kwalifikowanego build binding.
Limity: source 8 MiB, runtime 128 MiB, plik 32 MiB, 8192 rekordow;
16 MiB dotyczy metadanych pipeline. Profil id/version jest wiazany raz,
a materialized identity pozostaje w `study_problem_catalog.v3`.
Sampling mutations sa zachowane; konfliktowy ChangeDevice odrzuca cale
Submit z authored ID, bez rebindu profilu i oslabiania katalogu.
`script_pipeline_source.v1` jest immutable assetem archiwum i RunSpec pod
zastrzezonym ID `script-pipeline-source`. Execution ProblemIR katalogu jest
wiazane przez ten inwentarz. Nie zawiera końcowego RunSpec/catalog digestu, aby nie
utworzyć cyklu hash. Recovery korzysta z accepted bajtów, nie uruchamia
ponownie Python ani roboczego config.

### Typowana operacja i istniejący plan field-only

`study_plan.v4` dodaje strict wariant kind `closed_loop_inspection` z
`stage_id`, `port_mode_id` i `output_id`. Są to dokładne fizyczne refs,
nie nazwy/ordinal taska. Wariant jest zabroniony pod v1/v2/v3, także w
wyłączonym kroku; null, nieznane i dodatkowe pola nie stają się fallbackiem.
W v4 completion_dependencies nadal są wymagane jako jawna lista.

Lowering korzysta z istniejącej sumy `BackendPlanIR::AntennaFieldOnly` przez
`fullmag-plan::antenna_field_only::plan_antenna_field_only_carrier`.
To rzeczywisty source-mesh/sampling plan bez magnetic DOFs i LLG; nie jest
placeholderem TimeEvolution. Nie tworzymy równoległego StudyIR ani nowego
solverowego modelu. Dodatkowo exact
`plan_antenna_field_solve_execution` musi zwrócić ClosedLoopInspection i
zgodne stage/port/output. Fingerprint wiąże pełny accepted ProblemIR,
kanoniczny carrier, operation kind, source capture, profil i completion edges.
Inspekcja nie przyjmuje `until_seconds`, stanu magnetyzacji ani kontynuacji
zegara integratora. Dotychczasowe solver steps zachowują swoje horyzonty.

### Preparation i protocol

Inspekcja wymaga odrębnego typed operation preparation: exact
run/step/spec/problem/plan fingerprints, rzeczywisty natywny mesh-space
producer dla zaakceptowanej siatki H1/P1, source-cut/sampling identity i
budget. Nie fabricuje geometry/grid/display/LLG certificates. Istniejący
`native_fem::prepare_fem_mesh_space` może dostarczyć swój rzeczywisty wynik;
walidacja porównuje go z exact source mesh. Brak natywnej realizacji blokuje
gotowość przed claim/Start; source plan nie jest native evidence.

`resolved_task_input.v4` oraz `worker_protocol.v4` rozróżniają operation
preparation od dotychczasowego solver preparation. Stare v2/v3 inputy,
protokoły i checkpointy pozostają czytelne pod własną zapisaną wersją;
nie wolno globalnie podnieść stałej i przepisać odzyskiwanego journalu.
Nowy reader odrzuca mixed operation/binding/schema przed efektem.
Wszystkie komendy i eventy jednego attemptu zachowują jeden protocol version.
Stary worker nie może przyjąć v4. Idempotency replay porównuje exact immutable
identity. Canonical bytes v1/v2/v3 nie dostają nowych default pól.

Queue, claimed admission, Prepare, Start i replay stosują wspólną completion
gate v3 oraz exact operation/preparation validation. Zachować host-ledger →
store lock order i checked callback przed reservation; nie nabywać host lock
pod store writerem ani writerem drugiego handle. Ukończony producer nie
potrzebuje aktywnego lease; nowy consumer potrzebuje własnego aktualnego
claim/lease/epoch. Corrupted success nie jest zwykłym not-ready.

### Supervised effect, CAS i odzyskiwanie

Existing accepted worker/supervisor dispatchuje operation do
`fullmag-runner::execute_antenna_closed_loop_inspection` dla exact
zaakceptowanego input/request/output. Wymuszony GPU/FDM lub niespójny profil
nie daje fallbacku. Native CPU, strict double są oddzielone od requested
`auto`, jeżeli existing runner przyjmuje je jawnie; resolved lane pozostaje
CPU. Shared heartbeat/Stop i durable attempt.started obowiązują przed solve.
Native solve jest niepreemptive: interrupt jest sprawdzany przed i po wywołaniu;
Stop nie obiecuje przerwania wnętrza solve ani publikacji częściowych danych.

Output port `inspection` typu Artifact przenosi jeden bounded CAS object,
codec `fullmag.antenna.closed_loop_bundle/v1`. Framing obejmuje exact istniejący
manifest.v2 i wyłącznie jego canonical payloads: safe relative paths,
sprawdzone długości, brak escaping, duplikatów, nadmiarowych members i
trailing bytes. Limit retained transport to minimum 512 MiB,
claim storage i claim memory / 16, sprawdzane przed framing allocation.
Reserve dotyczy kopii transportu/decodera; nie kwalifikuje pamieci native
solvera ani wszystkich alokacji serde JSON. Nie używa giant JSON/base64 ani nested CAS
reachability wymagającej nowego GC kontraktu.

Application rejestruje framing codec; runtime-control, które już zależy od
runnera, ponownie używa `closed_loop_v2::verify` dla pełnej fizycznej kontroli
bajtów i owner identity. Nie duplikuje verifiera ani nie tworzy dependency
cycle application → runner. Publication, Completed i późniejszy readback
dependency wymagają zgodnego typed manifest/CAS. Completed oznacza durable
wykonanie z assessment Unassessed; qualification nadal NOT VERIFIED i
field_scope nadal inspection_only. Qualified basis, projection i FFT wciąż
odmawiają takiego raw źródła.

Crash po started bez kompletnego zweryfikowanego wyniku wymaga jawnego
reconciliation i nie uruchamia solve drugi raz. Kompletny committed wynik i
journal odzyskuje się idempotentnie bez natywnego rerunu. Brak/corrupt CAS
w pozornym sukcesie blokuje dalsze zadania. Stop/release, token/epoch fencing,
watermarks i owned attempt paths zachowują istniejące granice.

### Publiczny caller i bramki dowodowe

Jawny accepted tryb script buduje rzeczywisty archive/envelope i używa
istniejącego POST `/v2/persistence/projects/{project_id}/runs`, materialization
i immutable readback. Nie dodaje endpointu ani runnera per projekt. Zwykłe
`fullmag x.py` i polityka jego sibling `x.zarr` pozostają dotychczasowe.
CLI `run-script-accepted` wymaga project archive, jawnego published
execution profile, minimum resources i idempotency key. Admission nie
re-expanduje autora; source coverage i capture bijection sa sprawdzane przy
Submit i replay. Ten pion publikuje Artifact/CAS. Legacy disk inspection
reader nie jest automatycznie przekierowany na bundle i nie stanowi dowodu
nowego live UI flow.

Required source regressions obejmują legacy canonical roundtrip/hash,
version/presence i mixed-worker refusal, disabled ancestors/global duplicate
IDs/macro index, one materializer/profile owner, source/import/assets tamper,
operation refs/preparation/native mesh mismatch, framing limits i pełną
weryfikację payloads, stale attempt/epoch/CAS, manual queue/claim bypass,
released producer lease, Stop i crash bez drugiego efektu. Rust regressions
mogą zostać napisane bez kompilacji podczas source review; parser/model checks
nie zastępują managed build ani actual public native fixture.

Wymagany późniejszy dowód: public script → accepted tasks → native V/J/H →
one CAS bundle/typed manifest → durable Completed → recovery readback, przez
istniejącą single queue. To kwalifikacja ścieżki aplikacyjnej inspekcji,
nie naukowa kwalifikacja field basis ani pełne zamknięcie B02.


### Mapa zrodel proponowanego pionu v4

| Sciezka | Symbol |
|---|---|
| `crates/fullmag-application/src/script_pipeline_acceptance.rs` | `compile_accepted_closed_loop_pipeline`, `validate_accepted_script_pipeline_source`, `validate_script_source_assets` |
| `crates/fullmag-cli/src/script_source_capture.rs` | `capture_authored_script` |
| `crates/fullmag-authoring/src/study_contract.rs` | `StudyStepKind::ClosedLoopInspection` |
| `crates/fullmag-plan/src/study_lowering.rs` | `validate_closed_loop_operation` |
| `crates/fullmag-application/src/closed_loop_preparation.rs` | `ClosedLoopPreparationReceipt::validate_for` |
| `crates/fullmag-runtime-control/src/study_inspection.rs` | `validate_accepted_inspection_bytes`, `inspection_bundle_budget` |
| `crates/fullmag-application/src/antenna_inspection_bundle.rs` | `encode_antenna_inspection_bundle`, `decode_antenna_inspection_bundle` |
| `crates/fullmag-api/src/accepted_study_worker.rs` | `execute_accepted_closed_loop_worker_start` |
| `crates/fullmag-cli/src/accepted_script_run.rs` | `submit_script` |
| `crates/fullmag-session/src/cas.rs` | `CasStore::get_bounded` |

Patch i source index podlegaja pelnemu review przed aplikacja. Parser
source-only nie potwierdza typechecku, runtime ani zamkniecia B02.
