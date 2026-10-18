# P8 — odbiór meshera w CI i kontrakty sceny Python

Data: 15.10.2026. Baza: `f4c15a8781a8bc43fa72464b81d074aaa973898c`,
współdzielony master; cudze zmiany compute/API/frontend pozostawione.

## Wynik CI i przyczyny

[Python job 116307821097](https://github.com/MateuszZelent/fullmag/actions/runs/38700675368/job/116307821097)
potwierdził SUCCESS kroku `Run real Gmsh exact-layer airbox grading regressions`
(07:47:09 UTC). Tym samym poprawka body-first z 53CU ma również odbiór
tej bramki na Linux CI, odrębny od lokalnych receiptów Windows.
Nie oznacza to wykonania solvera FEM ani kwalifikacji fizycznej.

Następny krok `Run eigensolve scene and execution profile merge contracts`
zakończył się **119 PASS / 8 FAIL**:

- siedem przypadków wywoływało `_render_scene_stage_bootstrap` bez wymaganego
  keyword-only `magnet_vars`; trzy bezpośrednie call sites otrzymały `{}`,
  bo testują samodzielne etapy eigen bez powiązanych magnet handles;
- test auxiliary ID oczekiwał usuniętego błędu unsupported, mimo że renderer
  przekazuje publiczne `geometry_object(..., object_id=...)`, a
  `Problem.to_ir` publikuje auxiliary identity w `physics_objects`.
  Zmieniono test na kontrolę całego obiektu identity i braku dodatkowego magnetu.

Nie zmieniono kodu produkcyjnego, solvera ani asercji invalid authored eigen,
Floquet, parametrów solvera i konfliktów k-vector/path. Dostosowanie testów
wynika z bieżących konsumentów i kontraktu oddzielenia object_id/name/type.

## Wykonanie lokalne

Dokładnie pięć plików kroku CI (eigen scene merge, scene→IR, STL owner fallback,
execution profile authoring roundtrip, scene execution config):
**127/127 PASS**, 0 failures/errors/skipped, pytest exit 0, 4.33 s.

Receipt:
`C:/git/fullmag/storage/runs/fullmag-0950f4dca4ffe38f/python-scene-authoring-contracts/d88c362632a641e789f49c3af326de48/receipt.json`.
Resolver użył istniejącego profilu `windows-native-fdm-cpu-dev`; testy działały
pod `build_lock`, bez heavy builda, kompilacji native/Rust, pip install,
bytecode i cache pytest. Temp/JUnit/log znajdują się w tym run root.
Fingerprint wszystkich źródeł pakietu Python i pięciu testów oraz HEAD
pozostał stabilny. Dodatkowy ukierunkowany eigen fixture: 11 PASS.
AST i diff checks PASS; root source review bez konkretnego P0–P2.

## Retencja i granice

Zachować ten dokładny run root jako dowód i jego log/JUnit/receipt/temp.
Nie wykazano zbędności i nie ma autoryzacji usunięcia. Ponowna ocena po
odbiorze nowego CI i trwałym archiwum dowodów. Wolne C: 46720737280 B;
nie jest to pomiar odzysku. Brak prune, usuwania cache i cudzych buildów.
Rust CI job `116307821115` nadal aktywny; nie zaliczać nowych regresji IR
ani całego planu na podstawie sukcesu Python. Pełny plan **IN PROGRESS**.

## Dalszy odbiór tej generacji CI

Poprawki testów opublikowano jako `a16a34aef8367c40e350540511cb385800f489ab`;
bootstrap `38702215605` jest aktywny. Commit ma rodzica
`08c633413ae0afab4b0c658eee6e160763059be0`
(równoległy merge PR #171 dokumentacji). Ponowne porównanie 108 fingerprintów
z receiptu wykazało brak zmian źródeł Python/testów po tej integracji.

Dla dokładnego wcześniejszego `f4c15a878...` Control Room job `116307821123`
zakończył się SUCCESS: 828 plików testowych PASS / 1 skip, 8535 testów PASS /
13 skip, wymagany typecheck i lint. Ten dowód nie obejmuje niezacommitowanego
compute-policy WIP ani nie znosi obowiązków browser/WebGL i runtime.
Rust job `116307821115` nadal wykonuje typed active eigen Stop/Pause.

## Aktualizacja odbioru po publikacji

Job Python `116312876046` potwierdził Gmsh 45/45 i sceny 127/127, następnie
zatrzymał się na starym imporcie `_scene_stage_autosave` w checkerze output
storage. Naprawiono checker przez publiczny StageAutosave i aktualny renderer
suffixu, zachowując porównanie z eksportem publicznym. Oczekiwanie quantity `m`
odpowiada authored fixture i naming freeze ADR-0004; lowerer kopiuje nazwę
verbatim, nie normalizuje jej do magnetization.

Interpreted checker exit 0, diff check PASS. Commit
`b7051deb5e4b1a422470d4a37c71ffce4b8cffcf` opublikowany na origin/master.
Rust/native unit tests lokalnie nie kompilowano. Nowe CI wymagane.

Starszy Rust job `116307821115` zakończył się FAIL: końcowy zestaw API
1101 PASS / 1 FAIL / 3 ignored. Porażka
project_batch_submit_replays_and_lists_durable_parent w project_documents.rs:3992
to progress sequence conflict (expected 0, found 1), a nie błąd kompilacji.
Nowszy Rust job `116312875986` nadal aktywny przy ostatnim odczycie.
Nie zaliczać pełnej integracji z wcześniejszych częściowych sukcesów.

Fixture naprawiono w `d3f4d49cf381ab13fe3fbb2b162a1a84fbd05ff5`:
odczyt checkpointu utworzonego przez POST, asercje total_cases/sequence=1/
cursor=0/Pending, a następnie niezmienione crash-window child-before-cursor.
Nie osłabiono produkcyjnego fence ani nie dodano drugiego initial commita.
Diff check PASS, parser rustfmt stdout PASS także po dodaniu asercji
total_cases; istniejące globalne różnice formatowania modułu zachowano.
Wykonanie testu wymaga CI, lokalnie testów Rust nie kompilowano.
