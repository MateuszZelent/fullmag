# Punkt bazowy integracji modułu anteny mikrofalowej

Data pomiaru: 2026-09-09  
Worktree: `D:/git/fullmag/worktrees/microwave-antenna-latest-20260909`  
Podstawa: `origin/master` (`0bcd09558ac506e4ec334d24e98ce392f23d4473`)

## Rewizje i stan Git

| Pole | Wartość |
|---|---|
| poprzedni HEAD anteny | `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5` |
| aktualny `origin/master` | `0bcd09558ac506e4ec334d24e98ce392f23d4473` |
| merge-base | `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5` |
| commity mastera po poprzednim HEAD | 251 |
| ścieżki zmienione między bazą a masterem | 2417 |
| snapshot zmian antenowych | `bafb4726a91cc2aa7cac0ef91d046756d3159b11` |
| ścieżki snapshotu | 89 |
| ścieżki obecnie zintegrowane | 89 |
| konflikty nierozwiązane | 0 |

Snapshot wykonano z alternatywnym indeksem, bez resetu, stashowania ani
nadpisania starego worktree. Stary katalog
`D:/git/fullmag/worktrees/microwave-antenna-implementation-20260831`
pozostaje nietknięty. Integracja odbyła się ręcznie w pięciu właścicielach:
`backends/fem/CMakeLists.txt`, `backends/fem/tests/zeeman_contract.cpp`,
`crates/fullmag-cli/src/orchestrator.rs`, `crates/fullmag-engine/src/fem.rs`
i `crates/fullmag-runner/src/lib.rs`.

## Kontrole po integracji

* `cargo check -p fullmag-engine --target-dir .../antenna-latest-engine-check`:
  **zaliczone**.
* `cargo check -p fullmag-cli --bin fullmag --target-dir .../antenna-latest-cli-check`:
  **zaliczone**; pozostały ostrzeżenia `dead_code`/`unused`, bez błędów.
* `cargo test -p fullmag-engine rk4_evaluates_dynamic_field_at_internal_stage_times`:
  **1 passed**.
* `cargo test -p fullmag-runner antenna_spectrum`:
  **7 passed**.
* `cargo test -p fullmag-runner antenna_field_solution`:
  **7 passed**.
* `cargo test -p fullmag-ir antenna --tests`:
  **zaliczone**, w tym kontrakt v2 portu i kompozycja IR.
* `cargo test -p fullmag-plan antenna --lib`:
  **2 passed**.
* Python `test_antenna_composition_contract.py` w świeżym kontenerowym venv:
  **6 passed** po migracji DSL do `antenna_port_mode.v2`.
* `just verify-fem-charge-transport-abi-contract`: **zaliczone**. Natywny
  kontrakt ABI, layout `fullmag-fem-sys`, test certyfikatora par inlet/outlet,
  charge-only runner oraz integracja charge+spin/Oersted zakończyły się
  poprawnie; test portu odrzuca także odwróconą orientację prądu.
* `git diff --check` dla kodu: **zaliczone**; skopiowane dokumenty Markdown
  zawierają zamierzone twarde łamania linii z końcowymi spacjami.
* Pełne testy natywnego FEM/MFEM pozostają bramką kontenerową `just` z zadania
  T01; hostowy `cargo check` jest tylko kontrolą diagnostyczną.

## Decyzje integracyjne

1. Zachowano aktualne kontrakty mastera, w tym mixed-mesh, Frozen Spins,
   nowsze provenance i wykonanie czasowe.
2. Dodano antenowe pola dynamiczne jako niemutowalne bazy przestrzenne z
   mnożnikiem waveformu ocenianym dla dokładnego czasu etapu RK/ABM.
3. Pole obserwacyjne anteny budowane jest osobno od pola statycznego, aby nie
   dublować dynamicznego napędu w RHS LLG.
4. Antena pozostaje `not_qualified` dla ilościowej pracy naukowej do czasu
   wykonania bramek T01–T13 oraz walidacji FEM/FDM i CPU/GPU.
5. Python DSL emituje wyłącznie wersjonowany port `antenna_port_mode.v2`:
   każda gałąź ma jawne `id`, `inlet_terminal_ref` i `outlet_terminal_ref`;
   importer starego formatu pozostaje po stronie Rust IR i wymaga jawnej mapy
   par terminali.
