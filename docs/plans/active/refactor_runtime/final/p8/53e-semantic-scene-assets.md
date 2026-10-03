# P8-53E — pliki modelu w handoffie authoring

Data: 03.10.2026. Status: implementacja warstwy danych i regresje PASS;
konsument restartu w API/launcherze pozostaje do podłączenia.

## Problem i wynik

Prymityw P8-53A przyjmował ręczną listę plików. Sam zapis sceny nie dowodził,
że skopiowano wszystkie jej zależności. Dodatkowo rebase na `SHA256.blob`
zmieniał rozszerzenie: obecny `fullmag-plan::load_mesh_from_source` rozpoznaje
siatkę przez `.json`, więc poprawne bytes pod nazwą `.blob` nie wystarczały.

`development_scene_assets.py` inwentaryzuje zadeklarowane pola źródłowe
SceneDocument. Identyfikator assetu to JSON Pointer do konkretnego pola,
nie nazwa obiektu. `development_scene_handoff.py` rozwiązuje storage projektu,
weryfikuje pliki i ich hashe, zapisuje kapsułę v2 z rozszerzeniami, a przy
odczycie przepina scenę na zweryfikowane kopie. Wejściowy dokument pozostaje
niezmieniony; `source_scene` zachowuje oryginalną scenę, a `scene` zawiera
odwołania do kopii. Requested device/precision i pozostałe dane modelu
pozostają zachowane. Zwrócenie danych nie ustawia receipt na `restored`.

## Mapa zależności

| Deklaracja | Właściciel kontraktu | Obsługa |
|---|---|---|
| ImportedGeometry i zagnieżdżone CSG | `fullmag-authoring/src/scene.rs`, `geometry.rs` | `geometry_params.source`, rekurencja base/tool/a/b/children |
| Region CSG | `fullmag-ir/src/model.rs` | `shape.expression`, tagowane GeometryEntryIR i ImportedGeometry.source |
| Mesh obiektu i override | `fullmag-authoring/src/builder.rs` | `object_mesh.source`, `mesh_override.source` |
| Mesh interfejsu | `fullmag-authoring/src/scene.rs` | `study.mesh_interfaces[*].config.source` |
| Magnetyzacja i initial state | `scene.rs`, `builder.rs` | `magnetization_assets[*].source_path`, `study.initial_state.source_path` |
| Studies i pipeline | `builder.rs`, Python `model/study.py`, CLI `step_utils.rs` | Deklarowane pliki equilibrium oraz `load_state.state_path`; rekursja grup, także wyłączonych węzłów |
| Material references | `scene.rs` | URL/cytowania są provenance; nie są lokalnym assetem |
| Outputs i otwarte params | właściciele typów sceny | Nie skanujemy dowolnych kluczy `path`; nie ma zadeklarowanej zależności plikowej |

Current global/universe mesh typy nie deklarują pola `source`. Pythonowe
`domain_mesh_source` i `frozen_magnetic_submesh_source` nie mają pełnego
odpowiednika w SceneDocument; nie dopisujemy ich automatycznie do jego schematu.
Sampled material field, ImportedSolid selection i explicit frozen-field
`asset_id` nie mają rozwiązywalnego file-backed registry w SceneDocument.
Takie przypadki oraz nieznane geometrie/presety/schematy blokują kompletny
handoff z konkretnym błędem. Surowy reader/writer v1 nadal zachowuje payload;
nie jest deklaracją semantycznej kompletności dla tych przypadków.

## Integralność i zgodność

- Źródła muszą już należeć do skonfigurowanego storage projektu. Warstwa
  nie importuje niejawnie plików spoza storage ani nie zmienia konfiguracji.
  Zapis i odczyt wymagają istniejącego markera projektu oraz pasującego
  rejestru worktree z właścicielem, zadaniem i stanem `active`/`wip`.
  Odczyt tych metadanych jest ograniczony i sprawdza aliasy plików; brak
  rejestracji nie uruchamia bootstrapu. Nie jest to dowód żywego ownera
  procesu — lease generacji pozostaje obowiązkiem konsumenta restartu.
- Manifest odczytu musi dokładnie odpowiadać deklaracjom sceny: brakujące
  i nieprzypisane assety powodują odmowę. Kopiowanie sprawdza ponownie hashe,
  także jeśli źródło zmieni się między preflightem a zapisem.
  Prywatny helper przepięcia referencji wykonuje tylko transformację JSON.
  Publiczną granicą weryfikacji plików jest `load_scene_handoff`, wywołujący
  pełny reader kapsuły przed transformacją. Brak lub zmiana kopii blokuje
  odczyt i pozostawia receipt `staged`.
- Kapsuła v2 zachowuje rozszerzenie źródła w nazwie adresowanej SHA256.
  Normalizacja wielkości liter zapobiega aliasom `.OVF`/`.ovf` na Windows.
  Niedozwolone ścieżki i wieloczłonowe rozszerzenia są odrzucane także przy
  spójnych hashach snapshotu i receiptu.
- Podstawowy reader obsługuje v1 i v2. Semantyczny reader odrzuca v1, jeżeli
  `.blob` zgubiło format źródła; potrzebne jest ponowne zapisanie modelu.
  Starszy writer nie tworzy v2. Aktualizacja obowiązków jest w ADR 0050.
- Kolejny restart może ponownie kopiować assety poprzedniej kapsuły w tym
  samym runtime root po weryfikacji całej kapsuły i wskazanego pliku.
  Nie przyjmuje obcej tożsamości API i nie wznawia solvera.
- Limity: 512 referencji, 64 MiB snapshotu, 256 MiB kapsuły, 128 poziomów,
  100 000 węzłów JSON i 16 Mi znaków danych tekstowych w semantycznym walkerze.
  Przekroczenie limitu blokuje handoff; nie obcina modelu.

## Weryfikacja

Zarządzana recepta `just verify-windows-development-handoff` wykonała
**72 interpretowane testy, 0 skipów, exit 0**. Receipt:
`589fc55b04ef43c899273e6fae820c64` w profilu `development-handoff-checks`.
Hash źródeł przed/po:
`1f5de1fc51f4602980e4ce39088dfc4707e0578e330e58e5e1cd2239b0767e32`.
Inventory receiptu obejmuje zmienione helpery, adaptery Python/Rust,
deklaracje typów oraz konsumenta pipeline CLI i loader equilibrium.
Receipt pochodzi z bazowego HEAD `acde00d5f115695d35c359688ad847b6443ea5e0`
ze zmianami P8-53E w źródłach.

Regresje sprawdzają kopiowanie pliku z managed runs, niezależność od
usuniętego źródła, powtórny handoff, suffix wymagany przez importer meshu,
aliasy wielkości liter, immutable scene, dokładny manifest, CSG, unknown,
traversal, tampering i zmianę pliku podczas zapisu. Baseline nowego konsumenta
był RED (`32704986466c4128b528ba35335c8b36`); regresja unknown version była
RED (`2029ace63a194b24b72ceaa69fc02010`) przed dodaniem jej odmowy.
Nie kompilowano testów jednostkowych ani nie uruchamiano solvera.

Review ujawniło dodatkową stratę ścieżki equilibrium w eksporcie eigenmodes
z Python oraz w adapterach przepisywania sceny Python/Rust. Poprawka zachowuje
ścieżkę przy eksporcie i stosuje nową referencję przy renderowaniu skryptu.
Regresja interpretowana używa rzeczywistego DSL: source → export → scene →
rebase → overrides → script → reload, dla eigenmodes i frequency response,
osobno z zachowanym pipeline i przez adapter starszych wierszy stages.
Walidacja przyjmuje obecne pole `algorithm` eksportera; nie odrzuca
poprawnego aktualnego eksportu. Regresje obejmują także zagnieżdżone
i wyłączone węzły, makra, niespójne aliasy, wymagany plik equilibrium
i rozróżnienie `load_state.state_path` od logicznego `artifact_name`.
Poprawka aliasów zachowuje także ogólne `equilibrium_source/artifact`,
jeżeli pole specyficzne dla etapu jest puste lub null. Regresja Python
była RED przed poprawką; odpowiednie regresje Rust są zapisane w źródłach.
Źródła dodatkowych regresji Rust są zapisane; zgodnie z zakazem kompilacji
testów jednostkowych pozostaje **NOT RUN**. Weryfikacja nie dowodzi poprawności
fizycznej artefaktu equilibrium ani wykonania eigensolve.

Obsługiwany input equilibrium jest pojedynczym plikiem czytanym przez
`load_equilibrium_artifact_v7`; handoff kopiuje jego dokładne bajty. Nie
jest to odtworzenie osobnych pakietów wynikowych LinearizationState ani
wznowienie solvera. Katalogowe źródła Zarr pozostają jawnie nieobsługiwane
przez tę warstwę plików; reader nie raportuje ich jako skopiowanych.
Konfiguracje makr i payload equilibrium/load_state są zamknięte dla
nieznanych pól. Pozostałe znane prymitywy mają obecnie konsumentów bez
wejściowych plików; nie stosujemy do nich dowolnego skanowania kluczy path.

Końcowy niezależny przegląd objął walker, granicę kapsuły i adaptery:
brak blockera w zakresie authoring input. Potwierdzono pojedynczy plik
wejściowy equilibrium, prawidłową odmowę ImportedSolid i brak registry
dla sampled material field. Review nie zastępuje kwalifikacji runtime.
Kontrola `rustfmt --check` adaptera przeszła; testów Rust nie kompilowano.

## Następny krok

Podłączyć tę warstwę do prywatnego ownera restartu po admission/drain;
instalować pełną scenę przed listenerem, nadać nowy UUID/session epoch i pin,
a dopiero po potwierdzeniu modelu opublikować terminalny receipt. Nadal
potrzebny jest rzeczywisty Windows/browser flow z regionami i materiałami,
guard szkiców oraz fault gates. P8-53 i cały plan pozostają w realizacji.
