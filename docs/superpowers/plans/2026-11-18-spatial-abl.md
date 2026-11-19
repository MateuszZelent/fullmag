# Projekt do uzgodnienia — przestrzenne warstwy ABL

## Praca w UI

Po aktywacji w Magnetic Parameters użytkownik widzi Absorbing Boundary. Polecenie Add layer tworzy nazwaną warstwę. Warstwę można wybrać, przesunąć, obrócić, wyłączyć, skopiować lub usunąć. Każda ma niezależne ustawienia. Wybór dwóch ścian w jednej warstwie stosuje do obu ten sam profil. Dwie odrębne warstwy pozwalają ustawić osobno np. lewą i prawą stronę.

| Ustawienie | Znaczenie |
|---|---|
| Zasięg | Cała magnetyczna część obiektu lub wskazany region obiektu. Odwołanie używa trwałej tożsamości regionu. Zmiana jego nazwy zachowuje powiązanie. |
| Geometria | Ściany jak w obecnej wersji, przesuwalna płaszczyzna, okrąg wokół zadanej osi, sfera, brzeg regionu lub własna funkcja położenia. |
| Położenie | Punkt odniesienia, oś lub normalna, promień gdy dotyczy, układ obiektu lub świata. Dla płaskiej warstwy można wskazać stronę narastania. Dla kołowej można wybrać narastanie ku większym albo mniejszym promieniom. |
| Profil | Liniowy, kwadratowy, smootherstep, logarytmiczny, tanh lub własne f(u). Całkowita szerokość W, rampa L, plateau W−L, maksymalny dodatek Δα. |
| Pole 3D | Material alpha pokazuje końcowe tłumienie, z aktualizacją po Apply i na tej samej siatce. |

## Znaczenie przestrzenne

Zasięg przycina warstwę do materiału. Wybór krawędzi regionu jako geometrii dodatkowo wiąże położenie gradientu z jego kształtem. Region wyłączony daje zerowy wkład powiązanej z nim warstwy. Usunięcie regionu wymaga rozstrzygnięcia odwołań, żeby zakres nie rozszerzył się na cały obiekt.

Dla pierścienia zewnętrznego o promieniu R odległość ρ jest mierzona od osi zadanej przez środek i wektor jednostkowy. W obszarze ρ < R−W i poza zewnętrznym promieniem R wkład wynosi zero. Od R−W do R−W+L przyrost rośnie zgodnie z profilem. Od R−W+L do R utrzymuje się plateau. Gdy R jest mniejszy niż W, edytor sygnalizuje niepoprawną konfigurację przed zapisem. Warstwa biegnie wzdłuż osi tylko w obrębie wybranego materiału.

Własna funkcja położenia d(x,y,z), ze współrzędnymi i wynikiem w metrach, określa współrzędną warstwy mierzoną od krawędzi plateau w głąb warstwy. Maska 0 ≤ d ≤ W oddziela zasięg od profilu. W jej obrębie u = clamp((W−d)/L, 0, 1). Funkcja odległości pozwala definiować dowolne powierzchnie i orientacje. Fizyczna szerokość W odpowiada szerokości geometrycznej tam, gdzie d jest rzeczywistą odległością. Osobne f(u) określa kształt rampy. Oba wyrażenia przechodzą walidację w ograniczonej gramatyce matematycznej.

Proponowana reguła nakładania to α = α materiału po uwzględnieniu regionalnych parametrów + max lokalnych wkładów ABL, z zerowym wkładem przy braku warstw. Kolejność warstw w drzewie nie wpływa na wynik. Dotychczasowa konfiguracja obiektu zachowuje pole α po wczytaniu jako jedna warstwa.

## Weryfikacja przed wydaniem

- Lewa i prawa ściana z różnymi szerokościami i amplitudami. Sprawdzenie środka, rampy, plateau i narożnika.
- Przesunięty i obrócony pierścień wewnątrz obiektu. Równe wartości na tym samym promieniu, zerowy przyrost poza pasmem.
- Osobne testy maskowania regionem i profilu prowadzonego po granicy regionu, także po zmianie nazwy lub wyłączeniu regionu.
- Zgodny zapis UI → Python → ProblemIR → UI, również dla dawnych projektów.
- Analityczna mapa α próbkowana w komórkach FDM i węzłach FEM. Oddzielne dowody z CPU i GPU. Osobny pomiar odbicia fali przy kwalifikacji skuteczności absorpcji.
- Przeglądarka pokazuje zmianę Material alpha po Apply, także przy projekcji na trójkąty FEM. Zrzuty ekranu i sprawdzenie wartości pola oraz kolorów.

## Plan implementacji i kryteria odbioru

- [x] Rozszerzyć obecną notę naukową i opisać kryteria dla nieregularnych kształtów. W szczególności oddzielić tłumienie na pobocznicy cienkiego filmu od jego górnej i dolnej powierzchni.
- [ ] ProblemIR i wspólny planner materiału. Zachować starszy zapis pojedynczego ABL; kolekcja warstw w polu absorbing_boundary.layers. Porównać próbki analityczne na komórkach i węzłach, także w otworach i częściach nieaktywnych.
- [x] DSL, odczyt, walidacja, edytowalny eksport. Przepuścić prawdziwe skrypty zawierające wiele warstw przez pełny cykl.
- [ ] Interfejs, zasoby sceny, typowany transport i walidacja. Sprawdzić tworzenie, duplikowanie, edycję, wyłączanie i usuwanie, regiony, odświeżanie pola oraz przywracanie istniejących sesji.
- [ ] Zbudować grupę worktree, zweryfikować fizyczne pole i UI, wykonać review, CI, integrację i retencję zgodnie z rejestrem.

Etap DSL: `cd346706ba45848e5cb549f4d6e2da4a87aef0b0`. Sprawdzono przykład z trzema warstwami, eksport scene→Python→ProblemIR oraz 11 testów ABL. Dodatkowe scenariusze i punkty kontrolne opisano w [macierzy odbioru](2026-11-18-spatial-abl-scenarios.md).
