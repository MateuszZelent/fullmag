# P8-53BE — Compute po odtworzeniu workspace

Status: **OPEN**, 07.10.2026. Kontynuacja P8-53 po zamknięciu
[P8-53BD](53bd-incomplete-physics-project-persistence.md).

## Warunek docelowy

Po kontrolowanej wymianie backendu użytkownik może uruchomić rzeczywiste
obliczenia na odtworzonym modelu. Dla pierwszej bramki wybieramy istniejący
legalny FDM CPU, strict, double; nie dowodzi to pozostałych lane'ów ani
kwalifikacji fizyki. Model ma jawnie przypisany materiał, magnetyzację,
oddziaływanie oraz ograniczony etap obliczeń. Dowód musi pochodzić z
normalnego Compute Study w rzeczywistym workspace, po restore.

Wymagane dowody:

1. Przed restartem i po nim identyczna kanoniczna scena oraz dirty dokument;
   świeża instancja API, sesja i scope po odtworzeniu.
2. Normalne przygotowanie FDM przez Build Grid; bez ręcznej podmiany
   ProblemIR, wymuszenia capability lub zastępczego solvera.
3. ACK `solve` z command_id przypiętym do odtworzonej sesji, następnie
   rzeczywisty postęp solvera i ukończony etap tej samej komendy.
4. Terminalny sukces komendy i etapu; failed/rejected/cancelled/skipped
   nie spełniają bramki sukcesu.
5. Requested/resolved provenance FDM CPU strict double.
6. Jawna tożsamość i terminalny wait wszystkich własnych procesów, w tym
   dziecka scratch_runtime. Brak procesu na liście OS nie zastępuje wait.
7. Widoczny canvas, contextLost=false, niezerowy drawing buffer.

## Ustalenia z bieżących źródeł

Baza master: `1ee35b19e4a0e28da31ed5b9e52097d8b01919f8`.

- `studyRuntimeCommandContributions.ts` rejestruje `study.run` jako `solve`
  i kieruje normalne żądanie przez typowaną fasadę komend.
- `development_restart.rs` po restore uruchamia scratch_runtime przypięty
  do zastępczego API. `scratch_runtime.rs` wykrywa pending compute,
  synchronizuje scenę i uruchamia rzeczywiste `fullmag --interactive`.
- Istniejąca fixture `native-workspace-restart-page.tsx` kończy proof na
  tożsamości, scenie, dokumentach i viewportcie. Nie wymaga udanego Compute.
- `smoke-compute-performance.mjs` sprawdza rozpoczęcie wykonania, lecz jego
  terminalny cleanup dopuszcza także nieudane stany. Nie jest gotowym
  dowodem terminalnego sukcesu tej bramki.
- `verify_workspace_browser.py` rejestruje CLI/API/helpery; dotychczasowy
  protokół nie przekazuje jawnego PID i wyniku wait dziecka scratch_runtime.
  Produkcyjny owner posiada Child i obsługuje wait, ale sama kontrola źródeł
  nie dowodzi rzeczywistego terminalnego odbioru w konkretnej próbie.

Read-only przegląd niezależnego agenta potwierdził te granice; żadnej z
powyższych luk nie uznano za PASS. Rust testy jednostkowe pozostają NOT RUN.

## Bieżąca próba

Zarządzany browser korzysta z osobnego frontendu 3258 i własnych API.
Workspace użytkownika 3197 nie jest restartowany. Pierwszy start odmówił
na blokadzie storage; niczego nie usunięto ani nie zatrzymano. Ponowienie
tej samej recepty uzyskało dostęp i działa pod istniejącym uchwytem procesu.
Wynik oraz wykryte problemy zostaną dopisane po terminalnym odbiorze.
Nie podniesiono procentów P0–P8, nie udostępniono publicznego restartu.

## Próba diagnostyczna i odtworzone blokery

Receipt `bb551f895a854177939cd55e9fc1f54f`: **FAILED**, exit 1,
8/8 procesów oraz frontend odebrane, brak replacement API. Model utworzono
przez rzeczywiste UI: FDM CPU strict double, Box 20 × 20 × 10 nm,
region, Ms=8e5 A/m, A=1.3e-11 J/m, alpha=0.01, anizotropia Ku1=1e4 J/m³,
magnetyzacja uniform, pole zewnętrzne (0,0,0.01) T oraz cell 5 nm.
Nie zalicza to wykonania solvera ani walidacji fizyki.

Save stages dla Run until=2e-12 s odmówił:
`invalid scene patch payload: invalid type: floating point 2e-12, expected a string`.
Przyczyna jest w serde SceneStudyState.stages używającym tekstowego
ScriptBuilderStageState. UI prawidłowo wysyła liczbę. Analogicznie narażone
są fixed_timestep i max_steps Relax. Zakres poprawki: osobny typ sceny,
liczbowe canonical writes, nazwany reader legacy tekstu i adapter do
tekstowego buildera. Nie stringyfikować UI ani podmieniać solvera.

Po odrzuceniu szkicu etapu zapisano baseline sceny revision 8 i podjęto
restart. Native stderr zachowuje dodatkową odmowę:
`invalid development API acquisition response: unknown field reason`.
Nie było replacement ani Compute. Osobno należy sprawdzić pending
fdm_grid_refresh/quiescence oraz przekazanie diagnostyki refusal; nie
uznawać nieudanego restartu za dowód prawidłowego odtworzenia.

Nowa zarządzana regresja HTTP w windows/verify_scene_stage_authoring.py
wymaga udanego numeric Run/Relax round-trip, canonicalizacji legacy tekstu,
zachowania extra keys oraz odmowy bool/object/array/null i niepoprawnych
u64 step budgets bez mutacji. Observer jest utrwalony i hashowany w receipt.
Przed poprawką i produkcyjnym buildem pozostaje NOT RUN.

## Diagnoza odmowy acquisition

Niezależny read-only review wskazał, że CLI `development_api_owner::acquire`
dekoduje także legalną ramkę control rejection jako AcquisitionResponse,
który dopuszcza wyłącznie schema/nonce/api_instance_id/workspace. API owner
używa ogólnej odmowy `development_owner_request_rejected`, zawierającej reason.
CLI ma dokładny parser tej odmowy, lecz stosuje go wyłącznie w commit.
Niepoprawna klasyfikacja wyjaśnia komunikat unknown field reason; nie
uprawnia do pominięcia acquisition ani przymusowego restartu.

Pending grid może naruszać bramkę quiescence; stdout/stderr nie dowodzą,
który konkretny warunek acquisition odmówił. Coordinator po znanej odmowie
pozostawia attempted_api i nie ponawia próby dla tego samego API. W kolejnym
przyroście potrzebne są rozpoznanie ścisłej ramki odmowy i dowód jawnego
retry dopiero przy potwierdzonym Running/uncommitted starym ownerze.
Unknown/postcommit nie może zwolnić claimu. W tym przebiegu nie naprawiono
jeszcze tych granic; nie zalicza się retry ani Compute jako PASS.

Rozszerzenie numeric DTO obejmuje również jawne kolizje obecnego UI:
torque/energy tolerance, eigen_count, eigen_target_frequency, liczbową
trójkę eigen_k_vector oraz scalary adaptive_timestep. Extra payloady
pozostają lossless JSON. To reprezentacja istniejących żądań, bez dodania
capability, zmiany IR/fizyki lub kwalifikacji modalnej.

## Stan implementacji i dowodów

Rozdzielony DTO sceny, legacy scalar/vector reader, adaptery i fail-closed
export są wdrożone w source. Niezależny review: bez actionable findings.
Rust regression source został przejrzany, lecz **NOT RUN** zgodnie z zakazem
kompilowania testów jednostkowych. Parser AST observera Python PASS.

Pierwszy zarządzany BuildOnly, log
`native-build-cec85996f82d4186aaf9ff3ccd0700d3.log`, zakończył się exit 1
przed Cargo: Origin changed while copying a source file. Wrapper ponawia
capture trzy razy, nie kompiluje zmienionej/torn kopii. Dodano nazwę
konkretnego chronionego pliku do diagnozy wyczerpanych prób. Ponowienie
tego samego profilu nie omija seal/fingerprint/source-identity checks.
To blokada bieżącego snapshotu, nie wynik błędu Rust ani nieudanej fizyki.

### Numeric stage authoring — CLOSED, 07.10.2026

Ponowiony managed `just windows-backend-dev 3197` zakończył się exit 0:
CLI/API oraz desktop zbudowane bez kompilacji testów jednostkowych.
Log `native-build-774c99aba27347cda7e1bbb169cf449e.log`;
manifest `7d87e9c8bdeaf1ad95c9aa8884db6758e4e657f4bb852e90c5995b54a44dd74e`,
backend source `abc815900a993a4b4a7d8abbb96c068ada537e070f9c36d4695e126e9a82d8d8`.
Trzy zmienione pliki fullmag-authoring są byte-equal z frozen source.

Zwykły project-document preflight odmówił po późniejszych zmianach wspólnego
checkoutu (receipt `accc34feda6c41f0839e4b6e64f4bbfe`, blocked, exit 2).
Dodano osobną trasę `just verify-windows-project-document-frozen <manifest SHA>`:
wiąże EXE i Python helpers z tym samym zweryfikowanym snapshotem, zamiast
korzystać z później edytowanego pakietu Python. Niezależny review bez findings.

Pierwsza próba frozen (`cbfcbeb6ad264ca596aeb3e615fe52df`) wykonała 32 kontrole,
lecz zakończyła się failed, exit 1: helper Python dopisał 81 plików `.pyc`
w `__pycache__` sealed źródeł. Kontrola inventory prawidłowo odmówiła PASS.
Zweryfikowano hash i rozmiar każdego oryginalnego pliku oraz brak procesów
tej próby. Wyłącznie dodatkowy bytecode przeniesiono do jej `bytecode-quarantine`,
zachowując ścieżki i inventory hashów. Record i źródła pozostały niezmienione.
Verifier ustawia `PYTHONDONTWRITEBYTECODE=1` dla API i dziedziczących helperów.
Review poprawki bez findings; nie dodano wyjątku do seal checks.

Finalny receipt `0bdb5b739e864f8786433c83aa17ef28`: **completed, exit 0,
32 kontrole PASS**, wszystkie 6 własnych procesów terminalnie odebrane.
Numeric Run/Relax, adaptive scalary, legacy reader, extra preservation,
odmowy nieprawidłowych typów i u64 bez mutacji: PASS przez rzeczywistą
transakcję i odczyt sceny. Canonical OpenAPI identity oraz końcowy manifest,
EXE i frozen source integrity: PASS. Rust unit regression source: NOT RUN.

Zamknięcie dotyczy błędu numeric stage authoring i regresji API/persistence.
Nie dowodzi solvera, Compute po restore ani publicznego restartu. Wymienione
niżej bramki nadal są otwarte; UI użytkownika na 3197 nie restartowano.

## Dalszy blocker Compute — pending FDM grid

Read-only tracing potwierdził ścieżkę blokady świeżego workspace:
StudyInspectorPanel Apply Grid kolejkuje `fdm_grid_refresh`; whitelist
`pending_compute_command` scratch_runtime ignoruje ten rodzaj. Solve nie
uruchomi wykonawcy, ponieważ API odmawia Compute przy aktywnej komendzie
meshu. Acquisition również odmawia przy pending grid. Obserwacja tego
przebiegu oraz tracing określają następny konieczny krok, nie stan PASS.

Runner już klasyfikuje grid refresh jako Remesh i obsługuje go wewnątrz
wait_for_solve bez rozpoczęcia symulacji. Naprawa musi podłączyć ten rodzaj
do istniejącego wykonawcy oraz zapewnić terminalny odbiór grid-only child
przed restartem. Samo rozszerzenie whitelisty nie zamyka quiescence,
bo scratch pause nadal wymaga child.is_none(). Nie omijać admission ani
nie zaliczać braku widocznego PID jako wait.

## Checkpoint po zamknięciu numeric prerequisite

Numeric fix jest na lokalnym i remote master:
`2102e64c040ddeecb5dba6b454154081769c1e42`. Frozen build D i receipt
32/32 dotyczą tej poprawki, nie późniejszych zmian restartu.

Przygotowano osobny **WIP source** acquisition w development_api_owner.rs:
exact rejection parser i typowana odmowa przed handoff. Source tests dodane,
**NOT RUN**; brak native/runtime kwalifikacji tego przyrostu.
Nie zaliczać go na podstawie wcześniejszego builda D.

Wariant retry pump został wycofany po niezależnym review. Rzeczywisty
transport zachowuje immutable slot starego API i odrzuca inne request_id
HTTP 409; samo dopuszczenie nowej próby w pump jest nieosiągalne.
Ponadto wykorzystany readiness_candidate pozostawia memo tej samej identity
i blokuje ponowne przygotowanie. Potrzebny jest kontrolowany następnik
slotu po dokładnie potwierdzonej odmowie przed handoff, zachowanie historycznych
request/result oraz poprawny cykl ponownej walidacji candidate. Ogólne Failed,
Unknown i niepotwierdzona publikacja nie mogą uprawniać do następnej próby.
Unit test samego predykatu retry nie dowodzi tych granic. Rozpoznanie
acquisition rejection przeszło source review bez findings; retry pozostaje OPEN.

Review grid-only custody wskazał wymagany kontrakt przed implementacją:

- Lokalne przygotowanie przez istniejący manual remesh bez asynchronicznego
  publishera. Bootstrap nie może utworzyć sztucznego run/live/stage ani
  zastąpić authoring identity. Końcowy payload dopuszcza mesh_workspace
  i opcjonalnie engine_log; pola wykonania i flagi wymiany pozostają puste.
- Odbiornik pobiera wyłącznie przypięty Grid ID i kończy polling przed
  opublikowaniem terminalnego wyniku. Obecny poller pobiera komendy z API
  przed lokalnym odbiorem; samo zatrzymanie na końcu może zgubić późniejsze
  Solve. Inne kolejkujące się komendy muszą pozostać w API.
- Synchroniczny ACK publikacji oraz exact command ledger confirmation:
  ID/kind/API/session scope, completion i timestamp. 404/unavailable
  oznacza unknown. Następny child dopiero po normalnym wait i potwierdzeniu.
- Prep failure i scene/session drift wymagają scoped failure/reconciliation;
  nie publikować sztucznego failed run ani usuwać custody przez sam kill.

Wstępny eksperyment whitelist/early exit został wycofany przed buildem:
nie spełniał wszystkich powyższych granic. Scratch runtime, orchestrator
i live publisher nie mają zmian z tego eksperymentu. Grid i końcowe Compute
po restore nadal są **OPEN**, bez zmiany procentów P0–P8.
