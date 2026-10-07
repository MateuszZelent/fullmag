# T11 — zgodność deklaracji pasma Python z kanonicznym IR

Przyrost względem `87eac6879acd6aad7cadac432eb85b293b8ab759`.
Źródłowy audyt potwierdził, że
`crates/fullmag-ir/src/field_drive_validation.rs::classify_antenna_waveform_bandwidth_with_declaration`
nie stosuje heurystyki odwrotności czasu impulsu: pulse i piecewise bez
deklaracji zwracają nieznane pasmo. Nie implementowano ponownie tej gałęzi.

Znaleziono niespójność authoringu:
`crates/fullmag-ir/src/antenna.rs::validate_solved_antenna_drive` odrzuca
deklarację dla constant, sinusoidal i sinc_pulse, ale konstruktor Python
przyjmował te kombinacje. Obecnie
`packages/fullmag-py/src/fullmag/model/antenna.py::SolvedAntennaDrive.__post_init__`
odrzuca je przez `ValueError`, zachowując deklaracje dla pulse i piecewise_linear.
Nie dodano parametrów ani zmiany schematu IR/API v2. Skrypty wcześniej
akceptowane przez Python, lecz niepoprawne w kanonicznym IR, zawodzą wcześniej.

Fizyka, klasyfikator Rust, provenance, cache bazy, waveform i wykonanie pól
pozostają bez zmian. Kontrakt opiera się na nocie 0950, sekcji diagnostyki
ważności i jej zasadzie niewnioskowania pasma z czasu impulsu.
Sam wynik authoringu nie kwalifikuje FDM CPU, FDM GPU, FEM CPU ani FEM GPU.

## Dowody

- Nowy `packages/fullmag-py/tests/test_antenna_bandwidth_contract.py`:
  RED — brak oczekiwanego wyjątku dla trzech sygnałów analitycznych;
  GREEN — 4/4 testy po poprawce, exit 0.
- Sprawdzono brak syntetycznej deklaracji dla trzech długości impulsu,
  deklarowany pulse/piecewise → renderer skryptu → konstruktor → identyczny IR,
  oraz zachowanie sygnałów analitycznych bez deklaracji.
- `packages/fullmag-py/tests/test_antenna_stage_workflow.py`: bezpośrednio
  wykonano wszystkie 23 funkcje testowe, exit 0; dla jedynego argumentu
  `tmp_path` przekazano osobny TemporaryDirectory pod storage na D.
  To wykonanie interpretowane, nie przebieg pytest i nie solver runtime.
- Pierwsza próba szerszego testu nie miała prawa zapisu do temp; kolejna miała
  błąd cytowania polecenia. Końcowy przebieg z poprawnym stdin i uprawnieniami
  przeszedł w całości. Nie przedstawia się poprzednich prób jako PASS.
- Testów Rust nie kompilowano; aktywnej sesji nie zamykano ani nie restartowano.
- Niezależny przegląd źródeł nie wskazał blockera; potwierdził zgodność
  whitelisty z walidatorem Rust oraz pokrycie renderera dla obu przebiegów.

Pełne T11 i T00–T18 pozostają otwarte. Wymagane są m.in. budżet pamięci,
blokowanie targetów, globalny koszt i pomiary oraz kwalifikacja native/runtime.
