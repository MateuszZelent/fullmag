# Fig.3: kontrola osi, skali i całkowania przy rezonansie — 04.11.2026

Raport historyczny z 04.11.2026; podane liczniki i oczekujące decyzje opisują
wyłącznie tamtą chwilę. Aktualny stan: [plan wykonania](2026-10-11-antenna-transport-e2e-implementation.md).

**Rozbieżność pozostaje nierozstrzygnięta, ale nie można jej usunąć jednym
przesunięciem lub jednym wspólnym przeskalowaniem częstotliwości.** Dodatkowe
kontrole nie znalazły błędu całkowania w badanych ekstremach. Nie dopasowano
parametrów, nie zmieniono równań i nie uruchomiono nowego solvera.

## Odczyt źródła i osi

Ponownie obejrzano oryginalny osadzony PNG Fig.3, nie własną reprodukcję.
Oś6–9GHz na pikselach92–534 jest zgodna z podpisami. Zachowany odczyt rastra
daje FMR7,2081GHz i dodatnie maksimum S/alfa0,01 przy7,3405GHz. TableI w PDF
APS i źródłowy main.tex arXiv v1 podają pole efektywne0,25T oraz gamma/(2pi)
30GHz/T, skąd model przy k=0 daje7,50GHz. Nie zamieniono pola efektywnego
na pole przyłożone; dodatek A jawnie rozróżnia te wielkości.

Źródła: [wersja APS](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203),
[arXiv v1](https://arxiv.org/html/2001.11483v1), lokalny przypięty PDF i TAR.
Hashe pozostają identyczne z wcześniejszym raportem porównania Fig.3.
To odczyt grafiki, nie tabela surowych danych autorów. Pitch6,79MHz/piksel
nie jest pełnym oszacowaniem błędu digitizacji.

## Dlaczego jedna korekta osi nie wystarczy

| Wielkość | Raster publikacji | Literalny model Eq1–3/9–10 |
|---|---:|---:|
| FMR | 7,2081GHz | 7,5000GHz |
| Dodatnie maksimum S, alfa0,01 | 7,3405GHz | 7,8000GHz |
| Maksimum minus własne FMR | 0,13235GHz | 0,30000GHz |
| (Maksimum minus FMR)/FMR | 0,0183616 | 0,0400000 |

Po odjęciu własnego FMR pozostaje różnica położenia maksimum0,167647GHz.
Nie stosowano takiego przesunięcia do danych; to test hipotezy. Iloraz w
ostatnim wierszu jest bezwymiarowy i nie zmienia się przy jednym wspólnym
mnożniku wszystkich częstotliwości. Dlatego sama zmiana wspólnej skali lub
konsekwentnego współczynnika gamma nie uzgodni obu odczytanych punktów.
Nie wyklucza to mieszanego błędu konwencji lub innego zestawu parametrów.
Nie wybrano z tego rozumowania nowego pola, gamma, grubości lub odległości.
Pełna arytmetyka i piny: `sushruth-figure3-frequency-origin-audit-20261104.json`.

## Niezależna kontrola przy obu ekstremach

Istniejący test
`scripts/test_reference_sushruth_2020_response.py::SushruthResponseReferenceTests::test_independent_signed_quadrature_and_convergence`
rozszerzono z częstotliwości7,5/9/12GHz o7,605 i7,8GHz. Nie zmieniono
`scripts/reference_sushruth_2020_response.py::film_susceptibility` ani
`inductive_response`; ich hash pozostaje536c053c4ea67deca0e44c86b0ae0e3500f14e03263bb4184a47ac94543aa093.

Przeszedł jeden interpretowany test z60 przypadkami częstotliwość/antena/alfa,
w tym24 nowymi przypadkami i48 nowymi zespolonymi porównaniami R/T.
Każdy przypadek bada cztery konfiguracje Simpson/cutoff względem niezależnej
adaptacyjnej całki signed-q w jednostkach cykli/s. Zbiór obejmuje S/GS/GSG
oraz alfa0,01/0,03/0,07/0,1. Nie kompilowano testów Rust lub aplikacji.

Wszystkie zachowały wcześniejszy próg2e−6+2e−5|reference| oraz próg estymatora
QUADPACK1e−7. Największy błąd nowych przypadków po wszystkich czterech siatkach
wyniósł4,12765e−6; największa zmiana siatki/odcięcia3,86965e−6, estymator
1,18841e−8. Są to bezwzględne różnice bezwymiarowych R/T, nie błędy względem
publikacji. Dla samego domyślnego Simpson i alfa0,01 osobna kontrola12 R/T
przy obu ekstremach dała maksimum2,57997e−7.

To wyklucza błąd kwadratury o obserwowanej skali jako przyczynę przesunięcia
w sprawdzonych punktach, nie dowodzi poprawności każdego możliwego zestawu
parametrów. Nie są to dziewięć kontroli pola H pełnego obwodu GSG.
Dokładne progi, wyniki i logi pozostały w control volume:
`verification/sushruth-figure3-resonance-audit-20261104/`.

## Dalsze rozróżnienia i źródła danych

Przestrzenny znak fazy nie zmienia wyniku tej parzystej całki cosinusowej;
sprzężenie konwencji czasowej nie zmienia części rzeczywistej. Istniejące
testy reciprocity/conjugation zachowano, ale w tym kroku nie wykonywano ich
ponownie. Dowody A8 oraz dokładnego tłumionego bieguna są we wcześniejszym
raporcie i nie tłumaczą znalezionej różnicy. Nie dodano obrotu fazy do Fig.3.

Ograniczone wyszukiwanie po tytule i DOI nie ujawniło dodatkowego kodu lub
surowej tabeli autorów. Publiczna historia arXiv udostępnia v1; zachowany TAR
zawiera obrazy i TeX, nie skrypt generujący krzywe. HAL hal-03034420 odmówił
odczytu; nie obchodzono tej blokady. Nie jest to dowód braku innych danych.
Nie kontaktowano się z autorami.

## Następny krok i granica wniosku

Nadal potrzebne są parametry i konwencja faktycznie użyte do spornej Fig.3
albo silniejszy niezależny dowód, który rozstrzygnie niezgodność. Nie oznaczono
pracy jako błędnej i nie dopasowano modelu do rastra. Równolegle pełny zakres
E0–E12 pozostaje aktywny; rzeczywiste GSG wymaga kwalifikacji V/J/H,
projekcji i odpowiedzi magnetycznej. Kontrolne Run k=0 pozostają ważne w
swoim zakresie, ale nie zastępują propagacji fal spinowych lub transmisji.
