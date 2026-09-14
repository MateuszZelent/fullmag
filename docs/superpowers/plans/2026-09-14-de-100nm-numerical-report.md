# DE 100 nm — raport wykonania i bramka zgodności

Stan na 2026-09-14: **NOT VERIFIED — brak numerycznego spektrum FEM**.
Jest to raport roboczy wykonania, nie certyfikat ani nowa definicja fizyki.
Kanoniczny kontrakt: [Floquet i demag](../../physics/0828-fem-frequency-domain-floquet-demag.md).

## Przypadek i sprawdzony kontrakt wejścia

Źródło: `examples/fem_de_film_100nm_numeric_pilot.py`.
Odczyt przez `fm.load_problem_from_script(..., lightweight_assets=True)` oraz
`to_ir(requested_backend="fem", execution_mode="strict", execution_precision="double", include_geometry_assets=False)` zakończył się kodem 0.

| Wielkość | Wartość |
|---|---|
| Film / komórka periodyczna | 50 × 50 × 100 nm |
| Domena film + powietrze | 50 × 50 × 4100 nm |
| Ms | 800000 A/m |
| A | 13e-12 J/m |
| B zewnętrzne | (0.1, 0, 0) T |
| Magnetyzacja początkowa | (1, 0, 0) |
| Gamma w konwencji DSL | 221100 m/(A s) |
| K | (0, ky, 0), ky = −40, −30, −20, −10, 0, 10, 20, 30, 40 rad/µm |
| Operator | full_2x2, include_demag=true |
| Dynamiczne BC | floquet_airbox, exp_minus_i_k_dot_delta_r |
| Statyczne PBC | periodic, periodic, open; periodic_airbox_k0 |
| Mesh — żądanie | liniowe tetrahedry, 5 nm, 20 warstw filmu |
| Widmo | 24 mody, 1 MHz–30 GHz, damping_policy=ignore |
| Realizacja | FEM CPU, strict, double |

Eksport nie zawiera selektora `dispersion_validation` wybierającego analityczny
solver referencyjny. Powyższa kontrola potwierdza tylko authoring; nie dowodzi
wykonania siatki, planera, relaksacji ani eigensolve.

## Stan rzeczywistego wykonania

Build 43: `9ce502f938a64abd85d74d4e391b5d3a`, profil
`fem-cpu-slepc-modal-v1`, commit
`95763e6a7f3d6a7c19657bd214d5d805082b926b`.
Kapsuła: `77575527e2204d3bbf1d70ceab68e931`; source digest:
`9059c840b6ad17fa9906aa10d0c9b37a1d7d53b714fdf1d9d5d3e947d422f9f5`.

API raportuje running i nie ma kodu zakończenia. Docker nie pokazuje workera
tego joba. Żywy proces koordynatora ma wiele wątków w `p9_client_rpc`;
nie jest to dowód zawieszenia ani zidentyfikowana przyczyna źródłowa.
Kapsuła obejmuje 7181 plików, 289802701 bajtów. Nie anulowano joba ani nie
uruchomiono duplikatu na podstawie czasu oczekiwania.

Branch zmienił się podczas równoległego review. Obserwowany późniejszy HEAD:
`da9a0ecf54767823dcc8eb1f4a62807ced0e61cb`.
Nie wolno przypisać buildowi 43 późniejszych poprawek ani nowego pilota.
Obecny `run_comsol_dispersion_benchmark.py` dopuszcza C0/C1/A1 i wskazuje
na ich skrypt w kapsule; nie stanowi jeszcze wykonawczej recepty DE 100 nm.

## Pozostałe kroki i kryteria decyzji

1. Doprowadzić aktualny job do stanu terminalnego; sprawdzić receipt i hashe.
   Rozpoznać etap przygotowania danych, jeżeli worker nadal nie powstaje.
2. Zapewnić kontrolowaną receptę DE z niezmiennym wejściem oraz odpowiadającym
   mu solverem po poprawkach review. Nie podmieniać plików w kapsule buildu.
3. Wykonać siatkę, relaksację i wszystkie 9 punktów FEM. Zachować logi,
   requested/resolved execution, diagnostykę, częstotliwości i profile modów.
4. Sprawdzić residuale, warunek styczności, pokrycie okna widma i poprawność
   śledzenia gałęzi. Dopasowywanie tylko po kolejności częstotliwości nie wystarcza.
5. Porównać numeryczne częstotliwości z aproksymacją Kalinikosa n=0 i sporządzić
   tabelę błędów oraz wspólny wykres. Wzór referencyjny nie może być źródłem
   częstotliwości przedstawianych jako obliczenia FEM.
6. Wykonać zbieżność siatki i rozmiaru powietrza, zwłaszcza przy Gamma.
   Zestawić wyniki dla jednakowych warunków brzegowych. Zagęścić k przy Gamma.
7. Rozdzielić błąd numeryczny od ograniczeń jednomodowej aproksymacji filmu
   100 nm. Rozbieżności profili lub hybrydyzacji wymagają analizy; nie wolno
   korygować solvera przez dopasowanie do założonego kształtu wykresu.
8. Dopiero po wykonaniu powyższych kontroli ustalić wynik bramki dla tego
   przypadku. Nie rozszerzać jej automatycznie na FEM GPU, FDM, inne geometrie
   ani wszystkie mody solvera.

## Wyniki

Brak wartości FEM, tabeli błędów i wykresu porównawczego. Ich miejsce nie jest
wypełnione analityką ani zerowym błędem. Cel symulacji i certyfikacji pozostaje otwarty.

## Wykonawcza recepta DE

Dodano `just run-de-100nm-pilot <job_id>` i `scripts/run_de_100nm_pilot.py`.
Recepta korzysta z istniejących kontroli receipt, obrazu i kapsuły. Wymaga,
aby pilot był w manifestowanej kapsule tego samego buildu; sprawdza jego hash.
Uruchamia wyłącznie przygotowany model DE, zapisuje logi i request/result.
Sprawdza obecność widma, dyspersji, złożonych modów i potencjału; nawet sukces
pozostaje `completed_unqualified` do wykonania osobnej oceny naukowej.

Próba dry-run z jobem 43 została odrzucona przez preflight: job jest running.
Nie wykonano z tego powodu Docker Compose ani symulacji.

## Aktualizacja kolejki — właściwa wersja DE

Receptę i raport zapisano w commicie
`28f552b959455957bbf6dada8a522a241425552c`.
Weryfikacja fragmentu: 5 testów wrappera DE i 8 testów wrappera COMSOL
zakończonych sukcesem; `just --show run-de-100nm-pilot` poprawnie parsuje receptę.
Nie są to testy wykonania natywnego ani dowód zgodności fizycznej.

Przyjęto build **44**, `635451d7648a446a83e8d88e21c0279b`, dla tego commita,
profil `fem-cpu-slepc-modal-v1`, stan początkowy `queued`.
Kapsuła: `2b0e4a386c984f81952c1f86e48df5af`.
Source digest: `e525db73d0689d20f18ca97017ce9f3ecebc981d2bcd09b29a475f72d17b7c86`.
Native snapshot: `c98c74f0d1a828561ae5cd8afcc1be5da1d6eda422427212b1b291722c384a53`.

Starszy build 43 zastąpiono buildem właściwej wersji. Oficjalne API przyjęło
anulowanie i zwróciło `cancel_requested`; nie potwierdzono jeszcze terminalnego
`cancelled`. Przyczyną jest zastąpienie starego źródła nowym, a nie timeout
obserwatora. Nie kasowano lease ani nie uruchamiano innego koordynatora.
Po sukcesie buildu 44 polecenie wykonania: `just run-de-100nm-pilot 635451d7648a446a83e8d88e21c0279b`.

## Doprecyzowanie diagnostyki I/O

Liczniki procesu nie dowodzą postępu buildu: większość odczytów pochodziła
z wątku 9. Obserwowany wątek 7118 miał `rchar=2872333`, `syscr=695`;
po 45 sekundach oba liczniki były niezmienione, `wchan=p9_client_rpc`,
a stan jądra wynosił `D`. Jest to dowód oczekiwania na I/O, nie dowód
postępu kompilacji ani pełna identyfikacja przyczyny źródłowej.
Odczyt stosu jądra `/proc/1/task/7118/stack` został odrzucony przez uprawnienia;
nie zmieniano capabilities ani uprawnień kontenera.
Nie należy na podstawie samego health.worker_alive uznawać builda za zdrowy.
Build 43 nadal `cancel_requested`, a 44 pozostaje bez wyniku.

## Przejście na build 44

Koordynator potwierdził 2026-09-14 o 08:37:03 UTC stan terminalny buildu 43:
`cancelled`, exit 143. O 08:37:09 UTC podjął build 44; API zwróciło `running`.
W chwili kontroli nie było jeszcze kontenera workera 44. Przejście kolejki
jest potwierdzone, ale rozpoczęcie kompilacji i sukces buildu pozostają
niepotwierdzone. Nie przypisujemy skutku ograniczonej próbie diagnostycznej.
Pojedyncze stat manifestu trwało około 0.005 s; osobna, ograniczona do 25 s
kontrola kapsuły przechodziła przez kolejne pliki i została zakończona limitem.
Nie uzyskano z niej pełnego wyniku weryfikacji kapsuły.

## Przygotowane porównanie artefaktów

`scripts/compare_de_100nm_pilot.py <katalog-runu>` czyta numeryczne
`de100/eigen/dispersion.csv`, sprawdza dziewięć punktów DE i skończone
częstotliwości/residuale. Nakłada wszystkie mody na analitykę n=0; opcjonalne
`--branch-id N` tworzy tabelę różnic dla jawnie wskazanej pełnej gałęzi.
Nie dobiera gałęzi do oczekiwanej częstotliwości. Zapisuje PNG/PDF oraz JSON
z hashami i ograniczeniami; status pozostaje NOT VERIFIED.

Weryfikacja źródeł: 4 testy odczytu CSV, niepełnej gałęzi, braku automatycznej
podmiany gałęzi oraz granicy Gamma/reciprocity. To dane testowe, nie wyniki FEM.
Narzędzie nie zostało jeszcze wykonane na rzeczywistym spektrum, ponieważ build
44 nie dostarczył runtime. Żaden syntetyczny wykres nie jest przedstawiany jako
wynik symulacji.

## Kontrola Gamma dla warunków brzegowych pilota

Dla jednorodnego modu Gamma i phi=0 na obu granicach z, współczynnik wynosi
Nz = 1 − t/(t + 2a), gdzie t=100 nm i a=2 µm: Nz=0.9756097561.
Kontrola Kittela dla tej skończonej domeny daje 9.205971992 GHz,
a dla nieskończonego filmu 9.309813711 GHz. Różnica −1.1154% jest różnicą
modeli brzegowych. Nie można uznać jej samej za błąd numeryczny ani dostrajać
solvera do wartości otwartej domeny. Zbieżność powietrza pozostaje wymagana.
Narzędzie porównania zapisuje oba odniesienia Gamma oddzielnie. Po zmianie
przeszło 5 testów, w tym kontrola granicy dużego airboxu. To nadal wartości
analityczne i testy źródeł, nie wyniki FEM.

## Zakres ważności analityki

Harms i Duine, *Theory of the dipole-exchange spin wave spectrum in ferromagnetic
films with in-plane magnetization revisited* (JMMM, 2022), wskazują ograniczenia
przybliżenia diagonalnego Kalinikosa–Slavina dla grubszych filmów i znaczenie
sprzężenia modów. Źródło pierwotne: https://arxiv.org/abs/2109.10597.
Dla parametrów pilota długość wymiany sqrt(2A/(mu0 Ms²)) wynosi 5.6858 nm,
a t/lex = 17.5877. Wniosek dla tej walidacji: zgodność z jednomodową krzywą
nie może być jedyną bramką certyfikacji. Po uzyskaniu FEM trzeba sprawdzić
profile modów, zbieżność i — jeżeli wystąpi rozbieżność poza błędem numerycznym —
porównać z odniesieniem uwzględniającym sprzężenie modów lub pełne warunki
brzegowe. Nie określono z samej publikacji wartości błędu dla naszego pilota.


## Checkpoint aktywnego workera 44

Potwierdzono zywy proces build_entrypoint w kontenerze workera 44.
Po 44 minutach 40 sekundach od startu workera licznik wchar wynosil
289884742 bajty, a rchar wzrosl z 689000837 do 767039394 bajtow.
Kod materialize_capsule po kopiowaniu ponownie sprawdza rozmiary, hashe
i uprawnienia plikow. Obserwacja jest zgodna z postepem przygotowania
zrodel; brak jeszcze procesu kompilacji i native-build.stdout.log.
Probe run_de_100nm_pilot --dry-run zatrzymal preflight z powodu stanu
running buildu. Nie uruchomiono symulacji i nie uzyskano wynikow FEM.

Aktualizacja: po okolo 46 minutach przygotowania worker rozpoczal
native-build (make install-cli-dev). Potwierdzono proces rustc oraz
log stderr z kompilacja fullmag-quantities, fullmag-fdm-demag i fullmag-ir.
To dowod rozpoczecia kompilacji, nie jej sukcesu ani uruchomienia FEM.


## Referencja z pelnymi warunkami brzegowymi

Kandydatem do niezaleznego odniesienia jest pelny problem brzegowy
Harmsa-Duine (https://arxiv.org/html/2109.10597v2, rownania 7-15):
szesc rozwiazan bulkowych i szesc warunkow brzegowych tworzy macierz
6x6. Warunki obejmuja swobodna wymiane na obu powierzchniach oraz
ciaglosc pola magnetostatycznego. Nalezy rozwiazywac pelny problem,
a nie bez kontroli bledu przyjmowac pozniejsza aproksymacje artykulu.

Dostosowanie do pilota jest osobnym wyprowadzeniem: dla q=abs(k)
i warstwy powietrza a, eliminacja potencjalu Laplacea zakonczonego
Dirichletem daje eta=q*coth(q*a), z granica eta(0)=1/a.
Dla konwencji Fullmag h=-grad(phi) warunki na filmie wynosza
d_z phi + eta*phi - delta_Mz = 0 u gory oraz
d_z phi - eta*phi - delta_Mz = 0 u dolu.
Publikacja stosuje potencjal z przeciwnym znakiem h=+grad(w);
nie wolno bezposrednio kopiowac znakow jej BC do Fullmaga.

Ta referencja nie zostala jeszcze zaimplementowana ani obliczona.
Wymaga kontroli Gamma, granicy otwartego airboxu, kompletnosci korzeni
i profili modow. Porownanie FEM musi obejmowac zbieznosc siatki i airboxu
oraz sledzenie fizycznej galezi, zamiast doboru najblizszej czestotliwosci.
Sama zgodnosc z jednomodowym KS nie zamyka certyfikacji tego przypadku.


## Pomocnicze obliczenie sprzezonych modow

Skrypt scripts/de100_coupled_reference_diagnostic.py zachowuje
reprodukowalny eksperyment Galerkina: baza kosinusowa Neumanna w filmie,
pelne jadro Greena Dirichleta i jego pochodne, hermitowski operator
energii oraz pelny blokowy problem LL. Parametry sa celowo ustalone
na wartosci pilota. Skrypt nie uruchamia FEM i nie nadaje kwalifikacji.

W wykonanej kontroli N=1,8,16 oraz Q=160,320 i dodatkowo N=16,24
z Q=640,1280 odtworzono Gamma 9.205971992409074 GHz.
Dla N=24, Q=1280, k=20e6 pierwsze trzy dodatnie czestotliwosci
wyniosly 11.232180144, 15.205061727 i 17.434764420 GHz.
Dla k=40e6: 12.674833906, 16.148817927 i 19.087643924 GHz.
To posortowane wartosci wlasne referencji diagnostycznej, a nie
zidentyfikowane galezie DE i nie dane FEM. Zwiekszenie N oraz Q
daje mniejsze zmiany, lecz nie ustanowiono jeszcze tolerancji akceptacji.
Nadal wymagane: niezalezny przeglad rownan i znakow, kontrola
shootingiem, residuale, zbieznosc i profile modow.


## Zakonczony etap native-build zadania 44

Log workera potwierdzil: stage native-build end exit_code=0.
Nastepnie rozpoczal sie contract-slepc-modal przez
scripts/run_fem_cpu_slepc_modal_contract.sh slepc-modal.
Sukces kompilacji nie oznacza jeszcze sukcesu calego joba ani FEM DE.
Przed uruchomieniem pilota nadal wymagane sa terminalny succeeded,
receipt oraz weryfikacja tozsamosci i hashy artefaktow.


## Przeglad rownan referencji diagnostycznej

Niezalezny przeglad potwierdzil jadro Dirichleta, dystrybucyjny
czlon delta w Dzz, normalizacje i skalowanie gamma0*Ms.
Dodatkowa kontrola rachunku fazy ustalila: skrypt stosuje
exp(-i*omega*time+i*k*y), czyli konwencje sprzezona do Fullmaga.
Znak +i*k w Dyz jest spojny z operatorem +i*sqrt(K)*J*sqrt(K).
Przy porownywaniu przyszlych zespolonych profili nalezy wykonac
sprzezenie; sama zgodnosc widma i reciprocity nie wykrywa tej roznicy.
Konwencje zapisano jawnie w docstringu. Nadal brakuje cross-checku
shootingiem, residuali modow i identyfikacji fizycznych galezi.


## Identyfikacja harmonicznej w komorce periodycznej

Zakres abs(ky)<=40e6 rad/m lezy wewnatrz pierwszej strefy
Brillouina komorki 50 nm: pi/a=62.831853e6 rad/m. Nie oznacza
to usuniecia z widma wszystkich galezi z fizycznymi wektorami k+G.
G=2*pi/a=125.663706e6 rad/m, wiec przy ky=40e6 harmoniczna
ky-G ma modul 85.663706e6 rad/m. Nie ustalono jeszcze, ktore
z takich galezi wejda do okna do 30 GHz w wyniku FEM.

Wniosek dla porownania: referencja jednowymiarowa dla zadanego k
opisuje sektor G=0. Trzeba rozpoznac ten sektor na podstawie
profilu w plaszczyznie oraz okresowej czesci Blocha przed
porownywaniem modow grubosci. Sam numer surowego modu ani
najblizsza czestotliwosc nie wystarczaja. Nie zmieniamy parametrow
aktywnego pilota ani jego kapsuly. Ogolny kontrakt Blocha i
rozwijania w harmoniczne opisuje dokumentacja COMSOL:
https://doc.comsol.com/6.3/doc/com.comsol.help.semicond/semicond_ug_semiconductor.6.48.html
To zastosowanie ogolnej periodycznosci, nie mikromagnetyczny
benchmark z tej strony.

### Profile i niezależna kontrola referencji

Rozszerzono diagnostykę Galerkina o zespolone profile modów, transformację
powrotną do zmiennych magnetyzacji, kontrolę dodatniości oraz residual
oryginalnego **dyskretnego** równania LL. Pięć lekkich testów interpretera
zakończyło się powodzeniem; nie są to testy natywnego runtime FEM.
Konwencja Fullmag jest sprawdzana przez sprzężenie profili i znaku bloku
magnetostatycznego, ponieważ same częstotliwości nie wykrywają tej pomyłki.
Metodę opisuje `2026-09-14-de-coupled-reference-method.md`.

Wstępny niezależny eksperyment kolokacji Czebyszewa rozwiązał różniczkowe
równania LL–Poissona z sześcioma jawnymi warunkami brzegowymi. Dla stopni
32, 48 i 64 pierwsze trzy częstotliwości zgadzały się do ośmiu wyświetlonych
miejsc po przecinku. Przy k=20 Mrad/m uzyskano 11.23215299, 15.20503202,
17.43475997 GHz; przy k=40 Mrad/m 12.67480343, 16.14874894,
19.08761353 GHz. To diagnostyka referencji, nie wynik Fullmag. Utrwalenie
algorytmu, kontrola residuali i zbieżności są kolejnym krokiem, zanim
posłuży on do ustalenia bramki porównania.

Build 44 nadal wykonuje etap `contract-slepc-modal`; główna kompilacja
runtime zakończyła się kodem 0. Pilot FEM pozostaje **NOT VERIFIED**.

### Build 44: terminalny błąd ostatniego kontraktu

Stan końcowy job `635451d7648a446a83e8d88e21c0279b`: `failed`, exit 2.
Runtime zbudował się z exit 0. Siedem programów kontraktowych zbudowano,
ale kompilacja `fem_floquet_modal_solver_contract` zakończyła się błędem:
`poisson_airbox_shared_domain.hpp:18: fatal error: mfem.hpp: No such file or directory`.
CTest nie został wykonany; wcześniejsze zbudowane cele nie oznaczają zaliczonych testów.

Przyczyna źródłowa: cel dołącza nagłówek współdzielonej domeny korzystający
z MFEM, lecz nie miał zależności od importowanego celu MFEM. Sąsiednie
kontrakty mają tę zależność. Poprawka w `backends/fem/CMakeLists.txt`
dodaje `MFEM::mfem` albo `mfem` także dla kontraktu solvera Floquet.
Przejrzano obie gałęzie warunkowe i rzeczywisty include w pliku testu.
Odtworzenie kompilacji i wykonanie ośmiu kontraktów w nowym managed buildzie
pozostaje wymagane. Nie zmieniono kapsuły ani artefaktów buildu 44.
Pilot FEM nadal nie został uruchomiony.
