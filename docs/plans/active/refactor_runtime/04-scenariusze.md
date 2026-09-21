# Fullmag CAE — scenariusze odbioru architektury

**Status wszystkich scenariuszy:** NOT_RUN. To kontrakty przyszłych testów, nie raport zaliczenia.  
**Zakres:** cały cykl pracy CAE, nie tylko startup.  
**Referencje:** [architektura](01-architektura-cae.md), [kontrakty](02-kontrakty.md), [migracja](03-migracja.md).

## 1. Sposób kwalifikacji

Każdy scenariusz potrzebuje: fixture, SHA źródeł, wersji klienta/API/workera, lane i urządzenia, dokładnej akcji, obserwacji API/artefaktów oraz wyniku. Screenshot może dowodzić prezentacji, lecz nie działania correct backend ani braku zbędnych obliczeń. Test przepływu sprawdza także komendy, tożsamości i manifesty.

Test naukowy raportuje normę błędu/tolerancję, kryterium stopu i pochodzenie referencji. Nie używamy jednej arbitralnej tolerancji do wszystkich metod. Niedostępna kombinacja jest sprawdzana jako jawne odrzucenie; nie zmienia się w „test wykonania zaliczony”.

## 2. Projekt i persystencja

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-01 | Uruchom aplikację bez sesji i bez GPU; utwórz projekt. | Dostępne definitions, geometry i Save; zero uruchomień solvera. |
| CAE-02 | Dodaj bryłę bez materiału i study; Save/Close/Open. | Niekompletny model zachowany; Compute wyjaśnia brakujące definicje. |
| CAE-03 | W polu pozostaw `sin(`; zapisz draft i ponownie otwórz. | Tekst odzyskany jako draft, niepoprawne AST nie trafia do IR. |
| CAE-04 | Otwórz legacy `.fms`, wykonaj migrację do nowej kopii. | Raport migracji, zachowany oryginał, brak cichej utraty danych/źródeł. |

## 3. Geometria i parametry

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-05 | Zmień parametr szerokości zależnej geometrii. | Zmienione tylko zależne realizacje; definicja nie wymaga solve. |
| CAE-06 | Zmień nazwę parametru/obiektu. | Referencje ID i AST pozostają poprawne; brak nieuzasadnionego remeshu. |
| CAE-07 | Wprowadź cykl parametrów i błędny wymiar jednostki. | Czytelna ścieżka błędu; zapis draftu możliwy, Compute blokowane. |
| CAE-08 | Build to Selected, potem błąd późniejszej cechy CSG. | Poprzedni etap geometrii dostępny; dokładny węzeł błędu, bez globalnego modalu. |

## 4. Selekcje i przypisania

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-09 | Operacja dzieli wybraną powierzchnię na dwie. | Zachowanie zgodne z selection policy albo jawna ambiguity; brak losowego wyboru. |
| CAE-10 | Move/rotate tekstury regionalnej. | Zmiana tekstury nie przesuwa maski regionu; clipping i frame zachowane. |
| CAE-11 | Aktywuj Frozen Spins z predykatu zapisanego pola. | Przypięty source state i activation ID; kolejne klatki nie zmieniają samoczynnie maski. |
| CAE-12 | Usuń obiekt użyty przez źródło, materiał i study. | Impact report i transakcyjna decyzja; zachowana historia istniejących rozwiązań. |

## 5. FDM i FEM

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-13 | Utwórz FDM grid dla geometrii. | Grid/masks powstają bez żądania FEM policy i bez Gmsh, jeśli lane tego nie wymaga. |
| CAE-14 | Ten sam model ma recepturę FDM i FEM. | Przełączenie study reference nie usuwa drugiej receptury, materiałów ani wyników. |
| CAE-15 | FEM build zwraca zły marker lub nieakceptowany certyfikat. | Brak publikacji jako kwalifikowany mesh; Problems i edytor nadal dostępne. |
| CAE-16 | FDM multilayer wykorzystuje dodatkowy carrier demag. | Warstwy, support i carrier mają osobne identity; brak podszywania się jednego gridu pod drugi. |

## 6. Studies i solver configurations

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-17 | Ten sam model ma dwa studies o innych solver configs. | Zmiana tolerancji jednego nie zmienia drugiego bez jawnego wspólnego reference. |
| CAE-18 | Regeneruj preset z ręcznymi override. | Diff i zachowanie ręcznych ustawień albo jawne rozstrzygnięcie konfliktu. |
| CAE-19 | GPU wymuszone dla nieobsługiwanej konfiguracji. | Preflight/Compute odrzuca z przyczyną; brak cichego CPU fallbacku. |
| CAE-20 | Compute przy widocznych, niezastosowanych zmianach formularza. | Commit + ACK przed snapshotem albo błąd pola; nie liczymy po cichu starej wartości. |

## 7. Równowaga i analizy częstotliwościowe

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-21 | Relaxation kończy się przez max_steps bez spełnienia kryterium. | Technical completion oddzielne od equilibrium qualification; zależne eigen sprawdza evidence. |
| CAE-22 | Eigen i response korzystają z tego samego linearization state. | Wspólne jawne wejście; odrębne wyniki, residuals i interpretacja. |
| CAE-23 | Mod zapisano w bazie stycznej/FEM DOF, otwórz animację. | Rekonstrukcja według wskazanej bazy; brak interpretacji współczynników jako gotowego m. |
| CAE-24 | Dispersion przechodzi przez bliskie/degenerujące mody. | Zachowane k/normalization/branch evidence; ambiguity nie ukryta indeksem sortowania. |

## 8. Sweeps i multiphysics

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-25 | Histereza z kontynuacją stanu. | Punkt n+1 korzysta z wyniku n; scheduler nie równolegli zależnych punktów. |
| CAE-26 | Niezależny sweep geometrii na kilku workerach. | Case IDs i seedy stabilne; każdy przypadek ma własne wejście i wynik. |
| CAE-27 | Przekaż pole/prąd między różnymi dyskretyzacjami. | Jawna projekcja, support, jednostki i wymagane bilanse; nie tylko dopasowanie shape. |
| CAE-28 | Dwukierunkowe sprzężenie wymagające iteracji. | Wersjonowana convergence policy i raport; nie arbitralne jednokrotne przejście po grafie. |

## 9. Współbieżność i własność wykonania

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-29 | Edytuj geometry revision 42, gdy run używa 41. | Run nie jest zabity ani zmieniony; wynik nadal wskazuje wejście 41. |
| CAE-30 | Podwójny klik Compute i utrata odpowiedzi POST. | Jeden przyjęty intent/run; reconciliation po idempotency key. |
| CAE-31 | Ten sam klucz idempotency z innym payloadem. | Jawny konflikt, nie zwrot niepasującego wykonania. |
| CAE-32 | Stary worker publikuje po utracie lease. | Odrzucony ownership epoch; nowy attempt nie jest zanieczyszczony. |

## 10. Cancel, resume i live control

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-33 | Cancel równocześnie z ukończeniem zadania. | Jedno spójne terminalne rozstrzygnięcie i historia request/ACK. |
| CAE-34 | Wznowienie po zmianie engine/precision lub braku historii integratora. | Odpowiednia RestoreClass; bez fałszywej gwarancji ExactResume. |
| CAE-35 | Apply live field na wspieranym runtime. | Steering ACK z krokiem/czasem, segmentem i wymaganym cache reset; draft osobny. |
| CAE-36 | Odrzucony adaptacyjny krok przy thermal/constraints. | Accepted state, RNG/history/constraints i checkpoint pozostają zgodne z kontraktem metody. |

## 11. Wyniki i postprocessing

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-37 | Otwórz solved archive na hoście bez dostępnego solvera. | Geometria wyniku, datasets i wykresy działają z zapisanych danych. |
| CAE-38 | Zmień tylko plot scale/component/cut. | Brak ponownego rozwiązania; nowe zapytanie tylko do potrzebnych danych. |
| CAE-39 | Zażądaj pola, którego nie zapisano. | `not_recorded`/właściwy powód; brak fizycznego zera lub podmiany na m. |
| CAE-40 | Porównaj pola FDM/FEM na różnych siatkach. | Jawna ilościowa projekcja i kontekst; brak odejmowania niezgodnych tablic. |

## 12. Transport, UI i wielodokumentowość

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-41 | Zerwij WS podczas liczenia i przywróć połączenie. | Workspace nie jest odmontowany; run status uzgodniony z backendem. |
| CAE-42 | Przełącz projekt A→B, gdy trwa decode pola A. | Odpowiedź A nie trafia do widoku/cache B. |
| CAE-43 | Otwórz historyczny dataset przy aktywnym live runie. | Dane i kamera nie są samoczynnie przejmowane przez live update. |
| CAE-44 | Menu, ribbon, shortcut i Python wykonują tę samą akcję. | Zgodne availability i preconditions; brak bypassu przez inną powierzchnię. |

## 13. Zapis dużych danych i awarie

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-45 | Przerwij zapis przed commit manifestu. | Poprzednia wersja pozostaje czytelna; staging nie udaje kompletnego wyniku. |
| CAE-46 | Brak miejsca w trakcie zapisu trajectory. | Jawny błąd i manifest coverage; utracone próbki nie udają kompletnego datasetu. |
| CAE-47 | GC przy aktywnym workerze i przypiętym starym solution. | Zachowane wszystkie referencje/leases; brak usunięcia potrzebnych danych. |
| CAE-48 | Reopen po awarii koordynatora. | Reconciliation istniejących runów; brak automatycznego dublowania wszystkich tasków. |

## 14. Python i rozszerzenia

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-49 | Ten sam model przez GUI, deklaratywny Python i headless. | Zgodna znormalizowana semantyka/IR oraz wymagane provenance. |
| CAE-50 | Otwórz plik Python z efektami ubocznymi. | Brak wykonania bez jawnego intentu; script-owned workflow opisany. |
| CAE-51 | Import modelu z nieznanym modułem fizyki. | Payload zachowany lub import odrzucony z raportem; nigdy silently dropped. |
| CAE-52 | Dwa konteksty Python równocześnie. | Brak współdzielonego globalnego state między projektami. |

## 15. Kwalifikacja numeryczna i wydajność

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-53 | Reprezentatywne porównania FDM CPU/GPU i FEM CPU/GPU. | Wykonane właściwe lane’y i error metrics; brak utożsamienia zgodności z bitwise equality. |
| CAE-54 | Długi solve z bardzo wolnym klientem UI. | Throughput solvera nie zależy od odbioru wszystkich preview frames. |
| CAE-55 | Powtarzane otwieranie projektów/wyników i zmiany quantity. | Pamięć/worker leases/listeners wracają do ustalonych budżetów. |
| CAE-56 | Reuse kolejnych zgodnych kroków na GPU. | Zweryfikowana poprawność cache i brak zbędnych pełnych transferów per timestep. |

## 16. Bezpieczeństwo i przenośność

| ID | Warunek i akcja | Wymagany wynik |
|---|---|---|
| CAE-57 | Archiwum z traversal, nadmiernym rozpakowaniem lub złą checksumą. | Bezpieczne odrzucenie przed publikacją projektu. |
| CAE-58 | Otwarcie nowego schematu starszym klientem. | Read-only/odrzucenie z komunikatem; brak uszkadzającego zapisu. |
| CAE-59 | Remote worker zgłasza inne capabilities niż żądane. | Brak niejawnego fallbacku, właściwy status i receipt. |
| CAE-60 | Package/Archive projektu z brakującym assetem zewnętrznym. | Raport braku; brak deklaracji kompletnego przenośnego projektu. |

## 17. Warunki badań wydajności

Należy mierzyć co najmniej: czas do interaktywnej powłoki, czas otwarcia projektu bez solvera, latencję edycji parametrów, zmianę quantity bez rebuild topologii, zużycie pamięci CPU/GPU, objętość transportu, liczbę wywołań przygotowania oraz czas uzyskania rozwiązania o wymaganej dokładności.

Nie wpisujemy fikcyjnych wyników ani jednego limitu dla wszystkich hostów i rozmiarów modeli. Przed wdrożeniem ustalamy klasy datasetów, sprzęt, cold/warm cache, percentyle i progi regresji. Próg wydajności nie może być spełniany przez obniżenie dokładności lub zmianę forced GPU na CPU.

## 18. Raport wydania

Raport zawiera macierz: architektura/fixture × lane × etap dowodu. Etapy to: schema/compile, integration, actual runtime, scientific qualification, performance. Puste pole nie jest zielonym testem.

Krytyczne dowody obejmują samodzielne Open/Save bez runtime’u, izolację draft/run, poprawne pinning wejść studies, spójną publikację artefaktów, odtwarzanie wyników i cztery lane’y w faktycznie wspieranym zakresie. Niewspierane funkcje pozostają oznaczone jako unsupported/planned, nie są ukrywane przez ogólny badge „production”.
