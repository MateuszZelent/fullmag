# Dokowanie całego workspace i czytelny układ modów

Cel użytkownika: dowolnie przestawiać Inspector, Explorer i diagnostykę,
również nad/pod innym panelem; ustawić mody po lewej i spektrum po prawej.

1. **Model:** rekurencyjne podziały poziome/pionowe, pojedyncza instancja
   każdego panelu. Układ, kolejność i proporcje zapisuje lokalny
   `fullmag.workspace.dock-tree.v1`. Walidacja odrzuca brakujące/powtórzone
   panele, błędne rozmiary, duplikaty splitów i zbyt głębokie drzewo.
2. **UI:** panel można przeciągnąć do krawędzi całego workspace (pas 12 px)
   albo do krawędzi innego panelu (wewnętrzny pas do 32 px). Podgląd mówi,
   którego obszaru dotyczy operacja. Każdy panel ma także kierunki dokowania
   w menu, a „Reset panel arrangement” przywraca domyślny układ.
   „Modes | Spectrum” dokuje 3D po lewej i Analysis po prawej. Zachowuje
   wybrany wynik; jeśli wynik nie jest wybrany, podpowiada przejście przez
   Results → Modes at k → Show mode in 3D. Back to chart nie zwija już takiej pary.
3. **Weryfikacja:** CI modelu drzewa, SSR, typecheck i właściwe regresje UI;
   przeglądarka z opublikowanym modem: wszystkie panele, podziały wewnętrzne,
   preset, tożsamość canvasów i paneli, zapis/odtworzenie i reset. Bez Solve.
4. **Dowody:** screenshoty i raport końcowy, commit/push bieżącej gałęzi.

Status: implementacja gotowa, CI i przeglądarka w toku.

## Lifecycle i zgodność

ResizablePanelGroup zawiera wyłącznie kotwice pomiarowe. Wszystkie panele
żyją jako stałe, kluczowane rodzeństwo poza drzewem podziałów. Zmiana
miejsca/dokowanie nie przenosi modułu w React i nie tworzy drugiej instancji.
Istniejące reguły Activity oraz niesuspendowanego Inspectora pozostają;
ukryte i pływające panele usuwają tylko swoje kotwice. Compact-screen drawers
pozostają domyślnym zachowaniem; jawne dokowanie użytkownika ma pierwszeństwo.

Stary zapis kolumn/proporcji pozostaje w localStorage; nowy model ma oddzielny
klucz i rozpoczyna od domyślnego drzewa, bez usuwania starych preferencji.
Rozmiary pływających PanelFrame nadal używają dotychczasowych kluczy.
Dane wyników, model fizyczny i komendy solvera nie należą do tej zmiany.
