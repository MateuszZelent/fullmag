# P8-53BL — inwentaryzacja ownerów Inspectora

Data: 13.10.2026. Baza: `a8abbd465810e0f59b3dd8a45d9b1fd3aebcc769`.
Audyt źródeł, bez kompilacji testów i bez restartowania workspace użytkownika.
Cudze zmiany współdzielonego `mastera` pozostają poza zakresem.

## Zarejestrowane formularze

Audyt wykazał 23 bezpośrednie rejestracje produkcyjne
`useRegisterInspectorEditSession`. Funkcja hooka i jej test nie są liczone
jako ownerzy. Poniższe ścieżki są względem
`apps/control-room/src/modules/inspector/panels/`.

| Formularz | Źródło rejestracji |
|---|---|
| Antenna | `AntennaObjectPanel.tsx:100` |
| Coupling | `CouplingInspectorPanel.tsx:63` |
| Cross-section draft | `CrossSectionDraftEditor.tsx:175` |
| Frozen spins | `constraint/FrozenSpinsInspectorPanel.tsx:507` |
| Airbox mesh | `airbox/AirboxMeshParametersPanel.tsx:411` |
| Geometry | `GeometryObjectPanel.tsx:387` |
| Absorbing boundary | `ObjectAbsorbingBoundaryPanel.tsx:84` |
| Object general | `ObjectGeneralPanel.tsx:816` |
| Magnetic texture | `ObjectMagneticTexturePanel.tsx:1123` |
| Material | `ObjectMaterialPanel.tsx:1167` |
| Object mesh policy | `ObjectMeshPolicyPanel.tsx:1272` |
| Object regions | `ObjectRegionsPanel.tsx:780` |
| Object visualization | `ObjectVisualizationPanel.tsx:1359` |
| Physics overview | `PhysicsInspectorOverview.tsx:48` |
| Planar monitor draft | `PlanarMonitorDraftInspectorPanel.tsx:190` |
| Planar monitor | `PlanarMonitorInspectorPanel.tsx:300` |
| New region | `RegionsListPanel.tsx:160` |
| Regional field drive | `RegionalFieldDrivePanel.tsx:194` |
| Spin authoring | `SpinAuthoringInspector.tsx:524` |
| Spin interface | `SpinInterfaceInspector.tsx:367` |
| Study | `StudyInspectorPanel.tsx:1487` |
| Study stage | `StudyStageInspectorRouter.tsx:82` |
| Transport | `TransportAuthoringInspector.tsx:336` |

Panele zagnieżdżone korzystają z ownera rodzica, bridge lub sesji pomocniczej.
Nie wykazano brakującej rejestracji w standardowych formularzach staged.
Obecność hooka jest dowodem podłączenia źródeł, a nie dowodem poprawnego
Apply/Cancel/failure podczas rzeczywistego restartu każdego panelu.

## Stany poza PendingFormRegistry

| Stan | Właściciel i semantyka | Odbiór P8-53 |
|---|---|---|
| Aktywacja Object Extensions | `extensions/ObjectExtensionsSection.tsx:30–44`; domyślnie globalny `useObjectExtensionActivation`, opcjonalnie owner przekazany przez rodzica. Natychmiastowa zmiana widoku, bez Apply. | Nie dodawać sztucznego formularza. Wymaga sprawdzenia zachowania aktywacji i scope obiektu podczas restartu. |
| Topological Charge controls | `extensions/topological-charge/TopologicalChargeExtensionPanel.tsx:63–108`; lokalne `useState` dla trybu, płaszczyzny, support i liczby próbek. Sterują zapytaniem, nie modelem. | Lokalny stan wraca do domyślnych wartości po remount. Pełne zachowanie kontrolek workspace nie jest wykazane; potrzebny jawny owner stanu widoku albo udokumentowany zakres odtworzenia. |
| Ustawienia zapisanego przekroju | `CrossSectionInspectorPanel.tsx:164–167` → `kernel/workspace/crossSectionWorkspace.ts:617–638`. Natychmiastowa aktualizacja zapisanego plotu w store poza panelem. | Sam remount nie dowodzi utraty. Brakuje browser proof zachowania ustawień i poprawnego scope po wymianie kernela. |

## Zasady dalszej realizacji

Nie należy rejestrować parametrów zapytania ani natychmiastowych preferencji
jako szkiców autora modelu wyłącznie po to, aby zwiększyć liczbę ownerów.
Muszą mieć własnego właściciela i jawny zakres capture/restore.
`DevelopmentKernelOwners.capture` zapisuje obecnie workspace
`{schema, layout}`. Nie dowodzi to przeniesienia innych kontrolerów widoku.

Kolejna kontrola obejmuje kamerę: świeży kernel tworzy nowy
`CameraRegistryController`, a `setSessionScopeKey` resetuje jego snapshot.
Przed poprawką należy sprawdzić backendowy snapshot/restore visualization
i odtworzenie zasobu przez nowy klient. Nie wolno wnioskować o utracie
kamery wyłącznie z braku pola w frontendowym payloadzie.

## Stan bramki

Inwentaryzacja źródeł ownerów: **zakończona w opisanym zakresie**.
Pełna macierz browser Apply/Save/Cancel/failure: **NOT VERIFIED**.
Wszystkie ustawienia widoków i dwa restarty w jednej sesji: **NOT VERIFIED**.
P8-53 i cały plan pozostają otwarte; audyt nie podnosi ich do 100%.
