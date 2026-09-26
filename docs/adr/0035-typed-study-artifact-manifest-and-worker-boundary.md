# ADR 0035: Typowany manifest artefaktów study i granica workera

- Status: accepted for implementation
- Data: 2026-09-25
- Decydenci: Fullmag core
- Powiązany plan: `docs/plans/active/refactor_runtime/final/03-plan-refaktoryzacji.md` (P3-B, P5-B, P6)
- Powiązane decyzje: ADR-0025 (trwały runtime), ADR-0034 (journal i fail-closed recovery)

## Kontekst

`StudyOutputPort` definiuje obecnie tylko `port_id` i `data_kind`. Runner zapisuje
wiele plików wynikowych do katalogu, ale nie publikuje allow-listy wiążącej
konkretny plik z portem, jego formatem i wersją. `StudyOutputPayload` przyjmuje
nieprzezroczyste bajty, a `ResolvedInput` przechowuje wyłącznie `source` i
`content_sha256`. Nie ma więc jeszcze kontraktu, który pozwoliłby workerowi
bezpiecznie odtworzyć typowane wejście następnego kroku.

`publish_study_outputs` wiąże bajty z zaakceptowanym portem, attemptem i lease,
ale nie jest wywoływany przez supervisor. `WorkerEvent::Completed` może ustawić
task na `Succeeded` bez sprawdzenia publikacji outputów. Skanowanie całego
katalogu runnera nie jest bezpiecznym zamiennikiem manifestu: obejmuje też
diagnostykę, pliki pośrednie i częściowe wyniki.

## Decyzja

1. `StudyOutputPort` pozostaje logicznym kontraktem (`port_id`, `data_kind`).
   Nie zapisuje ścieżek plików, nazw runnera ani stanu cache w kanonicznym
   `StudyPlan`/`ProblemIR`.
2. Każdy worker publikuje jawny, niezmienny `study_output_manifest.v1`. Manifest
   wiąże run/task/step/attempt/ownership epoch oraz każdy port/case z
   `data_kind`, identyfikatorem i wersją codec, `artifact_id`, `object_ref` i
   SHA-256 bajtów. Pusty manifest jest dozwolony tylko wtedy, gdy zaakceptowany
   krok nie deklaruje outputów.
3. Bajty outputów i manifest trafiają do CAS. Artifact catalog wskazuje ich
   niezmienne identyfikatory; `FmsTaskCatalogEntry.artifact_ids` pozostaje
   projekcją katalogu i jest naprawiane przez idempotentny replay. Manifest
   powstaje wyłącznie z allow-listy runnera. Nie skanuje się katalogu outputów.
4. Każdy deklarowany output port musi wystąpić co najmniej raz w manifeście.
   Walidacja kompletności, claimu, lease, CAS digestu, codec i lineage musi
   zakończyć się przed terminalnym sukcesem. Nieobsługiwany codec lub
   `data_kind` blokuje task jawnie; worker nie może pominąć danych ani
   przełączyć backendu.
5. `StepOutput` wejście jest rozwiązywane wyłącznie z manifestu bieżącego,
   udanego attemptu. Trwałe `ResolvedTaskInput` przekazuje do worker boundary
   dokładne `artifact_id`, `object_ref`, digest, `data_kind` i wersję codec;
   źródłem bajtów pozostaje CAS, nigdy ścieżka do mutable katalogu.
6. Worker input adapter dekoduje tylko jawnie obsługiwane wersje i materializuje
   wejście przy kanonicznej granicy `ProblemIR`/runnera. Do chwili implementacji
   danego codec task jest `blocked`, nie dostaje przybliżonego lub pustego
   wejścia.
7. Supervisor wykonuje dokładny zaakceptowany task w prywatnym katalogu
   `run/task/attempt`, pod aktywnym claimem i lease oraz jawnym limitem
   współbieżności. Najpierw trwale publikuje kompletny manifest i artefakty,
   dopiero potem wysyła/akceptuje `Completed`. Powtórzony ACK nie uruchamia
   solvera drugi raz. Recovery naprawia projekcję z durable danych, a utrata
   manifestu nie uprawnia do ponownego `Start` tego samego pending effectu.
8. Zmiana payloadu `ResolvedTaskInput` i completion fence wymaga
   `worker_protocol.v2`; v1 nie jest reinterpretowany jako kompletne typowane
   wejście. `artifact_catalog.v1` zachowuje dotychczasowe rekordy; manifest ma
   własny versioned schema i jest zwykłym CAS-backed artifact catalog entry.

## Konsekwencje

- Fizyka, jednostki, `ProblemIR` i requested/resolved execution pozostają
  niezmienione. Output manifest opisuje transport danych, nie interpretuje
  semantyki fizycznej.
- Autorowanie nie zależy od nazw plików runnera. Formaty są rejestrowane i
  wersjonowane po stronie runtime; stary lub nieznany format jest czytelny jako
  archiwalny blob, ale nie może wejść do nowego `StepOutput`.
- Frontend nadal czyta typowany Run Catalog i zasoby artefaktów. Nie dostaje
  lokalnych ścieżek ani własnego dekodera solvera; późniejsze widoki analizy
  użyją kanonicznych API/artifact codecs.
- Granica jest kompatybilna z oddzielnymi realizacjami FDM/FEM i CPU/GPU.
  Manifest zachowuje requested/resolved provenance poza samym `data_kind`.

## Obowiązki implementacyjne

- Dodać walidowany typ `study_output_manifest.v1` i kodeki z jawnym
  rejestrem obsługiwanych wersji.
- Rozszerzyć typowany wynik `ResolvedTaskInput` o immutable CAS references dla
  źródeł study; zwiększyć wersję protokołu workerów do v2.
- Udostępnić z `fullmag-runner` manifest allow-listy artefaktów w miejscu ich
  jawnego tworzenia. Katalogów wynikowych nie wolno skanować.
- Zbudować supervisor/adapter, który odtwarza zaakceptowany `ProblemIR`, plan i
  preparation receipt, dekoduje wymagane wejścia, uruchamia istniejący runner
  bez zmiany lane'u i publikuje manifest przed `Completed`.
- Ograniczyć współbieżność do przyznanych resource leases; scratch jest
  rozdzielony per attempt i pochodny od zweryfikowanego store root.
- Weryfikować w store/runtime-control: kompletność portów, źródłowy attempt i
  epoch, aktywny lease, CAS digest, dokładne codec, monotoniczny journal,
  projekcję `artifact_ids` oraz completion fence.

## Stan implementacji — 25.09.2026

Typ manifestu, CAS publication, store-backed `StepOutput` resolver oraz typed
`ResolvedTaskInput.v2`/`worker_protocol.v2` są obecne w źródle. Durable adapter
sprawdza manifest i dekoder przed journal commit `Completed` oraz przed recovery
projection `Succeeded`; SessionStore odrzuca nowe outputy po opublikowaniu
manifestu i pozwala tylko na dokładny replay. `fullmag-application` rejestruje
teraz `fullmag.runner.field_json@v1` dla `state`/`initial_state` (identyfikowana
magnetyzacja FDM, FDM multilayer i FEM H1 P1) oraz
`fullmag.study.scalar_json@v1` dla skalarów SI. Publication dekoduje kompletny
zestaw przed CAS, a completion i `StepOutput` ponownie dekodują dokładne bajty
odczytane z CAS. Nieznane tuple i nieobsługiwane layouty pozostają fail-closed.

SessionStore freeze przeszedł przez `just verify-session-persistence`
(`11ff3056f4654fdfbe04d51129bb7c9b`); po implementacji dekoderów
`just verify-project-application` przeszedł (`c7561e2eeb2c4f7d8a3df54e8afb4292`),
`just verify-api-project-runs` przeszedł (`867f9153c9714377a8b3210be8806d77`),
a `just check-api-source` przeszedł (`7dc2d9e1051341728613ed0b69b6d536`). Test
runnera sprawdzający emisję state identity pozostaje **NOT RUN**. `just
runner-doctor` wykazał aktywny kontener BuildKit i `defer-existing-workload`,
zaś `just runner-list` zwrócił `Container profile allow-list mismatch`; nie
uruchomiono hostowego ani równoległego fallbacku. Supervisor, dekodowanie i
materializacja wejść w rzeczywistym workerze, publication przed terminalnym
eventem oraz runtime proof nadal pozostają poza tą implementacją.

Aktualizacja 26.09.2026: zbudowany supervisor uruchamia zbudowanego accepted
workera dla ograniczonego FDM CPU/double/strict, odnawia resource lease podczas
życia procesu, publikuje typowane outputy i manifest przed `Completed`, a po
terminalnym lifecycle czeka na exit i zwalnia ostatnią wersję lease. Zarządzane
E2E ma 1/1 PASS. Nie rozszerza to kwalifikacji na FDM GPU, FEM CPU/GPU, fizykę,
crash supervisora, orphan recovery, operator cancel ani retry orchestration.

## Migracja i rollback

Stare outputy bez manifestu pozostają zachowane i eksportowalne, ale nie są
wejściem do nowego `StepOutput`. Protocol v1 pozostaje tylko dla historycznych
zapisów i workerów bez dispatchu; coordinator nie wysyła v2 do procesu
deklarującego v1. Rollback wyłącza admission nowych typowanych tasków i
zachowuje zaakceptowane runy oraz ich CAS. Nie usuwa outputów ani nie uruchamia
ponownie tasków z niepewnym pending effectem.

## Testy i walidacja

- Contract: manifest dokładnie odpowiada bytes/digest/CAS i zaakceptowanym
  portom; niekompletny lub nieznany codec nie tworzy publikacji.
- Store: replay naprawia projekcję po przerwaniu; zmieniony manifest, stary
  epoch lub zwolniony lease są odrzucane.
- Worker: utrata ACK nie uruchamia solvera drugi raz; completion bez kompletnego
  manifestu jest odrzucane; downstream odczytuje dokładne CAS bytes i lineage.
- Każdy solver/device lane ma osobną bramkę runtime. Source check, testy,
  rzeczywiste wykonanie, walidacja fizyki i kwalifikacja wydania są osobnymi
  dowodami. Sam manifest nie kwalifikuje solvera.
