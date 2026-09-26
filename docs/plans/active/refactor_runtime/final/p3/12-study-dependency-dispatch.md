# Kontrola zależności i lineage przed dispatch taska study

Data: 25.09.2026
Zakres: P3-B / P5-B — weryfikacja wejść study przy odczycie do dispatchu.

## Zmiana

`AcceptedStudySnapshot::resolve_task_input_from_store` ponownie sprawdza
deklarację wejść kroku przed zbudowaniem `ResolvedTaskInput`:

- odrzuca nazwy wejść nieobecne w zaakceptowanym `StudyStep`;
- odrzuca brak każdego wymaganego portu;
- dla `StepOutput` wyprowadza task źródłowy z immutable `run_id` i `step_id`;
- pozwala kontynuować tylko wtedy, gdy task źródłowy ma lifecycle `Succeeded`,
  attempt i ownership epoch.

Kontrola jest przy granicy odczytu durable receipt i aktywnego claimu. Wcześniej
katalog mógł deklarować consumer `Ready`, mimo że poprzednik study nadal się
wykonywał lub zakończył niepowodzeniem. Dla wejścia `StepOutput` resolver
sprawdza również katalog artefaktów tego runu i wymaga dokładnego dopasowania
`step_id`/`port_id`/`case_id`, taska źródłowego, bieżącego attemptu i epoch,
statusu `Published`, referencji CAS, `artifact_id` oraz `content_sha256`.

`FmsArtifactCatalogEntry.study_output` jest opcjonalne i domyślnie pomijane w
JSON, więc stare wpisy nadal się deserializują bez zmiany wire shape. Katalog
odrzuca lineage przypisaną do taska innego kroku, status nieopublikowany oraz
duplikat tożsamości outputu w ramach tego samego taska, attemptu i epoch.
Ta sama logiczna para port/case może więc zachować immutable outputy z kolejnych
attemptów. Stary wpis bez tej metadanej pozostaje dostępny do odczytu i eksportu,
lecz fail-closed dla nowego `StepOutput`.

Append-only store zachowuje wcześniej opublikowane wpisy mimo retry taska.
Wpis już obecny w durable katalogu nie jest ponownie oceniany względem bieżącego
ownera; każdy nowy wpis musi natomiast pasować do aktualnego attemptu i epoch.
Nowe `study_output` są dopisywane pod aktywnym, dokładnie zweryfikowanym lease,
gdy task jest `Preparing`, `Running` albo `Stopping`; publikacja musi nastąpić
przed terminalnym zdarzeniem `Completed`. Dokładny replay już opublikowanych
wpisów jest idempotentny, również po przejściu taska do `Succeeded`, ale żaden
nowy wpis nie może wtedy zostać dodany. Dzięki temu awaria po publikacji, lecz
przed completion, może bezpiecznie powtórzyć zapis, a retry nie usuwa
diagnostyki poprzedniego attemptu.

`fullmag-runtime-control::publish_study_outputs` tworzy tę lineage z portów
zaakceptowanego kroku, bajtów wyniku i tożsamości aktualnego claimu. Dane trafiają
do CAS, a append katalogu jest ponownie fenced w SessionStore. Store-backed
adapter koordynatora sprawdza kompletny manifest przed utrwaleniem
`WorkerEvent::Completed`; rzeczywisty supervisor nadal nie wywołuje helpera,
więc brak end-to-end worker flow. Store aktualizuje również
`FmsTaskCatalogEntry.artifact_ids` jako projekcję kanonicznego katalogu artefaktów.
Jeżeli proces przerwie pracę po zapisie katalogu artefaktów, lecz przed projekcją,
dokładny replay pod nadal aktywnym lease naprawia brakujące identyfikatory bez
duplikowania wpisów. Helper wymaga też co najmniej jednego payloadu dla każdego
zadeklarowanego portu output; sprawdza kompletność przed przypięciem pierwszego
obiektu CAS. To nadal nie dowodzi działania rzeczywistego workera.

Następny przyrost dodaje konsumpcję manifestu po stronie resolvera. Dla każdego
`StepOutput` resolver ładuje dokładny manifest z CAS bieżącego udanego attemptu,
sprawdza jego run/task/step/attempt/epoch, kompletność zadeklarowanych portów,
wszystkie wpisy przeciwko artifact catalog oraz zgodność data kind. Do
`ResolvedTaskInput` trafia jawne `artifact_id`, `object_ref`, digest, data kind
i wersja codec; zmieniony payload ma `resolved_task_input.v2` oraz
`worker_protocol.v2`. v1 pozostaje formatem historycznym i nie jest
reinterpretowany jako typowane wejście. Przed terminalnym sukcesem runtime-control
sprawdza zaakceptowany plan, wszystkie output porty, task/attempt/epoch,
artifact catalog, CAS i codec; recovery ponawia tę kontrolę przed projekcją
`Succeeded`. Po publikacji manifest zamraża allow-listę w SessionStore: wolno
powtórzyć dokładne wpisy, ale nie dopisać innego outputu.

## Weryfikacja

- Dodano regresję helpera dla sukcesu zależności, brakującego portu,
  niedeklarowanego portu, upstream `Running`, złego artifact ID/digestu i złego
  `case_id`.
- Dodano opcjonalną lineage outputu do katalogu artefaktów i kontrolę
  unikalności/owner taska w walidacji katalogu.
- Dodano regresję store dla zachowania artefaktu diagnostycznego po retry,
  publikacji outputu podczas aktywnego claimu, idempotentnego replay po
  completion oraz odmowy nowych outputów po completion i po zwolnieniu lease.
  Nowe wpisy pozostają objęte walidacją CAS.
- Dodano runtime-control publication helper z walidacją claimu, deklarowanego
  portu, resource lease, attempt/epoch i pochodnej tożsamości artefaktu.
- Projekcja `artifact_ids` jest dopisywana pod tym samym writer lease; dokładny
  replay naprawia brakującą projekcję po przerwaniu pomiędzy dwoma zapisami.
  Regresje store i API obejmują publikację oraz asercję tej projekcji.
- Helper odrzuca brak któregokolwiek zadeklarowanego portu przed zapisem CAS;
  fixture regresyjny obejmuje output `State` i `Scalar`, próbę niekompletnego
  zestawu oraz publikację pełnego zestawu. Nowej regresji nie uruchomiono.
- Test API zaakceptowanego runu publikuje zadeklarowane `final_state` przez
  helper, odczytuje dokładne bajty z CAS i potwierdza, że task nadal jest
  `Preparing` w chwili publikacji. To syntetyczne bajty testowe, nie wynik
  solvera ani wykonanie przez worker.
- `rustfmt --edition 2021 --config skip_children=true --check` dla zmienionych
  modułów: **PASS**. Wcześniejsze trasy testowe i źródłowe przeszły na kodzie
  sprzed dodania projekcji (`d334239eafc24cc4aa0f5d5bc789acb1`,
  `aa957972d82d4c179246bfe14f12577f`, `f059ecad07c244bca39a8c3150e1145b`,
  `e5fe74a1356f42308616a153cffde899`; ich receipt-y miały
  `source_changed_during_run=false`). Nowa regresja store najpierw wykazała brak
  projekcji: 60 PASS, 1 FAIL zgodnie z oczekiwaniem przed poprawką
  (`0514352fd3f84fb784f7e397e36da5ff`). Po poprawce testy nie zostały ponowione:
  automatyczna kontrola odmówiła kompilacji testów jednostkowych z powodu
  tymczasowego zakazu w `AGENTS.md`. Po poprawce trasa źródłowa
  `just check-api-source` (**PASS**, `74904ea1146d45eab345a0b8cc945d0a`,
  `source_changed_during_run=false`) skompilowała binarium API wraz ze źródłami
  zależności, bez celów testowych. Po walidacji kompletności outputów ta sama
  trasa przeszła ponownie (**PASS**, `3e0ecc8f69b342d7b408878856ff4f20`,
  `source_changed_during_run=false`); `rustfmt --check` również **PASS**.
  Kompilacja jest potwierdzona, lecz zachowanie projekcji i kompletności outputów
  pozostaje **NOT VERIFIED**.
  Po dodaniu konsumpcji manifestu check źródłowy przeszedł (**PASS**, receipt
  `1c1dc0c5aefa4370b25db4648489e078`); po dodaniu terminal barrier i immutable
  manifest freeze aktualny `just check-api-source` ponownie przeszedł (**PASS**,
  receipt `53eb3f4bb7104e108d423bea4fdb2b2a`). Regresje nowych ścieżek pozostają
  **NOT RUN / NOT VERIFIED**. Solver i
  managed runtime nie były uruchamiane; kwalifikacja fizyki/worker transport
  pozostaje **NOT VERIFIED**.

## Otwarte

Wersjonowane kodeki ograniczone do magnetyzacji State/Initial State i scalar SI
zostały dodane w [`13-typed-study-artifact-codecs.md`](13-typed-study-artifact-codecs.md).
Publication dekoduje cały komplet payloadów przed pierwszym zapisem do CAS;
bariera `Completed` i resolver `StepOutput` sprawdzają dokładne bajty z CAS.
Nieobsługiwane data kind, wersje i layouty nadal blokują task jawnie.

Brakuje supervisora rzeczywistego workera. Żaden worker nie tworzy jeszcze
payloadów z zaakceptowanego solvera, nie publikuje output allow-listy przed
terminalnym eventem i nie materializuje zdekodowanego wejścia przy granicy
runnera. Nie ma zatem runtime proof ani zgodności źródłowego stanu z target
preparation.

Decyzja docelowa jest zapisana w
[`ADR-0035`](../../../../../adr/0035-typed-study-artifact-manifest-and-worker-boundary.md):
port pozostaje logiczny, a osobny `study_output_manifest.v1` wiąże zaakceptowany
port/case z data kind, versioned codec, CAS object i digestem. Worker dostaje
niezmienny input ref i dekoduje tylko obsługiwane kodeki. Brak codec blokuje
task jawnie. `Completed` wymaga opublikowanego kompletnego manifestu pod
aktywnym claimem/lease.

Resolver store-backed wyprowadza wejście `StepOutput` z accepted planu, bieżącej
udanej próby, manifestu i CAS; dla pozostałych źródeł przyjmuje jawne,
uprzednio rozwiązane wejścia od wywołującego. Konflikt z caller-provided
`StepOutput` jest odrzucany. Następny krok P3-B/P5-B to supervisor, worker
transport i dowód dispatchu przez rzeczywistego workera. Projekcja
`artifact_ids`, publication, immutable manifest freeze i completion barrier
mają uruchomione regresje: `just verify-session-persistence` **PASS** (receipt
`11ff3056f4654fdfbe04d51129bb7c9b`), `just verify-project-application`
**PASS** (`c7561e2eeb2c4f7d8a3df54e8afb4292`) i
`just verify-api-project-runs` **PASS** (`867f9153c9714377a8b3210be8806d77`).
Końcowy `just check-api-source` **PASS** (receipt
`7dc2d9e1051341728613ed0b69b6d536`). Test writer-a runnera pozostaje
**NOT RUN**: `just runner-list` zgłosił `Container profile allow-list mismatch`
przy aktywnym kontenerze BuildKit i `defer-existing-workload`. To dowód
wybranych zachowań źródłowych/API, nie wykonania przez rzeczywistego workera.

Procenty: **P3 50%, P4 50%, P5 0%, całość około 27%**.
