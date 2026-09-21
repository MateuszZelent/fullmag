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

## Granice anulowania native solve

`fullmag_runner::execute_antenna_field_solve_plan_interruptible` przyjmuje
`AtomicBool` i sprawdza go na granicach `before_preflight`,
`after_preflight`, `before/after_charge_transport`, `before/after_rt0_oersted`
oraz `before_artifact_materialization`. Pojedynczy FFI solve pozostaje
niepreemptive; przerwanie zgłoszone na granicy zwraca `RunError` przed
przekazaniem wyniku do publishera, więc ta ścieżka nie może opublikować
`ready` po zaakceptowanym anulowaniu.

Publisher ma dodatkowo wariant
`publish_antenna_field_solution_atomically_interruptible`, który sprawdza ten
sam sygnał po zapisie task-private payloadów i bezpośrednio przed `rename()`;
odrzucony zapis sprząta wyłącznie własny katalog tymczasowy. Samo `rename()`
pozostaje niepreemptive, ale nie ma już okna między kontrolą orchestratora a
kontrolą publishera.

`orchestrator.rs` przekazuje ten sygnał dla synthetic antenna stage. Przy
anulowaniu zapisuje `AntennaFieldStageStatus::Cancelled`,
`StageStopReason::UserCancelled` w read-modelu stage i diagnostykę w
`synthetic_stage.json`; headless kończy podsumowanie jako `cancelled`, a sesja
interaktywna wraca do `awaiting_command`. Pojedynczy FFI solve nadal nie jest
preemptive, a pełny fault-injection zapisu i runtime qualification pozostają
osobnymi bramkami.

## Katalog stage/output

Ścieżka antenowego `synthetic` stage zapisuje teraz atomowo
`stage_output_catalog.v1.json` w swoim katalogu stage. Rekord `ready` zawiera
`stage_id`, `port_mode_id`, referencję `AntennaFieldSolutionRefIR` z
`output_id`/`asset_id`/`content_digest`, względną ścieżkę manifestu, listę
materializowanych quantities oraz `reused_existing`. Katalog jest tworzony
dopiero po ponownym otwarciu opublikowanego assetu przez publishera; zapis do
pliku tymczasowego i pojedynczy rename nie może ujawnić częściowego JSON.

Anulowanie zapisuje ten sam schemat ze stanem `cancelled`, pustą listą
`outputs` i diagnostyką. Identyczne bajty są bezpiecznie reużywane, natomiast
próba nadpisania katalogu inną treścią kończy się błędem. Read-model stage
otrzymuje referencję do katalogu jako dodatkowy `artifact_ref`, więc następny
etap nie musi wyszukiwać wyniku po nazwie pliku.

Zakres tej zmiany obejmuje antenowy `synthetic` field solve; pełny resolver
symbolicznego `stage/output` oraz wspólny katalog dla wszystkich rodzajów
stage/output nadal pozostają otwarte.

## Weryfikacja wykonana 2026-09-21

- parser-formatowanie Rust (`rustfmt --edition 2021 --config skip_children=true
  --emit stdout`) dla `antenna_stage.rs`, `lib.rs` i `orchestrator.rs`: exit
  code 0;
- ten sam parser dla rozszerzonego `orchestrator.rs` po dodaniu katalogu
  `stage_output_catalog.v1` oraz `git diff --check`: exit code 0;
- `git diff --check`: exit code 0;
- odczyt callerów potwierdził, że CLI używa nowego inspectora, a kompatybilny
  `load_cached_antenna_field_solution` zachowuje dotychczasowe `Option` dla
  pozostałych konsumentów;
- dodano regresję lifecycle dla przejścia `Missing → Stale → Queued`;
- dodano deterministyczną regresję dwóch workerów: bariera zatrzymuje oba
  zapisy tuż przed `rename()`, po czym jeden worker publikuje revisioned asset,
  a drugi weryfikuje identyczny manifest i zwraca `reused_existing=true`;
- katalog `stage_output_catalog.v1` ma kontrolowany hook fault-injection po
  zapisie pliku tymczasowego; regresja wymusza anulowanie przed rename i
  sprawdza brak katalogu ready oraz cleanup wyłącznie prywatnego pliku;
- nie uruchamiano kompilacji testów, natywnego FEM/CUDA ani browser smoke;
  zmiana nie jest kwalifikacją wykonania solvera.

## Pozostaje otwarte

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
