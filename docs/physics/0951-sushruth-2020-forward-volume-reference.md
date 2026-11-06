# Fale forward-volume — niezależny wzorzec Sushruth 2020

**Reprodukcja publikacji: NOT VERIFIED.** Datowane rozdziały poniżej zachowują
stan w chwili kontroli; ich liczniki i decyzje nie opisują późniejszych prób.
Bieżący postęp kwalifikacji całej anteny znajduje się w
[planie wykonania](../superpowers/plans/2026-10-11-antenna-transport-e2e-implementation.md).

(problem-statement)=
## Problem fizyczny

Domena: liniowa odpowiedź cienkiej warstwy namagnesowanej prostopadle.
Wzorzec służy do późniejszego porównania anten i odpowiedzi Fullmaga
z [Sushruth i in., PR Research 2, 043203 (2020)](https://doi.org/10.1103/PhysRevResearch.2.043203).
Powiązany kontrakt aplikacji: [antena i baza pola](0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md).
Przyjmujemy równania 1–3 i 9–10 oraz Table I; nie dopasowujemy parametrów
do położenia krzywej na obrazie. Wzorzec nie rozwiązuje przewodnictwa 3D.

(governing-equations)=
## Równania i konwencje

Definiujemy $b_e=\mu_0 H_\mathrm{eff}$ i $b_M=\mu_0 M_s$ w teslach.
Appendix A definiuje $\gamma_0=\mu_0\gamma_B$; liczba 30 GHz/T w Table I
odpowiada tu $\gamma_B/(2\pi)$, nie współczynnikowi dla $H$ w A/m.
Daje to $f_\mathrm{FMR}=7.5$ GHz przy $b_e=0.25$ T.

```{math}
:label: eq-sushruth-film-reference

n(k)=1-\frac{1-e^{-|k|t}}{|k|t},\quad n(0)=0,\qquad
\omega_k^2=\gamma_B^2 b_e[b_e+n(k)b_M],
\quad \Delta\omega_k=\alpha\gamma_B[2b_e+n(k)b_M],
\qquad
\chi_{xx}(\omega,k)=
\frac{\gamma_B^2 b_M b_e}
{\omega_k^2-\omega^2+i\omega\Delta\omega_k}.

```

Jest to przybliżenie Eq1: pomijamy człon tłumienia w liczniku A8.
Konwencja czasowa to $e^{i\omega t}$. Dla dodatniej częstotliwości
część urojona $\chi_{xx}$ jest niedodatnia. Pole w Eq3 interpretujemy
jako efektywne, zgodnie z A7–A8; nie jako samo pole przyłożone.

```{math}
:label: eq-sushruth-inductive-reference

D=\int_{-\infty}^{\infty}|h(k)|^2\,dk,\qquad
\widetilde R=\frac{1}{D}\int_{-\infty}^{\infty}|h(k)|^2\chi_{xx}(\omega,k)\,dk,
\qquad
\widetilde T=\frac{1}{D}\int_{-\infty}^{\infty}|h(k)|^2
\chi_{xx}(\omega,k)e^{-ikr}\,dk.

```

Widma S/GS/GSG pochodzą z istniejącego wzorca równań 6–8.
Nie dokładamy wykładnika tłumienia propagacji: straty są już w podatności.
Dla identycznych anten integrand bez fazy jest parzysty w $k$, więc
część fazowa redukuje się do $\cos(kr)$ na dodatniej półosi.
Ta redukcja nie zmienia zespolonej podatności ani części urojonej wyniku.

(symbols-and-si-units)=
## Symbole i SI

| Symbol | Znaczenie | SI |
|---|---|---|
| $\omega$ | częstotliwość kołowa pobudzenia | $\mathrm{rad\,s^{-1}}$ |
| $\gamma_B$ | współczynnik żyromagnetyczny dla pól μ0H w teslach | $\mathrm{rad\,s^{-1}\,T^{-1}}$ |
| $b_e$ | μ0 H_eff, całkowite statyczne pole efektywne | $\mathrm T$ |
| $b_M$ | μ0 Ms | $\mathrm T$ |
| $\alpha$ | tłumienie Gilberta | $1$ |
| $k$ | podpisany wektor falowy | $\mathrm{rad\,m^{-1}}$ |
| $t$ | grubość warstwy magnetycznej | $\mathrm m$ |
| $n(k)$ | dynamiczny czynnik odmagnesowania | $1$ |
| $\omega_k$ | częstotliwość kołowa swobodnego modu | $\mathrm{rad\,s^{-1}}$ |
| $\Delta\omega_k$ | szerokość linii | $\mathrm{rad\,s^{-1}}$ |
| $\chi_{xx}$ | przybliżona podatność poprzeczna | $1$ |
| $h(k)$ | widmo źródła o arbitralnej wspólnej amplitudzie | $1$ |
| $r$ | podpisana odległość anten | $\mathrm m$ |
| $\widetilde R$ | unormowany wkład indukcyjny własny | $1$ |
| $\widetilde T$ | unormowany wkład indukcyjny wzajemny | $1$ |
| $D$ | normalizator widma | $\mathrm{m^{-1}}$ |
| $q$ | bezwymiarowa zmienna całkowania $q=\lvert k\rvert L$ | $1$ |
| $L$ | szerokość każdego paska, parametr width_m | $\mathrm m$ |

(assumptions-and-validity)=
## Założenia i zakres

Szeroka jednorodna warstwa, nieskończenie długie i cienkie paski,
jednorodne prądy, brak ekranowania przez prądy wirowe, pominięta wymiana,
liniowa odpowiedź i słabe tłumienie. To inny model niż nominalny przewodnik
Al o grubości 90 nm w przykładzie 3D. $\widetilde R$ i $\widetilde T$
opisują unormowany wkład spinowy do indukcyjności; nie są skalibrowanymi
parametrami S11/S21 całego toru RF.

(python-api)=
## Python wzorca i parametry

Przykład wykonuje się w backendzie właściwej grupy Docker, z katalogu
źródeł repozytorium; import nie uruchamia żadnego solvera.

```python
# %% Import niezależnego wzorca
import sys
sys.path.insert(0, "scripts")
from reference_sushruth_2020_response import inductive_response

# %% Odpowiedź GSG przy 9 GHz — surowe liczby zespolone
result = inductive_response([9e9], antenna="GSG", alpha=0.01)
assert result["reflection"].shape == (1,)
assert result["reflection"][0].imag < 0
```

Skrypt repozytoryjny nie jest publicznym DSL Fullmaga. Wszystkie parametry
liczbowe odrzucają bool i wartości nieskończone/NaN. Wspólne parametry
materiałowe funkcji film_susceptibility mają te same wartości, jednostki
i walidację co w inductive_response. Funkcja figure3_reference nie przyjmuje
argumentów: generuje 141 częstotliwości 7–14 GHz, co 50 MHz, dla S/GS/GSG
oraz $\alpha=0.01,0.03,0.07,0.1$. To nasza siatka częstotliwości, nie
zdigitalizowane punkty publikacji. Mnożniki prezentacji Fig3 zapisujemy
oddzielnie: S 1/10/30/60 i GS/GSG 1/30/300/600; surowe R/T ich nie zawierają.

| Python | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| inductive_response.frequencies_hz | Sequence[float] | wymagany | $\mathrm{Hz}$ | niepusta tablica 1D skończonych liczb | częstotliwości pobudzenia | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.antenna | str | GSG | $1$ | S, GS albo GSG | rodzaj identycznej pary anten | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.width_m | float | 200e-9 | $\mathrm m$ | skończony > 0 | szerokość każdego paska | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.gap_m | float | 250e-9 | $\mathrm m$ | skończony ≥ 0 | szczelina między paskami | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.spacing_m | float | 30e-9 | $\mathrm m$ | skończony ≥ 0 | odstęp pionowy modelu cienkiej anteny | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.distance_m | float | 2e-6 | $\mathrm m$ | skończony ze znakiem | odległość środków anten | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.alpha | float | 0.01 | $1$ | skończony > 0 | tłumienie Gilberta; przybliżenie słabego tłumienia | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.mu0_h_eff_t | float | 0.25 | $\mathrm T$ | skończony > 0 | μ0 razy całkowite statyczne pole efektywne | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.mu0_ms_t | float | 0.89 | $\mathrm T$ | skończony > 0 | μ0 razy magnetyzacja nasycenia | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.film_thickness_m | float | 20e-9 | $\mathrm m$ | skończony ≥ 0 | grubość warstwy; zero tylko jako granica matematyczna | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.gamma_hz_per_t | float | 30e9 | $\mathrm{Hz\,T^{-1}}$ | skończony > 0 | γ_B/(2π), bez dodatkowego μ0 | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.intervals | int | 16384 | $1$ | dokładny parzysty int ≥ 2, bez bool | liczba przedziałów Simpsona | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| inductive_response.max_kl | float | 80.0 | $1$ | skończony > 0 | górny limit $q=\lvert k\rvert L$ | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| film_susceptibility.k_rad_per_m | float lub ndarray | wymagany | $\mathrm{rad\,m^{-1}}$ | skończone liczby rzeczywiste | wektor falowy ze znakiem | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| film_susceptibility.frequency_hz | float | wymagany | $\mathrm{Hz}$ | skończona liczba rzeczywista | częstotliwość do obliczenia χ | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |

(problem-ir)=
## ProblemIR i runtime

Brak nowej klasy fizyki, pola ProblemIR, planera, endpointu ani runtime.
Wzorzec zapisuje JSON na stdout; orchestration przechowuje wynik techniczny
w wolumenie Docker. Każda próbka zachowuje częstotliwość, Re/Im oraz
normalizację. Metadane zawierają DOI, parametry, zakres całkowania,
konwencje i false dla Fullmag/BORIS solver execution oraz physics qualification.

(round-trip-and-failure-semantics)=
## Round-trip i odmowy

Requested intent to jawne parametry równań; resolved execution to niezależny
NumPy na CPU wewnątrz istniejącego backendu Docker. Nie jest to wybór backendu
symulacji. Validation errors obejmują niewłaściwe parametry, puste widmo,
nieparzystą liczbę przedziałów i zerowy/niefinitywny normalizator.
Unsupported combinations: zero damping z rzeczywistymi biegunami wymaga
rachunku dystrybucyjnego i jest odrzucane. Brak round-trip do DSL/ProblemIR,
ponieważ wynik jest referencją, nie autorskim modelem aplikacji.

(discrete-realization)=
## Realizacja numeryczna

Złożony Simpson na $q=|k|L$, z jawnym skończonym limitem i liczbą przedziałów.
Dodatni normalizator i obie całki korzystają z tej samej siatki.
Dla małego $|k|t$ rozwinięcie szeregu chroni obliczenie $n(k)$ przed utratą cyfr.
Parametry domyślne dotyczą Fig3: L200nm, g250nm, s30nm, r2µm, t20nm.
Przy s=0 ogon maleje wolniej; domyślne odcięcie nie otrzymuje kwalifikacji
dla tej innej sytuacji. Zmniejszenie alfa, wzrost r lub zmiana geometrii
wymaga ponownego sprawdzenia zbieżności.

### FEM CPU / FEM GPU / FDM CPU / FDM GPU

| Solver | Urządzenie | Status | Powód |
|---|---|---|---|
| FEM | CPU | not-applicable | Niezależny wzorzec równań publikacji, nie realizacja solvera Fullmaga. |
| FEM | GPU | not-applicable | Niezależny wzorzec równań publikacji, nie realizacja solvera Fullmaga. |
| FDM | CPU | not-applicable | Niezależny wzorzec równań publikacji, nie realizacja solvera Fullmaga. |
| FDM | GPU | not-applicable | Niezależny wzorzec równań publikacji, nie realizacja solvera Fullmaga. |

Każda z czterech realizacji Fullmaga: nie dotyczy wykonania wzorca.
Późniejsze porównanie wymaga osobnego rzeczywistego wykonania danej realizacji.
Wzorzec nie włącza żadnej nowej capability i nie zdejmuje blokad
inspection-only ani nie zakwalifikuje uciętego źródła GSG.

(implementation-mapping)=
## Mapa implementacji

Własność widma pozostaje w antenna_spectra; nowy skrypt dodaje tylko
podatność i całkę odpowiedzi. Pełna mapa path + symbol znajduje się na końcu.

(validation)=
## Prerejestracja kontroli

Przed obliczeniem wyników przyjmujemy próg błędu
$2\cdot10^{-6}+2\cdot10^{-5}|z_\mathrm{ref}|$ dla zespolonych R i T.
Niezależna kwadratura SciPy całkuje obie półosie z pełnym wykładnikiem,
dzieli przedział w zerze oraz przy rezonansie i kontroluje ostrzeżenia.
Punkty: f7.5/9/12GHz, wszystkie S/GS/GSG, wszystkie cztery alfa Fig3.
Sprawdzamy N8192/16384/32768 i osobno limit160 przy stałym kroku
względem limitu80/N16384. Próg nie jest dowodem a priori na ogon.

Granice: T(r=0)=R, T(-r)=T(r), sprzężenie przy zmianie znaku częstotliwości,
χ(0,0)=0.89/0.25 i χ(FMR,0)=-i·0.89/(2α·0.25).
Test jednostek niezależnie wyznacza FMR7.5GHz. Test z pełnym wykładnikiem
nie odróżnia jego znaku dla parzystego problemu; znak pozostaje jawną
konwencją równania 10. Prerejestracja powstała przed uruchomieniem testów.

### Wynik wykonanej weryfikacji

Sześć testów interpretowanych przeszło w istniejącym backendzie Docker:
NumPy 2.2.6, SciPy 1.15.3; czas zestawu 17.169 s. Wszystkie 36 kombinacji
anteny, alfa i częstotliwości przeszły ustalony próg dla obu całek na czterech
siatkach/odcięciach. Maksymalny błąd zespolony w całym zestawie wyniósł
$3.499\cdot10^{-5}$; obejmuje również najrzadszą siatkę N8192.
Największa zmiana po zagęszczeniu siatki lub zwiększeniu odcięcia wyniosła
$3.284\cdot10^{-5}$. Maksymalna oszacowana przez QUADPACK niepewność
nieunormowanej całki wyniosła $1.977\cdot10^{-8}$; nie jest to ścisły dowód
ograniczenia błędu. Kwadratura nie zgłosiła ostrzeżeń.

Zapisano 12 przebiegów po 141 częstotliwości, osobno Re/Im odbicia i transmisji.
Wynik wzorca nie jest wynikiem obliczeń Fullmaga ani BORIS. Dowody techniczne
w wolumenie kontrolnym grupy tego worktree:
`verification/sushruth-2020-reference/response-checks-corrected.json`,
`response-checks-corrected.stdout.log`, `response-checks-corrected.stderr.log`,
`figure3-response-reference.json` i `figure3-response-execution.json`.
Pierwszy test ujawnił błąd obsługi skalarnego k w NumPy; poprawiono bufor
wyjściowy dzielenia i ponownie wykonano cały zestaw bez zmiany tolerancji.

(limitations)=
## Ograniczenia i prace pozostałe

To wzorzec równań, nie numeryczne odtworzenie pełnego eksperymentu.
Nie kalibrujemy skali ani nie przesuwamy częstotliwości do obrazu wykresu.
Rzeczywiste J/H, zamknięcie obwodu, projekcja na warstwę, Run, odbiór
indukcyjny i porównanie BORIS pozostają niezależnymi bramkami E2–E9/E12.

(figure3-presentation-extension)=
## Kontrola prezentacji Fig.3 — plan rozszerzenia pasma 04.11.2026

Wersja wydawnicza Fig.3 ma oś6–9GHz. Zachowany niezależny wzorzec zaczyna
się przy7GHz, dlatego planujemy dodać20 częstotliwości6–6,95GHz co50MHz
przez istniejące `inductive_response`, z niezmienionymi parametrami TableI,
s=30nm i r=2µm. Wszystkie wcześniejsze141 próbek zostają zachowane.
Nie zmieniamy funkcji `figure3_reference`, równań, kwadratury lub formatu
wejściowego Fullmaga; dodatkowy plik jest tylko artefaktem porównania.

Przed wykonaniem dodatkowych liczb: niezależna pełna kwadratura podpisanego q
sprawdzi6/6,5/7GHz, S/GS/GSG i cztery alfa, obie części zespolonego R/T jako
pełny błąd modułu. Obowiązują istniejące progi2e-6+2e-5|z_ref|, względna
zgodność normalizatora2e-6 i oszacowanie QUADPACK poniżej1e-7 dla całki
nieunormowanej; ostrzeżenia nadal odmawiają. Nie jest to nowy profil H GSG
ani żadne z dziewięciu porównań pełnego źródła.

Wykres pokaże surowe Re(T) z wyłącznie mnożnikami prezentacji zapisanymi
w Fig.3. Nie wolno dopasować amplitudy, przesunąć częstotliwości ani
podstawić wzorca analitycznego za wykonanie LLG. FMR z TableI pozostaje
7,5GHz; nie zastępuje go wizualny odczyt znacznika FMR z opublikowanej osi.
Niezależna ilustracja nie otrzymuje statusu physics_qualified.

Źródła i wszystkie SI/parametry pozostają w powyższych tabelach. Mapowanie:
`scripts/reference_sushruth_2020_response.py::inductive_response` i
`scripts/test_reference_sushruth_2020_response.py::independent_integral`.
Dla FEM CPU, FEM GPU, FDM CPU i FDM GPU nadal jest to not-applicable
jako dowód wykonania solvera. Brak zmian DSL/ProblemIR/planner/runtime.

Po pierwszym renderze krok50MHz pozostawia widoczne odcinki łamanej. Dla
czytelności wykresu planujemy dołożyć rzeczywiście obliczone częstotliwości
co5MHz w6–9GHz, bez interpolacji, zmiany parametrów lub mnożników. Wszystkie
161 istniejących punktów pasma6–14GHz zostają zachowane dokładnie. To zmiana
siatki prezentacji, nie zmiana odcięcia q lub kroku kwadratury. Nie będzie
nowego claimu kwalifikacji; wcześniejsze kontrole niezależnej kwadratury i
ograniczenia ważności wzorca pozostają obowiązujące.


(figure3-rendering-and-anchor-audit)=
## Wynik rozszerzenia i porównania rysunku — 04.11.2026

Rozszerzenie pasma przeszło72 kontrole zespolonego R/T względem niezależnej
kwadratury dla36 kombinacji f/antenna/alfa. Maksymalna różnica zespolona
wyniosła2,2945142468626835e-8, w istniejącym progu z sekcji validation.
Zachowano także istniejące kontrole normalizatora i błędu QUADPACK.
To kontrole całek tego samego modelu, nie porównania nowego pola pełnej GSG.
Wszystkie141 oryginalnych próbek zachowano; po dołożeniu20 dolnych i540
częstotliwości pomiędzy próbkami plik ma701 punktów, w tym601 w6–9GHz.
Nie interpolowano wartości, nie zmieniono fizyki ani skali częstotliwości.

### Ilustracja i nierozstrzygnięta rozbieżność z publikacją

Wyrenderowano12 krzywych Re(T) z mnożnikami podanymi w Fig.3, bez dopasowania
amplitudy lub częstotliwości. Obejrzano PNG; SVG zachowuje edytowalne osie
i linie. Oryginalny rysunek został odczytany z publicznego PDF APS11 stron,
SHA2569e2249ec39543ae7e16dd1af43ad1756a7b4f704a62fd9b2e5972334e2e3ca1f.
Osadzony obraz Fig.3 ma1015×1524px; jego hash to
92aeb043aa5329cd73fc77fecc6eb110af760fe8b86a0f9b072cca2c83a7bf27.

Odczyt pierwszego panelu z tego rastra dał następujące **przybliżone położenia**.
Nie są to surowe dane autorów, eksperymentu ani nowy próg zaliczenia:

| Punkt porównania | Odczyt Fig.3 | Wzorzec TableI | Różnica model−rysunek |
|---|---:|---:|---:|
| Szary znacznik FMR | około7,208GHz | 7,500GHz | około0,292GHz |
| Dodatnie maksimum S, alfa0,01 | około7,340GHz | 7,800GHz | około0,460GHz |
| Ujemne minimum S, alfa0,01 | około7,208GHz | 7,605GHz | około0,397GHz |

Kalibracja osi obrazu:6–9GHz na pikselach92–534, czyli około6,79MHz/piksel.
Położenia maksimum/minimum odnoszą się do skrajnych rzędów niebieskiej linii,
nie do dopasowanego modelu; zapisano także zakres x obejmujący grubość kreski.
Rozdzielczość modelu wynosi5MHz. Zakres kreski i rozdzielczość nie obejmują
wszystkich możliwych błędów odczytu lub założeń wykresu. Amplitudy publikacji
są arbitralne; nie wyznaczono procentowego błędu amplitudy względem tych osi.

**Zgodność z Fig.3 nie jest wykazana.** Potwierdzono zgodność własnych dwóch
kwadratur i zachowanie literalnych parametrów TableI, lecz pozostaje
nierozstrzygnięte, dlaczego ich wynik nie pokrywa się z rysunkiem. Nie
przypisano winy implementacji ani publikacji bez dalszego dowodu. Nie zmieniono
pól, gamma, grubości, odległości lub definicji sygnału, aby dopasować krzywe.
Przed deklaracją odtworzenia rysunku trzeba rozstrzygnąć parametry i konwencje
faktycznie użyte do jego wygenerowania. Ta rozbieżność nie kwalifikuje ani
nie dyskwalifikuje wyniku3D Fullmaga, którego tu nie uruchamiano.

### Narzędzia prezentacji i wejścia

| Funkcja / parametr | Typ i domyślność | Walidacja / jednostki / skutek |
|---|---|---|
| `plot_figure3_reference.input_path` | Path/str, required | JSON o jednym z dwóch przypiętych hashy; tylko niezależny wzorzec z flagami solver/physics_qualified=false. Brak solvera i konwersji do IR. |
| `plot_figure3_reference.output_path` | Path/str, required | Nowa ścieżka PNG; odmawia nadpisania PNG/SVG/metadata. Generuje SVG i opis hasha oraz jednostek; wykres w GHz i bezwymiarowym Re(T). |
| `measure_figure3_anchors.published_png_path` | Path/str, required | Dokładny hash osadzonego obrazu1015×1524px z PDF; zakres panelu jest przypięty do tego obrazu. |
| `measure_figure3_anchors.reference_json_path` | Path/str, required | Jeden z tych samych przypiętych JSON; odczyt ekstremów S/alfa0,01, bez optymalizacji parametrów. |

Odczyt rastra używa RGB0–255: linia niebieska R/G<80 i B>180; szare piksele
mają kanał150–230 i rozrzut kanałów<6. Czarne ramki odnajdywane są przy
wartościach kanałów<80 w przypiętych oknach pierwszego panelu. Są to parametry
odczytu konkretnego obrazu, nie fizyczne stałe ani warunki dostępności quantity.
Narzędzia nie dodają Python DSL, ProblemIR, endpointów lub capabilities.

Nowe całkowanie referencji i kontrole wykonano w istniejącym backendzie grupy
Docker, z ograniczeniem2GiB i120s na proces. Render raportu wykonano gotowym
Matplotlib3.11.1 w WSL z odczytanych plików; to nie build/test aplikacji Fullmag.
Podgląd PDF odbył się przez Poppler, osadzony obraz odczytano pypdf, bez
wykonywania aktywnej zawartości. Nie pobierano nowych zależności i nie
zmieniono środowiska buildu. Dla czterech backendów nadal nie ma tu nowego
dowodu solvera. Nowe V/J/H0/3 i kontrole pełnego H0/9 pozostają otwarte.

Indeks źródeł: `scripts/plot_sushruth_2020_response_reference.py::plot_figure3_reference`
i `measure_figure3_anchors`; kernel odpowiedzi i niezależna całka pozostają
w istniejących źródłach wskazanych powyżej. Dowody dodatkowych obliczeń są
w prywatnym control volume, `verification/sushruth-figure3-visual-comparison-20261104`:
`extension-verification.json`, `dense-reference-verification.json`,
`figure3-response-extended.json`, `figure3-response-dense.json`.
Źródłowy PDF: [APS, Fig.3 i TableI](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203), CC BY4.0.


(sushruth-figure3e-raster-comparison)=
### Osobny odczyt Fig.3(e): GSG przy alfa0,01

<!-- DOC-ANCHOR:sushruth-figure3e-raster-comparison -->

`measure_figure3_anchors(..., panel="e")` porównuje czarną krzywą GSG z
odpowiadającym jej zachowanym przypadkiem GSG/alfa0,01. Domyślne `panel="a"`
zachowuje dotychczasowy wynik S/alfa0,01, łącznie z nazwami pól i sposobem
odczytu. Nie wolno przenosić odczytu7,208GHz z panelu(a) na panel(e).
Równania, jednostki i parametry TableI pozostają jak powyżej; nie wykonujemy
nowego całkowania, dopasowania ani przesunięcia częstotliwości. Wynik modelu
pochodzi z przypiętego JSON701 częstotliwości, w tym601 próbek w6–9GHz.

| Python | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| measure_figure3_anchors.panel | str | a | $1$ | wyłącznie a lub e, inaczej odmowa przed odczytem plików | wybór panelu obrazu, nie modelu fizycznego | niezależna diagnostyka rastra; bez backendu Fullmaga | nie serializuje się do IR |
| measure_figure3_e_pixels.image | ndarray uint8 | wymagany | $1$ | dokładnie1524×1015×3 kanały RGB; wymagane osie, krzywa i pojedyncza ciągła szara kreska | raster wyłącznie do czystego odczytu panelu(e); wrapper uwierzytelnia plik | niezależna diagnostyka rastra; bez backendu Fullmaga | nie serializuje się do IR |

Funkcja czysta `scripts/plot_sushruth_2020_response_reference.py::measure_figure3_e_pixels`
nie odczytuje plików ani modelu. Publiczny wrapper wymaga tego samego hasha
rastra92aeb043… i jednego z wcześniej przypiętych JSON; nie przyjmuje innych
rysunków pod tymi oknami. Oś panelu(e) ma zakres6–9GHz, pionowe ramki na
x=588 oraz1003. Ramki są wyszukiwane w pasach x575–604 i990–1014,
y44–369; ciemny pion musi pokrywać co najmniej90% wysokości pasa.
Czarna krzywa jest odczytywana we wnętrzu x591–1000,y47–366 przy wszystkich
kanałach RGB<80. Czerwona krzywa GS nie spełnia tego kryterium.

Poniższe granice są stałymi odczytu tego obrazu, zapisanymi przed przyjętym
pomiarem. Nie są parametrami fizyki ani filtrami dobieranymi do ekstremów.
Współrzędne `(x0,y0,x1,y1)` są globalnymi pikselami rastra, z prawą/dolną
granicą wyłączoną; piksel i kanał RGB mają jednostkę $1$.

| Wykluczona widoczna adnotacja | Granice `(x0,y0,x1,y1)` | Powód |
|---|---|---|
| Litera panelu `(e)` | (590,45,660,100) | Czarny napis przy lewym górnym rogu. |
| Napis alfa0,01 | (850,45,1002,110) | Czarna legenda nad krzywymi. |
| Wewnętrzny tick górnej osi przy x726 | (724,45,729,52) | Jego widoczne czarne piksele sięgają y50. |
| Wewnętrzny tick górnej osi przy x795 | (793,45,798,49) | Jego widoczne czarne piksele sięgają y47. |

Pozostałe górne ticki mieszczą się w dwóch maskach tekstu; dolna ramka jest
na y369, a widoczne dolne ticki wychodzą poza odczytywane wnętrze. Nie
usuwamy całego górnego/dolnego pasa amplitud. Pierwszy roboczy odczyt bez
masek ticków błędnie rozpoznał je jako maksimum. Niezależny fixture odtwarza
ten błąd i sprawdza przyczynową poprawkę; taki odczyt nie jest wynikiem krzywej.

Szara kreska ma kanał R>150 i R<230 oraz rozrzut RGB<6; wymagamy co najmniej90%
jej pionowego pokrycia w y47–366 i jednej ciągłej grupy kolumn w środkowych70%
osi. Zwracamy cały zakres kolumn i odpowiadający zakres częstotliwości,
bez pojedynczej dokładnej wartości „FMR”. Ekstrema czarnej krzywej są
przybliżonym środkiem kolumn w skrajnym rzędzie kreski, z podaniem jej
zakresu i pitchu osi7,2289MHz/piksel. Zakres kreski nie jest pełnym boundem
błędu digitizacji, oznaczenia FMR ani modelu fizycznego.

| Porównanie Fig.3(e) | Odczyt przypiętego rastra | Zachowany literalny model |
|---|---:|---:|
| Szara kreska oznaczona FMR | 7,13494–7,16386GHz, kolumny745–749 | 7,500GHz z TableI |
| Maksimum Re(T) GSG/alfa0,01 | około7,59759GHz; skrajny rząd ma jeden piksel x809 | 8,175GHz na siatce5MHz |
| Minimum Re(T) GSG/alfa0,01 | około7,71687GHz; zakres7,71325–7,72048GHz | 8,355GHz na siatce5MHz |

Dodatkowa diagnostyka odejmuje od maksimum jego własne oznaczenie FMR,
bez przesuwania jakiejkolwiek krzywej. Dla panelu(e) daje to przedział
0,433735–0,462651GHz wynikający wyłącznie z szerokości szarej kreski;
dla zachowanego modelu różnica wynosi0,675GHz. Pozostaje zatem
0,212349–0,241265GHz różnicy tych odstępów. Samo wspólne przesunięcie
początku osi nie uzgadnia tych odczytów; nie jest to pełny bound błędu
rastra ani dowód przyczyny rozbieżności. Nie dopasowano gamma lub pola.

To odczyt Fig.3(e), a nie surowe dane autorów ani nowe kryterium zaliczenia.
Różnice położeń ekstremów pozostają nierozstrzygnięte; nie porównujemy
amplitud arbitralnej osi publikacji z normalizacją własnego modelu.
Wyniki `fullmag_solver_executed`, `boris_solver_executed` i `physics_qualified`
są false; nie odblokowują LLG, bazy H/I ani kwalifikacji reprodukcji.
Dla FEM CPU/GPU i FDM CPU/GPU ten pomiar nadal jest not-applicable jako
dowód wykonania backendu. Nie zmienia DSL, ProblemIR, planner, quantity,
runtime ani provenance zachowanych wyników naukowych.

Dziesięć interpretowanych regresji niezależnego syntetycznego rastra
sprawdza ramkę, ticki, obie legendy, znane ekstrema i odmowy. Rzeczywisty
odczyt domyślnego panelu(a) przed/po zmianie jest identyczny bajtowo po tej
samej kanonicznej serializacji JSON; jawne `panel="a"` zwraca ten sam obiekt.
Nie uruchamiano nowych referencji pola ani solvera. Dowody odczytu i testów:
control volume grupy, `verification/sushruth-figure3e-raster-20261105/`.
Źródło obrazu pozostaje [wydawniczy PDF APS, Fig.3](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203),
CC BY4.0; jego hash i hash rastra podano powyżej.


(sushruth-a8-diagnostic)=
## Diagnostyka A8 względem równania1 — prerejestracja i wynik

Źródło: wydawniczy PDF, strona9, A5–A8. A8 zachowuje człon tłumienia
w liczniku, lecz w mianowniku nadal pomija wyrazy kwadratowe alfa.
Nie jest więc dokładnym odwróceniem A5. Domyślny wzorzec równania1,
jego kod i wcześniejsze dane pozostają bez zmian. Nowy dodatek jest
wyłącznie diagnostyką przyczyn różnicy Fig.3; nie udostępnia wariantu
solvera Fullmaga, publicznego DSL ani nowego pola ProblemIR.

```{math}
:label: eq-sushruth-a8-numerator-factor
 C(f)=1+i\frac{\alpha f}{\gamma_f b_e},\qquad
 \chi_{xx}^{A8}=C(f)\chi_{xx}^{(1)},\qquad
 \widetilde R_{A8}=C(f)\widetilde R_{(1)},\quad
 \widetilde T_{A8}=C(f)\widetilde T_{(1)}.
```

Czynnik jest niezależny od k, więc wychodzi przed całki9–10 z niezmienionym
normalizatorem. Nie jest dopasowaną fazą ani skalą. Sprawdzimy go na zapisanych
przebiegach, bez ponownej kwadratury. Dla k=0 dodatkowo porównamy dokładny
swobodny biegun liniowej macierzy A5 przy zachowanym członie alfa²:

```{math}
:label: eq-sushruth-a5-uniform-free-pole
 f_0=\gamma_f b_e,\qquad
 f_p=\frac{f_0(1+i\alpha)}{1+\alpha^2}.
```

Konwencja exp(+i omega t) oznacza dodatnią część urojoną stabilnego bieguna.
Jego część rzeczywista jest częstotliwością swobodnego tłumionego oscylatora,
nie maksimum Re(T), absorpcji ani automatycznie znacznikiem FMR z rysunku.
Nierozmyte f0 z relacji dyspersji nadal wynosi7,5GHz.

| Symbol | Znaczenie | SI |
|---|---|---|
| $C(f)$ | Dokładny stosunek liczników A8 i równania1. | $1$ |
| $f$ | Podpisana częstotliwość bodźca. | $\mathrm{Hz}$ |
| $\gamma_f$ | Współczynnik gamma_B/(2pi), domyślnie30GHz/T. | $\mathrm{Hz\,T^{-1}}$ |
| $b_e$ | Mu0 razy statyczne pole efektywne, domyślnie0,25T. | $\mathrm T$ |
| $\alpha$ | Nieujemne tłumienie w samej operacji algebraicznej. | $1$ |
| $\chi_{xx}^{A8},\chi_{xx}^{(1)}$ | Dwie jawnie odróżnione przybliżone podatności. | $1$ |
| $\widetilde R_{A8},\widetilde R_{(1)},\widetilde T_{A8},\widetilde T_{(1)}$ | Unormowane odpowiedzi dla obu liczników. | $1$ |
| $f_0,f_p$ | Częstotliwość bez tłumienia oraz zespolony swobodny biegun przy k=0. | $\mathrm{Hz}$ |

| Python | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| a8_numerator_factor.frequency_hz | float | wymagany | $\mathrm{Hz}$ | skończony bez bool; znak dowolny | podpisana częstotliwość bodźca | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| a8_numerator_factor.alpha | float | wymagany | $1$ | skończony nieujemny bez bool | tłumienie wyłącznie diagnostyki algebraicznej | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| a8_numerator_factor.mu0_h_eff_t | float | 0.25 | $\mathrm T$ | skończony >0 bez bool | μ0 razy statyczne pole efektywne | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| a8_numerator_factor.gamma_hz_per_t | float | 30e9 | $\mathrm{Hz\,T^{-1}}$ | skończony >0 bez bool | współczynnik gamma_B/(2pi) | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| uniform_free_pole_hz.alpha | float | wymagany | $1$ | skończony nieujemny bez bool | tłumienie wyłącznie diagnostyki algebraicznej | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| uniform_free_pole_hz.mu0_h_eff_t | float | 0.25 | $\mathrm T$ | skończony >0 bez bool | μ0 razy statyczne pole efektywne | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| uniform_free_pole_hz.gamma_hz_per_t | float | 30e9 | $\mathrm{Hz\,T^{-1}}$ | skończony >0 bez bool | współczynnik gamma_B/(2pi) | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |

Iloczyny i wyniki muszą pozostać dodatnie/skończone we właściwych miejscach;
przepełnienie odmawia. Zwracany C jest zespolony i bezwymiarowy; fp jest
zespolone w Hz. Diagnostyka alfa0 nie usuwa odmowy alfa0 w kwadraturze,
która nadal miałaby rzeczywiste bieguny. Nie stosujemy czynnika jako korekty
zaakceptowanej bazy lub danych zapisanych przez solver.

Plan weryfikacji: bezpośrednie A8 w jednostkach cykli/s kontra istniejące
Eq1 w rad/s razyC dla4 alfa,3 częstotliwości i4 k; sprzężenie częstotliwości,
C(0)=1, liniowość sumy, podstawienie fp do wyznacznika A5 i skalowanie jednostek.
Odczyt ekstremów zachowuje dotychczasową siatkę5MHz i zakres6–9GHz. Brak
nowego progu zgodności publikacji lub dopasowania; wynik może jedynie
wykluczyć/sprawdzić tę jedną hipotezę. Model pełnego źródła3D, DSl/ProblemIR,
planner, runtime, artefakty anteny i ich kwalifikacja pozostają bez zmian.
Wszystkie cztery backendy mają tu status not-applicable jako dowód solvera.

Indeks źródeł: `scripts/reference_sushruth_2020_a8_diagnostic.py::a8_numerator_factor`,
`uniform_free_pole_hz` i `scripts/test_sushruth_a8_diagnostic.py::SushruthA8DiagnosticTests`;
istniejące Eq1 pozostaje w `reference_sushruth_2020_response.py::film_susceptibility`.


### Wynik wykonanej diagnostyki A8/A5 — 04.11.2026

Siedem testów przeszło, bez skipów. Bezpośrednia postać A8 w cyklach/s
zgadza się z iloczynem równania1 w rad/s i C dla48 kombinacji; sprawdzono
także sprzężenie częstotliwości, granicę bez tłumienia, liniowość sumowania,
jednostki, odmowy i wyznacznik A5. To testy osobnej diagnostyki, bez zmiany
założeń lub bramek istniejącego całkowania.

Zachowany JSON701 częstotliwości i12 przebiegów został przetworzony
algebraicznie do osobnego pliku. Przy alfa0,01 i antenie S maksimum
Re(T) zmienia się z7,800 na7,805GHz, a minimum pozostaje przy7,605GHz
na siatce5MHz. Dodanie członu licznika nie wyjaśnia więc różnicy względem
przybliżonego odczytu Fig.3: maksimum około7,340GHz i minimum7,208GHz.
Nie przesunięto żadnego parametru lub osi, aby poprawić zgodność.

| Alfa | Re(fp) z dokładnego A5 przy k=0 | Przesunięcie względem f0=7,5GHz |
|---|---:|---:|
| 0,01 | 7,499250075GHz | −0,750MHz |
| 0,03 | 7,493256070GHz | −6,744MHz |
| 0,07 | 7,463429197GHz | −36,571MHz |
| 0,10 | 7,425742574GHz | −74,257MHz |

Swobodny tłumiony biegun nie jest maksimum Re(T). Przy najniższym alfa
jego przesunięcie nie wyjaśnia około292MHz między f0 a znacznikiem rysunku.
Wynik wyklucza tę konkretną prostą interpretację tłumienia; **nie rozstrzyga
przyczyny rozbieżności publikacji i nie dowodzi poprawności całego modelu**.

Odczyt i postprocessing wykonano w istniejącym backendzie grupy Docker,
czas0,0724s, peak RSS40,16MB, limit2GiB; bez nowej kwadratury. Kernel Eq1
pozostał bajtowo bez zmian. Nowe pełne V/J/H0/3, pełne kontrole H0/9,
nowy native build0/1; brak H-only, LLG, fitu i zmian historycznych wyników.
Dowody w control volume: `verification/sushruth-a8-diagnostic-20261104/`:
`green.json`, `green.log`, `retained-data-comparison.json` oraz
`a8-response-diagnostic.json`. Nowy JSON A8 SHA256:
`3ba7f5e27c29c50d58207f9da960eb4d4599c1922292401eb45f563f29540f01`.
To oddzielny wariant diagnostyczny; status naukowy i cztery backendy pozostają
niezakwalifikowane przez ten wynik.


### Kontrola źródeł autorów w arXiv

Odczytano także publiczne [źródła arXiv2001.11483v1](https://arxiv.org/src/2001.11483v1),
które strona autorów wiąże z tą samą publikacją. Archiwum zawiera7 rysunków
PNG, main.tex i main.bbl; nie zawiera skryptów obliczeniowych lub tabel
surowych danych. Nie uruchamiano TeX ani żadnego elementu archiwum.

Tabela w main.tex potwierdza0,25T,30GHz/T,0,89T i20nm; podpis Fig.3
potwierdza L200nm, g250nm, s30nm i r2µm. Nie znaleziono więc
alternatywnego jawnego zestawu parametrów, który rozstrzygałby różnicę.
Przy wierszu grubości znajduje się roboczy komentarz autorów o20 lub16,8nm;
nie jest to opublikowany parametr zastępczy i nie użyto go do dopasowania.
Oryginalny Fig03.png4952×7367px obejrzano; nie wykonano nowego ilościowego
odczytu tego rastra. Poprzednie liczby pozostają odczytem wydawniczego PDF.

Archiwum SHA256 `3f4a0b06f64182ad842437dc00738afad144c07a0840a0adebcaf8b9cb084b89`;
Fig03.png SHA256 `dc7a08ec34e42eeefc854437b64d9a3c071a2d59c68d3a012a23d470011329ba`.
To dowód sprawdzenia jednego konkretnego publicznego archiwum, nie dowód
nieistnienia kodu lub danych autorów w innych miejscach. Przyczyna różnicy
Fig.3 pozostaje otwarta; nie zadeklarowano błędu publikacji.


(sushruth-k0-runtime-control)=
## Kontrolna precesja k=0 w Fullmagu — prerejestracja

Przed nowym wykonaniem: osobny przypadek kontroluje jednostki, znak i
częstotliwość LLG dla parametrów modelu TableI. Nie używa pola anteny,
nie odblokowuje niezakwalifikowanej bazy i nie odtwarza skończonej próbki
Co/Ni. Jest to jednorodny stopień swobody w stałym polu efektywnym +z,
z wyłączonym demag, wymianą, anizotropią, temperaturą i torque transportowym.
Pole efektywne0,25T jest tu całym jawnym Zeemanem; nie dodajemy drugi raz
demag. Komórka20nm jest nośnikiem testu, nie pełną geometrią eksperymentu.

Właścicielem fizyki LLG pozostaje
[nota0960, §5.5](0960-canonical-llg-time-domain-solver-and-qualification-contract.md).
Wykorzystujemy istniejący `antenna_macrospin_oracle.py::macrospin_from_field_impulse`,
bez drugiego wzorca. Przy stałym polu jego rozwiązanie ma postać:

```{math}
:label: eq-sushruth-k0-runtime-control
 q=\frac{\gamma_H H_z\tau}{1+\alpha^2},\quad
 u=\operatorname{asinh}\!\left(\frac{m_{z0}}{m_{\perp0}}\right)+\alpha q,\quad
 \mathbf m(\tau)=\left(
 \frac{\cos(\phi_0+q)}{\cosh u},
 \frac{\sin(\phi_0+q)}{\cosh u},\tanh u\right).
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $\gamma_H$ | Dodatnia gamma dla H w A/m, równa mu0 razy2pi razy30GHz/T. | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $H_z$ | Całe stałe pole efektywne testu,0,25T podzielone przez mu0. | $\mathrm{A\,m^{-1}}$ |
| $\tau$ | Fizyczny czas od początku Run; osobny od grubości t. | $\mathrm s$ |
| $q,u$ | Bezwymiarowe zmienne precesji i tłumienia. | $1$ |
| $m_{z0},m_{\perp0}$ | Początkowa składowa z i dodatnia amplituda poprzeczna znormalizowanego m. | $1$ |
| $\phi_0$ | Początkowa faza atan2(my0,mx0), tutaj0. | $\mathrm{rad}$ |
| $\mathbf m(\tau)$ | Znormalizowana magnetyzacja testu. | $1$ |

Alfa jest zdefiniowana w głównej tabeli. Dodatnia gamma oraz exp(+i omega t)
dają dodatni przyrost fazy mx+i my. Gdy początkowa składowa poprzeczna jest
zerowa, istniejący wzorzec zwraca stan osiowy bez dzielenia przez zero.
Przykład kontrolny ma dodatnie m_perp0=0,001 i mz0=sqrt(1−1e−6).

| Python / wartość | Typ; default testu | SI | Walidacja i mapowanie |
|---|---|---|---|
| `study.engine`, `study.device`, `study.mode` | str; fdm/cpu/double/strict | $1$ | Jawny requested intent; canonical backend_policy/runtime_selection, bez fallbacku GPU. |
| `study.universe`, `study.cell`, `body.geometry` | tuple[float,float,float];20nm w każdej osi | $\mathrm m$ | Jedna komórka, dodatnie wymiary; canonical FDM grid/Box, bez siatki FEM. |
| `body.Ms` | float;0,89/mu0 | $\mathrm{A\,m^{-1}}$ | Dodatnie material.Ms; nie jest przypisaniem Ms do próbki eksperymentalnej. |
| `body.Aex` | float;13e−12 | $\mathrm{J\,m^{-1}}$ | API Material wymaga dodatniego A; wartość techniczna, niewykorzystywana przy jawnie wyłączonej wymianie. |
| `body.alpha` | float;0,01 | $1$ | Nieujemne material.alpha; wspólne z biegunem A5. |
| `body.m` | texture.uniform; (0,001,0,sqrt(1−1e−6)) | $1$ | Jednostkowy stan początkowy; canonical magnet.m0. |
| `study.b_ext` | tuple; (0,0,0,25) | $\mathrm T$ | Jedyny energy term: Zeeman;0,25T już reprezentuje całe pole efektywne. |
| `study.exchange`, `study.demag` | bool; enabled=False | $1$ | Brak operatorów w energy_terms; niezmienione publiczne walidatory. |
| `study.solver.gamma` | float; mu0*2pi*30e9 | $\mathrm{m\,A^{-1}\,s^{-1}}$ | Dodatnie study.dynamics.gyromagnetic_ratio etapu, bez g= i bez domyślnej gamma. |
| `study.solver.fix_dt`, `integrator` | float/str;1e−13/rk4 | $\mathrm s$, $1$ | Dodatni study.dynamics.fixed_timestep etapu i jawny rk4; brak adaptacji. |
| `study.stages.add_run.until` | float;2e−9 | $\mathrm s$ | Jeden Run,20000 kroków nominalnych; brak Relax, FFT, field-only lub anteny. |
| `study.tableautosave.every`, `quantities` | float/list[str];1e−12/step,time,dt,mx,my,mz | $\mathrm s$, $1$ | Zachowanie kanonicznych aliasów quantity; wynik m bez jednostki, czas/dt w sekundach. |

Pierwsze sprawdzenie dotyczy publicznego loadera, pełnego ProblemIR i
round-trip eksportu. Następnie planowany jest jeden accepted run przez
istniejącą grupę Docker; osobny projekt/run nie zastępuje sceny anteny.
Nie wolno wywołać solvera bez istniejącej trasy managed ani ominąć odmowy
capture, planera, storage lub zasobów. Brak wykonania pozostanie NOT VERIFIED.
FDM CPU jest jedyną planowaną realizacją tej kontroli; FDM GPU, FEM CPU i
FEM GPU nie otrzymują z niej dowodu ani domniemanej zgodności.

Przed wynikiem ustalamy: pełna trajektoria ma mieć co najmniej1000 różnych
próbek czasu, obejmować co najmniej1,99ns i składać się ze skończonych wektorów;
max błąd wektora względem istniejącego wzorca <=1e−7, defekt normy <=1e−10.
Faza rozwinięta ma rosnąć; częstotliwość z nachylenia fazy mx+i my ma zgadzać
się z Re(fp)=7,499250075GHz względnie do1e−5. Osobna regresja nachylenia
asinh(mz/hypot(mx,my)) sprawdza tłumienie względnie do1e−3. Granice te są
kryteriami jednego testu; nie zmieniają wersjonowanej polityki solvera lub
wcześniejszych kryteriów kwalifikacji GSG. Brak danych, skrócony Run, inny
backend albo nieznane provenance nie przechodzą kontroli. Nie wolno
uzupełniać brakujących próbek wzorcem. Same testy Python nie dowodzą Run.

Przewidziane źródła: `examples/fdm_sushruth_2020_k0_free_precession.py::study`,
`antenna_macrospin_oracle.py::macrospin_from_field_impulse` i
`packages/fullmag-py/tests/test_sushruth_k0_precession_example.py::SushruthK0PrecessionExampleTests`.
Wykonanie i odczyt pełnego wyniku mają osobne provenance. Model anteny3D,
baza H/I, projection i m(k,omega) pozostają poza dowodem tej kontroli.

Kontrola round-trip obejmuje wszystkie fizyczne pola IR oraz snapshot Run,
z wyłączeniem metadanych pochodzenia przepisywanego skryptu. Kanoniczny
renderer stosuje12 cyfr znaczących: liczby zmiennoprzecinkowe porównujemy
względnie do5e−12 bez podłogi absolutnej; klucze, typy wyborów, długości
i wartości nieliczbowe pozostają dokładne. To kontrola zapisu, nie próg
zgodności z publikacją. Oryginalny native run ma użyć pełnej wartości gamma
z oryginalnego skryptu, nie jej zaokrąglenia z eksportu.

### Wykonany kontrolny Run k=0 — wynik04.11.2026

Jeden oddzielny accepted run FDM CPU/double/strict z RK4 wykonał20000
zaakceptowanych kroków do2ns. Z zachowanej tabeli workera odczytano2001
próbek bez ponownego obliczenia. Przeszły wszystkie zapisane wcześniej
kryteria tej kontroli: max błąd wektora1,5879008252154792e−13, defekt normy
2,220446049250313e−16, częstotliwość z fazy7499250074,959879Hz wobec
7499250074,9925Hz z dokładnego bieguna A5; względna różnica4,35e−12.
Nachylenie tłumienia wyniosło471191778,851548s−1 wobec471191778,860583s−1;
względna różnica1,92e−11. Pomiar nachylenia nie jest dopasowaniem
parametrów materiału lub częstotliwości do krzywych publikacji.

Wynik kwalifikuje wyłącznie tę kontrolę jednorodnej precesji i tej realizacji
RK4. Nie kwalifikuje całego backendu FDM, podatności przy wymuszeniu RF,
propagacji, demag, pola anteny lub Fig.3. Pozostałe trzy realizacje backendów
nie otrzymują nowego dowodu. Nie zmieniono zapisanego scientific_assessment:
w archiwum pozostaje unassessed; wynik kontroli jest osobnym raportem.

Przygotowanie projektu i requestu przeszło publiczny CLI. Jednorazowy Submit
przekroczył czas30s, ale GET potwierdził przyjęty run i ten sam fingerprint.
Nie ponowiono Submit; istniejąca recepta materializacji dokończyła wyłącznie
brakujący katalog, po czym nadzorowany worker wykonał Run. Obie recepty
`just docker-dev-submit-accepted` i `just docker-dev-materialize-accepted`
użyły pinów naszej stałej grupy3203. Nie było nowego buildu lub restartu.

API potwierdza succeeded/closed,20000 kroków i końcowy stan CAS. Tabela
nie jest osobnym wpisem katalogu SolutionSet, ale jest zachowana w katalogu
worker-attempts; schema opisuje t/dt w sekundach, m bezwymiarowe. Sprawdzono
run/task/attempt/epoch z receipt wykonania, hash tabeli i zgodność jej końca
z przypiętym stanem CAS. Pełnej tabeli nie pobrano przez publiczny endpoint
SolutionSet. Nie zastępujemy tego ograniczenia stwierdzeniem o gotowym UI.
Scena anteny i tożsamość jej sesji pozostały bez zmian.

Run `run-968b1e61c20ea61f582dfd5f0b3bba9660b44411337bc14e06aaa1fc945085a3`,
projekt `project-1aa2f56967dd4603bb23c7c90554f47a`,
request SHA256 `a69d86e193ebca93c0ffefee4f78db054a434d154bb8953e4315a22e882abd5c`.
Wykonany pakiet: snapshot
`3422d160ec334bbd58cc039961e7a237a1cd84a522711ec3b48849ee567b8226`;
provenance końcowego m potwierdza cpu_reference/rk4/double i brak fallbacku.
Tabela SHA256 `ea3ec49cbdc388cdef1f6a04d4f0d4631a9c2ddd773dbde716dcdd02f52c006e`.
Dowody: control volume, `verification/sushruth-k0-runtime-control-20261104/`,
w szczególności `trajectory-verification.json`, `retained-trajectory.csv`,
`worker-completion-receipt.json`, receipt prepare i odczyty publicznego API.
Przeszły także3 kontrole authoringu/round-trip. Pierwsze nieudane kontrole
zapisano; ujawniły różne API zapisu tabeli Relax/Run oraz zagnieżdżenie
parametrów w study.dynamics, bez zmiany kontraktów produkcyjnych.

Requested minimum zasobów to1CPU/2GiB; scheduler przydzielił istniejący slot
3CPU/5,25GiB. Nie podniesiono limitów kontenera ani polityki schedulera.
Nie znamy faktycznego szczytu RAM samego native Run z tego odczytu.
Przetwarzanie zapisanej tabeli miało osobny limit2GiB i peak33,44MB;
tej liczby nie należy przypisywać solverowi.

Nowy kontrolny Run LLG1, lecz nowe pełne V/J/H GSG nadal0/3 i kontrole
pełnego H0/9. Jedyny zatwierdzony nowy build pozostaje niewykorzystany,
a patch metadanych capture8→12MiB nadal oczekuje na wcześniejszą decyzję.


(sushruth-k0-rf-control)=
## Wymuszona odpowiedź RF k=0 — prerejestracja

Po zaliczonej swobodnej precesji planujemy osobno sprawdzić amplitudę i fazę
odpowiedzi jednorodnej. To ten sam model kontrolny stałego pola efektywnego,
bez demag i wymiany, nie model skończonej próbki ani zakwalifikowanej anteny.
Używamy istniejącego RegionalFieldDrive/UniformFieldProfile/Sinusoidal.
Nie zmieniamy ich kodu, semantyki albo bramek; nie korzystamy z basis H/I.

Dokładne odwrócenie macierzy A5 przy k=0, w jednostkach cykli/s:

```{math}
:label: eq-sushruth-k0-exact-susceptibility
 \mathcal D_0=(\gamma_f b_e+i\alpha f)^2-f^2,\qquad
 \chi_{xx}^{A5}=\frac{\gamma_f b_M(\gamma_f b_e+i\alpha f)}{\mathcal D_0},\qquad
 \chi_{yx}^{A5}=\frac{-i\gamma_f b_M f}{\mathcal D_0}.
```

To pełny liniowy A5, a nie przybliżenie A8 lub Eq1. Nie zmieniamy istniejących
wzorów Fig.3. Bez wymiany/demag przy k=0 amplituda małej odpowiedzi m jest
porównywana z tym wzorcem; pełny LLG pozostaje nieliniowy.

```{math}
:label: eq-sushruth-k0-rf-demodulation
 H_x(\tau)=h_0\sum_{j=1}^{3}\cos(2\pi f_j\tau),\qquad
 \widehat m_a(f_j)=\frac{2}{N}\sum_{n=0}^{N-1}
 m_a(\tau_a+n\Delta\tau)e^{-i2\pi f_j(\tau_a+n\Delta\tau)},\qquad
 \chi_{ax}^{\mathrm{meas}}(f_j)=\frac{M_s\widehat m_a(f_j)}{h_0}.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $\mathcal D_0$ | Wyznacznik liniowej macierzy A5 w cyklach/s dla k=0. | $\mathrm{Hz^2}$ |
| $\chi_{xx}^{A5},\chi_{yx}^{A5}$ | Dokładne liniowe podatności Mx/Hx i My/Hx modelu k=0. | $1$ |
| $H_x(\tau)$ | Zadane sumaryczne poprzeczne pole RF. | $\mathrm{A\,m^{-1}}$ |
| $h_0$ | Amplituda peak każdej z trzech składowych,0,1A/m. | $\mathrm{A\,m^{-1}}$ |
| $j,f_j$ | Indeks1–3 i częstotliwość składowej6/7,5/9GHz. | $1;\;\mathrm{Hz}$ |
| $a,m_a(\tau)$ | a=x lub y, poprzeczna składowa znormalizowanego m. | $1$ |
| $N,n,\Delta\tau$ | Liczba2000 próbek, indeks0–1999 i okres2ps. | $1;\;1;\;\mathrm s$ |
| $\tau_a$ | Początek okna odczytu20ns; koniec24ns jest wyłączony z sumy. | $\mathrm s$ |
| $\widehat m_a,\chi_{ax}^{\mathrm{meas}}$ | Zmierzony zespolony współczynnik m i odpowiadająca podatność. | $1$ |
| $M_s$ | Magnetyzacja nasycenia modelu, b_M/mu0. | $\mathrm{A\,m^{-1}}$ |

Pozostałe symbole są zdefiniowane powyżej. Konwencja pozostaje exp(+i omega t).
Faza Sinusoidal=pi/2 daje cosinus. Odjęcie średniej nie jest wymagane przez
ortogonalną sumę pełnych24/30/36 okresów; nie dopasowujemy fazy lub amplitudy.
Nie stosujemy FFT kolejności węzłów: tu jest jedna komórka, a analiza dotyczy
wyłącznie czasu. Nie jest to widmo przestrzenne źródła lub m(k,omega).

Parametry modelu Ms/gamma/alfa/bias oraz nośnik są jak w kontroli swobodnej,
ale początkowy m=(0,0,1). Jeden planowany Run do24ns, RK4/fix_dt1ps,
próbkowanie tabeli2ps. Trzy drive mają jawne stabilne id zależne od
częstotliwości, globalny target jednej komórki, kierunek+x, amplitudę
B=mu0*0,1A/m, stage_local i activation wyłącznie dla etapu k0_rf_response.
Nie ma Relax, transportu, Solve pola anteny, zmian czasu początku lub
ponowień. Materiałowego Aex nadal nie używa wyłączony operator wymiany.

Po20ns przejściowy stan swobodny ma współczynnik tłumienia około8,1e−5;
okno4ns obejmuje całkowite okresy wszystkich trzech częstości. Przed wynikiem
ustalamy: co najmniej1000 próbek w oknie, skończone wartości i zgodna cadence,
horyzont>=23,99ns, brak fallbacku; dla obu zespolonych podatności i każdej
częstotliwości moduł różnicy <=1e−4+1e−3|chi_A5|. To sześć porównań
zespolonych, nie sześć nowych prób Run. Nie przesuwamy częstotliwości do
zmierzonego maksimum. Próg dotyczy tej jednej małoamplitudowej kontroli,
nie kwalifikacji całej aplikacji lub publikacji. Brak danych nie jest zerem.

Funkcja diagnostyczna uniform_susceptibility przyjmuje częstotliwość float
w Hz ze znakiem, wymagane skończone alpha>0 oraz domyślne mu0_h_eff_t=0,25T,
mu0_ms_t=0,89T i gamma_hz_per_t=30e9Hz/T. Pola/gamma muszą być dodatnie,
bez bool/NaN/Inf; nieskończony wynik lub zdegenerowany mianownik odmawia.
Zwraca dwie bezwymiarowe liczby zespolone xx/yx, bez nowego DSL/ProblemIR.
Bezpośrednie niezależne odwrócenie2x2 w jednostkach Hz, statyczna granica,
sprzężenie i pasywność mają kontrolować tę funkcję przed native Run.
Wszystkie nowe parametry skryptu RegionalFieldDrive przechodzą istniejące
field_drives w ProblemIR i istniejący planner; nie istnieje nowy fallback.
Dowód będzie wyłącznie FDM CPU/double/RK4; inne backendy pozostają bez dowodu.


| Python | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| uniform_susceptibility.frequency_hz | float | wymagany | $\mathrm{Hz}$ | skończony bez bool; znak dowolny | częstotliwość bodźca | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| uniform_susceptibility.alpha | float | wymagany | $1$ | skończony >0 bez bool | tłumienie stanu ustalonego | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| uniform_susceptibility.mu0_h_eff_t | float | 0.25 | $\mathrm T$ | skończony >0 bez bool | statyczne pole efektywne razy mu0 | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| uniform_susceptibility.mu0_ms_t | float | 0.89 | $\mathrm T$ | skończony >0 bez bool | magnetyzacja nasycenia razy mu0 | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |
| uniform_susceptibility.gamma_hz_per_t | float | 30e9 | $\mathrm{Hz\,T^{-1}}$ | skończony >0 bez bool | gamma dla pól w teslach podzielona przez2pi | niezależna diagnostyka CPU; bez backendu Fullmaga | nie serializuje się do ProblemIR |


`verify_rf_response.samples` to wymagane Sequence[dict] z time_s i wektorem m
trzech skończonych liczb; czas w sekundach rośnie ściśle. Brak parametrów
konfiguracyjnych; okres/częstotliwości/h0/Ms/alfa i progi są przypięte powyżej.
W oknie wymagane są wszystkie2000 próbek, z czasem zgodnym z20ns+n*2ps
z dokładnością1e−18s; nie interpolujemy braków. Sumowanie używa math.fsum
osobno dla real/imag. Wynik source_execution_verified=false wymaga osobnego
potwierdzenia run/worker/źródeł przez caller; fixture nie może go zamienić
w dowód native. ProblemIR/planer/runtime nie są modyfikowane przez analizę.

| Parametr skryptu RF | Typ i jawna wartość | SI / mapowanie i domyślność niewykorzystanych pól |
|---|---|---|
| RegionalFieldDrive.id/name | str; k0-rf-6ghz/k0-rf-7p5ghz/k0-rf-9ghz | $1$; wymagane niepuste stabilne identyfikatory, nie indeks obiektu. |
| target | FieldTarget.global_domain() | $1$; jedna komórka całej domeny; istniejący kontrakt target. |
| amplitude_B_T | float; mu0*0,1 | $\mathrm T$; nieujemna amplituda peak, nie RMS; istniejące lowering field drive. |
| direction | tuple; (1,0,0) | $1$; niezerowy wektor normalizowany przez istniejący konstruktor. |
| spatial_profile | UniformFieldProfile() | $1$; jawny profil jednorodny, bez geometrii anteny. |
| waveform.frequency_hz/phase_rad/offset | float;6e9/7,5e9/9e9, pi/2,0 | $\mathrm{Hz}$, $\mathrm{rad}$, $1$; dodatnia częstość, skończona faza/offset; offset jest zachowanym default0. |
| time_origin/activation | str/DriveActivation; stage_local, stage_ids(k0_rf_response) | $1$; jawne istniejące typy i stage id. |
| enabled/migration | bool/dict lub None; True/None | $1$; zachowane defaulty, brak provenance migracji lub niejawnej aktywacji fizyki. |
| initial_m/fix_dt/until/table period | (0,0,1),1ps,24ns,2ps | $1$, $\mathrm s$, $\mathrm s$, $\mathrm s$; reszta modelu jak w poprzedniej tabeli k=0. |

Przed native wykonaniem przeszły4 testy dokładnej podatności,7 istniejących
A8/A5,3 testy demodulacji i3 testy publicznego skryptu RF. Są to dowody
źródłowe i fixture, nie wykonanie nowego Run. Odmowy niewłaściwej fazy,
jednostek i brakujących próbek pozostają częścią kontroli.


### Wykonana odpowiedź RF k=0 — wynik04.11.2026

Rzeczywisty kontrolny Run FDM CPU/double/RK4 ukończył24000 kroków do24ns.
W oknie20–24ns odczytano wszystkie2000 próbek co2ps. Sześć porównań
zespolonych chi_xx/chi_yx przy6/7,5/9GHz spełniło próg prerejestracji;
największy względny błąd zespolony wyniósł0,00369351%. Wyrażenia i kryteria
powyżej były zapisane przed Run. Nie dopasowano fazy/amplitudy/częstotliwości.
Nie jest to wynik transmisji R/T, odpowiedź skończonego k lub doświadczenie.

Potwierdzono identyfikatory Run/worker/epoch, source hash, CAS końcowego stanu,
cpu_reference/rk4/double i brak fallbacku. Tabela12000 wierszy ma jeden brak
przy11,384ns; surowy zapis12001 wierszy zachował tę próbkę. Brak leży poza
oknem pomiaru i nie jest wypełniany. Ustalono rozbieżność tolerancji zegara
wyjść i tabeli; poprawka źródłowa nie ma jeszcze nowego native-build proof.
Kontrola arytmetyki poprawki nie jest zaliczeniem runtime.

Wynik i pełne piny: [raport kontrolnego Run RF](../superpowers/plans/2026-11-04-sushruth-k0-rf-native-control-result.md).
Dowód: control volume, verification/sushruth-k0-rf-control-20261104,
rf-response-verification.json. Nowe transport/antenna Solve0, nowy build0.
Nadal brak dowodu dla FDM GPU, FEM CPU i FEM GPU w tej kontroli. Tabela jest
zachowana, ale nie opublikowana jako osobny artefakt SolutionSet w UI.
Rozbieżność Fig.3 i kwalifikacja GSG pozostają otwarte. Wykres raportowy
rozróżnia trzy częstotliwości rzeczywistego Run i ciągłą linię wzorca A5.


(sushruth-figure3-frequency-origin-audit)=
### Dodatkowa kontrola Fig.3 — położenie względem FMR i rezonans

Porównanie dodatniego maksimum S/alfa0,01 względem własnego FMR daje
0,13235GHz dla zachowanego rastra i0,30000GHz dla literalnego modelu.
Po odjęciu początku pozostaje0,16765GHz różnicy; odpowiadające ilorazy przez
FMR wynoszą0,0183616 i0,0400000. Jeden wspólny mnożnik częstotliwości ich nie
uzgadnia. To test hipotezy z zachowanych odczytów, bez fitu lub zmiany wejść.
Nie jest to ścisły bound błędu digitizacji ani wykluczenie wszystkich błędów
konwencji. Wzorzec i grafika pozostają oddzielnymi danymi.

Istniejący test independent_signed_quadrature_and_convergence rozszerzono
o7,605/7,8GHz dla S/GS/GSG i czterech alfa. Przeszedł:60 przypadków, w tym
24 nowe i48 nowych zespolonych porównań R/T. Progi pozostały
2e−6+2e−5|reference| i estymator1e−7; maksimum błędu po wszystkich siatkach
4,12765e−6. Produkcyjne wzory niezależnego helpera pozostały bajtowo identyczne.
Nie wykonano nowego Fullmag/BORIS, transportu lub pola. Nie dowodzi to
reprodukcji Fig.3. Szczegóły i źródła: [raport kontroli](../superpowers/plans/2026-11-04-sushruth-figure3-resonance-and-origin-audit.md).
Mapowanie: scripts/plot_sushruth_2020_response_reference.py::measure_figure3_anchors
oraz scripts/test_reference_sushruth_2020_response.py::SushruthResponseReferenceTests::test_independent_signed_quadrature_and_convergence.

(sushruth-faraday-observable-audit)=
## Indukcyjność a napięcie — diagnostyka obserwabli 06.11.2026

To test hipotezy generatora Fig.3, nie zmiana równania10, kalibracja S21
lub dobór fazy. §II.C wiąże T z indukcyjnością wzajemną. Opis cosine-like
w §III.B.2 oraz czynnik i w Eq14/AppendixB uzasadniają rozróżnienie sygnałów,
ale nie dowodzą, że autorzy narysowali napięcie zamiast podpisanego Re(T).
Domyślny renderer zachowuje Re(T). Źródłem jest ta sama praca z bibliografii.

Dla zachowanej konwencji czasowej $e^{i\omega\tau}$ prawo Faradaya daje:

```{math}
:label: eq-sushruth-faraday-observable

\widehat\Phi=M_\ast\widetilde T\widehat I,\qquad
\widehat{\mathcal E}=-i\omega\widehat\Phi,\qquad
\omega_\ast=2\pi f_\ast,\qquad
P_{\mathcal E}=\frac{\widehat{\mathcal E}}
{\omega_\ast M_\ast\widehat I}
=-i\frac{f}{f_\ast}\widetilde T,\qquad
P_V=-P_{\mathcal E}.

```

$P_{\mathcal E}$ oznacza znormalizowaną SEM o znaku minus pochodnej strumienia;
$P_V$ ma przeciwny znak zgodnie z pasywnym spadkiem indukcyjnym. Pokazujemy
obie ustalone konwencje, nie wybieramy znaku po dopasowaniu wykresu. Nieznane
$M_\ast$ i polaryzacja rzeczywistych portów nie pozwalają wyprowadzić z tego
skalibrowanych woltów lub S21. Czynnik $f/f_\ast$ nie zmienia biegunów ani FMR.

| Symbol | Znaczenie | SI |
|---|---|---|
| $\widehat\Phi$ | zespolona amplituda strumienia sprzężonego | $\mathrm{Wb}$ |
| $M_\ast$ | niekalibrowana stała skali indukcyjności | $\mathrm H$ |
| $\widehat I$ | niezerowa zespolona amplituda prądu nadajnika | $\mathrm A$ |
| $\widehat{\mathcal E}$ | zespolona amplituda SEM Faradaya | $\mathrm V$ |
| $f_\ast$ | dodatnia częstotliwość normalizacji, FMR z TableI | $\mathrm{Hz}$ |
| $\omega_\ast$ | kołowa częstotliwość normalizacji | $\mathrm{rad\,s^{-1}}$ |
| $P_{\mathcal E},P_V$ | bezwymiarowe diagnostyki SEM i pasywnego napięcia | $1$ |
| $i$ | jednostka urojona | $1$ |

Funkcja `faraday_emf_proxy` jest niezależnym postprocessingiem wzorca,
nie publicznym konstruktorem DSL. Nie ma mapowania do ProblemIR, zmian
planera, zasobów API lub źródła LLG. Dla FEM CPU, FEM GPU, FDM CPU i FDM GPU
jest to not-applicable jako realizacja solvera; nie przenosi dowodów runtime.

| Parametr diagnostyki | Typ | Default | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| faraday_emf_proxy.frequency_hz | float | wymagany | $\mathrm{Hz}$ | skończony nieujemny bez bool | częstotliwość próbki | niezależny postprocessing CPU | brak serializacji |
| faraday_emf_proxy.normalized_inductance | complex | wymagany | $1$ | obie składowe skończone bez bool | zespolone T z zachowanej całki | niezależny postprocessing CPU | brak serializacji |
| faraday_emf_proxy.reference_frequency_hz | float | wymagany keyword | $\mathrm{Hz}$ | skończony dodatni bez bool | f_ast jawnie z FMR wejścia | niezależny postprocessing CPU | brak serializacji |

Przed porównaniem: test znanego rzeczywistego strumienia i niezależnej
centralnej pochodnej dla6/7,5/9GHz ma potwierdzić znak, czynnik częstotliwości
oraz jednostki z błędem względnym poniżej5e−7 przy4096próbkach okresu.
Odmowa niefinitych danych lub przepełnienia to ValueError, nie zerowy sygnał.
Następnie wyłącznie zachowane701próbek/case, bez nowej kwadratury, zmiany
osi, materiałów lub odległości. Ekstrema mierzymy na6–9GHz bez interpolacji;
pierwsze dwa dodatnie lokalne maksima muszą przekraczać10% maksimum tego
samego wariantu. Brak dwóch maksimów ma być jawny. Próg opisuje lokalizator,
nie akceptację fizyki. Nie wybieramy obserwabli według najlepszego dopasowania.
Sama zmiana obserwabli nie wystarcza do reprodukcji, jeżeli nie zgadza się FMR
lub pozostałe jawne parametry. Stan reprodukcji pozostaje NOT VERIFIED.

### Wykonany test obserwabli — 06.11.2026

Cztery testy diagnostyki PASS; niezależna rzeczywista pochodna strumienia
potwierdziła znak i skalę dla6/7,5/9GHz. Następnie przetworzono zachowane
12przebiegów po701próbek; ekstrema odczytano na601próbkach6–9GHz. Bez nowej
kwadratury, interpolacji, wyboru fazy lub parametrów. Dla alfa0,01:

| Antena | Maksimum Re(T), GHz | Maksimum SEM, GHz | Maksimum pasywnego napięcia, GHz |
|---|---:|---:|---:|
|S|7,800|7,700|7,900|
|GS|8,175|8,085|8,265|
|GSG|8,175|8,440|8,265|

Wobec odczytanego maksimum GSG7,59759GHz oraz niezgodnego FMR sama
zamiana obserwabli nie uzgadnia tej figury. Nie wybieramy wariantu tylko
dlatego, że jedno maksimum S stało się bliższe. Nie rozstrzyga to recepty
autorów ani wszystkich możliwych różnic modelu. Wynik pozostaje diagnostyką,
nie dowodem reprodukcji lub błędu publikacji. Domyślny Re(T) jest niezmieniony.
Pełne ekstrema i dowody: [raport obserwabli](../superpowers/plans/2026-11-06-sushruth-voltage-observable-audit.md).

(scientific-bibliography)=
## Bibliografia

1. M. Sushruth i in., Electrical spectroscopy of forward volume spin waves in
   perpendicularly magnetized materials, Physical Review Research 2, 043203
   (2020), [DOI i pełny tekst](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203).
   Równania 1–3, 6–10, Table I i Appendix A. Licencja CC BY 4.0.

(source-code-index)=
## Indeks kodu źródłowego

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/reference_sushruth_2020_response.py | film_susceptibility | Równania 1–3 z jawnymi jednostkami; model przybliżony. |
| scripts/reference_sushruth_2020_response.py | inductive_response | Unormowane całki 9–10; złożona kwadratura Simpsona. |
| scripts/reference_sushruth_2020_response.py | figure3_reference | Jawne parametry Table I/Fig3, JSON bez claimu Fullmag/BORIS. |
| scripts/test_reference_sushruth_2020_response.py | class SushruthResponseReferenceTests | Granice analityczne, niezależna kwadratura i zbieżność. |
| scripts/reference_sushruth_2020_antenna_spectrum.py | antenna_spectra | Istniejący wzorzec widma cienkich pasków Eq6–8. |
| scripts/plot_sushruth_2020_response_reference.py | plot_figure3_reference | Render przypiętych przebiegów do PNG/SVG, bez dopasowania. |
| scripts/plot_sushruth_2020_response_reference.py | measure_figure3_anchors | Odczyt położeń z oryginalnego rastra i jawna nierozstrzygnięta różnica. |
| scripts/plot_sushruth_2020_response_reference.py | measure_figure3_e_pixels | Czysty odczyt panelu(e), jawne maski adnotacji i zakres szarej kreski. |
| scripts/test_sushruth_figure3_panel_e.py | class Figure3PanelERasterTests | Niezależny fixture osi, ticków, legend, ekstremów i odmów. |
| scripts/reference_sushruth_2020_a8_diagnostic.py | a8_numerator_factor | Stosunek liczników A8 i równania1, bez nowej kwadratury lub zmiany domyślnego modelu. |
| scripts/reference_sushruth_2020_a8_diagnostic.py | uniform_free_pole_hz | Dokładny swobodny biegun A5 dla k=0; osobny obserwabl od maksimum transmisji. |
| scripts/test_sushruth_a8_diagnostic.py | class SushruthA8DiagnosticTests | Bezpośrednie A8, granice i jednostki oraz niezależne podstawienie do wyznacznika A5. |
| scripts/antenna_macrospin_oracle.py | macrospin_from_field_impulse | Istniejący niezależny dokładny wzorzec stałego/kolinearnego pola; bez uruchamiania backendu. |
| examples/fdm_sushruth_2020_k0_free_precession.py | study | Jawny publiczny przypadek FDM CPU k=0, bez anteny, wymiany i demag. |
| packages/fullmag-py/tests/test_sushruth_k0_precession_example.py | class SushruthK0PrecessionExampleTests | Publiczny loader, parametry snapshotu Run i semantyczny round-trip pełnego fizycznego IR. |
| scripts/reference_sushruth_2020_a8_diagnostic.py | uniform_susceptibility | Dokładna liniowa macierz A5 dla k=0, bez zmiany Eq1. |
| scripts/test_sushruth_k0_susceptibility.py | class SushruthK0SusceptibilityTests | Niezależna macierz2x2, statyka, sprzężenie, pasywność i odmowy. |
| examples/fdm_sushruth_2020_k0_rf_response.py | study | Publiczny kontrolny Run z trzema zadanymi polami RF; bez antenowej bazy. |
| packages/fullmag-py/tests/test_sushruth_k0_rf_example.py | class SushruthK0RfExampleTests | Wymuszenia, gamma, czas i sampler oraz round-trip publicznego skryptu. |
| scripts/verify_sushruth_k0_rf_response.py | verify_rf_response | Niezależny pomiar sześciu zespolonych podatności z zachowanych próbek, bez uwierzytelnienia runu. |
| scripts/test_sushruth_k0_rf_demodulation.py | class SushruthK0RfDemodulationTests | Znany sygnał trójtonowy i negatywne kontrole fazy, jednostek, braków oraz niefinitych danych. |
| scripts/reference_sushruth_2020_voltage_observable.py | faraday_emf_proxy | Ustalona pochodna Faradaya dla zachowanej konwencji czasowej; bez kalibracji i zmiany domyślnego T. |
| scripts/test_sushruth_voltage_observable.py | class SushruthVoltageObservableTests | Niezależna rzeczywista pochodna strumienia, jednostki i odmowy. |
