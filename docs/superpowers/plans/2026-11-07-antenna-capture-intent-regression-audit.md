# Regresje intencji wykonania przy eksporcie anteny — 07.11.2026

## Wynik i wpływ na zadanie

Odtworzono trzy defekty przepływu Python → workspace → eksport → Python/UI.
Nie wdrożono poprawki. Nie wykonano nowego Solve, meshowania, buildu,
restartu ani zmiany rezerwacji. Zapisane wyniki V/J/H pozostają bez zmian.

Raport jest audytem istniejącego kontraktu requested intent, a nie nową
notą fizyki lub kwalifikacją solvera. Stosuje zakres audytowy
scientific-documentation-contract. Nie zmienia publicznego DSL, ProblemIR,
formatu SceneDocument, równań, jednostek ani parametrów naukowych.
Korekta źródeł wymaga pełnego rozwiązania poniższych granic.

Baza: 9eaf84e736706ed644c2eb167b692c4b4781a76f.
Weryfikacja interpretera: działający backend grupy 3203,
05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.
Importowano jawnie źródła /opt/fullmag/source/packages/fullmag-py/src,
bez polegania na domyślnym pakiecie Pythona w kontenerze.

## Defekt 1: capture promuje skrypt do trybu interaktywnego

packages/fullmag-py/src/fullmag/world.py::capture_workspace_problem
tymczasowo ustawia _interactive=True. world.py::_build_problem zapisuje tę
wartość w runtime_metadata.interactive_session_requested. Przywrócenie stanu
w finally nie cofa wartości zapisanej w zwracanym Problem.

runtime/script_builder.py::_builder_base_problem wybiera workspace.
_render_runtime następnie emituje study.interactive(True).
Dodawanie etapu przy tej fladze włącza wait_for_solve.
W rezultacie domyślny albo jawnie nieinteraktywny skrypt anteny może po
eksporcie oczekiwać na Compute. To zmiana intencji, nie błąd pola Oersteda.

Potwierdzono na rzeczywistym przykładzie
examples/fem_antenna_sushruth_2020_closed_gsg.py,
SHA256 e73b4af090cd65d6963b3d4a1b90216da0025c135841a487b6a7db6ba7565e8b.

## Defekt 2: scena UI nie przenosi obu flag

Niezależny przegląd i test wykazały brak jawnej reprezentacji interactive
oraz wait_for_solve w następujących granicach:

| Granica | Plik i symbol |
|---|---|
| Problem → builder | packages/fullmag-py/src/fullmag/runtime/script_builder.py::export_builder_draft |
| builder → scena | packages/fullmag-py/src/fullmag/runtime/scene_document.py::build_scene_document_from_builder |
| scena → builder | packages/fullmag-py/src/fullmag/runtime/scene_document.py::build_builder_from_scene_document |
| scena → bootstrap Python | packages/fullmag-py/src/fullmag/runtime/script_builder.py::_render_scene_document_bootstrap |
| nakładanie ustawień sceny | packages/fullmag-py/src/fullmag/runtime/scene_document.py::builder_overrides_from_scene_document |
| builder Rust | crates/fullmag-authoring/src/builder.rs::ScriptBuilderState |
| scena Rust | crates/fullmag-authoring/src/scene.rs::SceneStudyState |
| adaptery Rust | crates/fullmag-authoring/src/adapters.rs::scene_document_from_script_builder oraz scene_document_to_script_builder |

Sama poprawka Python nie zachowa nowych pól po przejściu przez Rust/API.
Nie znaleziono reguły dokumentacyjnej celowo wyłączającej te flagi z
zachowania requested intent. Nie jest to dowód historycznego zamiaru autorów.

## Defekt 3: końcowe wait_for_solve(False) ginie przy eksporcie

Sekwencja interactive(True) → dodanie etapu → wait_for_solve(False)
ma inną intencję niż domyślne oczekiwanie interaktywne.
_build_problem zapisuje wait tylko wtedy, gdy jest True.
Renderer emituje ustawienia runtime przed etapami; dodanie etapu ponownie
ustawia wait na True. Test odtworzył tę zmianę zarówno dla starego kodu,
jak i izolowanego kandydata naprawy defektu 1.

Naprawa musi odtwarzać końcową intencję po deklaracjach etapów.
Nie wolno uznać braku klucza za dowód jawnego False we wszystkich
historycznych kontekstach bez ustalenia semantyki zgodności.

## Weryfikacja i granice dowodu

| Zestaw | Stary kod | Niewdrożone usunięcie wymuszenia interactive |
|---|---:|---:|
| 14 nowych testów capture/eksport | 7 zaliczonych, 7 błędnych zachowań, 0 błędów wykonania | 13 zaliczonych, 1 błędne zachowanie, 0 błędów wykonania |
| 2 dodatkowe testy końcowego wait i sceny | oba wykazują drift | oba nadal wykazują drift |
| Istniejące test_runtime_flags_export + test_auxiliary_object_identity | nie powtarzano | 17/17 zaliczonych |

Jedyny niezaliczony przypadek w pierwszym zestawie kandydata dotyczy
eksportu sceny z jawnym interactive(True). Dwa dodatkowe testy obejmują
końcowe wait(False) po etapie oraz scenę z wait(True) bez interactive.
Nie wyłączono tych testów ani nie zmieniono oczekiwań dla uzyskania zielonego wyniku.

Pierwszy eksperyment candidate-v1 miał dwa problemy samej uprzęży:
kopia globals odcinała mock _build_problem, a wspólne pliki RED/GREEN
powodowały kolizję eksportów. Zachowano nieudane logi. candidate-v2 używa
rzeczywistych globals funkcji oraz osobnych katalogów obu przebiegów.
Powyższa tabela dotyczy poprawionej uprzęży, nie candidate-v1.

Testowano rzeczywisty loader, renderer skryptu i adaptery sceny w interpreterze.
Popen oraz gmsh.model.mesh.generate miały ochronę odmawiającą uruchomienia,
aby test nie stał się pośrednim meshowaniem lub obliczeniem native.
Nie kompilowano testów Rust. Nie wykonano odbioru CLI lub przeglądarki.

## Niewdrożony kandydat i ryzyka

Patch usuwający jedynie tymczasowe wymuszenie ma SHA256
51e9e1be8770bf338d51fd6b170bcf2848c442c8d37445a1ac90edbbd16db8ad.
To częściowy eksperyment, NIE poprawka gotowa do wdrożenia.

world.py::_build_problem nakłada jawne _extra_runtime_metadata po wartości
domyślnej. Istniejące API zachowuje także surowe typy tych metadanych.
Bezwarunkowe odtwarzanie flagi wartością poprzedniego _interactive uszkodziłoby
ten priorytet; objęto go testem False, True, tekstu, liczb oraz None.

Dla geometry-only CLI usunięcie niejawnego interactive zmienia zachowanie:
skrypt bez -i przestanie niejawnie utrzymywać sesję. Sam capture geometrii
nadal działa. crates/fullmag-cli/src/orchestrator.rs::
interactive_session_should_stay_alive ma osobną ścieżkę dla jawnego -i.
Nie potwierdzono jeszcze wykonywalnym odbiorem, że wszystkie launchery UI
dostarczają tę intencję niezależnie od dotychczasowego wycieku metadanych.

## Następny zakres naprawy

Pełne rozwiązanie powinno zachować intencję capture, przenosić opcjonalne
jawne flagi przez istniejące modele builder/scena i oba zestawy adapterów,
odróżniać pominięcie od resetu False oraz odtwarzać końcowy wait po etapach.
Wymaga konkretnych reguł zgodności starszych scen, regresji serde/adapters,
testów Python/UI i odbioru managed runtime. Nie jest to zgoda na nowy
schemat ani zmiana tych kontraktów w tym raporcie.

Nie wdrażano częściowej poprawki i nie składano nowego żądania decyzji.
Oczekująca decyzja o corner25 pozostaje osobna i nie została zużyta.
Priorytet reprodukcji publikacji pozostaje bez zmian; ta usterka dotyczy
powtarzalności uruchamiania i eksportu, a nie rozstrzygnięcia różnic fizycznych.

## Artefakty

Dowody w prywatnym wolumenie grupy:
 /opt/fullmag/control/verification/antenna-authoring-roundtrip-20261107/

| Artefakt | SHA256 |
|---|---|
| candidate-v2/test_capture_intent.py | 712ad2bea751449b4f45a58d34bde1fcdc347d52a496369341dd0d471ac0b441 |
| candidate-v2/verification.json | 9302e72d2e736fdaebd6ba7b3493fa699d2d75c440b7fa0920c990d0932b0f0c |
| candidate-v2/existing-capture-regressions.json | 13ddec91ee2d2395f6882a598fc2bb2b48acf56158723f8a04952c88e4e5d5f9 |
| effective-wait-v1/additional-tests.py | fefb4c099083a9efce33510b9573f2a48c70fde9a3de79a3897d9e8d861da975 |
| effective-wait-v1/verification.json | b0ca298172288920f8edc758f0ab2481fa14dce8564c0ac4b457bbd90f32d3e7 |

capture-intent-audit-summary.json zapisuje także pełne hashe siedmiu
sprawdzonych plików źródłowych. Raport nie zastępuje kompletnego planu
implementacji ani wymaganych bramek końcowego E12.
