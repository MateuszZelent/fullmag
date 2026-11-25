# Sushruth2020: porównanie Fig.3 z niezależnym wzorcem — 04.11.2026

Raport historyczny z 04.11.2026; podane liczniki i oczekujące decyzje opisują
wyłącznie tamtą chwilę. Aktualny stan: [plan wykonania](2026-10-11-antenna-transport-e2e-implementation.md).

**Fig.3 nie jest jeszcze odtworzona ilościowo.** Nowe zestawienie pokazuje
rzeczywistą rozbieżność położenia sygnału. Dotyczy niezależnego modelu równań,
nie wykonanego solvera Fullmaga. Nowe V/J/H pozostają0/3, kontrole pełnego H0/9.

## Dostępne ilustracje i dane

W katalogu artefaktów zadania:

- `sushruth-figure3-comparison.png`: oryginalny rysunek obok wzorca.
- `sushruth-figure3-equation-reference-dense.png` i `.svg`:12 krzywych,601 rzeczywiście obliczonych częstotliwości6–9GHz w widoku.
- `sushruth-published-043203.pdf`: publiczna wersja APS,11 stron.
- `sushruth-published-figure3.png`: osadzony oryginalny obraz Fig.3.
- `sushruth-figure3-reference-dense.json`: pełne Re/Im R/T i metadane.
- `sushruth-figure3-anchor-comparison.json`: przybliżony odczyt położeń z rastra.

Źródło ilustracji publikacji: M.Sushruth iin., Electrical spectroscopy of forward
volume spin waves in perpendicularly magnetized materials, Phys.Rev.Research2,
043203(2020), [DOI](https://doi.org/10.1103/PhysRevResearch.2.043203), CC BY4.0.
Nie wykonywano aktywnej zawartości PDF. Oryginalny obraz i dane zachowano.

## Co dokładnie porównano

Istniejący `reference_sushruth_2020_response.py::inductive_response` oblicza
przybliżone równania1–3 i9–10: liniową odpowiedź cienkiej warstwy i anten
S/GS/GSG. Używa literalnych parametrów TableI oraz podpisu Fig.3:
mu0H_eff0,25T, mu0Ms0,89T, gamma_B/(2pi)30GHz/T, t20nm,
L200nm, g250nm, s30nm, r2µm i alfa0,01/0,03/0,07/0,1.
Pełne równania, SI, walidacja i ograniczenia pozostają w nocie0951.

Nie tworzono nowego modelu zamiast istniejącego. Hashe kernela odpowiedzi,
antenna_spectra i jego dotychczasowych testów pozostały zgodne z wcześniejszym
receipt wykonania. Nie dopasowano materiału, amplitudy lub częstotliwości.
Użyto wyłącznie mnożników prezentacji zapisanych na Fig.3. Osie amplitud
publikacji są arbitralne; nie ustalono wspólnej kalibracji amplitudy i nie
podano jej procentowego błędu względem wykresu.

## Wynik odczytu położenia

| Punkt | Przybliżony odczyt publikacji | Wzorzec | Model−rysunek |
|---|---:|---:|---:|
| Znacznik FMR | 7,208GHz | 7,500GHz | 0,292GHz |
| Dodatnie maksimum S, alfa0,01 | 7,340GHz | 7,800GHz | 0,460GHz |
| Ujemne minimum S, alfa0,01 | 7,208GHz | 7,605GHz | 0,397GHz |

Źródłowy raster ma1015×1524px. Kalibracja pierwszego panelu:6–9GHz na
pikselach92–534, czyli6,79MHz/piksel. Odczyt dotyczy koloru linii i znacznika;
nie jest surową tabelą autorów. W raporcie JSON zapisano grubość kreski
w zakresie częstotliwości. Nie jest to ścisły bound całego błędu digitizacji.
Siatka własnego wzorca ma krok5MHz w pokazanym paśmie.

Różnice są wyraźnie większe od pojedynczego piksela. **Przyczyna pozostaje
nierozstrzygnięta.** Nie wykazano jeszcze, czy wynika z parametrów faktycznie
użytych przy rysunku, konwencji lub interpretacji modelu, czy innego błędu.
Nie ogłoszono błędu publikacji ani nie przesunięto osi, aby uzyskać podobny obraz.
Sprawdzono wizualnie zapis równań9–10 w PDF; nie znaleziono prostego brakującego
minusa, który sam rozwiązywałby różnicę. Przed uznaniem reprodukcji trzeba
rozstrzygnąć definicję i parametry generujące krzywe, zachowując jawne warianty.

## Kontrole wykonane w tym kroku

Zachowany wcześniejszy JSON miał12 przebiegów po141 częstotliwości7–14GHz.
Dołożono20 punktów6–6,95GHz przez istniejącą funkcję, zachowując normalizator
oraz wszystkie stare wartości. Następnie dołożono540 częstotliwości, aby
widok6–9GHz miał601 próbek. Cały nowy plik ma701 częstotliwości, włącznie
ze starymi punktami powyżej9GHz. Nie interpolowano wartości.

Niezależna kwadratura sprawdziła6/6,5/7GHz dla trzech anten i czterech alfa,
osobno zespolone R i T:72 porównania. Wszystkie przeszły wcześniej zapisane
progi2e-6+2e-5|z_ref|, normalizatora2e-6 i błędu QUADPACK<1e-7 dla całki
nieunormowanej. Maksymalna różnica zespolona wyniosła2,2945142468626835e-8.
To kontrola matematyki tego modelu, nie wszystkich nowych częstotliwości i nie
potwierdzenie krzywych autorów. Domyślne kwadratura/krok/odcięcie i kernel
pozostały bez zmian. Nie są to9 kontroli zachowanego prądu pełnej anteny.

Nowe całkowanie działało w istniejącym backendzie naszej grupy Docker.
Każdy proces miał limit2GiB i120s. Rozszerzenie trwało2,233s, peak81,23MB;
zagęszczenie3,342s, peak38,09MB. Rysowanie z gotowych danych wykonano gotowym
Matplotlib3.11.1 w WSL, na D:, bez budowania/testowania aplikacji i bez
instalowania zależności. Obliczeń natywnych, nowego H-only lub LLG nie było.

Focused validator noty0951 i source-map przeszedł po dodaniu obu funkcji
do tabeli indeksu kodu. Pierwszą odmowę walidatora zachowano. PNG i oryginalny
rysunek obejrzano; bez przyciętych podpisów lub nakładania osi. SVG jest
wektorowym eksportem własnych krzywych, źródłowy rysunek pozostaje rastrem.

## Znaczenie dla dalszej pracy

Kwalifikacja V/J/H i zbieżności pełnego GSG pozostaje potrzebna; ta kontrola
jej nie zastępuje ani nie zmienia przypiętych wejść. Zgoda na patch metadanych
capture8→12MiB nadal oczekuje; patch4581df0a… nie został zastosowany,
a jeden zatwierdzony build nie został zużyty. Powód pytania: przekazany
AGENTS.md§8, zmiana istniejącej granicy. Nie ponowiono pytania.

Równolegle referencja publikacji ma teraz konkretny otwarty problem:
nie można traktować samego przejścia testów kwadratury jako dowodu odtworzenia
Fig.3. Potrzebne jest rozstrzygnięcie tej rozbieżności przed końcowym
porównaniem odpowiedzi magnetycznej Fullmaga. Zakres E0–E12 pozostaje pełny.

## Piny i odtwarzanie

- PDF APS: `9e2249ec39543ae7e16dd1af43ad1756a7b4f704a62fd9b2e5972334e2e3ca1f`.
- Obraz źródłowy: `92aeb043aa5329cd73fc77fecc6eb110af760fe8b86a0f9b072cca2c83a7bf27`.
- Gęsty JSON: `3fa8dd8400f906870c9e794a88dbfda902c74616ab54328d73b031d9fa2751cd`.
- PNG wzorca: `95750c7a48732b33a6a545a9ff521cb67cd83cabd6e01ee8a132d16be2168ff2`.
- PNG zestawienia: `fc9eb99d7cd0edfb143c7109d9ab2f48d25bbe1e36f783ebeeb7fa89859a09b5`.
- `scripts/plot_sushruth_2020_response_reference.py`: `e30a5cd9352c6721d0c0896bee3bf5e60f7246d0802d7eb46c3f0edc3a869562`.

Renderer `plot_figure3_reference` przyjmuje przypięty JSON i nową ścieżkę PNG;
zwraca PNG, SVG i metadata. Odmawia nieznanego pliku i nadpisania.
`measure_figure3_anchors` przyjmuje oryginalny PNG oraz przypięty JSON.
To narzędzia raportowe, nie nowe API Python DSL lub ProblemIR.

Dowody nowych całek i kontroli: prywatny control volume,
`verification/sushruth-figure3-visual-comparison-20261104/`:
`extension-verification.json`, `dense-reference-verification.json`,
`scientific-doc-validator-final.json` i zachowane skrypty/JSON.
Najważniejsze receipty są również obok ilustracji w katalogu artefaktów zadania.
