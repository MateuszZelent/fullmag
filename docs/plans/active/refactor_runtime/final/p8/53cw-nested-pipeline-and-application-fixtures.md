# P8 — zagnieżdżone etapy i fixture materializacji

Data: 15.10.2026. Baza: `df12c14ae5bc3d17fa8867c9da802eead51e88de`,
współdzielony `master`. Naprawy odpowiadają dziewięciu porażkom CI z 53CV.
Lokalna kompilacja testów Rust pozostaje wyłączona; odbiór wymaga CI.

## Przyczyny i zmiany

| Porażki | Przyczyna | Zakres poprawki |
|---|---|---|
| 3 replany anteny | aplikacja rekurencyjnie materializuje dzieci grup, ale IR zbierał tylko ID najwyższego poziomu | rekurencyjny membership w `fullmag-ir/src/validation.rs`; osobno deklaracje scope i efektywnie włączeni właściciele wykonania |
| 1 replay batch | kolejne wywołania fixture generowały losowy źródłowy RunId, więc fingerprinty intent różniły się prawidłowo | stały RunId tylko w konstruktorze fixture; produkcyjny fingerprint bez zmian |
| 1 tampering batch | nieaktualne brzmienie oczekiwanego komunikatu | konkretny aktualny tekst odmowy, bez usunięcia negatywnego assertu |
| 1 named Zhang–Li | legacy wariant miał niedozwolony canonical ID | kanoniczny named `zhang_li.mumax3.v1` dla istniejącego FDM fixture: schema, target, operator i `lande_g=2`; CPU/FDM bez zmiany |
| 3 tożsamości RunIntent FEM | fixture przygotowania nie zawiera MeshIR potrzebnego plannerowi | inline strukturalny tet4 i krok `1e-15 s`, identyczny wzorzec jak istniejący `run_intent_preparation_tests.rs` API; FEM pozostaje FEM |

## Kontrakt walidacji etapów

Zmiana realizuje istniejący model grup/primitive/macro i ADR-0026; nie dodaje
pól IR ani migracji wire format. `pipeline_stage_ids` i
`declared_pipeline_stage_ids` służą członkostwu zadeklarowanych scope, także
wewnątrz wyłączonej grupy. Wyłączony etap może istnieć jako deklaracja
przyszłej aktywacji. Kontrola `active_stage_id` osobno wymaga efektywnie
włączonego primitive/macro owner; wyłączony rodzic wyłącza potomków.
Zachowano legacy top-level node bez `node_kind` i domyślne `enabled=true`.
Grupa nie jest właścicielem wykonywanego primitive/macro.

Walidacja scope pól i ograniczeń magnetyzacji nie może używać zbioru
efektywnie włączonych etapów. Root review wychwyciło taką nadmierną zmianę
w pierwszym wariancie i zleciło jej rozdzielenie przed commitem.
Istniejące assert’y replanningu anteny pozostają odbiorem integracyjnym.
Dodano dwie macierze membership/active ID inline oraz pełną regresję
`regional_field_drive_activation_can_scope_to_a_disabled_declared_stage`
w `fullmag-ir/tests/ir_tests.rs`, wywołującą `ProblemIR::validate`.

## Dowody i granice

Diff check i parser `rustfmt --emit stdout --config skip_children=true`
fixture batch: PASS, bez zapisu formatowania. Focused rustfmt check fixture
RunIntent: PASS. Istniejące różnice formatowania batch poza poprawką
pozostawiono bez zmian. Źródłowo potwierdzono legalność operatora FDM w
`fullmag-plan/src/spin_torque.rs` oraz zgodność inline mesh z fixture API.
Parser obu zmienionych plików IR i ich diff check: PASS. Review fixture
batch/RunIntent nie wskazało actionable P0–P2. Review root poprawki IR
potwierdziło rozdzielenie active membership od zakresów aktywacji.

Wykonanie Rust, pełny CI, runtime FEM/GPU, fizyka i kwalifikacja wydania:
**NOT VERIFIED dla tej poprawki**, do odbioru w odpowiednich trasach.
Bootstrap uruchamia pełne `cargo test -p fullmag-ir` i
`cargo test -p fullmag-application`; nie zmieniano workflow ani filtrów.
Nie dodano hostowego obejścia zakazu kompilowania testów.

Brak nowych lokalnych danych solvera i native builda w tym fragmencie.
Receipty 53CU, nieudany build 53CT i cache przyrostowe pozostają zachowane;
nie uruchamiano prune ani usuwania danych. Pełny plan P0–P8 pozostaje aktywny.

## Publikacja i odbiór

Poprawka na remote: `f4c15a8781a8bc43fa72464b81d074aaa973898c`.
[CI 38700675368](https://github.com/MateuszZelent/fullmag/actions/runs/38700675368)
jest aktywny: Python job `116307821097` wykonuje Gmsh exact-layer regressions,
Rust job `116307821115` wykonuje compact workspace import regression.
Nie ma jeszcze terminalnego odbioru nowych testów aplikacji/IR.
Kontrakty volatile Windows storage, native modal ABI i API hygiene przeszły;
nie dowodzą działania solvera ani całego produktu.

Ponowny managed `windows-workspace-build dev dev 3197 auto`, sesja `4051`,
zakończył się exit 2 przed kompilacją: limit 120 s oczekiwania na globalny
slot `native Windows Fullmag build`. Wcześniejsze konkretne procesy z 53CV
już nie istniały, ale globalny slot pozostał zajęty. Nie ustalano właściciela
ani stanu jego joba wyłącznie na podstawie komunikatu blokady.
Nie obchodzono blokady i nie zatrzymywano procesów; brak nowego pakietu.
