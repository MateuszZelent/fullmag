# Scenariusze użytkownika dla przestrzennych warstw ABL

To macierz odbioru zatwierdzonego rozszerzenia UI, Pythona i ProblemIR. Każdy przykład zawiera miejsce z oczekiwanym wzrostem tłumienia oraz kontrolę miejsca, które ma zachować lokalne α materiału.

| Scenariusz | Jak użytkownik określa warstwę w UI i Pythonie | Co sprawdzić w polu Material alpha |
|---|---|---|
| Pasek z różnymi zakończeniami | Dwie warstwy na x− i x+, z własnymi szerokościami, profilami i amplitudami | Osobne maksima na końcach, bazowe α w środku. |
| Ukośnie ścięty lub zakrzywiony falowód | Płaszczyzna przez wskazany punkt z normalną wzdłuż lokalnej osi przy wylocie. Region ogranicza pas do wybranego końca. | Wzrost przy wylocie; pobliski odcinek zakrętu zachowuje bazowe α. |
| Rozwidlenie Y, T lub kilka portów | Osobna warstwa i region dla każdego tłumionego ramienia. Jedno ramię może pozostać otwarte. | Zmiana amplitudy na jednym porcie nie wpływa na drugie ramię ani na węzeł połączenia. |
| Cienki dysk | Pobocznica walca, środek i oś dysku, narastanie ku większemu promieniowi. | Równe wartości po okręgu i na obu powierzchniach przy tym samym promieniu. Środek zachowuje bazowe α także przy powierzchni górnej. |
| Pierścień z otworem | Niezależne granice cylindryczne. Przy wewnętrznym brzegu tłumienie narasta ku mniejszym promieniom, przy zewnętrznym ku większym. | Dwa różne maksima; otwór pozostaje poza materiałem. |
| Przesunięty lub nachylony pierścień | Dowolny punkt osi, kierunek i promień. Opcjonalny region skraca pas lub wybiera tylko część obwodu. | Przesunięcie i obrót składają się zgodnie z zadanym układem. Wartość zależy od odległości prostopadłej od osi. |
| Powłoka sferyczna | Środek i promień sfery, kierunek narastania, opcjonalna maska regionu. | Punkty na jednej sferze mają jednakowe α; przy tej samej odległości od osi, lecz innym promieniu sferycznym, mogą mieć inne α. |
| Fragment brzegu, ćwiartka dysku, lokalny absorber wewnątrz próbki | Region jako maska swobodnie położonej warstwy. | Po przeciwnych stronach granicy maski zachodzi oczekiwane odcięcie. Aktywne pozostają tylko punkty wspólne maski i pasma. |
| Warstwa wzdłuż wszystkich ścian regionu | Region jako źródło odległości od granicy. Rodzaj granicy ma znaczenie w cienkiej próbce. | Granica maski i położenie maksimum pokrywają się. Zmiana rozmiaru regionu odpowiednio przesuwa pasmo. |
| Falista krawędź, nieregularny wewnętrzny kontur | Własna współrzędna d(x,y,z) oraz osobne f(u). Przykład to d = h + a·sin(kx) − y. | Wzrost tłumienia podąża za falą. Taka współrzędna mierzy odległość w kierunku y; stała szerokość prostopadle do brzegu wymaga rzeczywistej odległości. |
| Geometria z otworem, wyspami lub wklęsłością | Region CSG jako maska, referencja po ID. Dla brzegu o zadanej grubości potrzebna jest poprawna miara odległości do właściwego obrysu. | Zero poza materiałem i w otworach. Wynik na oddzielnych wyspach odpowiada członkostwu w regionie. Sama informacja wewnątrz/na zewnątrz nie określa grubości pasa w metrach. |
| Importowany STL/STEP bez równania konturu | Osadzona płaszczyzna, walec lub jawna funkcja mogą przecinać importowany materiał. Automatyczne podążanie za wybranymi ścianami CAD wymaga identyfikacji tych powierzchni i miary odległości. | Trzeba odróżnić pas ustawiony na importowanym obiekcie od automatycznego pasa po jego obrysie. Bez dowodu odległości do wskazanych ścian ta druga funkcja pozostaje niepotwierdzona. |
| Nakładające się warstwy i różne materiały | Warstwy niezależne. Najpierw regionalne α materiału, potem największy aktywny lokalny przyrost. | Przestawienie kolejności warstw zachowuje mapę. Dwa absorbery po 0,3 w tym samym punkcie dodają 0,3. |
| Przenoszenie obiektu lub wyłączanie regionu | Układ lokalny obiektu lub świata, region wskazany przez trwały ID. | Lokalna warstwa przemieszcza się z obiektem. Światowa pozostaje we wskazanym miejscu. Wyłączenie regionu wygasza jego warstwę; zmiana nazwy nie zrywa powiązania. |
| Bardzo cienka rampa, stykające się warstwy | Szerokości w metrach. FDM i FEM używają własnych miejsc próbkowania. | Porównać analityczne α w środkach komórek FDM i w węzłach FEM. Gdy siatka omija rampę, sam obraz plateau nie potwierdza rozdzielczości profilu. |

Dla każdego przypadku wykonujemy zapis z UI, eksport do edytowalnego Pythona, odtworzenie ProblemIR i porównanie pola w punktach kontrolnych. Ustawienie kierunku opisuje położenie gradientu w przestrzeni. W tym samym punkcie lokalny współczynnik Gilberta jest skalarem niezależnym od kierunku, w którym porusza się fala.

## Trzy gotowe funkcje położenia dla nietypowych kształtów

W inspektorze wybierz geometrię z własnym polem `Distance d(x,y,z)`. W Pythonie przekaż ten sam tekst do `fm.AbsorbingGeometry.expression(...)`. Współrzędne i wynik są w metrach. Ustaw na przykład szerokość 5 nm i rampę 4 nm. Wtedy punkt z d = 2 nm leży w rampie, d = 0 na plateau, a d < 0 lub d > 5 nm zachowuje bazowe tłumienie.

| Geometria | Wyrażenie do wklejenia | Punkty kontrolne w nm |
|---|---|---|
| Torus o promieniu głównym 40 nm i promieniu rurki 10 nm. Pas biegnie po wewnętrznej stronie powierzchni rurki. | `10e-9-sqrt((sqrt(x*x+y*y)-40e-9)**2+z*z)` | W (48,0,0), (0,32,0) i (40,0,8) odległość wynosi 2 nm. W środku otworu wynosi −30 nm. |
| Eliptyczny dysk o półosiach 40 i 20 nm. Poziomice są współśrodkowymi elipsami. | `20e-9*(1-sqrt((x/40e-9)**2+(y/20e-9)**2))` | Punkty (36,0,0) i (0,18,0) mają to samo d = 2 nm, mimo że leżą odpowiednio 4 i 2 nm od końców osi. Ten profil daje różne szerokości geometryczne wzdłuż półosi. |
| Film z dwoma cylindrycznymi otworami o promieniu 10 nm. Tłumienie rośnie przy obu otworach. | `min(sqrt((x-30e-9)**2+y*y)-10e-9,sqrt((x+30e-9)**2+y*y)-10e-9)` | W (42,0,0) i (−42,0,0) d = 2 nm. W środku prawego otworu d = −10 nm, a pomiędzy otworami d = 20 nm. Dwa absorbery cylindryczne pozwalają nadać otworom różne profile. |

Wszystkie trzy teksty przeszły przez publiczny konstruktor geometrii w Pythonie i ewaluację współrzędnej w łącznie 11 punktach. To sprawdza wartość funkcji położenia. Pole materiałowe i widok 3D mają odrębne testy.
