# P6-A — integracja publikacji migracji z rzeczywistym wykonaniem

Data: 30.09.2026
Status: **SOURCE AUDIT / REVIEW PASS / PROPOSED IMPLEMENTATION ORDER / NOT IMPLEMENTED**.

To jest uszczegółowienie następnego kroku ADR-0035 i przyrostu 30, a nie
dowód działającego importera. Nie podnosi P6 powyżej 52%.

## Brakująca granica wykonania

Adapter przyjmuje dokładną tożsamość, lecz nie dowodzi jej pochodzenia.
`FmsArtifactCatalogEntry` przechowuje task, attempt i ownership epoch,
digest oraz opcjonalną lineage. `FmsRunManifest` i `FmsRunCatalog` nie
przechowują dokładnego `session_id` i `runtime_id` producenta.
`FmsSessionManifest.session_id` identyfikuje zapis sesji; sam związek runu
z takim zapisem nie dowodzi sesji, która wyprodukowała konkretny artefakt.
CLI `RunManifest` ma session/run, ale nie pełny kontekst stage/runtime.

Nie wolno użyć bieżącej sesji, nazwy katalogu, PID, resource lease ID,
engine ID ani nazwy solver lane jako brakującego ID. Receipt startu procesu
służy kontroli własności procesu, a nie dowodzeniu identity artefaktu.
`accepted_study_worker.rs` obecnie wywołuje opisywaną trasę runnera dla FDM;
nie stanowi to produkcyjnego callera FMR.

Read-only review i sprawdzenie źródeł wskazują rzeczywiste callery w
`fullmag-cli/src/orchestrator.rs`: gałąź callback około linii 9091
(`run_planned_problem_with_callback_and_hysteresis_stage_id_and_relax_handoff`)
oraz interaktywną około linii 10622
(`run_planned_problem_with_callback_and_hysteresis_stage_id`). CLI posiada
session/run i `stage-{index}`, lecz jego `SessionRuntimeSelection` zapisuje
runtime family, engine i worker, bez dokładnego runtime instance ID.
`step_utils.rs::supports_dynamic_live_preview` dopuszcza FDM/FEM; FMR trafia
do gałęzi callback. Nie przepinać go do dynamic live-preview w ramach tej
migracji. Managed worker jawnie odrzuca plany poza FDM CPU/GPU double strict.

## Kolejność implementacji

1. Właściciel runtime zapisuje immutable identity wykonania przed solve.
   Rekord wiąże session/run/stage/runtime, task/attempt/epoch i fingerprint
   zaakceptowanego planu. Zachowuje requested oraz resolved execution.
   Retry z nowym attemptem otrzymuje własny rekord; odnowienie tego samego
   claimu nie może zmieniać identity. Nie dodawać ID do fizycznego ProblemIR.
2. Produkcyjny caller przekazuje ten sam kontekst do istniejących
   identity-aware entrypointów runnera i natywnego ABI. Publication barrier
   wiąże identity z dokładnym source artifact ID oraz hashem bajtów CAS.
   Dopiero taki związek jest wejściem do importera.
   W CLI zmiana dotyczy wyłącznie gałęzi FMR wskazanych wyżej; używa
   `run_planned_problem_with_callback_and_artifact_identity`. Przed zmianą
   trzeba zachować obecne callbacki, sterowanie i stage/handoff contracts.
   Pozostałe backendy nadal korzystają ze swoich dotychczasowych entrypointów.
3. Importer ładuje i waliduje source bytes, record oraz claim fence;
   wywołuje bounded codec z przyrostu 30. Brak dowodu identity oznacza
   odmowę migracji. Nie syntetyzować brakujących danych historycznych.
4. Publikacja zapisuje oddzielne CAS objects: oryginał, zmigrowany manifest
   i raport. Trwały migration root powstaje jako ostatni. Nie zmienia
   artefaktów terminalnego membera ani istniejącego SolutionSet.
5. Dopiero po integracji reachability, eksportu, preflight i restore można
   włączyć admission importera. Sam zapis pliku root nie wystarcza.

## Proponowany rekord publikacji

Miejsce: `runs/<run_id>/frequency_domain_migrations/<migration_id>.json`.
To propozycja do review przed zmianą writerów, nie aktualny format store.

Rekord musi zawierać wersję codec, identity producenta, exact source artifact
ID, task/attempt/epoch, referencję dowodu identity i trzy CAS refs z długościami.
Deterministyczne migration ID wynika z kanonicznej wersjonowanej reprezentacji
tego kontekstu i source digest. Rozdzielić ID migracji od scientific revision.
Report po deserializacji przechodzi `validate()` oraz porównanie obu hashów
i identity z rootem. Status pozostaje `partial`, scope `family_manifest_only`.
Importer sprawdza referenced child artifacts; nie promuje oceny naukowej.

CAS objects wymagają pinów podczas publikacji. Po zapisie rootu wspólny
traversal chroni je przed GC. Replay tego samego requestu sprawdza zgodność
całego rekordu i wszystkich bajtów; konflikt oznacza błąd. Przerwanie przed
rootem nie może tworzyć widocznej częściowej migracji. Oryginalny zapis
i jego hash pozostają bez zmian.

## Integracja storage i archiwum

| Granica źródłowa | Wymagana zmiana i bramka |
|---|---|
| `reachability.rs::StoreWalker::walk_runs_dir` | Rozpoznanie wersjonowanego rootu, walidacja ownera i trzech CAS objects; unknown/corrupt root blokuje apply GC. |
| `fms.rs::plan_run_entries` | Uwzględnienie rootu zgodnie z ArtifactPolicy; polityka może pominąć całą migrację, nie część jej referencji. |
| `fms.rs::plan_cas_entries` | Pełna closure rootu, dowodu identity i trzech objects; nie zgadywać CAS refs z dowolnych pól JSON. |
| `reachability.rs::ArchiveWalker::walk_run` | To samo typed traversal i walidacja hashów/długości/sidecar; brak rootu pozostaje zgodny dla starszych archiwów. |
| Preflight i restore FMS | Odmowa archiwum z częściową closure przed publikacją; zachowanie istniejącej kolejności CAS → documents → checkpoints → session. |
| `SolutionSetCatalog` | Brak dopisywania artefaktów do terminalnego membera; brak przepisywania zamkniętego wyniku. |

## Dowody przed promocją

- Produkcyjny caller rzeczywiście przekazuje wszystkie cztery exact ID;
  managed receipt przypina zmienione źródła i profil.
- Negatywne regresje: brak identity, zmieniony attempt/epoch, conflicting
  owner, brak blobu, zły hash/długość, zmieniony report i unknown codec.
- Replay oraz przerwania przed/po CAS i przed/po root publication;
  oryginał zachowuje bajty i hash, terminalny wynik nie zmienia rewizji.
- Roundtrip FMS zachowuje pełną closure, a brakujący object jest odrzucany;
  reachability obejmuje wszystkie objects przed dopuszczeniem GC apply.
- Kompilacja, wykonywane regresje, managed runtime oraz nauka pozostają
  osobnymi bramkami. Aktualny zakaz kompilacji testów jednostkowych nadal
  obowiązuje; nie kwalifikować nieuruchomionych regresji jako PASS.

Pełne bundles, dependency rebinding i historyczne manifesty bez obsługiwanego
envelope wymagają osobnych wersjonowanych codec. Ten kontrakt nie deklaruje
ich obsługi ani działania migracji w przeglądarce.
