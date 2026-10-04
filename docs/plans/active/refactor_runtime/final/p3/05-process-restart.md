# P3-B — trwałość runu po restarcie procesu API

Checkpoint 24.09.2026. Status: **PASS w zakresie trwałego katalogu i replay po restarcie API**.

Dodano trasę `just verify-project-run-restart`. Rozszerza istniejącą zarządzaną
bramkę procesu API o syntetyczny Submit, materializację, zatrzymanie procesu,
ponowne uruchomienie oraz odczyt istniejącego katalogu **przed** replayem.
Po replayu wymagane są te same dane katalogu i zadania `accepted/blocked`.
Nie uruchamia solvera ani workera.

Payload pochodzi z przechodzącego testu HTTP Rust, nie z ręcznie odtworzonych
hashy. `verify-api-project-runs` zapisuje `project-run-request.json` oraz jego
hash w receipcie. Bramka restartu przyjmuje receipt przez
`FULLMAG_PROJECT_RUN_FIXTURE_RECEIPT`, wymaga zakończonego wyniku PASS,
niezmienionych źródeł podczas testu oraz zgodności hasha pliku. Dla każdej
próby nadaje nowy RunId i klucz idempotencji; po restarcie zachowuje te same
wartości. Artefakty i syntetyczne runy pozostają w zarządzanym storage.

## Dowody przygotowania

- Fixture: HTTP **3/3 PASS**, run `3ce41bc8ea534cbeab4284dac4530285`.
- Testy skryptów: **18/18 PASS**. Regresje weryfikatora odrzucają utratę
  trwałego katalogu przed replayem oraz zmianę tożsamości zadań po replayu.
- Kontrola składni Python oraz diffu: PASS.

## Zakończona próba

Run `ada0f9caa1d24c2cab7791387f4d7efa`, profil `windows-project-api-runtime`.
Receipt i log:
`storage/builds/fullmag-0950f4dca4ffe38f/windows-project-api-runtime/project-api-runtime/ada0f9caa1d24c2cab7791387f4d7efa/`
względem rootu projektu resolvera. Właściciel: bieżące zadanie refaktoryzacji,
lokalny master. Proces testu jest obserwowany przez uchwyt sesji `3060`.
Końcowy stan: `passed`, exit 0, build exit 0, `source_changed_during_run=false`.
Szczegółowy wynik końcowy i granice dowodu zapisano niżej.

## Pierwsza próba i korekta kontraktu recovery

Run `8608c9e1268a4ada8884bb0b8f8acedb` zakończył się `failed`, exit 1.
Build API był poprawny (exit 0), lecz historyczny smoke oczekiwał pustej
listy recovery bez sesji; właściwy endpoint zwrócił 404 `not_found`.
Serwer został zakończony przez wrapper. Nie jest to dowód restartu runu.

Weryfikator jawnie sprawdza teraz 404 bez aktywnej sesji; test odrzuca
historyczne 200 z pustą listą. Trasa używa wspólnego `cargo-target` profilu,
a zbudowany plik wykonywalny kopiuje do katalogu danego runu przed uruchomieniem
oraz zapisuje jego hash. Nie zmieniono ani nie usunięto wcześniejszych artefaktów.
Końcowy wynik kolejnej próby jest opisany poniżej.
## Odbiór końcowy

Run `ada0f9caa1d24c2cab7791387f4d7efa` zakończony **PASS**. Uchwyt `3060`
zwrócił wynik końcowy; oba serwery zostały zakończone przez wrapper, a kontrola
portów wykazała zero nasłuchujących procesów tej próby. Windows zwrócił kod 1
po kontrolowanym `terminate()` obu serwerów; nie jest to exit code bramki,
która zakończyła się kodem 0.

- HEAD: `93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty.
- Source snapshot SHA-256: `2faf8e9a4ab7b2c984dbc41ec22e9d09380a3de3a1215cd6f30b6b638e82e0ae`.
- Binary SHA-256: `044ea6cffcdfc890d0d9e7d23808c567044546e6d968da52cd33917c4d255f48`;
  hash zachowanej osobnej kopii sprawdzono ponownie po teście.
- RunId przed i po restarcie: `run-b8d043d3b89243479a45d9ac65bed1c7`.
- Rewizja katalogu: 1; TaskId przed i po:
  `task-8795dc199bc8e2ee0034aa68767d2ce9bf36c3724836399ff2f93a5f1f5bfb31`.
- Odczyt **przed replayem** zachował cały snapshot. Ponowne Submit zwróciło
  `replayed`, a materializacja identyczny katalog.
- Zadanie: `accepted/blocked`, bez attempt, ownership epoch, resource lease
  i artifact IDs. Nie uruchomiono workera ani solvera.
- Recovery bez sesji zwróciło 404 `not_found` przed i po restarcie.

Dowód obejmuje rzeczywiste procesy API i HTTP do localhost, nie tylko router
w procesie testowym. Nie jest kwalifikacją power-loss, pracy solvera, resume
aktywnego workera, zwolnienia VRAM, nauki ani wydania. Artefakty i syntetyczny
run pozostają zachowane; nie wykonano cleanup współdzielonego storage.

Następny krok P3/P5: sprawdzić atomowość przyjęcia zdarzenia przez
`WorkerCoordinator` (ledger jest aktualizowany przed walidacją lifecycle)
oraz odróżnić żądanie release od potwierdzonego zwolnienia zasobu. Te kwestie
nie zostały jeszcze uznane za zweryfikowane poprawki.