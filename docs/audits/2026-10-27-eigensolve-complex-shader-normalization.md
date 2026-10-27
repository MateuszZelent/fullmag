# Normalizacja koloru rzeczywistego modu FEM

## Przyczyna i poprawka

Shader zespolony przekazywał surowy wynik projekcji do wspólnego fragment shadera oczekującego znormalizowanego parametru palety. Dla modu +10 rad/µm amplituda sięga 2,5e11, więc większość dodatnich wartości trafiała do końca palety. Dodano normalizację względem aktywnego zakresu wyłącznie w zespolonym vertex shaderze; zwykłe pole skalarne pozostaje normalizowane na CPU. Zdegenerowany zakres otrzymuje środek palety. Kąt fazowy jest skalarem: nie stosujemy do niego ponownie normy wektora, która usuwała znak i mnożyła moduł kąta przez sqrt(3).

## Dowody

- `scripts/verify_complex_surface_shader_pixels.mjs`: rzeczywisty WebGL renderuje stałe pole na trójkącie. Piksele projekcji zespolonej są porównywane z niezależnie zadanym parametrem zwykłej palety: duża amplituda, część urojona, ujemna składowa, moduł zespolony, ujemna faza, zdegenerowany zakres i rotacja fazowa.
- Stare źródło: 6/7 przypadków FAIL. Poprawione źródło: 7/7 PASS; to dowód renderowania programów shaderów, nie test tekstowej obecności instrukcji.
- Rzeczywisty wynik `run-live-b70fc554a63f31f13ed0759ca17dfcfc93dd1580de0a173dd283c00e353b3162`: weryfikator odczytu danych i kontrolek PASS, brak błędów konsoli. Obejrzane obrazy części urojonej oraz fazy mają różne kolory; faza nie jest już nasyconym żółtym polem.
- Nie uruchomiono nowego Solve; nie zmieniono częstotliwości, residualów, tablic zespolonych ani ich normalizacji fizycznej. Tymczasowy pomiar `onBeforeRender` usunięto.

## Pozostałe bramki

Zmiana komponentu, animacja rzeczywistego modu, zgodność przestrzennego obrazu z polem i pełny sweep pozostają otwarte. Nie utożsamiamy siedmiu testów shadera z pełną kwalifikacją UI lub nauki.
