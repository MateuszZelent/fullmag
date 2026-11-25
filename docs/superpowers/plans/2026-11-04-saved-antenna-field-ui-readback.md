# Zachowane pole anteny w UI po restarcie — 04.11.2026

Potwierdzono publiczny przepływ od zachowanego SolutionSet do rzeczywistego
widoku pola H_ant. W przeglądarce otwarto czytelny przekrój XZ przy y=0.
Nie uruchamiano nowego transportu, H-only, LLG ani buildu.
To kontrola odczytu i prezentacji, nie nowa kwalifikacja naukowa anteny.

## Odtwarzalna ścieżka użytkownika

1. W otwartej instancji 3203 przejść do Home → Open saved run.
2. Wpisać poniższe Project ID i Run ID. Formularz wykonuje odczyt istniejącej
   próby; nie uruchamia symulacji i nie zastępuje bieżącej sesji authoringu.
3. Wybrać SolutionSet w rewizji 2, następnie member zakończony `...ae05a1cb`.
4. Wybrać `H_ant [A/m] · 275 node · 3 components` z `Manifest verified`,
   potem `Inspect pinned dataset`.
5. W `2D View` wybrać `Section plane = XZ`, pozycję 0 µm,
   component `magnitude`, Vectors włączone. Schować pływający Inspector,
   jeżeli zasłania wykres.

| Tożsamość | Wartość |
|---|---|
| Project ID | project-live-66cd495ce3ccc80762d5bb0ee6652a43966f7c0ecd7989a3b0a52457a800781a |
| Run ID | run-ff7d911a0a9237ffa6dad376c1c37539fbeceb6742cfaeca53adcdd1f26370ad |
| SolutionSet | solution-80301a1ede3c40482c4bbd9da5561d4c52c170b317c7cab3c2d784c1a2dc1e21 |
| Rewizja zawierająca wynik | 2 |
| Manifest digest | sha256:54e57da1aa97e5a29e53da6e29eb99d7df945f273f2ddf98018f5fe6ff07bc4f |
| Member | member-f0651f8c30985c9ab3fd6047062172b01c14751172f6a1c16e5ba455ae05a1cb |
| Dataset artifact | materialized-dataset-26fc60f63262fd1e2682dd931b039f0ca5d228d9c35332668e98a2cb9b218777 |
| Field quantity / unit | H_ant / A/m |
| Próbki / składowe | 275 / 3 |
| SHA256 oryginalnych 6600 bajtów H | 7897a8bbdf75da7bcf32cf2fc20baa64b60ca01c0d55d4ad7c3cde0b36488776 |

Nie należy używać zakładki Results bieżącego Run do szukania tego historycznego
SolutionSet. Bieżąca sesja authoringu ma `run=null`. Osobny widok Saved results
jawnie opisuje próbę historyczną i pokazuje jej status Failed. Nie zmieniono go
na Succeeded na podstawie możliwości wyświetlenia zachowanego pola.

## Co rzeczywiście widać

Przekrój XZ obejmuje x od −2 do +2 µm i z od −0,3 do +0,3 µm przy y=0.
Czytelne są zwroty strzałek i zmiany normy pola. Legenda H_ant ma jednostkę A/m,
a zakres rysowanego przekroju wynosi około 0,06048–24,37 A/m.
UI jawnie oznacza `inspection reconstruction, not qualified for LLG`.

Raster 192×192, czyli 36864 piksele, jest rekonstrukcją przekroju z zapisanych
275 próbek i topologii. Nie oznacza 36864 niezależnych punktów Biota–Savarta
ani zagęszczenia rozwiązanej siatki. Dane są `physical_field`,
`normalization=none`: to wartości H jak zapisano, nie baza na amper lub
pole w zadanej fazie przyszłego I(t). Nie rozszerzano domeny próbkowania.

Widok 3D odczytał własną zapisaną domenę oraz właściwe archiwalne źródło anteny.
Sprawdzono niezależne wyłączenie i ponowne włączenie Antenna geometry. Dla
strzałek pozostawiono budżet 275, długość 1×, opacity 100%, Wireframe i Surface
wyłączone; jawnie ustawiono grubość 3 oraz kolorowanie Magnitude. Legenda
pełnych próbek podaje 0,02073–25,4 A/m. To zmiany wyłącznie prezentacyjne.
Pełna wydłużona domena 3D nadal ma zbyt małe strzałki do wygodnej oceny
trajektorii, więc **nie zaliczono jej bramki czytelności**. Czytelny wynik
kontroli dotyczy przekroju 2D, nie pełnej kwalifikacji wszystkich widoków.

Publiczny panel Render details potwierdził:

- WebGL context active, drawing buffer 901×531 px;
- gotowe wektorowe buildy z 275 glyphami, bez degradacji;
- zero wyrenderowanych klatek w dwusekundowym oknie bez interakcji;
- brak błędów konsoli; pozostaje ostrzeżenie deprecacji THREE.Clock.

Zrzuty oglądano bezpośrednio przez narzędzie przeglądarki. Nie tworzono nowego
trwałego eksportu obrazów po wcześniejszej odmowie zapisu zrzutów; archiwum
plikowych screenshotów tego odbioru pozostaje NOT VERIFIED.

## Właściciele przepływu i granice zmian

- `apps/control-room/src/modules/start/OpenSavedRunForm.tsx::OpenSavedRunForm`
  oraz `kernel/saved-results/openSavedRun.ts::openSavedRun`: jawny odczyt i
  weryfikacja istniejącej próby, bez nowej sesji i Solve.
- `modules/results-navigator/SavedResultsBrowser.tsx::{SavedResultsBrowser,SavedRunResults}`:
  wybór immutable SolutionSet/member; `SavedMaterializedArtifactRow.tsx::SavedMaterializedArtifactRow`
  przypina dataset dopiero po zgodności ścieżki i manifestu.
- `kernel/resources/{solutionSetResources,savedGeometryResources,savedPlanarResources}.ts`:
  jedyna warstwa zasobów przez typowaną fasadę API, z przypiętymi identyfikatorami.
- `modules/viewport-3d/savedFieldViewportAdapter.ts::buildSavedFieldViewportSceneModel`:
  zapisane próbki i support, bez sztucznego przypisania do ferromagnetyka.
- `modules/field-map/SavedFieldMap.tsx::SavedFieldSection`: wybór płaszczyzny,
  położenia i składowej oraz prezentacja istniejącej rekonstrukcji.

Nie zmieniono tych implementacji podczas kontroli. Nie wygenerowano nowych
payloadów solvera, nie przełączono pola na m i nie podstawiono brakujących
próbek zerami. Po przejściu między widokami 3D/2D lokalny wybór przekroju wraca
obecnie do YZ i wymaga ponownego wyboru XZ; trwałego zachowania wyboru po pełnym
reload nie zakwalifikowano. Nie dodano nowego formatu, endpointu ani polityki.

## Commit poprawki Results i zachowanie stanu

Poprzednią poprawkę pobierania klatek bez Run zapisano w commicie
`e175f6b67314dae97b5cdc5af58436957aace763`:

- wyłącznie `observationFrameResources.ts` i nowa regresja
  `observationFrameAvailability.test.tsx`;
- wcześniejsze 10 testów, typecheck, lint tych plików i API hygiene pozostały
  ważne dla niezmienionej treści; nie powtarzano ich wyłącznie dla commita;
- wszystkie 47 wcześniejszych staged paths i ich wpisy indeksu są identyczne
  bajtowo przed i po commicie; nie weszły do tego commita.

Odczyt po działaniach UI potwierdził nadal tę samą sesję
`session-18e4b7477333187800004c43`, awaiting_command, `run=null`, oraz bajtowo
identyczne 52 katalogi prób. Backend nadal działa z poprzedniego, przypiętego
snapshotu `cc6c72b553377971dde703ace5cfcae50562b21d5a2379f30020d37911c58a23`;
nie uruchamiano kolejnego buildu po commicie wyłącznie frontendowym.

Wyniki naukowe i zakres kontroli opisuje poprzedni raport
[build i odtworzenie](2026-11-04-antenna-managed-build-and-authoring-restore.md).
Zbieżność GSG i porównanie z publikacją pozostają nieukończone. Zatwierdzony
nowy eksperyment nadal ma V/J/H 0/3 i niezależne kontrole H 0/9. Oczekujące
zmiany granicy capture i publikacji tabel nie zostały zastosowane.
