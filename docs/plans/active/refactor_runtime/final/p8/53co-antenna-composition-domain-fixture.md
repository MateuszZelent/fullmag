# P8-53CO — domena transportu w fixture kompozycji portu anteny

Data: 14.10.2026. Przyczyna odebrana z CI PR #168, SHA
`f53dc54f8d82d2e982f25461df0a4eea18aaf81d`, run `38555157810`,
job `115822360915`.

`balanced_port_mode_is_composition_only_and_round_trips` kończył się na
`problem.validate().is_ok()`. To nie jest problem niedozwolonego study V04:
fixture dziedziczy legalne `TimeEvolution` z bootstrapu. Transport miał
`domain: Vec::new()` i `materials: Vec::new()`, mimo terminali na `antenna_1`.
`crates/fullmag-ir/src/antenna.rs::validate_v2_port_structure` wymaga jednego
obiektu terminala należącego do domeny transportu. Pusty domain nie spełnia
tego warunku. Walidacja pełnego transportu wymaga także przypisania materiału.

Poprawka jest ograniczona do
`crates/fullmag-ir/tests/antenna_composition_ir.rs::problem_with_charge_transport`:
region `antenna_1` oraz dodatnia izotropowa przewodność 1 S/m. Produkcyjny
validator, wersja IR, zakres study i asercje roundtrip pozostają zachowane.
Negatywne sprawdzanie niezbalansowanych wag i brakujących terminali pozostaje
w teście. Dodano `port_mode_rejects_terminals_outside_transport_domain`,
który usuwa domain z poprawnego fixture i wymaga czterech konkretnych błędów
terminali spoza domeny, bez osłabiania pozostałych asercji.

Review źródłowe, `rustfmt --check --config skip_children=true` jednego pliku
i `git diff --check`: **PASS**. Nie formatowano modułów zależnych.

Review źródła i scoped format/diff check nie zastępują wykonania testu.
Lokalna kompilacja Rust unit tests pozostaje zabroniona. Odbiór poprawki w CI
jest **NOT RUN** do czasu publikacji nowego commita i terminalnego wyniku.
Nie dowodzi to transportu FEM CPU/GPU ani ukończenia P8.

## Późniejszy odbiór CI

Run `38562458536`, job `115846662601`, SHA `aa0f42f78a25453cb4a430a378823511a80e805f`
potwierdził wszystkie trzy testy kompozycji portu: **3/3 PASS**.
Wcześniejszy zapis NOT RUN dotyczył momentu przed publikacją; został
rozstrzygnięty tym wynikiem. Cały job nadal FAIL na dwóch błędach typów
fixture środowiska workera, opisanych w [53CP](53cp-worker-environment-fixture-types.md).
