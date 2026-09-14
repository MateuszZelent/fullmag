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
