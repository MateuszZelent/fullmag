# Audyt i plan: interaktywne ponawianie Study i etapów, edycja modelu oraz przebudowa siatki

**Data audytu:** 2026-11-05. **Aktualizacja odbioru:** 2026-11-07. Sekcje 1–9 zachowują ustalenia audytu i wymagania; aktualny stan implementacji oraz dowody CI/runtime opisuje §10. Pełny odbiór T8 pozostaje otwarty.

**Baza audytu:** `/mnt/c/git/fullmag/fullmag`, branch `master`, HEAD `7c38c65085a16c92f96f024f486156003bacfc3e`, z lokalnymi zmianami, m.in. w Inspectorach. Fakty dotyczą odczytanego drzewa roboczego, nie wyłącznie commita. Odczyt pliku lub istnienie symbolu nie dowodzi poprawnego działania w przeglądarce, GPU ani poprawności naukowej. Usunięto wcześniejszą deklarację „30/30, każda linia potwierdzona”, która nie odpowiadała treści dokumentu.

**Decyzje użytkownika:** rodzic **Study uruchamia cały cykl**, a akcja na **wybranym etapie uruchamia tylko ten etap**. Kolejne Run/Relax, także trzy Relax różnymi algorytmami, **dziedziczą aktualną magnetyzację z poprzedniego etapu**. Jawne przypisanie tekstury między etapami zmienia wejście następnego etapu. Zakres „od etapu do końca” nie należy do podstawowego kontraktu. Źródło stanu początkowego jest osobnym wyborem; sam rodzaj Relax nie oznacza resetu.

**Pierwotny zakres audytu:** poprawa raportu i planu. Późniejsze zlecenie użytkownika objęło implementację oraz integrację. Listy zadań i macierz §5 pozostają wymaganiami; wykonane zmiany i dowody są wyszczególnione w §10, bez domniemywania zaliczenia z samego opisu zadania.

## 1. Wynik ponownej weryfikacji

### 1.1. Potwierdzone problemy oraz ich granice

| ID | Ustalenie źródłowe | Wniosek dla wdrożenia |
|---|---|---|
| A01 | `session_status_after_projection` rozróżnia terminalny startup script i interaktywną komendę. `effective_runtime_status_code` preferuje stan wykonania etapów. Admission ma już wyjątek dla `session.status == awaiting_command`; nieprawdą jest, że każdy interaktywny terminalny run musi zostać odrzucony. [E16], [E03], [E19] | Oddzielić gotowość edytowalnego workspace od wyniku runu, uzgodnić wszystkie odczyty readiness i zachować historię oraz ograniczenia sesji tylko do odczytu. |
| A02 | `validate_active_scene_mutation` odrzuca zmianę wejścia nie-terminalnego accepted runu. Komenda przy bramce `Held` zwalnia istniejące całe Study, zanim nastąpi zwykły wybór pojedynczego kroku. [E17], [E09] | Sama zmiana allow-listy statusów jest niebezpieczna. Potrzebny kontrolowany mechanizm zastąpienia przygotowania i osobna obsługa Stage na bramce całego Study. |
| A03 | Zwykła projekcja sceny tworzy `study_plan.v2`, puste `inputs` i `completion_dependencies`. Ścieżka kompilacji skryptu ma już jawne `StepOutput`. Zależności zakończenia wymagają v3/v4. [E11], [E12], [E13] | Ujednolicić kompilację oraz wersjonowanie. Rozdzielić krawędzie kolejności od krawędzi przekazania magnetyzacji; zachować jawne zależności innych typów. |
| A04 | Kontynuacja pojedynczych Run/Relax odwołuje się do artefaktu z CAS, nie do dowolnego `latest_fields`. Nie uwzględnia edycji tekstury; wybór źródła nie potrafi wybrać wskazanego etapu z wielu zakończonych zadań. Runner już sprawdza dokładną równość layoutu. [E10], [E41] | Naprawić dobór źródła bez osłabiania weryfikacji CAS, task/attempt i layoutu. Równa liczba próbek nie oznacza zgodnej domeny. Zmiana współczynników i możliwość użycia starego m jako ziarna to odrębna decyzja, nie automatyczny zakaz. |
| A05 | Szybkie `rebuild_live_scene_magnetization` wymaga `fem_mesh`, próbuje tylko obiektowe `preset_texture`, pomija pełną semantykę regionów/assetów, zachowuje stare wektory przy części błędów. Commit wywołuje remap szerzej niż tylko po zmianie m₀. [E04] | Zastąpić skrót wspólną ewaluacją na zgodnej domenie. Zmiana samego materiału nie może bez jawnej akcji resetować wyświetlanego wyniku do m₀. |
| A06 | Szybki zapis m nie przechodzi przez pełną kwalifikację ramki i obsługę zmiany źródła. Istnieją już `publish_prepared_initial_state`, applicator ramki, rewizje ilości i realtime. [E05], [E06], [E34] | Nie wystarcza dopisać `provenance` i ręcznie inkrementować trzy liczniki. Potrzebna pełna tożsamość publikacji i odczyt nowego m przez rzeczywisty endpoint próbek. |
| A07 | Nowa siatka FEM jest publikowana bez zastąpienia starych pól/cache. Budowa pracuje na przechwyconej scenie poza blokadą; sam końcowy kontekst sesji nie zastępuje sprawdzenia aktualności wejścia budowy. [E08] | Atomowo zmienić domenę i zgodne nośniki; odrzucić nieaktualny wynik budowy. Przetestować także zmianę geometrii w trakcie Gmsh i dwie różne topologie o tej samej liczbie węzłów. |
| A08 | `ensure_live_accepted_study_with_transition` waliduje istniejący trwały intent i typed accepted snapshot, lecz jego reuse nie dowodzi zgodności bieżącej sceny ani gotowości właściwej granicy przygotowania. [E09] | Nie redukować diagnozy do „sprawdza tylko is_some”. Dopisać warunki reuse, odwołanie zastąpionego przygotowania i zgodność FDM grid refresh z aktualnym modelem. |
| A09 | `build_stage_execution` i `replace_current_live_stage_execution` projektują bieżący run. Brak zadania może dać Pending. Publiczny zasób ma jeden `run_id`; frontend sprawdza ten zakres. [E16], [E02], [E27] | To luka w widoku ostatnich wyników Study, nie dowód usunięcia artefaktów. Nie scalać rekordów wykonania różnych runów w jeden bieżący `stage_execution`. |
| A10 | PPM przekazuje `contextCommandInputs`, lecz węzły etapów nie zapewniają pełnego targetu. Stage ID bywa zastępowane indeksem; ID i kolejność są edytowalne. Study root i Execution mają różne menu. [E24], [E25], [E23] | Jawny target klikniętego węzła dla enabled/disabled/run/remove; stabilne ID w zatwierdzonej scenie i ochrona rewizji. |
| A11 | Zapis tekstury przez assety/transakcje oraz invalidacja katalogu pól już istnieją; istnieją też przyciski Study i invalidacja domeny przez realtime. [E26], [E23] | Poprawić konkretną ścieżkę danych i brakujące invalidacje zamiast dodawać równoległy transport/rejestr. Nie deklarować, że zapis działa end-to-end, dopóki nie ma dowodu runtime. |
| A12 | `StudyAcceptancePolicy` opisuje Any/Converged/Tolerance/StepLimit, lecz oba accepted workery odrzucają polityki inne niż Any. `StageCompletionIR` zawiera odrębną informację o zbieżności. [E12], [E14], [E15], [E39] | Samo wpisanie Converged do planu nie wdraża bramki. W podstawowym zakresie zachować Any i prezentować prawdziwy wynik; inne polityki odrzucać przed akceptacją do czasu osobnej implementacji ewaluatora. |
| A13 | Python przechwytuje ProblemIR danego etapu, ale setter `MagnetHandle.m` zapisuje tylko wartość, bez zdarzenia przypisania. `physical_step_contract` i walidator accepted source bezwarunkowo wymagają `StepOutput` poprzednika dla kolejnego Run/Relax. Runner następnie kopiuje cały odziedziczony wektor, bez scoped overlay. [E43], [E44], [E13], [E41] | Samo dodanie łańcucha etapów nie wystarcza: jawne `m = uniform(...)` pomiędzy Relax może zostać nadpisane. Zachować zdarzenie, zakres i przypiętą treść inicjalizacji; rozróżnić dziedziczenie, pełny reset i reset obiektu/regionu. Identyczna wartość ponownie przypisana także może oznaczać reset. |

### 1.2. Błędy usunięte z wersji Gemini

1. `RuntimeCommandIntent` jest strukturą, nie enumem z `Solve` i `Stage`. Warianty Run/Relax/Solve znajdują się w `StructuredCommandRequest`. `scene_revision` i `mesh_revision` już istnieją w precondition. [E01]
2. Wybrane kotwice i nazwy były błędne: `studyExplorerNodes.ts` ma 120 linii, nie zakres 323–347; przycisk Study jest w obecnym dużym Inspectorze, nie w cytowanym zakresie 168–176. `StageCompletionIR` jest w `crates/fullmag-ir/src/study.rs`, nie `observables.rs`. [E39]
3. `publish_prepared_initial_state` istnieje, ale rozpoczyna się w L535 odczytanego pliku; jest prywatnym publisherem gotowego read modelu, nie uniwersalnym materializatorem tekstury. Pełna ścieżka FEM wymaga dowodu natywnego przygotowania. [E06]
4. `replace_latest_fields: true` wymaga `field_generation` i czyszczenia preview. Podanie samych flag z poprzedniego planu kończy się `terminal_field_replace_requires_generation`. Nie wolno sfabrykować generacji wyniku solvera dla podglądu m₀. [E07]
5. `client_intent_id` nie zastępuje transportowego `idempotency-key`, który czyta backend. Samo powtórzenie tego pola nie dowodzi odporności na retry ani restart API. [E20]
6. Zmiana domyślnego `None` na „Relax zawsze od m₀” zerwałaby dotychczasowy kontrakt klienta live Python. Nowe UI musi wysyłać politykę jawnie; starsze komendy zachowują zgodne domyślne zachowanie, z naprawą invalidacji po edycji tekstury. [E32], [E36]
7. Nie można bez dodatkowego kontraktu nadać `final_state` każdemu Hysteresis/Eigenmodes/makru. Zakres obowiązkowy to wspierane Run/Relax; inne typy pozostają zgodne z własnymi portami i capabilities. [E12], [E13]
8. Historyczny Relax ma być widoczny jako wynik konkretnego starszego runu. Wklejenie jego Completed do bieżącego runu zafałszowuje postęp, zbieżność i pochodzenie. [E02], [E27]
9. Build Mesh FEM musi nadal działać bez materiałów, magnetyzacji i etapów Study. Brak m₀ nie może zmienić poprawnej budowy geometrii w niepowodzenie meshera. ADR 0074 rozróżnia też ręczną siatkę i przygotowanie solvera; ponowne użycie wymaga dowodu tożsamości. [E35]
10. Aktualne observation frames są ograniczone do aktywnego runu. Nie są gotowym API dowolnej historii; historyczny podgląd potrzebuje przypiętej geometrii i źródła danych historycznych. [E28], [E29]

## 2. Kontrakt produktu

### 2.1. Akcje i stany początkowe

W tym dokumencie m₀ oznacza początkową teksturę Study, a wejście konkretnego etapu może być wynikiem poprzednika lub stanem po jawnej zmianie tekstury. Nie istnieje jedna globalna tekstura, którą wolno nadpisać wszystkie przechwycone wejścia etapów.

| Akcja | Zakres | Domyślne wejście | Po zakończeniu |
|---|---|---|---|
| Study → Uruchom całe Study od początku | Wszystkie włączone, obsługiwane kroki z ich zależnościami | Aktualne m₀ dla pierwszego kroku magnetycznego, dalej jawne porty | Wyniki nowego cyklu; sesja gotowa do dalszej pracy |
| Relax → Uruchom ponownie ten etap | Wyłącznie wskazany Relax | Źródło wynikające z przepływu stanu: aktualny poprzednik albo jawna tekstura przed tym etapem; m₀ tylko na początku łańcucha | Zatrzymanie po tym etapie i ocena wyniku przez użytkownika |
| Run → Uruchom ponownie ten etap | Wyłącznie wskazany Run | Ta sama reguła co Relax: aktualny bezpośredni poprzednik, z uwzględnieniem jawnych zmian tekstury | Zatrzymanie po tym etapie |
| Pierwszy/samodzielny Run lub Relax bez poprzednika | Wyłącznie wskazany etap | Jego jawna tekstura albo początkowe m₀ Study | Jak wyżej; UI pokazuje to źródło przed startem |
| Wybierz stan początkowy… dla etapu | Nie uruchamia solvera | m₀, konkretny wynik etapu albo jawnie ostatni zgodny stan | Wybór przypisany do celu i rewizji; zmiana celu wymaga ponownej walidacji; pełne Study zachowuje start od m₀ |
| Tekstura → Zastosuj | Zapis modelu i przygotowanie podglądu | Kanoniczna tekstura w wybranym zakresie, na właściwej bazie i zgodnej domenie | Widoczny wynik przygotowania albo jawne oczekiwanie/błąd |
| Siatka → Zastosuj i przebuduj | Zapis ustawień i budowa domeny | m₀, jeżeli model magnetyczny jest gotowy | Siatka oraz gotowość m₀ pokazane oddzielnie |
| Siatka → Przebuduj i uruchom Study | Łańcuch jawnych operacji | Jak dla pełnego Study | Start dopiero po udanym zapisie, budowie i przygotowaniu |

Powtórzenie Run po cyklu Relax→Run używa właściwego wyniku Relax, a w sekwencji Relax→Run1→Run2 domyślny Run2 używa właściwego Run1. Tak samo Relax1→Relax2→Relax3 przekazuje wynik kolejno, niezależnie od zmiany algorytmu relaksacji. Nie wybiera się „ostatniego udanego runu” bez związku z grafem. Ponowienie Relax2 uruchamia tylko Relax2 z jego właściwym wejściem; nie wykonuje ponownie Relax1 ani nie resetuje automatycznie do początkowej tekstury.

Wyłączony etap pozostaje wyłączony. Uruchomienie go wymaga jawnego „Włącz” i zatwierdzenia; komenda nie zmienia po cichu authored enabled. Etapy bez jednoznacznego trwałego ID nie są uruchamiane przez zapamiętany indeks: normalizacja nadaje ID i zapisuje je w scenie przed wykonaniem. Zmiana etykiety zachowuje ID i powiązanie historii; reorder również zachowuje ID. UI nie edytuje tożsamości zapisanego etapu przy zwykłym Rename. Jawna zmiana ID/import oznacza nową tożsamość, wymaga transakcyjnej aktualizacji referencji albo odmowy i nie przejmuje automatycznie historii innego ID. Usunięte ID nie jest ponownie nadawane nowemu etapowi. `StageIndex` pozostaje kompatybilnym wejściem dawnych klientów, rozwiązywanym wyłącznie względem przechwyconej rewizji. Historia bez udowodnionego mapowania ID nie jest automatycznie przypisywana według podobnej nazwy lub indeksu.

Pierwszy Compute niezmienionego, przygotowanego całego Study może zwolnić istniejącą bramkę. Retry tej samej operacji zwraca ten sam run. Każde rzeczywiste ponowienie zakończonego wykonania tworzy nowy run; nie ma obowiązku tworzenia nowego runu dla każdego HTTP POST.

### 2.2. Trzy oddzielne informacje o etapie

1. **Bieżące wykonanie:** task/attempt i status w jednym konkretnym runie. Dotychczasowy `/v2/sessions/current/simulation/stages/execution` zachowuje tę semantykę.
2. **Ostatni wynik etapu w Study:** referencja do historycznego runu, kroku, przypadku i artefaktu, z oceną aktualności. Osobny read model nie zmienia statusów bieżącego runu ani procentu jego postępu.
3. **Proponowane wejście następnego uruchomienia:** konkretne źródło lub strukturalny powód niedostępności. Nie musi być to samo, co wynik obecnie oglądany w Viewporcie.

UI może pokazać „Run trwa; wynik Relax z przebiegu 12 jest aktualny”. Nie może sugerować, że Relax wykonano w bieżącym przebiegu zawierającym tylko Run. Historyczny wynik pozostaje wybieralny po odświeżeniu przeglądarki i restarcie API; pamięć poprzedniego snapshotu nie jest źródłem historii.

### 2.3. Aktualność, zgodność przestrzeni i akceptacja naukowa

To trzy odrębne osie. Wynik starego modelu pozostaje niezmiennym wynikiem tego modelu. „Nieaktualny” nie znaczy „uszkodzony”.

| Zmiana | Aktualność wyniku względem modelu | Domyślny wybór / jawne użycie jako ziarna |
|---|---|---|
| Początkowe m₀ albo tekstura/reset przed konkretnym etapem | Zależne wyniki otrzymują przyczynę `initial_state_changed`; reset przed etapem nie zmienia historycznego wejścia wcześniejszych etapów | Nowy jawny reset jest źródłem, a nie cichym fallbackiem do m₀; brak aktualnego wymaganego poprzednika bez resetu blokuje default |
| Współczynniki materiałowe/interakcje | Wyniki i obliczone pola zależne od tych współczynników stają się nieaktualne | Stare m może być jawnym ziarnem; zmiana aktywnej obsady, np. przez Ms, wymaga osobnej kontroli domeny |
| Konfiguracja wyłącznie jednego etapu | Zmiana dotyczy tego kroku i jego rzeczywistych potomków zależności | Wcześniejszy niezależny wynik nadal może być defaultem |
| Wykonanie poprzednika z nowym stanem wyjściowym | Potomkowie porównują przypięte źródło/digest | Stary potomek nie staje się aktualny tylko dlatego, że jego parametry się nie zmieniły |
| Geometria, siatka, warstwy, membership/support | Wynik z innej przestrzeni nie pasuje bezpośrednio | Odrzucenie także przy tej samej liczbie próbek; brak automatycznej interpolacji |
| Nazwa, kolor, widoczność | Bez zmiany fizyki | Brak rebuilda i invalidacji wyników |
| Brak danych historycznych potrzebnych do porównania | `unknown`, nie `current` | Brak automatycznego reuse; jawne ziarno tylko po weryfikacji artefaktu i przestrzeni |

Rewizje sesji służą do optimistic concurrency. Aktualność między runami ustala się z kanonicznych podpisów zależności: wejścia fizyczne, efektywna konfiguracja kroku, profil wykonania istotny dla wyniku, źródło m₀/artefaktu i przestrzeń stanu. Nie porównuje się bezpośrednio liczników rewizji różnych sesji. Globalne `scene.revision` nie może unieważniać niezależnego Relax po edycji Run. Przy wielu zmianach zwracana jest lista przyczyn, nie jeden enum ukrywający pozostałe.

`allow_stale_model` nie omija zgodności przestrzeni, własności artefaktu, kryterium akceptacji ani braku danych wymaganych do kwalifikacji artefaktu i przestrzeni. Brak historycznego podpisu modelu może pozostawić freshness `unknown`, mimo poprawnej kwalifikacji samego ziarna; UI pokazuje tę niepewność i wymaga jawnego wyboru konkretnego wyniku. Używalność ziarna jest oceniana względem konkretnego celu/realizacji, nie jako jeden globalny bool na wynik.

Zbieżność pochodzi z kwalifikowanego `StageCompletionIR`. Brak dowodu to „nieznana”, nie `false` udające zmierzony brak zbieżności. `Succeeded` oznacza zakończenie zadania; `MaxSteps` nie oznacza zbieżności. W obowiązkowym zakresie zachowujemy obsługiwane `Any` i jawnie pokazujemy stop reason. Polityki Converged/Tolerance/StepLimit mają otrzymać odmowę podczas preflight, zanim powstanie wykonywalny run, dopóki nie mają kompletnego ewaluatora. Nie zmieniamy ukradkiem domyślnej polityki pełnego Study. Osobne rozszerzenie tych polityk wymaga noty naukowej, metryk i jednostek, dowodów dla obu workerów oraz bramki zależności w schedulerze; sam frontend ani sam enum nie wystarczą.

### 2.4. Restart, kontynuacja m i Resume

Nowy etap z zapisanym m jest nowym zagadnieniem z warunkami początkowymi. Nie jest bitowo dokładnym wznowieniem integratora. `time_stage.start_time_s`, długość etapu, czas fizyczny/pseudoczas, faza wymuszenia oraz seed RNG pochodzą z przechwyconego planu i są zapisane w provenance; nie są zgadywane z czasu ostatniej klatki. Ponowienie tego samego etapu od tego samego źródła powtarza jego autorską politykę czasu/seedu. Wariant „użyj ostatniego m” zmienia źródło wektora, nie ukradkiem zegar etapu. Istniejące Resume dotyczy tego samego wstrzymanego wykonania i jest dostępne tylko w realizacjach, które je wspierają.

### 2.5. Dziedziczenie oraz jawna zmiana tekstury między etapami

Normatywna reguła jest jednakowa dla Run i Relax. Przy braku jawnego nadpisania wejścia kolejny etap bierze aktualny, kwalifikowany wynik bezpośredniego poprzednika stanu. Zmiana algorytmu relaksacji sama nie resetuje magnetyzacji. Początkowy m₀ jest wejściem pierwszego etapu lub jawnie wybranego restartu od tekstury.

Przykłady przepływu (zapis schematyczny, nie deklaracja publicznej składni API):

```text
m₀ → Relax A → wynik A → Relax B → wynik B → Relax C

m₀ → Relax A → [jawne m = uniform(1,0,0)] → Relax B → wynik B → Relax C
```

W drugim przypadku wejściem B jest zadeklarowana tekstura w swoim zakresie, a C dziedziczy już wynik B. Pełny reset m odcina magnetyczną zależność wejścia B od wyniku A, ale **nie usuwa kolejności wykonania** A przed B w całym Study. Wynik A i jego wejście pozostają w historii. Przy ponawianiu samego B nie wykonuje się A; stosuje się właściwą deklarację inicjalizacji B.

Przypisanie do jednego obiektu lub regionu zmienia tylko ten zakres. Przy dwóch obiektach `body_a.m = uniform(...)` nakłada teksturę na A, a B zachowuje wynik poprzedniego etapu. Jest to recepta: **zweryfikowany stan bazowy + uporządkowane przypisania na kanonicznych maskach/supportach**. Reset częściowy zachowuje zależność od poprzednika dla pozostałego zakresu. Nie wolno ani nadpisać tej tekstury pełnym StepOutput, ani przywrócić autorskiego m₀ na wszystkich pozostałych obiektach. W FEM wspólny węzeł siatki jest jednym stopniem swobody. Jego przynależność rozstrzyga kanoniczna maska planera. Brak kwalifikowanego stanu bazowego wymaga jawnego wyboru innego źródła lub pełnej inicjalizacji; nie pozwala użyć przypadkowej klatki live.

Capture zapisuje **zdarzenie przypisania**, jego kolejność, trwały zakres i immutable odniesienie do tekstury/assetu, nie tylko końcową wartość m. Przykład `uniform X → Relax A → ponownie uniform X → Relax B` wymaga resetu przed B mimo identycznego fingerprintu autorskiej tekstury. Samo przechwycenie niezmienionej wartości bez przypisania oznacza dziedziczenie. Digest służy weryfikacji treści; identyfikator/epoch zdarzenia służy rozróżnieniu zamiaru. Retry jednego zapisu nie tworzy kolejnego zdarzenia, a no-op technicznego PATCH nie jest sztucznym resetem. Jawna akcja ponownego użycia tekstury jest możliwa bez zmiany jej liczbowej wartości.

Niezależne przypisanie w skrypcie zachowuje własną pozycję i zakres. Wyłączenie następującego po nim solverowego etapu nie usuwa tego przypisania z wejścia kolejnego wykonywanego etapu. Capture nie może „zużyć” zdarzenia wyłącznie przez deklarację wyłączonego kroku; rozwiązuje je względem faktycznie wykonywanego przepływu. Wyłączenie całej grupy obejmującej przypisanie wyłącza też tę operację. Zapis z Inspectora trafia do `stage_magnetization_assignments` konkretnego węzła Run lub Relax w `study_pipeline.v2` albo do pola etapu w płaskiej scenie. Na wejściu tego etapu jest stosowany po niezależnych przypisaniach `magnetization_assignments`. Po wyłączeniu etapu zapis pozostaje w jego konfiguracji i wraca po ponownym włączeniu. Normalizacja/import/UI muszą zachować tę różnicę i stable identity, zamiast odtwarzać ją z indeksu.

W UI etap pokazuje „Wejście: wynik etapu A”, „Tekstura ustawiona przed tym etapem” albo „Stan po zmianie tekstury obiektu/regionu”, z możliwością jawnego wyboru. Trwałe ustawienie „Zmień teksturę przed etapem” jest częścią authored Study i zachowuje położenie przy eksporcie/importowaniu. Po ręcznym Apply w edytowalnej sesji UI proponuje **właśnie zastosowany stan** jako jawne wejście następnej ręcznie uruchamianej operacji; przed wysyłką wiąże go z klikniętym Stage i pokazuje źródło. Taki jednorazowy wybór nie dopisuje ukradkiem trwałego resetu w innym miejscu Study. Wybranie całego Study uruchamia jego początkowy stan i zapisane przejścia. Rozdział wyboru podglądu i wejścia solvera nadal obowiązuje.

Zmiana tekstury podczas uruchomionego, immutable Study nie wstrzykuje nowych danych do już zaakceptowanego następnego tasku. Użytkownik zapisuje szkic; zastosowanie korzysta z jawnego Stop/cancel i nowego wykonania zgodnie z §3.5. Zapis z góry w skrypcie między etapami jest częścią zaakceptowanego planu i wykonuje się na właściwej granicy bez ręcznej interwencji.

Aktualność wyniku porównuje efektywną receptę wejścia i jej resolved źródła. Po pełnym resecie zmiana algorytmu wcześniejszego Relax nie unieważnia automatycznie późniejszego wyniku przez nieistniejącą krawędź magnetyzacji; nadal obowiązują wspólne zależności materiałowe, domena i pozostałe jawne porty. Przy częściowym resecie zależność zachowanego zakresu pozostaje. Nieobsługiwana/nieudokumentowana ścieżka przypisania nie może zostać cicho potraktowana jako dziedziczenie.

## 3. Kontrakty techniczne do wdrożenia

### 3.1. Żądanie uruchomienia i zgodność wsteczna

**Projektowane rozszerzenie**, a nie opis istniejących typów:

- `initial_state` jako opcjonalny typowany parametr wariantów Run/Relax/Solve w `StructuredCommandRequest`; przechodzi przez wewnętrzny `SessionCommand`, konwersję `command_from_structured`, walidację, trwały zapis i worker binding. Jeśli implementacja umieści go we wspólnym flattened intent, musi odrzucać go na Stop/Pause/mesh i innych nieodpowiednich komendach.
- Tryby: `default_for_target`, `authored_initial_state`, `stage_result`, `latest_compatible_state`. Nowe UI wysyła tryb jawnie. Brak pola u starszych klientów zachowuje dotychczasowe rozróżnienie Solve versus Run/Relax, z naprawą błędu ignorowania edycji tekstury.
- `solve + target: study` zaczyna pierwszy etap od początkowego m₀ i respektuje wszystkie zadeklarowane przejścia/reset tekstury wewnątrz Study; przyjmuje wyłącznie `default_for_target` i `authored_initial_state`. Nie oznacza to resetu przed każdym Relax. Jawne `stage_result`/`latest_compatible_state` jako globalne nadpisanie całego Solve są odrzucane przed akceptacją. `run/relax + target: stage_id` wykonuje tylko wskazany krok; kind musi zgadzać się z rodzajem kroku. Nowy kontrakt odrzuca `solve + stage_id`; nie interpretuje go jako pełnego Study. Nowe UI używa Run/Relax z StageId.
- `default_for_target` respektuje zapisaną receptę wejścia etapu (§2.5). `authored_initial_state` dla pojedynczego etapu wskazuje konkretne authored/prepared źródło i jego generację: początkową teksturę, reset przypisany do etapu lub ręcznie zastosowany stan. Rodzaj źródła i reference są typowane i walidowane przez serwer; nie wolno rozwiązywać każdego z nich do jednej końcowej sceny skryptu. Dla scoped resetu odpowiedź i provenance zawierają także kwalifikowaną bazę i zakres.
- UI wysyła istniejące `scene_revision`, `mesh_revision` i właściwe region revisions. Serwer sprawdza je pod tą samą granicą przyjęcia co target i wejście. Nieznane, zduplikowane, usunięte lub wyłączone ID zwraca błąd; brak znalezionego StageId nie może uruchomić „jedynego dostępnego” etapu.
- `stage_result` wskazuje konkretny run, krok, case, artefakt i oczekiwany digest z backendowego katalogu wyboru. Backend odczytuje i weryfikuje katalog, manifest, publikację, task/attempt/ownership, codec, port final_state, digest CAS i layout. Klient nie dostarcza zaufania ani ścieżki pliku. Niejednoznaczne wyniki/sweep cases są odrzucane, nie wybierane przez `.first()`.
- Tylko `stage_result` może zawierać jawne `allow_stale_model: true` (domyślnie false), po pokazaniu przyczyn nieaktualności/niepewności konkretnego wyniku. `latest_compatible_state` wybiera wyłącznie wynik aktualny dla modelu i zgodny z celem; nie jest sposobem pominięcia ostrzeżenia o starym modelu. Brak właściwego kandydata daje odmowę, nie fallback do m₀.
- Dla pojedynczego etapu Default poprzednika i Latest są rozwiązywane raz, przed immutable acceptance. W RunIntent pozostaje dokładny `PinnedArtifact`/przypięta recepta oraz requested/resolved source. Retry nie wybiera nowszego artefaktu. W pełnym Study przyszły wynik poprzednika jeszcze nie istnieje: acceptance przypina `StepOutput` i receptę, a scheduler wiąże konkretny kwalifikowany artefakt przed dispatch następcy, zapisując to w trwałym wykonaniu bez mutowania RunIntent. Wynik udanego poprzednika z runu, którego dalszy etap zawiódł, jest dopuszczalny po kwalifikacji tego konkretnego zadania.
- Dostęp do źródła jest ograniczony do autoryzowanego projektu/owner context. Istniejącej kontroli session/epoch nie usuwa się dla wygody. Źródło z innej sesji jest dopuszczalne wyłącznie przez jawne, zweryfikowane wiązanie historycznego wyniku/importu; nie przez dowolny run_id z klienta.

Błędy projektowane: zmieniony target/revision, brak lub nieaktualny poprzednik, niezgodna przestrzeń, niejednoznaczny case, brak/uszkodzenie źródła, unsupported policy/lane. Dokładne kody należy dodać do kontraktu API i klienta, nie traktować nazw z tego dokumentu jako już istniejących.

### 3.2. Widok wyników Study

Projektowany osobny zasób **`GET /v2/sessions/current/simulation/stages/results`** (nowa trasa, wymaga schematu/OpenAPI), oparty na katalogach trwałych runów:

- identyfikuje bieżącą scenę/graf Study, rewizję odpowiedzi i authored stage IDs;
- zwraca bounded/paginowane metadane ostatnich wyników i kandydatów wejścia, z własnym run/step/case/artifact/source identity;
- rozdziela dowód zakończenia, aktualność recepty, porównanie z bieżącym opublikowanym układem magnetyzacji i domyślny wybór. Brak kwalifikowanego układu daje stan „porównanie niedostępne”. Zgodność z domeną wybranego etapu weryfikuje osobno admission;
- nie zawiera ciężkich wektorów ani topologii; linki prowadzą do właścicieli danych;
- nie wkłada historycznych Completed do `StageExecutionResource.stages` i nie zmienia jego `completed_stage_indexes`;
- może korzystać z odbudowywalnego indeksu, lecz autorytetem pozostają manifesty/CAS. Nie skanuje i nie dekoduje wszystkich dużych artefaktów przy każdym status tick;
- zwraca strukturalne dane i kody przyczyn; etykiety i tłumaczenia tworzy frontend.

Dla historycznego podglądu wykorzystać istniejące result context, saved-results oraz persistence/solution-set binding. Jeżeli wynik accepted jest wyłącznie state artefact i nie ma jeszcze zgodnego read API, zadanie T7 musi dodać jawny, projektowo/runowo ograniczony adapter binarnego odczytu wraz z przypiętą domeną. Nie wolno poluzować `active_run_id` w obecnym observation-frames ani podmienić aktywnej sesji, aby obejrzeć historię. Brak tej ścieżki oznacza nieukończone kryterium podglądu i wyboru źródła, a nie zgodę na użycie `/current/data/fields` dla starego runu.

Podgląd zapisanej magnetyzacji przypina projekt, run, krok, przypadek, próbę wykonania oraz identyfikator i skrót artefaktu. Viewport korzysta z projektowej rodziny `study-results` i weryfikuje wspólną domenę geometrii, maski oraz wektorów. Skalary są odczytywane stronicami dla tej samej próby. Wybrany podgląd pozostaje otwarty podczas edycji bieżącego modelu. Powrót do live jest osobną akcją.

### 3.3. Publikacja m₀, zmian tekstury i pól

Wspólny materializator ma przyjąć zatwierdzone wejście fizyczne i **konkretną, zgodną domenę**, wykorzystać istniejącą kanoniczną semantykę assetów/regionów i zwrócić przygotowany kandydat. Nie uruchamia solvera, nie tworzy fikcyjnego ukończonego runu, nie przebudowuje Gmsh przy każdej zmianie tekstury i nie omija natywnego admission FEM. Pełnego `materialize_live_scene_preparation_model_with_fem_evidence` nie należy bezrefleksyjnie wywoływać podczas każdego Apply.

Ten sam evaluator obsługuje receptę resetu z §2.5 na zweryfikowanej bazie: pełna inicjalizacja albo przypisania zakresowe. Preview i wejście solvera stosują tę samą receptę, maskę i przypięte assets. Pełny odziedziczony stan jest wczytywany **przed** nałożeniem resetu zakresowego; późniejszy binding nie może ponownie nadpisać go niezmienionym StepOutput. Stan wynikowy oraz jego pochodzenie są walidowane przed dispatch. To zmiana na tej samej przestrzeni, nie interpolacja między meshami.

FDM zachowuje aktywne maski, orientację i cell positions; multilayer zachowuje natywne siatki, offsety i kolejność warstw; FEM zachowuje właściwy układ DOF/nodes, membership i obsługiwany rząd elementu. Zakres tekstur i formatów wynika z kanonicznych evaluatorów i capabilities; nie dodajemy nowej fizyki przez listę nazw w UI.

Nowa publikacja ma jawny origin przygotowania autorskiego, revision/fingerprint wejścia, przygotowania i przestrzeni oraz kwalifikowaną ramkę/carrier. Sama etykieta provenance nie wystarcza. Applicator i field resolver muszą wspólnie odróżnić ten origin od terminalnej generacji solvera. Należy rozszerzyć typowany kontrakt publikacji przygotowania, zamiast wyłączyć `validate_terminal_field_replacement` lub użyć fałszywego run_id/sequence. Zachować historię terminalnych generacji. Test dowodzi, że m₀ na kroku 0 wygrywa jako świadomie wybrany nowy podgląd ze starym solverowym preview na kroku N; opóźniony callback starego źródła nie może go nadpisać.

Obecne `AcceptedObservationFrameRef::for_snapshot` buduje ID z session epoch, domeny, topologii, kroku i czasu, bez tożsamości kolejnej edycji tekstury. [E34] Dwie różne publikacje m₀ na tej samej domenie przy kroku/czasie 0 muszą mieć rozróżnialną tożsamość źródła także w binary request/cache key. Typowany kontrakt authored publication obejmie generację przygotowania lub fingerprint wejścia; resolver, metadane i cache użyją go spójnie. Nie zmieniać historycznej tożsamości ramek solvera ani fabrykować kroku 1 w celu obejścia kolizji. Test obejmuje pobranie obu różnych tablic przez realny endpoint.

Rewizje są aktualizowane przez istniejący mechanizm zmiany źródła: samples/quantity m przy zmianie nośnika, catalog przy zmianie katalogu/dostępności, topology wyłącznie przy zmianie domeny. No-op/metadata-only nie generuje pełnego rebuilda. Po zmianie m albo współczynników unieważnić zależne H/energie oraz inne obliczone quantities według katalogu, nie tylko ręcznie wymienione dwie nazwy. Historyczne pola pozostają dostępne w swoim kontekście.

Realtime oraz ACK odświeżają rzeczywistą rodzinę zasobów, w szczególności `data/fields/m/samples/vector` i właściwe meta/scoped variants. Nie wprowadzamy nieistniejącego `/data/fields/m` jako zamiennika endpointu próbek. Zachować FieldPublicationBundle, scope, rewizje i odrzucanie starych odpowiedzi; duże tablice pozostają w binary data plane.

### 3.4. Granice transakcji i brak domeny

Inspector wysyła `apply_magnetization` w rodzinie `model/transactions`. Wskazuje jeden obiekt z assetem albo jeden autorski region z `texture_override`, rewizję sceny i klucz operacji. Serwer aktualizuje wskazany cel w kanonicznej scenie. Klient po utracie odpowiedzi powtarza ten sam zamiar i sprawdza klucz, zakres oraz rewizję otrzymanego potwierdzenia.

- Przy Apply tekstury, gdy istnieje zgodna domena: walidacja i kosztowna ewaluacja kandydata poza blokadą; przed publikacją ponowne sprawdzenie epoch, scene/input signature, domain identity, przypiętej bazy oraz braku kolidującego wykonania. Scena i gotowy stan po właściwej pełnej/zakresowej inicjalizacji są zatwierdzane spójnie. Błąd walidacji/ewaluacji odrzuca tę transakcję i zachowuje szkic; nie wolno najpierw zapisać nowej sceny, a potem pozostawić starego m jako aktualnego sukcesu. Zapis samych współczynników na niezmienionej przestrzeni zatwierdza scenę i invalidację zależnych danych, bez przełączania Viewportu na m₀.
- Gdy domeny nie ma lub wymaga przebudowy: poprawna scena może zostać zapisana z jawnym `initial_state_pending` i przyczyną. Dotychczasowe pole nie jest przedstawiane jako jej aktualne m₀. Apply nie udaje startu solvera; UI prowadzi do Build.
- Budowa geometrii i gotowość modelu magnetycznego są oddzielne. Poprawna siatka FEM bez materiału/tekstury nadal jest sukcesem geometrii. Nowa domena jest publikowana bez niezgodnych starych pól; m₀ jest gotowe tylko jeśli jego wymagania są spełnione. Błąd późniejszej materializacji ma własny status, bez zmiany diagnozy meshera i bez utraty zatwierdzonej sceny. Solver pozostaje zablokowany.
- Compute może ponownie użyć manualnej siatki dopiero po udowodnieniu zgodności geometrii, polityk, kolejności i materiałowego supportu. Jeżeli obecna ścieżka musi przygotować siatkę solvera ponownie, pokazuje ten etap i publikuje faktycznie używaną domenę. Brak dowodu reuse nie pozwala użyć starego mesh tylko dlatego, że ma tę samą liczbę węzłów.

### 3.5. Admission, zatrzymanie i idempotencja

| Stan trwałej operacji | Zapis zmian fizycznych / rebuild / nowy start |
|---|---|
| Brak aktywnej pracy lub zakończony run, edytowalny workspace | Dozwolone po normalnej walidacji |
| Niezmienione całe Study, bramka Held i gotowe przygotowanie | Compute zwalnia dokładnie ten run |
| Held, zmieniony model/target/source | Kontrolowane zastąpienie: przygotuj kandydat, trwale anuluj/supersede stare oczekiwanie, potwierdź brak Start, zatwierdź nowe wejście i zaakceptuj właściwy run |
| Queued/Accepted/Dispatched/Preparing/Running/Stopping/Paused lub nieznana własność | Nie przyjmować kolidującej mutacji na podstawie samego braku aktywnego workera. Potrzebne właściwe Stop/cancel i terminalny dowód |
| Closed/imported read-only/disconnected/recovery required | Zachować realne ograniczenia i diagnostykę; bez automatycznego przejęcia, resetu lub nowego Solve |

Draft można edytować podczas obliczeń. Akcja zmieniająca wykonywane wejścia ma jawną etykietę „Zatrzymaj i zastosuj”; sama edycja formularza nie kończy runu. ACK Stop nie jest dowodem zakończenia. Zatrzymanie łańcucha zapisz→build→start anuluje również jego pozostałe kroki.

Supersession musi być trwałą, rekoncyliowalną operacją z ID starego i nowego runu oraz fazami. Zachować istniejące leases, journal, epoch i fence; nie edytować starych RunIntent/CAS ani usuwać wyników. Jeśli worker zdążył przejąć/zwolnić bramkę, wrócić do normalnego cancel, nie deklarować „nieuruchomiony”. Po awarii pomiędzy fazami recovery kontynuuje tę operację, zamiast tworzyć trzeci run. Nigdy nie zwalniać pełnego starego Study w odpowiedzi na kliknięty pojedynczy Stage.

Nowa logiczna operacja ma jeden trwały klucz idempotencji. Klient transportuje go w `idempotency-key`, a `client_intent_id` służy korelacji; powiązanie obu jest jawnie testowane. Replay wymaga tego samego owner context i fingerprintu żądania; ta sama wartość z innym body daje konflikt. Po utracie ACK/restartcie API wynik rozstrzyga durable receipt/journal, nie wyłącznie cache odpowiedzi w RAM. Odświeżenie preconditions nie może po cichu zmienić treści retry tej samej zaakceptowanej operacji.

Dwa niezależne żądania z różnych kart mają osobne klucze; zakaz równoczesnego kolidującego startu zapewniają admission/fence, a nie globalne utożsamianie ich z jednym retry. Późniejsze świadome ponowienie po zakończeniu poprzedniej operacji pozostaje nową legalną operacją.

## 4. Plan wdrożenia i zależności

Nazwy nowych modułów/zasobów są propozycjami architektonicznymi. Pliki istniejące są wskazane poniżej; pliki nowe są oznaczone **NEW**. Jeden właściciel zmian na zadanie. W implementacji niezależne zadania można delegować, ale wspólne pliki schematów, `session.rs` i `main.rs` wymagają sekwencyjnej integracji, nie równoległego nadpisywania.

Kolejność: **T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8**. Po T1 można badać T3 i T4 niezależnie od T2, lecz zmiany publikacji i wspólnych kontraktów scala się przed UI. Każdy krok ma własne testy; T8 nie jest pierwszym testowaniem całości.

### T0. Utrwalić kontrakty i bramki przed zmianą zachowania

**Właściciel:** prowadzący implementację. **Zależności:** brak.

**Pliki:** ten plan; `docs/specs/resource-first-control-room-api-v2.md`; `docs/physics/0925-live-session-magnetization-continuation.md`; `docs/specs/python-live-client-v1.md`; ADR 0074, jeżeli zmienia się kontrakt reuse/przygotowania domeny. Zmiany not naukowych wymagają repozytoryjnego `scientific-documentation-contract`.

- [ ] Przypiąć checkout/worktree, bazowy commit i własność; przejrzeć dryf źródeł od tego audytu. Dla implementacji użyć istniejącej procedury worktree i grupy Docker Compose; nie budować na hoście.
- [ ] Zapisać normatywne decyzje z §2–3: zakres Study/Stage, domyślne dziedziczenie Run/Relax, jawne zmiany tekstury między etapami, UI defaults vs legacy defaults, brak cross-space transferu, trzy osie oceny, Any i jawnie unsupported polityki.
- [ ] Uzgodnić schemat request/source reference, rozdział execution/results i typ publikacji authored m₀, zanim frontend zacznie ich używać.
- [ ] Utrwalić kontrakt zdarzeń i recept inicjalizacji: inherit, pełny reset, scoped reset; przypięte expression/assets, zakres i kolejność; początek Study vs granica etapu vs jednorazowe ręczne wejście. Jawne przypisanie identycznej wartości i odczyt wartości bez przypisania muszą dawać różne skutki semantyczne.
- [ ] Wybrać małe deterministyczne fixture'y Relax→Run, trzy Relax różnymi algorytmami, Relax→jawna tekstura→Relax, Run-only, dwa obiekty/regiony, multilayer i FEM oraz oczekiwane punkty odczytu. Określić legalne CPU/GPU/profile bez ukrytych fallbacków.

**Odbiór:** kontrakt opisuje każde domyślne zachowanie i błąd; żadne nowe capability nie jest deklarowane na podstawie samego planu.

### T1. Typowane API, target i transport wyboru stanu

**Właściciel:** backend API + klient typowany. **Zależności:** T0.

**Pliki:** `crates/fullmag-api/src/schemas/commands.rs`, `types.rs`, `router_v2/handlers/simulation/commands.rs`, `openapi_v2.rs`; `apps/control-room/src/kernel/api/apiTypes.ts`, `ControlRoomApi.ts`, `kernel/runtime/studyRuntimeCommandAdapters.ts`; generator `apps/control-room/scripts/generate-v2-client.mjs` i jego istniejące artefakty pod `kernel/api/generated/`.

- [ ] Dodać `initial_state` bez nieistniejących wariantów RuntimeCommandIntent; przeprowadzić pole przez cały transport do SessionCommand/RunIntent.
- [ ] Typować authored source/reference oraz podstawę, zakres i tożsamość recepty z §2.5. Preflight zwraca wybrane wejście, nie tylko ogólne `authored_initial_state`; brak wymaganej bazy scoped resetu daje czytelny błąd.
- [ ] Zachować dawne żądania; UI wymaga jawnego mode, StageId i istniejących preconditions. Unsupported kombinacje kind/target/policy odrzucać przed publikacją trwałego runu.
- [ ] Naprawić brak/zmianę ID i niezgodność rodzaju; nie używać fallbacku do innego jedynego etapu przy błędnym StageId.
- [ ] Zdefiniować błędy strukturalne i odpowiedź z resolved source/operation identity. Statusy HTTP, schema i klient muszą się zgadzać.
- [ ] Zachować osobno requested Stage/Study i resolved run/step w recepcie, journalu i command detail. Obecne zastąpienie `command.target` przez Run służy wiązaniu accepted wykonania; nie usuwać tego wiązania, lecz nie tracić pierwotnego celu. Potwierdzenie i szczegóły komendy udostępniają `execution_binding` z `requested_target`, `run_id` i opcjonalnym `step_id`. Pole `step_id` identyfikuje etap w uruchomieniu pojedynczego kroku. Odczyt po przełączeniu przebiegu korzysta z dziennika sesji lub z RunIntent należącego do tej komendy.
- [ ] Regenerować OpenAPI/types/transport/paths właściwą receptą; nie edytować wygenerowanych plików ręcznie. Zaktualizować facade i adaptery, nie wywołania fetch w komponentach.
- [ ] UI udostępnia nowe akcje tylko przy odpowiadających im możliwościach backendu. Nieznana/nieobsługiwana polityka nie degraduje klikniętego Stage do starego Solve. Utrzymać odczyt starych zapisów bez nowych pól; nie przepisywać hurtowo historycznych manifestów ani przypisywać im domyślnego `current`.

**Testy:** round-trip wszystkich nowych trybów; brak pola legacy; source na Stop/mesh; nieznany/wyłączony/zmieniony target; optimistic conflict; `solve + stage_id`; identyczny target PPM/Inspector; snapshot kontraktu i generacja bez driftu.

### T2. Zweryfikowane źródła, aktualność i historia Study

**Właściciel:** backend read model / accepted artifacts. **Zależności:** T1.

**Pliki:** `live_accepted_continuation.rs`, `live_accepted_projection.rs`, `schemas/runtime.rs`, `router_v2/handlers/simulation/runtime.rs`, `router_v2/mod.rs`, `openapi_v2.rs`; `crates/fullmag-authoring/src/region_revisions.rs`; **NEW** mały moduł resolvera wyników i freshness w `crates/fullmag-api/src/` oraz testy. Kod katalogów w `fullmag-session`/`fullmag-runtime-control` tylko gdy istniejące odczyty nie wystarczają.

- [ ] Zastąpić ograniczenie „jedno succeeded task” wyborem konkretnego task/step/case z manifestu. Zweryfikować attempt/ownership, publikację, digest, codec i dokładną przestrzeń.
- [ ] Wybierać poprzednika według grafu i zgodnych podpisów jego zależności. Nie preferować samej daty runu ani ogólnej scene revision. Wieloznaczne historie i brak metadanych dają jawny stan niedostępności.
- [ ] Oceniać źródło z uwzględnieniem resetu: pełny reset nie wymaga magnetycznego artefaktu poprzednika; częściowy zachowuje przypiętą bazę poza maską. W ręcznym Apply baza jest kwalifikowana względem przechwyconego stanu przed tą mutacją, a dozwolona zmiana zakresowa jest jawnie zapisana w recepcie. Nie odrzucać jej tylko przez zamierzoną zmianę tekstury ani nie pomijać niezwiązanych zmian materiałów/domeny. Freshness późniejszych wyników uwzględnia rzeczywiste krawędzie recepty.
- [ ] Obsłużyć udany poprzednik z runu zakończonego późniejszym błędem; nie używać dowolnej ostatniej klatki przerwanego solvera jako final_state.
- [ ] Zrealizować osobny zasób §3.2, odbudowywalny z trwałych danych, z bounded zapytaniami i strukturalnymi przyczynami. Invalidacja następuje po zmianie modelu, grafu, źródła i wyniku.
- [ ] Zachować zakres jednego run_id w StageExecutionResource. Nie kopiować historycznych rekordów do stage_execution i nie kasować historii przy zmianie źródła bieżącego Viewportu.
- [ ] Rozdzielić bieżący bufor skalarów i trwałe serie według run/step/case/attempt/source. Obecne wyczyszczenie bufora przy malejącym `row.step` oraz zastąpienie ostatniego wiersza o równym step nie dowodzą usunięcia trwałej historii. Nie naprawiać tego przez proste dopisywanie wszystkich wierszy do jednego bufora. Przejście A:step0 → B:step0 i A:stepN → B:step0 ma zmienić tożsamość serii i pozostawić historyczną A dostępną.
- [ ] Rozwiązać Default/Latest pojedynczego etapu do pinu przed akceptacją; dla całego Study przyszłe StepOutput wiąże scheduler zgodnie z przypiętym grafem. Źródło z UI musi odpowiadać zwróconej/przyjętej tożsamości. Uszkodzony/brakujący/obcy wymagany artefakt nie jest fallbackiem do m₀.

**Testy:** multiple tasks/cases, partial failed Study, obcy owner/epoch, stary attempt, digest mismatch, brak CAS, wycofany artefakt, niezależna zmiana Run, ponowiony poprzednik, nieznana historyczna sygnatura, odbudowa po restarcie API, dwa meshe o tym samym N. Test pokazuje osobno nowy current run i historyczny Relax.

### T3. Kompilacja pełnego Study i pojedynczego kroku

**Właściciel:** authoring/application/runtime. **Zależności:** T1–T2.

**Pliki:** `crates/fullmag-authoring/src/scene_study_plan.rs`, `scene_study_plan_tests.rs`, `study_contract.rs`, `scene.rs`, `builder.rs`; `crates/fullmag-application/src/script_stage_contract.rs`, `script_pipeline_compilation.rs`, `script_pipeline_acceptance.rs`, `script_stage_materialization.rs`, `study_execution_materialization.rs`; `packages/fullmag-py/src/fullmag/world.py`, `model/structure.py`, `runtime/scene_document_ir.py`, `runtime/run_config_export.py`, `live/_hooks.py`, `live/_scene.py`, `live/_session.py` i właściwe testy capture/Study/live; `crates/fullmag-api/src/script.rs`, `live_accepted_execution.rs`, `accepted_study_worker.rs`, `accepted_fem_study_worker.rs`; `crates/fullmag-runtime-control/src/study.rs`, `scheduler.rs` oraz `crates/fullmag-runner/src/lib.rs` w zakresie wiązania stanu i recepty.

- [ ] Zwykłe zależności wymagają co najmniej v3; zachować konstrukcje v4 i odczyt istniejących v1/v2/v3/v4. Nowe pole/recepta resetu i rozszerzony capture muszą dostać jawnie wersjonowany kontrakt oraz zgodną walidację source/canonical hashing. Nie wkładać nowych obowiązkowych danych do starego strict schema ani nie przepisywać historycznych RunIntent. Zakresowy reset ma opcjonalną receptę `fullmag.scoped-initial-state-overlay.v1` w StudyPlan v3/v4. Jej podstawa jest pojedynczym wymaganym portem stanu, a wektory tekstury pochodzą z zaakceptowanego planu etapu.
- [ ] Budować kolejność wszystkich wykonywalnych, włączonych kroków i oddzielny przepływ stanu między obsługiwanymi konsumentami/producentami. Nie deklarować final_state dla arbitralnych typów. Grupowanie i konfiguracje wpływające na ProblemIR zachowują znaczenie.
- [ ] Rozszerzyć wspierane settery tekstury/capture o zdarzenia przypisania z trwałym object/region scope i kolejnością. CapturedStage zachowuje je na granicy kolejnego etapu wraz z przypiętą treścią, zamiast wnioskować wyłącznie z różnicy ProblemIR. Odczyt bez przypisania dziedziczy; powtórne jawne przypisanie identycznej wartości resetuje. Dla legacy capture bez takich danych nie fabrykować dowodu intencji; zachować wersję i wymagać ponownego capture dla nowej gwarancji.
- [ ] Odłączyć mutowalne wartości `ObjectRegion` przy capture (owned copy albo kanoniczna immutable reprezentacja), zamiast zachować te same obiekty wewnątrz skopiowanej krotki. Późniejsza edycja tekstury/regionu nie może zmienić wejścia wcześniej przechwyconego etapu. Samo `dataclasses.replace` bez kontroli zagnieżdżonych referencji nie stanowi dowodu izolacji.
- [ ] Przeprowadzić reset event również przez `fullmag.live`: hooki i `plan_transactions` muszą wysłać jawną operację mimo równego authored diffu. Brak hooka regionu może tylko odroczyć zwykły sync do następnego submit, dlatego test sprawdza osobno natychmiastowy podgląd i wejście solvera. Zagnieżdżone settery i transport retry zachowują jeden logiczny intent oraz właściciela i zakres; nie generują kilku resetów.
- [ ] Rozstrzygać wynik oczekującego Apply przed następnym poleceniem `fullmag.live`. Po utracie ACK ponawiać tę samą operację z tym samym kluczem. `magnetization_apply_scene_advanced` oznacza zapis w starszej rewizji i wymaga uzgodnienia bieżącej sceny oraz jawnego rozwiązania konfliktu z lokalnymi zmianami. Ponowny sync ma wyjść z oczekiwania po rozstrzygnięciu wyniku i chronić nowszą scenę przed nadpisaniem pełnym lokalnym snapshotem. Odróżniać tę odpowiedź od przejściowej blokady wejścia. Zob. S45.
- [ ] Zmienić razem `physical_step_contract`, jego walidator source oraz materializację wejścia. Dla inherit użyć StepOutput; dla pełnego resetu użyć właściwej authored inicjalizacji tego etapu; dla resetu zakresowego zachować bazę StepOutput i nałożyć przypięte operacje po jej wczytaniu. Nie osłabiać walidatora do „dowolne inputs”; ma sprawdzać dokładnie przechwyconą receptę. Kolejność wykonania pozostaje niezależna od krawędzi m.
- [ ] Pełny Study startuje z autorskiego stanu pierwszego etapu zawartego w jego kanonicznym ProblemIR/planie i respektuje późniejsze przypisania. Wariant `AuthoredInitialState` wymaga prawidłowego `reference`; jego znaczenie musi być walidowane przez katalog/binding, nie wymyśloną referencją tekstową do globalnego m₀. Per-stage capture nie może zostać zastąpiony wyłącznie końcową sceną skryptu.
- [ ] Pojedynczy Run/Relax wykonuje tylko wskazany krok. Polityka `initial_state` wiąże port magnetyzacji według §2.5, jednakowo dla obu rodzajów: domyślnie pin aktualnego poprzednika, jawna inicjalizacja/zmiana tekstury, jeśli występuje, albo m₀ na początku łańcucha. Pozostałe wymagane wejścia od niewykonywanego poprzednika muszą otrzymać zweryfikowany pin albo spowodować odmowę. Nie wystarczy wyczyścić completion_dependencies i pozostawić wiszące StepOutput; nie wolno usuwać wymaganych wejść innych niż m.
- [ ] W `prepare_live_accepted` dokonać kwalifikacji źródeł i przebudowy grafu pojedynczego etapu **przed pierwszym** `study.validate_for_execution()`. Obecny kod wyłącza poprzedników i waliduje znacznie wcześniej niż deklaruje pin. Walidator musi odrzucać wymagany StepOutput od wyłączonego kroku, jeżeli nie został zastąpiony legalnym źródłem; nie wystarczy kontrola samych completion_dependencies.
- [ ] Uzgodnić `scheduler::inputs_are_automatically_resolvable`, `resolve_accepted_study_inputs`, `validate_study_input_dependencies` oraz materializację workera dla wymaganego `AuthoredInitialState`. Sam wyjątek w workerze nie wystarcza: scheduler i walidacja resolved inputs muszą uznawać tylko authored źródło związane z właściwym przechwyconym ProblemIR/receptą. Brak lub obce reference nadal blokuje start. Scoped overlay to jedna recepta na bazowym stanie, nie dołożenie drugiego konkurencyjnego portu magnetyzacji.
- [ ] Nowe requested/resolved source, scope i provenance przeprowadzić przez ścisłe allow-listy accepted parametrów i walidację source. Nie dopisywać kluczy wyłącznie do RunIntent ani nie wyłączać walidacji nieznanych pól; ująć wersję, binding i oba workery.
- [ ] Przygotowanie ProblemIR zachowuje efektywne ustawienia wybranego etapu, w tym konfigurację ze skryptu przed nim; nie wykonuje wcześniejszych solverów jako skutku ubocznego capture.
- [ ] Osobno zweryfikować ścieżkę Scene pipeline, która eksportuje `stages=()` i materializuje payload na bazowym IR. W LLG Relax zachować obsługiwane `relax_alpha`, `max_error/max_err`, `dt_initial`, `dt_min`, `dt_max`, `adaptive_timestep`, integrator i fixed timestep zgodnie z kanonicznymi nazwami/priorytetami. Parametry niedozwolone dla wybranego algorytmu dają odmowę zamiast ignorowania; direct minimizer nie otrzymuje bezwarunkowo ustawień LLG. Test porównuje wartości po materializacji, nie tylko JSON payload.
- [ ] Rozdzielić wykonanie jawnych Python snapshots od rekonstrukcji Scene pipeline. Obecny `validate_physical_snapshot_coverage` odrzuca nieobsługiwane mieszanki z helperami; nie usuwać tego guardu bez zastępczego kontraktu. Wspierane kroki pomocnicze zachowują wejścia i reset eventy, a nieobsługiwana kombinacja kończy się odmową przed akceptacją. Edycja parametrów primitive w UI musi nałożyć zweryfikowaną zmianę na właściwe wejście etapu; nie może utracić jego tekstur przez odtworzenie wszystkich kroków z końcowej sceny skryptu.
- [ ] Nie wybierać resetu na podstawie rodzaju Relax ani zmiany jego algorytmu. Jawne ustawienie tekstury między etapami ma pierwszeństwo przed dziedziczeniem w swoim zakresie. Legacy Run/Relax zachowują kontynuację według naprawionego kontraktu, w tym respektują jawne przypisania tekstury, również tej samej wartości.
- [ ] Utrzymać Any; preflight odrzuca polityki bez ewaluatora przed trwałą akceptacją, a worker zachowuje ostatnią obronę. Prezentować nieznane/nonconverged completion bez fabrykowania dowodu. Rozszerzenie obsługi Converged/Tolerance/StepLimit jest odrębne od tej naprawy UI.
- [ ] Zapisać requested i resolved source, zegary i seedy w provenance; eksport UI→Python→IR zachowuje konfigurację i wskazuje wymagane immutable assets. Eksport ze SceneDocument odtwarza również jawne przypisania w ich kolejności po trwałych ID obiektu i regionu. Konwersja zachowuje identyczne ponowne przypisanie oraz semantykę wyłączonego etapu i grupy z §2.5.

**Testy:** Relax→Run, Relax→Run1→Run2, trzy Relax różnymi algorytmami, Relax→jawna tekstura→Relax→Relax, identyczna tekstura ponownie przypisana, dwa obiekty i reset jednego/regionu, Run-only, drugi Relax z dziedziczeniem lub resetem oraz osobnym wymaganym portem, skipped step/group, reorder resetu, pomocniczy krok pomiędzy etapami, jawne inne porty, nieobsługiwany Hysteresis/macro restart, legacy capture/read, non-Any fail-before-acceptance, zgodność stanu na granicy etapów, brak przypadkowego wykonania poprzednika, regresje klienta live Python. Nie wystarczy snapshot JSON: test odczytuje rzeczywiste wejściowe wektory po bindingu.

### T4. Lifecycle, zastępowanie oczekującego przygotowania i retry

**Właściciel:** runtime admission / trwałe operacje. **Zależności:** T1, T3.

**Pliki:** `session.rs`, `live_execution_binding.rs`, `live_accepted_execution.rs`, `live_accepted_projection.rs`, `router_v2/handlers/simulation/commands.rs`, `simulation/runtime.rs`, `simulation/remesh_admission.rs`, `run_intent_persistence.rs`; właściwe istniejące moduły gate/cancellation/journal w `fullmag-runtime-control` i `fullmag-session`.

- [ ] Ujednolicić readiness i kontrolki według §3.5. Startup auto-run i wait_for_solve w edytowalnym workspace po zakończeniu pozwalają pracować dalej; wynik runu pozostaje terminalny. Nie zmieniać kontraktu zakończenia headless batch ani imported/closed sesji.
- [ ] Uzgodnić katalog readiness i wykrywanie aktywnych komend w `simulation/runtime.rs`: obecne listy obejmują Solve, ale pomijają Run/Relax, mimo szerszego zbioru w remesh admission. Nowe akcje Stage mają te same zabezpieczenia zajętości i właściwe powody odmowy. Nie zastępować terminalnej historii wykonania sztucznym Running/AwaitingCommand tylko po to, aby odblokować workspace.
- [ ] Nie wyprowadzać gotowości wyłącznie z braku workera albo statusu UI. Uwzględnić trwały gate, task claim, ledger, przygotowanie, pause/stop oraz recovery.
- [ ] Dodać kontrolowaną supersession Held. Zmieniona scena, inny target albo inne źródło nie zwalniają starego intentu. Nieuzgodniony cancellation/release race blokuje dalszą część operacji.
- [ ] Po Stop/cancel zachować terminalny dowód i wejścia starego runu. Przed rebuild/restart czekać na rzeczywiste zakończenie i zwolnienie właściwego ownera, nie tylko ACK.
- [ ] Powiązać nagłówek idempotency-key, client_intent_id, fingerprint żądania i wynik w trwałej rekoncyliacji. Unknown outcome po timeoutcie najpierw sprawdza istniejącą operację. Nie przechodzić na nowy ID w ślepym retry.
- [ ] Replay istniejącego receiptu rozwiązywać po kontroli dostępu, owner/session/epoch i zgodności kanonicznego żądania, lecz przed ponownym sprawdzaniem zmiennej gotowości do **nowego** startu. Inaczej utracony ACK zakończonej operacji może zmienić się w odmowę admission. Nie przesuwać obecnego RAM cache przed kontrolę tożsamości ani nie zwracać wyniku innego payloadu tylko z powodu zgodnego nagłówka. Odczyt receiptu nie wykonuje ponownie mutacji.
- [ ] Zapewnić działanie po restartach pomiędzy cancel, commit sceny, commit RunIntent, start i ACK. Nie restartować automatycznie solvera przy zwykłym odczycie/recovery.

**Testy:** wszystkie wiersze §3.5, pojedynczy Stage na Held whole Study, Stop kontra Start claim, dwa kliki/karty, zmiana body przy tym samym kluczu, awaria po trwałej akceptacji przed ACK, odtworzenie idempotencji po restarcie, brak duplikatu runu i brak usunięcia historii.

### T5. Kanoniczne stany początkowe oraz kwalifikowana publikacja authoringu

**Właściciel:** materializacja i data plane. **Zależności:** T1, T4.

**Pliki:** `main.rs` (tylko delegacja z commitu), `live_scene_preparation.rs`, `session.rs`, `schemas/common.rs`, `router_v2/handlers/data/fields.rs`, `router_v2/handlers/data/field_resolution.rs`; kanoniczni właściciele w `fullmag-application/src/preparation.rs` i istniejących evaluatorach `fullmag-plan`; **NEW** mały moduł `live_authored_initial_state.rs` zamiast dalszego powiększania main. `authoringMutationInvalidation.ts` i `RealtimeInvalidationBridge.ts` w zakresie danych.

- [ ] Wyodrębnić ewaluację wykorzystującą właściwą domenę/asset semantics; zachować maski, region precedence, transforms, frozen-spin/active support i układy multilayer. Nie wprowadzać drugiego parsera tekstur ani cichego fallbacku do uniform.
- [ ] Użyć tej samej recepty pełnego/zakresowego resetu dla Apply preview i solver input. Zachować m nieedytowanych obiektów/regionów z kwalifikowanej bazy. Zapisać źródło bazy, reset event i assets, aby reload/retry nie zmienił wejścia. Przy braku bazy udostępnić jawny wybór źródła zamiast zachowywać niekwalifikowane latest_fields.
- [ ] Zastosować transakcje §3.4. Ciężkie obliczenia poza blokadą, publish po sprawdzeniu przechwyconego wejścia. Brak/stara domena daje jawny pending; błąd ewaluacji na zgodnej domenie nie publikuje połowicznego sukcesu.
- [ ] Wprowadzić właściwy origin/generację przygotowania i kwalifikację m₀, z rozróżnieniem kolejnych publikacji step0 także w tożsamości ramki/kluczu binarnego cache (§3.3); zachować terminal generation guards i history. Spójna publikacja aktualizuje samples, cache, catalog availability i scoped binary responses przez istniejących właścicieli.
- [ ] Obsłużyć authored/prepared bundle bez fizycznego wiersza skalarnego. Obecne `refresh_accepted_field_publication_bundles` wymaga pasującej observation frame w `scalar_rows`; nowy origin przygotowania potrzebuje własnej kwalifikacji carrier/domain. Nie tworzyć fikcyjnej energii ani solverowego step0, nie usuwać wymaganej korelacji dla rzeczywistych obserwacji solvera. Sprawdzić katalog, meta i binarne próbki przy pustym `scalar_rows` oraz przy wierszach wyłącznie starego źródła.
- [ ] Nie resetować m po zmianie samej nazwy, display lub współczynników, o ile zmiana nie wpływa na przestrzeń/support. Oznaczać zależne wyniki/pola jako nieaktualne; rodzaj Relax nie zastępuje wyboru wejścia według §2.5. Zmiana aktywnej obsady lub realizacji wymaga osobnej kwalifikacji domeny i nie może pozostawić niezgodnych live pointers.
- [ ] Po zmianie m unieważnić pochodne quantities i skalarne widoki live, zachowując historyczne serie. Zweryfikować brak mieszania m₀ z energią starego runu.
- [ ] Uzupełnić dokładne invalidacje próbek/meta/scope bez podwójnych subskrypcji i pełnego odświeżania topologii przy texture-only Apply.

**Testy:** PATCH/transakcja→evaluator→publikacja→GET binary m→dekodowane wartości; wszystkie wspierane rodzaje assetów i błędy pliku, multi-object/region/transforms, FEM/FDM/multilayer, dwukrotne Apply step0 na tej samej domenie, stare preview stepN, opóźniona projekcja starego runu, no-op, material-only, failure przed commitem, pending mesh, brak sztucznego solver step/scalar.

### T6. Spójne Build Mesh / Build Grid i gotowość Compute

**Właściciel:** przygotowanie domeny. **Zależności:** T4–T5.

**Pliki:** `live_geometry_mesh_build.rs`, `live_scene_preparation.rs`, `live_accepted_execution.rs`, `router_v2/handlers/simulation/commands.rs`, `simulation/remesh_admission.rs`, `session.rs`; `router_v2/handlers/model/readiness.rs`, `model/authoring.rs`, `meshing/mesh.rs` i `main.rs` w zakresie wspólnej tożsamości domeny; `geometryLifecycleCommandContributions.ts`, `meshExplorerNodes.ts` oraz właściwe meshing resources/readiness.

- [ ] Przygotować domenę z aktualnych ustawień; przechwycić podpis geometrii/polityk i tożsamość operacji. Przed publikacją sprawdzić aktualność i cancellation. Spóźniony build innej sceny nie zastępuje obecnej domeny.
- [ ] Opublikować domenę, membership i zgodne nośniki spójnie; usunąć niezgodne live pointers, nie historyczne dane. Użyć kontraktu authored publication z T5, nie terminal replace bez generation.
- [ ] Zachować geometry-only FEM zgodnie z ADR 0074. MeshReady i InitialStateReady to oddzielne fakty. Bez gotowego modelu magnetycznego nie tworzyć fikcyjnego m ani nie uruchamiać solvera.
- [ ] Dla FDM grid refresh sprawdzać źródło/gate/frontier intentu. Nowa dyskretyzacja wymaga nowego przygotowania; completed run nie jest planned frontier. Jeżeli istniejąca ścieżka FDM wymaga accepted runu do przygotowania, jego bramka pozostaje Held i żaden task obliczeniowy nie jest uruchamiany przed Compute; przygotowanie nie jest prezentowane jako wynik solvera. To odrębny przypadek od geometry-only FEM, które nie tworzy RunIntent. Reuse i zastąpienie takiego przygotowania podlegają T4 oraz tym samym testom retry/cancel.
- [ ] Reuse manualnego mesha lub planu wyłącznie z dowodem tożsamości; w przeciwnym razie widoczne przygotowanie solvera z aktualnych polityk i publikacja użytej domeny. Nie rozluźniać exact-layout guard.
- [ ] Uzgodnić freshness siatki w backendowym model/readiness, mesh provenance, admission i frontendowym resolverze. Nie opierać wszystkich odczytów na równości globalnego `scene.revision`. Rozróżnić geometrię/topologię, membership/support i współczynniki: samo Ms/alpha lub tekstura nie musi wymagać Gmsh, ale zmiana materiału może zmienić aktywną obsadę/realizację. Samo usunięcie `material_ref` z podpisu albo `mesh:dirty` nie dowodzi reuse. `scene_mesh_signature` też obecnie zawiera `material_ref`; nowy wspólny kontrakt musi zweryfikować rzeczywisty wpływ zmiany.
- [ ] Utrzymać spójność danych domeny: meta/topology, FDM grid, native multilayer layout, membership, pola i ich scoped variants. Materiał/tekstura bez zmian przestrzeni nie powoduje niepotrzebnego Gmsh.
- [ ] Błąd builda albo przygotowania zatrzymuje łańcuch przed Solve, pozostawia scenę/draft i historię z jasnym wynikiem częściowym. Retry wraca do właściwej fazy.

**Testy:** rebuild po completed/failed/cancelled, bez materiałów/Study w FEM, zmiana cell size/layer offsets, to samo N a inna topologia, zmiana sceny podczas builda, Stop i opóźniony receipt, błąd meshera vs błąd m₀, reuse exact signature, stary accepted FDM intent, brak ponownego Solve po timeoutcie.

### T7. Explorer, Inspectory, historia i sekwencje użytkownika

**Właściciel:** frontend, z backendem dla brakującego historycznego odczytu. **Zależności:** T2–T6.

**Pliki:** `ExplorerTreeView.tsx`, `modules/explorer/builders/study/studyExplorerNodes.ts`, `studyStageCommon.ts`, `builders/meshExplorerNodes.ts`, `builders/objectExplorerNodes.ts`; `StudyInspectorPanel.tsx`, `StudyStageDraftEditor.tsx`, `stages/StageInspectorFrame.tsx`, `stages/RelaxStageInspector.tsx`, `stages/RunStageInspector.tsx`, `ObjectMagneticTexturePanel.tsx`, `region/ObjectRegionTexturePanel.tsx`, `ObjectMaterialPanel.tsx`, `MeshDetailsPanel.tsx`, `airbox/AirboxMeshBuildPanel.tsx`, `fdm-grid/FdmGridInspectorPanel.tsx`; `studyRuntimeCommandContributions.ts`, `studyRuntimeCommandAdapters.ts`, `geometryLifecycleCommandContributions.ts`, `kernel/resources/studyRuntimeResources.ts`, `kernel/authoring/authoringMutationInvalidation.ts`; `explorerStore.ts`, `ResultContextSelector.tsx`, `kernel/saved-results/`, `kernel/resources/savedResultsPlaybackResources.ts`. Historyczny backend: `handlers/data/observation_frames.rs` jako granica active-run; istniejący `handlers/persistence/solutions/` i kwalifikowany adapter opisany w §3.2.

- [ ] Jeden rejestr komend: Study whole, Stage only, wybór wejścia, build oraz build+Study. Disabled reason i execute używają tego samego targetu. Nie zakładać istnienia `node.selection.ref`; odczytać aktualny typ węzła i przekazać jego stageId/objectId/regionId w typed inputs.
- [ ] Zapewnić Explorerowi rzeczywiste zasoby potrzebne do oceny PPM. Obecne `includeSharedDomainReadiness: false` i `includeStageExecution: false` dają null również przy istniejącym cache. Włączyć potrzebne współdzielone odczyty lub jawny dostęp do nich na poziomie właściciela menu, bez osobnego pollingu każdego węzła. Zachować legalną ścieżkę backendowego readiness postprocessingu po terminalnym runie; brak lokalnego manifestu nie dowodzi zawsze niedostępności takiej komendy.
- [ ] Kliknięty węzeł ma pierwszeństwo przed globalnym selectedEntity. PPM nie musi zmieniać zaznaczenia. Także Remove działa na wskazanym etapie. Rozdzielić trwałe enable/disable od runtime Skip aktywnego kroku.
- [ ] Inspector pokazuje bieżące wykonanie, osobny ostatni wynik/freshness i źródło następnego startu. Nie wysyła arbitralnego Hysteresis/makra do handlera Run/Relax; unsupported ma czytelny powód.
- [ ] Udostępnić dziedziczenie oraz „Zmień teksturę przed tym etapem” z zakresem. Pokazać przejście między etapami, zachować je w zapisanym Study i eksporcie. Ręczny Apply proponuje jawne prepared źródło następnej wybranej operacji zgodnie z §2.5; zmiana algorytmu Relax nie wybiera resetu. Zmiana kolejności/disable nie przenosi przypisania przez przypadkowy indeks ani nie stosuje go do innego etapu.
- [ ] Zapis trwałej zmiany tekstury z Inspectora musi kodować powiązanie z ID wybranego etapu. Istniejące `magnetization_assignments` z capture mają semantykę niezależnej operacji i przechodzą na kolejny włączony etap. Zachować oba znaczenia w materializacji Rust i w obie strony konwersji Python, a dla płaskiej sceny udostępnić zapis dopiero wraz z poprawnym bindingiem tej reprezentacji. Zob. S46.
- [ ] Sekcja wykonawcza Stage musi działać również dla `pipelineNodeId`, poza fieldsetem blokującym dotychczasowy flat editor. Dla obsługiwanych Primitive Run/Relax zapewnić zapis po stable `pipelineNodeId` do właściwego payloadu; zachować grupy, kolejność, nieedytowane i nieznane pola zgodnej wersji oraz mapowanie capture. Właścicielem zapisu jest również `StudyStageAuthoringModel.ts`, który obecnie odrzuca pipeline w flat serializerze. Samo zdjęcie `disabled` albo spłaszczenie pipeline nie jest implementacją. Makra i nieobsługiwane schematy zachowują jawną granicę możliwości.
- [ ] Zapis aktywnego szkicu przed startem wymaga sukcesu ACK, aktualnego targetu i nowych preconditions. Niezapisane szkice innych paneli nie są automatycznie gubione ani ukradkiem zapisywane: wspólny dirty-state guard wskazuje Apply/Discard przed startem. Błąd zatrzymuje łańcuch, zachowuje szkice i nie uruchamia starej konfiguracji.
- [ ] Po zatwierdzeniu szkicu przypiąć scene/mesh revision, Stage ID i source identity odpowiadające temu zapisowi. Asynchroniczne odświeżenie statusu/ledgeru nie może zastąpić ich nowszym modelem, który pojawił się między kliknięciem a submit. Nie usuwać mechanicznie całego refreshu dynamicznych kontrolek: odróżnić odświeżenie dostępności od zmiany zamiaru. Rozszerzyć adapter i testy reconciliation o Run/Relax; obecny reconciler nie wyklucza ich sam z siebie, ale proste kindy adaptera ich nie zawierają.
- [ ] Build+Study ma widoczne fazy, własny cancellation i rozróżnia „zapisano”, „zbudowano”, „przygotowano”, „uruchomiono”. Receipt pending/unknown nie oznacza success i nie powoduje duplikatu.
- [ ] Apply tekstury w widoku live może otworzyć podgląd m₀ edytowanego celu, zachowując kamerę i ustawienia. Jawnie przypięty wynik historyczny nie jest przełączany bez zgody; pokazać „Zastosowano — pokaż m₀”. Podgląd i źródło solvera pozostają osobnymi wyborami.
- [ ] Historia/wybrany etap pobiera własne pola i domenę przez przypięty read API; nie używa live m na starej geometrii ani starego m na nowej. Wykresy kluczowane przez run/step/source; restart tworzy nową serię bez kasowania starej.
- [ ] Spiąć historyczny read model z `ExplorerModule.tsx`, który dziś wyłącza część danych Results dla niebieżącego runu, zachowując jego metadane. Invalidacja authoringu ma objąć odpowiednie dynamiczne meta/vector/scoped zasoby i nowe stages/results, a nie tylko bazowy katalog `DATA_FIELDS_PATH`. Dla region texture commit istnieje refetch sceny; zapewnić jedną spójną ścieżkę ACK→scena→pola (publikację committed_scene albo zweryfikowany refetch), zamiast dokładać drugi niezależny zapis. Używać rzeczywistych API paths/fabryk i nie usuwać kontroli run/epoch dla spóźnionych odpowiedzi.
- [ ] Zachować fokus, scroll, szkice i tożsamość panelu przez pending/ACK; pending jest per operacja/pole. Klawiatura/menu kontekstowe mają te same działania, zgodne z istniejącymi primitives i i18n.

**Testy:** adapter payload, PPM niezaznaczonego etapu, reorder/delete/rename między menu i ACK, skip≠disable, stage draft auto-apply i globalny dirty guard, material+texture+mesh workflow, zapis udany/build failed, timeout/reconcile, przypięta historia w czasie nowego runu, source label z odpowiedzi API, stabilność Object/Airbox, dostępność z klawiatury.

### T8. Integracja, dowody runtime i zamknięcie wdrożenia

**Właściciel:** prowadzący implementację. **Zależności:** T0–T7 i testy etapowe.

- [ ] Wykonać macierz §5, zachowując logi/receipty, identyfikatory runów, sceny, source pinów, wejściowych planów i artefaktów. Sam HTTP 200/ACK i strzałki na canvasie nie dowodzą użytego m₀/materiału.
- [ ] Backend kontrakty/runtime, OpenAPI/client drift, frontend typecheck, lint z zero warnings, wymagane testy i API hygiene. Polecenia dobrać z bieżącego justfile i reguł grupy Compose; nie wykonywać buildów na hoście ani w obcej grupie.
- [ ] Browser: widoczny canvas, `gl.isContextLost()==false`, niezerowy drawing buffer, wartości z binarnego data plane, bounded requests/renders, brak migotania/remount/focus loss Inspectora.
- [ ] Oddzielnie kwalifikować wspierane FDM CPU, FDM GPU, FEM CPU i FEM GPU; multilayer z natywnymi layoutami. Wymuszone GPU nie może przejść na CPU. Unsupported combination ma jawny wynik, nie sukces zastępczej realizacji.
- [ ] Sprawdzić przekazanie m pomiędzy etapami z pinów/digestów/odczytu wejścia i porównania wartości; materiał w resolved plan odpowiada nowym współczynnikom. Dokładne tolerancje, normy i jednostki ustalić z istniejących not/fixture'ów. Powtórzenie z tego samego źródła i seed daje oczekiwaną powtarzalność w danej realizacji. UI smoke nie zastępuje walidacji numerycznej ani parytetu CPU/GPU.
- [ ] Zaktualizować dokumentację i matrycę supportu do faktycznie wykonanych dowodów. Nowa akceptacja naukowa lub transfer przestrzeni wymaga odrębnego rozszerzenia i kwalifikacji, nie obejścia guardów.
- [ ] Review i integracja według AGENTS/worktree lifecycle dopiero w zadaniu implementacyjnym. Nie usuwać współdzielonych wyników/cache/grup jako skutku kończenia pracy.

## 5. Macierz odbioru

Każdy test ma sprawdzić zakres wykonywanych tasków, wejściowy model/źródło, stan danych po zakończeniu i zachowanie historii. Wpisy poniżej są **wymaganiami**, nie zaliczonymi testami.

| ID | Scenariusz | Minimalny dowód |
|---|---|---|
| S01 | Startup auto-run kończy się, następuje kolejna publikacja stanu sesji, a użytkownik edytuje i uruchamia ponownie | Ten sam edytowalny workspace i spójna gotowość w zasobie sesji oraz admission. Stary run terminalny, nowy run z nowym modelem |
| S02 | Held whole Study bez zmian → Compute → zakończenie → ponowna publikacja sesji | Zwolnienie jednego istniejącego intentu bez duplikatu. Po zakończeniu sesja przyjmuje następną edycję i komendę |
| S03 | Held whole Study → edit lub klik Stage | Trwała supersession; wyłącznie wybrany zakres, nie niezamierzone całe Study |
| S04 | Relax → zmiana m₀ → Apply → Relax only | Nowy binarny podgląd i zgodny solver initial state; jedno zadanie |
| S05 | Relax → zmiana samych współczynników → Relax only. Dla FEM także Compute z rodzica Study | Nowe współczynniki w planie bez fikcyjnego resetu magnetyzacji. W FEM obie operacje zachowują ID i rewizję siatki bez nowego meshowania. Explorer i przygotowanie Compute korzystają z serwerowej walidacji siatki dla nowej rewizji sceny. |
| S06 | Study Relax→Run | m wejściowe Run jest przypiętym wyjściem Relax, poprawna kolejność |
| S07 | Po pełnym cyklu zmiana Run → Run only | Użyty właściwy wynik Relax, nie final poprzedniego Run; historia Relax widoczna osobno |
| S08 | Relax→Run1→Run2 → Run2 only | Źródłem jest zgodny Run1, nie automatycznie Relax |
| S09 | Run/Relax bez poprzednika oraz osobno wybrany drugi Relax | Bez poprzednika wejście authored; drugi Relax dziedziczy aktualny wynik pierwszego, chyba że ma jawny reset; brak uruchamiania sąsiadów |
| S10 | Nieaktualny wymagany poprzednik bez jawnego resetu, np. po zmianie materiału | Brak cichego fallbacku; wyjaśnienie i jawny wybór inicjalizacji albo starego ziarna, gdy legalny; jawny reset testowany oddzielnie |
| S11 | Partial failure: Relax succeeded, Run failed | Ponowienie Run może użyć kwalifikowanego Relax; failed/current frame nie udaje final_state |
| S12 | Multiple cases, obcy/stary attempt, zły digest/brak CAS | Odmowa bez utworzenia wykonywalnego nowego runu |
| S13 | Zmiana parametrów tylko potomka, metadanych, upstream source | Precyzyjna freshness; nie globalne „scene changed” |
| S14 | FDM/FEM przebudowa, także takie samo N | Spójna nowa domena i pola; stare źródło nie pasuje |
| S15 | Multilayer offset/mask/region/transform change | Dokładna tożsamość każdej warstwy i prawidłowe samples |
| S16 | FEM Build Mesh bez materiału, tekstury lub Study | Sukces geometrii niezależny od modelu magnetycznego; gotowość m₀ oceniona osobno według kanonicznych wymagań/defaultów; brak fake m/RunIntent |
| S17 | Błąd Gmsh/m₀, edycja w trakcie budowy, Stop przed receipt | Brak niezgodnej publikacji i następczego Solve; jawny wynik częściowy |
| S18 | Dwa Apply na step0, stare preview stepN, spóźnione response | Właściwy source/carrier wygrywa; brak regresji rewizji |
| S19 | PPM innego węzła; reorder/rename/delete/disable | Tylko właściwy etap albo konflikt; nigdy przypadkowy inny etap |
| S20 | Dirty drafty, błąd zapisu, pending build | Brak startu starej konfiguracji; zachowanie szkiców i fokusu |
| S21 | Podwójne kliknięcie, dwie karty, utracony ACK lub 5xx po trwałej akceptacji, restart API przed powtórzeniem żądania | To samo żądanie w tej samej sesji zwraca wcześniejsze potwierdzenie mimo zmiany bieżącej gotowości. Zmieniony payload daje konflikt, a inna sesja nie otrzymuje potwierdzenia. Przy awarii zapisu dziennika projektor nadal widzi nowy run i rekonstruuje jego wpis z RunIntent. Trwałe dane potwierdzają co najwyżej jeden zaakceptowany run. |
| S22 | Active/queued/preparing/paused/stop race; closed/imported | Brak kolidującej mutacji/nieuprawnionego startu; gotowość po terminalnym dowodzie |
| S23 | Historia przypięta podczas nowego runu, Apply tekstury i przebudowy domeny | Samo Apply zachowuje historyczne pole, geometrię i serie. Jawne pokazanie m₀ sprawdza dokładną ramkę z potwierdzenia i domenę. Zachowuje ustawienia kamery oraz wybór źródła solvera. Utrata publikacji przed odczytem zostawia historyczny podgląd otwarty |
| S24 | Przeładowanie UI i recovery API przy oczekującym Compute | Historia, domyślne źródło i aktualność rekonstruowane z trwałych danych. W tej samej karcie odczyt dziennika wraca po potwierdzeniu tego samego adresu API, ID i epoki sesji. Sprawdzić zgodność ID i rodzaju komendy oraz brak drugiego POST. Zmiana ID lub epoki sesji blokuje odtworzenie obserwacji. |
| S25 | Legacy fm.relax→fm.run i texture edit | Zachowane legacy continuation; edycja m₀ unieważnia automatyczną kontynuację |
| S26 | Non-Any acceptance / unsupported stage/lane | Preflight odmowa bez solvera; brak fałszywego Converged i fallbacku GPU→CPU |
| S27 | Export UI→Python→IR; czas/seed/source | Zachowany sens zakresu i wejść; jawne wymagane artefakty; restart nie udaje Resume |
| S28 | Object/Airbox, klawiatura, WebGL, dłuższa seria ponowień | Stabilny panel/canvas, brak mieszania runów i nieograniczonego wzrostu żądań/pamięci |
| S29 | Trzy Relax kolejno różnymi algorytmami | Wejście drugiego równe kwalifikowanemu wynikowi pierwszego; wejście trzeciego równe wynikowi drugiego; zmiana algorytmu nie resetuje m |
| S30 | uniform X → Relax A → ponownie jawnie uniform X → Relax B → Relax C | B używa tekstury w jej zakresie mimo identycznego authored digestu; C dziedziczy wynik B; A i jego historia pozostają niezmienione |
| S31 | Dwa obiekty/regiony, reset tylko jednego między etapami | Zmieniony zakres ma nową teksturę, reszta dokładnie dziedziczy bazę; poprawne maski FEM/FDM/multilayer; brak nadpisania resetu przy bindingu |
| S32 | PPM Relax B w łańcuchu A→B→C, bez resetu i z resetem | Wykonuje się tylko B; źródłem jest odpowiednio aktualny A lub przypięta recepta B, nie automatyczne globalne m₀ |
| S33 | Ręczny Apply po Relax, następny Stage; reload/retry i równolegle aktywne Study | Jawnie użyty zastosowany stan z właściwym zakresem i bazą; brak zmiany zaakceptowanego runu; zachowany wybór źródła po odtworzeniu |
| S34 | Pełny/zakresowy reset, reorder/disable/group i zmiana algorytmu poprzednika oraz round-trip SceneDocument → Python → IR | Jawne przypisania po stabilnych ID zachowują kolejność, zakres i efektywny odbiornik po round-tripie. Kolejność etapów, zależności magnetyczne i aktualność odpowiadają recepcie |
| S35 | Scoped reset po Stop bez kwalifikowanego final_state albo po zmianie domeny | Brak użycia przypadkowej klatki lub niezgodnej bazy; czytelna odmowa i jawny wybór legalnego źródła/pełnej inicjalizacji |
| S36 | region.texture=tex1 → capture A → region.texture=tex2 → capture B | A nadal zawiera tex1; B zawiera tex2; brak współdzielonego mutowalnego regionu między snapshotami |
| S37 | Edycja parametrów LLG Relax w Scene pipeline oraz wspierany helper między etapami | Właściwe alpha/tolerancje/kroki/adaptivity w materializowanym IR; zachowane wejścia etapów; nieobsługiwana kombinacja odrzucona przed akceptacją |
| S38 | `fullmag.live`: ponowne identyczne przypisanie obiektu/regionu, także przez zagnieżdżony setter | Jawny reset wysłany mimo pustego diffu wartości; właściwy podgląd i input; retry nie powiela resetu |
| S39 | Wymagany AuthoredInitialState oraz pojedynczy B z wejściem od niewykonywanego A | Legalny authored port przechodzi scheduler/binding bez artefaktu CAS; zła referencja odrzucona; rebind B następuje przed walidacją grafu |
| S40 | A:step0 → B:step0 i A:stepN → B:step0; później odczyt starej komendy | Oddzielne serie/źródła i zachowana historia A; command detail wskazuje run/stage swojej operacji |
| S41 | Apply tekstury przy pustych scalar_rows albo skalarach wyłącznie starego runu | Kwalifikowany authored field bundle oraz meta/vector dostępne bez fikcyjnego pomiaru skalarnego |
| S42 | Etap Primitive ze skryptu: edycja, PPM i zmiana sceny podczas refreshu | Zapis tylko właściwego payloadu bez utraty grup/nieznanych pól; zachowanie per-stage wejść; działające zasoby PPM; konflikt rewizji zatrzymuje start |
| S43 | Wybór podglądu m po Apply dla pojedynczego Relax, także przy ponownej publikacji bez zmiany rewizji sceny | Komenda wskazuje dokładną publikację. Worker dostaje te same próbki po wznowieniu przygotowania. Podmiana przed akceptacją wymaga ponownego wyboru. Study uruchomione z rodzica zaczyna od własnego wejścia |
| S44 | Build + Study dla FEM i FDM, także przy ponownej publikacji tej samej domeny | Jedno potwierdzenie budowy z przypiętą sceną i runem. Compute dopiero po sprawdzeniu właściciela domeny i gotowości modelu. Utracone potwierdzenie wznawia odczyt tej samej komendy. Anulowanie przed Compute zatrzymuje dalszy ciąg |
| S45 | `fullmag.live` po utracie ACK jawnego Apply, gdy drugi klient zdążył zapisać nowszą scenę | Odtworzenie identyfikuje zapisane Apply dokładnie raz. Konflikt ze świeżą sceną ma czytelne rozstrzygnięcie. Po uzgodnieniu można wykonać kolejną edycję lub Relax z właściwą rewizją. |
| S46 | Reset regionu zapisany z Inspectora przy Relax B w sekwencji A → B → C. Wyłącz B, zapisz i zaimportuj ponownie. Powtórz dla niezależnego przypisania w skrypcie przed B. | Reset powiązany z B nie zmienia wejścia C po wyłączeniu B. Niezależne przypisanie w skrypcie przechodzi do C. Ponowne włączenie B przywraca jego receptę, a PPM na B uruchamia wyłącznie B. Porównać próbki w regionie oraz poza nim po bindingu. |

**Regresje źródeł do wykorzystania i rozszerzenia:** `scene_study_plan_tests.rs`; testy modułowe `study_contract`, `session`, `live_scene_preparation`, `live_accepted_execution`, `live_accepted_projection` i workerów; `studyRuntimeCommandAdapters.test.ts`, `studyRuntimeCommandContributions.test.ts`, `authoringMutationInvalidation.test.ts`, `RealtimeInvalidationBridge.test.ts`, `explorerStore.test.ts`; istniejące testy Object/Airbox; `packages/fullmag-py/tests/test_live_dsl_mode.py` i `test_live_client_core.py`. Nowe testy resolvera/operacji mają weryfikować inwarianty powyżej, nie kopiować implementacji.

## 6. Granice i kryterium ukończenia

Plan obejmuje pełny cykl interakcji dla kwalifikowanych Run/Relax i obsługiwanych realizacji domeny. Nie ustanawia automatycznie nowych zdolności solverów, obsługi dowolnego Hysteresis/makra, cross-space remap, Resume checkpointu ani ewaluacji wszystkich polityk naukowych. Ich ograniczenia muszą być uczciwie widoczne w API/UI. Przy dodawaniu takich zdolności rozszerzyć kontrakt, implementację i dowody; nie ukrywać ich za ogólnym przyciskiem Stage.

Ukończenie oznacza jednocześnie: właściwy zakres Study/Stage, prawidłowe dziedziczenie i jawne zmiany tekstury między etapami, właściwe wejścia solvera, spójny viewport, zachowaną historię, działającą edycję/rebuild/restart, odporność na błędy i retry oraz wymagane dowody w każdej deklarowanej realizacji. Brak capture zdarzeń/reset scope, historycznego read API, kwalifikacji pola m₀, trwałej supersession lub legacy compatibility jest brakującą częścią wdrożenia, nie kosmetyką.

## 7. Indeks dowodów źródłowych

Kotwice odnoszą się do odczytanego drzewa roboczego. Linia wskazuje właściciela danego kontraktu, nie dowodzi całej proponowanej zmiany. W czasie implementacji należy użyć symbolu, jeżeli numery linii się przesunęły. Projektowane moduły i zasoby opisane wyżej nie są przedstawiane jako istniejące.

| ID | Źródło | Znaczenie |
|---|---|---|
| E01 | [crates/fullmag-api/src/schemas/commands.rs](../../../crates/fullmag-api/src/schemas/commands.rs#L10) | Żądanie komendy, istniejące targety i preconditions; kotwica L10. |
| E02 | [crates/fullmag-api/src/schemas/runtime.rs](../../../crates/fullmag-api/src/schemas/runtime.rs#L89) | Zasób wykonania ma jeden run_id; kotwica L89. |
| E03 | [crates/fullmag-api/src/session.rs](../../../crates/fullmag-api/src/session.rs#L217) | Status efektywny a gotowość sesji; kotwica L217. |
| E04 | [crates/fullmag-api/src/main.rs](../../../crates/fullmag-api/src/main.rs#L5866) | Ograniczona przebudowa live m; wywołanie po commicie w tym module; kotwica L5866. |
| E05 | [crates/fullmag-api/src/session.rs](../../../crates/fullmag-api/src/session.rs#L3564) | Kwalifikacja i wybór źródła pola; kotwica L3564. |
| E06 | [crates/fullmag-api/src/live_scene_preparation.rs](../../../crates/fullmag-api/src/live_scene_preparation.rs#L535) | Publikacja przygotowanego wejścia; nie jest wynikiem solvera; kotwica L535. |
| E07 | [crates/fullmag-api/src/session.rs](../../../crates/fullmag-api/src/session.rs#L2391) | replace_latest_fields wymaga generacji i czyszczenia preview; kotwica L2391. |
| E08 | [crates/fullmag-api/src/live_geometry_mesh_build.rs](../../../crates/fullmag-api/src/live_geometry_mesh_build.rs#L340) | Budowa poza blokadą i publikacja siatki; kotwica L340. |
| E09 | [crates/fullmag-api/src/live_accepted_execution.rs](../../../crates/fullmag-api/src/live_accepted_execution.rs#L2320) | Wybór pojedynczego Run/Relax; przygotowanie i bramka w tym module; kotwica L2320. |
| E10 | [crates/fullmag-api/src/live_accepted_continuation.rs](../../../crates/fullmag-api/src/live_accepted_continuation.rs#L88) | Kontynuacja z CAS; load_final_state w tym module; kotwica L88. |
| E11 | [crates/fullmag-authoring/src/scene_study_plan.rs](../../../crates/fullmag-authoring/src/scene_study_plan.rs#L12) | Zwykła projekcja StudyPlan v2; kotwica L12. |
| E12 | [crates/fullmag-authoring/src/study_contract.rs](../../../crates/fullmag-authoring/src/study_contract.rs#L77) | Porty, wersje i walidacja StudyPlan; polityki akceptacji; kotwica L77. |
| E13 | [crates/fullmag-application/src/script_pipeline_acceptance.rs](../../../crates/fullmag-application/src/script_pipeline_acceptance.rs#L104) | Istniejący kontrakt StepOutput dla Run/Relax; kotwica L104. |
| E14 | [crates/fullmag-api/src/accepted_study_worker.rs](../../../crates/fullmag-api/src/accepted_study_worker.rs#L2631) | Worker odrzuca polityki inne niż Any; kotwica L2631. |
| E15 | [crates/fullmag-api/src/accepted_fem_study_worker.rs](../../../crates/fullmag-api/src/accepted_fem_study_worker.rs#L80) | Ograniczenie polityki w workerze FEM; kotwica L80. |
| E16 | [crates/fullmag-api/src/live_accepted_projection.rs](../../../crates/fullmag-api/src/live_accepted_projection.rs#L1215) | Projekcja bieżącego runu, nie historia Study; kotwica L1215. |
| E17 | [crates/fullmag-api/src/live_execution_binding.rs](../../../crates/fullmag-api/src/live_execution_binding.rs#L99) | Blokada zmiany przypiętych wejść; kotwica L99. |
| E18 | [crates/fullmag-api/src/router_v2/handlers/simulation/remesh_admission.rs](../../../crates/fullmag-api/src/router_v2/handlers/simulation/remesh_admission.rs#L39) | Dopuszczenie przebudowy i aktywny ledger; kotwica L39. |
| E19 | [crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs](../../../crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs#L355) | Admission; wyjątek awaiting_command i ograniczenia obserwacji; kotwica L355. |
| E20 | [crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs](../../../crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs#L2958) | Idempotencja odczytywana z nagłówka idempotency-key; kotwica L2958. |
| E21 | [crates/fullmag-api/src/openapi_v2.rs](../../../crates/fullmag-api/src/openapi_v2.rs#L1169) | Rejestr OpenAPI v2; kotwica L1169. |
| E22 | [apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.ts](../../../apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.ts#L33) | Adapter obecnych prostych komend; domyślny target; kotwica L33. |
| E23 | [apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts](../../../apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts#L1572) | Wysyłka, rekoncyliacja, preconditions i rejestr runtime; kotwica L1572. |
| E24 | [apps/control-room/src/modules/explorer/ExplorerTreeView.tsx](../../../apps/control-room/src/modules/explorer/ExplorerTreeView.tsx#L179) | Kontekst klikniętego węzła; kotwica L179. |
| E25 | [apps/control-room/src/modules/explorer/builders/study/studyStageCommon.ts](../../../apps/control-room/src/modules/explorer/builders/study/studyStageCommon.ts#L17) | Menu i identyfikator węzła etapu; kotwica L17. |
| E26 | [apps/control-room/src/kernel/authoring/authoringMutationInvalidation.ts](../../../apps/control-room/src/kernel/authoring/authoringMutationInvalidation.ts#L2) | Istniejąca invalidacja mutacji authoringu; kotwica L2. |
| E27 | [apps/control-room/src/kernel/resources/studyRuntimeResources.ts](../../../apps/control-room/src/kernel/resources/studyRuntimeResources.ts#L1) | Resource hooks i kontrola run_id odpowiedzi; kotwica L1. |
| E28 | [crates/fullmag-api/src/router_v2/handlers/data/observation_frames.rs](../../../crates/fullmag-api/src/router_v2/handlers/data/observation_frames.rs#L39) | Observation frames są ograniczone do aktywnego runu; kotwica L39. |
| E29 | [crates/fullmag-api/src/router_v2/handlers/persistence/solutions/saved_geometry.rs](../../../crates/fullmag-api/src/router_v2/handlers/persistence/solutions/saved_geometry.rs#L103) | Historyczna geometria przypięta do projektu/runu/artefaktu; kotwica L103. |
| E30 | [crates/fullmag-authoring/src/region_revisions.rs](../../../crates/fullmag-authoring/src/region_revisions.rs#L14) | Oddzielne rewizje realizacji regionów; kotwica L14. |
| E31 | [crates/fullmag-api/src/script.rs](../../../crates/fullmag-api/src/script.rs#L776) | Kanoniczne przygotowanie wejść poszczególnych etapów; kotwica L776. |
| E32 | [packages/fullmag-py/src/fullmag/live/__init__.py](../../../packages/fullmag-py/src/fullmag/live/__init__.py#L1) | Publiczny klient live; kompatybilność domyślnych komend; kotwica L1. |
| E33 | [apps/control-room/src/modules/explorer/explorerStore.ts](../../../apps/control-room/src/modules/explorer/explorerStore.ts#L1) | Wybór historycznego kontekstu wyników; kotwica L1. |
| E34 | [crates/fullmag-api/src/schemas/common.rs](../../../crates/fullmag-api/src/schemas/common.rs#L149) | Atomowa tożsamość publikacji pola; kotwica L149. |
| E35 | [docs/adr/0074-geometry-only-mesh-build.md](../../../docs/adr/0074-geometry-only-mesh-build.md#L31) | FEM Build Mesh bez materiałów, magnetyzacji i Study; kotwica L31. |
| E36 | [docs/physics/0925-live-session-magnetization-continuation.md](../../../docs/physics/0925-live-session-magnetization-continuation.md#L1) | Kontrakt kontynuacji live i invalidacji po edycji tekstury; kotwica L1. |
| E37 | [crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs](../../../crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs#L529) | Odczyty wykonania, runtime_controls i readiness; kotwica L529. |
| E38 | [crates/fullmag-api/src/types.rs](../../../crates/fullmag-api/src/types.rs#L1820) | Wewnętrzna komenda i transport do wykonania; kotwica L1820. |
| E39 | [crates/fullmag-ir/src/study.rs](../../../crates/fullmag-ir/src/study.rs#L852) | Zbieżność i przyczyna zakończenia są odrębnymi danymi; kotwica L852. |
| E40 | [crates/fullmag-runtime-control/src/study.rs](../../../crates/fullmag-runtime-control/src/study.rs#L1172) | Wiązanie wejść accepted workera; kotwica L1172. |
| E41 | [crates/fullmag-runner/src/lib.rs](../../../crates/fullmag-runner/src/lib.rs#L3342) | Dokładne porównanie layoutu; brak automatycznego transferu; kotwica L3342. |
| E42 | [crates/fullmag-api/src/router_v2/handlers/data/fields.rs](../../../crates/fullmag-api/src/router_v2/handlers/data/fields.rs#L3021) | Metadane i binarne próbki aktualnych pól; kotwica L3021. |
| E43 | [packages/fullmag-py/src/fullmag/world.py](../../../packages/fullmag-py/src/fullmag/world.py#L644) | Setter tekstury; CapturedStage i _capture_stage w tym module; kotwica L644. |
| E44 | [crates/fullmag-application/src/script_stage_contract.rs](../../../crates/fullmag-application/src/script_stage_contract.rs#L23) | Węzeł capture bez jawnego zdarzenia/resetu magnetyzacji; kotwica L23. |
| E45 | [packages/fullmag-py/src/fullmag/model/structure.py](../../../packages/fullmag-py/src/fullmag/model/structure.py#L377) | Mutowalny region i tekstura; izolacja snapshotów; kotwica L377. |
| E46 | [packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py](../../../packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py#L432) | Scene pipeline eksportuje wejście do wspólnej materializacji; kotwica L432. |
| E47 | [crates/fullmag-application/src/script_stage_materialization.rs](../../../crates/fullmag-application/src/script_stage_materialization.rs#L3127) | Ograniczony zakres override dynamiki w Scene pipeline; kotwica L3127. |
| E48 | [crates/fullmag-application/src/script_pipeline_compilation.rs](../../../crates/fullmag-application/src/script_pipeline_compilation.rs#L143) | Walidacja mieszanego pipeline i jawnych snapshotów; kotwica L143. |
| E49 | [packages/fullmag-py/src/fullmag/live/_hooks.py](../../../packages/fullmag-py/src/fullmag/live/_hooks.py#L62) | Instalacja hooków mutacji DSL; kotwica L62. |
| E50 | [packages/fullmag-py/src/fullmag/live/_scene.py](../../../packages/fullmag-py/src/fullmag/live/_scene.py#L134) | Transakcje live; równe authored sceny dają pusty diff; kotwica L134. |
| E51 | [packages/fullmag-py/src/fullmag/live/_session.py](../../../packages/fullmag-py/src/fullmag/live/_session.py#L199) | Synchronizacja przed komendą live; kotwica L199. |
| E52 | [crates/fullmag-runtime-control/src/scheduler.rs](../../../crates/fullmag-runtime-control/src/scheduler.rs#L1293) | Readiness portów wymaganych w schedulerze; kotwica L1293. |
| E53 | [crates/fullmag-api/src/router_v2/handlers/model/readiness.rs](../../../crates/fullmag-api/src/router_v2/handlers/model/readiness.rs#L391) | Aktualność FEM względem rewizji sceny; kotwica L391. |
| E54 | [crates/fullmag-api/src/router_v2/handlers/model/authoring.rs](../../../crates/fullmag-api/src/router_v2/handlers/model/authoring.rs#L4676) | Wpływ zmiany material_ref na mesh:dirty; kotwica L4676. |
| E55 | [crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs](../../../crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs#L4322) | Źródło rewizji siatki; clean_scene_mesh_provenance w tym module; kotwica L4322. |
| E56 | [crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs](../../../crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs#L18) | Kontrola liczby próbek; odrębna od kwalifikacji źródła; kotwica L18. |
| E57 | [apps/control-room/src/modules/inspector/panels/stages/StageInspectorFrame.tsx](../../../apps/control-room/src/modules/inspector/panels/stages/StageInspectorFrame.tsx#L158) | Ograniczenie edycji etapów canonical pipeline; kotwica L158. |
| E58 | [apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts](../../../apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts#L2187) | Odmowa flat serializera dla pipeline; kotwica L2187. |
| E59 | [apps/control-room/src/modules/explorer/ExplorerModule.tsx](../../../apps/control-room/src/modules/explorer/ExplorerModule.tsx#L546) | Wybór bieżącego i historycznego kontekstu wyników; kotwica L546. |
| E60 | [apps/control-room/src/kernel/resources/useResource.ts](../../../apps/control-room/src/kernel/resources/useResource.ts#L89) | Wyłączony hook zwraca null; nie jest odczytem cache; kotwica L89. |
| E61 | [apps/control-room/src/modules/inspector/panels/region/ObjectRegionTexturePanel.tsx](../../../apps/control-room/src/modules/inspector/panels/region/ObjectRegionTexturePanel.tsx#L254) | Commit tekstury regionu i invalidacja authoringu; kotwica L254. |

[E01]: ../../../crates/fullmag-api/src/schemas/commands.rs#L10
[E02]: ../../../crates/fullmag-api/src/schemas/runtime.rs#L89
[E03]: ../../../crates/fullmag-api/src/session.rs#L217
[E04]: ../../../crates/fullmag-api/src/main.rs#L5866
[E05]: ../../../crates/fullmag-api/src/session.rs#L3564
[E06]: ../../../crates/fullmag-api/src/live_scene_preparation.rs#L535
[E07]: ../../../crates/fullmag-api/src/session.rs#L2391
[E08]: ../../../crates/fullmag-api/src/live_geometry_mesh_build.rs#L340
[E09]: ../../../crates/fullmag-api/src/live_accepted_execution.rs#L2320
[E10]: ../../../crates/fullmag-api/src/live_accepted_continuation.rs#L88
[E11]: ../../../crates/fullmag-authoring/src/scene_study_plan.rs#L12
[E12]: ../../../crates/fullmag-authoring/src/study_contract.rs#L77
[E13]: ../../../crates/fullmag-application/src/script_pipeline_acceptance.rs#L104
[E14]: ../../../crates/fullmag-api/src/accepted_study_worker.rs#L2631
[E15]: ../../../crates/fullmag-api/src/accepted_fem_study_worker.rs#L80
[E16]: ../../../crates/fullmag-api/src/live_accepted_projection.rs#L1215
[E17]: ../../../crates/fullmag-api/src/live_execution_binding.rs#L99
[E18]: ../../../crates/fullmag-api/src/router_v2/handlers/simulation/remesh_admission.rs#L39
[E19]: ../../../crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs#L355
[E20]: ../../../crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs#L2958
[E21]: ../../../crates/fullmag-api/src/openapi_v2.rs#L1169
[E22]: ../../../apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.ts#L33
[E23]: ../../../apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts#L1572
[E24]: ../../../apps/control-room/src/modules/explorer/ExplorerTreeView.tsx#L179
[E25]: ../../../apps/control-room/src/modules/explorer/builders/study/studyStageCommon.ts#L17
[E26]: ../../../apps/control-room/src/kernel/authoring/authoringMutationInvalidation.ts#L2
[E27]: ../../../apps/control-room/src/kernel/resources/studyRuntimeResources.ts#L1
[E28]: ../../../crates/fullmag-api/src/router_v2/handlers/data/observation_frames.rs#L39
[E29]: ../../../crates/fullmag-api/src/router_v2/handlers/persistence/solutions/saved_geometry.rs#L103
[E30]: ../../../crates/fullmag-authoring/src/region_revisions.rs#L14
[E31]: ../../../crates/fullmag-api/src/script.rs#L776
[E32]: ../../../packages/fullmag-py/src/fullmag/live/__init__.py#L1
[E33]: ../../../apps/control-room/src/modules/explorer/explorerStore.ts#L1
[E34]: ../../../crates/fullmag-api/src/schemas/common.rs#L149
[E35]: ../../../docs/adr/0074-geometry-only-mesh-build.md#L31
[E36]: ../../../docs/physics/0925-live-session-magnetization-continuation.md#L1
[E37]: ../../../crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs#L529
[E38]: ../../../crates/fullmag-api/src/types.rs#L1820
[E39]: ../../../crates/fullmag-ir/src/study.rs#L852
[E40]: ../../../crates/fullmag-runtime-control/src/study.rs#L1172
[E41]: ../../../crates/fullmag-runner/src/lib.rs#L3342
[E42]: ../../../crates/fullmag-api/src/router_v2/handlers/data/fields.rs#L3021

[E43]: ../../../packages/fullmag-py/src/fullmag/world.py#L644
[E44]: ../../../crates/fullmag-application/src/script_stage_contract.rs#L23

[E45]: ../../../packages/fullmag-py/src/fullmag/model/structure.py#L377
[E46]: ../../../packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py#L432
[E47]: ../../../crates/fullmag-application/src/script_stage_materialization.rs#L3127
[E48]: ../../../crates/fullmag-application/src/script_pipeline_compilation.rs#L143
[E49]: ../../../packages/fullmag-py/src/fullmag/live/_hooks.py#L62
[E50]: ../../../packages/fullmag-py/src/fullmag/live/_scene.py#L134
[E51]: ../../../packages/fullmag-py/src/fullmag/live/_session.py#L199
[E52]: ../../../crates/fullmag-runtime-control/src/scheduler.rs#L1293
[E53]: ../../../crates/fullmag-api/src/router_v2/handlers/model/readiness.rs#L391
[E54]: ../../../crates/fullmag-api/src/router_v2/handlers/model/authoring.rs#L4676
[E55]: ../../../crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs#L4322
[E56]: ../../../crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs#L18
[E57]: ../../../apps/control-room/src/modules/inspector/panels/stages/StageInspectorFrame.tsx#L158
[E58]: ../../../apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts#L2187
[E59]: ../../../apps/control-room/src/modules/explorer/ExplorerModule.tsx#L546
[E60]: ../../../apps/control-room/src/kernel/resources/useResource.ts#L89
[E61]: ../../../apps/control-room/src/modules/inspector/panels/region/ObjectRegionTexturePanel.tsx#L254

## 8. Dowody wykonane przy tej korekcie dokumentu

- Odczyt poprawionej wersji raportu, owning source oraz kontraktów; dwa rozłączne przeglądy pomocnicze backendu i frontendu, rozstrzygnięte w treści.
- Kontrola istnienia źródeł i kotwic z indeksu oraz lokalnych linków; kontrola spójności zakresu i zależności planu.
- Kontrola zakresu edycji dokumentu i porównanie z zachowaną wersją wejściową; sprawdzenie, czy źródła użyte w audycie nie zmieniły się w jego trakcie.
- **Niewykonane:** testy produktu, build, uruchomienie sesji, browser/WebGL, CPU/GPU runtime i kwalifikacja naukowa. Żaden scenariusz z §5 nie jest oznaczony jako zaliczony na podstawie tego audytu.

## 9. Ocena dodatkowego raportu Gemini P01–P22

Ponowna ocena 2026-11-05 dotyczy wniosków z kolejnego raportu, a nie jego deklaracji „przeczytano całe pliki / wszystko potwierdzone”. Baza i audytowane wcześniej źródła nie zmieniły się. Raport zawiera wartościowe nowe ustalenia, ale także powtórzenia, nieaktualne ścieżki i zbyt szerokie wnioski. Jego oznaczenie **A13** odnosi się do komend, podczas gdy A13 tego planu dotyczy zdarzeń przypisania tekstury; nie traktujemy tych numerów jako zgodnej mapy diagnoz.

Poniższe oceny są **źródłowe**. Nie stanowią dowodu odtworzenia błędu w uruchomionej aplikacji. Przyjęte uzupełnienia są już wpisane w T1–T7 oraz S36–S42, a nie pozostawione wyłącznie w tym dodatku.

| Wniosek Gemini | Ocena po sprawdzeniu owning source | Wykorzystanie w planie |
|---|---|---|
| P01: współdzielony ObjectRegion | **Potwierdzona nowa luka.** Mutowalne regiony przechodzą do snapshotu jako te same obiekty w skopiowanej krotce; późniejsze przypisanie może zmienić wcześniejszy capture. [E43], [E45] | T3 izoluje stan capture; S36 sprawdza tex1 w A po zmianie regionu na tex2 dla B. Nie narzucamy płytkiego `dataclasses.replace` jako rzekomej głębokiej kopii. |
| P02: identyczna tekstura ponownie przypisana | **Potwierdzone, już objęte kontraktem.** Sam digest nie koduje przypisania. [E43], [E44] | §2.5 i S30 pozostają obowiązujące; nie dodajemy drugiego mechanizmu detekcji opartego tylko na różnicy wartości. |
| P03: parametry Relax | **Potwierdzone dla rekonstrukcji Scene pipeline, nie wszystkich Python snapshotów.** Scene pipeline świadomie emituje `stages=()`, a `apply_dynamics_overrides` obsługuje tylko integrator/fixed timestep. [E46], [E47] | T3/S37 wymagają zachowania wszystkich obsługiwanych parametrów LLG w zmaterializowanym IR i odmowy parametrów nielegalnych dla danego algorytmu. |
| P04: helper usuwa snapshoty | **Mechanizm w raporcie niepotwierdzony.** Nie znaleziono wskazanego normalizatora; aktualny walidator odrzuca nieobsługiwaną mieszankę helperów i jawnych snapshotów. Puste `stages` w Scene pipeline to odrębna, celowa ścieżka. [E46], [E48] | T3/S37 rozdzielają reprezentacje: zachowanie wejść dla kombinacji wspieranej albo jawna odmowa przed akceptacją. Nie zapisujemy jako faktu cichego kasowania snapshotów przez helper. |
| P05: scoped overlay | **Potwierdzone, już objęte.** Obecny binder obsługuje jedną magnetyzację, a runner kopiuje cały stan. [E40], [E41] | Doprecyzowano w T3: jedna baza i recepta zakresowa, nie dwa konkurencyjne porty stanu. S31 porównuje oba zakresy po bindingu. |
| P06: live hooks i pusty diff | **Częściowo potwierdzone, z ważnym nowym przypadkiem.** Brak hooka regionu opóźnia synchronizację, lecz następny submit wykonuje sync. Równe authored sceny rzeczywiście dają pustą listę transakcji. [E49], [E50], [E51] | T3 obejmuje moduły live; S38 wymaga operacji resetu mimo identycznej wartości oraz braku duplikacji przez zagnieżdżone hooki/retry. |
| P07: Held uruchamia całe Study | **Potwierdzone, wcześniej ujęte w A02/T4/S03.** [E09] | Zachować rozróżnienie release niezmienionego pełnego Study i kontrolowanej supersession dla innego celu/źródła. Nie rozluźniać fence ani usuwać starego intentu. |
| P08: przygotowanie oznaczone startup_script | **Zgodne ze ścieżką przygotowania; wcześniej objęte rozdziałem lifecycle.** [E09], [E16] | T4 i S01–S03 obejmują także Compute po przygotowaniu Held. Wynik runu pozostaje terminalny, workspace może być gotowy do kolejnej operacji. |
| P09: błędny StageId i fallback | **Potwierdzone, już ujęte.** [E09] | T1 oraz S19: nieznane ID nigdy nie wybiera „jedynego dostępnego” etapu. |
| P10: validate przed rebindem | **Potwierdzona pułapka kolejności po dodaniu zależności.** Wyłączenie poprzednika i pierwsza walidacja poprzedzają obecne deklarowanie pinu; StepOutput potrzebuje również kontroli enabled źródła. [E09], [E12] | T3 wymaga przebudowy grafu przed pierwszą walidacją; S39 sprawdza wybrany B i niewykonywanego A. Nie wyłączać walidatora dla wygody. |
| P11: wymagany AuthoredInitialState | **Potwierdzony blocker proponowanej reprezentacji.** Scheduler nie uznaje tego wariantu za automatycznie rozwiązywalny, a walidacja wymaga resolved input, mimo wyjątku w materializerze workera. [E52], [E40] | T3/S39 uzgadniają scheduler, resolver, walidację i binder. Rozwiązanie nie może uznać dowolnego niezweryfikowanego reference za gotowe. |
| P12: allow-list provenance | **Pułapka przyszłej integracji, nie samodzielny obecny błąd.** Worker odrzuca nieznane klucze `live_workspace`. [E14] | T3 przeprowadza nowe dane przez typowany/wersjonowany kontrakt i właściwe allow-listy; test round-trip oraz zachowanie odmowy nieznanych pól. |
| P13: scalar_rows przy step0 | **Mechanizm bieżącego bufora potwierdzony; usunięcie trwałej historii nie zostało wykazane.** Projektor czyści bufor przy cofnięciu step; `session::upsert_scalar_row` zastępuje ostatni równy step. Istnieje też deduplikacja po tożsamości accepted źródła. [E16], [E03] | T2/S40 rozdzielają lineage bieżącej serii od historii. Nie sklejamy wszystkich etapów w jedną tablicę indeksowaną samym step. |
| P14: każda edycja wymusza remesh | **Ryzyko potwierdzone, twierdzenie „zawsze” zbyt szerokie.** Readiness porównuje scene revision, material_ref może ustawić mesh:dirty, lecz mesh provenance ma też alternatywne ścieżki. Wskazany `snapshot_fem_mesh_is_current` nie występuje w odczytanym handlerze. [E53], [E54], [E55] | T6 uzgadnia podpisy domeny i readiness. Zachować rozróżnienie współczynników od membership/support/klasy materiału; samo usunięcie guardu materiałowego jest niewystarczające. |
| P15: frame step0 i bundle bez skalarów | **Potwierdzone.** Kolizja tożsamości przygotowania była już w §3.3; dodatkową konkretną bramką jest wymóg pasującego scalar row w `refresh_accepted_field_publication_bundles`. [E34], [E03] | T5/S41 dodają kwalifikację authored bundle bez fikcyjnego pomiaru. Dla źródeł solverowych zachowujemy wymagane dowody korelacji. |
| P16: sama liczba węzłów dowodzi ekspozycji starego pola | **Tak sformułowany wniosek niepotwierdzony.** Aktualny helper znajduje się w `data/field_resolution.rs`, sprawdza liczbę/mapping, a kwalifikację źródła i frame/domain wykonują inne funkcje. Nie jest to cały kontrakt odczytu ani opis „FDM sprawdza tam fingerprint”. [E56], [E05] | Zachować pełną weryfikację źródła/carrier/domeny oraz S14/S18. T6 publikuje spójne nośniki; nie naprawiać wyłącznie licznika próbek ani usuwać istniejących frame guards. |
| P17: historia niedostępna | **Potwierdzone dla observation frames i części danych Results, nie wszystkich metadanych.** [E28], [E59] | §3.2/T7/S23 już wymagają odrębnego kwalifikowanego odczytu historii. Dopisano owning frontend; nie poluzowujemy `active_run_id` bieżącego endpointu. |
| P18: brak zasobów PPM | **Potwierdzona luka; „Fields/Energies zawsze disabled” jest nieprawdą.** Wyłączone hooki dają null, ale istnieje osobna ścieżka backendowego readiness dla terminalnego postprocessingu. [E24], [E60], [E23] | T7/S42 zapewniają właściwe zasoby menu bez pollingu per węzeł i zachowują legalny wyjątek postprocessingu. |
| P19: refresh preconditions | **Potwierdzone częściowo.** Builder pomija scene/mesh revision, refresh nadpisuje wybrane dynamiczne pola i zachowuje pozostałe. Nie jest prawdą, że usuwa każdy precondition. [E23], [E01] | T7/S42 przypinają model/cel/źródło po ACK zapisu; odświeżenie statusu nie może podmienić tego zamiaru. Nie usuwamy automatycznie całego refreshu. |
| P20: brudne szkice | **Potwierdzone i już objęte T7/S20.** Porównanie z „bezpiecznymi komendami siatki” w raporcie jest za szerokie: wskazana kontrola dotyczy kasowania obiektu, a przygotowanie historii mutacji nie jest bramką szkiców. [E23] | Utrzymać wspólny dirty guard, ACK i zatrzymanie łańcucha po błędzie; nie kopiować niewłaściwego guardu usuwania. |
| P21: zablokowany pipeline editor | **Potwierdzona istotna luka wykonawcza planu.** Blokuje nie tylko fieldset, lecz również serializer flat-stage. [E57], [E58] | T3/T7/S42: bezpieczna edycja konkretnego Primitive payloadu, zachowanie drzewa i per-stage wejść; sekcja wykonawcza poza blokadą starego edytora. Nie wystarczy usunąć `disabled`. |
| P22: invalidacja region texture | **Potwierdzone częściowo.** Bazowa invalidacja nie pokrywa automatycznie dynamicznych meta/vector zasobów; jednak scena ma refetch, więc brak bezpośredniej publikacji ACK nie dowodzi całkowitego braku aktualizacji. Raportowe stałe `DATA_FIELD_M_META_PATH` i `DATA_FIELD_M_SAMPLES_VECTOR_PATH` nie istnieją. [E26], [E61] | T5/T7 obejmują właściwe dynamiczne zasoby i stages/results oraz jedną zweryfikowaną ścieżkę ACK/refetch. Nie wprowadzać fikcyjnych nazw ani dwóch niezależnych publisherów sceny. |

**Dodatkowe rozstrzygnięcia dotyczące propozycji zmian:**

- Zależności zakończenia są dopuszczone w v3 i v4; twierdzenie o wyłączności v4 jest błędne. [E12] Pozostaje dotychczasowa zasada wersjonowania nowych resetów i capture.
- Admission w obecnym `commands.rs` ma wcześniejszy wyjątek dla awaiting_command oraz odrębną ścieżkę accepted observations. Nie odpowiada opisowi z raportu, jakoby cytowana funkcja ogólnie dopuszczała Run/Relax/Solve w Completed. [E19] T4 uzgadnia gotowość workspace bez fałszowania stanu runu.
- Rozpoznanie potrzeby idempotencji jest użyteczne, ale frontend już rekoncyliuje po client_intent_id. Brak nagłówka nie oznacza „braku jakiegokolwiek recovery”. Replay należy rozwiązać po kontroli właściciela i treści, przed dynamicznym admission nowej mutacji — nie przez przeniesienie cache na sam początek handlera. [E20], [E23]
- Backendowe listy readiness/aktywnego compute rzeczywiście pomijają Run/Relax; to inne miejsce niż generyczny frontendowy reconciler, który ich jawnie nie wyklucza. [E37], [E23] T4/T7 obejmują oba kontrakty. T1/S40 dodatkowo zachowują requested target i trwałe resolved run/step w command detail po przełączeniu aktywnego runu.
- Nie przejmujemy mechanicznych zaleceń `replace_latest_fields=true` dla każdej publikacji ani obowiązkowego m₀ przy każdym FEM Build. Nadal obowiązują typowany origin/generation i geometry-only Build bez kompletnego modelu magnetycznego (§3.3–3.4, T5–T6). Historyczne observation frames pozostają odrębnym kontraktem od danych bieżącego runu.


## 10. Stan odbioru T8 w worktree

Branch codex/interactive-study-p01-p22 zawiera master w rewizji e8e0d35cb7da697207b490f9573cb2fb7f646e97. Wszystkie osiem workflow dla wcześniejszego scalenia 375a375c24a35f74a5b66b67094247f290ad4456 przeszło, w tym pełna bramka Rust i oba nowe testy stosu projektora. [CI 42367571399](https://github.com/MateuszZelent/fullmag/actions/runs/42367571399). Zarządzany runtime z czystej rewizji 1bebbd00b7c0c8392586d96f765de2ee2e65f353 wystartował poprawnie i wykonał nowy S29d do trzech natywnych Succeeded. Przekazanie magnetyzacji przeszło, lecz publiczny model pozostał Running; obserwator zakończył się timeoutem bez anulowania. Następnie wykonano autentyczny drain, zachowując wyniki. CI aktualnego scalenia ab34f20175b4951e7cf9bf424a6ba30d0a666154 oraz poprawka publikacji lifecycle pozostają odrębnymi bramkami.

| Warstwa | Wykonany dowód | Pozostaje do sprawdzenia |
|---|---|---|
| Python DSL i klient | 60 testów `test_study_stages.py` i `test_live_dsl_mode.py`, 8 subtestów oraz 18 testów `test_live_client_core.py`. Obejmują izolację przechwyconej tekstury regionu, jawny reset o tej samej wartości, round-trip przypisań i utratę ACK. | Rzeczywiste próbki S29 przeszły. Nadal wymagane: reset globalny/zakresowy S30–S31 i S43. |
| Control Room | Na `6a7be3934` przeszły typecheck, lint, build oraz 9562 testy głównego zestawu i 3 osobne testy. Główny zestaw pominął 13 testów. Chromium z fixture potwierdziło 12 żądań po Apply, zachowanie fokusu i przewinięcia oraz brak dodatkowych renderów Inspectora w mierzonym przedziale. [Przebieg CI 42275581890](https://github.com/MateuszZelent/fullmag/actions/runs/42275581890) | Rzeczywisty test canvas/Home z API przeszedł 2026-11-07 w zarządzanym Chromium; szczegóły i ograniczenia poniżej. Nadal otwarte: komendy, Inspector ACK, odczyt wartości pola, reload oraz pełny cykl edycja → ponowienie. |
| Rust | Na `b9a88f72` przeszła pełna bramka Rust/API, w tym sześć poprawionych regresji routera, klasyfikacja zmiany klucza regionu, kontrakty startu workera, ciągłość rzeczywistych próbek FDM CPU, OpenAPI i materializacja aplikacji. [Log CI](https://github.com/MateuszZelent/fullmag/actions/runs/42299778387/job/128174242751) | Przekazanie próbek S29 potwierdzono w DEV. Pozostają terminalna publikacja do UI i pozostałe scenariusze. |
| Wygenerowane API | Eksport z [przebiegu CI 42205286509](https://github.com/MateuszZelent/fullmag/actions/runs/42205286509) dla commita `963966774c9273030b180b60bf4e24c4749fd8ab` zawiera 324 trasy, w tym osiem nowych tras wyników, oraz warunki `current_run` i `domain_generation_id`. Snapshot i typy TypeScript pochodzą z artefaktu CI. Katalog ścieżek i klienta Python odtworzono z tego samego eksportu. | Deterministyczność przeszła również w CI 42299778387. Pozostaje weryfikacja API działającej grupy DEV. |
| Docker DEV | Nowe ownerless recovery przeszło 23 testy oraz 75 istniejących kontraktów, rzeczywisty preview/apply i przypięte fresh recreate. Poprawione API wystartowało bez przepełnienia stosu. S29d wykonał A/B/C; manifesty, CAS i próbki potwierdziły oba przekazania z maksymalną różnicą 0. Kontrolowane quiescence i natywny drain przeszły. Po stopie 98 plików S29c/S29d zachowało hashe. | Publiczny lifecycle nie osiągnął Completed/awaiting_command. Wymaga poprawki projekcji i ponownego testu; odbiór T8, FEM/GPU/multilayer pozostaje otwarty. |

Dla S29–S30 przygotowano test `relaxation_worker_binds_the_previous_final_samples_or_the_explicit_authored_reset` w `fullmag-runtime-control`. Test wykonuje trzy algorytmy FDM CPU. Wczytuje rzeczywiste `m_final.json` poprzednika przez CAS i porównuje z planem wejściowym oraz `m_initial.json` następnego etapu. Wariant B po jawnym resecie porównuje `m_initial.json` z pierwotnym uniform X. Ten zakres przeszedł na jednym spinie w polu poprzecznym w CI 42272218901. Rozszerzenie o porównanie wejścia C z wynikiem B po resecie przeszło w CI 42275581890. Osobny job `fdm-relaxation-qualification` tego przebiegu również przeszedł w swoim ograniczonym zakresie FDM CPU. Ścieżka przekazania próbek przez API i workery DEV przeszła w S29c/S29d; publikacja końcowego stanu UI pozostaje do odbioru.


Diagnoza sześciu błędów routera z CI 42275581890:

- Fixture zastąpienia runu nie ustawiała `snapshot.run`, ponieważ `default_current_live_state` jedynie inicjuje stan bazowy. Korekta wiąże manifest poprzedniego runu przed sprawdzeniem odrzucenia obcej publikacji.
- Fixture resetu zakresowego miała `session.status = running`. Publikacja pola przeliczała gotowość i prawidłowo blokowała edycję aktywnego wykonania. Scenariusz ustawia teraz spójny stan oczekiwania na polecenie.
- Trzy fixture ładunku topologicznego FEM wstawiały surowe próbki bez zaakceptowanej obserwacji. Korzystają teraz z istniejącego publishera testowego, zachowując dotychczasowe wartości, domenę i asercje naukowe.
- Historyczne pole `region_name` jest kluczem regionu głównego używanym przez geometrię i przypisania tekstur. Jego zmiana unieważnia realizację. Test odróżnia tę operację od zmiany etykiety `name`; dodatkowy test klasyfikacji rewizji trafia do standardowej bramki CI.

Korekty potwierdziła pełna bramka Rust w CI 42299778387. Lokalnie przeszły 15 testów kontraktu workflow, 10 testów wymaganych bramek, kontrola składni skryptu bramki i `git diff --check`. Nie wykonano hostowego buildu Rust.

W pełnym odbiorze korzystać z `m_initial.json` i `m_final.json` w prywatnym katalogu konkretnej próby workera `runs/<run>/worker-attempts/<task>/<attempt>/epoch-<epoch>`. Runner zapisuje wektory ze stanu solvera pobrane przed pierwszą aktualizacją, także gdy podgląd live z kroku 0 jest wyłączony. Najpierw przypiąć run, etap, task, próbę i epokę z receiptów oraz zgodność domeny z artefaktami. Dopiero wtedy porównać wartości. W przypadku resetu zakresowego porównać zmienione i zachowane próbki na kanonicznej masce. Odcisk w receiptcie workera dotyczy planu przed związaniem wejść.

Poprawka odczytów Windows-folder obejmuje wyłącznie pełną obserwację claima i snapshotu kolejki. Po `ENODATA` sprawdza rzeczywisty system plików i istniejącą admisję 9p przed każdą dodatkową próbą. Dwie sekundy ograniczają rozpoczynanie kolejnych odczytów; nie przerywają blokującego syscalla. Globalna klasyfikacja błędów i operacje zmieniające stan pozostają bez rozszerzenia retry. Kontrola składni czterech plików Rust, review i 19 testów kontraktu workflow przeszły; osiem nowych testów session oraz osobny test braku globalnego retry przeszły w CI dla `65e74a3a8b8cb16e7e33d4f67de3d15a35aa6701`. Pełny zestaw session zakończył się wynikiem 495/496: nowy kontekst błędu ukrył w pierwszym Display istniejący komunikat limitu bajtów. Limit nadal działał; poprawka zachowuje ten komunikat i łańcuch błędu bez zmiany dotychczasowej asercji. Siedem pozostałych workflow przeszło. [CI 42355100734](https://github.com/MateuszZelent/fullmag/actions/runs/42355100734).

Zarządzany build snapshotu z tą poprawką zakończył się poprawnie. W nowym S29 etap A uzyskał `succeeded` i opublikował kwalifikowany `final_state`. Etap B został przyjęty do przygotowania, po czym scheduler odmówił ponownej walidacji wejścia: poprawne `source` i `content_sha256` porównywano wraz z już uzupełnionym `study_artifact` do tymczasowego wariantu bez tych metadanych. Hash CAS i pełne metadane zgadzały się z manifestem bieżącej próby A. To odrębny błąd granicy queue → admission → Prepare, niewykrywany przez dotychczasowy test konstruujący workera bez schedulera. Nowa próba S29 również nie jest zaliczona. Zachowano oba runy; nie ponawiano nieznanej komendy.

Poprawka powtórnego związania StepOutput zachowuje uzupełnione metadane i sprawdza je względem kanonicznego manifestu oraz CAS. Nowa regresja `step_output_typed_binding_replay_survives_scheduler_prepare_for_b_and_c` przechodzi przez zwykłe queue → admission → Prepare dla B i C; sprawdza również uzupełnienie pustych metadanych i odrzucenie pięciu sfałszowanych pól. Regresja przeszła w kroku `accepted_start` CI dla `be1cb96d4`; dotychczasowy test fizycznego workera pozostaje osobnym dowodem.

Kolejny zarządzany build snapshotu z poprawką zakończył się poprawnie. Rzeczywista próba S29c wykonała A/B/C do trwałego `Succeeded` i opublikowała wszystkie 57 artefaktów. Odczyt konkretnych task/attempt/epoch, manifestów, CAS oraz domeny potwierdził na ośmiu komórkach FDM CPU: B.initial = A.final i C.initial = B.final, z maksymalną różnicą 0 przy tolerancji 1e-12. Jest to dowód przekazania próbek, bez deklaracji zbieżności ani kwalifikacji FEM/GPU/multilayer.

Odbiór UI pozostaje zablokowany błędem projekcji: publiczny stan wskazuje Running i pierwszy etap, mimo pustej kolejki i zakończonych trzech zadań. Observer zakończył się po 900 sekundach bez anulowania runu. Workery A/B zgłosiły również konflikt writera przy zapisie końcowego zdarzenia, chociaż trwały scheduler odtworzył Succeeded; C zakończył proces poprawnie. Zachowano pełne wyniki i receipty. Nie ponowiono aktywacji ani Solve. Diagnoza obejmuje blokadę współdzieloną, pełny odczyt dziennika oraz spójność aktualizacji lifecycle; sam stan Ready właściciela nie dowodzi gotowości UI.

Zarządzany test rzeczywistego Chromium/Playwright 1.62.1 zakończył się `succeeded`: WebGL2 zachował kontekst, bufory miały 617×527 i 617×495 pikseli, powrót przez Home zachował sesję; brak błędów strony, konsoli i żądań. Wykorzystano programowy SwiftShader, co nie kwalifikuje sprzętowego GPU. Żądanie próbek `m` zakończyło się HTTP 200, a etykieta i dane DOM wskazywały `data-ready` oraz osiem komórek. Harness jawnie zwraca `field_data_proven=false`: ten zakres nie dekoduje próbek ani nie dowodzi przyjęcia ich wartości przez renderer. Odrębny dowód próbek pozostaje weryfikacją artefaktów S29c. Nie wykonano w tym teście Solve/Compute ani scenariusza reload.

Odczytowa kontrola 40 wpisów dziennika S29c (17 komend, 23 zdarzenia, 146144 bajty) potwierdziła ciągłość sześciu strumieni, hash payloadu, tożsamości claim/checkpoint oraz po jednym Started i Completed dla każdego bieżącego etapu. Jest to kontrola danych względem kodu, bez wywołania projektora Rust i bez pomiaru opóźnienia jego blokady. Nie znaleziono deterministycznej niezgodności dziennik/katalog. Dodana diagnostyka faz projektora zachowuje tę samą oczekiwaną operację; nie wprowadza timeoutu, anulowania, replay ani innej semantyki blokad.

Procedura DEV otrzymała oddzielny tryb `restart-idle-volume --stop-only --capture-native-terminal` dla uruchomionego skryptu startup, którego zadania są natywnie Succeeded, lecz publiczny stan nadal wskazuje Running. Wymaga pustej kolejki, zakończonych komend, stałych tożsamości API/sesji/sceny i Ready ownera, istniejącego fenced `service-inspect-terminal-run` oraz poprawnego native drain. Zachowuje literalny status API. Osobny pin `--native-terminal-stop` wraz z SHA surowego terminal receipt pozwala wyłącznie na `recreate-volume --fresh-state`; dotychczasowe terminal restore i ich schematy pozostają bez zmian. Nowe i zgodne dotychczasowe testy przeszły 67/67, a 19 testów kontraktu/polityki workflow przeszło po dodaniu nowej regresji do CI. Wykonanie tego trybu w DEV wymaga jeszcze odbioru.

Pierwsze rzeczywiste wykonanie tego stop-only zakończyło się `failed-confirmed` przed zatrzymaniem backendu: istniejący proces API trzymał współdzielony fence, który uniemożliwił natywny odczyt terminalności wymagający writera, także po zatrzymaniu frontendu. Procedura przywróciła frontend; backend i Ready owner pozostały działające, a danych nie zmieniono. To wykazana zależność kolejności zamykania API i natywnej kwalifikacji; pomijanie fence nie jest poprawką. Następny wariant musi jawnie zamknąć dokładnie przypięty proces API przed tą kwalifikacją, zachowując runtime oraz wyniki i rozróżniając odmowę przed zamknięciem od niepotwierdzonego wyniku po nim.

Dodany wariant `--quiesce-api` jest dostępny wyłącznie z native capture i stop-only. Po podwójnym odczycie sesji, kolejki, komend, sceny i natywnego all-Succeeded oraz ponownej kontroli kontenerów zapisuje intent, ponownie sprawdza proces API i wysyła pojedynczy SIGTERM przez pidfd do tego API. Nie sygnalizuje workerów. Dopiero potwierdzone zamknięcie API pozwala wykonać dotychczasowy natywny fence; wymagane pozostają niezmienione piny i późniejszy autentyczny drain. Błąd po zapisie intentu zachowuje zasoby z wynikiem unknown, bez powtarzania sygnału ani odtwarzania API. W tym wariancie backend exit 1 jest dopuszczony wyłącznie z dowodem dokładnej przyczyny zamknięcia API i prawidłowym zakończeniem właściciela oraz dzieci. Dotychczasowy tryb pozostaje bez zmian. Testy obu wariantów i wcześniejszych producentów terminal proof przeszły 74/74; wariant wymaga jeszcze wykonania w DEV.

Pierwsza próba wariantu quiesce odmówiła działania przed intentem i sygnałem z powodu błędu nowego preflightu: rzeczywisty kanoniczny SceneDocument publikuje `revision`, a fixture zakładała `scene_revision`. Preflight wymaga teraz kanonicznej liczby całkowitej i zgodności z `status.resources.scene_revision`; opcjonalny alias musi zgadzać się z nią. Regresja obejmuje rzeczywisty kształt odpowiedzi, brak kanonicznego pola oraz błędne typy i sprzeczny alias. Zestaw przeszedł 75/75. Przy odmowie backend pozostał działający, a frontend przywrócono.

Kolejna próba wykonała quiescence API, natywną kontrolę terminalności i autentyczny drain poprawnie. Po archiwizacji ponownie potwierdzono hashe 50 plików oraz oba przekazania próbek przez CAS. Następny backend skompilował i zweryfikował pakiet, lecz API przerwało start przez przepełnienie stosu, przed utworzeniem natywnego ownera i przed jakąkolwiek aktywacją symulacji. Retained process zapisuje SIGABRT (-6); store nie zawiera runów, a namespace runtime-services jest pusty. To nie jest sukces startu aplikacji.

Nowy observer diagnostyczny był `async fn`, więc jego future przechowywał dużą operację inline przed pierwszym poll; `tokio::pin!` nie przenosił jej na stertę. Zmieniono go na zwykłą funkcję wykonującą `Box::pin` przed utworzeniem zwracanego async future. Dodano regresję rozmiaru dla zawieszonej operacji 64 KiB i test pustej projekcji na workerze Tokio z jawnym stosem 2 MiB. Nie zwiększono stosu procesu. Oba nowe testy przeszły w pełnej bramce Rust CI 42367571399. Zarządzany start API rewizji 1bebbd00b również przeszedł bez przepełnienia stosu.

Scalenie z aktualnym masterem zachowuje zatwierdzony zakres group-local recovery
oraz obie ścieżki: osieroconego helpera i wznowienia przygotowanej generacji
dowodu. Pusty bootstrap po SIGABRT API otrzymał oddzielny preview/apply stop
i fresh-only receipt. Potwierdza brak native ownera, bez udawania drain;
archiwizacja wymaga ponownej walidacji tego samego pustego stanu. Kontrakt przeszedł 23 nowe i 75 istniejących testów oraz rzeczywisty preview,
apply i fresh rebuild; po poprawce stosu API osiągnęło gotowość.

Nowy S29d potwierdził przekazanie A→B→C na ośmiu komórkach przez kwalifikowane manifesty i CAS, lecz odtworzył błąd publicznego lifecycle: po trzech natywnych Succeeded UI zachował [completed, completed, running]. Log ujawnił WouldBlock podczas shared fence dziennika. Odczyt 34–38 wpisów trzymał blokadę przez 1,2–1,6 s; pełny poll trwał do 4 s. Obserwator po 900 s zakończył się timeoutem bez anulowania. To nie jest zaliczony odbiór S29 w UI.

Przyjęta poprawka rozdziela krótki, obowiązkowy i spójny snapshot intent/katalogów/start gate od opcjonalnych metadanych dziennika. Dziennik będzie czytany w porcjach zwalniających blokadę, z zachowaniem walidacji tożsamości, sekwencji, hashy i pokrycia watermarków. Spośród błędów I/O wyłącznie typowany WouldBlock odracza wzbogacenie. Osobno rozpoznana legalna zmiana katalogu między porcjami odracza metadane; sam heartbeat przy zachowanej tożsamości dziennika nie unieważnia odczytu. Lifecycle może pochodzić ze zweryfikowanego core, bez wymyślonych timestampów. Pending musi umożliwiać uzupełnienie również dla niezmienionego terminalnego katalogu. Błędy integralności i publication CAS pozostają blokujące. Zaimplementowano ten podział w projektorze API i store oraz dodano 14 regresji: osiem API i sześć store. Review poprawiło blokowanie świeżych sidecarów przez backoff i mylenie heartbeat ze zmianą snapshotu. Parser obu plików i diff check przeszły; wykonanie testów Rust w CI oraz nowy test DEV są nadal wymagane. Pierwszy CI wykonał sześć nowych testów store poprawnie, ale kompilacja testów API wykryła brak rozpakowania opcjonalnego stage_execution w nowej asercji. Poprawiono ją, dodając również sprawdzenie obecności trzech etapów. Produkcyjny pakiet tej rewizji zbudował się i wystartował bez aktywnej sesji; osiem nowych testów API wymaga ponownego CI.

Ponowny CI dla `ec0a8c7eddd79d1047b1946d2f310fb2af95c2e6` zakończył wszystkie osiem workflow sukcesem. Pełny [job Rust/API 128408800864](https://github.com/MateuszZelent/fullmag/actions/runs/42374357834/job/128408800864) wykonał wszystkie 14 nowych regresji poprawnie, w tym terminalne Completed/awaiting_command przy odroczonych timestampach, ponowny enrichment tego samego kursora, świeżość sidecarów oraz publication CAS. To dowód źródeł i kontraktów; rzeczywisty odbiór poprawki lifecycle w DEV pozostaje wymagany.

Dalszy odbiór odbywa się wyłącznie w WSL. Poprzednia grupa Windows została zatrzymana przez managed stop-only z potwierdzonym native drain, bez aktywnej sesji lub runu; jej dane i 98 kontrolowanych plików S29c/S29d zachowano. Nie kwalifikowano importu tych sesji do WSL. Worktree zadania przeniesiono do kanonicznego `/home/kkingstoun/git/fullmag/worktrees/interactive-study-p01-p22-wsl`, zgodnie z AGENTS.md, i zarejestrowano jako aktywny. Wspólny Git oraz konfigurowany storage znajdują się w projekcie WSL; nie kopiowano `.env` z Windows. Nowa grupa nie została jeszcze uruchomiona.

Dodano zarządzany harness rzeczywistego PPM `--study-stage-rerun stage-b|study`. Wymaga dokładnego fixture FDM CPU na ośmiu komórkach, niezmienionego skryptu i sceny z limitami 10/1/1. Jeden POST jest dopuszczony dopiero po uzbrojeniu konkretnej akcji menu; immutable `execution_binding` wiąże obserwowany run z zaakceptowaną komendą. Osobno weryfikowane są zakres etapów, publiczny terminalny stan i niezmienione tożsamości wcześniejszych wyników. Odczytowe bindy źródeł i fixture są przypięte i sprawdzane. Brak, ucięcie lub uszkodzenie raportu po możliwym dispatchu zachowuje wynik native jako unknown; brak dispatchu wymaga kompletnego dowodu. Pełne 50 testów BrowserQA oraz kontrola składni przeszły. Rzeczywistego uruchomienia tego harnessu jeszcze nie wykonano. Jego dowody UI i historii nie zastępują niezależnej kontroli natywnego katalogu oraz próbek CAS; `native_execution_proven` i `field_data_proven` pozostają false.

Odczytowy audyt przed uruchomieniem PPM wykrył błędne oczekiwanie harnessu: `relax`, podobnie jak `solve`, jest komendą Study compute, a nie sterowaniem aktywnym etapem. Produkcyjny builder nie dodaje do nich `stage_execution_revision`. Poprawiono generator harnessu i oba walidatory do tego kontraktu, zachowując scene/mesh/domain/current_run, cztery rewizje regionów, stan runtime i liczbę komend. Regresja najpierw odtworzyła dwa błędy, a po korekcie cały zestaw 50 testów przeszedł.

Dalsze prześledzenie kanonicznego authoringu skorygowało zbyt wąski wniosek z audytu panelu Mesh: edytor rozdzielczości już istnieje w inspektorze Study jako FDM default cell. Zapisuje study.fdm.default_cell przez revision-fenced merge transaction, a następnie automatycznie wykonuje fdm_grid_refresh. Dla fixture zmiana [2e-9,2e-9,2e-9] na [1e-9,2e-9,2e-9] daje 8→16 komórek; magnetyzacja jest inicjalizowana z modelu, bez remapowania starej siatki. Eksport Python uwzględnia ten parametr. Nie trzeba dodawać osobnego edytora ani endpointu; rzeczywisty odbiór istniejącego przepływu i zachowania historii pozostaje wymagany.

T8 pozostaje otwarte. Macierz S01–S46 wymaga dowodów wykonania dla poszczególnych scenariuszy, w tym WebGL, trwałych artefaktów i osobnej kwalifikacji FDM/FEM CPU/GPU oraz multilayer.


### Aktualizacja odbioru WSL — 2026-11-07

Wszystkie osiem workflow dla `6ee3c39e76f27b0d59f6cc5a08eec836a6394af2` zakończyło się sukcesem, w tym [bootstrap 42385315806](https://github.com/MateuszZelent/fullmag/actions/runs/42385315806). Zarządzany backend WSL działa z pakietu tej czystej rewizji. Nowy S29e został przyjęty dokładnie raz, lecz pierwszy worker zakończył się przed solverem: zapis sąsiedniego Zarr pod aliasem wyjścia otrzymał Permission denied. Dwa kolejne taski pozostały Accepted, a katalog artefaktów nie powstał. Publiczny projektor odmawia takiej kombinacji przez accepted_projection_artifact_catalog_required, dlatego UI nadal pokazuje waiting_for_compute. Nie jest to dowód wykonania S29 ani udanego ponowienia.

Potwierdzono brak prawa zapisu UID 65532 w istniejącym podkatalogu examples/interactive_study na ext4; samo oznaczenie bindu RW nie nadaje praw POSIX. Naprawa musi zachować read-only bind źródeł, ograniczyć grant do jawnie wskazanego podkatalogu wyjściowego, zachować pozostałe efektywne ACL i sprawdzać rzeczywisty zapis przed akceptacją. Projektor wymaga osobnej, zweryfikowanej ścieżki błędu przed solverem z nieuruchomionymi następcami. Zapisano hashe 20 plików próby przed recovery. Istniejący operator WorkerNoSpawn nie obejmuje zakończonego procesu workera; nie użyto go. Recovery, przebudowa i rzeczywisty odbiór UI pozostają otwarte.


### Kandydat poprawki błędu przed solverem

Projektor otrzymał osobną ścieżkę dla pierwszego Failed/Disconnected i nieuruchomionych następców Accepted bez artefaktów. Weryfikuje pełne pokrycie kanonicznego Study, fingerprinty i zależności blokujące następców po błędzie, dwie niezmienne receipty próby oraz dopasowany applied Start w typowanym inboxie. Dowód jest czytany pod krótkim SH z ponownym porównaniem całego katalogu; nie uzyskuje writera. Przed zaufaniem receiptowi sprawdza również jego plan. Dodatkowe pliki próby, brakujące/uszkodzone/obce dowody, artefakty i rozpoczęty następca pozostają odmową. Istniejąca obsługa terminalnych runów oraz wymaganie katalogu dla Succeeded pozostają w mocy.

Regresje obejmują publikację Failed/Pending/Pending, awaiting_command i błędu związanej komendy bez zmiany trwałego stanu następców, a także zmianę B między snapshotami i niezmienność bajtów WRITER.lock/WRITER.owner.json podczas odczytu. Parser obu zmienionych plików Rust i diff check przeszły. Wykonanie testów Rust wymaga jeszcze CI; nie jest to dowód poprawy bieżącego runtime, który nadal korzysta z pakietu 6ee3.

Dodatkowy odczyt poza sandboxem wykazał dostępność RTX 4080 SUPER przez natywne linuksowe /usr/lib/wsl/lib/nvidia-smi. Wcześniejsza odmowa NVML w sandboxie nie dowodzi niedostępności GPU hosta. Bieżąca grupa i fixture nadal jawnie używają CPU; dostęp Docker GPU i wykonanie solverów GPU pozostają osobnymi bramkami.


### Kandydat poprawki dostępu do wyjścia WSL

Launcher przygotowuje ACL katalogów jawnie wybranego aliasu wyjściowego w Linux/WSL. Ograniczony, descriptor-relative spacer odrzuca dowiązania, przekroczenie filesystemu, obce nieprzygotowane katalogi i zagnieżdżony Git przed zmianą praw. Zachowuje efektywne wcześniejsze granty przy poszerzaniu maski, nadaje dostęp UID 65532 oraz dziedziczone prawa operatora i nie zmienia plików. Rollback przywraca własną zmianę tylko wtedy, gdy ACL nadal odpowiada zapisanym przez nas bajtom; cudza zmiana pozostaje zachowana.

Pełny zestaw 19 testów helpera i hooka przeszedł poza sandboxem, bez skipów, w tym rzeczywiste ACL na ext4, zachowanie plików i sąsiadów, maski, limity, odmowa dowiązań/Git oraz oba warianty rollback. Backend otrzymał osobny preflight nonce po mapowaniu ścieżek, przed zwróceniem LoadedStartupScene i placeholderem aktywacji. Używa istniejącego resolvera output/scratch, nie tworzy kontenera wyników i sprawdza tożsamość własnego pliku przed usunięciem. Regresje Rust pokrywają sukces, kolizję, odrębny scratch i dowiązanie; wymagają CI. Kolejność przed akceptacją potwierdza kod; test endpointu i rzeczywisty nowy start DEV pozostają do wykonania. Zgodność kompilacji Windows także wymaga CI; lokalnych procesów Windows nie użyto.
