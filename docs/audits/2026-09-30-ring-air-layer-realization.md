# A1 — realizacja warstw powietrza w komorce periodycznej

## Przyczyna i poprawka

Generator exact-cell Box minus Cylinder realizowal film w zadanej liczbie
warstw, ale powietrze nad i pod filmem jako pojedyncze slaby. Pole rozmiaru
Gmsh nie podzielilo tych ekstruzji. Regresja real-Gmsh dla 40 x 40 x 10 nm,
otworu r=8 nm i airboxu 40 x 40 x 410 nm wykazala maksymalny pionowy span
powietrza 200 nm przy zadanym maximum_element_size=50 nm (RED, n=1 i n=3).

Wspolny generator teraz tworzy geometrycznie stopniowane plaszczyzny z
zarowno dla Box, jak i pierścienia. Plaszczyzny zewnetrzne sa niezalezne
od liczby warstw filmu. Zachowano rownania, jednostki SI, translacje PBC,
markery domen i konwencje fazy. Pole Constant utrzymujace rozmiar powierzchni
zrodlowej dziala także dla pierścienia bez lokalnych pol.
Nieobslugiwane linear jest odrzucane przed Gmsh zamiast milczacej zmiany metody.

## Dowody i ograniczenia

77 testow i 15 podtestow PASS: generator, modele DE/BV i wrapper pilota.
Po dodaniu testu odrzucenia linear: 19 testow generatora PASS.
Nowa regresja sprawdza rzeczywiste plaszczyzny, span <=50 nm, dodatnie
objetosci Tet4, objetosc calej komorki oraz kompletne szwy x/y.
Walidator naukowej mapy zrodel PASS. Nie kompilowano testow jednostkowych.

To dowod generacji, nie walidacja dyspersji A1. Nadal NOT VERIFIED:
solver na nowej kapsule, zbieznosc airboxu, poziomy siatki i porownanie COMSOL.
Ograniczenie ring n=1/2/3 i historyczne boczne min(hmax,2*t/n) pozostaja;
nie nalezy traktowac zmiany n w tej sciezce jako czystej zbieznosci z przy
niezmienionej siatce x/y. Potrzebna oddzielna kontrola tej zaleznosci.

## Stan kolejki

#178 d3584c72f1d74300834aaca396902df6 nadal queued, profil runtime-v2.
Obserwator sesja 45879 potwierdzony jako dzialajacy. Jego immutable capsule
zawiera wcześniejsze poprawki Box, nie te poprawki A1. Nie restartowano joba
ani obserwatora; A1 wymaga nowej kapsuly po zapisaniu tego przyrostu.
