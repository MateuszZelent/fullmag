# Całkowe momenty zachowanego prądu anten — 01.11.2026

Wewnętrzny raport diagnostyczny istniejących wyników, nie dokument publikacyjnej kwalifikacji. Nie wykonano nowego Solve ani nie zmieniono V/J/H, source identity, historii tasków, progów i statusu inspection_only. Odbiór E3/E8 pozostaje otwarty.

## Metoda i jednostki

Dla lokalnych śladów wektorowych w komórkach Tet4 zastosowano dokładne całkowanie funkcji afinicznej. Każdą zapisaną liczbę binary64 potraktowano jako jej dokładną liczbę wymierną. Nie uśredniano J pomiędzy komórkami. Moment obwodu prądowego nie jest magnetyzacją M ferromagnetyka.

```{math}
:label: eq-retained-current-global-moments
S_i=\int_\Omega J_i\,dV,\qquad T_{ij}=\int_\Omega x_iJ_j\,dV,\qquad \mu_i=\frac12\epsilon_{ijk}T_{jk}.
```

```{math}
:label: eq-retained-current-tet4-mass
\int_K N_aN_b\,dV=\frac{|K|}{20}(1+\delta_{ab}),\qquad \boldsymbol\mu(\mathbf x-\mathbf r_0)=\boldsymbol\mu(\mathbf x)-\frac12\mathbf r_0\times\mathbf S.
```

| Symbol | Znaczenie | SI |
| --- | --- | --- |
| $\mathbf x,\mathbf r_0$ | Współrzędne i przesunięcie początku | $\mathrm m$ |
| $\mathbf J$ | Lokalna gęstość prądu z zaakceptowanego zapisu | $\mathrm{A\,m^{-2}}$ |
| $\Omega,K,\lvert K\rvert$ | Nośnik źródła, komórka i jej objętość | $\mathrm{m^3}$ dla objętości |
| $N_a,N_b,\delta_{ab},\epsilon_{ijk}$ | Baza barycentryczna i symbole Kroneckera/Levi-Civity | $1$ |
| $S_i$ | Całka składowej prądu po objętości | $\mathrm{A\,m}$ |
| $T_{ij},\mu_i$ | Pierwszy moment prądu i moment magnetyczny obwodu | $\mathrm{A\,m^2}$ |
| $I$ | Zachowany podpisany prąd źródła | $\mathrm A$ |
| $L$ | Największy rozmiar źródła na osi kartezjańskiej | $\mathrm m$ |

Dla zlokalizowanego stacjonarnego prądu bez dywergencji całka S i symetryczna część T znikają. Są to warunki konieczne; same nie dowodzą lokalnej ciągłości ani zamknięcia obwodu. Wyprowadzenie: [Fitzpatrick, Localized Current Distribution, równania 668–675](https://farside.ph.utexas.edu/teaching/jk1/Electromagnetism/node53.html). Nie użyto tutaj przybliżenia dipolowego do obliczenia H.

## Wejścia i wykonanie

| Parametr | Wartość / reguła |
| --- | --- |
| Wybór danych | Pełne, przypięte źródła mikrostripu i GSG; hashe w selection.json |
| Skala długości | L = największy z trzech pełnych rozmiarów źródła |
| Przesunięcie do kontroli | (L, -2L, 3L), ustalone przed analizą |
| Limit pamięci analizy | 512 MiB; obniżony priorytet nice 10 |
| Próg akceptacji fizycznej | Brak; wyniki opisowe, bez dodawania kryterium po ocenie danych |
| Zmiana Python/ProblemIR/plannera/API | Brak; odczyt istniejącego archive payload |

Zapis selection.json powstał przed analizą. Weryfikowano hashe CAS/payloadów, pełną partycję komórek na jawne material_parts oraz kolejność ordinali. Fixture na jednostkowym Tet4 sprawdziły całki pola stałego i radialnego afinicznego oraz dokładną tożsamość translacji.

## Wyniki

| Obwód | Komórki | Prąd I [A] | Norma S [A m] | Norma S / (abs(I) L) | Norma sym(T) / (abs(I) L²) |
| --- | --- | --- | --- | --- | --- |
| microstrip | 1856 | 0.142836559881 | 2.00814077e-24 | 5.85792127e-18 | 1.87524033e-18 |
| gsg | 14304 | 1.75353999117e-05 | 9.60445547e-28 | 2.28215864e-18 | 1.07106284e-19 |

| Obwód | μx [A m²] | μy [A m²] | μz [A m²] | μ / I [m²], składowe XYZ |
| --- | --- | --- | --- | --- |
| microstrip | -3.89211806e-18 | 1.87342259e-13 | -2.02627707e-17 | (-2.72487524e-17, 1.31158478e-12, -1.41859834e-16) |
| gsg | 1.45457289e-21 | 6.54497098e-22 | 1.19983094e-21 | (8.29506538e-17, 3.73243326e-17, 6.84233577e-17) |

Dla obu pełnych źródeł dokładnie odtworzono algebraiczną zmianę T i μ po przesunięciu początku. Niewielka niezerowa zmiana μ wynika z zachowanego niezerowego numerycznego S; raport podaje ją jawnie. Składowych osobnych części obwodu nie wolno traktować jako niezależnych zamkniętych pętli: ich moment zależy od początku układu.

W GSG wkłady obu powrotów do składowej μz mają przeciwne znaki i niemal się znoszą. Mały całkowity moment dipolowy nie oznacza małego pola bliskiego pod środkowym paskiem ani braku wzbudzenia spinowego. Ten raport nie oblicza odpowiedzi próbki.

## Backend i zakres dowodu

| Realizacja | Zakres |
| --- | --- |
| FEM CPU | Analiza zachowanych źródeł Tet4 mikrostrip/GSG; postprocessing na CPU |
| FEM GPU | Brak nowego dowodu wykonania ani parytetu GPU |
| FDM CPU | Nie objęto analizą; ten raport czyta komórki Tet4 |
| FDM GPU | Nie objęto analizą; brak dowodu GPU |

Nie wykazano zbieżności siatki, pełnej niezależnej dokładności H, kwalifikacji bazy per A ani działania Relax/LLG/FFT. Nie zmieniono historii nieudanych publikacji. Niezależne wcześniejsze bilanse terminali i mocy oraz H w trzech punktach pozostają oddzielnymi dowodami.

## Mapa źródeł i artefaktów

Pliki poniżej znajdują się w `/opt/fullmag/control/verification/antenna-current-moments-20261101` istniejącego backendu.

- `analyze-current-moments.py::moments`: dokładne całki P1 na Tet4; `::magnetic`: kontrakcja antysymetryczna; SHA256 bd0ea27f67437bd8e812f5ca8fc3101840df8b96d02cc9e8378120758ddab552.
- `selection.json`: przedobliczeniowe piny danych i metoda; SHA256 91500d39564439830356d8757463b2a950d5b84f51c904ff5f5576775375f9f1.
- `current-moments.json`: pełne racjonalne S/T/μ, normy i wkłady części; SHA256 7e7a0800c4fd67fac177d67a457c52cabaf1d67f2058757b05e4585a9c61836e.
- Mikrostrip: CAS 39f795b2178f12c47f7622157f298d43e65aac39582467018abe058bf6b37c7e; dekoder `terminal-bundle-audit-check.py::decode` z przypiętym hashem w selection.json.
- GSG: `qualification-input-audit-20261030.json` oraz payloady cells/authoring_receipt z przypiętymi hashami.

Raport jest odczytowym audytem wyniku. Właścicielem fizyki produktu pozostaje nota 0950 i istniejący publiczny tor accepted current → Oersted → archive. Nie utworzono równoległego solvera ani API.
