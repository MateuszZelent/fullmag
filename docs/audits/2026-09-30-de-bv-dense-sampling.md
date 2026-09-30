# DE/BV: zagęszczenie dyspersji, 2026-09-30

## Wynik

19 zaakceptowanych niezależnych punktów FEM z demagiem: 9 DE i 10 BV.
Poprzedni wykres miał 12 punktów. Dodano k = 7, 17, 22 rad/µm dla DE
oraz 7, 12, 17, 22 rad/µm dla BV. Siatka L0: zadany rozmiar 10 nm;
film 40×40×10 nm, PBC x/y, airbox po 2 µm, phi=0 na granicach z.
Materiał i geometria nie zmieniły się; analityka n=0 jest obliczana po solve.

| Konfiguracja | k [rad/µm] | FEM [GHz] | Analityka n=0 [GHz] | Różnica [%] |
|---|---:|---:|---:|---:|
| BV | 2 | 9.273542043 | 9.274233801 | -0.007459 |
| BV | 5 | 9.241839047 | 9.245917375 | -0.044110 |
| BV | 7 | 9.235504955 | 9.243430294 | -0.085740 |
| BV | 10 | 9.247660041 | 9.263654509 | -0.172658 |
| BV | 12 | 9.269813253 | 9.292689968 | -0.246180 |
| BV | 15 | 9.323376864 | 9.358788161 | -0.378375 |
| BV | 17 | 9.372175745 | 9.417395460 | -0.480172 |
| BV | 20 | 9.464171875 | 9.526247115 | -0.651623 |
| BV | 22 | 9.537534757 | 9.612255544 | -0.777349 |
| BV | 25 | 9.664769493 | 9.760535488 | -0.981155 |
| DE | 2 | 9.723336314 | 9.725724281 | -0.024553 |
| DE | 5 | 10.304790676 | 10.317375928 | -0.121981 |
| DE | 7 | 10.669228396 | 10.693658152 | -0.228451 |
| DE | 10 | 11.186165186 | 11.235414177 | -0.438337 |
| DE | 15 | 11.981028774 | 12.089703092 | -0.898900 |
| DE | 17 | 12.279266979 | 12.417750845 | -1.115209 |
| DE | 20 | 12.708760200 | 12.898112902 | -1.468065 |
| DE | 22 | 12.984489227 | 13.211704646 | -1.719804 |
| DE | 25 | 13.384204251 | 13.673868175 | -2.118376 |

## Dowody i ograniczenia

Runtime #167, job a745f5e241dc497fad98c10c2c11cb13.
Nowe wejścia: commit 251c4a63a2f80e84860a7709e4bba271533bb25b.
Kontrole Python/IR i walidatora: 111 PASS + 7 podtestów PASS;
nie kompilowano nowych testów natywnych.
Maksymalny residual pełnych równań zaakceptowanych punktów: 3.40365689287e-10,
poniżej niezmienionej bramki fizycznej 1e-8.

Punkt DE k=12 rad/µm pozostaje odrzucony. Próby:
8c575f1a88934a55803ce146d66ca881 (EPS 1e-10, restart 8),
818168433b044c77a358778dbcfa4d85 (EPS 1e-9, restart 8),
7e40359ce70e40fb9c2085d54b4b0717 (EPS 1e-10, restart 30, KSP 1e-12).
Wszystkie exit 1; nie przeniesiono kandydatów na wykres.

Walidator okien dla k17/k22 był niezgodny z wejściem 8.5–16 GHz.
Poprawiono listę punktów; powtórzone runy przeszły walidację.

BV ma minimum wśród obliczonych punktów przy k=7 rad/µm,
f=9.235504955 GHz. Jest to minimum próbkowanej krzywej, nie dokładnie
wyznaczone położenie minimum ciągłego.
Odchylenie od przybliżenia n=0 przy k25: DE -2.1184%, BV -0.9812%.
Zbieżność siatki i airboxu, ciągłość/tożsamość gałęzi i bezpośrednia
zgodność z COMSOL pozostają NOT VERIFIED. Nie dodano numerycznego k0.

Wyniki PNG/PDF/CSV/JSON: C:\git\fullmag\storage\runs\eigensolve-dispersion-plan-20260-c5dfad6d7f548079\a745f5e241dc497fad98c10c2c11cb13\comsol-dispersion\independent-ten-comparison
Manifest dodatkowych przebiegów: positive-ten-additional-20260930.json.
comparison.json zawiera hash wejściowych artefaktów, parametry i ścieżkę każdego runu.

## Następny krok

Wyjaśnić brak certyfikatu dla DE k12; następnie powtórzyć zagęszczoną
krzywą na L2/L3 i kontrolować airbox. Samo dodanie punktów nie zamyka
bramki naukowej. Przy L2/L3 pozostaje także otwarta kontrola znaku k
opisana w 2026-09-30-de-bv-mesh-convergence.md.

## Aktualizacja: siatka 52 punktów — przygotowanie wejść

Cel użytkownika: zwiększyć liczbę policzonych punktów, aby ocenić kształt dyspersji.

## Przygotowane wejścia

- Dwie ścieżki: `positive-26` (DE) i `bv-positive-26` (BV).
- Każda: 26 punktów od 0 do 25 rad/µm, krok 1 rad/µm; łącznie 52.
- Jedna relaksacja źródłowa na ścieżkę; jeden żądany mod na próbkę.
- Osobne selektory `k0`…`k25` oraz `bv-k0`…`bv-k25` do diagnostyki.
- Gamma pojedynczy używa PeriodicBC oraz periodic_airbox_k0.
- Demag, exchange, Zeeman i parametry materiałowe zachowane.
- Okno poszukiwania: DE 8.5–16 GHz, BV 8.5–12 GHz.

## Dowody i stan wykonania

54 interpretowane kontrole wejść Python→IR obejmują obie ścieżki i wszystkie
samodzielne punkty. Nie kompilują ani nie wykonują solvera FEM.
Kontrole pełnych syntetycznych artefaktów i wcześniejsze regresje w roboczym
checkoutcie: 139 testów oraz 7 subtestów przeszło. Szerszy walidator i jego
poprawka Gamma dla BV pozostają częścią niezakończonego przyrostu roboczego.

Nie powstały nowe częstotliwości ani zagęszczony wykres. Zachowane wyniki:
19 zaakceptowanych punktów niezależnych, 9 DE i 10 BV; nie jest to kompletna
ścieżka ani dowód identyfikacji najniższej gałęzi. Docelowo brakuje 33 punktów.

## Aktualna blokada

Odczyt runnera 2026-09-30: worker_alive=true, accepting_jobs=true,
brak aktywnych jobów; wolne 4 705 071 104 B, poniżej progu 8 GiB.
Profile runtime-only nie są dopuszczone. Zakaz kompilacji testów jednostkowych
pozostaje aktywny. Nie zmieniono runnera i nie usunięto danych; wcześniej
zadane pytania o te działania nadal oczekują odpowiedzi.

## Następne wykonanie

1. Rozwiązać zatwierdzoną trasą miejsce oraz profil runtime-only.
2. Zbudować aktualny snapshot i sprawdzić native source binding.
3. Uruchomić obie ścieżki; brak pojedynczego punktu diagnozować osobno,
   bez przedstawiania niezależnych relaksacji jako jednej ścieżki.
4. Sprawdzić pełne residuale, Gamma/nonzero demag probes, fazę i siatkę.
5. Nanieść zaakceptowane częstotliwości na scatterplot z analityką; jawnie
   oznaczyć brakujące/odrzucone punkty. Nie interpolować ich jako wyników FEM.

Stan naukowy: NOT VERIFIED dla nowego runtime i zagęszczonego solve.


## Aktualizacja: uszczelnienie kontroli wyników gęstej ścieżki

Odtworzono 19 przypadków błędnego przyjęcia artefaktu lub niekontrolowanego
wyjątku. Poprawiono scope certyfikatu Gamma/nonzero-k, limit residualu gęstej
ścieżki niezależny od luźniejszych opcji diagnostycznych, sample_count,
unikalność próbek, pełny inventory widma i liczbę modów względem count=1.
Certyfikaty innych granic airboxu lub polityki gauge są odrzucane.
Niepoprawny model descriptor daje kontrolowany ValueError. Gamma BV jest
legalny przy tej samej osi M0 i normalnej filmu.

Walidator używa pełnych residuali i seam certificate dla Floqueta; stare
reduced-only wyniki poza gęstą ścieżką mogą przejść jedynie preflight z jawną
listą brakujących wymagań. Żaden preflight nie daje kwalifikacji naukowej.
Pilot przekazuje solver.v1.json i metadata.json do walidatora oraz zachowuje
image_digest zatwierdzonego build context. Testy interpretowane: 158 PASS
oraz 7 subtestów PASS. Nie wykonano kompilacji ani nowych punktów FEM.

Dokładny staged snapshot: 144 testy i 7 subtestów PASS; walidacja naukowej mapy źródeł exit 0.
