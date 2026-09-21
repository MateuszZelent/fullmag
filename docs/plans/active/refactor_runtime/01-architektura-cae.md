# Fullmag CAE — nowa architektura całego systemu

**Wersja:** propozycja 2.0, 20 września 2026 r.  
**Status:** PROPOSED — specyfikacja docelowa, nie deklaracja wdrożonych funkcji.  
**Baza odczytu kodu:** `MateuszZelent/fullmag`, `master`, `31bac350a15c0af070287de92d4e0c1a6dabab0e`.  
**Zakres:** model produktu, authoring, Python, geometria, fizyka, dyskretyzacja, studies, planowanie, wykonanie, persystencja, wyniki, UI, rozszerzenia i kwalifikacja.  
**Dokumenty towarzyszące:** [kontrakty](02-kontrakty.md), [migracja](03-migracja.md), [scenariusze odbioru](04-scenariusze.md), [dowody i ADR](05-dowody-i-adr.md).

## 1. Decyzja zasadnicza

**Fullmag należy budować jako projektowe środowisko CAE do mikromagnetyzmu i powiązanych modeli fizycznych, a nie jako interfejs do aktualnej sesji solvera.**

Podstawową jednostką pracy użytkownika jest trwały projekt. Projekt zawiera definicje modeli, parametry, konfiguracje badań, receptury dyskretyzacji, ustawienia numeryczne i definicje prezentacji wyników. Może istnieć bez uruchomionego solvera, bez meshu, bez GPU i bez kompletnego modelu fizycznego. Uruchomione obliczenia oraz zapisane rozwiązania mają własną tożsamość i własny cykl życia.

Control Room pozostaje ważną częścią produktu, lecz staje się widokiem wybranego eksperymentu lub przebiegu. Nie jest właścicielem projektu ani warunkiem jego otwarcia. Nie rezygnujemy z szybkiej pracy `fm.run(...)` ani z interaktywnego sterowania. Nadajemy tym operacjom jednoznaczną semantykę w większym systemie.

Kluczowa zmiana brzmi:

```text
DZIŚ — nadmierne sprzężenie odpowiedzialności
current session → scena/study/runtime → gotowość → dostępny workspace

DOCELOWO
ProjectDefinition → ModelDefinition → StudyDefinition
                                ↓ explicit Compute
                      immutable RunSpecification
                                ↓
              preparation / discretization / execution
                                ↓
                   SolutionSet → Dataset → Plot

Workspace obserwuje i edytuje te zasoby; nie określa ich istnienia.
```

To nie jest propozycja przepisania wszystkich solverów. To nowy podział odpowiedzialności, wykorzystujący istniejące jądro obliczeniowe i mechanizmy przechowywania danych.

## 2. Co było niepełne w poprzednim projekcie

Poprzedni plan trafnie identyfikował globalny gate i ryzyko odmontowania workspace’u. Nie stanowił jednak pełnej architektury CAE: zachowywał `SceneDocument` jako zbyt szeroki korzeń, traktował `/sessions/current` niemal jak trwałą granicę produktu, a wielodokumentowość, historię geometrii i bogatsze studies odkładał poza zasadniczy zakres.

Nowa propozycja zastępuje następujące założenia:

| Poprzednie ograniczenie | Nowa decyzja |
|---|---|
| Projekt prawie utożsamiony z bieżącą sceną | Projekt zawiera modele, studies, źródła, biblioteki i odwołania do wyników. |
| Jeden globalny zestaw ustawień study/mesh/solver | Niezależne, identyfikowalne definicje; study wiąże je referencjami. |
| Wynik przede wszystkim jako stan aktualnego runtime’u | Trwałe rozwiązanie z własnymi danymi, dyskretyzacją i pochodzeniem. |
| Pipeline głównie jako uporządkowana lista komend | Typowane kroki, zależności danych, niezależne próby i jawna kontynuacja. |
| Monitor operacji jako główne rozszerzenie | Monitor jest projekcją wykonania; nie zastępuje modelu projektu i planera. |
| `current` jako centrum API | Jawne identyfikatory projektu, modelu, study, runu i artefaktu. |
| Jeden viewport jako globalny stan | Jeden wspólny system renderowania; kontekst danych zależy od dokumentu i widoku. |
| Wygodne przeglądanie po usunięciu gate | Pełny cykl New/Open/Edit/Save/Compute/Compare/Reopen/Resume. |

Nie unieważnia to wcześniejszych ustaleń o konkretnych błędach startupu. Unieważnia ich użycie jako wystarczającej definicji produktu.

## 3. Punkt odniesienia: COMSOL i CST

Z dokumentacji producentów przyjmujemy cztery obserwowalne wzorce użytkowe: parametryczne modelowanie i selekcje; oddzielenie study od ustawień solvera; powiązanie kolejnych analiz danymi; trwałe zarządzanie modelami i wynikami. COMSOL opisuje te pierwsze elementy w Model Builder, a wersjonowanie i powiązane pliki w Model Manager. CST opisuje wspólne środowisko modelowania i analiz oraz łączenie etapów i solverów w System Assembly and Modeling. [W01–W04](05-dowody-i-adr.md)

Nie wyciągamy z publicznych opisów wniosków o wewnętrznym kodzie tych produktów. Poniższe mechanizmy transakcji, cache, workerów i schematów są propozycją dla Fullmag, a nie opisem implementacji COMSOL/CST.

Docelową jakość mierzymy wykonaniem scenariuszy badawczych bez utraty modelu i bez niejawnych zmian fizyki. Nie deklarujemy pełnego odpowiednika wszystkich modułów CAD, EM i multiphysics obu produktów. Zaawansowane funkcje wymagają własnej implementacji i kwalifikacji, ale model danych nie może od początku uniemożliwiać ich dołączenia.

## 4. Co rzeczywiście już istnieje w Fullmag

W analizowanym kodzie są wartościowe fundamenty, które należy zachować:

- `SceneDocument` obejmuje obiekty, materiały, regiony, tekstury, constraints, transporty i powiązania fizyki. Istnieje również `PhysicsGraphIR` opisujący zakres i obecność modułów. [E02, E05](05-dowody-i-adr.md)
- `StudyPipelineDocument` ma kroki, makra i grupy; zawiera m.in. relaksację, dynamikę, eigenmodes, frequency response, histerezę i parameter sweep. Problemem nie jest całkowity brak studies, lecz ich osadzenie w jednym globalnym stanie i mieszanie intencji badawczej z komendami runtime’u. [E03](05-dowody-i-adr.md)
- `fullmag-session` ma CAS, `SessionStore`, `.fms`, profile zapisu i klasy przywracania. Manifest ma już `run_refs`, a więc format nie jest z definicji ograniczony do jednego runu. Nie należy tworzyć konkurencyjnego formatu tylko po to, żeby zmienić nazwę „session” na „project”. [E06–E08](05-dowody-i-adr.md)
- Python i IR zawierają bogaty model fizyki, geometrii i dyskretyzacji. Cache meshingu uwzględnia wersje producenta, politykę i certyfikację; tej ostrożności nie wolno zastąpić naiwnym hashem samych wierzchołków. [E09–E11](05-dowody-i-adr.md)
- `fullmag-engine` i `fullmag-runner` mają odrębne moduły, ścieżki wykonania, artefakty i logikę obserwacji. Samo istnienie modułu nie dowodzi jednak produkcyjnego wsparcia każdej kombinacji fizyki i urządzenia. [E12–E13](05-dowody-i-adr.md)

Zidentyfikowane ograniczenia strukturalne to m.in. pojedynczy `SceneStudyState`, skupienie endpointów persystencji na `sessions/current` i zależność procesu scratch od zmiany aktywnej sceny. Nowa architektura przebudowuje te granice. [E02, E04, E14](05-dowody-i-adr.md)

## 5. Ontologia produktu: co jest czym

Tożsamość i własność danych muszą wynikać z modelu domenowego, a nie z tego, który panel jest obecnie otwarty.

| Encja | Znaczenie | Czego nie oznacza |
|---|---|---|
| `ProjectDefinition` | Trwały zbiór modeli, źródeł, bibliotek, studies i definicji analiz | Nie proces, sesja HTTP ani aktualny solver. |
| `ModelDefinition` | Definicja układu fizycznego i jego komponentów | Nie wyświetlana scena i nie zestaw buforów meshu. |
| `ComponentDefinition` | Zakres geometrii, układów współrzędnych i przypisań fizycznych | Nie osobny worker ani obowiązkowo pojedynczy magnes. |
| `GeometryFeature` | Parametryczna operacja geometrii z identyfikowanymi wejściami i wyjściami | Nie niezmienny numer ściany wygenerowany przez mesher. |
| `PhysicsConfiguration` | Wybór aktywnych interfejsów, warunków, źródeł i parametrów | Nie konfiguracja urządzenia. |
| `DiscretizationDefinition` | Receptura gridu/meshu i przestrzeni aproksymacji | Nie gotowa topologia. |
| `StudyDefinition` | Cel badania, kroki i zależności ich wejść | Nie jeden konkretny przebieg. |
| `SolverConfiguration` | Kontrolowana receptura metod i tolerancji dla kroków | Nie to, co akurat wybrał planner bez zapisu. |
| `ExecutionProfile` | Żądanie CPU/GPU, precyzji, trybu i zasobów | Nie dowód faktycznego wykonania na GPU. |
| `Run` | Przyjęte wykonanie konkretnej wersji study z przypiętym wejściem | Nie mutowalny draft. |
| `Task` / `Attempt` | Jednostka planu pracy i konkretna próba jej wykonania | Nie krok czasowy LLG. |
| `SolutionSet` | Wyniki kroków/prób z manifestem pochodzenia i oceną jakości | Nie wyłącznie ostatnie pole `m`. |
| `DatasetDefinition` | Jawny wybór i przekształcenie danych rozwiązania | Nie ponowne uruchomienie solvera. |
| `PlotDefinition` | Receptura wizualizacji datasetu, jednostek, skali i przekroju | Nie właściciel danych numerycznych. |
| `RuntimeSession` | Techniczny kontekst wykonawczy umożliwiający np. reuse GPU | Nie kontener całego projektu. |
| `WorkspaceState` | Otwarte dokumenty, aktywny kontekst, layout, selekcja i kamera | Nie kanoniczny stan fizyczny. |

Projekt może mieć wiele modeli i studies. Model może mieć wiele komponentów i receptur dyskretyzacji. Study może być wykonane wiele razy, na różnych profilach urządzeń, bez nadpisywania swoich poprzednich wyników.

Referencje używają stabilnych identyfikatorów. Nazwa jest edytowalną etykietą. Usunięcie encji sprawdza referencje i przedstawia wpływ; nie usuwa po cichu wszystkich zależnych wyników.

### 5.1 Trzy oddzielne autorytatywne obszary

**Definicje:** edytowalne i wersjonowane. Commit definicji aktualizuje rewizję dokumentu i dziennik operacji. Dotyczy również definicji datasetów i wykresów, ale ich zmiana nie musi zmieniać fingerprintu fizyki.

**Wykonania:** dopisywany dziennik runów, tasków, prób, checkpointów i zdarzeń sterowania. Postęp solvera nie podbija rewizji edytowanego modelu. Run wskazuje wersję definicji, z której powstał.

**Artefakty:** niezmienne dane wskazywane przez manifesty, przechowywane przez CAS i istniejące formaty pól. Sam upload pliku nie oznacza ukończenia rozwiązania; autorytatywna jest zatwierdzona publikacja manifestu.

UI ma cache i lokalne szkice edycji. Nie tworzy czwartego, konkurencyjnego właściciela modelu.

## 6. Kanoniczna semantyka: Project, Model i ProblemIR

`SceneDocument` nie powinien pozostać jedyną reprezentacją całego projektu. Rozwijamy `fullmag-authoring` w kierunku typowanych `ProjectDefinition`/`ModelDefinition`; scena renderera staje się ich projekcją. Istniejący schemat `scene.v2` pozostaje wejściem migracyjnym i adapterem przez okres przejściowy.

`ProblemIR` nadal jest wspólną granicą fizyki dla Python/UI i backendów. Nie zamieniamy go w bazę historii edycji, układ docków ani magazyn niewalidowanych ciągów z formularzy. Dla pojedynczego kroku opisuje rozstrzygnięty problem fizyczny; wieloetapowe wykonanie ma nad nim plan study.

```text
UI transactions ───┐
Python DSL/API ─────┼──→ typed authoring kernel / versioned definitions
CLI / automation ──┘                ↓
                    parameter-context resolution
                                   ↓
               geometry + semantic selections + physics
                                   ↓
                study expansion / preflight capabilities
                                   ↓
                ProblemIR + preparation requirements
                                   ↓
          qualified discretization and resolved input artifacts
                                   ↓
              final ExecutionPlanIR / execution receipt
                                   ↓
                runner → FDM/FEM → CPU/GPU
                                   ↓
                  solutions / datasets / reports
```

Wstępny preflight ma wykrywać błędne jednostki i oczywiście niewspierane konfiguracje przed kosztownym meshingiem. Ostateczna walidacja planu musi również uwzględniać rzeczywiście otrzymaną topologię, przestrzeń dyskretną i certyfikaty. Nie zakładamy, że pełne planowanie zawsze da się zakończyć przed powstaniem meshu.

### 6.1 Jedna implementacja reguł naukowych

Normatywne reguły i lowering znajdują się w współdzielonym jądrze authoring/IR/planning. Python wiąże je przez istniejącą granicę `fullmag-py-core` lub wywołuje ten sam protokół w trybie zdalnym. UI korzysta z typowanego API. Lokalna walidacja formularza może szybciej wskazać błąd składni, lecz nie może samodzielnie zatwierdzić kombinacji fizyki i solvera odrzuconej przez backend.

Nie tworzymy osobnego „GUI physics model”, którego semantyka jest później odgadywana przez generowany Python. Nie wprowadzamy też obowiązku uruchamiania serwera GUI dla każdego skryptu headless. Ten sam application kernel ma adapter osadzony i adapter transportowy.

### 6.2 Definicja nie jest wykonaniem

Konstrukcja obiektu geometrii, zapis modelu, pobranie sceny i eksport definicji nie mogą niejawnie uruchamiać solvera. Kosztowna realizacja geometrii może być osobnym zadaniem podglądu. Budowanie meshu, analiza oraz uruchomienie zaufanego generatora Python to odrębne, nazwane operacje.

Dotychczasowe jawne `fm.run(...)` i polecenia budowania meshu pozostają operacjami wykonawczymi. Zachowujemy ich zachowanie przez adapter kompatybilności; nie zmieniamy nagle skryptu obliczeniowego w plik, który jedynie otwiera edytor.

## 7. Parametry, wyrażenia, jednostki i warianty

W profesjonalnym modelu `width = 120[nm]` jest definicją parametru, a nie napisem w polu formularza. Geometria może odwoływać się do `width`, wielkość komórki do `width/30`, a kilka studies używać różnych wartości tego samego parametru bez mutowania globalnego modelu.

Przyjmujemy typowany AST wyrażeń i następujące zasady:

1. Przechowywany jest oryginalny zapis, typ wartości, wymiar fizyczny, zakres symbolu i znormalizowana reprezentacja. Wykonanie używa SI.
2. Zakresy obejmują projekt, model/komponent i kontekst konkretnego study/parametric case. Nadpisania są jawne; nie zależą od kolejności kliknięć.
3. Cykle definicji są błędem z podaniem ścieżki zależności. Zależność od wyniku solvera nie jest zwykłym parametrem stałym — wymaga portu study lub modelu sprzężenia.
4. Funkcje przestrzenne/czasowe i tablice pomiarowe mają typy, układ współrzędnych, interpolację, zasady ekstrapolacji i hash źródła.
5. Nie stosujemy ogólnego `eval()` do wyrażeń GUI. Rozszerzenie o funkcję użytkownika ma jawny kontrakt, zasoby i politykę zaufania.
6. Display units nie zmieniają równania. W szczególności przeliczenie `H` i `B` wymaga semantyki wielkości, nie podmiany etykiety osi.

`ParameterContext` jest niezmiennym zestawem wartości rozstrzygniętych dla przypadku badawczego. Run zachowuje zarówno wartości, jak i definicje, ich źródła oraz politykę nadpisań.

Materiały biblioteczne są wersjonowane. Model przypina wersję materiału, a lokalna modyfikacja tworzy jawny wariant. Aktualizacja biblioteki na dysku nie zmienia odtwarzalności dawnych runów.

### 7.1 Niekompletny model a uszkodzony dokument

Model bez materiału lub study jest poprawnym dokumentem, ale niewykonywalnym modelem. Można go zapisać, otworzyć i rozwijać. `can_save` nie jest równoznaczne z `can_compute`.

Niedokończony zapis `sin(` w aktywnym polu jest szkicem edytora. Recovery może go zachować osobno, lecz nie przedstawia go jako zatwierdzonego wyrażenia. Apply tworzy transakcję semantyczną albo zwraca lokalny błąd. Ta granica pozwala nie gubić pracy bez wpuszczania niepoprawnych danych do IR.

## 8. Geometria jako osobny podsystem

### 8.1 Historia cech zamiast wyłącznie końcowej listy obiektów

`GeometryFeature` ma stabilne ID, typowaną konfigurację, referencje do wejściowych cech, zależności parametrów oraz nazwane wyjścia. Prymitywy, istniejące waveguides, translacja i CSG tworzą pierwszy zakres migracji. Rotacja, skala, wzory, import, partycjonowanie i operacje CAD są rozwijane jako kolejne typy cech z jawnym wsparciem.

Interfejs oferuje Build Selected, Build to Selected i Build All dla sekwencji. To operacje geometrii, nie komendy inicjalizacji magnetycznego solvera. Można zobaczyć wynik wcześniejszej cechy i wskazać, która późniejsza operacja zakończyła się błędem.

Nie uzależniamy utworzenia bryły od przypisania materiału magnetycznego. Bryła może reprezentować magnes, elektrodę, element mechaniczny, obszar pomocniczy lub obiekt konstrukcyjny. Fizykę aktywuje jawne przypisanie, nie nazwa ani `role`.

### 8.2 Trzy różne realizacje

- **Geometry realization:** kształt i relacje topologiczne dla modelowania.
- **Display realization:** triangulacja/LOD/bounds potrzebne do pokazania kształtu.
- **Simulation discretization:** grid FDM albo topologia i przestrzenie FEM.

Są to osobne artefakty. Wysokiej jakości podgląd bryły nie jest certyfikowanym meshem numerycznym. Wczytanie dużej geometrii może wymagać czasu, ale blokuje tylko zależne operacje/widok; drzewo, parametry i zapis dokumentu pozostają dostępne.

Serwis geometrii korzysta z adapterów do istniejących realizatorów. Nie budujemy własnego jądra CAD od zera w ramach naprawy architektury. Dobór i kwalifikacja konkretnego rozszerzenia CAD to osobny spike, obejmujący licencję, deterministyczność, dostępne operacje i serializację. Kontrakt cech nie może zależeć od numerów obiektów w jednej instancji meshera.

### 8.3 Selekcje i topological naming

Trwałe selekcje mogą wskazywać całe komponenty/obiekty, semantyczne wyjścia cech, regiony, interfejsy albo predykaty przestrzenne. Wynik rozwiązania selekcji ma certyfikat: wybrany zbiór, kardynalność, właściciela, fingerprint geometrii/dyskretyzacji i diagnostykę.

Mapowanie po zmianie geometrii opiera się na pochodzeniu cech i jawnych regułach. Podział jednej powierzchni na dwie może dać kilka kandydatów. Nie obiecujemy nieomylnego śledzenia dowolnej topologii; niejednoznaczność blokuje zależną komendę i otwiera narzędzie naprawy selekcji. Automatyczne „najbliższa ściana” bez kontraktu jest niedopuszczalne.

Selekcja komórek przez predykat pola, np. dla Frozen Spins, wskazuje również konkretny snapshot stanu i moment aktywacji. Nie staje się ciągłą, zmieniającą się co klatkę selekcją tylko dlatego, że viewport pokazuje nowe `m`.

## 9. Model fizyczny i multiphysics

Model fizyczny jest niezależny od tego, czy będzie realizowany przez FDM czy FEM. Nie oznacza to identycznego zakresu wsparcia obu rodzin. Każda realizacja ma jawne ograniczenia i dowody kwalifikacji.

Rozdzielamy:

| Kategoria | Przykłady w Fullmag | Własność |
|---|---|---|
| Materiał i parametry | Ms, Aex, damping, tensory anizotropii, przewodność, parametry sprężyste | Przypisania materiału do selekcji i regionów. |
| Oddziaływania/energia | Exchange, demag, DMI, anisotropy, Zeeman | Typowane moduły fizyki. |
| Źródła i wymuszenia | Pole RF, prąd, profil czasowy, temperatura | Definicje źródeł z jednostkami i zakresem. |
| Więzy i warunki | Frozen Spins, PBC/Floquet, elektrody, warunki mechaniczne | Jawne definicje; rozwiązanie na dyskretyzacji. |
| Mechanizmy niekonserwatywne | STT, SOT, dyssypacja | Wkłady do równań; nie udają energii potencjalnej. |
| Stan początkowy | Tekstura, stan zaimportowany, wynik wcześniejszego kroku | Receptura lub przypięty artefakt. |
| Sprzężenia | Current → spin → torque; magnetization ↔ mechanics | Porty i polityka rozwiązania. |

Istniejący `PhysicsGraphIR` jest punktem zaczepienia dla scope i referencji, nie gotowym uniwersalnym kompilatorem równań. Rozwijamy go wraz z typowanymi payloadami rodzin. [E05](05-dowody-i-adr.md)

### 9.1 Dziedziny nie są jednym globalnym airboxem

Domena magnetyzacji, domena prądu, domena mechaniczna i obszar obliczania pola rozproszonego mogą być różne. Airbox bywa elementem realizacji konkretnej formulacji, a nie obowiązkowym składnikiem każdego modelu FEM. Formulacje demagnetyzacji z airboxem i bez niego zachowują własne wymagania.

Publiczny target wizualizacji `airbox` można zachować, ale nie wolno utożsamiać go z dowolnym carrierem obliczeniowym. Zakres fizyczny, nośnik danych i reprezentacja obrazu pozostają jawne.

### 9.2 Sprzężenie wymaga więcej niż strzałki w grafie

Port sprzężenia określa wielkość, jednostkę, domenę, przestrzeń funkcji, układ współrzędnych, charakter rzeczywisty/zespolony i zależność od czasu/częstotliwości. Transfer między dyskretyzacjami wskazuje metodę, błąd i ewentualny wymóg zachowania strumienia lub bilansu.

Dla sprzężenia jednokierunkowego można planować oddzielne kroki. Dla silnego sprzężenia dwukierunkowego potrzebny jest węzeł z wewnętrzną pętlą zbieżności albo solver monolityczny — zgodnie z zakwalifikowaną metodą. Graf zależności tasków nie usuwa cykli fizycznych przez arbitralne uporządkowanie komponentów.

Zakresy harmoniczne, quasi-statyczne i czasowe muszą mieć jawne konwersje i założenia. Nie można bez opisu podać amplitudy zespolonej jako chwilowego wektora źródła.

## 10. Dyskretyzacja: receptura, realizacja, przestrzeń

`DiscretizationDefinition` określa wybraną metodę i jej recepturę dla wskazanej domeny. `DiscretizationArtifact` przechowuje wynik, certyfikaty i pochodzenie. `FunctionSpaceDescriptor` opisuje rozmieszczenie stopni swobody, bazę i ograniczenia. Trzy pojęcia nie są zamienne.

Jedna geometria może mieć `fdm-baseline`, `fdm-fine`, `fem-tet` i `fem-swept`. Study wybiera odpowiedni wariant przez referencję. Zmiana referencji nie kasuje pozostałych receptur, materiałów ani wyników. CPU/GPU jest wyborem wykonania, nie własnością kształtu.

### 10.1 FDM

Receptura obejmuje położenie/orientację obsługiwanej siatki, rozmiar komórek, extent, aktywne maski, ownership materiałów/regionów, warunki brzegowe i politykę demagnetyzacji. Dla multilayer zachowujemy osobno siatki fizycznych warstw i pomocniczą reprezentację wykorzystywaną przez operator sprzęgający.

Przycisk Build Grid oznacza utworzenie lub sprawdzenie gridu i masek. Nie otwiera formularza polityki FEM. Widok jakości FDM pokazuje adekwatne miary rozdzielczości i reprezentacji granic, nie udaje jakości tetraedrów.

### 10.2 FEM

Receptura obejmuje operacje meshingu, pola rozmiaru, regiony, interfejsy, elementy, dystrybucję przez grubość, przestrzenie aproksymacji, pary okresowe i wymagania formulacji. Import powierzchni i import certyfikowanej siatki objętościowej to różne wejścia.

Należy zachować rozróżnienie lokalnego meshu obiektu i zgodnej dyskretyzacji domeny wspólnej. Wyświetlenie kilku lokalnych meshów nie dowodzi, że można je bezpośrednio wykorzystać w jednym konforemnym solve.

Istniejące certyfikaty mixed cells, markerów, topology fingerprint i cache compatibility pozostają obligatoryjne tam, gdzie wymagają tego dzisiejsze lane’y. Nie zwiększamy zakresu wsparcia przez samą zmianę schematu. [E09](05-dowody-i-adr.md)

### 10.3 Remesh i zmiana stanu

Build Mesh nie oznacza automatycznie „wyzeruj magnetyzację aktualnego eksperymentu”. Nowy mesh powstaje jako osobny artefakt. Przy użyciu istniejącego stanu study wybiera: ponowną inicjalizację z receptury, jawny transfer lub brak dozwolonego przeniesienia.

Transfer zapisuje źródło, cel i diagnostykę. Ponowna normalizacja `m` nie jest dowodem zachowania energii, momentu lub ładunku topologicznego. Kontynuacja na nowej dyskretyzacji nie jest `ExactResume`.

Adaptacyjny remesh w obrębie rozwiązania jest kontrolowaną operacją solvera z własną sekwencją generacji i transferów. Nie edytuje w trakcie pracy globalnej receptury draftu.

## 11. Studies jako definicje eksperymentów numerycznych

`StudyDefinition` opisuje, co badamy, na którym modelu, z jaką konfiguracją fizyki i jakie dane przekazujemy pomiędzy krokami. Solver configuration opisuje, jak realizujemy dany krok. Execution profile określa gdzie i na jakich zasobach.

Podstawowy kontrakt kroku obejmuje: ID, typ badania, parameter context, wejściowe porty, oczekiwane wyjściowe porty, referencję dyskretyzacji, konfigurację solvera, politykę akwizycji i kryteria przyjęcia wyniku.

| Krok | Wejścia | Wyniki i warunki |
|---|---|---|
| Relaxation | Model, dyskretyzacja, initial state | Stan końcowy i raport zbieżności; nie zawsze stan równowagi. |
| Time evolution | Stan, wymuszenia, dynamika, harmonogram | Trajektoria/próbki, końcowy stan, raport stopu. |
| Eigenmodes | Kwalifikowany stan linearyzacji, model, k/BC | Wartości własne, mody, normalizacja, residuals. |
| Frequency response | Stan linearyzacji, wymuszenie, częstotliwości | Odpowiedź zespolona i diagnostyka rozwiązania wymuszonego. |
| Dispersion | K-path oraz study modalne | Uporządkowane widma i identyfikacja gałęzi. |
| Hysteresis | Początkowy stan, uporządkowany protokół pola | Zależna sekwencja stanów, settle evidence, krzywa. |
| Independent sweep | Zestaw niezależnych parameter cases | Kolekcja prób z jednoznacznymi współrzędnymi. |
| Coupled solve | Typowane modele i transfery | Stan sprzężony, raport bilansów i zbieżności. |
| Derived analysis | Zapisane dane wystarczającej jakości | FFT, dopasowania, całki, wskaźniki, eksport. |

Jest to katalog architektoniczny; dostępność konkretnego kroku na danej lane wynika z rejestru capabilities i kwalifikacji, nie z obecności w tej tabeli.

### 11.1 Lista dla użytkownika, graf dla planera

Typowe `Relax → Run → FFT` pozostaje czytelną listą kroków. Użytkownik nie musi budować grafu dla prostego eksperymentu. Zaawansowany widok zależności pokazuje rozgałęzienia i współdzielone wejścia. Istniejące `StudyPipelineDocument` i makra migrują do tych konstrukcji, zamiast być usuwane. [E03](05-dowody-i-adr.md)

Pętla histerezy jest operacją kontynuacji: stan punktu n jest wejściem punktu n+1. Rozdzielenie jej punktów na niezależne zadania zmieniłoby eksperyment. Sweep niezależnych geometrii można równoleglić, ale tylko po jawnym określeniu niezależności i polityki initial state.

### 11.2 Equilibrium nie jest synonimem completed

Przykładowo relaksacja zatrzymana na limicie kroków może zakończyć zadanie technicznie poprawnie, ale nie dostarczyć kwalifikowanej równowagi. `EquilibriumEvidence` wiąże stan, model/fizykę, residual/torque, kryterium stopu, tolerancje i constraints. Konsument linearyzacji sprawdza tę zgodność.

Nie wymuszamy jednej liczby tolerancji dla wszystkich metod. Wymagamy natomiast jawnego kryterium i certyfikowanego znaczenia tego kryterium. Zezwolenie na analizę stanu niekwalifikowanego, o ile dana metoda ją dopuszcza, jest świadomym trybem badawczym opisanym w provenance, nie standardowym sukcesem.

### 11.3 Eigenmodes i response nie są jednym solverem

Mogą współdzielić konstrukcję operatora linearyzacji, przestrzeni i części preconditionerów. Mają jednak różne typy wejść, algorytmy rozwiązania, kryteria jakości i wyjścia. UI nie powinien przedstawiać spectrum eigen jako odpowiedzi na RF ani wymuszonego piku jako wartości własnej.

Konwencja harmoniczna, znaki, jednostki częstotliwości i k, faza i normalizacja modów muszą być zapisane z operatorem i datasetem. Wspólna abstrakcja nie usuwa tych różnic.

### 11.4 Optymalizacja i niepewność

Study może zawierać kampanię prób: przestrzeń parametrów, ograniczenia, cel jako wersjonowana receptura derived value, strategię próbkowania i budżet. Zadania są zwykłymi runami/cases, a nie osobnymi, nieśledzonymi wywołaniami solvera z GUI.

Optymalizator otrzymuje również informację o niepowodzeniu i jakości, nie tylko liczbę. Stan „brak zbieżności” nie jest automatycznie zerową wartością funkcji celu. Zaawansowane algorytmy, adjoint i modele zastępcze są rozszerzeniami wymagającymi kwalifikacji; ich porty są przewidziane, implementacja nie jest domniemana.

## 12. Konfiguracja solvera: jawna, ale nie przytłaczająca

Prosty użytkownik wybiera study i dostaje kompletny, wersjonowany preset. Użytkownik zaawansowany otwiera drzewo konfiguracji metod: linearyzacja, integrator, linear/nonlinear solver, preconditioner, tolerancje, stopping criteria, precision policy i ograniczenia pamięci.

Przechowujemy trzy odrębne rzeczy:

- **Authored intent:** preset oraz jawne nadpisania użytkownika.
- **Resolved plan:** konkretne algorytmy i wartości po rozstrzygnięciu capabilities, danych i zasobów.
- **Executed receipt:** rzeczywiście użyte implementacje, urządzenia i wersje.

Odświeżenie domyślnych ustawień w nowej wersji Fullmag nie nadpisuje ręcznych parametrów. Regeneracja presetu pokazuje diff. Ustawienie nieprzenośne na nową lane pozostaje widoczne jako niedostępne z przyczyną; nie znika z dokumentu.

Granica fizyka–numeryka nie polega na ukryciu uproszczeń. Zmiana modelu demagnetyzacji, pominięcie oddziaływania czy zmiana warunku brzegowego jest zmianą założeń obliczenia. Nie może być cichym „optimization fallback”.

## 13. Cztery grafy, nie jeden uniwersalny „graph engine”

Należy rozróżnić cztery struktury, nawet gdy część kodu grafowego jest współdzielona:

| Graf | Przedmiot | Reguła |
|---|---|---|
| Zależności definicji | Parametry, cechy geometrii, referencje selekcji i konfiguracji | Cykle definicyjne odrzucane lub reprezentowane jawnym typem równania. |
| Powiązania fizyczne | Moduły, domeny, źródła i sprzężenia | Cykle są możliwe; wymagają poprawnej metody rozwiązania. |
| Plan wykonania study | Kroki, cases, zależności wyników, operacje zbiorcze | Acykliczny plan z jawnymi operatorami kontynuacji/iteracji. |
| Budowanie artefaktów | Geometria, maski, mesh, przestrzenie, operatory, dane pochodne | Fingerprinty wejść, wersji producenta i kontraktów zgodności. |

Drzewo Model Builder jest projekcją produktu, a dziennik Undo/Redo jest dziennikiem edycji. Żadne z nich nie powinno zastępować powyższych grafów.

Nie warto przenosić każdej komendy UI do jednego dowolnego węzła `kind: string, payload: object`. Typowane warianty rodzin pozwalają sprawdzać porty, jednostki, capabilities i migracje schematów. Wspólny mechanizm rozszerzeń może przechowywać nieznany payload, ale nie może go wykonać bez dostawcy i zgodnego kontraktu.

## 14. Planer przyrostowy i cache

Planer odpowiada na konkretne pytanie: „jakie artefakty są potrzebne do tego kroku, których brakuje i które wolno ponownie wykorzystać?”. Nie odpowiada na pytanie „czy cała aplikacja jest ready”.

Przykładowy łańcuch zależności:

```text
wyrażenia geometrii → GeometryArtifact → semantic selections
                              ↓                  ↓
                       Mesh/Grid recipe + assignments
                              ↓
                  Discretization + FunctionSpace
                              ↓
             material/constraint/operator realization
                              ↓
                  initialized numerical state
                              ↓
               solution → derived dataset → plot
```

Cache ma oddzielne klucze dla geometrii, dyskretyzacji, przestrzeni, operatorów i wyników. Wynik nie jest automatycznie cache’em, który wolno usunąć: opublikowany lub przypięty wynik jest trwałym materiałem badawczym.

### 14.1 Fingerprint zamiast jednego scene_revision

Każdy producent deklaruje pełny zbiór zależności. Klucz zawiera ich znormalizowane wartości lub niezmienne identyfikatory, wersję algorytmu, kontrakt danych i wymagane warunki kompatybilności. Wymaga się deterministycznej serializacji, odrzucenia NaN/Inf tam, gdzie niedopuszczalne, jednoznacznych jednostek i kolejności.

Nie ma obowiązku globalnego przeliczania całego modelu po zmianie koloru czy nazwy. Nie wolno jednak na podstawie intuicji uznać, że zmiana materiału nigdy nie zmienia meshu: mesh kalibrowany fizyką może od tego materiału zależeć.

| Zmiana | Domyślny wpływ; ostatecznie wynika z deklarowanych zależności |
|---|---|
| Kamera, wybór obiektu | Wyłącznie widok. |
| Etykieta obiektu | Prezentacja i opis; tożsamość nie zmienia się. |
| Parametr nieużywany w danym study | Brak przebudowy tego study; pozostaje w historii dokumentu. |
| Geometria lub jej tolerancja | Zależna geometria, selekcje, dyskretyzacja i dalsze artefakty. |
| Wielkość komórki/receptura meshu | Dyskretyzacja, przestrzenie i zależne operatory. |
| Ms/Aex | Zależne operatory i rozwiązanie; także mesh, gdy używa kalibracji fizycznej. |
| Receptura initial state | Stan i rozwiązanie; niekoniecznie mesh/operator. |
| Częstotliwości odpowiedzi | Zadania odpowiedzi; tylko zgodne części operatora mogą być reuse. |
| Definicja przekroju wynikowego | Dataset/widok, jeżeli zapisane dane wystarczają. |
| Nowy monitor online | Przyszła akwizycja; brak gwarancji rekonstrukcji przeszłości. |

Nieznana zależność oznacza zachowawcze unieważnienie, nie optymistyczny reuse. Dla zmiany geometrii sprawdzamy również certyfikaty selekcji i granic, a nie tylko rozmiar tablic.

### 14.2 Reuse numeryczny ma własny kontrakt

Ponowne użycie meshu nie implikuje ponownego użycia macierzy. Ponowne użycie macierzy nie implikuje zgodności preconditionera, historii integratora czy stanu RNG. Każdy poziom ma odrębną kompatybilność.

Cache z obecnego `problem.py` zawiera ważną informację o certyfikatorach i produkcji meshu. Migracja musi zachować te pola lub udowodnić bezpieczniejszy, równoważny kontrakt. [E09](05-dowody-i-adr.md)

## 15. Architektura procesów i odpowiedzialności

### 15.1 Modularny application service, osobne workery

Proponowany standard lokalny to jeden application service obsługujący projekty i koordynację oraz uruchamiane na żądanie procesy robocze. Nie potrzeba klastra mikroserwisów do lokalnej pracy naukowca.

```text
Desktop shell / browser / CLI / Python
                 │
       typed application API
                 │
 ┌──────────── Application service ────────────┐
 │ ProjectRepository + authoring transactions │
 │ Definition evaluator + study compiler     │
 │ Incremental build planner                  │
 │ Execution coordinator + operation journal │
 │ Solution catalog + dataset evaluator       │
 └─────────┬───────────────────────┬───────────┘
           │                       │
    persistent store/CAS     worker protocol
                                   │
              ┌────────────────────┼─────────────────┐
         geometry/mesh       numerical runner   derived analysis
                                   │
                            engine families
                         FDM CPU/GPU, FEM CPU/GPU
```

Moduły logiczne nie muszą od razu stać się osobnymi crates. Wyodrębnienie fizycznego pakietu ma sens, gdy ustalona granica daje niezależne testy, cykl życia lub zależności. Nie przenosimy monolitu `orchestrator.rs` do nowego monolitu o nazwie `ProjectManager`.

### 15.2 Launchery nie są właścicielami projektu

Launcher uruchamia aplikację i wybiera tryb wejścia. Application service zarządza otwartymi projektami. Worker zarządza przydzielonym wykonaniem. Zamknięcie karty przeglądarki nie oznacza anulowania zadania. Zamknięcie całej aplikacji lokalnej oferuje jawne zakończenie/pozostawienie pracy, zależnie od dostępnego modelu nadzorcy.

Nie obiecujemy przetrwania procesu po wyłączeniu hosta. Po awarii run przechodzi do stanu interrupted/unknown wymagającego uzgodnienia; resume korzysta ze zweryfikowanego checkpointu i dozwolonej klasy odtworzenia.

### 15.3 Jeden protokół wykonania lokalnego i zdalnego

`ExecutionTarget` opisuje instalację lokalną, zdalnego workera lub adapter kolejki HPC. Każdy target publikuje capabilities, limity i wersje. Identyfikatory solverów oraz artefaktów nie zależą od ścieżki konkretnego hosta.

Dla HPC coordinator zleca zadanie i obserwuje identyfikator kolejki; nie udaje lokalnego procesu. Transfer wejść jest oparty na manifestach i checksumach. Dane wynikowe można pobierać częściowo. Realizacja adaptera konkretnego schedulera jest osobnym zakresem, ale nie wymaga nowego modelu projektu ani specjalnego UI dla „innych wyników”.

## 16. Przyjęcie wykonania, izolacja i publikacja

### 16.1 Co jest niezmienne w momencie Compute

Transakcja Submit Study przypina: rewizję definicji, definicję study, parametry przypadków, konfigurację fizyki, receptury dyskretyzacji, konfiguracje solverów, zasoby źródłowe, seedy, profile wykonania i politykę akwizycji. Otrzymuje `run_id` i trwały zapis przed potwierdzeniem przyjęcia.

Niektóre wejścia, np. equilibrium z wcześniejszego kroku, jeszcze nie istnieją. Run zawiera wtedy typowaną zależność producent–port w obrębie przypiętego planu. Przed startem konsumenta zależność jest rozstrzygana do konkretnego artefaktu i zapisywana w `ResolvedTaskInput`. Nie wolno później podmieniać jej na „latest” z globalnego workspace’u.

### 16.2 Idempotencja to nie magia exactly-once

Idempotency key identyfikuje intent użytkownika w zakresie projektu. Powtórzenie z tym samym payload digest zwraca tę samą operację. Ten sam klucz z innym payloadem jest błędem. Utracone potwierdzenie POST nie stanowi powodu do ponownego uruchomienia symulacji z nowym ID.

Komunikaty mogą być dostarczane wielokrotnie. Attempt ma token właściciela/fencing epoch i numerację zdarzeń. Stara próba nie może publikować jako nowa po utracie uprawnień. To zabezpiecza **zatwierdzenie efektu**, nie gwarantuje, że po awarii żadne obliczenie nie zostanie kiedykolwiek wykonane powtórnie.

### 16.3 Edycja projektu nie steruje runem

Draft może przejść z revision 10 do 11, gdy run nadal oblicza wejście z revision 10. Wynik runu pozostaje prawidłowym wynikiem swojego wejścia. W relacji do nowego draftu może być nieaktualny, ale nie staje się uszkodzony ani automatycznie przeznaczony do usunięcia.

Obecna zależność scratch procesu od zmiany sceny musi zostać zastąpiona własnością przypiętego runu. Do czasu tej zmiany UI może być dostępny do inspekcji, ale nie może udawać bezpiecznej współbieżnej mutacji starego runtime’u. [E14](05-dowody-i-adr.md)

### 16.4 Publikacja artefaktu

Worker zapisuje dane do obszaru staging, kończy zapisy, oblicza sumy kontrolne i raportuje manifest kandydata. Coordinator sprawdza tożsamość run/task/attempt, dozwolone output ports, kompletność i wymagane certyfikaty. Dopiero potem atomowo zatwierdza referencje w katalogu.

Obraz ostatnio poprawnego wyniku może pozostać widoczny podczas powstawania nowego. UI oznacza jego źródło; nie łączy nowej topologii ze starym polem na podstawie podobnej długości tablic.

### 16.5 Cancel, pause, retry i restart

Anulowanie jest żądaniem, nie natychmiastowym terminalnym sukcesem. Zapisujemy przyjęcie żądania i faktyczny punkt zatrzymania. Pause jest oferowane tylko dla lane, która potrafi zatrzymać się w bezpiecznym punkcie. Wymuszone zabicie workera oznacza interrupted/cancelled z zakresem zachowanych artefaktów.

Retry tworzy nowy attempt z zachowaniem intencji i jawnej polityki seeda. Wznowienie numeryczne wymaga kompatybilnego checkpointu. Restart z końcowej magnetyzacji jest nowym przebiegiem, nie exact resume. Wyniki częściowe mają manifest określający pokrycie danych.

## 17. Control Room i eksperyment interaktywny

Tryb live nadal umożliwia obserwację, pause/resume, wybranie kolejnego kroku i wspierane zmiany parametrów. Nie wolno jednak mieszać dwóch poleceń:

- **Edit model:** zmienia definicję przyszłych obliczeń.
- **Apply to running experiment:** zleca jawne zdarzenie sterujące konkretnemu runtime’owi.

`SteeringEvent` zawiera target run/session, oczekiwany state token, zmianę, politykę punktu zastosowania i rzeczywisty czas/krok ACK. Runtime sprawdza, czy zmiana jest legalna; wykonuje niezbędne unieważnienie operatorów/historii integratora i zapisuje nowy segment eksperymentu.

Zmiana geometrii, która wymaga remeshu i transferu, nie jest zwykłym ustawieniem suwaka live. Staje się kontrolowanym przejściem do nowego segmentu z nową dyskretyzacją lub nowego runu. Przed tym przejściem użytkownik widzi wpływ na stan i checkpointy.

Eksport eksperymentu zawiera początkowe wejście i faktycznie przyjętą sekwencję zmian. Nie przypisujemy całej trajektorii jednemu finalnemu zestawowi parametrów.

## 18. Granica wykonania numerycznego i wydajność

Zachowujemy podział rodziny obliczeniowej oraz urządzenia: FDM CPU, FDM GPU, FEM CPU, FEM GPU. Profile precision/mode i obsługiwane moduły są osobnymi wymiarami capabilities. Rozwinięcie modelu produktu nie może zdegradować hot loop przez narzut UI i serializacji.

Wymagania dla granicy runner–engine:

1. Runner otrzymuje niezmienny problem/plan i jawne referencje stanu. Engine nie odczytuje edytowanego projektu ani `current` API w każdym kroku.
2. Workery planują sensowne jednostki pracy. Nie uruchamiamy nowego procesu i nie przesyłamy całego stanu dla każdego kroku czasowego, punktu małego wewnętrznego sweepu czy wywołania operatora.
3. Powiązane kroki mogą mieć affinity do jednego runtime’u i zachować zasoby GPU, gdy kontrakt pozwala na reuse. Logiczna granica artefaktu nie wymusza kosztownego GPU→CPU roundtrip wszystkich buforów przy każdej obserwacji.
4. Operatory, dane materiałowe, preconditionery i workspace’y mają własne tożsamości kompatybilności i limity pamięci. Brak modułu nie może zamieniać się w cichy fallback.
5. Telemetria jest agregowana, ograniczona i odłączona od synchronizacji solvera. Wolna przeglądarka może utracić klatki podglądu, lecz nie dane zadeklarowane jako wymagany zapis naukowy.
6. Akwizycja ma backpressure i politykę błędu. Utrata miejsca na dysku nie może tworzyć pozornie kompletnego datasetu.
7. Odrzucony krok adaptacyjny nie publikuje accepted state. Rollback obejmuje wszystkie wymagane stany pomocnicze, constraints, cache i RNG.

Deklaracja `GPU` jest weryfikowana przez executed receipt i adekwatny test ścieżki, nie przez samo utworzenie kontekstu CUDA. Hybrydowy przepływ jest dopuszczalny tylko jako nazwany, jawny tryb, a jego koszt komunikacji podlega pomiarowi.

Nowa architektura nie wprowadza nowych równań LLG. Musi zachować dotychczasowe jawne konwencje H/B, gamma, znaków, norm, BC, jednostek i interpretacji energii. Wszelkie zmiany naukowe mają własne noty i testy, nie są skutkiem ubocznym refaktoryzacji.

### 18.1 Kontrakt modułu fizyki i operatorów

Oprócz podziału plików na exchange/demag/DMI potrzebny jest jawny kontrakt tego, jakie operacje dostarcza dana implementacja. Moduł może oferować energię, pole efektywne, residual/RHS, działanie Jacobianu, informacje o linearyzacji albo sprzężeniu. Nie zakładamy, że każdy moduł ma wszystkie te operacje: torque nie musi posiadać energii, a implementacja transient nie dowodzi istnienia poprawnego Jacobianu do eigenmodes.

`OperatorBundle` wiąże dyskretyzację i przestrzenie, parametry materiałowe, ograniczenia, BC, nullspace/gauge, reguły mapowania DOF oraz wersje dostawców operatorów. W zależności od analizy udostępnia właściwy residual, metrykę/macierz masy i działanie operatora liniowego. Nie wymuszamy identycznej reprezentacji algebraicznej FDM i FEM; wymagamy wspólnego znaczenia fizycznego i jawnej realizacji dyskretnej.

`ConstraintOperator` musi być uwzględniony zarówno w ewolucji, jak i w przestrzeni linearyzacji. Wyłączenie DOF w wizualizacji albo zerowanie strzałki nie jest implementacją Frozen Spins. Własność ograniczeń i ich activation state musi przejść przez plan, runtime, checkpoint i wynik.

`SolverStrategy` konsumuje wymagany kontrakt operatorów, a nie obiekt UI lub dowolny słownik ustawień. Relaksacja, integracja czasowa, zadanie własne i odpowiedź wymuszona mają odrębne walidatory wejścia i kryteria jakości. Brak wymaganej operacji, np. tangent/Jacobian dla danego wkładu, blokuje konkretną analizę przed solve.

### 18.2 Wspólne kontrakty nie oznaczają wolnego wspólnego hot loop

Warstwa interfejsu jest na granicy inicjalizacji, planowania i kroków solvera. Nie wprowadzamy wirtualnego dispatchu Python/JSON dla każdej komórki lub węzła. Backend może łączyć wkłady w fused kernels, stosować matrix-free/partial assembly i własne layouty, o ile zachowuje zadeklarowany kontrakt oraz testy operatorów.

Weryfikacja obejmuje osobno zgodność energii i pola/gradientu tam, gdzie istnieje energia, zgodność residualu i linearyzacji, zachowanie BC/constraints oraz wpływ przybliżeń. Zmiana realizacji operatora, preconditionera lub częstotliwości aktualizacji pola jest jawna w planie i fingerprintach. Nie ukrywamy zmiany równania pod flagą wydajności.

Na początku migracji opakowujemy istniejące interfejsy engine/runner, zamiast jednocześnie przepisywać ich numerykę. Nowe abstrakcje muszą przejść test narzutu i data residency. Gorszy czas uzyskania zadanej dokładności jest regresją nawet wtedy, gdy nowa struktura kodu wygląda czytelniej.

## 19. Wyniki: Solution, Dataset, Derived Value i Plot

### 19.1 Rozwiązanie nie jest ostatnim buforem

`SolutionSet` grupuje wyniki konkretnego study/runu, przypadków parametrycznych i etapów. Zawiera stan wykonania oraz osobno ocenę naukową. Rozwiązanie wskazuje model i fizykę, dyskretyzację, przestrzeń, warunki, seedy, rzeczywisty plan, konfigurację akwizycji i raporty jakości.

Dla dużych runów stosujemy dopisywane, niezmienne segmenty danych z manifestem pokrycia. Ostateczny manifest zamyka zbiór. Podgląd bieżącego fragmentu nie oznacza pełnej trajektorii.

### 19.2 Dataset jest recepturą wyboru danych

Przykłady: `m` w zadanym czasie; odpowiedź zespolona przy f=8 GHz; mod nr 4 przy k=...; przekrój w płaszczyźnie; różnica dwóch rozwiązań po jawnej projekcji; rodzina krzywych po parametrze grubości.

Dataset wskazuje solution ID, selection, współrzędne osi i operacje transformacji. Przypięte ID są domyślne w wynikach przeznaczonych do publikacji. Dynamiczny wybór „ostatni zakończony run tego study” może istnieć jako wygoda obserwacji, ale eksport musi zamrozić konkretne źródło i zapisać je w provenance.

### 19.3 Metadane naukowe nie kończą się na dtype i shape

Deskryptor pola powinien jednoznacznie podawać: wielkość i jednostkę, tensor rank, osie, układ współrzędnych, support, lokalizację danych (cell/node/facet/quadrature), przestrzeń/bazę, dof layout, topology identity, maski aktywności, konwencję danych zespolonych oraz normalization/gauge tam, gdzie potrzebne.

Istniejący `TensorDescriptor` już opisuje typ, shape, osie i chunki, a `FieldRole` oddziela m.in. primary i preview. Rozwijamy tę warstwę, nie zastępujemy jej tablicami JSON. [E08](05-dowody-i-adr.md)

Brak zasobu musi być rozróżniony: nigdy nie zarejestrowano; nie zapisano w tym runie; jeszcze nie policzono; nie dotyczy tej formulacji; chwilowo niepobrany; niedostępny na wybranej lane. Żaden z tych stanów nie oznacza fizycznego zera.

### 19.4 Akwizycja online a postprocessing

Monitor online jest częścią specyfikacji wykonania i może wpływać na zapis oraz koszt. Przekrój tworzony po obliczeniu jest operacją na istniejących danych. Można go obliczyć tylko wtedy, gdy zapisano odpowiednie pola lub wystarczający stan do jawnego przeliczenia.

Nie wolno rekonstruować widma z samej decymowanej animacji bez kontroli próbkowania. Wartości całkowe, energie, ładunek topologiczny i inne wskaźniki korzystają z ilościowo poprawnej reprezentacji, miar komórek/kwadratur i masek, nie z widocznych glyphów.

### 19.5 Wykresy i porównania

`PlotDefinition` określa dataset, typ rysunku, jednostki, skale, zakres, komponent, paletę i adnotacje. Zmiana wykresu nie unieważnia rozwiązania. Definicje wykresów i eksportów są przenośne i mogą być wykonywane headless przez ten sam evaluator.

Porównanie FDM/FEM ma wspólną definicję eksperymentu i jawny protokół obserwacji. Różnicowanie pól z różnych siatek wymaga projekcji do wspólnej reprezentacji wraz z informacją o błędzie/interpolacji. Nie prezentujemy zgodności ekranowej jako dowodu zgodności numerycznej.

### 19.6 Dane pomiarowe i raport badania

Dataset może mieć źródło symulacyjne albo zewnętrzne dane pomiarowe. Import zachowuje plik źródłowy, jednostki, osie, kalibrację i niepewność, gdy zostały podane. Porównanie z symulacją określa mapowanie parametrów i wielkości, a brak niepewności nie jest zastępowany wymyśloną wartością.

Dopasowanie, normalizacja pomiaru i wykres porównawczy są wersjonowanymi recepturami. Raport badania przypina definicję modelu, konfiguracje, konkretne solutions/datasets, metody przetwarzania i figury. Ponowne wygenerowanie raportu nie ma samoczynnie wybierać najnowszego runu ani innego zestawu danych.

## 20. Persystencja: rozwinąć `.fms`, nie dublować storage

`fullmag-session` staje się technicznym fundamentem repository projektów i wyników. Logiczne API `ProjectRepository` może początkowo być adapterem nad istniejącym `SessionStore`; późniejsze przenoszenie nazw jest wtórne wobec kontraktu danych. [E06–E08](05-dowody-i-adr.md)

### 20.1 Format i profile

Zachowujemy rozszerzenie `.fms`. Nowa wersja manifestu potrafi zapisać definicję projektu, modele, studies, biblioteki i katalog wyników. Istniejące pliki są importowane przez jawną migrację z raportem. Nie nadpisujemy oryginału nowym schematem bez możliwości zachowania wcześniejszej wersji.

Profile Compact/Solved/Resume/Archive pozostają czytelnymi politykami. Compact pozwala zapisać niekompletny projekt bez solvera; Resume zawiera stan wymagany do deklarowanej klasy odtworzenia, a nie tylko końcową magnetyzację. Open nie uruchamia automatycznie Python, remeshingu ani solvera.

### 20.2 Commit, autosave i recovery

Definicje zapisujemy transakcyjnie: nowa wersja, dziennik semantycznych zmian i atomowa aktualizacja korzenia. Binarne artefakty są niezmienne, a manifesty zawierają sumy kontrolne. Na lokalnym systemie plików wymagamy zweryfikowanego kontraktu zapisu/flush/rename; nie zakładamy automatycznie takich samych gwarancji na udziale sieciowym.

Autosave projektu nie czeka na checkpoint solvera. Recovery formularzy i recovery wykonania są oddzielnymi mechanizmami. Crash podczas zapisu nie może uszkodzić ostatniej zatwierdzonej wersji projektu.

### 20.3 Zarządzanie dużymi danymi

CAS usuwa duplikację danych, a katalog utrzymuje graf referencji: wersje projektów, rozwiązania, checkpointy, eksporty i aktywne leases. Garbage collection uwzględnia wszystkie te korzenie i politykę retencji. Nigdy nie traktuje zamknięcia okna ani starej rewizji draftu jako zgody na usunięcie wyników.

Dane zewnętrzne mają jawne statusy embedded/reference/missing i checksumę. Open może odtworzyć model z brakującym dużym datasetem, ale oznacza jego niedostępność. Operacja Package/Archive sprawdza kompletność zależności przed deklaracją przenośności.

### 20.4 Klasy odtwarzania

Zachowujemy `ExactResume`, `LogicalResume`, `InitialConditionImport`, `ConfigOnly`. Ta klasyfikacja już występuje w typach i jest właściwym fundamentem. Wybór wynika z pełnego kontraktu zgodności, nie z preferencji użytkownika. Sama zgodność `m` i seeda nie dowodzi exact resume między różnymi urządzeniami, wersjami i integratorami. [E07–E08](05-dowody-i-adr.md)

## 21. Python, skrypty i automatyzacja

Jeden Python API pozostaje równorzędnym sposobem pracy, nie tylko językiem eksportu z GUI. Obowiązują trzy jawne tryby:

**Model definition:** tworzenie i edycja parametrycznej definicji bez wykonania. Ma wierny roundtrip semantyczny w zakresie wspieranych cech.

**Batch study:** uruchamianie study na przypiętej definicji; identyczne kontrakty runów, artefaktów i wyników jak w UI.

**Interactive experiment:** jawne operacje na kontekście eksperymentu i zapis zdarzeń sterujących. Dotychczasowy flat DSL pozostaje wygodną fasadą kontekstu, ale nie może używać jednego współdzielonego globalnego świata dla kilku równoległych projektów.

### 21.1 Import dowolnego Pythona

Nie obiecujemy odwrócenia arbitralnego programu Python do pełnej historii edytowalnego modelu. Import rozróżnia:

- Wspierany deklaratywny zapis Fullmag: odtwarzamy definicję i tożsamości.
- Zaufany generator modelu: wykonujemy osobne zadanie generowania, zapisujemy źródła/środowisko i otrzymaną definicję; oryginalny kod pozostaje źródłem pochodzenia.
- Program z nieodwzorowalnymi efektami lub własną pętlą: zachowujemy tryb script-owned oraz jasno ograniczoną edycję projekcji, albo użytkownik tworzy odłączoną kopię modelu.

Otwarcie źródła nie oznacza zgody na wykonanie. Eksport deklaracji ma zachowywać semantykę i jednostki, a nie pierwotne formatowanie lub komentarze dowolnego programu. Oryginał jest osobnym assetem.

Automatyzacja korzysta z tych samych komend domenowych, nie z klikania DOM. Dzięki temu agent, CLI i notebook nie obchodzą preconditions i walidacji.

## 22. API, tożsamość i komunikacja

Zachowujemy istniejącą fasadę API, generowane typy i resource-first control plane. Rozwijamy kontrakty o zasoby jawnie identyfikowane projektem/runem. Przykładowe ścieżki docelowe są specyfikacją, nie obecnymi endpointami:

```text
/v2/projects/{project_id}/definition
/v2/projects/{project_id}/commands
/v2/projects/{project_id}/models/{model_id}
/v2/projects/{project_id}/studies/{study_id}
/v2/projects/{project_id}/runs
/v2/projects/{project_id}/runs/{run_id}/tasks
/v2/projects/{project_id}/solutions/{solution_id}
/v2/projects/{project_id}/datasets/{dataset_id}
/v2/projects/{project_id}/artifacts/{artifact_id}/manifest
```

Dodanie zasobów projektu jest rozszerzeniem wspólnego protokołu, nie budową drugiej aplikacji. Dotychczasowe `simulation/commands` mogą przez okres migracji delegować do tego samego koordynatora. Nie utrzymujemy dwóch niezależnych kolejek wykonujących ten sam intent.

`/sessions/current` pozostaje wyłącznie ograniczonym adapterem zgodności. Nowy kod nie może używać go jako tożsamości datasetu ani wejścia zadania. Adapter wiąże kontekst w momencie przyjęcia polecenia i odrzuca niejednoznaczność. Nie może ponownie odczytać globalnego „current” po długim oczekiwaniu i wysłać wyniku do innego projektu.

### 22.1 Komendy definicji i komendy wykonania

Komenda definicji jest atomowa i może uczestniczyć w Undo/Redo. Komenda uruchomienia jest trwałym, idempotentnym żądaniem pracy. Anulowanie wykonania nie jest Undo modelu. Undo edycji nie cofa czasu symulacji ani nie usuwa opublikowanego runu.

### 22.2 Transport danych

JSON przenosi metadane, manifesty, błędy i małe projekcje. Pola/topologia korzystają z binarnego data plane z obsługą częściowego pobierania i wersjonowania. GET nie inicjuje solvera ani meshingu.

WebSocket przekazuje zdarzenia i unieważnienia w określonym scope. Cursor/revision służą wykrywaniu luk; po reconnect klient uzgadnia snapshot i brakujące zmiany. Stan połączenia nie jest stanem wykonania. Event o nowym polu nie uprawnia do odrzucenia niezwiązanego dokumentu.

### 22.3 Capabilities i availability

Oddzielamy: semantycznie znane, zaimplementowane, zakwalifikowane, dostępne na tym targetcie, materializowane i renderowalne. Backend publikuje uporządkowane powody oraz targety naprawy. UI nie odgaduje braku capabilities z `404` lub stringa w logu.

Preflight jest dwustopniowy: bez kosztownych zasobów sprawdza intencję; po przygotowaniu sprawdza realną dyskretyzację i implementację. Runtime ponownie weryfikuje wymagane preconditions. Wynik pozytywnego preflightu nie jest wieczystym pozwoleniem po zmianie wejścia.

## 23. UI jako środowisko pracy, a nie formularz runtime’u

### 23.1 Układ podstawowy

```text
Menu projektu + pasek dokumentów + jawny aktywny kontekst
┌─────────────────────┬─────────────────────────┬──────────────────────┐
│ Model Builder       │ Wspólny obszar pracy    │ Settings/Inspector   │
│ Definitions         │ Geometry / Mesh        │ właściwości węzła    │
│ Components/Physics  │ Field / Plot / Table   │ units / validation   │
│ Discretizations     │                       │ Apply / Undo         │
│ Studies/Solvers     │ Jeden system viewportu │                      │
│ Results             │ primitives/FDM/FEM     │                      │
├─────────────────────┴─────────────────────────┴──────────────────────┤
│ Operations | Problems | Log | Data / Results browser                │
└────────────────────────────────────────────────────────────────────┘
Status: projekt, zapis, obliczenia, target, połączenie — osobne informacje
```

Karty/perspektywy Modeling, Discretization, Studies i Results zmieniają organizację pracy, a nie model danych. Nie tworzymy osobnego UI FDM i osobnego UI FEM.

### 23.2 Model Builder

Przykładowe drzewo produktu:

```text
Project: Spin-wave device
├─ Definitions
│  ├─ Parameters / Functions / Data files
│  └─ Material library references
├─ Model: Device
│  ├─ Component: Magnetic stack
│  │  ├─ Coordinate systems
│  │  ├─ Geometry sequence
│  │  ├─ Selections / Regions / Interfaces
│  │  ├─ Material assignments
│  │  ├─ Micromagnetics / Sources / Constraints
│  │  └─ Initial states and textures
│  ├─ Component: Electrode / Mechanics (gdy użyte)
│  ├─ Couplings
│  └─ Discretizations: FDM reference, FEM swept, FEM refined
├─ Studies
│  ├─ Equilibrium
│  ├─ Dispersion
│  ├─ Driven response
│  └─ Backend comparison
├─ Solver configurations
└─ Results
   ├─ Solution sets and runs
   ├─ Datasets and derived values
   └─ Plot groups / Tables / Export recipes
```

Materiały, źródła i więzy mają spójną prezentację zakresu. Można obejrzeć efektywne ustawienia study oraz różnice względem modelu bazowego. Geometry node pokazuje geometrię; kliknięcie study nie uruchamia solvera.

### 23.3 Kontekst wyboru i widoku

Kernel zarządza strukturą `WorkspaceContext`: project, model, study, selected entity, observed run, dataset, view. Nie przechowuje jednego globalnego „selected quantity” dla wszystkich dokumentów. Komenda z menu, ribbonu, skrótu i automatyzacji rozstrzyga ten sam jawny kontekst.

Zachowujemy jeden wspólny `Viewport3D` dla primitives/FDM/FEM z adapterami domenowymi. Podstawowy workspace ma jeden aktywny viewport. Porównania korzystają z kart, warstw i wspólnego systemu ViewDocument; ewentualne zestawienie kilku okien korzysta z tej samej implementacji i globalnego budżetu zasobów, a nie z nowych rendererów dedykowanych backendom.

Przełączenie projektu przez użytkownika może świadomie zwolnić zasoby poprzedniego widoku. Telemetria, błąd solvera i reconnect nie mogą odmontowywać całej powłoki.

### 23.4 Edycja i Undo/Redo

Inspektor ma lokalny draft właściwości. Apply tworzy pojedynczą semantyczną transakcję, walidowaną w backendzie. Przeciąganie gizma ma podgląd i scalony commit na końcu, nie tysiące przebudów meshu. Dragging tekstury i geometry transform nie są tym samym poleceniem.

Undo/Redo działa w zakresie projektu na komendach edycyjnych. Zmiany selekcji i kamery nie zaśmiecają historii modelowania. Automatyczny podgląd jest odraczany/anulowalny; przyjmuje wynik tylko dla aktualnego tokena draftu.

Operacja, która resetuje stan lub usuwa dane, wymaga wyraźnego opisu skutku. Zwykłe Compute nie wymaga za każdym razem pełnoekranowego potwierdzenia tylko dlatego, że trwa długo. Potwierdzenia służą decyzjom, nie obserwacji postępu.

### 23.5 Dostępność i diagnostyka

Nie ukrywamy bez wyjaśnienia istotnych kontrolek. Niedostępna funkcja ma powód i wskazanie właściwego miejsca naprawy. Brak GPU blokuje konkretny Compute, nie zapis i analizę istniejących wyników.

Problems wiąże błąd z project/model/node/property oraz run/task/attempt, gdy dotyczy wykonania. Może otworzyć np. konkretną selekcję, konfigurację solvera lub politykę meshu. Długi log jest uzupełnieniem, nie głównym interfejsem komunikacji błędów.

Błąd meshu nie zabiera użytkownikowi ustawień meshu. Niekompletny model nie jest błędem startu. Brak sesji obliczeniowej jest normalnym stanem aplikacji.

## 24. Wielodokumentowość, wersje i współpraca

Projekt i otwarty workspace to odrębne zasoby. Użytkownik może mieć kilka projektów w kartach i uruchomić zadanie w jednym, po czym pracować w drugim. Wszystkie cache, requesty, wybory i opóźnione odpowiedzi mają jawny namespace projektu i dokumentu.

W pierwszej implementacji persystencja lokalna może mieć jednego autorytatywnego writera na projekt. Drugi proces otwiera projekt read-only albo korzysta z tej samej usługi transakcyjnej. Nie dopuszczamy dwóch niekoordynowanych zapisów do tego samego katalogu.

Współedycja zespołowa nie wymaga natychmiast CRDT ani automatycznego scalania geometrii. Backend sprawdza expected revision; konflikt pokazuje diff i wymaga rozstrzygnięcia. Historia wersji i przypięte wyniki działają niezależnie od bardziej zaawansowanej współpracy.

Model Manager klasy enterprise, uprawnienia wielu organizacji i edycja w czasie rzeczywistym są rozszerzeniami produktu. Nie są warunkiem pierwszej lokalnej wersji CAE, ale projekt nie może opierać się na jednym globalnym mutable singletonie, który czyni je niemożliwymi.

## 25. Rozszerzenia, bezpieczeństwo i dystrybucja

Każdy moduł fizyki/study/derived quantity ma deklarację: ID i wersję, schema konfiguracji, input/output contracts, dependencies, walidację, lowering, capabilities i dowody kwalifikacji. UI może używać metadanych do formularzy, lecz zaawansowane moduły dostają dedykowane inspektory; nie sprowadzamy całego programu do generatora pól JSON.

Custom expression nie oznacza dowolnego kodu na workerze. Custom solver lub physics plugin wymaga zaufania, kontroli wersji, testów i jawnej instalacji. Niewspierany moduł pozostaje zachowany w pliku jako nieznany asset/definicja, ale jego wykonanie jest blokowane.

Otwarcie `.fms` i import danych sprawdzają ścieżki, rozmiary rozpakowania, sumy kontrolne i obsługiwane schematy. Zasoby wskazane przez projekt nie dostają nieograniczonego dostępu do całego systemu plików. Skrypty są uruchamiane tylko jako jawnie zaufane zadania z limitem czasu, pamięci i kontrolą efektów.

Lokalny serwer ma ograniczony bind i uwierzytelnienie połączenia aplikacji. Dostęp zdalny wymaga osobnego, kontrolowanego wdrożenia z uwierzytelnianiem i szyfrowaniem. Nie traktujemy CORS jako granicy bezpieczeństwa.

Pakietowanie zachowuje istniejący desktop/web i Rust/Python/native architecture. Nowe funkcje muszą działać przy wersjonowanej zgodności klient–serwer–worker–IR, nie tylko na deweloperskim checkoutcie. Instalacja nie uruchamia ciężkiego meshingu, żeby pokazać pusty workspace.

## 26. Produkcyjne niezmienniki

Przyjmujemy poniższe reguły jako kryteria architektoniczne:

1. Open/Save/inspect definition nie wymaga solvera i nie zleca ukrytego Compute.
2. Dokument może być niekompletny i nadal dać się trwale zapisać.
3. Dane wykonywanego zadania nie są odczytywane z mutowalnego „current model”.
4. Study, konfiguracja solvera i konkretne wykonanie mają odrębne tożsamości.
5. Stan succeeded zadania nie zastępuje kwalifikacji naukowej wyniku.
6. Publikacja wymaga aktualnego właściciela i zgodnych input/output contracts.
7. Field, topology, przestrzeń funkcji i scope są sprawdzane łącznie.
8. Brak danych nie jest zerem; preview nie jest pełnym wynikiem ilościowym.
9. Forced GPU nie przechodzi po cichu na CPU; executed receipt potwierdza realizację.
10. Reconnect nie zmienia dokumentu ani wyniku; uzgadnia stan obserwacji.
11. Undo modelu nie anuluje obliczenia i nie usuwa wyniku.
12. Python, GUI i headless używają tej samej semantyki i walidacji.
13. Jedna implementacja viewportu obsługuje primitives/FDM/FEM, bez drugiego drzewa produktu.
14. Wersjonowanie formatu zachowuje źródła i umożliwia kontrolowaną migrację.
15. Cache reuse jest udowodnione kontraktem zależności i wersji, nie kolejnością zdarzeń.
16. Bezpieczna edycja podczas obliczeń wymaga izolacji runtime’u, nie tylko ukrycia modalu.

## 27. Kompletny scenariusz referencyjny

Użytkownik tworzy projekt bez wskazywania solvera. Dodaje parametry geometrii, warstwę magnetyczną i regiony. Przypisuje materiał, oddziaływania, teksturę i warunki. Zapisuje projekt — bez meshu i runtime’u.

Tworzy dwie receptury dyskretyzacji: FDM i FEM. Dodaje study Equilibrium oraz zależne studies Eigenmodes i Driven Response. Ich wejścia wskazują wynik równowagi konkretnego study, a nie to, co akurat widać w viewportcie. Konfiguracje CPU/GPU wybiera osobno i ogląda rozstrzygnięty plan.

Compute tworzy run. Planner wykonuje brakujące kroki i wykorzystuje zgodne artefakty. Mesh error zatrzymuje właściwy task i oznacza zależne kroki jako blocked, lecz użytkownik nadal edytuje projekt. Po poprawce uruchamia nowy run; poprzedni pozostaje w historii.

Podczas obliczeń otwiera wcześniejszą dyspersję. Jej geometria, pole i k pochodzą z jej własnego SolutionSet. Modyfikuje grubość przyszłego wariantu — aktywny run nie zmienia wejścia. Tworzy porównanie dwóch realizacji przez wspólny dataset obserwacyjny, nie przez odejmowanie niezgodnych tablic.

Po zamknięciu i ponownym otwarciu pliku widzi model, studies, wykresy i zapisane rozwiązania. Solver nie startuje automatycznie. Może uruchomić nową analizę, wznowić kompatybilny checkpoint albo zaimportować stan jako warunek początkowy. Program wyraźnie odróżnia te operacje.

To jest docelowy test sensowności architektury. Sam brak modalu nie realizuje tego scenariusza.

## 28. Zakres pewności i warunki przyjęcia

Dokument opiera się na ponownym odczycie wybranych plików głównych kontraktów oraz poprzednim audycie startupu. Nie jest twierdzeniem, że przeczytano i wykonano cały Fullmag. Nie uruchomiono aplikacji, testów ani symulacji. Opisane nowe encje, endpointy, zachowania i migracje są propozycją.

Decyzje domenowe są tutaj rozstrzygnięte: projektowy korzeń, jedna semantyka, osobne studies/configurations/runs, niezmienne artefakty i wspólne UI. Szczegóły wymagające eksperymentu inżynierskiego — gwarancje konkretnego storage, zakres CAD, migracja nieodwzorowalnych skryptów, rzeczywiste limity pamięci, resume między lane’ami — mają jawne bramy w planie migracji. Nie wypełniamy tych luk fikcyjną pewnością.

**Za wdrożenie nowej architektury uznajemy przejście scenariuszy produktu i kwalifikacji naukowej, a nie utworzenie klas o nowych nazwach.**
