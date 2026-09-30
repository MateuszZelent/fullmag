# Rzeczywiste warstwy filmu Box — 2026-09-30

Naprawiono przyczynę ignorowania `through_thickness_elements`: strategia
Box thin-film korzysta teraz ze wspólnego generatora GEO zachowującego Tet4.
Film ma dokładne płaszczyzny 3/6/9; powietrze ma osobne stopniowanie.
Rozmiar źródłowej siatki x/y pozostaje zadanym hmax i nie jest automatycznie
zmniejszany przez zwiększenie liczby warstw. Wybór tej ścieżki nie podnosi
hmax filmu do rozmiaru elementów airboxu.

Przy rozszerzeniu znaleziono drugi błąd: boczne powierzchnie dotykające
zewnętrznego z były wyłączane z periodyczności. Rozpoznawanie końcowych
płaszczyzn wymaga teraz obu granic z; sprawdzono komplet węzłów bocznych
Box oraz dotychczasowego pierścienia.

Dowody: 70 interpretowanych testów + 15 subtests PASS. W tym 11 nowych
regresji: rzeczywisty Gmsh 4.15.2 dla 3/6/9 warstw, pełna ścieżka
shared-domain kanonicznego przykładu DE z airboxem 4.01 µm,
periodyczne szwy obu kierunków także w zewnętrznych slabach, istniejący
pierścień, dodatnie objętości i odrzucanie niepoprawnych parametrów.
Nie kompilowano testów jednostkowych.

To dowód generacji siatki, nie wynik eigensolve. Płaszczyzny powietrza są stałe przy zmianie liczby warstw filmu. Następny krok: nowa
kapsuła managed runtime-v2 zawierająca zmieniony pakiet Python, następnie
DE/BV k25 z niezależnymi kontrolami Poissona i zbieżności przez grubość.
Stary build #173 nie zawiera poprawki generatora; nie można go wykorzystać
do deklaracji walidacji tej zmiany. Cały cel S00–S12 pozostaje otwarty.
