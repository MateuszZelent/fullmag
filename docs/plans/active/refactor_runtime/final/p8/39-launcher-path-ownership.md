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
