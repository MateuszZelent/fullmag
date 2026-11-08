# Ilościowy odczyt oryginalnego Fig. 3 — 08.11.2026

## Cel i granice

Sprawdzono, czy wcześniejsza różnica pomiędzy wzorcem równań a Fig. 3
może wynikać z rozdzielczości ilustracji. Jest to odczyt dwóch rastrów,
nie nowa symulacja Fullmaga, niezależny pomiar fizyczny ani kwalifikacja LLG.
Właścicielem interpretacji pozostaje
docs/physics/0951-sushruth-2020-forward-volume-reference.md.
Nie zmieniono tej noty, równań, parametrów, tolerancji ani kodu produkcyjnego.

Źródła pierwotne: [Sushruth i in., PR Research 2, 043203 (2020)](https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.2.043203)
oraz [źródła arXiv 2001.11483v1](https://arxiv.org/src/2001.11483v1).
Wersja arXiv może różnić się od ostatecznej publikacji; zgodność ich ilustracji
nie stanowi dwóch niezależnych potwierdzeń teorii.

## Metoda i wykonanie

Przed pomiarem zapisano measurement-plan.json; przed odczytem ekstremów
zapisano window-registration.json z oknami, maskami adnotacji i progami.
Wypakowano wyłącznie regularny Fig03.png ze sprawdzonego archiwum,
bez uruchamiania TeX. Oryginał ma 4952 × 7367 px; wydawniczy raster
1015 × 1524 px. Ich SHA256 są zapisane w manifeście.

Dekodowanie obrazu wykonano przez System.Drawing; analiza tablic RGB
przez NumPy w istniejącym środowisku Windows, bez instalowania zależności.
To analiza ilustracji, bez kompilacji lub uruchomienia natywnego Fullmaga.
Cztery próbki RGB sprawdzono osobno przez GetPixel, potwierdzając orientację
wierszy i kolejność kanałów po LockBits. Surowe BGR pozostają w katalogu
analizy na D:, a końcowe dowody naukowe skopiowano na ext4 WSL.

Dla panelu (a) odczytano niebieską krzywą Single wire, alfa=0,01;
dla (e) czarną CPW/GSG, alfa=0,01. Czerwona U-shaped nie jest porównywanym
modelem GSG. Każdy panel skalibrowano osobno na granice 6–9 GHz,
zgodnie ze wspólną drukowaną osią częstotliwości. Znaleziono pionowe
kreski osi przez co najmniej 95% wysokości okna i szary znacznik przez
co najmniej 90%; wymagano ciągłych pasm pikseli.

Ekstrema wyznaczono z najwyższego i najniższego piksela właściwego koloru,
z przedziałem całej grubości kreski. Obwiednia odczytu dodatkowo rozszerza
o jeden piksel skrajne punkty i pasma osi. To ograniczenie błędu digitalizacji,
nie całkowity błąd fizyczny. Zmieniono progi koloru 60/80/100.
Kontrola ścisłego nominalnego progu niebieskiego B>180 poprawiła zapis
pomocniczego wyrażenia B>175; wszystkie osiem nominalnych ekstremów
obu rastrów pozostało identycznych. Oba wyniki i skrypty zachowano.

## Wyniki

Wartości w GHz; podane środki kreski nie są dokładnymi danymi autorów.

| Panel i punkt | Oryginalny arXiv | Raster wydawniczy | Różnica środków |
|---|---:|---:|---:|
| (a) S, maksimum | 7,341394 | 7,340498 | +0,896 MHz |
| (a) S, minimum | 7,209104 | 7,208145 | +0,959 MHz |
| (e) GSG, maksimum | 7,599546 | 7,597590 | +1,955 MHz |
| (e) GSG, minimum | 7,719152 | 7,716867 | +2,285 MHz |

Piksel odpowiada 1,422 MHz w oryginalnym (a) i 1,514 MHz w (e),
wobec odpowiednio 6,787 MHz i 7,229 MHz w rastrze wydawniczym.
Wszystkie przedziały odpowiadających punktów obu wersji nakładają się.
Zmiana progów przesuwa środki oryginalnych ekstremów o mniej niż 0,8 MHz;
nie usuwa to szerokości kreski ani niepewności kalibracji.

Dla porównania zachowany wzorzec równań na siatce częstotliwości 5 MHz
ma dla S maksimum/minimum 7,800/7,605 GHz, a dla GSG 8,175/8,355 GHz.
Różnice względem większego oryginału to około 459/396 MHz i 575/636 MHz.
Nie mogą być wyjaśnione samą rozdzielczością sprawdzonych ilustracji.
Nie wykonano dopasowania amplitudy, zmiany fazy ani przesunięcia częstotliwości.

Szare znaczniki odczytane osobno dla paneli mają środki około 7,205 GHz
w (a) i 7,148 GHz w (e). Ich obwiednie to odpowiednio około
7,181–7,229 i 7,125–7,172 GHz. Nie wolno więc traktować jednego odczytu
tego elementu graficznego jako dokładnego globalnego FMR.
Wzorzec z parametrów Table I daje 7,5 GHz. Przyczyna różnic między
rysunkiem, parametrami i wzorcem pozostaje nierozstrzygnięta.

## Odbiór i następny krok

Zaliczone: cztery próbki niezależnego dekodera, tożsamości plików,
12 kombinacji panel/próg dla obu rastrów łącznie, osiem nominalnych
ekstremów po kontroli progu oraz sześć nakładających się przedziałów
porównania obu ilustracji. Nie ogłasza się błędu autorów ani zgodności
solverów z publikacją. FDM CPU, FDM GPU, FEM CPU i FEM GPU nie uzyskują
żadnej nowej kwalifikacji z tego odczytu.

Bieżąca próba corner25 nadal jest Failed: natywny etap pola osiągnął 20/20
punktów, ale weryfikacja interpolacji J odmówiła akceptacji całego wyniku.
Nie uruchomiono nowego Prepare, Submit, Solve, buildu, H-only ani LLG.
Wdrożenie diagnostyki pierwszego błędu i kolejna pojedyncza próba pozostają
objęte osobnym oczekującym pytaniem:
2026-11-08-rt0-center-first-failure-diagnostic-proposal.md.
Nie zmieniono chronionej bramki na podstawie tego audytu.

Dowody: examples/sushruth_2020_closed_gsg/figure3_highres_readback_20261108/.
Pliki measurement.json, strict-threshold-verification.json i audit-checks.json
zawierają liczby i kontrole. Manifest SHA256: 9a8f0a8fd72f0d9e14ea2256313065142246729c712a3f6c7e494292dad4edfc.
Pliki BGR nie są danymi autorów i nie są jedyną kopią wyniku: to odtwarzalny
produkt dekodowania przypiętych PNG.
