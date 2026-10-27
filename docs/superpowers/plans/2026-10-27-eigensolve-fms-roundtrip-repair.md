# Naprawa round trip FMS dla rzeczywistych modów accepted — 27.10.2026

Uzupełnienie I3/I4/I6 planu `2026-10-26-eigensolve-integration-mode-ui.md`. Cel: zapisać aktualny, ukończony signed15, otworzyć go po zmianie procesu API i otrzymać te same częstotliwości oraz zespolone pola w UI, bez nowego Solve.

## Dowody i granice

Aktualny run `run-live-f6e511007567b55c1e3fad2a56f9c85e914ddce3d5fb6d5565c0df3a40e65a88` jest completed i ma 15 pól. Eksport `solved` zwraca `packing accepted .fms: incomplete session object graph`. Snapshot ma typed `latest_fields.*.accepted_state_ref` i odnośniki do `runs/<run>/artifacts/frequency_domain/generations/<id>/...`. Dotychczasowy test accepted export używa pustego katalogu zadań i nie obejmuje modów.

`fullmag.session.v2` dopuszcza obecnie tylko syntetyczny manifest runu, odłączone evidence-only accepted closure i CAS. Zasady te nie pozwalają po prostu skopiować drzewa accepted run ani poluzować namespace guard do całego `runs/`. Brakujące pliki UI są danymi wynikowymi, ale ich obecność i pochodzenie muszą zostać udowodnione.

## Kroki

| Krok | Stan | Implementacja i dowód odbioru |
|---|---|---|
| FMS1: typowana tożsamość stanu | PASS źródła/CI 40572731383; runtime w FMS5 | `typed_documents.rs`: rozpoznać AcceptedStateRef tylko w latest_fields i ich provenance; użyć istniejącego typu z deny_unknown_fields, validate i zgodności run_id. Zachować state_object_ref w grafie CAS; odrzucić cudzy run, błędne digesty i ukryte refy. Oryginalne bajty snapshotu bez zmian |
| FMS2: rozdzielone źródła CAS | PASS źródła/CI 40572731383; runtime w FMS5 | `fms.rs` / `reachability.rs`: allowlista hash→rozmiar ze zweryfikowanego AcceptedProvenancePlan. Hashować odczyt, odrzucać symlinki i błędne rozmiary; żadnego przeszukiwania sąsiednich store i kopiowania danych do live CAS. Strumieniowanie archiwum przez istniejący provenance writer, bez podwójnego wpisu ZIP |
| FMS3: odtwarzalna projekcja modów | PASS źródła/CI 40594365988; runtime otwarte | Przygotować projekcję wyłącznie z aktualnego, catalog-pinned modal bundle w accepted CAS. Użyć istniejącego codec, walidacji pełnego closure i immutable generation publisher. Zachować odnośniki snapshotu oraz dokładne marker/member bytes. Obsłużyć wyłącznie read-only namespace wyników; zakaz claim/lease/journal/inbox/retry/start-release w eksportowanej projekcji |
| FMS4: kontrola archiwum i cold import | PASS źródła/fixture cold import w CI 40594365988; signed15 otwarte | Core FMS: dokładny allowlist marker + członkowie generacji, sumy i owner. API import: zgodność projekcji z dokładnym bundle CAS i succeeded task lineage w detached closure; odrzucić dodatkowy plik, podmianę ownera, ubytek pola i niezgodny CAS. Import visualization_only nie tworzy accepted authority ani nowego Solve |
| FMS5: rzeczywisty odbiór i wdrożenie ETag | Otwarte | Test fixture z prawdziwym codec/generacją i niepustym mode bundle: export → inspect → cold visualization import → JSON/meta/binary/UI. Zachować bieżącą sesję i jej wyniki przed przeładowaniem API. Następnie wdrożyć ograniczony ETag i uzyskać strict browser PASS bez HTTP 500 |

FMS3/FMS4 wymagają spójnej zmiany packera, preflight/readonly import i API, a nie usunięcia wpisów z live snapshot. Nie deklarować gotowego FMS po samym FMS1/FMS2. Przy rozszerzeniu v2 o projekcję dane muszą pozostać evidence-only; istniejące archiwa bez projekcji oraz negatywne testy authority records mają nadal przechodzić. Uwzględnić zasady ADR 0060.

## Weryfikacja

- Testy kompilowane tylko w GitHub Actions: `cargo test -p fullmag-session --lib --no-fail-fast`, kontrakty API accepted export oraz regresje rzeczywistego bundle.
- FMS1/FMS2 mają negatywne testy: nieprzypięty hash, uszkodzone bytes, zmieniony rozmiar, symlink, ukryta referencja i foreign run.
- FMS3/FMS4: nie kopiować istniejącego, niezweryfikowanego katalogu UI jako źródła fizyki. Autorytatywnym źródłem pozostaje accepted CAS; projekcja to sprawdzalna kopia do odczytu.
- Runtime: SHA archiwum, run/stage/generation/sample/raw-mode/frequency i topology przed/po; WebGL2 i widoczne kompleksowe pole. Nie restartować działającej sesji wyłącznie z powodu timeoutu obserwacji.

Otwarty wynik naukowy: I7 nadal wymaga kompletności okna, serial/adaptive, zbieżności i COMSOL A1. Naprawa FMS nie zamyka tych bramek.

## Checkpoint FMS3/FMS4 — 27.10.2026

Projekcja jest odtwarzana z CAS bundle przypiętego przez oba katalogi, zgodne succeeded task/attempt/epoch oraz dokładny port `modal_artifacts`. Współdzieli walidatory tożsamości i payloadu normalnego publishera. Katalog UI wybiera bieżącą generację, nie dostarcza bajtów eksportu. Core dopuszcza wyłącznie marker v2 i pełny zbiór jego członków; API porównuje je z bundle w odłączonym CAS przed publikacją importu.

Dodane regresje obejmują niepuste 48-bajtowe zespolone pole wraz z Zarr, odrzucenie brakującego chunka nawet po przeliczeniu hashy, obcy owner/session, błędną epokę, failed task, brak przypięcia artefaktu i dwuznaczny katalog. Core rozszerza dotychczasowy round trip o profil solved, ograniczony odczyt i kontrolę dodatkowych claim/lease. To fixture transportu, nie wynik solvera ani dowód naukowy. Dotychczasowy compact round trip nadal jest wykonywany.

Parsowanie Rust/rustfmt i `git diff --check`: PASS. Testy kompilowane uruchamia dedykowany workflow `eigensolve-api-source-contracts` w GitHub Actions. Ich wynik i rzeczywisty cold import signed15 pozostają do sprawdzenia. Nie restartowano obecnej sesji, nie usunięto danych i nie zamknięto FMS5.

Pełny test API `accepted_solved_modal_archive_reopens_without_original_store` eksportuje fixture solved, zwalnia źródłową instancję i jej tymczasowe katalogi, następnie uruchamia inspect/import w nowym stanie aplikacji i porównuje wszystkie członki generacji bajt w bajt. Workflow wymaga jawnie obecności tego testu oraz historycznego testu odrzucania podmiany. Test transportu nie zastępuje rzeczywistego odbioru UI po imporcie signed15.

## Odbiór źródeł i następny krok runtime

CI `40594365988`, SHA `26408e1195334f7aa7b3ab9cd1d1036abdfeb72f`: krok `Preserve accepted modal archive projection and cold import contracts` zakończył się SUCCESS 27.10.2026 o 22:30:47 UTC. Wymagał przejścia wszystkich trzech regresji bundle oraz obu jawnie wskazanych testów accepted FMS, w tym niepustego cold import. Wszystkie 437 testów fullmag-session przeszły także w przebiegu `40593579586`. Kontrakty wygenerowanego API i postprocessingu końcowego SHA: SUCCESS. Pozostałe kroki workflow są osobno obserwowane; nie utożsamiamy pojedynczego kroku z wynikiem całego workflow.

Runtime UI nadal odpowiada pod `http://localhost:3217/workspace`; spectrum ma 15 próbek i generację `sha256:94a4698432bb417fd3e0758c39300ef98661c84a7d3b7e6638e74b10b9ca7f4f`. Backend pozostaje `0.1.0-dev.20261027.gfe06a6573bc0+9796`, więc poprawka FMS i ograniczonego ETag nie są w nim wdrożone. Pojedyncza próba standardowego eksportu compact potwierdziła HTTP 500: nierozpoznany typed accepted_state_ref i brak członków generacji w archiwum. Nie ponawiano eksportu ani Solve.

FMS5 dzielimy na dwa jawne kroki:

1. **FMS5a: zachować i odtworzyć ukończony accepted run przy aktualizacji.** `RestartableWorkspace` w `crates/fullmag-api/src/router_v2/handlers/platform/development_restart.rs` przenosi tożsamość i scenę, nie pełny snapshot wyniku. Istnieje odrębna, przypięta ścieżka `development_accepted_restore.rs` / `docker_volume_accepted_reattach.py`; należy sprawdzić jej obsługę tego zdrowego ukończonego runu, zanim nastąpi restart. Sam trwały katalog wyników nie dowodzi, że UI po restarcie wybierze te same dane. Zachować wyniki i accepted CAS; nie tworzyć zastępczej sesji ani nowego Solve.
2. **FMS5b: wdrożyć i odebrać rzeczywisty archive round trip.** Dopiero po FMS5a przyrostowo zbudować właściwą grupę przez managed launcher, potwierdzić nową binarkę/proweniencję, wyeksportować solved signed15 i zanotować SHA archiwum. W nowym stanie API otworzyć visualization_only, sprawdzić 15 częstotliwości, generację i pola oraz strict browser bez katalogowego HTTP 500. Nie traktować testowego 48-bajtowego pola jako zastępstwa dla tego odbioru.

W tym checkpointcie nie restartowano backendu ani innych grup, nie usunięto danych i nie zmieniono solvera ani progów fizycznych. FMS5 i pozostałe bramki I0/I1/I5/I6/I7 nadal są otwarte.
