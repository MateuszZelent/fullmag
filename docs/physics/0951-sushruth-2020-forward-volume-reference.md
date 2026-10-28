# Fale forward-volume — niezależny wzorzec Sushruth 2020

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
| inductive_response.max_kl | float | 80.0 | $1$ | skończony > 0 | górny limit q = |k|L | niezależny wzorzec NumPy; bez backendu Fullmaga | nie serializuje się do ProblemIR |
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
