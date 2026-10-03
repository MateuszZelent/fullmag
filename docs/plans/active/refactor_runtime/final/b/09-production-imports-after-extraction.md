# B-09 — importy produkcyjne po ekstrakcji FDM CPU

03.10.2026. Pierwsza natywna kompilacja Windows ujawniła `E0432` w
`fields/direct_torques.rs` i `fields/exchange.rs`. Oba moduły importowały
`neighbor_index` i `AxisBoundary` przez rodzica, który nie udostępniał ich
w buildzie produkcyjnym. `AxisBoundary` występował tam wyłącznie w `cfg(test)`.

Zmieniono wyłącznie dwa importy na bezpośrednie
`crate::fdm::shared::types::{neighbor_index, AxisBoundary}`, zgodnie ze wzorcem
już używanym przez `fields/dmi.rs`. Żadne ciało metody, pętla, sygnatura ani
semantyka fizyczna nie uległy zmianie. Cudze formatowanie `fields.rs` zachowano.

Niezależny review i `git diff --check`: PASS. Kolejny rzeczywisty build przez
`just windows-ui dev 3197` skompilował CLI/API i desktop dla
`x86_64-pc-windows-msvc`; powstały wszystkie trzy niepuste EXE. CLI/API zakończyły
się `release` exit 0 w 8 minut; manifest natywnego pakietu został zapisany.

Jest to dowód kompilacji produkcyjnych źródeł FDM CPU po B-04–B-08.
Nie jest dowodem wykonania solvera, parytetu CPU/GPU, walidacji fizyki ani
natywnego FEM. Startup API/Next osiągnięto, lecz `/workspace` zwróciło 404
z powodu śledzenia junction katalogu `app`; poprawka tej osobnej bramki należy
do [P8-50](../p8/50-windows-empty-ui-just-route.md).
Nie kompilowano testów jednostkowych.
