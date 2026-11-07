# Zapisane pole anteny — wspólny przekrój wizualizacji

Data: 7.11.2026. Fragment E7; pełny odbiór E0–E12 i odtworzenie publikacji pozostają otwarte.

## Problem i zmiana

SavedFieldVisualizationPanel nie przekazywał clippingu do wspólnego
VisualizationInspectorOverview. Dodano jednego właściciela
useVisualizationStateResource i istniejące ViewportClippingControls.
Tożsamość gestu obejmuje bieżącą sesję i przypięty wynik. Summary używa stanu
optymistycznego, renderer potwierdzonego — zgodnie ze wspólną ścieżką.

Plan odbioru fragmentu:
1. Odtworzyć brak sekcji w regresji renderowania — trzy testy RED, następnie GREEN.
2. Sprawdzić typy, lint i architekturę — dowody zapisane osobno.
3. Otworzyć rzeczywisty zachowany wynik i sprawdzić odcinanie mapy oraz WebGL — wykonano ręcznie w UI.

Nie dodano stanu pola do React/Zustand, endpointu, drugiego mechanizmu clippingu,
resamplingu ani Solve. Przekrój odcina obraz 3D; nie tworzy nowych próbek ani
interpolowanej mapy 2D. Jest globalny dla workspace i wymaga dostępnego wspólnego
zasobu wizualizacji. Brak zasobu pozostaje jawną niedostępnością.

## Właściciele kodu

- apps/control-room/src/modules/inspector/panels/SavedFieldVisualizationPanel.tsx,
  SavedFieldVisualizationPanel — zasób, owner i propsy wspólnej sekcji.
- apps/control-room/src/modules/inspector/visualization/ViewportClippingControls.tsx,
  ViewportClippingControls — istniejące polecenia enable/axis/position/flip.
- apps/control-room/src/modules/viewport-3d/layers/ClipPlaneLayer.tsx,
  ClipPlaneLayer — istniejące płaszczyzny renderera i cleanup.
- apps/control-room/src/modules/inspector/panels/SavedFieldVisualizationPanel.test.tsx
  — trzy nowe regresje zasobu, optymistycznego summary i tożsamości.

Niezależny review nie znalazł wymaganej poprawki kodu. Potwierdził wspólną scenę,
clipping w shaderze powierzchni i standardowe materiały Three. Testy mockują
kontrolkę oraz Overview; nie są dowodem WebGL. Fragment wydzielono od wcześniejszego
WIP isInspectionField i przełącznika geometrii anteny w tym samym pliku.

## Rzeczywisty odczyt H275

Home → Open saved run → SolutionSet rev2 → drugi member → H_ant → Inspect pinned dataset:
- projekt project-live-66cd495ce3ccc80762d5bb0ee6652a43966f7c0ecd7989a3b0a52457a800781a;
- run run-ff7d911a0a9237ffa6dad376c1c37539fbeceb6742cfaeca53adcdd1f26370ad;
- SolutionSet solution-80301a1ede3c40482c4bbd9da5561d4c52c170b317c7cab3c2d784c1a2dc1e21, revision 2;
- manifest sha256:54e57da1aa97e5a29e53da6e29eb99d7df945f273f2ddf98018f5fe6ff07bc4f;
- artifact materialized-dataset-26fc60f63262fd1e2682dd931b039f0ca5d228d9c35332668e98a2cb9b218777;
- dataset dataset:retained-current:sha256:a932cdcd958f074d20ef09e270d286c79114055f1456fe27e57b07b831ce454b;
- H_ant, A/m, 275 punktów, trzy składowe; zakres UI 0,02073–25,4 A/m.

Wczytały się mapa i archiwalna geometria źródła. Poprzednia próba otwarcia authoring
.fms odmówiła z powodu już otwartego workspace. Nie zamknięto go ani nie zmieniono
sesji; istniejący przepływ Open saved run wymaga wyłącznie odczytu.

Sprawdzono Off → Z50 → X50 → Y50 → flip → 49,5% → Off.
Screenshoty pokazały przeciwne połowy kolorowej powierzchni oraz powrót pełnej mapy.
GET visualization/state potwierdził revision 10: enabled=true, axis=y,
position_percent=49.5, flipped=true.
Końcowy GET potwierdził oryginalny clip Off, Z, 50%, flipped=false (revision 15).

Dodatkowy publiczny GET FMDS zwrócił 6600 B wartości f64 w układzie by_node.
Sprawdzono tożsamość manifestu/deskryptora, SHA każdego zwróconego zakresu,
275 aktywnych węzłów geometrii i skończoność wszystkich składowych.
Niezależne obliczenie norm w NumPy daje min 0.020726185528905552 A/m i max
25.40102879836274 A/m, zgodne z zaokrąglonymi etykietami UI.
SHA256 payloadu: 7897a8bbdf75da7bcf32cf2fc20baa64b60ca01c0d55d4ad7c3cde0b36488776.
Identyfikator artifact z wiersza Results i dataset_id są różnymi polami;
raport rozdziela je według rzeczywistych metadanych API.

Render details: context active · drawing buffer 944 × 587 px.
Rendered frames: 0 in 2.01 s po ustabilizowaniu.
Po ACK przesunięcia fokus pozostał na Section position; był jeden panel
.fm-saved-field-visualization, a jedyny disabled dotyczył Reset color range to Auto.
Nie dowodzi to pełnej stabilności DOM/pending.

Screenshoty obejrzano w rozmowie; nie zapisano osobnych PNG i nie należy wymyślać
ich ścieżek. Pozostawiono pełną kolorową mapę z wektorami i włączoną geometrią źródła.
Nie uruchomiono Solve, native buildu ani restartu. Sesja ma run=null,
solver=awaiting_command.

## Testy i ograniczenia

W istniejącym frontendzie Docker grupy zadania:
- nowe regresje: 3/3 GREEN po RED (trzy błędy oczekiwanego zachowania);
- TypeScript: PASS; lint zmienionych plików: PASS; architecture hygiene: PASS;
- pełny Vitest: 9556 PASS i jeden błąd konfiguracji odczytu apps/web/dev-server.mjs;
  po ustawieniu obsługiwanego FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source
  wszystkie 12 testów tego pliku PASS. Nie powtarzano pozostałych niezmienionych testów;
- pełny ESLint z heap 384 MiB oraz 1536 MiB zakończył się OOM; oba receipty zachowano.
  Kontrola partiami zachowuje zakres i reguły, bez zmiany konfiguracji.
  Izolacja wskazała useViewport3DSceneModel.ts: sam ten plik kończy się OOM także
  przy 2048 MiB. Nie edytowano go i nie wyłączono reguł. Kontrola zakończona:
  2530/2531 plików PASS, zero zgłoszonych błędów i ostrzeżeń; jeden plik OOM.
  Pełny lokalny lint pozostaje NOT VERIFIED. Manifest zakresu jest w
  lint-batches/manifest.json, a wynik końcowy w lint-batches/summary.json.
  Ten checkpoint nie jest zgodą na merge ani pełnym odbiorem E7.

Starszy ręczny check-saved-field-presentation.mjs zatrzymuje się przed panelem:
nie znajduje dawnego inspectSelected w przebudowanym Results Browser.
Nie użyto go jako dowodu poprawki ani nie zmieniano przy okazji jego przepływu.

Brakuje pełnej automatycznej regresji pending/ACK, root DOM, scroll/focus,
bounded requests i przełączenia sesji/wyniku. Nie zakwalifikowano osobno wszystkich
wariantów wireframe/wektorów. Kontrola powierzchni nie zamyka E7/E12.
Historyczny Failed i representation not verified pozostają jawne.
Nie jest to dowód zgodności Fig. 3 ani kwalifikacji źródła do LLG.

## Dowody trwałe

Prywatny wolumen grupy, backend verification/saved-field-clipping-20261107/:
browser-observations.json, visualization.json, visualization-final.json, status.json,
h275-metadata.json, h275-range-check.json, h275-values.fmds.
Frontend verification/saved-field-clipping-20261107/:
red.json, green.json, lint.json, typecheck.json, full-tests.json,
launcher-source-root.json, architecture.json, lint-all.json, lint-all-1536.json.

To techniczne metadane i testy, nie jedyna kopia wyników naukowych.
Archiwalne dane użytkownika, historia i rezerwacje pozostają zachowane.

## Diagnoza pamięci pełnego lintu

Po drugim OOM sprawdzono cztery drogi: ignorowanie wygenerowanych katalogów buildu,
ograniczenie programów typowanego lintu, zwiększenie heap oraz odrębne procesy dla
ograniczonych partii. Istniejące ignores już wyłączają .next i jego warianty;
nie znaleziono powodu do osłabiania zakresu lub reguł. Inwentarz zawiera ponad
2500 plików JS/TS, około 28,7 MB źródeł, w tym 1,36 MB openapi-v2-types.ts.
Wybrano pełny manifest przez ESLint.isPathIgnored oraz początkowo partie do 32 plików lub
600 kB, z niezmienionymi regułami i --max-warnings=0. Pojedynczy większy plik
pozostaje w osobnej partii. Zbiór dowodów obejmuje każdy proces i pełną listę plików.
Po wskazaniu problematycznej partii dalsze pliki sprawdzano w osobnych procesach.
Limit kontenera pozostaje 8 GiB. Odczyt podczas kontroli wskazał około 3,44 GiB
MemAvailable, więc nie przeznaczano kolejnych wielu GiB na eskalację jednej kontroli.
Nie zmieniono kontenera, konfiguracji lint ani generowanego kontraktu API.

Źródła metody diagnostycznej: [ESLint — Ignore Files](https://eslint.org/docs/latest/use/configure/ignore),
[typescript-eslint — Performance](https://typescript-eslint.io/troubleshooting/typed-linting/performance/).
To wskazówki diagnostyczne; rzeczywisty wynik lintu pochodzi z receiptów naszej grupy.

## CI i automatyczna stabilność zapisanego Inspectora

[Bootstrap 42381001859](https://github.com/MateuszZelent/fullmag/actions/runs/42381001859)
dla commita fc0a8c01ea96ef08c0036edeff6113951e2dca0f zakończył się SUCCESS.
Obejmuje kontrolki frontendu i istniejące scenariusze przeglądarkowe; nie obejmował
jeszcze nowego testu saved-section ani pełnego lokalnego WIP.

Dodano scenariusz saved-section do istniejącego fixture antenowego. Montuje on
SavedFieldVisualizationPanel w InspectorShell, używa prawdziwego
VisualizationRegistrySyncController, typowanego klienta oraz polecenia sekcji.
Metadane H są kontrolowane; fixture nie ładuje rendererów ani hooka metadanych
SavedFieldVisualizationInspector. Nie zastępuje ręcznego odbioru rzeczywistego H275.

Nowy odbiór w przeglądarce sprawdza: niezerowe przewinięcie rzeczywistego ScrollArea,
tożsamość shell/panel/scroll, fokus, wszystkie niepowiązane disabled/opacity,
brak animacji opacity, starszy ACK po nowszym geście, dwa PATCH, ograniczone GET
i commity React oraz brak requestów w idle. Istniejący job inspector-actions
uruchamia go przez verify_pinned_dataset_browser.py na osobnym porcie 3250.
Pełny scenariusz antenowy także zawiera ten odbiór; CI wybiera tylko saved-section,
zachowując dotychczasowe testy Object/Airbox bez zmian.

Przed uruchomieniem browser CI: focused ESLint PASS, TypeScript PASS i 3/3 testów
panelu PASS w istniejącym frontendzie grupy. Receipty: frontend
verification/saved-field-clipping-20261107/stability/.
Wynik przeglądarkowy pozostaje oczekujący; sam przygotowany test nie jest dowodem.
Bez nowego Solve, native buildu, restartu lub zwalniania rezerwacji.
