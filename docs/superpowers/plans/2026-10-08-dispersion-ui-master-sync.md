# Aktualizacja worktree UI z mastera — 08.10.2026

## Zakres

- Worktree: `C:\git\fullmag\worktrees\dispersion-mode-ui-20261008`.
- Branch: `codex/dispersion-mode-ui-20261008`.
- Stan przed aktualizacją: czysty, HEAD `807ebb4ed5293a5ff0d63c35c4d1eb12f5c38f1c`.
- Pobrany master: `2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`.
- Integracja 13 commitów z mastera przez merge, bez resetu/rebase/force-push.
- Główny checkout z cudzymi zmianami nie jest modyfikowany.

## Rozwiązanie konfliktu

Jedyny konflikt treści: `crates/fullmag-authoring/src/scene.rs`.
Zachowano obie niezależne zmiany:

1. Dotychczasowy `deserialize_scene_pbc_presence`: brak pola zachowuje PBC,
   jawne null usuwa PBC. Zachowano pola i polityki specyficzne dla brancha.
2. Importowane z mastera `SceneStageF64`, `SceneStageU64`, `SceneStageVec3`
   i `SceneStudyStageState`: liczbowe parametry etapów w canonical scene,
   kontrolowana zgodność z legacy tekstem oraz adaptery/validation mastera.

Nie wybrano całego pliku jednej strony. Parser Rust i brak markerów sprawdzone.

## Dowody

- Production-source receipt `1857c2efff6e482d8352fc5a184999cd`: PASS/exit0.
- Rustfmt `--emit stdout` dla scene.rs: parser PASS, bez formatowania repo
  i bez kompilacji testów.
- Git diff check PASS; brak nierozwiązanych ścieżek w indeksie.
- Bounded review viewportu: zachowane mode/complex/phase wiring,
  rozróżnienie Inspector Focus od Frame All oraz jeden właściciel WebGL.
- CI rozszerzone o `fullmag-authoring --lib scene_`: testy PBC oraz
  numerycznych etapów wyłącznie w GitHub Actions. Wynik merge CI jest osobnym
  dowodem; wcześniejsze CI nie certyfikuje nowego połączenia źródeł.

## Pozostałe ograniczenia

Review źródeł wskazało potencjalne opóźnienie wyboru krawędzi ticków podczas
ruchu kamery: `DimensionFrameLayer` korzysta ze snapshotu cameraState,
zatwierdzanego po końcu gestu OrbitControls. Jest to zachowanie importowane
z mastera, nie skutek rozwiązania konfliktu. Runtime/browser potwierdzenie
tego findingu: NOT VERIFIED. Nie zmieniano mechanizmu kamery w aktualizacji Git.

Aktualizacja źródeł nie jest wdrożeniem nowego backendu ani ponowną walidacją
naukową. Aktywny workspace korzysta ze wcześniej zbudowanego backendu;
frontend dev może przeładować zmienione źródła. Nowe HUD/authoring wymagają
oddzielnego dowodu runtime przed kwalifikacją produktu.

S00–S12 i szersza integracja solvera do mastera pozostają otwarte.


## Korekta po terminalnym CI — 13.10.2026

CI `37845860140` dla `c8a8dd5e4749d180f5cf3f2e46e5bdaa8a466de2`
zakończyło się FAILURE. Capture-contract PASS; native scene: 79 PASS / 1 FAIL;
frontend nie wykonał regresji po awarii Doctor. Poprzednia informacja
„CI oczekuje” opisuje checkpoint historyczny, nie aktualny wynik.

Naprawy tego przyrostu:

1. Scene parallel_execution przyjmuje wyłącznie obiekt lub null. Serde
   dopuszczało reprezentację sekwencyjną struktury, w tym pustą tablicę z
   defaultami. Deserializer odrzuca ten niekanoniczny kształt; null nadal
   przywraca serial, a obiekt adaptive zachowuje intencję. Regresja obejmuje
   pustą i pełną tablicę, nieznane pole i legalny adaptive.
2. Frontend checkout pobiera pełną historię. Doctor działa w checkoutcie
   źródeł (binarium pochodzi z managed workspace), ale fetch-depth 32 nie
   gwarantowało obecności bazowego commita po merge. Osobna kontrola
   cat-file/ancestor kończy CI błędem przed Doctor przy braku właściwej bazy.
   Zakres i bazowy commit pozostają niezmienione; nie wyłączono reguł.

Diff check i parser rustfmt PASS. Testów jednostkowych lokalnie nie
kompilowano. Wykonanie regresji i Doctor wymaga świeżego GitHub Actions;
wynik nie jest jeszcze potwierdzony. Nie zmieniono solvera, progów residualu
ani istniejących danych. Pełne S00–S12 i kwalifikacja naukowa pozostają OPEN.


## Wynik weryfikacji i kolejny runtime — 13.10.2026

Commit naprawy `00b14fb05acd597a1506b3b191a1166631ce2368` jest na remote.
CI https://github.com/MateuszZelent/fullmag/actions/runs/38357947899 zakończone
SUCCESS: frontend, native-resource-contracts i capture-contract PASS.
Oznacza to zamknięcie obu poprzednich awarii tej konfiguracji CI, nie naukową
kwalifikację solvera lub akceptację projektu interfejsu.

Runner potwierdzony healthy/accepting, bez aktywnych buildów. Wykonano managed
serial preflight i rzeczywistą próbę `de-smoke-parallel-probe` na runtime #241
`4ebf0c524ca2479eab4672836694586d`, source digest
`711a91e06a61f5b9dd0352959dd96ef5fd356be1268079f826cd859031cea66d`.
Dry-run PASS; wykonanie terminal FAILED/exit1 przed eigensolve.
Output: `storage/runs/dispersion-mode-ui-20261008-9aae306a4b5f5e7d/4ebf0c524ca2479eab4672836694586d/comsol-dispersion/bf0e6c0f6a3643629a35769db4997f9f`.
Runtime.log: `scoped layer-partitioned realization requested 3 layers but resolved 9 exact z intervals`.
Nie zmieniono wymagania trzech warstw ani guardu; nie zlecono adaptive dla
odrzuconego modelu. Nowszy solver checkpoint `1827c3436f80ff17396c285d13c0e269eecf4b25`
zawiera rozbudowane poprawki _gmsh_swept/_gmsh_fields; ich zależności i dowody
należy sprawdzić przed integracją. Cudzy dirty worktree pozostaje zachowany.

Wykonano niezależny postsolve siedmiu wcześniej obliczonych punktów #241:
parametry z rzeczywistego metadata, dokładne sample_index/k/frequency z JSON
modów, full residual <=1e-8 i pełne lokalne descriptor certificates.
Raport z hashami wejść i źródeł orakli, PNG/PDF:
`storage/runs/dispersion-mode-ui-20261008-9aae306a4b5f5e7d/postsolve-seven-20261013-e2b3056ac79a453bb4c3fc73a86edfa4`.
Nie są to nowe punkty FEM. Względem istniejącego finite-Dirichlet n=0:
Gamma praktycznie 0%, ±5 około -0.0733%, ±15 około -0.5345%, ±25 około -1.255%.
Open-film thickness N=32 pozostawia około -1.023% przy ±25 i ma inne BC.
N=0 jest przybliżeniem; ten raport nie ustala przyczyny różnicy i nie zamyka
zbieżności siatki/airboxu/gałęzi ani porównania COMSOL. Wykres sprawdzony wizualnie.

Następna zależność planu: integracja sprawdzonej realizacji warstw przy
zachowaniu owner-scoped zagęszczenia -> aktualny managed runtime -> powtórzenie
serial/adaptive probe -> kontrola parytetu -> signed DE/BV i zbieżność.
Docelowy projekt UI oraz pełne S00–S12 pozostają OPEN.
