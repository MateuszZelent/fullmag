# Fale forward-volume — niezależny wzorzec Sushruth 2020

**Reprodukcja publikacji: NOT VERIFIED.** Datowane rozdziały poniżej zachowują
stan w chwili kontroli; ich liczniki i decyzje nie opisują późniejszych prób.
Bieżący cel obejmuje sekwencyjną reprodukcję Fig1,2,3,4,6:
[plan wykonania](../superpowers/plans/2026-11-15-sushruth-publication-reproduction.md).
Analityczny model Fig1 przeszedł odbiór15.11.2026; walidacja pola i widma
Fullmaga pozostaje osobnym nieukończonym krokiem.

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
| Adnotacja FMR w panelu(a), nie pomiar materiału | około7,208GHz | 7,500GHz | około0,292GHz między modelem i rysunkiem |
| Dodatnie maksimum S, alfa0,01 | około7,340GHz | 7,800GHz | około0,460GHz |
| Ujemne minimum S, alfa0,01 | około7,208GHz | 7,605GHz | około0,397GHz |

Odczyt adnotacji nie jest pomiarem materiałowego FMR ani jego błędu. Pełne pasma kreski i obu ramek sprawdzono ponownie w {ref}`sushruth-figure3-axis-and-annotation-recheck`.

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

Poniższy odstęp od adnotacji nie jest różnicą względem zmierzonego materiałowego FMR; por. {ref}`sushruth-figure3-axis-and-annotation-recheck`.

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


(sushruth-complex-square-normalization)=
## Kontrola zespolonego kwadratu i normalizacji GS — 06.11.2026

<!-- DOC-ANCHOR:sushruth-complex-square-normalization -->

Równania9–10 publikacji zapisują kwadrat widma, podczas gdy nasz wzorzec
używa modułu kwadratowego. Dla konkretnych idealnych widm6–8 oba zapisy
dają tę samą unormowaną odpowiedź, jeżeli licznik i mianownik stosują
tę samą konwencję. Nie jest to ogólna zamiana dla dowolnego zespolonego
profilu lub dowolnej pary anten.

Dla niezerowego, stałego w k współczynnika $\lambda$ definiujemy pomocniczy
normalizator zespolonego kwadratu $Q_\lambda$ i odpowiedź $\widetilde T_\lambda$:

```{math}
:label: eq-sushruth-complex-square-normalization

 Q_\lambda=\int_{-\infty}^{\infty}[\lambda h(k)]^2\,dk,\qquad
 \widetilde T_\lambda=
 \frac{\int_{-\infty}^{\infty}[\lambda h(k)]^2
       \chi_{xx}(\omega,k)e^{-ikr}\,dk}{Q_\lambda}
 =\widetilde T_1.
```

Dla widma GS z równania7 zachodzi $h(k)=i\,a(k)$ z rzeczywistym $a(k)$.
Wtedy $Q_1=-D$, a licznik ma ten sam dodatkowy minus. Dla S i GSG
widma są rzeczywiste, więc $Q_1=D$. Dlatego użycie modułu kwadratowego
w obu miejscach nie wprowadza samo w sobie przeciwnej fazy GS.
Ta algebra dotyczy konwencji zapisu tej znormalizowanej całki;
nie usuwa fizycznej fazy osobnego źródła, względnej orientacji odbiornika
lub polaryzacji portu. Nie wolno na tej podstawie obracać danych pomiarowych.

| Symbol | Znaczenie | SI |
|---|---|---|
| $\lambda$ | niezerowy, wspólny stały współczynnik reprezentacji widma w liczniku i mianowniku | $1$ |
| $Q_\lambda$ | pomocnicza całka zespolonego kwadratu widma | $\mathrm{m^{-1}}$ |
| $\widetilde T_\lambda$ | znormalizowana odpowiedź przy tym samym współczynniku w obu całkach | $1$ |
| $a(k)$ | rzeczywista funkcja taka, że idealne widmo GS wynosi $i a(k)$ | $1$ |

Pozostałe symbole, domena, jednostki i założenia pozostają w powyższych
równaniach wzorca. Odpowiednik $\widetilde R$ otrzymuje się dla $r=0$.
Warunkiem dzielenia jest niezerowe $Q_\lambda$; dla trzech badanych widm
całka jest niezerowa. To diagnostyka bez nowego publicznego API,
ProblemIR, źródła, bazy, solvera lub kontraktu runtime. Macierz czterech
realizacji FEM/FDM CPU/GPU pozostaje not-applicable jako dowód wykonania.

### Dowód numeryczny i granica wniosku

scripts/test_sushruth_response_normalization.py::signed_integrals buduje
zespolone widma bez wywoływania antenna_spectra: z sum przesuniętych
prostokątnych pasków i podpisanej zmiennej q. Podatność zapisuje w cyklach/s,
nie przez film_susceptibility. Porównanie dotyczy niezmienionego
scripts/reference_sushruth_2020_response.py::inductive_response.

Parametry materiałowe i geometryczne odpowiadają powyższej TableI/Fig.3:
b_e0,25T, b_M0,89T, gamma/(2pi)30GHz/T, t20nm, L200nm, g250nm,
s30nm i r2µm. Test używa q od−80 do80,65536 przedziałów Simpsona,
trzech częstotliwości7,8/8,175/8,355GHz, alfa0,01/0,1 i antenS/GS/GSG.
To18 kombinacji i36 porównań zespolonych R/T. Zachowano wcześniejszy
próg2e−6+2e−5|reference|; nie jest to próg zgodności z publikacją.

Dwa testy PASS: równoważność obu konsekwentnych normalizacji oraz
skracanie globalnej fazy dla lambda1,−1,i,−i i exp(0,37i).
Kontrolny, celowo niespójny wariant GS z kwadratem tylko w liczniku
i dodatnim D w mianowniku odwraca wynik; nie jest używany w produkcji.
Nie zmieniono kernela, parametrów, wykresów lub historycznych wyników.
Log: verification/sushruth-complex-square-normalization-20261106/
w prywatnym control volume grupy3203. Test trwał2,586s,1CPU/AS2GiB,
bez native meshera, prepare lub Solve.

Wniosek: wykluczono konkretną hipotezę dodatkowego minusa wynikającego
wyłącznie z czynnika i i poprawnej normalizacji GS. Nie ustalono przyczyny
rozbieżnych ekstremów Fig.3, nie wyjaśniono całej relacji czerwonej/czarnej
krzywej i nie uznano publikacji za odtworzoną.


(sushruth-table-one-consistency)=
## Spójność pochodnych wielkości Table I — prerejestracja 08.11.2026

<!-- DOC-ANCHOR:sushruth-table-one-consistency -->

Osobna diagnostyka sprawdza jednoczesną interpretację prędkości, szerokości
linii i długości tłumienia przy tym samym $k$. Tabela nie określa tego $k$,
więc rozbieżność nie dowodzi błędu całej publikacji ani zgodności Fullmaga.
Parametry podstawowe pozostają dokładnie takie jak powyżej: $b_e=0.25$ T,
$b_M=0.89$ T, $t=20$ nm, $\gamma_f=30$ GHz/T i $\alpha=0.01,0.1$.
Dane porównawcze tabeli: $v_g=105$ m/s,
$\Delta f_k=230$ MHz lub $2.3$ GHz oraz $L_\mathrm{att}=1.2$ lub $0.12$ µm.
Źródła: Table I oraz równania2–5 i Appendix A [1].
Nie zmieniamy żadnego parametru w celu dopasowania Fig.3.

Dla dodatniego $k$ różniczkujemy istniejącą dyspersję wzorca; w zerze
używamy granicy prawostronnej, ponieważ dyspersja zależy od $|k|$:

```{math}
:label: eq-sushruth-table-one-consistency

x=kt,\qquad n'(x)=\frac{1-(1+x)e^{-x}}{x^2},\qquad
v_g(k)=\frac{\gamma_B b_e b_M t\,n'(x)}
 {2\sqrt{b_e[b_e+b_M n(k)]}},\qquad
v_g(0^+)=\frac{\gamma_B b_Mt}{4},
\qquad \Delta f_k=\frac{\Delta\omega_k}{2\pi},\qquad
L_\mathrm{att}(k)=\frac{2|v_g(k)|}{\Delta\omega_k}
                =\frac{|v_g(k)|}{\pi\Delta f_k}.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $x$ | bezwymiarowe $kt$ dla dodatniego wektora falowego | $1$ |
| $n'(x)$ | pochodna czynnika odmagnesowania względem $x$ | $1$ |
| $v_g(k)$ | pochodna $\partial\omega_k/\partial k$; dla ujemnego k zmienia znak | $\mathrm{m\,s^{-1}}$ |
| $\Delta f_k$ | szerokość linii w cyklach na sekundę | $\mathrm{Hz}$ |
| $L_\mathrm{att}(k)$ | długość tłumienia amplitudy przy tym samym k | $\mathrm m$ |

Pozostałe symbole mają definicje i SI w tabelach właściciela powyżej.
To różniczkowanie tego samego modelu bez wymiany, nie nowy solver fal spinowych.
Małe $x$ korzysta z szeregu $n'(x)=1/2-x/3+x^2/8-x^3/30$.
Nie jest to pochodna w punkcie ostrym k=0; granice lewa/prawa są przeciwne.

### Zakres kodu, parametrów i realizacji

scripts/reference_sushruth_2020_table_one.py::audit_table_one nie ma argumentów:
odczytuje stałe Table I jako liczby SI i zapisuje wyłącznie raport JSON.
Prywatny _dispersion otrzymuje podpisane k w rad/m, używa tych samych czterech
stałych co film_susceptibility i zwraca f w Hz oraz prędkość w m/s.
Brak nowego publicznego API, pola ProblemIR, normalizacji DSL, endpointu,
capability lub kontraktu runtime. Requested intent to literalne parametry tabeli;
resolved execution to interpretowany Python CPU, bez Fullmag/BORIS Solve.
Wszystkie cztery realizacje FDM/FEM CPU/GPU pozostają not-applicable
jako dowód wykonania tej diagnostyki. Źródło anteny nadal inspection-only.

### Kontrola przed wykonaniem

Test sprawdzi konwersję Hz/rad/s, symetrię dyspersji i antysymetrię prędkości.
Niezależne centralne różnice częstości, bez użycia pochodnej implementacji,
zastosują k=1e6/1e7/3.8e7 rad/m i kroki k/1000,k/2000,k/4000:
błąd najdrobniejszego kroku ma być <1e-7 względnie i mniejszy od pierwszego.
To tolerancja kontroli różniczkowania, nie kwalifikacja Fullmaga lub Fig.3.
Dodatkowo statyczna podatność istniejącego wzorca sprawdzi zgodność tej samej
dyspersji i parametrów w czterech punktach z tolerancją arytmetyki 2e-15.
Wyniki oraz stan testów zostaną wpisane dopiero po wykonaniu.


### Wykonana kontrola i ograniczenie wniosku — 08.11.2026

Trzy testy PASS w istniejącym backendzie3203, Python3.10.12,0.057s, exit0.
Zachowano niezmienione parametry i zadeklarowane tolerancje. Nie uruchomiono
Fullmaga, BORIS, transportu, Prepare, H-only lub LLG.

Dla obu par szerokości linii/długości z tabeli warunkowe podstawienie tej samej
prędkości105m/s daje odpowiednio0.145315382823µm i0.0145315382823µm.
Wpisane długości są8.25790068944 razy większe. Odwrotne podstawienie długości
i szerokości implikuje867.079572391m/s. Nie jest to błąd konwersji2pi w naszym
skrypcie: osobny test w Hz i rad/s oraz niezależne różnice dyspersji przeszły.

Literalne parametry modelu dają przy k=0+ prędkość838.805238508m/s,
f=7.5GHz oraz szerokość150MHz/1.5GHz i długość1.78µm/0.178µm.
Nie zakładamy jednak, że wszystkie wiersze tabeli miały dotyczyć k=0.
Wniosek dotyczy braku jednoczesnej zgodności wierszy przy tym samym k,
nie dowodzi błędu autorów ani konkretnej przyczyny ekstremów Fig.3.

Sam inny wpis prędkości w tabeli nie zmienia naszych całek transmisji:
inductive_response używa dyspersji i podatności, a nie liczby105m/s z tabeli.
Nie zastępujemy parametrów liczbą dopasowaną do obrazu. Zgodność z publikacją
i źródło3D pozostają NOT VERIFIED.

Kod, wynik, logi i źródła są również na ext4 WSL:
examples/sushruth_2020_closed_gsg/table_one_consistency_20261108.
Manifest11plików/9577452B:
f3615a496bd9011bab89101465e02870d977899cc2355c9ffa37e4879e5e6082.
Wynik4bd240539daf848e639c94c5068d52bfbee0466273d7e4be5d7f1351a1b867b4.
[Pełne piny i zakres dowodu](../superpowers/plans/2026-11-08-sushruth-table-one-consistency-audit.md).

(sushruth-figure3-period-audit)=
## Odstępy oscylacji Fig.3 — zakres diagnostyki 11.11.2026

<!-- DOC-ANCHOR:sushruth-figure3-period-audit -->

Cel: odróżnić zmianę początku osi i globalnego znaku od zmiany odstępów
między oscylacjami. Jest to formalizacja wykonanego odczytu rozpoznawczego,
nie ślepa prerejestracja. Nie zmieniamy równań, parametrów, kwadratury ani
zachowanych wartości wzorca. Odczyt rastra nie jest surowymi danymi autorów.

Dla dwóch kolejnych ekstremów tego samego znaku albo zer o tym samym
kierunku przejścia definiujemy obserwowany odstęp:

```{math}
:label: eq-sushruth-figure3-period-measurement

\Delta f_j=f_{j+1}-f_j,\qquad
\Delta f_j\in[f_{j+1}^{-}-f_j^{+},f_{j+1}^{+}-f_j^{-}].
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $f_j$ | częstotliwość j-tego zidentyfikowanego zdarzenia | $\mathrm{Hz}$ |
| $f_j^{-},f_j^{+}$ | dolna i górna granica odczytu zdarzenia | $\mathrm{Hz}$ |
| $\Delta f_j$ | odstęp kolejnych zdarzeń tej samej klasy | $\mathrm{Hz}$ |

Źródła wejściowe są przypięte: oryginalny raster APS1015×1524 oraz gęsty
JSON wzorca o kroku5MHz, jak w rozdziale porównania Fig.3. Analizujemy S
i GSG przy alfa0,01. Nie mieszamy przeciwnych kierunków przejścia przez zero.
Zakres odczytu rastra obejmuje plateau/bracket i dodatkowe pół piksela na
każdym końcu; nie stanowi pełnej niepewności digitizacji. Modelowe ekstrema
mają dodatkowo rozdzielczość siatki, bez interpolacji.

Kryteria odbioru narzędzia: znany sygnał sinusoidalny, brackety zer, odmowa
niejednoznacznych dużych przerw i kontrola tożsamości wejść. Odczyt rzeczywisty
musi zapisać kalibrację osi, okna i maski tekstu, wszystkie częstotliwości,
przedziały i hashe. Wynik nie może ogłaszać przyczyny rozbieżności ani
kwalifikacji solvera. Minima i zera stanowią dodatkowe kontrole względem
wcześniejszych maksimów, ale nie są statystycznie niezależnymi eksperymentami.

Mapa implementacji: scripts/verify_sushruth_2020_figure3_periods.py::audit_periods
oraz scripts/test_sushruth_figure3_periods.py::class Figure3PeriodTests.
Parametry narzędzia to wymagane ścieżki do przypiętych PNG i JSON (typ Path,
jednostka $1$; nieznany digest oznacza odmowę); wyjście CLI jest nową ścieżką
JSON i odmawia nadpisania. Narzędzie nie serializuje się do ProblemIR, nie
zmienia publicznego DSL, planera, sesji ani runtime. Wszystkie cztery realizacje
FDM CPU/GPU i FEM CPU/GPU pozostają poza zakresem tego postprocessingu;
żaden backend Fullmaga nie jest przez niego uruchamiany.

### Wykonany pomiar odstępów — 11.11.2026

Odczyt przypiętych wejść zakończył się poprawnie w0,819s, bez nowej kwadratury
lub solvera. Dla GSG kolejne minima rastra dają odstępy0,25663 i0,24940GHz,
a wzorzec0,370 i0,345GHz. Zera przechodzące od wartości ujemnej do dodatniej
dają odpowiednio0,26386/0,25301GHz oraz0,385/0,385GHz. Dla S różnica jest
również obecna: minima0,26810/0,25452GHz wobec0,390/0,360GHz.
Przedziały odczytu kreski i rozdzielczości modelu dla tych par nie zachodzą
na siebie. Nie są pełnym budżetem niepewności całego porównania.

Surowy JSON zachowuje również małe maksimum modelu S przy7,43GHz poniżej
własnego FMR. Nie traktujemy go jako propagującej fali; wykres diagnostyczny
używa wyłącznie pierwszych dwóch odstępów minimów i zer −→+ dla S i GSG.
Różnica powstaje już przy zestawieniu rysunku z literalnym modelem publikacji.
Nie identyfikuje osobno grubości, materiału, odległości lub konwencji, ani nie
dowodzi błędu autorów lub poprawności solvera Fullmaga. Reprodukcja: NOT VERIFIED.

Sześć lekkich testów narzędzia, w tym niezależny raster o znanym okresie,
przeszło. Źródła równań i zapisany wzorzec pozostają niezmienione.
[Raport, wejścia i piny](../superpowers/plans/2026-11-11-sushruth-figure3-period-audit.md).

(sushruth-finite-k-native-control)=
## Kontrola LLG przy skończonym k — plan pomiaru 11.11.2026

<!-- DOC-ANCHOR:sushruth-finite-k-native-control -->

Cel: zmierzyć rzeczywisty operator demag i ewolucję pojedynczej harmonicznej
w FDM CPU/double. To syntetyczna kontrola modelu jednorodnego po grubości,
bez PMA i wymiany, nie eksperymentalna próbka Co/Ni ani transmisja anteny.
Dotychczasowe k=0 nie kontrolowało dynamicznego demag zależnego od k.

Dla dodatnio określonych sztywności pola w teslach liniowe LLG ma postać:

```{math}
:label: eq-sushruth-finite-k-llg-control

\frac{d}{dt}\begin{pmatrix}a_x\\a_y\end{pmatrix}
=\frac{\gamma_B}{1+\alpha^2}
\begin{pmatrix}-\alpha A_k&-B_k\\A_k&-\alpha B_k\end{pmatrix}
\begin{pmatrix}a_x\\a_y\end{pmatrix},
\quad
A_k=b_e+b_M n(k),\quad B_k=b_e.
```

```{math}
:label: eq-sushruth-finite-k-eigenvalue-control

\lambda_\pm=-\Lambda\pm i\Omega,\qquad
\Lambda=\frac{\alpha\gamma_B(A_k+B_k)}{2(1+\alpha^2)},\quad
\Omega=\frac{\gamma_B}{1+\alpha^2}
\sqrt{A_kB_k-\frac{\alpha^2(A_k-B_k)^2}{4}}.
```

Dla zmierzonego operatora używamy osobno sztywności dyskretnych, bez
przyjmowania z góry zerowego Nyy:

```{math}
:label: eq-sushruth-finite-k-discrete-stiffness

b_{e,d}=1.14\,\mathrm T-b_M N_{zz}(0),\qquad
A_{k,d}=b_{e,d}+b_M N_{xx}(k),\quad
B_{k,d}=b_{e,d}+b_M N_{yy}(k).
```

Sama zgodność średniego okresu i zaniku nie sprawdza lokalnej ewolucji.
Przed rzeczywistym Run dodajemy kontrolę pełnego propagatora:

```{math}
:label: eq-sushruth-finite-k-propagator

\mathbf a_{\rm ref}(t)=e^{-\Lambda\tau}
\left[\mathsf I\cos(\Omega\tau)
+\frac{\mathsf D+\Lambda\mathsf I}{\Omega}\sin(\Omega\tau)\right]
\mathbf a(t_0),\qquad \tau=t-t_0.
```

Macierz D jest macierzą generatora w równaniu liniowego LLG z dyskretnymi
sztywnościami A_k,d i B_k,d. Początkowa amplituda pochodzi z pierwszej próbki;
nie dopasowujemy fazy, czasu ani amplitudy.

| Symbol | Znaczenie | SI |
|---|---|---|
| $a_x,a_y$ | amplitudy kosinusowej harmonicznej magnetyzacji zredukowanej | $1$ |
| $A_k,B_k$ | sztywności pól liniowej odpowiedzi w płaszczyźnie filmu | $\mathrm T$ |
| $\lambda_\pm$ | zespolone wartości własne liniowego LLG | $\mathrm{s^{-1}}$ |
| $\Lambda$ | dodatnia szybkość zaniku amplitudy | $\mathrm{s^{-1}}$ |
| $\Omega$ | dodatnia częstość kołowa tłumionej precesji | $\mathrm{rad\,s^{-1}}$ |
| $\epsilon$ | amplituda początkowej perturbacji poprzecznej | $1$ |
| $N_{zz}(0)$ | statyczny czynnik demag rzeczywiście użytego operatora | $1$ |
| $N_{xx}(k),N_{yy}(k)$ | diagonalne czynniki demag dla badanej harmonicznej | $1$ |
| $b_{e,d}$ | efektywne pole statyczne zmierzonego operatora | $\mathrm T$ |
| $A_{k,d},B_{k,d}$ | sztywności zmierzonego operatora dyskretnego | $\mathrm T$ |
| $\mathsf D$ | macierz generatora liniowej ewolucji amplitud | $\mathrm{s^{-1}}$ |
| $\mathbf a_{\rm ref}$ | kontrolna trajektoria amplitudy poprzecznej | $1$ |
| $t_0,\tau$ | czas pierwszej próbki oraz czas od tej próbki | $\mathrm s$ |

Pozostałe symbole i n(k) są zdefiniowane wcześniej. Wzorzec czasu swobodnego
korzysta z dokładnego liniowego LLG przy zadanym alfa, podczas gdy Eq.1
publikacji pomija część wyrazów tłumienia. Nie utożsamiamy częstości
tłumionej precesji z maksimum zespolonej transmisji.

| Parametr skryptu | Typ i zadana wartość | SI | Walidacja, znaczenie i istniejący kontrakt |
|---|---|---|---|
| LX, LY | float, 1.28e-6, 1.28e-6 | $\mathrm m$ | dodatnie; rozmiar manualnego Universe i Box |
| THICKNESS | float, 20e-9 | $\mathrm m$ | dodatni; jedna warstwa z, jednorodność po grubości |
| NX, NY, NZ | int, 128, 1, 1 | $1$ | dodatnie; cell=(LX/NX,LY/NY,THICKNESS/NZ) |
| IMAGES | int, 4 albo8 | $1$ | osobne przypadki; FdmPeriodicityIR.image_counts=[I,I,0], axes=periodic/periodic/open |
| epsilon w initial_m.json | float, 1e-4 | $1$ | 0<epsilon<1; SampledMagnetization, x+NX*(y+NY*z) |
| k | float, 2pi/LX | $\mathrm{rad\,m^{-1}}$ | dodatni; kosinus na centrach128 komórek |
| Ms | float, 0.89/mu0 | $\mathrm{A\,m^{-1}}$ | dodatni; materiał magnetyka, b_M=0.89T |
| Aex | float, 13e-12 | $\mathrm{J\,m^{-1}}$ | dodatnia wartość materiałowa; exchange jawnie wyłączone |
| alpha | float, 0.01 | $1$ | 0<=alpha<1; materiał magnetyka |
| Bext,z | float, 1.14 | $\mathrm T$ | stałe pole zewnętrzne; brak anizotropii |
| gamma | float, mu0*2pi*30e9 | $\mathrm{m\,A^{-1}\,s^{-1}}$ | dodatni; istniejące study.dynamics.gyromagnetic_ratio |
| fix_dt | float, 0.5e-12 | $\mathrm s$ | dodatni; RK4, istniejący fixed_timestep |
| until | float, 3e-9 | $\mathrm s$ | dodatni; pojedynczy Run, bez Relax lub anteny |
| sampling | float, 2e-12 | $\mathrm s$ | dodatni; tabela oraz pełne pola m i H_demag |

W nieskończonym filmie bez PMA zewnętrzne1,14T minus b_M daje b_e=0,25T.
Dla skończonego sumowania obrazów najpierw mierzymy Nzz(0) i odpowiadające
pole efektywne; nie zmieniamy biasu po obejrzeniu częstotliwości.
Ny=1 i duża komórka po y narzucają ky=0, bez fizycznie otwartych bocznych
brzegów. PBC truncated_images ma81 lub289 składników obrazu, bez podnoszenia
istniejącego limitu. Dwa warianty nie stanowią pełnego dowodu zbieżności
do nieskończonego filmu. Wymagane jest zachowanie metadanych requested/resolved.

Z każdego pełnego snapshotu liczymy projekcję kosinusową i sinusową po x
dla podstawowego k. Czystość kontrolujemy resztą całego m_xy po odjęciu
odtworzonej harmonicznej kosinusowej, obejmując wszystkie pozostałe mody,
a nie tylko wybraną drugą harmoniczną. Normalizacja używa RMS podstawowego
modu. Globalne średnie m_x/m_y nie mierzą tej fali. Częstotliwość mierzymy odstępami przejść a_y od−do+
po początkowych0,25ns, z liniowymi bracketami czasu; FFT okna3ns nie daje
wystarczającej rozdzielczości. Tłumienie kontrolujemy na obwiedni.
Osobno mierzymy Nxx/Nyy i Nzz ze zapisanych pól. Reszta operatora obejmuje
całe H_xy względem odtworzonego diagonalnego pola podstawowego modu;
normalizacja używa Ms i RMS podstawowego modu. Sama reszta po projekcji
nie wystarcza, bo ukrywa obce harmoniczne pola. Porównanie LLG z mierzonym operatorem jest
kontrolą implementacji czasu; nie zmienia parametrów modelu fizycznego.

Kryteria przed wykonaniem: kompletna trajektoria i prawidłowe SI, brak
niezamierzonego Relax/exchange/PMA lub zmiany backendu, perturbacja poprzeczna
pozostająca liniowa, brak brakujących próbek. Błąd częstości względem liniowego
LLG dla zmierzonego operatora ma być <=2e-4 względnie, a szybkości zaniku<=1e-2.
Udział niezamierzonych harmonicznych poprzecznych ma być <1e-3 amplitudy
podstawowej. Zmiana obrazów4→8 oraz różnica wobec n(k) są raportowane oddzielnie;
bez dopasowania i bez automatycznej kwalifikacji źródła anteny lub publikacji.
Przed wykonaniem ustalono granicę reszty znormalizowanej przez Ms i amplitudę
modu:1e-4. Przy jej przekroczeniu oba wnioski zgodności czasu są odrzucane.
Przy istotnym sprzężeniu do składowej sinusowej diagonalny wzorzec ma odmówić
wnioskowania zamiast ukrywać sprzężenie.

Dodatkowy warunek przed Run: maksymalny względny błąd pełnej projekcji a_xy
wobec propagatora ma być <=2e-3, z normalizacją normą a_ref w danej chwili.
To silniejszy, osobny warunek przebiegu, który odrzuca lokalne błędy fazy
nawet przy poprawnym globalnym nachyleniu częstości i zaniku.

Mapowanie źródeł: dwa przykłady poniżej definiują jawny stage-first study;
SampledMagnetization.to_ir, StudyBuilder.pbc/save i StudyStagesBuilder.add_run
z publicznego API przekazują istniejący ProblemIR do plan_fdm.
ExchangeLlgProblem::create_workspace wybiera compute_periodic_newell_kernels
w CPU. record_due_outputs zapisuje pełne pola; odbiór wymaga sąsiedniego
Zarr na ext4 WSL, nie samego stanu CAS lub etykiety Succeeded.
Nie zmieniamy DSL, IR, planera, runtime, zakresu katalogu quantities ani limitów.

| Realizacja | Zakres tej kontroli |
|---|---|
| FDM CPU/double | zaplanowany rzeczywisty Run, jeszcze niewykonany |
| FDM GPU | brak wykonania i brak kwalifikacji w tym eksperymencie |
| FEM CPU | nie dotyczy tej dyskretyzacji; brak nowego dowodu |
| FEM GPU | nie dotyczy tej dyskretyzacji; brak nowego dowodu |

### Wykonany odbiór definicji przed Run

Początkowe128 wektorów są jawnym wejściem
examples/fdm_sushruth_2020_finite_k_initial_m.json, zapisanym przez
fullmag.init.state_io::save_magnetization i czytanym przez
MagnetizationHandle.loadfile. Eksporter wymaga takiej jawnej referencji
dla sampled_field; anonimowy initializer poprawnie odmówił eksportu.
Nie zmieniono tej bramki. Hash wejścia:
3eeae98e974cf05aa30a9c5d30b04db8eb2484b6cf28353fa9357c191a739f72.

Oba skrypty deklarują StageAutosave(state,continuous,zarr) z osobnymi polami
m i H_demag oraz rzeczywistymi czasami każdej próbki. Trzy testy publicznego
authoringu przeszły, w tym pełny IR i autosave po round-trip.
Pierwszych sześć kontroli analizy objęło niezależną ewolucję macierzową,
obce rozmiary, braki czasu, drugi mod przestrzenny, nie-diagonalne pole
i brak chunka Zarr. Przegląd ujawnił trzy dodatkowe kontrprzykłady: trzeci mod
magnetyzacji, trzeci mod pola oraz lokalną modulację czasu przy poprawnym
średnim okresie. Trzy nowe regresje odtworzyły fałszywą akceptację przed poprawką.
Po poprawce wszystkie9 kontroli analizy przeszły; świadkowie są odrzucani.
Odbiór rzeczywistego Run pozostaje niewykonany.

Mapowanie pomiaru: scripts/verify_sushruth_finite_k_control.py::analyze_trajectory,
::_linear_modes i ::read_trajectory. Wymagane argumenty analizy to tablica
times w sekundach oraz dwie skończone tablice[T,128,3]: magnetyzacja
zredukowana o jednostce1 i demag w A/m, bez domyślnych wartości.
Odmowa występuje przy niewłaściwym rozmiarze, brakach, niewłaściwej kolejności,
nieznanym układzie Zarr lub za małej liczbie zer. Funkcja nie uwierzytelnia
runu; provenance musi zostać sprawdzone oddzielnie na rzeczywistym wykonaniu.
Żaden wynik testu syntetycznego nie jest wynikiem Fullmaga.


(sushruth-metal-thickness-filter)=
## Wpływ grubości metalu na porównanie anten — 12.11.2026

To niezależna diagnostyka różnicy **modeli źródła**. W części analitycznej
publikacji przyjęto cienkie paski; równania6–8 zawierają szerokość, szczelinę
i odstęp od filmu, lecz nie grubość metalu. Nasza zachowana geometria ma
metal90nm, szerokość200nm, szczelinę250nm i dolną powierzchnię30nm nad
z=0. Analiza zachowuje całkowity prąd, położenie dolnej powierzchni,
szerokości oraz orientację wszystkich gałęzi.

### Wyprowadzenie i ograniczenia

Dla porównawczego modelu pasków nieskończonych wzdłuż y, jednorodnego
prądu po grubości i płaszczyzny obserwacji poniżej przewodnika każda
warstwa na wysokości $\zeta$ wnosi czynnik $e^{-|k|\zeta}$ z równania6.
Superpozycja daje następujące własne wyprowadzenie:

```{math}
:label: eq-sushruth-metal-thickness-average

h_{t_c}(k;s)
=\frac{1}{t_c}\int_0^{t_c}h_0(k;s+\zeta)\,d\zeta
=F_c(k,t_c)\,h_0(k;s).
```

```{math}
:label: eq-sushruth-metal-thickness-factor

u=|k|t_c,\qquad
F_c(k,t_c)=
\begin{cases}
(1-e^{-u})/u,&u>0,\\
1,&u=0.
\end{cases}
\qquad
|h_{t_c}|^2=F_c^2|h_0|^2.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $k$ | podpisany wektor falowy wzdłuż x | $\mathrm{rad\,m^{-1}}$ |
| $s$ | odstęp dolnej powierzchni od płaszczyzny obserwacji | $\mathrm{m}$ |
| $t_c$ | grubość przewodnika, osobna od grubości magnetyka | $\mathrm{m}$ |
| $\zeta$ | współrzędna warstwy ponad dolną powierzchnią metalu | $\mathrm{m}$ |
| $u$ | moduł wektora falowego razy grubość metalu | $1$ |
| $F_c$ | dodatni rzeczywisty czynnik grubości przy tym samym prądzie | $1$ |
| $h_0$ | sprawność cienkiego źródła z tą samą arbitralną normalizacją co powyżej | $1$ |
| $h_{t_c}$ | sprawność porównawczego źródła o jednorodnym prądzie po grubości | $1$ |

Dla $u>0$ zachodzi $0<F_c<1$; granice $k\to0$ i $t_c\to0$ dają1.
Wyrażenie $-\operatorname{expm1}(-u)/u$ zapobiega utracie cyfr.
To dodatni filtr przestrzenny. Nie obraca samodzielnie fazy o pi.
Zmienia względne wagi różnych k, więc zespolona odpowiedź po całkowaniu
z podatnością może się zmienić. W znormalizowanych R/T z równań9–10
zmienia się także mianownik; nie wolno utożsamiać ich stosunku z $F_c^2$.

Założenia tej diagnostyki nie opisują pełnego obwodu3D: nie obejmują
połączeń końcowych, niejednorodnego RT0 przy narożach, prądów wirowych,
skin/proximity lub ekranowania w magnetyku.
Wysokość cienkiego źródła musi być jawna. Powyższe $F_c$ odnosi się do
paska na dolnej powierzchni metalu. Dla porównawczego cienkiego paska
w środku metalu definiujemy odrębny czynnik:

```{math}
:label: eq-sushruth-metal-midplane-factor

h_{\mathrm{mid}}(k;s)
=e^{-|k|t_c/2}h_0(k;s),\qquad
F_{\mathrm{mid}}(k,t_c)
=\frac{h_{t_c}}{h_{\mathrm{mid}}}
=e^{u/2}F_c
=\frac{\sinh(u/2)}{u/2},\quad F_{\mathrm{mid}}(0)=1.
```

Iloraz jest rozumiany jako czynnik modeli, również w granicy zer widma.
Środek zachowanego metalu jest na75nm, dolna powierzchnia na30nm.
Wysokości30/75nm są współrzędnymi względem z=0. Dla płaszczyzny
obserwacji poniżej z=0 odstęp w równaniu6 otrzymujemy, odejmując jej
współrzędną od wysokości źródła. Czynniki grubości pozostają takie same,
gdy oba modele obserwujemy w tej samej płaszczyźnie poniżej metalu.

To dwie jawne aproksymacje tego samego rozkładu prądu, bez zmiany
istniejącego źródła lub dobierania efektywnego s do wyników.
$F_{\mathrm{mid}}\ge1$, więc nie wolno porównywać liczb dla dolnej
powierzchni tak, jakby dotyczyły cienkiego paska w środku.

| Symbol | Znaczenie | SI |
|---|---|---|
| $h_{\mathrm{mid}}$ | sprawność porównawczego cienkiego źródła w środku metalu | $1$ |
| $F_{\mathrm{mid}}$ | czynnik grubości względem tej płaszczyzny | $1$ |


Nie jest to korekta
nakładana na natywne H ani granica jego błędu. Nie wykonujemy FFT
niejednorodnych92próbek; źródłem są wyłącznie przypięte parametry geometrii.

### Parametry i mapowanie implementacji

| Interfejs/parametr | Typ; default | SI | Walidacja, znaczenie i mapowanie |
|---|---|---|---|
| `metal_thickness_factor.k_rad_per_m` | float/int; required | $\mathrm{rad\,m^{-1}}$ | skończony, signed, bez bool; używany moduł k |
| `metal_thickness_factor.metal_thickness_m` | float/int; required | $\mathrm{m}$ | skończony≥0, bez bool; zero to jawna granica cienkiego metalu |
| `geometry_filter_report.parameters_si` | dict; required | jednostki pól poniżej | wymagane cztery pola: width/gap/metal/insulator; pozostałe parametry zachowanego obwodu są metadanymi wejścia |
| `conductor_width_m` | float; required200e-9 w zachowanej geometrii | $\mathrm{m}$ | dodatni; zachowana szerokość, nie parametr dopasowania |
| `gap_m`, `insulator_thickness_m` | float; required250e-9 i30e-9 w zachowanej geometrii | $\mathrm{m}$ | nieujemne; zachowane szczelina i dolny odstęp |
| `metal_thickness_m` | float; required90e-9 w zachowanej geometrii | $\mathrm{m}$ | nieujemny; różnicuje porównawcze źródło cienkie i grube |
| `WAVENUMBERS_RAD_PER_M` | tuple; zamknięte0/1/3/5/7/10/20×1e6 | $\mathrm{rad\,m^{-1}}$ | punkty kontroli ustalone przed wykonaniem; nie są siatką FFT, modem ani wynikiem LLG |

Brak nowego publicznego API Python, ProblemIR, planera, formatu V/J/H,
runtime/session lub publikacji bazy. `scripts/antenna_metal_thickness_diagnostic.py::metal_thickness_factor`
realizuje czynnik; `::geometry_filter_report` porównuje modele.
Źródło parametrów:
`examples/sushruth_2020_closed_gsg/edge_field_20261111/verification/edge-field-comparison.json`,
SHA256 `615f0e95379fe39cba2a93eacdd13f35acdd1256bb88c8708c16b4b665a325bf`.
Odczyt tych parametrów nie jest porównaniem z wartościami natywnego H.

| Realizacja | Status diagnostyki |
|---|---|
| FEM CPU | niezależna algebra porównawcza; nie dowodzi wykonania FEM lub zbieżności RT0 |
| FEM GPU | brak wykonania/parytetu; ta sama algebra nie jest kwalifikacją urządzenia |
| FDM CPU | nie uruchamia FDM; brak kwalifikacji pola obliczanego przez aplikację |
| FDM GPU | brak wykonania/parytetu i bez fallbacku |

### Weryfikacja i rozdzielenie dwóch rozbieżności

Kontrole obejmą całkę po grubości policzoną niezależną kwadraturą,
przypadek $u=1$, granicę cienkiego metalu, signed k, monotoniczność,
walidację i wykonanie na zachowanych parametrach w istniejącym
kontenerze przez receptę interpretowaną. Wykonano137/137testów, w tym6kontroli tego modułu; rzeczywiste zapisane
wymiary przeliczono w istniejącym kontenerze przez interpretowaną receptę just.
Niezależna kwadratura, oba położenia cienkiego źródła i granice przechodzą.
To diagnostyka modeli; nowe native V/J/H i kwalifikacja źródła: NOT VERIFIED.
Pełny nowy V/J/H i referencje fine pozostają osobnym etapem.

Wcześniejszy wzorzec Fig.3,
`scripts/reference_sushruth_2020_response.py::inductive_response`,
korzysta już z cienkiego widma
`scripts/reference_sushruth_2020_antenna_spectrum.py::antenna_spectra`.
Jego `film_thickness_m` opisuje magnetyk, nie metal. Zatem różnica90nm
może dotyczyć porównania przyszłego źródła3D z modelem publikacji,
ale nie wyjaśnia dawnej rozbieżności między naszym cienkim wzorcem
równań1–10 a Fig.3. Nie podmieniamy parametrów ani historycznego FAIL.
Bibliografia i źródło równania6: Sushruth i in., DOI powyżej.


(sushruth-figure3-axis-and-annotation-recheck)=
## Osie i adnotacja FMR — kontrola 13.11.2026

Nie należy nazywać odczytu szarej kreski **zmierzonym rezonansem materiału**.
Wartość około7,208GHz w starszej tabeli powyżej jest historyczną pozycją
adnotacji w panelu(a). Nie jest niezależnym pomiarem FMR ani parametrem,
który można wstawić do modelu w miejsce TableI. W panelu(e) ta sama
adnotacja ma inną współrzędną częstotliwości. Dopuszczenie arbitralnego
przesunięcia krzywej na tej podstawie ukrywałoby nierozstrzygnięte założenia
generatora rysunku.

Oryginalny raster APS i Fig03.png ze źródeł arXiv sprawdzono osobno.
Przypięte hashe obrazów podano w istniejących sekcjach; nowy
`figure3_raster_calibration_20261113/preregistration.json` zachowuje je ponownie,
razem z oknami pomiaru i ręcznie odczytanymi tickami, przed wykonaniem kontroli.
Nie pobierano nowych rysunków, nie modyfikowano ich i nie uruchamiano TeX.

Kalibracja każdego panelu stosuje jego własną ramkę:

```{math}
:label: eq-sushruth-raster-axis-calibration

f(p)=10^9\,\mathrm{Hz}\left[
6+3\,\frac{p-p_{\mathrm L}}{p_{\mathrm R}-p_{\mathrm L}}
\right].
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $f(p)$ | Częstotliwość odpowiadająca współrzędnej obrazu, nie estymator rezonansu | $\mathrm{Hz}$ |
| $p$ | Pozioma współrzędna obrazu liczona od zera | $1$ |
| $p_{\mathrm L}$ | Współrzędna lewej ramki danego panelu | $1$ |
| $p_{\mathrm R}$ | Współrzędna prawej ramki danego panelu | $1$ |

Implementacja `affine_frequency` zwraca liczbę w GHz, a jawny czynnik
$10^9\,\mathrm{Hz}$ powyżej określa jej przeliczenie do SI.
Nie korzysta z podatności, siatki FEM, prądu ani pola.

| Raster / panel | Lewa i prawa ramka [piksel] | Niezależne ticki7GHz;8GHz [piksel] |
|---|---|---|
| APS(a) | 92;534 | 239–240;387 |
| APS(e) | 588;1003 | 726;864–865 |
| arXiv(a) | 478;2587 | 1181;1884 |
| arXiv(e) | 2844;4825 | 3504;4164–4165 |

Pięć ręcznie odczytanych ticków6,5–8,5GHz na każdy z czterech paneli
mieści się w zarejestrowanej tolerancji jednego piksela. To kontrola
kalibracji po oględzinach, **nie OCR** ani pełny budżet niepewności
rysunku. Kadrowanie i szerokości paneli nie wyjaśniają wcześniejszej
różnicy okresów około1,4.

Dla rastra APS dodatkowo odczytano pełne pasma ramek i szarej kreski.
Przedział poniżej obejmuje wszystkie kombinacje ich krańców po dodaniu
pół piksela do każdego pasma; nie jest przedziałem ufności materiałowego FMR.

| Panel | Przedział położenia adnotacji z ramką/pikselem [GHz] |
|---|---|
| (a) | 7,187783–7,228507 |
| (e) | 7,127711–7,171084 |

Przedziały są rozłączne. Zatem nie wyznaczają jednego wspólnego
parametru rezonansu. Model z literalnymi wielkościami TableI nadal ma
częstotliwość jednorodną7,5GHz; kontrola rastra nie zmienia parametrów
ani nie rozstrzyga, jakich wartości użył generator publikacji.

### Poprawka narzędzia i wykonany odbiór

W `scripts/plot_sushruth_2020_response_reference.py::measure_figure3_anchors`
domyślny panel(a) wcześniej wykonywał `argmax` również dla pustej maski.
Dla całkowicie brakującej kreski taki algorytm zwracałby około6,447964GHz.
Wspólny `measure_gray_annotation_pixels` wymaga teraz jednej ciągłej
kreski o zarejestrowanym pionowym pokryciu; brak albo kilka rozdzielonych
pasm daje odmowę. Oba panele zwracają
`annotation_is_measured_fmr=False`. Stare nazwy `published_FMR_marker_*`
pozostają aliasami **odczytu rysunku**, nie pomiaru fizycznego.
Nie są nowymi quantity, parametrami materiałowymi ani polem ProblemIR.

Wykonana kontrola zachowała każde stare pole i wartość rzeczywistego
odczytu obu paneli. Dodała wyłącznie jawny zakres i interpretację.
18 interpretowanych testów rastra i okresów przeszło; obejmują brak/split
adnotacji, niezależne ramki, dystraktory oraz znany okres i kierunek zer.
Nie kompilowano testów native.

Zachowane przedziały pierwszych dwóch odstępów minimów i zer rosnących
GSG z Fig.3 nie zachodzą na przedziały literalnego modelu. Stały dodatek
do częstotliwości nie zmienia odstępów; wniosek pozostaje niezależny od
położenia szarej kreski. **Przyczyna różnicy jest nadal nierozstrzygnięta**.
Ta kontrola nie kwalifikuje pełnego źródła3D, pola w całej próbce,
transmisji, RF ani LLG.

Nie zmieniono publicznego Python DSL, ProblemIR, planera, runtime,
formatu wyników anteny lub istniejących rezultatów. Dla FDMCPU, FDMGPU,
FEMCPU i FEMGPU niniejszy odbiór jest **nie dotyczy wykonania backendu**:
jest postprocessingiem obrazu i zachowanych liczb, bez nowego Solve.
Status kwalifikacji backendów z wcześniejszych tabel pozostaje bez zmian.

Dowód:
`examples/sushruth_2020_closed_gsg/figure3_raster_calibration_20261113/result.json`,
SHA256 `17f9644da3273e7ea8d9f3af89cff060682674e06ceba19fd1ed7f3a09b4881a`, oraz `tests.log`.
JSON zachowuje osobno brak estymaty materiałowego FMR,
`cause_resolved=false`, `publication_reproduced=false`, zerową liczbę
nowych całkowań, transportu i LLG. Historyczne artefakty nie zostały
nadpisane.


(sushruth-figure1-field-fft-sampling)=
## Próbkowanie pola i konwencje transformaty — kontrola niezależna

Zadanie dotyczy osobno pola w przestrzeni i jego transformaty, nie zagęszczania
samej osi modelu A(k). Publikacja Eq6–8 używa operatora translacji z dodatnim
wykładnikiem. Istniejący kernel Fullmaga używa ujemnego wykładnika i lokalnego
środka płaszczyzny. Brak uwzględnienia tej różnicy odwraca część urojoną GS
przy zachowaniu mocy. Nie dowodzi to przyczyny rozbieżności dynamicznej Fig3.

Dla prądu+Y i obserwacji poniżej przewodnika całka prawa Biota–Savarta po
nieskończonym kierunkuY i po szerokości daje:

```{math}
:label: eq-sushruth-real-space-field-fft-reference

h_x(x;s,0)=\frac{H_x(x)}{I}
=-\frac{1}{2\pi L}\left[
\arctan\frac{x+L/2}{s}-\arctan\frac{x-L/2}{s}\right],
\qquad
h_x(x;s,t_c)=\frac{1}{t_c}\int_s^{s+t_c}h_x(x;a,0)\,da .
```

Pierwszy wzór dla dodatniego odstępu; dla zerowego przyjmujemy jednostronny
ślad pola pod idealną warstwą: −1/(2L) pod paskiem, zero na zewnątrz, połowę
wartości na krawędzi. Nie tworzymy zerowej grubości siatki FEM.
Drugą całkę liczymy niezależną kwadraturą warstw Gaussa16 i sprawdzamy32.
Kontrola testowa używa osobnej dwuwymiarowej całki po przekroju, bez atan.

```{math}
:label: eq-sushruth-sampled-field-fourier-convention

x_j=-R+(j+\tfrac12)\Delta x,\quad N\Delta x=2R,\quad
k_n=\frac{2\pi n}{N\Delta x},\quad \Delta k=\frac{2\pi}{N\Delta x},
\qquad
\widehat h^-_n=\Delta x\,e^{-ik_nx_0}
\sum_{j=0}^{N-1}h_x(x_j)e^{-i2\pi nj/N},
\quad A^-_n=-2\widehat h^-_n,\quad A^+(k)=A^-(-k).
```

Dla rzeczywistego pola ostatnią równość realizujemy sprzężeniem amplitudy
przy dodatnimk. Nie jest to dopasowanie fazy. Mnożnik−2 wynika z całki pola
pojedynczego paska po całej prostej równej−1/2 na amper, nie z normalizacji
zmierzonego maksimum lub zera. Znak prądu pozostaje niezmieniony.

| Symbol | Znaczenie | SI |
|---|---|---|
| $H_x$ | Fizyczne pole źródła w kierunkuX | $\mathrm{A\,m^{-1}}$ |
| $h_x(x;s,t_c)$ | Pole na jednostkę prądu poniżej paska | $\mathrm{m^{-1}}$ |
| $x,x_j,x_0$ | Fizyczna pozycja próbki i pierwszy punkt | $\mathrm m$ |
| $s$ | Odległość od płaszczyzny obserwacji do dolnej powierzchni metalu | $\mathrm m$ |
| $t_c$ | Grubość przewodnika | $\mathrm m$ |
| $L$ | Szerokość jednorodnego paska | $\mathrm m$ |
| $a$ | Wysokość warstwy źródła nad obserwacją | $\mathrm m$ |
| $I$ | Podpisany prąd paska w kierunku dodatnimY | $\mathrm A$ |
| $R$ | Połowa okresowego okna całkowania | $\mathrm m$ |
| $\Delta x$ | Odstęp próbek w przestrzeni | $\mathrm m$ |
| $k,k_n,\Delta k$ | Wektor falowy, bin i odstęp binów | $\mathrm{rad\,m^{-1}}$ |
| $N,j,n$ | Liczba próbek i indeksy całkowite | $1$ |
| $A^-,A^+$ | Bezwymiarowe amplitudy obu konwencji | $1$ |
| $\widehat h^-_n$ | Przestrzenna całka pola na amper | $1$ |
| $i$ | Jednostka urojona transformaty | $1$ |
| $\pi$ | Stała kołowa | $1$ |

| Parametr / interfejs | Typ / default | SI | Walidacja, zakres i wpływ na ProblemIR |
|---|---|---|---|
| width_m | float /200e-9 | $\mathrm m$ | Dodatni; szerokość każdego paska; brak nowego IR |
| gap_m | float /200e-9 lub250e-9 | $\mathrm m$ | Nieujemny; jawne przypadki, bez fitu |
| spacing_m | float /0 lub43.7e-9 | $\mathrm m$ | Od obserwacji do dolnej powierzchni, nie współrzędna worldz |
| thickness_m | float /0 lub90e-9 | $\mathrm m$ | Zero oznacza model analityczny warstwy, nie geometrię native |
| layer_order | int /16, kontrola32 | $1$ | Co najmniej2; niezależna kontrola zmiany warstw |
| half_width_m | list[float] /8,16,32,64µm | $\mathrm m$ | Okno i jego zbieżność niezależne od kroku |
| step_m | list[float] /50,25,12.5,6.25nm | $\mathrm m$ | Co najmniej4próbki, rosnące jednolite pozycje; bez resamplingu |
| maximum_k_rad_per_m | float /30e6 | $\mathrm{rad\,m^{-1}}$ | Tylko fizyczne dodatnie biny wraz z zerem |
| normalization / window | integral_si / rectangular | $1$ | Bez odjęcia średniej, paddingu i korekcji coherent gain |
| criteria / output-dir | Path / wymagane | $1$ | Kryteria przed wynikiem; wynik nie nadpisuje katalogu |
| progi amplitudy/mocy | float /1e-3,8e-3 | $1$ | Na najgęstszej siatce; moc S ma jawny czynnik4 |
| progi przyrostów | float /2e-3,1e-3 | $1$ | Osobno zmiana kroku i zmiana okna |
| próg warstw16/32 | float /1e-10 | $1$ | Max różnicy podzielone przez max pola, bez dzielenia przez zero pola |

Trzy przypadki: (g,s,t_c)=(200,0,0)nm dlaFig1; (200,43.7,90)nm dla
samego wpływu wysokości i grubości; (250,43.7,90)nm dla nominalnego przekroju
zachowanejGSG. Wysokość43.7nm wynika z30nm izolatora,5nm capu i8.7nm
do środka stosu magnetycznego. To trzy różne modele, nie te same wyniki.
Wszystkie zakładają uniform current, nieskończoneY, brak końców i ekranowania.
Nie kwalifikują skończonej zamkniętej pętli, taperu, zachowanego RT0 lub LLG.

Biny porównujemy bez interpolacji. Kontrola kroku używa tego samego okna;
kontrola okna używa tego samego kroku i wspólnych binów dwóch okresów.
Padding nie zwiększa rozdzielczości fizycznej ani nie zastępuje kontroli okna.
Publiczny kernel ma2D endpoint-inclusive sampling, a ten test1D używa
środków komórek; nie utożsamiamy liczbyN z samym zasięgiem między endpointami.
Dla translacyjnie niezmiennegoY redukcja publicznego binu k_v0 wymaga dzielenia
przez rzeczywistą wagę sumowania poY, a nie automatycznie przez geometryczną
szerokość. Dla pełnego obwodu3D nie zakładamy takiej niezmienności.

### Mapowanie, realizacje i stan odbioru

Prywatny skrypt nie dodaje klasy publicznego Python, ProblemIR, planera,
runtime stage, formatu danych lub możliwości kwalifikowanej bazy.
Python→IR, capabilities i requested/resolved provenance pozostają bez zmian.
CSV zawiera fizyczne x oraz Hx/I, a oddzielnie k, obie fazy amplitudy i wzorzec.
Kryteria i piny kodu są zachowane w wynikach. Regresje6nowych+19istniejących
przeszły. Wykonano144profile w3.505s,peakRSS99.9MiB; wszystkie uprzednie kryteria przechodzą. Największy błąd amplitudy wynosi8.824e-4, mocy7.056e-3, przyrost kroku1.677e-3 i okna8.824e-4. Wyniki, wejścia,25testów i obraz są w examples/sushruth_2020_closed_gsg/figure1_sampling_20261115/raport-probkowania-i-konwencji.md. Nie uruchomiono Fullmaga.

| Realizacja | Zakres tego eksperymentu | Kwalifikacja |
|---|---|---|
| FDM CPU | Niezależny Python, bez solvera FDM | NOT VERIFIED |
| FDM GPU | Brak wykonania GPU | NOT VERIFIED |
| FEM CPU | Brak nowego pola native, audyt źródeł FFT | NOT VERIFIED |
| FEM GPU | Brak wykonania GPU | NOT VERIFIED |

Standardowy start3203 odmówił ze względu na niezdrowy backend. Nie rozwijamy
recovery i nie omijamy publicznej kontroli pochodzenia pola. Wynik odniesienia
pozostaje referencją, nawet gdy przejdzie własne kryteria.

Plan walidacji: fizyczny znak prawej dłoni, bezwzględne jednostki, przesunięty
origin, zespolona faza GS, odrzucenie niejednorodnych próbek, osobna całka
Biota–Savarta po przekroju, siatki przestrzenne i okna. Pozostałe: rzeczywiste
pole Fullmaga na zgodnym nośniku, skończona długość i zamknięcie obwodu,
pełna kwalifikacja oraz kolejne wyniki publikacji.


(sushruth-retained-rt0-line-spectrum)=
## Niezależne widmo z zachowanego prądu3D — prerejestracja15.11.2026

To postprocessing referencyjny zapisanego RT0, bez nowego transportu, H-only,
DLL, runtime i natywnego spectrum. Nie publikuje zaakceptowanej bazy i nie
zmienia statusu inspection-only. Pozwala oddzielić całkowanie po źródle od
ograniczonego okna obserwacji. Wspólne prawo Biota–Savarta pozostaje w nocie0950.

Dla obserwacji $\mathbf r=(x,y_0,z_0)$ i źródła $\mathbf r'$ przyjmujemy:
```{math}
:label: eq-sushruth-retained-line-kernel

\Delta y=y_0-y',\quad\Delta z=z_0-z',\quad
a^2=(\Delta y)^2+(\Delta z)^2,\quad q=|k|,\quad u=qa,
\qquad
\widehat H_x^+(k;y_0,z_0)=
\frac{1}{2\pi}\int_{\Omega_c}
[J_y(\mathbf r')\Delta z-J_z(\mathbf r')\Delta y]\,
\frac{uK_1(u)}{a^2}e^{ikx'}\,dV',
\quad \lim_{u\to0}uK_1(u)=1,\qquad A=-2\widehat H_x^+/I_\mathrm{ref}.
```

Całka po $x$ w prawie Biota–Savarta daje $2qK_1(qa)/a$:
[DLMF10.32.E11](https://dlmf.nist.gov/10.32.E11), z granicą
[DLMF10.30.E2](https://dlmf.nist.gov/10.30.E2). Czynnik2 skraca4π do2π.
Nie ma μ0: obliczamy H, nie B. Wzór uwzględnia pełną geometrię i wszystkie
składowe źródła wpływające na Hx; nie zakłada niezmienności poY.
Wymagamy zwartego całkowalnego prądu i dodatniego oddalenia linii od źródła:
w tym przypadku cały metal jest nad płaszczyzną obserwacji. Wtedy można
zamienić całki; całka bezwzględna ma ograniczenie przez stałą razy normę L1
prądu. Dla zwartej, bezdywergencyjnej zamkniętej pętli ponad płaszczyzną
prawo Ampère'a wymaga zerowej całki Hx po całej osi x dla k0.
Nie wymuszamy tego zera numerycznie: jest oddzielną diagnostyką, nie fit.

Wykorzystujemy tę samą rekonstrukcję RT0 co zachowany source:
```{math}
:label: eq-sushruth-retained-rt0-volume-cancellation

D_T=\det(v_1-v_0,v_2-v_0,v_3-v_0)>0,\quad
J(\mathbf r)=\frac{\sum_{i=0}^{3}c_i(\mathbf r-v_i)}{D_T},
\quad c_i=2\Phi_i,\qquad
J(\mathbf r_q)\,dV_q=w_q^\mathrm{ref}
\sum_{i=0}^{3}c_i(\mathbf r_q-v_i),\quad
\sum_q w_q^\mathrm{ref}=1/6.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $\mathbf r,\mathbf r',v_i,\mathbf r_q$ | Pozycja obserwacji, źródła, wierzchołki i próbka kwadratury | $\mathrm m$ |
| $x,x',y_0,z_0,y',z',\Delta y,\Delta z,a$ | Współrzędne, różnice i odległość poprzeczna | $\mathrm m$ |
| $\Omega_c,dV'$ | Źródłowy przewodnik i miara objętości | $\mathrm{m^3}$ |
| $J,J_y,J_z$ | Prąd i składowe jego gęstości | $\mathrm{A\,m^{-2}}$ |
| $k,q$ | Podpisany wektor falowy i jego moduł | $\mathrm{rad\,m^{-1}}$ |
| $u,K_1(u)$ | Argument i zmodyfikowana funkcja Bessela drugiego rodzaju | $1$ |
| $\widehat H_x^+$ | Jednowymiarowa transformata Hx z dodatnim wykładnikiem | $\mathrm A$ |
| $I_\mathrm{ref},c_i,\Phi_i$ | Podpisany prąd źródła, współczynnikRT0, strumień ściany | $\mathrm A$ |
| $D_T,dV_q$ | Sześciokrotność objętości dodatniego Tet4 i miara próbki | $\mathrm{m^3}$ |
| $w_q^\mathrm{ref},A,i,\pi$ | Waga na referencyjnym Tet4, amplituda, jednostka urojona, stała kołowa | $1$ |

| Parametr / interfejs | Typ / default | SI | Walidacja i rola / ProblemIR |
|---|---|---|---|
| frozen source | bytes / wymagane | $1$ | Parser sprawdza22payloady i SHA; pack_rt0 kontroluje dodatnią orientację i zachowuje momenty; brak nowego IR |
| observation_y_m / observation_z_m | float /0,-13.7e-9 | $\mathrm m$ | Linia pod całym metalem; minimum odstępu43.7nm |
| k_rad_per_m | list[float] /0…30e6 co1e6 | $\mathrm{rad\,m^{-1}}$ | Skończone, signed w interfejsie; pilot31punktów, nie gęsty odbiór Fig1 |
| quadrature_orders | list[int] /2,3,4 | $1$ | Tensorowe Gauss–Duffy:8,27,64punkty/Tet; brak zdegenerowanej geometrii |
| check_order / check_k | int/list /6;0,1,3,6,12,20,30e6 | $1$ / $\mathrm{rad\,m^{-1}}$ | Niezależne zagęszczenie do216punktów/Tet na7wybranych k |
| progi przyrostów | float /1e-3,1e-3 | $1$ | Max bezwzględnej różnicy A dla3→4 i4→6, bez dzielenia przez zero widma |
| próg zera Ampère'a | float /1e-4 | $1$ | Kontrola A(k0), bez ręcznego odejmowania DC |
| test pryzmatu | float /1e-6 | $1$ | Pole/normalizacja względem niezależnego całkowania i antypochodnej |
| zasoby | CPU1, pamięć do2048MiB | $1$ | Tylko prywatny proces Python; pomiar czasu iRSS; bez zmian polityk runtime |

Numerator RT0 liczymy ze względnych krawędzi w longdouble; determinant
skraca się z miarą i nie dzielimy przez bardzo małe D. Funkcja K1 i faza
używają double; sumy rzeczywiste/urojone longdouble. Raportujemy sumę
modułów składników i redukcję przez cancellation, bez gwarancji błędu
wynikającej wyłącznie z różnicy dwóch reguł kwadratury.

Pełny source ma85980Tet4,23263wierzchołki,188926momentów; metal90nm,
szerokość pasków200nm,szczelinę250nm i końce przyY±12µm.
Referencja porównawcza ma te same szerokości,szczeliny i pionową warstwę,
ale nieskończone proste paski z jednorodnym prądem. Jest innym modelem.
Zbieżność kwadratury nie potwierdza zbieżności J ani małego wpływu końców.

### Mapowanie, walidacja i realizacje

Prywatny Python: scripts/reference_retained_rt0_spectrum.py +
tetra_rule, rt0_sample_moment, line_kernel, field_spectrum, run_reference.
Źródło: tools/gsg_surface_native_probe.py + read_bundle, pack_rt0,
backends/fem/cpu/mfem/transport/affine_rt0_element.cpp +
AffineRt0Element::retained_current_at. Testy: scripts/test_reference_retained_rt0_spectrum.py +
class RetainedSpectrumTests. Nie dodajemy publicznej klasy Python, ProblemIR,
planera, capabilities, runtime stage, formatu pola lub zaakceptowanej bazy.
Requested/resolved execution starego wyniku pozostaje zachowane; nowe
provenance odnosi się tylko do referencyjnego postprocessingu.
Dla FDM CPU/GPU i FEM CPU/GPU nie jest to nowe wykonanie backendu:
wszystkie cztery lane dla tego widma pozostają NOT VERIFIED.
Kontrole: objętość i momenty liniowe Tet4, stałe J, niezależna całka
cosinusowa, skończony pryzmat, faza przesunięcia, odwrócenie prądu,
wkład Jz oraz odmowa przecięcia źródła. Pilot wykonano:3→4=1.69812e-4,4→6=4.30242e-6 i A(k0)=6.17174e-8, przy progach1e-3/1e-3/1e-4. Czas58.94s iRSS210.22MiB. BłądL2 względem zgodnego przekroju nieskończonego wynosi6.6150e-6 na31k; nie jest to porównanie z idealnąFig1. Siedem nowych regresji przechodzi. Po pilocie prerejestrowano gęstą kontrolę241k, n4 oraz n6 na61k i kroki1/0.5/0.25/0.125rad/µm; progi przyrostuA1e-3, zmiany położenia maksimum0.125rad/µm i mocy1e-3. To nadal postprocessing referencyjny.
Piny i kryteria przed obliczeniem: examples/sushruth_2020_closed_gsg/
figure1_retained_spectrum_20261115/criteria-preregistered.json.
Pozostałe: gęsty profil, publiczny native field/spectrum, zbieżność źródła,
granica cienkich/długich pasków oraz Fig2,3,4,6.



### Wykonany odbiór gęstego postprocessingu i zapisanych Hx

Przetworzono pełne85980Tet4 bez ponownego V/J/H. Gęsty przebieg ma241k
na0–30rad/µm z krokiem0.125rad/µm; n6 sprawdzono na61k.
Przyrost4→6 wynosi4.3663121e-06, dyskretne względneL2 wobec zgodnego
przekroju nieskończonego wynosi6.57720842e-06 dla n4 i1.31660572e-07 na61k dla n6.
To różnica dwóch określonych modeli, nie błąd względem idealnejFig1.
Zwiększenie n obniża różnicę, więc wynik n4 nie jest samą miarą efektu
skończonej długości. Kryteria próbkowania i kwadratury przeszły;32powiązane
testy są zielone. Pełny proces gęsty trwał260.72s, sama faza obliczeń258.57s,
RSS fazy obliczeń171.27MiB; pamięci całego procesu z renderem nie zmierzono.

Wspólny węzeł maksimum na kilku siatkach nie wystarcza do lokalizacji piku.
Osobno prerejestrowano i wykonano33k z n6 w5.75–6.25rad/µm.
Ostatni krok wynosi0.015625rad/µm; maksimum próbkowane wypada przy
5.96875rad/µm z mocą
1.134861314, tak samo jak referencja na tej siatce.
To lokalizacja na siatce, bez twierdzenia o dokładnym maksimum ciągłym.

Niezależnie odczytano20uprzednio zapisanych natywnych Hx w A/m, sprawdzając
SHA całego bundle i wszystkich22payloadów. Normalizacja używa signed
Iref=1.7551508469637155e-5A, bez fitu. WzględneL2 wobec modelu
nieskończonych pasków o tych samych wysokościach wynosi
1.30705513e-07; max różnicy wynosi
0.3346264431/m.
To rzeczywiste stare Hx Fullmaga, a nie wynik nowego kernela referencyjnego.
Dwadzieścia próbek nie kwalifikuje całej mapy, Hy/Hz, widma ani źródła.

Kontrolowane zmiany analityczne (maxima na tej samej siatce241k):
g200/s0/t0 daje3.271063; zmiana g250 daje3.409697;
dodanie wysokości43.7nm daje1.924044; dodanie grubości90nm daje1.134687.
Przesunięcie i obniżenie widma wynikają w tych modelach z jawnych parametrów,
bez korekcji amplitudy lub fazy. To nie diagnoza dawnej rozbieżności Fig3.
Dowody: examples/sushruth_2020_closed_gsg/figure1_retained_spectrum_20261115/
raport-zachowanego-pradu-i-widma.md, dense-results/results.json,
native-hx-point-comparison.json i peak-results.json.
Natywne spectrum, kwalifikacja źródła i pełna reprodukcja Fig1 pozostają
NOT VERIFIED; Fig2,3,4,6 są nadal otwarte.



(sushruth-retained-source-stability)=
## Stabilność dwóch zapisanych źródeł GSG — prerejestracja15.11.2026

Porównujemy zachowane40728Tet4 i85980Tet4, nie uruchamiając nowegoSolve.
Audyt zachowanych authoring_receipt i conductivity potwierdził te same:
geometrię, obwód, źródło, port, metodę transportu, tolerancje, backend_policy
i requested_execution. Pięć regionów ma tę samą przewodność3.5e7S/m.
Zmiana hmin i ośmiu stref naroży25→12.5nm jest jawna, lecz dwa wykonania
mają różne dirtyruntimeversions. Nie dowiedziono tożsamości kodu, więc
wniosek dotyczy stabilności tych dwóch zapisanych rozwiązań, nie czystego
mesh-only eksperymentu ani rzędu asymptotycznego.

Dodatkowo do pola porównujemy objętościową normę zachowanego prądu.
Dla RT0 całka kwadratu jest analityczna, bez kwadratury pola:
```{math}
:label: eq-sushruth-retained-current-volume-norm

\bar v_T=\frac14\sum_{i=0}^{3}v_i,\quad
s_T=\sum_{i=0}^{3}c_i,\quad
F_T=\sum_{i=0}^{3}c_i(\bar v_T-v_i),\qquad
Q_T=\int_T|\mathbf J_T|^2\,dV
=\frac{|F_T|^2+\frac{s_T^2}{20}\sum_{i=0}^{3}|v_i-\bar v_T|^2}{6D_T},
\quad
C_J=\frac{\sum_TQ_T}{I_\mathrm{ref}^2},\qquad R_J=C_J/\sigma.
```

Czynnik1/20 jest śladem kowariancji jednostajnej miary na Tet4:
pierwszy moment barycentryczny1/4, drugi diagonalny1/10 i mieszany1/20.
R_J jest rezystancją równoważną dyssypacji wyliczoną ze źródłowego RT0
przy jednorodnej dodatniej przewodności. Nie zastępuje osobnego sprawdzenia
zgodności J=σE lub mocy dostarczanej przez źródło. Nie dodajemy termiki.

| Symbol | Znaczenie | SI |
|---|---|---|
| $\bar v_T,v_i$ | Środek i cztery wierzchołki tetraedru | $\mathrm m$ |
| $s_T,c_i,I_\mathrm{ref}$ | Suma współczynników, współczynnik i podpisany prąd normalizacji | $\mathrm A$ |
| $F_T$ | Licznik RT0 w środku komórki | $\mathrm{A\,m}$ |
| $D_T$ | Dodatni determinant sześciokrotnej objętości | $\mathrm{m^3}$ |
| $\mathbf J_T$ | Gęstość prądu w komórce | $\mathrm{A\,m^{-2}}$ |
| $Q_T$ | Całka kwadratu prądu w komórce | $\mathrm{A^2\,m^{-1}}$ |
| $C_J$ | Norma prądu na kwadrat prądu źródła | $\mathrm{m^{-1}}$ |
| $\sigma$ | Jednorodna przewodność | $\mathrm{S\,m^{-1}}$ |
| $R_J$ | Rezystancja równoważna dyssypacji RT0 | $\Omega$ |
| $T,i,dV$ | Tetraedr, indeks wierzchołka i miara objętości | $1,1,\mathrm{m^3}$ |

| Parametr / interfejs | Typ / default | SI | Walidacja i rola / IR |
|---|---|---|---|
| coarse_bundle / fine_frozen | Path / przypięte | $1$ | Pełne SHA i kontrola payloadów; źródła inspection-only |
| vertices / coefficients | ndarray / wymagane | $\mathrm m$ / $\mathrm A$ | Skończone4×3 i4 na komórkę; determinant dodatni, bez smoothing |
| conductivity_s_per_m | float /3.5e7 | $\mathrm{S\,m^{-1}}$ | Przypięta wartość z odrębnego audytu obu payloadów; driver nie odczytuje σ z bundle |
| k_rad_per_m | list[float] /61pkt0…30e6 | $\mathrm{rad\,m^{-1}}$ | Te samek dla obu źródeł, nie dopasowanie |
| coarse_orders / high_check_order | list[int]/4,6 oraz8 | $1$ | N4 i6 na61k, N8 na0,1,3,6,12,20,30e6 dla obu źródeł |
| progi stabilności | float /1e-3 | $1$ | L2 i max amplitudy, L2 nativeHx i względna zmianaC_J |
| próg kwadratury6→8 | float /1e-6 | $1$ | Oddzielnie od zmiany rozwiązania; nie dowód rygorystycznego error bound |
| y0 / z0 | float /0,-13.7e-9 | $\mathrm m$ | Linia pod źródłem jak w poprzednim eksperymencie |
| zasoby | CPU1,2048MiB | $1$ | Tylko proces analizy, bez zmiany polityk runtime lub kontenerów |

Cztery nowe regresje: stałeJ i objętość, niezerowy człon afiniczny,
zmiana znaku/przesunięcie/skala geometrii oraz odmowa płaskich, ujemnie
zorientowanych i niefinitywnych danych. Transformata pola reużywa
scripts/reference_retained_rt0_spectrum.py + field_spectrum bez zmiany tego
przypiętego pliku; ma uprzednie niezależne testy całki i pryzmatu.
NativeHx porównujemy w20identycznych targetach po normalizacji signedIref.
Per-A usuwa wyłącznie liniową amplitudę; nie zmienia rozkładu i powrotów.

Mapowanie nowego prywatnego postprocessingu:
scripts/compare_retained_antenna_meshes.py + integrated_current_squared,
run_comparison; testy scripts/test_compare_retained_antenna_meshes.py +
class RetainedMeshTests. Brak nowych klas publicznych, IR, planera, stage,
formatu pola i bazy. Niezależne wskaźniki nie publikują kwalifikacji runtime.
Dla FDM CPU/GPU i FEM CPU/GPU nowy etap nie jest wykonaniem solvera.
Dane natywne są historycznymi wynikami FEM CPU; GPU nie uruchamiano.
Prerejestracja i zastrzeżenie wersji:
examples/sushruth_2020_closed_gsg/source_mesh_convergence_20261115/
criteria-preregistered.json oraz provenance-addendum.json.
Wykonanie15.11.2026 zakończyło się kodem0: SAVED_SOLUTION_STABILITY_PASS.
Na61k względneL2 zespolonej amplitudy wyniosło3.126368411e-6,
a na20 zapisanych targetach L2nativeHx/I3.031355594e-6.
Względna zmianaC_J wyniosła1.249508498e-4; wszystkie trzy wartości
mieszczą się w prerejestrowanym progu1e-3.
Osobna kontrola kwadratury6→8 na7k daje max1.616166908e-8 dla40k
oraz7.125379410e-8 dla86k, poniżej progu1e-6.
Dokładna czteropunktowa kubatura stopnia2 całych obu źródeł niezależnie
potwierdziła wzór normy. Cztery nowe regresje i focusedvalidator przeszły,
a niezależny przegląd nie wykazał Critical/Important.
CSV, PNG/SVG, processreceipt i raport są w
examples/sushruth_2020_closed_gsg/source_mesh_convergence_20261115.
Wynik ograniczony do stabilności tych zapisów. Pozostałe: kwalifikacja źródła, czysty mesh-only
eksperyment, S/GS Fullmaga, gęste natywne pole/spectrum oraz Fig2,3,4,6.



(sushruth-single-strip-return-and-aperture)=
## Pojedynczy pasek S: powrót i obszar obserwacji

To kontrola analityczna założeń porównania Fig1, nie nowy solver lub model
pełnego obwodu. Publikacja Eq6 opisuje jeden nieskończenie długi cienki pasek;
Eq7–8 zawierają przeciwne prądy. W Fig1 dla S moc jest mnożona przez4.
Tutaj s=t=0 oznacza jednostronną granicę pola od dołu, nie siatkę FEM
o zerowej grubości. Pomijamy ekranowanie, prądy wirowe i RF displacement.

Dla dwóch nieskończonych w y pasków o prądach +I i−I oraz szerokościach L,W,
przy szczelinie brzegowej g i środku powrotu d, własne całkowanie prostokątów
według tej samej konwencji co Eq6 daje:
```{math}
:label: eq-sushruth-single-return-global

a(x)=-2H_x(x)/I,\quad
A_\mathrm{pair}(k)=\int_{-\infty}^{\infty}a(x)e^{ikx}\,dx
=\operatorname{sinc}(kL/2)-e^{ikd}\operatorname{sinc}(kW/2),\quad
d=g+(L+W)/2,\qquad A_\mathrm{pair}(0)=0,\quad A_S(0)=1,\quad P=4|A|^2.
```
Sinc jest nieznormalizowaną funkcją sin(u)/u z wartością1 w0.
Jest to analityczny przekrój prądowo zbilansowany, nie wykonanie ani
kwalifikacja skończonego zamkniętego obwodu3D.

Osobno, dla zwartego stacjonarnego źródła3D bez dywergencji, którego pole
zanika w nieskończoności, prąd netto przez pełną płaszczyznę y=y0 jest zerowy.
Kontur Ampère'a z prostą poniżej całego źródła i półokręgiem domykającym
ją od dołu nie obejmuje żadnego prądu. W granicy nieskończonego promienia
całka po łuku znika i otrzymujemy:
```{math}
:label: eq-sushruth-closed-source-zero-mode

\nabla\cdot\mathbf J=0,\quad
I_\mathrm{net}(y_0)=\int_{\mathbb R^2}J_y(x,y_0,z)\,dx\,dz=0,\qquad
\int_{-\infty}^{\infty}H_x(x,y_0,z_0)\,dx=0.
```
To własny wniosek z równania ciągłości i prawa Ampère'a
[Feynman, rozdz.13](https://www.feynmanlectures.caltech.edu/II_13.html),
przy z0 poniżej całego źródła. Nie dotyczy otwartego przewodnika z prądem
doprowadzanym z nieskończoności, linii przecinającej źródło lub obszar
obejmowany przez obwód, ani pełnego RF z prądem przesunięcia.
Pierścień w płaszczyźnie yz obejmujący linię obserwacji x jest
kontrprzykładem po usunięciu warunku położenia linii; całka może wynosić I.
Nie orzekamy o dowolnej pojedynczej próbce Hx.

Dlatego idealnego A_S(0)=1 nie wolno wymagać od pełnego globalnego widma
zbilansowanego źródła i uznawać różnicy za błąd solvera. Szeroki powrót daje
zbieżność w normie L2 amplitudy, ale nie jednostajną przyk0:
```{math}
:label: eq-sushruth-single-return-norm

\frac{\|A_\mathrm{pair}-A_S\|_{L^2(\mathbb R)}}{\|A_S\|_{L^2(\mathbb R)}}
=\sqrt{L/W},\quad
|A_\mathrm{pair}(0)-A_S(0)|=1,\qquad
\mathcal Q(w,K)=\int_0^K\operatorname{sinc}^2(kw/2)\,dk
=\frac2w\left[\operatorname{Si}(Kw)-\frac{1-\cos(Kw)}{Kw}\right].
```
Relacja pełnej normy wynika z [Parsevala](https://dlmf.nist.gov/1.14.E8)
dla dwóch prostokątów:
norma kwadratu sygnału w x wynosi1/L, a różnicy1/W. Nie zależy od d.
Dla skończonego pasma0…K odniesieniem względnegoL2 jest
sqrt(Q(W,K)/Q(L,K)); kod używa stabilnej gałęzi szeregu przy małymKw.
Si oznacza całkę0…x z sin(u)/u; definicja i implementacja:
[SciPy sici](https://docs.scipy.org/doc/scipy/reference/generated/scipy.special.sici.html).

Ograniczenie obserwacji do zadanego okna zmienia obserwabl:
```{math}
:label: eq-sushruth-single-return-aperture

A_R(k)=\int_{-R}^{R}a(x)e^{ikx}\,dx.
```
Jeżeli w idealnej granicy s=t=0 okno zawiera cały pasek sygnałowy, a żaden
fragment powrotu, A_R=A_S dla każdego k. Kod nie normalizuje ponownie
przyciętego pola. Dla dodatniego s lub grubości pole ma ogony, więc ta
dokładna równość nie jest deklarowana. Zbieżność okna i pomijanej części
obwodu musi być wtedy sprawdzana oddzielnie; nie wolno dopasować okna po
obejrzeniu krzywych ani schować pola powrotu w rendererze.

| Symbol | Znaczenie | SI |
|---|---|---|
| $x,y_0,z_0,L,W,g,d,R,w,dx,dz$ | Współrzędne, szerokości, szczelina, położenie powrotu, rozmiar okna i miary długości | $\mathrm m$ |
| $k,K$ | Wektor falowy i górna granica pasma | $\mathrm{rad\,m^{-1}}$ |
| $\mathbf J,J_y$ | Gęstość prądu i jej składowa y | $\mathrm{A\,m^{-2}}$ |
| $H_x$ | Pole Oersteda w linii obserwacji | $\mathrm{A\,m^{-1}}$ |
| $I,I_\mathrm{net}$ | Prąd sygnału i prąd netto przez płaszczyznę | $\mathrm A$ |
| $a(x)$ | Pole podzielone przez podpisany prąd i pomnożone przez minus dwa | $\mathrm{m^{-1}}$ |
| $A_S,A_\mathrm{pair},A_R,P$ | Amplitudy widma i prezentowany kwadrat modułu | $1$ |
| $\mathcal Q$ | Całka kwadratu sinc w paśmie k | $\mathrm{m^{-1}}$ |
| $\operatorname{sinc},\operatorname{Si}$ | Funkcja sin(u)/u i całka sinusowa dla bezwymiarowego argumentu | $1$ |

| Parametr / interfejs | Typ / default | SI | Walidacja / rola |
|---|---|---|---|
| width_m | float /200e-9 | $\mathrm m$ | Dodatnia skończona szerokość sygnału |
| return_width_m | float /2,8,32,128e-6 | $\mathrm m$ | Dodatnia skończona szerokość powrotu; parametry własnej diagnostyki |
| gap_m | float /16e-6 | $\mathrm m$ | Nieujemna szczelina krawędziowa, nie parametr Fig1 |
| half_window_m | float or None /None | $\mathrm m$ | None: cała oś; dodatnie R: jawny obszar obserwacji |
| k_rad_per_m | ndarray /0…30e6 | $\mathrm{rad\,m^{-1}}$ | Skończone k; brak zmiany2π |
| maximum_k_rad_per_m | float /30e6 | $\mathrm{rad\,m^{-1}}$ | Nieujemna granica całki; zero daje zero |
| interval_counts | list[int] /12000,24000,48000 | $1$ | Osobna zbieżność całkowania po k |
| progi analityczne | float /1e-14,1e-12 | $1$ | Zero globalne i zgodność jawnej apertury |
| progi całkowania | float /1e-8 | $1$ | Różnica z formułą Q i ostatni przyrost, nie tolerancja solvera |
| spacing / thickness | float /0 | $\mathrm m$ | Tylko analityczna granica; brak generowania siatki |

Pięć regresji obejmuje k0 i Hermitian, niezależną całkę prostokątnych
prądów, jawne przycięcie bez renormalizacji, Q wobec adaptacyjnej kwadratury
oraz odmowy niepoprawnych danych. Prerejestracja:
examples/sushruth_2020_closed_gsg/figure1_single_strip_return_20261115/
criteria-preregistered.json. Odbiór wykonano15.11.2026: cztery bramki
analityczne przeszły na siatkach12000/24000/48000 przedziałów. WzględneL2
amplitudy w paśmie0…30rad/µm wynosi33.10614%,16.61901%,8.31784%,4.15995%
dla W=2,8,32,128µm. Max różnicy kwadratury ze wzorem to1.055e-12,
a jawnej apertury zS:2.221e-16. Pięć regresji i niezależny review przeszły;
daneNPZ/CSV, PNG/SVG, piny i raport są w tym samym katalogu.
To zaliczenie analitycznego testu modelu; Fullmag nadal **NOT VERIFIED**.

Prywatny moduł scripts/diagnose_sushruth_single_strip_return.py:
pair_spectrum, strip_power_integral, run_diagnostic. Brak zmiany publicznego
Python, ProblemIR, planera, stage, formatu wyniku lub źródłowej kwalifikacji.
Nie powstaje drugi solver produkcyjny. Dla FEM/FDM CPU/GPU jest to
reference-only analiza modelu i pola widzenia, a nie wykonanie danej lane.
Pełny S/GS/GSG Fullmaga, dodatni odstęp/grubość, skończona długość,
kwalifikacja źródła i późniejsze odpowiedzi magnetyczne pozostają otwarte.


(scientific-bibliography)=
## Bibliografia

1. M. Sushruth i in., Electrical spectroscopy of forward volume spin waves in
   perpendicularly magnetized materials, Physical Review Research 2, 043203
   (2020), [DOI i pełny tekst](https://journals.aps.org/prresearch/pdf/10.1103/PhysRevResearch.2.043203).
   Równania 1–5, 6–10, Table I i Appendix A. Licencja CC BY 4.0.

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
| scripts/test_sushruth_response_normalization.py | signed_integrals | Niezależne widma z położeń pasków i podpisana całka, bez użycia integrandu implementacji. |
| scripts/test_sushruth_response_normalization.py | class ResponseNormalizationTests | Konsekwentna normalizacja zespolonego kwadratu, wspólna faza i negatywna kontrola mieszanego mianownika. |
| scripts/reference_sushruth_2020_table_one.py | audit_table_one | Raport literalnych parametrów i warunkowej spójności Table I; bez Solve. |
| scripts/reference_sushruth_2020_table_one.py | _dispersion | Różniczkowanie istniejącej dyspersji; granica prawostronna k=0. |
| scripts/test_sushruth_table_one_audit.py | class SushruthTableOneAuditTests | Niezależne różnice częstości, jednostki i zgodność z podatnością. |

| scripts/verify_sushruth_2020_figure3_periods.py | audit_periods | Odtwarzalny pomiar odstępów z przypiętego rastra i wzorca, bez dopasowania. |
| scripts/test_sushruth_figure3_periods.py | class Figure3PeriodTests | Znany okres, kierunki zer, przedziały i odmowy niejednoznacznego odczytu. |

| examples/fdm_sushruth_2020_finite_k_images4.py | study | Kontrolna harmoniczna FDM CPU/double, 4 obrazy PBC XY. |
| examples/fdm_sushruth_2020_finite_k_images8.py | study | Ta sama kontrola i 8 obrazów PBC XY. |

| scripts/verify_sushruth_finite_k_control.py | analyze_trajectory | Pomiar harmonicznej, częstości, zaniku i czynników demag na pełnej trajektorii. |
| scripts/verify_sushruth_finite_k_control.py | _linear_modes | Dokładne wartości własne liniowego LLG dla obu sztywności pola. |
| scripts/verify_sushruth_finite_k_control.py | read_trajectory | Odczyt per-quantity czasu i odmowa brakujących chunków Zarr. |
| scripts/test_sushruth_finite_k_analysis.py | class FiniteKAnalysisTests | Niezależne trajektorie i negatywne kontrole fizycznej analizy. |
| packages/fullmag-py/tests/test_sushruth_finite_k_control.py | class SushruthFiniteKControlTests | Publiczne IR, tryb przestrzenny i bezstratny round-trip. |

| scripts/antenna_metal_thickness_diagnostic.py | metal_thickness_factor | Średnia warstw po grubości, stabilne expm1 i jawna granica. |
| scripts/antenna_metal_thickness_diagnostic.py | geometry_filter_report | Dwa położenia cienkiego paska przy zachowanej geometrii, bez korekty native H. |
| scripts/test_antenna_metal_thickness_diagnostic.py | class MetalThicknessDiagnosticTests | Niezależna kwadratura, wysokość odniesienia, walidacja i wykonanie na zachowanych parametrach. |

| scripts/plot_sushruth_2020_response_reference.py | measure_gray_annotation_pixels | Pełne pasmo adnotacji, odmowa braku/split i brak estymaty materiałowego FMR. |
| examples/sushruth_2020_closed_gsg/figure3_raster_calibration_20261113/audit_calibration.py | affine_frequency | Niezależna kalibracja ticków według własnej ramki panelu. |
| examples/sushruth_2020_closed_gsg/figure3_raster_calibration_20261113/audit_calibration.py | pixel_envelope | Wszystkie krańce piksela/ramek, bez interpretacji materiałowej. |
| examples/sushruth_2020_closed_gsg/figure3_raster_calibration_20261113/audit_calibration.py | audit | Tożsamości obu obrazów, stare wartości i różnica okresów niezależna od kreski. |

| docs/physics/0951-sushruth-2020-forward-volume-reference.md | DOC-ANCHOR:sushruth-figure3-axis-and-annotation-recheck | Zakres odczytu adnotacji, bez pomiaru materiałowego FMR i bez zmiany modelu. |



| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/reproduce_sushruth_2020_figure1.py | reproduce | Wykonany odbiór analitycznej Fig1, osobno od Fullmaga. |
| scripts/reproduce_sushruth_2020_figure1.py | extract_curves | Digitizacja RGB/connected components bez wyboru według modelu. |
| scripts/reproduce_sushruth_2020_figure1.py | compare_curves | Jawne residuale i prerejestrowane progi rastra. |
| scripts/reproduce_sushruth_2020_figure1.py | integrate_strips | Niezależna całka prądu prostokątnych pasków, nie solver Fullmaga. |
| scripts/reproduce_sushruth_2020_figure1.py | sampling_convergence | Kontrola gęstości próbkowania widma. |
| scripts/test_reproduce_sushruth_2020_figure1.py | class FigureOneTests | Siedem wykonanych testów odbioru i odmów. |



| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/verify_sushruth_2020_field_fft.py | strip_field_per_ampere | Niezależne Hx/I z prawa Biota–Savarta dla nieskończonych pasków. |
| scripts/verify_sushruth_2020_field_fft.py | fourier_minus | Całka DFT z fizycznym początkiem i ujemnym wykładnikiem. |
| scripts/verify_sushruth_2020_field_fft.py | run_sampling | Osobne badanie okna i kroku przestrzennego, bez Solve. |
| scripts/test_verify_sushruth_2020_field_fft.py | class FieldFftTests | Sześć regresji znaku, fazy, jednostek, origin i niepoprawnych profili. |
| crates/fullmag-runner/src/antenna_spectrum.rs | compute_structured_antenna_source_spectrum_interruptible | Istniejąca produkcyjna transformata2D z ujemnym wykładnikiem; tylko audyt źródeł. |



| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/reference_retained_rt0_spectrum.py | line_kernel | Niezależny postprocessing zachowanego RT0; bez wykonania native. |
| scripts/reference_retained_rt0_spectrum.py | field_spectrum | Niezależny postprocessing zachowanego RT0; bez wykonania native. |
| scripts/reference_retained_rt0_spectrum.py | rt0_sample_moment | Niezależny postprocessing zachowanego RT0; bez wykonania native. |
| scripts/reference_retained_rt0_spectrum.py | tetra_rule | Niezależny postprocessing zachowanego RT0; bez wykonania native. |
| scripts/test_reference_retained_rt0_spectrum.py | class RetainedSpectrumTests | Niezależny postprocessing zachowanego RT0; bez wykonania native. |
| tools/gsg_surface_native_probe.py | pack_rt0 | Niezależny postprocessing zachowanego RT0; bez wykonania native. |


| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/compare_retained_antenna_meshes.py | integrated_current_squared | Dokładna norma RT0, bez kwadratury pola. |
| scripts/compare_retained_antenna_meshes.py | run_comparison | Stabilność zapisanych źródeł, bez nowegoSolve. |
| scripts/test_compare_retained_antenna_meshes.py | class RetainedMeshTests | Cztery regresje momentu kwadratowego i odmów. |

(sushruth-figure1-reproduction-protocol)=
## Rysunek1: prerejestrowany odbiór modelu anten — 15.11.2026

Celem jest analityczne odtworzenie wykresu, osobno od walidacji Fullmaga.
Podpis Fig1 określa kwadrat modułu; napis „Amplitude” na osi nie zmienia tej
definicji. Wprowadzamy bezwymiarowe amplitudy znormalizowane przez wartość
pojedynczego paska dla zerowego wektora falowego:

```{math}
:label: eq-sushruth-figure1-spectra

A_S(k)=\operatorname{sinc}(kL/2)e^{-|k|s},\qquad
A_{GS}(k)=2i\sin[k(L+g)/2]A_S(k),\qquad
A_{GSG}(k)=2\sin^2[k(L+g)/2]A_S(k),
\qquad
P_S=4|A_S|^2,\quad P_{GS}=|A_{GS}|^2,\quad P_{GSG}=|A_{GSG}|^2.
```

| Symbol | Znaczenie | SI |
|---|---|---|
| $k$ | Wektor falowy | $\mathrm{rad\,m^{-1}}$ |
| $L$ | Szerokość paska | $\mathrm m$ |
| $g$ | Szczelina | $\mathrm m$ |
| $s$ | Odstęp | $\mathrm m$ |
| $i$ | Jednostka urojona | $1$ |
| $\operatorname{sinc}(u)$ | Znormalizowany sinus i jego argument | $1$ |
| $u$ | Argument funkcji sinc | $1$ |
| $A_S,A_{GS},A_{GSG}$ | Znormalizowane amplitudy | $1$ |
| $P_S,P_{GS},P_{GSG}$ | Kwadrat modułu z caption scaling | $1$ |

| Parametr / interfejs | Typ / default | SI | Walidacja i rola / ProblemIR |
|---|---|---|---|---|
| width_m / gap_m / spacing_m | float / wymagane Fig1 | $\mathrm m$ | Dokładnie200e-9 /200e-9 /0; bez dopasowania; brak nowego IR |
| k_rad_per_m | float / wymagane | $\mathrm{rad\,m^{-1}}$ | Skończone signed; wykres0–30e6; bez nowego IR |
| source page / criteria / output | Path / wymagane | $1$ | Piny PDF i PNG, calibration frame, wyjścia nie nadpisują cudzych plików; prywatny skrypt |
| quad intervals | list[int] /256,512,1024 | $1$ | Całka prądu prostokątnego z exp(+ikx), niezależna od sinc; ostatnia redukcja błędu3.9–4.1, max amplitude error5e-6 |
| plot sample intervals | list[int] /600,1200,2400,4800 | $1$ | Zmiana pozycji maksimum≤0.02rad/µm i mocy≤1e-5 między ostatnimi siatkami |
| raster selection | RGB masks / wymagane | $1$ | Connected components, bez dopasowania do modelu;≥200kolumn/krzywą |
| raster acceptance | float / p95=3,max=5 | $\mathrm{pixel}$ | Bezwzględne residuale osi; empiryczna tolerancja rasteryzacji, nie certyfikat błędu pola |

Geometria: nieskończenie długie i cienkie paski, jednorodny prąd, bez
shieldingu. S: jeden prąd+1; GS: +1/−1 w odległościach±(L+g)/2;
GSG: +1 w środku i−1/2 przy±(L+g). Transformata używa exp(+ikx).
Nie wyznacza to bezwzględnego H/I ani prądu w skończonej antenie3D.
Dla każdej komórki kwadratury całkujemy zespolony exp(+ikx) w obrębie
jednorodnego paska i sumujemy jawne prądy — bez użycia sinc i sinusa
array factor jako referencji.

Oryginał: zachowany PDF DOI10.1103/PhysRevResearch.2.043203, str.3,
SHA2569e2249ec39543ae7e16dd1af43ad1756a7b4f704a62fd9b2e5972334e2e3ca1f.
Render200dpi: osie x224.5–806.5, y383.5–619.5; wartości0–30rad/µm i0–4.
Prerejestracja i pełne źródła są w
`examples/sushruth_2020_closed_gsg/figure1_reproduction_20261115/criteria-preregistered.json`.
Obraz i sample grid nie są oryginalnymi danymi autorów; digitizacja ma
niepewność linii, antialiasingu, kalibracji i piksela. Nie dopasowujemy osi
do wyników ani amplitudy/fazy modelu do obrazu.

Mapowanie: `scripts/reference_sushruth_2020_antenna_spectrum.py + antenna_spectra`
realizuje Eq6–8. Nowy prywatny odbiór
`scripts/reproduce_sushruth_2020_figure1.py + reproduce` zapisze model,
digitizację, residuale i obraz porównawczy. Odbiór wykonano15.11.2026:13/13testów, bezpośrednia kwadratura prostokątnych
prądów i kontrola próbkowania przeszły. Porównano477/510/323kolumny S/GS/GSG;
L2 względem digitizacji wynosi0.441%/0.681%/0.786%, P95≤1.391px i max≤2.093px
przy uprzednio zapisanych progach3/5px. Dotyczy odczytanych fragmentów:
GSG obejmuje1.469–22.5rad/µm. Luki nie są interpolowane, a kwadrat modułu
nie potwierdza fazy. Pełny model zapisano w1201punktach0–30rad/µm.
Dowody i ograniczenia:
`examples/sushruth_2020_closed_gsg/figure1_reproduction_20261115/raport-rysunek1.md`
oraz `reviewed-results/results.json` w tym katalogu. Fullmag **NOT VERIFIED**. Brak nowej publicznej klasy Python, IR, planera, runtime,
formatu pola lub solvera. W czterech lane FEM CPU/GPU i FDM CPU/GPU jest
to wyłącznie niezależny Python reference — nie dowód wykonania ani parytetu.
Kwalifikacja źródła/pola/widma Fullmaga i dalsze figury pozostają osobne.


| scripts/diagnose_sushruth_single_strip_return.py | pair_spectrum | Globalne lub jawnie przycięte widmo dwóch idealnych pasków, bez renormalizacji. |
| scripts/diagnose_sushruth_single_strip_return.py | strip_power_integral | Zamknięta całka sinc² z całką sinusową, niezależne odniesienie kwadratury po k. |
| scripts/diagnose_sushruth_single_strip_return.py | run_diagnostic | Prerejestrowana kontrola powrotu, apertury i zbieżności, bez native Solve. |
| scripts/test_diagnose_sushruth_single_strip_return.py | class SingleReturnTests | Pięć niezależnych regresji całki, znaków, okna i odmów. |

(sushruth-retained-current-closure-audit)=
## Zachowany prąd RT0: bilans i niezależne przekroje

Przed kolejnym widmem sprawdzamy zachowane źródło prądu pełnej GSG:
bilans komórek, nieprzenikanie przez zewnętrzny brzeg, zgodność par
sourcecut i trzy przekroje przez signal/return. Nie uruchamiamy nowego
transportu, nie zmieniamy wyniku inspection_only ani kwalifikacji planera.

RT0 jest elementem H(div) o ciągłym śladzie normalnym; definicja i stopnie
swobody: [DefElement](https://defelement.org/elements/raviart-thomas.html),
[MFEM Maxwell notes](https://mfem.org/maxwell-notes/). W reprezentacji
kanonicznych momentów Fullmaga, po uwzględnieniu orientacji ściany:
```{math}
:label: eq-sushruth-current-closure-rt0

D_T=6\lvert T\rvert>0,\quad F_{Ti}=\int_{\partial T_i}\mathbf J_T\cdot\mathbf n_i\,dS,
\quad c_{Ti}=2F_{Ti},\qquad
\mathbf J_T(\mathbf r)=D_T^{-1}\sum_{i=0}^{3}c_{Ti}(\mathbf r-\mathbf v_i).
```
Z tej reprezentacji, bez kwadratury, wynikają:
```{math}
:label: eq-sushruth-current-closure-moments

R_T=\int_T\nabla\cdot\mathbf J_T\,dV=\frac12\sum_i c_{Ti},\qquad
\mathbf M_T=\int_T\mathbf J_T\,dV
=\frac16\sum_i c_{Ti}(\bar{\mathbf r}_T-\mathbf v_i).
```
Dla płaszczyzny y=y0 składowa Jy jest stała na przekroju każdej komórki.
Dokładne przecięcie krawędzi wyznacza wielokąt w xz i jego pole:
```{math}
:label: eq-sushruth-current-closure-section

\mathcal S_T=T\cap\{y=y_0\},\quad
I_b(y_0)=\sum_T J_{T,y}(y_0)\,
\operatorname{area}(\mathcal S_T\cap B_b),\qquad
J_{T,y}(y_0)=D_T^{-1}\sum_i c_{Ti}(y_0-v_{i,y}).
```
Przekroje leżą w prostych odcinkach trzech rozłącznych pasków.
B_b oznacza obszar przekroju paska b. Klasyfikacja wymaga, by cały
wielokąt mieścił się w jednym jawnym zakresie x; brak takiej gałęzi lub
przecięcie kilku gałęzi daje odmowę, bez przypisania według centroidu.
Jeśli płaszczyzna pokrywa ścianę, reguła min(y)≤y0<max(y) przypisuje
ją tylko do jednej strony; nie sumujemy obu sąsiednich śladów.
Nie interpolujemy wygładzonego nodal J. Pole wielokąta otrzymujemy
z uporządkowanych punktów przecięcia, a całka nie używa display J.

Na geometrycznie odpowiadających sobie trójkątach sourcecut sumujemy
podpisane strumienie obu stron. Tolerancja1e-18m służy wyłącznie
identyfikacji współrzędnych; nie przesuwa siatki i nie koryguje prądu.
Brzeg poza sourcecut powinien mieć zerowy strumień. Dla zwartego
zachowawczego prądu, po zamknięciu obu stron cut, całka wektoraJ
po całym źródle powinna zanikać. Sam ten warunek nie kwalifikuje pola
ani pominiętego przewodnika i nie zastępuje dowodu geometrii.

| Symbol | Znaczenie | SI |
|---|---|---|
| $T,\partial T_i,i,b$ | Komórka, jej ściana, indeks lokalny i indeks paska | $1$ |
| $\mathbf r,\mathbf v_i,\bar{\mathbf r}_T,y_0,v_{i,y}$ | Położenie, wierzchołek, centroid i współrzędne y | $\mathrm m$ |
| $D_T,\lvert T\rvert,dV$ | Dodatni sześciokrotny wolumen, wolumen i miara objętości | $\mathrm{m^3}$ |
| $\mathbf J_T,J_{T,y}$ | Prąd RT0 i składowa normalna do przekroju | $\mathrm{A\,m^{-2}}$ |
| $\mathbf n_i$ | Jednostkowa normalna zewnętrzna ściany | $1$ |
| $F_{Ti},c_{Ti},R_T,I_b$ | Strumień ściany, współczynnik RT0, reszta bilansu i prąd paska | $\mathrm A$ |
| $\mathbf M_T$ | Objętościowa całka wektora prądu | $\mathrm{A\,m}$ |
| $\mathcal S_T,B_b,dS,\operatorname{area}$ | Przekrój komórki i paska, miara powierzchni i pole powierzchni | $\mathrm{m^2}$ |

| Parametr / interfejs | Typ / default | SI | Walidacja i rola |
|---|---|---|---|
| vertices / coefficients | ndarray /wymagane | $\mathrm m$ / $\mathrm A$ | Tet4 dodatniej orientacji, skończone dane; cztery współczynniki |
| planes_y_m | list[float] /-5e-6,0,+5e-6 | $\mathrm m$ | Trzy przekroje wewnątrz prostych pasków |
| branches | dict /trzy zapisane przedziały | $\mathrm m$ | Rozłączne zakresy x; brak przypisania daje odmowę |
| sourcecut | trzy zakresy /y=-11e-6,x±100e-9,z30…120e-9 | $\mathrm m$ | Tylko jawny przekrój źródła z zachowanego modelu |
| matching tolerance | float /1e-18 | $\mathrm m$ | Identyfikacja par, bez edycji geometrii |
| relative flux / area tolerance | float /1e-9 | $1$ | Reszty wobec podpisanego Iref i pól przekroju |
| relative split tolerance | float /1e-6 | $1$ | Przewidywany podział+1,-1/2,-1/2; bez fitu |
| integrated current length | float /24e-6 | $\mathrm m$ | Skala Iref×długość pełnego źródła |
| integrated current tolerance | float /1e-9 | $1$ | Względna całka wektoraJ całego źródła |
| bundle / digest | Path /wymagane | $1$ | Pełny hash i wszystkie payloady przed obliczeniem |

Prywatny skrypt scripts/audit_retained_rt0_current.py, symbole
current_moments, section_currents, boundary_ledger i run_audit, nie
zmienia publicznego Python, ProblemIR, planera, formatu wyników, runtime
ani interpolacji pola. Korzysta wyłącznie z pure read_bundle/pack_rt0
z tools/gsg_surface_native_probe.py; nie wywołuje jego main/native.
Dla FEM/FDM CPU/GPU jest to reference-only kontrola zachowanych danych;
brak nowego wykonania backendu lub GPU. Pełna kwalifikacja źródła,
gęste native H/spectrum, cienki/długi limit i odpowiedź magnetyczna
pozostają otwarte.

Walidacja: sześć analitycznych regresji pola stałego/liniowego,
translacji, podziałuTet4, nieprzypisanego przekroju i błędnych danych;
następnie obie pełne GSG, trzy przekroje, brzeg i moment globalny.
Prerejestracja jest w current_closure_audit_20261116/criteria-preregistered.json.
Odbiór wykonano16.11.2026: bilans, brzeg,18par sourcecut i całkaJ
przechodzą dla obu źródeł. Starszy podział powrotów ma błąd2.4468e-6
wobecIref i nie przechodzi progu1e-6; nowszy3.8263e-8 przechodzi.
Ogólny wynik audytu pozostajeFAIL. Dane, CSV, PNG/SVG i raport są
w current_closure_audit_20261116; źródła nadal inspection_only.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/audit_retained_rt0_current.py | current_moments | Dokładny bilans i całkaJ zachowanych Tet4. |
| scripts/audit_retained_rt0_current.py | section_currents | Niezależne geometryczne przecięcie i strumienie pasków. |
| scripts/audit_retained_rt0_current.py | boundary_ledger | Bilans zewnętrznego brzegu i par sourcecut. |
| scripts/audit_retained_rt0_current.py | run_audit | Wykonanie prerejestrowanej kontroli obu zapisanych źródeł. |
| scripts/test_audit_retained_rt0_current.py | class RetainedCurrentAuditTests | Sześć analitycznych regresji i odmów. |


(sushruth-return-asymmetry-spectrum-attribution)=
## Asymetria powrotów a mała różnica zachowanych widm

Audyt przekrojów ujawnił nierówny podział powrotów. Sprawdzamy własną,
prerejestrowaną hipotezę: czy niezależnie zmierzone prądy wyjaśniają
małą różnicę zespolonych widm obu zapisanych rozwiązań. To nie jest
dopasowanie pola do widma publikacji ani nowa kwalifikacja Fullmaga.

Superpozycja Eq6–8 dla fizycznych środków x=-d,0,+d daje:
```{math}
:label: eq-sushruth-return-asymmetry-spectrum

d=L+g,\quad
q_b=I_b/I_\mathrm{ref},\quad
A(k)=S_t(k)\left[q_0+q_-e^{-ikd}+q_+e^{ikd}\right],\qquad
S_t(k)=\operatorname{sinc}(kL/2)e^{-|k|s}
\frac{1-e^{-|k|t}}{|k|t}.
```
Czynnik grubości przy k=0 lub t=0 ma granicę1. Jest to model
nieskończonych prostych pasków, jednolitego prądu w przekroju i dodatniej
skończonej grubości, nie zastępstwo pełnych połączeń3D. Dla q0=1
oraz q-=-1/2+δ, q+=-1/2-δ:
```{math}
:label: eq-sushruth-return-asymmetry-imaginary

A(k)-A_\mathrm{sym}(k)=-2i\delta\,S_t(k)\sin(kd).
```
Konwencja pozostaje exp(+ikx); znak nie jest wybierany z otrzymanej
krzywej. Nie oceniamy fazy przez dzielenie w pobliżu zer amplitudy.
Porównujemy bezpośrednio Re/Im różnicy obu widm. q jest odczytane
z przekroju y=0, niezależnie od obliczonego wcześniej widmaRT0.

| Symbol | Znaczenie | SI |
|---|---|---|
| $d,L,g,s,t$ | Odstęp środków, szerokość, szczelina, odstęp pionowy i grubość metalu | $\mathrm m$ |
| $k$ | Podpisany wektor falowy | $\mathrm{rad\,m^{-1}}$ |
| $I_b,I_\mathrm{ref}$ | Zmierzony prąd paska i podpisana normalizacja źródła | $\mathrm A$ |
| $q_b,q_0,q_-,q_+,\delta$ | Podpisane udziały prądu i asymetria powrotów | $1$ |
| $A,A_\mathrm{sym},S_t$ | Amplituda widma, symetryczne odniesienie i czynnik pojedynczego paska | $1$ |
| $i,b$ | Jednostka urojona i indeks paska | $1$ |

Parametry: L200nm,g250nm,s43.7nm,t90nm — zgodne z zachowaną geometrią,
odmienne od idealnejFig1. Wejścia: jawnie zahashowany CSV prądów,61punktów
kwadratury6 oraz7niezależnie zachowanych punktów kwadratury8.
Pomiędzy pomiarami nie zmieniamy parametrów. Próg atrybucji: względna
normaL2 reszty wobec mierzonej różnicy≤0.05; na kontroli8 maxreszta≤1e-7.
To progi własnej hipotezy, nie nowe tolerancje solvera. Dane pozostają
niezmienione, a reszta jest zapisana osobno od predykcji.

| Parametr / interfejs | Typ / default | SI | Walidacja / rola |
|---|---|---|---|
| width_m / gap_m | float /200e-9,250e-9 | $\mathrm m$ | Dodatnia szerokość, nieujemna szczelina; istniejący antenna_spectra |
| spacing_m / thickness_m | float /43.7e-9,90e-9 | $\mathrm m$ | Nieujemne, skończone; istniejące walidatory referencji |
| q_left / q_signal / q_right | float /CSV wymagany | $1$ | Podpisane skończone prądy z jawnego y=0; bez renormalizacji |
| k | ndarray /zapisane61 lub7 punktów | $\mathrm{rad\,m^{-1}}$ | Identyczne k obu rozwiązań; bez interpolacji |
| input_sha256 | dict /wymagany | $1$ | Wszystkie cztery wejścia zgodne przed i po obliczeniu |
| acceptance | float /0.05,1e-7 | $1$ | Prerejestrowane progi własnej hipotezy, bez wpływu na solver |
| output | Path /results | $1$ | Nowy katalog; odmowa nadpisania |

Prywatny skrypt current_closure_audit_20261116/return_asymmetry_hypothesis/
hypothesis.py + weighted_spectrum/run_hypothesis używa istniejącego
antenna_spectra i metal_thickness_factor. Nie zmienia PythonAPI,
ProblemIR, planera, runtime, źródła lub publicznego widma. FEM/FDM CPU/GPU:
wyłącznie niezależny postprocessing zachowanego prądu; nativeH/spectrum
pozostaje niezweryfikowane. Nie wyjaśnia to automatycznie dawnej
rozbieżności transmisji lub widm o różnych geometriach.

Walidacja: trzy regresje symetrycznegoGSG, znaku części urojonej i
liniowości bez renormalizacji. Osobno zapisane61punktów przy n=6 oraz siedem punktów kontrolnych
przy n=8, CSV z resztą i wspólny wykres. Wykonanie16.11.2026 przechodzi:
resztaL2 na61punktachn6 to0.03798137 normy różnicy (próg0.05);
maxreszta w7punktachn8 to4.0355e-10 (próg1e-7). Próbnikowa względna
norma tych7punktów wynosi0.0002099643; nie dowodzi pełnej krzywejn8.
Dotyczy małej różnicy obu zachowanych rozwiązań, bez fitu lub promocji
nativeH/spectrum.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/return_asymmetry_hypothesis/hypothesis.py | weighted_spectrum | Predykcja z niezależnych udziałów prądu, bez fitu. |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/return_asymmetry_hypothesis/hypothesis.py | run_hypothesis | Porównanie z zachowanymi zespolonymi widmami6/8. |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/return_asymmetry_hypothesis/test_hypothesis.py | class ReturnAsymmetryTests | Trzy regresje modelu predykcji. |

(sushruth-native-h-return-asymmetry)=
## Predykcja różnicy zachowanego native Hx z prądów przekrojowych

Cel: sprawdzić tę samą przyczynę małej różnicy dwóch zapisanych rozwiązań
bez użycia zachowanego widma jako referencji. Referencją obserwacji jest
20 dawnych wartości native $H_x/I_\mathrm{ref}$; współczynniki prądów
pochodzą z niezależnego przekroju $y=0$. Nie dopasowujemy amplitudy,
znaku, fazy ani położenia. Historyczne dane były już znane przed
prerejestracją nowej analizy; nie jest to badanie ślepe.

Dla prądu w kierunku $+y$ oraz punktu poniżej dolnej powierzchni metalu
całkowanie Biota–Savarta po nieskończonym $y$ i szerokości paska daje:

```{math}
:label: eq-sushruth-native-h-strip-kernel
K(x,s;L,t)=-\frac{1}{2\pi Lt}\int_0^t
\left[\operatorname{atan2}(x+L/2,s+u)
-\operatorname{atan2}(x-L/2,s+u)\right]\,\mathrm du,\qquad s=z_b-z>0.
```

Funkcja $K$ jest polem na amper. Używamy rzeczywistego $z$ każdej próbki;
nie przenosimy wszystkich punktów na linię widmową $z=-13.7$ nm.
Dla $t\to0$ pozostaje wyrażenie w nawiasie podzielone przez $-2\pi L$.
Skończona grubość jest całkowana regułą Gaussa–Legendre'a:

```{math}
:label: eq-sushruth-native-h-asymmetry-prediction
x_b\in\{-d,0,+d\},\quad d=L+g,\qquad
\Delta h_i^\mathrm{pred}=\sum_b
\left(q_b^\mathrm{old}-q_b^\mathrm{new}\right)
K(x_i-x_b,z_b-z_i;L,t).
```

Nie wymuszamy idealnej symetrii prądów lub ich ponownego bilansowania.
Współrzędna $y_i$ pozostaje w CSV i jest uwzględniona przy parowaniu
punktów, chociaż model nieskończonych pasków nie zależy od $y$.
Pomiar różnicy ma skończony obwód 3D; predykcja ma model długich,
jednorodnie wypełnionych pasków. Pozostała reszta obejmuje ten błąd modelu,
niejednorodność RT0 i błąd dawnych obliczeń pola. Bez osobnego eksperymentu
nie rozdzielamy tych składników.

```{math}
:label: eq-sushruth-native-h-asymmetry-error
r_i=(h_i^\mathrm{old}-h_i^\mathrm{new})-\Delta h_i^\mathrm{pred},\quad
E_\Delta=\frac{\sqrt{\sum_i r_i^2}}
{\sqrt{\sum_i(h_i^\mathrm{old}-h_i^\mathrm{new})^2}},\quad
E_h=\frac{\sqrt{\sum_i r_i^2}}{\sqrt{\sum_i(h_i^\mathrm{new})^2}}.
```

| Dokładny token | Znaczenie | Jednostka SI |
|---|---|---|
| $x,s,u,L,t,d,g,x_b,z_b,z,x_i,y_i,z_i$ | Współrzędne, odstęp dodatni, zmienna grubości, rozmiary i położenia paska oraz próbki | $\mathrm m$ |
| $K,h_i^\mathrm{old},h_i^\mathrm{new},\Delta h_i^\mathrm{pred},r_i$ | Pole H na amper, jego różnica i reszta w punktach | $\mathrm{m^{-1}}$ |
| $q_b^\mathrm{old},q_b^\mathrm{new}$ | Zmierzone podpisane udziały prądów paska w prądzie sygnałowym | $1$ |
| $i,b$ | Indeks próbki i paska | $1$ |
| $E_\Delta,E_h$ | Próbnikowe względne normy reszty, odpowiednio względem różnicy i pełnego nowego pola | $1$ |

Pełne parametry prywatnego eksperymentu, bez publicznego API lub nowego IR:

| Parametr | Typ / wartość | SI | Walidacja i znaczenie |
|---|---|---|---|
| width_m, gap_m | float /200e-9,250e-9 | $\mathrm m$ | Skończone, szerokość >0, szczelina ≥0 |
| source_bottom_z_m, thickness_m | float /30e-9,90e-9 | $\mathrm m$ | Skończone, grubość ≥0, wszystkie próbki poniżej metalu |
| points | int /20 | $1$ | Dokładnie zachowany zbiór XYZ, bez interpolacji lub pomijania punktów |
| layer_orders | list[int] /16,32,64 | $1$ | Kontrola dokładności całkowania grubości; wynik główny 64 |
| branch_current_measurement_plane_y_m | float /0 | $\mathrm m$ | Jeden unikalny pomiar każdego paska i źródła |
| acceptance | dict /0.10,1e-6,1e-8 | $1$, $1$, $\mathrm{m^{-1}}$ | Własne progi $E_\Delta$, $E_h$ i max zmiany predykcji 16/32/64; bez wpływu na solver |
| input_sha256, reference_sha256 | dict /wymagane | $1$ | Zgodność wszystkich wejść i współdzielonej referencji przed i po analizie |
| output | Path /native_h_asymmetry/results | $1$ | Nowy katalog; odmowa nadpisania historycznego wyniku |

Prywatna funkcja predict_difference i driver run_prediction w
examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/native_h_asymmetry/
field_prediction.py używają istniejącego strip_field_per_ampere.
Python publiczny, ProblemIR, planner, runtime, status inspection_only
i limity solvera pozostają bez zmian. FEM CPU: odczyt zapisanych próbek,
bez nowego wykonania. FEM GPU, FDM CPU i FDM GPU: brak nowej kwalifikacji;
niezależna predykcja nie jest ich implementacją.

Odtworzenie: Python3.12 uruchamia field_prediction.py bez argumentów,
ze świeżym katalogiem results, przypiętymi CSV i kontrolą hashy.
Przed implementacją zapisano testy niezależnej kubatury Biota–Savarta,
znaku, antysymetrii, skalowania SI, przesunięcia pionowego i odmów.
Kryterium hipotezy: $E_\Delta\le0.10$, $E_h\le10^{-6}$ i maksymalna
zmiana predykcji między regułami grubości $\le10^{-8}\,\mathrm{m^{-1}}$.
Są to kryteria wyjaśnienia różnicy tych 20 punktów, nie pełnej krzywej.

Wykonanie16.11.2026: cztery regresje przechodzą. Predykcja bez fitu daje
$E_\Delta=0.05050445646$ oraz $E_h=1.530969666\times10^{-7}$.
Największa reszta to $0.3070780169\,\mathrm{m^{-1}}$; zmiana16→32
wynosi $1.491862189\times10^{-16}\,\mathrm{m^{-1}}$.
Wszystkie trzy prerejestrowane bramki przechodzą. Nie oznacza to, że
przypisano całą resztę konkretnej metodzie numerycznej.
Otwarty pozostaje odbiór gęstego
native H/spectrum oraz anten S/GS i zgodnego limitu Fig.1. Nie przechodzimy
do odpowiedzi LLG na podstawie tego testu.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/verify_sushruth_2020_field_fft.py | strip_field_per_ampere | Referencja Hx/I z właściwym znakiem Biota–Savarta |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/native_h_asymmetry/field_prediction.py | predict_difference | Superpozycja zmierzonych prądów przy właściwym z każdej próbki |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/native_h_asymmetry/field_prediction.py | run_prediction | Przypięcie danych, wszystkie 20 punktów, błędy, wykres |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/native_h_asymmetry/test_field_prediction.py | class NativeFieldPredictionTests | Niezależne regresje modelu i jednostek |

(sushruth-full-rt0-point-field)=
## Oddzielenie modelu pasków od obliczania pola z pełnego RT0

Przed oceną reszty wykonujemy niezależną całkę tego samego zachowanego
prądu 3D, zamiast przypisywać ją od razu kernelowi. Nie uruchamiamy native
ani nowego transportu. Dla punktów ściśle poniżej całego źródła:

```{math}
:label: eq-sushruth-full-rt0-point-field
H_x(\mathbf r)=\frac{1}{4\pi}
\sum_T\int_{\hat T}
\frac{N_{T,y}(\boldsymbol\lambda)R_z-
N_{T,z}(\boldsymbol\lambda)R_y}{\lvert\mathbf R\rvert^3}
\,\mathrm d\hat V,\quad
\mathbf R=\mathbf r-\mathbf r_T(\boldsymbol\lambda),\quad
\mathbf N_T=\sum_{j=0}^3 c_{T,j}
\left(\mathbf r_T-\mathbf v_{T,j}\right).
```

Zachowane $c_{T,j}$ są dwukrotnością podpisanego strumienia ściany,
a $\mathbf J_T=\mathbf N_T/D_T$, gdzie $D_T=6V_T>0$.
Jacobian $D_T$ skraca się z mianownikiem reprezentacji RT0.
Reguła tetra_rule ma sumę wag $1/6$. Po całkowaniu dzielimy przez
oryginalny podpisany $I_\mathrm{ref}$ każdego źródła, bez zmiany prądu.

```{math}
:label: eq-sushruth-full-rt0-field-decomposition
\left(h^\mathrm{old}_\mathrm{native}-h^\mathrm{new}_\mathrm{native}\right)
-\Delta h^\mathrm{pred}
=
\underbrace{\left(h^\mathrm{old}_\mathrm{ref}-h^\mathrm{new}_\mathrm{ref}\right)
-\Delta h^\mathrm{pred}}_{r_\mathrm{model}}
+
\underbrace{\left(h^\mathrm{old}_\mathrm{native}-h^\mathrm{old}_\mathrm{ref}\right)
-\left(h^\mathrm{new}_\mathrm{native}-h^\mathrm{new}_\mathrm{ref}\right)}
_{r_\mathrm{field}}.
```

To tożsamość rozdzielająca błąd przybliżenia długich pasków
od różnicy native względem niezależnego całkowania tego samego RT0.
Samo $r_\mathrm{field}$ nie wskazuje jeszcze linijki błędnego kodu;
może mieścić się w deklarowanym błędzie obliczania pola.
Referencja musi najpierw przejść własną kontrolę zbieżności.

| Dokładny token | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf r,\mathbf R,\mathbf r_T,\mathbf v_{T,j}$ | Target, wektor od źródła, punkt całkowania i wierzchołek Tet4 | $\mathrm m$ |
| $c_{T,j},I_\mathrm{ref}$ | Współczynnik RT0 równy dwukrotności strumienia i oryginalny prąd źródła | $\mathrm A$ |
| $\mathbf N_T$ | Licznik RT0 równy gęstości prądu razy Jacobian | $\mathrm{A\,m}$ |
| $\mathbf J_T$ | Gęstość prądu w lokalnej komórce | $\mathrm{A\,m^{-2}}$ |
| $D_T,V_T$ | Dodatni Jacobian i objętość Tet4 | $\mathrm{m^3}$ |
| $H_x$ | Składowa pola źródłowego przed normalizacją prądem | $\mathrm{A\,m^{-1}}$ |
| $h^\mathrm{old}_\mathrm{native},h^\mathrm{new}_\mathrm{native},h^\mathrm{old}_\mathrm{ref},h^\mathrm{new}_\mathrm{ref},\Delta h^\mathrm{pred},r_\mathrm{model},r_\mathrm{field}$ | Pola na amper, predykcja różnicy i składniki reszty | $\mathrm{m^{-1}}$ |
| $T,j,\hat T,\boldsymbol\lambda,\mathrm d\hat V$ | Indeksy komórki/wierzchołka, tetraedr referencyjny, barycentryczne współrzędne i miara | $1$ |

Prywatny eksperyment full_rt0_point_field/point_field_reference.py:
point_field_x całkuje, run_reference przypina oba bundle i wszystkie payloady,
sprawdza zgodność zamrożonego RT0 i dawnych nativeH z20XYZ, a następnie
zapisuje oddzielne błędy modelu i pola. Współdzielone tetra_rule i
rt0_sample_moment pozostają niezmienione.

| Parametr | Typ / wartość | SI | Walidacja / przeznaczenie |
|---|---|---|---|
| sources | list /40728,85980komórek | $1$ | Właściwe bundle, wszystkie hashe payloadów, dodatnie Tet4 i identyczne zamrożone współczynniki |
| points | ndarray /20×3 | $\mathrm m$ | Skończone oryginalne XYZ; targety poniżej całego źródła |
| orders | list[int] /4,6,8,10,12 | $1$ | Minimum trzy reguły; dwie ostatnie zmiany muszą przejść oba progi, inaczej referencja nieodebrana |
| quadrature_l2, quadrature_point | float /1e-9,1e-8 | $1$ | Zmiany normy próbnikowej i każdego punktu; mianownik punktowy max(1 m⁻¹,abs(h)) |
| native_l2, native_point | float /1e-6,1e-6 | $1$ | Własne progi kontroli20punktów, bez zmiany tolerancji solvera |
| cpu_threads, memory, time | int /1,2048,720 | $1$, $\mathrm{MiB}$, $\mathrm s$ | Lokalne ograniczenia niezależnego eksperymentu, bez zmiany kontenera |
| output | Path /full_rt0_point_field/results | $1$ | Nowy katalog, odmowa nadpisania wyniku |

PythonAPI/ProblemIR/planner/runtime: brak zmian i brak serializacji tej
prywatnej referencji. FEM CPU dostarcza wyłącznie zapisane wejścia.
FDM CPU, FDM GPU i FEM GPU nie otrzymują nowego wsparcia lub kwalifikacji.
Nie zmieniamy inspection_only ani ograniczenia publicznego źródła.
Każda odmowa zbieżności lub limitu jest zachowana jako nieodebrany wynik,
bez podnoszenia tolerancji po porównaniu z native.

Test samego bardzo grubego prostopadłościanu wymaga reguły16 dla
niezmienionej tolerancji $10^{-10}$; reguła12 dała błąd około $1.8\times10^{-10}$.
Prywatne point_rule odtwarza tę samą transformację Duffy'ego dla
testowego16. Zapisano pierwotną odmowę. Reguły eksperymentu na zachowanych
siatkach nadal wynoszą4/6/8/10/12, a ich progi pozostają bez zmian.

Wykonanie zakończyło się kodem2: własna zbieżność nieodebrana dla obu
źródeł. Zmiany10→12 L2: $8.03667\times10^{-9}$ i $9.80592\times10^{-9}$,
punktowo $2.55826\times10^{-8}$ i $3.21357\times10^{-8}$.
Norma zmiany różnicy źródeł10→12 to $0.0244318\,\mathrm{m^{-1}}$,
większa od oszacowania $r_\mathrm{model}$ przy12. Nie opieramy na nim
ilościowej atrybucji. Cztery testy i niezależny review przeszły,
co nie zastępuje odmowy referencji. Zapisano343.8s i227.6MiB RSS.
Referencja dotyczy tylko20targetów; brak interpolacji na całe Universe
i brak gęstego FFT.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/reference_retained_rt0_spectrum.py | tetra_rule | Reguła Gaussa na referencyjnym Tet4 |
| scripts/reference_retained_rt0_spectrum.py | rt0_sample_moment | Stabilny licznik J razy Jacobian w lokalnej komórce |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/full_rt0_point_field/point_field_reference.py | point_rule | Wspólna reguła do12 i dokładniejszy test prostopadłościanu16 |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/full_rt0_point_field/point_field_reference.py | point_field_x | Niezależna całka Hx z całego zachowanego RT0 |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/full_rt0_point_field/point_field_reference.py | run_reference | Audyt wejść, zbieżność i rozdzielenie reszty |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/full_rt0_point_field/test_point_field_reference.py | class FullRT0PointFieldTests | Dokładny prostokątny prąd, jednostki, orientacje i podział Tet4 |

(sushruth-analytic-rt0-face-reference)=
## Analityczna referencja ścian RT0 dla 20 zachowanych targetów

Reguły objętościowe4/6/8/10/12 nie przeszły uprzednich progów referencji:
zmiana10→12 daje L2 $8.04\times10^{-9}$ i $9.81\times10^{-9}$,
wobec progu $10^{-9}$. Nie uznajemy ich za odebrany wzorzec i nie
zwiększamy tolerancji. Osobno sprawdzamy własną redukcję analityczną.

Lokalne RT0 ma postać $\mathbf J_T(\mathbf r')=a_T\mathbf r'+\mathbf b_T$,
gdzie nachylenie $a_T$ jest skalarem. W poniższej tożsamości
$\mathbf J_T(\mathbf r)$ oznacza wyłącznie matematyczne przedłużenie
tego wielomianu do targetu; nie jest fizycznym prądem poza przewodnikiem:

```{math}
:label: eq-sushruth-rt0-face-reduction
\mathbf J_T(\mathbf r')\times(\mathbf r-\mathbf r')
=\mathbf J_T(\mathbf r)\times(\mathbf r-\mathbf r'),\qquad
\mathbf H_T(\mathbf r)=\frac{\mathbf J_T(\mathbf r)}{4\pi}
\times\sum_f\mathbf n_f\Phi_f,\qquad
\Phi_f=\int_f\frac{\mathrm dS'}{|\mathbf r-\mathbf r'|}.
```

Wykorzystano $\nabla'(1/|\mathbf r-\mathbf r'|)
=(\mathbf r-\mathbf r')/|\mathbf r-\mathbf r'|^3$ i twierdzenie Gaussa.
Dla trójkąta o wierzchołkach $\mathbf v_j$ oznaczamy
$\boldsymbol\rho_j=\mathbf v_j-\mathbf r$, $R_j=|\boldsymbol\rho_j|$,
$h=\boldsymbol\rho_0\cdot\mathbf n_f$ oraz
$\mathbf m_j=((\mathbf v_{j+1}-\mathbf v_j)/\ell_j)\times\mathbf n_f$.
Indeksy wierzchołków są cykliczne. Z dwuwymiarowej dywergencji
$\nabla_2\cdot(\mathbf u/\sqrt{|\mathbf u|^2+h^2})
=1/R+h^2/R^3$ otrzymujemy:

```{math}
:label: eq-sushruth-triangle-potential
\Phi_f=
\sum_{j=0}^2(\boldsymbol\rho_j\cdot\mathbf m_j)
\,2\operatorname{atanh}\frac{\ell_j}{R_j+R_{j+1}}
-|h|\,|\Omega_f|,\qquad
\Omega_f=2\operatorname{atan2}
\left(
\det[\boldsymbol\rho_0,\boldsymbol\rho_1,\boldsymbol\rho_2],
R_0R_1R_2+
(\boldsymbol\rho_0\cdot\boldsymbol\rho_1)R_2+
(\boldsymbol\rho_1\cdot\boldsymbol\rho_2)R_0+
(\boldsymbol\rho_2\cdot\boldsymbol\rho_0)R_1
\right).
```

Kąt bryłowy trójkąta: van Oosterom i Strackee,
[IEEE TBME30(2),125–126(1983)](https://doi.org/10.1109/TBME.1983.325207).
Redukcję RT0 i wzór potencjału wyprowadzono tutaj; nie kopiujemy
nieodczytanego kodu innego solvera. Reguły Gaussa porównano z
[NIST DLMF3.5](https://dlmf.nist.gov/3.5).
Wektorowe prawo Biota–Savarta jest podstawą znaku;
źródłowe H nie zawiera dodatkowego mnożnika $\mu_0$.

| Dokładny token | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf r,\mathbf r',\mathbf v_j,\boldsymbol\rho_j,\mathbf u,R,R_j,h,\ell_j$ | Target, źródło, współrzędne i odległości w geometrii trójkąta | $\mathrm m$ |
| $\mathbf J_T,\mathbf b_T$ | Gęstość prądu i stała część lokalnego wielomianu RT0 | $\mathrm{A\,m^{-2}}$ |
| $a_T$ | Skalarne nachylenie lokalnego RT0 | $\mathrm{A\,m^{-3}}$ |
| $\mathbf H_T$ | Wkład komórki do pola H | $\mathrm{A\,m^{-1}}$ |
| $\Phi_f$ | Potencjał skalarny powierzchni trójkąta | $\mathrm m$ |
| $\mathrm dS'$ | Element powierzchni źródłowej | $\mathrm{m^2}$ |
| $\mathbf n_f,\mathbf m_j,\Omega_f,T,f,j$ | Normalne jednostkowe, kąt bryłowy i indeksy | $1$ |
| $\nabla_2$ | Operator różniczkowy po współrzędnych płaszczyzny | $\mathrm{m^{-1}}$ |

Operator i wszystkie pola mają jawne jednostki SI.

Prywatny analytic_rt0_face_reference/analytic_reference.py:
triangle_potential i point_field_x, z osobnym run_reference.
Parametry źródeł i20XYZ są identyczne z poprzednią kontrolą.
Nie zmieniają publicznego PythonAPI, ProblemIR, planera lub runtime.
FEM CPU: wyłącznie zapisane wejścia; FEM GPU/FDM CPU/FDM GPU:
brak nowej implementacji lub kwalifikacji.

| Parametr | Typ / wartość | SI | Walidacja / znaczenie |
|---|---|---|---|
| sources, points | list, ndarray /dwa źródła,20×3 | $1$, $\mathrm m$ | Całe bundle i frozen zgodne z przypiętymi hashami; skończone dodatnie Tet4 i targety poniżej źródła |
| arithmetic | dtype /longdouble,float64 | $1$ | Oba warianty tego samego wzoru; zapis rzeczywistej liczby bitów mantysy |
| precision_l2, precision_point | float /1e-9,1e-8 | $1$ | Zmiana między wariantami; mianownik punktowy max(1 m⁻¹,abs(h)) |
| native_l2, native_point | float /1e-6,1e-6 | $1$ | Uprzednie progi kontroli20targetów, bez zmiany tolerancji native |
| cpu_threads, memory, time | int /1,2048,720 | $1$, $\mathrm{MiB}$, $\mathrm s$ | Lokalne limity referencji, bez zmiany kontenera |
| output | Path /analytic_rt0_face_reference/results | $1$ | Odmowa nadpisania historycznych wyników |

Wariant float64 dotyczy geometrii i kernela; oba warianty akumulują
wkłady w longdouble i zwracają float64. Pole mantissa_bits w JSON zapisuje
np.finfo.nmant (52/63), bez ukrytego bitu wiodącego.
Kontrola dwóch precyzji jest testem stabilności arytmetyki, nie
certyfikatem przedziałowym. Konieczne są także niezależne analityczne
i całkowe regresje, a następnie osobny przegląd. Zachowany inspection_only
pozostaje bez zmian. Nawet zaliczenie wszystkich20punktów nie dowodzi
gęstego native H/spectrum ani pozostałych anten Fig.1.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/analytic_rt0_face_reference/analytic_reference.py | triangle_potential | Własna zamknięta całka potencjału trójkąta |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/analytic_rt0_face_reference/analytic_reference.py | point_field_x | Redukcja pełnego lokalnego RT0 do czterech ścian |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/analytic_rt0_face_reference/analytic_reference.py | run_reference | Piny, precyzja,20nativeH i rozdzielenie reszty |

Wykonanie analitycznej referencji16.11.2026: sześć regresjiGREEN; wynik
ANALYTIC_RT0_POINT_REFERENCE_PASS w20targetach. Błąd native/ref L2:
coarse1.854521229e-7, fine1.153147502e-7; max punktowy5.419099806e-7
oraz2.052493537e-7 przy progu1e-6. Zmiana float64/longdouble L2
5.7823e-15/6.1287e-15; max punktowo1.24361e-11/9.70056e-12.
Normy reszty: całkowita0.4853743228, modelu0.0001486290960,
obliczania pola0.4853639235[1/m]. Te składowe nie są ortogonalne;
nie dodajemy ich norm. Reszta modelu stanowi0.03062% normy reszty
całkowitej, a nie procent błędu pełnego pola. Własna referencja trwała
23.774s przy peakRSS181.02MiB. Nowa kwalifikacja dotyczy wyłącznie20Hx
z dwóch zachowanych źródeł; nie pełnej Fig.1 lub gęstego nativeFFT.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/analytic_rt0_face_reference/test_analytic_reference.py | class AnalyticFaceReferenceTests | Kubatura trójkąta, orientacja i jednostki oraz stały Jz/radialny RT0; osobno reużyte cztery oracley pryzmatu |


(sushruth-analytic-rt0-vector-validation)=
## Kontrola zachowanego pełnego wektora H — wykonany pomiar

Rozszerzenie referencyjnego odbioru obejmuje wszystkie trzy składowe
równania {eq}`eq-sushruth-rt0-face-reduction`, z tą samą geometrią,
podpisanym prądem i fizycznymi współczynnikami RT0. Nie zmienia równania
produkcji ani publicznego API. Osobny prywatny driver korzysta z istniejącej
funkcji triangle_potential; zapisany Hx nie zostaje nadpisany.

Kontrakt i kryteria zapisano przed nowym pomiarem. Wykonanie trwało
57,858576 s na jednym CPU przy peak RSS 189,917969 MiB; exit 2 jest
odmową odbioru: siedem z ośmiu bramek przechodzi.

| Źródło | Wektorowe L2 [ppm] | Maksimum punktowe [ppm] | Próg maksimum 1 ppm |
|---|---:|---:|---|
| 40 728 Tet4 | 0.228373736 | 0.500627404 | PASS |
| 85 980 Tet4 | 0.581565746 | 1.477436313 | FAIL |

Odmowa dotyczy próbki #11 nowszego źródła: x=0, y=+50 nm, z=−22,4 nm.
Różnica Hz wynosi 3,170331448e-5 A/m. Weryfikacja fizycznych źródeł i
niezależny odczyt CSV potwierdziły wynik; błędu mapowania składowych,
jednostek lub podpisanego prądu nie stwierdzono.

Aktualny DirectTetraQuadratureOptions stosuje składnik bezwzględny
1e-9 A/m i względny 1e-5. W tym punkcie bieżąca reguła budżetu daje
około 2,146e-4 A/m, więcej niż zmierzona norma błędu 3,171e-5 A/m.
Nie dowodzi to naruszenia natywnego kontraktu H; odrębna bramka
1 ppm pozostaje niezaliczona. Manifest nie zachowuje historycznej
decyzji estymatora. Przyczyny lokalnej różnicy numerycznej nie ustalono.

Pełne dane, piny, wykresy, wykonanie i ograniczenia:
examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/vector_rt0_face_reference/raport-wektora-H.md.
Pięć fizycznych regresji RED/GREEN i dwa odczytowe review są zachowane.
Nie nadajemy źródłu durable_source_authentication i nie odbieramy gęstej
mapy lub widma. Publiczny Python, ProblemIR, normalizacja, planner,
runtime, status inspection_only i dane historyczne pozostają bez zmian.
FEM CPU: porównanie wyłącznie zachowanych wyników; FEM GPU, FDM CPU
i FDM GPU: brak nowej realizacji lub kwalifikacji.

| Parametr prywatnej referencji | Typ / wartość | Jednostka SI | Walidacja i przeznaczenie |
|---|---|---|---|
| vertices | ndarray, wymagany | $\mathrm m$ | Skończone dodatnie Tet4, kształt liczba komórek ×4×3 |
| coefficients | ndarray, wymagany | $\mathrm A$ | Cztery lokalne współczynniki RT0 na Tet4; zgodne z fizycznymi momentami ścian, bez nodal averaging |
| points | ndarray, wymagany | $\mathrm m$ | Skończone 20×3, identyczne z dwoma bundle, ściśle poniżej przewodnika |
| dtype | numpy dtype, domyślnie longdouble | $1$ | Osobna kontrola geometrii i kernela float64; obie akumulacje longdouble, wyjście float64 |
| point denominator floor | float, 1 | $\mathrm{m^{-1}}$ | Mianownik punktowy max(podłoga, norma całego wektora pola podzielonego przez podpisany prąd) |
| native vector L2 / max point | float, 1e-6 /1e-6 | $1$ | Kryteria zadane przed pomiarem; bez zmiany tolerancji natywnego solvera |
| precision vector L2 / max point | float, 1e-9 /1e-8 | $1$ | Stabilność względem typu arytmetyki, nie certyfikat przedziałowy |
| CPU / RSS / czas | int, 1 /2048 /720 | $1$, $\mathrm{MiB}$, $\mathrm s$ | Lokalne limity postprocessingu bez zmiany kontenera |
| output | Path, nowy katalog results | $1$ | Odmowa nadpisania wcześniejszych wyników |

Normy L2 są próbnikowe bez wag objętości. Dla składowych małych przez
anulowanie zapisujemy również błędy bezwzględne w $\mathrm{m^{-1}}$;
dobrej normy całego wektora nie nazywamy dowodem względnej dokładności
każdej składowej bliskiej zeru. Wykres punktowy nie stanowi gęstego
odtworzenia Fig.1. Regresje obejmują niezależną objętościową kwadraturę
pryzmatu i afinicznego Tet4, jednostki przy zachowanych strumieniach,
cykliczną permutację osi oraz odmowy. Wykorzystujemy pełne wektorowe
prawo Biota–Savarta i bibliografię poprzedniej sekcji.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/vector_rt0_face_reference/vector_reference.py | point_field_vector | Wszystkie składowe istniejącej analitycznej redukcji RT0 |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/vector_rt0_face_reference/vector_reference.py | run_comparison | Jawne piny, dwie arytmetyki, normy wektorowe i zapis |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/vector_rt0_face_reference/test_vector_reference.py | class VectorReferenceTests | Niezależne całki objętościowe i transformacje fizyczne |
| examples/sushruth_2020_closed_gsg/current_closure_audit_20261116/vector_rt0_face_reference/render_vector_comparison.py | render_comparison | Wykres punktowego błędu wektora i trzech składowych z CSV, bez interpolacji mapy |



(sushruth-native-field-fft-postprocessor)=
## FFT z zachowanego natywnego H — prywatne przetwarzanie 18.11.2026

Narzędzie scripts/native_antenna_field_fft.py łączy istniejący odczyt
zachowanych pakietów z fourier_minus. Stosuje wyłącznie dyskretną sumę
równania eq-sushruth-sampled-field-fourier-convention; nie oblicza nowego H.
Normalizuje fizyczne Hx przez podpisany prąd źródła, zachowuje fizyczny
początek osi, ujemny wykładnik transformaty i jawnie zapisuje także
sprzężone A+ z mnożnikiem −2. Nie dopasowuje skali ani fazy i nie wykonuje
interpolacji, paddingu, odejmowania średniej lub uzupełniania ogonów.

Odczyt źródła jest ograniczony do antenna_field_solution.v2 ze statusem
inspection_only; opcjonalne pole potomne do zachowanego
antenna_retained_current_field_solution.v1. Hash pliku, ramkowanie,
hashe payloadów, jednostki i layout są sprawdzane przed użyciem.
Potomek musi wskazywać ten sam bundle źródła, pięć tożsamości źródła oraz
te same liczby komórek i wierzchołków. Nie oznacza to kwalifikacji źródła.

| Interfejs prywatnego CLI | Typ / domyślna wartość | SI | Reguła |
|---|---|---|---|
| source-bundle, source-sha256 | Path, str / wymagane | $1$ | Istniejący pełny bundle i jawny hash SHA256. |
| field-bundle, field-sha256 | Path, str / brak | $1$ | Oba razem; brak oznacza H z pełnego bundle. |
| y-m, z-m | float / wymagane | $\mathrm m$ | Skończone, dokładny wybór fizycznej linii; brak wyboru najbliższej warstwy. |
| expected-count | int / wymagane | $1$ | Co najmniej cztery punkty jawnie zadanej linii. |
| expected-x-first-m | float / wymagany | $\mathrm m$ | Skończony początek zaplanowanego profilu. |
| expected-step-m | float / wymagany | $\mathrm m$ | Dodatni, skończony odstęp, bez odgadywania go z brakujących próbek. |
| output-dir | Path / wymagany | $1$ | Nowy katalog, bez nadpisywania wyników. |

Nie ma nowego publicznego API Python, ProblemIR, capabilities, etapu
runtime ani formatu produkcyjnego. Wszystkie parametry należą do prywatnego
postprocessingu, nie serializują się do ProblemIR. Requested profile,
tożsamość wejść i zakres inspection_only pozostają w raporcie.

Pozycje wybranej linii są sortowane razem z wartościami H. Narzędzie
odrzuca powtórzenia, nieregularny lub niekompletny profil, niezgodne
jednostki, niefinity oraz zerowy prąd. Kompletność sprawdza względem
jawnych expected-count/x-first/step; inne warstwy nośnika mogą mieć
inne pozycje x. Sprawdzenie równomierności dziedziczy rtol=1e−9;
wartości wejściowe przekazywane do FFT nie są poprawiane.

FFT_POSTPROCESSING_PASS oznacza jedynie, że wykonano transformację
poprawnego wejścia. publication_agreement pozostaje NOT_VERIFIED,
native_spectrum_executed=false, source_status=inspection_only. Wynik powstaje
w NumPy z natywnego H; nie jest wykonaniem publicznego etapu
antenna_spectrum ani potwierdzeniem zbieżności okna/próbkowania.

Przy INPUT_REJECTED zapisujemy przyczynę i manifest wejść; nie powstaje
spectrum.csv. Nie dodajemy automatycznie referencji nieskończonych pasków:
dla pełnego obwodu różnica względem niej jest różnicą modeli, a nie samym
błędem obliczania H. Warunki i odniesienie wymagają osobnego eksperymentu.

FEM CPU: prywatny odczyt zachowanych danych inspekcyjnych i CPU NumPy;
kwalifikacja natywnego widma pozostaje NOT VERIFIED. FEM GPU, FDM CPU
i FDM GPU nie są wykonywane ani kwalifikowane tym narzędziem.
Dodatnie testy syntetyczne są oddzielone od odmowy dla prawdziwego H92.
W wykonaniu 18.11.2026 odczyt źródła i pola przeszedł kontrolę hashy,
jednostek i relacji rodzic–potomek. Wybrana linia zawierała 23 próbki
zamiast jawnie zadanych 81 punktów co 50 nm w ±2 µm; narzędzie zakończyło
się oczekiwanym kodem 2 i INPUT_REJECTED. Nie powstało widmo ani nowy wynik H.
Wszystkie 16 kontroli odbioru oraz 17 testów (11 nowych i 6 istniejących)
przeszło. Przetwarzanie zajęło 0,558 s i maksymalnie 158,31 MiB RSS.
Dokładne wejścia, komenda i wyniki pozostają w
examples/sushruth_2020_closed_gsg/native_field_fft_20261118:
criteria.json, edge92-verification.json oraz edge92-rejection/result.json.
Ten test kontraktu nie definiuje nowej siatki solvera ani wystarczającego
profilu do odtworzenia Fig.1. Zgodność natywnego widma pozostaje niepotwierdzona.

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| scripts/native_antenna_field_fft.py | load_native_field | Przypięte wejścia i relacja źródła oraz pola. |
| scripts/native_antenna_field_fft.py | extract_line | Jawny fizyczny profil, kompletność i signed I. |
| scripts/native_antenna_field_fft.py | compute_spectrum | Istniejąca konwencja DFT i A+. |
| scripts/native_antenna_field_fft.py | run_postprocessor | Artefakty i ograniczony werdykt, bez Solve. |
| scripts/test_native_antenna_field_fft.py | class NativeFieldFftTests | Syntetyczne regresje fazy, jednostek, kompletności i provenance. |


(sushruth-edge92-same-current-reference)=
## Kontrola H92 z dokładnie tego samego prądu — 18.11.2026

Rozszerzono wyłącznie odczytowy postprocessing istniejącej metody
{ref}`sushruth-analytic-rt0-face-reference` na wszystkie 92 zachowane targety.
Wykorzystano źródło 40 728 Tet4, 14 194 wierzchołki i podpisany prąd
$1.7549315667730878\times10^{-5}\ \mathrm A$. Wymiary pasków
(szerokość/szczelina/grubość) to $200/250/90\ \mathrm{nm}$.
Próbki: 23 niejednorodne pozycje $x$ od $-2$ do $2\ \mathrm{\mu m}$,
$y=\pm50\ \mathrm{nm}$ oraz $z=-22.4,-5\ \mathrm{nm}$.
Współczynniki RT0 odtworzono bajtowo z oryginalnych momentów ścian;
sprawdzono pięć pinów tożsamości rodzica, wszystkie XYZ, jednostki i payloady.

Wykonano tę samą analityczną całkę wektorową w longdouble oraz float64,
z akumulacją longdouble i zapisem float64. Kryteria z poprzedniej kontroli
zapisano przed wykonaniem: L2/max native $10^{-6}$, stabilność precyzji
$10^{-9}/10^{-8}$; mianownik punktowy
$\max(1\ \mathrm{m^{-1}},\|\mathbf H_{\mathrm{ref}}/I\|)$.
Norma L2 obejmuje próbki, bez wag objętości. Nie zmieniono tolerancji solvera.

| Kontrola wszystkich 92 wektorów | Wynik | Werdykt |
|---|---:|---|
| Native vs referencja, względne L2 | $7.861634347244416\times10^{-17}$ | PASS |
| Native vs referencja, maksimum punktowe | $1.4591454319879294\times10^{-15}$ | PASS |
| float64 vs longdouble, względne L2 | $8.291010921779853\times10^{-15}$ | PASS |
| float64 vs longdouble, maksimum punktowe | $2.2385159420813517\times10^{-12}$ | PASS |

Wykonanie: $60.105\ \mathrm s$, jeden CPU, szczyt RSS
$116.961\ \mathrm{MiB}$; limity prywatnej referencji
$720\ \mathrm s$ i $2048\ \mathrm{MiB}$. Największa obserwowana
różnica surowych wektorów to
$3.972057181878092\times10^{-15}\ \mathrm{A\,m^{-1}}$.
Nie jest to certyfikat dokładności fizycznej ani przedziałowego błędu całki.

Zgodność identycznego RT0 nie wskazuje na błąd operatora H jako źródło
wcześniejszej różnicy od jednorodnych pasków (maksymalnie 0.110560831%,
w 84 środkowych punktach 0.001049465%). Pozostaje różnica opisu źródła:
pełna geometria i prąd 3D kontra jednorodne paski bez poprzeczek.
Nie rozdzielono tu osobno wpływu geometrii i rozkładu prądu.

Publiczne wykonanie H92 nadal ma Failed po błędzie publikacji;
wynik pozostaje inspection_only/not_verified. Brak nowego native H,
transportu, FFT lub LLG. Parametry różnią się od idealnego rysunku 1,
więc ten odbiór nie zamyka zgodności widm S/GS/GSG z publikacją.
Niejednorodne x nie są zwykłą siatką FFT. Wcześniejszy FAIL maksimum
1.477 ppm dla 85 980 Tet4 pozostaje niezmieniony.
FEM CPU: odczyt zachowanych danych i niezależny postprocessing;
FEM GPU, FDM CPU, FDM GPU: bez nowych dowodów.
Publiczny Python, ProblemIR, planner i runtime pozostają bez zmian.

Wykonywalny adapter, prerejestracja, siedem regresji wejść, pełne 92 wektory,
wykres i raport:
examples/sushruth_2020_closed_gsg/edge92_same_current_reference_20261118/.
Kryteria i piny są w criteria.json, wynik w results/results.json.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/edge92_same_current_reference_20261118/compare.py | validate | Tożsamości rodzica, źródła i punktów |
| examples/sushruth_2020_closed_gsg/edge92_same_current_reference_20261118/compare.py | main | Niezmieniona całka dla wszystkich 92 punktów i metryki |
| examples/sushruth_2020_closed_gsg/edge92_same_current_reference_20261118/test_input_contract.py | class InputContract | Regresje obcego źródła, kolejności, liczności, prądu i niefinitywnego H |
| examples/sushruth_2020_closed_gsg/edge92_same_current_reference_20261118/render.py | render | Pola i reszty; przycięcie poniżej $10^{-12}$ ppm wyłącznie na wykresie |


(sushruth-longitudinal-gsg-spectrum)=
## Wpływ położenia względem końców zamkniętej GSG — prerejestracja

Pytanie: gdzie porównanie zachowanego prądu pełnej anteny z nieskończonymi
paskami o zgodnym przekroju przestaje być użyteczne? Korzystamy z
istniejącej redukcji liniowej transformaty prawa Biota–Savarta i tego
samego lokalnego RT0 opisanych w sekcji
{ref}`sushruth-retained-rt0-line-spectrum`. Zmieniamy tylko linię obserwacji
$y$, przy stałym $z$, źródle i normalizacji. Dodatni i ujemny koniec
pozostają osobnymi pomiarami; nie narzucamy symetrii źródła.

Amplituda $A=-2\widehat H_x/I$ jest bezwymiarowa. Przy konwencji
$\exp(+ikx)$ pole $\widehat H_x$ ma jednostkę $\mathrm A$, a podpisany
prąd $I$ — $\mathrm A$. Dla nierównomiernego próbkowania stosujemy
regułę trapezów $\mathcal T_k$ z fizycznymi szerokościami przedziałów:

```{math}
:label: eq-sushruth-longitudinal-error
E_2(y)=
\sqrt{\frac{\mathcal T_k\!\left[|A_y-A_\infty|^2\right]}
{\mathcal T_k\!\left[|A_\infty|^2\right]}},
\qquad
E_{\max}(y)=\max_{k_j}|A_y(k_j)-A_\infty(k_j)|.
```

Obie miary są bezwymiarowe; mianownik musi być niezerowy. $A_\infty$
oznacza referencję nieskończoną ze zgodnym przekrojem, $k_j$ ma jednostkę
$\mathrm{rad\,m^{-1}}$, a $\mathcal T_k$ zwraca całkę po $k$.
Sprawdzamy również różnicę kwadratów modułów, ale nie zastępuje ona
kontroli zespolonego znaku i fazy. Nie wykonujemy dopasowania.


| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $A_y,A_\infty,E_2,E_{\max}$ | Amplitudy zespolone i normy błędu, bezwymiarowe | $1$ |
| $k,k_j$ | Liczba falowa i jej próbki | $\mathrm{rad\,m^{-1}}$ |
| $y$ | Współrzędna wzdłuż anteny | $\mathrm m$ |
| $\mathcal T_k$ | Operator całki trapezowej po k | $\mathrm{rad\,m^{-1}}$ |


| Parametr | Typ / ustawienie | Jednostka SI | Znaczenie, źródło i walidacja |
|---|---|---|---|
| Źródło | 85 980 Tet4, przypięty frozen RT0 i bundle | $1$ | Zachowane V/J/H corner12p5, SHA256 przed odczytem; brak nowego transportu |
| Granice źródła | x=±550 nm, y=±12 µm, z=30…120 nm | $\mathrm m$ | Z wierzchołków zachowanej siatki |
| y obserwacji | float: +8,+10,+11,5,−11,5 µm | $\mathrm m$ | Cztery nowe przekroje; odległości od zewnętrznego końca4,2,0,5µm |
| z obserwacji | float: −13,7 nm | $\mathrm m$ | Płaszczyzna ściśle poniżej źródła |
| y=0 | zachowane CSV rzędów4/6 | $\mathrm m$ | Środek ponownie odczytany, bez ponownego obliczenia |
| L,g,s,t referencji | 200,250,43,7,90 nm | $\mathrm m$ | Zgodny przekrój: nie idealne parametry Fig.1 |
| k | 73 wartości:0…2 co0,125;2,5…30 co0,5 | $\mathrm{rad\,\mu m^{-1}}$ | Rosnące skończone liczby; w pliku SI |
| Kwadratury | int:4,6 oraz8 | $1$ | Istniejący Gauss–Duffy, bez zmiany implementacji |
| Punkty kontroli n=8 | 0;0,5;1;2;6;15;30 | $\mathrm{rad\,\mu m^{-1}}$ | Siedem jawnie przypiętych punktów, nie cała krzywa |
| max przyrost4→6 /6→8 | float:1e-4 /1e-5 | $1$ | Kryteria numeryczne zapisane przed obliczeniem; bez zmiany tolerancji produkcji |
| E2 /Emax modelu | float:1e-3 /1e-3 | $1$ | Prywatny test użyteczności przybliżenia, nie próg publikacji |
| CPU /RSS /czas | int:1 /2048 /1800 | $1$, $\mathrm{MiB}$, $\mathrm s$ | Postprocessing CPU; limit przestrzeni adresowej2GiB |
| output | nowy katalog results | $1$ | Odmowa nadpisania wcześniejszych danych |

Wynik testu modelu jest odrębny od odbioru kwadratury. FAIL modelu może
być poprawnie zmierzonym wpływem końców; FAIL kwadratury blokuje taki
wniosek ilościowy. Próba rozdziela położenie obserwacji, ale nie oddziela
przyczynowo skończonej długości, geometrii połączeń i redystrybucji J.
Wnioski dotyczą próbkowanych k i y, bez interpolowanej granicy ważności.
Przypięta definicja: examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/criteria-preregistered.json.

Publiczny Python, ProblemIR, planner, normalizacja, runtime i provenance
produkcyjne nie zmieniają się. Prywatny Python czyta zachowany FEM CPU
RT0 i liczy niezależną referencję; nie emituje ProblemIR ani nowego
zaakceptowanego wyniku pola. FEM GPU, FDM CPU i FDM GPU nie są tutaj
uruchamiane lub kwalifikowane. Source inspection_only pozostaje.
Bibliografia i równania redukcji są wspólne z wcześniejszą sekcją widma.
Nie kwalifikujemy natywnego H/FFT, S/GS, LLG ani następnych figur pracy.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/longitudinal_spectrum.py | spectrum_metrics | Zespolony błąd i norma z wagami nierównomiernego k |
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/longitudinal_spectrum.py | run_experiment | Przypięty RT0, cztery położenia, trzy rzędy i osobne werdykty |
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/test_longitudinal_spectrum.py | class SpectrumMetricsTests | Wagi, znak, faza oraz odmowy niepoprawnych norm |


### Aneks odczytowy zaplanowany po starcie

Niezależny przegląd ujawnił dwa ograniczenia: pierwotne piny objęły
wrapper analityczny, ale nie dwie importowane definicje; zapisany środek
ma61k, nowe przekroje73k. Pierwotna prerejestracja pozostaje bez zmian.
Dodatkowy audyt porówna zespoloną zapisaną referencję z zamkniętym wzorem
nieskończonych pasków ze skończoną grubością i policzy metryki na
wspólnych61k bez interpolacji. Wykorzystuje równania już opisane w nocie;
nie oblicza nowego pola.

| Parametr audytu | Typ / ustawienie | Jednostka SI | Walidacja i znaczenie |
|---|---|---|---|
| reference_max_absolute_difference | float:2e-14 | $1$ | Zgodność zespolonego A∞ z jawnym wzorem, obejmuje znak i normalizację |
| metric_max_absolute_readback_difference | float:5e-14 | $1$ | Zgodność metryk obliczonych niezależnie jawnymi wagami przedziałów |
| common_grid | 61 wartości:0…30 co0,5 | $\mathrm{rad\,\mu m^{-1}}$ | Wyłącznie dokładnie obecne współrzędne; bez interpolacji |
| late_dependency_pins | mapa path→SHA256 | $1$ | Hashe dwóch definicji wzorca od chwili dodatkowego planu; nie dowód wcześniejszego przypięcia |
| output | readback-audit.json | $1$ | Osobny wynik, brak nadpisania pierwotnego results.json |

Ten aneks nie odtwarza brakującej prerejestracji zależności i nie
nadaje trwałego uwierzytelnienia źródłu produkcyjnemu. Renderer otrzymuje
tylko zachowane CSV; zakres osi błędu wynika z danych. Przycięte
zakresy k są jawnie nazwanymi powiększeniami, a pełne dane pozostają w CSV.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/audit_readback.py | closed_reference | Algebraiczny odczyt wzorca ze zgodnym przekrojem |
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/audit_readback.py | independent_metrics | Jawne wagi przedziałów, wspólna siatka61k |
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/audit_readback.py | audit_results | Odrębny audyt po starcie, bez zmiany pierwotnych wyników |
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/render_longitudinal_spectrum.py | render_comparison | Wykres i raport z zachowanych CSV, brak nowego pola |


### Odrębne uzupełnienie po limicie czasu

Pierwotny proces zakończył się po 1800,007 s z TimeoutError i trzema
kompletnymi przekrojami. Jego limit, kryteria i wynik wykonania pozostają
bez zmian. Zachował również n4 dla y=−11,5 µm; n6 i n8 tego przekroju
nie zostały zapisane. Warunkowy plan uzupełnienia powstał przed jego
uruchomieniem, po zaobserwowaniu wzrostu kosztu kwadratury na hoście.

Jeden osobny proces referencyjny odczyta wyłącznie brakujące n6/n8.
Sprawdzi terminalny exit receipt, nieobecność pierwotnego PID, hashe
drivera i kryteriów oraz wszystkie siedem pinów wejściowych. Zachowane
CSV i podsumowania są kopiowane z kontrolą hashy do nowego katalogu;
nie nadpisuje się pierwotnego failure ani wyników. Metryki i wzory
pozostają te same.

| Parametr uzupełnienia | Typ / ustawienie | Jednostka SI | Walidacja i znaczenie |
|---|---|---|---|
| position | int: 3; y=−11,5 µm | $1$, $\mathrm m$ | Wyłącznie ostatni przekrój; trzy wcześniejsze ukończone |
| orders | int: 6 i 8 | $1$ | n4 pozostaje odczytem; te same 73/7 wartości k |
| additional_time_limit | int: 900 | $\mathrm s$ | Odrębny limit, nie zmiana pierwotnego 1800 s |
| CPU / address_space | int: 1 / 2147483648 | $1$, $\mathrm{byte}$ | Ten sam zakres zasobów; bez GPU i native Solve |
| output | completion-results | $1$ | Nowy katalog; brak nadpisania starej próby |
| primary_time_budget_pass | bool: false | $1$ | Trwały wynik pierwszej próby; PASS kwadratury go nie zmienia |

Budżet dodatkowy ustalono na 900 s przed jego wykonaniem, ponieważ
obserwowane czasy bloków kwadratury wzrosły z około42 do64s. Pierwszy
projekt 600 s nie został wykonany. Ten eksperyment nie kwalifikuje
wydajności pod stałym obciążeniem. W raporcie sumujemy czasy procesów
obliczeniowych bez przerwy między nimi; RSS uzupełnienia dotyczy
wyłącznie tego dodatkowego procesu.

| Path | Symbol | Odpowiedzialność |
|---|---|---|
| examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/complete_negative_end.py | complete_negative_end | Jeden odczyt brakujących rzędów; osobny wynik czasu i kwadratury, zachowanie pierwszej próby |


### Wynik pomiaru wpływu końców — 17.11.2026

**Zgodność częściowa z modelem nieskończonych pasków o zgodnym przekroju;
pełna walidacja natywnego pola i widma Fullmaga pozostaje niepotwierdzona.**
Wszystkie cztery przekroje przeszły prerejestrowane kontrole kwadratury.
Poniższa tabela używa wszystkich 73 wartości k dla każdego nowego przekroju.
E2 podano w procentach; pozostałe miary amplitudy są bezwymiarowe.

| y [µm] | Odległość od zewnętrznego końca [µm] | E2 [%] | Emax [1] | max zmiana n4→n6 [1] | max zmiana n6→n8 [1] | Przybliżenie nieskończone |
|---:|---:|---:|---:|---:|---:|---|
| +8 | 4 | 0.00054285106 | 1.68133484e-05 | 7.49531e-06 | 1.76105e-08 | PASS |
| +10 | 2 | 0.00673577075 | 0.000147799011 | 5.65675e-07 | 8.63278e-10 | PASS |
| +11.5 | 0.5 | 1.18531731 | 0.0147555169 | 4.30354e-07 | 7.92354e-10 | FAIL |
| -11.5 | 0.5 | 1.18526074 | 0.0147550606 | 4.17755e-07 | 1.37631e-09 | FAIL |

Przy y=+8 i +10 µm przybliżenie przechodzi prywatne kryteria.
Przy y=±11,5 µm jest odrzucone z powodu zmierzonego wpływu skończonego
obwodu: E2 około 1,19%, z podobnym wynikiem przy obu końcach.
To odrzucenie modelu przybliżonego, nie błąd numeryczny kwadratury.
Nie wyznaczamy ciągłej granicy ważności między odległościami 0,5 i 2 µm.
Nie izolujemy osobno długości, geometrii połączeń i redystrybucji prądu.

Dodatkowy audyt na dokładnie wspólnych 61 wartościach k, bez interpolacji,
daje E2: środek 0,0000130958%, y=+8 µm 0,000543210%,
y=+10 µm 0,00673456%, y=+11,5 µm 1,18656899%,
y=−11,5 µm 1,18651244%. Wartości te służą porównaniu położeń na
tej samej siatce. Nie zastępują pierwotnych metryk 73-punktowych.

Jawny zamknięty wzór odtwarza zespoloną referencję z maksymalną różnicą
2,220446049250313e-16. Niezależne jawne wagi przedziałów odtwarzają
metryki z różnicą co najwyżej 3,469446951953614e-18.
Oba odczyty przeszły swoje zapisane kryteria.
Hashe dwóch importowanych definicji i porównanie wspólnych 61 k są
audytem dodanym po starcie; nie przedstawiamy ich jako pierwotnej
prerejestracji. Kontrola hashy łączy wynik, audyt i renderer.

Wykonanie zachowuje werdykt **NUMERICAL_PASS_PRIMARY_TIME_BUDGET_FAIL**:
pierwszy proces zakończył się po 1800,006705 s, odrębne uzupełnienie
n6/n8 trwało 690,853156 s, łącznie 2490,859861 s pracy procesów.
Pierwotny failure i wyniki są niezmienione. Szczytowy RSS 178,586 MiB
dotyczy wyłącznie procesu uzupełnienia; nie jest maksimum całej serii.
Użyto jednego CPU i limitu przestrzeni adresowej 2 GiB, bez GPU.

Sześć regresji metryk, siedem istniejących regresji fizycznego kernela
oraz 41 regresji kontraktu dokumentacji zakończyło się poprawnie.
Nie kompilowano natywnego solvera. Obraz porównania sprawdzono wizualnie:
legenda jest poza danymi, pełne pasmo różnicy widoczne, oba przybliżone
końce pokazane osobno, a powiększenie głównego maksimum jawnie opisane.

Zachowane wyniki znajdują się w
examples/sushruth_2020_closed_gsg/longitudinal_spectrum_20261117/completion-results:
results.json, CSV dla każdego rzędu i przekroju, readback-audit.json,
longitudinal-spectrum.png, longitudinal-spectrum.svg i raport.md.
Kryteria, pierwotny wynik czasu, polecenia wykonania i hashe pozostają
w katalogu nadrzędnym. Skrypty odmawiają nadpisania wyników.

To niezależne całkowanie zapisanej reprezentacji FEM RT0, a nie nowe
publiczne H/FFT Fullmaga. Źródło nadal ma zakres inspection_only.
Duże różnice wobec idealnej Fig.1 nie mogą być interpretowane bez
uwzględnienia odmiennej szczeliny, odstępu próbki i grubości metalu;
ich wcześniejszy kontrolowany test jest zestawiony w raporcie.
Niniejszy pomiar dodaje ilościowy wpływ położenia w skończonym obwodzie.
Nie potwierdza anten S/GS, zbieżności siatki prądu ani następnych figur.
