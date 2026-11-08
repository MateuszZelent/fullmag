# Odbiór dziewięciu niezależnych kontroli pola GSG

Odbiór: 08.11.2026. Dane dotyczą wcześniej wykonanej serii globalnych siatek
100/75/50 nm. Nie uruchomiono ponownie transportu, pola ani referencji.

**Wynik: 9/9 porównań pola przechodzi ustalone bramki. Źródło pozostaje
niezakwalifikowane, a odtworzenie publikacji nie jest potwierdzone.**

## Co rzeczywiście zostało obliczone

Istniejący driver użył pełnego zachowanego prądu RT0 w każdym źródle.
Niezależna referencja powierzchniowa obliczyła pole dla trzech pozycji:
x = −2, 0 i +2 µm, y = −50 nm, z = −22,4 nm. Dla każdej pozycji sumowano
wszystkie komórki danego źródła; nie wybrano tylko reprezentatywnych Tet4.

Zrealizowano osobne przebiegi binary64, 80 i 120 cyfr, kontrole lokalne
i globalne oraz porównanie wzoru całej ściany z jej podziałem na wachlarz.
120 cyfr oznacza precyzję arytmetyki referencji, nie fizyczną dokładność pola.

Porównywano normę różnicy wektorów H solvera i referencji w A/m.
Zamrożona bramka wynosiła 0,001 A/m + 0,001 razy norma H referencji.
Weryfikacja dotyczy tego samego zaakceptowanego prądu; nie jest niezależnym
rozwiązaniem transportu.

## Wyniki liczbowe

Maksima w każdym wierszu obejmują trzy sprawdzone punkty.

| Siatka | Tet4 źródła | Kontrole | Maks. różnica normy wektora [A/m] | Maks. różnica względna |
|---|---:|---:|---:|---:|
| 100 nm | 14 299 | 3/3 PASS | 4,0531741e−6 | 1,8904877e−7 |
| 75 nm | 25 516 | 3/3 PASS | 3,5836962e−7 | 1,6708809e−8 |
| 50 nm | 72 911 | 3/3 PASS | 2,4160370e−6 | 1,1263230e−7 |

Największa względna różnica to około 0,0000189%.
Nie wymagano monotonicznego zmniejszania tej różnicy między różnymi źródłami:
każde porównanie ma własny zachowany prąd i istniejącą bramkę.
To odrębne zagadnienie od zbieżności transportu względem siatki.

Referencja trwała 12 886,734 s (około 3 h 34 min 47 s), przy zapisanym
szczycie 417 714 176 B RAM i 4 058 136 ocenach ściana–punkt z precyzjami.
Profil dopuszczał 43 200 s, 2 GiB RAM i 5 mln tych ocen.
Liczniki nie oznaczają wyczerpującego zliczenia wszystkich elementarnych
operacji wewnątrz biblioteki; ich zakres zachowano w oryginalnym raporcie.

## Pochodzenie i rzeczywiste zakończenie

Zarządzana próba gsg-reference c9a5ddf707e341da9cc9d2a2b48bea3e ma
state=succeeded, exit_code=0. Jej receipt wskazuje dokładnie:
result SHA256 e58e5f19010870ee0d1c711df01d3202a329516384be8e74daa70ebe3105dec5
oraz worker-exit SHA256 bbe2f0298fc3112757a486e0239fcc66eb820734e743bd181fcc164419facb51.
Worker PID23265 został zebrany; source_inputs_stable=true i retry=0.
Nie uznano starego progress.json z 8/9 za bieżący stan procesu.

Właściwe żądanie ma SHA256
b7b187aac685b1113abc935b97cc3d78c848e6f5dab595c07e8639bad4d8806f
i leży w snapshots/<SHA>/request.json. Starszy root/request.json ma inny
hash d046d0f02ed832237b27cf7b4426dacd126ec093b49056b034e4d350825dd559.
Sprawdzono źródło WORKER w scripts/docker_gsg_reference.py:
uruchamia driver właśnie z przypiętego snapshotu. Nie ma tu dowodu
zmiany żądania trwającego procesu; pomylone były dwa dokumenty.

Rzeczywisty driver snapshotu ma hash
7aa1a1c39add89459a580aa2ee4a000d7314f6995a0dc42819d5c43d8f31c186.
Wszystkie cztery moduły i mpmath są zgodne z pinami żądania.
Historyczny native API miał hash
6b8ac24e44cc5efb24a2b26cf3e35b1cad1edb4abcb7373061777b96ce351040;
obecny build nie jest przedstawiany jako nowe wykonanie tych obliczeń.

## Odczytowy audyt 08.11.2026

Wykonano bez ponownego całkowania:

1. Sprawdzenie zgodności request/result/worker-exit/launch i kompletności 9/9.
2. Weryfikację pełnych paczek trzech źródeł, ich IR, węzłów, stable IDs,
   topologii, przewodności oraz lokalnego J i V/H względem zapisanych tensorów.
   Użyto rzeczywistego load_case z zamrożonego drivera i 20 GET przez nowe API.
3. Porównanie każdego pliku punktu z końcową tablicą wyników.
4. Niezależne przeliczenie dziewięciu norm różnic, względnych różnic i
   bramek z zapisanych wektorów, przy Decimal90.
5. Kontrolę liczby komórek, pracy profilu, limitów i niezmienności aktualnej
   sesji oraz runu. Nie wywołano nowej referencji lub Solve.

Audyt ma status PASS, SHA256
cbd0f33c2e18380d35a7fdbcb105f383db7a8d8a1aaf749d8731256258214c68,
w verification/gsg-source-convergence-reference-20261105/receipt-audit-20261108/result.json
prywatnego control volume grupy 3203.

## Trwała kopia na WSL

W obecnym worktree:
examples/sushruth_2020_closed_gsg/reference_9points_20261108.

Zachowano 32 pliki (419 235 853 B): końcowy wynik i dziewięć punktów,
dowód zakończenia, właściwy snapshot żądania i kodu, preflight, autoryzację,
oczekiwania HTTP, audyt, mpmath oraz pełne trzy binarne paczki V/J/H i trzy IR.
Każdy hash ponownie odczytano z WSL jako właściciel worktree.
Manifest-integrity ma SHA256
b16e054c34ebf287e5762f6f63957b80d38aa6c597729ae2e275ddf88a43ad79.

Początkowo kontener nadał nowemu katalogowi UID65532 i tryb0700.
Automatyczna kontrola odrzuciła propozycję0755 jako rozszerzenie dostępu
na wszystkich lokalnych użytkowników. Zastosowano węższą alternatywę:
wyłącznie nowa kopia i jej jawnie zinwentaryzowane wpisy otrzymały
UID/GID1000 właściciela worktree; wszystkie tryby, w tym prywatny0700,
pozostały bez zmian. Odczyt i hashe przeszły już jako użytkownik1000.
Nie zmieniano uprawnień oryginałów, grupy Docker ani innych katalogów.

Ta kopia zabezpiecza dane i pochodzenie. Driver zachowuje historyczne
bezwzględne ścieżki i odczyty API; nie jest to gotowy przenośny replay ani Zarr.
Bramka publicznego samowystarczalnego archiwum pozostaje otwarta.

## Wniosek i zakres naukowy

Potwierdzono małą różnicę niezależnego całkowania pola na trzech pozycjach
dla każdego z trzech zapisanych źródeł. Ogranicza to hipotezę, że właśnie
całkowanie H w tych punktach powoduje obserwowane rozbieżności.
Nie obejmuje całego Universe, wnętrza przewodnika, wszystkich 20 punktów
ani innej geometrii.

Nie zmienia się poprzedni FAIL zbieżności korekty prądu.
Nie kwalifikuje to bazy H/I, projekcji na LLG, przebiegu czasowego,
wzbudzenia fal spinowych lub odpowiedzi z Fig.3 publikacji.
Osobny wariant local50 i oczekujące corner25 nie należą do tej serii
globalnych 100/75/50 nm.

| Realizacja | Zakres dowodu |
|---|---|
| FEM CPU / double | Zachowane natywne H porównane z referencją; źródło nadal inspection-only |
| FEM GPU | Nie oceniano |
| FDM CPU | Nie oceniano |
| FDM GPU | Nie oceniano |

## Właściciel metody i mapa źródeł

Równania i ograniczenia zachowuje
[kanoniczna nota anteny](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md).
Profil pozostaje zgodny z
[zatwierdzonym eksperymentem](2026-11-03-gsg-source-convergence-experiment-proposal.md).

- scripts/docker_gsg_reference.py::WORKER oraz attached — przypięcie i odbiór procesu.
- scripts/run_gsg_source_convergence_reference.py::load_case i verify_carriers —
  uwierzytelnienie zachowanego nośnika i danych; dokładna wersja w snapshotcie.
- scripts/antenna_gsg_convergence_reference.py::evaluate_retained_field —
  wszystkie komórki, precyzje i bramki sumowania.
- scripts/antenna_rt0_surface_oracle.py::evaluate_retained_rt0 —
  niezależna realizacja powierzchniowa pojedynczego RT0.
- scripts/antenna_triangle_surface_oracle.py::Budget — ograniczony profil pracy.

Raport odbiera istniejący eksperyment; nie zmienia metody, API, ProblemIR,
polityki limitów ani statusu kwalifikacji.
