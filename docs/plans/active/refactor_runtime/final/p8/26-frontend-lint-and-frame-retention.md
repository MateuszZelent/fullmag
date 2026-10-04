# P8-26 — bramka lint i retencja mapy pola

Usunięto przyczyny 23 findings (19 errors, 4 warnings) wcześniejszego pełnego
lintu, bez wyciszania reguł ani obniżania jakości wizualizacji.

## Zmiany

- Field Map nie czyta mutowalnego ref podczas renderowania. Jeden lokalny
  magazyn klatki z useSyncExternalStore przechowuje wyłącznie pochodny model
  renderera. Bufory są współdzielone przez referencję, nie kopiowane do state.
  Retencja obejmuje sesję/request epoch, generację domeny i dotychczasową
  semantykę widoku, pełną definicję przekroju i vector budget. Nieznana albo
  zmieniona tożsamość widoku odrzuca starą klatkę. Osobny revision/hash źródła
  zachowuje zgodną klatkę przy chwilowym braku metadanych, lecz odrzuca ją po
  otrzymaniu odmiennej definicji monitora/default slice.
  Selekcja snapshotu pomija cache, gdy jest świeży model; publikacja fallbacku
  nie wywołuje zbędnego renderu ani pętli przy niestabilnej tożsamości modelu.
- FDM cuboid aktualizuje potrzeby rekompilacji materiału przez zamontowany
  surface.material, z kontrolą typu i zgodności instancji, zachowując usunięcie
  instanceColor, rewizję i invalidację. Nie zmienia shaderów, gęstości ani jakości.
- Callback resetu Inspectora uwzględnia setFeedback w zależnościach.
- Usunięto nieużywane frame z destrukturyzacji i dwie nieużywane funkcje smoke;
  niezmienne zmienne regresji Inspectora mają const.

## Dowody i granice

- Pełny lint finalnych źródeł: PASS,
  receipt `a134982df3f143999188abce8c8f7044` (ESLint exit 0, stabilny source digest).
- Produkcyjny TypeScript bez kompilacji testów: PASS,
  receipt `a263b104898349c49aa70dbdfd07bac9`.
- API hygiene: PASS, receipt `083f05d4ca6841bfb3af8665fe2c6ba1`.
- Parser smoke node --check i scoped diff: PASS.
- Zainstalowany React Doctor, changed scope względem
  `638b0c7c9a236d63d407b8265a2e4730fb42a573`: PASS, 10 plików, brak issues,
  receipt `50c7eb8b0f704eedaf65a84f2d8eed7a`. Jest to diagnostyka źródłowa.
- Regresje magazynu oraz mounted hook sprawdzają współdzielenie bufora,
  retencję podczas refresh, stabilny węzeł renderera, ograniczenie renderów
  oraz odrzucenie innej sesji/epoki/domeny. Mounted regresja modułu obejmuje
  również przejściowy brak metadata i zmianę przekroju/budżetu/definicji źródła.
  NOT RUN / NOT COMPILED zgodnie
  z bieżącym zakazem. Dotychczasowa fixture modułu ma jawną tożsamość sesji.
- Niezależne source review: PASS, bez otwartych P0/P1 po dwóch poprawkach.
  Przegląd wykrył brak definicji przekroju/hash źródła w kluczu oraz reset
  przy chwilowym braku metadata. Obie przyczyny poprawiono i ponownie oceniono.
  Przejściowy lint `cd2b31b5f3264c43a069cf859a7d2f17` nie jest dowodem:
  ESLint miał exit 0, ale źródła zmieniły się w trakcie; zastępuje go wynik powyżej.
- Bieżący build, browser/WebGL, 2D refresh/idle i Object/Airbox regression:
  NOT VERIFIED. Stara instancja 3104 nie dowodzi działania tych źródeł.

Ten fragment zamyka wyłącznie źródłowe błędy lint. Pełny plan P0–P8, managed
runtime, domyślne zasoby produktu, cutover i kwalifikacja wydania pozostają
otwarte. Nie zatrzymano 3104 ani nie usuwano danych/cache.
