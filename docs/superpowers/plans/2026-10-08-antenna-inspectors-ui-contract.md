# Anteny — kontrakt węzłów, inspektorów i wizualizacji

## Zakres i status

Dokument projektuje frontend, nie nową fizykę ani nowe API. Opisuje docelowe
odpowiedzialności i luki potwierdzone w kodzie na bazie
`f693a2f7f58be6516ce074c76abce2d18787c6e2`. „Docelowe” nie oznacza wdrożonego.
Nie jest to kwalifikacja publikacji naukowej ani certyfikacja czterech backendów.
Kanoniczne równania i semantyka anten pozostają w istniejącej dokumentacji
fizyki; UI nie może ich redefiniować. Każdy kolejny etap wymaga własnych dowodów.

## Diagnoza sceny użytkownika

Odczyt zasobu sceny aktywnej instancji potwierdził:

- falowód `waveguide-ui-test-muyicwjw`: Box 1000 × 100 × 20 nm;
- antena `antenna-muyid3v0`: `MicrostripAntennaLayout`, długość 1000 nm,
  pasek sygnałowy 50 nm, przewodnik powrotny 500 nm, grubość 10 nm;
- `return_offset_m = 30 nm`; położenie całego obiektu jest osobną transformacją;
- dwa rzeczywiste przewodniki `signal` i `return`, nie jedna bryła AABB.

Szeroki żółty prostokąt jest zatem przewodnikiem powrotnym microstripu.
Nie wolno usuwać go jako „błędu renderowania” ani automatycznie zastępować CPW.
CPW ma trzy coplanarne paski i dwie szczeliny. Typ wybiera użytkownik poprzez
jawne autorowanie, nie przez nazwę obiektu. Podgląd geometrii nie jest wynikiem
solve i nie może być użyty jako zastępcza siatka do kolorowania pola.

## Wspólny kontrakt każdego inspektora

Każdy semantyczny węzeł otrzymuje własny tytuł, zakres i widok szczegółów.
Wspólne komponenty formularzy i renderowania są współdzielone; wspólna karta
„wszystko o antenie” nie zastępuje inspektorów dzieci.

Każdy panel pokazuje immutable object/resource ID, stan zasobu, walidację i
powiązania. Edytuje wyłącznie swój zakres. Draft, pending, konflikt rewizji i
ACK są jawne; aktualizacja danych nie resetuje fokusu, scrolla ani szkicu.
Brak danych nie oznacza pola zerowego. Historyczny wynik pozostaje oznaczony
snapshotem; zmiana wejść nie może uczynić go pozornie aktualnym.

## Specyfikacja wszystkich węzłów

| Węzeł | Co przedstawia | Czym zarządza docelowo | Stan i brakujące elementy |
|---|---|---|---|
| Nazwa anteny / `object.root` | Nazwa, notatki, ID, jawna rola, typ geometrii, widoczność, readiness | Tożsamość, notatki, usunięcie z kontrolą referencji, kolor prezentacyjny | Istniejący ObjectGeneral; nie może prezentować średniej m i energii magnetycznych niemagnetycznego przewodnika. Moduły fizyki pozostają osobnymi węzłami. |
| Geometry / `object.antenna.geometry` | CPW/microstrip, części, rzeczywiste wymiary i stacje, transformacja, odstęp od odbiorcy | Długość/grubość, szerokości/szczeliny, return geometry, stacje, transformacja i ustawienie nad/pod celem | Dedykowany routing dodawany w tym etapie. Istniejący edytor obsługuje stacje i placement; pełna edycja pozostałych wymiarów nadal do wykonania. |
| Antenna / `object.antenna` | Grupuje Conductor, porty, solve, projections, drives, spectra | Nawigacja i tworzenie dzieci | Obecnie nieselektowalny kontener. Jego historyczny route do Regional field drive nie jest podsumowaniem kompozycji; trzeba rozdzielić przy usunięciu legacy routingu. |
| Conductor / `object.antenna.conductor` | Przewodność, materiał, signal/return IDs, terminale, siatka przewodnika i transport | Materiał/przewodność, terminale i polityka siatki; przejście do geometrii | Obecnie pokazuje geometrię i edytory stacji/placement. Pozostają skrótem zgodności do czasu migracji istniejących workflow; docelowym właścicielem geometrii jest Geometry. Nie dublować nowych edytorów. |
| Port / `object.antenna.port` | Port ID, transport, normalizacja, wszystkie gałęzie, terminale, signed weights, walidacja | Dodawanie/edycja/usuwanie portów i gałęzi, wybór istniejących terminali | Obecny dedykowany panel jest read-only. Wymagany autorujący formularz oraz walidacja referencji i bilansu. |
| Field solve / `object.antenna.solution` | Model, porty, transport, sampling domain, targets, mesh/solver policy, outputy, runtime i provenance | Konfiguracja i samodzielne obliczenie anteny bez LLG; publikacja i reuse zgodnie z runtime | Edycja targets i kompozytory istnieją; większość konfiguracji jest read-only. Sampling domain nie jest tym samym co target list. Wymagany rzeczywisty lifecycle komendy i pole błędu. |
| Projection / `object.antenna.projection` | Powiązanie opublikowanej bazy z konkretnym targetem/regionem, carrier identity, podpisy | Wybór/edycja odbiorcy i jawna publikacja zgodnej projekcji | Obecnie read-only; tworzenie projection+drive jest skrótem przy Solution. Nie nazywać samej definicji gotowym wynikiem. |
| Drive / `object.antenna.drive` | Projection/port, prąd, waveform, pasmo, aktywacja w etapach i jednostki | Prąd i funkcja czasu; powiązania, aktywacja, włącz/wyłącz | Edytor waveform istnieje. Powiązania projection/port wymagają pełnej edycji. Prąd nie jest amplitudą B regionalnego źródła. |
| Spectrum / `object.antenna.spectrum` | Source FFT, siatka k, komponent, okno, sampling plane, normalizacja, piki, provenance | Konfiguracja/edycja requestu, wykonanie analizy, wybór widoku/eksport | Heatmap payloadu istnieje; tworzenie requestu jest przy Solution, edycja istniejącego requestu do wdrożenia. Nie utożsamiać FFT źródła z odpowiedzią spinową. |
| Visualization / `object.antenna.visualization` | Wybrany wynik, quantity, komponent/moduł, carrier, jednostka, czas/port, legenda | Te same grupy display co inne obiekty: powierzchnia, wektory, zakres, paleta, clipping, widoczność i kamera | Obecnie tylko bounded preview ośmiu próbek. Wspólny pełny renderer V/J/H i dostosowanie katalogu do owner/carrier nadal do wdrożenia. |
| Regional field drive / `object.antenna.regional` | Jawnie narzucone regionalne pole i jego waveform | Edycja regionalnego źródła, migracja legacy | Oddzielny model źródła. Nie zastępuje portu, current solve ani rozwiązania pola przewodnika; UI musi to wyraźnie nazwać. |
| Physics / dzieci jawnego grafu | Faktycznie skonfigurowane moduły i ich parametry | Wyłącznie parametry danego modułu | Nie dodawać magnetyzacji, LLG ani transportu przez domysł z nazwy/typu. |

## Docelowa wspólna wizualizacja

Układ panelu ma być identyczny z inspektorem innych obiektów, ale zestaw
kontrolek i quantities wynika z katalogu, shape, owner, carrier i capabilities.
Nie wystarczy zamienić etykiety `m` na `J_charge`.

| Quantity | Jednostka w katalogu | Zgodny nośnik | Kontrolki |
|---|---|---|---|
| `V_electric` | V | Obliczona siatka przewodnika | Skalar, paleta, zakres, legenda i przekroje; bez wektorów |
| `J_charge` | A/m² | Obliczona siatka przewodnika | x/y/z, moduł, kolorowanie i wektory |
| `H_ant_basis` | A/m/A | Deklarowana domena próbkowania albo zgodna projekcja | Wybór portu, x/y/z, moduł i wektory; jawne „na jednostkę prądu” |
| `H_ant` | A/m | Zgodny odbiorca/domena i konkretne skalowanie czasowe | Wybór źródła, czasu i komponentu; jawna waveform/aktywacja |

Payload `electric_potential_per_ampere` ma jednostkę V/A, a
`current_density_per_ampere` A/m²/A. Nie są to bez skalowania odpowiednio
`V_electric` i `J_charge`. Obecne bazy muszą zachować swoje jednostki.
Przy wielu portach UI wymaga jednoznacznej bazy lub zgodnej superpozycji;
pojedynczy wybór portu nie oznacza sumy. Nie dopisywać sztucznych field IDs
tylko w frontendzie ani uruchamiać solve przy przełączeniu istniejącego pola.

Odbiorcze B w teslach, żądane jako `b_zeeman_antena_1`, wymaga kanonicznego
katalogu quantity i identyfikacji konkretnego źródła antenowego. Nazwa robocza
nie jest gotowym field ID. Panel musi rozróżnić bezpośrednie pole anteny od
całkowitego pola Zeemana; ten etap routingu nie wdraża takiego kanału.

Bez wyniku UI udostępnia presentation bryły, lecz blokuje field controls z
konkretnym powodem. Niezgodna siatka, zmieniona sesja, brak carrier lub stale
wynik nie może uruchamiać fallbacku na primitive. Odbiorczy airbox nie jest
„magnetycznym airboxem anteny”; jego panel pokazuje zgodne pole w domenie.

## Czytelność geometrii

- Domyślny metal pozostaje złoty zgodnie z centralnymi tokenami.
- Geometry pokazuje osobno signal i returns, ich wymiary oraz legendę części.
- Widok boczny/przekrój ma ujawnić odstęp microstrip signal–return i antena–target.
- Ewentualne ukrycie return jest świadomą opcją podglądu, nie zmianą fizyki;
  default nadal pokazuje pełną geometrię.
- Overlay terminali/kierunków prądu jest diagnostyką; nie udaje wyniku J.

## Etapy i bramki ukończenia

1. Routing Geometry i poprawne podsumowanie root; TypeScript, lint,
   regresja Explorer→Inspector oraz Object/Airbox pending/ACK.
2. Pełne authoring Geometry/Conductor/Port/Solve; round-trip i błędne wejścia,
   konflikt rewizji, zachowanie szkiców oraz niezmienność ID.
3. Projection i Spectrum edit; poprawna identyfikacja source/target/output,
   stale/session mismatch oraz brak payload reads dla niezgodnych wyników.
4. Wspólna wizualizacja; canonical catalog→field store→API→adapter→renderer.
   Osobny dowód V/J/H na rzeczywistych carrierach; przełączanie bez recompute.
5. Browser authoring obu geometrii, top+side screenshots, edycja stacji,
   aktualizacja primitive i test WebGL: widoczny canvas, niezagubiony kontekst,
   niezerowy drawing buffer, zwolnienie zasobów i brak pracy idle.
6. Kopia/odtworzenie sceny i restart portu 3197; sprawdzenie wszystkich węzłów
   oraz fizycznego wyniku standalone anteny. Sama fixture nie dowodzi solve.

Backendy FDM CPU/GPU i FEM CPU/GPU nie są przez tę specyfikację kwalifikowane.
Wymagają osobnych dowodów naukowych/runtime. Zakaz kompilacji testów jednostkowych
pozostaje w mocy; bramki produkcyjnych źródeł i browser są oddzielne.

## Mapa źródeł

- `apps/control-room/src/modules/explorer/builders/objectExplorerNodes.ts`:
  `buildObjectExplorerNode`, `antennaCompositionNodes`, `physicsGraphObjectChildren`.
- `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx`: `resolveInspectorRoute`.
- `apps/control-room/src/modules/explorer/explorerSelection.ts`: `selectionRefFromNode`.
- `apps/control-room/src/modules/inspector/panels/antenna/AntennaGeometryPanel.tsx`: `AntennaGeometryPanel`.
- `apps/control-room/src/modules/inspector/panels/ObjectGeneralPanel.tsx`: `ObjectGeneralPanel`.
- `apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.tsx`:
  `AntennaCompositionPanel`, `conductorDetails`, `portDetails`, `solutionDetails`.
- `apps/control-room/src/modules/inspector/panels/antenna/AntennaVisualizationPanel.tsx`:
  `AntennaVisualizationView`, `AntennaPublishedVisualization`.
- `apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreviewModel.ts`:
  `ANTENNA_BASIS_QUANTITIES`, `MAX_FIELD_BASIS_PREVIEW_SAMPLES`.
- `apps/control-room/src/shared/domain/geometry/authoredMicrostripGeometry.ts`:
  `buildAuthoredMicrostripGeometry`, `buildAuthoredCpwGeometry`.
- `apps/control-room/src/modules/viewport-3d/viewport3dPrimitiveModel.ts`:
  `buildViewport3DPrimitiveRenderModel`.
- `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayerModel.ts`:
  `createPrimitiveObjectGeometry`.

Audyt dwóch subagentów był tylko do odczytu. Potwierdził te luki i istniejącą
obsługę obu geometrii, lecz nie zastępuje browser/runtime evidence.

## Dowody etapu Geometry/root — 08.10.2026

Wdrożono osobny kind i routing `object.antenna.geometry`, opis prawdziwej
konstrukcji CPW/microstripu, istniejące edytory stacji i placement oraz komunikaty
błędu/ładowania/braku wybranego obiektu. Root nie pobiera metrics ani nie pokazuje
energii, gdy antena nie ma ref magnetyzacji, żadnego jawnego wpisu physics_stack
ani region overrides. To konserwatywny warunek pustego modelu magnetycznego;
nie rozstrzyga fizyki istniejących deklaracji na podstawie roli prezentacyjnej.

Dowody w `storage/builds/microwave-antenna-latest-2026090-78aaec16ccf52671`:

| Kontrola | Receipt / wynik | Zakres |
|---|---|---|
| TypeScript produkcyjnych źródeł | `windows-control-room-source-check/production-source/a5d178d7c618442486c7dab3a261460d/receipt.json` — PASS | Bez kompilacji testów jednostkowych |
| Pełny ESLint | `windows-control-room-source-check/lint/4de22fe1b9cb4ba9b76f6fe9300720d5/receipt.json` — PASS | Aktualne źródła i fixture |
| API hygiene | `windows-control-room-source-check/api-hygiene/81c771c83cd04b548858dc3bf60eafdd/receipt.json` — PASS | Bez bezpośredniego transportu w modułach |
| Architecture hygiene | `node scripts/check-architecture-hygiene.mjs`, exit 0 — PASS | Kontrola tylko do odczytu, bez osobnego managed receipt |
| Geometry obu anten | `windows-control-room-browser-fixture/antenna-microstrip-stations-browser/381d813f113d4a478f1bcabcb61e6b88/receipt.json` — PASS | Produkcyjny builder, selection, routing i panel; kontrolowany transport, bez solve. Późniejszy dodatek komunikatów błędu ma dowód TypeScript/lint, nie nową kwalifikację wszystkich błędów |
| Object/Airbox pending/ACK | `windows-control-room-browser-fixture/primitive-color-inspector-browser/6d798827eb0c437bbf4ce48ddbf5ad67/receipt.json` — PASS | Stabilność formularzy oraz brak energii/średniej m/żądań metrics dla niemagnetycznej anteny |
| Natywny pakiet Windows | `windows-native-fdm-cpu-dev/build-status.json` — completed, exit 0, 13:16:36 UTC | Build aplikacji/API/desktopu; nie kwalifikacja FEM ani obliczeń anteny |

Pierwszy native build nie przeszedł linkowania: istniejący plik rlib miał
ścieżkę długości 262 znaków. Ponowny managed build użył wcześniej istniejącego
targetu `windows-native-fdm-cpu-dev/c`, przez zwalidowany override
`FULLMAG_WINDOWS_TARGET_DIR`. Nie usunięto cache ani artefaktów. Microsoft
opisuje ograniczenie długich ścieżek w
[LNK1104](https://learn.microsoft.com/en-us/cpp/error-messages/tool-errors/linker-tools-error-lnk1104?view=msvc-170).
Log udanej próby: `windows-native-fdm-cpu-dev/logs/native-build-c8189ba2fb2b41678fafb7131b9f4082.log`.

Workspace uruchomiono przez `just windows-ui dev 3197 auto dev`.
Kopia sceny znajduje się w
`D:/git/fullmag/storage/runs/antenna-frontend/2026-10-08-inspector-restart/scene-before-restart.json`.
Po sprawdzeniu pustej listy sesji utworzono nową sesję testową i odtworzono model
atomowym `replace_scene` z kontrolą base_revision, przez API v2.
Nowa sesja: `session-18dc9068d6ca81a80000a9c4`, scena rev 1;
GET sceny potwierdził dwa zachowane object IDs, jeden port i jeden solve stage.
Nie wykonano solve ani LLG; nie odtworzono Undo, niezapisanych szkiców czy
historii runtime. Stare publikacje nie stają się aktualne dla nowej sesji.

Live browser na 3197: **PASS w ograniczonym zakresie oględzin**. Po ręcznym
otwarciu URL przez użytkownika sprawdzono odtworzony workspace przez przeglądarkę:
root anteny nie pokazuje grupy energii ani średniej magnetyzacji; Geometry otwiera
dedykowany panel z wymiarami rzeczywistego microstripu, stacjami szerokości
i placement; Visualization otwiera osobny panel anteny, opisuje bazy per ampere
i zgłasza brak zgodnego opublikowanego wyniku. Oględziny i zrzut Geometry
potwierdziły widoczny viewport oraz rzeczywistą szeroką płytę powrotną.
Nie wykonano mutacji geometrii ani solve; nie jest to dowód pełnych map V/J/H,
sprawności każdego przycisku ani kwalifikacja kontekstu WebGL.

Pozostały błąd globalnych powierzchni: HUD viewportu nadal wyświetla `m` przy
wybranej antenie, a dolna telemetria przypisuje zerowe energie Exchange/Demag/
Zeeman/Anisotropy/DMI do jej object_id. Poprawka root Inspectora nie naprawia
tych niezależnych konsumentów. Ich dostępność musi wynikać z jawnych modułów
fizyki i zgodnych danych, a brak próbki nie może być prezentowany jako obliczone
zero. Ten punkt pozostaje otwarty i wymaga regresji wyboru antena ↔ ferromagnetyk.

Cały kontrakt inspektorów oraz pełna wizualizacja V/J/H pozostają nieukończone.
Ten etap nie zamyka sześciu bramek wymienionych powyżej.
