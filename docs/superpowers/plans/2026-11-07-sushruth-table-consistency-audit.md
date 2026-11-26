# Spójność wielkości pochodnych w Table I — 07.11.2026

## Wniosek i granice

Literalne 105 m/s, szerokość 230 MHz i długość tłumienia 1,2 µm nie spełniają
równocześnie definicji długości tłumienia z publikacji dla tego samego modu.
Rozbieżność wynosi czynnik 8,2579. Tabela nie podaje wektora falowego tych
wielkości; audyt nie ustala intencji autorów ani nie dowodzi błędu ich wyników.

Istniejący wzorzec Fullmaga wyznacza dyspersję i tłumienie z parametrów
materiałowych. Nie używa wpisu 105 m/s jako wejścia. Nie jest to zatem
zidentyfikowana przyczyna różnicy Fig. 3. Nie zmieniono parametrów, znaków,
normalizacji ani zachowanych wyników. Zgodność z Fig. 3 pozostaje niepotwierdzona.

To wewnętrzny raport odczytowy zgodny z zakresem audytowym
scientific-documentation-contract. Nie wprowadza metody produkcyjnej,
nowego API lub ProblemIR i nie zastępuje kanonicznej
[noty 0951](../../physics/0951-sushruth-2020-forward-volume-reference.md).

## Źródła i parametry

Sprawdzono [publikację Sushruth i in.](https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.2.043203)
oraz [arXiv v1, Table I i Eq. 2–5](https://arxiv.org/html/2001.11483v1).
W oryginalnym PDF oraz źródłowym main.tex zapisano 105 m/s — nie jest to
wyłącznie błąd konwersji HTML. Zachowany obraz tabeli został obejrzany.

| Wejście audytu | Wartość |
|---|---:|
| $b_e=\mu_0 H_z^\mathrm{eff}$ | $0{,}25\,\mathrm T$ |
| $b_M=\mu_0 M_s$ | $0{,}89\,\mathrm T$ |
| $t$ | $20\cdot10^{-9}\,\mathrm m$ |
| $\gamma_B/(2\pi)$ | $30\cdot10^9\,\mathrm{Hz\,T^{-1}}$ |
| $\alpha$ | $0{,}01$ oraz $0{,}1$ |
| $k$ | 12 punktów od $0$ do $5\cdot10^8\,\mathrm{rad\,m^{-1}}$; pełna lista w plan.json |

Duże wartości k służą tylko diagnozie literalnego równania bez wymiany.
Nie kwalifikują jego fizycznej dokładności w tym zakresie.

## Kontrola rachunku i jednostek

Zastosowano te same równania dyspersji i szerokości co w istniejącym wzorcu:

```{math}
:label: eq-table-audit-mode
\omega_k=\gamma_B\sqrt{b_e(b_e+b_M n)},\qquad
n=1-\frac{1-e^{-x}}{x},\quad x=|k|t,\qquad
\Delta\omega_k=\alpha\gamma_B(2b_e+b_M n).
```

Prędkość dla dodatniego k i długość tłumienia wyliczono jako:

```{math}
:label: eq-table-audit-velocity
v_g=\frac{\partial\omega_k}{\partial k}
=\frac{\gamma_B b_e b_M t}{2\sqrt{b_e(b_e+b_M n)}}
  \frac{1-(1+x)e^{-x}}{x^2},\qquad
L_\mathrm{att}=\frac{2|v_g|}{\Delta\omega_k}
=\frac{|v_g|}{\pi\,\Delta f_k},\quad
\Delta f_k=\frac{\Delta\omega_k}{2\pi}.
```

W k=0 użyto granicy prawostronnej: n=0 oraz pochodnej n względem x równej 1/2.
Dyspersja parzysta w k ma tam naroże; nie przypisujemy jej pochodnej dwustronnej.

| Symbol | Znaczenie | SI |
|---|---|---|
| $b_e,b_M$ | pola efektywne i nasycenia w konwencji powyżej | $\mathrm T$ |
| $\gamma_B$ | współczynnik żyromagnetyczny dla pola w teslach | $\mathrm{rad\,s^{-1}\,T^{-1}}$ |
| $t$ | grubość warstwy | $\mathrm m$ |
| $k$ | składowa wektora falowego | $\mathrm{rad\,m^{-1}}$ |
| $x,n,\alpha$ | argument bezwymiarowy, czynnik dipolowy i tłumienie | $1$ |
| $\omega_k,\Delta\omega_k$ | częstość kołowa i jej szerokość | $\mathrm{rad\,s^{-1}}$ |
| $\Delta f_k$ | szerokość wyrażona jako częstotliwość | $\mathrm{Hz}$ |
| $f=\omega_k/(2\pi)$ | częstotliwość własna | $\mathrm{Hz}$ |
| $v_g$ | prędkość grupowa | $\mathrm{m\,s^{-1}}$ |
| $L_\mathrm{att}$ | długość zaniku amplitudy | $\mathrm m$ |

## Wyniki

| $\alpha$ | $\Delta f$ z tabeli | $L$ z tabeli | $L$ z 105 m/s i tej szerokości | $v_g$ wymagane przez długość i szerokość |
|---:|---:|---:|---:|---:|
| 0,01 | 230 MHz | 1,2 µm | 0,145315 µm | 867,080 m/s |
| 0,1 | 2,3 GHz | 0,12 µm | 0,014532 µm | 867,080 m/s |

Kontrola wrażliwości na zaokrąglenie: zakładając 225–235 MHz i 1,15–1,25 µm,
otrzymujemy 812,887–922,843 m/s. Ten zakres nie obejmuje 105 m/s.
To jawne założenie o zaokrągleniu, nie niepewność eksperymentalna.

Poniższe liczby dotyczą wyłącznie równania wzorca przy alpha=0,01:

| Warunek | $k$ [rad/µm] | $f$ [GHz] | $v_g$ [m/s] | $\Delta f$ [MHz] | $L$ [µm] |
|---|---:|---:|---:|---:|---:|
| Granica k→0+ | 0 | 7,5 | 838,805 | 150 | 1,78 |
| vg=105 m/s | 125,882312 | 13,541645 | 105 | 319,502 | 0,104608 |
| szerokość 230 MHz | 38,010511 | 10,781929 | 357,369 | 230 | 0,494583 |

Dwa ostatnie wiersze są rozwiązaniami diagnostycznych warunków przy stałych
parametrach materiałowych. Nie dopasowano parametrów ani nie wybrano tych k
jako rzeczywistych modów wzbudzenia. W tabeli publikacji brakuje k potrzebnego
do jednoznacznego przypisania jej wierszy.

## Weryfikacja i odtwarzalność

Plan oraz progi zapisano przed wykonaniem. Użyto Decimal z precyzją 60 cyfr.
Pochodną analityczną sprawdzono osobną różnicą pięciopunktową, a w k=0
pięciopunktową różnicą jednostronną. Odwrotność istniejącej podatności
w 1, 6 i 9 GHz pozwoliła odzyskać współczynniki dyspersji i tłumienia mianownika bez zmiany kodu.

| Kontrola | Wynik | Próg |
|---|---:|---:|
| 12 pochodnych: maksymalna różnica względna | 4,09e-16 | 1e-12 |
| 72 próbki podatności: względna różnica współczynnika dyspersji | 4,44e-16 | 1e-12 |
| 72 próbki podatności: względna różnica szerokości | 6,66e-16 | 1e-12 |
| Liczba stanów k/alpha | 24 | wszystkie zapisane |
| Czas / szczyt RSS | 0,154 s / 34 500 KiB | limit 60 s CPU / 2 GiB przestrzeni adresowej |

Pole dowodu recovered_reference_pole_squared_max_relative_error ma skrótową
nazwę: sprawdza współczynnik omega_k² mianownika, a nie zespolone bieguny
podatności. Niezależny przegląd potwierdził rachunek i wymusił to doprecyzowanie.
Interpretacja długości zaniku zakłada słabe tłumienie oraz lokalną linearyzację
gałęzi; alpha=0,1 jest kontrolą formalnego rachunku, nie potwierdzeniem dokładności
przybliżenia w silniejszym tłumieniu.

Jest to zgodność rachunku z literalnymi równaniami, nie niezależny dowód
poprawności fizycznej tych równań. Nie obliczano ponownie Fig. 3, V/J/H,
meshu ani LLG. Nie wykonano buildu, restartu lub zmiany rezerwacji.
Zablokowano uruchamianie procesów potomnych.

| Realizacja Fullmaga | Dowód z tego audytu |
|---|---|
| FDM CPU | solver niewykonany |
| FDM GPU | solver niewykonany |
| FEM CPU | solver niewykonany |
| FEM GPU | solver niewykonany |

Dowody techniczne: verification/sushruth-table-consistency-20261107/
w prywatnym control volume grupy 3203. Mała kopia planu, kodu i wyniku jest
także na ext4 WSL w .superpowers/sdd/2026-11-07-sushruth-table-consistency/
tego worktree. Baza ca1f9d167038da76128eb8bb46350b55f77147a3.

| Plik | SHA256 |
|---|---|
| plan.json | 8d3cd462b3392d4253835cf1830c417f719d8451108fab45ff7c30dfcc2afcb5 |
| audit.py | d791c1c764de7fc01018aa0488479d7a68c2f3d276aab14f07c5183336296750 |
| result.json | 4f6933f8735f5bf1755e0cec44a3adcc5afef9a1c8daed00d1cc4d9b9cd100df |
| Oryginalny PDF | 9e2249ec39543ae7e16dd1af43ad1756a7b4f704a62fd9b2e5972334e2e3ca1f |
| main.tex w archiwum arXiv v1 | 2c117eb7331b2e7ea4f8c5fd48611964423ff7e29fce4b260d580a15ce9a0265 |

## Źródła kodu i następny krok

- scripts/reference_sushruth_2020_response.py::film_susceptibility — istniejąca
  podatność, SHA256 536c053c4ea67deca0e44c86b0ae0e3500f14e03263bb4184a47ac94543aa093;
  kod przed i po zgodny.
- audit.py::mode — obliczenia i pochodna równań na potrzeby tego audytu.
- audit.py::bisect — dwie diagnostyczne wartości k, bez fitu materiału.
- audit.py::run — kontrola pochodnej, 72 odczyty podatności i zapis dowodów.

Ten audyt zamyka kontrolę spójności wierszy Table I, ale nie rozbieżność
Fig. 3. Nie wolno użyć 105 m/s do ręcznego przesunięcia fazy ani „poprawić”
krzywej doborem innego pola. Nadal potrzebna jest kwalifikacja źródła 3D
i pola na magnetyku, a potem odpowiedź dynamiczna i właściwy odbiór.
Niezależna praca Connelly 2021 i wykonana kontrola 106 punktów pozostają
opisane w [osobnym raporcie](2026-11-07-independent-publication-crosscheck.md).
