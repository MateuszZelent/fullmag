# P8-53CL — jednostki SI topologii fixture Inspectora

Baza: `02e286a0ba038fa7562fb51750a92ac83ac836f1`.
Browser smoke dla 5e99782ac zatrzymał się po Fit view:
https://github.com/MateuszZelent/fullmag/actions/runs/38544583160/job/115787374666.
`qualifyObjectMoveGestureAndSharedApply` czekało na dystans poniżej 14 µm.

Źródłowa przyczyna: `inspectorTopologyBuffer` zapisywał pozycje FMMT od -1 do 2,
interpretowane zgodnie z kontraktem jako metry. Film ma 200×80×5 nm,
a Universe 1 µm. Aktualna topologia ma pierwszeństwo przy określaniu bounds;
`CameraControls` używa globalnego radius×2.8. Dotychczasowy fixture wymuszał
dystans rzędu metrów, więc zwiększenie timeoutu nie naprawiłoby kontraktu.

Zmiana skaluje wyłącznie 36 współrzędnych przez 100 nm i dodaje wykonywalną
asercję skończonych, dodatnich rozpiętości w skali sceny. To syntetyczna topologia
renderowania, a nie fizyczna siatka solvera. Nie zmieniono algorytmu kamery,
timeoutu, warunku dystansu, headera FMMT, indeksów ani markerów.
Brak zmian publicznego JSON/codec: regeneracja OpenAPI nie jest wymagana.

Weryfikacja roota: `node --check` PASS; wykonany konstruktor i validator PASS.
Porównanie z HEAD potwierdziło bajtowo niezmieniony header i całą część po
współrzędnych. Każda z 36 pozycji jest dokładnie starym polem×100 nm.
Negatywna próba ze starym buforem metrowym została odrzucona przez validator.
Na checkpoint źródeł pełny browser smoke był **NOT RUN**; jego późniejszy
odbiór opisano poniżej. Odrębnej kwalifikacji Undo nie wyprowadzamy z samego gestu Apply.
Nie zmieniono publicznego restart_available ani procentu zakończenia planu.

## Odbiór CI po zmianie

Browser-fixture-smoke zakończył się SUCCESS dla `f53dc54f8d82d2e982f25461df0a4eea18aaf81d`
w pull-request run `38555157810`, job `115822361266`:
https://github.com/MateuszZelent/fullmag/actions/runs/38555157810/job/115822361266.
Log potwierdza `objectMoveGesture`, niezerowy drawing buffer 703×436 i
`isContextLost=false` przed i po geście. Przeszły też wcześniejsze kontrole
mutacji wizualizacji Object/Airbox oraz dalsze przypadki całego smoke.
To odbiór syntetycznego fixture i rzeczywistego frontendu w przeglądarce;
nie jest dowodem solvera ani restartu A→B→C. PR pozostaje otwarty do czasu
pozostałych wymaganych kontroli i bezpiecznej integracji.
