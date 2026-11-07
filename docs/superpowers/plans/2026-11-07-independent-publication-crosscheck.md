# Niezależne publikacje i kontrola dyspersji — 07.11.2026

## Wynik i zakres

Przeprowadzono audyt literatury oraz 106-punktową kontrolę matematyczną.
Nie odtworzono nowego wykresu impedancji, transmisji ani odpowiedzi LLG.
Nie ma dowodu błędu autorów Sushruth 2020. Główny cel reprodukcji tej pracy
pozostaje nieukończony.

To datowany raport odczytowy zgodny z zakresem audytowym
`scientific-documentation-contract`, nie nowa terminalna nota metody ani
kwalifikacja produkcyjnego solvera. Nie zmieniono kanonicznej fizyki,
Python DSL, ProblemIR, progów naukowych, runtime lub dawnych wyników.
Przed wdrożeniem nowej realizacji konieczne są kompletna nota i jej bramki.

Baza repozytorium: `2f995c0d89694f0ea7068a1166c923b23df143e1`.
Źródło wzorca odczytane w kontenerze:
`scripts/reference_sushruth_2020_response.py::film_susceptibility`,
SHA256 `536c053c4ea67deca0e44c86b0ae0e3500f14e03263bb4184a47ac94543aa093`.

## Wybór źródeł

1. [Connelly i in., Scientific Reports 11,18378 (2021)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8443574/),
   DOI 10.1038/s41598-021-97627-3: CPW i fale forward-volume. Rys. 2a zestawia
   impedancję z modelu analitycznego i HFSS. Autorzy opisują przesunięcie
   związane ze zmianą prądu przez próbkę. To podobny reżim, lecz inny materiał
   i obserwabl niż transmisja Sushrutha. Nie wolno porównywać tych amplitud wprost.
2. [Bruckner i in., Scientific Reports 15,19993 (2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12144178/),
   DOI 10.1038/s41598-025-05463-6: pole Oersteda, LLG i rezystancja fal spinowych
   w magnum.np; konfiguracja Damon–Eshbach, YIG i antena U. Przyjmuje jednorodny
   prąd; dane są dostępne od autora na żądanie, nie potwierdzono publicznych
   surowych krzywych. To późniejsza kontrola całego łańcucha, nie bezpośrednia
   kopia naszego przypadku forward-volume.
3. [Erdélyi i in., Scientific Reports 15,9806 (2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11928728/),
   DOI 10.1038/s41598-025-94474-4: rys. 4c–f z zespolonymi Z11/Z21 i eksperymentem;
   publiczne [źródła autorów](https://github.com/a-papp/spin-wave-transducer/tree/af2e7c8e927abf5265de4f115448a962818040c8).
   Audyt tego commita wykazał różnice konfiguracji względem opisu publikacji:
   bias 387 wobec 383 mT, pole FEMM 9 GHz wobec sweepu 13–14 GHz oraz nadpisanie
   tłumienia przez regiony. Nie dowodzi to błędu opublikowanych wyników.
   Nie uruchamiano ani nie kopiowano kodu solverów zewnętrznych.

Te listy autorów nie pokrywają się z listą Sushruth 2020. Niezależna lista
autorów nie gwarantuje niezależności wszystkich założeń teoretycznych.

## Pierwsza wykonana kontrola: warunki brzegowe warstwy

Odczytano [autorski suplement Connelly 2021 w ResearchSquare](https://assets-eu.researchsquare.com/files/rs-852082/v1/01bdd5e430007e75053019bc.pdf):
8 stron, S2 Eq. 6 oraz S4 Eq. 9 i Fig. S4. Nie potwierdzono identyczności bajtowej
z suplementem wydawcy; jego publiczne trasy zwróciły CAPTCHA lub błąd dostępu.
Historyczna nazwa pobranego pliku `connelly-2021-preprint.pdf` jest myląca:
sprawdzona treść to suplement, nie główny artykuł. SHA256:
`a9f10a8de272d758dcbeab94176ac597a2bf902ea050a8aab83e90c57019d5c7`.
Wizualnie sprawdzono stronę 7 z równaniem i wykresem.

Dla podstawowego, bezstratnego modu bez wymiany przyjęto zmienne:

```{math}
:label: eq-connelly-audit-boundary
x=|k|t,\qquad u=\sqrt{-(1+\chi_d)},\qquad
\theta=\arctan(1/u),\qquad 0<\theta<\pi/2,\qquad
\tan(xu/2)=1/u\iff x=2\theta\tan\theta.
```

Z Eq. 6 wynika:

```{math}
:label: eq-connelly-audit-factor
N_\mathrm{boundary}=\sin^2\theta,\qquad
\omega^2=\omega_0^2+\omega_0\omega_M N_\mathrm{boundary},\qquad
\omega_0=\gamma_B b_e,\quad \omega_M=\gamma_B b_M.
```

Jest to przekształcenie równań do audytu, nie nowy model Fullmaga.

| Symbol | Znaczenie | SI |
|---|---|---|
| $k$ | wektor falowy w płaszczyźnie | $\mathrm{rad\,m^{-1}}$ |
| $t$ | grubość magnetyka | $\mathrm m$ |
| $x$ | iloczyn modułu wektora falowego i grubości | $1$ |
| $u$ | dodatni pierwiastek z $-(1+\chi_d)$ | $1$ |
| $\theta$ | parametr podstawowej gałęzi warunków brzegowych | $1$ |
| $N_\mathrm{boundary}$ | czynnik dyspersji z warunków brzegowych | $1$ |
| $\chi_d$ | diagonalna podatność Poldera | $1$ |
| $\omega,\omega_0,\omega_M$ | częstotliwości kołowe z powyższego równania | $\mathrm{rad\,s^{-1}}$ |
| $b_e,b_M$ | odpowiednio $\mu_0 H_\mathrm{eff}$ i $\mu_0 M_s$ | $\mathrm T$ |
| $\gamma_B$ | współczynnik dla pól w teslach | $\mathrm{rad\,s^{-1}\,T^{-1}}$ |
| $N_\mathrm{uniform}$ | czynnik dla jednorodnej grubości | $1$ |

Porównano $N_\mathrm{boundary}$ z istniejącym przybliżeniem jednorodnej grubości:

```{math}
:label: eq-connelly-audit-uniform
N_\mathrm{uniform}=1-\frac{1-e^{-x}}{x},\qquad N_\mathrm{uniform}(0)=0.
```

Parametry do przeliczenia różnic na częstotliwość
pochodzą jawnie z **Sushruth Table I**, nie z YIG Connelly'ego:
$b_e=0{,}25\,\mathrm T$, $b_M=0{,}89\,\mathrm T$, $\gamma_B/(2\pi)=30\cdot10^9\,\mathrm{Hz\,T^{-1}}$, $t=20\cdot10^{-9}\,\mathrm m$.
Brak tłumienia dotyczy tu dyspersji własnej, nie zastępuje tłumionej
podatności używanej w całkach transmisji.

## Dowód wykonania i liczby

Plan i kontrole zapisano przed obliczeniem. Bisekcję dla $\theta$ sprawdzono
osobnym Brentem dla $u$ oraz podstawieniem do oryginalnego równania tangensa.
Czynnik starego wzorca odzyskano dodatkowo z jego podatności statycznej.
106 punktów obejmuje $x=0$ i $x$ od 0,0001 do 10.

| Kontrola | Wynik | Próg audytu |
|---|---:|---:|
| Różnica N między dwiema trasami pierwiastka | 1,3323e-15 | 2e-13 |
| Maksymalne względne residuum równania u tan(xu/2)=1 | 3,4417e-15 | 2e-12 |
| Zgodność N_uniform z istniejącym kodem | 2,2204e-16 | 1e-12 |
| Ciągła gałąź, monotoniczność, skończoność, 0<=N<1 | PASS | wszystkie próbki |

| $k$ [$\mathrm{rad}/\mu\mathrm m$] | $x$ | $f_\mathrm{uniform}$ [$\mathrm{GHz}$] | $f_\mathrm{boundary}$ [$\mathrm{GHz}$] | Różnica [$\mathrm{MHz}$] |
|---:|---:|---:|---:|---:|
| 0 | 0 | 7,500000 | 7,500000 | 0 |
| 5 | 0,1 | 8,120156 | 8,120188 | 0,032201 |
| 10 | 0,2 | 8,660495 | 8,660722 | 0,227171 |
| 25 | 0,5 | 9,945629 | 9,948206 | 2,577428 |
| 50 | 1 | 11,398152 | 11,411548 | 13,396678 |

Przy $k=0$ oba równania dają dokładnie $7{,}5\,\mathrm{GHz}$. Zmiana profilu grubości nie
wyjaśnia zatem przesunięcia znacznika FMR w Fig. 3 Sushrutha. To wniosek
wyłącznie dla tej konkretnej hipotezy. Nie obliczono wpływu nowej dyspersji
na pełną całkę zespolonej transmisji; podane różnice częstotliwości modów
nie są automatycznie przesunięciami maksimum transmisji.

## Artefakty i granice dowodu

Dowody pozostają w prywatnym wolumenie istniejącej grupy 3203, pod:
`/opt/fullmag/control/verification/independent-transducer-reference-20261107/`.

| Artefakt | SHA256 |
|---|---|
| dispersion-audit-plan.json | 30e54f0a558c627239f6ecbc1484dd4d875ab6f211536276770d8628021cf807 |
| dispersion-audit.py | 5ed583431358f0013065723373a40ead5a844b853da3a54a0742283611a32be4 |
| dispersion-audit.json | 6953e0ef9b181d03467f4e92690df885e1d4385453b3484ec11a73257c88f1de |

Kod audytu to odtwarzalny dowód techniczny z funkcjami `boundary_factor`
i `direct_factor`, nie publiczna powierzchnia Python ani solver równoległy.
Dwie metody pierwiastka kontrolują numerykę tego samego równania;
nie stanowią dwóch niezależnych dowodów fizycznych.

| Realizacja Fullmaga | Status dowodu tego audytu |
|---|---|
| FDM CPU | nie wykonano solvera |
| FDM GPU | nie wykonano solvera |
| FEM CPU | nie wykonano solvera |
| FEM GPU | nie wykonano solvera |

Nie wykonano native builda, meshowania, Solve, restartu, zmiany rezerwacji
lub usunięcia danych. Pełne Fig. 2a Connelly'ego pozostaje NOT VERIFIED:
brakuje zweryfikowanego wejścia RF/prądu, pełnej normalizacji obserwabli,
przypadku wykonawczego Fullmaga i odczytu krzywych z niepewnością.
Fig. 4 Erdélyiego wymaga najpierw rozstrzygnięcia ustawień źródeł.

Następny merytoryczny krok w głównym zadaniu: zachować to rozróżnienie
modeli przy domknięciu zbieżności źródła 3D, następnie zakwalifikować pole
na siatce magnetyka i wykonać odpowiedź LLG/odbiór indukcyjny. Nie wolno
ogłaszać zgodności publikacyjnej na podstawie samego H lub tego audytu.
