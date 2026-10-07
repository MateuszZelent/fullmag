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


## Uzupelnienie: niezalezne zagęszczenie x/y i z

Regresja rzeczywistych pozycji x/y potwierdzila RED dla n=1 vs n=3 przy
stalym hmax=10 nm. Z exact-cell generatora usunieto min(hmax,2*t/n);
teraz powierzchnia zrodlowa zachowuje hmax niezaleznie od n.
Zbiory x/y dla n=1 i n=3 sa identyczne, a hmax=5 nm zwieksza liczbe pozycji.
79 testow +15 podtestow PASS, mapa naukowa PASS. Poprzedni akapit o
zaleznosci bocznej dotyczy stanu sprzed tego uzupelnienia i pozostaje
historycznym dowodem przyczyny. Pozostaly limit n=1/2/3 nie zostal zmieniony.


## Rzeczywista recepta publiczna A1

Po obu poprawkach zrealizowano workflow siatki z problem.py A1 i jego
kanonicznej konfiguracji: okres 200 nm, film 10 nm, otwor r=50 nm,
airbox 200 x 200 x 4010 nm, hmax filmu 5 nm, maksimum powietrza 100 nm,
growth=1.3, n=3. Metoda single_geometry_geo_ring.
102424 wezly, 574620 Tet4, 27558 magnetycznych Tet4, 5084 par wezlow PBC.
Maksymalny span powietrza 100 nm, filmu 3.3333333333333334 nm.
Wszystkie objetosci dodatnie (minimum 6.440494101417479e-27 m3).
Objetosc 1.6039999999999967e-19 m3 zgadza sie z 1.604e-19 m3 komorki.
To kosztowna siatka; przyjecie buildu przez prog 8 GiB nie dowodzi zasobow
potrzebnych do rozwiazania jej calego widma. Nie ma wyniku solvera A1.
Dowod JSON: a1_public_mesh_realization.json w katalogu wizualizacji tego watku.

Nowy managed #179: 1d5451d2fee5443591a9c7f468569c43, runtime-v2, queued.
Digest e6d33f2ab37f1d529db133f12d0d45813fd2d89721121f740e7de3402e62d0fc.
Snapshot bazuje na 4ad72fe03d3d0420a411373cf75ca56103a84c9a,
zawiera biezacy tracked WIP i tracking_mass.rs. #178 pozostaje osobna kapsula
Box/pilotow DE-BV; nie zastapiono go ani nie zmieniono jego obserwatora.
