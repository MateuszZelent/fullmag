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
Pełny browser smoke i gest Apply/Undo po tej zmianie: **NOT RUN**, oczekują CI.
Nie zmieniono publicznego restart_available ani procentu zakończenia planu.
