# Granica wykonania workera i publikacji wyników — audyt P3-B

Data: 25.09.2026

## Ustalenie

Istniejący adapter `fullmag-api::accepted_study_worker::collect_runner_study_outputs`
zamienia jawnie dozwolone pliki zakończonego runnera na typowane payloady
study. Nie jest jednak wywoływany przez produkcyjnego supervisora ani proces
workera. Obecna ścieżka `fullmag-runner::run_planned_problem` zapisuje do
`output_dir` przez writer plikowy; nie publikuje do session CAS ani
`FmsArtifactCatalog`. Durable Submit tworzy intent i projekcję run catalogu,
a `Prepare` zapisuje outbox command, lecz żaden z tych punktów nie uruchamia
solvera.

Potwierdzone granice kodu:

- `crates/fullmag-runner/src/lib.rs` — runner przyjmuje katalog wynikowy i
  uruchamia solver;
- `crates/fullmag-runner/src/artifacts.rs` — artefakty są zapisywane jako pliki;
- `crates/fullmag-api/src/run_intent_persistence.rs` — Submit materializuje
  trwały run bez wywołania workera;
- `crates/fullmag-runtime-control/src/study.rs` — istnieją typed wejścia,
  preparation receipt, Prepare outbox i fenced publikacja study outputs;
- `crates/fullmag-runtime-control/src/lib.rs::commit_transition` — terminalne
  `Completed` przechodzi przez completion barrier przed zapisem journala.

Wniosek: kompletne kontrakty Submit, claim, Prepare, codecs i publikacji nie
składają się jeszcze w działający przepływ solvera.

## Najwęższy bezpieczny przyrost

Zintegrować jeden accepted FDM task przez istniejące kontrakty, bez zmiany
legacy trybów CLI/Python:

1. Odczytać immutable `ResolvedTaskInput`, RunSpec, zaakceptowany study step i
   preparation receipt; odrzucić zmianę fingerprintu.
2. Odtworzyć claim i potwierdzić dokładny attempt, ownership epoch oraz aktywny
   resource lease bezpośrednio przed side effectem.
3. Uruchomić zaplanowany problem w prywatnym katalogu `run/task/attempt`; nie
   wykonywać polecenia ponownie po utracie ACK bez reconciliation trwałego stanu
   inbox/workera.
4. Zbudować outputy wyłącznie z jawnej allow-listy adaptera. Nie skanować całego
   katalogu ani nie publikować plików tymczasowych lub częściowych.
5. Zweryfikować komplet deklarowanych portów i codeców, zapisać payloady do CAS,
   a następnie dopisać immutable manifest/katalog przez
   `append_artifact_catalog_entries_for_lease`.
6. Dopiero po publikacji i sprawdzeniu digestów przekazać `Completed`; completion
   barrier musi odczytać ten sam attempt i komplet wymaganych outputów.

Publikacja outputów przed `Completed` pozostawia możliwy stan „artefakty gotowe,
event jeszcze niezapisany”. Retry/recovery musi dokończyć transition z już
utrwalonym wynikiem albo bezpiecznie uznać completion jako replay; nie może
ponownie uruchomić solvera ani dopisać innych bajtów pod tym samym ID.
Identyfikatory i logiczne ścieżki muszą zawierać attempt, a stary epoch nie może
publikować po retry lub release lease'u.

## Kryteria odbioru

- dokładnie jeden fenced worker realizuje accepted task i utrwala wykonawczy
  receipt przed nieodwracalnym ponowieniem;
- CAS, output manifest, artifact catalog i `artifact_ids` taska wskazują te same
  bajty, attempt i ownership epoch;
- replay po awarii na granicy: po zapisie CAS, po katalogu artefaktów i przed
  `Completed`, nie dubluje obliczenia ani wpisów;
- stary attempt, brak aktywnego lease, zmieniony RunSpec, niekompletny output,
  niezadeklarowany port, symlink, path traversal lub nieobsługiwany codec blokują
  publikację bez mutacji katalogu;
- dopiero po managed testach accepted-run można raportować kontrakt bridge jako
  zweryfikowany; wykonanie solvera, device provenance, browser/runtime i
  walidacja fizyczna pozostają odrębnymi bramkami.

## Status

To jest audyt granicy i kolejny slice implementacyjny, nie ukończony worker.
Nie zmieniono kodu produkcyjnego w ramach tego checkpointu. Nie uruchomiono
solvera. P3 pozostaje **50%**, a plan globalny około **27%**.
