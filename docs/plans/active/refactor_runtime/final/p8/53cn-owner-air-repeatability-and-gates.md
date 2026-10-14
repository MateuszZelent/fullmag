# P8-53CN — powtarzalność siatki i aktualne bramki integracji

Data: 14.10.2026. Odczytany checkout: `master`,
`95dc457ad8b7883f079e234b7d9cb846b8c4cc17`, z lokalnym mesher WIP.
Cały zakres P0–P8 pozostaje **IN PROGRESS**; procentów nie podniesiono.

## Wyniki wykonane

| Bramka | Wynik | Dowód i granice |
|---|---|---|
| Publiczny Box po doprecyzowaniu zakresu air planes | 44 PASS / 1 FAIL, 0 skip, 45 przypadków | Receipt `172d305649b54b718a661bc7d331f26d`, 477,21 s. PID 173568 odczekany, exit 1, źródła stabilne. Pozostała oryginalna asercja niezależności body XY dla airbox hmin 15 nm: 30 vs 31 punktów, 210 vs 217 węzłów, 756 vs 792 tetraedry. |
| Powtórzenia owner-target ring | 6 obserwacji, bez pominięć | Receipt `5f5696ec3d074e0f8dcc672ca69c127e`, PID 182916 odczekany, exit 0, bez timeout/terminate/kill; fingerprints źródeł przed/po identyczne. Exit 0 oznacza zebranie obserwacji, nie zaliczenie owner independence. |
| Inspector — przeglądarka CI | PASS | PR #168, SHA `f53dc54f8d82d2e982f25461df0a4eea18aaf81d`, run `38555157810`, job `115822361266`: Object/Airbox, drawing buffer 703×436, contextLost=false. Szczegóły w 53CL. Synthetic fixture nie dowodzi solvera ani dwóch restartów A→B→C. |
| Rust contracts CI | FAIL | Ten sam run, job `115822360915`: library 243/243 PASS, następnie `balanced_port_mode_is_composition_only_and_round_trips`, `antenna_composition_ir.rs:102`, `problem.validate().is_ok()` FAIL. Wymagana diagnoza fixture/wersji IR. |
| Python contracts CI | FAIL | Job `115822361045`: 4 FAIL / 35 PASS; lokalny numeric WIP nie jest na branchu PR #168. |

Receipty diagnostyki znajdują się pod rozwiązywanym storage:
`runs/fullmag-0950f4dca4ffe38f/windows-exact-layer-mesh-diagnostics/<receipt-id>/receipt.json`.

## Odciski powtórzeń ring

Owner hmax = 20 nm, hint = 10 nm, L = 3, domena 40×40×410 nm,
XY PBC. Oryginalny mesher wykonano ponownie po dwóch kontrolowanych wariantach.

| Obserwacja | Liczba body XY | SHA256 body XY |
|---|---:|---|
| Oryginał 30 nm oraz jego powtórzenie | 24 | `fbbdccb6727717118af1218328dd5e17d7339c482e390fb27fa3f5696954ae3d` |
| Oryginał 50 nm oraz jego powtórzenie | 24 | `84f9dbde04e0c705279e640f1a8b96fc8ddaec2e0daf486e8b049668477e497e` |
| Fixed levels i fixed fields | 24 | `0ae106a140d56625f95ac4d164271684cfe44bf1a751db36fe69359f546360f5` |

Powtórzenia zachowały także pełne interface facet digests: odpowiednio
`5830a39407f59d7a1180b8e4ea985c7af83dc25e065815877e30191d63901f55`
i `8abad5bc1a9db213c6d3a95a7efe65c95eaabf470e264af7c43148a17e8ff69e`.
Kontrole mają digest `858a1144ada12ceda9d614eb540bb0b86630fa1989fa873d590070909a1aa23a`.

W tej sekwencji nie wykazano dryfu identycznych wejść. Nie dowodzi to jednak
uniwersalnej deterministyczności Gmsh. Żadna pojedyncza kontrola nie odtwarza
referencji 30 nm. Zanim przypiszemy efekt polom lub partycjom, należy porównać
wykonanie niezmienionego sklonowanego źródła z oryginalną funkcją; prepared
clone dotychczas nie był wykonywany dla baseline. Nie zmieniamy tolerancji,
oczekiwanej niezależności owner XY, PBC ani liczby warstw.

## Stan integracji

### Odbiór niezmienionych klonów

Receipt `df2a0323353049afb93142e955d42526` zebrał wszystkie osiem
obserwacji. PID 187656 odczekany, exit 0, bez timeout/terminate/kill;
fingerprints źródeł stabilne. Niezmieniony clone 30 nm ma ten sam body XY
digest co oryginał 30 nm, a clone 50 nm taki sam jak oryginał 50 nm.
Również późniejsze powtórzenia zachowują te wyniki. W tej próbie różnica
wykonania oryginał/clone nie wyjaśnia trzeciego wyniku fixed controls.
Następna diagnoza rozdzieli air grading od owner VOut/global ceiling,
z zachowaniem wszystkich authored inputs i guardów. To nadal obserwacje,
nie zaliczenie niezależności siatki.

PR #168 pozostaje otwarty. Błędy CI i lokalna niezależność owner/air są
rzeczywistymi niedomkniętymi bramkami. Mesher pozostaje WIP; ta diagnostyka
nie kwalifikuje FEM CPU/GPU, solvera, wydania ani pełnego pakietu Windows.
Pełny native build oraz P8-53 A→B→C nadal wymagają odrębnego dowodu.
