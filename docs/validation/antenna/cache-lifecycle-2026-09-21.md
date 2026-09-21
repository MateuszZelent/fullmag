# Lifecycle cache bazy pola anteny — 2026-09-21

## Cel

Ten raport dokumentuje domknięcie jednego kontraktu T12: nieaktualna, lecz
poprawnie odczytywalna immutable baza pola nie może być mylona z brakiem cache
ani użyta przez kolejny etap LLG. Korupcja manifestu pozostaje błędem, a nie
sygnałem do cichego ponownego solve.

## Kontrakt stanów

`crates/fullmag-runner/src/antenna_stage.rs` udostępnia
`inspect_cached_antenna_field_solution`, który zwraca:

| Stan | Warunek | Działanie |
|---|---|---|
| `Missing` | brak manifestu dla logicznego outputu | normalny solve od `Queued` |
| `Stale` | manifest istnieje, ale `asset_id` lub podpis planu nie zgadza się z bieżącym | zapis diagnostyki i nowa rewizja content-addressed |
| `Ready` | manifest, podpisy, digest i payloady są zgodne | `Queued → ProjectingTargets → Ready`, `reused_existing=true` |

Niepełny JSON, brak wymaganych pól, błąd integralności payloadu albo zmiana
manifestu pomiędzy odczytem i ponownym otwarciem zwracają `RunError`; nie są
mapowane na `Missing` ani `Stale`.

## Lifecycle CLI

`execute_synthetic_stage` sprawdza stan przed emisją `Meshing`,
`SolvingCurrent` i `EvaluatingField`:

```text
cache miss:  Missing → Queued → Meshing → SolvingCurrent → EvaluatingField → ProjectingTargets → Ready
stale cache: Missing → Stale(reason) → Queued → Meshing → SolvingCurrent → EvaluatingField → ProjectingTargets → Ready
cache hit:   Missing → Queued → ProjectingTargets(reused_existing=true) → Ready
```

Diagnoza `Stale` zawiera `cached_asset_id`, `expected_asset_id` oraz ścieżkę
manifestu. Zgodność jest nadal wyznaczana przez pełny podpis zależności
geometrii, materiału, terminali, meshu, operatora i próbkowania; waveform nie
wchodzi do podpisu statycznej bazy.

Stary asset pozostaje w swoim katalogu revisioned i można go ponownie otworzyć
przez jego dawną referencję. Nowy solve publikuje osobny katalog po digest,
więc zmiana geometrii lub materiału nie mutuje wyniku wcześniejszego runu.

## Weryfikacja wykonana 2026-09-21

- parser-formatowanie Rust (`rustfmt --edition 2021 --config skip_children=true
  --emit stdout`) dla `antenna_stage.rs`, `lib.rs` i `orchestrator.rs`: exit
  code 0;
- `git diff --check`: exit code 0;
- odczyt callerów potwierdził, że CLI używa nowego inspectora, a kompatybilny
  `load_cached_antenna_field_solution` zachowuje dotychczasowe `Option` dla
  pozostałych konsumentów;
- dodano regresję lifecycle dla przejścia `Missing → Stale → Queued`;
- dodano deterministyczną regresję dwóch workerów: bariera zatrzymuje oba
  zapisy tuż przed `rename()`, po czym jeden worker publikuje revisioned asset,
  a drugi weryfikuje identyczny manifest i zwraca `reused_existing=true`;
- nie uruchamiano kompilacji testów, natywnego FEM/CUDA ani browser smoke;
  zmiana nie jest kwalifikacją wykonania solvera.

## Pozostaje otwarte

- cancellation token podczas długiego native solve i fault injection przed/po
  zapisie payloadu;
- fault injection przerwania całego batcha przed/po zapisie payloadu albo
  manifestu;
- pełny resolver stage/output oraz rejestracja w standardowym artifact catalog.

Ścieżka publikacji obsługuje już samo okno wyścigu po `exists()` i przed
`rename()`: worker przegrywający ponownie ładuje zwycięski revisioned asset,
weryfikuje manifest, payloady i digest, a identyczny wynik zwraca jako
`reused_existing=true`. Różna treść daje konflikt immutable rewizji; nie ma
nadpisania ani częściowego merge. Regresja wielowątkowa wymusza oba workery w
kontrolowanym punkcie przed `rename()`; nadal osobno pozostaje fault injection
przerwania zapisu oraz cancellation token native solve.
