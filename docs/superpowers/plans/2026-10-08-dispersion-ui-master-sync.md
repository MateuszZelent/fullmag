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
