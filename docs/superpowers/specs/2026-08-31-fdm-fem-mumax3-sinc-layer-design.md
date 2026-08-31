# Projekt porównania FDM/FEM/MuMax3 dla warstwy Py z impulsem sinc

Status: przygotowane do uruchomienia jako eksperyment walidacyjny. Dokument nie
wprowadza zmiany w fizyce produkcyjnej ani w publicznym API Fullmag.

## Cel i zakres

Eksperyment ma porównać trzy realizacje tego samego problemu dynamicznego:

- FDM Fullmag, referencyjny tor CPU `double`,
- FEM Fullmag, tor GPU `double` z zarządzanym runtime Windows/Docker,
- MuMax3, tor GPU `double` dostępny w WSL.

Porównanie obejmuje wyłącznie jednorodne wartości uśrednione po obszarze
magnetycznym: `avg mx`, `avg my`, `avg mz`, oraz skalarne energie. Nie wolno
zapisywać czasowych pól magnetyzacji ani innych ciężkich snapshotów pola.

## Ustalone parametry

Wszystkie długości są w metrach, indukcje w teslach, czas w sekundach.

| parametr | wartość |
|---|---:|
| rozmiar warstwy | `500e-9 x 500e-9 x 10e-9` |
| FDM | `200 x 200 x 1` komórek |
| komórka FDM | `2.5e-9 x 2.5e-9 x 10e-9` |
| FEM | P1, `prism6`, jedna warstwa przez grubość |
| FEM transition | `pyramid5` do `tet4` w części przejściowej airboxu |
| warunki brzegowe | otwarte, bez PBC (`x=y=z=false`) |
| materiał | Py: `Ms=800e3 A/m`, `A=13e-12 J/m`, `alpha=0.01` |
| stan początkowy | jednorodny `m=(1,0,0)` |
| pole statyczne | `B0=(100e-3,0,0) T` |
| impuls sinc | jednorodne `By=1e-3*sinc(2*pi*fcut*(t-t0)) T` |
| częstotliwość graniczna | `fcut=10e9 Hz` |
| środek impulsu | `t0=20/fcut=2 ns` |
| czas końcowy | `T=40/fcut=4 ns` |
| próbkowanie tabeli | `t_sampling=1/(2*1.3*fcut)=38.4615384615 ps` |

W treści żądania amplituda i kierunek części zmiennej nie były podane. Przyjęto
konwencję referencyjną: `1 mT` w kierunku `+y`, przy czym `100 mT` w kierunku
`+x` pozostaje polem biasu. To założenie musi być widoczne w każdym raporcie;
wynik nie może być opisany jako zgodny z inną amplitudą lub kierunkiem.

Zapis `5=20/f_cut` interpretuję jako `t0=20/fcut`; daje to impuls wyśrodkowany
w połowie okna `0..40/fcut`. Fullmag używa znormalizowanego sinc
`sin(pi*x)/(pi*x)` z `x=2*fcut*(t-t0)`, a MuMax3 funkcji `sinc` zwracającej
`sin(x)/x`; są to te same wartości dla argumentu `2*pi*fcut*(t-t0)`.

## Realizacje i granice porównania

FDM używa otwartej konwolucji demagnetyzacyjnej na siatce `200x200x1`; tor GPU
jest wykluczony, ponieważ globalny czasowy `RegionalFieldDrive` jest w tym
kontrakcie zaimplementowany dla referencyjnego FDM CPU. FEM używa wspólnego
airboxu `1 um x 1 um x 1 um`, demagnetyzacji `poisson_robin`, oraz jawnej
geometrii pryzmatycznej z `through_thickness_elements=1`, `exact_layer_count`
i `sweep_direction="z"`. Sam pryzmat magnetyczny bez airboxu nie jest
równoważnym otwartym problemem FEM.

MuMax3 używa `SetPBC(0,0,0)`, tej samej siatki, materiału, stanu początkowego,
pola biasu i wzoru sinc. Wszystkie trzy tory wykonują najpierw relaksację bez
impulsu, a następnie dynamiczny etap `0..T`; impuls jest aktywny tylko w etapie
dynamicznym.

## Kontrakt wyników

Tabela Fullmag zawiera `t`, `step`, `mx`, `my`, `mz` oraz:
`e_ex`, `e_demag`, `e_ext`, `e_drive`, `e_ani`, `e_dmi`, `e_total`.
W MuMax3 rejestrowane są odpowiadające kolumny `mx`, `my`, `mz`, `E_exch`,
`E_demag`, `E_zeeman`, `E_anis`, `E_total`; `E_zeeman` jest sumą wkładu biasu i
impulsu, więc w porównaniu jest mapowane na `e_ext + e_drive`. Wyłączone
wkłady (`e_ani`, `e_dmi`, a w MuMaxie termiczne przy `Temp=0`) pozostają
jawne jako zera albo `NOT AVAILABLE`, zamiast być cicho pomijane.

Do porównania używa się wspólnej osi czasu i interpolacji liniowej tylko wtedy,
gdy backend zwróci różne chwile próbkowania. Raport pokazuje wartości końcowe,
różnice para-para oraz maksymalną różnicę na wspólnej osi. Nie traktuje
zgodności energetycznej jako dowodu identyczności operatora demag: airbox FEM,
otwarta konwolucja FDM i implementacja MuMax3 mają własne błędy dyskretyzacji.

## Kryteria akceptacji

1. Test kontraktu potwierdza rozmiar, brak PBC, materiał, bias, sinc, `t0`, `T`,
   politykę automatycznego próbkowania oraz brak `SaveField`/snapshotów.
2. IR i manifest runtime identyfikują osobno FDM CPU, FEM GPU i MuMax3 GPU;
   żaden wynik z wymuszonym GPU nie może pochodzić z cichego fallbacku CPU.
3. Każdy backend kończy etap relaksacji i cały etap dynamiczny do `4 ns`, a
   tabela zawiera `mx`, `my`, `mz` oraz wszystkie aktywne energie.
4. Raport przechowuje metadane źródła, konfigurację, liczbę wierszy tabeli,
   listę kolumn, czas pierwszego/ostatniego wiersza i kontrolę braku artefaktów
   pól magnetyzacji.
5. Brakująca tabela, niezgodny czas, fallback, niezgodny mesh lub zapis pola
   oznacza `NOT VERIFIED`, a nie wynik pozytywny.

## Artefakty

Skrypty eksperymentu i test kontraktu pozostają w repozytorium. Ciężkie runtime,
cache i wyniki uruchomieniowe są zapisywane poza checkoutem, w dedykowanym
katalogu eksperymentu. W repozytorium nie powstaje żaden plik z czasowym polem
magnetyzacji.
