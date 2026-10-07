# ADR 0034: Procesowe, mierzone wykonywanie niezależnych punktów k

Status: zaakceptowany kierunek w zakresie polecenia użytkownika, implementacja i kwalifikacja otwarte.
Data: 2026-10-02.

## Kontekst

Natywne MFEM/PETSc mają stan procesu. Sekwencyjny k-loop ogranicza przepustowość wielu niezależnych punktów; sama liczba wątków Rayon nie uruchamia równolegle osobnych solverów k. Obciążenie zmienia się pomiędzy fazami, a host HPC może być współdzielony. Nie wolno uznać całego hosta za przydział jednego Fullmaga ani nazywać regulatora admission twardym limitem CPU.

## Decyzja

Polityka `ParallelExecutionPolicyIR` w `runtime_metadata.runtime_selection.parallel_execution` opisuje żądanie użytkownika. UI Study edytuje ten sam zasób przez istniejące authoring transactions; Python zachowuje go w kanonicznym skrypcie. Brak polityki oznacza serial, a adaptive jest jawnym wyborem. Domyślny cel CPU dla adaptive wynosi 90% przydziału, cel RAM 80%, rezerwa 1 GiB. Rdzenie na worker i maksymalna liczba workerów są oddzielnymi ustawieniami.

Oddzielne procesy zużywają niezmienną certyfikowaną równowagę i siatkę; worker nie relaksuje ponownie ani nie zmienia wykonanej precyzji/device. Rust runner zarządza procesami, admission, cancel i artefaktami; solver i operator fizyczny pozostają w `backends/fem`. Pierwszy zakres wymaga jawnego requested backend FEM i device CPU; auto, FDM i GPU są odrzucane zamiast ukrytej zmiany realizacji. Bias-field continuation i niekwalifikowane lane nie są równoleglone tym mechanizmem.

Kalibracja kończy jeden rzeczywisty punkt i zachowuje szczyt CPU/RSS, po czym admission uwzględnia affinity, ograniczenia cgroup, alokację HPC, obciążenie innych procesów, pamięć i rezerwę. Brak pomiaru zamyka admission. Zwiększanie puli jest stopniowe, spadek budżetu wstrzymuje start kolejnych punktów. Agregacja i śledzenie pasm odbywają się w kolejności sampling, niezależnie od kolejności ukończenia workerów.

CPU target jest miękkim celem regulatora; twarde quota są zadaniem OS/cgroup/schedulera i muszą pozostać widoczne jako osobny resolved allocation. Nie zmieniamy ich na współdzielonym HPC ani w runnerze. Unsupported telemetry nie oznacza 0% użycia.

Telemetria puli korzysta z istniejącego zasobu wykonania etapów Study,
bez dodatkowego endpointu i pollera. Próbka pochodzi z regulatora procesu
solverowego, nie z diagnostyki CPU serwera API. Liczba aktywnych procesów,
planowane admission i opcjonalny limit użytkownika pozostają oddzielne.
Brak CPU/RAM oznacza niedostępny pomiar. UI pokazuje czas pomiaru i odróżnia
próbkę końcową od aktywnego wykonania; nowy przebieg i etap nie dziedziczą
telemetrii poprzedniego wykonania. Aktualizacje okresowe są ograniczone,
a zmiana stanu procesów lub przyczyny admission może zostać wysłana
natychmiast. Końcowy raport artefaktowy pozostaje dowodem przebiegu,
nie substytutem zasobu live.

## Konsekwencje i migracja

Istniejące pliki bez polityki zachowują serial. Zapisujemy requested policy, resolved allocation i powody admission. Pula obliczeń nie tworzy dodatkowych koordynatorów builda i nie omija jego kolejki FIFO. Większa liczba workerów zwiększa RSS, stąd budżet pamięci jest równorzędny CPU.

Rollback: wybór `serial`, bez zmian danych fizycznych i bez kasowania wyników. Nie deklarujemy speedup ani zgodności naukowej na podstawie samej obecności procesów.

## Weryfikacja i stan

Plan i bramki: [adaptacyjne wykonanie dyspersji](../superpowers/plans/2026-10-02-adaptive-dispersion-execution.md).
Źródła fizyki pozostają [FEM Poisson-airbox modal eigen](../physics/0830-fem-poisson-airbox-modal-eigen.md) oraz ADR 0031 nonzero-k.
Required: walidacja policy/Python round-trip, produkcyjny managed build, serial/adaptive parity na wspólnej równowadze, pamięć i cancellation przy presji, rzeczywiste UI i WebGL. Kompilacja unit tests pozostaje zakazana. Status runtime: NOT VERIFIED do uzyskania tych dowodów.
## Rozdzielenie domen pomiaru CPU

Procent wykorzystania 12-rdzeniowego hosta nie jest procentem wykorzystania
4-rdzeniowej alokacji kontenera. Admission nie może brać maksimum tych
procentów i następnie mnożyć go przez rozmiar mniejszej alokacji.
Samplowanie publikuje osobno cpu_busy_percent dla leaf allocation oraz
cpu_available_cores jako minimum rzeczywiście wolnej pojemności affinity,
leaf cgroup, przodków z jawną skończoną quota CPU i efektywnego przydziału.
Nieograniczony przodek (`cpu.max = max`) nie tworzy budżetu równego affinity
liścia: jego usage obejmuje także obce zadania poza przydzielonymi CPU.
Ich konkurencję na przydzielonych CPU mierzy /proc/stat dla affinity.
Skończone quota przodków pozostają obowiązujące. Wszystkie ograniczenia
pojemności są najpierw przeliczone na rdzenie; brak pełnego okresu pomiaru
pozostaje unavailable.

Budżet nowych procesów wynosi minimum pojemności cpu_available_cores i
max(allocated_cpu_cores * target/100 - allocation_busy_cores, 0).
Nie dodajemy do niego własnego CPU z innego okresu. Przykład regresji:
host 12 CPU zajęty w 80%, alokacja 4 CPU zajęta przez 1 CPU daje wolną
pojemność min(2.4, 3)=2.4 CPU, a nie 80% zajęcia alokacji. Regulator
nadal uwzględnia koszt procesu, margines i stopniowe admission.
Minimalny niepodzielny worker może przekroczyć miękki cel tylko przy
dostępnym budżecie startu; wyjątek nie omija presji zewnętrznej domeny CPU.
Zmiana dotyczy scheduling, nie operatora ani residualu fizycznego.


## Tożsamość zasobu stage execution

Istniejący StageExecutionResource publikuje session_id, session_epoch
oraz run_id (jawny string/null) z tego samego zablokowanego snapshotu co
rekordy etapów. Session status i zasób etapów używają wspólnego helpera
epoch, z niezmienioną semantyką aktywnej sesji i terminalnego tombstone.
UI dopuszcza live telemetry wyłącznie dla ready zasobu i zgodnej tożsamości
z bieżącą sesją/runem. Brak pól w starym API nie jest dowodem zgodności;
nowy panel wygasza taki zasób do czasu zgodnej odpowiedzi. Nie tworzy
znaczników klienta udających serwerową provenance.

Zmiana jest dodatkiem do istniejącego endpointu, bez dodatkowego pollera.
Generated OpenAPI musi powstać z nowego backendu; lokalne przejściowe typy
nie kwalifikują klienta API. Weryfikacja runtime i browser pozostaje otwarta.

Podstawa semantyki: [dokumentacja jądra cgroup v2 — CPU](https://docs.kernel.org/admin-guide/cgroup-v2.html#cpu). `cpu.stat` obejmuje potomków, a `cpu.max = max` oznacza brak limitu. Zapis nieograniczonego przodka nie może więc być porównany z pojemnością mniejszego leaf affinity.

## Pełny envelope aktywnej puli

Oprócz headroom dla nowych procesów regulator ogranicza rozmiar całej puli przez skalibrowany szczyt CPU i RSS z marginesami. Chwilowa faza IO ani zwolnienie workspace nie mogą powiększać puli ponad jej pełny budżet CPU/RAM. Nie traktujemy summed RSS jako pamięci do odzyskania. Limit pozostaje miękkim admission, a nie gwarancją szczytu przyszłych punktów k ani kontrolą quota OS. Przy presji aktywne obliczenia są drenowane bez ich zabijania. Produkcyjny dowód tej korekty pozostaje otwarty.


## Jakość próbek i wiązanie polityki

Bieżący peak CPU/RSS workera powiększa envelope admission przed kolejnym startem, bez czekania na zakończenie procesu. Kalibrację zatwierdza dopiero poprawny pierwszy wynik. Wystarczające pokrycie CPU oznacza co najmniej trzy dodatnie interwały nie dłuższe niż jedna sekunda i łącznie co najmniej jedną sekundę obserwacji. Pomiary rzadsze lub krótsze zachowują resolved_threads jako konserwatywny koszt. To reguła schedulera, bez gwarancji rejestracji każdego piku. Raport cpu_observations rozdziela zmierzony peak, średnią terminalną, pokrycie interwałów i źródło resolved-team envelope. Osobne thread_bindings zachowują rzeczywiste zespoły zmniejszane przy wzroście puli.

Request o polityce różnej od parent pool jest odrzucany przed side effects. Jedna kanoniczna polityka steruje admission, środowiskiem procesu i raportem. Nie zmienia to semantyki solvera ani precyzji.

## Kontrakt authoringu i zgodność dekoderów

ScriptBuilderState zachowuje jawne requested_backend, requested_device oraz
requested_precision niezależnie od prezentacyjnego backend. Brak historycznych
pól zachowuje dotychczasowe backend/auto/double; polityka adaptive nie służy do
wywnioskowania CPU. Round-trip sceny przenosi rzeczywiste żądanie użytkownika.
Jawne null dla polityki sceny przywraca kanoniczne serial, tak jak w Pythonie
i runtime metadata. Nieznane pola i niepoprawne wartości nadal są odrzucane.
Ten kontrakt authoringu nie dowodzi realizacji schedulera ani parytetu solverów.
Regresje serde i adaptera Rust przygotowano; zakaz kompilowania unit tests
pozostaje w mocy. Runtime/API/browser wymagają odrębnych dowodów.
