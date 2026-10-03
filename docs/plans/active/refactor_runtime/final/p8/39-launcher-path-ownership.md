# P8-39 — ścieżki launchera pod właścicielem blokady

Data: 03.10.2026. Status: poprawka źródłowa; production build i runtime
**NOT VERIFIED**. Nie zalicza ukończenia P8 ani natywnego produktu Windows.

## Przyczyna

Build 215 `901bf4779f5848ebaf9900311dd4b9bd`, przypięty do commita
`7b5248c515eeee788c62050073b05d3affe6ddcb`, zakończył native-build z exit 2.
Rust zgłosił dwa E0603: runtime-control wywoływał prywatny
`fullmag_session::repository_path::create_parent` przy przygotowaniu
konfiguracji i stdout usługi. Nie uzyskano aktualnego API/OpenAPI ani
kompletnego pakietu. Błąd nie jest dowodem problemu solvera lub fizyki.

## Zmiana

`RuntimeServiceLaunchGuard::prepare_launcher_paths` tworzy rodzica wyłącznie
dla `runtime-services/launchers/<canonical UUID>` i zwraca ścieżki config,
stdout oraz stderr. Wywołanie wymaga istniejącej instancji guarda, a ten
zachowuje blokadę podczas zapisu i decyzji o starcie. Identyfikator jest
sprawdzany przed utworzeniem namespace; zachowano local-filesystem gate,
containment, kontrolę linków i synchronizację utworzonych katalogów.

Ogólny `create_parent` pozostaje prywatny. Runtime-control korzysta z nowej
publicznej granicy domenowej, nadal tworzy pliki przez `create_new`, zapisuje
i synchronizuje config przed spawnem. Nie zmienia decyzji launch/recovery,
stanu nieznanego wyniku ani polityki cancel/kill.

## Weryfikacja

Rustfmt edition 2021 i scoped diff check: PASS. Trzy regresje źródłowe
sprawdzają ścieżki/wyłączność guarda bez tworzenia plików, odmowę błędnych
identyfikatorów przed utworzeniem katalogu oraz odmowę symlinku namespace
(Unix). **NOT COMPILED / NOT RUN**, zgodnie z aktualnym zakazem AGENTS.md.
Niezależny source review: PASS, bez P0/P1; potwierdzono publiczną granicę,
containment, zakres blokady i zachowanie unknown outcome. Kolejny produkcyjny
build pozostaje osobną bramką; źródłowa kontrola widoczności nie zastępuje
kompilacji cross-crate. Założenie trusted local filesystem pozostaje
identyczne jak dla istniejących writerów.

Po source review i commicie trzeba zlecić immutable build przez istniejącą
kolejkę. Build 216 innego zadania zachowuje pierwszeństwo; nie uruchamiać
równoległego ciężkiego buildu na hoście. Po terminalnym sukcesie odbierać
receipt, hashe i raw OpenAPI, a następnie wdrożyć integrację frontendu
opisaną w [P6-76](../p6/76-scalar-frontend-integration-checklist.md).

## Przypięty build 217

Poprawkę zapisano i wysłano na master jako
`ecec6d44fa85652c5e78bc7f036c8e207235417c`. Zlecono centralny produkcyjny
build, bez kompilacji testów jednostkowych:

- sequence 217, job `50298982d80f48d8a688af01a7c19304`;
- profile `fdm-cpu-release`, operation `build`, source mode `commit`;
- request key `p8-39-launch-paths-ecec6d44fa85652c`;
- capture `2c848e438a78417dbe6c0dbb61cf756b`;
- capsule digest `696223aff2dbcc27cae4b5be683b5c6b443156a326c3b9728b8d829ee11c3bc6`;
- source snapshot `25b8b89126a73c3a4d7af3705c072b98b8b75faa3cb135dae95b7802493538e1`;
- source_snapshot_dirty=false, status odbioru `queued` za zadaniem 216.

W kapsule nie ma obcych zmian współdzielonego checkoutu. Przyjęcie do
kolejki nie dowodzi kompilacji, API ani natywnego Windows. Przygotowany
overlay runnera P8-38 nadal nie jest wdrożony; required outputs i receipt
217 trzeba dodatkowo sprawdzić bieżącym kontraktem repozytorium.
