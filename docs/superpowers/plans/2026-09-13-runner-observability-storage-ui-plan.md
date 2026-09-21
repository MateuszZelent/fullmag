# Fullmag Build Runner — plan UI, obserwowalności i ochrony storage

Data: 2026-09-13. Status: propozycja do implementacji. Zakres tej pracy: analiza źródeł i plan; bez zmiany działającego runnera ani usuwania danych.

## 1. Cel i stan wyjściowy

Runner powinien sam utrzymywać kontrolowany budżet danych, rozpoznawać przerwane wykonania i pokazywać operatorowi, co robi, co go blokuje oraz gdzie pozostawia pliki. UI musi działać także wtedy, gdy Fullmag nie daje się zbudować.

Analiza checkoutu `C:/git/fullmag/fullmag`, HEAD `17127ba764dd50ae3f7f4b8c463221dd68ab82da`. Zastane zmiany w submodułach i nieśledzone dokumenty pozostawiono bez zmian. Poniższe ustalenia dotyczą odczytanych źródeł; nie wykonano pomiaru bieżącego zajęcia dysku, RAM ani inspekcji działającego kontenera. Ilość miejsca do odzyskania pozostaje niezmierzona.

| Ustalenie ze źródeł | Konsekwencja dla projektu |
|---|---|
| `scripts/local_runner/retention.py` jest wyłącznie planistą; obejmuje terminalne `execution`, domyślnie po 24 h dla sukcesu i 168 h dla failure/cancel | Potrzebny oddzielny, audytowalny wykonawca i polityki dla pozostałych klas danych |
| Retencja sprawdza journal, owner, source digest, pełny container ID, pin i niebezpieczne ścieżki | Zachować te zabezpieczenia; wiek katalogu nie dowodzi bezpieczeństwa usunięcia |
| `build_executor.py` sprawdza 8 GiB przed wykonaniem | Brakuje budżetu wzrostu i ciągłej ochrony podczas buildu |
| `container_main.py` ogranicza wejście planisty retencji do 1000 rekordów | Pełna inwentaryzacja wymaga paginacji; UI musi sygnalizować niepełny wynik |
| `build_entrypoint.py` zapisuje stdout/stderr etapów bezpośrednio do osobnych plików | Logi etapów istnieją, lecz nie tworzą czytelnej relacji na konsoli koordynatora |
| `container_api.py` celowo wycisza standardowy logger HTTP dla ochrony tokena | Dodać własne bezpieczne zdarzenia, nie przywracać bezwarunkowego logowania żądań |
| API udostępnia health, jobs, job detail, logs, cancel, stop/resume i retention | Rozbudować istniejącego koordynatora; nie tworzyć drugiego właściciela SQLite |
| Target zależy od worktree/profilu/obrazu, a cache jest współdzielony | Potrzebny rejestr zasobów i odwołań wielu jobów |

Źródła: `docs/guides/local-container-runner.md`, wymienione moduły, `service.py`, `coordinator.py`, `queue.py`, `justfile`. Dokumentacja zawiera także sekcje historyczne; nie traktować ich jako dowodu aktualnej kwalifikacji runtime.

## 2. Architektura produktu

Proponowany osobny panel operatorski `apps/runner-console`, statycznie serwowany przez koordynator pod `/ui/`. Nazwa i lokalizacja są propozycją, nie istniejącą aplikacją. Własny mały build frontendu, niezależny od buildu solverów. Zachować jeden koordynator, jedną kolejkę, jeden slot ciężkiego buildu i obecne profile CPU/GPU. Nie włączać panelu w cykl życia sesji naukowej Control Room.

Warstwy: kolejka i journal → kolektory metryk/rejestr storage → wersjonowane API → typowany klient → widoki. UI nie dostaje Docker socketu, ścieżek do arbitralnego wykonania ani możliwości bezpośredniego zapisu SQLite. Nowe trwałe decyzje kontraktowe zapisać w ADR przed implementacją.

Panel lokalny, ten sam origin co API, bez CDN i zależności od internetu. Zachować bind do loopback. Proponowana sesja przeglądarkowa: wymiana lokalnego tokena na krótkotrwałą sesję HttpOnly, SameSite=Strict, kontrola Origin i CSRF dla mutacji. Nie umieszczać tokenów w URL, localStorage, logach ani pakiecie JS. Istniejący klient CLI zachowuje bearer auth. Sieć LAN i konta wielu użytkowników poza pierwszym zakresem.

## 3. Układ UI

Stała lewa nawigacja: Przegląd, Kolejka, Historia, Storage, Procesy i zasoby, Logi, Polityki, Diagnostyka. Górny pasek: host, zdrowie API, zdrowie wykonawcy, tryb kolejki, czas ostatniej aktualizacji. Widoczny baner blokady z konkretną przyczyną i możliwym działaniem. Brak danych pokazywać jako „niedostępne”, nigdy jako zero.

### Przegląd

Pierwszy ekran odpowiada: co trwa, co jest następne, czy komputer ma bezpieczny zapas i czy potrzebna jest interwencja.

1. Karty: aktywny build i etap; liczba oczekujących; wolne miejsce i rezerwacje; RAM workera/limit; ostatni wynik sprzątania.
2. Duży panel aktywnego buildu: profil, worktree, SHA/snapshot digest, czas oczekiwania, czas pracy, etap, ostatnie zdarzenie. Przycisk szczegółów i logów.
3. Następne zadania: pozycja, profil, źródło, wiek zgłoszenia, powód oczekiwania. Rozróżniać zajęty slot, pauzę operatora, brak miejsca, recovery i błąd konfiguracji.
4. Trendy ostatniej godziny: wolny dysk, przyrost danych, RAM, CPU i I/O. Oś czasu wspólna; oznaczenia etapów i cleanupu.
5. Ostatnie incydenty: awaria, OOM, utrata komunikacji, blokada retencji, przekroczenie progu. Każdy prowadzi do dowodów.

Nie pokazywać sztucznego procentu kompilacji. Postęp etapów jest faktem, ETA jest estymacją z liczbą próbek i zakresem. Dla nowego profilu „brak historii”.

### Kolejka i historia

Tabela: pozycja/job ID, status, profil, owner, worktree, commit/digest, czas zgłoszenia, oczekiwania i wykonania, etap, przyczyna blokady, rozmiar danych własnych, wynik. W historii dodatkowo exit code, peak RAM, przyrost storage i status retencji.

Filtrowanie po stanie, profilu, worktree, źródle i przedziale czasu; sortowanie po czasie/rozmiarze; paginacja serwerowa. Link do buildu stabilny po odświeżeniu. Rozwinięcie wiersza nie przesuwa widoku przy aktualizacji.

Akcje: pauza/drain, wznowienie, anulowanie konkretnego zadania, pin danych diagnostycznych. Retry tworzy nowy job powiązany z pierwotnym i używa tej samej istniejącej kapsuły; jeżeli kapsuła została usunięta, wyjaśnia konieczność nowego capture. Nie zmieniać automatycznie kolejności ani semantyki FIFO w pierwszej wersji.

### Szczegóły buildu

Zakładki:

- **Przebieg:** timeline queued → przygotowanie → etapy → weryfikacja receipt → wynik; czasy etapów, retry/recovery, sygnał zakończenia, OOM i exit code.
- **Logi:** stdout/stderr według etapu, wyszukiwanie, poziomy, kopiowanie i pobieranie ograniczonego fragmentu lub pliku. Auto-follow tylko gdy użytkownik jest na końcu. Komunikat o rotacji, luce lub ucięciu.
- **Zasoby:** CPU, RAM current/peak/limit, I/O, liczba procesów, rozmiar własny i współdzielony. Cursor wykresu pokazuje etap w tym momencie.
- **Pliki:** logiczna kategoria, ścieżka hosta, ścieżka kontenera, rozmiar, czas pomiaru, właściciele/odwołania, termin retencji i powód ochrony. Lazy tree i największe katalogi.
- **Źródła i wynik:** pełne SHA/digest, image ID, requested/resolved backend i device, receipt, artefakty i hashe. Sukces buildu nie oznacza kwalifikacji fizyki.
- **Sprzątanie:** co pozostało, co usunięto, ile faktycznie odzyskano, dlaczego reszta jest chroniona.

### Storage

Najważniejszy ekran operacyjny. Tabela wolumenów pokazuje pojemność, użycie, wolne miejsce, rezerwacje przyszłego wzrostu i progi. Oddzielnie dysk hosta, filesystem widoczny w kontenerze, magazyn Dockera/backing VHDX, jeżeli kolektor potrafi je zidentyfikować. Nie dodawać tych samych bajtów widzianych przez różne mounty.

Podział: source capsules, execution, trwałe build targets, cache zależności, artefakty, logi, dane koordynatora, zasoby Docker, nieprzypisane. Każda kategoria ma: logical bytes, allocated bytes jeśli dostępne, liczba plików, kompletność skanu, czas pomiaru, rozmiar kwalifikujący się do usunięcia i szacowany odzysk.

Pod wykresem segmentowym tabela zasobów: sortuj po rozmiarze/ostatnim użyciu, filtruj worktree/profil/job. Widoczna kolumna „dlaczego zostaje”: aktywny lease, mount, pin, current, wspólny cache, nieznany właściciel, niekompletny skan. Domyślnie najwyżej największe zasoby, a nie tysiące plików.

Panel cleanupu: plan z identyfikatorem, wersją polityki, konkretnymi zasobami, powodami, estymacją i listą blokad. Oddzielić „dane kwalifikują się” od „wykonawca ma zgodę polityki i może je bezpiecznie usunąć”. Pokazać wynik każdego elementu i różnicę wolnego miejsca przed/po. Usunięcie plików wewnątrz VHDX nie jest dowodem zmniejszenia jego pliku na hoście; automatyczna kompakcja poza zakresem.

### Procesy i zasoby

Koordynator, worker builda, jego drzewo procesów oraz rozpoznane procesy/kontenery używające storage. Kolumny: PID/container ID, rola, job, czas startu, CPU, RAM/limit, I/O i używane ścieżki. Command line po redakcji sekretów. Obce procesy tylko informacyjnie; brak przycisku ogólnego kill.

Rozdzielić RAM hosta, Docker VM i cgroup workera; sumowanie może dublować użycie. Podobnie CPU: podać procent względem przydzielonego limitu i zużywane rdzenie. GPU opcjonalne z identyfikacją urządzenia; brak kolektora oznacza brak danych, nie CPU fallback.

### Polityki i diagnostyka

Polityki: tryb preview/automatic, TTL według kategorii, budżety, progi, pin i limity logów, harmonogram skanu. Zmiana pokazuje różnicę i nowy preview przed aktywacją. Historia wersji, autor i czas.

Diagnostyka: API vs worker health, profil i allow-list, slot/lease, powód recovery, ostatni błąd, wersja koordynatora, świeżość kolektorów. Eksport raportu bez tokena i `.env`. Alert ma klucz do deduplikacji, początek, ostatnie wystąpienie i warunek rozwiązania; potwierdzenie alertu nie usuwa przyczyny.

## 4. Bezpieczna automatyczna retencja

Pierwsza automatyzacja obejmuje tylko własne prywatne dane runnera. Współdzielone Cargo targets/cache pozostają chronione aktualnym kontraktem projektu, w tym wymaganym potwierdzeniem korzystających agentów. Ich bezobsługowe czyszczenie wymaga osobnej migracji do zasobów wyłącznie zarządzanych przez runner i wspólnych leases wszystkich konsumentów.

Proponowane wartości początkowe do kalibracji:

| Klasa | Propozycja |
|---|---|
| execution po sukcesie | 24 h |
| execution po failure/cancel | 7 dni; krótsza retencja tylko przez jawną politykę |
| osierocony staging/capture | 24 h od potwierdzenia braku referencji i zakończenia capture; nie od samego mtime |
| źródła | minimum 7 dni, potem tylko bez referencji aktywnych jobów/pinów i wymaganych danych odtworzenia |
| logi | rotacja i limit bajtów od początku, proponowane 30 dni historii |
| receipt i journal | mały trwały zapis audytowy, także po usunięciu dużych danych |
| artefakty | minimum ostatnie 3 sukcesy na profil oraz wszystkie pinned/current; starsze według jawnego budżetu i okresu |
| build targets/cache | w pierwszym wdrożeniu tylko pomiar i kandydaci; automatyka dopiero po migracji własności |
| terminalne kontenery | usuwać tylko własny pełny ID po utrwaleniu logów/wyniku i potwierdzeniu braku działania |

Rejestr zasobów zawiera resource ID, kategorię, kanoniczny root, storage/mount identity, job references, owner, last-used, pin, measurement i lifecycle. Odwołania do wspólnych danych liczyć raz; rozmiar joba rozbić na własny, shared i przyrost zmierzony podczas wykonania.

Wykonanie: snapshot planu → blokada konkretnego zasobu i wykluczenie nowych konsumentów → ponowna walidacja tożsamości, pinów, referencji, procesu i mountów → zapis intencji → usunięcie dokładnego zasobu → zapis wyniku. Plan ma TTL i revision; zmiana stanu unieważnia decyzję. Walidacja musi chronić także wyścig podmiany ścieżki podczas operacji, bez podążania za symlink/junction/reparse point. Niejednoznaczność oznacza zachowanie danych i powód blokady.

Usuwanie musi być restartowalne i idempotentne. Po crashu dokończyć lub rozliczyć dokładnie rozpoczętą operację; nie skanować nazw i nie zgadywać właściciela. Quarantine rename na tym samym wolumenie może ułatwić recovery, lecz nie zwalnia miejsca i nie jest zabezpieczeniem przed pełnym dyskiem. Nie obiecywać cofnięcia po rzeczywistym usunięciu.

## 5. Przerwane buildy i ochrona przed pełnym dyskiem

Rozróżnić: anulowanie operatora, proces zakończony błędem, OOM, ENOSPC, restart koordynatora, utracony obserwator, niejednoznaczny Docker create oraz niedostępny daemon. Timeout klienta nie anuluje joba. Sam wiek lease nie uprawnia do zwolnienia slotu ani cleanupu.

Recovery najpierw potwierdza pełny container ID, etykiety, obraz i terminalność; potem finalizuje queue/journal/logi. Przerwany capture bez joba ma osobny rekord i capture lease. Stan niepewny dostaje widoczne „wymaga rozstrzygnięcia”, a nie automatyczne failed. Cleanup przychodzi dopiero po reconciliation.

Ochrona działa niezależnie od otwartej przeglądarki:

1. Przed capture i startem rezerwacja prognozowanego dodatkowego zapisu według profilu/obrazu i historii peak; cold build dostaje konserwatywny budżet operatora. Sprawdzać każdy rzeczywisty wolumen, także backing Dockera i tmp.
2. Start dopuszczony, gdy wolne bajty minus inne rezerwacje pokrywają przewidywany pozostały wzrost i rezerwę bezpieczeństwa. Nie odejmować ponownie już zapisanych danych; rezerwacja maleje z konsumpcją.
3. Proponowane progi startowe: ostrzeżenie przy zapasie poniżej większej z wartości 15%/30 GiB; blokada startu według budżetu; krytyczny zapas większy z 5%/10 GiB. Kalibracja do pojemności i profili obowiązkowa, nie są to wyniki pomiarów hosta.
4. Próbkowanie wolnego miejsca co 5 s; pełny skan katalogów niezależny i rzadszy. Przy presji uruchomić dozwolony cleanup i zatrzymać nowe starty.
5. Jeżeli aktywny build zbliża się do krytycznego zapasu, zgodnie z włączoną polityką wykonać kontrolowane anulowanie własnego workera, zapisać `storage_pressure` i ograniczony raport. Nie zabijać obcych procesów. Awaryjny zapis ma własny mały budżet.
6. Wznowienie po odbudowaniu zapasu z histerezą i stabilnym pomiarem; pauza operatora pozostaje niezależna i nie znika automatycznie.

Monitoring i anulowanie zmniejszają ryzyko, ale nie dają twardej gwarancji przy gwałtownym zapisie lub aktywności obcych aplikacji. Twarda izolacja wymaga kwalifikowanego limitowanego wolumenu/kwoty oraz rezerwy hosta; zbadać możliwości istniejącego storage przed wyborem mechanizmu. Nie migrować aktywnych buildów ani VHDX w ramach pierwszego wdrożenia.

## 6. Logi Dockera i dane telemetryczne

Koordynator emituje na stdout ustrukturyzowane zdarzenia z timestamp UTC, level, event, job ID, profile, stage, duration i krótkim komunikatem. Minimum: start/version, ready, queued, claimed, stage start/end, low disk, blocked, cancel, recovery, cleanup planned/applied/skipped, terminal i awaria kolektora. INFO pokazuje pracę bez zalewu request logami; DEBUG jest ograniczone czasowo. Okresowy zwięzły heartbeat, np. co 60 s.

Logi kompilatora pozostają oddzielnymi plikami z kursorem/offsetem, rotacją i limitem; opcjonalny ograniczony tail w Dockerze, bez dublowania całego strumienia. Utrata lub rotacja części logu ma jawny marker. Redakcja sekretów obejmuje błędy i argumenty poleceń; logger HTTP nadal nie wypisuje nagłówków. Konfiguracja drivera Dockera ma limit rozmiaru i liczby plików.

Metryki kontenerów pobiera zaufany koordynator przez istniejący adapter Dockera; metryki Windows wymagają małego kolektora hostowego, ponieważ RAM hosta nie jest RAM-em kontenera. Kolektor nie zarządza kolejką. Jego brak nie blokuje UI, lecz ogranicza zakres potwierdzonej ochrony hosta.

Próbki mają timestamp, scope, jednostkę i validity. Propozycja: metryki co 2–5 s, historia surowa 24 h, agregaty 1 min przez 30 dni. Inwentaryzacja ma limit czasu/I/O, checkpoint i paginację, nie działa w obsłudze HTTP. DB, journal, logi i same metryki również mają budżet. ETA według profilu i cold/warm cache, z jawną niepewnością.

## 7. Proponowane API i kontrakty

Zachować istniejące endpointy i CLI. Nowe zasoby pod wersjonowaną przestrzenią, np. `/api/v1/`; poniższe trasy są projektowane:

| Zasób | Funkcja |
|---|---|
| GET overview, jobs, jobs/{id} | stan zbiorczy, paginowana kolejka, szczegóły z revision |
| GET jobs/{id}/events, /logs, /metrics, /resources | kursory zdarzeń i logów, ograniczone szeregi, powiązania storage |
| GET storage/volumes, storage/resources | pomiary z completeness, scan ID i stale age |
| GET processes, alerts | zredagowana obserwacja i incydenty |
| GET events | SSE z cursor/reconnect; przy luce ponowne pobranie snapshotu |
| POST retention/plans | asynchroniczny preview o utrwalonym plan ID |
| POST retention/plans/{id}/apply | idempotentne wykonanie zgodne z polityką i ponowną walidacją |
| GET/PUT retention/policy | wersja i optimistic concurrency |
| POST resources/{id}/pin | ochrona konkretnego zasobu z uzasadnieniem |

Mutacje używają resource ID, revision i idempotency key, nigdy dowolnej ścieżki/powłoki. Powtórzenie requestu nie wykonuje drugi raz cleanupu. Błędy strukturalne: kod, powód, zasób i możliwy następny krok. Ustalić kompatybilność schematu SQLite i migracje z backupem przed wdrożeniem. SSE i kolektory nie mogą zająć wszystkich wątków serwera ani blokować cancel/health.

## 8. Wymagania wizualne i wydajność

Spokojny panel operatorski: neutralne tło, wysoki kontrast, jednoznaczne kolory statusów wspierane tekstem/ikoną; liczby z równą szerokością cyfr, ścieżki monospace. Jasny i ciemny motyw. Główne liczby czytelne przy 1440×900; przy 1280×720 bez poziomego przewijania całej strony. Szerokie tabele mogą przewijać się lokalnie. Klawiatura, widoczny focus, reduced motion, brak migających aktualizacji.

Wirtualizacja długich logów/tabel, ograniczone punkty wykresów, server-side downsampling, anulowanie nieaktualnych żądań. Ukryta karta ogranicza odświeżanie. Aktualizacja nie resetuje selekcji, scrolla ani filtrów. Każdy widok ma loading, empty, stale, disconnected, partial i error state.

## 9. Etapy realizacji i odbiór

| Etap | Pliki/obszary | Wynik i dowody |
|---|---|---|
| 0. Inwentaryzacja wdrożenia | istniejący CLI, resolver, konfiguracja hosta, dokumentacja | read-only status runnera, mapowanie wolumenów i zasobów, pomiar rozmiarów bez pełnego skanu w godzinach obciążenia; rozbieżność źródła/obrazu jawna |
| 1. Zdarzenia i metryki | `service.py`, `container_main.py`, `build_entrypoint.py`, `unix_docker.py`; nowe moduły telemetry/events | Docker pokazuje cykl zadania; test redakcji tokena i limitów; awaria kolektora nie zatrzymuje kolejki |
| 2. Rejestr i preview | `retention.py`, `queue.py`; nowe storage inventory/resource registry; testy retencji | paginacja ponad 1000 jobów, poprawne shared bytes, partial scans, ścieżki i blokady; zgodność sum z kontrolnym zestawem |
| 3. UI tylko do odczytu | proponowane `apps/runner-console`, `container_api.py`, `container_client.py`, obraz koordynatora | działające ekrany z rzeczywistym API, log tail, metryki i paths; test przeglądarkowy disconnect/reconnect i długiej historii |
| 4. Recovery i wykonawca cleanup | `build_executor.py`, `coordinator.py`, `service.py`; nowe retention executor/pressure policy | testy awarii, wyścigów i restartu; usunięcie wyłącznie zasobów testowych; aktywny build/pin/shared pozostają nietknięte |
| 5. Kontrola i automatyka | UI polityk, mutacje API, host collector, dokumentacja operatora | preview → świadome włączenie zakresu polityki → automatyczne przebiegi; audit i ochrona dysku bez otwartej przeglądarki |
| 6. Wdrożenie | managed build, obraz, istniejące start/replace/status recipes | drain i pusty slot przed wymianą obrazu, test rzeczywistego kolejnego buildu i restartu; obserwacja stabilności, plan powrotu |

Przed implementacją użyć izolowanego zarejestrowanego worktree i wymaganej procedury projektu. Nie wykonywać ciężkiego buildu poza kolejką. Każdy etap ma spójny commit z odpowiednimi kontrolami; integracja zgodnie z zasadami repozytorium.

Istniejące moduły testowe do rozszerzenia: `scripts/test_local_runner_retention.py`, `test_local_runner_queue.py`, `test_local_runner_build_executor.py`, `test_local_runner_coordinator.py`, `test_local_runner_container_client.py` oraz `scripts/tests/local_runner/test_container_api.py`, `test_container_main.py`, `test_service.py`. Polecenia lekkich testów dobrać do używanego w repo środowiska, np. `python -m pytest scripts/test_local_runner_retention.py scripts/test_local_runner_queue.py scripts/test_local_runner_build_executor.py scripts/tests/local_runner` po sprawdzeniu zależności. Dodać osobne testy nowych modułów oraz build/typecheck i browser smoke panelu.

Obowiązkowe scenariusze: anulowanie queued/running; restart koordynatora z żywym workerem; daemon unavailable; ambiguous create; ENOSPC/OOM; zmiana pina między plan/apply; nowy konsument w trakcie cleanupu; junction/mount/path escape; crash po częściowym usunięciu; niedostępny kolektor hosta; zalew logów; retry HTTP; brak receipt; stare źródła bez pełnego rejestru; dwa widoki operatorskie równocześnie. Destrukcyjne testy wyłącznie na kontrolowanych danych testowych.

Odbiór: operator z pierwszego ekranu zna przyczynę czekania; z buildu dociera do logów i ścieżek; suma zasobów nie dubluje shared; każdy pomiar ma świeżość; każda odmowa cleanupu ma powód; automatyka działa po zamknięciu UI i po restarcie. Zwolnione miejsce potwierdza pomiar, a ochrona hosta ma osobny dowód. Testy UI nie są dowodem bezpieczeństwa retencji ani kwalifikacji solvera.

## 10. Granice i kolejność priorytetów

Najpierw widoczne logi, pomiary i wyjaśniona kolejka; następnie bezpieczne execution cleanup i ciągła ochrona; potem szersza polityka artefaktów/źródeł. Automatyzacja shared cache wymaga pełnej własności i nie powinna blokować pierwszej użytecznej wersji.

Przed włączeniem automatyki skalibrować budżety na rzeczywistym cold/warm buildzie, zatwierdzić retencję wyników oraz zachowanie przy krytycznej presji. Nie trzeba tych decyzji podejmować przed wdrożeniem obserwacji i preview. Ten plan nie wykonuje ani nie zatwierdza konkretnego usunięcia istniejących danych.
